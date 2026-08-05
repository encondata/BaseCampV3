# Assets Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the core asset registry — `assets` + make/model catalog + aliases + a global notes system — with client-scoped visibility, two new portal pages (Assets, Makes/Models), new nav sections (Assets above Operations, Admin above System), and global-search/palette registration.

**Architecture:** Follows the Sites feature end to end: one migration (0014) with editable lookups and composite status FK, SQLAlchemy models mirroring it, resource-registry + scope-map access wiring, routers cloned from `sites.py` conventions (require_permission → scope_conditions → audit-in-transaction), and portal pages cloned from `Sites.tsx` (list toolbar → read-only expansion → edit modal). Dual-unit fields (weight, dimensions) are computed server-side in one helper.

**Tech Stack:** FastAPI + SQLAlchemy 2 async + Alembic + pytest (asyncio_mode=auto); React 18 + Vite + TypeScript + vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-05-assets-section-design.md` (approved 2026-08-05).

## Global Constraints

- Repo root: `/Volumes/Extreme SSD/Code Backups/BaseCampV3`. API venv: `api/.venv` (Python 3.13). All pytest runs: `cd api && .venv/bin/pytest …`. All portal runs: `cd portal && npm test` / `npm run build`.
- Migration is `0014_assets.py`, `revision = "0014"`, `down_revision = "0013"`. Vocabulary colors are HEX (post-0013): green `#178a4c`, amber `#a36207`, red `#c03540`, blue `#1668a7`, violet `#6d4fc4`, aqua `#0f7c86`, slate `#51606f`.
- Unit factors: `1 lb = 0.453592 kg`, `1 in = 2.54 cm`, round half-even to 2 decimals. If exactly one side of a pair arrives, the server computes the partner; if both arrive, both are stored as sent.
- `serial_number` is indexed, NOT unique. `rfid_tag` is unique where present (partial index). Both CITEXT.
- Client org roles (`client_owner`, `client_admin`, `client_viewer`) get `assets: view` only. `asset_models` is internal-only (`visible_to={"global"}`). All asset writes are `_require_global`.
- Audit rides the mutation transaction (`services/audit.py`); `entity_id` is always `str(uuid)`; no-op PATCH writes no audit row and does not bump `updated_at`.
- House naming: schemas `AssetItem`/`AssetCreateIn`/`AssetUpdateIn` (`extra="forbid"` on write schemas); routers export module-level `router` (+ named secondary routers); models have NO `relationship()` — joins are explicit in routes.
- Portal: new resources must be registered in FOUR places — `App.tsx` route, `navSections.tsx`, `lib/access.ts` `ROUTE_RESOURCE`, `Topbar.tsx` `CRUMBS`+`PAGES` — plus `CommandPalette.tsx` (static list, does NOT derive from nav).
- UI rules: shared list toolbar (`lib/listTools.tsx`), ComboBox for record-backed dropdowns (native `<select>` only for tiny fixed enums), read-only row expansion with a single Edit button, modal classes `modal-scrim/modal-card/modal-head/modal-body/modal-foot`, status chips via `.chip.custom` + `--chip` hex.
- Commit after every task (each task ends with a commit step). Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure (whole feature)

```
api/migrations/versions/0014_assets.py                 (new — tables, seeds, grants)
api/src/serversherpa/db/models.py                      (modify — 5 new model classes)
api/src/serversherpa/status/registry.py                (modify — 'asset' record type)
api/src/serversherpa/assets/__init__.py                (new — empty)
api/src/serversherpa/assets/units.py                   (new — dual-unit helper)
api/src/serversherpa/access/resources.py               (modify — assets, asset_models)
api/src/serversherpa/access/defaults.py                (modify — grants)
api/src/serversherpa/access/scope.py                   (modify — SCOPE_COLUMNS)
api/src/serversherpa/api/schemas.py                    (modify — asset schemas)
api/src/serversherpa/api/routes/asset_models.py        (new — catalog router)
api/src/serversherpa/api/routes/assets.py              (new — registry router)
api/src/serversherpa/api/routes/notes.py               (new — global notes router)
api/src/serversherpa/api/routes/attachments.py         (modify — asset entity type)
api/src/serversherpa/api/routes/search.py              (modify — 2 new sections)
api/src/serversherpa/api/app.py                        (modify — include routers)
api/tests/conftest.py                                  (modify — TRUNCATE + seed restore)
api/tests/test_assets_units.py                         (new)
api/tests/test_asset_models_api.py                     (new)
api/tests/test_assets_api.py                           (new)
api/tests/test_assets_write.py                         (new)
api/tests/test_notes_api.py                            (new)
api/tests/test_search_assets.py                        (new)
portal/src/lib/api.ts                                  (modify — types + methods)
portal/src/lib/assets.ts                               (new — pure page logic)
portal/src/lib/assets.test.ts                          (new)
portal/src/lib/access.ts                               (modify — ROUTE_RESOURCE)
portal/src/layout/navSections.tsx                      (modify — 2 new sections)
portal/src/lib/godmode.test.ts                         (modify — nav assertions)
portal/src/App.tsx                                     (modify — 2 routes)
portal/src/components/Topbar.tsx                       (modify — crumbs, pages, search kinds)
portal/src/components/CommandPalette.tsx               (modify — 2 nav commands)
portal/src/components/NotesFilesPanel.tsx              (new — shared notes+files panel)
portal/src/components/assets/AssetEditModal.tsx        (new)
portal/src/components/assets/ModelEditModal.tsx        (new)
portal/src/pages/Assets.tsx                            (new)
portal/src/pages/AssetModels.tsx                       (new)
portal/src/styles/assets.css                           (new — small page-specific additions)
```

---

### Task 1: Migration 0014, SQLAlchemy models, status registry, test-harness hygiene

**Files:**
- Create: `api/migrations/versions/0014_assets.py`
- Modify: `api/src/serversherpa/db/models.py` (append after `SiteClient`, ~line 407)
- Modify: `api/src/serversherpa/status/registry.py` (STATUS_RECORD_TYPES list)
- Modify: `api/tests/conftest.py` (`clean_db` TRUNCATE list + seed restore)
- Test: `api/tests/test_assets_model.py`

**Interfaces:**
- Produces: tables `asset_categories`, `asset_models`, `asset_model_aliases`, `assets`, `notes`; models `AssetCategory`, `AssetModel`, `AssetModelAlias`, `Asset`, `Note` importable from `serversherpa.db.models`; status record type `asset` with 5 seeded `status_values` rows; role grants for resources `assets` and `asset_models` in `role_permissions`.

- [ ] **Step 1: Write the failing test**

`api/tests/test_assets_model.py`:

```python
"""Migration 0014 + model round-trips: tables exist, seeds landed,
constraints hold (rfid partial-unique, make+model unique, alias unique)."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Asset, AssetCategory, AssetModel, AssetModelAlias, Note, StatusValue,
)


async def test_seeds_present(db):
    cats = (await db.scalars(select(AssetCategory))).all()
    assert {c.key for c in cats} == {"server", "storage", "network", "power", "other"}
    statuses = (await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))).all()
    assert {s.key for s in statuses} == {
        "active", "in_transit", "in_storage", "decommissioned", "unknown"}
    assert all(s.color.startswith("#") for s in statuses)


async def test_asset_defaults_and_status_fk(db):
    asset = Asset(name="web-01")
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    assert asset.status == "unknown"
    assert asset.status_record_type == "asset"
    assert asset.location_detail == ""
    assert asset.created_at is not None

    bad = Asset(name="bad", status="not_a_status")
    db.add(bad)
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_rfid_unique_only_when_present(db):
    db.add_all([Asset(name="a1", rfid_tag=None), Asset(name="a2", rfid_tag=None)])
    await db.commit()          # two NULL tags fine

    db.add(Asset(name="a3", rfid_tag="TAG-1"))
    await db.commit()
    db.add(Asset(name="a4", rfid_tag="tag-1"))   # CITEXT: case-insensitive clash
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_duplicate_serial_allowed(db):
    db.add_all([Asset(serial_number="SN1"), Asset(serial_number="SN1")])
    await db.commit()          # serials deliberately NOT unique


async def test_make_model_unique_and_alias_cascade(db):
    m = AssetModel(make="Dell", model="R740")
    db.add(m)
    await db.commit()
    db.add(AssetModel(make="dell", model="r740"))   # CITEXT pair clash
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    db.add(AssetModelAlias(model_id=m.id, alias="PowerEdge R740"))
    await db.commit()
    await db.delete(m)
    await db.commit()
    left = (await db.scalars(select(AssetModelAlias))).all()
    assert left == []          # ON DELETE CASCADE


async def test_notes_table_roundtrip(db):
    note = Note(entity_type="asset",
                entity_id=(await _mk_asset(db)), body="hello")
    db.add(note)
    await db.commit()
    await db.refresh(note)
    assert note.deleted_at is None and note.created_at is not None


async def _mk_asset(db):
    a = Asset(name="host")
    db.add(a)
    await db.flush()
    return a.id


async def test_role_grants_seeded(db):
    rows = (await db.execute(text(
        "SELECT role, action FROM role_permissions WHERE resource = 'assets'"
    ))).all()
    granted = {(r, a) for r, a in rows}
    assert ("staff", "change") in granted
    assert ("client_viewer", "view") in granted
    assert ("client_viewer", "change") not in granted
    model_rows = (await db.execute(text(
        "SELECT role FROM role_permissions WHERE resource = 'asset_models'"
    ))).all()
    assert all(r[0] not in ("client_owner", "client_admin", "client_viewer")
               for r in model_rows)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/api" && .venv/bin/pytest tests/test_assets_model.py -q`
Expected: FAIL at import time (`ImportError: cannot import name 'Asset'`) — or ProgrammingError about missing tables once models exist.

- [ ] **Step 3: Write the migration**

`api/migrations/versions/0014_assets.py`:

```python
"""assets — core registry + make/model catalog + aliases + global notes.
Rebuilt from legacy BaseCamp V2 assets/assets_make_model/assets_make_model_fuzzy:
uuid PKs, editable category lookup, status via status_values, dual-unit
weight/dimensions (server computes the partner), CITEXT identifiers with a
partial-unique rfid_tag, and the damage/notes existence flags deliberately
dropped (damage reports are a designed follow-on; notes become a real table).

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-05
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ASSET_CATEGORIES = [
    ("server", "Server", "Compute hardware.", 1, "#1668a7"),
    ("storage", "Storage", "Disk shelves, arrays, tape.", 2, "#6d4fc4"),
    ("network", "Network", "Switches, routers, firewalls.", 3, "#0f7c86"),
    ("power", "Power", "PDUs, UPSes.", 4, "#a36207"),
    ("other", "Other", "Anything that does not fit the other categories.", 5, "#51606f"),
]

ASSET_STATUSES = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('asset','active','Active','Racked and in service.','#178a4c',1),
      ('asset','in_transit','In transit','Between locations.','#0f7c86',2),
      ('asset','in_storage','In storage','Warehoused, not in service.','#51606f',3),
      ('asset','decommissioned','Decommissioned','Retired; retained for history.','#c03540',4),
      ('asset','unknown','Unknown','Not yet verified.','#a36207',5)
"""

FULL = ("view", "add", "change", "delete")
# assets: staff full, client org roles read-only (their own rows via scope).
ASSET_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": FULL,
    "client_owner": ("view",), "client_admin": ("view",),
    "client_viewer": ("view",),
}
# asset_models: the catalog (incl. the knowledge field) is house IP —
# internal roles only; client actors get a read-only summary embedded in
# asset payloads instead.
MODEL_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": FULL,
}


def upgrade() -> None:
    op.create_table(
        "asset_categories",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("sort_order", sa.Integer, nullable=False),
        sa.Column("color", sa.Text, nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )

    conn = op.get_bind()
    for key, label, desc, order, color in ASSET_CATEGORIES:
        conn.execute(sa.text(
            "INSERT INTO asset_categories (key, label, description, sort_order, color) "
            "VALUES (:k, :l, :d, :o, :c)"),
            {"k": key, "l": label, "d": desc, "o": order, "c": color})
    op.execute(ASSET_STATUSES)

    op.create_table(
        "asset_models",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("make", CITEXT, nullable=False),
        sa.Column("model", CITEXT, nullable=False),
        sa.Column("category", sa.Text, sa.ForeignKey("asset_categories.key")),
        sa.Column("ru_size", sa.Integer),
        # dual-unit pairs: enter either side, the API computes the partner
        sa.Column("weight_lbs", sa.Numeric(8, 2)),
        sa.Column("weight_kg", sa.Numeric(8, 2)),
        sa.Column("length_in", sa.Numeric(8, 2)),
        sa.Column("width_in", sa.Numeric(8, 2)),
        sa.Column("height_in", sa.Numeric(8, 2)),
        sa.Column("length_cm", sa.Numeric(8, 2)),
        sa.Column("width_cm", sa.Numeric(8, 2)),
        sa.Column("height_cm", sa.Numeric(8, 2)),
        sa.Column("mount_type", sa.Text,
                  comment="rails, ears, shelf, custom — validated in code"),
        sa.Column("rail_type", sa.Text, comment="e.g. Dell B7, A15"),
        sa.Column("knowledge", sa.Text, nullable=False, server_default="",
                  comment="field-crew tips & tricks"),
        sa.Column("legacy_id", sa.BigInteger, comment="V2 assets_make_model.id"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("make", "model", name="asset_models_make_model_key"),
    )

    op.create_table(
        "asset_model_aliases",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("model_id", UUID(as_uuid=True),
                  sa.ForeignKey("asset_models.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("alias", CITEXT, nullable=False, unique=True,
                  comment="global-unique: an alias resolves to exactly one model"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("asset_model_aliases_model_idx", "asset_model_aliases",
                    ["model_id"])

    op.create_table(
        "assets",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("serial_number", CITEXT,
                  comment="indexed, deliberately NOT unique — legacy has dupes"),
        sa.Column("name", CITEXT, comment="hostname/label"),
        sa.Column("rfid_tag", CITEXT),
        sa.Column("model_id", UUID(as_uuid=True),
                  sa.ForeignKey("asset_models.id")),
        sa.Column("client_id", UUID(as_uuid=True), sa.ForeignKey("clients.id"),
                  comment="owner; NULL = house gear. Drives client scoping."),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("location_detail", sa.Text, nullable=False, server_default=""),
        sa.Column("status", sa.Text, nullable=False, server_default="unknown"),
        sa.Column("has_rails", sa.Boolean, comment="NULL = unknown"),
        sa.Column("last_seen_at", sa.TIMESTAMP(timezone=True),
                  comment="written by future scan surfaces"),
        sa.Column("legacy_id", sa.BigInteger, comment="V2 assets.id"),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    # composite FK to status_values, same idiom migration 0012 used for sites
    op.execute("""
        ALTER TABLE assets ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "assets_status_fkey", "assets", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])

    op.create_index("assets_serial_idx", "assets", ["serial_number"])
    op.create_index("assets_client_idx", "assets", ["client_id"])
    op.create_index("assets_site_idx", "assets", ["site_id"])
    op.create_index("assets_model_idx", "assets", ["model_id"])
    op.create_index("assets_rfid_uniq", "assets", ["rfid_tag"], unique=True,
                    postgresql_where=sa.text("rfid_tag IS NOT NULL"))

    op.create_table(
        "notes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("entity_type", sa.Text, nullable=False,
                  comment="same vocabulary as attachments; only 'asset' in V1"),
        sa.Column("entity_id", UUID(as_uuid=True), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("updated_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("deleted_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("notes_entity_idx", "notes",
                    ["entity_type", "entity_id", "created_at"])

    for resource, grants in (("assets", ASSET_GRANTS),
                             ("asset_models", MODEL_GRANTS)):
        for role, actions in grants.items():
            for action in actions:
                conn.execute(sa.text(
                    "INSERT INTO role_permissions (role, resource, action) "
                    "VALUES (:r, :res, :a) ON CONFLICT DO NOTHING"),
                    {"r": role, "res": resource, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource IN ('assets', 'asset_models')"))
    op.drop_table("notes")
    op.drop_table("assets")
    op.drop_table("asset_model_aliases")
    op.drop_table("asset_models")
    op.drop_table("asset_categories")
    conn.execute(sa.text("DELETE FROM status_values WHERE record_type = 'asset'"))
```

