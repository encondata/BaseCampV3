"""Migration 0097: truck_updates.source_ref (+ per-truck unique) and the
truck_events table for MacroPoint trip events."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import Truck, TruckEvent, TruckUpdate

T0 = datetime(2026, 3, 1, 12, tzinfo=UTC)


async def test_columns_and_constraints_exist(db):
    col = (await db.execute(text(
        "SELECT data_type, is_nullable FROM information_schema.columns "
        "WHERE table_name='truck_updates' AND column_name='source_ref'"))).one()
    assert col == ("text", "YES")
    names = set((await db.scalars(text(
        "SELECT conname FROM pg_constraint WHERE conname IN "
        "('uq_truck_updates_truck_source_ref', 'uq_truck_events_truck_source_ref')"))).all())
    assert names == {"uq_truck_updates_truck_source_ref", "uq_truck_events_truck_source_ref"}
    idx = set((await db.scalars(text(
        "SELECT indexname FROM pg_indexes WHERE tablename='truck_events'"))).all())
    assert {"ix_truck_events_truck_recorded", "ix_truck_events_recorded_at"} <= idx


async def test_source_ref_unique_per_truck_but_null_repeats(db):
    a, b = Truck(name="A"), Truck(name="B")
    db.add_all([a, b])
    await db.flush()
    for truck in (a, a, b):          # NULL refs never collide
        db.add(TruckUpdate(truck_id=truck.id, recorded_at=T0, location="1.000000, 2.000000",
                           lat=1.0, lng=2.0))
    db.add(TruckUpdate(truck_id=a.id, recorded_at=T0, location="1.000000, 2.000000",
                       lat=1.0, lng=2.0, source_ref="r1"))
    db.add(TruckUpdate(truck_id=b.id, recorded_at=T0, location="1.000000, 2.000000",
                       lat=1.0, lng=2.0, source_ref="r1"))   # same ref, other truck: fine
    await db.commit()
    db.add(TruckUpdate(truck_id=a.id, recorded_at=T0, location="1.000000, 2.000000",
                       lat=1.0, lng=2.0, source_ref="r1"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_truck_event_defaults_and_cascade(db):
    t = Truck(name="Evented")
    db.add(t)
    await db.flush()
    e = TruckEvent(truck_id=t.id, recorded_at=T0, event="Departed at Pickup",
                   event_kind="departed", stop="pickup", source_ref="x")
    db.add(e)
    await db.commit()
    await db.refresh(e)
    assert e.source == "manual"
    assert e.created_at is not None
    await db.delete(t)
    await db.commit()
    assert (await db.scalar(text("SELECT count(*) FROM truck_events"))) == 0
