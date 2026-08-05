# Status values + Variables page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `site_statuses` and `worker_profiles`' status CHECK constraint with one discriminated `status_values` table, and add a developer-only Variables page to administer it alongside site types and worker levels.

**Architecture:** `status_values` is keyed on `(record_type, key)`. Consuming tables expose their record type as a Postgres generated column so a composite FK can point at it — a FK on `key` alone would let a site reference a worker status. Valid record types come from a frozen code registry mirroring `access/resources.py`, not from the database. Reads are gated by the owning entity's `view` permission; writes by `devtools`, which is developer-only.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 async, Alembic, Postgres 12+ (generated columns), pytest/httpx; React 18 + TypeScript + Vite, vitest.

**Spec:** `docs/superpowers/specs/2026-07-15-status-values-design.md`

## Global Constraints

- Colour values are token names (`c-green`, `c-amber`, `c-red`, `c-aqua`, `c-slate`, `c-blue`, `c-violet`), never hex. Not validated server-side — no existing lookup validates colour, and adding validation here is out of scope.
- Error bodies are `{"detail": {"code": "..."}}`. Build them with the local `_err(status, code)` helper. Never raise a bare `HTTPException`.
- `key` and `record_type` are immutable. `worker_profiles` has a CHECK constraint hardcoding the literal `'blacklist'` (`0007_workers.py:67`); key immutability is what keeps it valid.
- No `DELETE` endpoint for status values. `is_active` is the retirement mechanism.
- `devtools` is `developer_only=True, visible_to={"global"}`. The resolver hard gate (`resolver.py:89`) blocks non-global and non-developer actors before overrides are read, so `require_permission("devtools", ...)` implies global. Do **not** add `_require_global` to devtools-gated endpoints.
- Mutations that change data write an audit row via `audit(db, actor_id=..., entity_type=..., entity_id=..., action=..., changes=...)` using `snapshot()`/`diff()`, following `routes/sites.py:163-210`.
- Portal: no React Query. Pages call `lib/api.ts` functions from `useEffect` into `useState`. Testable logic lives in `lib/<name>.ts` with `lib/<name>.test.ts` beside it.
- Run API tests from `api/` with `.venv/bin/pytest`. Run portal tests from `portal/` with `npm test`.

---

### Task 1: Record-type registry

**Files:**
- Create: `api/src/serversherpa/status/__init__.py`
- Create: `api/src/serversherpa/status/registry.py`
- Test: `api/tests/test_status_registry.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `StatusRecordType` (frozen dataclass: `id: str`, `label: str`, `table: str`, `column: str`, `resource: str`), `STATUS_RECORD_TYPES: list[StatusRecordType]`, `STATUS_REGISTRY: dict[str, StatusRecordType]`.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_status_registry.py
"""The record-type registry is code, not data — a record_type only means
something if code reads statuses for that entity. Mirrors test_access_registry."""

from serversherpa.access.resources import REGISTRY as RESOURCE_REGISTRY
from serversherpa.status.registry import STATUS_RECORD_TYPES, STATUS_REGISTRY


def test_registry_is_keyed_by_id():
    assert set(STATUS_REGISTRY) == {rt.id for rt in STATUS_RECORD_TYPES}


def test_launch_types_are_site_and_worker():
    assert set(STATUS_REGISTRY) == {"site", "worker"}


def test_every_record_type_points_at_a_real_resource():
    for rt in STATUS_RECORD_TYPES:
        assert rt.resource in RESOURCE_REGISTRY, rt.id


def test_site_type_targets_the_sites_status_column():
    site = STATUS_REGISTRY["site"]
    assert (site.table, site.column, site.resource) == ("sites", "status", "sites")


def test_worker_type_targets_the_worker_profiles_status_column():
    worker = STATUS_REGISTRY["worker"]
    assert (worker.table, worker.column, worker.resource) == (
        "worker_profiles", "status", "workers")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_status_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'serversherpa.status'`

- [ ] **Step 3: Write minimal implementation**

```python
# api/src/serversherpa/status/__init__.py
```
(empty file)

```python
# api/src/serversherpa/status/registry.py
"""Status record types — the code-side list of entities that carry a status
vocabulary. Deploys introduce record types; the DB stores only the values.

Shaped after access/resources.py deliberately: a record_type is not data. A
row saying record_type='invoice' is inert until an invoices feature ships,
and that feature ships as a deploy anyway."""

from dataclasses import dataclass


@dataclass(frozen=True)
class StatusRecordType:
    id: str
    label: str
    # the table/column carrying this entity's status — used to count usage
    table: str
    column: str
    # the resource whose "view" permission gates reading these values
    resource: str


STATUS_RECORD_TYPES: list[StatusRecordType] = [
    StatusRecordType("site", "Site", table="sites",
                     column="status", resource="sites"),
    StatusRecordType("worker", "Worker", table="worker_profiles",
                     column="status", resource="workers"),
]

STATUS_REGISTRY: dict[str, StatusRecordType] = {
    rt.id: rt for rt in STATUS_RECORD_TYPES}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && .venv/bin/pytest tests/test_status_registry.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/status/ api/tests/test_status_registry.py
git commit -m "Add the status record-type registry"
```

---

### Task 2: Migration 0012 + model + test harness

**Files:**
- Create: `api/migrations/versions/0012_status_values.py`
- Modify: `api/src/serversherpa/db/models.py` — add `StatusValue`, delete `SiteStatus` (lines 350-358), change `Site.status` FK (line 369-370)
- Modify: `api/tests/conftest.py:78-88` — the `site_statuses` restore block
- Test: `api/tests/test_status_values_model.py`

**Interfaces:**
- Consumes: `STATUS_REGISTRY` from Task 1 (for the test only).
- Produces: `StatusValue` model with columns `record_type`, `key`, `label`, `description`, `color`, `sort_order`, `is_active`, `updated_at`. `SiteStatus` no longer exists — importing it is an error.

**Context:** `sites.status` and `worker_profiles.status` are both `NOT NULL` with `server_default 'active'`, so the composite FK needs no NULL tolerance. `worker_profiles_blacklist_note_check` (`status != 'blacklist' OR status_note IS NOT NULL`) must survive untouched.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_status_values_model.py
"""The composite FK is the point: a FK on `key` alone would let a site
reference a worker status."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import Site, StatusValue


async def test_site_statuses_migrated_with_colors(db):
    rows = (await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "site")
        .order_by(StatusValue.sort_order))).all()
    assert [r.key for r in rows] == [
        "active", "planned", "inactive", "decommissioned"]
    assert [r.color for r in rows] == ["c-green", "c-aqua", "c-slate", "c-red"]
    assert all(r.is_active for r in rows)


async def test_worker_statuses_seeded_with_labels_and_colors(db):
    rows = (await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "worker")
        .order_by(StatusValue.sort_order))).all()
    assert [r.key for r in rows] == ["active", "standby", "blacklist"]
    assert [r.label for r in rows] == ["Active", "Standby", "Blacklist"]
    assert [r.color for r in rows] == ["c-green", "c-amber", "c-red"]


async def test_site_cannot_reference_a_worker_only_status(db):
    """'standby' exists, but only as record_type='worker'. The composite FK
    must reject it — this is the whole reason the PK is composite."""
    db.add(Site(name="FK Probe", status="standby"))
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()


async def test_generated_record_type_column_is_constant(db):
    db.add(Site(name="Generated Probe", status="planned"))
    await db.flush()
    value = await db.scalar(text(
        "SELECT status_record_type FROM sites WHERE name = 'Generated Probe'"))
    assert value == "site"
    await db.rollback()


async def test_blacklist_note_check_survives(db):
    """The CHECK hardcodes the literal 'blacklist'. It stays valid only
    because no API can rename a key."""
    row = await db.scalar(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'worker_profiles_blacklist_note_check'"))
    assert row is not None
    assert "blacklist" in row


async def test_old_status_check_is_gone(db):
    row = await db.scalar(text(
        "SELECT 1 FROM pg_constraint "
        "WHERE conname = 'worker_profiles_status_check'"))
    assert row is None


async def test_site_statuses_table_is_dropped(db):
    row = await db.scalar(text("SELECT to_regclass('public.site_statuses')"))
    assert row is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_status_values_model.py -v`
Expected: FAIL — `ImportError: cannot import name 'StatusValue'`

- [ ] **Step 3a: Write the migration**

```python
# api/migrations/versions/0012_status_values.py
"""status_values — one discriminated table for every entity's status
vocabulary. Folds in site_statuses and replaces worker_profiles' status
CHECK constraint.