- [ ] **Step 4: Add the SQLAlchemy models**

Append to `api/src/serversherpa/db/models.py` after `SiteClient` (house style: no `relationship()`, `Mapped[str]` → Text via type map). `Numeric` is already imported; `Decimal` too:

```python
class AssetCategory(Base):
    __tablename__ = "asset_categories"

    key: Mapped[str] = mapped_column(primary_key=True)
    label: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    sort_order: Mapped[int] = mapped_column(Integer)
    color: Mapped[str]
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AssetModel(Base):
    """Catalog row (legacy assets_make_model). Dual-unit columns are always
    written in pairs — assets/units.py computes the missing partner."""

    __tablename__ = "asset_models"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    make: Mapped[str] = mapped_column(CITEXT)
    model: Mapped[str] = mapped_column(CITEXT)
    category: Mapped[str | None] = mapped_column(ForeignKey("asset_categories.key"))
    ru_size: Mapped[int | None] = mapped_column(Integer)
    weight_lbs: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    length_in: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    width_in: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    height_in: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    length_cm: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    width_cm: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    height_cm: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    mount_type: Mapped[str | None]
    rail_type: Mapped[str | None]
    knowledge: Mapped[str] = mapped_column(server_default="")
    legacy_id: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class AssetModelAlias(Base):
    __tablename__ = "asset_model_aliases"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    model_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("asset_models.id", ondelete="CASCADE"))
    alias: Mapped[str] = mapped_column(CITEXT, unique=True)
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    serial_number: Mapped[str | None] = mapped_column(CITEXT)
    name: Mapped[str | None] = mapped_column(CITEXT)
    rfid_tag: Mapped[str | None] = mapped_column(CITEXT)
    model_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("asset_models.id"))
    client_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clients.id"))
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    location_detail: Mapped[str] = mapped_column(server_default="")
    status: Mapped[str] = mapped_column(server_default="unknown")
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED column; never written
    has_rails: Mapped[bool | None] = mapped_column(Boolean)
    last_seen_at: Mapped[datetime | None]
    legacy_id: Mapped[int | None] = mapped_column(BigInteger)
    source: Mapped[str] = mapped_column(server_default="manual")
    source_ref: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Note(Base):
    """Global polymorphic notes (attachments-style entity_type/entity_id).
    Soft-deleted like attachments; only entity_type='asset' is wired in V1."""

    __tablename__ = "notes"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    entity_type: Mapped[str]
    entity_id: Mapped[uuid.UUID]
    body: Mapped[str]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    deleted_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

IMPORTANT: `Asset.status_record_type` is a `GENERATED ALWAYS` column — the model maps it read-only by convention (mirror how the `Site` model handles it after 0012: check `db/models.py` `Site.status_record_type` and copy that exact mapping style; if Site omits the column entirely, omit it on Asset too and read it via refresh in tests).

- [ ] **Step 5: Register the status record type**

In `api/src/serversherpa/status/registry.py`, append to `STATUS_RECORD_TYPES`:

```python
    StatusRecordType("asset", "Asset", table="assets",
                     column="status", resource="assets"),
```

- [ ] **Step 6: Test-harness hygiene**

In `api/tests/conftest.py` `clean_db`:

1. Extend the TRUNCATE statement's table list with `notes, assets, asset_model_aliases, asset_models` (before the `CASCADE`; order doesn't matter, CASCADE handles FKs).
2. After the existing `status_values` / `site_types` seed-restore blocks, add deterministic restores (assets are truncated first, so DELETE+INSERT is safe):

```python
        # asset vocabulary — restore canonical seeds (0014)
        await session.execute(text(
            "DELETE FROM status_values WHERE record_type = 'asset'"))
        await session.execute(text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order)
            VALUES
              ('asset','active','Active','Racked and in service.','#178a4c',1),
              ('asset','in_transit','In transit','Between locations.','#0f7c86',2),
              ('asset','in_storage','In storage','Warehoused, not in service.','#51606f',3),
              ('asset','decommissioned','Decommissioned','Retired; retained for history.','#c03540',4),
              ('asset','unknown','Unknown','Not yet verified.','#a36207',5)
        """))
        await session.execute(text("DELETE FROM asset_categories"))
        await session.execute(text("""
            INSERT INTO asset_categories (key, label, description, sort_order, color)
            VALUES
              ('server','Server','Compute hardware.',1,'#1668a7'),
              ('storage','Storage','Disk shelves, arrays, tape.',2,'#6d4fc4'),
              ('network','Network','Switches, routers, firewalls.',3,'#0f7c86'),
              ('power','Power','PDUs, UPSes.',4,'#a36207'),
              ('other','Other','Anything that does not fit the other categories.',5,'#51606f')
        """))
```

- [ ] **Step 7: Migrate and run the tests**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/api" && .venv/bin/alembic upgrade head && .venv/bin/pytest tests/test_assets_model.py -q`
Expected: PASS (the test DB migrates via conftest automatically; the dev DB needs the explicit upgrade).
Also verify downgrade is clean: `.venv/bin/alembic downgrade 0013 && .venv/bin/alembic upgrade head`
Expected: both commands exit 0.

- [ ] **Step 8: Run the FULL suite (conftest changed)**

Run: `.venv/bin/pytest tests/ -q`
Expected: all pass (~193 existing + new).

- [ ] **Step 9: Commit**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A api && git commit -m "feat(api): assets migration 0014, models, status record type

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Access wiring — resources, defaults, scope map

**Files:**
- Modify: `api/src/serversherpa/access/resources.py` (`_RESOURCES` list)
- Modify: `api/src/serversherpa/access/defaults.py` (`_ALL` + role dicts)
- Modify: `api/src/serversherpa/access/scope.py` (`SCOPE_COLUMNS`)
- Test: `api/tests/test_assets_api.py` (started here, grown in Task 5)

**Interfaces:**
- Consumes: `Asset` model from Task 1.
- Produces: `REGISTRY["assets"]` (visible_to `{"global","client"}`), `REGISTRY["asset_models"]` (visible_to `{"global"}`); `scope_conditions("assets", access, person_id)` returns `Asset.client_id IN (actor's client_ids)` for client-anchored actors; default grants matching the migration's `role_permissions` seeds.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_assets_api.py` with the login helpers (house pattern — sibling files import these) and the access-shape tests:

```python
"""Assets API — read paths, labels, and the client-scoping contract."""

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, Client, Person, PersonRole, Site,
)


async def login(client, email="alice@test.example.com", pw="CorrectHorse9!"):
    resp = await client.post("/auth/login", json={"email": email, "password": pw})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def make_login(db, client_api, person, email):
    """Give an existing person a login and return their auth header."""
    from datetime import UTC, datetime

    from serversherpa.config import get_settings
    from serversherpa.db.models import UserAccount
    from serversherpa.security.passwords import hash_password

    db.add(UserAccount(
        person_id=person.id, email=email,
        password_hash=hash_password(
            "CorrectHorse9!", pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))
    await db.commit()
    return await login(client_api, email=email)


async def _client_contact(db, client_api, org_name, email):
    """A client_viewer contact of a fresh org; returns (org, headers)."""
    org = Client(name=org_name)
    db.add(org)
    await db.flush()
    contact = Person(first_name="C", last_name="Contact")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=org.id))
    await db.commit()
    hdrs = await make_login(db, client_api, contact, email)
    return org, hdrs


async def test_registry_shape():
    from serversherpa.access.resources import REGISTRY

    assert REGISTRY["assets"].visible_to == frozenset({"global", "client"})
    assert REGISTRY["asset_models"].visible_to == frozenset({"global"})
    assert "/assets" in REGISTRY["assets"].routes
    assert "/admin/asset-models" in REGISTRY["asset_models"].routes


async def test_scope_map(db, seeded_user):
    from serversherpa.access.resolver import resolve_access
    from serversherpa.access.scope import scope_conditions

    org_a, org_b = Client(name="Acme"), Client(name="Bcme")
    db.add_all([org_a, org_b])
    await db.flush()
    contact = Person(first_name="S", last_name="Coped")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=org_a.id))
    db.add_all([Asset(name="a-acme", client_id=org_a.id),
                Asset(name="a-bcme", client_id=org_b.id),
                Asset(name="a-house", client_id=None)])
    await db.commit()

    access = await resolve_access(db, contact.id)
    cond = scope_conditions("assets", access, contact.id)
    names = {a.name for a in await db.scalars(select(Asset).where(cond))}
    assert names == {"a-acme"}          # own org only — house gear invisible


async def test_client_contact_scoped_list_and_403s(client, db, seeded_user):
    """The house three-assertion contract: in-scope row visible /
    out-of-scope detail 404 / no-permission resource 403."""
    org, hdrs = await _client_contact(db, client, "Acme A", "ac1@acme.example.com")
    other = Client(name="Other Co")
    db.add(other)
    await db.flush()
    mine = Asset(name="mine", client_id=org.id)
    theirs = Asset(name="theirs", client_id=other.id)
    db.add_all([mine, theirs])
    await db.commit()

    rows = (await client.get("/assets", headers=hdrs)).json()
    assert {r["name"] for r in rows} == {"mine"}

    resp = await client.get(f"/assets/{theirs.id}", headers=hdrs)
    assert resp.status_code == 404

    resp = await client.get("/asset-models", headers=hdrs)
    assert resp.status_code == 403      # catalog is internal-only
```

- [ ] **Step 2: Run to verify failure**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/api" && .venv/bin/pytest tests/test_assets_api.py::test_registry_shape tests/test_assets_api.py::test_scope_map -q`
Expected: FAIL — `KeyError: 'assets'` from REGISTRY.

- [ ] **Step 3: Implement**

`access/resources.py` — add to `_RESOURCES` (after the `sites` entry, keeping the list's grouping):

```python
    Resource("assets", "Assets", routes=("/assets",),
             # client-visible: client org roles see their own org's assets
             # read-only via SCOPE_COLUMNS; writes are globally anchored.
             visible_to=frozenset({"global", "client"})),
    Resource("asset_models", "Makes / Models", routes=("/admin/asset-models",),
             # internal-only: the catalog (incl. the knowledge field) is house
             # IP. Asset payloads embed a read-only model summary instead.
             visible_to=frozenset({"global"})),
```

`access/scope.py` — import `Asset` and add to `SCOPE_COLUMNS`:

```python
    "assets": {"client": Asset.client_id},
```

`access/defaults.py` — add `"assets"` and `"asset_models"` to `_ALL`; add `"assets": FULL, "asset_models": FULL` to the explicit `admin` and `staff` dicts; add `"assets": ("view",)` to each of the `client_owner`, `client_admin`, `client_viewer` role dicts (mirror how those dicts grant `clients: ("view",)`); do NOT add either resource to partner/vendor or worker/external roles. The result must match the migration's `ASSET_GRANTS`/`MODEL_GRANTS` exactly — `seed_default_grants` is what conftest restores between tests, so any mismatch shows up as flaky permission tests.

- [ ] **Step 4: Run the two tests again**

Run: same command as Step 2.
Expected: PASS (test_client_contact_scoped_list_and_403s still fails — the router doesn't exist until Task 5; run only the two named tests).

- [ ] **Step 5: Run the access registry suite (it asserts registry invariants)**

Run: `.venv/bin/pytest tests/test_access_registry.py tests/test_access_resolver.py tests/test_access_scope.py -q`
Expected: PASS. If test_access_registry asserts an exact resource list, extend its expected set with `assets` and `asset_models`.

- [ ] **Step 6: Commit**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A api && git commit -m "feat(api): access wiring for assets + asset_models resources

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Dual-unit conversion helper

**Files:**
- Create: `api/src/serversherpa/assets/__init__.py` (empty)
- Create: `api/src/serversherpa/assets/units.py`
- Test: `api/tests/test_assets_units.py`

**Interfaces:**
- Produces: `apply_unit_pairs(data: dict) -> dict` — mutates+returns a payload dict, filling the missing side of each (imperial, metric) pair. Used by both routers' create/patch paths. `UNIT_PAIRS` is importable for schema field lists.

- [ ] **Step 1: Write the failing test**

`api/tests/test_assets_units.py`:

```python
"""apply_unit_pairs — the one place unit conversion happens."""

from serversherpa.assets.units import apply_unit_pairs


def test_lbs_fills_kg():
    data = apply_unit_pairs({"weight_lbs": 50.0})
    assert data["weight_kg"] == 22.68          # 50 * 0.453592 = 22.6796


def test_kg_fills_lbs():
    data = apply_unit_pairs({"weight_kg": 10.0})
    assert data["weight_lbs"] == 22.05         # 10 / 0.453592 = 22.0462


def test_both_present_stored_as_sent():
    data = apply_unit_pairs({"weight_lbs": 50.0, "weight_kg": 23.0})
    assert data == {"weight_lbs": 50.0, "weight_kg": 23.0}


def test_dimensions_pair_componentwise():
    data = apply_unit_pairs({"length_in": 32.0, "width_in": 1.5, "height_in": 18.5})
    assert data["length_cm"] == 81.28
    assert data["width_cm"] == 3.81
    assert data["height_cm"] == 46.99


def test_cm_to_inches():
    data = apply_unit_pairs({"length_cm": 100.0})
    assert data["length_in"] == 39.37


def test_none_clears_partner():
    data = apply_unit_pairs({"weight_lbs": None})
    assert data["weight_kg"] is None


def test_untouched_fields_pass_through():
    data = apply_unit_pairs({"make": "Dell", "ru_size": 2})
    assert data == {"make": "Dell", "ru_size": 2}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/api" && .venv/bin/pytest tests/test_assets_units.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'serversherpa.assets'`.

- [ ] **Step 3: Implement**

`api/src/serversherpa/assets/units.py`:

```python
"""Dual-unit fields: the client enters either unit system; the server
computes the partner so both are stored and exports never convert.

