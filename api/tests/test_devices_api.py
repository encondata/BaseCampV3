"""Devices — model round-trip, vocab FK enforcement (Task 1); list +
delete routes (Task 2 appends)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Asset, AuditLog, Device, DeviceDhcpLease, Initiative, ProcessedScan,
    RawScan, Site,
)
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff


async def test_device_round_trip(db):
    d = Device(device_type="router", name="dock-router-1",
               serial="GL-MT300N-C4A1B2", mac="94:83:C4:12:A1:B2",
               wan_ip="203.0.113.14", lan_ip="192.168.8.1",
               uptime_seconds=1_036_800,
               last_seen_at=datetime.now(UTC),
               raw_info={"model": "GL-MT300N", "firmware": "4.3.11"})
    db.add(d)
    await db.commit()
    got = await db.scalar(select(Device).where(Device.id == d.id))
    assert got.device_type == "router"
    assert got.raw_info["model"] == "GL-MT300N"
    assert got.registered_at is not None


async def test_device_type_fk_rejects_unknown_key(db):
    db.add(Device(device_type="toaster", name="nope"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_serial_partial_unique(db):
    db.add(Device(device_type="router", name="a", serial="DUP-1"))
    await db.commit()
    db.add(Device(device_type="router", name="b", serial="DUP-1"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    # NULL serials never collide (partial index)
    db.add_all([Device(device_type="kiosk", name="k1"),
                Device(device_type="kiosk", name="k2")])
    await db.commit()


async def test_list_devices_filters_by_type(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)

    site = Site(name="Main Warehouse")
    db.add(site)
    await db.flush()

    now = datetime.now(UTC)
    router = Device(
        device_type="router", name="dock-router-1",
        serial="GL-MT300N-C4A1B2", mac="94:83:C4:12:A1:B2",
        site_id=site.id, wan_ip="203.0.113.14", lan_ip="192.168.8.1",
        uptime_seconds=1_036_800, last_seen_at=now,
        raw_info={"model": "GL-MT300N"},
        registered_at=now - timedelta(hours=1))
    kiosk = Device(
        device_type="kiosk", name="lobby-kiosk-1",
        registered_at=now)
    db.add_all([router, kiosk])
    await db.commit()

    resp = await client.get("/devices", headers=hdrs,
                            params={"device_type": "router"})
    assert resp.status_code == 200, resp.text
    items = resp.json()
    assert len(items) == 1
    item = items[0]
    assert item["id"] == str(router.id)
    assert item["device_type"] == "router"
    assert item["site_id"] == str(site.id)
    assert item["site_name"] == "Main Warehouse"
    assert item["wan_ip"] == "203.0.113.14"
    assert item["uptime_seconds"] == 1_036_800

    resp = await client.get("/devices", headers=hdrs)
    assert resp.status_code == 200, resp.text
    items = resp.json()
    assert len(items) == 2
    # newest registered_at first — kiosk (now) before router (now - 1h)
    assert items[0]["id"] == str(kiosk.id)
    assert items[1]["id"] == str(router.id)


async def test_delete_device(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)

    device = Device(device_type="router", name="dock-router-2",
                     serial="GL-MT300N-XYZ")
    db.add(device)
    await db.commit()
    device_id = device.id

    resp = await client.delete(f"/devices/{device_id}", headers=hdrs)
    assert resp.status_code == 204

    db.expire_all()
    assert await db.get(Device, device_id) is None

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "delete",
        AuditLog.entity_id == str(device_id)))
    assert row is not None
    assert row.changes["name"] == "dock-router-2"
    assert row.changes["device_type"] == "router"
    assert row.changes["serial"] == "GL-MT300N-XYZ"

    resp = await client.delete(f"/devices/{device_id}", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "device_not_found"


async def test_devices_permissions(client, db, seeded_user):
    # "external" carries no grants at all (DEFAULT_GRANTS["external"] == {}),
    # so it's the role to prove the endpoints are permission-gated —
    # unlike "staff", which gets scanning_hardware:view by default.
    await db.execute(text(
        "UPDATE person_roles SET role='external' WHERE person_id=:p"),
        {"p": seeded_user.id})
    await db.commit()
    hdrs = await login_staff(client, seeded_user)

    resp = await client.get("/devices", headers=hdrs)
    assert resp.status_code == 403

    device = Device(device_type="router", name="dock-router-3")
    db.add(device)
    await db.commit()

    resp = await client.delete(f"/devices/{device.id}", headers=hdrs)
    assert resp.status_code == 403


async def test_lease_round_trip_unique_and_cascade(db):
    d = Device(device_type="router", name="r1")
    db.add(d)
    await db.flush()
    device_id = d.id  # captured before rollback expires d's attributes
    db.add(DeviceDhcpLease(device_id=device_id, mac="AA:BB:CC:00:00:01",
                           ip="192.168.8.100", hostname="handheld-01",
                           reserved=False, up=True))
    await db.commit()
    db.add(DeviceDhcpLease(device_id=device_id, mac="aa:bb:cc:00:00:01"))
    with pytest.raises(IntegrityError):          # CITEXT: case-insensitive dupe
        await db.commit()
    await db.rollback()
    # select() against the captured id, not db.get()/d.id — Session.rollback()
    # expires every object in the session, and refreshing an expired
    # instance right after a failed commit triggers a pool_pre_ping
    # checkout outside the async greenlet context (asyncpg/SQLAlchemy
    # interaction quirk, unrelated to the feature under test).
    row = await db.scalar(select(Device).where(Device.id == device_id))
    await db.delete(row)
    await db.commit()
    assert (await db.scalars(select(DeviceDhcpLease))).all() == []


async def test_list_derives_connected_count(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)

    d = Device(device_type="router", name="counted",
               vpn_status="connected")
    empty = Device(device_type="router", name="empty")
    db.add_all([d, empty])
    await db.flush()
    db.add_all([
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:01", up=True),
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:02", up=True,
                        reserved=True),
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:03", up=False),
    ])
    await db.commit()
    resp = await client.get("/devices", headers=hdrs,
                            params={"device_type": "router"})
    assert resp.status_code == 200
    by_name = {i["name"]: i for i in resp.json()}
    assert by_name["counted"]["connected_count"] == 2   # up only, reserved counts
    assert by_name["counted"]["vpn_status"] == "connected"
    assert by_name["empty"]["connected_count"] == 0
    assert by_name["empty"]["token_expires_at"] is None


async def test_leases_endpoint_ordering_404_403(client, db, seeded_user):
    hdrs_admin = await login_admin(client, db, seeded_user)

    d = Device(device_type="router", name="r2")
    db.add(d)
    await db.flush()
    db.add_all([
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:10",
                        hostname="zeta", up=False),
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:11",
                        hostname=None, up=True),
        DeviceDhcpLease(device_id=d.id, mac="AA:00:00:00:00:12",
                        hostname="alpha", up=True),
    ])
    await db.commit()
    resp = await client.get(f"/devices/{d.id}/leases", headers=hdrs_admin)
    assert resp.status_code == 200
    rows = resp.json()
    # up DESC, hostname NULLS LAST, mac
    assert [(r["up"], r["hostname"]) for r in rows] == [
        (True, "alpha"), (True, None), (False, "zeta")]
    missing = await client.get(
        "/devices/00000000-0000-0000-0000-000000000000/leases",
        headers=hdrs_admin)
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "device_not_found"

    # "external" carries no grants at all — prove the endpoint is gated
    await db.execute(text(
        "UPDATE person_roles SET role='external' WHERE person_id=:p"),
        {"p": seeded_user.id})
    await db.commit()
    hdrs_external = await login_staff(client, seeded_user)
    resp = await client.get(f"/devices/{d.id}/leases", headers=hdrs_external)
    assert resp.status_code == 403


async def test_reader_fields_round_trip_and_fk(db):
    r = Device(device_type="fixed_reader", name="dock-reader-1",
               model="FX9600", antennas_connected=8,
               connection_type="api", scan_status="rfid_1_cage_exit")
    db.add(r)
    await db.commit()
    got = await db.scalar(select(Device).where(Device.id == r.id))
    assert got.scan_status == "rfid_1_cage_exit"
    assert got.antennas_connected == 8
    db.add(Device(device_type="fixed_reader", name="bad",
                  scan_status="not-a-status"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_list_derives_tags_read_24h(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)

    now = datetime.now(UTC)
    r = Device(device_type="fixed_reader", name="dock-reader-9",
               scan_status="rfid_1_cage_exit")
    other = Device(device_type="fixed_reader", name="idle-reader")
    db.add_all([r, other])
    await db.flush()
    a = Asset(serial_number="TAGSCAN-1")
    db.add(a)
    await db.flush()
    db.add_all([
        # counted: raw, in-window, matching device_id
        RawScan(scanned_value="T1", scan_type="rfid",
                scanned_at=now - timedelta(hours=1),
                device_id="dock-reader-9"),
        RawScan(scanned_value="T2", scan_type="rfid",
                scanned_at=now - timedelta(hours=23),
                device_id="dock-reader-9"),
        # NOT counted: outside the window
        RawScan(scanned_value="T3", scan_type="rfid",
                scanned_at=now - timedelta(hours=25),
                device_id="dock-reader-9"),
        # NOT counted: different device
        RawScan(scanned_value="T4", scan_type="rfid",
                scanned_at=now - timedelta(hours=1),
                device_id="someone-else"),
        # counted: processed scan, in-window, matching device_id
        ProcessedScan(scanned_value="T5", scan_type="rfid",
                      scanned_at=now - timedelta(hours=2),
                      processed_at=now, device_id="dock-reader-9",
                      match_type="asset", asset_id=a.id),
    ])
    await db.commit()
    resp = await client.get("/devices", headers=hdrs,
                            params={"device_type": "fixed_reader"})
    by_name = {i["name"]: i for i in resp.json()}
    assert by_name["dock-reader-9"]["tags_read_24h"] == 3   # 2 raw + 1 processed
    assert by_name["idle-reader"]["tags_read_24h"] == 0
    assert by_name["dock-reader-9"]["scan_status_label"] is not None
    assert by_name["dock-reader-9"]["scan_status_color"] is not None
    assert by_name["idle-reader"]["scan_status_label"] is None


async def test_create_kiosk_and_initiative_join(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)

    move = Initiative(name="Rack Move 12", initiative_type="move",
                      status="planned")
    db.add(move)
    await db.commit()

    resp = await client.post("/devices", headers=hdrs, json={
        "device_type": "kiosk", "name": "lobby-kiosk-2",
        "kiosk_type": "laptop", "mac": "AA:BB:CC:00:00:99",
        "lan_ip": "192.168.9.50", "version": "1.2.3",
        "scan_status": "rfid_1_cage_exit",
        "current_initiative_id": str(move.id),
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["device_type"] == "kiosk"
    assert body["kiosk_type"] == "laptop"
    assert body["version"] == "1.2.3"
    assert body["current_initiative_id"] == str(move.id)
    device_id = body["id"]

    resp = await client.get("/devices", headers=hdrs,
                            params={"device_type": "kiosk"})
    assert resp.status_code == 200, resp.text
    by_id = {i["id"]: i for i in resp.json()}
    assert by_id[device_id]["current_initiative_name"] == "Rack Move 12"

    resp = await client.post("/devices", headers=hdrs, json={
        "device_type": "toaster", "name": "not-a-device"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_device_type"

    resp = await client.post("/devices", headers=hdrs, json={
        "device_type": "kiosk", "name": "bad-status-kiosk",
        "scan_status": "nope"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_scan_status"

    resp = await client.post("/devices", headers=hdrs, json={
        "device_type": "kiosk", "name": "bad-initiative-kiosk",
        "current_initiative_id": str(uuid.uuid4())})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_initiative"


async def test_patch_allowed_fields_and_guards(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)

    move = Initiative(name="Rack Move 13", initiative_type="move",
                      status="planned")
    db.add(move)
    await db.flush()
    device = Device(device_type="kiosk", name="kiosk-a",
                    current_initiative_id=move.id)
    db.add(device)
    await db.commit()
    device_id = device.id

    resp = await client.patch(f"/devices/{device_id}", headers=hdrs, json={
        "name": "kiosk-a-renamed", "version": "2.0.0",
        "current_initiative_id": None,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "kiosk-a-renamed"
    assert body["version"] == "2.0.0"
    assert body["current_initiative_id"] is None
    assert body["current_initiative_name"] is None

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "update",
        AuditLog.entity_id == str(device_id)))
    assert row is not None
    assert row.changes["name"] == {"from": "kiosk-a", "to": "kiosk-a-renamed"}
    assert row.changes["version"] == {"from": None, "to": "2.0.0"}
    assert row.changes["current_initiative_id"] == {
        "from": str(move.id), "to": None}

    resp = await client.patch(f"/devices/{device_id}", headers=hdrs,
                              json={"serial": "x"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_field"

    resp = await client.patch(f"/devices/{device_id}", headers=hdrs,
                              json={"name": ""})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_name"

    resp = await client.patch(f"/devices/{device_id}", headers=hdrs,
                              json={"name": None})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_name"


async def test_register_deregister_lifecycle(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)

    device = Device(device_type="kiosk", name="kiosk-b")
    db.add(device)
    await db.commit()
    device_id = device.id

    before = datetime.now(UTC)
    resp = await client.post(f"/devices/{device_id}/register", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    registered_at = datetime.fromisoformat(body["registered_at"])
    expires_at = datetime.fromisoformat(body["token_expires_at"])
    assert abs((registered_at - before).total_seconds()) < 10
    assert abs((expires_at - (before + timedelta(days=30)))
              .total_seconds()) < 10

    resp = await client.post(f"/devices/{device_id}/register", headers=hdrs,
                             json={"days": 7})
    assert resp.status_code == 200, resp.text
    expires_at = datetime.fromisoformat(resp.json()["token_expires_at"])
    assert abs((expires_at - (before + timedelta(days=7)))
              .total_seconds()) < 10

    resp = await client.post(f"/devices/{device_id}/register", headers=hdrs,
                             json={"days": 0})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_days"

    resp = await client.post(f"/devices/{device_id}/register", headers=hdrs,
                             json={"days": 400})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_days"

    resp = await client.post(f"/devices/{device_id}/deregister",
                             headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["token_expires_at"] is None
    assert body["registered_at"] is not None

    register_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "register",
        AuditLog.entity_id == str(device_id)))
    assert register_row is not None
    deregister_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "deregister",
        AuditLog.entity_id == str(device_id)))
    assert deregister_row is not None


async def test_mutations_permission_denied(client, db, seeded_user):
    # "external" carries no grants at all — prove the mutation endpoints
    # are permission-gated same as list/leases/delete.
    await db.execute(text(
        "UPDATE person_roles SET role='external' WHERE person_id=:p"),
        {"p": seeded_user.id})
    await db.commit()
    hdrs = await login_staff(client, seeded_user)

    resp = await client.post("/devices", headers=hdrs, json={
        "device_type": "kiosk", "name": "denied-kiosk"})
    assert resp.status_code == 403

    device = Device(device_type="kiosk", name="kiosk-c")
    db.add(device)
    await db.commit()

    resp = await client.patch(f"/devices/{device.id}", headers=hdrs,
                              json={"name": "renamed"})
    assert resp.status_code == 403

    resp = await client.post(f"/devices/{device.id}/register", headers=hdrs)
    assert resp.status_code == 403

    resp = await client.post(f"/devices/{device.id}/deregister",
                             headers=hdrs)
    assert resp.status_code == 403
