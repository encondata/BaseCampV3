# Logistics Slice 1 — Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Containers end-to-end — migration, vocabularies, API CRUD + asset membership + bulk import, and the portal Containers page under a new Logistics nav group.

**Architecture:** Mirrors the Assets section exactly: Alembic migration seeding `status_values` vocabularies, a FastAPI route module cloned from `assets.py` conventions (permission gates, audit diffs, soft archive), and a portal list page cloned from `Assets.tsx` (column menus, persistent prefs, read-only expansion, edit modal). Container↔asset membership is a join table with UNIQUE(asset_id). Bulk import mirrors the sites preview/commit flow.

**Tech Stack:** FastAPI + SQLAlchemy 2 async + Alembic + pytest-asyncio (API); React 18 + TypeScript + vitest (portal).

**Spec:** `docs/superpowers/specs/2026-08-05-logistics-design.md`. Slice 2 (Trucks, GPS, `containers.truck_id`) is a separate follow-up plan — nothing in this plan references trucks.

## Global Constraints

- Repo root: `/Volumes/Extreme SSD/Code Backups/BaseCampV3`. API paths below are relative to `api/`, portal paths to `portal/`.
- Run API tests: `cd api && python -m pytest tests/<file> -x -q`. Run portal checks: `cd portal && npx tsc --noEmit && npx vitest run src/lib/<file>`.
- If working in a worktree: symlink `.env`, `.venv`, `node_modules` from the main checkout first (see memory `running-api-tests-in-worktrees`), and NEVER `git add -A` (the symlinks are not gitignored — add files explicitly).
- Vocabulary colors MUST come from the measured house palette already used in migration 0014: green `#178a4c`, teal `#0f7c86`, slate `#51606f`, red `#c03540`, amber `#a36207`, blue `#1668a7`, purple `#6d4fc4`.
- Every record-backed dropdown is the shared `ComboBox` (type-to-filter). Row expansions are read-only; all mutation lives in the edit modal. Do not seed demo rows in the dev DB.
- Copy style: sentence case, em-dash hints, `—` for blank cells (matches Assets page).
- Commit after every task with the message given in that task's final step.

---

### Task 1: Migration 0015 + models + registries

**Files:**
- Create: `api/migrations/versions/0015_containers.py`
- Modify: `api/src/serversherpa/db/models.py` (append after `class Asset`, before `class Note`)
- Modify: `api/src/serversherpa/status/registry.py:22-29` (STATUS_RECORD_TYPES list)
- Modify: `api/src/serversherpa/access/resources.py` (add resource after the `assets`/`asset_models` entries)
- Test: `api/tests/test_containers_model.py`

**Interfaces:**
- Produces: `Container` and `ContainerAsset` ORM classes; `status_values` record types `container` and `container_type`; access resource `containers` with route `/logistics/containers`; DB tables `containers`, `container_assets`.

- [ ] **Step 1: Write the failing model test**

```python
# api/tests/test_containers_model.py
"""Containers schema — defaults, constraints, vocabulary seeds, registry."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Asset, Container, ContainerAsset, StatusValue,
)


async def test_container_defaults(db):
    c = Container(name="Crate 1")
    db.add(c)
    await db.commit()
    assert c.id is not None
    assert c.status == "available"
    assert c.location_detail == ""
    assert c.source == "manual"
    assert c.archived_at is None


async def test_vocabulary_seeds(db):
    statuses = {s.key for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "container"))}
    assert statuses == {"available", "packed", "in_transit", "historical"}
    types = {s.key for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "container_type"))}
    assert types == {"pelican_case", "shipping_container", "cart"}


async def test_unknown_status_rejected_by_fk(db):
    db.add(Container(name="Bad", status="nope"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_one_container_per_asset(db):
    a = Asset(name="asset-1")
    c1, c2 = Container(name="C1"), Container(name="C2")
    db.add_all([a, c1, c2])
    await db.flush()
    db.add(ContainerAsset(container_id=c1.id, asset_id=a.id))
    await db.commit()
    db.add(ContainerAsset(container_id=c2.id, asset_id=a.id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_registry_shape():
    from serversherpa.access.resources import REGISTRY
    from serversherpa.status.registry import STATUS_REGISTRY

    assert REGISTRY["containers"].visible_to == frozenset({"global"})
    assert "/logistics/containers" in REGISTRY["containers"].routes
    assert STATUS_REGISTRY["container"].table == "containers"
    assert STATUS_REGISTRY["container"].column == "status"
    assert STATUS_REGISTRY["container_type"].table == "containers"
    assert STATUS_REGISTRY["container_type"].column == "container_type"
    assert STATUS_REGISTRY["container"].resource == "containers"
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd api && python -m pytest tests/test_containers_model.py -x -q`
Expected: FAIL — `ImportError: cannot import name 'Container'`.

- [ ] **Step 3: Write the migration**

Note on statuses: the spec listed an `assigned_to_truck` seed; trucks don't exist in this slice, so it ships in the Trucks migration (0016) instead — seeding a status whose semantics can't occur yet would just be noise in the picker.

```python
# api/migrations/versions/0015_containers.py
"""containers — logistics containers + asset membership.
Rebuilt from legacy V2 containers/containers_assets_list: uuid PKs,
status + type via status_values vocabularies, site FK + free-text
location_detail (the assets idiom, replacing V2's sites_locations FK),
membership in a join table with UNIQUE(asset_id) (one container per
asset — V2 assumed but never enforced this), and the denormalized
container_device_count deliberately dropped (computed in queries).
truck_id arrives in 0016 with the trucks table.

Revision ID: 0015
Revises: 0014
Create Date: 2026-08-06
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONTAINER_SEEDS = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('container','available','Available','Empty or accepting assets.','#178a4c',1),
      ('container','packed','Packed','Loaded and sealed.','#6d4fc4',2),
      ('container','in_transit','In transit','Between locations.','#0f7c86',3),
      ('container','historical','Historical','Retired; retained for history.','#51606f',4),
      ('container_type','pelican_case','Pelican case','Hard transport case.','#1668a7',1),
      ('container_type','shipping_container','Shipping container','Full-size freight container.','#a36207',2),
      ('container_type','cart','Cart','Rolling cart or trolley.','#0f7c86',3)
"""

FULL = ("view", "add", "change", "delete")
# containers: internal-only (like sites) — no client/partner visibility.
CONTAINER_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": FULL,
}


def upgrade() -> None:
    op.execute(CONTAINER_SEEDS)

    op.create_table(
        "containers",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT, nullable=False),
        sa.Column("rfid_tag", CITEXT),
        sa.Column("container_type", sa.Text),
        sa.Column("status", sa.Text, nullable=False, server_default="available"),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("location_detail", sa.Text, nullable=False, server_default=""),
        sa.Column("last_audit_at", sa.TIMESTAMP(timezone=True),
                  comment="written by future scan surfaces"),
        sa.Column("audit_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("last_validated_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("legacy_id", sa.BigInteger, comment="V2 containers.id"),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    # composite FKs to status_values — the 0014 assets idiom, twice
    op.execute("""
        ALTER TABLE containers ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('container') STORED
    """)
    op.create_foreign_key(
        "containers_status_fkey", "containers", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])
    op.execute("""
        ALTER TABLE containers ADD COLUMN type_record_type text
          GENERATED ALWAYS AS ('container_type') STORED
    """)
    # MATCH SIMPLE: a NULL container_type skips the check entirely
    op.create_foreign_key(
        "containers_type_fkey", "containers", "status_values",
        ["type_record_type", "container_type"], ["record_type", "key"])

    op.create_index("containers_name_idx", "containers", ["name"])
    op.create_index("containers_site_idx", "containers", ["site_id"])
    op.create_index("containers_rfid_uniq", "containers", ["rfid_tag"],
                    unique=True,
                    postgresql_where=sa.text("rfid_tag IS NOT NULL"))

    op.create_table(
        "container_assets",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("container_id", UUID(as_uuid=True),
                  sa.ForeignKey("containers.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), sa.ForeignKey("assets.id"),
                  nullable=False, unique=True,
                  comment="UNIQUE: one container per asset"),
        sa.Column("added_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("added_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("last_validated_at", sa.TIMESTAMP(timezone=True)),
    )
    op.create_index("container_assets_container_idx", "container_assets",
                    ["container_id"])

    conn = op.get_bind()
    for role, actions in CONTAINER_GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'containers', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'containers'"))
    op.drop_table("container_assets")
    op.drop_table("containers")
    conn.execute(sa.text(
        "DELETE FROM status_values "
        "WHERE record_type IN ('container', 'container_type')"))
```

- [ ] **Step 4: Add the ORM models**

