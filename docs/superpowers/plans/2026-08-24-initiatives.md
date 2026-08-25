# Unified Initiatives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `initiatives` section replacing V2's separate projects/events/moves — a single table with an `initiative_type` field, people assignments, and initiative↔initiative links, per `docs/superpowers/specs/2026-08-24-initiatives-design.md`.

**Architecture:** Standard V3 domain, cloned from the Containers exemplar: Alembic migration seeding `status_values` vocabularies with generated-column composite FKs; flat additions to `db/models.py` / `api/schemas.py`; one router `api/routes/initiatives.py` with machine-coded errors, in-transaction audit, and soft archive; one portal page + one edit modal with pure logic in `lib/initiatives.ts`.

**Tech Stack:** FastAPI + SQLAlchemy (async) + Alembic + Postgres; React + Vite + vitest. No new dependencies.

## Global Constraints

- API checks: `cd api && .venv/bin/pytest` (uses the `serversherpa_test` DB; docker compose Postgres must be up). Portal checks: `cd portal && npx tsc --noEmit && npx vitest run`.
- All pydantic inputs: `model_config = ConfigDict(extra="forbid")`; update inputs all-optional.
- Every API error is `{"code": "<machine_code>", ...}` via `_err()` — never prose.
- House palette only: `#178a4c` green, `#0f7c86` teal, `#51606f` slate, `#c03540` red, `#a36207` amber, `#1668a7` blue, `#6d4fc4` violet. Fallback chip color `#51606f`.
- Vocab keys are snake_case; three fields per enum in payloads: key + `*_label` + `*_color`.
- `access/defaults.py` grants and the migration's grant seeding must match exactly.
- Route ordering: literal paths before `/{id}` routes.
- Commit after every task with the exact message given.

---

### Task 1: Migration, models, registries, conftest

**Files:**
- Create: `api/migrations/versions/0016_initiatives.py`
- Modify: `api/src/serversherpa/db/models.py` (append after `ContainerAsset`, ~line 525)
- Modify: `api/src/serversherpa/status/registry.py`
- Modify: `api/src/serversherpa/api/routes/status_values.py:43-50`
- Modify: `api/src/serversherpa/access/resources.py` (after the containers entry, ~line 59)
- Modify: `api/src/serversherpa/access/defaults.py`
- Modify: `api/tests/conftest.py` (TRUNCATE list ~line 56; seed restores after the container block ~line 161)
- Test: `api/tests/test_initiatives_model.py`

**Interfaces:**
- Produces: ORM classes `Initiative`, `InitiativePerson`, `InitiativeLink` (exact columns below); vocab record types `initiative`, `initiative_type`, `initiative_sub_type`, `initiative_work_type`, `shipping_type`; resource id `initiatives`; `StatusRecordType` gains an `array: bool = False` field.

- [ ] **Step 1: Write the failing model tests**

`api/tests/test_initiatives_model.py`:

```python
"""Initiatives schema — defaults, vocab seeds, and DB-level constraints."""

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Initiative, InitiativeLink, InitiativePerson, Person, StatusValue,
)


async def test_vocab_seeds(db):
    counts = dict((await db.execute(
        select(StatusValue.record_type, func.count())
        .where(StatusValue.record_type.in_((
            "initiative", "initiative_type", "initiative_sub_type",
            "initiative_work_type", "shipping_type")))
        .group_by(StatusValue.record_type))).all())
    assert counts == {"initiative": 6, "initiative_type": 3,
                      "initiative_sub_type": 6, "initiative_work_type": 5,
                      "shipping_type": 4}


async def test_defaults(db):
    i = Initiative(name="Denver refresh", initiative_type="project")
    db.add(i)
    await db.commit()
    await db.refresh(i)
    assert i.status == "planned"
    assert i.archived_at is None
    assert i.created_at is not None
    assert i.shipping_types is None


async def test_unknown_status_rejected(db):
    db.add(Initiative(name="X", initiative_type="project", status="bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_unknown_type_rejected(db):
    db.add(Initiative(name="X", initiative_type="bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_person_unique_per_initiative(db):
    i = Initiative(name="X", initiative_type="event")
    p = Person(first_name="Terry", last_name="Tech")
    db.add_all([i, p])
    await db.flush()
    db.add(InitiativePerson(initiative_id=i.id, person_id=p.id))
    await db.commit()
    db.add(InitiativePerson(initiative_id=i.id, person_id=p.id))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_link_self_reference_rejected(db):
    i = Initiative(name="X", initiative_type="project")
    db.add(i)
    await db.flush()
    db.add(InitiativeLink(parent_id=i.id, child_id=i.id))
    with pytest.raises(IntegrityError):
        await db.commit()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && .venv/bin/pytest tests/test_initiatives_model.py -v`
Expected: FAIL — `ImportError: cannot import name 'Initiative'`

- [ ] **Step 3: Write the migration**

`api/migrations/versions/0016_initiatives.py`:

```python
"""initiatives — unified V2 projects/events/moves as one entity.
Replaces the three V2 tables (projects, events, moves) with a single
initiatives table discriminated by initiative_type, plus people
assignments (V2 people_work_association) and initiative↔initiative
links (V2 projects_associations, generalised to any parent type).
Deliberately fixed from V2: shipping_type is a real text[] (was a
comma-joined string), *_vendor_involved is spelled correctly, the
orphan projects.site/events.site columns are gone, status is a seeded
vocabulary instead of a hardcoded id, and scheduled_end exists.

Revision ID: 0016
Revises: 0015
Create Date: 2026-08-24
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT, UUID

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INITIATIVE_SEEDS = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('initiative','planned','Planned','Not yet scheduled.','#51606f',1),
      ('initiative','scheduled','Scheduled','Date set; not started.','#0f7c86',2),
      ('initiative','in_progress','In progress','Work underway.','#1668a7',3),
      ('initiative','on_hold','On hold','Paused.','#a36207',4),
      ('initiative','completed','Completed','Done; retained for history.','#178a4c',5),
      ('initiative','cancelled','Cancelled','Will not happen.','#c03540',6),
      ('initiative_type','project','Project','Long-running engagement.','#1668a7',1),
      ('initiative_type','event','Event','Date-bound occasion.','#6d4fc4',2),
      ('initiative_type','move','Move','Physical relocation of assets.','#a36207',3),
      ('initiative_sub_type','deployment','Deployment','New equipment install.','#178a4c',1),
      ('initiative_sub_type','decommission','Decommission','Teardown / removal.','#c03540',2),
      ('initiative_sub_type','migration','Migration','Data-centre migration.','#0f7c86',3),
      ('initiative_sub_type','maintenance','Maintenance','Scheduled maintenance.','#a36207',4),
      ('initiative_sub_type','conference','Conference','Conference or trade show.','#6d4fc4',5),
      ('initiative_sub_type','office_move','Office move','Office relocation.','#1668a7',6),
      ('initiative_work_type','lead','Lead','On-site lead.','#1668a7',1),
      ('initiative_work_type','tech','Tech','Hands-on technician.','#178a4c',2),
      ('initiative_work_type','cabling','Cabling','Structured cabling.','#0f7c86',3),
      ('initiative_work_type','logistics','Logistics','Transport & handling.','#a36207',4),
      ('initiative_work_type','other','Other','Anything else.','#51606f',5),
      ('shipping_type','truck','Truck','Road freight.','#1668a7',1),
      ('shipping_type','air','Air','Air freight.','#0f7c86',2),
      ('shipping_type','rail','Rail','Rail freight.','#a36207',3),
      ('shipping_type','ferry','Ferry','Sea / ferry.','#6d4fc4',4)
"""

FULL = ("view", "add", "change", "delete")
# initiatives: internal-only for this slice (like containers) — client
# visibility is a future decision; V2 exposed a client work-history view.
INITIATIVE_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": FULL,
}

PARTNER_FK_COLUMNS = (
    "shipping_partner_id",
    "origin_tech_partner_id", "origin_cable_partner_id",
    "origin_logistics_partner_id",
    "destination_tech_partner_id", "destination_cable_partner_id",
    "destination_logistics_partner_id",
)


def upgrade() -> None:
    op.execute(INITIATIVE_SEEDS)

    op.create_table(
        "initiatives",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("initiative_type", sa.Text, nullable=False),
        sa.Column("sub_type", sa.Text),
        sa.Column("status", sa.Text, nullable=False, server_default="planned"),
        sa.Column("client_id", UUID(as_uuid=True), sa.ForeignKey("clients.id")),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("location", sa.Text),
        sa.Column("scheduled_start", sa.TIMESTAMP(timezone=True)),
        sa.Column("scheduled_end", sa.TIMESTAMP(timezone=True)),
        sa.Column("sky_command_project_id", sa.Text),
        # move block — nullable for every other type
        sa.Column("origin_site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("destination_site_id", UUID(as_uuid=True),
                  sa.ForeignKey("sites.id")),
        sa.Column("real_start_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("real_end_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("priority_devices", sa.Boolean),
        sa.Column("shipping_types", ARRAY(sa.Text),
                  comment="keys under status_values record_type='shipping_type'; "
                          "API-validated (composite FK can't cover arrays)"),
        *(sa.Column(col, UUID(as_uuid=True), sa.ForeignKey("partners.id"))
          for col in PARTNER_FK_COLUMNS),
        sa.Column("origin_vendor_involved", sa.Boolean),
        sa.Column("destination_vendor_involved", sa.Boolean),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    # composite FKs to status_values — the 0014/0015 idiom, three times
    op.execute("""
        ALTER TABLE initiatives ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('initiative') STORED
    """)
    op.create_foreign_key(
        "initiatives_status_fkey", "initiatives", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])
    op.execute("""
        ALTER TABLE initiatives ADD COLUMN type_record_type text
          GENERATED ALWAYS AS ('initiative_type') STORED
    """)
    op.create_foreign_key(
        "initiatives_type_fkey", "initiatives", "status_values",
        ["type_record_type", "initiative_type"], ["record_type", "key"])
    op.execute("""
        ALTER TABLE initiatives ADD COLUMN sub_type_record_type text
          GENERATED ALWAYS AS ('initiative_sub_type') STORED
    """)
    # MATCH SIMPLE: a NULL sub_type skips the check entirely
    op.create_foreign_key(
        "initiatives_sub_type_fkey", "initiatives", "status_values",
        ["sub_type_record_type", "sub_type"], ["record_type", "key"])

    op.create_index("initiatives_name_idx", "initiatives", ["name"])
    op.create_index("initiatives_type_idx", "initiatives", ["initiative_type"])
    op.create_index("initiatives_client_idx", "initiatives", ["client_id"])
    op.create_index("initiatives_site_idx", "initiatives", ["site_id"])

    op.create_table(
        "initiative_people",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"),
                  nullable=False),
        sa.Column("work_type", sa.Text),
        sa.Column("site_worked_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("rating", sa.SmallInteger),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("rating BETWEEN 1 AND 5",
                           name="initiative_people_rating_range"),
        sa.UniqueConstraint("initiative_id", "person_id",
                            name="initiative_people_uniq"),
    )
    op.execute("""
        ALTER TABLE initiative_people ADD COLUMN work_type_record_type text
          GENERATED ALWAYS AS ('initiative_work_type') STORED
    """)
    op.create_foreign_key(
        "initiative_people_work_type_fkey", "initiative_people",
        "status_values",
        ["work_type_record_type", "work_type"], ["record_type", "key"])
    op.create_index("initiative_people_initiative_idx", "initiative_people",
                    ["initiative_id"])

    op.create_table(
        "initiative_links",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("parent_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("child_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("role", sa.Text),
        sa.Column("sort_order", sa.Integer),
        sa.Column("notes", sa.Text),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("parent_id <> child_id",
                           name="initiative_links_no_self"),
        sa.UniqueConstraint("parent_id", "child_id",
                            name="initiative_links_uniq"),
    )
    op.create_index("initiative_links_parent_idx", "initiative_links",
                    ["parent_id"])
    op.create_index("initiative_links_child_idx", "initiative_links",
                    ["child_id"])

    conn = op.get_bind()
    for role, actions in INITIATIVE_GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'initiatives', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'initiatives'"))
    op.drop_table("initiative_links")
    op.drop_table("initiative_people")
    op.drop_table("initiatives")
    conn.execute(sa.text(
        "DELETE FROM status_values WHERE record_type IN "
        "('initiative', 'initiative_type', 'initiative_sub_type', "
        "'initiative_work_type', 'shipping_type')"))
```

- [ ] **Step 4: Append the ORM models**

In `api/src/serversherpa/db/models.py`, after `ContainerAsset`. Add `ARRAY` to the existing `sqlalchemy.dialects.postgresql` import line (which already has `CITEXT`); `Text` comes from the existing `sqlalchemy` import line — add it there if absent.

```python
class Initiative(Base):
    """Unified V2 projects/events/moves. initiative_type discriminates;
    the move-only block stays NULL for the other types and is retained
    (not wiped) on an admin type change."""

    __tablename__ = "initiatives"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    description: Mapped[str | None]
    initiative_type: Mapped[str]
    type_record_type: Mapped[str] = mapped_column(
        server_default=text("'initiative_type'"))  # GENERATED; never written
    sub_type: Mapped[str | None]
    sub_type_record_type: Mapped[str] = mapped_column(
        server_default=text("'initiative_sub_type'"))  # GENERATED; never written
    status: Mapped[str] = mapped_column(server_default="planned")
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'initiative'"))  # GENERATED; never written
    client_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clients.id"))
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    location: Mapped[str | None]
    scheduled_start: Mapped[datetime | None]
    scheduled_end: Mapped[datetime | None]
    sky_command_project_id: Mapped[str | None]
    origin_site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    destination_site_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sites.id"))
    real_start_at: Mapped[datetime | None]
    real_end_at: Mapped[datetime | None]
    priority_devices: Mapped[bool | None]
    shipping_types: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    shipping_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    origin_tech_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    origin_cable_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    origin_logistics_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    destination_tech_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    destination_cable_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    destination_logistics_partner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("partners.id"))
    origin_vendor_involved: Mapped[bool | None]
    destination_vendor_involved: Mapped[bool | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class InitiativePerson(Base):
    __tablename__ = "initiative_people"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    initiative_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    work_type: Mapped[str | None]
    work_type_record_type: Mapped[str] = mapped_column(
        server_default=text("'initiative_work_type'"))  # GENERATED; never written
    site_worked_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    rating: Mapped[int | None] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class InitiativeLink(Base):
    """parent contains child. Any type may parent any type; the API
    enforces acyclicity (the DB only blocks direct self-links)."""

    __tablename__ = "initiative_links"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    parent_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    child_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    role: Mapped[str | None]
    sort_order: Mapped[int | None]
    notes: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

Add `SmallInteger` to the `sqlalchemy` import line in `models.py` if absent.

- [ ] **Step 5: Register the vocabularies (with array support)**

In `api/src/serversherpa/status/registry.py`, add a field to the dataclass and five entries to `STATUS_RECORD_TYPES`:

```python
@dataclass(frozen=True)
class StatusRecordType:
    id: str
    label: str
    # the table/column carrying this entity's status — used to count usage
    table: str
    column: str
    # the resource whose "view" permission gates reading these values
    resource: str
    # True when column is text[] — usage counting must unnest
    array: bool = False
