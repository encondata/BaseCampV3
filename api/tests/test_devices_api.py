"""Devices — model round-trip, vocab FK enforcement (Task 1); list +
delete routes (Task 2 appends)."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import AuditLog, Device, Site
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
