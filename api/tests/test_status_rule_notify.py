"""The Notify action ("Send a notification", status_rules/notify.py) and what it announces.

- Saving it: the catalog's `people` and `groups` param types and `validate_action`
  (`notify_no_recipients`), and the route's look-up of the chosen people and groups
  (`unknown_person`, `unknown_group`).
- A match: one `status_rule_matched` event per rule and initiative in a transaction (one per
  thing when there is no initiative), announced once, at commit, with the final count and the
  matched ids. A 500-row bulk update is one event.
- The repeat guard: once an hour per rule and thing, checked and set in one upsert, so two
  workers racing on the same thing notify once.
- Rollbacks: a failed scan leaves no event and no guard row, a savepoint takes back only its
  own matches, and a session reused after a rollback starts with no batch.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 5, 6 and 9)
Plan: docs/superpowers/plans/2026-11-03-notifications-phase2-slice4.md (Task 2; calls 1, 3-5, 7)"""

import asyncio
import copy
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event as sa_event
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from serversherpa.db.engine import get_engine, get_sessionmaker
from serversherpa.db.models import (
    Asset,
    Container,
    Initiative,
    InitiativeAsset,
    InitiativeLink,
    NotificationEvent,
    NotificationGroup,
    Person,
    ProcessedScan,
    RawScan,
    Site,
    StatusRule,
    StatusRuleExecution,
    StatusRuleNotified,
)
from serversherpa.imports.worker import run_once
from serversherpa.scans import worker as scan_worker
from serversherpa.scans.manual import record_status_edit
from serversherpa.status_rules import engine, notify
from serversherpa.status_rules.catalog import ACTIONS, ActionOutcome, validate_action
from serversherpa.status_rules.context import Context
from serversherpa.status_rules.engine import RuleExecutionError, apply_rules, invalidate_cache
from tests.test_access_roles_api import login_admin
from tests.test_asset_bulk_update_apply import fresh_job, mk_job, mk_person
from tests.test_status_rules_engine import _rule

STATUS = "rfid_4_into_cage"
OFF_MOVE = ("scan.off_move", "equals", "true")


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    invalidate_cache()
    monkeypatch.setattr(scan_worker, "_last_sweep", None)
    yield
    invalidate_cache()


@dataclass(frozen=True)
class Scene:
    """Initiative A (a move in progress) under Initiative B, Site A, Asset A ("SN-A") on
    Initiative A's roster, and Person A, who runs the scanner. Ids only: a rollback expires
    loaded rows."""

    parent: uuid.UUID
    initiative: uuid.UUID
    site: uuid.UUID
    asset: uuid.UUID
    operator: uuid.UUID


async def _scene(db) -> Scene:
    parent = Initiative(name="Initiative B", initiative_type="project")
    initiative = Initiative(name="Initiative A", initiative_type="move", status="in_progress")
    site = Site(name="Site A")
    asset = Asset(serial_number="SN-A", status="unknown")
    operator = Person(first_name="Person", last_name="A")
    db.add_all([parent, initiative, site, asset, operator])
    await db.flush()
    db.add_all([InitiativeLink(parent_id=parent.id, child_id=initiative.id),
                InitiativeAsset(initiative_id=initiative.id, asset_id=asset.id,
                                status="loaded_in_system")])
    await db.commit()
    return Scene(parent.id, initiative.id, site.id, asset.id, operator.id)


async def _on_roster(db, initiative_id, *serials) -> list[uuid.UUID]:
    """More assets on an initiative's roster; their ids, in order."""
    assets = [Asset(serial_number=serial, status="unknown") for serial in serials]
    db.add_all(assets)
    await db.flush()
    db.add_all([InitiativeAsset(initiative_id=initiative_id, asset_id=asset.id,
                                status="loaded_in_system") for asset in assets])
    await db.commit()
    return [asset.id for asset in assets]


async def _named(db):
    """Person B and Group A, for a rule to name."""
    person = Person(first_name="Person", last_name="B")
    group = NotificationGroup(name="Group A")
    db.add_all([person, group])
    await db.commit()
    return person.id, group.id


def _notify(*, people=(), groups=(), watchers=False) -> tuple[str, dict]:
    """A Notify action as a rule stores it."""
    return ("notify", {"people": [str(p) for p in people], "groups": [str(g) for g in groups],
                       "watchers": watchers})


async def _add_rule(db, name, *actions, **fields) -> uuid.UUID:
    rule = _rule(name, actions=actions, **fields)
    db.add(rule)
    await db.commit()
    return rule.id