```

```python
    StatusRecordType("initiative", "Initiative", table="initiatives",
                     column="status", resource="initiatives"),
    StatusRecordType("initiative_type", "Initiative type", table="initiatives",
                     column="initiative_type", resource="initiatives"),
    StatusRecordType("initiative_sub_type", "Initiative sub-type",
                     table="initiatives", column="sub_type",
                     resource="initiatives"),
    StatusRecordType("initiative_work_type", "Initiative work type",
                     table="initiative_people", column="work_type",
                     resource="initiatives"),
    StatusRecordType("shipping_type", "Shipping type", table="initiatives",
                     column="shipping_types", resource="initiatives",
                     array=True),
```

In `api/src/serversherpa/api/routes/status_values.py`, replace `_usage_counts` (asyncpg returns a `text[]` cell as a Python list — unhashable, so the existing dict comprehension would crash on an array column):

```python
async def _usage_counts(db: DbSession, rt: StatusRecordType) -> dict[str, int]:
    """Count referencing rows per key. Table/column come from the frozen code
    registry, never from user input."""
    if rt.array:
        rows = (await db.execute(sqla_text(
            f"SELECT k, count(*) FROM {rt.table}, unnest({rt.column}) AS k "
            f"GROUP BY k"))).all()
    else:
        t = table(rt.table, column(rt.column))
        rows = (await db.execute(
            select(t.c[rt.column], func.count())
            .group_by(t.c[rt.column]))).all()
    return {key: n for key, n in rows if key is not None}
```

Add `from sqlalchemy import text as sqla_text` to that module's imports (adjust the alias if `text` is already imported under another name).

- [ ] **Step 6: Register the resource and grants**

`api/src/serversherpa/access/resources.py`, after the containers entry:

```python
    Resource("initiatives", "Initiatives", routes=("/initiatives",),
             # internal-only for the first slice — client visibility is a
             # future decision (V2 exposed a client work-history view).
             visible_to=frozenset({"global"})),
```

`api/src/serversherpa/access/defaults.py`: append `"initiatives"` to `_ALL`, and add `"initiatives": FULL` to both the `"admin"` and `"staff"` dicts (developer/founder/super_admin get it via the `_ALL` comprehension).

- [ ] **Step 7: Update conftest**

In `api/tests/conftest.py`: add `initiative_links, initiative_people, initiatives` to the TRUNCATE list (before `containers CASCADE`, order irrelevant under CASCADE). After the container vocabulary restore block, add:

```python
        # initiative vocabularies — restore canonical seeds (0016)
        await session.execute(text(
            "DELETE FROM status_values WHERE record_type IN "
            "('initiative', 'initiative_type', 'initiative_sub_type', "
            "'initiative_work_type', 'shipping_type')"))
        await session.execute(text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order)
            VALUES
              ('initiative','planned','Planned','Not yet scheduled.','#51606f',1),
              ('initiative','scheduled','Scheduled','Date set; not started.','#0f7c86',2),
              ('initiative','in_progress','In progress','Work underway.','#1668a7',3),
              ('initiative','on_hold','On hold','Paused.','#a36207',4),
              ('initiative','completed','Completed','Done; retained for history.','#178a4c',5),
              ('initiative','cancelled','Cancelled','Will not happen.','#c03540',6),
              ('initiative_type','project','Project','Long-running engagement.','#1668a7',1),
              ('initiative_type','event','Event','Date-bound occasion.','#6d4fc4',2),
              ('initiative_type','move','Move','Physical relocation of assets.','#a36207',3),
              ('initiative_sub_type','deployment','Deployment','New equipment install.','#178a4c',1),
              ('initiative_sub_type','decommission','Decommission','Teardown / removal.','#c03540',2),
              ('initiative_sub_type','migration','Migration','Data-centre migration.','#0f7c86',3),
              ('initiative_sub_type','maintenance','Maintenance','Scheduled maintenance.','#a36207',4),
              ('initiative_sub_type','conference','Conference','Conference or trade show.','#6d4fc4',5),
              ('initiative_sub_type','office_move','Office move','Office relocation.','#1668a7',6),
              ('initiative_work_type','lead','Lead','On-site lead.','#1668a7',1),
              ('initiative_work_type','tech','Tech','Hands-on technician.','#178a4c',2),
              ('initiative_work_type','cabling','Cabling','Structured cabling.','#0f7c86',3),
              ('initiative_work_type','logistics','Logistics','Transport & handling.','#a36207',4),
              ('initiative_work_type','other','Other','Anything else.','#51606f',5),
              ('shipping_type','truck','Truck','Road freight.','#1668a7',1),
              ('shipping_type','air','Air','Air freight.','#0f7c86',2),
              ('shipping_type','rail','Rail','Rail freight.','#a36207',3),
              ('shipping_type','ferry','Ferry','Sea / ferry.','#6d4fc4',4)
        """))
```

- [ ] **Step 8: Apply the migration and run the tests**

Run: `cd api && .venv/bin/alembic upgrade head && .venv/bin/pytest tests/test_initiatives_model.py -v`
Expected: 6 passed. Then run `.venv/bin/pytest tests/test_status_values_api.py -v` (or the closest-named status-values test file) to confirm the registry change broke nothing.

- [ ] **Step 9: Commit**

```bash
git add api/migrations/versions/0016_initiatives.py api/src/serversherpa/db/models.py api/src/serversherpa/status/registry.py api/src/serversherpa/api/routes/status_values.py api/src/serversherpa/access/resources.py api/src/serversherpa/access/defaults.py api/tests/conftest.py api/tests/test_initiatives_model.py
git commit -m "feat(api): initiatives schema — unified projects/events/moves tables + vocabularies"
```

---

### Task 2: Schemas, CRUD router, registration

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (append at end, `# ── initiatives ──` banner)
- Create: `api/src/serversherpa/api/routes/initiatives.py`
- Modify: `api/src/serversherpa/api/app.py` (import tuple + `include_router`)
- Test: `api/tests/test_initiatives_api.py`

**Interfaces:**
- Consumes: Task 1's ORM models and vocab record types.
- Produces: `InitiativeItem`, `InitiativeDetailOut`, `InitiativeCreateIn`, `InitiativeUpdateIn` pydantic models; router endpoints `GET/POST /initiatives`, `GET/PATCH /initiatives/{id}`, `POST /initiatives/{id}/archive|unarchive`; helpers `_err`, `_get_initiative`, `_check_refs`, `_context`, `_item`, `_detail`, `PARTNER_FIELDS`, `ADMIN_RANK` reused by Tasks 3–4 (people/links row builders `_people_rows`/`_link_rows` are stubbed here returning `[]` and implemented in Tasks 3–4).

- [ ] **Step 1: Write the failing API tests**

`api/tests/test_initiatives_api.py`:

```python
"""Initiatives CRUD — roundtrip, validation codes, type-change gate,
archive, permission gates."""

import uuid

from serversherpa.db.models import Person, PersonRole, Site

from .test_assets_api import login, make_login


async def _admin_login(db, client):
    admin = Person(first_name="Bob", last_name="Boss")
    db.add(admin)
    await db.flush()
    db.add(PersonRole(person_id=admin.id, role="admin"))
    await db.commit()
    return await make_login(db, client, admin, "bob@test.example.com")


async def test_crud_roundtrip(client, db, seeded_user):
    headers = await login(client)
    resp = await client.post("/initiatives", headers=headers, json={
        "name": "Denver DC migration", "initiative_type": "project",
        "sub_type": "migration", "description": "Phase 1"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "planned"
    assert body["status_label"] == "Planned"
    assert body["type_label"] == "Project"
    assert body["sub_type_label"] == "Migration"
    iid = body["id"]

    resp = await client.get("/initiatives", headers=headers)
    assert [i["id"] for i in resp.json()] == [iid]

    resp = await client.patch(f"/initiatives/{iid}", headers=headers,
                              json={"status": "in_progress",
                                    "location": "Denver, CO"})
    assert resp.status_code == 200
    assert resp.json()["status_label"] == "In progress"
    assert resp.json()["location"] == "Denver, CO"

    resp = await client.get(f"/initiatives/{iid}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["people"] == []


async def test_create_move_with_move_block(client, db, seeded_user):
    headers = await login(client)
    a = Site(name="DC-East")
    b = Site(name="DC-West")
    db.add_all([a, b])
    await db.commit()
    resp = await client.post("/initiatives", headers=headers, json={
        "name": "East to West", "initiative_type": "move",
        "origin_site_id": str(a.id), "destination_site_id": str(b.id),
        "shipping_types": ["truck", "rail"], "priority_devices": True})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["origin_site_name"] == "DC-East"
    assert body["destination_site_name"] == "DC-West"
    assert body["shipping_types"] == ["truck", "rail"]


async def test_validation_codes(client, db, seeded_user):
    headers = await login(client)
    cases = [
        ({"name": "", "initiative_type": "project"}, "name_required"),
        ({"name": "X", "initiative_type": "bogus"},
         "unknown_initiative_type"),
        ({"name": "X", "initiative_type": "project", "status": "bogus"},
         "unknown_status"),
        ({"name": "X", "initiative_type": "project", "sub_type": "bogus"},
         "unknown_sub_type"),
        ({"name": "X", "initiative_type": "project",
          "client_id": str(uuid.uuid4())}, "client_not_found"),
        ({"name": "X", "initiative_type": "project",
          "site_id": str(uuid.uuid4())}, "site_not_found"),
        ({"name": "X", "initiative_type": "move",
          "shipping_partner_id": str(uuid.uuid4())}, "partner_not_found"),
        ({"name": "X", "initiative_type": "move",
          "shipping_types": ["hovercraft"]}, "unknown_shipping_type"),
    ]
    for payload, code in cases:
        resp = await client.post("/initiatives", headers=headers, json=payload)
        assert resp.status_code == 422, (payload, resp.text)
        assert resp.json()["detail"]["code"] == code


async def test_type_change_admin_only(client, db, seeded_user):
    staff = await login(client)
    site = Site(name="DC-East")
    db.add(site)
    await db.commit()
    resp = await client.post("/initiatives", headers=staff, json={
        "name": "Started as move", "initiative_type": "move",
        "origin_site_id": str(site.id)})
    iid = resp.json()["id"]

    # staff (rank 40) may not change the type
    resp = await client.patch(f"/initiatives/{iid}", headers=staff,
                              json={"initiative_type": "project"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "type_change_forbidden"

    # admin (rank 60) may — and the old move field is retained, not wiped
    admin = await _admin_login(db, client)
    resp = await client.patch(f"/initiatives/{iid}", headers=admin,
                              json={"initiative_type": "project"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["initiative_type"] == "project"
    assert resp.json()["origin_site_id"] == str(site.id)

    # a no-op "change" to the same type is not gated
    resp = await client.patch(f"/initiatives/{iid}", headers=staff,
                              json={"initiative_type": "project"})
    assert resp.status_code == 200


async def test_archive_unarchive(client, db, seeded_user):
    headers = await login(client)
    resp = await client.post("/initiatives", headers=headers,
                             json={"name": "X", "initiative_type": "event"})
    iid = resp.json()["id"]
    assert (await client.post(f"/initiatives/{iid}/archive",
                              headers=headers)).status_code == 204
    resp = await client.get(f"/initiatives/{iid}", headers=headers)
    assert resp.json()["archived_at"] is not None
    assert (await client.post(f"/initiatives/{iid}/unarchive",
                              headers=headers)).status_code == 204


async def test_worker_role_forbidden(client, db, seeded_user):
    w = Person(first_name="Wally", last_name="Worker")
    db.add(w)
    await db.flush()
    db.add(PersonRole(person_id=w.id, role="worker"))
    await db.commit()
    headers = await make_login(db, client, w, "wally@test.example.com")
    assert (await client.get("/initiatives",
                             headers=headers)).status_code == 403


async def test_shipping_type_usage_counts(client, db, seeded_user):
    """The Variables page usage counter must survive the text[] column."""
    headers = await login(client)
    await client.post("/initiatives", headers=headers, json={
        "name": "X", "initiative_type": "move", "shipping_types": ["truck"]})
    resp = await client.get("/status-values?record_type=shipping_type",
                            headers=headers)
    assert resp.status_code == 200, resp.text
    by_key = {r["key"]: r for r in resp.json()}
    assert by_key["truck"]["usage_count"] == 1
    assert by_key["air"]["usage_count"] == 0


async def test_unknown_id_404(client, db, seeded_user):
    headers = await login(client)
    resp = await client.get(f"/initiatives/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"
```

Note: if `/status-values` items expose usage differently than `usage_count`, mirror the field name used in `api/src/serversherpa/api/schemas.py`'s `StatusValueOut` — do not change the API.

- [ ] **Step 2: Run to verify failure**

Run: `cd api && .venv/bin/pytest tests/test_initiatives_api.py -v`
Expected: FAIL — 404s (router not registered yet).

- [ ] **Step 3: Add the schemas**

Append to `api/src/serversherpa/api/schemas.py`:

```python
# ── initiatives ────────────────────────────────────────────────────


class InitiativeItem(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    initiative_type: str
    type_label: str
    type_color: str
    sub_type: str | None = None
    sub_type_label: str | None = None
    sub_type_color: str | None = None
    status: str
    status_label: str
    status_color: str
    client_id: uuid.UUID | None = None
    client_name: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    location: str | None = None
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    sky_command_project_id: str | None = None
    origin_site_id: uuid.UUID | None = None
    origin_site_name: str | None = None
    destination_site_id: uuid.UUID | None = None
    destination_site_name: str | None = None
    real_start_at: datetime | None = None
    real_end_at: datetime | None = None
    priority_devices: bool | None = None
    shipping_types: list[str] = []
    shipping_partner_id: uuid.UUID | None = None
    shipping_partner_name: str | None = None
    origin_tech_partner_id: uuid.UUID | None = None
    origin_cable_partner_id: uuid.UUID | None = None
    origin_logistics_partner_id: uuid.UUID | None = None
    destination_tech_partner_id: uuid.UUID | None = None
    destination_cable_partner_id: uuid.UUID | None = None
    destination_logistics_partner_id: uuid.UUID | None = None
    origin_vendor_involved: bool | None = None
    destination_vendor_involved: bool | None = None
    people_count: int = 0
    links_count: int = 0
    archived_at: datetime | None = None
    created_at: datetime


class InitiativePersonRow(BaseModel):
    id: uuid.UUID
    person_id: uuid.UUID
    person_name: str
    work_type: str | None = None
    work_type_label: str | None = None
    work_type_color: str | None = None
    site_worked_id: uuid.UUID | None = None
    site_worked_name: str | None = None
    rating: int | None = None
    created_at: datetime


class InitiativeLinkRow(BaseModel):
    """One link, described from one side: `other_*` is the initiative at
    the far end (the child when listed under links_children, the parent
    when under links_parents)."""

    id: uuid.UUID
    other_id: uuid.UUID
    other_name: str
    other_type: str
    other_type_label: str
    other_type_color: str
    other_status_label: str
    other_status_color: str
    role: str | None = None
    sort_order: int | None = None
    notes: str | None = None
    created_at: datetime


class InitiativeDetailOut(InitiativeItem):
    people: list[InitiativePersonRow] = []
    links_children: list[InitiativeLinkRow] = []
    links_parents: list[InitiativeLinkRow] = []


class InitiativeCreateIn(BaseModel):
    name: str
    initiative_type: str
    description: str | None = None
    sub_type: str | None = None
    status: str | None = None
    client_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    location: str | None = None
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    sky_command_project_id: str | None = None
    origin_site_id: uuid.UUID | None = None
    destination_site_id: uuid.UUID | None = None
    real_start_at: datetime | None = None
    real_end_at: datetime | None = None
    priority_devices: bool | None = None
    shipping_types: list[str] | None = None
    shipping_partner_id: uuid.UUID | None = None
    origin_tech_partner_id: uuid.UUID | None = None
    origin_cable_partner_id: uuid.UUID | None = None
    origin_logistics_partner_id: uuid.UUID | None = None
    destination_tech_partner_id: uuid.UUID | None = None
    destination_cable_partner_id: uuid.UUID | None = None
    destination_logistics_partner_id: uuid.UUID | None = None
    origin_vendor_involved: bool | None = None
    destination_vendor_involved: bool | None = None
    model_config = ConfigDict(extra="forbid")


class InitiativeUpdateIn(InitiativeCreateIn):
    """PATCH body — same fields, everything optional."""

    name: str | None = None
    initiative_type: str | None = None
    model_config = ConfigDict(extra="forbid")


class InitiativePersonAddIn(BaseModel):
    person_id: uuid.UUID
    work_type: str | None = None
    site_worked_id: uuid.UUID | None = None
    rating: int | None = None
    model_config = ConfigDict(extra="forbid")


class InitiativePersonUpdateIn(BaseModel):
    work_type: str | None = None
    site_worked_id: uuid.UUID | None = None
    rating: int | None = None
    model_config = ConfigDict(extra="forbid")


class InitiativeLinkAddIn(BaseModel):
    child_id: uuid.UUID
    role: str | None = None
    sort_order: int | None = None
    notes: str | None = None
    model_config = ConfigDict(extra="forbid")


class InitiativeLinkUpdateIn(BaseModel):
    role: str | None = None
    sort_order: int | None = None
    notes: str | None = None
    model_config = ConfigDict(extra="forbid")
```

- [ ] **Step 4: Write the router**

`api/src/serversherpa/api/routes/initiatives.py` (people/links row loaders are stubs here; Tasks 3–4 fill them):

```python
"""Initiatives — unified V2 projects/events/moves (one entity, an
initiative_type vocabulary field, nullable move-only block). Internal-only
resource for this slice; all actors are globally anchored. People
assignments and initiative↔initiative links live here too (the
initiative is the aggregate root)."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    InitiativeCreateIn, InitiativeDetailOut, InitiativeItem,
    InitiativeLinkAddIn, InitiativeLinkRow, InitiativeLinkUpdateIn,
    InitiativePersonAddIn, InitiativePersonRow, InitiativePersonUpdateIn,
    InitiativeUpdateIn,
)
from serversherpa.db.models import (
    Client, Initiative, InitiativeLink, InitiativePerson, Partner, Person,
    Site, StatusValue,
)
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/initiatives", tags=["initiatives"])

