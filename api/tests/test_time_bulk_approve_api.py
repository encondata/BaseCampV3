"""Bulk approve / reject on the Timesheet: ids or filter, dry run, skip
reasons, the 5,000 cap, one audit row per entry, and the time:change gate."""

import uuid
from datetime import timedelta

from sqlalchemy import func, select

from serversherpa.api.routes import time as time_routes
from serversherpa.db.models import AuditLog, Initiative, Person, Site, TimeEntry

from .test_assets_api import login
from .test_time_api import T0, _bump_admin


async def _person(db, first, last):
    p = Person(first_name=first, last_name=last)
    db.add(p)
    await db.flush()
    return p


def _entry(person, *, status="pending", day=0, initiative=None, site=None):
    start = T0 + timedelta(days=day)
    return TimeEntry(person_id=person.id, clock_in_at=start,
                     clock_out_at=start + timedelta(hours=8), status=status,
                     initiative_id=initiative.id if initiative else None,
                     site_id=site.id if site else None)


async def _audits(db, entry_id=None):
    query = select(AuditLog).where(AuditLog.entity_type == "time_entry")
    if entry_id is not None:
        query = query.where(AuditLog.entity_id == str(entry_id))
    return list(await db.scalars(query))


async def _admin(client, db, seeded_user):
    """seeded_user (alice) is staff; bump to admin and COMMIT before logging
    in, since the route runs in another session and must see the grant."""
    await _bump_admin(db, seeded_user)
    await db.commit()
    return await login(client)


async def _approved_count(db):
    return await db.scalar(select(func.count()).select_from(TimeEntry)
                           .where(TimeEntry.status == "approved"))