Revision ID: 0012
Revises: 0011
"""

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels = None
depends_on = None

WORKER_STATUSES = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('worker','active','Active','Available for dispatch.','c-green',1),
      ('worker','standby','Standby','Temporarily unavailable.','c-amber',2),
      ('worker','blacklist','Blacklist','Do not dispatch; reason required.','c-red',3)
"""


def upgrade() -> None:
    op.create_table(
        "status_values",
        sa.Column("record_type", sa.Text, primary_key=True),
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("color", sa.Text, nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )

    # carry the four site statuses over verbatim
    op.execute("""
        INSERT INTO status_values
          (record_type, key, label, description, color, sort_order)
        SELECT 'site', key, label, description, color, sort_order
        FROM site_statuses
    """)
    op.execute(WORKER_STATUSES)

    # a constant column Postgres computes, so it cannot drift — gives the
    # composite FK something to point at
    op.execute("""
        ALTER TABLE sites ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('site') STORED
    """)
    op.execute("""
        ALTER TABLE worker_profiles ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('worker') STORED
    """)

    op.drop_constraint("sites_status_fkey", "sites", type_="foreignkey")
    op.create_foreign_key(
        "sites_status_fkey", "sites", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])
    op.create_foreign_key(
        "worker_profiles_status_fkey", "worker_profiles", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])

    # superseded by the FK above; blacklist_note_check is deliberately kept
    op.drop_constraint("worker_profiles_status_check", "worker_profiles",
                       type_="check")
    op.drop_table("site_statuses")