# roles.rank for "admin" (migration 0009); super_admin/founder/developer
# rank higher. Changing initiative_type after creation is admin-and-up.
ADMIN_RANK = 60

PARTNER_FIELDS = (
    "shipping_partner_id",
    "origin_tech_partner_id", "origin_cable_partner_id",
    "origin_logistics_partner_id",
    "destination_tech_partner_id", "destination_cable_partner_id",
    "destination_logistics_partner_id",
)
SITE_FIELDS = ("site_id", "origin_site_id", "destination_site_id")
INITIATIVE_FIELDS = [
    "name", "description", "initiative_type", "sub_type", "status",
    "client_id", "site_id", "location", "scheduled_start", "scheduled_end",
    "sky_command_project_id", "origin_site_id", "destination_site_id",
    "real_start_at", "real_end_at", "priority_devices", "shipping_types",
    "origin_vendor_involved", "destination_vendor_involved",
    *PARTNER_FIELDS,
]
NON_NULLABLE_FIELDS = ("name", "initiative_type", "status")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _get_initiative(db: DbSession,
                          initiative_id: uuid.UUID) -> Initiative:
    initiative = await db.get(Initiative, initiative_id)
    if initiative is None:
        raise _err(404, "initiative_not_found")
    return initiative


async def _vocab(db: DbSession) -> dict[str, dict]:
    """{record_type: {key: (label, color)}} for the three chip vocabularies."""
    rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(
            ("initiative", "initiative_type", "initiative_sub_type"))))).all()
    out: dict[str, dict] = {"initiative": {}, "initiative_type": {},
                            "initiative_sub_type": {}}
    for s in rows:
        out[s.record_type][s.key] = (s.label, s.color)
    return out


async def _context(db: DbSession, initiatives: list[Initiative]) -> tuple:
    vocab = await _vocab(db)
    site_ids = {getattr(i, f) for i in initiatives for f in SITE_FIELDS
                if getattr(i, f)}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids))
    )).all()) if site_ids else {}
    client_ids = {i.client_id for i in initiatives if i.client_id}
    clients = dict((await db.execute(
        select(Client.id, Client.name).where(Client.id.in_(client_ids))
    )).all()) if client_ids else {}
    partner_ids = {i.shipping_partner_id for i in initiatives
                   if i.shipping_partner_id}
    partners = dict((await db.execute(
        select(Partner.id, Partner.name).where(Partner.id.in_(partner_ids))
    )).all()) if partner_ids else {}
    ids = [i.id for i in initiatives]
    people_counts = dict((await db.execute(
        select(InitiativePerson.initiative_id, func.count())
        .where(InitiativePerson.initiative_id.in_(ids))
        .group_by(InitiativePerson.initiative_id)
    )).all()) if ids else {}
    child_counts = dict((await db.execute(
        select(InitiativeLink.parent_id, func.count())
        .where(InitiativeLink.parent_id.in_(ids))
        .group_by(InitiativeLink.parent_id)
    )).all()) if ids else {}
    parent_counts = dict((await db.execute(
        select(InitiativeLink.child_id, func.count())
        .where(InitiativeLink.child_id.in_(ids))
        .group_by(InitiativeLink.child_id)
    )).all()) if ids else {}
    link_counts = {i: child_counts.get(i, 0) + parent_counts.get(i, 0)
                   for i in ids}
    return vocab, sites, clients, partners, people_counts, link_counts


def _item(i: Initiative, vocab: dict, sites: dict, clients: dict,
          partners: dict, people_counts: dict, link_counts: dict) -> dict:
    s_label, s_color = vocab["initiative"].get(
        i.status, (i.status, "#51606f"))
    t_label, t_color = vocab["initiative_type"].get(
        i.initiative_type, (i.initiative_type, "#51606f"))
    st_label, st_color = (vocab["initiative_sub_type"].get(
        i.sub_type, (i.sub_type, "#51606f"))
        if i.sub_type is not None else (None, None))
    return {
        "id": i.id, "name": i.name, "description": i.description,
        "initiative_type": i.initiative_type,
        "type_label": t_label, "type_color": t_color,
        "sub_type": i.sub_type,
        "sub_type_label": st_label, "sub_type_color": st_color,
        "status": i.status, "status_label": s_label, "status_color": s_color,
        "client_id": i.client_id, "client_name": clients.get(i.client_id),
        "site_id": i.site_id, "site_name": sites.get(i.site_id),
        "location": i.location,
        "scheduled_start": i.scheduled_start,
        "scheduled_end": i.scheduled_end,
        "sky_command_project_id": i.sky_command_project_id,
        "origin_site_id": i.origin_site_id,
        "origin_site_name": sites.get(i.origin_site_id),
        "destination_site_id": i.destination_site_id,
        "destination_site_name": sites.get(i.destination_site_id),
        "real_start_at": i.real_start_at, "real_end_at": i.real_end_at,
        "priority_devices": i.priority_devices,
        "shipping_types": i.shipping_types or [],
        "shipping_partner_id": i.shipping_partner_id,
        "shipping_partner_name": partners.get(i.shipping_partner_id),
        "origin_tech_partner_id": i.origin_tech_partner_id,
        "origin_cable_partner_id": i.origin_cable_partner_id,
        "origin_logistics_partner_id": i.origin_logistics_partner_id,
        "destination_tech_partner_id": i.destination_tech_partner_id,
        "destination_cable_partner_id": i.destination_cable_partner_id,
        "destination_logistics_partner_id": i.destination_logistics_partner_id,
        "origin_vendor_involved": i.origin_vendor_involved,
        "destination_vendor_involved": i.destination_vendor_involved,
        "people_count": people_counts.get(i.id, 0),
        "links_count": link_counts.get(i.id, 0),
        "archived_at": i.archived_at, "created_at": i.created_at,
    }


async def _people_rows(db: DbSession,
                       initiative_id: uuid.UUID) -> list[InitiativePersonRow]:
    return []  # implemented in the people task


async def _link_rows(
    db: DbSession, initiative_id: uuid.UUID,
) -> tuple[list[InitiativeLinkRow], list[InitiativeLinkRow]]:
    return [], []  # implemented in the links task


async def _detail(db: DbSession, initiative: Initiative) -> InitiativeDetailOut:
    ctx = await _context(db, [initiative])
    children, parents = await _link_rows(db, initiative.id)
    return InitiativeDetailOut(
        **_item(initiative, *ctx),
        people=await _people_rows(db, initiative.id),
        links_children=children, links_parents=parents)


@router.get("", response_model=list[InitiativeItem])
async def list_initiatives(
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "view"),
) -> list[InitiativeItem]:
    initiatives = list(await db.scalars(
        select(Initiative).order_by(Initiative.created_at.desc())))
    ctx = await _context(db, initiatives)
    return [InitiativeItem(**_item(i, *ctx)) for i in initiatives]


@router.get("/{initiative_id}", response_model=InitiativeDetailOut)
async def get_initiative(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "view"),
) -> InitiativeDetailOut:
    return await _detail(db, await _get_initiative(db, initiative_id))


async def _check_refs(db: DbSession, data: dict) -> None:
    if data.get("client_id") is not None and \
            await db.get(Client, data["client_id"]) is None:
        raise _err(422, "client_not_found")
    for field in SITE_FIELDS:
        if data.get(field) is not None and \
                await db.get(Site, data[field]) is None:
            raise _err(422, "site_not_found", field=field)
    for field in PARTNER_FIELDS:
        if data.get(field) is not None and \
                await db.get(Partner, data[field]) is None:
            raise _err(422, "partner_not_found", field=field)
    for field, record_type, code in (
        ("status", "initiative", "unknown_status"),
        ("initiative_type", "initiative_type", "unknown_initiative_type"),
        ("sub_type", "initiative_sub_type", "unknown_sub_type"),
    ):
        if data.get(field) is not None and await db.scalar(
            select(StatusValue).where(
                StatusValue.record_type == record_type,
                StatusValue.key == data[field])) is None:
            raise _err(422, code)
    if data.get("shipping_types"):
        keys = set(await db.scalars(select(StatusValue.key).where(
            StatusValue.record_type == "shipping_type")))
        if unknown := [s for s in data["shipping_types"] if s not in keys]:
            raise _err(422, "unknown_shipping_type", values=unknown)


@router.post("", response_model=InitiativeDetailOut, status_code=201)
async def create_initiative(
    body: InitiativeCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> InitiativeDetailOut:
    data = body.model_dump(exclude_none=True)
    if not data.get("name"):
        raise _err(422, "name_required")
    await _check_refs(db, data)
    initiative = Initiative(**data, created_by=actor.person.id)
    db.add(initiative)
    await db.flush()
    initial = snapshot(initiative, INITIATIVE_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items()
               if value not in (None, "", [])}
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative.id), action="create", changes=changes)
    await db.commit()
    return await _detail(db, initiative)


@router.patch("/{initiative_id}", response_model=InitiativeDetailOut)
async def update_initiative(
    initiative_id: uuid.UUID,
    body: InitiativeUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> InitiativeDetailOut:
    initiative = await _get_initiative(db, initiative_id)
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_FIELDS:
        if field in data and not data[field]:
            raise _err(422, f"{field}_required")
    if data.get("initiative_type") not in (None, initiative.initiative_type) \
            and actor.access.max_rank < ADMIN_RANK:
        raise _err(403, "type_change_forbidden")
    await _check_refs(db, data)

    fields = list(data.keys())
    before = snapshot(initiative, fields)
    for field, value in data.items():
        setattr(initiative, field, value)
    changes = diff(before, snapshot(initiative, fields))
    if changes:
        initiative.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="initiative",
              entity_id=str(initiative_id), action="update", changes=changes)
    await db.commit()
    return await _detail(db, initiative)


@router.post("/{initiative_id}/archive", status_code=204)
async def archive_initiative(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> None:
    initiative = await _get_initiative(db, initiative_id)
    initiative.archived_at = datetime.now(UTC)
    initiative.updated_at = initiative.archived_at
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="archive")
    await db.commit()


@router.post("/{initiative_id}/unarchive", status_code=204)
async def unarchive_initiative(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> None:
    initiative = await _get_initiative(db, initiative_id)
    initiative.archived_at = None
    initiative.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="restore")
    await db.commit()
