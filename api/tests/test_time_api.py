"""Time API — punch clock, timesheet approvals, per-initiative summary,
and the access gates around them."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog, Client, Initiative, Person, PersonRole, Site, TimeEntry,
    UserAccount,
)
from serversherpa.security.passwords import hash_password

from .test_assets_api import _client_contact, login, make_login
from .test_status_values_write import _make

PW = "CorrectHorse9!"

T0 = datetime(2026, 8, 27, 9, 0, tzinfo=UTC)
ZERO_UUID = "00000000-0000-0000-0000-000000000000"


async def _bump_admin(db, person):
    """seeded_user (alice) is staff — bump to admin for time:add/change gates."""
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.flush()


async def test_clock_in_open_and_blocks_double(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/time/clock-in", headers=hdrs, json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "open"
    assert body["clock_out_at"] is None
    assert body["minutes"] == 0
    assert body["source"] == "punch"
    assert body["person_name"] == "Alice Anderson"

    resp = await client.post("/time/clock-in", headers=hdrs, json={})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "already_clocked_in"


async def test_clock_in_validates_refs(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/time/clock-in", headers=hdrs,
                             json={"initiative_id": ZERO_UUID})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"

    resp = await client.post("/time/clock-in", headers=hdrs,
                             json={"site_id": ZERO_UUID})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "site_not_found"


async def test_clock_out_computes_minutes(client, db, seeded_user):
    hdrs = await login(client)
    # frozen clock-in far enough in the past that flooring is stable even
    # with a little test-execution slack.
    clock_in = datetime.now(UTC) - timedelta(minutes=65, seconds=30)
    db.add(TimeEntry(person_id=seeded_user.id, clock_in_at=clock_in))
    await db.commit()

    resp = await client.post("/time/clock-out", headers=hdrs, json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "pending"
    assert body["clock_out_at"] is not None
    assert body["minutes"] == 65


async def test_clock_out_deducts_break_minutes(client, db, seeded_user):
    hdrs = await login(client)
    clock_in = datetime.now(UTC) - timedelta(minutes=125, seconds=30)
    db.add(TimeEntry(person_id=seeded_user.id, clock_in_at=clock_in))
    await db.commit()

    resp = await client.post("/time/clock-out", headers=hdrs,
                             json={"break_minutes": 30, "notes": "lunch"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["break_minutes"] == 30
    assert body["minutes"] == 95
    assert body["notes"] == "lunch"


async def test_clock_out_invalid_break(client, db, seeded_user):
    hdrs = await login(client)
    clock_in = datetime.now(UTC) - timedelta(minutes=10)
    db.add(TimeEntry(person_id=seeded_user.id, clock_in_at=clock_in))
    await db.commit()

    resp = await client.post("/time/clock-out", headers=hdrs,
                             json={"break_minutes": -1})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_break"

    resp = await client.post("/time/clock-out", headers=hdrs,
                             json={"break_minutes": 50})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_break"


async def test_clock_out_without_open_entry(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/time/clock-out", headers=hdrs, json={})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "not_clocked_in"


async def test_time_me_returns_open_and_history(client, db, seeded_user):
    hdrs = await login(client)
    db.add(TimeEntry(person_id=seeded_user.id, clock_in_at=T0,
                     clock_out_at=T0 + timedelta(hours=8), status="approved"))
    await db.commit()

    resp = await client.post("/time/clock-in", headers=hdrs, json={})
    assert resp.status_code == 200, resp.text

    resp = await client.get("/time/me", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["open"] is not None
    assert body["open"]["status"] == "open"
    assert len(body["entries"]) == 2
    assert body["entries"][0]["status"] == "open"          # newest first
    assert body["entries"][1]["status"] == "approved"


async def test_punch_options_filters(client, db, seeded_user):
    hdrs = await login(client)
    site_active = Site(name="Site A")
    site_archived = Site(name="Site B", archived_at=T0)
    init_open = Initiative(name="Init Open", initiative_type="project",
                           status="in_progress")
    init_done = Initiative(name="Init Done", initiative_type="project",
                           status="completed")
    init_archived = Initiative(name="Init Arch", initiative_type="project",
                               status="planned", archived_at=T0)
    db.add_all([site_active, site_archived, init_open, init_done, init_archived])
    await db.commit()

    resp = await client.get("/time/punch-options", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    site_names = {s["name"] for s in body["sites"]}
    assert "Site A" in site_names
    assert "Site B" not in site_names
    init_names = {i["name"] for i in body["initiatives"]}
    assert "Init Open" in init_names
    assert "Init Done" not in init_names
    assert "Init Arch" not in init_names


async def test_punch_options_scoped_actor_gets_empty_lists(client, db, seeded_user):
    """Sites and initiatives are internal-only (visible_to global) — a
    client-scoped actor must not see them via punch-options, even though
    punching itself carries no resource gate."""
    db.add_all([Site(name="Internal Site"),
               Initiative(name="Internal Init", initiative_type="project",
                          status="in_progress")])
    await db.commit()

    _org, chdrs = await _client_contact(db, client, "PunchCo", "punch-client@test.example.com")
    resp = await client.get("/time/punch-options", headers=chdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["initiatives"] == []
    assert body["sites"] == []

    # a global-anchored (staff) actor still sees the populated lists
    hdrs = await login(client)
    resp = await client.get("/time/punch-options", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert any(i["name"] == "Internal Init" for i in body["initiatives"])
    assert any(s["name"] == "Internal Site" for s in body["sites"])


async def test_manual_entry_validates_range_and_creates(client, db, seeded_user):
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    worker = Person(first_name="Man", last_name="Ual")
    db.add(worker)
    await db.commit()

    resp = await client.post("/time/entries", headers=hdrs, json={
        "person_id": str(worker.id),
        "clock_in_at": T0.isoformat(),
        "clock_out_at": (T0 - timedelta(hours=1)).isoformat(),
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_range"

    resp = await client.post("/time/entries", headers=hdrs, json={
        "person_id": str(worker.id),
        "clock_in_at": T0.isoformat(),
        "clock_out_at": (T0 + timedelta(hours=8)).isoformat(),
        "notes": "manual entry",
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "pending"
    assert body["source"] == "manual"
    assert body["minutes"] == 480
    assert body["person_name"] == "Man Ual"


async def test_manual_entry_invalid_break(client, db, seeded_user):
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    worker = Person(first_name="Man", last_name="Ual")
    db.add(worker)
    await db.commit()

    resp = await client.post("/time/entries", headers=hdrs, json={
        "person_id": str(worker.id),
        "clock_in_at": T0.isoformat(),
        "clock_out_at": (T0 + timedelta(hours=8)).isoformat(),
        "break_minutes": -10,
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_break"

    resp = await client.post("/time/entries", headers=hdrs, json={
        "person_id": str(worker.id),
        "clock_in_at": T0.isoformat(),
        "clock_out_at": (T0 + timedelta(hours=8)).isoformat(),
        "break_minutes": 480,
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_break"


async def test_patch_invalid_break(client, db, seeded_user):
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    entry = TimeEntry(person_id=seeded_user.id, clock_in_at=T0,
                      clock_out_at=T0 + timedelta(hours=8), status="pending")
    db.add(entry)
    await db.commit()

    resp = await client.patch(f"/time/entries/{entry.id}", headers=hdrs, json={
        "break_minutes": 480, "adjust_reason": "bad break"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_break"

    # a shortened clock_out can make the *existing* break invalid even
    # though break_minutes itself isn't part of this patch.
    entry2 = TimeEntry(person_id=seeded_user.id, clock_in_at=T0,
                       clock_out_at=T0 + timedelta(hours=8),
                       break_minutes=400, status="pending")
    db.add(entry2)
    await db.commit()

    resp = await client.patch(f"/time/entries/{entry2.id}", headers=hdrs, json={
        "clock_out_at": (T0 + timedelta(hours=1)).isoformat(),
        "adjust_reason": "shortened shift"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_break"


async def test_clock_in_and_manual_create_audit_initial_status(client, db, seeded_user):
    """Clock-in and manual-create must leave a provenance trail for the
    entry's INITIAL status, not just later transitions."""
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)

    resp = await client.post("/time/clock-in", headers=hdrs, json={})
    assert resp.status_code == 200, resp.text
    entry_id = resp.json()["id"]
    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "time_entry", AuditLog.entity_id == entry_id,
        AuditLog.action == "clock_in"))
    assert row.changes == {"status": {"from": None, "to": "open"}}

    worker = Person(first_name="Man", last_name="Ual")
    db.add(worker)
    await db.commit()
    resp = await client.post("/time/entries", headers=hdrs, json={
        "person_id": str(worker.id),
        "clock_in_at": T0.isoformat(),
        "clock_out_at": (T0 + timedelta(hours=8)).isoformat(),
    })
    assert resp.status_code == 201, resp.text
    created_id = resp.json()["id"]
    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "time_entry", AuditLog.entity_id == created_id,
        AuditLog.action == "create"))
    assert row.changes == {"status": {"from": None, "to": "pending"}}


