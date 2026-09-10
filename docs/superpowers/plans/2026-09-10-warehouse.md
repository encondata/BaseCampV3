# Warehouse Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/logistics/warehouse` page that shows, for one warehouse site at a time, its containers (with contents), loose tagged assets, and counted **stock lines**, with add / edit / move / archive for stock.

**Architecture:** New `stock_lines` table (migration 0050) + `StockLine` model; a read-mostly `/warehouse` router that assembles one inventory payload per site with set-based queries and owns stock-line CRUD; portal page built from the standard directory list (container rows expand into a mini list of contents) with a `StockLineModal`. Containers and assets are never written by the warehouse API — their existing modals are reused.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (api/), React 18 + TypeScript + Vitest (portal/), existing list primitives (`dir-list`, `mini-list`, `DataTable`), `ComboBox`, `RowActionsMenu`, `usePersistentListState`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-10-warehouse-design.md` — read it first.
- Migration id `0050`, `down_revision = "0049"`; a single alembic head.
- Resource key `warehouse`, label "Warehouse", route `/logistics/warehouse`, `visible_to={"global"}`; FULL grants for developer / founder / super_admin / admin / staff.
- Error codes exactly: `site_not_found`, `site_not_warehouse`, `container_not_found`, `container_not_at_site`, `model_not_found`, `description_required`, `quantity_required`, `unit_required`, `stock_line_not_found`, `forbidden`.
- Portal idioms only: `.dir-search`, `.org-select`, `.segmented`, chips (`statusChip`), `RowActionsMenu`, `.pf-form`/`.pf-error`/`.pf-notice`, `ComboBox`, modals sized to content. **Never** raw native `<select>`; a native `<input type="number">` inside `.pf-form` is fine (it is the form idiom).
- List typography rule: no font-size/family/weight/line-height/min-height in `warehouse.css` on list-ish selectors, no raw `<table>`, never `cell-sub` + `mono` on one element, no new `listTypography.allow.json` entries.
- API tests: run from the worktree's `api/` FOREGROUND, one call, `PYTHONPATH=src SS_TEST_DB=serversherpa_test_wh /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q <files>`; never background. Portal tests: from `portal/`, `npx vitest run <files> && npx tsc --noEmit -p .`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Before committing, `git checkout -- api/src/serversherpa/_dev_reload.py` if it shows modified.

---

## File map

| File | Responsibility |
|---|---|
| `api/migrations/versions/0050_warehouse.py` | `stock_lines` table, 3 container-type vocab rows, `warehouse` grants |
| `api/src/serversherpa/db/models.py` | `StockLine` (append after `TruckUpdate`) |
| `api/src/serversherpa/access/resources.py`, `access/defaults.py` | `warehouse` resource + defaults |
| `api/src/serversherpa/api/schemas.py` | `AssetRef`, `StockLineOut`, `StockLineCreateIn`, `StockLineUpdateIn`, `WarehouseSiteOut`, `WarehouseContainerOut`, `WarehouseInventoryOut` |
| `api/src/serversherpa/api/routes/warehouse.py` | `/warehouse/sites`, `/warehouse/{site_id}/inventory`, stock CRUD/archive |
| `api/src/serversherpa/api/app.py` | router registration |
| `api/src/serversherpa/warehouse/seed.py`, `cli.py` | `seed-demo-warehouse` |
| `portal/src/lib/api.ts` | types + client functions |
| `portal/src/lib/warehouse.ts` | flatten, search/cell text, errors, form ↔ payload |
| `portal/src/pages/Warehouse.tsx` | the page |
| `portal/src/components/warehouse/StockLineModal.tsx`, `StockMoveModal.tsx` | stock forms |
| `portal/src/styles/warehouse.css` | layout only |
| `portal/src/App.tsx`, `layout/navSections.tsx`, `components/CommandPalette.tsx` | wiring |

---

### Task 1: Data — migration 0050, `StockLine` model, vocabulary, resource

**Files:**
- Create: `api/migrations/versions/0050_warehouse.py`
- Modify: `api/src/serversherpa/db/models.py` (append after `class TruckUpdate`), `api/src/serversherpa/access/resources.py` (after the `trucks` entry), `api/src/serversherpa/access/defaults.py` (add `"warehouse"` wherever `"trucks"` appears, same grant), `api/tests/test_access_registry.py` (pinned set gains `"warehouse"`), `api/tests/conftest.py` (if it pins container_type vocab rows, add the three new keys — check `grep -n container_type api/tests/conftest.py`)
- Test: `api/tests/test_warehouse_model.py`

**Interfaces — Produces:** `StockLine` model with columns exactly as below; vocab keys `pallet`, `crate`, `d_container` in `status_values` (`record_type='container_type'`); resource `warehouse`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_warehouse_model.py
"""stock_lines (0050): columns, CHECK quantity >= 0, FK set-null on container
delete, container_type vocab rows, warehouse grants."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.access.registry import RESOURCES
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
    assert "warehouse" in {r.key for r in RESOURCES}
    rows = (await db.execute(text(
        "SELECT role, action FROM role_permissions WHERE resource = 'warehouse'"))).all()
    roles = {r for r, _ in rows}
    assert {"developer", "founder", "super_admin", "admin", "staff"} <= roles
    assert {a for _, a in rows} == {"view", "add", "change", "delete"}
```

If `RESOURCES` lives under a different name, mirror how `api/tests/test_access_registry.py` imports the registry.

- [ ] **Step 2: Run to verify failure** — `… -m pytest -q tests/test_warehouse_model.py` → ImportError on `StockLine`.

- [ ] **Step 3: Migration**

