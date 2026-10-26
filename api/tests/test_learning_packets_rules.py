"""Learning packets (ordered document lists) and assignment rules (ordered,
AND-combined conditions → packet): the CRUD routes, the pure matcher and
the RuleContext builder later tasks use to decide who gets what."""
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog,
    Client,
    Initiative,
    InitiativePerson,
    Partner,
    Person,
    Site,
    WorkerProfile,
)
from serversherpa.learning import rules
from serversherpa.learning.models import (
    LearningDocument,
    LearningPacket,
    LearningRule,
)
from serversherpa.learning.rules import RuleContext
from tests.test_sites_api import login  # noqa: F401
from tests.test_status_values_write import _make

# ── helpers ──────────────────────────────────────────────────────────


async def _manager(db, client):
    return await _make(db, client, "admin", f"pr-{uuid.uuid4().hex[:8]}@test.example.com")


async def _documents(db, *titles):
    docs = [LearningDocument(title=t) for t in titles]
    db.add_all(docs)
    await db.commit()
    return docs


async def _packet(client, hdrs, name="Standard onboarding", items=(), expect=201, **extra):
    resp = await client.post("/learning/packets", headers=hdrs, json={
        "name": name, "items": [str(i) for i in items], **extra})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _rule(client, hdrs, packet_id, conditions, name="Rule", expect=201, **extra):
    resp = await client.post("/learning/rules", headers=hdrs, json={
        "name": name, "packet_id": str(packet_id), "conditions": conditions, **extra})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _actions(db, entity_type, entity_id):
    return list(await db.scalars(select(AuditLog.action).where(
        AuditLog.entity_type == entity_type, AuditLog.entity_id == str(entity_id))
        .order_by(AuditLog.at)))


def _ctx(**kw):
    return RuleContext(**{"person_id": uuid.uuid4(), **kw})


def _r(*conditions, enabled=True):
    return LearningRule(name="r", packet_id=uuid.uuid4(), enabled=enabled,
                        conditions=[{"field": f, "values": v} for f, v in conditions])


# ── packets ──────────────────────────────────────────────────────────


async def test_packet_crud_orders_items(client, db, seeded_user):
    hdrs = await _manager(db, client)
    a, b, c = await _documents(db, "Dress code", "Site safety", "Photo policy")

    packet = await _packet(client, hdrs, items=[c.id, a.id, b.id], enforce_order=True,
                           due_offset_days=2, color="#1668a7", description="Day one")
    assert [i["document_id"] for i in packet["items"]] == [str(c.id), str(a.id), str(b.id)]
    assert [i["title"] for i in packet["items"]] == ["Photo policy", "Dress code", "Site safety"]
    assert packet["enforce_order"] is True and packet["due_offset_days"] == 2
    assert packet["archived_at"] is None

    got = (await client.get(f"/learning/packets/{packet['id']}", headers=hdrs)).json()
    assert [i["document_id"] for i in got["items"]] == [str(c.id), str(a.id), str(b.id)]

    # PATCH replaces the items (order included); other keys stay put
    resp = await client.patch(f"/learning/packets/{packet['id']}", headers=hdrs, json={
        "items": [str(b.id), str(c.id)], "name": "Onboarding v2"})
    assert resp.status_code == 200, resp.text
    patched = resp.json()
    assert patched["name"] == "Onboarding v2" and patched["enforce_order"] is True
    assert [i["document_id"] for i in patched["items"]] == [str(b.id), str(c.id)]
    resp = await client.patch(f"/learning/packets/{packet['id']}", headers=hdrs,
                              json={"description": None})
    assert resp.json()["description"] is None
    assert len(resp.json()["items"]) == 2           # no items key = unchanged

    # an unknown document, or the same one twice, is refused
    for items in ([str(uuid.uuid4())], [str(a.id), str(a.id)]):
        resp = await client.patch(f"/learning/packets/{packet['id']}", headers=hdrs,
                                  json={"items": items})
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] in ("bad_document", "duplicate_document")
    assert [i["document_id"] for i in (await client.get(
        f"/learning/packets/{packet['id']}", headers=hdrs)).json()["items"]] == [
        str(b.id), str(c.id)]

    # copy
    resp = await client.post(f"/learning/packets/{packet['id']}/copy", headers=hdrs)
    assert resp.status_code == 201, resp.text
    copy = resp.json()
    assert copy["id"] != packet["id"] and copy["name"] == "Copy of Onboarding v2"
    assert [i["document_id"] for i in copy["items"]] == [str(b.id), str(c.id)]
    assert copy["enforce_order"] is True and copy["due_offset_days"] == 2

    # list, then archive
    listing = (await client.get("/learning/packets", headers=hdrs)).json()
    assert {p["name"] for p in listing} == {"Onboarding v2", "Copy of Onboarding v2"}
    assert next(p for p in listing if p["id"] == packet["id"])["item_count"] == 2
    assert (await client.delete(f"/learning/packets/{packet['id']}",
                                headers=hdrs)).status_code == 204
    listing = (await client.get("/learning/packets", headers=hdrs)).json()
    assert [p["name"] for p in listing] == ["Copy of Onboarding v2"]
    everything = (await client.get("/learning/packets?include_archived=true",
                                   headers=hdrs)).json()
    assert len(everything) == 2
    archived = await db.get(LearningPacket, uuid.UUID(packet["id"]))
    await db.refresh(archived)
    assert archived.archived_at is not None
    resp = await client.patch(f"/learning/packets/{packet['id']}", headers=hdrs,
                              json={"name": "Nope"})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "archived"

    assert await _actions(db, "learning_packet", packet["id"]) == [
        "learning_packet_create", "learning_packet_update", "learning_packet_update",
        "learning_packet_archive"]
    assert await _actions(db, "learning_packet", copy["id"]) == ["learning_packet_copy"]


