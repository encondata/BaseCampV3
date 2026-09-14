"""Kiosk timeclock: GET /kiosk/timeclock/{person_id} plus POST
/kiosk/timeclock/clock-in and /clock-out — the kiosk clocking the
worker standing in front of it in and out of the portal's own
time_entries, using the site and move from the kiosk's setup. All three
are kiosk:view, act on ANOTHER person, and write (so read-only mode
blocks the two POSTs)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, Device, Initiative, Person, Site, TimeEntry, WorkerProfile,
)
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_sites_api import login
from tests.test_status_values_write import _make
from tests.test_system_admin_api import _admin

SERIAL = "kiosk-web-timeclock-1"
UNKNOWN_ID = "00000000-0000-0000-0000-000000000000"
T0 = datetime(2026, 9, 14, 13, 0, tzinfo=UTC)


async def _seed_context(db):
    """A site, a move, and a kiosk Device set up on both."""
    site = Site(name="NAP7 Timeclock Hall")
    initiative = Initiative(name="NAP7 Timeclock Move", initiative_type="move",
                            status="in_progress")
    db.add_all([site, initiative])
    await db.flush()
    device = Device(device_type="kiosk", name="Timeclock Kiosk", serial=SERIAL,
                    site_id=site.id, current_initiative_id=initiative.id)
    db.add(device)
    await db.flush()
    return site, initiative, device


async def _seed_worker(db, *, first="Tina", last="Timeclock", rfid="T-RFID-9",
                       archived=None):
    person = Person(first_name=first, last_name=last, preferred_name="Tee",
                    rfid_tag=rfid, archived_at=archived)
    db.add(person)
    await db.flush()
    db.add(WorkerProfile(person_id=person.id))
    await db.commit()
    return person


def _in(person, **kw):
    return {"serial": SERIAL, "person_id": str(person.id), **kw}


# ── status ──────────────────────────────────────────────────────────

async def test_status_for_a_person_with_no_entries(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_context(db)
    person = await _seed_worker(db)

    resp = await client.get(f"/kiosk/timeclock/{person.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["clocked_in"] is False
    assert body["entry"] is None
    assert body["person"]["id"] == str(person.id)
    assert body["person"]["display_name"] == "Tee Timeclock"
    assert body["person"]["first_name"] == "Tina"
    assert body["person"]["last_name"] == "Timeclock"
    assert body["person"]["preferred_name"] == "Tee"
    assert body["person"]["rfid_tag"] == "T-RFID-9"
    assert body["person"]["avatar_url"] is None


async def test_status_unknown_person_is_404(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get(f"/kiosk/timeclock/{UNKNOWN_ID}", headers=hdrs)
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "person_not_found"


async def test_status_archived_person_is_404(client, db, seeded_user):
    hdrs = await login(client)
    gone = await _seed_worker(db, first="Gone", rfid="G-RFID-9",
                              archived=datetime.now(UTC))
    resp = await client.get(f"/kiosk/timeclock/{gone.id}", headers=hdrs)
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "person_not_found"


# ── clock in ────────────────────────────────────────────────────────

async def test_clock_in_creates_an_open_entry_and_audits(client, db, seeded_user):
    hdrs = await login(client)
    site, initiative, device = await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)

    resp = await client.post("/kiosk/timeclock/clock-in", headers=hdrs, json=_in(
        person, site_id=str(site.id), initiative_id=str(initiative.id),
        at=T0.isoformat()))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["clocked_in"] is True
    assert body["entry"]["started_at"].startswith("2026-09-14T13:00:00")
    assert body["entry"]["site_id"] == str(site.id)
    assert body["entry"]["site_name"] == "NAP7 Timeclock Hall"
    assert body["entry"]["initiative_id"] == str(initiative.id)
    assert body["entry"]["initiative_name"] == "NAP7 Timeclock Move"

    entry = await db.scalar(select(TimeEntry).where(TimeEntry.person_id == person.id))
    assert entry is not None
    assert str(entry.id) == body["entry"]["id"]
    assert entry.clock_out_at is None
    assert entry.status == "open"
    assert entry.source == "kiosk"
    assert entry.device_id == device.id
    assert entry.site_id == site.id
    assert entry.initiative_id == initiative.id
    assert entry.created_by == seeded_user.id

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "time_entry", AuditLog.action == "kiosk_clock_in"))
    assert row is not None
    assert row.entity_id == str(entry.id)
    assert row.actor_person_id == seeded_user.id
    assert row.changes == {"person_id": str(person.id), "site_id": str(site.id),
                           "initiative_id": str(initiative.id),
                           "device_id": str(device.id)}


async def test_status_reports_the_open_entry(client, db, seeded_user):
    hdrs = await login(client)
    site, initiative, _device = await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)
    assert (await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                              json=_in(person, at=T0.isoformat()))).status_code == 200

    body = (await client.get(f"/kiosk/timeclock/{person.id}", headers=hdrs)).json()
    assert body["clocked_in"] is True
    assert body["entry"]["started_at"].startswith("2026-09-14T13:00:00")
    assert body["entry"]["site_id"] == str(site.id)
    assert body["entry"]["initiative_id"] == str(initiative.id)


async def test_clock_in_twice_is_409(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)
    first = await client.post("/kiosk/timeclock/clock-in", headers=hdrs, json=_in(person))
    assert first.status_code == 200, first.text

    resp = await client.post("/kiosk/timeclock/clock-in", headers=hdrs, json=_in(person))
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "already_clocked_in"
    assert resp.json()["detail"]["entry_id"] == first.json()["entry"]["id"]


async def test_clock_in_falls_back_to_the_device_setup(client, db, seeded_user):
    hdrs = await login(client)
    site, initiative, _device = await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)

    resp = await client.post("/kiosk/timeclock/clock-in", headers=hdrs, json=_in(person))
    assert resp.status_code == 200, resp.text
    entry = resp.json()["entry"]
    assert entry["site_id"] == str(site.id)
    assert entry["initiative_id"] == str(initiative.id)


async def test_clock_in_rejects_bad_refs(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)

    resp = await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                             json=_in(person, site_id=UNKNOWN_ID))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_site"

    resp = await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                             json=_in(person, initiative_id=UNKNOWN_ID))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_initiative"


async def test_clock_in_unknown_person_and_device(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)
    gone = await _seed_worker(db, first="Gone", rfid="G-RFID-8",
                              archived=datetime.now(UTC))

    resp = await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                             json={"serial": SERIAL, "person_id": UNKNOWN_ID})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "person_not_found"

    resp = await client.post("/kiosk/timeclock/clock-in", headers=hdrs, json=_in(gone))
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "person_not_found"

    resp = await client.post("/kiosk/timeclock/clock-in", headers=hdrs, json={
        "serial": "no-such-kiosk", "person_id": str(person.id)})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "device_not_found"


# ── clock out ───────────────────────────────────────────────────────

async def test_clock_out_closes_the_entry_and_audits(client, db, seeded_user):
    hdrs = await login(client)
    _site, _initiative, device = await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)
    assert (await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                              json=_in(person, at=T0.isoformat()))).status_code == 200

    out_at = T0 + timedelta(hours=3, minutes=12)
    resp = await client.post("/kiosk/timeclock/clock-out", headers=hdrs,
                             json=_in(person, at=out_at.isoformat()))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["clocked_in"] is False
    assert body["entry"] is None
    assert body["last_entry"]["minutes"] == 192
    assert body["last_entry"]["started_at"].startswith("2026-09-14T13:00:00")
    assert body["last_entry"]["ended_at"].startswith("2026-09-14T16:12:00")

    entry = await db.scalar(select(TimeEntry).where(TimeEntry.person_id == person.id))
    await db.refresh(entry)
    assert entry.clock_out_at == out_at
    assert entry.status == "pending"
    assert str(entry.id) == body["last_entry"]["id"]

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "time_entry", AuditLog.action == "kiosk_clock_out"))
    assert row is not None
    assert row.entity_id == str(entry.id)
    assert row.actor_person_id == seeded_user.id
    assert row.changes["status"] == {"from": "open", "to": "pending"}
    assert row.changes["device_id"] == str(device.id)


async def test_clock_out_twice_is_409(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)
    assert (await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                              json=_in(person))).status_code == 200
    assert (await client.post("/kiosk/timeclock/clock-out", headers=hdrs,
                              json=_in(person))).status_code == 200

    resp = await client.post("/kiosk/timeclock/clock-out", headers=hdrs, json=_in(person))
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "not_clocked_in"


async def test_clock_out_before_the_start_is_422(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)
    assert (await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                              json=_in(person, at=T0.isoformat()))).status_code == 200

    resp = await client.post("/kiosk/timeclock/clock-out", headers=hdrs, json=_in(
        person, at=(T0 - timedelta(minutes=1)).isoformat()))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_time"

    entry = await db.scalar(select(TimeEntry).where(TimeEntry.person_id == person.id))
    await db.refresh(entry)
    assert entry.clock_out_at is None      # still open


# ── the portal sees it ──────────────────────────────────────────────

async def test_the_entry_shows_up_in_the_portal_time_endpoints(client, db, seeded_user):
    """The kiosk punch is a first-class portal time entry: staff see it
    through GET /time/entries, which is what 'the portal's time tracking
    updates' means."""
    hdrs = await login(client)
    site, initiative, _device = await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)
    assert (await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                              json=_in(person, at=T0.isoformat()))).status_code == 200

    resp = await client.get(f"/time/entries?person_id={person.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["person_name"] == "Tina Timeclock"
    assert rows[0]["status"] == "open"
    assert rows[0]["source"] == "kiosk"
    assert rows[0]["site_id"] == str(site.id)
    assert rows[0]["initiative_id"] == str(initiative.id)

    assert (await client.post("/kiosk/timeclock/clock-out", headers=hdrs,
                              json=_in(person, at=(T0 + timedelta(hours=2)).isoformat())
                              )).status_code == 200
    rows = (await client.get(f"/time/entries?person_id={person.id}", headers=hdrs)).json()
    assert rows[0]["status"] == "pending"
    assert rows[0]["minutes"] == 120


# ── gates ───────────────────────────────────────────────────────────

async def test_a_worker_can_clock_another_worker_in(client, db, seeded_user):
    """Any kiosk user may punch any worker — the kiosk operator is the
    one standing at the screen, and the audit row names them."""
    await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)
    w = await _make(db, client, "worker", "w-timeclock@test.example.com")

    resp = await client.post("/kiosk/timeclock/clock-in", headers=w, json=_in(person))
    assert resp.status_code == 200, resp.text
    assert resp.json()["clocked_in"] is True
    assert (await client.get(f"/kiosk/timeclock/{person.id}",
                             headers=w)).status_code == 200

    operator = await db.scalar(select(Person).where(
        Person.email == "w-timeclock@test.example.com"))
    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "time_entry", AuditLog.action == "kiosk_clock_in"))
    assert row.actor_person_id == operator.id


async def test_timeclock_personas(client, db, seeded_user):
    await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)
    cv = await _client_viewer(db, client, "cv-timeclock@test.example.com")
    assert (await client.get(f"/kiosk/timeclock/{person.id}",
                             headers=cv)).status_code == 403
    assert (await client.post("/kiosk/timeclock/clock-in", headers=cv,
                              json=_in(person))).status_code == 403
    assert (await client.post("/kiosk/timeclock/clock-out", headers=cv,
                              json=_in(person))).status_code == 403
    assert (await client.get(f"/kiosk/timeclock/{person.id}")).status_code == 401


async def test_timeclock_blocked_in_read_only_mode(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_context(db)
    await db.commit()
    person = await _seed_worker(db)
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200

    assert (await client.post("/kiosk/timeclock/clock-in", headers=hdrs,
                              json=_in(person))).status_code == 423
    assert (await client.post("/kiosk/timeclock/clock-out", headers=hdrs,
                              json=_in(person))).status_code == 423
    # reads stay open
    assert (await client.get(f"/kiosk/timeclock/{person.id}",
                             headers=hdrs)).status_code == 200