```python
# api/migrations/versions/0050_warehouse.py
"""Warehouse inventory: stock_lines (counted stock at a warehouse site,
optionally inside a container / linked to a catalog model), three more
container types, and grants for the new `warehouse` resource.

Revision ID: 0050
Revises: 0049
Create Date: 2026-09-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0050"
down_revision: str | None = "0049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONTAINER_TYPES = """
    INSERT INTO status_values (record_type, key, label, description, color, sort_order)
    VALUES
      ('container_type','pallet','Pallet','Wrapped pallet of boxed or loose stock.','#a36207',10),
      ('container_type','crate','Crate','Wooden or plastic shipping crate.','#6d4fc4',11),
      ('container_type','d_container','D-container','Wheeled D-container / roll cage.','#0f7c86',12)
    ON CONFLICT DO NOTHING
"""
FULL = ("view", "add", "change", "delete")
GRANTS = {r: FULL for r in ("developer", "founder", "super_admin", "admin", "staff")}


def upgrade() -> None:
    op.execute(CONTAINER_TYPES)
    op.create_table(
        "stock_lines",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("site_id", UUID(as_uuid=True),
                  sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("container_id", UUID(as_uuid=True),
                  sa.ForeignKey("containers.id", ondelete="SET NULL")),
        sa.Column("model_id", UUID(as_uuid=True),
                  sa.ForeignKey("asset_models.id", ondelete="SET NULL")),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("unit", sa.Text, nullable=False, server_default="each"),
        sa.Column("location_detail", sa.Text, nullable=False, server_default=""),
        sa.Column("notes", sa.Text, nullable=False, server_default=""),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("quantity >= 0", name="ck_stock_lines_quantity_nonneg"),
    )
    op.create_index("stock_lines_site_idx", "stock_lines", ["site_id"])
    op.create_index("stock_lines_container_idx", "stock_lines", ["container_id"])
    op.create_index("stock_lines_model_idx", "stock_lines", ["model_id"])
    for role, actions in GRANTS.items():
        for action in actions:
            op.get_bind().execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'warehouse', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    op.get_bind().execute(sa.text("DELETE FROM role_permissions WHERE resource = 'warehouse'"))
    op.drop_index("stock_lines_model_idx", table_name="stock_lines")
    op.drop_index("stock_lines_container_idx", table_name="stock_lines")
    op.drop_index("stock_lines_site_idx", table_name="stock_lines")
    op.drop_table("stock_lines")
    op.execute("DELETE FROM status_values WHERE record_type = 'container_type' "
               "AND key IN ('pallet','crate','d_container')")
```

Check how 0049 inserts `role_permissions` (column names / conflict target) and copy that exactly if it differs from the above.

- [ ] **Step 4: Model** (append after `class TruckUpdate` in `db/models.py`; reuse the file's existing imports — `CheckConstraint`, `Integer`, `Text` are likely already imported; add any that aren't)

```python
class StockLine(Base):
    """Counted stock at a warehouse site — "24 × PDU, 30A" — optionally
    inside a container and/or linked to a catalog model. No status: its
    state is quantity (0 allowed) and archived_at."""

    __tablename__ = "stock_lines"
    __table_args__ = (
        CheckConstraint("quantity >= 0", name="ck_stock_lines_quantity_nonneg"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    site_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sites.id"))
    container_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("containers.id", ondelete="SET NULL"))
    model_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("asset_models.id", ondelete="SET NULL"))
    description: Mapped[str] = mapped_column(Text)
    quantity: Mapped[int] = mapped_column(Integer)
    unit: Mapped[str] = mapped_column(Text, server_default="each")
    location_detail: Mapped[str] = mapped_column(Text, server_default="")
    notes: Mapped[str] = mapped_column(Text, server_default="")
    source: Mapped[str] = mapped_column(Text, server_default="manual")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    archived_at: Mapped[datetime | None] = mapped_column()
```

- [ ] **Step 5: Resource + defaults** — in `access/resources.py` after the `trucks` entry:

```python
    Resource("warehouse", "Warehouse", routes=("/logistics/warehouse",),
             visible_to=frozenset({"global"})),
```

In `access/defaults.py` add `"warehouse"` next to every `"trucks"` occurrence with the same grant (`FULL`). In `tests/test_access_registry.py` add `"warehouse"` to the pinned resource-key set.

- [ ] **Step 6: Run** `… -m pytest -q tests/test_warehouse_model.py tests/test_access_registry.py tests/test_status_values_read.py tests/test_containers_api.py` → all pass (if a pinned container_type set exists in `test_status_values_read.py` or conftest, extend it with the three keys).

- [ ] **Step 7: Commit** `feat(warehouse): stock_lines table, container types, warehouse resource (migration 0050)`.

---

### Task 2: API — `routes/warehouse.py`

**Files:**
- Create: `api/src/serversherpa/api/routes/warehouse.py`
- Modify: `api/src/serversherpa/api/schemas.py` (append), `api/src/serversherpa/api/app.py` (register router next to `trucks`)
- Test: `api/tests/test_warehouse_api.py`

**Interfaces — Consumes:** `StockLine` (Task 1). **Produces:** endpoints and schemas exactly as below (the portal types in Task 4 mirror them).

- [ ] **Step 1: Schemas** (append to `schemas.py`)