def downgrade() -> None:
    op.create_table(
        "site_statuses",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("color", sa.Text, nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.execute("""
        INSERT INTO site_statuses (key, label, description, color, sort_order)
        SELECT key, label, description, color, sort_order
        FROM status_values WHERE record_type = 'site'
    """)

    op.drop_constraint("worker_profiles_status_fkey", "worker_profiles",
                       type_="foreignkey")
    op.drop_constraint("sites_status_fkey", "sites", type_="foreignkey")
    op.drop_column("worker_profiles", "status_record_type")
    op.drop_column("sites", "status_record_type")

    op.create_foreign_key(
        "sites_status_fkey", "sites", "site_statuses", ["status"], ["key"])
    op.create_check_constraint(
        "worker_profiles_status_check", "worker_profiles",
        "status IN ('active', 'standby', 'blacklist')")
    op.drop_table("status_values")
```

- [ ] **Step 3b: Update the model**

In `api/src/serversherpa/db/models.py`, delete the `SiteStatus` class (lines 350-358) and add in its place:

```python
class StatusValue(Base):
    """One row per (entity, status) pair. record_type is validated in code
    against status/registry.py, not by a DB constraint — the registry is the
    source of truth for which types exist."""

    __tablename__ = "status_values"

    record_type: Mapped[str] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(primary_key=True)
    label: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    color: Mapped[str]
    sort_order: Mapped[int] = mapped_column(Integer, server_default="0")
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

Change `Site.status` (line 369-370) to drop the now-wrong single-column FK — the composite FK is DB-level only and has no ORM expression:

```python
    status: Mapped[str] = mapped_column(server_default="active")
```

- [ ] **Step 3c: Fix the test harness**

In `api/tests/conftest.py`, replace the `UPDATE site_statuses` block (lines 78-88) with the following. The `DELETE` is new and load-bearing: `POST /status-values` lands in Task 4, so a status created by one test would otherwise survive into the next — the same reason `roles` gets `DELETE ... WHERE is_system = false` above.

```python
        # status_values is editable seed data AND createable — drop customs,
        # then restore canonical values so an admin-edit test can't pollute
        # later runs. Values match migration 0012's seeds.
        await session.execute(text("""
            DELETE FROM status_values WHERE (record_type, key) NOT IN (
              ('site','active'),('site','planned'),('site','inactive'),
              ('site','decommissioned'),
              ('worker','active'),('worker','standby'),('worker','blacklist')
            )
        """))
        await session.execute(text("""
            UPDATE status_values AS sv
            SET label = v.label, description = v.description,
                color = v.color, sort_order = v.sort_order, is_active = true
            FROM (VALUES
              ('site','active','Active','In service.','c-green',1),
              ('site','planned','Planned','Not yet in service.','c-aqua',2),
              ('site','inactive','Inactive','Temporarily out of service.','c-slate',3),
              ('site','decommissioned','Decommissioned','Retired; retained for history.','c-red',4),
              ('worker','active','Active','Available for dispatch.','c-green',1),
              ('worker','standby','Standby','Temporarily unavailable.','c-amber',2),
              ('worker','blacklist','Blacklist','Do not dispatch; reason required.','c-red',3)
            ) AS v(record_type, key, label, description, color, sort_order)
            WHERE sv.record_type = v.record_type AND sv.key = v.key
        """))
```

The `TRUNCATE` on line 53-56 already runs before this and clears `sites`/`site_clients`; `worker_profiles` cascades from `people`. So no FK blocks the `DELETE`.

- [ ] **Step 4: Run the tests**

The test DB is migrated to head once per session by `conftest._prepare_environment`, so it picks up 0012 automatically.

Run: `cd api && .venv/bin/pytest tests/test_status_values_model.py -v`
Expected: 7 passed

Then confirm nothing else broke — `routes/sites.py` still imports `SiteStatus`, so a large failure count here is expected and is Task 3's job:

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -5`
Expected: collection errors from `routes/sites.py` importing `SiteStatus`. Note the count; Task 3 drives it to zero.

- [ ] **Step 5: Verify the downgrade**

Run: `cd api && .venv/bin/alembic downgrade 0011 && .venv/bin/alembic upgrade head`
Expected: both succeed with no error.

- [ ] **Step 6: Commit**

```bash
git add api/migrations/versions/0012_status_values.py api/src/serversherpa/db/models.py api/tests/conftest.py api/tests/test_status_values_model.py
git commit -m "Migrate site + worker statuses into status_values"
```

---

### Task 3: Read endpoints + repoint the sites router

**Files:**
- Create: `api/src/serversherpa/api/routes/status_values.py`
- Modify: `api/src/serversherpa/api/schemas.py` — add near `SiteLookupOut` (line 514)
- Modify: `api/src/serversherpa/api/routes/sites.py` — imports (17-19), `_labels` (48-51), delete `list_site_statuses` (153-160) and `update_site_status` (188-210)
- Modify: `api/src/serversherpa/api/app.py:64` — register the router
- Test: `api/tests/test_status_values_read.py`

**Interfaces:**
- Consumes: `StatusValue` (Task 2), `STATUS_REGISTRY` (Task 1).
- Produces: `StatusValueOut` (`record_type`, `key`, `label`, `description`, `color`, `sort_order`, `is_active`, `usage_count: int | None`); `router` in `routes/status_values.py` (registered as `status_values.router`); `_record_type(record_type: str) -> StatusRecordType`; `_usage_counts(db: DbSession, rt: StatusRecordType) -> dict[str, int]`.

**Context:** `GET /status-values?record_type=site` is gated on that type's `resource:view` and returns active values without counts — this is what the Sites page calls. Unfiltered `GET /status-values` is gated on `devtools:view` and returns everything with counts — this is what the Variables page calls. The count query only runs for the caller that wants it, and an ordinary user can't enumerate record types they have no business seeing.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_status_values_read.py
"""Reads follow the owning entity's view permission; the unfiltered listing
is developer-only because it spans every record type."""

from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password
from serversherpa.config import get_settings
from tests.test_sites_api import login

PW = "CorrectHorse9!"


async def _make(db, client, role, email):
    p = Person(first_name="R", last_name=role.title(), email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    return await login(client, email=email)


async def test_staff_reads_site_statuses_by_record_type(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/status-values?record_type=site", headers=hdrs)
    assert resp.status_code == 200
    rows = resp.json()
    assert [r["key"] for r in rows] == [
        "active", "planned", "inactive", "decommissioned"]
    assert rows[0]["usage_count"] is None      # counts are devtools-only


async def test_entity_scoped_read_omits_inactive(client, db, seeded_user):
    dev = await _make(db, client, "developer", "dev1@test.example.com")
    await client.patch("/status-values/site/planned", headers=dev,
                       json={"is_active": False})
    hdrs = await login(client)
    rows = (await client.get("/status-values?record_type=site",
                             headers=hdrs)).json()
    assert [r["key"] for r in rows] == ["active", "inactive", "decommissioned"]


async def test_staff_refused_the_unfiltered_listing(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/status-values", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_developer_reads_everything_with_counts(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev2@test.example.com")
    resp = await client.get("/status-values", headers=hdrs)
    assert resp.status_code == 200
    rows = resp.json()
    assert {r["record_type"] for r in rows} == {"site", "worker"}
    active_site = next(
        r for r in rows if r["record_type"] == "site" and r["key"] == "active")
    assert active_site["usage_count"] == 0


async def test_usage_count_reflects_referencing_rows(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev3@test.example.com")
    staff = await login(client)
    await client.post("/sites", headers=staff,
                      json={"name": "Counted Site", "status": "planned"})
    rows = (await client.get("/status-values", headers=hdrs)).json()
    planned = next(
        r for r in rows if r["record_type"] == "site" and r["key"] == "planned")
    assert planned["usage_count"] == 1


async def test_unknown_record_type_is_422(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/status-values?record_type=invoice", headers=hdrs)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_record_type"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_status_values_read.py -v`
Expected: FAIL — 404 on `/status-values` (router not registered).

- [ ] **Step 3a: Add the schemas**

In `api/src/serversherpa/api/schemas.py`, immediately before `SiteLookupOut` (line 514):

```python
class StatusValueOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    record_type: str
    key: str
    label: str
    description: str
    color: str
    sort_order: int
    is_active: bool
    # populated only on the devtools-gated listing — an entity-scoped read
    # has no business paying for the count query
    usage_count: int | None = None
```

- [ ] **Step 3b: Write the router**

```python
# api/src/serversherpa/api/routes/status_values.py
"""Status values — one discriminated vocabulary for every entity's status.

Reads follow the owning entity's view permission (a site picker needs the
labels). Writes are developer-only: the *value* on a record is normal data,
but the *vocabulary* is not."""

from fastapi import APIRouter, HTTPException
from sqlalchemy import column, func, select, table

from serversherpa.api.deps import CurrentUser, DbSession
from serversherpa.api.schemas import StatusValueOut
from serversherpa.db.models import StatusValue
from serversherpa.status.registry import STATUS_REGISTRY, StatusRecordType

router = APIRouter(prefix="/status-values", tags=["status-values"])


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _record_type(record_type: str) -> StatusRecordType:
    rt = STATUS_REGISTRY.get(record_type)
    if rt is None:
        raise _err(422, "unknown_record_type")
    return rt


async def _usage_counts(db: DbSession, rt: StatusRecordType) -> dict[str, int]:
    """Count referencing rows per key. Table/column come from the frozen code
    registry, never from user input."""
    t = table(rt.table, column(rt.column))
    rows = (await db.execute(
        select(t.c[rt.column], func.count())
        .group_by(t.c[rt.column]))).all()
    return {key: n for key, n in rows if key is not None}


@router.get("", response_model=list[StatusValueOut])
async def list_status_values(
    db: DbSession,
    actor: CurrentUser,
    record_type: str | None = None,
) -> list[StatusValueOut]:
    if record_type is not None:
        rt = _record_type(record_type)
        if not actor.access.can(rt.resource, "view"):
            raise _err(403, "forbidden")
        rows = (await db.scalars(
            select(StatusValue)
            .where(StatusValue.record_type == rt.id,
                   StatusValue.is_active.is_(True))
            .order_by(StatusValue.sort_order, StatusValue.label))).all()
        return [StatusValueOut.model_validate(r) for r in rows]

    # the unfiltered listing spans every record type — that is the Variables
    # page's view, and it is developer-only
    if not actor.access.can("devtools", "view"):
        raise _err(403, "forbidden")
    rows = (await db.scalars(
        select(StatusValue).order_by(
            StatusValue.record_type, StatusValue.sort_order,
            StatusValue.label))).all()
    counts = {rt.id: await _usage_counts(db, rt)
              for rt in STATUS_REGISTRY.values()}
    out = []
    for r in rows:
        item = StatusValueOut.model_validate(r)
        item.usage_count = counts.get(r.record_type, {}).get(r.key, 0)
        out.append(item)
    return out
```

IMPORTANT: this endpoint gates on `actor.access.can(...)` in the body rather than via a `require_permission(...)` dependency, because which permission is required depends on the query string. `CurrentUser` (`deps.py:88`) is `Annotated[AuthContext, Depends(get_current_user)]` — it authenticates without asserting any permission, which is exactly what's needed. It carries no default, so it must precede `record_type` in the signature.

Do NOT put `require_permission("devtools", "view")` on the whole endpoint — that would 403 the Sites page for every non-developer, which is the bug this split exists to avoid.

- [ ] **Step 3c: Repoint the sites router**

In `api/src/serversherpa/api/routes/sites.py`:

Change the model import (lines 17-19) — `SiteStatus` no longer exists:
```python
from serversherpa.db.models import (
    Client, Partner, Site, SiteClient, SiteType, StatusValue,
)
```

Change `_labels` (lines 48-51):
```python
async def _labels(db: DbSession) -> tuple[dict, dict]:
    types = {t.key: t.label for t in await db.scalars(select(SiteType))}
    statuses = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "site"))}
    return types, statuses
```
`_item`'s `(site.status, "c-slate")` fallback stays — an inactive status still resolves here, because `_labels` doesn't filter on `is_active`. That is deliberate: a site referencing a retired status must still render.

Delete `list_site_statuses` (153-160) and `update_site_status` (188-210) entirely, and drop `SiteLookupOut`/`SiteLookupUpdateIn` from the import list only if `update_site_type` no longer uses them (it does — keep them).

In `_check_lookups` (around line 235-239), the status validation now needs the record type. Read the existing function and change its `SiteStatus` lookup to `StatusValue` filtered on `record_type == "site"`, keeping the `unknown_status` error code unchanged.

- [ ] **Step 3d: Register the router**

In `api/src/serversherpa/api/app.py`, after line 64 (`app.include_router(sites.lookups_router)`):
```python
    app.include_router(status_values.router)
```
and add `status_values` to the `from serversherpa.api.routes import (...)` list at the top of the file.

- [ ] **Step 4: Run the tests**

Run: `cd api && .venv/bin/pytest tests/test_status_values_read.py -v`
Expected: 6 passed. `test_entity_scoped_read_omits_inactive` will FAIL until Task 4 lands `PATCH` — mark it `@pytest.mark.xfail(reason="PATCH lands in Task 4", strict=True)` for now and remove the marker in Task 4.

Now the suite must be green again:

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -5`
Expected: all pass except `tests/test_sites_lookups.py`'s two site-status tests, which reference deleted endpoints. Delete `test_admin_patches_site_status_color` (lines 53-68) and the site-status half of `test_unknown_lookup_key_404s` (lines 78-81) and the site-status half of `test_non_global_actor_with_settings_override_forbidden` (lines 105-108) — those endpoints are gone. Their replacements live in Task 4.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/status_values.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/sites.py api/src/serversherpa/api/app.py api/tests/test_status_values_read.py api/tests/test_sites_lookups.py
git commit -m "Serve status values, repoint the sites router"
```

---

### Task 4: Write endpoints

**Files:**
- Modify: `api/src/serversherpa/api/routes/status_values.py`
- Modify: `api/src/serversherpa/api/schemas.py`
- Modify: `api/tests/test_status_values_read.py` — drop the `xfail` marker
- Test: `api/tests/test_status_values_write.py`

**Interfaces:**
- Consumes: `StatusValueOut`, `status_values_router`, `_record_type` (Task 3).
- Produces: `StatusValueCreateIn`, `StatusValueUpdateIn`; `POST /status-values`, `PATCH /status-values/{record_type}/{key}`.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_status_values_write.py
"""The vocabulary is developer-only; the value on a record is not. A
settings:change admin who can still edit a site's status must not be able to
invent a new one."""

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog, Client, Person, PersonRole, PermissionOverride, UserAccount,
)
from serversherpa.security.passwords import hash_password
from tests.test_sites_api import login, make_login

PW = "CorrectHorse9!"


async def _make(db, client, role, email):
    p = Person(first_name="R", last_name="X", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    return await login(client, email=email)


async def test_developer_creates_a_status(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.post("/status-values", headers=hdrs, json={
        "record_type": "site", "key": "mothballed", "label": "Mothballed",
        "description": "Shut down, retained.", "color": "c-violet",
        "sort_order": 5,
    })
    assert resp.status_code == 201
    assert resp.json()["key"] == "mothballed"
    assert resp.json()["is_active"] is True

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "status_value", AuditLog.action == "create"))
    assert audit_row is not None
    assert audit_row.entity_id == "site:mothballed"


async def test_created_status_is_usable_on_a_site(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev2@test.example.com")
    await client.post("/status-values", headers=hdrs, json={
        "record_type": "site", "key": "mothballed", "label": "Mothballed",
        "color": "c-violet", "sort_order": 5,
    })
    staff = await login(client)
    resp = await client.post("/sites", headers=staff, json={
        "name": "Mothball Site", "status": "mothballed"})
    assert resp.status_code == 201


async def test_duplicate_key_within_a_record_type_is_409(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev3@test.example.com")
    resp = await client.post("/status-values", headers=hdrs, json={
        "record_type": "site", "key": "active", "label": "Dupe",
        "color": "c-green",
    })
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "status_value_exists"


async def test_same_key_across_record_types_is_allowed(client, db, seeded_user):
    """'active' already exists for both site and worker — the composite PK is
    what makes that fine."""
    hdrs = await _make(db, client, "developer", "dev4@test.example.com")
    rows = (await client.get("/status-values", headers=hdrs)).json()
    actives = [r for r in rows if r["key"] == "active"]
    assert {r["record_type"] for r in actives} == {"site", "worker"}


async def test_deactivating_an_in_use_status_keeps_the_record_rendering(
        client, db, seeded_user):
    """No DELETE — is_active is the retirement mechanism, and the FK is what
    makes it safe."""
    dev = await _make(db, client, "developer", "dev5@test.example.com")
    staff = await login(client)
    site = (await client.post("/sites", headers=staff, json={
        "name": "Retired Status Site", "status": "planned"})).json()

    resp = await client.patch("/status-values/site/planned", headers=dev,
                              json={"is_active": False})
    assert resp.status_code == 200
    assert resp.json()["is_active"] is False

    row = (await client.get(f"/sites/{site['id']}", headers=staff)).json()
    assert row["status"] == "planned"
    assert row["status_label"] == "Planned"       # still renders
    assert row["status_color"] == "c-aqua"


async def test_key_and_record_type_are_immutable(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev6@test.example.com")
    resp = await client.patch("/status-values/site/active", headers=hdrs,
                              json={"key": "renamed"})
    assert resp.status_code == 422


async def test_admin_with_settings_change_cannot_touch_the_vocabulary(
        client, db, seeded_user):
    """The capability admins lose: PATCH /site-statuses was settings:change."""
    hdrs = await _make(db, client, "admin", "ada@test.example.com")
    resp = await client.patch("/status-values/site/active", headers=hdrs,
                              json={"label": "Live"})
    assert resp.status_code == 403
    resp = await client.post("/status-values", headers=hdrs, json={
        "record_type": "site", "key": "x", "label": "X", "color": "c-green"})
    assert resp.status_code == 403


async def test_non_global_actor_with_devtools_override_is_hard_gated(
        client, db, seeded_user):
    """devtools is developer_only + visible_to={'global'} — the resolver hard
    gate blocks before overrides are read, so no _require_global is needed."""
    acme = Client(name="Acme SV")
    db.add(acme)
    await db.flush()
    contact = Person(first_name="C", last_name="SV")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_admin", client_id=acme.id))
    db.add(PermissionOverride(person_id=contact.id, resource="devtools",
                              action="change", allow=True))
    await db.commit()
    hdrs = await make_login(db, client, contact, "sv@acme.example.com")

    resp = await client.patch("/status-values/site/active", headers=hdrs,
                              json={"label": "Sneaky"})
    assert resp.status_code == 403


async def test_unknown_key_404s(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev7@test.example.com")
    resp = await client.patch("/status-values/site/haunted", headers=hdrs,
                              json={"label": "Nope"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "status_value_not_found"


async def test_patch_writes_an_audit_row(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev8@test.example.com")
    await client.patch("/status-values/site/active", headers=hdrs,
                       json={"label": "Live"})
    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "status_value", AuditLog.action == "update"))
    assert audit_row is not None
    assert audit_row.entity_id == "site:active"
    assert audit_row.changes["label"]["to"] == "Live"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_status_values_write.py -v`
Expected: FAIL — 405 Method Not Allowed on POST/PATCH.

- [ ] **Step 3a: Add the schemas**

In `api/src/serversherpa/api/schemas.py`, after `StatusValueOut`:

```python
class StatusValueCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_type: str
    # slug, not prose — this is a stable identifier code may compare against
    key: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")
    label: str = Field(min_length=1)
    description: str = ""
    color: str = Field(min_length=1)
    sort_order: int = 0


class StatusValueUpdateIn(BaseModel):
    # extra="forbid" is what makes key/record_type immutable — a PATCH naming
    # them is a 422, not a silent no-op
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(None, min_length=1)
    description: str | None = None
    color: str | None = Field(None, min_length=1)
    sort_order: int | None = None
    is_active: bool | None = None
```

- [ ] **Step 3b: Add the endpoints**

Append to `api/src/serversherpa/api/routes/status_values.py`:

```python
@router.post("", response_model=StatusValueOut, status_code=201)
async def create_status_value(
    body: StatusValueCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "add"),
) -> StatusValueOut:
    rt = _record_type(body.record_type)
    existing = await db.get(StatusValue, (rt.id, body.key))
    if existing is not None:
        raise _err(409, "status_value_exists")
    row = StatusValue(
        record_type=rt.id, key=body.key, label=body.label,
        description=body.description, color=body.color,
        sort_order=body.sort_order, is_active=True,
        updated_at=datetime.now(UTC),
    )
    db.add(row)
    audit(db, actor_id=actor.person.id, entity_type="status_value",
          entity_id=f"{rt.id}:{body.key}", action="create",
          changes=diff({}, snapshot(row, STATUS_FIELDS)))
    await db.commit()
    return StatusValueOut.model_validate(row)


@router.patch("/{record_type}/{key}", response_model=StatusValueOut)
async def update_status_value(
    record_type: str,
    key: str,
    body: StatusValueUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> StatusValueOut:
    rt = _record_type(record_type)
    row = await db.get(StatusValue, (rt.id, key))
    if row is None:
        raise _err(404, "status_value_not_found")
    before = snapshot(row, STATUS_FIELDS)
    # `is not None` guards are wrong for is_active — False is a real value.
    # exclude_unset already means "the caller named this field".
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    changes = diff(before, snapshot(row, STATUS_FIELDS))
    if changes:
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="status_value",
              entity_id=f"{rt.id}:{key}", action="update", changes=changes)
    await db.commit()
    return StatusValueOut.model_validate(row)
```

Add to the top of the file:
```python
from datetime import UTC, datetime

from serversherpa.api.deps import require_permission
from serversherpa.api.schemas import StatusValueCreateIn, StatusValueUpdateIn
from serversherpa.services.audit import audit, diff, snapshot

STATUS_FIELDS = ["label", "description", "color", "sort_order", "is_active"]
```

NOTE the deviation from `routes/sites.py:176-178`, which does `if field in fields and value is not None`. That pattern silently drops `is_active=False`. `extra="forbid"` already rejects unknown fields and `exclude_unset` already distinguishes "not sent" from "sent as null", so the guard is both unnecessary and wrong here.

- [ ] **Step 3c: Un-xfail the Task 3 test**

Remove the `@pytest.mark.xfail` marker from `test_entity_scoped_read_omits_inactive` in `api/tests/test_status_values_read.py`.

- [ ] **Step 4: Run the tests**

Run: `cd api && .venv/bin/pytest tests/test_status_values_write.py tests/test_status_values_read.py -v`
Expected: all pass (10 + 6).

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -3`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/status_values.py api/src/serversherpa/api/schemas.py api/tests/test_status_values_write.py api/tests/test_status_values_read.py
git commit -m "Create and edit status values, developer-gated"
```

---

### Task 5: Move site-type and worker-level gates to devtools

**Files:**
- Modify: `api/src/serversherpa/api/routes/sites.py:163-185` — `update_site_type`
- Modify: `api/src/serversherpa/api/routes/workers.py:275-295` — `list_worker_levels`, `update_worker_level`
- Modify: `api/tests/test_sites_lookups.py`
- Test: `api/tests/test_lookup_gates.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: no new symbols; three endpoints change gates.

**Context:** Same rule as statuses — setting a site's type is `sites:change`, but editing what types *exist* is vocabulary. `GET /worker-levels` currently uses `require_roles("admin","staff","worker")`, which silently excludes `developer` and `founder` by name; the Worker levels tab hits that immediately.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_lookup_gates.py
"""Vocabulary editing is developer-only across all three tabs; reading stays
on the owning entity's view permission."""

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password
from tests.test_sites_api import login

PW = "CorrectHorse9!"


async def _make(db, client, role, email):
    p = Person(first_name="R", last_name="X", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    return await login(client, email=email)


async def test_admin_cannot_edit_site_types(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "ada@test.example.com")
    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"label": "Nope"})
    assert resp.status_code == 403


async def test_developer_can_edit_site_types(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"label": "Data Center v2"})
    assert resp.status_code == 200
    assert resp.json()["label"] == "Data Center v2"


async def test_admin_cannot_edit_worker_levels(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "ada2@test.example.com")
    resp = await client.patch("/worker-levels/L3", headers=hdrs,
                              json={"title": "Nope"})
    assert resp.status_code == 403


async def test_developer_can_edit_worker_levels(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev2@test.example.com")
    resp = await client.patch("/worker-levels/L3", headers=hdrs,
                              json={"title": "Tech II"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "Tech II"


async def test_developer_can_read_worker_levels(client, db, seeded_user):
    """The old require_roles('admin','staff','worker') excluded developer by
    name — the Worker levels tab would 403 on its own list."""
    hdrs = await _make(db, client, "developer", "dev3@test.example.com")
    resp = await client.get("/worker-levels", headers=hdrs)
    assert resp.status_code == 200
    assert [r["level"] for r in resp.json()] == [
        "L1", "L2", "L3", "L4", "L5", "L6"]


async def test_staff_still_reads_worker_levels(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/worker-levels", headers=hdrs)
    assert resp.status_code == 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/pytest tests/test_lookup_gates.py -v`
Expected: FAIL — `test_admin_cannot_edit_site_types` gets 200 (admin still allowed); `test_developer_can_read_worker_levels` gets 403.

- [ ] **Step 3: Change the gates**

In `api/src/serversherpa/api/routes/sites.py`, `update_site_type` (line 168) — change the dependency and delete the `_require_global(actor)` call on line 170 (the devtools hard gate already implies global):
```python
    actor: AuthContext = require_permission("devtools", "change"),
```

In `api/src/serversherpa/api/routes/workers.py`:
- `list_worker_levels` (line ~275) — replace `require_roles("admin", "staff", "worker")` with `require_permission("workers", "view")`. Remove the `require_roles` import if nothing else in the file uses it.
- `update_worker_level` (line ~285) — replace `require_permission("settings", "change")` with `require_permission("devtools", "change")`.

Check whether `_require_global` in `sites.py` still has callers after this change (the six site mutations use it — it stays).

- [ ] **Step 4: Run the tests**

Run: `cd api && .venv/bin/pytest tests/test_lookup_gates.py -v`
Expected: 6 passed

`test_sites_lookups.py` now fails — its `_make_admin` helper builds an admin and expects 200. Update it: change `_make_admin` to create a `developer` role instead, rename it `_make_developer`, and delete `test_non_global_actor_with_settings_override_forbidden` (the `settings:change` gate it pins no longer exists; `test_lookup_gates.py` and `test_status_values_write.py` cover the replacement).

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -3`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/sites.py api/src/serversherpa/api/routes/workers.py api/tests/test_lookup_gates.py api/tests/test_sites_lookups.py
git commit -m "Gate lookup vocabulary editing on devtools"
```

---

### Task 6: Portal API client

**Files:**
- Modify: `portal/src/lib/api.ts:750-762` — `listSiteStatuses`, and add the status-value functions

**Interfaces:**
- Consumes: the Task 3/4 endpoints.
- Produces: `StatusValue` interface (`record_type`, `key`, `label`, `description`, `color`, `sort_order`, `is_active`, `usage_count: number | null`), `WorkerLevel` interface, and the functions `listStatusValues()`, `createStatusValue(body)`, `updateStatusValue(recordType, key, body)`, `updateSiteType(key, body)`, `listWorkerLevels()`, `updateWorkerLevel(level, body)`. `listSiteStatuses()` keeps its existing name and `Promise<SiteLookup[]>` signature — only its URL changes.

**Context:** Every function here is the same four lines — `apiFetch`, `if (!resp.ok) throw await errorFrom(resp)`, `return resp.json()`. Follow `listSites`/`updateSite` (lines 654-700) exactly. Response types are hand-written interfaces mirroring the Pydantic schemas; there is no codegen.

- [ ] **Step 1: Write the code**

Replace `listSiteStatuses` (around line 756) — same signature, new endpoint, so `Sites.tsx` and `SiteEditModal.tsx` need no change:

```ts
export interface StatusValue {
  record_type: string;
  key: string;
  label: string;
  description: string;
  color: string;
  sort_order: number;
  is_active: boolean;
  usage_count: number | null;
}

// The site picker's statuses. Server filters to is_active and omits counts.
export async function listSiteStatuses(): Promise<SiteLookup[]> {
  const resp = await apiFetch('/status-values?record_type=site');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

// The Variables page's view: every record type, including inactive, with counts.
export async function listStatusValues(): Promise<StatusValue[]> {
  const resp = await apiFetch('/status-values');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createStatusValue(
  body: Record<string, unknown>,
): Promise<StatusValue> {
  const resp = await apiFetch('/status-values', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateStatusValue(
  recordType: string, key: string, body: Record<string, unknown>,
): Promise<StatusValue> {
  const resp = await apiFetch(`/status-values/${recordType}/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateSiteType(
  key: string, body: Record<string, unknown>,
): Promise<SiteLookup> {
  const resp = await apiFetch(`/site-types/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateWorkerLevel(
  level: string, body: Record<string, unknown>,
): Promise<WorkerLevel> {
  const resp = await apiFetch(`/worker-levels/${level}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

`SiteLookup` (`api.ts:669`) is the existing interface backing `listSiteTypes`/`listSiteStatuses`. Reuse it; do not introduce a parallel type.

There is no worker-level type or client function anywhere in the portal today — `Workers.tsx:168` calls `apiFetch('/worker-levels')` raw and leaves the result untyped, the one place bypassing this module's convention. Add both here:

```ts
export interface WorkerLevel {
  level: string;
  rank: number;
  title: string;
  description: string;
  expected_skills: string[];
}

export async function listWorkerLevels(): Promise<WorkerLevel[]> {
  const resp = await apiFetch('/worker-levels');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

Leave `Workers.tsx:168` alone — repointing it is a real improvement but not this change's job.

- [ ] **Step 2: Typecheck**

Run: `cd portal && npx tsc --noEmit`
Expected: no errors.

Run: `cd portal && npm test`
Expected: existing suite green.

- [ ] **Step 3: Commit**

```bash
git add portal/src/lib/api.ts
git commit -m "Portal client for status values"
```

---

### Task 7: Portal pure helpers

**Files:**
- Create: `portal/src/lib/variables.ts`
- Test: `portal/src/lib/variables.test.ts`

**Interfaces:**
- Consumes: `StatusValue` from `lib/api.ts` (Task 6).
- Produces: `statusSearchText(v)`, `recordTypeOptions(values)`, `statusFormFromValue(v)`, `statusCreatePayload(form)`, `statusUpdatePayload(form, original)`, `needsStatusCreate(original, createdKey)`, `StatusForm` type.

**Context:** House convention — anything testable leaves the component. See `lib/sites.ts` + `lib/sites.test.ts`. `needsStatusCreate` mirrors `needsSiteCreate` (`lib/sites.ts:163-181`): once `POST` succeeds, a retry after a later failure must never re-create.

- [ ] **Step 1: Write the failing test**

```ts
// portal/src/lib/variables.test.ts
import { describe, expect, it } from 'vitest';
import {
  needsStatusCreate, recordTypeOptions, statusCreatePayload,
  statusFormFromValue, statusSearchText, statusUpdatePayload,
} from './variables';
import type { StatusValue } from './api';

const value: StatusValue = {
  record_type: 'site', key: 'planned', label: 'Planned',
  description: 'Not yet in service.', color: 'c-aqua',
  sort_order: 2, is_active: true, usage_count: 3,
};

describe('statusSearchText', () => {
  it('covers key, label, description and record type', () => {
    const text = statusSearchText(value);
    expect(text).toContain('planned');
    expect(text).toContain('not yet in service');
    expect(text).toContain('site');
  });

  it('is lowercased so callers can compare directly', () => {
    expect(statusSearchText(value)).toBe(statusSearchText(value).toLowerCase());
  });
});

describe('recordTypeOptions', () => {
  it('lists each record type once, sorted', () => {
    const worker = { ...value, record_type: 'worker', key: 'standby' };
    expect(recordTypeOptions([value, worker, { ...value, key: 'active' }]))
      .toEqual([
        { value: 'site', label: 'site' },
        { value: 'worker', label: 'worker' },
      ]);
  });

  it('is empty for no values', () => {
    expect(recordTypeOptions([])).toEqual([]);
  });
});

describe('statusUpdatePayload', () => {
  it('sends only what changed', () => {
    const form = { ...statusFormFromValue(value), label: 'Scheduled' };
    expect(statusUpdatePayload(form, value)).toEqual({ label: 'Scheduled' });
  });

  it('sends is_active false rather than dropping it', () => {
    const form = { ...statusFormFromValue(value), is_active: false };
    expect(statusUpdatePayload(form, value)).toEqual({ is_active: false });
  });

  it('is empty when nothing changed', () => {
    expect(statusUpdatePayload(statusFormFromValue(value), value)).toEqual({});
  });

  it('coerces sort_order to a number', () => {
    const form = { ...statusFormFromValue(value), sort_order: '7' };
    expect(statusUpdatePayload(form, value)).toEqual({ sort_order: 7 });
  });
});

describe('statusCreatePayload', () => {
  it('carries every required field', () => {
    const form = {
      record_type: 'site', key: 'mothballed', label: 'Mothballed',
      description: '', color: 'c-violet', sort_order: '5', is_active: true,
    };
    expect(statusCreatePayload(form)).toEqual({
      record_type: 'site', key: 'mothballed', label: 'Mothballed',
      description: '', color: 'c-violet', sort_order: 5,
    });
  });
});

describe('needsStatusCreate', () => {
  it('creates when editing nothing and nothing was created yet', () => {
    expect(needsStatusCreate(null, null)).toBe(true);
  });

  it('does not re-create after a successful create', () => {
    expect(needsStatusCreate(null, 'mothballed')).toBe(false);
  });

  it('never creates when editing an existing value', () => {
    expect(needsStatusCreate(value, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd portal && npm test -- variables`
Expected: FAIL — cannot resolve `./variables`.

- [ ] **Step 3: Write the implementation**

```ts
// portal/src/lib/variables.ts
// Pure helpers for the Variables page. Kept out of the component so they can
// be tested without a live API — same convention as lib/sites.ts.
import type { StatusValue } from './api';

export interface StatusForm {
  record_type: string;
  key: string;
  label: string;
  description: string;
  color: string;
  sort_order: string;   // form state is a string; coerced on the way out
  is_active: boolean;
}

export function statusSearchText(v: StatusValue): string {
  return [v.record_type, v.key, v.label, v.description]
    .join(' ').toLowerCase();
}

export function recordTypeOptions(
  values: StatusValue[],
): { value: string; label: string }[] {
  return [...new Set(values.map((v) => v.record_type))]
    .sort()
    .map((t) => ({ value: t, label: t }));
}

export function statusFormFromValue(v: StatusValue): StatusForm {
  return {
    record_type: v.record_type,
    key: v.key,
    label: v.label,
    description: v.description,
    color: v.color,
    sort_order: String(v.sort_order),
    is_active: v.is_active,
  };
}

export function statusCreatePayload(form: StatusForm): Record<string, unknown> {
  return {
    record_type: form.record_type,
    key: form.key,
    label: form.label,
    description: form.description,
    color: form.color,
    sort_order: Number(form.sort_order),
  };
}

// The server forbids unknown fields and treats "sent" as "set" — so send only
// what actually changed. is_active is a boolean: a falsy check would drop it.
export function statusUpdatePayload(
  form: StatusForm, original: StatusValue,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.label !== original.label) out.label = form.label;
  if (form.description !== original.description) {
    out.description = form.description;
  }
  if (form.color !== original.color) out.color = form.color;
  if (Number(form.sort_order) !== original.sort_order) {
    out.sort_order = Number(form.sort_order);
  }
  if (form.is_active !== original.is_active) out.is_active = form.is_active;
  return out;
}

// Once POST succeeds, a retry after a later failure must never re-create.
// Mirrors needsSiteCreate in lib/sites.ts.
export function needsStatusCreate(
  original: StatusValue | null, createdKey: string | null,
): boolean {
  return original === null && createdKey === null;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd portal && npm test -- variables`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/variables.ts portal/src/lib/variables.test.ts
git commit -m "Pure helpers for the Variables page"
```

---

### Task 8: The Variables page

**Files:**
- Create: `portal/src/pages/Variables.tsx`
- Create: `portal/src/components/variables/StatusEditModal.tsx`
- Create: `portal/src/components/variables/SiteTypeEditModal.tsx`
- Create: `portal/src/components/variables/WorkerLevelEditModal.tsx`
- Modify: `portal/src/styles/directory.css` — tab strip, if no existing class fits

**Interfaces:**
- Consumes: Task 6 client functions, Task 7 helpers, `FilterButton`/`ColumnsButton`/`ExportButton`/`exportCsv`/`passesFacets`/`facetCount` from `lib/listTools.tsx`, `ComboBox` from `components/ComboBox.tsx`.
- Produces: default-exported `Variables` page component.

**Context — read these first:** `pages/Sites.tsx` end to end, and `components/sites/SiteEditModal.tsx`. This page is the same pattern three times; do not invent new UI vocabulary.

Non-negotiable house rules (each has bitten before):
- Row expansion is **read-only**. Every control lives behind an Edit button in a modal. (`Sites.tsx:395-474`)
- Any dropdown over records uses `ComboBox`, never a native `<select>`. Record type and colour are tiny fixed enums, so a native `<select>` is correct for *those two* — see the rule at `ComboBox.tsx:1-6`.
- Toolbar order is search → result count → Filters → Columns → Export → primary action. (`Sites.tsx:257-285`)
- No card grids.

- [ ] **Step 1: Build the page shell with tabs**

Tabs are page-local `useState`, not routes. Each tab owns its own facet and column state, so switching tabs does not leak a filter.

```tsx
type Tab = 'statuses' | 'site-types' | 'worker-levels';

const TABS: { id: Tab; label: string }[] = [
  { id: 'statuses', label: 'Statuses' },
  { id: 'site-types', label: 'Site types' },
  { id: 'worker-levels', label: 'Worker levels' },
];
```

The page renders a heading, the tab strip, and the active tab's list component (`StatusesTab`, `SiteTypesTab`, `WorkerLevelsTab` — all in `Variables.tsx`; they are small and change together).

- [ ] **Step 2: Statuses tab**

- Loads `listStatusValues()` on mount into `useState<StatusValue[] | null>(null)` (null = loading), exactly like `Sites.tsx:115-133`. Handle 403 via `err instanceof ApiError && err.status === 403`.
- Columns (`ColumnDef[]`): `record_type` (Type, `0.8fr`, default), `key` (Key, `1fr`, default), `label` (Label, `1.2fr`, default), `description` (Description, `2fr`, default), `color` (Colour, `0.8fr`, default — renders a swatch, not the token string), `sort_order` (Order, `0.6fr`, default), `is_active` (Active, `0.6fr`, default), `usage_count` (In use, `0.7fr`, default).
- Facets: `record_type` (from `recordTypeOptions()`) and a synthetic `is_active` yes/no group. Filter with `passesFacets` — the generic idiom. (`Sites.tsx` uses its own `matchesSiteFilters`; do not copy that, it is site-specific.)
- Search over `statusSearchText`.
- Sort by `record_type`, then `sort_order`, then `label`.
- `+ New status` when `can('devtools', 'add')`, opening `StatusEditModal` with `value={null}`.
- Export via `exportCsv('status-values', CSV_COLUMNS, visible)` — export all fields, not just visible ones.
- Row detail: read-only, showing description, colour token, usage count, and an Edit button when `can('devtools', 'change')`.

- [ ] **Step 3: StatusEditModal**

Follows `SiteEditModal.tsx` structure: `.modal-scrim` > `.modal-card` > `.modal-head`/`.modal-body`/`.modal-foot`; mousedown on the scrim closes unless `saving`.

- Create and edit render the same component; create passes `value={null}`.
- In create mode: `record_type` is a native `<select>` over `STATUS_RECORD_TYPES` (hardcode `['site', 'worker']` — it is a code registry, and the portal has no endpoint to read it; a `// keep in sync with api/src/serversherpa/status/registry.py` comment is required). `key` is editable.
- In edit mode: `record_type` and `key` render as read-only text. The server rejects them with a 422 (`extra="forbid"`), so a disabled input would be a lie about what is possible — show them as plain text with a hint that they are permanent.
- `color` is a native `<select>` over the token list: `c-green`, `c-amber`, `c-red`, `c-aqua`, `c-slate`, `c-blue`, `c-violet`. Each option shows a swatch.
- `is_active` is a checkbox, edit mode only. Label it "Available in pickers" — that is what it does. When `usage_count > 0`, show "N records use this value. They keep their label and colour." next to it.
- Save: `needsStatusCreate(value, createdKey)` decides POST vs PATCH. On a successful create, store the key in `createdKey` state before anything else can fail. Payloads come from `statusCreatePayload` / `statusUpdatePayload`; skip the PATCH entirely when `statusUpdatePayload` returns `{}`.
- Error map, following `SITE_ERRORS` (`SiteEditModal.tsx:55-71`):
```tsx
const STATUS_ERRORS: Record<string, string> = {
  status_value_exists: 'That key already exists for this record type.',
  status_value_not_found: 'That status value no longer exists.',
  unknown_record_type: 'That record type is not recognised.',
  forbidden: 'You do not have permission to change the vocabulary.',
};
```
- `onSaved={() => load()}` — the parent refetches. No cache invalidation.

- [ ] **Step 4: Site types tab**

`listSiteTypes()`. Columns: `key`, `label`, `description`, `sort_order`, `icon`. No facets beyond search (there is nothing to facet on — one record type, no active flag). Edit-only: **no `+ New` button**. `SiteTypeEditModal` edits `label`, `description`, `sort_order`, `icon` via `updateSiteType`. `key` renders read-only.

- [ ] **Step 5: Worker levels tab**

`listWorkerLevels()` from Task 6. Columns: `level`, `rank`, `title`, `description`, `expected_skills` (renders as chips). Edit-only. `WorkerLevelEditModal` edits `title`, `description`, `expected_skills` via `updateWorkerLevel`. `level` and `rank` render read-only — `rank` is unique-constrained and not patchable, so reordering is out of scope.

- [ ] **Step 6: Typecheck and test**

Run: `cd portal && npx tsc --noEmit`
Expected: no errors.

Run: `cd portal && npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add portal/src/pages/Variables.tsx portal/src/components/variables/ portal/src/styles/
git commit -m "Variables page: statuses, site types, worker levels"
```

---

### Task 9: Route, nav, palette, breadcrumb

**Files:**
- Modify: `portal/src/App.tsx:43` — add the route
- Modify: `portal/src/layout/AppShell.tsx:154-170` — Developer section
- Modify: `portal/src/components/CommandPalette.tsx:74-83` — `navGated` line
- Modify: `portal/src/lib/access.ts:11-23` — `ROUTE_RESOURCE`
- Modify: `portal/src/components/Topbar.tsx:14-36` — `CRUMBS`, `PAGES`
- Test: `portal/src/lib/godmode.test.ts`

**Interfaces:**
- Consumes: `Variables` from Task 8.
- Produces: the `/dev/database/variables` route.

**Context:** Six places, none derived from each other. `ROUTE_RESOURCE` in both `lib/access.ts` and `access/resources.py` is test-only — the real binding is the `resource=` prop on `<ProtectedRoute>` in `App.tsx`. `devtools` keeps `routes=()` in the Python registry; the god-mode spec omits them deliberately and that stays.

- [ ] **Step 1: Write the failing test**

Add to `portal/src/lib/godmode.test.ts`:

```ts
it('hides Variables without god mode even when devtools is held', () => {
  const item = {
    to: '/dev/database/variables', label: 'Variables',
    resource: 'devtools', godOnly: true, icon: null,
  };
  const can = () => true;                    // holds devtools:view
  expect(isNavItemVisible(item, can, false)).toBe(false);
  expect(isNavItemVisible(item, can, true)).toBe(true);
});
```

Match the existing tests' exact construction of `item` and `can` (`godmode.test.ts:23-27`) rather than the sketch above.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd portal && npm test -- godmode`
Expected: PASS already — `isNavItemVisible` is generic and needs no change. This test pins the `godOnly: true` requirement for the nav entry added in Step 3; if it passes now, that is correct. The real failure mode it guards is a future edit dropping `godOnly` from the nav item.

- [ ] **Step 3: Wire the six places**

`App.tsx`, after line 43:
```tsx
<Route path="/dev/database/variables" element={
  <ProtectedRoute resource="devtools"><Variables /></ProtectedRoute>
} />
```

`AppShell.tsx`, in the Developer section's `items` array after the `/dev` entry — `godOnly: true` is required, or the page appears in the sidebar for anyone holding `devtools` whether or not they have unlocked god mode:
```tsx
{
  to: '/dev/database/variables', label: 'Variables',
  resource: 'devtools', godOnly: true,
  icon: (/* an inline SVG, matching the style of the others */),
},
```

`CommandPalette.tsx`, alongside the other `navGated` lines:
```tsx
navGated('Variables', '/dev/database/variables', 'devtools', true),
```

`lib/access.ts` `ROUTE_RESOURCE`:
```ts
'/dev/database/variables': 'devtools',
```

`Topbar.tsx` `CRUMBS` — `/dev` has no entry today, so its breadcrumb reads just "Portal". Add both while here:
```ts
'/dev': ['Portal', 'Developer tools'],
'/dev/database/variables': ['Portal', 'Developer tools', 'Database', 'Variables'],
```
Do **not** add these to `PAGES` (the global-search page index). `PAGES` is not god-gated, so an entry there would surface "Variables" in search for anyone with `devtools` regardless of god mode — a leak of the same kind the palette's `navGated` exists to prevent. Check how `PAGES` is filtered before deciding; if it runs through `isNavItemVisible`, add it, otherwise leave it out.

- [ ] **Step 4: Verify**

Run: `cd portal && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add portal/src/App.tsx portal/src/layout/AppShell.tsx portal/src/components/CommandPalette.tsx portal/src/lib/access.ts portal/src/components/Topbar.tsx portal/src/lib/godmode.test.ts
git commit -m "Route and reveal the Variables page"
```

---

### Task 10: End-to-end verification

**Files:** none — this task only observes.

- [ ] **Step 1: Full API suite**

Run: `cd api && .venv/bin/pytest tests/ -q 2>&1 | tail -3`
Expected: all pass, no xfail, no skips beyond pre-existing ones.

- [ ] **Step 2: Full portal suite + typecheck**

Run: `cd portal && npx tsc --noEmit && npm test && npm run lint`
Expected: green.

- [ ] **Step 3: Apply the migration to the dev DB**

The dev database is separate from the test database and does not migrate itself.

Run: `cd api && .venv/bin/alembic upgrade head`
Expected: `0012` applies cleanly. If a dev `uvicorn` is running, restart it so it loads the new model — a stale process will 500 on `StatusValue`.

- [ ] **Step 4: Hand the browser pass to the plan owner**

STOP HERE. Do not attempt a browser walkthrough.

The portal sits behind a login, and entering credentials is not something an agent or the controller may do — this is a standing constraint recorded in the progress ledger from the Sites and God-mode branches, where the same gap was flagged by three separate reviews. Automated tests are the only verification this branch can self-serve.

Report to the plan owner: the branch is code-complete and green, and the following need a human at a logged-in browser. Anything not on this list is covered by tests.

1. Unlock god mode (⌘K, type a word from `SS_GOD_MODE_WORDS` in `.env`, press Enter while "no results" is showing). Confirm the Developer section now lists both `Developer tools` and `Variables`.
2. Open Variables. Confirm all three tabs load, the record-type facet filters the Statuses tab, and Export downloads a CSV.
3. Create a status (`site` / `mothballed`), then open `/sites` and confirm it appears in the status picker.
4. Deactivate `mothballed` in Variables. Confirm it leaves the site picker, and that a site already carrying it still renders its label and colour.
5. Exit god mode. Confirm the Variables nav item disappears, but `/dev/database/variables` still loads when navigated to directly — the route is permission-gated, not god-gated, per the god-mode spec.
6. Confirm the breadcrumb reads "Portal / Developer tools / Database / Variables".