async def _scan(db, *, asset=None, container=None, person=None, site=None, operator=None):
    """A processed RFID scan at the rules' status, of one matched thing (ids)."""
    match_type = "asset" if asset else "container" if container else "person"
    scan = ProcessedScan(scanned_value="V", scan_type="rfid", status=STATUS,
                         scanned_at=datetime.now(UTC), processed_at=datetime.now(UTC),
                         site_id=site, operator_id=operator, match_type=match_type,
                         asset_id=asset, container_id=container, person_id=person)
    db.add(scan)
    await db.flush()
    return scan


async def _match(db, **scan) -> None:
    """One scan through the rules, in the caller's transaction."""
    await apply_rules(db, await _scan(db, **scan))


async def _events() -> list[NotificationEvent]:
    """Every event, oldest first, as a new session sees them (what was committed)."""
    async with get_sessionmaker()() as s:
        return list(await s.scalars(select(NotificationEvent).order_by(NotificationEvent.id)))


async def _guards() -> list[tuple]:
    """The committed guard rows: (rule, subject type, subject id, notified at)."""
    async with get_sessionmaker()() as s:
        return [(row.rule_id, row.subject_type, row.subject_id, row.notified_at)
                for row in await s.scalars(select(StatusRuleNotified).order_by(
                    StatusRuleNotified.notified_at))]


async def _outcomes(rule_id) -> list[list[dict]]:
    """What each of the rule's executions applied, oldest first."""
    async with get_sessionmaker()() as s:
        return [ex.actions_applied for ex in await s.scalars(
            select(StatusRuleExecution).where(StatusRuleExecution.rule_id == rule_id)
            .order_by(StatusRuleExecution.id))]


def _ref(kind, thing_id) -> dict:
    return {"type": kind, "id": str(thing_id)}


APPLIED = [{"action_type": "notify", "applied": True}]
REPEAT = [{"action_type": "notify", "applied": False, "reason": "notified_within_hour"}]


# ── the catalog ─────────────────────────────────────────────────────

def test_notify_is_the_last_action():
    """Appended last: the rule editor defaults a new action to the first one."""
    assert list(ACTIONS)[-1] == "notify"
    action = ACTIONS["notify"]
    assert action.label == "Send a notification"
    assert [(p.name, p.type, p.options, p.options_source) for p in action.params] == [
        ("people", "people", (), None), ("groups", "groups", (), None),
        ("watchers", "bool", (), None)]
    assert action.apply is notify.apply


def test_validate_action_for_notify():
    some = str(uuid.uuid4())
    ok = {"people": [some], "groups": [], "watchers": False}
    assert validate_action("notify", ok) is None
    assert validate_action("notify", {"people": [], "groups": [some], "watchers": False}) is None
    assert validate_action("notify", {"people": [], "groups": [], "watchers": True}) is None
    assert validate_action("notify", {"people": [some, str(uuid.uuid4())], "groups": [some],
                                      "watchers": True}) is None

    # nobody chosen at all
    assert validate_action("notify", {"people": [], "groups": [], "watchers": False}) \
        == "notify_no_recipients"
    # every param is required, and nothing else is taken
    assert validate_action("notify", {"people": [], "groups": []}) == "missing_param"
    assert validate_action("notify", {**ok, "extra": 1}) == "bad_param"
    # people and groups are lists of id strings
    for bad in (some, None, {}, [1], [None], ["Person A"], [[some]], [some, "x"]):
        assert validate_action("notify", {**ok, "people": bad}) == "bad_param", bad
        assert validate_action("notify", {**ok, "groups": bad}) == "bad_param", bad
    # and watchers is a real boolean
    for bad in ("true", 1, None):
        assert validate_action("notify", {**ok, "watchers": bad}) == "bad_param", bad
    # a malformed param is reported before an empty choice
    assert validate_action("notify", {"people": "x", "groups": [], "watchers": False}) \
        == "bad_param"


# ── saving a rule ───────────────────────────────────────────────────

def _body(*params: dict, name="Rule A") -> dict:
    """A rule whose actions are Notify actions with these params (each completed with
    nobody chosen)."""
    return {"name": name, "description": "", "trigger_status": STATUS,
            "trigger_match_type": "asset", "priority": 10, "enabled": True, "conditions": [],
            "actions": [{"action_type": "notify",
                         "params": {"people": [], "groups": [], "watchers": False, **p}}
                        for p in params]}