```python
# ── warehouse ─────────────────────────────────────────────────────────

class AssetRef(BaseModel):
    id: uuid.UUID
    legacy_id: int | None = None
    serial_number: str | None = None
    name: str | None = None
    model_name: str | None = None
    status: str
    status_label: str
    status_color: str
    location_detail: str = ""


class StockLineOut(BaseModel):
    id: uuid.UUID
    site_id: uuid.UUID
    site_name: str
    container_id: uuid.UUID | None = None
    container_name: str | None = None
    model_id: uuid.UUID | None = None
    model_make: str | None = None
    model_model: str | None = None
    description: str
    quantity: int
    unit: str
    location_detail: str = ""
    notes: str = ""
    archived_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class StockLineCreateIn(BaseModel):
    site_id: uuid.UUID
    container_id: uuid.UUID | None = None
    model_id: uuid.UUID | None = None
    description: str
    quantity: int = Field(ge=0)
    unit: str = "each"
    location_detail: str = ""
    notes: str = ""
    model_config = ConfigDict(extra="forbid")


class StockLineUpdateIn(BaseModel):
    """PATCH — every field optional; None (unset) means unchanged EXCEPT
    container_id/model_id where an explicit null means 'clear'."""

    site_id: uuid.UUID | None = None
    container_id: uuid.UUID | None = None
    model_id: uuid.UUID | None = None
    description: str | None = None
    quantity: int | None = Field(default=None, ge=0)
    unit: str | None = None
    location_detail: str | None = None
    notes: str | None = None
    model_config = ConfigDict(extra="forbid")


class WarehouseSiteOut(BaseModel):
    id: uuid.UUID
    name: str
    code: str | None = None
    city: str | None = None
    region: str | None = None
    status: str
    status_label: str
    status_color: str
    container_count: int = 0
    asset_count: int = 0
    stock_line_count: int = 0
    stock_units: int = 0


class WarehouseContainerOut(BaseModel):
    id: uuid.UUID
    name: str
    rfid_tag: str | None = None
    container_type: str | None = None
    type_label: str | None = None
    type_color: str | None = None
    status: str
    status_label: str
    status_color: str
    location_detail: str = ""
    updated_at: datetime
    assets: list[AssetRef] = []
    stock: list[StockLineOut] = []


class WarehouseInventoryOut(BaseModel):
    site: WarehouseSiteOut
    containers: list[WarehouseContainerOut] = []
    loose_assets: list[AssetRef] = []
    loose_stock: list[StockLineOut] = []
```

`Field` must be imported from pydantic if it isn't already.

- [ ] **Step 2: Failing tests**

```python
# api/tests/test_warehouse_api.py
"""Warehouse API — sites with counts, per-site inventory, stock CRUD."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, AuditLog, Container, ContainerAsset, Site, StockLine,
)

from tests.test_sites_api import login
from tests.test_assets_api import make_login


async def _wh(db, name="ACC4 Storage"):
    site = Site(name=name, site_type="warehouse")
    db.add(site)
    await db.flush()
    return site


async def test_sites_lists_only_warehouses_with_counts(client, db, seeded_user):
    hdrs = await login(client)
    wh = await _wh(db)
    db.add(Site(name="Not a warehouse", site_type="datacenter"))
    box = Container(name="Pallet A-01", site_id=wh.id, container_type="pallet")
    db.add(box)
    await db.flush()
    asset = Asset(name="srv-1", site_id=wh.id, status="in_storage")
    db.add(asset)
    await db.flush()
    db.add(ContainerAsset(container_id=box.id, asset_id=asset.id))
    db.add(StockLine(site_id=wh.id, container_id=box.id, description="PDU", quantity=24))
    db.add(StockLine(site_id=wh.id, description="cage nuts", quantity=40, unit="bag"))
    db.add(StockLine(site_id=wh.id, description="archived", quantity=5,
                     archived_at=__import__("datetime").datetime.now(
                         __import__("datetime").UTC)))
    await db.commit()

    resp = await client.get("/warehouse/sites", headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [r["name"] for r in rows] == ["ACC4 Storage"]
    r = rows[0]
    assert (r["container_count"], r["asset_count"], r["stock_line_count"],
            r["stock_units"]) == (1, 1, 2, 64)


async def test_inventory_shape(client, db, seeded_user):
    hdrs = await login(client)
    wh = await _wh(db)
    box = Container(name="Crate C-07", site_id=wh.id, container_type="crate")
    other = Container(name="Elsewhere")
    db.add_all([box, other])
    await db.flush()
    inside = Asset(name="srv-in", serial_number="SN-IN", site_id=wh.id)
    loose = Asset(name="srv-loose", site_id=wh.id)
    away = Asset(name="srv-away")
    db.add_all([inside, loose, away])
    await db.flush()
    db.add(ContainerAsset(container_id=box.id, asset_id=inside.id))
    model = AssetModel(make="APC", model="AP8941")
    db.add(model)
    await db.flush()
    db.add(StockLine(site_id=wh.id, container_id=box.id, model_id=model.id,
                     description="PDU", quantity=24))
    db.add(StockLine(site_id=wh.id, description="Cage nuts", quantity=40,
                     unit="bag", location_detail="Shelf B"))
    await db.commit()

    resp = await client.get(f"/warehouse/{wh.id}/inventory", headers=hdrs)
    assert resp.status_code == 200, resp.text
    inv = resp.json()
    assert inv["site"]["name"] == "ACC4 Storage"
    assert len(inv["containers"]) == 1
    c = inv["containers"][0]
    assert c["type_label"] == "Crate"
    assert [a["serial_number"] for a in c["assets"]] == ["SN-IN"]
    assert c["stock"][0]["model_make"] == "APC"
    assert c["stock"][0]["container_name"] == "Crate C-07"
    assert [a["name"] for a in inv["loose_assets"]] == ["srv-loose"]
    assert [s["description"] for s in inv["loose_stock"]] == ["Cage nuts"]
    assert inv["loose_stock"][0]["location_detail"] == "Shelf B"

    dc = Site(name="DC", site_type="datacenter")
    db.add(dc)
    await db.commit()
    resp = await client.get(f"/warehouse/{dc.id}/inventory", headers=hdrs)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "site_not_warehouse"
    resp = await client.get(f"/warehouse/{uuid.uuid4()}/inventory", headers=hdrs)
    assert resp.status_code == 404


async def test_stock_crud_placement_and_audit(client, db, seeded_user):
    hdrs = await login(client)
    wh = await _wh(db)
    other_wh = await _wh(db, "DA11 Storage")
    box = Container(name="Pallet A-01", site_id=wh.id)
    far = Container(name="Far", site_id=other_wh.id)
    db.add_all([box, far])
    await db.commit()

    resp = await client.post("/warehouse/stock", headers=hdrs, json={
        "site_id": str(wh.id), "container_id": str(far.id),
        "description": "PDU", "quantity": 24})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "container_not_at_site"

    resp = await client.post("/warehouse/stock", headers=hdrs, json={
        "site_id": str(wh.id), "container_id": str(box.id),
        "description": "PDU", "quantity": 24})
    assert resp.status_code == 201, resp.text
    line = resp.json()
    assert line["unit"] == "each" and line["container_name"] == "Pallet A-01"
    lid = line["id"]

    resp = await client.post("/warehouse/stock", headers=hdrs, json={
        "site_id": str(wh.id), "description": "  ", "quantity": 1})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "description_required"

    resp = await client.post("/warehouse/stock", headers=hdrs, json={
        "site_id": str(wh.id), "description": "neg", "quantity": -1})
    assert resp.status_code == 422

    resp = await client.patch(f"/warehouse/stock/{lid}", headers=hdrs,
                              json={"quantity": 20, "container_id": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["quantity"] == 20
    assert resp.json()["container_id"] is None

    resp = await client.patch(f"/warehouse/stock/{lid}", headers=hdrs,
                              json={"description": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "description_required"

    resp = await client.patch(f"/warehouse/stock/{lid}", headers=hdrs,
                              json={"container_id": str(far.id)})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "container_not_at_site"

    resp = await client.patch(f"/warehouse/stock/{lid}", headers=hdrs,
                              json={"site_id": str(other_wh.id), "container_id": str(far.id)})
    assert resp.status_code == 200, resp.text
    assert resp.json()["site_name"] == "DA11 Storage"

    resp = await client.patch(f"/warehouse/stock/{lid}", headers=hdrs,
                              json={"bogus": 1})
    assert resp.status_code == 422

    resp = await client.post(f"/warehouse/stock/{lid}/archive", headers=hdrs)
    assert resp.status_code == 204
    inv = (await client.get(f"/warehouse/{other_wh.id}/inventory", headers=hdrs)).json()
    assert inv["containers"][0]["stock"] == []
    resp = await client.post(f"/warehouse/stock/{lid}/unarchive", headers=hdrs)
    assert resp.status_code == 204

    actions = list(await db.scalars(
        select(AuditLog.action).where(AuditLog.entity_type == "stock_line",
                                      AuditLog.entity_id == lid)))
    assert {"create", "update", "archive", "unarchive"} <= set(actions)
    upd = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "stock_line", AuditLog.entity_id == lid,
        AuditLog.action == "update").order_by(AuditLog.at))
    assert upd.changes["quantity"] == {"from": 24, "to": 20}


async def test_worker_is_forbidden(client, db, seeded_user):
    hdrs = await make_login(db, client, "worker", "wh-worker@test.example.com")
    resp = await client.get("/warehouse/sites", headers=hdrs)
    assert resp.status_code == 403
```