Rule (from the spec): if exactly one side of a pair is present in the
payload, compute the other; if both are present, store both as sent
(imports send both); None clears the pair."""

LB_TO_KG = 0.453592
IN_TO_CM = 2.54

UNIT_PAIRS: tuple[tuple[str, str, float], ...] = (
    ("weight_lbs", "weight_kg", LB_TO_KG),
    ("length_in", "length_cm", IN_TO_CM),
    ("width_in", "width_cm", IN_TO_CM),
    ("height_in", "height_cm", IN_TO_CM),
)


def apply_unit_pairs(data: dict) -> dict:
    for imperial, metric, factor in UNIT_PAIRS:
        if imperial in data and metric not in data:
            data[metric] = (None if data[imperial] is None
                            else round(float(data[imperial]) * factor, 2))
        elif metric in data and imperial not in data:
            data[imperial] = (None if data[metric] is None
                              else round(float(data[metric]) / factor, 2))
    return data
```

- [ ] **Step 4: Run to verify pass**

Run: same command. Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A api && git commit -m "feat(api): dual-unit conversion helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Schemas + asset-models (catalog) router

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (append an `── assets ──` section)
- Create: `api/src/serversherpa/api/routes/asset_models.py`
- Modify: `api/src/serversherpa/api/app.py` (imports + `include_router`)
- Test: `api/tests/test_asset_models_api.py`

**Interfaces:**
- Consumes: `apply_unit_pairs` (Task 3), models (Task 1), grants (Task 2).
- Produces: `GET/POST /asset-models`, `PATCH /asset-models/{id}`, `PUT /asset-models/{id}/aliases`, `GET /asset-categories`; schemas `AssetModelItem`, `AssetModelCreateIn`, `AssetModelUpdateIn`, `AssetModelAliasesIn`, `AssetCategoryOut`, `AssetModelRef` (the summary embedded in asset payloads — Task 5 depends on it).

- [ ] **Step 1: Write the failing test**

`api/tests/test_asset_models_api.py`:

```python
"""Asset-models catalog API: CRUD, unit computation, aliases, 409s."""

from sqlalchemy import select

from serversherpa.db.models import AssetModel, AssetModelAlias, AuditLog
from tests.test_assets_api import login


async def test_create_computes_partner_units(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/asset-models", headers=hdrs, json={
        "make": "Dell", "model": "R740", "category": "server", "ru_size": 2,
        "weight_lbs": 50, "length_in": 32, "width_in": 17.09, "height_in": 3.42,
        "mount_type": "rails", "rail_type": "B7", "knowledge": "Slide latches stick."})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["weight_kg"] == 22.68
    assert body["length_cm"] == 81.28
    assert body["category_label"] == "Server"
    assert body["aliases"] == []

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset_model", AuditLog.action == "create"))
    assert row is not None and row.entity_id == body["id"]


async def test_metric_entry_computes_imperial(client, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/asset-models", headers=hdrs, json={
        "make": "HPE", "model": "DL380", "weight_kg": 20})
    assert resp.status_code == 201
    assert resp.json()["weight_lbs"] == 44.09


async def test_duplicate_make_model_409(client, seeded_user):
    hdrs = await login(client)
    await client.post("/asset-models", headers=hdrs,
                      json={"make": "Dell", "model": "R640"})
    resp = await client.post("/asset-models", headers=hdrs,
                             json={"make": "dell", "model": "r640"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "duplicate_model"


async def test_unknown_category_and_mount_422(client, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/asset-models", headers=hdrs, json={
        "make": "X", "model": "Y", "category": "spaceship"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_category"
    resp = await client.post("/asset-models", headers=hdrs, json={
        "make": "X", "model": "Y", "mount_type": "sticky_tape"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_mount_type"


async def test_patch_recomputes_changed_side(client, db, seeded_user):
    hdrs = await login(client)
    created = (await client.post("/asset-models", headers=hdrs, json={
        "make": "Dell", "model": "R750", "weight_lbs": 50})).json()
    resp = await client.patch(f"/asset-models/{created['id']}", headers=hdrs,
                              json={"weight_kg": 30})
    assert resp.status_code == 200
    assert resp.json()["weight_kg"] == 30
    assert resp.json()["weight_lbs"] == 66.14      # recomputed from changed side


async def test_aliases_put_replaces_and_conflicts(client, db, seeded_user):
    hdrs = await login(client)
    m1 = (await client.post("/asset-models", headers=hdrs,
                            json={"make": "Dell", "model": "R840"})).json()
    m2 = (await client.post("/asset-models", headers=hdrs,
                            json={"make": "Dell", "model": "R940"})).json()

    resp = await client.put(f"/asset-models/{m1['id']}/aliases", headers=hdrs,
                            json={"aliases": ["PowerEdge R840", "PE-R840"]})
    assert resp.status_code == 200
    assert sorted(resp.json()["aliases"]) == ["PE-R840", "PowerEdge R840"]

    # replace: old alias gone, new one in
    resp = await client.put(f"/asset-models/{m1['id']}/aliases", headers=hdrs,
                            json={"aliases": ["PE-R840"]})
    assert resp.json()["aliases"] == ["PE-R840"]

    # another model claiming it → 409 with the owner named
    resp = await client.put(f"/asset-models/{m2['id']}/aliases", headers=hdrs,
                            json={"aliases": ["pe-r840"]})     # CITEXT clash
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "alias_in_use"


async def test_categories_endpoint(client, seeded_user):
    hdrs = await login(client)
    cats = (await client.get("/asset-categories", headers=hdrs)).json()
    assert [c["key"] for c in cats][:2] == ["server", "storage"]   # sort_order
    assert all(c["color"].startswith("#") for c in cats)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/api" && .venv/bin/pytest tests/test_asset_models_api.py -q`
Expected: FAIL — 404s (router not registered).

- [ ] **Step 3: Add schemas**

Append to `api/src/serversherpa/api/schemas.py` (after the sites section):

```python
# ── assets ─────────────────────────────────────────────────────────


class AssetCategoryOut(BaseModel):
    key: str
    label: str
    description: str
    sort_order: int
    color: str
    model_config = ConfigDict(from_attributes=True)


class AssetModelRef(BaseModel):
    """Read-only catalog summary embedded in asset payloads — this is all a
    client-anchored actor ever sees of the catalog (no knowledge field)."""

    id: uuid.UUID
    make: str
    model: str
    category: str | None = None
    category_label: str | None = None
    category_color: str | None = None
    ru_size: int | None = None


class AssetModelItem(BaseModel):
    id: uuid.UUID
    make: str
    model: str
    category: str | None = None
    category_label: str | None = None
    category_color: str | None = None
    ru_size: int | None = None
    weight_lbs: float | None = None
    weight_kg: float | None = None
    length_in: float | None = None
    width_in: float | None = None
    height_in: float | None = None
    length_cm: float | None = None
    width_cm: float | None = None
    height_cm: float | None = None
    mount_type: str | None = None
    rail_type: str | None = None
    knowledge: str
    aliases: list[str] = []
    created_at: datetime
    updated_at: datetime


class AssetModelCreateIn(BaseModel):
    make: str = Field(min_length=1)
    model: str = Field(min_length=1)
    category: str | None = None
    ru_size: int | None = Field(default=None, ge=0, le=100)
    weight_lbs: float | None = Field(default=None, ge=0)
    weight_kg: float | None = Field(default=None, ge=0)
    length_in: float | None = Field(default=None, ge=0)
    width_in: float | None = Field(default=None, ge=0)
    height_in: float | None = Field(default=None, ge=0)
    length_cm: float | None = Field(default=None, ge=0)
    width_cm: float | None = Field(default=None, ge=0)
    height_cm: float | None = Field(default=None, ge=0)
    mount_type: str | None = None
    rail_type: str | None = None
    knowledge: str = ""
    model_config = ConfigDict(extra="forbid")


class AssetModelUpdateIn(BaseModel):
    make: str | None = None
    model: str | None = None
    category: str | None = None
    ru_size: int | None = Field(default=None, ge=0, le=100)
    weight_lbs: float | None = Field(default=None, ge=0)
    weight_kg: float | None = Field(default=None, ge=0)
    length_in: float | None = Field(default=None, ge=0)
    width_in: float | None = Field(default=None, ge=0)
    height_in: float | None = Field(default=None, ge=0)
    length_cm: float | None = Field(default=None, ge=0)
    width_cm: float | None = Field(default=None, ge=0)
    height_cm: float | None = Field(default=None, ge=0)
    mount_type: str | None = None
    rail_type: str | None = None
    knowledge: str | None = None
    model_config = ConfigDict(extra="forbid")


class AssetModelAliasesIn(BaseModel):
    aliases: list[str]
```

(Pydantic quirk to preserve: `model_config`/`model` field names are fine — Pydantic only reserves `model_` prefixed attribute names on the class, and `model` alone is allowed. If a `model_` warning appears, set `model_config = ConfigDict(extra="forbid", protected_namespaces=())` on the affected schemas.)

- [ ] **Step 4: Implement the router**

`api/src/serversherpa/api/routes/asset_models.py`:

```python
"""Asset make/model catalog — the hardware knowledge base (legacy
assets_make_model). Internal-only resource: client actors see a summary
embedded in asset payloads, never these endpoints."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    AssetCategoryOut, AssetModelAliasesIn, AssetModelCreateIn,
    AssetModelItem, AssetModelUpdateIn,
)
from serversherpa.assets.units import apply_unit_pairs
from serversherpa.db.models import AssetCategory, AssetModel, AssetModelAlias
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/asset-models", tags=["assets"])
categories_router = APIRouter(tags=["assets"])

MOUNT_TYPES = ("rails", "ears", "shelf", "custom")

MODEL_FIELDS = [
    "make", "model", "category", "ru_size",
    "weight_lbs", "weight_kg", "length_in", "width_in", "height_in",
    "length_cm", "width_cm", "height_cm", "mount_type", "rail_type", "knowledge",
]
NON_NULLABLE_MODEL_FIELDS = ("make", "model")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _require_global(actor: AuthContext) -> None:
    if not actor.access.is_global:
        raise _err(403, "forbidden")


async def _cats(db: DbSession) -> dict:
    return {c.key: (c.label, c.color)
            for c in await db.scalars(select(AssetCategory))}


async def _aliases_by_model(db: DbSession, model_ids: list[uuid.UUID]) -> dict:
    if not model_ids:
        return {}
    rows = (await db.execute(
        select(AssetModelAlias.model_id, AssetModelAlias.alias)
        .where(AssetModelAlias.model_id.in_(model_ids))
        .order_by(AssetModelAlias.alias))).all()
    out: dict = {}
    for model_id, alias in rows:
        out.setdefault(model_id, []).append(alias)
    return out


def _item(m: AssetModel, cats: dict, aliases: dict) -> dict:
    label, color = (cats.get(m.category, (m.category, "#51606f"))
                    if m.category is not None else (None, None))
    def f(v):
        return float(v) if v is not None else None
    return {
        "id": m.id, "make": m.make, "model": m.model,
        "category": m.category, "category_label": label, "category_color": color,
        "ru_size": m.ru_size,
        "weight_lbs": f(m.weight_lbs), "weight_kg": f(m.weight_kg),
        "length_in": f(m.length_in), "width_in": f(m.width_in),
        "height_in": f(m.height_in), "length_cm": f(m.length_cm),
        "width_cm": f(m.width_cm), "height_cm": f(m.height_cm),
        "mount_type": m.mount_type, "rail_type": m.rail_type,
        "knowledge": m.knowledge, "aliases": aliases.get(m.id, []),
        "created_at": m.created_at, "updated_at": m.updated_at,
    }


async def _detail(db: DbSession, m: AssetModel) -> AssetModelItem:
    cats = await _cats(db)
    aliases = await _aliases_by_model(db, [m.id])
    return AssetModelItem(**_item(m, cats, aliases))


async def _validate(db: DbSession, data: dict) -> None:
    if data.get("category") is not None and \
            await db.get(AssetCategory, data["category"]) is None:
        raise _err(422, "unknown_category")
    if data.get("mount_type") is not None and \
            data["mount_type"] not in MOUNT_TYPES:
        raise _err(422, "unknown_mount_type")


async def _check_duplicate(db: DbSession, make: str, model: str,
                           exclude: uuid.UUID | None = None) -> None:
    query = select(AssetModel.id).where(
        AssetModel.make == make, AssetModel.model == model)
    if exclude is not None:
        query = query.where(AssetModel.id != exclude)
    if await db.scalar(query) is not None:
        raise _err(409, "duplicate_model")


@router.get("", response_model=list[AssetModelItem])
async def list_asset_models(
    db: DbSession,
    _actor: AuthContext = require_permission("asset_models", "view"),
) -> list[AssetModelItem]:
    models = (await db.scalars(
        select(AssetModel).order_by(AssetModel.make, AssetModel.model))).all()
    cats = await _cats(db)
    aliases = await _aliases_by_model(db, [m.id for m in models])
    return [AssetModelItem(**_item(m, cats, aliases)) for m in models]


@router.get("/{model_id}", response_model=AssetModelItem)
async def get_asset_model(
    model_id: uuid.UUID,
    db: DbSession,
    _actor: AuthContext = require_permission("asset_models", "view"),
) -> AssetModelItem:
    m = await db.get(AssetModel, model_id)
    if m is None:
        raise _err(404, "asset_model_not_found")
    return await _detail(db, m)


@router.post("", response_model=AssetModelItem, status_code=201)
async def create_asset_model(
    body: AssetModelCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("asset_models", "add"),
) -> AssetModelItem:
    _require_global(actor)
    data = apply_unit_pairs(body.model_dump(exclude_unset=True))
    await _validate(db, data)
    await _check_duplicate(db, data["make"], data["model"])
    m = AssetModel(**data)
    db.add(m)
    await db.flush()
    initial = snapshot(m, MODEL_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items() if value not in (None, "")}
    audit(db, actor_id=actor.person.id, entity_type="asset_model",
          entity_id=str(m.id), action="create", changes=changes)
    await db.commit()
    return await _detail(db, m)


@router.patch("/{model_id}", response_model=AssetModelItem)
async def update_asset_model(
    model_id: uuid.UUID,
    body: AssetModelUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("asset_models", "change"),
) -> AssetModelItem:
    _require_global(actor)
    m = await db.get(AssetModel, model_id)
    if m is None:
        raise _err(404, "asset_model_not_found")
    data = apply_unit_pairs(body.model_dump(exclude_unset=True))
    for field in NON_NULLABLE_MODEL_FIELDS:
        if field in data and not data[field]:
            raise _err(422, f"{field}_required")
    await _validate(db, data)
    await _check_duplicate(db, data.get("make", m.make),
                           data.get("model", m.model), exclude=m.id)

    fields = list(data.keys())
    before = snapshot(m, fields)
    for field, value in data.items():
        setattr(m, field, value)
    changes = diff(before, snapshot(m, fields))
    if changes:
        m.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="asset_model",
              entity_id=str(model_id), action="update", changes=changes)
    await db.commit()
    return await _detail(db, m)


@router.put("/{model_id}/aliases", response_model=AssetModelItem)
async def set_asset_model_aliases(
    model_id: uuid.UUID,
    body: AssetModelAliasesIn,
    db: DbSession,
    actor: AuthContext = require_permission("asset_models", "change"),
) -> AssetModelItem:
    _require_global(actor)
    m = await db.get(AssetModel, model_id)
    if m is None:
        raise _err(404, "asset_model_not_found")
    desired = {a.strip() for a in body.aliases if a.strip()}

    # global uniqueness: an alias owned by ANOTHER model is a conflict
    if desired:
        clash = await db.scalar(
            select(AssetModelAlias.alias).where(
                AssetModelAlias.alias.in_(desired),
                AssetModelAlias.model_id != model_id))
        if clash is not None:
            raise _err(409, "alias_in_use", alias=str(clash))

    current = set(await db.scalars(
        select(AssetModelAlias.alias).where(AssetModelAlias.model_id == model_id)))
    # CITEXT compares case-insensitively in SQL, but the Python sets above are
    # case-sensitive — normalise via lowercase maps for the diff.
    cur_map = {a.lower(): a for a in current}
    des_map = {a.lower(): a for a in desired}
    removed = [cur_map[k] for k in cur_map.keys() - des_map.keys()]
    added = [des_map[k] for k in des_map.keys() - cur_map.keys()]
    for alias in removed:
        await db.execute(AssetModelAlias.__table__.delete().where(
            AssetModelAlias.model_id == model_id, AssetModelAlias.alias == alias))
    for alias in added:
        db.add(AssetModelAlias(model_id=model_id, alias=alias))
    if added or removed:
        audit(db, actor_id=actor.person.id, entity_type="asset_model",
              entity_id=str(model_id), action="aliases.set",
              changes={"added": sorted(added), "removed": sorted(removed)})
    await db.commit()
    return await _detail(db, m)


@categories_router.get("/asset-categories", response_model=list[AssetCategoryOut])
async def list_asset_categories(
    db: DbSession,
    _actor: AuthContext = require_permission("asset_models", "view"),
) -> list[AssetCategoryOut]:
    cats = (await db.scalars(
        select(AssetCategory).order_by(AssetCategory.sort_order,
                                       AssetCategory.label))).all()
    return [AssetCategoryOut.model_validate(c) for c in cats]
```

- [ ] **Step 5: Register the routers**

In `api/src/serversherpa/api/app.py`: add `asset_models` to the `from serversherpa.api.routes import (…)` block, and after `app.include_router(sites.lookups_router)` add:

```python
    app.include_router(asset_models.router)
    app.include_router(asset_models.categories_router)