async def test_packets_and_rules_need_a_manager(client, db, seeded_user):
    worker = await _make(db, client, "worker", "pr-worker@test.example.com")
    for method, path in (("get", "/learning/packets"), ("post", "/learning/packets"),
                         ("get", "/learning/rules"), ("post", "/learning/rules"),
                         ("post", "/learning/rules/reorder")):
        resp = await getattr(client, method)(path, headers=worker,
                                             **({} if method == "get" else {"json": {}}))
        assert resp.status_code == 403, (path, resp.text)


# ── the matcher ──────────────────────────────────────────────────────


def test_rule_matches_everyone():
    assert rules.matches(_r(("everyone", [])), _ctx())
    assert rules.matches(_r(("everyone", [])), _ctx(initiative_id=uuid.uuid4()))
    # no conditions is not "everyone": it matches nothing
    assert not rules.matches(_r(), _ctx())


def test_rule_and_of_conditions():
    init, client_id, other = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    rule = _r(("initiative", [str(init), str(other)]), ("client", [str(client_id)]))
    assert rules.matches(rule, _ctx(initiative_id=init, client_id=client_id))
    assert rules.matches(rule, _ctx(initiative_id=other, client_id=client_id))
    assert not rules.matches(rule, _ctx(initiative_id=init, client_id=uuid.uuid4()))
    assert not rules.matches(rule, _ctx(initiative_id=uuid.uuid4(), client_id=client_id))
    assert not rules.matches(rule, _ctx(client_id=client_id))       # no initiative

    site, person = uuid.uuid4(), uuid.uuid4()
    rule = _r(("site", [str(site)]), ("person", [str(person)]))
    assert rules.matches(rule, _ctx(person_id=person, site_ids={uuid.uuid4(), site}))
    assert not rules.matches(rule, _ctx(person_id=person, site_ids={uuid.uuid4()}))
    assert not rules.matches(rule, _ctx(site_ids={site}))

    partner = uuid.uuid4()
    assert rules.matches(_r(("partner", [str(partner)])), _ctx(partner_id=partner))
    assert not rules.matches(_r(("partner", [str(partner)])), _ctx())
    # an unknown field never matches
    assert not rules.matches(_r(("everyone", []), ("shoe_size", ["9"])), _ctx())


def test_rule_country_and_role():
    rule = _r(("site_country", ["JP", "KR"]), ("worker_role", ["lead"]))
    assert rules.matches(rule, _ctx(site_countries={"US", "JP"}, work_type="lead"))
    assert not rules.matches(rule, _ctx(site_countries={"US", "JP"}, work_type="tech"))
    assert not rules.matches(rule, _ctx(site_countries={"US"}, work_type="lead"))
    assert not rules.matches(rule, _ctx(work_type="lead"))
    assert not rules.matches(_r(("worker_role", ["lead"])), _ctx(work_type=None))
    # country compares case-insensitively
    assert rules.matches(_r(("site_country", ["jp"])), _ctx(site_countries={"JP"}))