async def test_approve_by_ids_reports_each_skip_reason(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    pending, settled = _entry(owner), _entry(owner, status="approved", day=1)
    own = _entry(seeded_user, day=2)
    db.add_all([pending, settled, own])
    await db.commit()
    missing = uuid.uuid4()

    resp = await client.post("/time/entries/approve", headers=hdrs, json={
        "entry_ids": [str(pending.id), str(settled.id), str(own.id), str(missing)]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["approved"] == 1
    assert {(s["entry_id"], s["person"], s["reason"]) for s in body["skipped"]} == {
        (str(settled.id), "Ow Ner", "no longer pending"),
        (str(own.id), "Alice Anderson", "your own entry"),
        (str(missing), None, "not found"),
    }
    assert next(s for s in body["skipped"] if s["reason"] == "not found")["date"] is None
    await db.refresh(pending)
    await db.refresh(own)
    assert pending.status == "approved"
    assert pending.approved_by == seeded_user.id and pending.approved_at is not None
    assert own.status == "pending"
    [row] = await _audits(db, pending.id)
    assert row.action == "update"
    assert set(row.changes) == {"status", "approved_by", "approved_at"}
    assert await _audits(db, own.id) == []


async def test_one_audit_row_per_approved_entry(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    entries = [_entry(owner, day=d) for d in range(3)]
    db.add_all(entries)
    await db.commit()

    resp = await client.post("/time/entries/approve", headers=hdrs,
                             json={"entry_ids": [str(e.id) for e in entries]})
    assert resp.json() == {"approved": 3, "skipped": []}
    audits = await _audits(db)
    assert sorted(a.entity_id for a in audits) == sorted(str(e.id) for e in entries)
    assert {a.action for a in audits} == {"update"}


async def test_approve_by_filter_reaches_pending_only(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    other = await _person(db, "Ot", "Her")
    job = Initiative(name="Move A", initiative_type="move")
    elsewhere = Initiative(name="Move B", initiative_type="move")
    db.add_all([job, elsewhere])
    await db.flush()
    hit1 = _entry(owner, initiative=job)
    hit2 = _entry(other, day=1, initiative=job)
    settled = _entry(owner, status="rejected", day=2, initiative=job)
    own = _entry(seeded_user, day=3, initiative=job)
    miss = _entry(owner, day=4, initiative=elsewhere)
    db.add_all([hit1, hit2, settled, own, miss])
    await db.commit()

    resp = await client.post("/time/entries/approve", headers=hdrs,
                             json={"filter": {"initiative_id": str(job.id)}})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["approved"] == 2
    assert [(s["entry_id"], s["reason"]) for s in body["skipped"]] == [
        (str(own.id), "your own entry")]
    statuses = dict((await db.execute(select(TimeEntry.id, TimeEntry.status))).all())
    assert statuses[hit1.id] == statuses[hit2.id] == "approved"
    assert statuses[settled.id] == "rejected"
    assert statuses[own.id] == statuses[miss.id] == "pending"


async def test_filter_by_person_site_and_clock_in_window(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    other = await _person(db, "Ot", "Her")
    dc = Site(name="DC East")
    db.add(dc)
    await db.flush()
    early = _entry(owner, day=0, site=dc)
    inside = _entry(owner, day=2, site=dc)
    no_site = _entry(owner, day=2)
    someone_else = _entry(other, day=2, site=dc)
    db.add_all([early, inside, no_site, someone_else])
    await db.commit()

    resp = await client.post("/time/entries/approve", headers=hdrs, json={"filter": {
        "person_id": str(owner.id), "site_id": str(dc.id),
        "from": (T0 + timedelta(days=1)).isoformat(),
        "to": (T0 + timedelta(days=3)).isoformat()}})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"approved": 1, "skipped": []}
    statuses = dict((await db.execute(select(TimeEntry.id, TimeEntry.status))).all())
    assert statuses[inside.id] == "approved"
    assert {statuses[e.id] for e in (early, no_site, someone_else)} == {"pending"}


async def test_dry_run_counts_and_writes_nothing(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    db.add_all([_entry(owner), _entry(owner, day=1), _entry(seeded_user, day=2)])
    await db.commit()

    resp = await client.post("/time/entries/approve?dry_run=1", headers=hdrs,
                             json={"filter": {}})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"count": 2}
    assert await _approved_count(db) == 0
    assert await _audits(db) == []


async def test_exactly_one_of_ids_or_filter(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    for body in ({}, {"entry_ids": [], "filter": {}}):
        resp = await client.post("/time/entries/approve", headers=hdrs, json=body)
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "ids_or_filter"


async def test_the_5000_cap_for_ids_and_filters(client, db, seeded_user, monkeypatch):
    hdrs = await _admin(client, db, seeded_user)
    assert time_routes.BULK_LIMIT == 5000
    ids = [str(uuid.uuid4()) for _ in range(5001)]
    resp = await client.post("/time/entries/approve", headers=hdrs, json={"entry_ids": ids})
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "too_many", "limit": 5000}
    resp = await client.post("/time/entries/reject", headers=hdrs,
                             json={"entry_ids": ids, "reason": "no"})
    assert resp.json()["detail"]["code"] == "too_many"

    owner = await _person(db, "Ow", "Ner")
    db.add_all([_entry(owner, day=d) for d in range(3)])
    await db.commit()
    monkeypatch.setattr(time_routes, "BULK_LIMIT", 2)
    for url in ("/time/entries/approve?dry_run=1", "/time/entries/approve"):
        resp = await client.post(url, headers=hdrs, json={"filter": {}})
        assert resp.status_code == 422
        assert resp.json()["detail"] == {"code": "too_many", "limit": 2}
    assert await _approved_count(db) == 0


async def test_bulk_reject_needs_a_reason_and_applies_it_to_each(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    a, b = _entry(owner), _entry(owner, day=1)
    done = _entry(owner, status="approved", day=2)
    db.add_all([a, b, done])
    await db.commit()
    ids = [str(a.id), str(b.id), str(done.id)]

    resp = await client.post("/time/entries/reject", headers=hdrs,
                             json={"entry_ids": ids, "reason": "   "})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "reason_required"

    resp = await client.post("/time/entries/reject", headers=hdrs,
                             json={"entry_ids": ids, "reason": " No show "})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rejected"] == 2
    assert [(s["entry_id"], s["reason"]) for s in body["skipped"]] == [
        (str(done.id), "no longer pending")]
    for e in (a, b):
        await db.refresh(e)
        assert (e.status, e.reject_reason) == ("rejected", "No show")
        [row] = await _audits(db, e.id)
        assert set(row.changes) == {"status", "reject_reason"}


async def test_bulk_routes_need_time_change(client, db, seeded_user):
    hdrs = await login(client)          # seeded_user is staff: time:view only
    for url, body in (("/time/entries/approve", {"filter": {}}),
                      ("/time/entries/reject", {"entry_ids": [], "reason": "x"})):
        resp = await client.post(url, headers=hdrs, json=body)
        assert resp.status_code == 403


async def test_entries_list_filters_by_site(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    dc = Site(name="DC East")
    db.add(dc)
    await db.flush()
    here, there = _entry(owner, site=dc), _entry(owner, day=1)
    db.add_all([here, there])
    await db.commit()

    resp = await client.get("/time/entries", headers=hdrs, params={"site_id": str(dc.id)})
    assert resp.status_code == 200, resp.text
    assert [r["id"] for r in resp.json()] == [str(here.id)]