```

- [ ] **Step 6: Run to verify pass**

Run: `.venv/bin/pytest tests/test_asset_models_api.py -q`
Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A api && git commit -m "feat(api): asset-models catalog router with dual-unit compute and aliases

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Assets registry router

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (asset schemas)
- Create: `api/src/serversherpa/api/routes/assets.py`
- Modify: `api/src/serversherpa/api/app.py`
- Test: `api/tests/test_assets_api.py` (extend), `api/tests/test_assets_write.py` (new)

**Interfaces:**
- Consumes: `AssetModelRef` (Task 4), scope map (Task 2).
- Produces: `GET /assets`, `GET /assets/{id}`, `POST /assets`, `PATCH /assets/{id}`, `POST /assets/{id}/archive|unarchive`; schemas `AssetItem`, `AssetCreateIn`, `AssetUpdateIn`. `AssetItem.model` is an embedded `AssetModelRef | None`.

- [ ] **Step 1: Extend the read tests**

Append to `api/tests/test_assets_api.py`:

```python
async def test_list_embeds_labels_and_model_summary(client, db, seeded_user):
    hdrs = await login(client)
    m = AssetModel(make="Dell", model="R740", category="server", ru_size=2)
    org = Client(name="Acme L")
    site = Site(name="DC-1")
    db.add_all([m, org, site])
    await db.flush()
    db.add(Asset(serial_number="SN-100", name="web-01", model_id=m.id,
                 client_id=org.id, site_id=site.id, status="active",
                 location_detail="Hall B, Rack 14"))
    await db.commit()

    rows = (await client.get("/assets", headers=hdrs)).json()
    assert len(rows) == 1
    row = rows[0]
    assert row["serial_number"] == "SN-100"
    assert row["status_label"] == "Active" and row["status_color"] == "#178a4c"
    assert row["client_name"] == "Acme L"
    assert row["site_name"] == "DC-1"
    assert row["model"]["make"] == "Dell"
    assert row["model"]["category_label"] == "Server"
    assert "knowledge" not in row["model"]        # summary only — house IP


async def test_client_contact_gets_model_summary_but_not_catalog(client, db, seeded_user):
    org, hdrs = await _client_contact(db, client, "Acme MS", "ms@acme.example.com")
    m = AssetModel(make="Dell", model="R640")
    db.add(m)
    await db.flush()
    db.add(Asset(name="mine", client_id=org.id, model_id=m.id))
    await db.commit()

    rows = (await client.get("/assets", headers=hdrs)).json()
    assert rows[0]["model"]["make"] == "Dell"     # embedded summary works
    assert (await client.get("/asset-models", headers=hdrs)).status_code == 403
```

- [ ] **Step 2: Write the write-path tests**

`api/tests/test_assets_write.py`:

```python
"""Assets write paths: create/patch/archive, audit, validation, 403s."""

from sqlalchemy import select

from serversherpa.db.models import Asset, AssetModel, AuditLog, Client, Person, PersonRole
from tests.test_assets_api import login, make_login


async def test_create_update_archive_with_audit(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/assets", headers=hdrs, json={
        "serial_number": "SN-1", "name": "db-01", "status": "active",
        "location_detail": "Rack 4, RU 10"})
    assert resp.status_code == 201, resp.text
    asset_id = resp.json()["id"]
    assert resp.json()["status_label"] == "Active"

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "create"))
    assert row is not None and row.entity_id == asset_id

    resp = await client.patch(f"/assets/{asset_id}", headers=hdrs,
                              json={"location_detail": "Rack 5, RU 2"})
    assert resp.status_code == 200
    upd = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "update"))
    assert upd.changes["location_detail"]["to"] == "Rack 5, RU 2"

    assert (await client.post(f"/assets/{asset_id}/archive",
                              headers=hdrs)).status_code == 204
    assert (await client.post(f"/assets/{asset_id}/unarchive",
                              headers=hdrs)).status_code == 204


