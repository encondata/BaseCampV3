"""The builder's Load from person… routes (spec 2026-10-20-badge-templates
§4.7, §4.11): `GET /labels/sample-people` searches staff and workers by
name (archived people and hidden move identities never appear) with their
type, company, photo and logo presence, natural-sorted; `GET
/labels/sample-person` returns one person's badge values. Both are
labels:view + rank 80, like /labels/sample-values."""

import uuid
from datetime import UTC, datetime

from serversherpa.db.models import (
    Client,
    Partner,
    Person,
    PersonRole,
    SystemConfig,
    WorkerProfile,
)
from serversherpa.labels.fields import PERSON_KEYS
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from tests.test_status_values_write import _make

PEOPLE = "/labels/sample-people"
ONE = "/labels/sample-person"
NOW = datetime.now(UTC)


async def _super(db, client):
    return await _make(db, client, "super_admin", "sp-sa@test.example.com")


async def _person(db, first, last, *, roles=(), profile=None, **over) -> Person:
    p = Person(first_name=first, last_name=last, **over)
    db.add(p)
    await db.flush()
    for role in roles:
        db.add(PersonRole(person_id=p.id, role=role))
    if profile is not None:
        db.add(WorkerProfile(person_id=p.id, **profile))
    await db.commit()
    return p


async def _partner(db, name, *, parent=None, logo=None) -> Partner:
    row = Partner(name=name, logo_key=logo, parent_id=parent.id if parent else None)
    db.add(row)
    await db.commit()
    return row


async def _search(client, hdrs, q="", **params):
    resp = await client.get(PEOPLE, headers=hdrs, params={"q": q, **params})
    assert resp.status_code == 200, resp.text
    return resp.json()


# ── sample-people ────────────────────────────────────────────────────

async def test_search_by_name_parts(client, db, seeded_user):
    hdrs = await _super(db, client)
    jordan = await _person(db, "Jordan", "Quillfeather", roles=("staff",))
    await _person(db, "Jordan", "Smith", roles=("worker",))
    avery = await _person(db, "Avery", "Quillfeather", roles=("worker",))
    pref = await _person(db, "Robert", "Quillfeather", preferred_name="Bobby",
                         roles=("worker",))
    got = await _search(client, hdrs, "jor quill")
    assert [r["person_id"] for r in got] == [str(jordan.id)]
    got = await _search(client, hdrs, "QUILLFEATHER")
    assert [r["name"] for r in got] == ["Avery Quillfeather", "Bobby Quillfeather",
                                        "Jordan Quillfeather"]
    # a preferred name matches, and so does the first name it stands in for
    assert [r["person_id"] for r in await _search(client, hdrs, "bobby")] == [str(pref.id)]
    assert [r["person_id"] for r in await _search(client, hdrs, "robert quill")] == [str(pref.id)]
    # the order the parts come in doesn't matter
    assert [r["person_id"] for r in await _search(client, hdrs, "quill avery")] == [str(avery.id)]
    # %, _ and \ are literal, not wildcards
    assert await _search(client, hdrs, "%") == []
    assert await _search(client, hdrs, "Jor_an") == []


async def test_staff_and_workers_both_listed_with_type_company_photo_and_logo(
        client, db, seeded_user):
    hdrs = await _super(db, client)
    db.add(SystemConfig(section="branding", data={"company_logo_key": "branding/c.png"}))
    await db.commit()
    top = await _partner(db, "Zephyr Holdings", logo="partners/top.png")
    crew = await _partner(db, "Zephyr Crew", parent=top)
    staff = await _person(db, "Zephyr", "Alpha", roles=("staff", "worker"),
                          avatar_key="people/a.jpg")
    worker = await _person(db, "Zephyr", "Bravo", roles=("worker",),
                           profile={"partner_id": crew.id, "trade": "Rigger"})
    bare = await _person(db, "Zephyr", "Charlie", profile={"trade": "Rigger"})
    got = await _search(client, hdrs, "zephyr")
    assert got == [
        {"person_id": str(staff.id), "name": "Zephyr Alpha", "person_type": "Staff",
         "company": "Cumulus Solutions Group", "has_photo": True, "has_logo": True},
        {"person_id": str(worker.id), "name": "Zephyr Bravo", "person_type": "Worker",
         "company": "Zephyr Crew", "has_photo": False, "has_logo": True},
        {"person_id": str(bare.id), "name": "Zephyr Charlie", "person_type": "Worker",
         "company": None, "has_photo": False, "has_logo": False},
    ]


