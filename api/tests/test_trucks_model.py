"""Trucks tables (0048): vocab seeded, GENERATED status record type, cascades."""

from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.db.models import (
    Container, StatusValue, Truck, TruckContainer, TruckUpdate,
)
from serversherpa.status.registry import STATUS_REGISTRY


async def test_truck_vocab_seeded_and_registered(db):
    rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type == "truck").order_by(StatusValue.sort_order))).all()
    assert [r.key for r in rows] == [
        "created", "active", "in_transit", "at_destination", "inactive", "historical"]
    assert rows[0].color == "#51606f" and rows[2].label == "In Transit"
    assert STATUS_REGISTRY["truck"].resource == "trucks"
    assert STATUS_REGISTRY["truck"].sources == (("trucks", "status"),)


async def test_truck_defaults_links_and_cascades(db):
    t = Truck(name="Demo")
    db.add(t)
    await db.flush()
    await db.refresh(t)
    assert t.status == "created" and t.status_record_type == "truck"
    assert t.team_drive is False and t.contact_info == "" and t.tracking_type == {}
    c = Container(name="Crate 1")
    db.add(c)
    await db.flush()
    db.add(TruckContainer(truck_id=t.id, container_id=c.id))
    db.add(TruckUpdate(truck_id=t.id, recorded_at=datetime.now(UTC),
                       location="39.0, -77.4", lat=39.0, lng=-77.4))
    await db.commit()
    await db.delete(t)
    await db.commit()
    assert (await db.scalars(select(TruckContainer))).all() == []
    assert (await db.scalars(select(TruckUpdate))).all() == []


async def test_unknown_status_rejected_by_fk(db):
    import pytest
    from sqlalchemy.exc import IntegrityError
    db.add(Truck(name="Bad", status="teleporting"))
    with pytest.raises(IntegrityError):
        await db.flush()