async def test_default_status_applied(client, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/assets", headers=hdrs, json={"name": "mystery"})
    assert resp.status_code == 201
    assert resp.json()["status"] == "unknown"


async def test_unknown_refs_rejected(client, seeded_user):
    hdrs = await login(client)
    ghost = "00000000-0000-0000-0000-000000000000"
    for field, code in (("model_id", "asset_model_not_found"),
                        ("client_id", "client_not_found"),
                        ("site_id", "site_not_found")):
        resp = await client.post("/assets", headers=hdrs,
                                 json={"name": "x", field: ghost})
        assert resp.status_code == 422, (field, resp.text)
        assert resp.json()["detail"]["code"] == code
    resp = await client.post("/assets", headers=hdrs,
                             json={"name": "x", "status": "nope"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_status"


async def test_rfid_conflict_409(client, seeded_user):
    hdrs = await login(client)
    await client.post("/assets", headers=hdrs, json={"name": "a", "rfid_tag": "T1"})
    resp = await client.post("/assets", headers=hdrs,
                             json={"name": "b", "rfid_tag": "t1"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "rfid_tag_in_use"


async def test_duplicate_serial_allowed_via_api(client, seeded_user):
    hdrs = await login(client)
    assert (await client.post("/assets", headers=hdrs,
                              json={"serial_number": "DUP"})).status_code == 201
    assert (await client.post("/assets", headers=hdrs,
                              json={"serial_number": "DUP"})).status_code == 201


async def test_noop_patch_writes_no_audit(client, db, seeded_user):
    hdrs = await login(client)
    created = (await client.post("/assets", headers=hdrs,
                                 json={"name": "same"})).json()
    before = created["created_at"]
    resp = await client.patch(f"/assets/{created['id']}", headers=hdrs,
                              json={"name": "same"})
    assert resp.status_code == 200
    upd = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "update"))
    assert upd is None
    asset = await db.get(Asset, created["id"])
    assert asset.updated_at.isoformat() != ""     # untouched (equals created_at)
    assert asset.created_at.isoformat().startswith(before[:19])


async def test_client_contact_cannot_write(client, db, seeded_user):
    """Client tiers are read-only, even with an override — the write paths
    are _require_global (same posture as sites)."""
    from serversherpa.db.models import PermissionOverride

    org = Client(name="Acme W")
    db.add(org)
    await db.flush()
    contact = Person(first_name="C", last_name="W")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_admin", client_id=org.id))
    db.add(PermissionOverride(person_id=contact.id, resource="assets",
                              action="add", allow=True))
    db.add(PermissionOverride(person_id=contact.id, resource="assets",
                              action="change", allow=True))
    await db.commit()
    hdrs = await make_login(db, client, contact, "w@acme.example.com")

    resp = await client.post("/assets", headers=hdrs, json={"name": "sneaky"})
    assert resp.status_code == 403

    mine = Asset(name="mine", client_id=org.id)
    db.add(mine)
    await db.commit()
    resp = await client.patch(f"/assets/{mine.id}", headers=hdrs,
                              json={"name": "renamed"})
    assert resp.status_code == 403
```

- [ ] **Step 3: Run to verify failure**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/api" && .venv/bin/pytest tests/test_assets_api.py tests/test_assets_write.py -q`
Expected: FAIL — 404s (no router).

- [ ] **Step 4: Add asset schemas**

Append to the assets section of `api/src/serversherpa/api/schemas.py`:

```python
class AssetItem(BaseModel):
    id: uuid.UUID
    serial_number: str | None = None
    name: str | None = None
    rfid_tag: str | None = None
    model_id: uuid.UUID | None = None
    model: AssetModelRef | None = None
    client_id: uuid.UUID | None = None
    client_name: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    location_detail: str
    status: str
    status_label: str
    status_color: str
    has_rails: bool | None = None
    last_seen_at: datetime | None = None
    archived_at: datetime | None = None
    created_at: datetime


class AssetCreateIn(BaseModel):
    serial_number: str | None = None
    name: str | None = None
    rfid_tag: str | None = None
    model_id: uuid.UUID | None = None
    client_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    location_detail: str = ""
    status: str | None = None
    has_rails: bool | None = None
    model_config = ConfigDict(extra="forbid")


class AssetUpdateIn(BaseModel):
    serial_number: str | None = None
    name: str | None = None
    rfid_tag: str | None = None
    model_id: uuid.UUID | None = None
    client_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    location_detail: str | None = None
    status: str | None = None
    has_rails: bool | None = None
    model_config = ConfigDict(extra="forbid")
```

- [ ] **Step 5: Implement the router**

`api/src/serversherpa/api/routes/assets.py`:

```python
"""Assets — the core hardware registry (legacy BaseCamp assets). Client
org roles see their own org's rows read-only (SCOPE_COLUMNS); all writes
are globally anchored. The embedded model summary (AssetModelRef) is the
only catalog surface a client actor ever receives."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    AssetCreateIn, AssetItem, AssetModelRef, AssetUpdateIn,
)
from serversherpa.db.models import (
    Asset, AssetCategory, AssetModel, Client, Site, StatusValue,
)
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/assets", tags=["assets"])

ASSET_FIELDS = [
    "serial_number", "name", "rfid_tag", "model_id", "client_id", "site_id",
    "location_detail", "status", "has_rails",
]
NON_NULLABLE_ASSET_FIELDS = ("location_detail", "status")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _require_global(actor: AuthContext) -> None:
    if not actor.access.is_global:
        raise _err(403, "forbidden")


async def _get_asset(db: DbSession, asset_id: uuid.UUID, actor: AuthContext) -> Asset:
    """404 for missing AND out-of-scope — an actor must not learn an id exists."""
    asset = await db.get(Asset, asset_id)
    if asset is None:
        raise _err(404, "asset_not_found")
    cond = scope_conditions("assets", actor.access, actor.person.id)
    if cond is not None:
        visible = await db.scalar(select(Asset.id).where(Asset.id == asset_id, cond))
        if visible is None:
            raise _err(404, "asset_not_found")
    return asset


async def _statuses(db: DbSession) -> dict:
    return {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))}


async def _model_refs(db: DbSession, model_ids: set[uuid.UUID]) -> dict:
    if not model_ids:
        return {}
    cats = {c.key: (c.label, c.color)
            for c in await db.scalars(select(AssetCategory))}
    models = (await db.scalars(
        select(AssetModel).where(AssetModel.id.in_(model_ids)))).all()
    out = {}
    for m in models:
        label, color = (cats.get(m.category, (m.category, "#51606f"))
                        if m.category is not None else (None, None))
        out[m.id] = AssetModelRef(
            id=m.id, make=m.make, model=m.model, category=m.category,
            category_label=label, category_color=color, ru_size=m.ru_size)
    return out


def _item(a: Asset, statuses: dict, models: dict, clients: dict,
          sites: dict) -> dict:
    label, color = statuses.get(a.status, (a.status, "#51606f"))
    return {
        "id": a.id, "serial_number": a.serial_number, "name": a.name,
        "rfid_tag": a.rfid_tag, "model_id": a.model_id,
        "model": models.get(a.model_id),
        "client_id": a.client_id, "client_name": clients.get(a.client_id),
        "site_id": a.site_id, "site_name": sites.get(a.site_id),
        "location_detail": a.location_detail,
        "status": a.status, "status_label": label, "status_color": color,
        "has_rails": a.has_rails, "last_seen_at": a.last_seen_at,
        "archived_at": a.archived_at, "created_at": a.created_at,
    }


async def _context(db: DbSession, assets: list[Asset]) -> tuple:
    statuses = await _statuses(db)
    models = await _model_refs(db, {a.model_id for a in assets if a.model_id})
    client_ids = {a.client_id for a in assets if a.client_id}
    clients = dict((await db.execute(
        select(Client.id, Client.name).where(Client.id.in_(client_ids))
    )).all()) if client_ids else {}
    site_ids = {a.site_id for a in assets if a.site_id}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids))
    )).all()) if site_ids else {}
    return statuses, models, clients, sites


async def _detail(db: DbSession, asset: Asset) -> AssetItem:
    statuses, models, clients, sites = await _context(db, [asset])
    return AssetItem(**_item(asset, statuses, models, clients, sites))


@router.get("", response_model=list[AssetItem])
async def list_assets(
    db: DbSession,
    actor: AuthContext = require_permission("assets", "view"),
) -> list[AssetItem]:
    query = select(Asset).order_by(Asset.created_at.desc())
    cond = scope_conditions("assets", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    assets = (await db.scalars(query)).all()
    statuses, models, clients, sites = await _context(db, list(assets))
    return [AssetItem(**_item(a, statuses, models, clients, sites))
            for a in assets]


@router.get("/{asset_id}", response_model=AssetItem)
async def get_asset(
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "view"),
) -> AssetItem:
    asset = await _get_asset(db, asset_id, actor)
    return await _detail(db, asset)


async def _check_refs(db: DbSession, data: dict) -> None:
    if data.get("model_id") is not None and \
            await db.get(AssetModel, data["model_id"]) is None:
        raise _err(422, "asset_model_not_found")
    if data.get("client_id") is not None and \
            await db.get(Client, data["client_id"]) is None:
        raise _err(422, "client_not_found")
    if data.get("site_id") is not None and \
            await db.get(Site, data["site_id"]) is None:
        raise _err(422, "site_not_found")
    if data.get("status") is not None and await db.scalar(
        select(StatusValue).where(StatusValue.record_type == "asset",
                                  StatusValue.key == data["status"])) is None:
        raise _err(422, "unknown_status")


async def _check_rfid(db: DbSession, tag: str | None,
                      exclude: uuid.UUID | None = None) -> None:
    if tag is None:
        return
    query = select(Asset.id).where(Asset.rfid_tag == tag)
    if exclude is not None:
        query = query.where(Asset.id != exclude)
    if await db.scalar(query) is not None:
        raise _err(409, "rfid_tag_in_use")


@router.post("", response_model=AssetItem, status_code=201)
async def create_asset(
    body: AssetCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "add"),
) -> AssetItem:
    _require_global(actor)
    data = body.model_dump(exclude_none=True)
    await _check_refs(db, data)
    await _check_rfid(db, data.get("rfid_tag"))
    asset = Asset(**data, created_by=actor.person.id)
    db.add(asset)
    await db.flush()
    initial = snapshot(asset, ASSET_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items() if value not in (None, "")}
    audit(db, actor_id=actor.person.id, entity_type="asset",
          entity_id=str(asset.id), action="create", changes=changes)
    await db.commit()
    return await _detail(db, asset)


@router.patch("/{asset_id}", response_model=AssetItem)
async def update_asset(
    asset_id: uuid.UUID,
    body: AssetUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "change"),
) -> AssetItem:
    _require_global(actor)
    asset = await _get_asset(db, asset_id, actor)
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_ASSET_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    await _check_refs(db, data)
    if "rfid_tag" in data:
        await _check_rfid(db, data["rfid_tag"], exclude=asset_id)

    fields = list(data.keys())
    before = snapshot(asset, fields)
    for field, value in data.items():
        setattr(asset, field, value)
    changes = diff(before, snapshot(asset, fields))
    if changes:
        asset.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="asset",
              entity_id=str(asset_id), action="update", changes=changes)
    await db.commit()
    return await _detail(db, asset)


@router.post("/{asset_id}/archive", status_code=204)
async def archive_asset(
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "change"),
) -> None:
    _require_global(actor)
    asset = await _get_asset(db, asset_id, actor)
    asset.archived_at = datetime.now(UTC)
    asset.updated_at = asset.archived_at
    audit(db, actor_id=actor.person.id, entity_type="asset",
          entity_id=str(asset_id), action="archive")
    await db.commit()


@router.post("/{asset_id}/unarchive", status_code=204)
async def unarchive_asset(
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "change"),
) -> None:
    _require_global(actor)
    asset = await _get_asset(db, asset_id, actor)
    asset.archived_at = None
    asset.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="asset",
          entity_id=str(asset_id), action="restore")
    await db.commit()
```

Register in `app.py`: add `assets` to the routes import and `app.include_router(assets.router)` next to the asset_models routers.

- [ ] **Step 6: Run to verify pass**

Run: `.venv/bin/pytest tests/test_assets_api.py tests/test_assets_write.py -q`
Expected: PASS (all tests both files).

- [ ] **Step 7: Commit**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A api && git commit -m "feat(api): assets registry router with client scoping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Global search sections

**Files:**
- Modify: `api/src/serversherpa/api/routes/search.py`
- Test: `api/tests/test_search_assets.py`

**Interfaces:**
- Produces: `/search?q=` returns `kind="asset"` hits (matching serial_number, name, rfid_tag; scoped) and `kind="asset_model"` hits (matching make, model, or alias; internal-only).

- [ ] **Step 1: Write the failing test**

`api/tests/test_search_assets.py`:

```python
"""Global search: asset + asset_model sections, permission- and row-scoped."""

from serversherpa.db.models import Asset, AssetModel, AssetModelAlias
from tests.test_assets_api import _client_contact, login


async def test_search_finds_assets_and_models(client, db, seeded_user):
    hdrs = await login(client)
    m = AssetModel(make="Dell", model="R740")
    db.add(m)
    await db.flush()
    db.add(AssetModelAlias(model_id=m.id, alias="PowerEdge 740"))
    db.add(Asset(serial_number="SN-R740-1", name="web-01", model_id=m.id))
    await db.commit()

    body = (await client.get("/search?q=R740", headers=hdrs)).json()
    kinds = {(r["kind"], r["label"]) for r in body["results"]}
    assert ("asset", "SN-R740-1") in kinds or ("asset", "web-01") in kinds
    assert ("asset_model", "Dell R740") in kinds

    # alias text also finds the model
    body = (await client.get("/search?q=PowerEdge", headers=hdrs)).json()
    assert any(r["kind"] == "asset_model" for r in body["results"])


async def test_search_scopes_assets_and_hides_catalog(client, db, seeded_user):
    org, hdrs = await _client_contact(db, client, "Acme SR", "sr@acme.example.com")
    from serversherpa.db.models import Client
    other = Client(name="Other SR")
    db.add(other)
    await db.flush()
    db.add_all([
        Asset(serial_number="FINDME-1", client_id=org.id),
        Asset(serial_number="FINDME-2", client_id=other.id),
    ])
    m = AssetModel(make="Findme", model="Z1")
    db.add(m)
    await db.commit()

    body = (await client.get("/search?q=FINDME", headers=hdrs)).json()
    labels = [r["label"] for r in body["results"] if r["kind"] == "asset"]
    assert labels == ["FINDME-1"]                     # own org only
    assert not any(r["kind"] == "asset_model" for r in body["results"])
```

- [ ] **Step 2: Run to verify failure**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/api" && .venv/bin/pytest tests/test_search_assets.py -q`
Expected: FAIL — no asset kinds in results.

- [ ] **Step 3: Implement**

In `api/src/serversherpa/api/routes/search.py`: extend the models import with `Asset, AssetModel, AssetModelAlias`, and insert before `return SearchOut(results=results)`:

```python
    # assets — serial / name / rfid; row-scoped for client actors
    if user.access.can("assets", "view"):
        query = select(Asset).where(or_(
            Asset.serial_number.ilike(needle),
            Asset.name.ilike(needle),
            Asset.rfid_tag.ilike(needle),
        ))
        cond = scope_conditions("assets", user.access, user.person.id)
        if cond is not None:
            query = query.where(cond)
        assets = (await db.scalars(
            query.order_by(Asset.serial_number, Asset.name)
            .limit(LIMIT_PER_KIND))).all()
        results.extend(
            SearchResult(kind="asset", id=a.id,
                         label=a.serial_number or a.name or str(a.id),
                         sub=a.name if a.serial_number else a.location_detail or None)
            for a in assets
        )

    # asset models — make / model / alias; internal-only resource
    if user.access.can("asset_models", "view"):
        alias_owner = select(AssetModelAlias.model_id).where(
            AssetModelAlias.alias.ilike(needle))
        query = select(AssetModel).where(or_(
            AssetModel.make.ilike(needle),
            AssetModel.model.ilike(needle),
            AssetModel.id.in_(alias_owner),
        ))
        models = (await db.scalars(
            query.order_by(AssetModel.make, AssetModel.model)
            .limit(LIMIT_PER_KIND))).all()
        results.extend(
            SearchResult(kind="asset_model", id=m.id,
                         label=f"{m.make} {m.model}", sub=m.category)
            for m in models
        )
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/pytest tests/test_search_assets.py tests/test_search_api.py -q`
Expected: PASS (new tests + existing search suite untouched).

- [ ] **Step 5: Commit**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A api && git commit -m "feat(api): global search sections for assets and asset models

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Notes router + attachments support for assets

**Files:**
- Create: `api/src/serversherpa/api/routes/notes.py`
- Modify: `api/src/serversherpa/api/routes/attachments.py` (asset entity type + scoped view)
- Modify: `api/src/serversherpa/api/app.py`
- Test: `api/tests/test_notes_api.py`

**Interfaces:**
- Produces: `GET /notes?entity_type=asset&entity_id=…`, `POST /notes`, `PATCH /notes/{id}`, `DELETE /notes/{id}` (soft); `NoteOut {id, entity_type, entity_id, body, created_by, author_name, created_at, updated_at}`; attachments accept `entity_type="asset"` with kinds `photo`/`document` (never `avatar`), and client-scoped actors can VIEW asset attachments/notes for in-scope assets.

- [ ] **Step 1: Write the failing test**

`api/tests/test_notes_api.py`:

```python
"""Global notes: CRUD on asset-hosted notes; permission derives from the
host entity's resource. Clients read their own assets' notes; staff write."""

from sqlalchemy import select

from serversherpa.db.models import Asset, AuditLog, Note
from tests.test_assets_api import _client_contact, login


async def _asset(db, **kw):
    a = Asset(name="host-1", **kw)
    db.add(a)
    await db.commit()
    return a


async def test_note_crud_with_audit(client, db, seeded_user):
    hdrs = await login(client)
    asset = await _asset(db)

    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "asset", "entity_id": str(asset.id),
        "body": "PSU replaced during staging."})
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["author_name"] == "Alice Anderson"

    row = await db.scalar(select(AuditLog).where(AuditLog.action == "note.add"))
    assert row is not None and row.entity_type == "asset"

    resp = await client.patch(f"/notes/{note['id']}", headers=hdrs,
                              json={"body": "PSU replaced. Rails bent."})
    assert resp.status_code == 200
    assert resp.json()["body"] == "PSU replaced. Rails bent."

    listing = (await client.get(
        f"/notes?entity_type=asset&entity_id={asset.id}", headers=hdrs)).json()
    assert len(listing) == 1

    resp = await client.delete(f"/notes/{note['id']}", headers=hdrs)
    assert resp.status_code == 204
    listing = (await client.get(
        f"/notes?entity_type=asset&entity_id={asset.id}", headers=hdrs)).json()
    assert listing == []                      # soft-deleted rows hidden
    assert (await db.get(Note, note["id"])).deleted_at is not None


async def test_unknown_entity_type_422(client, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "spaceship",
        "entity_id": "00000000-0000-0000-0000-000000000000", "body": "x"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_entity_type"


async def test_client_reads_own_asset_notes_cannot_write(client, db, seeded_user):
    org, hdrs = await _client_contact(db, client, "Acme N", "n@acme.example.com")
    staff_hdrs = await login(client)
    mine = await _asset(db, client_id=org.id)
    from serversherpa.db.models import Client
    other_org = Client(name="Other N")
    db.add(other_org)
    await db.flush()
    theirs = await _asset(db, client_id=other_org.id)

    for a in (mine, theirs):
        await client.post("/notes", headers=staff_hdrs, json={
            "entity_type": "asset", "entity_id": str(a.id), "body": "note"})

    resp = await client.get(
        f"/notes?entity_type=asset&entity_id={mine.id}", headers=hdrs)
    assert resp.status_code == 200 and len(resp.json()) == 1

    resp = await client.get(
        f"/notes?entity_type=asset&entity_id={theirs.id}", headers=hdrs)
    assert resp.status_code == 404            # out-of-scope host = 404

    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "asset", "entity_id": str(mine.id), "body": "hi"})
    assert resp.status_code == 403            # read-only tier


async def test_asset_attachment_upload_and_scoped_view(client, db, seeded_user):
    hdrs = await login(client)
    asset = await _asset(db)
    files = {"file": ("manual.pdf", b"%PDF-1.4 fake", "application/pdf")}
    resp = await client.post("/attachments", headers=hdrs, files=files, data={
        "entity_type": "asset", "entity_id": str(asset.id), "kind": "document"})
    assert resp.status_code in (200, 201), resp.text

    listing = await client.get(
        f"/attachments?entity_type=asset&entity_id={asset.id}", headers=hdrs)
    assert listing.status_code == 200
    assert listing.json()[0]["filename"] == "manual.pdf"

    resp = await client.post("/attachments", headers=hdrs, files={
        "file": ("x.png", b"png", "image/png")}, data={
        "entity_type": "asset", "entity_id": str(asset.id), "kind": "avatar"})
    assert resp.status_code == 422            # assets have no avatar slot
```

NOTE: the attachment test needs MinIO running (docker compose dev stack) — the existing `test_attachments.py` has the same dependency; mirror however it handles storage (if it stubs boto3, stub the same way; check its fixtures before writing this test and copy the approach).

- [ ] **Step 2: Run to verify failure**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/api" && .venv/bin/pytest tests/test_notes_api.py -q`
Expected: FAIL — 404 (no /notes router).

- [ ] **Step 3: Implement the notes router**

Add schemas to `api/src/serversherpa/api/schemas.py` (assets section):

```python
class NoteOut(BaseModel):
    id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    body: str
    created_by: uuid.UUID | None = None
    author_name: str | None = None
    created_at: datetime
    updated_at: datetime


class NoteCreateIn(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    body: str = Field(min_length=1)
    model_config = ConfigDict(extra="forbid")


class NoteUpdateIn(BaseModel):
    body: str = Field(min_length=1)
    model_config = ConfigDict(extra="forbid")
```

`api/src/serversherpa/api/routes/notes.py`:

```python
"""Global notes — polymorphic text notes on any registered host entity.
Permission derives from the HOST's resource: viewing notes requires viewing
the host row (scope included); writing requires change on the host resource
and a global anchor. Only 'asset' is registered in V1; new hosts are one
NOTE_HOSTS entry (plus grants) away."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, CurrentUser, DbSession
from serversherpa.api.schemas import NoteCreateIn, NoteOut, NoteUpdateIn
from serversherpa.db.models import Asset, Note, Person
from serversherpa.services.audit import audit

router = APIRouter(prefix="/notes", tags=["notes"])

# entity_type -> (resource id, model) — the permission/scope anchor
NOTE_HOSTS: dict[str, tuple[str, type]] = {
    "asset": ("assets", Asset),
}


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _authorize_host(
    db: DbSession, actor: AuthContext, entity_type: str,
    entity_id: uuid.UUID, action: str,
) -> None:
    """view: host resource view + host row in scope (404 outside).
    write: host resource change + global anchor (client tiers are read-only)."""
    host = NOTE_HOSTS.get(entity_type)
    if host is None:
        raise _err(422, "unknown_entity_type")
    resource, model = host
    needed = "view" if action == "view" else "change"
    if not actor.access.can(resource, needed):
        raise _err(403, "forbidden")
    if action != "view" and not actor.access.is_global:
        raise _err(403, "forbidden")
    row = await db.get(model, entity_id)
    if row is None:
        raise _err(404, "entity_not_found")
    cond = scope_conditions(resource, actor.access, actor.person.id)
    if cond is not None:
        visible = await db.scalar(
            select(model.id).where(model.id == entity_id, cond))
        if visible is None:
            raise _err(404, "entity_not_found")


def _out(note: Note, authors: dict) -> NoteOut:
    return NoteOut(
        id=note.id, entity_type=note.entity_type, entity_id=note.entity_id,
        body=note.body, created_by=note.created_by,
        author_name=authors.get(note.created_by),
        created_at=note.created_at, updated_at=note.updated_at)


async def _authors(db: DbSession, ids: set) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    people = (await db.scalars(select(Person).where(Person.id.in_(ids)))).all()
    return {p.id: p.display_name for p in people}


@router.get("", response_model=list[NoteOut])
async def list_notes(
    entity_type: str,
    entity_id: uuid.UUID,
    db: DbSession,
    actor: CurrentUser,
) -> list[NoteOut]:
    await _authorize_host(db, actor, entity_type, entity_id, "view")
    notes = (await db.scalars(
        select(Note).where(Note.entity_type == entity_type,
                           Note.entity_id == entity_id,
                           Note.deleted_at.is_(None))
        .order_by(Note.created_at.desc()))).all()
    authors = await _authors(db, {n.created_by for n in notes})
    return [_out(n, authors) for n in notes]


@router.post("", response_model=NoteOut, status_code=201)
async def create_note(
    body: NoteCreateIn,
    db: DbSession,
    actor: CurrentUser,
) -> NoteOut:
    await _authorize_host(db, actor, body.entity_type, body.entity_id, "add")
    note = Note(entity_type=body.entity_type, entity_id=body.entity_id,
                body=body.body, created_by=actor.person.id)
    db.add(note)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type=body.entity_type,
          entity_id=str(body.entity_id), action="note.add",
          changes={"note_id": str(note.id)})
    await db.commit()
    authors = await _authors(db, {note.created_by})
    return _out(note, authors)


async def _get_live_note(db: DbSession, note_id: uuid.UUID) -> Note:
    note = await db.get(Note, note_id)
    if note is None or note.deleted_at is not None:
        raise _err(404, "note_not_found")
    return note


@router.patch("/{note_id}", response_model=NoteOut)
async def update_note(
    note_id: uuid.UUID,
    body: NoteUpdateIn,
    db: DbSession,
    actor: CurrentUser,
) -> NoteOut:
    note = await _get_live_note(db, note_id)
    await _authorize_host(db, actor, note.entity_type, note.entity_id, "change")
    if body.body != note.body:
        note.body = body.body
        note.updated_by = actor.person.id
        note.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type=note.entity_type,
              entity_id=str(note.entity_id), action="note.update",
              changes={"note_id": str(note.id)})
    await db.commit()
    authors = await _authors(db, {note.created_by})
    return _out(note, authors)


@router.delete("/{note_id}", status_code=204)
async def delete_note(
    note_id: uuid.UUID,
    db: DbSession,
    actor: CurrentUser,
) -> None:
    note = await _get_live_note(db, note_id)
    await _authorize_host(db, actor, note.entity_type, note.entity_id, "delete")
    note.deleted_at = datetime.now(UTC)
    note.updated_by = actor.person.id
    audit(db, actor_id=actor.person.id, entity_type=note.entity_type,
          entity_id=str(note.entity_id), action="note.remove",
          changes={"note_id": str(note.id)})
    await db.commit()
```

Register in `app.py`: import `notes`, add `app.include_router(notes.router)`.

(If `Person.display_name` is a property not a column, `_authors` as written still works — it reads the attribute off ORM instances. Verify the attribute name in `db/models.py` `Person`; the search router uses `person.display_name` so it exists.)

- [ ] **Step 4: Extend attachments for assets**

In `api/src/serversherpa/api/routes/attachments.py`:

1. `EntityType = Literal["person", "client", "partner", "asset"]` and `ENTITY_MODEL = {…, "asset": Asset}` (import `Asset`). Do NOT add `asset` to `AVATAR_KEY_FIELD`.
2. Where `kind == "avatar"` is handled (the avatar-column write), guard first:

```python
    if kind == "avatar" and entity_type not in AVATAR_KEY_FIELD:
        raise _err(422, "avatar_not_supported")
```

3. In `_authorize`, replace the blanket non-global deny with a host-scoped view path for assets (write actions keep the deny):

```python
    if not actor.access.is_global:
        # asset attachments inherit the asset's visibility: a client-scoped
        # actor may VIEW files on assets they can see (spec: clients read,
        # staff write). Other entity types keep the interim hard deny until
        # attachments get a real scope map.
        if entity_type == "asset" and action == "view":
            if not actor.access.can("assets", "view"):
                raise _err(403, "forbidden")
            cond = scope_conditions("assets", actor.access, actor.person.id)
            if cond is not None:
                visible = await db.scalar(select(Asset.id).where(
                    Asset.id == entity_id, cond))
                if visible is None:
                    raise _err(404, "entity_not_found")
            return
        raise _err(403, "forbidden")
```

Keep the ordering: this replaces the existing final `if not actor.access.is_global: raise` block; the `can("attachments", action)` check above it stays for global actors, and the asset-view path deliberately does NOT require `attachments:view` (permission derives from the host resource, same as notes). Import `scope_conditions` from `serversherpa.access.scope` and `select` from sqlalchemy if not present.

- [ ] **Step 5: Run to verify pass**

Run: `.venv/bin/pytest tests/test_notes_api.py tests/test_attachments.py -q`
Expected: PASS (new + existing attachment suite).

- [ ] **Step 6: Full API suite + commit**

Run: `.venv/bin/pytest tests/ -q` — expected all pass.

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A api && git commit -m "feat(api): global notes router; attachments accept asset hosts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Portal API client — types and methods

**Files:**
- Modify: `portal/src/lib/api.ts` (append after the sites block)
- Test: covered by `portal/src/lib/assets.test.ts` in Task 10 (api.ts holds no logic — 4-line fetch wrappers, same as sites)

**Interfaces:**
- Produces (consumed by Tasks 10–13):

```ts
export interface AssetModelRef {
  id: string; make: string; model: string;
  category: string | null; category_label: string | null;
  category_color: string | null; ru_size: number | null;
}
export interface AssetItem {
  id: string; serial_number: string | null; name: string | null;
  rfid_tag: string | null; model_id: string | null; model: AssetModelRef | null;
  client_id: string | null; client_name: string | null;
  site_id: string | null; site_name: string | null;
  location_detail: string; status: string; status_label: string;
  status_color: string; has_rails: boolean | null;
  last_seen_at: string | null; archived_at: string | null; created_at: string;
}
export interface AssetModelItem {
  id: string; make: string; model: string;
  category: string | null; category_label: string | null;
  category_color: string | null; ru_size: number | null;
  weight_lbs: number | null; weight_kg: number | null;
  length_in: number | null; width_in: number | null; height_in: number | null;
  length_cm: number | null; width_cm: number | null; height_cm: number | null;
  mount_type: string | null; rail_type: string | null;
  knowledge: string; aliases: string[]; created_at: string; updated_at: string;
}
export interface AssetCategoryOut {
  key: string; label: string; description: string;
  sort_order: number; color: string;
}
export interface NoteOut {
  id: string; entity_type: string; entity_id: string; body: string;
  created_by: string | null; author_name: string | null;
  created_at: string; updated_at: string;
}
```

- [ ] **Step 1: Add types and methods**

Append to `portal/src/lib/api.ts` (below the sites methods) the interfaces above plus (every method is the standard 4-line shape used by `listSites`):

```ts
export async function listAssets(): Promise<AssetItem[]>                    // GET /assets
export async function createAsset(body: Record<string, unknown>): Promise<AssetItem>   // POST /assets
export async function updateAsset(id: string, body: Record<string, unknown>): Promise<AssetItem>  // PATCH /assets/{id}
export async function archiveAsset(id: string, archived: boolean): Promise<void>  // POST /assets/{id}/archive|unarchive (mirror archiveSite)
export async function listAssetStatuses(): Promise<StatusValue[]>           // GET /status-values?record_type=asset (mirror listSiteStatuses)

export async function listAssetModels(): Promise<AssetModelItem[]>          // GET /asset-models
export async function createAssetModel(body: Record<string, unknown>): Promise<AssetModelItem>
export async function updateAssetModel(id: string, body: Record<string, unknown>): Promise<AssetModelItem>
export async function setAssetModelAliases(id: string, aliases: string[]): Promise<AssetModelItem>  // PUT /asset-models/{id}/aliases  body {aliases}
export async function listAssetCategories(): Promise<AssetCategoryOut[]>    // GET /asset-categories

export async function listNotes(entityType: string, entityId: string): Promise<NoteOut[]>
  // GET /notes?entity_type=…&entity_id=…
export async function createNote(entityType: string, entityId: string, body: string): Promise<NoteOut>
export async function updateNote(id: string, body: string): Promise<NoteOut>
export async function deleteNote(id: string): Promise<void>                 // DELETE, expect 204

export async function listAttachments(entityType: string, entityId: string): Promise<AttachmentOut[]>
  // GET /attachments?entity_type=…&entity_id=… — NEW: no list method existed
export async function deleteAttachment(id: string): Promise<void>           // DELETE /attachments/{id}
```

Write each as real code following the exact `listSites` pattern — e.g.:

```ts
export async function listAssets(): Promise<AssetItem[]> {
  const resp = await apiFetch('/assets');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createNote(
  entityType: string, entityId: string, body: string,
): Promise<NoteOut> {
  const resp = await apiFetch('/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_type: entityType, entity_id: entityId, body }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteNote(id: string): Promise<void> {
  const resp = await apiFetch(`/notes/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}
```

Also widen the existing upload type union: `uploadAttachmentRequest`'s `entityType` becomes `'person' | 'client' | 'partner' | 'asset'` (check the actual JSON body/FormData keys stay unchanged). Before writing `listAttachments`, verify the API's attachments GET route signature (`api/src/serversherpa/api/routes/attachments.py` — the list endpoint's query params and response shape) and match it exactly.

- [ ] **Step 2: Typecheck**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/portal" && npm run build`
Expected: builds clean (tsc + vite).

- [ ] **Step 3: Commit**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A portal && git commit -m "feat(portal): api client types and methods for assets, models, notes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Portal registration — nav, routes, crumbs, palette, search kinds

**Files:**
- Modify: `portal/src/layout/navSections.tsx` (Assets section first, Admin before System)
- Modify: `portal/src/App.tsx` (2 routes)
- Modify: `portal/src/lib/access.ts` (`ROUTE_RESOURCE`)
- Modify: `portal/src/components/Topbar.tsx` (CRUMBS, PAGES, Hit kinds, GROUPS, select())
- Modify: `portal/src/components/CommandPalette.tsx` (2 navGated entries)
- Test: `portal/src/lib/godmode.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new — pure registration.
- Produces: `/assets` (resource `assets`) and `/admin/asset-models` (resource `asset_models`) reachable, gated, searchable, and in the palette. Placeholder page components are NOT used — Tasks 11/12 build the real pages, so this task imports them; if executing strictly in order, create the two pages as minimal stubs in this task (`export default function Assets() { return <div className="portal-page"><h1 className="page-title">Assets</h1></div>; }`) and let Tasks 11/12 replace the bodies.

- [ ] **Step 1: Write the failing nav test**

Append to `portal/src/lib/godmode.test.ts` inside the `NAV_SECTIONS` describe:

```ts
  it('registers Assets above Operations and Admin above System', () => {
    const labels = NAV_SECTIONS.map((s) => s.label);
    expect(labels.indexOf('Assets')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('Assets')).toBeLessThan(labels.indexOf('Operations'));
    expect(labels.indexOf('Admin')).toBeGreaterThan(labels.indexOf('Stakeholders'));
    expect(labels.indexOf('Admin')).toBeLessThan(labels.indexOf('System'));

    const assets = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.to === '/assets');
    expect(assets, 'no nav item for /assets').toBeDefined();
    expect(assets!.resource).toBe('assets');
    expect(isNavItemVisible(assets!, canAllBut('assets'), false)).toBe(false);
    expect(isNavItemVisible(assets!, canAll, false)).toBe(true);

    const models = NAV_SECTIONS.flatMap((s) => s.items)
      .find((i) => i.to === '/admin/asset-models');
    expect(models, 'no nav item for /admin/asset-models').toBeDefined();
    expect(models!.resource).toBe('asset_models');
    expect(isNavItemVisible(models!, canAllBut('asset_models'), false)).toBe(false);
  });
```

(`canAllBut` already exists at the top of the file; `canAll` too.)

- [ ] **Step 2: Run to verify failure**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/portal" && npm test -- godmode`
Expected: FAIL — no Assets section.

- [ ] **Step 3: Implement registration**

`navSections.tsx` — insert as the FIRST section (before Operations):

```tsx
  {
    label: 'Assets',
    items: [
      {
        to: '/assets',
        label: 'Assets',
        resource: 'assets',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="6" rx="1.5" />
            <rect x="3" y="14" width="18" height="6" rx="1.5" />
            <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
          </svg>
        ),
      },
    ],
  },
```

and insert between Stakeholders and System:

```tsx
  {
    label: 'Admin',
    items: [
      {
        to: '/admin/asset-models',
        label: 'Makes / Models',
        resource: 'asset_models',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16M4 12h16M4 17h10" />
            <circle cx="19" cy="17" r="2.5" />
          </svg>
        ),
      },
    ],
  },
```

`App.tsx` — import the two pages and add inside the shell route group:

```tsx
            <Route path="/assets" element={<ProtectedRoute resource="assets"><Assets /></ProtectedRoute>} />
            <Route path="/admin/asset-models" element={<ProtectedRoute resource="asset_models"><AssetModels /></ProtectedRoute>} />
```

`lib/access.ts` `ROUTE_RESOURCE` — add:

```ts
  '/assets': 'assets',
  '/admin/asset-models': 'asset_models',
```

`Topbar.tsx`:
- `CRUMBS`: add `'/assets': ['Assets', 'Assets']` and `'/admin/asset-models': ['Admin', 'Makes / Models']` (match the existing value shape exactly — read the CRUMBS entries first; also add the missing `/sites` entry ONLY if trivially consistent, otherwise leave it).
- `PAGES`: add `{ label: 'Assets', to: '/assets' }` and `{ label: 'Makes / Models', to: '/admin/asset-models' }` (gate: PAGES filtering is done by label match only — check whether PAGES entries carry a resource and mirror).
- `Hit` kind union: add `'asset' | 'asset_model'`.
- `GROUPS`: add `asset: 'Assets', asset_model: 'Makes / Models'`.
- `select()`: add branches:

```tsx
    else if (hit.kind === 'asset') navigate('/assets', { state: { openRow: hit.id } });
    else if (hit.kind === 'asset_model') navigate('/admin/asset-models', { state: { openRow: hit.id } });
```

`CommandPalette.tsx` — in the `cmds` array after the Sites entry:

```tsx
      ...navGated('Assets', '/assets', 'assets'),
```

and after the Partners entry:

```tsx
      ...navGated('Makes / Models', '/admin/asset-models', 'asset_models'),
```

- [ ] **Step 4: Run tests + build**

Run: `npm test -- godmode && npm run build`
Expected: PASS + clean build (with stub pages if Tasks 11/12 haven't run).

- [ ] **Step 5: Commit**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A portal && git commit -m "feat(portal): register Assets + Admin nav sections, routes, search kinds, palette

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Portal pure logic — `lib/assets.ts`

**Files:**
- Create: `portal/src/lib/assets.ts`
- Test: `portal/src/lib/assets.test.ts`

**Interfaces:**
- Consumes: `AssetItem`, `AssetModelItem` types (Task 8).
- Produces (used by Tasks 11–12):

```ts
export function partnerFor(value: number | null, factor: number, toMetric: boolean): number | null
export function parseDims(input: string): [number, number, number] | null
export function formatDims(l: number | null, w: number | null, h: number | null, unit: string): string
export function assetSearchText(a: AssetItem): string
export function matchesAssetFacets(a: AssetItem, state: FacetState): boolean   // via passesFacets
export interface AssetFormState { … }        // strings for every input
export function formFromAsset(a: AssetItem | null): AssetFormState
export function assetPayload(form: AssetFormState): Record<string, unknown>
export interface ModelFormState { … }
export function formFromModel(m: AssetModelItem | null): ModelFormState
export function modelPayload(form: ModelFormState, original: AssetModelItem | null): Record<string, unknown>
export function duplicateSerials(assets: AssetItem[]): Set<string>
```

- [ ] **Step 1: Write the failing tests**

`portal/src/lib/assets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { AssetItem, AssetModelItem } from './api';
import {
  assetPayload, duplicateSerials, formFromAsset, formFromModel,
  formatDims, modelPayload, parseDims, partnerFor,
} from './assets';

const asset = (over: Partial<AssetItem> = {}): AssetItem => ({
  id: 'a1', serial_number: 'SN1', name: 'web-01', rfid_tag: null,
  model_id: null, model: null, client_id: null, client_name: null,
  site_id: null, site_name: null, location_detail: '', status: 'active',
  status_label: 'Active', status_color: '#178a4c', has_rails: null,
  last_seen_at: null, archived_at: null, created_at: '2026-08-05T00:00:00Z',
  ...over,
});

describe('partnerFor', () => {
  it('converts lbs to kg and back', () => {
    expect(partnerFor(50, 0.453592, true)).toBe(22.68);
    expect(partnerFor(10, 0.453592, false)).toBe(22.05);
    expect(partnerFor(null, 0.453592, true)).toBeNull();
  });
});

describe('parseDims', () => {
  it('parses x-separated dims', () => {
    expect(parseDims('32 x 1.5 x 18.5')).toEqual([32, 1.5, 18.5]);
    expect(parseDims('32x1.5x18.5')).toEqual([32, 1.5, 18.5]);
    expect(parseDims('32 × 1.5 × 18.5')).toEqual([32, 1.5, 18.5]);
    expect(parseDims('32, 1.5, 18.5')).toEqual([32, 1.5, 18.5]);
  });
  it('rejects garbage', () => {
    expect(parseDims('32 x 1.5')).toBeNull();
    expect(parseDims('a x b x c')).toBeNull();
    expect(parseDims('')).toBeNull();
  });
});

describe('formatDims', () => {
  it('formats a trio', () => {
    expect(formatDims(32, 1.5, 18.5, 'in')).toBe('32 × 1.5 × 18.5 in');
  });
  it('dashes when incomplete', () => {
    expect(formatDims(32, null, 18.5, 'in')).toBe('—');
  });
});

describe('asset form round-trip', () => {
  it('create-mode defaults', () => {
    const f = formFromAsset(null);
    expect(f.status).toBe('unknown');
    expect(f.serial_number).toBe('');
  });
  it('payload nulls empties (patch clears; create drops server-side)', () => {
    const f = formFromAsset(null);
    f.serial_number = ' SN9 ';
    f.has_rails = 'yes';
    const p = assetPayload(f);
    expect(p.serial_number).toBe('SN9');
    expect(p.has_rails).toBe(true);
    expect(p.rfid_tag).toBeNull();     // null clears on PATCH; POST ignores it
  });
});

describe('model form payload', () => {
  const model: AssetModelItem = {
    id: 'm1', make: 'Dell', model: 'R740', category: 'server',
    category_label: 'Server', category_color: '#1668a7', ru_size: 2,
    weight_lbs: 50, weight_kg: 22.68, length_in: 32, width_in: 17,
    height_in: 3.4, length_cm: 81.28, width_cm: 43.18, height_cm: 8.64,
    mount_type: 'rails', rail_type: 'B7', knowledge: '', aliases: [],
    created_at: '', updated_at: '',
  };
  it('sends only the CHANGED unit side so the API recomputes the partner', () => {
    const f = formFromModel(model);
    f.weight_kg = '30';
    const p = modelPayload(f, model);
    expect(p.weight_kg).toBe(30);
    expect('weight_lbs' in p).toBe(false);     // partner recomputed server-side
  });
  it('clears a pair with null when blanked', () => {
    const f = formFromModel(model);
    f.weight_lbs = '';
    f.weight_kg = '';
    const p = modelPayload(f, model);
    expect(p.weight_lbs).toBeNull();
  });
  it('create mode sends entered fields only', () => {
    const f = formFromModel(null);
    f.make = 'HPE';
    f.model = 'DL380';
    f.weight_lbs = '40';
    const p = modelPayload(f, null);
    expect(p).toEqual({ make: 'HPE', model: 'DL380', weight_lbs: 40 });
  });
});

describe('duplicateSerials', () => {
  it('flags case-insensitive dupes, ignores blanks', () => {
    const dupes = duplicateSerials([
      asset({ id: '1', serial_number: 'SN1' }),
      asset({ id: '2', serial_number: 'sn1' }),
      asset({ id: '3', serial_number: null }),
      asset({ id: '4', serial_number: null }),
    ]);
    expect(dupes.has('sn1')).toBe(true);
    expect(dupes.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/portal" && npm test -- assets`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/assets.ts`**

```ts
/**
 * Assets page logic — pure functions the components delegate to, so the
 * behaviour is unit-testable without jsdom (the lib/sites.ts pattern).
 */
import type { AssetItem, AssetModelItem } from './api';
import { passesFacets, type FacetState } from './listTools';

export const LB_TO_KG = 0.453592;
export const IN_TO_CM = 2.54;

/** Convert one side of a dual-unit pair; toMetric=true means value×factor. */
export function partnerFor(
  value: number | null, factor: number, toMetric: boolean,
): number | null {
  if (value === null || Number.isNaN(value)) return null;
  const v = toMetric ? value * factor : value / factor;
  return Math.round(v * 100) / 100;
}

/** "32 x 1.5 x 18.5" | "32×1.5×18.5" | "32, 1.5, 18.5" → [L, W, H]. */
export function parseDims(input: string): [number, number, number] | null {
  const parts = input.split(/[x×,]/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => Number.isNaN(n) || n < 0)) return null;
  return [nums[0]!, nums[1]!, nums[2]!];
}

export function formatDims(
  l: number | null, w: number | null, h: number | null, unit: string,
): string {
  if (l === null || w === null || h === null) return '—';
  return `${l} × ${w} × ${h} ${unit}`;
}

export function assetSearchText(a: AssetItem): string {
  return [a.serial_number, a.name, a.rfid_tag, a.location_detail,
          a.client_name, a.site_name, a.model?.make, a.model?.model]
    .filter(Boolean).join(' ').toLowerCase();
}

export function matchesAssetFacets(a: AssetItem, state: FacetState): boolean {
  return passesFacets(state, (group) => {
    switch (group) {
      case 'status': return [a.status];
      case 'category': return a.model?.category ? [a.model.category] : [];
      case 'client': return a.client_id ? [a.client_id] : [];
      case 'site': return a.site_id ? [a.site_id] : [];
      case 'model': return a.model_id ? [a.model_id] : [];
      case 'archived': return [a.archived_at ? 'yes' : 'no'];
      default: return [];
    }
  });
}

/** Serials appearing on 2+ assets (case-insensitive, blanks ignored). */
export function duplicateSerials(assets: AssetItem[]): Set<string> {
  const seen = new Map<string, number>();
  for (const a of assets) {
    const s = a.serial_number?.trim().toLowerCase();
    if (!s) continue;
    seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([s]) => s));
}

