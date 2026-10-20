"""Station-key time clock: GET /kiosk/station/timeclock/{person_id} and POST
/kiosk/station/timeclock/clock-in / clock-out, the signed-out Time Clock
laptop punching whoever badges in (`Authorization: Station <key>`, no person
session). Clock-in always uses the device's own setup; clock-out closes any
open shift. People sync takes a Time Clock key with no move."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, Initiative, Person, TimeEntry, WorkerProfile
from serversherpa.services import timeclock
from tests.test_kiosk_station_key import SERIAL
from tests.test_kiosk_station_scans import _auth, _station
from tests.test_kiosk_timeclock_station_key import _timeclock_station
from tests.test_system_admin_api import _admin


async def _worker(db, first="Stella"):
    person = Person(first_name=first, last_name="Station", rfid_tag=f"TC-{uuid.uuid4().hex[:6]}")
    db.add(person)
    await db.flush()
    db.add(WorkerProfile(person_id=person.id))
    await db.commit()
    pid = person.id
    db.expunge(person)
    return pid


def _body(pid):
    return {"serial": SERIAL, "person_id": str(pid)}


async def _clock_in(client, key, pid):
    return await client.post("/kiosk/station/timeclock/clock-in", headers=_auth(key),
                             json=_body(pid))


async def _clock_out(client, key, pid):
    return await client.post("/kiosk/station/timeclock/clock-out", headers=_auth(key),
                             json=_body(pid))


async def test_station_clock_in_uses_device_setup(client, db, seeded_user):
    device, init, key = await _timeclock_station(db)
    live = await db.get(Device, device.id)
    site_id = live.site_id
    assert site_id is not None and live.current_initiative_id == init.id
    pid = await _worker(db)

    r = await _clock_in(client, key, pid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["clocked_in"] is True
    assert body["entry"]["initiative_id"] == str(init.id)
    assert body["entry"]["site_id"] == str(site_id)

    db.expire_all()
    entry = await db.scalar(select(TimeEntry).where(TimeEntry.person_id == pid))
    assert entry.initiative_id == init.id
    assert entry.site_id == site_id
    assert entry.source == "kiosk"
    assert entry.device_id == device.id
    assert entry.created_by is None
    assert entry.clock_out_at is None
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "kiosk_clock_in", AuditLog.entity_id == str(entry.id)))
    assert row.actor_person_id is None
    assert row.changes["via"] == "station_key"
    assert row.changes["person_id"] == str(pid)
    assert row.changes["device_id"] == str(device.id)

    # the status read under the key agrees
    r = await client.get(f"/kiosk/station/timeclock/{pid}", headers=_auth(key),
                         params={"serial": SERIAL})
    assert r.status_code == 200, r.text
    assert r.json()["clocked_in"] is True
    assert r.json()["entry"]["id"] == str(entry.id)


async def test_station_clock_in_no_move(client, db, seeded_user):
    device, _, key = await _timeclock_station(db)
    live = await db.get(Device, device.id)
    live.current_initiative_id = None
    live.station_key_initiative_id = None
    await db.commit()
    pid = await _worker(db)

    r = await _clock_in(client, key, pid)
    assert r.status_code == 200, r.text
    assert r.json()["entry"]["initiative_id"] is None
    db.expire_all()
    entry = await db.scalar(select(TimeEntry).where(TimeEntry.person_id == pid))
    assert entry.initiative_id is None


async def test_station_clock_out_closes_any_open_shift(client, db, seeded_user):
    device, _, key = await _timeclock_station(db)
    other = Initiative(name="Some Other Move", initiative_type="move", status="in_progress")
    db.add(other)
    await db.flush()
    pid = await _worker(db)
    # a shift another move's kiosk opened
    entry = await timeclock.create_open_entry(
        db, person_id=pid, initiative_id=other.id,
        clock_in_at=datetime.now(UTC) - timedelta(hours=2), source="kiosk")
    await db.commit()
    entry_id = entry.id

    r = await _clock_out(client, key, pid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["clocked_in"] is False
    assert body["last_entry"]["id"] == str(entry_id)
    db.expire_all()
    closed = await db.get(TimeEntry, entry_id)
    assert closed.clock_out_at is not None
    assert closed.status == "pending"
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "kiosk_clock_out", AuditLog.entity_id == str(entry_id)))
    assert row.actor_person_id is None
    assert row.changes["via"] == "station_key"
    assert row.changes["device_id"] == str(device.id)

    r = await _clock_out(client, key, pid)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "not_clocked_in"


async def test_station_clock_in_twice_409(client, db, seeded_user):
    _, _, key = await _timeclock_station(db)
    pid = await _worker(db)
    first = await _clock_in(client, key, pid)
    assert first.status_code == 200, first.text
    r = await _clock_in(client, key, pid)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "already_clocked_in"
    assert detail["entry_id"] == first.json()["entry"]["id"]


async def test_station_timeclock_unknown_person_404(client, db, seeded_user):
    _, _, key = await _timeclock_station(db)
    r = await client.get(f"/kiosk/station/timeclock/{uuid.uuid4()}", headers=_auth(key),
                         params={"serial": SERIAL})
    assert r.status_code == 404 and r.json()["detail"]["code"] == "person_not_found"
    r = await _clock_in(client, key, uuid.uuid4())
    assert r.status_code == 404 and r.json()["detail"]["code"] == "person_not_found"


async def test_station_timeclock_refuses_upload_keys(client, db, seeded_user):
    _, _, key = await _station(db)   # an RFID Station key
    pid = await _worker(db)
    r = await client.get(f"/kiosk/station/timeclock/{pid}", headers=_auth(key),
                         params={"serial": SERIAL})
    assert r.status_code == 403 and r.json()["detail"] == {"code": "wrong_station_type"}
    for r in (await _clock_in(client, key, pid), await _clock_out(client, key, pid)):
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == {"code": "wrong_station_type"}
    db.expire_all()
    assert await db.scalar(select(TimeEntry).where(TimeEntry.person_id == pid)) is None


async def test_station_timeclock_bad_key_401(client, db, seeded_user):
    await _timeclock_station(db)
    pid = await _worker(db)
    r = await client.post("/kiosk/station/timeclock/clock-in",
                          headers=_auth("not-the-key"), json=_body(pid))
    assert r.status_code == 401 and r.json()["detail"]["code"] == "station_key_invalid"
    r = await client.post("/kiosk/station/timeclock/clock-in", json=_body(pid))
    assert r.status_code == 401


async def test_station_timeclock_read_only_mode(client, db, seeded_user):
    _, _, key = await _timeclock_station(db)
    pid = await _worker(db)
    assert (await _clock_in(client, key, pid)).status_code == 200
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200
    for r in (await _clock_out(client, key, pid), await _clock_in(client, key, pid)):
        assert r.status_code == 423, r.text
        assert r.json()["detail"]["code"] == "read_only_mode"
    db.expire_all()
    entry = await db.scalar(select(TimeEntry).where(TimeEntry.person_id == pid))
    assert entry.clock_out_at is None   # the clock-out never landed
    # the status read still answers during a freeze
    r = await client.get(f"/kiosk/station/timeclock/{pid}", headers=_auth(key),
                         params={"serial": SERIAL})
    assert r.status_code == 200 and r.json()["clocked_in"] is True


async def test_station_sync_people_timeclock_without_move(client, db, seeded_user):
    device, init, key = await _timeclock_station(db)
    pid = await _worker(db)
    # absent, or equal to the key move: both fine for a Time Clock key
    r = await client.get("/kiosk/station/sync/people", headers=_auth(key),
                         params={"serial": SERIAL})
    assert r.status_code == 200, r.text
    assert str(pid) in {p["id"] for p in r.json()["people"]}
    r = await client.get("/kiosk/station/sync/people", headers=_auth(key),
                         params={"serial": SERIAL, "initiative_id": str(init.id)})
    assert r.status_code == 200, r.text
    r = await client.get("/kiosk/station/sync/people", headers=_auth(key),
                         params={"serial": SERIAL, "initiative_id": str(uuid.uuid4())})
    assert r.status_code == 403 and r.json()["detail"] == {"code": "move_locked"}
    # a Time Clock key with no move at all
    live = await db.get(Device, device.id)
    live.current_initiative_id = None
    live.station_key_initiative_id = None
    await db.commit()
    r = await client.get("/kiosk/station/sync/people", headers=_auth(key),
                         params={"serial": SERIAL})
    assert r.status_code == 200, r.text
    # the Time Clock key is still refused on the other sync routes
    r = await client.get("/kiosk/station/sync/assets", headers=_auth(key),
                         params={"serial": SERIAL, "initiative_id": str(init.id)})
    assert r.status_code == 403 and r.json()["detail"] == {"code": "wrong_station_type"}


async def test_station_sync_people_upload_key_needs_its_move(client, db, seeded_user):
    _, init, key = await _station(db)
    r = await client.get("/kiosk/station/sync/people", headers=_auth(key),
                         params={"serial": SERIAL})
    assert r.status_code == 403 and r.json()["detail"] == {"code": "move_locked"}
    r = await client.get("/kiosk/station/sync/people", headers=_auth(key),
                         params={"serial": SERIAL, "initiative_id": str(init.id)})
    assert r.status_code == 200, r.text
    r = await client.get("/kiosk/station/sync/people", headers=_auth(key),
                         params={"serial": SERIAL, "initiative_id": str(uuid.uuid4())})
    assert r.status_code == 403 and r.json()["detail"] == {"code": "move_locked"}
