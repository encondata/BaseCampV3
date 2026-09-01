"""Devices — model round-trip, vocab FK enforcement (Task 1); list +
delete routes (Task 2 appends)."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Asset, AuditLog, Device, DeviceDhcpLease, ProcessedScan, RawScan, Site,
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