/* ── asset edit/create form ────────────────────────────────────── */

export interface AssetFormState {
  serial_number: string; name: string; rfid_tag: string;
  model_id: string; client_id: string; site_id: string;
  location_detail: string; status: string;
  has_rails: '' | 'yes' | 'no';        // tri-state: '' = unknown
}

export function formFromAsset(a: AssetItem | null): AssetFormState {
  return {
    serial_number: a?.serial_number ?? '',
    name: a?.name ?? '',
    rfid_tag: a?.rfid_tag ?? '',
    model_id: a?.model_id ?? '',
    client_id: a?.client_id ?? '',
    site_id: a?.site_id ?? '',
    location_detail: a?.location_detail ?? '',
    status: a?.status ?? 'unknown',
    has_rails: a?.has_rails === true ? 'yes' : a?.has_rails === false ? 'no' : '',
  };
}

/** Payload for create AND patch: trimmed, empty strings become null for
 *  clearable FKs/text (patch) or are omitted (create handles via API's
 *  exclude_none — we just always send null and let create drop them). */
export function assetPayload(form: AssetFormState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, raw: string) => {
    const v = raw.trim();
    if (v) out[key] = v;
    else out[key] = null;
  };
  put('serial_number', form.serial_number);
  put('name', form.name);
  put('rfid_tag', form.rfid_tag);
  put('model_id', form.model_id);
  put('client_id', form.client_id);
  put('site_id', form.site_id);
  out.location_detail = form.location_detail.trim();
  out.status = form.status;
  out.has_rails = form.has_rails === '' ? null : form.has_rails === 'yes';
  // Nulls stay in: PATCH needs them to clear fields, and POST drops them
  // server-side (create_asset uses model_dump(exclude_none=True)).
  return out;
}