async def test_patch_rejects_explicit_null_clock_out(client, db, seeded_user):
    """Re-opening a closed entry via PATCH is unsupported — an explicit
    clock_out_at: null must 422, not silently null the column (which would
    collide with the one-open-entry-per-person unique index)."""
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    entry = TimeEntry(person_id=seeded_user.id, clock_in_at=T0,
                      clock_out_at=T0 + timedelta(hours=8), status="pending")
    db.add(entry)
    await db.commit()

    resp = await client.patch(f"/time/entries/{entry.id}", headers=hdrs, json={
        "clock_out_at": None, "adjust_reason": "trying to reopen"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_range"


async def test_patch_closes_open_entry_to_pending(client, db, seeded_user):
    """PATCHing a clock_out onto a still-open entry must graduate it to
    pending (with minutes computed) so it can be approved — otherwise it's
    stuck open forever."""
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    # entry belongs to someone other than the approving admin — approving
    # one's own entry is a separate, disallowed path (see
    # test_approve_rejects_self_approval below).
    other = Person(first_name="Ot", last_name="Her")
    db.add(other)
    await db.flush()
    entry = TimeEntry(person_id=other.id, clock_in_at=T0, status="open")
    db.add(entry)
    await db.commit()

    resp = await client.patch(f"/time/entries/{entry.id}", headers=hdrs, json={
        "clock_out_at": (T0 + timedelta(hours=8)).isoformat(),
        "adjust_reason": "manager closed out shift"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "pending"
    assert body["minutes"] == 480

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "time_entry", AuditLog.entity_id == str(entry.id),
        AuditLog.action == "update"))
    assert row.changes["status"] == {"from": "open", "to": "pending"}

    resp = await client.post(f"/time/entries/{entry.id}/approve", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "approved"


async def test_patch_notes_only_skips_break_revalidation(client, db, seeded_user):
    """A notes-only PATCH on an entry whose existing (already-valid) span
    happens to be 0 minutes must not spuriously 422 — the invalid_break
    check only applies when the patch actually touches
    clock_in_at/clock_out_at/break_minutes."""
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    # clock_out is 30s after clock_in — a valid span at creation time
    # (clock_out > clock_in) that floors to 0 *minutes*.
    entry = TimeEntry(person_id=seeded_user.id, clock_in_at=T0,
                      clock_out_at=T0 + timedelta(seconds=30), break_minutes=0,
                      status="pending")
    db.add(entry)
    await db.commit()

    resp = await client.patch(f"/time/entries/{entry.id}", headers=hdrs,
                              json={"notes": "no time fields touched"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["notes"] == "no time fields touched"


async def test_clock_in_race_loser_gets_409(client, db, seeded_user, monkeypatch):
    """The loser of a concurrent clock-in misses the pre-check and hits
    one_open_entry_per_person — that must surface as the same 409, not an
    unhandled IntegrityError."""
    from serversherpa.api.routes import time as time_routes

    hdrs = await login(client)
    db.add(TimeEntry(person_id=seeded_user.id, clock_in_at=T0))
    await db.commit()

    async def _races_past_check(db, person_id):
        return None

    monkeypatch.setattr(time_routes, "_open_entry_for", _races_past_check)
    resp = await client.post("/time/clock-in", headers=hdrs, json={})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "already_clocked_in"


async def test_patch_requires_adjust_reason_for_time_fields(client, db, seeded_user):
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    entry = TimeEntry(person_id=seeded_user.id, clock_in_at=T0,
                      clock_out_at=T0 + timedelta(hours=8), status="pending")
    db.add(entry)
    await db.commit()

    resp = await client.patch(f"/time/entries/{entry.id}", headers=hdrs,
                              json={"break_minutes": 15})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "adjust_reason_required"

    resp = await client.patch(f"/time/entries/{entry.id}", headers=hdrs, json={
        "break_minutes": 15, "adjust_reason": "forgot to log break"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["adjusted"] is True
    assert body["adjust_reason"] == "forgot to log break"
    assert body["break_minutes"] == 15

    # notes-only edits don't touch the adjustment machinery
    resp = await client.patch(f"/time/entries/{entry.id}", headers=hdrs,
                              json={"notes": "no adjustment needed"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["notes"] == "no adjustment needed"


async def test_patch_approved_entry_drops_to_pending(client, db, seeded_user):
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    entry = TimeEntry(
        person_id=seeded_user.id, clock_in_at=T0,
        clock_out_at=T0 + timedelta(hours=8), status="approved",
        approved_by=seeded_user.id, approved_at=T0)
    db.add(entry)
    await db.commit()

    resp = await client.patch(f"/time/entries/{entry.id}", headers=hdrs, json={
        "clock_out_at": (T0 - timedelta(hours=1)).isoformat(),
        "adjust_reason": "bad edit"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_range"

    resp = await client.patch(f"/time/entries/{entry.id}", headers=hdrs, json={
        "clock_out_at": (T0 + timedelta(hours=9)).isoformat(),
        "adjust_reason": "extra hour worked"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "pending"
    assert body["approved_by"] is None
    assert body["approved_at"] is None
    assert body["minutes"] == 540


async def test_approve_reject_transitions_and_conflicts(client, db, seeded_user):
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    # entries belong to someone other than the approving admin — self
    # approval is covered separately by test_approve_rejects_self_approval.
    owner = Person(first_name="Ow", last_name="Ner")
    db.add(owner)
    await db.flush()
    pending = TimeEntry(person_id=owner.id, clock_in_at=T0,
                        clock_out_at=T0 + timedelta(hours=8), status="pending")
    db.add(pending)
    await db.commit()

    resp = await client.post(f"/time/entries/{pending.id}/approve", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "approved"
    assert body["approved_by"] == str(seeded_user.id)
    assert body["approved_at"] is not None

    resp = await client.post(f"/time/entries/{pending.id}/approve", headers=hdrs)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "not_pending"

    other = TimeEntry(person_id=owner.id, clock_in_at=T0,
                      clock_out_at=T0 + timedelta(hours=4), status="pending")
    db.add(other)
    await db.commit()

    resp = await client.post(f"/time/entries/{other.id}/reject", headers=hdrs,
                             json={"reason": "no show"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "rejected"
    assert body["reject_reason"] == "no show"

    resp = await client.post(f"/time/entries/{other.id}/reject", headers=hdrs,
                             json={"reason": "again"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "not_pending"


async def test_reject_requires_reason(client, db, seeded_user):
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    entry = TimeEntry(person_id=seeded_user.id, clock_in_at=T0,
                      clock_out_at=T0 + timedelta(hours=8), status="pending")
    db.add(entry)
    await db.commit()

    resp = await client.post(f"/time/entries/{entry.id}/reject", headers=hdrs,
                             json={"reason": ""})
    assert resp.status_code == 422


async def test_entries_filters(client, db, seeded_user):
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    other = Person(first_name="Other", last_name="Worker")
    db.add(other)
    await db.flush()
    db.add_all([
        TimeEntry(person_id=seeded_user.id, clock_in_at=T0,
                 clock_out_at=T0 + timedelta(hours=8), status="approved"),
        TimeEntry(person_id=other.id, clock_in_at=T0 + timedelta(days=1),
                 clock_out_at=T0 + timedelta(days=1, hours=8), status="pending"),
    ])
    await db.commit()

    resp = await client.get("/time/entries", headers=hdrs,
                            params={"person_id": str(other.id)})
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["person_id"] == str(other.id)

    resp = await client.get("/time/entries", headers=hdrs,
                            params={"status": "approved"})
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["status"] == "approved"

    cutoff = (T0 + timedelta(hours=12)).isoformat()
    resp = await client.get("/time/entries", headers=hdrs, params={"since": cutoff})
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["person_id"] == str(other.id)

    resp = await client.get("/time/entries", headers=hdrs, params={"until": cutoff})
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["person_id"] == str(seeded_user.id)


async def test_active_entries(client, db, seeded_user):
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    other = Person(first_name="Ac", last_name="Tive")
    db.add(other)
    await db.flush()
    db.add_all([
        TimeEntry(person_id=seeded_user.id, clock_in_at=T0),
        TimeEntry(person_id=other.id, clock_in_at=T0 + timedelta(minutes=5)),
        TimeEntry(person_id=other.id, clock_in_at=T0 - timedelta(days=1),
                 clock_out_at=T0 - timedelta(days=1) + timedelta(hours=1),
                 status="approved"),
    ])
    await db.commit()

    resp = await client.get("/time/active", headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 2
    assert all(r["clock_out_at"] is None for r in rows)
    assert rows[0]["person_id"] == str(seeded_user.id)   # oldest first


async def test_summary_per_initiative_math(client, db, seeded_user):
    # staff (seeded_user's default role) already holds initiatives:view
    hdrs = await login(client)
    initiative = Initiative(name="Init-A", initiative_type="project")
    other_initiative = Initiative(name="Init-B", initiative_type="project")
    db.add_all([initiative, other_initiative])
    await db.flush()
    p1 = Person(first_name="P", last_name="One")
    p2 = Person(first_name="P", last_name="Two")
    db.add_all([p1, p2])
    await db.flush()
    db.add_all([
        TimeEntry(person_id=p1.id, initiative_id=initiative.id, clock_in_at=T0,
                 clock_out_at=T0 + timedelta(hours=8), status="approved"),
        TimeEntry(person_id=p1.id, initiative_id=initiative.id,
                 clock_in_at=T0 + timedelta(days=1),
                 clock_out_at=T0 + timedelta(days=1, hours=4), status="pending"),
        TimeEntry(person_id=p2.id, initiative_id=initiative.id,
                 clock_in_at=T0 + timedelta(days=2), status="open"),
        # a rejected entry must not count toward either bucket
        TimeEntry(person_id=p2.id, initiative_id=initiative.id,
                 clock_in_at=T0 + timedelta(days=3),
                 clock_out_at=T0 + timedelta(days=3, hours=2), status="rejected"),
        # noise on a different initiative — must not leak in
        TimeEntry(person_id=p1.id, initiative_id=other_initiative.id,
                 clock_in_at=T0, clock_out_at=T0 + timedelta(hours=1),
                 status="approved"),
    ])
    await db.commit()

    resp = await client.get("/time/summary", headers=hdrs,
                            params={"initiative_id": str(initiative.id)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["approved_minutes"] == 480
    assert body["pending_minutes"] == 240
    assert body["open_count"] == 1
    by_person = {p["person_id"]: p for p in body["people"]}
    assert by_person[str(p1.id)]["approved_minutes"] == 480
    assert by_person[str(p1.id)]["pending_minutes"] == 240
    assert by_person[str(p1.id)]["entry_count"] == 2
    assert str(p2.id) not in by_person  # only a rejected + an open entry


async def test_time_gates_worker_and_staff(client, db, seeded_user):
    worker = Person(first_name="Wk", last_name="Puncher")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()
    whdrs = await make_login(db, client, worker, "wk-punch@test.example.com")

    # worker: self-service punch clock works, gated endpoints don't
    resp = await client.post("/time/clock-in", headers=whdrs, json={})
    assert resp.status_code == 200, resp.text
    entry_id = resp.json()["id"]

    resp = await client.get("/time/me", headers=whdrs)
    assert resp.status_code == 200

    resp = await client.get("/time/entries", headers=whdrs)
    assert resp.status_code == 403

    resp = await client.get("/time/active", headers=whdrs)
    assert resp.status_code == 403

    resp = await client.post(f"/time/entries/{entry_id}/approve", headers=whdrs)
    assert resp.status_code == 403

    # staff (seeded_user, time:view only): can list but not mutate
    shdrs = await login(client)
    resp = await client.get("/time/entries", headers=shdrs)
    assert resp.status_code == 200

    resp = await client.post(f"/time/entries/{entry_id}/approve", headers=shdrs)
    assert resp.status_code == 403

    resp = await client.post("/time/entries", headers=shdrs, json={
        "person_id": str(worker.id),
        "clock_in_at": T0.isoformat(),
        "clock_out_at": (T0 + timedelta(hours=1)).isoformat(),
    })
    assert resp.status_code == 403


async def test_provenance_after_approve(client, db, seeded_user):
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)
    # entry belongs to someone other than the approving admin — approving
    # one's own entry is disallowed (test_approve_rejects_self_approval).
    other = Person(first_name="Ot", last_name="Her")
    db.add(other)
    await db.flush()
    entry = TimeEntry(person_id=other.id, clock_in_at=T0,
                      clock_out_at=T0 + timedelta(hours=8), status="pending")
    db.add(entry)
    await db.commit()

    resp = await client.post(f"/time/entries/{entry.id}/approve", headers=hdrs)
    assert resp.status_code == 200, resp.text

    resp = await client.get("/status/provenance", headers=hdrs, params={
        "entity_type": "time_entry", "entity_id": str(entry.id),
        "status": "approved"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "edit"
    assert body["actor_name"] == "Alice Anderson"


async def test_summary_requires_time_view_not_initiatives_view(client, db, seeded_user):
    """GET /time/summary must gate on time:view — a client_viewer holds
    initiatives:view (and can see the initiative itself) but has no time
    grant at all, so this must 403, not fall through to the initiative
    scope check."""
    org = Client(name="Acme")
    db.add(org)
    await db.flush()
    initiative = Initiative(name="Acme move", initiative_type="move",
                            sub_type="migration", client_id=org.id)
    db.add(initiative)
    await db.flush()

    viewer = Person(first_name="Cl", last_name="Viewer", email="clv@test.example.com")
    db.add(viewer)
    await db.flush()
    db.add(UserAccount(
        person_id=viewer.id, email="clv@test.example.com",
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=viewer.id, role="client_viewer", client_id=org.id))
    await db.commit()
    hdrs = await login(client, email="clv@test.example.com")

    # sanity: the client_viewer really can see the initiative itself.
    resp = await client.get(f"/initiatives/{initiative.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text

    resp = await client.get("/time/summary", headers=hdrs,
                            params={"initiative_id": str(initiative.id)})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"

    # a global user with time:view still gets the summary.
    await _bump_admin(db, seeded_user)
    ahdrs = await login(client)
    resp = await client.get("/time/summary", headers=ahdrs,
                            params={"initiative_id": str(initiative.id)})
    assert resp.status_code == 200, resp.text


async def test_clock_in_requires_a_time_tracked_role(client, db, seeded_user):
    """clock-in/out must not accept a bare authenticated account: `external`
    (no grants at all) is refused, while a `worker` (the primary punch-clock
    persona, but without an explicit time:view grant) still works."""
    ext_hdrs = await _make(db, client, "external", "ext-punch@test.example.com")
    resp = await client.post("/time/clock-in", headers=ext_hdrs, json={})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"

    worker = Person(first_name="Wk", last_name="Two")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()
    whdrs = await make_login(db, client, worker, "wk-two@test.example.com")
    resp = await client.post("/time/clock-in", headers=whdrs, json={})
    assert resp.status_code == 200, resp.text

    resp = await client.post("/time/clock-out", headers=whdrs, json={})
    assert resp.status_code == 200, resp.text


async def test_clock_out_also_requires_a_time_tracked_role(client, db, seeded_user):
    """The clock-out gate is checked independently of clock-in — an
    external account can't fake around it by having an open entry inserted
    directly (e.g. by another path)."""
    ext_hdrs = await _make(db, client, "external", "ext-punchout@test.example.com")
    resp = await client.post("/time/clock-out", headers=ext_hdrs, json={})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_approve_rejects_self_approval(client, db, seeded_user):
    """A time:change holder must not approve or reject their own entry —
    otherwise a staff/admin who also punches the clock could self-approve
    their own timesheet."""
    await _bump_admin(db, seeded_user)
    hdrs = await login(client)

    own_entry = TimeEntry(person_id=seeded_user.id, clock_in_at=T0,
                          clock_out_at=T0 + timedelta(hours=8), status="pending")
    other = Person(first_name="Ot", last_name="Her2")
    db.add(other)
    await db.flush()
    others_entry = TimeEntry(person_id=other.id, clock_in_at=T0,
                             clock_out_at=T0 + timedelta(hours=8), status="pending")
    db.add_all([own_entry, others_entry])
    await db.commit()

    resp = await client.post(f"/time/entries/{own_entry.id}/approve", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "cannot_target_self"

    resp = await client.post(f"/time/entries/{own_entry.id}/reject", headers=hdrs,
                             json={"reason": "n/a"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "cannot_target_self"

    resp = await client.post(f"/time/entries/{others_entry.id}/approve", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "approved"