async def test_build_context(db, seeded_user):
    client_row = Client(name="Acme")
    partner = Partner(name="Crew Co")
    origin = Site(name="Tokyo DC", country="JP")
    destination = Site(name="Seoul DC", country="KR")
    other = Site(name="Austin DC", country="US")
    person, outsider = Person(first_name="W", last_name="One"), Person(
        first_name="O", last_name="Ut")
    db.add_all([client_row, partner, origin, destination, other, person, outsider])
    await db.flush()
    db.add(WorkerProfile(person_id=person.id, partner_id=partner.id))
    move = Initiative(name="Move", initiative_type="move", client_id=client_row.id,
                      origin_site_id=origin.id, destination_site_id=destination.id)
    project = Initiative(name="Project", initiative_type="project", site_id=other.id)
    db.add_all([move, project])
    await db.flush()
    db.add(InitiativePerson(initiative_id=move.id, person_id=person.id, work_type="lead"))
    await db.commit()

    ctx = await rules.build_context(db, person.id, move.id)
    assert ctx.person_id == person.id and ctx.initiative_id == move.id
    assert ctx.client_id == client_row.id and ctx.partner_id == partner.id
    assert ctx.site_ids == {origin.id, destination.id}
    assert ctx.site_countries == {"JP", "KR"} and ctx.work_type == "lead"
    rule = _r(("site_country", ["KR"]), ("worker_role", ["lead"]),
              ("partner", [str(partner.id)]))
    assert rules.matches(rule, ctx)

    ctx = await rules.build_context(db, person.id, project.id)
    assert ctx.site_ids == {other.id} and ctx.site_countries == {"US"}
    assert ctx.client_id is None and ctx.work_type is None     # not on the project

    ctx = await rules.build_context(db, outsider.id, None)
    assert ctx == RuleContext(person_id=outsider.id, initiative_id=None, client_id=None,
                              site_ids=set(), site_countries=set(), work_type=None,
                              partner_id=None)


async def test_disabled_rule_ignored(db, seeded_user):
    live, archived = LearningPacket(name="Live"), LearningPacket(name="Archived")
    archived.archived_at = datetime.now(UTC)
    db.add_all([live, archived])
    await db.flush()
    everyone = [{"field": "everyone", "values": []}]
    db.add_all([
        LearningRule(name="third", packet_id=live.id, conditions=everyone, position=3),
        LearningRule(name="first", packet_id=live.id, conditions=everyone, position=1),
        LearningRule(name="off", packet_id=live.id, conditions=everyone, position=2,
                     enabled=False),
        LearningRule(name="gone", packet_id=archived.id, conditions=everyone, position=4),
        LearningRule(name="no match", packet_id=live.id, position=5, conditions=[
            {"field": "initiative", "values": [str(uuid.uuid4())]}]),
    ])
    await db.commit()

    found = await rules.matching_packets(db, _ctx())
    assert [(rule.name, packet.name) for rule, packet in found] == [
        ("first", "Live"), ("third", "Live")]


# ── the rule routes ──────────────────────────────────────────────────


