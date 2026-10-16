"""Kiosk heartbeat `reader`: an RFID Station's paired reader is upserted as a
fixed_reader Device. A bad or unacceptable report never changes the beat."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device
from tests.test_kiosk_setup_api import SERIAL
from tests.test_kiosk_station_setup import READER, _device, _setup_body
from tests.test_sites_api import login

RSERIAL = READER["serial"]
BEAT = {"serial": SERIAL, "name": "Station Target", "mode": "laptop"}
REPORT = {
    "serial": RSERIAL, "make": "Zebra", "model": "FX9600", "name": "FX9600647D23",
    "mac": "C4:7D:CC:64:7D:23", "ip": "10.10.48.119", "firmware": "3.32.37.0",
    "uptime_seconds": 1285577, "antennas_connected": 2, "antennas_total": 4,
    "reading": True, "tags_24h": 1832, "reachable": True,
    "taken_at": "2026-10-16T23:00:05+00:00",
}


async def _station(client, db, station_type="rfid"):
    hdrs = await login(client)
    body, device_id = await _setup_body(db)
    payload = {**body, "station_type": station_type}
    if station_type == "rfid":
        payload["reader"] = READER
    r = await client.post("/kiosk/setup", headers=hdrs, json=payload)
    assert r.status_code == 200, r.text
    return hdrs, device_id


async def _readers(db):
    db.expire_all()
    return (await db.scalars(select(Device).where(Device.device_type == "fixed_reader"))).all()


async def _beat(client, hdrs, reader):
    return await client.post("/kiosk/heartbeat", headers=hdrs, json={**BEAT, "reader": reader})


async def test_reader_creates_fixed_reader(client, db, seeded_user):
    hdrs, kid = await _station(client, db)
    r = await _beat(client, hdrs, REPORT)
    assert r.status_code == 200, r.text
    k = await _device(db, kid)
    want = (k.scan_status, k.site_id, k.current_initiative_id)
    (fr,) = await _readers(db)
    assert fr.serial == RSERIAL and fr.name == "FX9600647D23"
    assert fr.mac == "C4:7D:CC:64:7D:23" and fr.lan_ip == "10.10.48.119"
    assert fr.model == "FX9600" and fr.version == "3.32.37.0"
    assert fr.uptime_seconds == 1285577 and fr.antennas_connected == 2
    assert fr.connection_type == "local_api"
    assert (fr.scan_status, fr.site_id, fr.current_initiative_id) == want
    assert want[0] and want[1] and want[2]
    assert fr.last_seen_at is not None
    assert fr.raw_info["make"] == "Zebra" and fr.raw_info["reading"] is True
    assert fr.raw_info["reported_tags_24h"] == 1832 and fr.raw_info["antennas_total"] == 4
    assert fr.raw_info["via_kiosk_id"] == str(kid)
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "self_register", AuditLog.entity_id == str(fr.id)))).all()
    assert len(audits) == 1
    assert audits[0].changes == {"serial": RSERIAL, "name": "FX9600647D23",
                                 "via_kiosk": "Station Target"}


async def test_second_beat_updates_without_audit(client, db, seeded_user):
    hdrs, _ = await _station(client, db)
    await _beat(client, hdrs, REPORT)
    r = await _beat(client, hdrs, {**REPORT, "tags_24h": 2000, "reading": False})
    assert r.status_code == 200
    (fr,) = await _readers(db)
    assert fr.raw_info["reported_tags_24h"] == 2000 and fr.raw_info["reading"] is False
    n = len((await db.scalars(select(AuditLog).where(
        AuditLog.action == "self_register", AuditLog.entity_id == str(fr.id)))).all())
    assert n == 1


async def test_reader_with_only_serial_is_accepted(client, db, seeded_user):
    hdrs, _ = await _station(client, db)
    assert (await _beat(client, hdrs, {"serial": RSERIAL})).status_code == 200
    (fr,) = await _readers(db)
    assert fr.name == f"FX9600 {RSERIAL}" and fr.mac is None and fr.lan_ip is None


async def test_bad_mac_is_dropped_not_422(client, db, seeded_user):
    hdrs, kid = await _station(client, db)
    before = (await _device(db, kid)).last_seen_at
    r = await _beat(client, hdrs, {**REPORT, "mac": "not-a-mac"})
    assert r.status_code == 200, r.text
    after = (await _device(db, kid)).last_seen_at
    assert after is not None and (before is None or after > before)
    assert await _readers(db) == []


async def test_serial_not_paired_is_ignored(client, db, seeded_user):
    hdrs, _ = await _station(client, db)
    assert (await _beat(client, hdrs, {**REPORT, "serial": "OTHER-1"})).status_code == 200
    assert await _readers(db) == []


async def test_label_station_reader_ignored(client, db, seeded_user):
    hdrs, _ = await _station(client, db, station_type="label")
    assert (await _beat(client, hdrs, REPORT)).status_code == 200
    assert await _readers(db) == []


async def test_serial_owned_by_other_type_is_ignored(client, db, seeded_user):
    hdrs, kid = await _station(client, db)
    db.add(Device(device_type="router", name="rtr", serial=RSERIAL, model="GL"))
    await db.commit()
    before = (await _device(db, kid)).last_seen_at
    r = await _beat(client, hdrs, REPORT)
    assert r.status_code == 200, r.text
    after = (await _device(db, kid)).last_seen_at
    assert after is not None and (before is None or after > before)
    assert await _readers(db) == []
    rtr = await db.scalar(select(Device).where(Device.serial == RSERIAL))
    assert rtr.device_type == "router" and rtr.model == "GL" and rtr.mac is None


async def test_hand_made_fixed_reader_is_not_taken_over(client, db, seeded_user):
    hdrs, _ = await _station(client, db)
    db.add(Device(device_type="fixed_reader", name="Dock door 3", serial=RSERIAL,
                  mac="AA:BB:CC:00:00:01"))
    await db.commit()
    assert (await _beat(client, hdrs, REPORT)).status_code == 200
    (fr,) = await _readers(db)
    assert fr.name == "Dock door 3" and fr.mac == "AA:BB:CC:00:00:01"
    assert fr.site_id is None and fr.scan_status is None and fr.last_seen_at is None


async def test_partial_snapshot_keeps_stored_values(client, db, seeded_user):
    hdrs, _ = await _station(client, db)
    await _beat(client, hdrs, REPORT)
    (fr,) = await _readers(db)
    seen = fr.last_seen_at
    await _beat(client, hdrs, {"serial": RSERIAL, "reachable": False})
    (fr,) = await _readers(db)
    assert fr.mac == "C4:7D:CC:64:7D:23" and fr.lan_ip == "10.10.48.119"
    assert fr.version == "3.32.37.0" and fr.model == "FX9600"
    assert fr.raw_info["make"] == "Zebra" and fr.raw_info["reachable"] is False
    assert fr.last_seen_at == seen


async def test_reassignment_is_audited(client, db, seeded_user):
    hdrs, _ = await _station(client, db)
    await _beat(client, hdrs, REPORT)
    await _beat(client, hdrs, REPORT)
    (fr,) = await _readers(db)
    rid = str(fr.id)
    n = lambda: db.scalars(select(AuditLog).where(  # noqa: E731
        AuditLog.action == "reader_reassigned", AuditLog.entity_id == rid))
    assert (await n()).all() == []
    other = Device(device_type="kiosk", name="Second Laptop", serial="kiosk-2",
                   sub_type="laptop", station_type="rfid", rfid_reader_serial=RSERIAL)
    db.add(other)
    await db.commit()
    await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": "kiosk-2", "name": "Second Laptop", "mode": "laptop", "reader": REPORT})
    (a,) = (await n()).all()
    assert a.changes["via_kiosk"] == {"from": "Station Target", "to": "Second Laptop"}
    assert a.changes["site_id"]["to"] is None and a.changes["site_id"]["from"]


async def test_failed_upsert_does_not_touch_the_beat(client, db, seeded_user, monkeypatch):
    from sqlalchemy.exc import IntegrityError

    from serversherpa.services import fixed_readers

    hdrs, kid = await _station(client, db)
    before = (await _device(db, kid)).last_seen_at

    async def boom(db_, kiosk, r, actor_id):
        db_.add(Device(device_type="fixed_reader", name="x", serial=r.serial))
        raise IntegrityError("stmt", {}, Exception("dup"))

    monkeypatch.setattr(fixed_readers, "_upsert", boom)
    assert (await _beat(client, hdrs, REPORT)).status_code == 200
    after = (await _device(db, kid)).last_seen_at
    assert after is not None and (before is None or after > before)
    assert await _readers(db) == []
    monkeypatch.undo()
    assert (await _beat(client, hdrs, REPORT)).status_code == 200
    assert len(await _readers(db)) == 1


async def test_unreachable_snapshot_creates_offline_record(client, db, seeded_user):
    hdrs, _ = await _station(client, db)
    await _beat(client, hdrs, {"serial": RSERIAL, "reachable": False})
    (fr,) = await _readers(db)
    assert fr.last_seen_at is None and fr.raw_info["reachable"] is False


async def test_reader_moves_to_another_kiosk(client, db, seeded_user):
    hdrs, _ = await _station(client, db)
    await _beat(client, hdrs, REPORT)
    other = Device(device_type="kiosk", name="Second Laptop", serial="kiosk-2",
                   sub_type="laptop", station_type="rfid", rfid_reader_serial=RSERIAL)
    db.add(other)
    await db.commit()
    r = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": "kiosk-2", "name": "Second Laptop", "mode": "laptop", "reader": REPORT})
    assert r.status_code == 200, r.text
    (fr,) = await _readers(db)
    assert fr.raw_info["via_kiosk_name"] == "Second Laptop"
