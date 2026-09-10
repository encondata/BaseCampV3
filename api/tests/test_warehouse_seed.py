"""Demo warehouse seed — idempotent by container name / stock-line
description at the site."""

from sqlalchemy import select

from serversherpa.db.models import AssetModel, Container, Site, StockLine
from serversherpa.warehouse.seed import seed_demo_warehouse


async def _containers_by_name(db, site_id):
    rows = (await db.scalars(
        select(Container).where(Container.site_id == site_id))).all()
    return {c.name: c for c in rows}


async def _stock_by_description(db, site_id):
    rows = (await db.scalars(
        select(StockLine).where(StockLine.site_id == site_id))).all()
    return {s.description: s for s in rows}


async def test_seed_creates_site_containers_and_stock_and_is_idempotent(db):
    added = await seed_demo_warehouse(db)
    assert added == 7

    site = await db.scalar(
        select(Site).where(Site.name == "Demo Warehouse (Ashburn)"))
    assert site is not None
    assert site.site_type == "warehouse"

    containers = await _containers_by_name(db, site.id)
    assert set(containers) == {"Pallet A-01", "Crate C-07", "D-Container D-02"}
    assert containers["Pallet A-01"].container_type == "pallet"
    assert containers["Crate C-07"].container_type == "crate"
    assert containers["D-Container D-02"].container_type == "d_container"

    stock = await _stock_by_description(db, site.id)
    assert set(stock) == {
        "PDU, 30A vertical", "Cat6 patch, 10 ft", "Cage nuts M6",
        "Rack PDU (spare)",
    }

    pdu = stock["PDU, 30A vertical"]
    assert pdu.quantity == 24
    assert pdu.unit == "each"
    assert pdu.container_id == containers["Pallet A-01"].id

    patch = stock["Cat6 patch, 10 ft"]
    assert patch.quantity == 6
    assert patch.unit == "box"
    assert patch.container_id == containers["Crate C-07"].id

    nuts = stock["Cage nuts M6"]
    assert nuts.quantity == 40
    assert nuts.unit == "bag"
    assert nuts.container_id is None
    assert nuts.location_detail == "Shelf B"

    spare = stock["Rack PDU (spare)"]
    assert spare.quantity == 2
    assert spare.unit == "each"
    assert spare.container_id is None
    assert spare.model_id is None

    assert all(c.source == "seed" for c in containers.values())
    assert all(s.source == "seed" for s in stock.values())

    added_again = await seed_demo_warehouse(db)
    assert added_again == 0

    containers_again = await _containers_by_name(db, site.id)
    stock_again = await _stock_by_description(db, site.id)
    assert len(containers_again) == 3
    assert len(stock_again) == 4


async def test_seed_uses_existing_warehouse_site_and_creates_no_site(db):
    existing = Site(name="AAA Storage", site_type="warehouse")
    db.add(existing)
    await db.flush()

    added = await seed_demo_warehouse(db)
    assert added == 7

    sites = (await db.scalars(
        select(Site).where(Site.site_type == "warehouse"))).all()
    assert len(sites) == 1
    assert sites[0].name == "AAA Storage"

    containers = await _containers_by_name(db, existing.id)
    assert len(containers) == 3


async def test_seed_links_model_when_pdu_or_power_category_model_exists(db):
    model = AssetModel(make="APC", model="AP8941", category="power")
    db.add(model)
    await db.flush()

    await seed_demo_warehouse(db)

    site = await db.scalar(
        select(Site).where(Site.name == "Demo Warehouse (Ashburn)"))
    stock = await _stock_by_description(db, site.id)
    assert stock["Rack PDU (spare)"].model_id == model.id