async def test_validation(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    person, group = await _named(db)

    async def rejected(body, reason, index=0, *, put=None):
        if put is None:
            resp = await client.post("/status-rules", headers=hdrs, json=body)
        else:
            resp = await client.put(f"/status-rules/{put}", headers=hdrs, json=body)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == {"code": "bad_action", "index": index, "reason": reason}

    # nobody chosen
    await rejected(_body({}), "notify_no_recipients")
    # an id that is no person (a group's is not), and one that is no notification group
    await rejected(_body({"people": [str(uuid.uuid4())]}), "unknown_person")
    await rejected(_body({"people": [str(group)]}), "unknown_person")
    await rejected(_body({"people": [str(person), str(uuid.uuid4())]}), "unknown_person")
    await rejected(_body({"groups": [str(uuid.uuid4())]}), "unknown_group")
    await rejected(_body({"groups": [str(person)]}), "unknown_group")
    # not ids at all
    await rejected(_body({"people": ["Person B"]}), "bad_param")
    # the index is the action's
    second = _body({"groups": [str(uuid.uuid4())]})
    second["actions"].insert(0, {"action_type": "set_asset_status",
                                 "params": {"status": "in_container"}})
    await rejected(second, "unknown_group", index=1)
    assert await db.scalar(select(func.count()).select_from(StatusRule)) == 0

    # a valid save round-trips
    saved = {"people": [str(person)], "groups": [str(group)], "watchers": True}
    resp = await client.post("/status-rules", headers=hdrs, json=_body(saved))
    assert resp.status_code == 201, resp.text
    rule_id = resp.json()["id"]
    resp = await client.get(f"/status-rules/{rule_id}", headers=hdrs)
    assert resp.json()["actions"] == [{"action_type": "notify", "params": saved}]
    # watchers alone is enough
    resp = await client.post("/status-rules", headers=hdrs,
                             json=_body({"watchers": True}, name="Rule B"))
    assert resp.status_code == 201, resp.text

    # replacing a rule checks the same, and a rejected replace changes nothing
    await rejected(_body({"groups": [str(uuid.uuid4())]}), "unknown_group", put=rule_id)
    resp = await client.get(f"/status-rules/{rule_id}", headers=hdrs)
    assert resp.json()["actions"] == [{"action_type": "notify", "params": saved}]
    resp = await client.put(f"/status-rules/{rule_id}", headers=hdrs,
                            json=_body({"groups": [str(group)]}))
    assert resp.status_code == 200, resp.text
    assert resp.json()["actions"][0]["params"] == {"people": [], "groups": [str(group)],
                                                   "watchers": False}


async def test_one_notify_per_rule(client, db, seeded_user):
    """A rule has one Notify action: the repeat guard is per rule and thing, so a second one
    would never be heard. The second is refused, at its own index, on create and replace."""
    hdrs = await login_admin(client, db, seeded_user)
    person, group = await _named(db)
    twice = _body({"people": [str(person)]}, {"groups": [str(group)]})
    resp = await client.post("/status-rules", headers=hdrs, json=twice)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == {"code": "bad_action", "index": 1, "reason": "notify_twice"}
    # wherever the second one is, and whatever its params
    between = _body({"watchers": True}, {})
    between["actions"].insert(1, {"action_type": "set_asset_status",
                                  "params": {"status": "in_container"}})
    resp = await client.post("/status-rules", headers=hdrs, json=between)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == {"code": "bad_action", "index": 2, "reason": "notify_twice"}
    assert await db.scalar(select(func.count()).select_from(StatusRule)) == 0

    # one Notify beside other actions is fine
    once = _body({"watchers": True})
    once["actions"].insert(0, {"action_type": "set_asset_status",
                               "params": {"status": "in_container"}})
    resp = await client.post("/status-rules", headers=hdrs, json=once)
    assert resp.status_code == 201, resp.text
    rule_id = resp.json()["id"]

    # replacing checks the same, and a rejected replace changes nothing
    resp = await client.put(f"/status-rules/{rule_id}", headers=hdrs, json=twice)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == {"code": "bad_action", "index": 1, "reason": "notify_twice"}
    resp = await client.get(f"/status-rules/{rule_id}", headers=hdrs)
    assert [a["action_type"] for a in resp.json()["actions"]] == ["set_asset_status", "notify"]


async def test_the_schema_offers_notify(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.get("/status-rules/schema", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["actions"][-1] == {
        "key": "notify", "label": "Send a notification",
        "params": [{"name": "people", "type": "people"}, {"name": "groups", "type": "groups"},
                   {"name": "watchers", "type": "bool"}]}


# ── one match ───────────────────────────────────────────────────────

@pytest.mark.parametrize("watchers", [True, False])
async def test_one_match_is_one_event(db, watchers):
    s = await _scene(db)
    person, group = await _named(db)
    rule = await _add_rule(db, "Rule A",
                           _notify(people=[person], groups=[group], watchers=watchers))

    await _match(db, asset=s.asset, site=s.site, operator=s.operator)
    # announced at commit, not before: nothing waits in the session or the table yet
    assert not [obj for obj in db.new if isinstance(obj, NotificationEvent)]
    assert await db.scalar(select(func.count()).select_from(NotificationEvent)) == 0
    await db.commit()

    [event] = await _events()
    assert event.kind == "status_rule_matched"
    # the rule's initiative is what a rule batch is about (call 1)
    assert (event.subject_type, event.subject_id) == ("initiative", s.initiative)
    assert event.item == {
        "title": "Rule A: SN-A", "line": "Initiative A · Site A",
        "link": f"/assets?open={s.asset}", "initiative_id": str(s.initiative), "at": None,
        "list_link": None, "count": 1, "matched_type": "asset",
        "matched_ids": [str(s.asset)]}
    # the initiative's parent and the scan's site, only when watchers is on
    assert event.reaches == ([_ref("initiative", s.parent), _ref("site", s.site)]
                             if watchers else [])
    assert event.watchers is watchers
    assert event.actor_id == s.operator
    assert (event.person_ids, event.group_ids) == ([person], [group])
    assert (event.rule_id, event.sent_at) == (rule, None)

    assert await _outcomes(rule) == [APPLIED]
    [(guard_rule, kind, thing, _at)] = await _guards()
    assert (guard_rule, kind, thing) == (rule, "asset", s.asset)


async def test_a_match_with_no_initiative_is_about_the_thing(db):
    """A container with no move, a worker's badge, an asset on no move in progress: each is
    its own event, about the matched thing, linking to its page (call 5)."""
    site = Site(name="Site A")
    crate = Container(name="Container A")
    worker = Person(first_name="Person", last_name="C")
    loose = Asset(name="Asset B", status="unknown")
    db.add_all([site, crate, worker, loose])
    await db.commit()
    by_container = await _add_rule(db, "Rule C", _notify(watchers=True), match="container")
    by_badge = await _add_rule(db, "Rule P", _notify(people=[worker.id]), match="person")
    by_asset = await _add_rule(db, "Rule A", _notify(people=[worker.id]))

    await _match(db, container=crate.id, site=site.id)
    await _match(db, person=worker.id)
    await _match(db, asset=loose.id)
    await db.commit()

    events = {event.rule_id: event for event in await _events()}
    assert set(events) == {by_container, by_badge, by_asset}

    container = events[by_container]
    assert (container.subject_type, container.subject_id) == ("container", crate.id)
    assert container.item == {
        "title": "Rule C: Container A", "line": "Site A",
        "link": f"/logistics/containers?open={crate.id}", "initiative_id": None, "at": None,
        "list_link": None, "count": 1, "matched_type": "container",
        "matched_ids": [str(crate.id)]}
    assert container.reaches == [_ref("site", site.id)]

    badge = events[by_badge]
    assert (badge.subject_type, badge.subject_id) == ("person", worker.id)
    assert (badge.item["title"], badge.item["line"], badge.item["link"]) == (
        "Rule P: Person C", "", f"/people/workers/{worker.id}")
    assert (badge.item["matched_type"], badge.reaches, badge.watchers) == ("person", [], False)
    assert badge.person_ids == [worker.id]

    # an asset with no serial number is called by its name
    asset = events[by_asset]
    assert (asset.subject_type, asset.subject_id) == ("asset", loose.id)
    assert (asset.item["title"], asset.item["line"], asset.item["link"]) == (
        "Rule A: Asset B", "", f"/assets?open={loose.id}")


async def test_a_container_brings_its_own_initiative(db):
    """With no initiative in the rule's context, a matched container's own move is the
    rule's initiative."""
    s = await _scene(db)
    crate = Container(name="Container A", initiative_id=s.initiative)
    db.add(crate)
    await db.commit()
    rule = await _add_rule(db, "Rule C", _notify(watchers=True), match="container")

    await _match(db, container=crate.id, site=s.site)
    await db.commit()

    [event] = await _events()
    assert (event.subject_type, event.subject_id, event.rule_id) == (
        "initiative", s.initiative, rule)
    assert (event.item["title"], event.item["line"], event.item["initiative_id"]) == (
        "Rule C: Container A", "Initiative A · Site A", str(s.initiative))
    assert event.reaches == [_ref("initiative", s.parent), _ref("site", s.site)]


async def test_a_status_edit_reaches_the_initiative_only(db):
    """A manual status edit has no scan site (call 4), and the editor is the actor."""
    s = await _scene(db)
    editor = Person(first_name="Person", last_name="E")
    db.add(editor)
    await db.commit()
    rule = await _add_rule(db, "Rule A", _notify(watchers=True))
    assoc = await db.scalar(select(InitiativeAsset).where(InitiativeAsset.asset_id == s.asset))
    asset = await db.get(Asset, s.asset)

    await record_status_edit(db, assoc=assoc, asset=asset, status=STATUS,
                             actor_person_id=editor.id)
    await db.commit()

    [event] = await _events()
    assert (event.subject_type, event.subject_id, event.rule_id) == (
        "initiative", s.initiative, rule)
    assert event.actor_id == editor.id
    assert event.reaches == [_ref("initiative", s.parent)]
    assert (event.item["title"], event.item["line"]) == ("Rule A: SN-A", "Initiative A")


async def test_an_off_move_sighting_tells_the_stations_move(db):
    """A sighting's initiative is the station's move (Task 1). One the station named no move
    for has nobody to tell when the rule asks only for watchers and was read at no site, and
    that skip never rolls the sighting back."""
    s = await _scene(db)
    lost = Asset(serial_number="SN-L", status="unknown")
    db.add(lost)
    await db.commit()
    rule = await _add_rule(db, "Rule A", _notify(watchers=True), conditions=(OFF_MOVE,))
    seen = RawScan(scanned_value="SN-L", scan_type="rfid", status=STATUS,
                   scanned_at=datetime.now(UTC), off_move=True, initiative_id=s.initiative,
                   site_id=s.site)
    db.add(seen)
    await db.commit()

    assert await scan_worker.process_raw_scan(get_sessionmaker(), seen.id) == "matched"
    [event] = await _events()
    assert (event.subject_type, event.subject_id) == ("initiative", s.initiative)
    assert (event.item["title"], event.item["line"]) == ("Rule A: SN-L", "Initiative A · Site A")

    stray = Asset(serial_number="SN-S", status="unknown")
    nowhere = RawScan(scanned_value="SN-S", scan_type="rfid", status=STATUS,
                      scanned_at=datetime.now(UTC), off_move=True)
    db.add_all([stray, nowhere])
    await db.commit()
    assert await scan_worker.process_raw_scan(get_sessionmaker(), nowhere.id) == "matched"
    assert await _outcomes(rule) == [
        APPLIED, [{"action_type": "notify", "applied": False, "reason": "nobody_to_tell"}]]
    assert len(await _events()) == 1
    # the hour was not spent on it
    assert [thing for _rule_id, _kind, thing, _at in await _guards()] == [lost.id]


# ── batches ─────────────────────────────────────────────────────────

async def test_bulk_update_is_one_event(db, monkeypatch):
    """Every row of a 500-row bulk update matches one rule on one initiative: one event with
    the count and every id, announced once (one INSERT, never an UPDATE)."""
    s = await _scene(db)
    person, _ = await _named(db)
    me = await mk_person(db)
    assets = [Asset(serial_number=f"SN-{i}", status="active") for i in range(500)]
    db.add_all(assets)
    await db.flush()                    # the Asset IDs come from their sequence
    db.add_all([InitiativeAsset(initiative_id=s.initiative, asset_id=a.id,
                                status="loaded_in_system") for a in assets])
    await db.commit()
    rule = await _add_rule(db, "Rule A", _notify(people=[person], watchers=True),
                           status="racked")
    body = "asset_id,status\n" + "".join(f"{a.legacy_id},racked\n" for a in assets)
    job_id = await mk_job(db, me, body, options={"approve_all": True})

    announced = []
    real = notify.announce

    def spy(*args, **kwargs):
        announced.append(kwargs["item"])
        return real(*args, **kwargs)

    monkeypatch.setattr(notify, "announce", spy)
    writes: list[str] = []

    def count_writes(conn, cursor, statement, parameters, context, executemany):
        verb = statement.lstrip().split(" ", 1)[0].upper()
        if verb in ("INSERT", "UPDATE") and "notification_events" in statement:
            writes.append(verb)

    sync_engine = get_engine().sync_engine
    sa_event.listen(sync_engine, "before_cursor_execute", count_writes)
    try:
        assert await run_once(get_sessionmaker()) is True
    finally:
        sa_event.remove(sync_engine, "before_cursor_execute", count_writes)

    assert (await fresh_job(job_id)).status == "completed"
    assert len(announced) == 1 and writes == ["INSERT"]
    [event] = await _events()
    assert (event.subject_type, event.subject_id, event.rule_id) == (
        "initiative", s.initiative, rule)
    assert event.item == {
        "title": "Rule A (500)", "line": "Initiative A · 500",
        "link": f"/admin/status-rules?tab=executions&rule={rule}",
        "initiative_id": str(s.initiative), "at": None, "list_link": None, "count": 500,
        "matched_type": "asset", "matched_ids": [str(a.id) for a in assets]}
    # the person who ran the job; a manual edit has no site, so the initiative's parent only
    assert (event.actor_id, event.person_ids, event.watchers) == (me.id, [person], True)
    assert event.reaches == [_ref("initiative", s.parent)]
    assert len(await _guards()) == 500


async def test_two_initiatives_two_events(db):
    """One transaction, one rule: a batch per initiative, each counted on its own."""
    s = await _scene(db)
    other = Initiative(name="Initiative C", initiative_type="move", status="in_progress")
    db.add(other)
    await db.commit()
    [second] = await _on_roster(db, s.initiative, "SN-B")
    [elsewhere] = await _on_roster(db, other.id, "SN-C")
    rule = await _add_rule(db, "Rule A", _notify(watchers=True))

    for asset in (s.asset, elsewhere, second):
        await _match(db, asset=asset, site=s.site)
    await db.commit()

    first, last = await _events()
    assert (first.subject_type, first.subject_id, first.rule_id) == (
        "initiative", s.initiative, rule)
    assert (first.item["title"], first.item["line"], first.item["link"], first.item["count"],
            first.item["matched_ids"]) == (
        "Rule A (2)", "Initiative A · 2", f"/admin/status-rules?tab=executions&rule={rule}",
        2, [str(s.asset), str(second)])
    assert (last.subject_type, last.subject_id) == ("initiative", other.id)
    assert (last.item["title"], last.item["line"], last.item["link"], last.item["count"],
            last.item["matched_ids"]) == (
        "Rule A: SN-C", "Initiative C · Site A", f"/assets?open={elsewhere}", 1,
        [str(elsewhere)])
    assert last.reaches == [_ref("site", s.site)]           # Initiative C has no parent


async def test_two_rules_two_events(db):
    """Batches are per rule: the same match under two rules is two events."""
    s = await _scene(db)
    first = await _add_rule(db, "Rule A", _notify(watchers=True), priority=10)
    second = await _add_rule(db, "Rule B", _notify(watchers=True), priority=20)
    await _match(db, asset=s.asset)
    await db.commit()
    assert [(e.rule_id, e.item["title"]) for e in await _events()] == [
        (first, "Rule A: SN-A"), (second, "Rule B: SN-A")]


# ── the repeat guard ────────────────────────────────────────────────

async def test_repeat_guard(db):
    s = await _scene(db)
    [other_asset] = await _on_roster(db, s.initiative, "SN-B")
    rule = await _add_rule(db, "Rule A", _notify(watchers=True))

    await _match(db, asset=s.asset)
    # the same thing again in the same transaction is a repeat too, and is not counted
    await _match(db, asset=s.asset)
    await db.commit()
    [event] = await _events()
    assert event.item["count"] == 1
    [(_, _, _, first_at)] = await _guards()

    # within the hour: not applied, no event, and the hour still runs from the first time
    await _match(db, asset=s.asset)
    await db.commit()
    assert await _outcomes(rule) == [APPLIED, REPEAT, REPEAT]
    assert len(await _events()) == 1
    assert [at for *_, at in await _guards()] == [first_at]

    # the hour is per rule and thing: another thing, or another rule, notifies
    another = await _add_rule(db, "Rule B", _notify(watchers=True), priority=20)
    invalidate_cache()
    await _match(db, asset=other_asset)
    await db.commit()
    assert [(e.rule_id, e.item["matched_ids"]) for e in (await _events())[1:]] == [
        (rule, [str(other_asset)]), (another, [str(other_asset)])]
    await _match(db, asset=s.asset)
    await db.commit()
    assert (await _outcomes(rule))[-1] == REPEAT
    assert (await _outcomes(another))[-1] == APPLIED

    # 59 minutes later it is still within the hour; an hour later it notifies again
    await db.execute(update(StatusRuleNotified).where(
        StatusRuleNotified.rule_id == rule, StatusRuleNotified.subject_id == s.asset)
        .values(notified_at=datetime.now(UTC) - timedelta(minutes=59)))
    await db.commit()
    await _match(db, asset=s.asset)
    await db.commit()
    assert (await _outcomes(rule))[-1] == REPEAT

    events_before = len(await _events())
    await db.execute(update(StatusRuleNotified).where(
        StatusRuleNotified.rule_id == rule, StatusRuleNotified.subject_id == s.asset)
        .values(notified_at=datetime.now(UTC) - timedelta(hours=1)))
    await db.commit()
    started = datetime.now(UTC)
    await _match(db, asset=s.asset)
    await db.commit()
    assert (await _outcomes(rule))[-1] == APPLIED
    events = await _events()
    assert len(events) == events_before + 1 and events[-1].item["matched_ids"] == [str(s.asset)]
    renewed = {(r, thing): at for r, _kind, thing, at in await _guards()}[(rule, s.asset)]
    assert renewed >= started


@pytest.mark.parametrize("earlier", [None, timedelta(hours=2)],
                         ids=["first time", "an hour since"])
async def test_concurrent_workers_notify_once(db, earlier):
    """Two transactions race on one rule and thing: the second waits on the first's guard
    row, then finds it within the hour."""
    s = await _scene(db)
    rule = await _add_rule(db, "Rule A", _notify(watchers=True))
    if earlier is not None:
        db.add(StatusRuleNotified(rule_id=rule, subject_type="asset", subject_id=s.asset,
                                  notified_at=datetime.now(UTC) - earlier))
        await db.commit()

    maker = get_sessionmaker()
    async with maker() as first, maker() as second:
        await _match(first, asset=s.asset, site=s.site)      # holds the guard row

        async def racing():
            await _match(second, asset=s.asset, site=s.site)
            await second.commit()

        task = asyncio.create_task(racing())
        await asyncio.sleep(0.5)
        assert not task.done()                                # waiting on the first
        await first.commit()
        await asyncio.wait_for(task, 10)

    [event] = await _events()
    assert event.item["matched_ids"] == [str(s.asset)]
    assert await _outcomes(rule) == [APPLIED, REPEAT]
    assert len(await _guards()) == 1


# ── rollbacks ───────────────────────────────────────────────────────

async def test_rollback_leaves_nothing(db):
    """A later action of the rule fails, so the scan rolls back: no event, no guard row."""
    s = await _scene(db)
    await _add_rule(db, "Rule A", _notify(watchers=True),
                    ("set_asset_status", {"status": "no-such-status"}))
    raw = RawScan(scanned_value="SN-A", scan_type="rfid", status=STATUS,
                  scanned_at=datetime.now(UTC), site_id=s.site)
    db.add(raw)
    await db.commit()

    assert await scan_worker.process_raw_scan(get_sessionmaker(), raw.id) == "error"
    assert await _events() == []
    assert await _guards() == []


async def test_a_session_reused_after_a_rollback_starts_clean(db):
    s = await _scene(db)
    broken = await _add_rule(db, "Rule A", _notify(watchers=True),
                             ("set_asset_status", {"status": "no-such-status"}))
    with pytest.raises(RuleExecutionError):
        await _match(db, asset=s.asset, site=s.site)
    await db.rollback()
    assert notify.NOTICES not in db.info

    # the same session, after the rule is fixed
    await db.delete(await db.get(StatusRule, broken))
    fixed = await _add_rule(db, "Rule B", _notify(watchers=True))
    invalidate_cache()
    await _match(db, asset=s.asset, site=s.site)
    await db.commit()
    [event] = await _events()
    assert (event.rule_id, event.item["count"], event.item["matched_ids"]) == (
        fixed, 1, [str(s.asset)])
    assert [r for r, *_ in await _guards()] == [fixed]


async def test_a_failed_bulk_update_announces_nothing(db):
    """The bulk update rolls back on a rule failure and goes on with the same session to
    record the failure: the rows it matched before are not announced with it."""
    s = await _scene(db)
    me = await mk_person(db)
    matched = await db.get(Asset, s.asset)
    matched.status = "active"
    broken = Asset(serial_number="SN-B", status="active")
    db.add(broken)
    await db.commit()
    await _add_rule(db, "Rule A", _notify(watchers=True), status="racked")
    await _add_rule(db, "Rule B", ("set_asset_status", {"status": "no-such-status"}),
                    status="labeled")
    job_id = await mk_job(
        db, me, f"asset_id,status\n{matched.legacy_id},racked\n{broken.legacy_id},labeled\n",
        options={"approve_all": True})

    assert await run_once(get_sessionmaker()) is True
    job = await fresh_job(job_id)
    assert (job.status, job.error) == ("failed", "rule_failed")
    assert await _events() == []
    assert await _guards() == []


async def test_a_savepoint_takes_back_only_its_own_matches(db):
    s = await _scene(db)
    early, kept_back, released, late = await _on_roster(
        db, s.initiative, "SN-B", "SN-C", "SN-D", "SN-E")
    rule = await _add_rule(db, "Rule A", _notify(watchers=True))

    # a savepoint begun before any match takes all of its own back
    with pytest.raises(RuntimeError):
        async with db.begin_nested():
            await _match(db, asset=early)
            raise RuntimeError("roll the savepoint back")
    await _match(db, asset=s.asset)
    # one begun after a match takes back only what came after it
    with pytest.raises(RuntimeError):
        async with db.begin_nested():
            await _match(db, asset=kept_back)
            raise RuntimeError("roll the savepoint back")
    # and a released one keeps its match, in the batch the commit announces: releasing a
    # savepoint is not the commit
    async with db.begin_nested():
        await _match(db, asset=released)
    await _match(db, asset=late)
    await db.commit()

    [event] = await _events()
    assert (event.item["count"], event.item["matched_ids"]) == (
        3, [str(s.asset), str(released), str(late)])
    assert {thing for r, _kind, thing, _at in await _guards() if r == rule} == {
        s.asset, released, late}


async def _duplicate_asset_id(db, asset_id) -> None:
    """Flush an asset that reuses another's Asset ID: the INSERT fails, and SQLAlchemy rolls
    the nearest savepoint back and leaves it inactive (the savepoint's own exit then closes
    it rather than rolling it back)."""
    taken = await db.scalar(select(Asset.legacy_id).where(Asset.id == asset_id))
    db.add(Asset(legacy_id=taken, serial_number="SN-DUPLICATE"))
    await db.flush()


async def test_a_savepoint_a_failed_flush_rolled_back_takes_its_match_back(db):
    """The match made inside the savepoint goes with it, guard row and all; the one before
    it is announced."""
    s = await _scene(db)
    [inside] = await _on_roster(db, s.initiative, "SN-B")
    rule = await _add_rule(db, "Rule A", _notify(watchers=True))

    await _match(db, asset=s.asset)
    with pytest.raises(IntegrityError):
        async with db.begin_nested():
            await _match(db, asset=inside)
            await _duplicate_asset_id(db, s.asset)
    await db.commit()

    [event] = await _events()
    assert (event.item["count"], event.item["matched_ids"]) == (1, [str(s.asset)])
    assert [thing for r, _kind, thing, _at in await _guards() if r == rule] == [s.asset]
    # its notice never went out, so the thing it took back notifies on its next match
    await _match(db, asset=inside)
    await db.commit()
    assert (await _events())[-1].item["matched_ids"] == [str(inside)]


async def test_a_failed_flush_takes_back_only_its_own_savepoint(db):
    """Two levels: the inner savepoint's flush fails, the outer one is released. The inner
    one takes back its match on the batch and the batch it began; the rest is announced."""
    s = await _scene(db)
    other = Initiative(name="Initiative C", initiative_type="move", status="in_progress")
    db.add(other)
    await db.commit()
    outer, inner, after = await _on_roster(db, s.initiative, "SN-B", "SN-C", "SN-D")
    [elsewhere] = await _on_roster(db, other.id, "SN-E")
    rule = await _add_rule(db, "Rule A", _notify(watchers=True))

    await _match(db, asset=s.asset)
    async with db.begin_nested():
        await _match(db, asset=outer)
        with pytest.raises(IntegrityError):
            async with db.begin_nested():
                await _match(db, asset=inner)           # on the batch begun before
                await _match(db, asset=elsewhere)       # a batch begun inside
                await _duplicate_asset_id(db, s.asset)
        await _match(db, asset=after)
    await db.commit()

    [event] = await _events()
    assert (event.subject_id, event.item["matched_ids"]) == (
        s.initiative, [str(s.asset), str(outer), str(after)])
    assert {thing for r, _kind, thing, _at in await _guards() if r == rule} == {
        s.asset, outer, after}


# ── soft states ─────────────────────────────────────────────────────

async def test_soft_states_skip_without_raising(db):
    s = await _scene(db)
    scan = await _scan(db, asset=s.asset, site=s.site)
    asset = await db.get(Asset, s.asset)
    everyone = {"people": [], "groups": [], "watchers": True}

    # a context built outside the engine names no rule
    assert await notify.apply(db, Context(scan=scan, asset=asset), everyone) == ActionOutcome(
        False, "no_rule")
    # the matched thing is missing from the context
    assert await notify.apply(db, Context(scan=scan, rule_id=uuid.uuid4(), rule_name="Rule A"),
                              everyone) == ActionOutcome(False, "no_asset")
    assert notify.NOTICES not in db.info
    await db.rollback()

    # nobody to tell: only watchers, and nothing to watch (no initiative, no scan site); or a
    # stored action with nobody chosen at all
    loose = Asset(serial_number="SN-L", status="unknown")
    db.add(loose)
    await db.commit()
    watchers = await _add_rule(db, "Rule A", _notify(watchers=True))
    nobody = await _add_rule(db, "Rule B", _notify(), priority=20)
    await _match(db, asset=loose.id)
    await db.commit()
    skipped = [{"action_type": "notify", "applied": False, "reason": "nobody_to_tell"}]
    assert await _outcomes(watchers) == [skipped]
    assert await _outcomes(nobody) == [skipped]
    assert await _events() == []
    assert await _guards() == []          # the hour was not spent


async def test_the_rules_params_are_never_changed(db):
    """The engine hands every scan the same params dict from its 60 s rule cache."""
    s = await _scene(db)
    person, group = await _named(db)
    stored = {"people": [str(person)], "groups": [str(group)], "watchers": True}
    await _add_rule(db, "Rule A", ("notify", copy.deepcopy(stored)))
    [other] = await _on_roster(db, s.initiative, "SN-B")

    await _match(db, asset=s.asset, site=s.site)          # the first of a batch
    await _match(db, asset=s.asset, site=s.site)          # a repeat
    await _match(db, asset=other, site=s.site)            # a later one of the batch
    await db.commit()
    assert len(await _events()) == 1
    [cached] = engine._cache[(STATUS, "asset")][1]
    assert cached["actions"] == [("notify", stored)]