In `api/src/serversherpa/db/models.py`, insert between `class Asset` and `class Note` (keep the file's existing import block — `CITEXT`, `UUID`, `text`, etc. are already imported):

```python
class Container(Base):
    __tablename__ = "containers"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    rfid_tag: Mapped[str | None] = mapped_column(CITEXT)
    container_type: Mapped[str | None]
    status: Mapped[str] = mapped_column(server_default="available")
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'container'"))  # GENERATED column; never written
    type_record_type: Mapped[str] = mapped_column(
        server_default=text("'container_type'"))  # GENERATED; never written
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    location_detail: Mapped[str] = mapped_column(server_default="")
    last_audit_at: Mapped[datetime | None]
    audit_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    last_validated_at: Mapped[datetime | None]
    legacy_id: Mapped[int | None] = mapped_column(BigInteger)
    source: Mapped[str] = mapped_column(server_default="manual")
    source_ref: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ContainerAsset(Base):
    __tablename__ = "container_assets"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    container_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("containers.id", ondelete="CASCADE"))
    asset_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("assets.id"), unique=True)
    added_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    added_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    last_validated_at: Mapped[datetime | None]
```

- [ ] **Step 5: Register the record types and the resource**

In `api/src/serversherpa/status/registry.py`, extend `STATUS_RECORD_TYPES` (after the `asset` entry):

```python
    StatusRecordType("container", "Container", table="containers",
                     column="status", resource="containers"),
    StatusRecordType("container_type", "Container type", table="containers",
                     column="container_type", resource="containers"),
```

In `api/src/serversherpa/access/resources.py`, add to `_RESOURCES` directly after the `asset_models` entry:

```python
    Resource("containers", "Containers", routes=("/logistics/containers",),
             # internal-only, like sites — no client/partner visibility.
             visible_to=frozenset({"global"})),
```

- [ ] **Step 6: Run the migration and the tests**

Run: `cd api && alembic upgrade head && python -m pytest tests/test_containers_model.py tests/test_status_registry.py tests/test_access_registry.py -q`
Expected: all PASS (the two registry test files guard the lists you just extended).

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0015_containers.py api/src/serversherpa/db/models.py api/src/serversherpa/status/registry.py api/src/serversherpa/access/resources.py api/tests/test_containers_model.py
git commit -m "feat(api): containers schema — tables, vocabularies, registry entries"
```

---

### Task 2: Container schemas + CRUD routes

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (append after the asset schemas, ~line 885)
- Create: `api/src/serversherpa/api/routes/containers.py`
- Modify: `api/src/serversherpa/api/app.py` (import + `include_router` after `assets.router`)
- Test: `api/tests/test_containers_api.py`

**Interfaces:**
- Consumes: `Container` ORM (Task 1); `require_permission`, `AuthContext`, `DbSession` from `api/deps.py`; `audit`, `diff`, `snapshot` from `services/audit.py`.
- Produces: Pydantic `ContainerItem` (fields: `id, name, rfid_tag, container_type, type_label, type_color, status, status_label, status_color, site_id, site_name, location_detail, asset_count, last_audit_at, last_validated_at, archived_at, created_at`), `ContainerCreateIn`, `ContainerUpdateIn`; endpoints `GET/POST /containers`, `GET/PATCH /containers/{id}`, `POST /containers/{id}/archive|unarchive`; helper `_get_container(db, container_id)` and `_detail(db, container)` reused by Task 3.

- [ ] **Step 1: Write the failing API tests**

```python
# api/tests/test_containers_api.py
"""Containers API — CRUD, labels, vocab/ref validation, archive, gates."""

from serversherpa.db.models import Person, PersonRole, Site

from .test_assets_api import login, make_login


async def test_crud_roundtrip(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="DC-1")
    db.add(site)
    await db.commit()

    resp = await client.post("/containers", headers=hdrs, json={
        "name": "Crate A", "container_type": "pelican_case",
        "rfid_tag": "RF-001", "site_id": str(site.id),
        "location_detail": "Dock 3",
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "available"
    assert body["status_label"] == "Available"
    assert body["type_label"] == "Pelican case"
    assert body["site_name"] == "DC-1"
    assert body["asset_count"] == 0
    cid = body["id"]

    resp = await client.get("/containers", headers=hdrs)
    assert [c["id"] for c in resp.json()] == [cid]

    resp = await client.patch(f"/containers/{cid}", headers=hdrs,
                              json={"status": "packed", "site_id": None})
    assert resp.status_code == 200
    assert resp.json()["status"] == "packed"
    assert resp.json()["site_name"] is None


async def test_validation_errors(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers", headers=hdrs,
                             json={"name": "X", "status": "nope"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_status"

    resp = await client.post("/containers", headers=hdrs,
                             json={"name": "X", "container_type": "nope"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_container_type"

    await client.post("/containers", headers=hdrs,
                      json={"name": "A", "rfid_tag": "DUP-1"})
    resp = await client.post("/containers", headers=hdrs,
                             json={"name": "B", "rfid_tag": "DUP-1"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "rfid_tag_in_use"

    resp = await client.patch("/containers/00000000-0000-0000-0000-000000000000",
                              headers=hdrs, json={"name": "Z"})
    assert resp.status_code == 404


async def test_archive_roundtrip(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers", headers=hdrs, json={"name": "Arch"})
    cid = resp.json()["id"]
    assert (await client.post(f"/containers/{cid}/archive",
                              headers=hdrs)).status_code == 204
    resp = await client.get(f"/containers/{cid}", headers=hdrs)
    assert resp.json()["archived_at"] is not None
    assert (await client.post(f"/containers/{cid}/unarchive",
                              headers=hdrs)).status_code == 204


async def test_no_permission_403(client, db, seeded_user):
    nobody = Person(first_name="No", last_name="Body")
    db.add(nobody)
    await db.flush()
    db.add(PersonRole(person_id=nobody.id, role="client_viewer"))
    await db.commit()
    hdrs = await make_login(db, client, nobody, "nobody@test.example.com")
    assert (await client.get("/containers", headers=hdrs)).status_code == 403
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && python -m pytest tests/test_containers_api.py -x -q`
Expected: FAIL — 404s (no `/containers` routes exist).

- [ ] **Step 3: Add the Pydantic schemas**

Append to `api/src/serversherpa/api/schemas.py` after the asset block:

```python
class ContainerItem(BaseModel):
    id: uuid.UUID
    name: str
    rfid_tag: str | None = None
    container_type: str | None = None
    type_label: str | None = None
    type_color: str | None = None
    status: str
    status_label: str
    status_color: str
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    location_detail: str
    asset_count: int = 0
    last_audit_at: datetime | None = None
    last_validated_at: datetime | None = None
    archived_at: datetime | None = None
    created_at: datetime


class ContainerCreateIn(BaseModel):
    name: str
    rfid_tag: str | None = None
    container_type: str | None = None
    status: str | None = None
    site_id: uuid.UUID | None = None
    location_detail: str = ""
    model_config = ConfigDict(extra="forbid")


class ContainerUpdateIn(BaseModel):
    name: str | None = None
    rfid_tag: str | None = None
    container_type: str | None = None
    status: str | None = None
    site_id: uuid.UUID | None = None
    location_detail: str | None = None
    model_config = ConfigDict(extra="forbid")
```

- [ ] **Step 4: Write the route module**

```python
# api/src/serversherpa/api/routes/containers.py
"""Containers — logistics transport containers (legacy V2 containers).
Internal-only resource; all actors are globally anchored. Asset
membership endpoints live here too (the container is the aggregate
root); the join table enforces one-container-per-asset."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    ContainerCreateIn, ContainerItem, ContainerUpdateIn,
)
from serversherpa.db.models import Container, ContainerAsset, Site, StatusValue
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/containers", tags=["containers"])

CONTAINER_FIELDS = [
    "name", "rfid_tag", "container_type", "status", "site_id",
    "location_detail",
]
NON_NULLABLE_FIELDS = ("name", "location_detail", "status")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _get_container(db: DbSession, container_id: uuid.UUID) -> Container:
    container = await db.get(Container, container_id)
    if container is None:
        raise _err(404, "container_not_found")
    return container


async def _vocab(db: DbSession) -> tuple[dict, dict]:
    rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(("container", "container_type"))))).all()
    statuses = {s.key: (s.label, s.color)
                for s in rows if s.record_type == "container"}
    types = {s.key: (s.label, s.color)
             for s in rows if s.record_type == "container_type"}
    return statuses, types


async def _context(db: DbSession, containers: list[Container]) -> tuple:
    statuses, types = await _vocab(db)
    site_ids = {c.site_id for c in containers if c.site_id}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids))
    )).all()) if site_ids else {}
    ids = [c.id for c in containers]
    counts = dict((await db.execute(
        select(ContainerAsset.container_id, func.count())
        .where(ContainerAsset.container_id.in_(ids))
        .group_by(ContainerAsset.container_id)
    )).all()) if ids else {}
    return statuses, types, sites, counts


def _item(c: Container, statuses: dict, types: dict, sites: dict,
          counts: dict) -> dict:
    s_label, s_color = statuses.get(c.status, (c.status, "#51606f"))
    t_label, t_color = (types.get(c.container_type, (c.container_type, "#51606f"))
                        if c.container_type is not None else (None, None))
    return {
        "id": c.id, "name": c.name, "rfid_tag": c.rfid_tag,
        "container_type": c.container_type,
        "type_label": t_label, "type_color": t_color,
        "status": c.status, "status_label": s_label, "status_color": s_color,
        "site_id": c.site_id, "site_name": sites.get(c.site_id),
        "location_detail": c.location_detail,
        "asset_count": counts.get(c.id, 0),
        "last_audit_at": c.last_audit_at,
        "last_validated_at": c.last_validated_at,
        "archived_at": c.archived_at, "created_at": c.created_at,
    }


async def _detail(db: DbSession, container: Container) -> ContainerItem:
    statuses, types, sites, counts = await _context(db, [container])
    return ContainerItem(**_item(container, statuses, types, sites, counts))


@router.get("", response_model=list[ContainerItem])
async def list_containers(
    db: DbSession,
    actor: AuthContext = require_permission("containers", "view"),
) -> list[ContainerItem]:
    containers = list(await db.scalars(
        select(Container).order_by(Container.created_at.desc())))
    statuses, types, sites, counts = await _context(db, containers)
    return [ContainerItem(**_item(c, statuses, types, sites, counts))
            for c in containers]


@router.get("/{container_id}", response_model=ContainerItem)
async def get_container(
    container_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "view"),
) -> ContainerItem:
    return await _detail(db, await _get_container(db, container_id))


async def _check_refs(db: DbSession, data: dict) -> None:
    if data.get("site_id") is not None and \
            await db.get(Site, data["site_id"]) is None:
        raise _err(422, "site_not_found")
    for field, record_type, code in (
        ("status", "container", "unknown_status"),
        ("container_type", "container_type", "unknown_container_type"),
    ):
        if data.get(field) is not None and await db.scalar(
            select(StatusValue).where(
                StatusValue.record_type == record_type,
                StatusValue.key == data[field])) is None:
            raise _err(422, code)


async def _check_rfid(db: DbSession, tag: str | None,
                      exclude: uuid.UUID | None = None) -> None:
    if tag is None:
        return
    query = select(Container.id).where(Container.rfid_tag == tag)
    if exclude is not None:
        query = query.where(Container.id != exclude)
    if await db.scalar(query) is not None:
        raise _err(409, "rfid_tag_in_use")


@router.post("", response_model=ContainerItem, status_code=201)
async def create_container(
    body: ContainerCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "add"),
) -> ContainerItem:
    data = body.model_dump(exclude_none=True)
    await _check_refs(db, data)
    await _check_rfid(db, data.get("rfid_tag"))
    container = Container(**data, created_by=actor.person.id)
    db.add(container)
    await db.flush()
    initial = snapshot(container, CONTAINER_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items() if value not in (None, "")}
    audit(db, actor_id=actor.person.id, entity_type="container",
          entity_id=str(container.id), action="create", changes=changes)
    await db.commit()
    return await _detail(db, container)


@router.patch("/{container_id}", response_model=ContainerItem)
async def update_container(
    container_id: uuid.UUID,
    body: ContainerUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "change"),
) -> ContainerItem:
    container = await _get_container(db, container_id)
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    await _check_refs(db, data)
    if "rfid_tag" in data:
        await _check_rfid(db, data["rfid_tag"], exclude=container_id)

    fields = list(data.keys())
    before = snapshot(container, fields)
    for field, value in data.items():
        setattr(container, field, value)
    changes = diff(before, snapshot(container, fields))
    if changes:
        container.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="container",
              entity_id=str(container_id), action="update", changes=changes)
    await db.commit()
    return await _detail(db, container)


@router.post("/{container_id}/archive", status_code=204)
async def archive_container(
    container_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "change"),
) -> None:
    container = await _get_container(db, container_id)
    container.archived_at = datetime.now(UTC)
    container.updated_at = container.archived_at
    audit(db, actor_id=actor.person.id, entity_type="container",
          entity_id=str(container_id), action="archive")
    await db.commit()


@router.post("/{container_id}/unarchive", status_code=204)
async def unarchive_container(
    container_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "change"),
) -> None:
    container = await _get_container(db, container_id)
    container.archived_at = None
    container.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="container",
          entity_id=str(container_id), action="restore")
    await db.commit()
```

- [ ] **Step 5: Register the router**

In `api/src/serversherpa/api/app.py`: add `containers` to the existing `from serversherpa.api.routes import (...)` block, and after `app.include_router(assets.router)` add:

```python
    app.include_router(containers.router)
```

- [ ] **Step 6: Run the tests**

Run: `cd api && python -m pytest tests/test_containers_api.py -x -q`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/containers.py api/src/serversherpa/api/app.py api/tests/test_containers_api.py
git commit -m "feat(api): containers CRUD routes with vocab labels + audit"
```

---

### Task 3: Asset membership endpoints

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (append after `ContainerUpdateIn`)
- Modify: `api/src/serversherpa/api/routes/containers.py` (append endpoints)
- Test: `api/tests/test_container_assets_api.py`

**Interfaces:**
- Consumes: `_get_container`, `_err`, `router` from Task 2; `ContainerAsset`, `Asset`, `AssetModel` ORM.
- Produces: `ContainerAssetRow` schema (`asset_id, serial_number, name, model_name, status, status_label, status_color, added_at, added_by_name`); `ContainerAssetsAddIn` (`asset_ids: list[uuid.UUID]`); endpoints `GET/POST /containers/{id}/assets`, `DELETE /containers/{id}/assets/{asset_id}`. 409 shape: `{"code": "assets_in_containers", "conflicts": [{"asset_id", "container_id", "container_name"}]}`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_container_assets_api.py
"""Container membership — add/list/remove, the all-or-nothing 409."""

from serversherpa.db.models import Asset

from .test_assets_api import login


async def _mk_container(client, hdrs, name):
    resp = await client.post("/containers", headers=hdrs, json={"name": name})
    assert resp.status_code == 201
    return resp.json()["id"]


async def test_add_list_remove(client, db, seeded_user):
    hdrs = await login(client)
    cid = await _mk_container(client, hdrs, "C1")
    a1, a2 = Asset(serial_number="SN-1"), Asset(serial_number="SN-2")
    db.add_all([a1, a2])
    await db.commit()

    resp = await client.post(f"/containers/{cid}/assets", headers=hdrs,
                             json={"asset_ids": [str(a1.id), str(a2.id)]})
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert {r["serial_number"] for r in rows} == {"SN-1", "SN-2"}
    assert all(r["added_by_name"] for r in rows)

    resp = await client.get(f"/containers/{cid}", headers=hdrs)
    assert resp.json()["asset_count"] == 2

    resp = await client.delete(f"/containers/{cid}/assets/{a1.id}",
                               headers=hdrs)
    assert resp.status_code == 204
    resp = await client.get(f"/containers/{cid}/assets", headers=hdrs)
    assert [r["serial_number"] for r in resp.json()] == ["SN-2"]


async def test_conflict_is_all_or_nothing(client, db, seeded_user):
    hdrs = await login(client)
    c1 = await _mk_container(client, hdrs, "Taken")
    c2 = await _mk_container(client, hdrs, "Target")
    a1, a2 = Asset(serial_number="F-1"), Asset(serial_number="F-2")
    db.add_all([a1, a2])
    await db.commit()
    await client.post(f"/containers/{c1}/assets", headers=hdrs,
                      json={"asset_ids": [str(a1.id)]})

    resp = await client.post(f"/containers/{c2}/assets", headers=hdrs,
                             json={"asset_ids": [str(a1.id), str(a2.id)]})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "assets_in_containers"
    assert detail["conflicts"] == [{
        "asset_id": str(a1.id), "container_id": c1, "container_name": "Taken",
    }]
    # a2 must NOT have been added
    resp = await client.get(f"/containers/{c2}/assets", headers=hdrs)
    assert resp.json() == []


async def test_add_unknown_asset_422(client, db, seeded_user):
    hdrs = await login(client)
    cid = await _mk_container(client, hdrs, "C")
    resp = await client.post(
        f"/containers/{cid}/assets", headers=hdrs,
        json={"asset_ids": ["00000000-0000-0000-0000-000000000000"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "asset_not_found"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && python -m pytest tests/test_container_assets_api.py -x -q`
Expected: FAIL — 404/405 (endpoints missing).

- [ ] **Step 3: Add the schemas**

Append to `api/src/serversherpa/api/schemas.py`:

```python
class ContainerAssetRow(BaseModel):
    asset_id: uuid.UUID
    serial_number: str | None = None
    name: str | None = None
    model_name: str | None = None
    status: str
    status_label: str
    status_color: str
    added_at: datetime
    added_by_name: str | None = None


class ContainerAssetsAddIn(BaseModel):
    asset_ids: list[uuid.UUID]
    model_config = ConfigDict(extra="forbid")
```

- [ ] **Step 4: Add the endpoints**

Append to `api/src/serversherpa/api/routes/containers.py`. Extend the module's imports: add `Asset, AssetModel, Person` to the `serversherpa.db.models` import and `ContainerAssetRow, ContainerAssetsAddIn` to the schemas import.

```python
async def _asset_rows(db: DbSession,
                      container_id: uuid.UUID) -> list[ContainerAssetRow]:
    rows = (await db.execute(
        select(ContainerAsset, Asset)
        .join(Asset, Asset.id == ContainerAsset.asset_id)
        .where(ContainerAsset.container_id == container_id)
        .order_by(ContainerAsset.added_at))).all()
    statuses = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))}
    model_ids = {a.model_id for _, a in rows if a.model_id}
    models = dict((await db.execute(
        select(AssetModel.id, AssetModel.make + " " + AssetModel.model)
        .where(AssetModel.id.in_(model_ids)))).all()) if model_ids else {}
    person_ids = {m.added_by for m, _ in rows if m.added_by}
    people = dict((await db.execute(
        select(Person.id, Person.first_name + " " + Person.last_name)
        .where(Person.id.in_(person_ids)))).all()) if person_ids else {}
    out = []
    for membership, asset in rows:
        label, color = statuses.get(asset.status, (asset.status, "#51606f"))
        out.append(ContainerAssetRow(
            asset_id=asset.id, serial_number=asset.serial_number,
            name=asset.name, model_name=models.get(asset.model_id),
            status=asset.status, status_label=label, status_color=color,
            added_at=membership.added_at,
            added_by_name=people.get(membership.added_by)))
    return out


@router.get("/{container_id}/assets", response_model=list[ContainerAssetRow])
async def list_container_assets(
    container_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "view"),
) -> list[ContainerAssetRow]:
    await _get_container(db, container_id)
    return await _asset_rows(db, container_id)


@router.post("/{container_id}/assets", response_model=list[ContainerAssetRow])
async def add_container_assets(
    container_id: uuid.UUID,
    body: ContainerAssetsAddIn,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "change"),
) -> list[ContainerAssetRow]:
    container = await _get_container(db, container_id)
    ids = list(dict.fromkeys(body.asset_ids))  # dedupe, keep order
    if not ids:
        raise _err(422, "asset_ids_required")
    found = set(await db.scalars(select(Asset.id).where(Asset.id.in_(ids))))
    if missing := [i for i in ids if i not in found]:
        raise _err(422, "asset_not_found", asset_ids=[str(i) for i in missing])

    taken = (await db.execute(
        select(ContainerAsset.asset_id, Container.id, Container.name)
        .join(Container, Container.id == ContainerAsset.container_id)
        .where(ContainerAsset.asset_id.in_(ids)))).all()
    if conflicts := [
        {"asset_id": str(aid), "container_id": str(cid), "container_name": name}
        for aid, cid, name in taken if cid != container_id
    ]:
        raise _err(409, "assets_in_containers", conflicts=conflicts)

    already = {aid for aid, cid, _ in taken if cid == container_id}
    added = [i for i in ids if i not in already]
    for asset_id in added:
        db.add(ContainerAsset(container_id=container_id, asset_id=asset_id,
                              added_by=actor.person.id))
    if added:
        container.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="container",
              entity_id=str(container_id), action="assets_add",
              changes={"asset_ids": {
                  "from": None, "to": [str(i) for i in added]}})
    await db.commit()
    return await _asset_rows(db, container_id)


@router.delete("/{container_id}/assets/{asset_id}", status_code=204)
async def remove_container_asset(
    container_id: uuid.UUID,
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "change"),
) -> None:
    container = await _get_container(db, container_id)
    membership = await db.scalar(select(ContainerAsset).where(
        ContainerAsset.container_id == container_id,
        ContainerAsset.asset_id == asset_id))
    if membership is None:
        raise _err(404, "membership_not_found")
    await db.delete(membership)
    container.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="container",
          entity_id=str(container_id), action="assets_remove",
          changes={"asset_ids": {"from": [str(asset_id)], "to": None}})
    await db.commit()
```

- [ ] **Step 5: Run the tests**

Run: `cd api && python -m pytest tests/test_container_assets_api.py tests/test_containers_api.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/containers.py api/tests/test_container_assets_api.py
git commit -m "feat(api): container asset membership — add/list/remove, all-or-nothing 409"
```

---

### Task 4: Global search

**Files:**
- Modify: `api/src/serversherpa/api/routes/search.py` (add a containers block after the assets block, ~line 108)
- Test: `api/tests/test_search_containers.py`

**Interfaces:**
- Consumes: the existing `SearchResult` shape used in `search.py` (`kind`, `id`, `title`, `subtitle`) and its `q`/limit idioms — read the assets block at `search.py:90-108` and copy its structure exactly.
- Produces: search results with `kind="container"` matching on `name` / `rfid_tag`.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_search_containers.py
"""Global search — containers by name and RFID, permission-gated."""

from serversherpa.db.models import Container, Person, PersonRole

from .test_assets_api import login, make_login


async def test_search_finds_containers(client, db, seeded_user):
    hdrs = await login(client)
    db.add_all([Container(name="Crate Alpha", rfid_tag="CRF-77"),
                Container(name="Unrelated")])
    await db.commit()

    resp = await client.get("/search?q=alpha", headers=hdrs)
    hits = [h for h in resp.json() if h["kind"] == "container"]
    assert [h["title"] for h in hits] == ["Crate Alpha"]

    resp = await client.get("/search?q=CRF-77", headers=hdrs)
    assert any(h["kind"] == "container" for h in resp.json())


async def test_search_respects_permission(client, db, seeded_user):
    db.add(Container(name="Hidden Crate"))
    nobody = Person(first_name="No", last_name="Body")
    db.add(nobody)
    await db.flush()
    db.add(PersonRole(person_id=nobody.id, role="client_viewer"))
    await db.commit()
    hdrs = await make_login(db, client, nobody, "seeker@test.example.com")
    resp = await client.get("/search?q=crate", headers=hdrs)
    assert not any(h["kind"] == "container" for h in resp.json())
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && python -m pytest tests/test_search_containers.py -x -q`
Expected: FAIL — no `container` hits.

- [ ] **Step 3: Add the search block**

In `api/src/serversherpa/api/routes/search.py`, import `Container` from `serversherpa.db.models`, then add after the assets block, following its exact structure (same limit constant, same `ilike` pattern, same `SearchResult` construction — adjust only if the real block differs from this sketch):

```python
    # containers — name / rfid; internal-only resource, no row scoping
    if user.access.can("containers", "view"):
        containers = (await db.scalars(
            select(Container)
            .where(Container.name.ilike(pattern)
                   | Container.rfid_tag.ilike(pattern))
            .limit(limit))).all()
        results += [
            SearchResult(kind="container", id=c.id, title=c.name,
                         subtitle=c.rfid_tag or "Container")
            for c in containers
        ]
```

- [ ] **Step 4: Run the tests**

Run: `cd api && python -m pytest tests/test_search_containers.py tests/test_search_api.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/search.py api/tests/test_search_containers.py
git commit -m "feat(api): containers in global search"
```

---

### Task 5: Bulk import (service + routes)

**Files:**
- Create: `api/src/serversherpa/logistics/__init__.py` (empty)
- Create: `api/src/serversherpa/logistics/bulk_import.py`
- Modify: `api/src/serversherpa/api/routes/containers.py` (template/preview/commit endpoints)
- Test: `api/tests/test_containers_bulk_import.py`

**Interfaces:**
- Consumes: `sites/bulk_import.py` is the pattern source — reuse its `parse_upload`, `number_json_rows`, `BulkImportError`, and `_cell` by IMPORTING them (`from serversherpa.sites.bulk_import import BulkImportError, number_json_rows, parse_upload`); those helpers are content-agnostic except `_check_columns`, which is sites-specific — this module has its own column check.
- Produces: `TEMPLATE_COLUMNS = ["name", "container_type", "rfid_tag", "site_name", "location_detail", "status"]`; `preview_rows(db, numbered) -> list[dict]` where each dict is `{"row": int, "action": "create"|"error", "data": dict, "errors": list[str]}`; `commit_rows(db, actor_person_id, numbered) -> {"created": int}`; endpoints `GET /containers/bulk-import/template?fmt=csv|xlsx`, `POST /containers/bulk-import/preview`, `POST /containers/bulk-import/commit`. Create-only: a row whose `name` matches an existing container errors with `duplicate_name`.

- [ ] **Step 1: Write the failing service tests**

```python
# api/tests/test_containers_bulk_import.py
"""Container bulk import — resolution, per-row errors, create-only commit."""

from sqlalchemy import select

from serversherpa.db.models import Container, Site
from serversherpa.logistics import bulk_import as bulk

from .test_assets_api import login


def _rows(*dicts):
    return [(i + 2, d) for i, d in enumerate(dicts)]  # header = row 1


async def test_preview_resolves_and_errors(db, seeded_user):
    db.add(Site(name="DC-East"))
    db.add(Container(name="Existing"))
    await db.commit()

    results = await bulk.preview_rows(db, _rows(
        {"name": "New Crate", "container_type": "Pelican case",
         "site_name": "dc-east", "status": "available"},
        {"name": "", "container_type": "cart"},
        {"name": "Bad Refs", "container_type": "hovercraft",
         "site_name": "Atlantis", "status": "nope"},
        {"name": "Existing"},
    ))
    assert [r["action"] for r in results] == [
        "create", "error", "error", "error"]
    assert results[0]["data"]["container_type"] == "pelican_case"
    assert results[0]["data"]["site_name"] == "DC-East"
    assert results[1]["errors"] == ["name_required"]
    assert set(results[2]["errors"]) == {
        "unknown_container_type", "unknown_site", "unknown_status"}
    assert results[3]["errors"] == ["duplicate_name"]


async def test_commit_creates_only_valid_rows(db, seeded_user, client):
    hdrs = await login(client)
    db.add(Site(name="DC-West"))
    await db.commit()

    resp = await client.post("/containers/bulk-import/commit", headers=hdrs,
                             json={"rows": [
                                 {"name": "Bulk-1", "site_name": "DC-West"},
                                 {"name": "Bulk-2", "status": "packed"},
                             ]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["created"] == 2
    names = {c.name for c in await db.scalars(select(Container))}
    assert {"Bulk-1", "Bulk-2"} <= names


async def test_commit_rejects_invalid_rows(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk-import/commit", headers=hdrs,
                             json={"rows": [{"name": "OK"},
                                            {"name": "", "status": "nope"}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "rows_invalid"


async def test_template_endpoint(client, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/containers/bulk-import/template?fmt=csv",
                            headers=hdrs)
    assert resp.status_code == 200
    assert resp.text.splitlines()[0] == \
        "name,container_type,rfid_tag,site_name,location_detail,status"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && python -m pytest tests/test_containers_bulk_import.py -x -q`
Expected: FAIL — `ModuleNotFoundError: serversherpa.logistics`.

- [ ] **Step 3: Write the service**

```python
# api/src/serversherpa/logistics/bulk_import.py
"""Container bulk import — create-only. Mirrors sites/bulk_import.py's
preview/commit split and reuses its file parsing; resolution is
case-insensitive against site names and the container/container_type
vocabularies (label OR key). Unresolvable values are per-row errors,
never silent drops — no hidden defaults (the V2 bug this replaces)."""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Container, Site, StatusValue
from serversherpa.services.audit import audit
from serversherpa.sites.bulk_import import (  # content-agnostic helpers
    BulkImportError, number_json_rows, parse_upload,
)

TEMPLATE_COLUMNS = [
    "name", "container_type", "rfid_tag", "site_name",
    "location_detail", "status",
]
MAX_ROWS = 1000


def check_columns(keys: list[str]) -> None:
    if unknown := [k for k in keys if k not in TEMPLATE_COLUMNS]:
        raise BulkImportError("unknown_columns", columns=unknown)


def build_template_csv() -> str:
    return ",".join(TEMPLATE_COLUMNS) + "\n"


async def _reference_data(db: AsyncSession) -> dict:
    sites = {s.name.lower(): s for s in await db.scalars(select(Site))}
    vocab_rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(("container", "container_type"))))).all()
    def vocab(record_type: str) -> dict:
        out = {}
        for v in vocab_rows:
            if v.record_type == record_type:
                out[v.key.lower()] = v.key
                out[v.label.lower()] = v.key
        return out
    names = {n.lower() for n in await db.scalars(select(Container.name))}
    return {"sites": sites, "statuses": vocab("container"),
            "types": vocab("container_type"), "names": names}


def _resolve(row: dict, refs: dict) -> tuple[dict, list[str]]:
    """One row → (normalized data, error codes). data keeps site_name as
    the resolved display name; site_id rides along for commit."""
    errors: list[str] = []
    data: dict[str, Any] = {}
    name = str(row.get("name", "")).strip()
    if not name:
        errors.append("name_required")
    elif name.lower() in refs["names"]:
        errors.append("duplicate_name")
    data["name"] = name

    if raw := str(row.get("container_type", "")).strip():
        if key := refs["types"].get(raw.lower()):
            data["container_type"] = key
        else:
            errors.append("unknown_container_type")
    if raw := str(row.get("status", "")).strip():
        if key := refs["statuses"].get(raw.lower()):
            data["status"] = key
        else:
            errors.append("unknown_status")
    if raw := str(row.get("site_name", "")).strip():
        if site := refs["sites"].get(raw.lower()):
            data["site_id"] = site.id
            data["site_name"] = site.name
        else:
            errors.append("unknown_site")
    if raw := str(row.get("rfid_tag", "")).strip():
        data["rfid_tag"] = raw
    if raw := str(row.get("location_detail", "")).strip():
        data["location_detail"] = raw
    return data, errors


async def preview_rows(db: AsyncSession,
                       numbered: list[tuple[int, dict]]) -> list[dict]:
    if len(numbered) > MAX_ROWS:
        raise BulkImportError("too_many_rows")
    if numbered:
        check_columns(list(numbered[0][1].keys()))
    refs = await _reference_data(db)
    results = []
    seen: set[str] = set()
    for row_no, row in numbered:
        data, errors = _resolve(row, refs)
        key = data["name"].lower()
        if key and key in seen:
            errors.append("duplicate_name")
        seen.add(key)
        results.append({
            "row": row_no,
            "action": "error" if errors else "create",
            "data": {k: v for k, v in data.items() if k != "site_id"},
            "errors": errors,
        })
    return results


async def commit_rows(db: AsyncSession, actor_person_id: uuid.UUID,
                      numbered: list[tuple[int, dict]]) -> dict:
    if len(numbered) > MAX_ROWS:
        raise BulkImportError("too_many_rows")
    if numbered:
        check_columns(list(numbered[0][1].keys()))
    refs = await _reference_data(db)
    resolved = []
    seen: set[str] = set()
    for row_no, row in numbered:
        data, errors = _resolve(row, refs)
        key = data["name"].lower()
        if key and key in seen:
            errors.append("duplicate_name")
        seen.add(key)
        if errors:
            raise BulkImportError("rows_invalid")
        resolved.append(data)
    created = 0
    for data in resolved:
        container = Container(
            name=data["name"],
            container_type=data.get("container_type"),
            rfid_tag=data.get("rfid_tag"),
            site_id=data.get("site_id"),
            location_detail=data.get("location_detail", ""),
            status=data.get("status", "available"),
            source="bulk_import", created_by=actor_person_id)
        db.add(container)
        await db.flush()
        audit(db, actor_id=actor_person_id, entity_type="container",
              entity_id=str(container.id), action="create",
              changes={"name": {"from": None, "to": container.name}})
        created += 1
    await db.commit()
    return {"created": created}
```

If `parse_upload` / `number_json_rows` in `sites/bulk_import.py` turn out to be entangled with sites-specific column checks (read them first), copy the minimal parsing bodies here instead of importing — do NOT modify the sites module.

- [ ] **Step 4: Add the endpoints**

Append to `api/src/serversherpa/api/routes/containers.py` (imports: `from fastapi import Response`, `from pydantic import BaseModel as _BM` is NOT needed — reuse the sites route idioms; read `sites.py:130-215` for the exact request shapes and mirror them):

```python
from serversherpa.logistics import bulk_import as bulk


def _bulk_err(exc: bulk.BulkImportError) -> HTTPException:
    return HTTPException(status_code=422, detail=exc.detail)


@router.get("/bulk-import/template")
async def bulk_import_template(
    db: DbSession,
    fmt: str = "csv",
    actor: AuthContext = require_permission("containers", "add"),
):
    if fmt == "csv":
        return Response(content=bulk.build_template_csv(), media_type="text/csv",
                        headers={"Content-Disposition":
                                 'attachment; filename="containers-template.csv"'})
    raise _err(422, "unsupported_format")


@router.post("/bulk-import/preview")
async def bulk_import_preview(
    body: dict,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "add"),
):
    try:
        numbered = bulk.number_json_rows(body.get("rows"))
        return {"rows": await bulk.preview_rows(db, numbered)}
    except bulk.BulkImportError as exc:
        raise _bulk_err(exc) from exc


@router.post("/bulk-import/commit")
async def bulk_import_commit(
    body: dict,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "add"),
):
    try:
        numbered = bulk.number_json_rows(body.get("rows"))
        return await bulk.commit_rows(db, actor.person.id, numbered)
    except bulk.BulkImportError as exc:
        raise _bulk_err(exc) from exc
```

IMPORTANT: these three routes use fixed path segments under `/containers/` — they MUST be declared BEFORE `get_container`'s `/{container_id}` route in the file, or FastAPI will try to parse "bulk-import" as a UUID. Move them above `get_container` (order within the module is what matters). Check how `sites.py` handles `BulkImportError.detail` (the exception's constructor packs `code` + extras) and mirror the exact attribute name.

- [ ] **Step 5: Run the tests**

Run: `cd api && python -m pytest tests/test_containers_bulk_import.py tests/test_containers_api.py -q`
Expected: all PASS (the second file catches the route-ordering mistake).

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/logistics/ api/src/serversherpa/api/routes/containers.py api/tests/test_containers_bulk_import.py
git commit -m "feat(api): container bulk import — preview/commit, create-only"
```

---

### Task 6: Portal API client + containers lib

**Files:**
- Modify: `portal/src/lib/api.ts` (append after the asset client block, ~line 1140)
- Create: `portal/src/lib/containers.ts`
- Test: `portal/src/lib/containers.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `errorFrom`, `ApiError`, `StatusValue`, `SiteItem` already in `api.ts`; `GodField`, `ComboOption` types.
- Produces: `ContainerItem`, `ContainerAssetRow` TS interfaces; API functions `listContainers`, `createContainer`, `updateContainer`, `archiveContainer`, `listContainerStatuses`, `listContainerTypes`, `listContainerAssets`, `addContainerAssets`, `removeContainerAsset`, `previewContainerBulk`, `commitContainerBulk`, `downloadContainerTemplate`; lib helpers `containerSearchText`, `containerCellText`, `CONTAINER_ERRORS`, `ContainerFormState`, `formFromContainer`, `containerPayload`, `CONTAINER_GOD_FIELDS`.

- [ ] **Step 1: Write the failing lib tests**

```typescript
// portal/src/lib/containers.test.ts
import { describe, expect, it } from 'vitest';

import type { ContainerItem } from './api';
import {
  containerCellText, containerPayload, containerSearchText, formFromContainer,
} from './containers';

const row: ContainerItem = {
  id: 'c1', name: 'Crate A', rfid_tag: 'RF-9',
  container_type: 'cart', type_label: 'Cart', type_color: '#0f7c86',
  status: 'available', status_label: 'Available', status_color: '#178a4c',
  site_id: 's1', site_name: 'DC-East', location_detail: 'Dock 3',
  asset_count: 4, last_audit_at: null, last_validated_at: null,
  archived_at: null, created_at: '2026-08-06T00:00:00Z',
};

describe('containerSearchText', () => {
  it('joins the searchable fields lowercased', () => {
    const t = containerSearchText(row);
    expect(t).toContain('crate a');
    expect(t).toContain('rf-9');
    expect(t).toContain('dc-east');
    expect(t).toContain('cart');
  });
});

describe('containerCellText', () => {
  it('mirrors cell rendering including dashes', () => {
    expect(containerCellText(row, 'primary')).toBe('Crate A');
    expect(containerCellText(row, 'type')).toBe('Cart');
    expect(containerCellText(row, 'status')).toBe('Available');
    expect(containerCellText(row, 'site')).toBe('DC-East');
    expect(containerCellText(row, 'assets')).toBe('4');
    expect(containerCellText({ ...row, rfid_tag: null }, 'rfid')).toBe('—');
    expect(containerCellText(row, 'archived')).toBe('No');
  });
});

describe('form round-trip', () => {
  it('builds a payload with nulls for cleared fields', () => {
    const form = formFromContainer(row);
    form.rfid_tag = '  ';
    form.site_id = '';
    const p = containerPayload(form);
    expect(p.name).toBe('Crate A');
    expect(p.rfid_tag).toBeNull();
    expect(p.site_id).toBeNull();
    expect(p.status).toBe('available');
  });
  it('create mode starts with defaults', () => {
    const form = formFromContainer(null);
    expect(form.status).toBe('available');
    expect(form.name).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd portal && npx vitest run src/lib/containers.test.ts`
Expected: FAIL — module `./containers` not found.

- [ ] **Step 3: Add the API client block**

Append to `portal/src/lib/api.ts` after the asset functions:

```typescript
export interface ContainerItem {
  id: string; name: string; rfid_tag: string | null;
  container_type: string | null; type_label: string | null;
  type_color: string | null;
  status: string; status_label: string; status_color: string;
  site_id: string | null; site_name: string | null;
  location_detail: string; asset_count: number;
  last_audit_at: string | null; last_validated_at: string | null;
  archived_at: string | null; created_at: string;
}

export interface ContainerAssetRow {
  asset_id: string; serial_number: string | null; name: string | null;
  model_name: string | null;
  status: string; status_label: string; status_color: string;
  added_at: string; added_by_name: string | null;
}

export async function listContainers(): Promise<ContainerItem[]> {
  const resp = await apiFetch('/containers');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createContainer(
  body: Record<string, unknown>,
): Promise<ContainerItem> {
  const resp = await apiFetch('/containers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateContainer(
  id: string, body: Record<string, unknown>,
): Promise<ContainerItem> {
  const resp = await apiFetch(`/containers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function archiveContainer(
  id: string, archived: boolean,
): Promise<void> {
  const resp = await apiFetch(
    `/containers/${id}/${archived ? 'archive' : 'unarchive'}`,
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function listContainerStatuses(): Promise<StatusValue[]> {
  const resp = await apiFetch('/status-values?record_type=container');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listContainerTypes(): Promise<StatusValue[]> {
  const resp = await apiFetch('/status-values?record_type=container_type');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listContainerAssets(
  id: string,
): Promise<ContainerAssetRow[]> {
  const resp = await apiFetch(`/containers/${id}/assets`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function addContainerAssets(
  id: string, assetIds: string[],
): Promise<ContainerAssetRow[]> {
  const resp = await apiFetch(`/containers/${id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset_ids: assetIds }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function removeContainerAsset(
  id: string, assetId: string,
): Promise<void> {
  const resp = await apiFetch(`/containers/${id}/assets/${assetId}`,
    { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export interface ContainerBulkRow {
  row: number; action: 'create' | 'error';
  data: Record<string, unknown>; errors: string[];
}

export async function previewContainerBulk(
  rows: Record<string, unknown>[],
): Promise<{ rows: ContainerBulkRow[] }> {
  const resp = await apiFetch('/containers/bulk-import/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function commitContainerBulk(
  rows: Record<string, unknown>[],
): Promise<{ created: number }> {
  const resp = await apiFetch('/containers/bulk-import/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function downloadContainerTemplate(): Promise<Blob> {
  const resp = await apiFetch('/containers/bulk-import/template?fmt=csv');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.blob();
}
```

- [ ] **Step 4: Write the containers lib**

```typescript
// portal/src/lib/containers.ts
/**
 * Containers page logic — pure functions the components delegate to
 * (the lib/assets.ts pattern), unit-testable without jsdom.
 */
import type { ComboOption } from '../components/ComboBox';
import type { ContainerItem } from './api';
import type { GodField } from './godEdit';

export function containerSearchText(c: ContainerItem): string {
  return [c.name, c.rfid_tag, c.type_label, c.status_label,
          c.site_name, c.location_detail]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor — one row's display text per column key, mirroring
 *  the page's cell renderer exactly (including '—' fallbacks). 'primary'
 *  is the always-shown name cell; 'archived' is the chevron pseudo-column. */
export function containerCellText(c: ContainerItem, colKey: string): string {
  switch (colKey) {
    case 'primary': return c.name;
    case 'type': return c.type_label ?? '';
    case 'rfid': return c.rfid_tag ?? '—';
    case 'assets': return String(c.asset_count);
    case 'status': return c.status_label;
    case 'site': return c.site_name ?? '';
    case 'location': return c.location_detail || '—';
    case 'updated': return c.created_at ? new Date(c.created_at).toLocaleDateString() : '—';
    case 'archived': return c.archived_at ? 'Yes' : 'No';
    default: return '';
  }
}

export const CONTAINER_ERRORS: Record<string, string> = {
  rfid_tag_in_use: 'That RFID tag is already on another container.',
  site_not_found: 'Pick a site from the list.',
  unknown_status: 'Pick a status from the list.',
  unknown_container_type: 'Pick a container type from the list.',
  name_required: 'Name is required.',
  location_detail_required: 'Location cannot be null.',
  status_required: 'Status is required.',
  asset_not_found: 'One of those assets no longer exists.',
  assets_in_containers: 'Some assets are already in another container.',
  membership_not_found: 'That asset is not in this container.',
  forbidden: 'You do not have permission to change containers.',
};

/* ── edit/create form ────────────────────────────────────────────── */

export interface ContainerFormState {
  name: string; rfid_tag: string; container_type: string;
  status: string; site_id: string; location_detail: string;
}

export function formFromContainer(c: ContainerItem | null): ContainerFormState {
  return {
    name: c?.name ?? '',
    rfid_tag: c?.rfid_tag ?? '',
    container_type: c?.container_type ?? '',
    status: c?.status ?? 'available',
    site_id: c?.site_id ?? '',
    location_detail: c?.location_detail ?? '',
  };
}

/** Payload for create AND patch — nulls stay in: PATCH needs them to
 *  clear fields, POST drops them server-side (exclude_none). */
export function containerPayload(
  form: ContainerFormState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, raw: string) => {
    const v = raw.trim();
    out[key] = v || null;
  };
  out.name = form.name.trim();
  put('rfid_tag', form.rfid_tag);
  put('container_type', form.container_type);
  put('site_id', form.site_id);
  out.location_detail = form.location_detail.trim();
  out.status = form.status;
  return out;
}

/* ── god-edit descriptors (lib/assets.ts factory pattern) ────────── */

export interface ContainerGodLookups {
  sites: () => ComboOption[];
  statuses: () => ComboOption[];
  types: () => ComboOption[];
}

export function CONTAINER_GOD_FIELDS(
  lookups: ContainerGodLookups,
): GodField<ContainerItem>[] {
  return [
    { column: 'primary', field: 'name', kind: 'text',
      fromRow: (c) => c.name },
    { column: 'rfid', field: 'rfid_tag', kind: 'text',
      fromRow: (c) => c.rfid_tag ?? '' },
    { column: 'location', field: 'location_detail', kind: 'text',
      fromRow: (c) => c.location_detail },
    { column: 'type', field: 'container_type', kind: 'combo',
      fromRow: (c) => c.container_type ?? '', options: lookups.types },
    { column: 'site', field: 'site_id', kind: 'combo',
      fromRow: (c) => c.site_id ?? '', options: lookups.sites },
    { column: 'status', field: 'status', kind: 'combo',
      fromRow: (c) => c.status, options: lookups.statuses },
  ];
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd portal && npx vitest run src/lib/containers.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/containers.ts portal/src/lib/containers.test.ts
git commit -m "feat(portal): containers API client + page logic lib"
```

---

### Task 7: ContainerEditModal

**Files:**
- Create: `portal/src/components/containers/ContainerEditModal.tsx`

**Interfaces:**
- Consumes: everything from Task 6; `ComboBox` (`portal/src/components/ComboBox.tsx`); `listAssets`, `AssetItem` from `api.ts`.
- Produces: `<ContainerEditModal container statuses types sites canChange onClose onSaved />` — `container === null` is create mode. Contents (membership) management lives HERE per the house rule (expansions read-only): an edit-mode-only "Contents" section with a multi-add ComboBox and per-row remove. Membership changes call the API immediately (they are their own aggregate operations, not part of the form save).

- [ ] **Step 1: Write the component**

```tsx
// portal/src/components/containers/ContainerEditModal.tsx
/**
 * ContainerEditModal — the only place a container is mutated: field
 * edits, archive/unarchive, and contents (asset membership). `container
 * === null` opens in create mode (contents section hidden — membership
 * needs an id). Membership add/remove hits the API immediately; field
 * edits save on submit. Follows AssetEditModal's modal conventions.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  addContainerAssets,
  ApiError,
  archiveContainer,
  createContainer,
  listAssets,
  listContainerAssets,
  removeContainerAsset,
  updateContainer,
  type AssetItem,
  type ContainerAssetRow,
  type ContainerItem,
  type SiteItem,
  type StatusValue,
} from '../../lib/api';
import {
  CONTAINER_ERRORS, containerPayload, formFromContainer,
  type ContainerFormState,
} from '../../lib/containers';
import ComboBox from '../ComboBox';

interface Props {
  container: ContainerItem | null;   // null = create mode
  statuses: StatusValue[];
  types: StatusValue[];
  sites: SiteItem[];
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

function mapError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'assets_in_containers') {
      const conflicts = (err.detail as {
        conflicts?: { container_name: string }[];
      })?.conflicts ?? [];
      const names = [...new Set(conflicts.map((c) => c.container_name))];
      return names.length
        ? `Already in another container: ${names.join(', ')} — remove there first.`
        : CONTAINER_ERRORS.assets_in_containers;
    }
    return CONTAINER_ERRORS[err.code] ?? fallback;
  }
  return 'Network error.';
}

export default function ContainerEditModal({
  container, statuses, types, sites, canChange, onClose, onSaved,
}: Props) {
  const isCreateMode = container === null;
  const [form, setForm] = useState<ContainerFormState>(
    () => formFromContainer(container));
  const [archived, setArchived] = useState<boolean>(!!container?.archived_at);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // contents (edit mode only)
  const [contents, setContents] = useState<ContainerAssetRow[] | null>(null);
  const [allAssets, setAllAssets] = useState<AssetItem[] | null>(null);
  const [pendingAdd, setPendingAdd] = useState('');
  const [contentsError, setContentsError] = useState('');
  const [busyContents, setBusyContents] = useState(false);

  const locked = saving || (!isCreateMode && !canChange);

  useEffect(() => {
    if (isCreateMode || !container) return;
    void listContainerAssets(container.id).then(setContents).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAssets = () => {
    if (allAssets !== null) return;
    void listAssets().then(setAllAssets).catch(() => {});
  };

  const inContainer = useMemo(
    () => new Set((contents ?? []).map((r) => r.asset_id)), [contents]);
  const assetOptions = useMemo(() => (allAssets ?? [])
    .filter((a) => !a.archived_at && !inContainer.has(a.id))
    .map((a) => ({
      value: a.id,
      label: a.serial_number ?? a.name ?? a.id,
      sub: a.name ?? undefined,
    })), [allAssets, inContainer]);

  const setField = (key: keyof ContainerFormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const statusOptions = useMemo(() => {
    const list = container && !statuses.some((s) => s.key === container.status)
      ? [...statuses, { key: container.status, label: container.status_label } as StatusValue]
      : statuses;
    return list.map((s) => ({ value: s.key, label: s.label }));
  }, [statuses, container]);

  const typeOptions = useMemo(() => {
    const list = container?.container_type
      && !types.some((t) => t.key === container.container_type)
      ? [...types, { key: container.container_type,
                     label: container.type_label ?? container.container_type } as StatusValue]
      : types;
    return list.map((t) => ({ value: t.key, label: t.label }));
  }, [types, container]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = containerPayload(form);
      if (isCreateMode) {
        await createContainer(payload);
      } else {
        await updateContainer(container.id, payload);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async () => {
    if (!container) return;
    setSaving(true);
    setError('');
    try {
      await archiveContainer(container.id, !archived);
      setArchived((v) => !v);
      await onSaved();
    } catch (err) {
      setError(mapError(err, 'Could not change the archive state — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const addAsset = async (assetId: string) => {
    if (!container || !assetId) return;
    setBusyContents(true);
    setContentsError('');
    try {
      setContents(await addContainerAssets(container.id, [assetId]));
      setPendingAdd('');
      await onSaved();   // asset_count changed
    } catch (err) {
      setContentsError(mapError(err, 'Could not add that asset — try again.'));
    } finally {
      setBusyContents(false);
    }
  };

  const removeAsset = async (assetId: string) => {
    if (!container) return;
    setBusyContents(true);
    setContentsError('');
    try {
      await removeContainerAsset(container.id, assetId);
      setContents((rows) => rows?.filter((r) => r.asset_id !== assetId) ?? rows);
      await onSaved();
    } catch (err) {
      setContentsError(mapError(err, 'Could not remove that asset — try again.'));
    } finally {
      setBusyContents(false);
    }
  };

  const title = container ? `Edit — ${form.name || 'Container'}` : 'New container';

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="modal-section">Identity</div>
            <div className="pf-form">
              <div><label>Name</label>
                <input value={form.name} disabled={locked} required
                       onChange={(e) => setField('name', e.target.value)} /></div>
              <div><label>RFID tag</label>
                <input value={form.rfid_tag} disabled={locked}
                       onChange={(e) => setField('rfid_tag', e.target.value)} /></div>
              <div><label>Location detail</label>
                <input value={form.location_detail} disabled={locked}
                       onChange={(e) => setField('location_detail', e.target.value)} /></div>
            </div>

            <div className="modal-section">Classification</div>
            <div className="pf-form">
              <div><label>Type</label>
                <ComboBox
                  placeholder="Type to search types…"
                  value={form.container_type}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('container_type', v)}
                  options={typeOptions}
                /></div>
              <div><label>Status</label>
                <ComboBox
                  placeholder="Type to search statuses…"
                  value={form.status}
                  disabled={locked}
                  onChange={(v) => setField('status', v)}
                  options={statusOptions}
                /></div>
              <div><label>Site</label>
                <ComboBox
                  placeholder="Type to search sites…"
                  value={form.site_id}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('site_id', v)}
                  options={sites
                    .filter((s) => !s.archived_at || s.id === form.site_id)
                    .map((s) => ({ value: s.id, label: s.name }))}
                /></div>
            </div>

            {!isCreateMode && (
              <>
                <div className="modal-section">
                  Contents{contents ? ` — ${contents.length}` : ''}
                </div>
                {canChange && (
                  <div className="pf-form">
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label>Add asset</label>
                      <ComboBox
                        placeholder="Type to search assets…"
                        value={pendingAdd}
                        disabled={busyContents}
                        onOpen={loadAssets}
                        onChange={(v) => void addAsset(v)}
                        options={assetOptions}
                      />
                      {contentsError && <span className="pf-error">{contentsError}</span>}
                    </div>
                  </div>
                )}
                <div className="contents-list">
                  {contents === null && <p className="page-hint">Loading…</p>}
                  {contents?.length === 0 && (
                    <p className="page-hint">No assets in this container yet.</p>
                  )}
                  {contents?.map((r) => (
                    <div key={r.asset_id} className="contents-row">
                      <span className="mono">{r.serial_number ?? '—'}</span>
                      <span>{r.name ?? r.model_name ?? '—'}</span>
                      <span className="chip custom"
                            style={{ '--chip': r.status_color } as React.CSSProperties}>
                        <span className="dot" />{r.status_label}
                      </span>
                      {canChange && (
                        <button type="button" className="mini-btn danger"
                                disabled={busyContents}
                                onClick={() => void removeAsset(r.asset_id)}>
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreateMode ? 'Create container' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {container && canChange && (
              <button className="mini-btn danger" type="button" disabled={saving}
                      onClick={() => void toggleArchive()}>
                {archived ? 'Unarchive' : 'Archive'}
              </button>
            )}
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
```

Also add the two small CSS classes to `portal/src/styles/assets.css` (or a new `containers.css` imported by the page in Task 8 — put them where the page imports styles from):

```css
.contents-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.contents-row {
  display: grid; grid-template-columns: 1fr 1.4fr auto auto;
  gap: 10px; align-items: center; padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 8px;
}
```

(Check the variable name the stylesheet actually uses for borders — grep `--border` in `portal/src/styles/`; use whatever token the house uses.)

- [ ] **Step 2: Typecheck**

Run: `cd portal && npx tsc --noEmit`
Expected: no errors. (Check `ApiError`'s actual shape in `api.ts` — if the detail payload lives on a different property than `.detail`, adjust `mapError`; the `ApiError` class and its `code` come from `errorFrom`.)

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/containers/ContainerEditModal.tsx portal/src/styles/
git commit -m "feat(portal): ContainerEditModal — fields, archive, contents management"
```

---

### Task 8: Containers page + nav + route + topbar search

**Files:**
- Create: `portal/src/pages/Containers.tsx`
- Modify: `portal/src/layout/navSections.tsx` (new Logistics section between Assets and Operations)
- Modify: `portal/src/App.tsx` (route `/logistics/containers`)
- Modify: `portal/src/components/Topbar.tsx:122-125` (handle `kind === 'container'`)

**Interfaces:**
- Consumes: Tasks 6-7 exports; `usePersistentListState`, `ColumnMenu`, `passesColumnFilters`, `FilterSummaryChip`, `EmptyClearFilters` from `lib/columnMenu`; `ColumnsButton`, `ExportButton`, `exportCsv`, `visibleColumnsFor` from `lib/listTools`; `useGodEdit`, `GodCell`, `GodEditToggle` from `lib/godEdit`; `useRecordFocus` from `lib/useDeepLinkFilter`; `naturalCompare` from `lib/sites`; `NotesFilesPanel`.
- Produces: route `/logistics/containers` gated on resource `containers`; topbar search hits of kind `container` navigate to `/logistics/containers?open=<id>`.

- [ ] **Step 1: Write the page**

Clone `portal/src/pages/Assets.tsx` structure exactly — including the deep-link guard refs and both auto-clear effects (the comments in Assets.tsx explicitly call themselves the template). Full file:

```tsx
// portal/src/pages/Containers.tsx
/**
 * Containers — logistics transport containers: identity, type/status
 * chips, site + location, and asset contents. Directory pattern cloned
 * from Assets.tsx (incl. its deep-link/filter interplay); all mutation
 * lands in ContainerEditModal.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { useAuth } from '../auth/AuthContext';
import ContainerBulkImport from '../components/containers/ContainerBulkImport';
import ContainerEditModal from '../components/containers/ContainerEditModal';
import NotesFilesPanel from '../components/NotesFilesPanel';
import {
  ApiError,
  listContainerAssets,
  listContainers,
  listContainerStatuses,
  listContainerTypes,
  listSites,
  updateContainer,
  type ContainerAssetRow,
  type ContainerItem,
  type SiteItem,
  type StatusValue,
} from '../lib/api';
import {
  CONTAINER_ERRORS, CONTAINER_GOD_FIELDS, containerCellText, containerSearchText,
} from '../lib/containers';
import { initialOpenId } from '../lib/auditFormat';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import { GodCell, GodEditToggle, useGodEdit } from '../lib/godEdit';
import { naturalCompare } from '../lib/sites';
import { useRecordFocus } from '../lib/useDeepLinkFilter';
import {
  ColumnsButton,
  ExportButton,
  exportCsv,
  visibleColumnsFor,
  type ColumnDef,
} from '../lib/listTools';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/assets.css';

const COLUMNS: ColumnDef[] = [
  { key: 'type', label: 'Type', width: '1fr', default: true },
  { key: 'rfid', label: 'RFID', width: '1fr', default: true },
  { key: 'assets', label: 'Assets', width: '0.6fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'site', label: 'Site', width: '1.2fr', default: true },
  { key: 'location', label: 'Location', width: '1.4fr', default: false },
  { key: 'updated', label: 'Created', width: '1fr', default: false },
];

const ALL_COLUMN_KEYS = new Set<string>(
  [...COLUMNS.map((c) => c.key), 'primary', 'archived']);
const DEFAULT_VISIBLE = new Set<string>(
  COLUMNS.filter((c) => c.default).map((c) => c.key));

function sortValueFor(c: ContainerItem, key: string): string {
  switch (key) {
    case 'primary': return c.name.toLowerCase();
    case 'type': return (c.type_label ?? '').toLowerCase();
    case 'rfid': return (c.rfid_tag ?? '').toLowerCase();
    case 'assets': return String(c.asset_count).padStart(6, '0');
    case 'status': return c.status_label.toLowerCase();
    case 'site': return (c.site_name ?? '').toLowerCase();
    case 'location': return c.location_detail.toLowerCase();
    case 'updated': return c.created_at;
    case 'archived': return c.archived_at ? '1' : '0';
    default: return '';
  }
}

const CSV_COLUMNS: [string, (c: ContainerItem) => string][] = [
  ['ID', (c) => c.id],
  ['Name', (c) => c.name],
  ['Type', (c) => c.type_label ?? ''],
  ['RFID', (c) => c.rfid_tag ?? ''],
  ['Assets', (c) => String(c.asset_count)],
  ['Status', (c) => c.status_label],
  ['Site', (c) => c.site_name ?? ''],
  ['Location', (c) => c.location_detail],
  ['Created', (c) => c.created_at],
];

export default function Containers() {
  const { can, godMode } = useAuth();
  const canAdd = can('containers', 'add');
  const canChange = can('containers', 'change');
  const canViewSites = can('sites', 'view');
  const god = useGodEdit();

  const [containers, setContainers] = useState<ContainerItem[] | null>(null);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [types, setTypes] = useState<StatusValue[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const deepLinkTarget = useRef<string | null>(initialOpenId());
  const focusOpenId = (id: string | null) => {
    deepLinkTarget.current = id;
    clearedDeepLink.current = null;
    setOpenId(id);
  };
  useRecordFocus(containers, (c) => c.id, (c) => c.name, focusOpenId, setQuery);
  const clearedDeepLink = useRef<string | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
  } = usePersistentListState(
    'containers', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 },
    ALL_COLUMN_KEYS,
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = async () => {
    try {
      setContainers(await listContainers());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view containers.'
        : 'Failed to load containers.');
    }
  };

  useEffect(() => {
    void load();
    void listContainerStatuses().then(setStatuses).catch(() => {});
    void listContainerTypes().then(setTypes).catch(() => {});
    if (canViewSites) void listSites().then(setSites).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const godFields = useMemo(() => CONTAINER_GOD_FIELDS({
    sites: () => (canViewSites ? sites.map((s) => ({ value: s.id, label: s.name })) : []),
    statuses: () => statuses.map((s) => ({ value: s.key, label: s.label })),
    types: () => types.map((t) => ({ value: t.key, label: t.label })),
  }), [sites, statuses, types, canViewSites]);
  const godFieldFor = (column: string) => godFields.find((f) => f.column === column);
  const replaceRow = (u: ContainerItem) =>
    setContainers((xs) => xs?.map((x) => (x.id === u.id ? u : x)) ?? xs);

  const visible = useMemo(() => {
    if (!containers) return [];
    const q = query.trim().toLowerCase();
    const showArchived = filters.archived?.values?.includes('Yes') ?? false;
    const rows = containers.filter((c) => {
      if (!showArchived && c.archived_at) return false;
      if (!passesColumnFilters(c, filters, containerCellText)) return false;
      if (!q) return true;
      return containerSearchText(c).includes(q);
    });
    return rows.sort((a, b) =>
      naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [containers, filters, query, sortKey, sortDir]);

  // Deep-link vs persisted-filter interplay — cloned from Assets.tsx.
  useEffect(() => {
    if (!containers || !openId || visible.some((c) => c.id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId;
      const target = containers.find((c) => c.id === openId);
      if (target && !passesColumnFilters(target, filters, containerCellText)) {
        clearFilters();
        return;
      }
    }
    setOpenId(null);
  }, [containers, visible, openId, filters, clearFilters]);

  useEffect(() => {
    if (deepLinkTarget.current && visible.some((c) => c.id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);
  const grid = { gridTemplateColumns: `2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (c: ContainerItem, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={c} gf={gf} patch={updateContainer} onRowSaved={replaceRow}
                   errorMap={CONTAINER_ERRORS} disabled={!canChange} />
        );
      }
    }
    switch (key) {
      case 'type':
        return c.type_color
          ? (
            <span className="chip custom" style={{ '--chip': c.type_color } as CSSProperties}>
              <span className="dot" />{c.type_label}
            </span>
          )
          : <span className="cell-top">—</span>;
      case 'rfid':
        return <span className="mono">{c.rfid_tag ?? '—'}</span>;
      case 'assets':
        return <span className="mono">{c.asset_count}</span>;
      case 'status':
        return (
          <div className="chips">
            <span className="chip custom" style={{ '--chip': c.status_color } as CSSProperties}>
              <span className="dot" />{c.status_label}
            </span>
            {c.archived_at && <span className="chip tag">Archived</span>}
          </div>
        );
      case 'site':
        return <span className="cell-top">{c.site_name ?? '—'}</span>;
      case 'location':
        return <span className="cell-top">{c.location_detail || '—'}</span>;
      case 'updated':
        return <span className="cell-top">{new Date(c.created_at).toLocaleDateString()}</span>;
      default:
        return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Logistics</div>
          <h1 className="page-title">
            Containers
            <span className="badge-count">{containers?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Transport containers — type, status, site, and asset contents.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {containers?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={COLUMNS} visible={visibleCols} onChange={setVisibleCols} godMode={godMode} />
          <ExportButton onExport={() => exportCsv('containers', CSV_COLUMNS, visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle} visible={godMode && canChange} />
          {canAdd && (
            <button className="mini-btn" onClick={() => setImporting(true)}>
              Import
            </button>
          )}
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New container
            </button>
          )}
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load containers</b>{error}</div>}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <span className="col-head">
              <button className="sortable" onClick={() => toggleSort('primary')}>
                Name {caret('primary')}
              </button>
              <ColumnMenu colKey="primary" label="Name"
                          allRows={containers ?? []} filters={filters}
                          text={containerCellText}
                          filter={filters.primary} onFilter={setFilter}
                          sortDir={sortKey === 'primary' ? sortDir : null}
                          onSort={(dir) => setSort('primary', dir)} />
            </span>
            {shownCols.map((c) => (
              <span key={c.key} className="col-head">
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={containers ?? []} filters={filters}
                            text={containerCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <ColumnMenu colKey="archived" label="Archived"
                        allRows={containers ?? []} filters={filters}
                        text={containerCellText}
                        filter={filters.archived} onFilter={setFilter}
                        sortDir={sortKey === 'archived' ? sortDir : null}
                        onSort={(dir) => setSort('archived', dir)} />
          </div>

          {containers && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — or add a container.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          {visible.map((c) => {
            const open = openId === c.id;
            return (
              <div key={c.id} className={`dir-row ${open ? 'open' : ''} ${c.archived_at ? 'archived' : ''}`}>
                <div className="row-main" style={grid}
                     onClick={() => { deepLinkTarget.current = null; setOpenId(open ? null : c.id); }}>
                  <div className="cell cell-primary">
                    {god.editing && godFieldFor('primary') ? (
                      <div className="pn god-primary-edit">
                        <GodCell row={c} gf={godFieldFor('primary')!} patch={updateContainer}
                                 onRowSaved={replaceRow} errorMap={CONTAINER_ERRORS} disabled={!canChange} />
                      </div>
                    ) : (
                      <div className="pn"><b>{c.name}</b>
                        <span>{c.type_label ?? '—'}</span></div>
                    )}
                  </div>
                  {shownCols.map((col) => (
                    <div className="cell" key={col.key}>{cellFor(c, col.key)}</div>
                  ))}
                  <div className="cell chevron-cell">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                         strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                  </div>
                </div>

                <div className="detail">
                  <div className="detail-clip">
                    <div className="detail-inner">
                      {open && (
                        <ContainerRowDetail
                          container={c}
                          canEdit={canChange}
                          onEdit={() => setEditingId(c.id)}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingId !== null && (
        <ContainerEditModal
          container={containers?.find((c) => c.id === editingId) ?? null}
          statuses={statuses}
          types={types}
          sites={sites}
          canChange={canChange}
          onClose={() => setEditingId(null)}
          onSaved={() => load()}
        />
      )}
      {creating && (
        <ContainerEditModal
          container={null}
          statuses={statuses}
          types={types}
          sites={sites}
          canChange={canChange}
          onClose={() => setCreating(false)}
          onSaved={() => load()}
        />
      )}
      {importing && (
        <ContainerBulkImport
          onClose={() => setImporting(false)}
          onDone={() => load()}
        />
      )}
    </div>
  );
}

/* ── row detail: read-only — the ONLY interactive element is Edit. ── */

function ContainerRowDetail({ container, canEdit, onEdit }: {
  container: ContainerItem; canEdit: boolean; onEdit: () => void;
}) {
  const [contents, setContents] = useState<ContainerAssetRow[] | null>(null);
  useEffect(() => {
    void listContainerAssets(container.id).then(setContents).catch(() => {});
  }, [container.id]);

  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Identity</p>
        <dl className="kv">
          <dt>Name</dt><dd>{container.name}</dd>
          <dt>Type</dt><dd>{container.type_label ?? '—'}</dd>
          <dt>RFID tag</dt><dd className="mono">{container.rfid_tag ?? '—'}</dd>
          <dt>Last audit</dt>
          <dd>{container.last_audit_at
            ? new Date(container.last_audit_at).toLocaleString() : '—'}</dd>
          <dt>Last validated</dt>
          <dd>{container.last_validated_at
            ? new Date(container.last_validated_at).toLocaleString() : '—'}</dd>
        </dl>
      </div>
      <div className="detail-block">
        <p className="eyebrow-sm">Location</p>
        <dl className="kv">
          <dt>Site</dt><dd>{container.site_name ?? '—'}</dd>
          <dt>Location</dt><dd>{container.location_detail || '—'}</dd>
          <dt>Assets</dt><dd>{container.asset_count}</dd>
        </dl>
      </div>
      <div className="detail-block" style={{ gridColumn: '1 / -1' }}>
        <p className="eyebrow-sm">Contents</p>
        {contents === null && <p className="page-hint">Loading…</p>}
        {contents?.length === 0 && <p className="page-hint">No assets in this container.</p>}
        {contents && contents.length > 0 && (
          <dl className="kv">
            {contents.map((r) => (
              <span key={r.asset_id} style={{ display: 'contents' }}>
                <dt className="mono">{r.serial_number ?? '—'}</dt>
                <dd>{r.name ?? r.model_name ?? '—'} · {r.status_label}</dd>
              </span>
            ))}
          </dl>
        )}
      </div>
      <NotesFilesPanel entityType="container" entityId={container.id} canWrite={canEdit} />
      {canEdit && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        </div>
      )}
    </div>
  );
}
```

NOTE: `NotesFilesPanel entityType="container"` — check whether the notes/attachments API validates `entity_type` server-side (grep `entity_type` in `api/src/serversherpa/api/routes/notes.py` and `attachments.py`); if there's an allowlist, add `"container"` to it in this task and note it in the commit.

- [ ] **Step 2: Add the nav section**

In `portal/src/layout/navSections.tsx`, insert between the `Assets` and `Operations` sections:

```tsx
  {
    label: 'Logistics',
    items: [
      {
        to: '/logistics/containers',
        label: 'Containers',
        resource: 'containers',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8h18v10H3z" />
            <path d="M3 8l2-4h14l2 4" />
            <path d="M8 12v3M12 12v3M16 12v3" />
          </svg>
        ),
      },
    ],
  },
```

- [ ] **Step 3: Add the route**

In `portal/src/App.tsx`, import `Containers` alongside the other pages and add after the `/assets` route:

```tsx
            <Route path="/logistics/containers" element={<ProtectedRoute resource="containers"><Containers /></ProtectedRoute>} />
```

- [ ] **Step 4: Handle the search kind in the topbar**

In `portal/src/components/Topbar.tsx`, in the kind dispatch around line 122, after the `asset` branch (copy the exact navigate-with-open pattern the `asset` branch uses):

```tsx
    } else if (hit.kind === 'container') {
      navigate('/logistics/containers', { state: { openRow: hit.id } });
```

(Match the `asset` branch verbatim — if it passes `openRow` differently or navigates with a query param, do the same.)

Also check `portal/src/components/CommandPalette.tsx`: if pages register there explicitly (rather than deriving from `NAV_SECTIONS`), add the Containers page entry following the Assets entry's pattern — the standing rule is every new section appears in both global search and the ⌘K palette.

- [ ] **Step 5: Build ContainerBulkImport stub so the page compiles**

Task 9 writes the real component; to keep this task shippable, create it now with the full implementation from Task 9 — OR, if executing tasks strictly in order, create the file with the real component in Task 9 and in THIS task temporarily comment out the `ContainerBulkImport` import, the `importing` state, and the Import button, then restore them in Task 9. Prefer doing Task 9 first if executing out of order is allowed; otherwise use the comment-out approach.

- [ ] **Step 6: Typecheck and run existing portal tests**

Run: `cd portal && npx tsc --noEmit && npx vitest run`
Expected: no type errors; the godmode nav test (`godmode.test.ts` asserts against `NAV_SECTIONS`) still passes.

- [ ] **Step 7: Commit**

```bash
git add portal/src/pages/Containers.tsx portal/src/layout/navSections.tsx portal/src/App.tsx portal/src/components/Topbar.tsx
git commit -m "feat(portal): Containers page under new Logistics nav group"
```

---

### Task 9: ContainerBulkImport component

**Files:**
- Create: `portal/src/components/containers/ContainerBulkImport.tsx`
- Modify: `portal/src/pages/Containers.tsx` (restore the import/button if Task 8 commented them out)

**Interfaces:**
- Consumes: `previewContainerBulk`, `commitContainerBulk`, `downloadContainerTemplate`, `ContainerBulkRow` from Task 6; the `xlsx` package (already a portal dependency if `SiteBulkImport.tsx` uses it — check its imports; if sites parse xlsx server-side instead, mirror THAT).
- Produces: `<ContainerBulkImport onClose onDone />` modal.

- [ ] **Step 1: Read the template component**

Read `portal/src/components/sites/SiteBulkImport.tsx` fully (281 lines). Mirror its structure: file input + paste area if it has one, Preview button → per-row results table, Import button locked until the preview says every row is `create`. Reuse its CSS classes.

- [ ] **Step 2: Write the component**

Adapt this skeleton to what Step 1 found (state flow and JSX layout must match the sites component's conventions; the code below is the required logic):

```tsx
// portal/src/components/containers/ContainerBulkImport.tsx
/**
 * ContainerBulkImport — Import-button modal on the Containers list.
 * CSV/XLSX file → preview (per-row create/error) → commit. Create-only;
 * commit stays locked until every row previews as `create`.
 * Mirrors SiteBulkImport.tsx's flow and styling.
 */

import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';

import {
  ApiError,
  commitContainerBulk,
  downloadContainerTemplate,
  previewContainerBulk,
  type ContainerBulkRow,
} from '../../lib/api';

interface Props {
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

const BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The data has columns that are not in the template.',
  too_many_rows: 'Too many rows — the limit is 1,000 per import.',
  rows_invalid: 'Some rows have problems — fix them and preview again.',
  forbidden: 'You do not have permission to import containers.',
};

const ROW_ERRORS: Record<string, string> = {
  name_required: 'Name is required',
  duplicate_name: 'A container with this name already exists',
  unknown_container_type: 'Unknown container type',
  unknown_status: 'Unknown status',
  unknown_site: 'Unknown site',
};

/** File → array of row objects keyed by header. CSV parsed inline;
 *  XLSX via the xlsx package (V2's client-side conversion approach). */
async function parseFile(file: File): Promise<Record<string, unknown>[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  return XLSX.utils.sheet_to_json(sheet!, { defval: '' });
}

export default function ContainerBulkImport({ onClose, onDone }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [preview, setPreview] = useState<ContainerBulkRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<number | null>(null);

  const pickFile = async (file: File) => {
    setError('');
    setPreview(null);
    setDone(null);
    try {
      const parsed = await parseFile(file);
      setRows(parsed);
      setFileName(file.name);
    } catch {
      setError('Could not read that file — use .csv or .xlsx.');
    }
  };

  const runPreview = async () => {
    if (!rows) return;
    setBusy(true);
    setError('');
    try {
      setPreview((await previewContainerBulk(rows)).rows);
    } catch (err) {
      setError(err instanceof ApiError
        ? (BULK_ERRORS[err.code] ?? 'Preview failed — try again.')
        : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const runCommit = async () => {
    if (!rows) return;
    setBusy(true);
    setError('');
    try {
      const result = await commitContainerBulk(rows);
      setDone(result.created);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError
        ? (BULK_ERRORS[err.code] ?? 'Import failed — try again.')
        : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const template = async () => {
    const blob = await downloadContainerTemplate();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'containers-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const canCommit = !!preview && preview.length > 0
    && preview.every((r) => r.action === 'create');

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Import containers</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <p className="page-hint">
            Upload a .csv or .xlsx matching the template — names must be new
            (this import creates containers, it never updates).
          </p>
          <div className="pf-form">
            <div>
              <button className="mini-btn" type="button" onClick={() => void template()}>
                Download template
              </button>
            </div>
            <div>
              <input ref={fileRef} type="file" accept=".csv,.xlsx"
                     style={{ display: 'none' }}
                     onChange={(e) => {
                       const f = e.target.files?.[0];
                       if (f) void pickFile(f);
                     }} />
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => fileRef.current?.click()}>
                {fileName || 'Choose file…'}
              </button>
            </div>
          </div>

          {preview && (
            <table className="bulk-table">
              <thead>
                <tr><th>Row</th><th>Name</th><th>Result</th></tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.row} className={r.action === 'error' ? 'row-error' : ''}>
                    <td>{r.row}</td>
                    <td>{String(r.data.name ?? '')}</td>
                    <td>{r.action === 'create'
                      ? 'Create'
                      : r.errors.map((e) => ROW_ERRORS[e] ?? e).join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {done !== null && (
            <p className="page-hint"><b>Imported {done} containers.</b></p>
          )}
          {error && <span className="pf-error">{error}</span>}
        </div>
        <div className="modal-foot">
          <button className="mini-btn" type="button" disabled={!rows || busy}
                  onClick={() => void runPreview()}>
            {busy ? 'Working…' : 'Preview'}
          </button>
          <button className="btn-solid" type="button" disabled={!canCommit || busy || done !== null}
                  onClick={() => void runCommit()}>
            Import
          </button>
          <button className="mini-btn" type="button" onClick={onClose} disabled={busy}>
            {done !== null ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

If `SiteBulkImport.tsx` reveals different class names for its results table (`bulk-table` is a guess), use the real ones. If `xlsx` is not in `portal/package.json`, run `npm install xlsx` and commit the lockfile change in this task.

- [ ] **Step 3: Typecheck**

Run: `cd portal && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/containers/ContainerBulkImport.tsx portal/src/pages/Containers.tsx portal/package.json portal/package-lock.json
git commit -m "feat(portal): container bulk import modal — template, preview, commit"
```

---

### Task 10: Full-suite verification + dev-server pass

**Files:** none created — verification only.

- [ ] **Step 1: Run the whole API suite**

Run: `cd api && python -m pytest -q`
Expected: everything passes — especially `test_status_values_*` (the new record types must not break vocabulary listing), `test_audit_*`, and `test_access_*`.

- [ ] **Step 2: Run the whole portal check**

Run: `cd portal && npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 3: Dev-server manual pass**

Start the dev stack (`.claude/launch.json` config if present; otherwise the project's usual `docker-compose.dev.yml` + portal dev server). Verify in the browser, as the dev login:

1. **Nav**: Logistics → Containers appears between Assets and Operations; hidden for a role without `containers` view.
2. **Create**: + New container → name/type/status/site/location save; new row appears.
3. **List**: column menus filter + sort; Columns picker persists across reload; Export downloads CSV; search box filters.
4. **Expansion**: read-only detail with contents + notes panel; Edit opens the modal.
5. **Contents**: in Edit, add an asset via the ComboBox; add the SAME asset to a second container → inline error naming the first container; remove works.
6. **Variables page** (god mode): `Container` and `Container type` vocabularies appear and are editable.
7. **Import**: template downloads; a 2-row CSV previews (one good, one with a bad site) showing per-row results; fixing and committing creates the rows.
8. **Search**: topbar search finds a container by name and navigates to the row.
9. **Audit**: the audit log shows container create/update/assets_add entries.

Do NOT leave test rows behind in the dev DB — archive-then-hard-delete is not available, so create rows named obviously (e.g. "ZZZ-verify") and delete them via SQL after the pass, or verify against rows the user actually wants.

- [ ] **Step 4: Commit any fixes found**

```bash
git add -u
git commit -m "fix(portal/api): containers verification pass fixes"
```

(Skip if nothing changed.)

---

## Self-review notes (already applied)

- Spec §1's `assigned_to_truck` container status seed is deferred to migration 0016 (trucks don't exist in this slice) — recorded in Task 1 Step 3.
- Spec §2's `truck_id` list filter and truck columns are Slice 2.
- Spec §5's XLSX handling: client-side parse via `xlsx` (Task 9), API accepts JSON rows (the sites idiom) — the template endpoint serves CSV.
- `NotesFilesPanel` entity-type allowlist check is called out in Task 8 Step 1.
- Route-ordering hazard (`/bulk-import/*` vs `/{container_id}`) is called out in Task 5 Step 4.