async def test_rule_crud_and_audit(client, db, seeded_user):
    hdrs = await _manager(db, client)
    packet = await _packet(client, hdrs)
    initiative_id, client_id = uuid.uuid4(), uuid.uuid4()

    first = await _rule(client, hdrs, packet["id"], [{"field": "everyone"}], name="Everyone")
    second = await _rule(client, hdrs, packet["id"], [
        {"field": "site_country", "values": [" jp ", "JP", "KR"]},
        {"field": "client", "values": [str(client_id).upper()]}], name="Asia", enabled=False)
    assert first["position"] < second["position"] and first["enabled"] is True
    assert first["conditions"] == [{"field": "everyone", "values": []}]
    assert second["conditions"] == [{"field": "site_country", "values": ["JP", "KR"]},
                                    {"field": "client", "values": [str(client_id)]}]
    assert first["packet_name"] == "Standard onboarding"

    listing = (await client.get("/learning/rules", headers=hdrs)).json()
    assert [r["name"] for r in listing] == ["Everyone", "Asia"]

    resp = await client.patch(f"/learning/rules/{second['id']}", headers=hdrs, json={
        "name": "Asia clients", "enabled": True,
        "conditions": [{"field": "initiative", "values": [str(initiative_id)]}]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Asia clients" and resp.json()["enabled"] is True
    assert resp.json()["conditions"] == [{"field": "initiative", "values": [str(initiative_id)]}]

    # a rule can't point at a missing or archived packet
    await _rule(client, hdrs, uuid.uuid4(), [{"field": "everyone"}], expect=422)
    gone = await _packet(client, hdrs, name="Retired")
    await client.delete(f"/learning/packets/{gone['id']}", headers=hdrs)
    resp = await _rule(client, hdrs, gone["id"], [{"field": "everyone"}], expect=422)
    assert resp["detail"]["code"] == "bad_packet"

    assert (await client.delete(f"/learning/rules/{first['id']}",
                                headers=hdrs)).status_code == 204
    assert (await client.delete(f"/learning/rules/{first['id']}",
                                headers=hdrs)).status_code == 404
    assert [r["name"] for r in (await client.get("/learning/rules",
                                                  headers=hdrs)).json()] == ["Asia clients"]
    assert await _actions(db, "learning_rule", first["id"]) == [
        "learning_rule_create", "learning_rule_delete"]
    assert await _actions(db, "learning_rule", second["id"]) == [
        "learning_rule_create", "learning_rule_update"]


async def test_reorder(client, db, seeded_user):
    hdrs = await _manager(db, client)
    packet = await _packet(client, hdrs)
    ids = [(await _rule(client, hdrs, packet["id"], [{"field": "everyone"}],
                        name=n))["id"] for n in ("A", "B", "C")]

    resp = await client.post("/learning/rules/reorder", headers=hdrs,
                             json={"ids": [ids[2], ids[0], ids[1]]})
    assert resp.status_code == 200, resp.text
    assert [r["name"] for r in resp.json()] == ["C", "A", "B"]
    assert [r["name"] for r in (await client.get("/learning/rules",
                                                  headers=hdrs)).json()] == ["C", "A", "B"]
    assert [rule.name for rule, _ in await rules.matching_packets(db, _ctx())] == [
        "C", "A", "B"]

    # a partial list goes first; the rest keep their order after it
    resp = await client.post("/learning/rules/reorder", headers=hdrs, json={"ids": [ids[1]]})
    assert [r["name"] for r in resp.json()] == ["B", "C", "A"]

    # an unknown or repeated id is refused and nothing moves
    for bad in ([str(uuid.uuid4())], [ids[0], ids[0]]):
        resp = await client.post("/learning/rules/reorder", headers=hdrs, json={"ids": bad})
        assert resp.status_code == 422 and resp.json()["detail"]["code"] == "bad_order"
    assert [r["name"] for r in (await client.get("/learning/rules",
                                                  headers=hdrs)).json()] == ["B", "C", "A"]


async def test_bad_field_422(client, db, seeded_user):
    hdrs = await _manager(db, client)
    packet = await _packet(client, hdrs)
    resp = await _rule(client, hdrs, packet["id"], [{"field": "shoe_size", "values": ["9"]}],
                       expect=422)
    assert resp["detail"]["code"] == "bad_rule_field"

    # values: everyone takes none, every other field needs at least one
    for conditions in ([{"field": "everyone", "values": ["x"]}],
                       [{"field": "client", "values": []}],
                       [{"field": "site", "values": ["not-a-uuid"]}],
                       [{"field": "site_country", "values": ["  "]}],
                       []):
        resp = await _rule(client, hdrs, packet["id"], conditions, expect=422)
        assert resp["detail"]["code"] == "bad_rule_values", conditions

    good = await _rule(client, hdrs, packet["id"], [{"field": "everyone"}])
    resp = await client.patch(f"/learning/rules/{good['id']}", headers=hdrs, json={
        "conditions": [{"field": "nope", "values": ["1"]}]})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "bad_rule_field"
    assert (await client.get("/learning/rules", headers=hdrs)).json()[0]["conditions"] == [
        {"field": "everyone", "values": []}]