async def test_archived_hidden_and_other_people_are_excluded(client, db, seeded_user):
    hdrs = await _super(db, client)
    keep = await _person(db, "Yarrow", "Kept", roles=("worker",))
    await _person(db, "Yarrow", "Archived", roles=("worker",), archived_at=NOW)
    await _person(db, "Yarrow", "Hidden", roles=("worker",), source=KIOSK_MOVE_SOURCE)
    await _person(db, "Yarrow", "Nobody")                  # no role, no profile
    gone = await _person(db, "Yarrow", "Former")
    db.add(PersonRole(person_id=gone.id, role="staff", revoked_at=NOW))
    org = Client(name=f"Client {uuid.uuid4().hex[:4]}")
    db.add(org)
    await db.flush()
    contact = await _person(db, "Yarrow", "Contact")
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=org.id))
    await db.commit()
    assert [r["person_id"] for r in await _search(client, hdrs, "yarrow")] == [str(keep.id)]
    # filtered in the query, so the people left out never use up the limit
    assert [r["person_id"] for r in await _search(client, hdrs, "yarrow", limit=1)] == [
        str(keep.id)]


async def test_natural_order_and_the_limit(client, db, seeded_user):
    hdrs = await _super(db, client)
    for n in (10, 2, 1):
        await _person(db, "Xeno", f"Crew {n}", roles=("worker",))
    got = await _search(client, hdrs, "xeno")
    assert [r["name"] for r in got] == ["Xeno Crew 1", "Xeno Crew 2", "Xeno Crew 10"]
    assert [r["name"] for r in await _search(client, hdrs, "xeno", limit=2)] == [
        "Xeno Crew 1", "Xeno Crew 2"]
    for bad in (0, 101):
        resp = await client.get(PEOPLE, headers=hdrs, params={"q": "xeno", "limit": bad})
        assert resp.status_code == 422
    # no query lists people too (the first page, natural by name)
    assert len(await _search(client, hdrs, limit=3)) == 3


async def test_blacklisted_workers_are_listed(client, db, seeded_user):
    """A designer may need a blacklisted worker's badge layout: the search
    lists them like anyone else."""
    hdrs = await _super(db, client)
    crew = await _partner(db, "Quarry Crew")
    barred = await _person(db, "Quinn", "Quarry", roles=("worker",),
                           profile={"partner_id": crew.id, "status": "blacklist",
                                    "status_note": "Site rules"})
    got = await _search(client, hdrs, "quinn")
    assert [(r["person_id"], r["person_type"], r["company"]) for r in got] == [
        (str(barred.id), "Worker", "Quarry Crew")]


async def test_the_search_reads_partners_once_for_every_row(client, db, seeded_user):
    """Each row's badge (type, company, logo up the partner chain) comes from
    lookups made once for the whole page: 50 workers under a 3-level partner
    chain cost what 5 do (it was 5 queries a worker)."""
    from sqlalchemy import event

    from serversherpa.db.engine import get_engine

    hdrs = await _super(db, client)
    top = await _partner(db, "Ridge Holdings", logo="partners/ridge.png")
    mid = await _partner(db, "Ridge Region", parent=top)
    low = await _partner(db, "Ridge Crew", parent=mid)
    engine = get_engine().sync_engine
    statements: list[str] = []

    def record(conn, cursor, statement, *rest):
        statements.append(statement)

    async def workers(first, count):
        for n in range(count):
            await _person(db, "Ridge", f"Worker {first + n}", roles=("worker",),
                          profile={"partner_id": low.id})

    async def measure(expected):
        statements.clear()
        event.listen(engine, "before_cursor_execute", record)
        try:
            got = await _search(client, hdrs, "ridge", limit=100)
        finally:
            event.remove(engine, "before_cursor_execute", record)
        assert len(got) == expected
        assert {(r["company"], r["has_logo"]) for r in got} == {("Ridge Crew", True)}
        return len(statements)

    await workers(0, 5)
    few = await measure(5)
    await workers(5, 45)
    many = await measure(50)
    assert few == many <= 15, (few, many)