/* ── model edit/create form ────────────────────────────────────── */

export interface ModelFormState {
  make: string; model: string; category: string; ru_size: string;
  weight_lbs: string; weight_kg: string;
  length_in: string; width_in: string; height_in: string;
  length_cm: string; width_cm: string; height_cm: string;
  mount_type: string; rail_type: string; knowledge: string;
}

const numStr = (v: number | null): string => (v === null ? '' : String(v));

export function formFromModel(m: AssetModelItem | null): ModelFormState {
  return {
    make: m?.make ?? '', model: m?.model ?? '',
    category: m?.category ?? '', ru_size: numStr(m?.ru_size ?? null),
    weight_lbs: numStr(m?.weight_lbs ?? null), weight_kg: numStr(m?.weight_kg ?? null),
    length_in: numStr(m?.length_in ?? null), width_in: numStr(m?.width_in ?? null),
    height_in: numStr(m?.height_in ?? null),
    length_cm: numStr(m?.length_cm ?? null), width_cm: numStr(m?.width_cm ?? null),
    height_cm: numStr(m?.height_cm ?? null),
    mount_type: m?.mount_type ?? '', rail_type: m?.rail_type ?? '',
    knowledge: m?.knowledge ?? '',
  };
}

const UNIT_FIELDS: [keyof ModelFormState, keyof ModelFormState][] = [
  ['weight_lbs', 'weight_kg'],
  ['length_in', 'length_cm'],
  ['width_in', 'width_cm'],
  ['height_in', 'height_cm'],
];

/**
 * Build the write payload. Unit-pair rule: send ONLY the side the user
 * changed (the API computes the partner); if both sides blanked, send null
 * to clear; untouched pairs are omitted entirely.
 */
