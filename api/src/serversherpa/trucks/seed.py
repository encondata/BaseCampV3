"""Demo truck seed — idempotent by truck name, used by the
`serversherpa seed-demo-trucks` CLI command and live verification.

Route points are (hours_ago, lat, lng, address); TruckUpdate rows are
created oldest-first with `source="seed"`.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, Site, Truck, TruckUpdate
from serversherpa.trucks.location import format_location

_INITIATIVE_NAME = "NAP11 Hall Migration (demo)"
_START_SITE_NAME = "ACC4 - Digital Reality"
_END_SITE_NAME = "DA11 - Equinix"

DEMO_TRUCKS = [
    {
        "name": "Demo Truck 1",
        "status": "in_transit",
        "driver_name": "Marcus Reyes",
        "co_driver_name": "Dana Whitfield",
        "team_drive": True,
        "contact_info": "+1 (555) 010-2231",
        "load_number": "L-1042",
        "seal_id": "SEAL-88231",
        "tracking_type": {
            "type": "gps", "update_type": "API", "tracker_id": "DEMO-TRK-1"},
        "route": [
            (24, 39.0437, -77.4875, "Ashburn, VA"),
            (19, 38.0293, -78.4767, "Charlottesville, VA"),
            (14, 37.2710, -79.9414, "Roanoke, VA"),
            (9, 36.0999, -80.2442, "Winston-Salem, NC"),
            (4, 35.2271, -80.8431, "Charlotte, NC"),
            (1, 34.8526, -82.3940, "Greenville, SC"),
        ],
    },
    {
        "name": "Demo Truck 2",
        "status": "at_destination",
        "driver_name": "Priya Natarajan",
        "co_driver_name": None,
        "team_drive": False,
        "contact_info": "",
        "load_number": "L-1043",
        "seal_id": "SEAL-88232",
        "tracking_type": {
            "type": "gps", "update_type": "API", "tracker_id": "DEMO-TRK-2"},
        "route": [
            (6, 33.4484, -112.0740, "Phoenix, AZ"),
            (3, 31.7619, -106.4850, "El Paso, TX"),
            (1, 32.7767, -96.7970, "Dallas, TX"),
        ],
    },
]


async def seed_demo_trucks(db: AsyncSession) -> int:
    """Insert DEMO_TRUCKS (+ their updates) when not already present,
    keyed on truck name. Returns the number of trucks added."""

    initiative_id = await db.scalar(
        select(Initiative.id).where(Initiative.name == _INITIATIVE_NAME))
    start_site_id = await db.scalar(
        select(Site.id).where(Site.name == _START_SITE_NAME))
    end_site_id = await db.scalar(
        select(Site.id).where(Site.name == _END_SITE_NAME))

    now = datetime.now(UTC)
    added = 0

    for spec in DEMO_TRUCKS:
        existing = await db.scalar(
            select(Truck.id).where(Truck.name == spec["name"]))
        if existing is not None:
            continue

        truck = Truck(
            name=spec["name"],
            status=spec["status"],
            driver_name=spec["driver_name"],
            co_driver_name=spec["co_driver_name"],
            team_drive=spec["team_drive"],
            contact_info=spec["contact_info"],
            load_number=spec["load_number"],
            seal_id=spec["seal_id"],
            tracking_type=spec["tracking_type"],
            initiative_id=initiative_id,
            start_site_id=start_site_id,
            end_site_id=end_site_id,
        )
        db.add(truck)
        await db.flush()  # truck.id

        for hours_ago, lat, lng, address in spec["route"]:
            db.add(TruckUpdate(
                truck_id=truck.id,
                recorded_at=now - timedelta(hours=hours_ago),
                location=format_location(lat, lng),
                lat=lat,
                lng=lng,
                approximate_address=address,
                source="seed",
            ))

        added += 1

    return added