If `make_login` has a different name/signature in `tests/test_assets_api.py`, use the helper that already logs in a role-specific person (grep `async def make_login`/`_make`). If `Asset` requires a status vocab key, use one that conftest seeds (grep the asset vocab in conftest).

- [ ] **Step 3: Router**

```python
# api/src/serversherpa/api/routes/warehouse.py
"""Warehouse inventory — per-site view of containers (with contents),
loose tagged assets, and counted stock lines; stock-line CRUD.

The warehouse API owns ONLY stock_lines. Containers and assets are read
here but written through their own routers/permissions."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    AssetRef, StockLineCreateIn, StockLineOut, StockLineUpdateIn,
    WarehouseContainerOut, WarehouseInventoryOut, WarehouseSiteOut,
)
from serversherpa.db.models import (
    Asset, AssetModel, Container, ContainerAsset, Site, StatusValue, StockLine,
)
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/warehouse", tags=["warehouse"])

STOCK_FIELDS = ("site_id", "container_id", "model_id", "description",
                "quantity", "unit", "location_detail", "notes")
NON_NULLABLE_FIELDS = ("site_id", "description", "quantity", "unit",
                       "location_detail", "notes")
FALLBACK = ("", "#51606f")


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def _vocab(db: DbSession, *record_types: str) -> dict[str, dict[str, tuple[str, str]]]:
    rows = await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(record_types)))
    out: dict[str, dict[str, tuple[str, str]]] = {rt: {} for rt in record_types}
    for s in rows:
        out[s.record_type][s.key] = (s.label, s.color)
    return out


async def _warehouse_site(db: DbSession, site_id: uuid.UUID) -> Site:
    site = await db.get(Site, site_id)
    if site is None or site.archived_at is not None:
        raise _err(404, "site_not_found")
    if site.site_type != "warehouse":
        raise _err(422, "site_not_warehouse")
    return site


async def _site_counts(db: DbSession, site_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    counts = {sid: {"container_count": 0, "asset_count": 0,
                    "stock_line_count": 0, "stock_units": 0} for sid in site_ids}
    if not site_ids:
        return counts
    for sid, n in (await db.execute(
            select(Container.site_id, func.count())
            .where(Container.site_id.in_(site_ids), Container.archived_at.is_(None))
            .group_by(Container.site_id))).all():
        counts[sid]["container_count"] = n
    for sid, n in (await db.execute(
            select(Asset.site_id, func.count())
            .where(Asset.site_id.in_(site_ids), Asset.archived_at.is_(None))
            .group_by(Asset.site_id))).all():
        counts[sid]["asset_count"] = n
    for sid, n, units in (await db.execute(
            select(StockLine.site_id, func.count(),
                   func.coalesce(func.sum(StockLine.quantity), 0))
            .where(StockLine.site_id.in_(site_ids), StockLine.archived_at.is_(None))
            .group_by(StockLine.site_id))).all():
        counts[sid]["stock_line_count"] = n
        counts[sid]["stock_units"] = int(units)
    return counts


def _site_out(site: Site, statuses: dict, counts: dict) -> WarehouseSiteOut:
    label, color = statuses.get(site.status, (site.status, FALLBACK[1]))
    return WarehouseSiteOut(
        id=site.id, name=site.name, code=site.code, city=site.city,
        region=site.region, status=site.status, status_label=label,
        status_color=color, **counts)


async def _stock_out(db: DbSession, lines: list[StockLine]) -> list[StockLineOut]:
    if not lines:
        return []
    site_ids = {l.site_id for l in lines}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids)))).all())
    cids = {l.container_id for l in lines if l.container_id}
    containers = dict((await db.execute(
        select(Container.id, Container.name).where(Container.id.in_(cids)))).all()) if cids else {}
    mids = {l.model_id for l in lines if l.model_id}
    models = {m.id: m for m in await db.scalars(
        select(AssetModel).where(AssetModel.id.in_(mids)))} if mids else {}
    out = []
    for l in lines:
        m = models.get(l.model_id) if l.model_id else None
        out.append(StockLineOut(
            id=l.id, site_id=l.site_id, site_name=sites.get(l.site_id, ""),
            container_id=l.container_id,
            container_name=containers.get(l.container_id) if l.container_id else None,
            model_id=l.model_id, model_make=m.make if m else None,
            model_model=m.model if m else None,
            description=l.description, quantity=l.quantity, unit=l.unit,
            location_detail=l.location_detail, notes=l.notes,
            archived_at=l.archived_at, created_at=l.created_at,
            updated_at=l.updated_at))
    return out


def _asset_ref(a: Asset, statuses: dict, model_names: dict) -> AssetRef:
    label, color = statuses.get(a.status, (a.status, FALLBACK[1]))
    return AssetRef(
        id=a.id, legacy_id=a.legacy_id, serial_number=a.serial_number,
        name=a.name, model_name=model_names.get(a.model_id) if a.model_id else None,
        status=a.status, status_label=label, status_color=color,
        location_detail=a.location_detail)


@router.get("/sites", response_model=list[WarehouseSiteOut])
async def list_warehouse_sites(
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "view"),
) -> list[WarehouseSiteOut]:
    sites = list(await db.scalars(
        select(Site).where(Site.site_type == "warehouse", Site.archived_at.is_(None))
        .order_by(Site.name)))
    vocab = await _vocab(db, "site")
    counts = await _site_counts(db, [s.id for s in sites])
    return [_site_out(s, vocab["site"], counts[s.id]) for s in sites]


@router.get("/{site_id}/inventory", response_model=WarehouseInventoryOut)
async def warehouse_inventory(
    site_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "view"),
) -> WarehouseInventoryOut:
    site = await _warehouse_site(db, site_id)
    vocab = await _vocab(db, "site", "container", "container_type", "asset")
    counts = await _site_counts(db, [site.id])

    containers = list(await db.scalars(
        select(Container)
        .where(Container.site_id == site.id, Container.archived_at.is_(None))
        .order_by(Container.name)))
    cids = [c.id for c in containers]

    assets = list(await db.scalars(
        select(Asset).where(Asset.site_id == site.id, Asset.archived_at.is_(None))
        .order_by(Asset.name, Asset.serial_number)))
    membership = dict((await db.execute(
        select(ContainerAsset.asset_id, ContainerAsset.container_id)
        .where(ContainerAsset.container_id.in_(cids)))).all()) if cids else {}
    model_ids = {a.model_id for a in assets if a.model_id}
    model_names = {mid: f"{make} {model}" for mid, make, model in (await db.execute(
        select(AssetModel.id, AssetModel.make, AssetModel.model)
        .where(AssetModel.id.in_(model_ids)))).all()} if model_ids else {}

    lines = list(await db.scalars(
        select(StockLine)
        .where(StockLine.site_id == site.id, StockLine.archived_at.is_(None))
        .order_by(StockLine.description)))
    lines_out = await _stock_out(db, lines)

    by_container_assets: dict[uuid.UUID, list[AssetRef]] = {cid: [] for cid in cids}
    loose_assets: list[AssetRef] = []
    for a in assets:
        ref = _asset_ref(a, vocab["asset"], model_names)
        cid = membership.get(a.id)
        if cid in by_container_assets:
            by_container_assets[cid].append(ref)
        else:
            loose_assets.append(ref)
    by_container_stock: dict[uuid.UUID, list[StockLineOut]] = {cid: [] for cid in cids}
    loose_stock: list[StockLineOut] = []
    for l in lines_out:
        if l.container_id in by_container_stock:
            by_container_stock[l.container_id].append(l)
        else:
            loose_stock.append(l)

    containers_out = []
    for c in containers:
        s_label, s_color = vocab["container"].get(c.status, (c.status, FALLBACK[1]))
        t_label, t_color = (vocab["container_type"].get(c.container_type, (c.container_type, FALLBACK[1]))
                            if c.container_type else (None, None))
        containers_out.append(WarehouseContainerOut(
            id=c.id, name=c.name, rfid_tag=c.rfid_tag,
            container_type=c.container_type, type_label=t_label, type_color=t_color,
            status=c.status, status_label=s_label, status_color=s_color,
            location_detail=c.location_detail, updated_at=c.updated_at,
            assets=by_container_assets[c.id], stock=by_container_stock[c.id]))

    return WarehouseInventoryOut(
        site=_site_out(site, vocab["site"], counts[site.id]),
        containers=containers_out, loose_assets=loose_assets, loose_stock=loose_stock)


async def _check_placement(db: DbSession, site_id: uuid.UUID,
                           container_id: uuid.UUID | None, model_id: uuid.UUID | None) -> None:
    await _warehouse_site(db, site_id)
    if container_id is not None:
        container = await db.get(Container, container_id)
        if container is None or container.archived_at is not None:
            raise _err(404, "container_not_found")
        if container.site_id != site_id:
            raise _err(422, "container_not_at_site")
    if model_id is not None and await db.get(AssetModel, model_id) is None:
        raise _err(404, "model_not_found")


async def _get_line(db: DbSession, line_id: uuid.UUID) -> StockLine:
    line = await db.get(StockLine, line_id)
    if line is None:
        raise _err(404, "stock_line_not_found")
    return line


@router.post("/stock", response_model=StockLineOut, status_code=201)
async def create_stock_line(
    body: StockLineCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "add"),
) -> StockLineOut:
    data = body.model_dump()
    data["description"] = data["description"].strip()
    if not data["description"]:
        raise _err(422, "description_required")
    data["unit"] = data["unit"].strip() or "each"
    await _check_placement(db, data["site_id"], data["container_id"], data["model_id"])
    line = StockLine(**data, created_by=actor.person.id)
    db.add(line)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="stock_line",
          entity_id=str(line.id), action="create",
          changes=snapshot(line, STOCK_FIELDS))
    await db.commit()
    await db.refresh(line)
    return (await _stock_out(db, [line]))[0]


@router.patch("/stock/{line_id}", response_model=StockLineOut)
async def update_stock_line(
    line_id: uuid.UUID,
    body: StockLineUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "change"),
) -> StockLineOut:
    line = await _get_line(db, line_id)
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    if "description" in data:
        data["description"] = data["description"].strip()
        if not data["description"]:
            raise _err(422, "description_required")
    if "unit" in data:
        data["unit"] = data["unit"].strip() or "each"
    site_id = data.get("site_id", line.site_id)
    container_id = data.get("container_id", line.container_id)
    model_id = data.get("model_id", line.model_id)
    if {"site_id", "container_id", "model_id"} & data.keys():
        await _check_placement(db, site_id, container_id, model_id)
    before = snapshot(line, STOCK_FIELDS)
    for k, v in data.items():
        setattr(line, k, v)
    line.updated_at = datetime.now(UTC)
    changes = diff(before, snapshot(line, STOCK_FIELDS))
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="stock_line",
              entity_id=str(line.id), action="update", changes=changes)
    await db.commit()
    await db.refresh(line)
    return (await _stock_out(db, [line]))[0]


@router.post("/stock/{line_id}/archive", status_code=204)
async def archive_stock_line(
    line_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "delete"),
) -> None:
    line = await _get_line(db, line_id)
    line.archived_at = datetime.now(UTC)
    line.updated_at = line.archived_at
    audit(db, actor_id=actor.person.id, entity_type="stock_line",
          entity_id=str(line.id), action="archive")
    await db.commit()


@router.post("/stock/{line_id}/unarchive", status_code=204)
async def unarchive_stock_line(
    line_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "delete"),
) -> None:
    line = await _get_line(db, line_id)
    line.archived_at = None
    line.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="stock_line",
          entity_id=str(line.id), action="unarchive")
    await db.commit()
```

