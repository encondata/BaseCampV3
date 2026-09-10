"""stock_lines (0050): columns, CHECK quantity >= 0, FK set-null on container
delete, container_type vocab rows, warehouse grants."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.access.resources import REGISTRY
from serversherpa.db.models import Container, Site, StatusValue, StockLine


async def _warehouse(db):
    site = Site(name="WH Test", site_type="warehouse")
    db.add(site)
    await db.flush()
    return site


async def test_stock_line_defaults_and_vocab(db):
    site = await _warehouse(db)
    line = StockLine(site_id=site.id, description="PDU, 30A", quantity=24)
    db.add(line)
    await db.flush()
    await db.refresh(line)
    assert line.unit == "each"
    assert line.location_detail == ""
    assert line.notes == ""
    assert line.source == "manual"
    assert line.archived_at is None
    assert line.container_id is None and line.model_id is None
    keys = set(await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "container_type")))
    assert {"pallet", "crate", "d_container"} <= keys


async def test_negative_quantity_rejected(db):
    site = await _warehouse(db)
    db.add(StockLine(site_id=site.id, description="x", quantity=-1))
    with pytest.raises(IntegrityError):
        await db.flush()


async def test_container_delete_sets_null(db):
    site = await _warehouse(db)
    box = Container(name="Crate 1", site_id=site.id)
    db.add(box)
    await db.flush()
    line = StockLine(site_id=site.id, container_id=box.id,
                     description="cables", quantity=3)
    db.add(line)
    await db.flush()
    await db.execute(text("DELETE FROM containers WHERE id = :id"), {"id": box.id})
    await db.refresh(line)
    assert line.container_id is None


async def test_warehouse_resource_registered_and_granted(db):
    assert "warehouse" in REGISTRY
    rows = (await db.execute(text(
        "SELECT role, action FROM role_permissions WHERE resource = 'warehouse'"))).all()
    roles = {r for r, _ in rows}
    assert {"developer", "founder", "super_admin", "admin", "staff"} <= roles
    assert {a for _, a in rows} == {"view", "add", "change", "delete"}