export function modelPayload(
  form: ModelFormState, original: AssetModelItem | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const orig = (key: string): unknown => {
    if (original === null) return null;
    return (original as unknown as Record<string, unknown>)[key];
  };
  const changedStr = (key: keyof ModelFormState, origVal: unknown) => {
    const v = form[key].trim();
    const before = (origVal ?? '') as string;
    if (v !== before) out[key] = v || null;
  };

  changedStr('make', orig('make'));
  changedStr('model', orig('model'));
  changedStr('category', orig('category'));
  changedStr('mount_type', orig('mount_type'));
  changedStr('rail_type', orig('rail_type'));
  if (form.knowledge !== ((orig('knowledge') ?? '') as string)) {
    out.knowledge = form.knowledge;
  }
  const ru = form.ru_size.trim();
  if (ru !== numStr((orig('ru_size') as number | null) ?? null)) {
    out.ru_size = ru === '' ? null : Number(ru);
  }

  for (const [imp, met] of UNIT_FIELDS) {
    const impStr = form[imp].trim();
    const metStr = form[met].trim();
    const impOrig = numStr((orig(imp) as number | null) ?? null);
    const metOrig = numStr((orig(met) as number | null) ?? null);
    const impChanged = impStr !== impOrig;
    const metChanged = metStr !== metOrig;
    if (!impChanged && !metChanged) continue;         // untouched pair
    if (impStr === '' && metStr === '') {
      out[imp] = null;                                // clearing clears both
      out[met] = null;
    } else if (impChanged && !metChanged) {
      out[imp] = Number(impStr);                      // partner recomputed
    } else if (metChanged && !impChanged) {
      out[met] = Number(metStr);
    } else {
      out[imp] = impStr === '' ? null : Number(impStr);
      out[met] = metStr === '' ? null : Number(metStr);
    }
  }
  // create mode: drop nulls (nothing to clear yet)
  if (original === null) {
    for (const key of Object.keys(out)) {
      if (out[key] === null) delete out[key];
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- assets`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A portal && git commit -m "feat(portal): pure assets page logic with unit-pair payload rules

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Assets page + AssetEditModal

**Files:**
- Create: `portal/src/pages/Assets.tsx` (replace Task 9 stub)
- Create: `portal/src/components/assets/AssetEditModal.tsx`
- Create: `portal/src/styles/assets.css`
- Test: build + existing suites (no component-test infra — known gap; behaviour logic was tested in Task 10)

**Interfaces:**
- Consumes: everything from Tasks 8–10; `NotesFilesPanel` arrives in Task 13 — leave a clearly marked mount point (render nothing if the import doesn't exist yet is NOT possible in TS: instead build this page WITHOUT the panel and let Task 13 add the import + element; the detail block layout below shows where).

**Structure to build (clone `Sites.tsx` exactly — same class names, same state shape, same toolbar order):**

- [ ] **Step 1: Build the page**

`portal/src/pages/Assets.tsx` — clone the Sites.tsx skeleton with these substitutions:

Module config:

```tsx
const COLUMNS: ColumnDef[] = [
  { key: 'model', label: 'Make / Model', width: '1.5fr', default: true },
  { key: 'category', label: 'Category', width: '1fr', default: true },
  { key: 'client', label: 'Client', width: '1.2fr', default: true },
  { key: 'site', label: 'Site', width: '1.2fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'ru', label: 'RU', width: '0.5fr', default: false },
  { key: 'location', label: 'Location', width: '1.4fr', default: false },
  { key: 'rfid', label: 'RFID', width: '1fr', default: false },
  { key: 'last_seen', label: 'Last seen', width: '1fr', default: false },
];
```

Primary cell (the `2.2fr` name column): serial number bold + name as the sub-line (`<div className="pn"><b>{a.serial_number ?? '—'}</b><span>{a.name ?? '—'}</span></div>`), with a `⚠ duplicate serial` chip (`<span className="chip c-amber">Duplicate SN</span>`) when `dupes.has(a.serial_number!.toLowerCase())` — `const dupes = useMemo(() => duplicateSerials(assets ?? []), [assets])`.

State/loaders (mirror Sites): `listAssets()` in `load()`; mount effect also fires `listAssetStatuses()`, `listAssetCategories()`, `listClients()`, `listSites()` — sites go into a `SiteItem[]` for the site facet + edit modal ComboBox; `can('assets','add')`/`can('assets','change')` gate the New/Edit buttons. `useLocation()` for `state.openRow` (copy the exact openRow-handling effect from `Workers.tsx` — search results navigate here with an asset id to auto-expand).

Facets:

```tsx
  const facetGroups = useMemo<FacetGroup[]>(() => [
    { key: 'status', title: 'Status',
      options: statuses.map((s) => ({ value: s.key, label: s.label })) },
    { key: 'category', title: 'Category',
      options: categories.map((c) => ({ value: c.key, label: c.label })) },
    { key: 'client', title: 'Client', options:
      clients.filter((c) => !c.archived_at).map((c) => ({ value: c.id, label: c.name })) },
    { key: 'site', title: 'Site',
      options: sites.map((s) => ({ value: s.id, label: s.name })) },
    { key: 'archived', title: 'Archived', options: [
      { value: 'no', label: 'Active only' }, { value: 'yes', label: 'Archived' }] },
  ], [statuses, categories, clients, sites]);
```

Filtering memo: `assetSearchText(a).includes(query.toLowerCase())` + `matchesAssetFacets(a, facets)`; default (no archived facet selected) hides archived rows: `if (!facets.archived?.size && a.archived_at) return false;`.

Cell renderer highlights: `status` uses the `.chip.custom`/`--chip` pattern with `a.status_color`; `category` uses `a.model?.category_color` the same way; `model` renders `a.model ? `${a.model.make} ${a.model.model}` : '—'`; `last_seen` renders `a.last_seen_at ? new Date(a.last_seen_at).toLocaleDateString() : '—'`.

CSV columns: ID, Serial, Name, Make, Model, Category, Client, Site, Location, Status, RFID, Has rails, Last seen, Created.

Row detail (read-only; Edit button only interactive element):

```tsx
function AssetRowDetail({ asset, canEdit, onEdit }: {
  asset: AssetItem; canEdit: boolean; onEdit: () => void;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Identity</p>
        <dl className="kv">
          <dt>Serial</dt><dd className="mono">{asset.serial_number ?? '—'}</dd>
          <dt>Name</dt><dd>{asset.name ?? '—'}</dd>
          <dt>RFID tag</dt><dd className="mono">{asset.rfid_tag ?? '—'}</dd>
          <dt>Model</dt><dd>{asset.model ? `${asset.model.make} ${asset.model.model}` : '—'}</dd>
          <dt>RU</dt><dd>{asset.model?.ru_size ?? '—'}</dd>
          <dt>Rails present</dt>
          <dd>{asset.has_rails === null ? 'Unknown' : asset.has_rails ? 'Yes' : 'No'}</dd>
        </dl>
      </div>
      <div className="detail-block">
        <p className="eyebrow-sm">Location & ownership</p>
        <dl className="kv">
          <dt>Client</dt><dd>{asset.client_name ?? 'House'}</dd>
          <dt>Site</dt><dd>{asset.site_name ?? '—'}</dd>
          <dt>Location</dt><dd>{asset.location_detail || '—'}</dd>
          <dt>Last seen</dt>
          <dd>{asset.last_seen_at ? new Date(asset.last_seen_at).toLocaleString() : '—'}</dd>
        </dl>
      </div>
      {/* Task 13 mounts <NotesFilesPanel entityType="asset" entityId={asset.id}
          canWrite={canEdit} /> here as a third, full-width detail block */}
      {canEdit && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build the edit modal**

`portal/src/components/assets/AssetEditModal.tsx` — clone `SiteEditModal.tsx` structure (`modal-scrim/modal-card/…`, `SITE_ERRORS`-style code map, `locked` rule, create vs edit by `asset === null`). Specifics:

```tsx
const ASSET_ERRORS: Record<string, string> = {
  rfid_tag_in_use: 'That RFID tag is already on another asset.',
  asset_model_not_found: 'Pick a model from the catalog list.',
  client_not_found: 'Pick a client from the list.',
  site_not_found: 'Pick a site from the list.',
  unknown_status: 'Pick a status from the list.',
  location_detail_required: 'Location cannot be null.',
  status_required: 'Status is required.',
  forbidden: 'You do not have permission to change assets.',
};
```

Form fields (state = `AssetFormState` via `formFromAsset`):
- Serial number `<input>` with inline duplicate warning: props include `existingSerials: Set<string>` (from `duplicateSerials` + all current serials, computed by the page); on blur, if the trimmed lowercase serial is on another asset, show `<span className="pf-error">Another asset already has this serial — allowed, but check it's not a re-entry.</span>` (non-blocking).
- Name, RFID tag, Location detail: plain `<input>`s.
- Model: `ComboBox` over `models.map((m) => ({ value: m.id, label: `${m.make} ${m.model}`, sub: m.category_label }))` — the page passes `models` from a lazy `listAssetModels()` call **only when the actor can view the catalog** (`can('asset_models','view')`); otherwise pass the asset's own embedded ref as the sole option (client actors never reach this modal anyway — writes are staff-only — but don't fetch a 403).
- Client and Site: `ComboBox` with `clearable`, options from the page's loaded lists.
- Status: `ComboBox` over asset statuses (record-backed vocabulary).
- Rails: native `<select>` — tiny fixed enum: Unknown / Yes / No.
- Foot: Save/Create + Cancel + Archive/Unarchive (edit mode, `canChange`), exactly like SiteEditModal's foot.

Submit: `assetPayload(form)`; create → `createAsset(payload)`, edit → `updateAsset(asset.id, payload)` (for edit, send the full payload — the API diffs and no-ops unchanged fields; this matches how SiteEditModal submits). On success `await onSaved(); onClose();`.

- [ ] **Step 3: `portal/src/styles/assets.css`**

```css
/* Assets pages — reuses the directory-list shell, chip classes, and
   --surface/--c-* tokens from directory.css (imported by the page).
   Only genuinely new bits live here. */

.asset-dupe-hint { color: var(--c-amber); font-size: 12px; }
.knowledge-block {
  white-space: pre-wrap;
  background: var(--surface-2);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
}
```

- [ ] **Step 4: Build + lint**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/portal" && npm run build && npm test`
Expected: clean build, all tests pass.

- [ ] **Step 5: Commit**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A portal && git commit -m "feat(portal): Assets page with list, expansion, edit modal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Makes / Models page + ModelEditModal

**Files:**
- Create: `portal/src/pages/AssetModels.tsx` (replace Task 9 stub)
- Create: `portal/src/components/assets/ModelEditModal.tsx`
- Test: build + suites (pure logic already covered by Task 10)

**Interfaces:**
- Consumes: Task 8 methods, Task 10 helpers (`formFromModel`, `modelPayload`, `parseDims`, `formatDims`, `partnerFor`).

- [ ] **Step 1: Build the page**

`portal/src/pages/AssetModels.tsx` — same Sites.tsx skeleton. Eyebrow: `Admin`. Title: `Makes / Models`. Hint: `The hardware catalog — specs, mounting, and field knowledge per make/model.`

```tsx
const COLUMNS: ColumnDef[] = [
  { key: 'category', label: 'Category', width: '1fr', default: true },
  { key: 'ru', label: 'RU', width: '0.5fr', default: true },
  { key: 'weight', label: 'Weight', width: '1.2fr', default: true },
  { key: 'dims', label: 'Dimensions', width: '1.6fr', default: true },
  { key: 'mount', label: 'Mount', width: '0.8fr', default: true },
  { key: 'rail', label: 'Rail type', width: '0.8fr', default: false },
  { key: 'aliases', label: 'Aliases', width: '0.6fr', default: false },
];
```

Primary cell: `<div className="pn"><b>{m.make}</b><span>{m.model}</span></div>`. Weight cell: `m.weight_lbs !== null ? `${m.weight_lbs} lb / ${m.weight_kg} kg` : '—'`. Dims cell: `formatDims(m.length_in, m.width_in, m.height_in, 'in')`. Category chip via `category_color`. Facets: category, mount type (fixed options rails/ears/shelf/custom), `has knowledge` yes/no. Search text: make, model, rail_type, aliases joined. `openRow` navigation state handled like Assets (search hits land here).

Row detail: left block `dl.kv` with all specs (both unit systems); right block:

```tsx
      <div className="detail-block">
        <p className="eyebrow-sm">Field knowledge</p>
        {m.knowledge
          ? <div className="knowledge-block">{m.knowledge}</div>
          : <p className="page-hint">No tips recorded yet.</p>}
        <p className="eyebrow-sm" style={{ marginTop: 12 }}>Aliases</p>
        <div className="chips">
          {m.aliases.length
            ? m.aliases.map((a) => <span key={a} className="chip tag">{a}</span>)
            : <span className="chip tag">none</span>}
        </div>
      </div>
```

Edit button gated on `can('asset_models', 'change')`; New model button on `can('asset_models', 'add')`.

- [ ] **Step 2: Build the modal**

`portal/src/components/assets/ModelEditModal.tsx` — SiteEditModal shell. Error map:

```tsx
const MODEL_ERRORS: Record<string, string> = {
  duplicate_model: 'A model with this make + model already exists.',
  unknown_category: 'Pick a category from the list.',
  unknown_mount_type: 'Mount type must be rails, ears, shelf, or custom.',
  alias_in_use: 'One of these aliases already belongs to another model.',
  make_required: 'Make is required.',
  model_required: 'Model is required.',
  forbidden: 'You do not have permission to change the catalog.',
};
```

Form (state = `ModelFormState`):
- Make*, Model*, Rail type: `<input>`s. Category: ComboBox over categories. Mount type: native `<select>` (fixed enum + blank). RU: `<input inputMode="numeric">`.
- **Dual-unit weight row**: two inputs side by side (`lb` / `kg`). `onChange` of one recomputes the OTHER's display live via `partnerFor(Number(v), LB_TO_KG, true|false)` — display-only convenience; `modelPayload` still sends only the changed side. Track which side the user last edited in a `useRef<'imp' | 'met' | null>` so a server round-trip isn't needed for the preview.
- **Dimensions**: per unit system, one text input accepting `L x W x H` (parsed with `parseDims` on blur into the three fields) above three small per-field inputs. Editing the imperial trio live-fills the metric preview via `partnerFor(v, IN_TO_CM, true)` and vice versa.
- Knowledge: `<textarea rows={5}>`.
- **Aliases editor**: chip list with an × per chip + an input with an Add button (Enter adds too); state `aliases: string[]`. On save, if the alias set changed, call `setAssetModelAliases(id, aliases)` AFTER the create/patch succeeds (create returns the new id). If the aliases call fails with `alias_in_use`, keep the modal open showing the mapped error (the model save already landed — say so: prefix the error with `Model saved, but: `).

Submit: `modelPayload(form, original)`; skip the API call entirely if the payload is empty AND aliases unchanged (pure no-op close).

- [ ] **Step 3: Build + test + commit**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/portal" && npm run build && npm test`
Expected: clean.

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A portal && git commit -m "feat(portal): Makes/Models catalog page with dual-unit editor and aliases

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: NotesFilesPanel — shared notes + attachments panel

**Files:**
- Create: `portal/src/components/NotesFilesPanel.tsx`
- Modify: `portal/src/pages/Assets.tsx` (mount in row detail — the marked spot from Task 11)
- Test: build + suites; behaviour is API-tested (Task 7); render wiring verified in the browser pass (Task 14)

**Interfaces:**
- Produces: `<NotesFilesPanel entityType="asset" entityId={id} canWrite={bool} />` — generic; future sections pass their own entity types once the API registers them.

- [ ] **Step 1: Build the component**

`portal/src/components/NotesFilesPanel.tsx`:

```tsx
/**
 * NotesFilesPanel — the old portal's "document, image, or note" panel,
 * rebuilt: one merged, newest-first stream of notes and file attachments
 * for any entity the notes/attachments APIs host. Read-only unless
 * canWrite (client-scoped actors read; staff write).
 */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, createNote, deleteAttachment, deleteNote, listAttachments,
  listNotes, updateNote, uploadAttachmentRequest,
  type AttachmentOut, type NoteOut,
} from '../lib/api';

type Entry =
  | { kind: 'note'; at: string; note: NoteOut }
  | { kind: 'file'; at: string; file: AttachmentOut };

export default function NotesFilesPanel({ entityType, entityId, canWrite }: {
  entityType: 'asset'; entityId: string; canWrite: boolean;
}) {
  const [notes, setNotes] = useState<NoteOut[]>([]);
  const [files, setFiles] = useState<AttachmentOut[]>([]);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const [n, f] = await Promise.all([
        listNotes(entityType, entityId),
        listAttachments(entityType, entityId),
      ]);
      setNotes(n);
      setFiles(f);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  };

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void load().then(() => { if (cancelled) return; });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId]);

  const entries: Entry[] = [
    ...notes.map((n) => ({ kind: 'note' as const, at: n.created_at, note: n })),
    ...files.map((f) => ({ kind: 'file' as const, at: f.created_at, file: f })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const addNote = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError('');
    try {
      await createNote(entityType, entityId, body);
      setDraft('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? 'Could not save the note.' : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (editingId === null) return;
    setBusy(true);
    try {
      await updateNote(editingId, editBody.trim());
      setEditingId(null);
      await load();
    } catch {
      setError('Could not update the note.');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      await uploadAttachmentRequest({
        entityType, entityId,
        kind: file.type.startsWith('image/') ? 'photo' : 'document',
        file,
      });
      await load();
    } catch {
      setError('Upload failed.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="detail-block" style={{ gridColumn: '1 / -1' }}>
      <p className="eyebrow-sm">Notes &amp; files</p>

      {status === 'loading' && <p className="page-hint">Loading…</p>}
      {status === 'error' && <p className="page-hint">Could not load notes and files.</p>}

      {status === 'loaded' && (
        <>
          {canWrite && (
            <div className="nf-composer">
              <textarea rows={2} placeholder="Add a note…" value={draft}
                        onChange={(e) => setDraft(e.target.value)} disabled={busy} />
              <div className="nf-composer-actions">
                <button className="mini-btn" onClick={() => void addNote()}
                        disabled={busy || !draft.trim()}>Add note</button>
                <button className="mini-btn" onClick={() => fileRef.current?.click()}
                        disabled={busy}>Attach file</button>
                <input ref={fileRef} type="file" hidden
                       onChange={(e) => {
                         const f = e.target.files?.[0];
                         if (f) void upload(f);
                       }} />
              </div>
            </div>
          )}

          {entries.length === 0 && <p className="page-hint">Nothing here yet.</p>}

          <ul className="nf-list">
            {entries.map((entry) => entry.kind === 'note' ? (
              <li key={`n-${entry.note.id}`} className="nf-item">
                {editingId === entry.note.id ? (
                  <>
                    <textarea rows={2} value={editBody}
                              onChange={(e) => setEditBody(e.target.value)} />
                    <div className="nf-actions">
                      <button className="mini-btn" onClick={() => void saveEdit()}
                              disabled={busy || !editBody.trim()}>Save</button>
                      <button className="mini-btn" onClick={() => setEditingId(null)}>
                        Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="nf-body">{entry.note.body}</p>
                    <div className="nf-meta">
                      <span>{entry.note.author_name ?? 'Unknown'}</span>
                      <span>{new Date(entry.note.created_at).toLocaleString()}</span>
                      {canWrite && (
                        <span className="nf-actions">
                          <button className="mini-btn" onClick={() => {
                            setEditingId(entry.note.id);
                            setEditBody(entry.note.body);
                          }}>Edit</button>
                          <button className="mini-btn danger" onClick={() => {
                            void deleteNote(entry.note.id).then(load);
                          }}>Delete</button>
                        </span>
                      )}
                    </div>
                  </>
                )}
              </li>
            ) : (
              <li key={`f-${entry.file.id}`} className="nf-item">
                <p className="nf-body">
                  {entry.file.url
                    ? <a href={entry.file.url} target="_blank" rel="noreferrer">
                        📎 {entry.file.filename}</a>
                    : <>📎 {entry.file.filename}</>}
                  <span className="chip tag" style={{ marginLeft: 8 }}>
                    {entry.file.kind}</span>
                </p>
                <div className="nf-meta">
                  <span>{(entry.file.size_bytes / 1024).toFixed(0)} KB</span>
                  <span>{new Date(entry.file.created_at).toLocaleString()}</span>
                  {canWrite && (
                    <span className="nf-actions">
                      <button className="mini-btn danger" onClick={() => {
                        void deleteAttachment(entry.file.id).then(load);
                      }}>Delete</button>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {error && <span className="pf-error">{error}</span>}
        </>
      )}
    </div>
  );
}
```

Add to `portal/src/styles/assets.css`:

```css
.nf-composer { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.nf-composer textarea { width: 100%; resize: vertical; }
.nf-composer-actions, .nf-actions { display: flex; gap: 6px; }
.nf-list { list-style: none; margin: 0; padding: 0; display: flex;
           flex-direction: column; gap: 10px; }
.nf-item { border-bottom: 1px solid var(--paper-line); padding-bottom: 8px; }
.nf-body { margin: 0 0 4px; white-space: pre-wrap; }
.nf-meta { display: flex; gap: 12px; align-items: center;
           color: var(--text-mute); font-size: 12px; }
```

(Before relying on `entry.file.url`: check `AttachmentOut.url` is populated by the list endpoint — the avatar flow returns presigned URLs; if the list endpoint omits urls, render the filename without a link and note the follow-up.)

- [ ] **Step 2: Mount in Assets row detail**

In `Assets.tsx` `AssetRowDetail`, replace the Task 11 placeholder comment with:

```tsx
      <NotesFilesPanel entityType="asset" entityId={asset.id} canWrite={canEdit} />
```

plus the import. `canWrite={canEdit}` — client-scoped users (no `assets:change`) get the read-only stream.

- [ ] **Step 3: Build + test + commit**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/portal" && npm run build && npm test`
Expected: clean.

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git add -A portal && git commit -m "feat(portal): shared Notes & Files panel, mounted on asset rows

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Full verification pass

**Files:** none created — verification only.

- [ ] **Step 1: Full API suite**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/api" && .venv/bin/pytest tests/ -q`
Expected: ALL pass (~193 pre-existing + ~35 new).

- [ ] **Step 2: Full portal suite + build**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/portal" && npm test && npm run build`
Expected: ALL pass (67 pre-existing + new), clean build.

- [ ] **Step 3: Migration cycle on the DEV database**

Run: `cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3/api" && .venv/bin/alembic upgrade head && .venv/bin/alembic current`
Expected: `0014 (head)`.

- [ ] **Step 4: Live API smoke (dev stack)**

With the dev API running (uvicorn on :8000):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/healthz
```

Expected: `200`. Then verify `/assets` and `/asset-models` appear in `http://127.0.0.1:8000/docs`.

- [ ] **Step 5: Browser verification checklist (needs a human or the browser pane + Jimmy's login)**

The dev portal sits behind a login — agents must not enter credentials. Ask Jimmy to (or drive the preview pane while he's logged in):

1. Nav shows **Assets** section (top) and **Admin** section (above System).
2. `/assets`: create an asset via **+ New asset** (pick model/client/site via type-to-filter ComboBoxes), see it listed with status chip; expand → read-only detail + Notes & files; add a note; attach a file; edit; archive.
3. Duplicate-serial warning: enter an existing serial in the modal → amber hint appears, save still allowed.
4. `/admin/asset-models`: create a model entering **weight in lbs only** → kg appears computed after save (and live-previews while typing); enter dimensions as `32 x 1.5 x 18.5` in the L×W×H box → three fields fill; metric side computed. Add two aliases; try adding one of them to a second model → clear error.
5. ⌘K palette: "Go to Assets", "Go to Makes / Models" appear (and hide for a user lacking the resources).
6. Topbar search: an asset serial and a model name both return grouped hits; clicking one lands on the right page with the row auto-expanded.
7. Log in as a client-tier user (create a contact with login on a client that owns an asset): sees only their org's assets, read-only (no New/Edit buttons), Notes & files stream visible read-only; `/admin/asset-models` hidden from nav and 403s by URL.

- [ ] **Step 6: Update the memory file**

Update `/Users/jrh1812/.claude/projects/-Volumes-Extreme-SSD-Code-Backups-BaseCampV3/memory/project-state.md`: assets section shipped (migration 0014, resources assets/asset_models, notes system, pages `/assets` + `/admin/asset-models`), plus anything deferred during execution.

- [ ] **Step 7: Final commit if anything moved**

```bash
cd "/Volumes/Extreme SSD/Code Backups/BaseCampV3" && git status --short && git add -A && git commit -m "chore: assets section verification fixes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Deferred (recorded in the spec, NOT in this plan)

Bulk import of the 10,388 legacy assets; containers; RFID scan surfaces; damage-reports workflow; Admin "Lookups" page (vocabulary governance question open — V1 asset statuses are edited via the god-mode Variables page); per-page search helpers; model merge/archive tooling.