```

(`Person`, `InitiativePersonAddIn/UpdateIn`, `InitiativeLinkAddIn/UpdateIn`, `InitiativePersonRow`, `InitiativeLinkRow` imports are used by Tasks 3–4; keeping them now avoids churn. If the linter blocks unused imports, add them in Tasks 3–4 instead.)

- [ ] **Step 5: Register the router**

In `api/src/serversherpa/api/app.py`: add `initiatives` to the alphabetized `from serversherpa.api.routes import (...)` tuple, and add `app.include_router(initiatives.router)` alongside the other `include_router` calls (keep the existing ordering style).

- [ ] **Step 6: Run the tests**

Run: `cd api && .venv/bin/pytest tests/test_initiatives_api.py tests/test_initiatives_model.py -v`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/initiatives.py api/src/serversherpa/api/app.py api/tests/test_initiatives_api.py
git commit -m "feat(api): initiatives CRUD — unified type field, admin-gated type change"
```

---

### Task 3: People assignment endpoints

**Files:**
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (replace the `_people_rows` stub; append endpoints)
- Test: `api/tests/test_initiative_people_api.py`

**Interfaces:**
- Consumes: Task 2's router helpers (`_err`, `_get_initiative`) and Task 1's models.
- Produces: `GET/POST /initiatives/{id}/people`, `PATCH/DELETE /initiatives/people/{assoc_id}`; real `_people_rows(db, initiative_id) -> list[InitiativePersonRow]`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_initiative_people_api.py`:

```python
"""Initiative people — add/update/remove, duplicate + validation codes."""

import uuid

from serversherpa.db.models import Person

from .test_assets_api import login


async def _initiative(client, headers, name="Team test"):
    resp = await client.post("/initiatives", headers=headers,
                             json={"name": name, "initiative_type": "project"})
    return resp.json()["id"]


async def _person(db, first="Terry", last="Tech"):
    p = Person(first_name=first, last_name=last)
    db.add(p)
    await db.commit()
    return p


async def test_people_roundtrip(client, db, seeded_user):
    headers = await login(client)
    iid = await _initiative(client, headers)
    p = await _person(db)

    resp = await client.post(f"/initiatives/{iid}/people", headers=headers,
                             json={"person_id": str(p.id),
                                   "work_type": "tech", "rating": 4})
    assert resp.status_code == 201, resp.text
    rows = resp.json()
    assert rows[0]["person_name"] == "Terry Tech"
    assert rows[0]["work_type_label"] == "Tech"
    assert rows[0]["rating"] == 4
    assoc_id = rows[0]["id"]

    resp = await client.patch(f"/initiatives/people/{assoc_id}",
                              headers=headers, json={"rating": 5})
    assert resp.status_code == 200
    assert resp.json()["rating"] == 5

    # the initiative list denormalizes the count
    resp = await client.get("/initiatives", headers=headers)
    assert resp.json()[0]["people_count"] == 1

    resp = await client.delete(f"/initiatives/people/{assoc_id}",
                               headers=headers)
    assert resp.status_code == 204
    resp = await client.get(f"/initiatives/{iid}", headers=headers)
    assert resp.json()["people"] == []


async def test_people_validation(client, db, seeded_user):
    headers = await login(client)
    iid = await _initiative(client, headers)
    p = await _person(db)

    resp = await client.post(f"/initiatives/{iid}/people", headers=headers,
                             json={"person_id": str(uuid.uuid4())})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "person_not_found"

    resp = await client.post(f"/initiatives/{iid}/people", headers=headers,
                             json={"person_id": str(p.id),
                                   "work_type": "bogus"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_work_type"

    resp = await client.post(f"/initiatives/{iid}/people", headers=headers,
                             json={"person_id": str(p.id), "rating": 9})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "rating_out_of_range"

    assert (await client.post(
        f"/initiatives/{iid}/people", headers=headers,
        json={"person_id": str(p.id)})).status_code == 201
    resp = await client.post(f"/initiatives/{iid}/people", headers=headers,
                             json={"person_id": str(p.id)})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "duplicate_person"


async def test_people_assoc_404(client, db, seeded_user):
    headers = await login(client)
    resp = await client.patch(f"/initiatives/people/{uuid.uuid4()}",
                              headers=headers, json={"rating": 3})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "assignment_not_found"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && .venv/bin/pytest tests/test_initiative_people_api.py -v`
Expected: FAIL — 404/405 (endpoints missing) and empty `people`.

- [ ] **Step 3: Implement**

In `api/src/serversherpa/api/routes/initiatives.py`, replace the `_people_rows` stub and append the endpoints (below the unarchive endpoint):

```python
async def _people_rows(db: DbSession,
                       initiative_id: uuid.UUID) -> list[InitiativePersonRow]:
    rows = (await db.execute(
        select(InitiativePerson, Person)
        .join(Person, Person.id == InitiativePerson.person_id)
        .where(InitiativePerson.initiative_id == initiative_id)
        .order_by(InitiativePerson.created_at))).all()
    work_types = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(
            StatusValue.record_type == "initiative_work_type"))}
    site_ids = {m.site_worked_id for m, _ in rows if m.site_worked_id}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids))
    )).all()) if site_ids else {}
    out = []
    for m, person in rows:
        wt_label, wt_color = (work_types.get(m.work_type,
                                             (m.work_type, "#51606f"))
                              if m.work_type is not None else (None, None))
        out.append(InitiativePersonRow(
            id=m.id, person_id=person.id,
            person_name=f"{person.first_name} {person.last_name}",
            work_type=m.work_type,
            work_type_label=wt_label, work_type_color=wt_color,
            site_worked_id=m.site_worked_id,
            site_worked_name=sites.get(m.site_worked_id),
            rating=m.rating, created_at=m.created_at))
    return out


async def _check_person_refs(db: DbSession, data: dict) -> None:
    if data.get("work_type") is not None and await db.scalar(
        select(StatusValue).where(
            StatusValue.record_type == "initiative_work_type",
            StatusValue.key == data["work_type"])) is None:
        raise _err(422, "unknown_work_type")
    if data.get("site_worked_id") is not None and \
            await db.get(Site, data["site_worked_id"]) is None:
        raise _err(422, "site_not_found", field="site_worked_id")
    if data.get("rating") is not None and not 1 <= data["rating"] <= 5:
        raise _err(422, "rating_out_of_range")


@router.get("/{initiative_id}/people",
            response_model=list[InitiativePersonRow])
async def list_initiative_people(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "view"),
) -> list[InitiativePersonRow]:
    await _get_initiative(db, initiative_id)
    return await _people_rows(db, initiative_id)


@router.post("/{initiative_id}/people",
             response_model=list[InitiativePersonRow], status_code=201)
async def add_initiative_person(
    initiative_id: uuid.UUID,
    body: InitiativePersonAddIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> list[InitiativePersonRow]:
    initiative = await _get_initiative(db, initiative_id)
    data = body.model_dump(exclude_none=True)
    if await db.get(Person, data["person_id"]) is None:
        raise _err(422, "person_not_found")
    await _check_person_refs(db, data)
    if await db.scalar(select(InitiativePerson.id).where(
            InitiativePerson.initiative_id == initiative_id,
            InitiativePerson.person_id == data["person_id"])) is not None:
        raise _err(409, "duplicate_person")
    db.add(InitiativePerson(initiative_id=initiative_id, **data))
    initiative.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="person_add",
          changes={"person_id": {"from": None,
                                 "to": str(data["person_id"])}})
    await db.commit()
    return await _people_rows(db, initiative_id)


async def _get_assignment(db: DbSession,
                          assoc_id: uuid.UUID) -> InitiativePerson:
    assoc = await db.get(InitiativePerson, assoc_id)
    if assoc is None:
        raise _err(404, "assignment_not_found")
    return assoc


@router.patch("/people/{assoc_id}", response_model=InitiativePersonRow)
async def update_initiative_person(
    assoc_id: uuid.UUID,
    body: InitiativePersonUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> InitiativePersonRow:
    assoc = await _get_assignment(db, assoc_id)
    data = body.model_dump(exclude_unset=True)
    await _check_person_refs(db, data)
    for field, value in data.items():
        setattr(assoc, field, value)
    assoc.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(assoc.initiative_id), action="person_update",
          changes={field: {"from": None, "to": str(value)}
                   for field, value in data.items()})
    await db.commit()
    rows = await _people_rows(db, assoc.initiative_id)
    return next(r for r in rows if r.id == assoc_id)


@router.delete("/people/{assoc_id}", status_code=204)
async def remove_initiative_person(
    assoc_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> None:
    assoc = await _get_assignment(db, assoc_id)
    initiative_id = assoc.initiative_id
    person_id = assoc.person_id
    await db.delete(assoc)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="person_remove",
          changes={"person_id": {"from": str(person_id), "to": None}})
    await db.commit()
```

Route-ordering note: `/people/{assoc_id}` contains a literal first segment, so it never collides with `/{initiative_id}` (a bare UUID). No reordering needed.

- [ ] **Step 4: Run the tests**

Run: `cd api && .venv/bin/pytest tests/test_initiative_people_api.py tests/test_initiatives_api.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/initiatives.py api/tests/test_initiative_people_api.py
git commit -m "feat(api): initiative people assignments — work type, site, rating"
```

---

### Task 4: Initiative link endpoints (universal cycle guard)

**Files:**
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (replace the `_link_rows` stub; append endpoints)
- Test: `api/tests/test_initiative_links_api.py`

**Interfaces:**
- Consumes: Task 2's helpers.
- Produces: `GET/POST /initiatives/{id}/links`, `PATCH/DELETE /initiatives/links/{link_id}`; real `_link_rows(db, id) -> (children, parents)`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_initiative_links_api.py`:

```python
"""Initiative links — cross-type nesting, self/duplicate/circular guards."""

import uuid

from .test_assets_api import login


async def _initiative(client, headers, name, itype):
    resp = await client.post("/initiatives", headers=headers,
                             json={"name": name, "initiative_type": itype})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def test_links_roundtrip_and_guards(client, db, seeded_user):
    headers = await login(client)
    a = await _initiative(client, headers, "Alpha", "project")
    b = await _initiative(client, headers, "Bravo", "move")
    c = await _initiative(client, headers, "Charlie", "event")

    # cross-type link: project contains move
    resp = await client.post(f"/initiatives/{a}/links", headers=headers,
                             json={"child_id": b, "role": "primary move"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["links_children"][0]["other_name"] == "Bravo"
    assert body["links_children"][0]["other_type"] == "move"
    link_id = body["links_children"][0]["id"]

    # self link
    resp = await client.post(f"/initiatives/{a}/links", headers=headers,
                             json={"child_id": a})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "self_link"

    # duplicate
    resp = await client.post(f"/initiatives/{a}/links", headers=headers,
                             json={"child_id": b})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "duplicate_link"

    # chain A→B→C, then C→A must be rejected (any-type cycle guard —
    # V2 only guarded project→project)
    assert (await client.post(f"/initiatives/{b}/links", headers=headers,
                              json={"child_id": c})).status_code == 201
    resp = await client.post(f"/initiatives/{c}/links", headers=headers,
                             json={"child_id": a})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "circular_link"

    # the child sees the link from its side
    resp = await client.get(f"/initiatives/{b}", headers=headers)
    assert resp.json()["links_parents"][0]["other_name"] == "Alpha"
    assert resp.json()["links_count"] == 2

    # update + delete
    resp = await client.patch(f"/initiatives/links/{link_id}",
                              headers=headers, json={"role": "phase 1"})
    assert resp.status_code == 200
    assert resp.json()["role"] == "phase 1"
    assert (await client.delete(f"/initiatives/links/{link_id}",
                                headers=headers)).status_code == 204


async def test_link_target_404(client, db, seeded_user):
    headers = await login(client)
    a = await _initiative(client, headers, "Alpha", "project")
    resp = await client.post(f"/initiatives/{a}/links", headers=headers,
                             json={"child_id": str(uuid.uuid4())})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "initiative_not_found"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && .venv/bin/pytest tests/test_initiative_links_api.py -v`
Expected: FAIL — endpoints missing / empty `links_children`.

- [ ] **Step 3: Implement**

Replace the `_link_rows` stub and append endpoints in `initiatives.py`:

```python
async def _link_rows(
    db: DbSession, initiative_id: uuid.UUID,
) -> tuple[list[InitiativeLinkRow], list[InitiativeLinkRow]]:
    vocab = await _vocab(db)

    def row(link: InitiativeLink, other: Initiative) -> InitiativeLinkRow:
        t_label, t_color = vocab["initiative_type"].get(
            other.initiative_type, (other.initiative_type, "#51606f"))
        s_label, s_color = vocab["initiative"].get(
            other.status, (other.status, "#51606f"))
        return InitiativeLinkRow(
            id=link.id, other_id=other.id, other_name=other.name,
            other_type=other.initiative_type,
            other_type_label=t_label, other_type_color=t_color,
            other_status_label=s_label, other_status_color=s_color,
            role=link.role, sort_order=link.sort_order, notes=link.notes,
            created_at=link.created_at)

    children = (await db.execute(
        select(InitiativeLink, Initiative)
        .join(Initiative, Initiative.id == InitiativeLink.child_id)
        .where(InitiativeLink.parent_id == initiative_id)
        .order_by(InitiativeLink.sort_order, InitiativeLink.created_at))).all()
    parents = (await db.execute(
        select(InitiativeLink, Initiative)
        .join(Initiative, Initiative.id == InitiativeLink.parent_id)
        .where(InitiativeLink.child_id == initiative_id)
        .order_by(InitiativeLink.sort_order, InitiativeLink.created_at))).all()
    return ([row(l, o) for l, o in children],
            [row(l, o) for l, o in parents])


async def _ancestor_ids(db: DbSession, start: uuid.UUID) -> set[uuid.UUID]:
    """Every initiative above `start` in the link graph (transitive)."""
    seen: set[uuid.UUID] = set()
    frontier = [start]
    while frontier:
        parents = list(await db.scalars(
            select(InitiativeLink.parent_id)
            .where(InitiativeLink.child_id.in_(frontier))))
        frontier = [p for p in parents if p not in seen]
        seen.update(frontier)
    return seen


@router.get("/{initiative_id}/links")
async def list_initiative_links(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "view"),
) -> dict:
    await _get_initiative(db, initiative_id)
    children, parents = await _link_rows(db, initiative_id)
    return {"children": children, "parents": parents}


@router.post("/{initiative_id}/links", response_model=InitiativeDetailOut,
             status_code=201)
async def add_initiative_link(
    initiative_id: uuid.UUID,
    body: InitiativeLinkAddIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> InitiativeDetailOut:
    initiative = await _get_initiative(db, initiative_id)
    if body.child_id == initiative_id:
        raise _err(422, "self_link")
    if await db.get(Initiative, body.child_id) is None:
        raise _err(422, "initiative_not_found")
    if await db.scalar(select(InitiativeLink.id).where(
            InitiativeLink.parent_id == initiative_id,
            InitiativeLink.child_id == body.child_id)) is not None:
        raise _err(409, "duplicate_link")
    # cycle: the proposed child must not already be an ancestor of parent
    if body.child_id in await _ancestor_ids(db, initiative_id):
        raise _err(422, "circular_link")
    db.add(InitiativeLink(parent_id=initiative_id,
                          **body.model_dump(exclude_none=True)))
    initiative.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="link_add",
          changes={"child_id": {"from": None, "to": str(body.child_id)}})
    await db.commit()
    return await _detail(db, initiative)


async def _get_link(db: DbSession, link_id: uuid.UUID) -> InitiativeLink:
    link = await db.get(InitiativeLink, link_id)
    if link is None:
        raise _err(404, "link_not_found")
    return link


@router.patch("/links/{link_id}", response_model=InitiativeLinkRow)
async def update_initiative_link(
    link_id: uuid.UUID,
    body: InitiativeLinkUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> InitiativeLinkRow:
    link = await _get_link(db, link_id)
    data = body.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(link, field, value)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(link.parent_id), action="link_update",
          changes={field: {"from": None, "to": str(value)}
                   for field, value in data.items()})
    await db.commit()
    children, _ = await _link_rows(db, link.parent_id)
    return next(r for r in children if r.id == link_id)


@router.delete("/links/{link_id}", status_code=204)
async def remove_initiative_link(
    link_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> None:
    link = await _get_link(db, link_id)
    parent_id, child_id = link.parent_id, link.child_id
    await db.delete(link)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(parent_id), action="link_remove",
          changes={"child_id": {"from": str(child_id), "to": None}})
    await db.commit()
```

