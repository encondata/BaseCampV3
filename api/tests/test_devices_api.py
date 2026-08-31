"""Devices — model round-trip, vocab FK enforcement (Task 1); list +
delete routes (Task 2 appends)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import Device


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