Check `snapshot`/`diff` signatures in `services/audit.py` (containers.py uses them the same way) and `Site.archived_at` exists (if sites use a different archive column, adjust `_warehouse_site`). `/sites` is a literal segment so it never collides with `/{site_id}/inventory`. Register in `app.py` exactly like `trucks`.

- [ ] **Step 4: Run** `… -m pytest -q tests/test_warehouse_api.py tests/test_warehouse_model.py` → pass. **Step 5: Commit** `feat(warehouse): API — sites, inventory, stock lines`.

---

### Task 3: Seed command

**Files:** Create `api/src/serversherpa/warehouse/__init__.py` (empty), `api/src/serversherpa/warehouse/seed.py`; Modify `api/src/serversherpa/cli.py` (mirror `seed_demo_trucks`); Test `api/tests/test_warehouse_seed.py`.

**Produces:** `async def seed_demo_warehouse(db) -> int` (rows added: containers + stock lines), CLI `serversherpa seed-demo-warehouse` printing `Seeded N row(s).`

- [ ] Test: with no warehouse site, seeding creates "Demo Warehouse (Ashburn)" (site_type warehouse), containers "Pallet A-01" (pallet), "Crate C-07" (crate), "D-Container D-02" (d_container) at it, and four stock lines: 24 "PDU, 30A vertical" each on Pallet A-01; 6 "Cat6 patch, 10 ft" box in Crate C-07; 40 "Cage nuts M6" bag loose location "Shelf B"; 2 "Rack PDU (spare)" each loose, `model_id` = the first `AssetModel` whose `category` is in ("pdu", "power") if one exists else None. Returns 7 on first run, 0 on second (idempotent by container name / description at that site). With an existing warehouse site, uses the first one by name and creates no site.
- [ ] Implement + CLI + run `tests/test_warehouse_seed.py` + commit `feat(warehouse): seed-demo-warehouse command`.