- [ ] **Step 4: Run the tests**

Run: `cd api && .venv/bin/pytest tests/test_initiative_links_api.py tests/test_initiatives_api.py tests/test_initiative_people_api.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/initiatives.py api/tests/test_initiative_links_api.py
git commit -m "feat(api): initiative links — any-type nesting with universal cycle guard"
```

---

### Task 5: Global search

**Files:**
- Modify: `api/src/serversherpa/api/routes/search.py`
- Test: `api/tests/test_search_initiatives.py`

**Interfaces:**
- Produces: search hits `{kind: "initiative", id, label: name, sub: type key}`.

- [ ] **Step 1: Write the failing test**

`api/tests/test_search_initiatives.py`:

```python
"""Global search covers initiatives (name / location / sky-command ref)."""

from .test_assets_api import login


async def test_search_finds_initiatives(client, db, seeded_user):
    headers = await login(client)
    await client.post("/initiatives", headers=headers, json={
        "name": "Denver DC migration", "initiative_type": "project",
        "sky_command_project_id": "SKY-441"})
    for q in ("denver", "sky-441"):
        resp = await client.get(f"/search?q={q}", headers=headers)
        assert resp.status_code == 200
        hits = [r for r in resp.json()["results"]
                if r["kind"] == "initiative"]
        assert hits and hits[0]["label"] == "Denver DC migration", q
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && .venv/bin/pytest tests/test_search_initiatives.py -v`
Expected: FAIL — no `initiative` hits.

- [ ] **Step 3: Implement**

In `api/src/serversherpa/api/routes/search.py`: add `Initiative` to the models import, then append after the containers block (inside `global_search`):

```python
    # initiatives — name / location / sky-command ref; internal-only resource
    if user.access.can("initiatives", "view"):
        query = select(Initiative).where(or_(
            Initiative.name.ilike(needle),
            Initiative.location.ilike(needle),
            Initiative.sky_command_project_id.ilike(needle),
        ))
        initiatives = (await db.scalars(
            query.order_by(Initiative.name).limit(LIMIT_PER_KIND))).all()
        results.extend(
            SearchResult(kind="initiative", id=i.id, label=i.name,
                         sub=i.initiative_type)
            for i in initiatives
        )
```

- [ ] **Step 4: Run the test**

Run: `cd api && .venv/bin/pytest tests/test_search_initiatives.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/search.py api/tests/test_search_initiatives.py
git commit -m "feat(api): initiatives in global search"
```

---

### Task 6: Portal API client + pure page logic

**Files:**
- Modify: `portal/src/lib/api.ts` (append before the god-mode section, `/* ── initiatives ── */` banner)
- Create: `portal/src/lib/initiatives.ts`
- Test: `portal/src/lib/initiatives.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `errorFrom`, `StatusValue`, `ComboOption`, `GodField` (all existing).
- Produces (used by Tasks 7–8): TS interfaces `InitiativeItem`, `InitiativeDetail`, `InitiativePersonRow`, `InitiativeLinkRow`, `WorkerOption`; api functions `listInitiatives`, `getInitiative`, `createInitiative`, `updateInitiative`, `archiveInitiative`, `listInitiativeStatuses`, `listInitiativeTypes`, `listInitiativeSubTypes`, `listInitiativeWorkTypes`, `listShippingTypes`, `addInitiativePerson`, `updateInitiativePerson`, `removeInitiativePerson`, `addInitiativeLink`, `removeInitiativeLink`, `listWorkerOptions`; lib exports `initiativeSearchText`, `initiativeCellText`, `INITIATIVE_ERRORS`, `InitiativeFormState`, `formFromInitiative`, `initiativePayload`, `sectionsForType`, `INITIATIVE_GOD_FIELDS`.

- [ ] **Step 1: Write the failing unit tests**

`portal/src/lib/initiatives.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import type { InitiativeItem } from './api';
import {
  formFromInitiative, initiativeCellText, initiativePayload,
  initiativeSearchText, sectionsForType,
} from './initiatives';

const row: InitiativeItem = {
  id: 'i1', name: 'Denver DC migration', description: null,
  initiative_type: 'move', type_label: 'Move', type_color: '#a36207',
  sub_type: 'migration', sub_type_label: 'Migration', sub_type_color: '#0f7c86',
  status: 'in_progress', status_label: 'In progress', status_color: '#1668a7',
  client_id: 'c1', client_name: 'Acme', site_id: null, site_name: null,
  location: 'Denver, CO',
  scheduled_start: '2026-09-01T00:00:00Z', scheduled_end: null,
  sky_command_project_id: null,
  origin_site_id: 's1', origin_site_name: 'DC-East',
  destination_site_id: 's2', destination_site_name: 'DC-West',
  real_start_at: null, real_end_at: null, priority_devices: true,
  shipping_types: ['truck', 'rail'],
  shipping_partner_id: null, shipping_partner_name: null,
  origin_tech_partner_id: null, origin_cable_partner_id: null,
  origin_logistics_partner_id: null, destination_tech_partner_id: null,
  destination_cable_partner_id: null, destination_logistics_partner_id: null,
  origin_vendor_involved: null, destination_vendor_involved: null,
  people_count: 3, links_count: 1,
  archived_at: null, created_at: '2026-08-24T00:00:00Z',
};

describe('initiativeSearchText', () => {
  it('joins the searchable fields lowercased', () => {
    const t = initiativeSearchText(row);
    expect(t).toContain('denver dc migration');
    expect(t).toContain('move');
    expect(t).toContain('acme');
    expect(t).toContain('dc-east');
    expect(t).toContain('in progress');
  });
});

describe('initiativeCellText', () => {
  it('mirrors cell rendering including dashes', () => {
    expect(initiativeCellText(row, 'primary')).toBe('Denver DC migration');
    expect(initiativeCellText(row, 'type')).toBe('Move');
    expect(initiativeCellText(row, 'sub_type')).toBe('Migration');
    expect(initiativeCellText(row, 'status')).toBe('In progress');
    expect(initiativeCellText(row, 'client')).toBe('Acme');
    expect(initiativeCellText(row, 'site')).toBe('');
    expect(initiativeCellText({ ...row, scheduled_start: null }, 'start'))
      .toBe('—');
    expect(initiativeCellText(row, 'origin')).toBe('DC-East');
    expect(initiativeCellText(row, 'people')).toBe('3');
    expect(initiativeCellText(row, 'archived')).toBe('No');
  });
});

describe('sectionsForType', () => {
  it('shows the project field only for projects, move block only for moves', () => {
    expect(sectionsForType('project')).toEqual({ project: true, move: false });
    expect(sectionsForType('move')).toEqual({ project: false, move: true });
    expect(sectionsForType('event')).toEqual({ project: false, move: false });
  });
});

