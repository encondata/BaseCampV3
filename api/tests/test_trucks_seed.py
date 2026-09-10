"""Demo truck seed — idempotent, linked to the demo initiative/sites when
present."""

from sqlalchemy import select

from serversherpa.db.models import Initiative, Site, Truck, TruckUpdate
from serversherpa.trucks.seed import seed_demo_trucks


async def _trucks_by_name(db):
    rows = (await db.scalars(select(Truck))).all()
    return {t.name: t for t in rows}


async def test_seed_creates_two_trucks_and_is_idempotent(db):
    added = await seed_demo_trucks(db)
    assert added == 2

    trucks = await _trucks_by_name(db)
    assert set(trucks) == {"Demo Truck 1", "Demo Truck 2"}

    added_again = await seed_demo_trucks(db)
    assert added_again == 0

    trucks_again = await _trucks_by_name(db)
    assert set(trucks_again) == {"Demo Truck 1", "Demo Truck 2"}
    assert len(trucks_again) == 2


async def test_truck_1_fields_and_updates(db):
    await seed_demo_trucks(db)
    trucks = await _trucks_by_name(db)
    t1 = trucks["Demo Truck 1"]

    assert t1.status == "in_transit"
    assert t1.driver_name == "Marcus Reyes"
    assert t1.co_driver_name == "Dana Whitfield"
    assert t1.team_drive is True
    assert t1.contact_info == "+1 (555) 010-2231"
    assert t1.load_number == "L-1042"
    assert t1.seal_id == "SEAL-88231"
    assert t1.tracking_type == {
        "type": "gps", "update_type": "API", "tracker_id": "DEMO-TRK-1"}

    updates = (await db.scalars(
        select(TruckUpdate).where(TruckUpdate.truck_id == t1.id)
        .order_by(TruckUpdate.recorded_at))).all()
    assert len(updates) == 6
    assert all(u.source == "seed" for u in updates)
    newest = updates[-1]
    assert newest.approximate_address == "Greenville, SC"
    assert newest.lat == 34.8526 and newest.lng == -82.3940
    oldest = updates[0]
    assert oldest.approximate_address == "Ashburn, VA"


async def test_truck_2_fields_and_updates(db):
    await seed_demo_trucks(db)
    trucks = await _trucks_by_name(db)
    t2 = trucks["Demo Truck 2"]

    assert t2.status == "at_destination"
    assert t2.driver_name == "Priya Natarajan"
    assert t2.team_drive is False
    assert t2.load_number == "L-1043"
    assert t2.seal_id == "SEAL-88232"
    assert t2.tracking_type == {
        "type": "gps", "update_type": "API", "tracker_id": "DEMO-TRK-2"}

    updates = (await db.scalars(
        select(TruckUpdate).where(TruckUpdate.truck_id == t2.id)
        .order_by(TruckUpdate.recorded_at))).all()
    assert len(updates) == 3
    newest = updates[-1]
    assert newest.approximate_address == "Dallas, TX"
    assert newest.lat == 32.7767 and newest.lng == -96.7970


async def test_seed_links_initiative_and_sites_when_present(db):
    initiative = Initiative(
        name="NAP11 Hall Migration (demo)", initiative_type="move")
    start = Site(name="ACC4 - Digital Reality")
    end = Site(name="DA11 - Equinix")
    db.add_all([initiative, start, end])
    await db.flush()

    await seed_demo_trucks(db)
    trucks = await _trucks_by_name(db)
    t1, t2 = trucks["Demo Truck 1"], trucks["Demo Truck 2"]

    assert t1.initiative_id == initiative.id
    assert t1.start_site_id == start.id
    assert t1.end_site_id == end.id
    assert t2.initiative_id == initiative.id
    assert t2.start_site_id == start.id
    assert t2.end_site_id == end.id


async def test_seed_leaves_links_none_when_initiative_and_sites_absent(db):
    await seed_demo_trucks(db)
    trucks = await _trucks_by_name(db)
    t1 = trucks["Demo Truck 1"]

    assert t1.initiative_id is None
    assert t1.start_site_id is None
    assert t1.end_site_id is None
