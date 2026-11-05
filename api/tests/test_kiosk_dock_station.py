"""Dock station type (migration 0120): `devices.station_type` accepts 'dock',
Kiosk Setup pairs a reader for it like an RFID Station, and a Dock Station's
key gets the RFID Station's treatment (sync, scan upload, telemetry heartbeat,
client assets, sounds, RFID-only scan types). Spec:
docs/superpowers/specs/2026-11-05-dock-station-design.md"""

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import AuditLog, Container, Device, DockPass, RawScan
from serversherpa.services import station_keys
from tests.test_devices_config_api import _kiosk, _move
from tests.test_kiosk_config_sync import _doc
from tests.test_kiosk_config_sync import login as kiosk_login
from tests.test_kiosk_heartbeat_reader import REPORT, RSERIAL
from tests.test_kiosk_station_key import SERIAL, _audits, _code
from tests.test_kiosk_station_scans import _auth, _scan, _station
from tests.test_kiosk_station_setup import READER, _device, _setup_body
from tests.test_notification_groups_api import login_staff
from tests.test_sites_api import login


async def _dock_station(db, person_id=None):
    """A registered Dock laptop with a paired reader and a key for its move.
    -> (device, move, key)."""
    device, init, _ = await _station(db, person_id=person_id)
    live = await db.get(Device, device.id)
    live.station_type = "dock"
    live.rfid_reader_serial = RSERIAL
    live.rfid_reader_ip = "10.20.30.40"
    live.rfid_reader_model = "FX9600"
    key = await station_keys.issue(db, live, actor_id=person_id, via="password")
    await db.commit()
    return device, init, key


async def _readers(db):
    db.expire_all()
    return (await db.scalars(select(Device).where(Device.device_type == "fixed_reader"))).all()


async def test_migration_allows_dock_station_type(db):
    d = Device(device_type="kiosk", name="Dock", serial=f"dk-{uuid.uuid4().hex[:8]}",
               sub_type="laptop", station_type="dock")
    db.add(d)
    await db.flush()   # no IntegrityError
    d.station_type = "bogus"
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()


async def test_dock_pass_row_follows_its_device_and_crate(db):
    device = Device(device_type="kiosk", name="Dock", serial=f"dk-{uuid.uuid4().hex[:8]}",
                    sub_type="laptop", station_type="dock")
    crate = Container(name=f"Crate {uuid.uuid4().hex[:6]}")
    db.add_all([device, crate])
    await db.flush()
    device_id, crate_id, pass_id = device.id, crate.id, uuid.uuid4()
    db.add(DockPass(id=pass_id, device_id=device_id, container_id=crate_id,
                    closed_at=datetime.now(UTC), reply={"assets": []}))
    await db.commit()

    row = await db.get(DockPass, pass_id)
    assert row.created_at is not None and row.reply == {"assets": []}
    # a deleted crate leaves the pass (and its reply) behind
    await db.delete(await db.get(Container, crate_id))
    await db.commit()
    db.expire_all()
    assert (await db.get(DockPass, pass_id)).container_id is None
    # a deleted device takes its passes with it
    await db.delete(await db.get(Device, device_id))
    await db.commit()
    db.expire_all()
    assert await db.get(DockPass, pass_id) is None