describe('form round-trip', () => {
  it('defaults for create mode', () => {
    const f = formFromInitiative(null);
    expect(f.initiative_type).toBe('project');
    expect(f.status).toBe('planned');
    expect(f.shipping_types).toEqual([]);
    expect(f.priority_devices).toBe(false);
  });

  it('loads dates as YYYY-MM-DD and rebuilds a payload with nulls', () => {
    const f = formFromInitiative(row);
    expect(f.scheduled_start).toBe('2026-09-01');
    const p = initiativePayload({ ...f, location: '  ' });
    expect(p.name).toBe('Denver DC migration');
    expect(p.location).toBeNull();
    expect(p.scheduled_start).toBe('2026-09-01');
    expect(p.scheduled_end).toBeNull();
    expect(p.shipping_types).toEqual(['truck', 'rail']);
    expect(p.priority_devices).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd portal && npx vitest run src/lib/initiatives.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the API client section**

Append to `portal/src/lib/api.ts` (before the god-mode section):

```typescript
/* ── initiatives ──────────────────────────────────────────────────── */

export interface InitiativeItem {
  id: string; name: string; description: string | null;
  initiative_type: string; type_label: string; type_color: string;
  sub_type: string | null; sub_type_label: string | null;
  sub_type_color: string | null;
  status: string; status_label: string; status_color: string;
  client_id: string | null; client_name: string | null;
  site_id: string | null; site_name: string | null;
  location: string | null;
  scheduled_start: string | null; scheduled_end: string | null;
  sky_command_project_id: string | null;
  origin_site_id: string | null; origin_site_name: string | null;
  destination_site_id: string | null; destination_site_name: string | null;
  real_start_at: string | null; real_end_at: string | null;
  priority_devices: boolean | null;
  shipping_types: string[];
  shipping_partner_id: string | null; shipping_partner_name: string | null;
  origin_tech_partner_id: string | null;
  origin_cable_partner_id: string | null;
  origin_logistics_partner_id: string | null;
  destination_tech_partner_id: string | null;
  destination_cable_partner_id: string | null;
  destination_logistics_partner_id: string | null;
  origin_vendor_involved: boolean | null;
  destination_vendor_involved: boolean | null;
  people_count: number; links_count: number;
  archived_at: string | null; created_at: string;
}

export interface InitiativePersonRow {
  id: string; person_id: string; person_name: string;
  work_type: string | null; work_type_label: string | null;
  work_type_color: string | null;
  site_worked_id: string | null; site_worked_name: string | null;
  rating: number | null; created_at: string;
}

export interface InitiativeLinkRow {
  id: string; other_id: string; other_name: string;
  other_type: string; other_type_label: string; other_type_color: string;
  other_status_label: string; other_status_color: string;
  role: string | null; sort_order: number | null; notes: string | null;
  created_at: string;
}

export interface InitiativeDetail extends InitiativeItem {
  people: InitiativePersonRow[];
  links_children: InitiativeLinkRow[];
  links_parents: InitiativeLinkRow[];
}

export async function listInitiatives(): Promise<InitiativeItem[]> {
  const resp = await apiFetch('/initiatives');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getInitiative(id: string): Promise<InitiativeDetail> {
  const resp = await apiFetch(`/initiatives/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function createInitiative(
  body: Record<string, unknown>,
): Promise<InitiativeDetail> {
  const resp = await apiFetch('/initiatives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateInitiative(
  id: string, body: Record<string, unknown>,
): Promise<InitiativeDetail> {
  const resp = await apiFetch(`/initiatives/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function archiveInitiative(
  id: string, archived: boolean,
): Promise<void> {
  const resp = await apiFetch(
    `/initiatives/${id}/${archived ? 'archive' : 'unarchive'}`,
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

async function statusValuesFor(recordType: string): Promise<StatusValue[]> {
  const resp = await apiFetch(`/status-values?record_type=${recordType}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export const listInitiativeStatuses = () => statusValuesFor('initiative');
export const listInitiativeTypes = () => statusValuesFor('initiative_type');
export const listInitiativeSubTypes = () =>
  statusValuesFor('initiative_sub_type');
export const listInitiativeWorkTypes = () =>
  statusValuesFor('initiative_work_type');
export const listShippingTypes = () => statusValuesFor('shipping_type');

export async function addInitiativePerson(
  id: string, body: Record<string, unknown>,
): Promise<InitiativePersonRow[]> {
  const resp = await apiFetch(`/initiatives/${id}/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateInitiativePerson(
  assocId: string, body: Record<string, unknown>,
): Promise<InitiativePersonRow> {
  const resp = await apiFetch(`/initiatives/people/${assocId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function removeInitiativePerson(assocId: string): Promise<void> {
  const resp = await apiFetch(`/initiatives/people/${assocId}`,
    { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function addInitiativeLink(
  id: string, body: Record<string, unknown>,
): Promise<InitiativeDetail> {
  const resp = await apiFetch(`/initiatives/${id}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function removeInitiativeLink(linkId: string): Promise<void> {
  const resp = await apiFetch(`/initiatives/links/${linkId}`,
    { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

/** Minimal person options for the assignment picker (GET /workers). */
export interface WorkerOption {
  person_id: string; display_name: string;
}

export async function listWorkerOptions(): Promise<WorkerOption[]> {
  const resp = await apiFetch('/workers');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 4: Write the pure logic module**

`portal/src/lib/initiatives.ts`:

```typescript
/**
 * Initiatives page logic — pure functions the components delegate to
 * (the lib/containers.ts pattern), unit-testable without jsdom.
 */
import type { ComboOption } from '../components/ComboBox';
import type { InitiativeItem } from './api';
import type { GodField } from './godEdit';

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString() : '—';

export function initiativeSearchText(i: InitiativeItem): string {
  return [i.name, i.type_label, i.sub_type_label, i.status_label,
          i.client_name, i.site_name, i.location, i.origin_site_name,
          i.destination_site_name, i.sky_command_project_id]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor — one row's display text per column key, mirroring
 *  the page's cell renderer exactly (including '—' fallbacks). 'primary'
 *  is the always-shown name cell; 'archived' is the chevron pseudo-column. */
export function initiativeCellText(i: InitiativeItem, colKey: string): string {
  switch (colKey) {
    case 'primary': return i.name;
    case 'type': return i.type_label;
    case 'sub_type': return i.sub_type_label ?? '';
    case 'status': return i.status_label;
    case 'client': return i.client_name ?? '';
    case 'site': return i.site_name ?? '';
    case 'location': return i.location || '—';
    case 'start': return day(i.scheduled_start);
    case 'end': return day(i.scheduled_end);
    case 'origin': return i.origin_site_name ?? '';
    case 'destination': return i.destination_site_name ?? '';
    case 'shipping': return i.shipping_types.join(', ') || '—';
    case 'people': return String(i.people_count);
    case 'links': return String(i.links_count);
    case 'created': return day(i.created_at);
    case 'archived': return i.archived_at ? 'Yes' : 'No';
    default: return '';
  }
}

export const INITIATIVE_ERRORS: Record<string, string> = {
  name_required: 'Name is required.',
  initiative_type_required: 'Type is required.',
  status_required: 'Status is required.',
  unknown_initiative_type: 'Pick a type from the list.',
  unknown_sub_type: 'Pick a sub-type from the list.',
  unknown_status: 'Pick a status from the list.',
  unknown_shipping_type: 'Pick shipping types from the list.',
  unknown_work_type: 'Pick a work type from the list.',
  client_not_found: 'Pick a client from the list.',
  site_not_found: 'Pick a site from the list.',
  partner_not_found: 'Pick a partner from the list.',
  person_not_found: 'That person no longer exists.',
  initiative_not_found: 'That initiative no longer exists.',
  type_change_forbidden: "Only admins can change an initiative's type.",
  duplicate_person: 'That person is already on this initiative.',
  rating_out_of_range: 'Rating must be between 1 and 5.',
  assignment_not_found: 'That assignment no longer exists.',
  self_link: 'An initiative cannot contain itself.',
  duplicate_link: 'Those initiatives are already linked.',
  circular_link: 'That link would create a loop.',
  link_not_found: 'That link no longer exists.',
  forbidden: 'You do not have permission to change initiatives.',
};

/** Which conditional form sections a type shows. */
export function sectionsForType(
  type: string,
): { project: boolean; move: boolean } {
  return { project: type === 'project', move: type === 'move' };
}

/* ── edit/create form ────────────────────────────────────────────── */

export interface InitiativeFormState {
  name: string; description: string;
  initiative_type: string; sub_type: string; status: string;
  client_id: string; site_id: string; location: string;
  scheduled_start: string; scheduled_end: string;   // YYYY-MM-DD or ''
  sky_command_project_id: string;
  origin_site_id: string; destination_site_id: string;
  real_start_at: string; real_end_at: string;       // YYYY-MM-DD or ''
  priority_devices: boolean;
  shipping_types: string[];
  shipping_partner_id: string;
  origin_tech_partner_id: string; origin_cable_partner_id: string;
  origin_logistics_partner_id: string;
  destination_tech_partner_id: string; destination_cable_partner_id: string;
  destination_logistics_partner_id: string;
  origin_vendor_involved: boolean; destination_vendor_involved: boolean;
}

const toDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

export function formFromInitiative(
  i: InitiativeItem | null,
): InitiativeFormState {
  return {
    name: i?.name ?? '',
    description: i?.description ?? '',
    initiative_type: i?.initiative_type ?? 'project',
    sub_type: i?.sub_type ?? '',
    status: i?.status ?? 'planned',
    client_id: i?.client_id ?? '',
    site_id: i?.site_id ?? '',
    location: i?.location ?? '',
    scheduled_start: toDay(i?.scheduled_start),
    scheduled_end: toDay(i?.scheduled_end),
    sky_command_project_id: i?.sky_command_project_id ?? '',
    origin_site_id: i?.origin_site_id ?? '',
    destination_site_id: i?.destination_site_id ?? '',
    real_start_at: toDay(i?.real_start_at),
    real_end_at: toDay(i?.real_end_at),
    priority_devices: i?.priority_devices ?? false,
    shipping_types: i?.shipping_types ?? [],
    shipping_partner_id: i?.shipping_partner_id ?? '',
    origin_tech_partner_id: i?.origin_tech_partner_id ?? '',
    origin_cable_partner_id: i?.origin_cable_partner_id ?? '',
    origin_logistics_partner_id: i?.origin_logistics_partner_id ?? '',
    destination_tech_partner_id: i?.destination_tech_partner_id ?? '',
    destination_cable_partner_id: i?.destination_cable_partner_id ?? '',
    destination_logistics_partner_id:
      i?.destination_logistics_partner_id ?? '',
    origin_vendor_involved: i?.origin_vendor_involved ?? false,
    destination_vendor_involved: i?.destination_vendor_involved ?? false,
  };
}

/** Payload for create AND patch — nulls stay in: PATCH needs them to
 *  clear fields, POST drops them server-side (exclude_none). Dates go
 *  as YYYY-MM-DD strings (the API parses them as midnight UTC). */
export function initiativePayload(
  form: InitiativeFormState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, raw: string) => {
    const v = raw.trim();
    out[key] = v || null;
  };
  out.name = form.name.trim();
  out.initiative_type = form.initiative_type;
  out.status = form.status;
  put('description', form.description);
  put('sub_type', form.sub_type);
  put('client_id', form.client_id);
  put('site_id', form.site_id);
  put('location', form.location);
  put('scheduled_start', form.scheduled_start);
  put('scheduled_end', form.scheduled_end);
  put('sky_command_project_id', form.sky_command_project_id);
  put('origin_site_id', form.origin_site_id);
  put('destination_site_id', form.destination_site_id);
  put('real_start_at', form.real_start_at);
  put('real_end_at', form.real_end_at);
  out.priority_devices = form.priority_devices;
  out.shipping_types = form.shipping_types;
  put('shipping_partner_id', form.shipping_partner_id);
  put('origin_tech_partner_id', form.origin_tech_partner_id);
  put('origin_cable_partner_id', form.origin_cable_partner_id);
  put('origin_logistics_partner_id', form.origin_logistics_partner_id);
  put('destination_tech_partner_id', form.destination_tech_partner_id);
  put('destination_cable_partner_id', form.destination_cable_partner_id);
  put('destination_logistics_partner_id',
      form.destination_logistics_partner_id);
  out.origin_vendor_involved = form.origin_vendor_involved;
  out.destination_vendor_involved = form.destination_vendor_involved;
  return out;
}

/* ── god-edit descriptors (lib/containers.ts factory pattern) ────── */

export interface InitiativeGodLookups {
  clients: () => ComboOption[];
  sites: () => ComboOption[];
  statuses: () => ComboOption[];
  types: () => ComboOption[];
  subTypes: () => ComboOption[];
}

export function INITIATIVE_GOD_FIELDS(
  lookups: InitiativeGodLookups,
): GodField<InitiativeItem>[] {
  return [
    { column: 'primary', field: 'name', kind: 'text',
      fromRow: (i) => i.name },
    { column: 'location', field: 'location', kind: 'text',
      fromRow: (i) => i.location ?? '' },
    { column: 'type', field: 'initiative_type', kind: 'combo',
      fromRow: (i) => i.initiative_type, options: lookups.types },
    { column: 'sub_type', field: 'sub_type', kind: 'combo',
      fromRow: (i) => i.sub_type ?? '', options: lookups.subTypes },
    { column: 'status', field: 'status', kind: 'combo',
      fromRow: (i) => i.status, options: lookups.statuses },
    { column: 'client', field: 'client_id', kind: 'combo',
      fromRow: (i) => i.client_id ?? '', options: lookups.clients },
    { column: 'site', field: 'site_id', kind: 'combo',
      fromRow: (i) => i.site_id ?? '', options: lookups.sites },
  ];
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd portal && npx vitest run src/lib/initiatives.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors. Note: `listWorkerOptions` returns full `/workers` rows; the declared `WorkerOption` subset type is intentional (TS structural typing ignores the extra fields).

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/initiatives.ts portal/src/lib/initiatives.test.ts
git commit -m "feat(portal): initiatives API client + pure page logic"
```

---

### Task 7: InitiativeEditModal

**Files:**
- Create: `portal/src/components/initiatives/InitiativeEditModal.tsx`

**Interfaces:**
- Consumes: Task 6's api/lib exports; existing `ComboBox`, `OrgRef`, `SiteItem`, `StatusValue`.
- Produces: `<InitiativeEditModal initiative={InitiativeItem | null} statuses types subTypes shippingTypes sites clients partners isAdmin canChange onClose onSaved />` — the only field-mutation surface. All display logic delegates to `lib/initiatives.ts` (tested in Task 6; no component test — the codebase has no jsdom component tests).

- [ ] **Step 1: Write the component**

`portal/src/components/initiatives/InitiativeEditModal.tsx`:

```tsx
/**
 * InitiativeEditModal — the only place an initiative's fields are
 * mutated: field edits + archive/unarchive. `initiative === null` opens
 * in create mode. The type picker drives conditional sections
 * (sectionsForType); after creation only admins may change the type —
 * the server enforces this too (403 type_change_forbidden). Follows
 * ContainerEditModal's modal conventions.
 */

import { useState, type FormEvent } from 'react';

import {
  ApiError,
  archiveInitiative,
  createInitiative,
  updateInitiative,
  type InitiativeItem,
  type OrgRef,
  type SiteItem,
  type StatusValue,
} from '../../lib/api';
import {
  formFromInitiative, INITIATIVE_ERRORS, initiativePayload, sectionsForType,
  type InitiativeFormState,
} from '../../lib/initiatives';
import ComboBox from '../ComboBox';

interface Props {
  initiative: InitiativeItem | null;   // null = create mode
  statuses: StatusValue[];
  types: StatusValue[];
  subTypes: StatusValue[];
  shippingTypes: StatusValue[];
  sites: SiteItem[];
  clients: OrgRef[];
  partners: OrgRef[];
  isAdmin: boolean;
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

function mapError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return INITIATIVE_ERRORS[err.code] ?? fallback;
  return 'Network error.';
}

export default function InitiativeEditModal({
  initiative, statuses, types, subTypes, shippingTypes, sites, clients,
  partners, isAdmin, canChange, onClose, onSaved,
}: Props) {
  const isCreateMode = initiative === null;
  const [form, setForm] = useState<InitiativeFormState>(
    () => formFromInitiative(initiative));
  const [archived, setArchived] = useState<boolean>(!!initiative?.archived_at);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const locked = saving || (!isCreateMode && !canChange);
  // type is picked freely on create; edits are admin-only (server-enforced)
  const typeLocked = locked || (!isCreateMode && !isAdmin);
  const sections = sectionsForType(form.initiative_type);

  const setField = (key: keyof InitiativeFormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setFlag = (key: keyof InitiativeFormState, value: boolean) =>
    setForm((f) => ({ ...f, [key]: value }));
  const toggleShipping = (key: string) =>
    setForm((f) => ({
      ...f,
      shipping_types: f.shipping_types.includes(key)
        ? f.shipping_types.filter((s) => s !== key)
        : [...f.shipping_types, key],
    }));

  // a row sitting on a retired vocab value isn't in the is_active list —
  // seed the option back from the row (the ContainerEditModal trap/fix)
  const seedOption = (
    list: StatusValue[], key: string | null | undefined,
    label: string | null | undefined,
  ) => (key && !list.some((s) => s.key === key)
    ? [...list, { key, label: label ?? key } as StatusValue] : list);

  const statusOptions = seedOption(statuses, initiative?.status,
    initiative?.status_label).map((s) => ({ value: s.key, label: s.label }));
  const typeOptions = seedOption(types, initiative?.initiative_type,
    initiative?.type_label).map((t) => ({ value: t.key, label: t.label }));
  const subTypeOptions = seedOption(subTypes, initiative?.sub_type,
    initiative?.sub_type_label).map((t) => ({ value: t.key, label: t.label }));
  const siteOptions = (exclude?: string) => sites
    .filter((s) => !s.archived_at || s.id === exclude)
    .map((s) => ({ value: s.id, label: s.name }));
  const orgOptions = (orgs: OrgRef[]) =>
    orgs.filter((o) => !o.archived_at)
      .map((o) => ({ value: o.id, label: o.name }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = initiativePayload(form);
      if (isCreateMode) {
        await createInitiative(payload);
      } else {
        await updateInitiative(initiative.id, payload);
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
    if (!initiative) return;
    setSaving(true);
    setError('');
    try {
      await archiveInitiative(initiative.id, !archived);
      setArchived((v) => !v);
      await onSaved();
    } catch (err) {
      setError(mapError(err, 'Could not change the archive state — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const partnerCombo = (
    label: string, key: keyof InitiativeFormState,
  ) => (
    <div><label>{label}</label>
      <ComboBox
        placeholder="Type to search partners…"
        value={form[key] as string}
        clearable
        disabled={locked}
        onChange={(v) => setField(key, v)}
        options={orgOptions(partners)}
      /></div>
  );

  const title = initiative
    ? `Edit — ${form.name || 'Initiative'}` : 'New initiative';

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}
                  disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.2" strokeLinecap="round">
              <path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="modal-section">Identity</div>
            <div className="pf-form">
              <div><label>Name</label>
                <input value={form.name} disabled={locked} required
                       onChange={(e) => setField('name', e.target.value)} /></div>
              <div><label>Type</label>
                <ComboBox
                  placeholder="Type to search types…"
                  value={form.initiative_type}
                  disabled={typeLocked}
                  onChange={(v) => setField('initiative_type', v)}
                  options={typeOptions}
                />
                {!isCreateMode && !isAdmin && (
                  <span className="page-hint">Only admins can change the type.</span>
                )}</div>
              <div><label>Sub-type</label>
                <ComboBox
                  placeholder="Type to search sub-types…"
                  value={form.sub_type}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('sub_type', v)}
                  options={subTypeOptions}
                /></div>
              <div><label>Status</label>
                <ComboBox
                  placeholder="Type to search statuses…"
                  value={form.status}
                  disabled={locked}
                  onChange={(v) => setField('status', v)}
                  options={statusOptions}
                /></div>
              <div style={{ gridColumn: '1 / -1' }}><label>Description</label>
                <input value={form.description} disabled={locked}
                       onChange={(e) => setField('description', e.target.value)} /></div>
            </div>

            <div className="modal-section">Where &amp; when</div>
            <div className="pf-form">
              <div><label>Client</label>
                <ComboBox
                  placeholder="Type to search clients…"
                  value={form.client_id}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('client_id', v)}
                  options={orgOptions(clients)}
                /></div>
              <div><label>Site</label>
                <ComboBox
                  placeholder="Type to search sites…"
                  value={form.site_id}
                  clearable
                  disabled={locked}
                  onChange={(v) => setField('site_id', v)}
                  options={siteOptions(form.site_id)}
                /></div>
              <div><label>Location (free text)</label>
                <input value={form.location} disabled={locked}
                       onChange={(e) => setField('location', e.target.value)} /></div>
              <div><label>Scheduled start</label>
                <input type="date" value={form.scheduled_start} disabled={locked}
                       onChange={(e) => setField('scheduled_start', e.target.value)} /></div>
              <div><label>Scheduled end</label>
                <input type="date" value={form.scheduled_end} disabled={locked}
                       onChange={(e) => setField('scheduled_end', e.target.value)} /></div>
            </div>

            {sections.project && (
              <>
                <div className="modal-section">Project</div>
                <div className="pf-form">
                  <div><label>Sky Command project ID</label>
                    <input value={form.sky_command_project_id} disabled={locked}
                           onChange={(e) =>
                             setField('sky_command_project_id', e.target.value)} /></div>
                </div>
              </>
            )}

            {sections.move && (
              <>
                <div className="modal-section">Move</div>
                <div className="pf-form">
                  <div><label>Origin site</label>
                    <ComboBox
                      placeholder="Type to search sites…"
                      value={form.origin_site_id}
                      clearable
                      disabled={locked}
                      onChange={(v) => setField('origin_site_id', v)}
                      options={siteOptions(form.origin_site_id)}
                    /></div>
                  <div><label>Destination site</label>
                    <ComboBox
                      placeholder="Type to search sites…"
                      value={form.destination_site_id}
                      clearable
                      disabled={locked}
                      onChange={(v) => setField('destination_site_id', v)}
                      options={siteOptions(form.destination_site_id)}
                    /></div>
                  <div><label>Actual start</label>
                    <input type="date" value={form.real_start_at} disabled={locked}
                           onChange={(e) => setField('real_start_at', e.target.value)} /></div>
                  <div><label>Actual end</label>
                    <input type="date" value={form.real_end_at} disabled={locked}
                           onChange={(e) => setField('real_end_at', e.target.value)} /></div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label>Shipping types</label>
                    <div className="chips">
                      {shippingTypes.map((s) => (
                        <label key={s.key} className="chip tag"
                               style={{ cursor: 'pointer' }}>
                          <input type="checkbox"
                                 checked={form.shipping_types.includes(s.key)}
                                 disabled={locked}
                                 onChange={() => toggleShipping(s.key)} />
                          {s.label}
                        </label>
                      ))}
                    </div></div>
                  {partnerCombo('Shipping partner', 'shipping_partner_id')}
                  <div><label>Priority devices</label>
                    <input type="checkbox" checked={form.priority_devices}
                           disabled={locked}
                           onChange={(e) =>
                             setFlag('priority_devices', e.target.checked)} /></div>
                  {partnerCombo('Origin tech partner', 'origin_tech_partner_id')}
                  {partnerCombo('Origin cable partner', 'origin_cable_partner_id')}
                  {partnerCombo('Origin logistics partner',
                                'origin_logistics_partner_id')}
                  <div><label>Origin vendor involved</label>
                    <input type="checkbox" checked={form.origin_vendor_involved}
                           disabled={locked}
                           onChange={(e) =>
                             setFlag('origin_vendor_involved', e.target.checked)} /></div>
                  {partnerCombo('Destination tech partner',
                                'destination_tech_partner_id')}
                  {partnerCombo('Destination cable partner',
                                'destination_cable_partner_id')}
                  {partnerCombo('Destination logistics partner',
                                'destination_logistics_partner_id')}
                  <div><label>Destination vendor involved</label>
                    <input type="checkbox"
                           checked={form.destination_vendor_involved}
                           disabled={locked}
                           onChange={(e) =>
                             setFlag('destination_vendor_involved',
                                     e.target.checked)} /></div>
                </div>
              </>
            )}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreateMode ? 'Create initiative' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose}
                    disabled={saving}>
              Cancel
            </button>
            {initiative && canChange && (
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

- [ ] **Step 2: Typecheck**

Run: `cd portal && npx tsc --noEmit`
Expected: no errors. (If `OrgRef` lacks `archived_at` in its type, it is optional — `o.archived_at` narrows fine; adjust only if tsc complains.)

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/initiatives/InitiativeEditModal.tsx
git commit -m "feat(portal): initiative edit modal — conditional type sections, admin-gated type"
```

---

### Task 8: Initiatives page, row panels, wiring, full verification

**Files:**
- Create: `portal/src/pages/Initiatives.tsx`
- Modify: `portal/src/App.tsx` (route)
- Modify: `portal/src/layout/navSections.tsx` (new section, above Logistics)
- Modify: `portal/src/components/CommandPalette.tsx` (~line 77)
- Modify: `portal/src/components/Topbar.tsx` (~line 126, the `hit.kind` chain)
- Modify: `portal/src/lib/access.ts:11-26` (`ROUTE_RESOURCE`)

**Interfaces:**
- Consumes: everything from Tasks 6–7.
- Produces: `/initiatives` route, nav entry, palette entry, search deep-link.

- [ ] **Step 1: Write the page**

`portal/src/pages/Initiatives.tsx` — clone of `pages/Containers.tsx` with these exact substitutions (same structure, hooks, deep-link/filter interplay, god-edit wiring; refer to Containers.tsx lines 93–190 for the component skeleton being mirrored):

```tsx
/**
 * Initiatives — unified projects / events / moves: one list, a type
 * chip, conditional move columns, people + links + notes in the row
 * detail. Directory pattern cloned from Containers.tsx; all field
 * mutation lands in InitiativeEditModal.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { useAuth } from '../auth/AuthContext';
import InitiativeEditModal from '../components/initiatives/InitiativeEditModal';
import NotesFilesPanel from '../components/NotesFilesPanel';
import {
  ApiError,
  addInitiativeLink,
  addInitiativePerson,
  getInitiative,
  listClients,
  listInitiatives,
  listInitiativeStatuses,
  listInitiativeSubTypes,
  listInitiativeTypes,
  listInitiativeWorkTypes,
  listPartners,
  listShippingTypes,
  listSites,
  listWorkerOptions,
  removeInitiativeLink,
  removeInitiativePerson,
  updateInitiative,
  type InitiativeDetail,
  type InitiativeItem,
  type OrgRef,
  type SiteItem,
  type StatusValue,
  type WorkerOption,
} from '../lib/api';
import {
  INITIATIVE_ERRORS, INITIATIVE_GOD_FIELDS, initiativeCellText,
  initiativeSearchText,
} from '../lib/initiatives';
import { initialOpenId } from '../lib/auditFormat';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import { GodCell, GodEditToggle, useGodEdit } from '../lib/godEdit';
import { naturalCompare } from '../lib/sites';
import { useRecordFocus } from '../lib/useDeepLinkFilter';
import {
  ColumnsButton, ExportButton, exportCsv, visibleColumnsFor,
  type ColumnDef,
} from '../lib/listTools';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/assets.css';

const COLUMNS: ColumnDef[] = [
  { key: 'type', label: 'Type', width: '0.9fr', default: true },
  { key: 'sub_type', label: 'Sub-type', width: '1fr', default: true },
  { key: 'status', label: 'Status', width: '1.1fr', default: true },
  { key: 'client', label: 'Client', width: '1.2fr', default: true },
  { key: 'site', label: 'Site', width: '1.2fr', default: true },
  { key: 'start', label: 'Start', width: '0.9fr', default: true },
  { key: 'end', label: 'End', width: '0.9fr', default: false },
  { key: 'location', label: 'Location', width: '1.2fr', default: false },
  { key: 'origin', label: 'Origin', width: '1.2fr', default: false },
  { key: 'destination', label: 'Destination', width: '1.2fr', default: false },
  { key: 'shipping', label: 'Shipping', width: '1fr', default: false },
  { key: 'people', label: 'People', width: '0.6fr', default: false },
  { key: 'links', label: 'Links', width: '0.6fr', default: false },
  { key: 'created', label: 'Created', width: '0.9fr', default: false },
];

const ALL_COLUMN_KEYS = new Set<string>(
  [...COLUMNS.map((c) => c.key), 'primary', 'archived']);
const DEFAULT_VISIBLE = new Set<string>(
  COLUMNS.filter((c) => c.default).map((c) => c.key));

function sortValueFor(i: InitiativeItem, key: string): string {
  switch (key) {
    case 'primary': return i.name.toLowerCase();
    case 'type': return i.type_label.toLowerCase();
    case 'sub_type': return (i.sub_type_label ?? '').toLowerCase();
    case 'status': return i.status_label.toLowerCase();
    case 'client': return (i.client_name ?? '').toLowerCase();
    case 'site': return (i.site_name ?? '').toLowerCase();
    case 'start': return i.scheduled_start ?? '';
    case 'end': return i.scheduled_end ?? '';
    case 'location': return (i.location ?? '').toLowerCase();
    case 'origin': return (i.origin_site_name ?? '').toLowerCase();
    case 'destination': return (i.destination_site_name ?? '').toLowerCase();
    case 'shipping': return i.shipping_types.join(',');
    case 'people': return String(i.people_count).padStart(6, '0');
    case 'links': return String(i.links_count).padStart(6, '0');
    case 'created': return i.created_at;
    case 'archived': return i.archived_at ? '1' : '0';
    default: return '';
  }
}

const CSV_COLUMNS: [string, (i: InitiativeItem) => string][] = [
  ['ID', (i) => i.id],
  ['Name', (i) => i.name],
  ['Type', (i) => i.type_label],
  ['Sub-type', (i) => i.sub_type_label ?? ''],
  ['Status', (i) => i.status_label],
  ['Client', (i) => i.client_name ?? ''],
  ['Site', (i) => i.site_name ?? ''],
  ['Location', (i) => i.location ?? ''],
  ['Scheduled start', (i) => i.scheduled_start ?? ''],
  ['Scheduled end', (i) => i.scheduled_end ?? ''],
  ['Origin', (i) => i.origin_site_name ?? ''],
  ['Destination', (i) => i.destination_site_name ?? ''],
  ['Shipping', (i) => i.shipping_types.join('; ')],
  ['People', (i) => String(i.people_count)],
  ['Links', (i) => String(i.links_count)],
  ['Created', (i) => i.created_at],
];

export default function Initiatives() {
  const { can, godMode, maxRank } = useAuth();
  const canAdd = can('initiatives', 'add');
  const canChange = can('initiatives', 'change');
  const canViewSites = can('sites', 'view');
  const canViewClients = can('clients', 'view');
  const canViewPartners = can('partners', 'view');
  const canViewWorkers = can('workers', 'view');
  const isAdmin = maxRank >= 60;   // roles.rank for "admin" (migration 0009)
  const god = useGodEdit();

  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [types, setTypes] = useState<StatusValue[]>([]);
  const [subTypes, setSubTypes] = useState<StatusValue[]>([]);
  const [workTypes, setWorkTypes] = useState<StatusValue[]>([]);
  const [shippingTypes, setShippingTypes] = useState<StatusValue[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);
  const [partners, setPartners] = useState<OrgRef[]>([]);
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const deepLinkTarget = useRef<string | null>(initialOpenId());
  const focusOpenId = (id: string | null) => {
    deepLinkTarget.current = id;
    clearedDeepLink.current = null;
    setOpenId(id);
  };
  useRecordFocus(initiatives, (i) => i.id, (i) => i.name, focusOpenId, setQuery);
  const clearedDeepLink = useRef<string | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
  } = usePersistentListState(
    'initiatives', { visible: DEFAULT_VISIBLE, sortKey: 'primary', sortDir: 1 },
    ALL_COLUMN_KEYS,
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      setInitiatives(await listInitiatives());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view initiatives.'
        : 'Failed to load initiatives.');
    }
  };

  useEffect(() => {
    void load();
    void listInitiativeStatuses().then(setStatuses).catch(() => {});
    void listInitiativeTypes().then(setTypes).catch(() => {});
    void listInitiativeSubTypes().then(setSubTypes).catch(() => {});
    void listInitiativeWorkTypes().then(setWorkTypes).catch(() => {});
    void listShippingTypes().then(setShippingTypes).catch(() => {});
    if (canViewSites) void listSites().then(setSites).catch(() => {});
    if (canViewClients) void listClients().then(setClients).catch(() => {});
    if (canViewPartners) void listPartners().then(setPartners).catch(() => {});
    if (canViewWorkers) void listWorkerOptions().then(setWorkers).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const godFields = useMemo(() => INITIATIVE_GOD_FIELDS({
    clients: () => (canViewClients
      ? clients.map((c) => ({ value: c.id, label: c.name })) : []),
    sites: () => (canViewSites
      ? sites.map((s) => ({ value: s.id, label: s.name })) : []),
    statuses: () => statuses.map((s) => ({ value: s.key, label: s.label })),
    types: () => (isAdmin
      ? types.map((t) => ({ value: t.key, label: t.label })) : []),
    subTypes: () => subTypes.map((t) => ({ value: t.key, label: t.label })),
  }), [clients, sites, statuses, types, subTypes, canViewClients,
       canViewSites, isAdmin]);
  const godFieldFor = (column: string) =>
    godFields.find((f) => f.column === column);
  const replaceRow = (u: InitiativeItem) =>
    setInitiatives((xs) => xs?.map((x) => (x.id === u.id ? u : x)) ?? xs);

  const visible = useMemo(() => {
    if (!initiatives) return [];
    const q = query.trim().toLowerCase();
    const showArchived = filters.archived?.values?.includes('Yes') ?? false;
    const rows = initiatives.filter((i) => {
      if (!showArchived && i.archived_at) return false;
      if (!passesColumnFilters(i, filters, initiativeCellText)) return false;
      if (!q) return true;
      return initiativeSearchText(i).includes(q);
    });
    return rows.sort((a, b) =>
      naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [initiatives, filters, query, sortKey, sortDir]);

  // Deep-link vs persisted-filter interplay — cloned from Containers.tsx.
  useEffect(() => {
    if (!initiatives || !openId || visible.some((i) => i.id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId;
      const target = initiatives.find((i) => i.id === openId);
      if (target && !passesColumnFilters(target, filters, initiativeCellText)) {
        clearFilters();
        return;
      }
    }
    setOpenId(null);
  }, [initiatives, visible, openId, filters, clearFilters]);

  useEffect(() => {
    if (deepLinkTarget.current
        && visible.some((i) => i.id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  const caret = (key: string) =>
    sortKey === key
      ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const shownCols = visibleColumnsFor(COLUMNS, visibleCols, godMode);
  const grid = { gridTemplateColumns:
    `2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

  const chip = (label: string | null, color: string | null) =>
    label && color
      ? (
        <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
          <span className="dot" />{label}
        </span>
      )
      : <span className="cell-top">—</span>;

  const cellFor = (i: InitiativeItem, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={i} gf={gf} patch={updateInitiative} onRowSaved={replaceRow}
                   errorMap={INITIATIVE_ERRORS} disabled={!canChange} />
        );
      }
    }
    switch (key) {
      case 'type': return chip(i.type_label, i.type_color);
      case 'sub_type': return chip(i.sub_type_label, i.sub_type_color);
      case 'status':
        return (
          <div className="chips">
            {chip(i.status_label, i.status_color)}
            {i.archived_at && <span className="chip tag">Archived</span>}
          </div>
        );
      case 'client': return <span className="cell-top">{i.client_name ?? '—'}</span>;
      case 'site': return <span className="cell-top">{i.site_name ?? '—'}</span>;
      case 'location': return <span className="cell-top">{i.location || '—'}</span>;
      case 'start':
        return <span className="cell-top">{initiativeCellText(i, 'start')}</span>;
      case 'end':
        return <span className="cell-top">{initiativeCellText(i, 'end')}</span>;
      case 'origin':
        return <span className="cell-top">{i.origin_site_name ?? '—'}</span>;
      case 'destination':
        return <span className="cell-top">{i.destination_site_name ?? '—'}</span>;
      case 'shipping':
        return <span className="cell-top">{initiativeCellText(i, 'shipping')}</span>;
      case 'people': return <span className="mono">{i.people_count}</span>;
      case 'links': return <span className="mono">{i.links_count}</span>;
      case 'created':
        return <span className="cell-top">{initiativeCellText(i, 'created')}</span>;
      default: return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Operations</div>
          <h1 className="page-title">
            Initiatives
            <span className="badge-count">{initiatives?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Projects, events, and moves — one list, discriminated by type.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">
            {visible.length} of {initiatives?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={COLUMNS} visible={visibleCols}
                         onChange={setVisibleCols} godMode={godMode} />
          <ExportButton onExport={() =>
            exportCsv('initiatives', CSV_COLUMNS, visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle}
                         visible={godMode && canChange} />
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New initiative
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load initiatives</b>{error}</div>
      )}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <span className="col-head">
              <button className="sortable" onClick={() => toggleSort('primary')}>
                Name {caret('primary')}
              </button>
              <ColumnMenu colKey="primary" label="Name"
                          allRows={initiatives ?? []} filters={filters}
                          text={initiativeCellText}
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
                            allRows={initiatives ?? []} filters={filters}
                            text={initiativeCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <ColumnMenu colKey="archived" label="Archived"
                        allRows={initiatives ?? []} filters={filters}
                        text={initiativeCellText}
                        filter={filters.archived} onFilter={setFilter}
                        sortDir={sortKey === 'archived' ? sortDir : null}
                        onSort={(dir) => setSort('archived', dir)} />
          </div>

          {initiatives && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — or add an initiative.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          {visible.map((i) => {
            const open = openId === i.id;
            return (
              <div key={i.id}
                   className={`dir-row ${open ? 'open' : ''} ${i.archived_at ? 'archived' : ''}`}>
                <div className="row-main" style={grid}
                     onClick={() => {
                       deepLinkTarget.current = null;
                       setOpenId(open ? null : i.id);
                     }}>
                  <div className="cell cell-primary">
                    {god.editing && godFieldFor('primary') ? (
                      <div className="pn god-primary-edit">
                        <GodCell row={i} gf={godFieldFor('primary')!}
                                 patch={updateInitiative} onRowSaved={replaceRow}
                                 errorMap={INITIATIVE_ERRORS}
                                 disabled={!canChange} />
                      </div>
                    ) : (
                      <div className="pn"><b>{i.name}</b>
                        <span>{i.type_label}</span></div>
                    )}
                  </div>
                  {shownCols.map((col) => (
                    <div className="cell" key={col.key}>{cellFor(i, col.key)}</div>
                  ))}
                  <div className="cell chevron-cell">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round"
                         strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                  </div>
                </div>

                <div className="detail">
                  <div className="detail-clip">
                    <div className="detail-inner">
                      {open && (
                        <InitiativeRowDetail
                          initiative={i}
                          canEdit={canChange}
                          workTypes={workTypes}
                          workers={workers}
                          allInitiatives={initiatives ?? []}
                          onEdit={() => setEditingId(i.id)}
                          onChanged={() => void load()}
                          onNavigate={(id) => focusOpenId(id)}
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
        <InitiativeEditModal
          initiative={initiatives?.find((i) => i.id === editingId) ?? null}
          statuses={statuses} types={types} subTypes={subTypes}
          shippingTypes={shippingTypes}
          sites={sites} clients={clients} partners={partners}
          isAdmin={isAdmin} canChange={canChange}
          onClose={() => setEditingId(null)}
          onSaved={() => load()}
        />
      )}
      {creating && (
        <InitiativeEditModal
          initiative={null}
          statuses={statuses} types={types} subTypes={subTypes}
          shippingTypes={shippingTypes}
          sites={sites} clients={clients} partners={partners}
          isAdmin={isAdmin} canChange={canChange}
          onClose={() => setCreating(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

/* ── row detail: people, links, notes — association mutations live
      here (the modal owns field edits). ─────────────────────────── */

function InitiativeRowDetail({
  initiative, canEdit, workTypes, workers, allInitiatives,
  onEdit, onChanged, onNavigate,
}: {
  initiative: InitiativeItem;
  canEdit: boolean;
  workTypes: StatusValue[];
  workers: WorkerOption[];
  allInitiatives: InitiativeItem[];
  onEdit: () => void;
  onChanged: () => void;
  onNavigate: (id: string) => void;
}) {
  const [detail, setDetail] = useState<InitiativeDetail | null>(null);
  const [pendingPerson, setPendingPerson] = useState('');
  const [pendingWorkType, setPendingWorkType] = useState('');
  const [pendingChild, setPendingChild] = useState('');
  const [panelError, setPanelError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDetail = () => {
    void getInitiative(initiative.id).then(setDetail).catch(() => {});
  };
  useEffect(loadDetail, [initiative.id]);

  const run = async (op: () => Promise<unknown>) => {
    setBusy(true);
    setPanelError('');
    try {
      await op();
      loadDetail();
      onChanged();
    } catch (err) {
      setPanelError(err instanceof ApiError
        ? (INITIATIVE_ERRORS[err.code] ?? 'Could not save — try again.')
        : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const onPeople = new Set((detail?.people ?? []).map((p) => p.person_id));
  const personOptions = workers
    .filter((w) => !onPeople.has(w.person_id))
    .map((w) => ({ value: w.person_id, label: w.display_name }));
  const linked = new Set([
    initiative.id,
    ...(detail?.links_children ?? []).map((l) => l.other_id),
    ...(detail?.links_parents ?? []).map((l) => l.other_id),
  ]);
  const childOptions = allInitiatives
    .filter((i) => !linked.has(i.id) && !i.archived_at)
    .map((i) => ({ value: i.id, label: i.name, sub: i.type_label }));

  const kv = (label: string, value: string | null | undefined) => (
    <><dt>{label}</dt><dd>{value || '—'}</dd></>
  );

  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Overview</p>
        <dl className="kv">
          {kv('Type', initiative.type_label)}
          {kv('Sub-type', initiative.sub_type_label)}
          {kv('Client', initiative.client_name)}
          {kv('Site', initiative.site_name)}
          {kv('Location', initiative.location)}
          {kv('Scheduled', [initiativeCellText(initiative, 'start'),
                            initiativeCellText(initiative, 'end')]
            .filter((s) => s !== '—').join(' → ') || '—')}
          {initiative.initiative_type === 'project'
            && kv('Sky Command ID', initiative.sky_command_project_id)}
        </dl>
      </div>
      {initiative.initiative_type === 'move' && (
        <div className="detail-block">
          <p className="eyebrow-sm">Move</p>
          <dl className="kv">
            {kv('Origin', initiative.origin_site_name)}
            {kv('Destination', initiative.destination_site_name)}
            {kv('Shipping', initiative.shipping_types.join(', '))}
            {kv('Shipping partner', initiative.shipping_partner_name)}
            {kv('Priority devices',
                initiative.priority_devices == null ? null
                  : initiative.priority_devices ? 'Yes' : 'No')}
          </dl>
        </div>
      )}

      <div className="detail-block" style={{ gridColumn: '1 / -1' }}>
        <p className="eyebrow-sm">People{detail ? ` — ${detail.people.length}` : ''}</p>
        {detail === null && <p className="page-hint">Loading…</p>}
        {detail?.people.length === 0
          && <p className="page-hint">No one assigned yet.</p>}
        {detail && detail.people.length > 0 && (
          <dl className="kv">
            {detail.people.map((p) => (
              <span key={p.id} style={{ display: 'contents' }}>
                <dt>{p.person_name}</dt>
                <dd>
                  {p.work_type_label && p.work_type_color && (
                    <span className="chip custom"
                          style={{ '--chip': p.work_type_color } as CSSProperties}>
                      <span className="dot" />{p.work_type_label}
                    </span>
                  )}
                  {p.rating != null && ` ★${p.rating}`}
                  {canEdit && (
                    <button type="button" className="mini-btn danger"
                            disabled={busy}
                            onClick={() => void run(
                              () => removeInitiativePerson(p.id))}>
                      Remove
                    </button>
                  )}
                </dd>
              </span>
            ))}
          </dl>
        )}
        {canEdit && (
          <div className="pf-form">
            <div><label>Add person</label>
              <select value={pendingPerson} disabled={busy}
                      onChange={(e) => setPendingPerson(e.target.value)}>
                <option value="">Pick a person…</option>
                {personOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select></div>
            <div><label>Work type</label>
              <select value={pendingWorkType} disabled={busy}
                      onChange={(e) => setPendingWorkType(e.target.value)}>
                <option value="">(none)</option>
                {workTypes.map((w) => (
                  <option key={w.key} value={w.key}>{w.label}</option>
                ))}
              </select></div>
            <div><label>&nbsp;</label>
              <button type="button" className="mini-btn"
                      disabled={busy || !pendingPerson}
                      onClick={() => void run(async () => {
                        await addInitiativePerson(initiative.id, {
                          person_id: pendingPerson,
                          work_type: pendingWorkType || null,
                        });
                        setPendingPerson('');
                        setPendingWorkType('');
                      })}>
                Add
              </button></div>
          </div>
        )}
      </div>

      <div className="detail-block" style={{ gridColumn: '1 / -1' }}>
        <p className="eyebrow-sm">Linked initiatives</p>
        {detail === null && <p className="page-hint">Loading…</p>}
        {detail && detail.links_children.length === 0
          && detail.links_parents.length === 0
          && <p className="page-hint">No linked initiatives.</p>}
        {detail && (detail.links_children.length > 0
          || detail.links_parents.length > 0) && (
          <dl className="kv">
            {detail.links_children.map((l) => (
              <span key={l.id} style={{ display: 'contents' }}>
                <dt>Contains</dt>
                <dd>
                  <button type="button" className="mini-btn"
                          onClick={() => onNavigate(l.other_id)}>
                    {l.other_name}
                  </button>
                  <span className="chip custom"
                        style={{ '--chip': l.other_type_color } as CSSProperties}>
                    <span className="dot" />{l.other_type_label}
                  </span>
                  {l.role && ` · ${l.role}`}
                  {canEdit && (
                    <button type="button" className="mini-btn danger"
                            disabled={busy}
                            onClick={() => void run(
                              () => removeInitiativeLink(l.id))}>
                      Unlink
                    </button>
                  )}
                </dd>
              </span>
            ))}
            {detail.links_parents.map((l) => (
              <span key={l.id} style={{ display: 'contents' }}>
                <dt>Part of</dt>
                <dd>
                  <button type="button" className="mini-btn"
                          onClick={() => onNavigate(l.other_id)}>
                    {l.other_name}
                  </button>
                  <span className="chip custom"
                        style={{ '--chip': l.other_type_color } as CSSProperties}>
                    <span className="dot" />{l.other_type_label}
                  </span>
                </dd>
              </span>
            ))}
          </dl>
        )}
        {canEdit && (
          <div className="pf-form">
            <div><label>Link an initiative (as child)</label>
              <select value={pendingChild} disabled={busy}
                      onChange={(e) => setPendingChild(e.target.value)}>
                <option value="">Pick an initiative…</option>
                {childOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label} ({o.sub})</option>
                ))}
              </select></div>
            <div><label>&nbsp;</label>
              <button type="button" className="mini-btn"
                      disabled={busy || !pendingChild}
                      onClick={() => void run(async () => {
                        await addInitiativeLink(initiative.id,
                                                { child_id: pendingChild });
                        setPendingChild('');
                      })}>
                Link
              </button></div>
          </div>
        )}
        {panelError && <span className="pf-error">{panelError}</span>}
      </div>

      <NotesFilesPanel entityType="initiative" entityId={initiative.id}
                       canWrite={canEdit} />
      {canEdit && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <button className="btn-solid" onClick={onEdit}>Edit</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the route, nav, palette, topbar, access map**

`portal/src/App.tsx` — add with the other page imports and routes (mirror the containers route form exactly):

```tsx
import Initiatives from './pages/Initiatives';
```

```tsx
<Route path="/initiatives" element={
  <ProtectedRoute resource="initiatives"><Initiatives /></ProtectedRoute>
} />
```

`portal/src/layout/navSections.tsx` — new section above the Logistics section:

```tsx
  {
    label: 'Initiatives',
    items: [
      {
        to: '/initiatives',
        label: 'Initiatives',
        resource: 'initiatives',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 21V4" />
            <path d="M5 4h13l-3 4 3 4H5" />
          </svg>
        ),
      },
    ],
  },
```

`portal/src/components/CommandPalette.tsx` — into the `pages` list, after the Containers line:

```tsx
      ...navGated('Initiatives', '/initiatives', 'initiatives'),
```

`portal/src/components/Topbar.tsx` — into the `select(hit)` chain, after the `container` branch:

```tsx
    } else if (hit.kind === 'initiative') {
      navigate('/initiatives', { state: { openRow: hit.id } });
```

`portal/src/lib/access.ts` — two entries in `ROUTE_RESOURCE` (the containers one is a pre-existing gap found during exploration):

```typescript
  '/initiatives': 'initiatives',
  '/logistics/containers': 'containers',
```

- [ ] **Step 3: Typecheck and run portal tests**

Run: `cd portal && npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 4: Full-suite verification**

Run: `cd api && .venv/bin/pytest`
Expected: entire API suite passes (not just the new files — the conftest and registry changes touch shared ground).
Run: `cd portal && npx tsc --noEmit && npx vitest run`
Expected: clean.
Then launch both dev servers (docker compose services must be up) and verify in the browser: `/initiatives` renders, create a project / an event / a move (move shows the move section), assign a person, link two initiatives, confirm the cycle guard message, confirm the global search finds an initiative, and confirm the five vocabularies appear on the Variables page.

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/Initiatives.tsx portal/src/App.tsx portal/src/layout/navSections.tsx portal/src/components/CommandPalette.tsx portal/src/components/Topbar.tsx portal/src/lib/access.ts
git commit -m "feat(portal): initiatives page — unified list, people/links panels, nav + search wiring"
```
