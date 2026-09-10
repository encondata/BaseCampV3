"""Demo warehouse seed — idempotent by container name / stock-line
description at the site, used by the `serversherpa seed-demo-warehouse`
CLI command and live verification.

If no non-archived site is typed `warehouse`, creates one. Containers and
stock lines are then seeded at that site with `source="seed"`.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import AssetModel, Container, Site, StockLine

_DEMO_SITE_NAME = "Demo Warehouse (Ashburn)"

DEMO_CONTAINERS = [
    {"name": "Pallet A-01", "container_type": "pallet"},
    {"name": "Crate C-07", "container_type": "crate"},
    {"name": "D-Container D-02", "container_type": "d_container"},
]

# container is a key into DEMO_CONTAINERS names; None = loose.
DEMO_STOCK = [
    {
        "description": "PDU, 30A vertical",
        "quantity": 24,
        "unit": "each",
        "container": "Pallet A-01",
        "location_detail": "",
        "model": False,
    },
    {
        "description": "Cat6 patch, 10 ft",
        "quantity": 6,
        "unit": "box",
        "container": "Crate C-07",
        "location_detail": "",
        "model": False,
    },
    {
        "description": "Cage nuts M6",
        "quantity": 40,
        "unit": "bag",
        "container": None,
        "location_detail": "Shelf B",
        "model": False,
    },
    {
        "description": "Rack PDU (spare)",
        "quantity": 2,
        "unit": "each",
        "container": None,
        "location_detail": "",
        "model": True,
    },
]


async def seed_demo_warehouse(db: AsyncSession) -> int:
    """Insert DEMO_CONTAINERS and DEMO_STOCK at the first non-archived
    `warehouse`-typed site (by name), creating a demo site when none
    exists. Returns the number of containers + stock lines added; the
    site itself does not count."""

    site = await db.scalar(
        select(Site)
        .where(Site.site_type == "warehouse", Site.archived_at.is_(None))
        .order_by(Site.name)
        .limit(1))
    if site is None:
        site = Site(name=_DEMO_SITE_NAME, site_type="warehouse")
        db.add(site)
        await db.flush()  # site.id

    added = 0
    containers_by_name: dict[str, Container] = {}

    for spec in DEMO_CONTAINERS:
        existing = await db.scalar(
            select(Container).where(
                Container.site_id == site.id, Container.name == spec["name"]))
        if existing is not None:
            containers_by_name[spec["name"]] = existing
            continue

        container = Container(
            name=spec["name"],
            site_id=site.id,
            container_type=spec["container_type"],
            source="seed",
        )
        db.add(container)
        await db.flush()  # container.id
        containers_by_name[spec["name"]] = container
        added += 1

    model_id = None
    if any(spec["model"] for spec in DEMO_STOCK):
        model_id = await db.scalar(
            select(AssetModel.id)
            .where(AssetModel.category.in_(("pdu", "power")))
            .order_by(AssetModel.make, AssetModel.model)
            .limit(1))

    for spec in DEMO_STOCK:
        existing = await db.scalar(
            select(StockLine.id).where(
                StockLine.site_id == site.id,
                StockLine.description == spec["description"]))
        if existing is not None:
            continue

        container = containers_by_name.get(spec["container"]) if spec["container"] else None
        db.add(StockLine(
            site_id=site.id,
            container_id=container.id if container else None,
            model_id=model_id if spec["model"] else None,
            description=spec["description"],
            quantity=spec["quantity"],
            unit=spec["unit"],
            location_detail=spec["location_detail"],
            source="seed",
        ))
        added += 1

    return added
