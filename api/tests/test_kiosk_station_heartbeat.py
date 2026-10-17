"""POST /kiosk/station/heartbeat: an RFID Station's telemetry (last seen,
version, the paired reader's snapshot) under its station key, no person
session. It never renews registration and never fails over a bad reader.
The person heartbeat still accepts `reader` but ignores it."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device
from tests.test_kiosk_heartbeat_reader import REPORT, RSERIAL
from tests.test_kiosk_station_key import SERIAL
from tests.test_kiosk_station_scans import _auth, _station
from tests.test_sites_api import login
from tests.test_system_admin_api import _admin


async def _set(db, device, **fields):
    live = await db.get(Device, device.id)
    for k, v in fields.items():
        setattr(live, k, v)
    await db.commit()


async def _get(db, device):
    db.expire_all()
    return await db.get(Device, device.id)


async def _readers(db):
    db.expire_all()
    return (await db.scalars(select(Device).where(Device.device_type == "fixed_reader"))).all()


async def _beat(client, key, **body):
    headers = _auth(key) if key is not None else {}
    return await client.post("/kiosk/station/heartbeat", headers=headers,
                             json={"serial": SERIAL, **body})


async def test_station_heartbeat_stamps_last_seen_and_version(client, db, seeded_user):
    uid = seeded_user.id
    device, _, key = await _station(db)
    old_seen = datetime.now(UTC) - timedelta(hours=1)
    expires = datetime.now(UTC) + timedelta(days=30)
    started = datetime.now(UTC) - timedelta(hours=2)
    await _set(db, device, last_seen_at=old_seen, version="1.0",
               raw_info={"os": "mac"}, token_expires_at=expires,
               session_person_id=uid, session_login_method="password",
               session_started_at=started)
    r = await _beat(client, key, version="2.0")
    assert r.status_code == 200, r.text
    assert r.json() == {"registration": "ok",
                        "token_expires_at": r.json()["token_expires_at"],
                        "clear_setup": None,
                        # kiosk settings sync (test_kiosk_config_sync.py)
                        "server_time": r.json()["server_time"],
                        "config_version": 0, "config": None,
                        "scan_status": None, "scan_status_label": None}
    live = await _get(db, device)
    assert live.last_seen_at > old_seen
    assert live.version == "2.0"
    assert live.raw_info == {"os": "mac"}
    assert live.token_expires_at == expires
    assert live.session_person_id == uid
    assert live.session_login_method == "password"
    assert live.session_started_at == started


async def test_station_heartbeat_without_version_keeps_it(client, db, seeded_user):
    device, _, key = await _station(db)
    await _set(db, device, version="1.0")
    assert (await _beat(client, key)).status_code == 200
    assert (await _get(db, device)).version == "1.0"


async def test_station_heartbeat_applies_reader(client, db, seeded_user):
    device, _, key = await _station(db)
    await _set(db, device, rfid_reader_serial=RSERIAL)
    r = await _beat(client, key, reader=REPORT)
    assert r.status_code == 200, r.text
    (fr,) = await _readers(db)
    assert fr.serial == RSERIAL and fr.name == "FX9600647D23"
    assert fr.mac is None and fr.raw_info["mac"] == "C4:7D:CC:64:7D:23"
    assert fr.lan_ip == "10.10.48.119"
    assert fr.model == "FX9600" and fr.version == "3.32.37.0"
    assert fr.uptime_seconds == 1285577 and fr.antennas_connected == 2
    assert fr.connection_type == "local_api"
    assert fr.raw_info["via_kiosk_id"] == str(device.id)
    (a,) = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "self_register", AuditLog.entity_id == str(fr.id)))).all()
    assert a.actor_person_id is None


async def test_station_heartbeat_bad_reader_still_200(client, db, seeded_user):
    device, _, key = await _station(db)
    await _set(db, device, rfid_reader_serial=RSERIAL)
    before = (await _get(db, device)).last_seen_at
    r = await _beat(client, key, reader={**REPORT, "mac": "not-a-mac"})
    assert r.status_code == 200, r.text
    after = (await _get(db, device)).last_seen_at
    assert after is not None and (before is None or after > before)
    assert await _readers(db) == []


async def test_station_heartbeat_needs_key(client, db, seeded_user):
    await _station(db)
    r = await _beat(client, None)
    assert r.status_code == 401
    assert r.json()["detail"] == {"code": "station_key_invalid"}
    r = await _beat(client, "wrong-key")
    assert r.status_code == 401
    assert r.json()["detail"] == {"code": "station_key_invalid"}


async def test_station_heartbeat_lapsed_is_403(client, db, seeded_user):
    device, _, key = await _station(db)
    old_seen = datetime.now(UTC) - timedelta(hours=1)
    await _set(db, device, last_seen_at=old_seen,
               token_expires_at=datetime.now(UTC) - timedelta(days=1))
    r = await _beat(client, key)
    assert r.status_code == 403
    assert r.json()["detail"] == {"code": "kiosk_not_registered"}
    live = await _get(db, device)
    assert live.station_key_hash is not None
    assert live.last_seen_at == old_seen


async def test_station_heartbeat_never_renews_registration(client, db, seeded_user):
    device, _, key = await _station(db)
    expires = datetime.now(UTC) + timedelta(days=3)
    await _set(db, device, token_expires_at=expires)
    r = await _beat(client, key)
    assert r.status_code == 200, r.text
    assert r.json()["registration"] == "soon"
    assert (await _get(db, device)).token_expires_at == expires


async def test_station_heartbeat_blocked_in_read_only_mode(client, db, seeded_user):
    device, _, key = await _station(db)
    await _set(db, device, version="1.0")
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200
    r = await _beat(client, key, version="3.0")
    assert r.status_code == 423
    assert r.json()["detail"]["code"] == "read_only_mode"
    assert (await _get(db, device)).version == "1.0"


async def test_station_heartbeat_returns_clear_setup(client, db, seeded_user):
    device, _, key = await _station(db)
    pending = uuid.uuid4()
    await _set(db, device, setup_clear_id=pending)
    r = await _beat(client, key)
    assert r.status_code == 200, r.text
    assert r.json()["clear_setup"] == str(pending)


async def test_person_heartbeat_ignores_reader(client, db, seeded_user):
    device, _, _ = await _station(db)
    await _set(db, device, rfid_reader_serial=RSERIAL)
    hdrs = await login(client)
    r = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": SERIAL, "name": "Station 1", "mode": "laptop", "reader": REPORT})
    assert r.status_code == 200, r.text
    assert await _readers(db) == []