async def test_dock_setup_needs_reader_and_laptop(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    r = await client.post("/kiosk/setup", headers=hdrs, json={**body, "station_type": "dock"})
    assert r.status_code == 422 and _code(r) == "reader_required"
    assert (await _device(db, device_id)).station_type is None


async def test_dock_setup_needs_a_laptop(client, db, seeded_user):
    hdrs = await login(client)
    body, device_id = await _setup_body(db, sub_type="android")
    r = await client.post("/kiosk/setup", headers=hdrs,
                          json={**body, "station_type": "dock", "reader": READER})
    assert r.status_code == 422 and _code(r) == "rfid_needs_laptop"
    assert (await _device(db, device_id)).station_type is None


async def test_dock_setup_stamps_reader_and_key_issues(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    r = await client.post("/kiosk/setup", headers=hdrs,
                          json={**body, "station_type": "dock", "reader": READER})
    assert r.status_code == 200, r.text
    d = await _device(db, device_id)
    assert d.station_type == "dock"
    assert str(d.rfid_reader_ip) == "10.20.30.40"
    assert d.rfid_reader_serial == "FX9600-AB12"
    assert d.rfid_reader_model == "FX9600"
    assert d.rfid_reader_versions == READER["versions"]
    assert d.rfid_paired_at is not None

    # the dock laptop is signed in on its own session; it may take a key
    d.session_person_id = uid
    d.token_expires_at = datetime.now(UTC) + timedelta(days=30)
    await db.commit()
    issued = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert issued.status_code == 200, issued.text
    assert issued.json()["key"]
    assert (await _device(db, device_id)).station_key_hash is not None

    # setting it up again as an RFID Station is a station type change: the key goes
    r = await client.post("/kiosk/setup", headers=hdrs,
                          json={**body, "station_type": "rfid", "reader": READER})
    assert r.status_code == 200, r.text
    d = await _device(db, device_id)
    assert d.station_type == "rfid" and d.station_key_hash is None
    [row] = await _audits(db, SimpleNamespace(id=device_id), "station_key_revoke")
    assert row.changes == {"reason": "station_type_change"}


async def test_dock_key_syncs_and_uploads(client, db, seeded_user):
    device, init, key = await _dock_station(db)
    params = {"serial": SERIAL, "initiative_id": str(init.id)}
    for path in ("/kiosk/station/sync/assets", "/kiosk/station/sync/containers",
                 "/kiosk/station/sync/client-assets"):
        r = await client.get(path, headers=_auth(key), params=params)
        assert r.status_code == 200, (path, r.text)

    r = await client.post("/kiosk/station/scans", headers=_auth(key), json={
        "serial": SERIAL, "scans": [_scan("EPC-DOCK-OFF", off_move=True),
                                    _scan("EPC-DOCK-ON")]})
    assert r.status_code == 200, r.text
    assert len(r.json()["accepted"]) == 2 and r.json()["rejected"] == []
    db.expire_all()
    off = await db.scalar(select(RawScan).where(RawScan.scanned_value == "EPC-DOCK-OFF"))
    on = await db.scalar(select(RawScan).where(RawScan.scanned_value == "EPC-DOCK-ON"))
    assert off.off_move is True and on.off_move is False
    assert off.device_id == device.name and off.operator_id is None
    assert off.scan_type == "rfid"


async def test_dock_station_heartbeat_keeps_key_and_applies_reader(client, db, seeded_user):
    device, _, key = await _dock_station(db)
    r = await client.post("/kiosk/station/heartbeat", headers=_auth(key),
                          json={"serial": SERIAL, "version": "2.0", "reader": REPORT})
    assert r.status_code == 200, r.text
    db.expire_all()
    live = await db.get(Device, device.id)
    assert live.last_seen_at is not None and live.version == "2.0"
    (fr,) = await _readers(db)
    assert fr.serial == RSERIAL and fr.raw_info["via_kiosk_id"] == str(device.id)
    (a,) = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "self_register", AuditLog.entity_id == str(fr.id)))).all()
    assert a.actor_person_id is None
    got = await station_keys.verify(db, SERIAL, key)
    assert got is not None and got.id == device.id


async def test_dock_key_reaches_sounds(client, db, seeded_user):
    _, _, key = await _dock_station(db)
    r = await client.get(f"/kiosk/sounds/{uuid.uuid4()}", headers=_auth(key),
                         params={"serial": SERIAL})
    assert r.status_code == 404 and _code(r) == "sound_not_found"


async def test_dock_scan_type_options_are_rfid_only(client, db, seeded_user):
    move, origin, _ = await _move(db)
    device = await _kiosk(db, sub_type="laptop", station_type="dock",
                          current_initiative_id=move.id, site_id=origin.id)
    hdrs = await login_staff(client, seeded_user)
    body = (await client.get(f"/devices/{device.id}", headers=hdrs)).json()
    options = body["scan_type_options"]
    assert options
    assert all("rfid" in o["label"].lower() for o in options)


async def test_person_heartbeat_skips_config_on_keyed_dock(client, db, seeded_user):
    """A keyed Dock laptop syncs config only on the station route, like a keyed
    RFID Station; its own signed-in session still gets the scan type."""
    device, _, _key = await _dock_station(db, person_id=seeded_user.id)
    live = await db.get(Device, device.id)
    live.config = _doc(flash_ms=1234)
    live.config_version = 2
    live.scan_status = "pre_stage"
    await db.commit()
    hdrs = await kiosk_login(client)
    r = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": SERIAL, "name": "Station 1", "mode": "laptop", "sign_in": True,
        "config_applied_version": 1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["config"] is None and body["config_version"] == 2
    assert body["scan_status"] == "pre_stage"
    db.expire_all()
    live = await db.get(Device, device.id)
    assert live.config["appearance"]["flash_ms"] == 1234
    assert live.config_applied_version is None