---

### Task 4: Portal lib — API client + helpers

**Files:** Modify `portal/src/lib/api.ts` (append after the trucks section); Create `portal/src/lib/warehouse.ts`, `portal/src/lib/warehouse.test.ts`.

**Produces (exact):**

```ts
// api.ts
export interface AssetRef { id: string; legacy_id: number | null; serial_number: string | null; name: string | null; model_name: string | null; status: string; status_label: string; status_color: string; location_detail: string; }
export interface StockLine { id: string; site_id: string; site_name: string; container_id: string | null; container_name: string | null; model_id: string | null; model_make: string | null; model_model: string | null; description: string; quantity: number; unit: string; location_detail: string; notes: string; archived_at: string | null; created_at: string; updated_at: string; }
export interface WarehouseSite { id: string; name: string; code: string | null; city: string | null; region: string | null; status: string; status_label: string; status_color: string; container_count: number; asset_count: number; stock_line_count: number; stock_units: number; }
export interface WarehouseContainer { id: string; name: string; rfid_tag: string | null; container_type: string | null; type_label: string | null; type_color: string | null; status: string; status_label: string; status_color: string; location_detail: string; updated_at: string; assets: AssetRef[]; stock: StockLine[]; }
export interface WarehouseInventory { site: WarehouseSite; containers: WarehouseContainer[]; loose_assets: AssetRef[]; loose_stock: StockLine[]; }
export async function listWarehouseSites(): Promise<WarehouseSite[]>            // GET /warehouse/sites
export async function getWarehouseInventory(siteId: string): Promise<WarehouseInventory> // GET /warehouse/{siteId}/inventory
export async function createStockLine(body: Record<string, unknown>): Promise<StockLine>  // POST /warehouse/stock
export async function updateStockLine(id: string, body: Record<string, unknown>): Promise<StockLine> // PATCH
export async function archiveStockLine(id: string, archived: boolean): Promise<void> // POST archive|unarchive

// warehouse.ts
export type InventoryRowKind = 'container' | 'asset' | 'stock';
export interface InventoryRow {
  key: string;                 // `${kind}:${id}`
  kind: InventoryRowKind;
  id: string;
  primary: string;             // container name | asset serial ?? name ?? '—' | stock description
  secondary: string;           // container: rfid or '' | asset: name when serial shown | stock: notes
  model: string;               // container: type_label ?? '' | asset: model_name ?? '' | stock: "Make Model" or ''
  qtyText: string;             // container: "3 assets · 40 units" (omit zero parts, '' when both zero) | asset: '1' | stock: `${quantity} ${unit}`
  location: string;
  status: { key: string; label: string; color: string } | null;   // null for stock
  updated: string | null;      // ISO
  container: WarehouseContainer | null;   // for kind container
  asset: AssetRef | null;
  stock: StockLine | null;
}
export function flattenInventory(inv: WarehouseInventory): InventoryRow[]   // containers (name natural order) then loose assets then loose stock
export function inventorySearchText(r: InventoryRow): string
export function inventoryCellText(r: InventoryRow, colKey: 'primary'|'kind'|'model'|'qty'|'location'|'status'|'updated'): string
export const KIND_LABEL: Record<InventoryRowKind, string>   // Container / Asset / Stock
export const UNIT_SUGGESTIONS = ['each','box','pallet','spool','roll','bag','case'];
export const STOCK_ERRORS: Record<string,string> = {
  description_required: 'Describe the stock line.', quantity_required: 'Enter a quantity.', unit_required: 'Enter a unit.',
  site_not_found: 'That warehouse no longer exists.', site_not_warehouse: 'That site is not typed Warehouse.',
  container_not_found: 'That container no longer exists.', container_not_at_site: 'That container is at a different site.',
  model_not_found: 'That model no longer exists.', stock_line_not_found: 'That stock line no longer exists.',
  forbidden: 'You do not have permission to change warehouse stock.',
};
export interface StockFormState { description: string; quantity: string; unit: string; model_id: string; container_id: string; location_detail: string; notes: string; }
export function formFromStockLine(line: StockLine | null): StockFormState   // quantity as string, '' ids for null, unit default 'each'
export function stockPayload(f: StockFormState, siteId: string): Record<string, unknown>  // trims; quantity Number(); model_id/container_id '' → null; ALWAYS includes site_id
export function modelLabel(m: { make: string; model: string }): string      // "Make Model"
```