async def test_sample_people_needs_rank_80(client, db, seeded_user):
    admin = await _make(db, client, "admin", "sp-admin@test.example.com")   # rank 60
    assert (await client.get(PEOPLE, headers=admin)).status_code == 403
    staff = await _make(db, client, "staff", "sp-staff@test.example.com")
    assert (await client.get(PEOPLE, headers=staff)).status_code == 403


# ── sample-person ────────────────────────────────────────────────────

async def test_values_for_a_worker(client, db, seeded_user):
    hdrs = await _super(db, client)
    top = await _partner(db, "Summit Group", logo="partners/summit.png")
    crew = await _partner(db, "Summit Crew", parent=top)
    worker = await _person(
        db, "Wren", "Walker", preferred_name="Wendy", roles=("worker",),
        job_title="Lead", external_id="E-42", email="wren@crew.test", phone="555-0100",
        avatar_key="people/w.jpg",
        profile={"partner_id": crew.id, "trade": "Electrician", "level": "L3",
                 "status": "active"})
    resp = await client.get(ONE, headers=hdrs, params={"person_id": str(worker.id)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["person_id"], body["has_photo"], body["has_logo"]) == (
        str(worker.id), True, True)
    values = body["values"]
    assert set(values) == set(PERSON_KEYS)
    assert values["person_name"] == "Wendy Walker"
    assert values["person_type"] == "Worker"
    assert values["trade"] == "Electrician"
    assert values["level"] == "L3 Technician"
    assert values["company"] == "Summit Crew"
    assert values["parent_company"] == "Summit Group"
    assert values["employee_id"] == "E-42"
    assert values["badge_id"] == str(worker.id)
    assert values["badge_short"] == str(worker.id)[:8]
    assert values["roles"] == ""


async def test_sample_person_works_the_badge_out_once(client, db, seeded_user, monkeypatch):
    """Its values and its photo and logo flags come from one badge lookup."""
    from serversherpa.labels import people_badge

    hdrs = await _super(db, client)
    crew = await _partner(db, "Once Crew", logo="partners/once.png")
    worker = await _person(db, "Oona", "Once", roles=("worker",),
                           profile={"partner_id": crew.id})
    calls = []
    real = people_badge._badge

    async def counting(*args, **kwargs):
        calls.append(args[1].id)
        return await real(*args, **kwargs)

    monkeypatch.setattr(people_badge, "_badge", counting)
    body = (await client.get(ONE, headers=hdrs, params={"person_id": str(worker.id)})).json()
    assert (body["values"]["company"], body["has_logo"]) == ("Once Crew", True)
    assert calls == [worker.id]


async def test_a_person_with_no_photo_or_logo(client, db, seeded_user):
    hdrs = await _super(db, client)
    p = await _person(db, "Nora", "None", roles=("worker",))
    body = (await client.get(ONE, headers=hdrs, params={"person_id": str(p.id)})).json()
    assert (body["has_photo"], body["has_logo"]) == (False, False)
    assert body["values"]["company"] == ""


async def test_unknown_and_hidden_people_are_not_found(client, db, seeded_user):
    hdrs = await _super(db, client)
    resp = await client.get(ONE, headers=hdrs, params={"person_id": str(uuid.uuid4())})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (404, "person_not_found")
    hidden = await _person(db, "Kiosk", "Identity", source=KIOSK_MOVE_SOURCE)
    resp = await client.get(ONE, headers=hdrs, params={"person_id": str(hidden.id)})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (404, "person_not_found")
    assert (await client.get(ONE, headers=hdrs, params={"person_id": "nope"})).status_code == 422
    # an archived person a template already samples still loads
    old = await _person(db, "Olga", "Archived", roles=("worker",), archived_at=NOW)
    assert (await client.get(ONE, headers=hdrs,
                             params={"person_id": str(old.id)})).status_code == 200


async def test_sample_person_needs_rank_80(client, db, seeded_user):
    admin = await _make(db, client, "admin", "sp1-admin@test.example.com")
    resp = await client.get(ONE, headers=admin, params={"person_id": str(seeded_user.id)})
    assert resp.status_code == 403