Tests cover flatten ordering/qtyText variants, search text, cell text per column, payload null mapping + quantity coercion, formFromStockLine round trip.

- [ ] Commit `feat(portal): warehouse API client + helpers`.

---

### Task 5: Warehouse page + stock modals + wiring

**Files:** Create `portal/src/pages/Warehouse.tsx`, `portal/src/pages/Warehouse.test.tsx`, `portal/src/components/warehouse/StockLineModal.tsx`, `StockLineModal.test.tsx`, `portal/src/components/warehouse/StockMoveModal.tsx`, `portal/src/styles/warehouse.css`; Modify `portal/src/App.tsx` (replace the placeholder route with `<ProtectedRoute resource="warehouse"><Warehouse /></ProtectedRoute>`), `portal/src/layout/navSections.tsx` (Warehouse item `resource: 'warehouse'`), `portal/src/components/CommandPalette.tsx` (`navGated('Warehouse', '/logistics/warehouse', 'warehouse')`).

**Consumes:** everything from Task 4; existing `ContainerEditModal` (props `container, statuses, types, sites, canChange, onClose, onSaved` — pass `listContainerStatuses()`, `listContainerTypes()`, `listSites()`), `AssetEditModal` (props `asset, statuses, clients, sites, existingSerials, canChange, onClose, onSaved` — look at how `Assets.tsx` builds them), `ComboBox`, `RowActionsMenu`, `usePersistentListState('warehouse', …)`, `VirtualRows`, `ColumnMenu`, `statusChip`, dashboard KPI tiles (`.dash-kpis` / `.dash-kpi` / `.dash-kpi-label` / `.dash-kpi-value` from PeopleDashboard.tsx).

- [ ] **Page** (`Warehouse.tsx`): copy `Containers.tsx`'s page chrome/list skeleton and adapt.
  - Selector row: `<select className="org-select">` is NOT allowed — use `ComboBox` with options `{ value: site.id, label: site.name, sub: `${container_count} containers · ${stock_units} units` }`; selected id state initialised from `?site=` (URLSearchParams) else `localStorage['warehouse.site']` else the first site; changing it updates both. Empty state when `sites.length === 0`: `<p className="page-hint">No sites are typed Warehouse yet. <Link to="/sites">Open Sites</Link></p>`.
  - KPI tiles: Containers / Tagged assets / Stock lines / Units in stock from `inventory.site`.
  - Kind filter `.segmented` (All / Containers / Assets / Stock with counts) above the list; filter box `.dir-search`; Columns; Export; `+ Add stock` (needs `can('warehouse','add')`), `+ New container` (needs `can('containers','add')`).
  - Rows = `flattenInventory(inventory)` filtered by kind pill and `useSearchHaystacks(inventorySearchText)`. Columns: `primary` (`.pn b` + `.pn span` secondary), `kind` (chip with class per kind: container `chip tag`, asset `chip`, stock `chip custom` with `--chip:#a36207`), `model` (cell-sub), `qty` (mono), `location` (cell-sub), `status` (`statusChip` or "—"), `updated` (mono, `relativeTime`).
  - Expanding a container row (existing row-detail block) renders a `mini-list` with a `mini-list-head` (Item / Model / Qty / Status) and one `mini-row` per asset (`serial ?? name`, model_name, "1", status chip) and per stock line (description, model label, `${quantity} ${unit}`, "—"), each with an `Edit` mini-btn (asset → `AssetEditModal`, stock → `StockLineModal`) and, for stock, `Move`. Empty container: "Nothing inside this container."
  - `RowActionsMenu`: container → Edit (`ContainerEditModal`), Open in Containers (`navigate('/logistics/containers?focus=' + id)`); asset → Edit, Open in Assets (`/assets?focus=` — check the Assets page's focus param name); stock → Edit, Move, Archive (`window.confirm('Archive this stock line?')` → `archiveStockLine(id, true)`).
  - After any modal `onSaved`: `getWarehouseInventory(siteId)` + `listWarehouseSites()` refetch without blanking rows.
- [ ] **StockLineModal** (`{ siteId, siteName, containers: WarehouseContainer[], line: StockLine | null, onClose, onSaved }`): `.pf-form` in a content-sized `modal-card`; header "Add stock · {siteName}" / "Edit — {description}"; fields Description (required), Quantity (`input type="number" min=0 step=1`), Unit (`ComboBox` over `UNIT_SUGGESTIONS` with `clearable`, plus the current value if not in the list — ComboBox has no free-text mode, so render the ComboBox for suggestions AND accept typed text via an "Other…" option that reveals a text input; keep it simple), Model (`ComboBox` of `listAssetModels()` labelled `modelLabel(m)`, `sub` = category_label, clearable; choosing a model when Description is blank fills it with the label), Container (`ComboBox`: "Loose at site" (value '') + the warehouse's containers), Location detail, Notes. Save → `stockPayload(form, siteId)` → `createStockLine` / `updateStockLine(line.id, …)`; error → `STOCK_ERRORS[code] ?? message` in `.pf-error`. Client-side: blank description → "Describe the stock line." without calling the API; quantity NaN or < 0 → "Enter a quantity of 0 or more."
- [ ] **StockMoveModal** (`{ line, containers, onClose, onSaved }`): one `ComboBox` (Loose at site + containers) + Save → `updateStockLine(line.id, { container_id })`.
- [ ] **Tests**: `Warehouse.test.tsx` (mock api: two sites, inventory with one container holding one asset + one stock line, one loose asset, one loose stock) — selector shows the first site and loads its inventory; tiles show counts; kind pill "Stock" leaves only stock rows; expanding the container shows its two contents rows; `+ Add stock` → modal → save posts `{ site_id, description, quantity: 24, unit: 'each', container_id: null, … }` and refetches; archive confirms and calls `archiveStockLine`; empty-sites state. `StockLineModal.test.tsx` — required description, model fill-in, error mapping for `container_not_at_site`.
- [ ] `warehouse.css`: layout only (selector row flex, tiles grid reuse, nested mini-list indent, `.wh-modal { width: fit-content; min-width: 420px; max-width: min(720px, 92vw) }`).
- [ ] Run `npx vitest run src/pages/Warehouse.test.tsx src/components/warehouse src/lib/warehouse.test.ts src/styles/listTypography.test.ts src/layout && npx tsc --noEmit -p .`; commit `feat(portal): Warehouse page — per-site inventory with stock lines`.

---

### Task 6: Verification (controller-led)

- [ ] Full API suite (private DB `serversherpa_test_wh`) and full portal suite + tsc + build; guardrail green.
- [ ] Dev DB `alembic upgrade head`; `serversherpa seed-demo-warehouse`.
- [ ] Live on worktree servers (portal-lt 5174 / api-lt 8001): selector, tiles, list, expand container, add / edit / move / archive stock, new container from the page, nav + palette, list size Extra large.
- [ ] Fix, commit, fast-forward `main`.
