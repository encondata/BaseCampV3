# Scan-Matching Worker + Status Rules Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `scan-matching-worker` process that matches `raw_scans` to assets/containers/people, moves them to `processed_scans`, and applies admin-authored status rules; plus the `/admin/status-rules` portal page to manage those rules.

**Architecture:** One worker, two phases per scan in one transaction (match → rules → move). The rules engine is a library (`serversherpa/status_rules/`) with a typed action catalog — no dynamic SQL identifiers. Rules/conditions/actions/executions live in four new tables (migration 0035). The portal page is schema-driven from `GET /status-rules/schema` so UI and engine can never drift.

**Spec:** `docs/superpowers/specs/2026-08-31-scan-matching-status-rules-design.md` — read it before starting any task.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + typer/watchfiles (api), React + hand-rolled CSS + vitest (portal). No new dependencies.

## Global Constraints

- Migration number is **0035** (`down_revision = "0034"`).
- No new pip or npm dependencies.
- **Run all test suites FOREGROUND in one continuous run with timeout 600000ms. Never background a suite.** API suite ≈5 min; use `SS_TEST_DB=serversherpa_test_<branch>` if working in a worktree.
- API tests: `api/.venv/bin/pytest api/tests/<file> -v` from repo root (real Postgres via `docker compose -f docker-compose.dev.yml up -d`; conftest migrates + truncates `serversherpa_test*` only).
- Portal tests: `npm --prefix portal test -- --run <file>`; full check is `npm --prefix portal test -- --run` + `npm --prefix portal run build`.
- Never commit `api/src/serversherpa/_dev_reload.py` — `git checkout -- api/src/serversherpa/_dev_reload.py` before every commit if it churned.
- House comment style: comments state constraints the code can't show; no narration.
- Worker process name is exactly `scan-matching-worker` (heartbeat, db_logging, CLI command).
- Deviation from spec §4, agreed at planning: there is no dev seeding script in V3, so the "2–3 sample dev rules" item is dropped; rules are created through the portal or tests.

## File Structure

| File | Responsibility |
|---|---|
| `api/migrations/versions/0035_status_rules.py` | Create: 4 rule tables, `raw_scans.match_attempted_at`, grants |
| `api/src/serversherpa/db/models.py` | Modify: +`RawScan.match_attempted_at`, +4 ORM models |
| `api/src/serversherpa/access/resources.py` | Modify: +`status_rules` resource |
| `api/src/serversherpa/access/defaults.py` | Modify: +`status_rules` default grants |
| `api/src/serversherpa/scans/__init__.py` | Create: empty package init |
| `api/src/serversherpa/scans/matching.py` | Create: the matching ladder |
| `api/src/serversherpa/scans/worker.py` | Create: poll loop, per-scan transaction, error path |
| `api/src/serversherpa/status_rules/__init__.py` | Create: empty package init |
| `api/src/serversherpa/status_rules/context.py` | Create: `Context` dataclass + dotted-key resolution |
| `api/src/serversherpa/status_rules/catalog.py` | Create: operators, condition-field registry, typed action catalog |
| `api/src/serversherpa/status_rules/engine.py` | Create: rule cache, context building, evaluate + execute + log |
| `api/src/serversherpa/cli.py` | Modify: +`scan-matching-worker` command |
| `Procfile.dev` | Modify: +`scanmatch:` line |
| `api/src/serversherpa/api/schemas.py` | Modify: +status-rule pydantic models |
| `api/src/serversherpa/api/routes/status_rules.py` | Create: CRUD + toggle + schema + executions endpoints |
| `api/src/serversherpa/api/app.py` | Modify: register router |
| `portal/src/lib/api.ts` | Modify: +status-rules client block |
| `portal/src/lib/statusRules.ts` | Create: display helpers |
| `portal/src/pages/StatusRules.tsx` | Create: tabbed page shell |
| `portal/src/components/statusRules/RulesTab.tsx` | Create: rules list |
| `portal/src/components/statusRules/RuleEditorModal.tsx` | Create: schema-driven editor |
| `portal/src/components/statusRules/ExecutionsTab.tsx` | Create: execution log |
| `portal/src/App.tsx`, `portal/src/layout/navSections.tsx`, `portal/src/components/Topbar.tsx`, `portal/src/components/CommandPalette.tsx`, `portal/src/lib/access.ts` | Modify: route registration |

---

### Task 1: Migration 0035, ORM models, access resource

**Files:**
- Create: `api/migrations/versions/0035_status_rules.py`
- Modify: `api/src/serversherpa/db/models.py` (add `match_attempted_at` to `RawScan`; add 4 models after `ProcessedScan`)
- Modify: `api/src/serversherpa/access/resources.py` (add resource after the `scans` entry)
- Modify: `api/src/serversherpa/access/defaults.py` (add to `_ALL`, `admin`, `staff`)
- Test: `api/tests/test_status_rules_models.py`

**Interfaces:**
- Produces ORM models used by every later API task: `StatusRule` (fields `id, name, description, trigger_status, trigger_match_type, priority, enabled, created_by, created_at, updated_at`; relationships `conditions`, `actions` ordered by `position`, cascade `all, delete-orphan`), `StatusRuleCondition` (`id, rule_id, position, field, operator, value`), `StatusRuleAction` (`id, rule_id, position, action_type, params`), `StatusRuleExecution` (`id, rule_id, rule_name, processed_scan_id, conditions_met, actions_applied, error, executed_at, duration_ms`), and `RawScan.match_attempted_at: datetime | None`.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_status_rules_models.py
"""Status-rules storage: migration 0035 tables, relationships, FK
enforcement, cascade behavior, and the raw_scans attempt column."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    RawScan, StatusRule, StatusRuleAction, StatusRuleCondition,
    StatusRuleExecution,
)


def _rule(**over):
    base = dict(name="Into cage", trigger_status="rfid_4_into_cage",
                trigger_match_type="asset", priority=10, enabled=True)
    base.update(over)
    return StatusRule(**base)


async def test_rule_with_children_round_trips(db):
    rule = _rule()
    rule.conditions.append(StatusRuleCondition(
        position=1, field="scan.device_id", operator="equals", value="dock-1"))
    rule.actions.append(StatusRuleAction(
        position=1, action_type="set_asset_status",
        params={"status": "rfid_4_into_cage"}))
    db.add(rule)
    await db.commit()

    got = await db.scalar(select(StatusRule).where(StatusRule.id == rule.id))
    assert got.trigger_status == "rfid_4_into_cage"
    assert got.conditions[0].operator == "equals"
    assert got.actions[0].params == {"status": "rfid_4_into_cage"}


async def test_children_cascade_on_rule_delete(db):
    rule = _rule()
    rule.actions.append(StatusRuleAction(
        position=1, action_type="set_asset_status", params={"status": "unknown"}))
    db.add(rule)
    await db.commit()
    await db.delete(rule)
    await db.commit()
    assert (await db.scalars(select(StatusRuleAction))).all() == []


async def test_trigger_status_fk_rejects_unknown_key(db):
    db.add(_rule(trigger_status="not-a-status"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_execution_survives_rule_delete_with_name(db):
    rule = _rule()
    db.add(rule)
    await db.commit()
    db.add(StatusRuleExecution(
        rule_id=rule.id, rule_name=rule.name, processed_scan_id=None,
        conditions_met=True, actions_applied=[], duration_ms=3))
    await db.commit()
    await db.delete(rule)
    await db.commit()
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.rule_id is None
    assert ex.rule_name == "Into cage"


async def test_raw_scan_match_attempted_at(db):
    scan = RawScan(scanned_value="SN-1", scan_type="rfid",
                   scanned_at=datetime.now(UTC))
    db.add(scan)
    await db.commit()
    assert scan.match_attempted_at is None
    scan.match_attempted_at = datetime.now(UTC)
    await db.commit()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_models.py -v`
Expected: FAIL — `ImportError: cannot import name 'StatusRule'`

- [ ] **Step 3: Write the migration**

```python
# api/migrations/versions/0035_status_rules.py
"""status rules — DB-driven rules the scan-matching worker applies when
a matched scan carries a status checkpoint. Rules trigger on
(trigger_status, trigger_match_type); conditions are AND-only; actions
are keys into the code-side typed catalog (no dynamic identifiers).
Executions are the per-fire log; rule_name is denormalized so history
survives rule deletion. Also adds raw_scans.match_attempted_at — the
worker's unmatched marker (matched rows are deleted, so only unmatched
rows ever show a value).

Revision ID: 0035
Revises: 0034
Create Date: 2026-08-31
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0035"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FULL = ("view", "add", "change", "delete")
# status_rules: Admin-authored automation. Same internal-only posture as
# scans; admins author rules, staff may read them.
RULE_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": ("view",),
}


def upgrade() -> None:
    op.add_column("raw_scans", sa.Column(
        "match_attempted_at", sa.TIMESTAMP(timezone=True),
        comment="last matcher attempt; NULL = never tried"))
    op.create_index("raw_scans_match_attempted_idx", "raw_scans",
                    ["match_attempted_at"])

    op.create_table(
        "status_rules",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("trigger_status", sa.Text, nullable=False),
        sa.Column("trigger_match_type", sa.Text, nullable=False),
        sa.Column("priority", sa.Integer, nullable=False,
                  server_default="10", comment="lower runs first"),
        sa.Column("enabled", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.execute("""
        ALTER TABLE status_rules ADD COLUMN trigger_status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "status_rules_trigger_status_fkey", "status_rules", "status_values",
        ["trigger_status_record_type", "trigger_status"],
        ["record_type", "key"])
    op.execute("""
        ALTER TABLE status_rules ADD COLUMN trigger_match_record_type text
          GENERATED ALWAYS AS ('processed_scan') STORED
    """)
    op.create_foreign_key(
        "status_rules_trigger_match_fkey", "status_rules", "status_values",
        ["trigger_match_record_type", "trigger_match_type"],
        ["record_type", "key"])
    op.create_index("status_rules_trigger_idx", "status_rules",
                    ["trigger_status", "trigger_match_type"])

    op.create_table(
        "status_rule_conditions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("rule_id", UUID(as_uuid=True),
                  sa.ForeignKey("status_rules.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("field", sa.Text, nullable=False,
                  comment="dotted key into the code-side field registry"),
        sa.Column("operator", sa.Text, nullable=False),
        sa.Column("value", sa.Text),
    )
    op.create_index("status_rule_conditions_rule_idx",
                    "status_rule_conditions", ["rule_id"])

    op.create_table(
        "status_rule_actions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("rule_id", UUID(as_uuid=True),
                  sa.ForeignKey("status_rules.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("action_type", sa.Text, nullable=False,
                  comment="key into the code-side typed action catalog"),
        sa.Column("params", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
    )
    op.create_index("status_rule_actions_rule_idx",
                    "status_rule_actions", ["rule_id"])

    op.create_table(
        "status_rule_executions",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("rule_id", UUID(as_uuid=True),
                  sa.ForeignKey("status_rules.id", ondelete="SET NULL")),
        sa.Column("rule_name", sa.Text, nullable=False,
                  comment="denormalized; survives rule deletion"),
        sa.Column("processed_scan_id", UUID(as_uuid=True),
                  sa.ForeignKey("processed_scans.id"),
                  comment="NULL for error rows — the scan txn rolled back"),
        sa.Column("conditions_met", sa.Boolean, nullable=False),
        sa.Column("actions_applied", JSONB, nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("error", sa.Text),
        sa.Column("executed_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("duration_ms", sa.Integer, nullable=False,
                  server_default="0"),
    )
    op.create_index("status_rule_executions_rule_idx",
                    "status_rule_executions", ["rule_id"])
    op.create_index("status_rule_executions_at_idx",
                    "status_rule_executions", [sa.text("executed_at DESC")])

    conn = op.get_bind()
    for role, actions in RULE_GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'status_rules', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'status_rules'"))
    op.drop_table("status_rule_executions")
    op.drop_table("status_rule_actions")
    op.drop_table("status_rule_conditions")
    op.drop_table("status_rules")
    op.drop_index("raw_scans_match_attempted_idx", table_name="raw_scans")
    op.drop_column("raw_scans", "match_attempted_at")
```

- [ ] **Step 4: Add the ORM models**

In `api/src/serversherpa/db/models.py`, add to `RawScan` (after `source`):

```python
    match_attempted_at: Mapped[datetime | None] = mapped_column(
        comment="last matcher attempt; NULL = never tried")
```

After `ProcessedScan`, add (imports `JSONB` and `relationship` already exist in the module — verify and reuse):

```python
class StatusRule(Base):
    """Admin-authored scan automation: when a scan with trigger_status
    matches a trigger_match_type entity, conditions (AND-only) gate the
    typed actions. Evaluated by the scan-matching worker."""

    __tablename__ = "status_rules"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str]
    description: Mapped[str] = mapped_column(server_default="")
    trigger_status: Mapped[str]
    trigger_status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED column; never written
    trigger_match_type: Mapped[str]
    trigger_match_record_type: Mapped[str] = mapped_column(
        server_default=text("'processed_scan'"))  # GENERATED; never written
    priority: Mapped[int] = mapped_column(server_default="10")
    enabled: Mapped[bool] = mapped_column(server_default=text("true"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))

    conditions: Mapped[list["StatusRuleCondition"]] = relationship(
        cascade="all, delete-orphan",
        order_by="StatusRuleCondition.position")
    actions: Mapped[list["StatusRuleAction"]] = relationship(
        cascade="all, delete-orphan", order_by="StatusRuleAction.position")


class StatusRuleCondition(Base):
    __tablename__ = "status_rule_conditions"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    rule_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("status_rules.id", ondelete="CASCADE"))
    position: Mapped[int]
    field: Mapped[str]
    operator: Mapped[str]
    value: Mapped[str | None]


class StatusRuleAction(Base):
    __tablename__ = "status_rule_actions"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    rule_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("status_rules.id", ondelete="CASCADE"))
    position: Mapped[int]
    action_type: Mapped[str]
    params: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))


class StatusRuleExecution(Base):
    """One row per rule fire (or per failed scan — then processed_scan_id
    is NULL and error is set; the scan txn rolled back)."""

    __tablename__ = "status_rule_executions"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    rule_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("status_rules.id", ondelete="SET NULL"))
    rule_name: Mapped[str]
    processed_scan_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("processed_scans.id"))
    conditions_met: Mapped[bool]
    actions_applied: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb"))
    error: Mapped[str | None]
    executed_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    duration_ms: Mapped[int] = mapped_column(server_default="0")
```

If `relationship` is not yet imported in models.py, add it to the existing `sqlalchemy.orm` import line.

- [ ] **Step 5: Register the access resource**

In `api/src/serversherpa/access/resources.py`, after the `scans` entry:

```python
    Resource("status_rules", "Status rules", routes=("/admin/status-rules",),
             # internal-only Admin automation surface, same posture as scans.
             visible_to=frozenset({"global"})),
```

In `api/src/serversherpa/access/defaults.py`: append `"status_rules"` to `_ALL`; add `"status_rules": FULL,` to the `admin` dict and `"status_rules": ("view",),` to the `staff` dict.

- [ ] **Step 6: Run tests to verify they pass**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_models.py -v`
Expected: 5 PASS (conftest auto-migrates the test DB to the new head).

Also run: `api/.venv/bin/pytest api/tests/test_access_api.py api/tests/test_migrations.py -v 2>/dev/null || true` — if either file exists, it must pass (resource registries are asserted there).

- [ ] **Step 7: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/migrations/versions/0035_status_rules.py api/src/serversherpa/db/models.py api/src/serversherpa/access/resources.py api/src/serversherpa/access/defaults.py api/tests/test_status_rules_models.py
git commit -m "feat(api): status-rules storage — migration 0035, models, access resource"
```

---

### Task 2: Matching ladder

**Files:**
- Create: `api/src/serversherpa/scans/__init__.py` (empty)
- Create: `api/src/serversherpa/scans/matching.py`
- Test: `api/tests/test_scan_matching.py`

**Interfaces:**
- Produces: `Match` frozen dataclass (`match_type: str` in `{"asset","container","person"}`, `target_id: uuid.UUID`) and `async def match_scan(db: AsyncSession, scanned_value: str) -> Match | None`. Task 5's worker consumes exactly this.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_scan_matching.py
"""Matching ladder: ID (uuid / legacy) → RFID → serial → name.
Multiple hits at a tier = ambiguous → None (stop, don't fall through).
Archived entities never match."""

from datetime import UTC, datetime

from serversherpa.db.models import Asset, AssetModel, Container, Person
from serversherpa.scans.matching import Match, match_scan


async def _asset(db, **over):
    a = Asset(**over)
    db.add(a)
    await db.flush()
    return a


async def test_uuid_matches_asset_id(db):
    a = await _asset(db, serial_number="SN-1")
    got = await match_scan(db, str(a.id))
    assert got == Match("asset", a.id)


async def test_legacy_id_matches_numeric_value(db):
    a = await _asset(db, legacy_id=4471)
    assert await match_scan(db, "4471") == Match("asset", a.id)


async def test_rfid_matches_across_tables_in_order(db):
    c = Container(name="Crate 9", rfid_tag="E280AAA")
    db.add(c)
    p = Person(first_name="Badge", last_name="Holder", rfid_tag="E280BBB")
    db.add(p)
    await db.flush()
    assert await match_scan(db, "e280aaa") == Match("container", c.id)
    assert await match_scan(db, "E280BBB") == Match("person", p.id)


async def test_rfid_beats_serial(db):
    by_serial = await _asset(db, serial_number="COLLIDE")
    by_rfid = await _asset(db, rfid_tag="COLLIDE")
    assert await match_scan(db, "COLLIDE") == Match("asset", by_rfid.id)


async def test_serial_single_hit_matches(db):
    a = await _asset(db, serial_number="SN-77")
    assert await match_scan(db, "sn-77") == Match("asset", a.id)


async def test_duplicate_serial_is_ambiguous_not_name_fallthrough(db):
    await _asset(db, serial_number="DUPE")
    await _asset(db, serial_number="DUPE")
    # a name row that WOULD match must not be reached — ambiguity stops
    await _asset(db, name="DUPE")
    assert await match_scan(db, "DUPE") is None


async def test_name_fallback_single_hit(db):
    a = await _asset(db, name="Rack 12 switch")
    assert await match_scan(db, "Rack 12 switch") == Match("asset", a.id)


async def test_archived_entities_never_match(db):
    await _asset(db, serial_number="GONE", archived_at=datetime.now(UTC))
    assert await match_scan(db, "GONE") is None


async def test_no_match_returns_none(db):
    assert await match_scan(db, "definitely-not-here") is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `api/.venv/bin/pytest api/tests/test_scan_matching.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'serversherpa.scans'`

- [ ] **Step 3: Implement**

Create empty `api/src/serversherpa/scans/__init__.py`, then:

```python
# api/src/serversherpa/scans/matching.py
"""Entity matching for the scan-matching worker. Ladder: ID (uuid or
legacy numeric) → RFID tag → asset serial → name. Within a tier, tables
are tried in asset → container → person order; the first table with
hits decides. Multiple hits anywhere = ambiguous — the ladder STOPS and
returns None (the value clearly refers to something; guessing or
falling through would mis-attribute the scan). Archived entities are
excluded everywhere. All identifier columns are CITEXT, so equality is
case-insensitive for free."""

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, Container, Person


@dataclass(frozen=True)
class Match:
    match_type: str          # 'asset' | 'container' | 'person'
    target_id: uuid.UUID


def _as_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value.strip())
    except (ValueError, AttributeError):
        return None


def _as_int(value: str) -> int | None:
    try:
        return int(value.strip())
    except (ValueError, AttributeError):
        return None


async def _hits(db: AsyncSession, model, column, value) -> list[uuid.UUID]:
    """Up to 2 unarchived ids — enough to tell unique from ambiguous."""
    return (await db.scalars(
        select(model.id).where(column == value,
                               model.archived_at.is_(None)).limit(2))).all()


# (match_type, model, tag column) in ladder order for the RFID tier.
_RFID_TIER = (("asset", Asset, Asset.rfid_tag),
              ("container", Container, Container.rfid_tag),
              ("person", Person, Person.rfid_tag))
_NAME_TIER = (("asset", Asset, Asset.name),
              ("container", Container, Container.name))


async def match_scan(db: AsyncSession, scanned_value: str) -> Match | None:
    # Tier 1: ID — uuid PKs, then V2 numeric asset labels.
    uid = _as_uuid(scanned_value)
    if uid is not None:
        for match_type, model in (("asset", Asset), ("container", Container),
                                  ("person", Person)):
            ids = await _hits(db, model, model.id, uid)
            if ids:
                return Match(match_type, ids[0])
    legacy = _as_int(scanned_value)
    if legacy is not None:
        ids = await _hits(db, Asset, Asset.legacy_id, legacy)
        if len(ids) == 1:
            return Match("asset", ids[0])
        if ids:
            return None                      # ambiguous — stop the ladder

    # Tier 2: RFID (partial-unique per table — first table with a hit wins).
    for match_type, model, column in _RFID_TIER:
        ids = await _hits(db, model, column, scanned_value)
        if len(ids) == 1:
            return Match(match_type, ids[0])
        if ids:
            return None

    # Tier 3: asset serial (deliberately non-unique — dupes are ambiguous).
    ids = await _hits(db, Asset, Asset.serial_number, scanned_value)
    if len(ids) == 1:
        return Match("asset", ids[0])
    if ids:
        return None

    # Tier 4: name fallback. No people-by-name — badges are RFID-only.
    for match_type, model, column in _NAME_TIER:
        ids = await _hits(db, model, column, scanned_value)
        if len(ids) == 1:
            return Match(match_type, ids[0])
        if ids:
            return None
    return None
```

Note: `Asset()` with no `model_id` must be insertable for the tests — check the `assets` table: `model_id` is nullable (`db/models.py:556` region), so bare `Asset(serial_number=...)` works. If a test fails on a NOT NULL, create a minimal `AssetModel` in the helper instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `api/.venv/bin/pytest api/tests/test_scan_matching.py -v`
Expected: 9 PASS

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/scans api/tests/test_scan_matching.py
git commit -m "feat(api): scan matching ladder — id/rfid/serial/name, ambiguity stops"
```

---

### Task 3: Rules catalog — context, operators, condition fields, typed actions

**Files:**
- Create: `api/src/serversherpa/status_rules/__init__.py` (empty)
- Create: `api/src/serversherpa/status_rules/context.py`
- Create: `api/src/serversherpa/status_rules/catalog.py`
- Test: `api/tests/test_status_rules_catalog.py`

**Interfaces:**
- Produces (consumed by Tasks 4, 7, 8):
  - `Context` dataclass: fields `scan, asset, container, person, initiative_asset, initiative` (entity ORM objects or None); method `get(dotted: str) -> Any` (None when the entity is absent).
  - `OPERATORS: dict[str, Callable[[Any, str | None], bool]]` — keys exactly `equals, not_equals, contains, is_null, is_not_null, greater_than, greater_or_equal, less_than, less_or_equal`.
  - `evaluate_condition(field_value, operator: str, value: str | None) -> bool`.
  - `CONDITION_FIELDS: dict[str, ConditionField]` — `ConditionField(key, label, type, options_source)` with `type` in `{"text","status","site","bool","number","uuid"}`.
  - `ACTIONS: dict[str, ActionDef]` — `ActionDef(key, label, params: tuple[ParamField, ...], apply)`; `ParamField(name, type, options)` with `type` in `{"status","choice","bool"}`; `apply(db, ctx, params) -> ActionOutcome`; `ActionOutcome(applied: bool, reason: str | None)`.
  - `validate_condition(field, operator, value) -> str | None` and `validate_action(action_type, params) -> str | None` (error-code string or None).

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_status_rules_catalog.py
"""Catalog semantics: operator truth table, dotted context lookup,
structural validation, and every typed action's apply() including the
missing-context skip path."""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Asset, Container, Initiative, InitiativeAsset, Person, ProcessedScan,
)
from serversherpa.status_rules.catalog import (
    ACTIONS, CONDITION_FIELDS, OPERATORS, evaluate_condition,
    validate_action, validate_condition,
)
from serversherpa.status_rules.context import Context


def test_operator_truth_table():
    assert evaluate_condition("Dock-1", "equals", "dock-1") is True
    assert evaluate_condition(None, "equals", "x") is False
    assert evaluate_condition("a", "not_equals", "b") is True
    assert evaluate_condition("warehouse-7", "contains", "HOUSE") is True
    assert evaluate_condition(None, "is_null", None) is True
    assert evaluate_condition("", "is_null", None) is True
    assert evaluate_condition("x", "is_not_null", None) is True
    assert evaluate_condition("5", "greater_than", "3") is True
    assert evaluate_condition("abc", "greater_than", "3") is False
    assert evaluate_condition("3", "less_or_equal", "3") is True


def test_context_get_missing_entity_is_none():
    ctx = Context(scan=None)
    assert ctx.get("asset.status") is None


def test_validate_condition_rejects_unknown_field_and_operator():
    assert validate_condition("nope.nope", "equals", "x") == "unknown_field"
    assert validate_condition("scan.device_id", "regex", "x") == "unknown_operator"
    assert validate_condition("scan.device_id", "equals", "x") is None


def test_validate_action_rejects_bad_params():
    assert validate_action("no_such_action", {}) == "unknown_action"
    assert validate_action("set_asset_status", {}) == "missing_param"
    assert validate_action("set_initiative_asset_verified",
                           {"side": "sideways", "value": True}) == "bad_param"
    assert validate_action("set_asset_status",
                           {"status": "rfid_4_into_cage"}) is None


async def _scan(db, *, asset=None, container=None, person=None,
                site_id=None, location_detail="", status="rfid_4_into_cage"):
    match_type = ("asset" if asset else
                  "container" if container else "person")
    s = ProcessedScan(
        scanned_value="V", scan_type="rfid", status=status,
        scanned_at=datetime.now(UTC), processed_at=datetime.now(UTC),
        site_id=site_id, location_detail=location_detail,
        match_type=match_type,
        asset_id=asset.id if asset else None,
        container_id=container.id if container else None,
        person_id=person.id if person else None)
    db.add(s)
    await db.flush()
    return s


async def test_set_asset_status_applies(db):
    a = Asset(status="unknown")
    db.add(a)
    await db.flush()
    scan = await _scan(db, asset=a)
    ctx = Context(scan=scan, asset=a)
    out = await ACTIONS["set_asset_status"].apply(
        db, ctx, {"status": "rfid_4_into_cage"})
    assert out.applied is True
    assert a.status == "rfid_4_into_cage"


async def test_initiative_action_skips_without_context(db):
    a = Asset()
    db.add(a)
    await db.flush()
    scan = await _scan(db, asset=a)
    ctx = Context(scan=scan, asset=a)          # no active initiative
    out = await ACTIONS["set_initiative_asset_status"].apply(
        db, ctx, {"status": "rfid_4_into_cage"})
    assert out.applied is False
    assert out.reason == "no_active_initiative"


async def test_set_asset_location_from_initiative_composes_rack_ru(db):
    a = Asset()
    db.add(a)
    init = Initiative(name="Move", initiative_type="move",
                      status="in_progress")
    db.add(init)
    await db.flush()
    ia = InitiativeAsset(initiative_id=init.id, asset_id=a.id,
                         destination_rack="R12",
                         destination_ru=Decimal("42.0"))
    db.add(ia)
    await db.flush()
    scan = await _scan(db, asset=a)
    ctx = Context(scan=scan, asset=a, initiative_asset=ia, initiative=init)
    out = await ACTIONS["set_asset_location_from_initiative"].apply(
        db, ctx, {"side": "destination"})
    assert out.applied is True
    assert a.location_detail == "R12 RU42"


async def test_touch_container_audit(db):
    c = Container(name="Crate")
    p = Person(first_name="Op", last_name="Erator")
    db.add_all([c, p])
    await db.flush()
    scan = await _scan(db, container=c)
    scan.operator_id = p.id
    ctx = Context(scan=scan, container=c)
    out = await ACTIONS["touch_container_audit"].apply(db, ctx, {})
    assert out.applied is True
    assert c.last_audit_at == scan.scanned_at
    assert c.audit_by == p.id
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_catalog.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'serversherpa.status_rules'`

- [ ] **Step 3: Implement context.py**

Create empty `api/src/serversherpa/status_rules/__init__.py`, then:

```python
# api/src/serversherpa/status_rules/context.py
"""Evaluation context for one processed scan: the scan row plus the
matched entity and (asset matches only) the active-initiative pair.
Dotted keys resolve leniently — a missing entity yields None so
conditions on absent context evaluate per-operator instead of raising."""

from dataclasses import dataclass
from typing import Any


@dataclass
class Context:
    scan: Any
    asset: Any = None
    container: Any = None
    person: Any = None
    initiative_asset: Any = None
    initiative: Any = None

    def get(self, dotted: str) -> Any:
        entity_key, _, attr = dotted.partition(".")
        entity = getattr(self, entity_key, None)
        if entity is None or not attr:
            return None
        return getattr(entity, attr, None)
```

- [ ] **Step 4: Implement catalog.py**

```python
# api/src/serversherpa/status_rules/catalog.py
"""The single source of truth for rule semantics: operators, the
condition-field registry, and the typed action catalog. The API's
/status-rules/schema serializes THIS module; the portal renders that
payload — nothing else may define operators, fields, or actions.

Actions are real Python with validated params — never dynamic
table/field identifiers (V2's injection surface). apply() mutates ORM
objects already in the caller's session and never commits; an action
whose required context is missing returns applied=False with a reason
instead of failing the scan."""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.status_rules.context import Context

# ── operators ────────────────────────────────────────────────────────


def _num(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _cmp(op: Callable[[float, float], bool]):
    def check(f: Any, v: str | None) -> bool:
        fn, vn = _num(f), _num(v)
        return fn is not None and vn is not None and op(fn, vn)
    return check


OPERATORS: dict[str, Callable[[Any, str | None], bool]] = {
    "equals": lambda f, v: (f is not None and v is not None
                            and str(f).lower() == str(v).lower()),
    "not_equals": lambda f, v: (v is not None
                                and (f is None
                                     or str(f).lower() != str(v).lower())),
    "contains": lambda f, v: (f is not None and v is not None
                              and str(v).lower() in str(f).lower()),
    "is_null": lambda f, v: f is None or f == "",
    "is_not_null": lambda f, v: f is not None and f != "",
    "greater_than": _cmp(lambda a, b: a > b),
    "greater_or_equal": _cmp(lambda a, b: a >= b),
    "less_than": _cmp(lambda a, b: a < b),
    "less_or_equal": _cmp(lambda a, b: a <= b),
}

_NO_VALUE_OPERATORS = {"is_null", "is_not_null"}


def evaluate_condition(field_value: Any, operator: str,
                       value: str | None) -> bool:
    check = OPERATORS.get(operator)
    return bool(check and check(field_value, value))


# ── condition fields ─────────────────────────────────────────────────


@dataclass(frozen=True)
class ConditionField:
    key: str
    label: str
    type: str                       # text | status | site | bool | number | uuid
    options_source: str | None = None   # 'status:<record_type>' | 'sites'


_FIELDS = [
    ConditionField("scan.scan_type", "Scan type", "status",
                   "status:scan"),
    ConditionField("scan.device_id", "Scan device", "text"),
    ConditionField("scan.site_id", "Scan site", "site", "sites"),
    ConditionField("scan.source", "Scan source", "text"),
    ConditionField("scan.operator_id", "Scan operator", "uuid"),
    ConditionField("asset.status", "Asset status", "status", "status:asset"),
    ConditionField("asset.site_id", "Asset site", "site", "sites"),
    ConditionField("asset.client_id", "Asset client", "uuid"),
    ConditionField("asset.has_rails", "Asset has rails", "bool"),
    ConditionField("container.status", "Container status", "status",
                   "status:container"),
    ConditionField("container.site_id", "Container site", "site", "sites"),
    ConditionField("person.id", "Matched person", "uuid"),
    ConditionField("initiative.initiative_type", "Initiative type", "status",
                   "status:initiative_type"),
    ConditionField("initiative.sub_type", "Initiative sub-type", "status",
                   "status:initiative_sub_type"),
    ConditionField("initiative.status", "Initiative status", "status",
                   "status:initiative"),
    ConditionField("initiative_asset.status", "Roster asset status", "status",
                   "status:asset"),
    ConditionField("initiative_asset.disposition", "Roster disposition",
                   "text"),
    ConditionField("initiative_asset.priority_wave", "Priority wave", "text"),
]
CONDITION_FIELDS: dict[str, ConditionField] = {f.key: f for f in _FIELDS}


def validate_condition(field_key: str, operator: str,
                       value: str | None) -> str | None:
    if field_key not in CONDITION_FIELDS:
        return "unknown_field"
    if operator not in OPERATORS:
        return "unknown_operator"
    if operator not in _NO_VALUE_OPERATORS and (value is None or value == ""):
        return "missing_value"
    return None


# ── typed actions ────────────────────────────────────────────────────


@dataclass(frozen=True)
class ActionOutcome:
    applied: bool
    reason: str | None = None


@dataclass(frozen=True)
class ParamField:
    name: str
    type: str                        # status | choice | bool
    options: tuple[str, ...] = ()    # for choice
    options_source: str | None = None  # for status params: 'status:<type>'


ApplyFn = Callable[[AsyncSession, Context, dict], Awaitable[ActionOutcome]]


@dataclass(frozen=True)
class ActionDef:
    key: str
    label: str
    params: tuple[ParamField, ...]
    apply: ApplyFn


_SKIP = ActionOutcome(applied=False)


def _touch(entity) -> None:
    entity.updated_at = datetime.now(UTC)


def _ru_str(ru: Decimal | None) -> str | None:
    if ru is None:
        return None
    text = format(ru.normalize(), "f")
    return f"RU{text.removesuffix('.0')}" if text.endswith(".0") else f"RU{text}"


async def _set_asset_status(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    ctx.asset.status = params["status"]
    _touch(ctx.asset)
    return ActionOutcome(True)


async def _set_initiative_asset_status(db, ctx, params) -> ActionOutcome:
    if ctx.initiative_asset is None:
        return ActionOutcome(False, "no_active_initiative")
    ctx.initiative_asset.status = params["status"]
    _touch(ctx.initiative_asset)
    return ActionOutcome(True)


async def _set_container_status(db, ctx, params) -> ActionOutcome:
    if ctx.container is None:
        return ActionOutcome(False, "no_container")
    ctx.container.status = params["status"]
    _touch(ctx.container)
    return ActionOutcome(True)


async def _set_asset_location_from_scan(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    ctx.asset.site_id = ctx.scan.site_id
    ctx.asset.location_detail = ctx.scan.location_detail
    _touch(ctx.asset)
    return ActionOutcome(True)


async def _set_asset_location_from_initiative(db, ctx, params) -> ActionOutcome:
    if ctx.asset is None:
        return ActionOutcome(False, "no_asset")
    if ctx.initiative_asset is None or ctx.initiative is None:
        return ActionOutcome(False, "no_active_initiative")
    side = params["side"]
    rack = getattr(ctx.initiative_asset, f"{side}_rack")
    ru = _ru_str(getattr(ctx.initiative_asset, f"{side}_ru"))
    parts = [p for p in (rack, ru) if p]
    if not parts:
        return ActionOutcome(False, "no_location_on_roster")
    ctx.asset.location_detail = " ".join(parts)
    site_attr = ("origin_site_id" if side == "source"
                 else "destination_site_id")
    site = getattr(ctx.initiative, site_attr)
    if site is not None:
        ctx.asset.site_id = site
    _touch(ctx.asset)
    return ActionOutcome(True)


async def _set_initiative_asset_verified(db, ctx, params) -> ActionOutcome:
    if ctx.initiative_asset is None:
        return ActionOutcome(False, "no_active_initiative")
    setattr(ctx.initiative_asset, f"{params['side']}_verified",
            bool(params["value"]))
    _touch(ctx.initiative_asset)
    return ActionOutcome(True)


async def _touch_container_audit(db, ctx, params) -> ActionOutcome:
    if ctx.container is None:
        return ActionOutcome(False, "no_container")
    ctx.container.last_audit_at = ctx.scan.scanned_at
    ctx.container.audit_by = ctx.scan.operator_id
    _touch(ctx.container)
    return ActionOutcome(True)


_SIDE = ParamField("side", "choice", options=("source", "destination"))
_ACTION_LIST = [
    ActionDef("set_asset_status", "Set asset status",
              (ParamField("status", "status", options_source="status:asset"),),
              _set_asset_status),
    ActionDef("set_initiative_asset_status", "Set roster asset status",
              (ParamField("status", "status", options_source="status:asset"),),
              _set_initiative_asset_status),
    ActionDef("set_container_status", "Set container status",
              (ParamField("status", "status",
                          options_source="status:container"),),
              _set_container_status),
    ActionDef("set_asset_location_from_scan",
              "Set asset location from the scan", (),
              _set_asset_location_from_scan),
    ActionDef("set_asset_location_from_initiative",
              "Set asset location from the initiative roster", (_SIDE,),
              _set_asset_location_from_initiative),
    ActionDef("set_initiative_asset_verified", "Mark roster side verified",
              (_SIDE, ParamField("value", "bool")),
              _set_initiative_asset_verified),
    ActionDef("touch_container_audit", "Record container audit touch", (),
              _touch_container_audit),
]
ACTIONS: dict[str, ActionDef] = {a.key: a for a in _ACTION_LIST}


def validate_action(action_type: str, params: dict) -> str | None:
    action = ACTIONS.get(action_type)
    if action is None:
        return "unknown_action"
    for p in action.params:
        if p.name not in params:
            return "missing_param"
        if p.type == "choice" and params[p.name] not in p.options:
            return "bad_param"
        if p.type == "bool" and not isinstance(params[p.name], bool):
            return "bad_param"
        if p.type == "status" and not isinstance(params[p.name], str):
            return "bad_param"
    extra = set(params) - {p.name for p in action.params}
    return "bad_param" if extra else None
```

Note: status-param *keys* are validated against the vocabulary in the route layer (Task 7, which has request-scoped DB access); at execution time the composite FK on the target column enforces them (bad key → IntegrityError → the worker's error path).

- [ ] **Step 5: Run tests to verify they pass**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_catalog.py -v`
Expected: 9 PASS. If `Initiative(...)` fails a NOT NULL, check `0016_initiatives.py` for required columns and extend the test's constructor minimally (`initiative_type="move"` should satisfy the vocab FK — verify the key exists in that migration's seeds).

- [ ] **Step 6: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/status_rules api/tests/test_status_rules_catalog.py
git commit -m "feat(api): status-rules catalog — operators, field registry, typed actions"
```

---

### Task 4: Rules engine — cache, context building, apply_rules

**Files:**
- Create: `api/src/serversherpa/status_rules/engine.py`
- Test: `api/tests/test_status_rules_engine.py`

**Interfaces:**
- Consumes: Task 3's `Context`, `evaluate_condition`, `ACTIONS`; Task 1's models.
- Produces (consumed by Task 5): `async def apply_rules(db: AsyncSession, scan: ProcessedScan) -> int` (returns count of rules whose trigger matched; adds `StatusRuleExecution` rows to the session; raises `RuleExecutionError` on real action failure), `class RuleExecutionError(Exception)` with attributes `rule_id`, `rule_name`; `def invalidate_cache() -> None`; `RULE_CACHE_SECONDS = 60`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_status_rules_engine.py
"""Engine orchestration: trigger selection, priority order, AND
conditions, execution logging (met and not-met), per-action skips,
NULL-status short-circuit, active-initiative resolution, cache TTL,
and RuleExecutionError wrapping."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Asset, Initiative, InitiativeAsset, ProcessedScan, StatusRule,
    StatusRuleAction, StatusRuleCondition, StatusRuleExecution,
)
from serversherpa.status_rules import engine
from serversherpa.status_rules.engine import (
    RuleExecutionError, apply_rules, invalidate_cache,
)


@pytest.fixture(autouse=True)
def _fresh_cache():
    invalidate_cache()
    yield
    invalidate_cache()


def _rule(name, *, status="rfid_4_into_cage", match="asset", priority=10,
          enabled=True, actions=(), conditions=()):
    r = StatusRule(name=name, trigger_status=status,
                   trigger_match_type=match, priority=priority,
                   enabled=enabled)
    for i, (atype, params) in enumerate(actions, 1):
        r.actions.append(StatusRuleAction(position=i, action_type=atype,
                                          params=params))
    for i, (f, op, v) in enumerate(conditions, 1):
        r.conditions.append(StatusRuleCondition(position=i, field=f,
                                                operator=op, value=v))
    return r


async def _asset_scan(db, asset, *, status="rfid_4_into_cage",
                      device="dock-1"):
    s = ProcessedScan(scanned_value="V", scan_type="rfid", status=status,
                      scanned_at=datetime.now(UTC),
                      processed_at=datetime.now(UTC), device_id=device,
                      match_type="asset", asset_id=asset.id)
    db.add(s)
    await db.flush()
    return s


async def test_matching_rule_fires_and_logs(db):
    a = Asset(status="unknown")
    db.add(a)
    db.add(_rule("Cage", actions=(
        ("set_asset_status", {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)

    n = await apply_rules(db, scan)
    await db.commit()

    assert n == 1
    assert a.status == "rfid_4_into_cage"
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.conditions_met is True
    assert ex.processed_scan_id == scan.id
    assert ex.actions_applied == [
        {"action_type": "set_asset_status", "applied": True}]


async def test_null_status_and_wrong_trigger_skip_engine(db):
    a = Asset()
    db.add(a)
    db.add(_rule("Cage", actions=(
        ("set_asset_status", {"status": "rfid_4_into_cage"}),)))
    db.add(_rule("Other status", status="rfid_1_cage_exit", actions=(
        ("set_asset_status", {"status": "rfid_1_cage_exit"}),)))
    db.add(_rule("Container trigger", match="container", actions=(
        ("set_container_status", {"status": "available"}),)))
    await db.flush()
    bare = await _asset_scan(db, a, status=None)
    assert await apply_rules(db, bare) == 0

    scan = await _asset_scan(db, a)
    invalidate_cache()
    assert await apply_rules(db, scan) == 1     # only "Cage"


async def test_disabled_rule_does_not_fire(db):
    a = Asset()
    db.add(a)
    db.add(_rule("Off", enabled=False, actions=(
        ("set_asset_status", {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 0


async def test_priority_orders_execution(db):
    a = Asset(status="unknown")
    db.add(a)
    db.add(_rule("Second", priority=20, actions=(
        ("set_asset_status", {"status": "rfid_10_dock_to_truck"}),)))
    db.add(_rule("First", priority=5, actions=(
        ("set_asset_status", {"status": "rfid_1_cage_exit"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 2
    assert a.status == "rfid_10_dock_to_truck"   # later priority wins last write


async def test_failed_condition_logs_but_skips_actions(db):
    a = Asset(status="unknown")
    db.add(a)
    db.add(_rule("Gated", conditions=(("scan.device_id", "equals", "dock-9"),),
                 actions=(("set_asset_status",
                           {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    scan = await _asset_scan(db, a, device="dock-1")
    assert await apply_rules(db, scan) == 1
    assert a.status == "unknown"
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.conditions_met is False
    assert ex.actions_applied == []


async def test_active_initiative_resolved_for_asset_match(db):
    a = Asset()
    db.add(a)
    live = Initiative(name="Live", initiative_type="move",
                      status="in_progress",
                      scheduled_start=datetime.now(UTC))
    stale = Initiative(name="Planned", initiative_type="move",
                       status="planned")
    db.add_all([live, stale])
    await db.flush()
    db.add(InitiativeAsset(initiative_id=live.id, asset_id=a.id,
                           status="loaded_in_system"))
    db.add(InitiativeAsset(initiative_id=stale.id, asset_id=a.id,
                           status="loaded_in_system"))
    db.add(_rule("Roster", actions=(
        ("set_initiative_asset_status", {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 1
    rows = (await db.scalars(select(InitiativeAsset).where(
        InitiativeAsset.initiative_id == live.id))).one()
    assert rows.status == "rfid_4_into_cage"


async def test_missing_context_action_is_recorded_skip(db):
    a = Asset()
    db.add(a)
    db.add(_rule("Roster only", actions=(
        ("set_initiative_asset_status", {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 1
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.actions_applied == [
        {"action_type": "set_initiative_asset_status", "applied": False,
         "reason": "no_active_initiative"}]


async def test_action_error_raises_rule_execution_error(db):
    a = Asset()
    db.add(a)
    db.add(_rule("Boom", actions=(
        ("set_asset_status", {"status": "not-a-real-status-key"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    with pytest.raises(RuleExecutionError) as err:
        await apply_rules(db, scan)
        await db.commit()     # FK fires at flush inside apply_rules or here
    assert err.value.rule_name == "Boom"


async def test_cache_serves_stale_until_ttl(db, monkeypatch):
    a = Asset()
    db.add(a)
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 0     # cache now holds "no rules"

    db.add(_rule("New", actions=(
        ("set_asset_status", {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    assert await apply_rules(db, scan) == 0     # still cached

    monkeypatch.setattr(engine, "RULE_CACHE_SECONDS", 0)
    assert await apply_rules(db, scan) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_engine.py -v`
Expected: FAIL — `ModuleNotFoundError` / `ImportError` on `engine`

- [ ] **Step 3: Implement**

```python
# api/src/serversherpa/status_rules/engine.py
"""Rule evaluation for one processed scan, inside the worker's scan
transaction. All enabled rules for (scan.status, match_type) run in
priority order — no first-match-wins (V2 semantics). Every triggered
rule adds one StatusRuleExecution row to the SESSION (never commits);
a real action failure raises RuleExecutionError so the worker can roll
back the whole scan and log an error execution afterward.

The rule cache is per-process with a 60s TTL — API writes land within
one TTL without any cross-process signal (same posture as V2)."""

import logging
import time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from serversherpa.db.models import (
    Asset, Container, Initiative, InitiativeAsset, Person, ProcessedScan,
    StatusRule, StatusRuleExecution,
)
from serversherpa.status_rules.catalog import ACTIONS, evaluate_condition
from serversherpa.status_rules.context import Context

logger = logging.getLogger("serversherpa.status_rules.engine")
RULE_CACHE_SECONDS = 60

# (trigger_status, match_type) -> (loaded_monotonic, [rule snapshot dicts])
_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}


class RuleExecutionError(Exception):
    def __init__(self, rule_id, rule_name: str, cause: Exception):
        super().__init__(f"rule '{rule_name}' failed: {cause}")
        self.rule_id = rule_id
        self.rule_name = rule_name


def invalidate_cache() -> None:
    _cache.clear()


async def _load_rules(db: AsyncSession, trigger_status: str,
                      match_type: str) -> list[dict]:
    key = (trigger_status, match_type)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < RULE_CACHE_SECONDS:
        return hit[1]
    rows = (await db.scalars(
        select(StatusRule)
        .options(selectinload(StatusRule.conditions),
                 selectinload(StatusRule.actions))
        .where(StatusRule.trigger_status == trigger_status,
               StatusRule.trigger_match_type == match_type,
               StatusRule.enabled.is_(True))
        .order_by(StatusRule.priority, StatusRule.id))).all()
    # Snapshot to plain dicts — cached entries outlive their session.
    rules = [{
        "id": r.id, "name": r.name,
        "conditions": [(c.field, c.operator, c.value) for c in r.conditions],
        "actions": [(a.action_type, a.params) for a in r.actions],
    } for r in rows]
    _cache[key] = (time.monotonic(), rules)
    return rules


async def _build_context(db: AsyncSession, scan: ProcessedScan) -> Context:
    ctx = Context(scan=scan)
    if scan.match_type == "asset":
        ctx.asset = await db.get(Asset, scan.asset_id)
        pair = (await db.execute(
            select(InitiativeAsset, Initiative)
            .join(Initiative,
                  InitiativeAsset.initiative_id == Initiative.id)
            .where(InitiativeAsset.asset_id == scan.asset_id,
                   Initiative.status == "in_progress",
                   Initiative.archived_at.is_(None))
            .order_by(func.abs(func.extract(
                "epoch",
                Initiative.scheduled_start - func.now())).nulls_last())
            .limit(1))).first()
        if pair is not None:
            ctx.initiative_asset, ctx.initiative = pair
    elif scan.match_type == "container":
        ctx.container = await db.get(Container, scan.container_id)
    elif scan.match_type == "person":
        ctx.person = await db.get(Person, scan.person_id)
    return ctx


async def apply_rules(db: AsyncSession, scan: ProcessedScan) -> int:
    if scan.status is None:
        return 0
    rules = await _load_rules(db, scan.status, scan.match_type)
    if not rules:
        return 0
    ctx = await _build_context(db, scan)
    for rule in rules:
        started = time.monotonic()
        met = all(evaluate_condition(ctx.get(f), op, v)
                  for f, op, v in rule["conditions"])
        applied: list[dict] = []
        if met:
            for action_type, params in rule["actions"]:
                try:
                    outcome = await ACTIONS[action_type].apply(
                        db, ctx, params)
                    await db.flush()   # surface FK/CHECK errors per action
                except Exception as exc:
                    raise RuleExecutionError(
                        rule["id"], rule["name"], exc) from exc
                entry = {"action_type": action_type,
                         "applied": outcome.applied}
                if outcome.reason:
                    entry["reason"] = outcome.reason
                applied.append(entry)
        db.add(StatusRuleExecution(
            rule_id=rule["id"], rule_name=rule["name"],
            processed_scan_id=scan.id, conditions_met=met,
            actions_applied=applied,
            duration_ms=int((time.monotonic() - started) * 1000)))
    return len(rules)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_engine.py api/tests/test_status_rules_catalog.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/status_rules/engine.py api/tests/test_status_rules_engine.py
git commit -m "feat(api): status-rules engine — cached triggers, AND conditions, execution log"
```

---

### Task 5: Worker loop — process_raw_scan, run_once, run_forever

**Files:**
- Create: `api/src/serversherpa/scans/worker.py`
- Test: `api/tests/test_scan_worker.py`

**Interfaces:**
- Consumes: `match_scan`/`Match` (Task 2), `apply_rules`/`RuleExecutionError` (Task 4).
- Produces (consumed by Task 6's CLI): `async def run_once(maker) -> bool`, `async def run_forever(poll_seconds: float = 2.0) -> None`, `async def process_raw_scan(maker, raw_id: int) -> str` (returns `"matched" | "unmatched" | "gone" | "error"`), constants `BATCH_LIMIT = 50`, `RETRY_SWEEP_SECONDS = 900`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_scan_worker.py
"""Worker semantics: true move on match, attempt stamping on no-match,
built-in last_seen_at, error rollback + error execution row, batch
pickup, and the slow retry sweep. run_forever smoke modeled on
test_notification_worker.py."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, ProcessedScan, RawScan, StatusRule, StatusRuleAction,
    StatusRuleExecution, SystemProcess,
)
from serversherpa.scans import worker
from serversherpa.status_rules.engine import invalidate_cache


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    invalidate_cache()
    monkeypatch.setattr(worker, "_last_sweep", None)
    yield
    invalidate_cache()


def _raw(value, *, status="rfid_4_into_cage", attempted=None):
    return RawScan(scanned_value=value, scan_type="rfid", status=status,
                   scanned_at=datetime.now(UTC),
                   match_attempted_at=attempted)


async def test_match_moves_row_and_sets_last_seen(db):
    a = Asset(serial_number="SN-1")
    scan = _raw("SN-1")
    db.add_all([a, scan])
    await db.commit()

    result = await worker.process_raw_scan(get_sessionmaker(), scan.id)
    assert result == "matched"

    async with get_sessionmaker()() as check:
        assert (await check.scalars(select(RawScan))).all() == []
        moved = (await check.scalars(select(ProcessedScan))).one()
        assert moved.match_type == "asset"
        assert moved.asset_id == a.id
        assert moved.raw_scan_id == scan.id
        assert moved.scanned_value == "SN-1"
        seen = await check.get(Asset, a.id)
        assert seen.last_seen_at == moved.scanned_at


async def test_no_match_stamps_and_row_stays(db):
    scan = _raw("nobody-home")
    db.add(scan)
    await db.commit()
    assert await worker.process_raw_scan(get_sessionmaker(), scan.id) == "unmatched"
    async with get_sessionmaker()() as check:
        row = (await check.scalars(select(RawScan))).one()
        assert row.match_attempted_at is not None


async def test_rule_error_rolls_back_and_logs_error_execution(db):
    a = Asset(serial_number="SN-2", status="unknown")
    rule = StatusRule(name="Boom", trigger_status="rfid_4_into_cage",
                      trigger_match_type="asset")
    rule.actions.append(StatusRuleAction(
        position=1, action_type="set_asset_status",
        params={"status": "not-a-key"}))
    scan = _raw("SN-2")
    db.add_all([a, rule, scan])
    await db.commit()

    assert await worker.process_raw_scan(get_sessionmaker(), scan.id) == "error"

    async with get_sessionmaker()() as check:
        raw = (await check.scalars(select(RawScan))).one()   # still raw
        assert raw.match_attempted_at is not None
        assert (await check.scalars(select(ProcessedScan))).all() == []
        asset = await check.get(Asset, a.id)
        assert asset.status == "unknown"                     # rolled back
        ex = (await check.scalars(select(StatusRuleExecution))).one()
        assert ex.error is not None
        assert ex.rule_name == "Boom"
        assert ex.processed_scan_id is None


async def test_run_once_picks_fresh_rows_and_sweeps_stale(db, monkeypatch):
    monkeypatch.setattr(worker, "RETRY_SWEEP_SECONDS", 0)
    a = Asset(serial_number="LATE-REG")
    fresh = _raw("nobody")
    stale = _raw("LATE-REG",
                 attempted=datetime.now(UTC) - timedelta(hours=1))
    db.add_all([a, fresh, stale])
    await db.commit()

    worked = await worker.run_once(get_sessionmaker())
    assert worked is True

    async with get_sessionmaker()() as check:
        # stale row matched now that the asset exists; fresh row stamped.
        assert (await check.scalars(select(ProcessedScan))).one().asset_id == a.id
        leftover = (await check.scalars(select(RawScan))).one()
        assert leftover.scanned_value == "nobody"
        assert leftover.match_attempted_at is not None

    assert await worker.run_once(get_sessionmaker()) is False   # all stamped


async def test_run_forever_heartbeats_and_stops(db):
    task = asyncio.create_task(worker.run_forever(poll_seconds=0.05))
    try:
        for _ in range(80):
            await asyncio.sleep(0.05)
            row = await db.scalar(select(SystemProcess).where(
                SystemProcess.name == "scan-matching-worker"))
            if row is not None:
                break
        assert row is not None
        assert row.kind == "worker"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `api/.venv/bin/pytest api/tests/test_scan_worker.py -v`
Expected: FAIL — no `serversherpa.scans.worker`

- [ ] **Step 3: Implement**

```python
# api/src/serversherpa/scans/worker.py
"""The scan-matching worker loop (`serversherpa scan-matching-worker`).
One transaction per scan: match → insert processed row → apply status
rules → delete the raw row. Errors roll back the whole scan (raw row
intact — no V2-style silent loss); a follow-up transaction stamps
match_attempted_at and logs an error execution so the slow sweep
retries it. No signal handlers, matching the import worker: safety is
per-scan commits + idempotent re-runs."""

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, ProcessedScan, RawScan, StatusRuleExecution,
)
from serversherpa.scans.matching import match_scan
from serversherpa.status_rules.engine import RuleExecutionError, apply_rules

logger = logging.getLogger("serversherpa.scans.worker")

BATCH_LIMIT = 50
RETRY_SWEEP_SECONDS = 900   # unmatched rows re-tried every 15 min
_last_sweep: float | None = None

_COPY_FIELDS = ("scanned_value", "scan_type", "status", "scanned_at",
                "device_id", "operator_id", "site_id", "location_detail",
                "source")


async def _stamp_error(maker, raw_id: int, err: Exception) -> None:
    rule_id = getattr(err, "rule_id", None)
    rule_name = getattr(err, "rule_name", None)
    try:
        async with maker() as db:
            raw = await db.get(RawScan, raw_id)
            if raw is not None:
                raw.match_attempted_at = datetime.now(UTC)
            db.add(StatusRuleExecution(
                rule_id=rule_id, rule_name=rule_name or "(scan processing)",
                processed_scan_id=None, conditions_met=rule_id is not None,
                actions_applied=[], error=str(err)[:2000]))
            await db.commit()
    except Exception:
        logger.exception("failed to record error for raw scan %s", raw_id)


async def process_raw_scan(maker, raw_id: int) -> str:
    try:
        async with maker() as db:
            raw = await db.scalar(
                select(RawScan).where(RawScan.id == raw_id)
                .with_for_update(skip_locked=True))
            if raw is None:
                return "gone"
            match = await match_scan(db, raw.scanned_value)
            if match is None:
                raw.match_attempted_at = datetime.now(UTC)
                await db.commit()
                return "unmatched"
            processed = ProcessedScan(
                **{f: getattr(raw, f) for f in _COPY_FIELDS},
                raw_scan_id=raw.id, match_type=match.match_type,
                asset_id=(match.target_id
                          if match.match_type == "asset" else None),
                container_id=(match.target_id
                              if match.match_type == "container" else None),
                person_id=(match.target_id
                           if match.match_type == "person" else None),
                processed_at=datetime.now(UTC))
            db.add(processed)
            await db.flush()
            if match.match_type == "asset":
                asset = await db.get(Asset, match.target_id)
                if (asset.last_seen_at is None
                        or asset.last_seen_at < raw.scanned_at):
                    asset.last_seen_at = raw.scanned_at
            await apply_rules(db, processed)
            await db.delete(raw)
            await db.commit()
            return "matched"
    except RuleExecutionError as err:
        logger.exception("raw scan %s: rule failed", raw_id)
        await _stamp_error(maker, raw_id, err)
        return "error"
    except Exception as err:
        logger.exception("raw scan %s: processing failed", raw_id)
        await _stamp_error(maker, raw_id, err)
        return "error"


async def run_once(maker) -> bool:
    """One batch pass. The slow sweep re-tries previously attempted rows
    (late-registered tags); it runs at most every RETRY_SWEEP_SECONDS."""
    global _last_sweep
    async with maker() as db:
        ids = list((await db.scalars(
            select(RawScan.id)
            .where(RawScan.match_attempted_at.is_(None))
            .order_by(RawScan.id).limit(BATCH_LIMIT))).all())
        now = time.monotonic()
        if _last_sweep is None or now - _last_sweep >= RETRY_SWEEP_SECONDS:
            _last_sweep = now
            cutoff = (datetime.now(UTC)
                      - timedelta(seconds=RETRY_SWEEP_SECONDS))
            ids += (await db.scalars(
                select(RawScan.id)
                .where(RawScan.match_attempted_at < cutoff)
                .order_by(RawScan.id).limit(BATCH_LIMIT))).all()
    for raw_id in ids:
        await process_raw_scan(maker, raw_id)
    return bool(ids)


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("scan-matching-worker")
    heartbeat = start_heartbeat("scan-matching-worker", "worker")
    logger.info("scan-matching worker online — batch %d, sweep every %ds",
                BATCH_LIMIT, RETRY_SWEEP_SECONDS)
    maker = get_sessionmaker()
    try:
        while True:
            worked = await run_once(maker)
            if not worked:
                await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
```

Note on the sweep-instantly test: `RETRY_SWEEP_SECONDS = 0` makes `cutoff = now`, and the stale row's hour-old stamp qualifies. In production the 900s value keeps just-stamped rows out.

- [ ] **Step 4: Run tests to verify they pass**

Run: `api/.venv/bin/pytest api/tests/test_scan_worker.py -v`
Expected: 5 PASS

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/scans/worker.py api/tests/test_scan_worker.py
git commit -m "feat(api): scan-matching worker — true move, rules phase, error retry path"
```

---

### Task 6: CLI command + Procfile line

**Files:**
- Modify: `api/src/serversherpa/cli.py` (append after the `notification_worker` command, before `if __name__`)
- Modify: `Procfile.dev`
- Test: `api/tests/test_cli_scan_matching_worker.py`

**Interfaces:**
- Consumes: Task 5's `run_once`/`run_forever`.
- Produces: `serversherpa scan-matching-worker` CLI (typer names it from the function `scan_matching_worker`).

- [ ] **Step 1: Write the failing tests** — copy the structure of `api/tests/test_cli_import_worker.py` exactly (read it first), adapted:

```python
# api/tests/test_cli_scan_matching_worker.py
"""CLI surface of `serversherpa scan-matching-worker` — mirrors
test_cli_import_worker.py."""

from pathlib import Path

from typer.testing import CliRunner

from serversherpa.cli import app

runner = CliRunner()


def test_help_shows_reload_flag():
    result = runner.invoke(app, ["scan-matching-worker", "--help"])
    assert result.exit_code == 0
    assert "--reload" in result.output


def test_reload_and_once_conflict():
    result = runner.invoke(
        app, ["scan-matching-worker", "--reload", "--once"])
    assert result.exit_code == 1
    assert "cannot be combined" in result.output


def test_reload_invokes_watchfiles(monkeypatch):
    calls = {}

    def fake_run_process(path, target, args):
        calls["path"], calls["target"], calls["args"] = path, target, args

    import watchfiles
    monkeypatch.setattr(watchfiles, "run_process", fake_run_process)
    result = runner.invoke(app, ["scan-matching-worker", "--reload",
                                 "--poll-seconds", "3.5"])
    assert result.exit_code == 0
    assert str(calls["path"]).endswith("/src")
    assert calls["args"] == (3.5,)
    from serversherpa.cli import _run_scan_matching_worker_process
    assert calls["target"] is _run_scan_matching_worker_process
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `api/.venv/bin/pytest api/tests/test_cli_scan_matching_worker.py -v`
Expected: FAIL — typer exit code 2 (unknown command)

- [ ] **Step 3: Implement** — append to `api/src/serversherpa/cli.py`:

```python
def _run_scan_matching_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (picklable, like the import
    worker's)."""

    async def _run() -> None:
        from serversherpa.scans import worker

        await worker.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass    # watchfiles stops the old process with SIGINT on reload


@app.command()
def scan_matching_worker(
    poll_seconds: float = typer.Option(
        2.0, help="Idle sleep between raw-scan polls"),
    once: bool = typer.Option(
        False, help="One batch pass, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart when api/src changes "
                    "(uvicorn-style)"),
) -> None:
    """Run the scan-matching worker — matches raw scans to entities,
    applies status rules, and moves them to processed_scans."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[scan-matching-worker] dev reload — watching {src_dir}",
                    fg="cyan")
        watchfiles.run_process(src_dir,
                               target=_run_scan_matching_worker_process,
                               args=(poll_seconds,))
        return

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.scans import worker

        if once:
            worked = await worker.run_once(get_sessionmaker())
            typer.secho("processed a batch" if worked else "inbox empty",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())
```

Add to `Procfile.dev` after the `notifsvc:` line:

```
scanmatch: api/.venv/bin/serversherpa scan-matching-worker --reload
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `api/.venv/bin/pytest api/tests/test_cli_scan_matching_worker.py -v`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/cli.py Procfile.dev api/tests/test_cli_scan_matching_worker.py
git commit -m "feat(api): scan-matching-worker CLI command + Procfile line"
```

---

### Task 7: API — pydantic schemas + CRUD/toggle routes with audit

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (append a `── status rules ──` block)
- Create: `api/src/serversherpa/api/routes/status_rules.py`
- Modify: `api/src/serversherpa/api/app.py` (import + `app.include_router(status_rules.router)` after the `scans` line)
- Test: `api/tests/test_status_rules_api.py`

**Interfaces:**
- Consumes: Task 1 models, Task 3 `validate_condition`/`validate_action`.
- Produces wire shapes (consumed by Tasks 8–11): `StatusRuleOut = {id, name, description, trigger_status, trigger_match_type, priority, enabled, conditions: [{field, operator, value}], actions: [{action_type, params}], created_at, updated_at}`. Endpoints: `GET /status-rules`, `POST /status-rules` (201), `GET /status-rules/{rule_id}`, `PUT /status-rules/{rule_id}`, `PATCH /status-rules/{rule_id}` (body `{enabled: bool}`), `DELETE /status-rules/{rule_id}` (204). Error style: `HTTPException(status, detail={"code": ...})`; codes `rule_not_found`, `bad_trigger`, `bad_condition`, `bad_action`.

- [ ] **Step 1: Write the failing tests.** Model the auth/client fixtures on `api/tests/test_status_rules_models.py`'s neighbor `api/tests/test_notification_groups_api.py` — read it first and reuse its client/login helper pattern verbatim (it builds an admin user and an `httpx` client against the app). Cover:

```python
# api/tests/test_status_rules_api.py — test list (bodies follow the
# notification-groups test file's client fixture pattern):
#
# 1. test_create_and_list_round_trip — POST a rule with 1 condition +
#    2 actions; GET /status-rules returns it with children in position
#    order; audit row (entity_type="status_rule", action="create") exists.
# 2. test_create_rejects_bad_trigger_status — POST trigger_status="nope"
#    → 422 detail.code == "bad_trigger".
# 3. test_create_rejects_unknown_condition_field — field="x.y" → 422
#    detail.code == "bad_condition".
# 4. test_create_rejects_bad_action_params — set_asset_status with
#    params={} → 422 detail.code == "bad_action".
# 5. test_create_rejects_unknown_status_param_key — set_asset_status with
#    params={"status": "not-a-key"} → 422 detail.code == "bad_action"
#    (vocab check in route).
# 6. test_put_replaces_children — PUT with different conditions/actions;
#    GET shows only the new children; old child rows gone from the DB.
# 7. test_patch_toggles_enabled — PATCH {"enabled": false} → GET shows
#    enabled false; audit action == "toggle".
# 8. test_delete_removes_rule — DELETE → 204; GET /{id} → 404
#    rule_not_found; audit action == "delete".
# 9. test_permission_denied_without_grant — as a user whose role lacks
#    status_rules:add, POST → 403.
```

Every test body must be written out in full in this step (no comment-only stubs in the actual file) — the sketch above defines the required assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_api.py -v`
Expected: FAIL — 404s (router not registered)

- [ ] **Step 3: Add schemas** to `api/src/serversherpa/api/schemas.py`:

```python
# ── status rules ─────────────────────────────────────────────────────

class StatusRuleConditionIn(BaseModel):
    field: str
    operator: str
    value: str | None = None


class StatusRuleActionIn(BaseModel):
    action_type: str
    params: dict = {}


class StatusRuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    trigger_status: str
    trigger_match_type: str
    priority: int = 10
    enabled: bool = True
    conditions: list[StatusRuleConditionIn] = []
    actions: list[StatusRuleActionIn] = Field(min_length=1)


class StatusRulePatch(BaseModel):
    enabled: bool


class StatusRuleOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    trigger_status: str
    trigger_match_type: str
    priority: int
    enabled: bool
    conditions: list[StatusRuleConditionIn]
    actions: list[StatusRuleActionIn]
    created_at: datetime
    updated_at: datetime
```

(Match the module's existing import style; `BaseModel`/`Field` are already imported.)

- [ ] **Step 4: Implement the router**

```python
# api/src/serversherpa/api/routes/status_rules.py
"""Status rules CRUD — the /admin/status-rules backing. Rules are
validated against the code-side catalog at save time (the same catalog
the worker executes — one source of truth); status-typed action params
are additionally checked against the vocabulary here, where we have a
DB. PUT replaces children wholesale: child ids are not stable and
nothing may reference them. All writes audit through services.audit."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    StatusRuleIn, StatusRuleOut, StatusRulePatch,
)
from serversherpa.db.models import (
    StatusRule, StatusRuleAction, StatusRuleCondition, StatusValue,
)
from serversherpa.services.audit import audit
from serversherpa.status_rules.catalog import (
    ACTIONS, validate_action, validate_condition,
)

router = APIRouter(prefix="/status-rules", tags=["status-rules"])


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _out(rule: StatusRule) -> dict:
    return {
        "id": rule.id, "name": rule.name, "description": rule.description,
        "trigger_status": rule.trigger_status,
        "trigger_match_type": rule.trigger_match_type,
        "priority": rule.priority, "enabled": rule.enabled,
        "conditions": [{"field": c.field, "operator": c.operator,
                        "value": c.value} for c in rule.conditions],
        "actions": [{"action_type": a.action_type, "params": a.params}
                    for a in rule.actions],
        "created_at": rule.created_at, "updated_at": rule.updated_at,
    }


async def _vocab_keys(db: DbSession, record_type: str) -> set[str]:
    return set((await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == record_type))).all())


async def _validate(db: DbSession, body: StatusRuleIn) -> None:
    if body.trigger_status not in await _vocab_keys(db, "asset"):
        raise _err(422, "bad_trigger", field="trigger_status")
    if body.trigger_match_type not in await _vocab_keys(db, "processed_scan"):
        raise _err(422, "bad_trigger", field="trigger_match_type")
    for i, c in enumerate(body.conditions):
        code = validate_condition(c.field, c.operator, c.value)
        if code:
            raise _err(422, "bad_condition", index=i, reason=code)
    for i, a in enumerate(body.actions):
        code = validate_action(a.action_type, a.params)
        if code:
            raise _err(422, "bad_action", index=i, reason=code)
        # status-typed params must be real vocabulary keys.
        action = ACTIONS[a.action_type]
        for p in action.params:
            if p.type == "status":
                record_type = p.options_source.removeprefix("status:")
                if a.params[p.name] not in await _vocab_keys(db, record_type):
                    raise _err(422, "bad_action", index=i,
                               reason="unknown_status_key")


def _children(body: StatusRuleIn) -> tuple[list, list]:
    conditions = [StatusRuleCondition(position=i, field=c.field,
                                      operator=c.operator, value=c.value)
                  for i, c in enumerate(body.conditions, 1)]
    actions = [StatusRuleAction(position=i, action_type=a.action_type,
                                params=a.params)
               for i, a in enumerate(body.actions, 1)]
    return conditions, actions


_LOAD = (selectinload(StatusRule.conditions),
         selectinload(StatusRule.actions))


async def _get(db: DbSession, rule_id: uuid.UUID) -> StatusRule:
    rule = await db.scalar(select(StatusRule).options(*_LOAD)
                           .where(StatusRule.id == rule_id))
    if rule is None:
        raise _err(404, "rule_not_found")
    return rule


@router.get("", response_model=list[StatusRuleOut])
async def list_rules(
    db: DbSession,
    actor: AuthContext = require_permission("status_rules", "view"),
) -> list[dict]:
    rules = (await db.scalars(
        select(StatusRule).options(*_LOAD)
        .order_by(StatusRule.priority, StatusRule.created_at))).all()
    return [_out(r) for r in rules]


@router.post("", response_model=StatusRuleOut, status_code=201)
async def create_rule(
    body: StatusRuleIn, db: DbSession,
    actor: AuthContext = require_permission("status_rules", "add"),
) -> dict:
    await _validate(db, body)
    conditions, actions = _children(body)
    rule = StatusRule(
        name=body.name, description=body.description,
        trigger_status=body.trigger_status,
        trigger_match_type=body.trigger_match_type,
        priority=body.priority, enabled=body.enabled,
        created_by=actor.person.id,
        conditions=conditions, actions=actions)
    db.add(rule)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="status_rule",
          entity_id=str(rule.id), action="create",
          changes=body.model_dump(mode="json"))
    await db.commit()
    return _out(await _get(db, rule.id))


@router.get("/{rule_id}", response_model=StatusRuleOut)
async def get_rule(
    rule_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("status_rules", "view"),
) -> dict:
    return _out(await _get(db, rule_id))


@router.put("/{rule_id}", response_model=StatusRuleOut)
async def replace_rule(
    rule_id: uuid.UUID, body: StatusRuleIn, db: DbSession,
    actor: AuthContext = require_permission("status_rules", "change"),
) -> dict:
    rule = await _get(db, rule_id)
    await _validate(db, body)
    rule.name = body.name
    rule.description = body.description
    rule.trigger_status = body.trigger_status
    rule.trigger_match_type = body.trigger_match_type
    rule.priority = body.priority
    rule.enabled = body.enabled
    conditions, actions = _children(body)
    rule.conditions[:] = conditions      # delete-orphan replaces children
    rule.actions[:] = actions
    rule.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="status_rule",
          entity_id=str(rule.id), action="update",
          changes=body.model_dump(mode="json"))
    await db.commit()
    return _out(await _get(db, rule.id))


@router.patch("/{rule_id}", response_model=StatusRuleOut)
async def toggle_rule(
    rule_id: uuid.UUID, body: StatusRulePatch, db: DbSession,
    actor: AuthContext = require_permission("status_rules", "change"),
) -> dict:
    rule = await _get(db, rule_id)
    rule.enabled = body.enabled
    rule.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="status_rule",
          entity_id=str(rule.id), action="toggle",
          changes={"enabled": body.enabled})
    await db.commit()
    return _out(await _get(db, rule.id))


@router.delete("/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("status_rules", "delete"),
) -> None:
    rule = await _get(db, rule_id)
    audit(db, actor_id=actor.person.id, entity_type="status_rule",
          entity_id=str(rule.id), action="delete",
          changes={"name": rule.name})
    await db.delete(rule)
    await db.commit()
```

Register in `api/src/serversherpa/api/app.py`: add `status_rules` to the `from serversherpa.api.routes import (...)` list and `app.include_router(status_rules.router)` after `app.include_router(scans.router)`.

Check `AuthContext`'s person accessor while implementing — the notifications routes use `actor.person.id`; mirror exactly what they do.

- [ ] **Step 5: Run tests to verify they pass**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_api.py -v`
Expected: 9 PASS

- [ ] **Step 6: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/status_rules.py api/src/serversherpa/api/app.py api/tests/test_status_rules_api.py
git commit -m "feat(api): status-rules CRUD routes with catalog validation + audit"
```

---

### Task 8: API — schema endpoint + executions endpoints

**Files:**
- Modify: `api/src/serversherpa/api/routes/status_rules.py`
- Modify: `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_status_rules_api.py` (append)

**Interfaces:**
- Produces (consumed by portal Tasks 9–12):
  - `GET /status-rules/schema` → `{trigger_statuses: [{value,label,color}], match_types: [{value,label,color}], operators: [{key,label,needs_value}], condition_fields: [{key,label,type,options?}], actions: [{key,label,params: [{name,type,options?}]}], sites: [{value,label}]}` — status/site `options` are embedded `[{value,label,color?}]` so the portal editor needs no other fetches.
  - `GET /status-rules/executions?rule_id=&limit=&offset=` → `[{id, rule_id, rule_name, processed_scan_id, conditions_met, actions_applied, error, executed_at, duration_ms, scanned_value, scan_status}]` (scan fields NULL for error rows), newest first, default limit 100, max 500.
  - `GET /status-rules/executions/stats` → `[{rule_id, run_count, met_count, last_run_at, avg_duration_ms}]`.

**IMPORTANT:** these routes share the `/status-rules` prefix with `/{rule_id}` — declare `/schema` and `/executions*` handlers ABOVE the `/{rule_id}` handlers in the file, or FastAPI will try to parse "schema" as a UUID.

- [ ] **Step 1: Write the failing tests** (append to `api/tests/test_status_rules_api.py`; full bodies, same fixtures):

```python
# 10. test_schema_endpoint_shape — GET /status-rules/schema as admin:
#     trigger_statuses non-empty and contains rfid keys from the vocab;
#     operators has exactly the 9 keys; every action's status params
#     carry non-empty options; sites list present.
# 11. test_executions_list_and_filter — insert 2 StatusRuleExecution
#     rows (one tied to a ProcessedScan, one error row with NULLs) via
#     the db fixture; GET /status-rules/executions returns both newest
#     first with scanned_value joined; ?rule_id= filters.
# 12. test_executions_stats — 3 executions across 2 rules → stats rows
#     aggregate run_count/met_count/last_run_at per rule.
# 13. test_executions_require_view — role without status_rules:view → 403.
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_api.py -v -k "schema or executions"`
Expected: FAIL — 404/422

- [ ] **Step 3: Implement.** Add to `schemas.py`:

```python
class StatusRuleExecutionItem(BaseModel):
    id: int
    rule_id: uuid.UUID | None
    rule_name: str
    processed_scan_id: uuid.UUID | None
    conditions_met: bool
    actions_applied: list
    error: str | None
    executed_at: datetime
    duration_ms: int
    scanned_value: str | None
    scan_status: str | None


class StatusRuleExecStat(BaseModel):
    rule_id: uuid.UUID
    run_count: int
    met_count: int
    last_run_at: datetime | None
    avg_duration_ms: float | None
```

Add to the router (above the `/{rule_id}` routes):

```python
@router.get("/schema")
async def rule_schema(
    db: DbSession,
    actor: AuthContext = require_permission("status_rules", "view"),
) -> dict:
    vocab = (await db.scalars(select(StatusValue).where(
        StatusValue.is_active.is_(True)).order_by(
        StatusValue.record_type, StatusValue.sort_order))).all()
    by_type: dict[str, list[dict]] = {}
    for v in vocab:
        by_type.setdefault(v.record_type, []).append(
            {"value": v.key, "label": v.label, "color": v.color})
    sites = [{"value": str(sid), "label": name}
             for sid, name in (await db.execute(
                 select(Site.id, Site.name).order_by(Site.name))).all()]

    def options_for(source: str | None):
        if source is None:
            return None
        if source == "sites":
            return sites
        return by_type.get(source.removeprefix("status:"), [])

    return {
        "trigger_statuses": by_type.get("asset", []),
        "match_types": by_type.get("processed_scan", []),
        "operators": [{"key": k, "label": k.replace("_", " "),
                       "needs_value": k not in ("is_null", "is_not_null")}
                      for k in OPERATORS],
        "condition_fields": [
            {"key": f.key, "label": f.label, "type": f.type,
             **({"options": options_for(f.options_source)}
                if f.options_source else {})}
            for f in CONDITION_FIELDS.values()],
        "actions": [
            {"key": a.key, "label": a.label,
             "params": [
                 {"name": p.name, "type": p.type,
                  **({"options": list(p.options)} if p.options else {}),
                  **({"options": options_for(p.options_source)}
                     if p.options_source else {})}
                 for p in a.params]}
            for a in ACTIONS.values()],
    }


@router.get("/executions", response_model=list[StatusRuleExecutionItem])
async def list_executions(
    db: DbSession,
    actor: AuthContext = require_permission("status_rules", "view"),
    rule_id: uuid.UUID | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[dict]:
    query = (select(StatusRuleExecution, ProcessedScan.scanned_value,
                    ProcessedScan.status)
             .outerjoin(ProcessedScan,
                        StatusRuleExecution.processed_scan_id
                        == ProcessedScan.id)
             .order_by(StatusRuleExecution.executed_at.desc(),
                       StatusRuleExecution.id.desc())
             .limit(limit).offset(offset))
    if rule_id is not None:
        query = query.where(StatusRuleExecution.rule_id == rule_id)
    rows = (await db.execute(query)).all()
    return [{
        "id": ex.id, "rule_id": ex.rule_id, "rule_name": ex.rule_name,
        "processed_scan_id": ex.processed_scan_id,
        "conditions_met": ex.conditions_met,
        "actions_applied": ex.actions_applied, "error": ex.error,
        "executed_at": ex.executed_at, "duration_ms": ex.duration_ms,
        "scanned_value": value, "scan_status": status,
    } for ex, value, status in rows]


@router.get("/executions/stats", response_model=list[StatusRuleExecStat])
async def execution_stats(
    db: DbSession,
    actor: AuthContext = require_permission("status_rules", "view"),
) -> list[dict]:
    rows = (await db.execute(
        select(StatusRuleExecution.rule_id,
               func.count().label("run_count"),
               func.count().filter(
                   StatusRuleExecution.conditions_met).label("met_count"),
               func.max(StatusRuleExecution.executed_at),
               func.avg(StatusRuleExecution.duration_ms))
        .where(StatusRuleExecution.rule_id.is_not(None))
        .group_by(StatusRuleExecution.rule_id))).all()
    return [{"rule_id": r[0], "run_count": r[1], "met_count": r[2],
             "last_run_at": r[3],
             "avg_duration_ms": float(r[4]) if r[4] is not None else None}
            for r in rows]
```

Extend the router file's imports: `Query` from fastapi, `func` from sqlalchemy, `ProcessedScan, Site` from models, `CONDITION_FIELDS, OPERATORS` from the catalog, and the two new schemas. **Move these three handlers above `get_rule`** in the file.

Note `/executions/stats` must ALSO be declared before `/executions`? No — FastAPI matches exact segments before typed params only by declaration order within the same path shape; `/executions` and `/executions/stats` don't collide. Only `/{rule_id}` ordering matters.

- [ ] **Step 4: Run all API status-rules tests**

Run: `api/.venv/bin/pytest api/tests/test_status_rules_api.py -v`
Expected: 13 PASS

- [ ] **Step 5: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/status_rules.py api/tests/test_status_rules_api.py
git commit -m "feat(api): status-rules schema + executions endpoints"
```

---

### Task 9: Portal — api client block + lib helpers

**Files:**
- Modify: `portal/src/lib/api.ts` (append a `/* ── status rules ── */` block at the end, modeled on the notification-group block at `api.ts:2408-2559`)
- Create: `portal/src/lib/statusRules.ts`
- Test: `portal/src/lib/statusRules.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 10–12) in `api.ts`:

```ts
export interface StatusRuleCondition { field: string; operator: string; value: string | null }
export interface StatusRuleAction { action_type: string; params: Record<string, unknown> }
export interface StatusRule {
  id: string; name: string; description: string;
  trigger_status: string; trigger_match_type: string;
  priority: number; enabled: boolean;
  conditions: StatusRuleCondition[]; actions: StatusRuleAction[];
  created_at: string; updated_at: string;
}
export interface StatusRuleIn {
  name: string; description: string; trigger_status: string;
  trigger_match_type: string; priority: number; enabled: boolean;
  conditions: StatusRuleCondition[]; actions: StatusRuleAction[];
}
export interface SchemaOption { value: string; label: string; color?: string }
export interface RuleSchemaOperator { key: string; label: string; needs_value: boolean }
export interface RuleSchemaField { key: string; label: string; type: string; options?: SchemaOption[] }
export interface RuleSchemaParam { name: string; type: string; options?: (string | SchemaOption)[] }
export interface RuleSchemaAction { key: string; label: string; params: RuleSchemaParam[] }
export interface StatusRuleSchema {
  trigger_statuses: SchemaOption[]; match_types: SchemaOption[];
  operators: RuleSchemaOperator[]; condition_fields: RuleSchemaField[];
  actions: RuleSchemaAction[];
}
export interface StatusRuleExecution {
  id: number; rule_id: string | null; rule_name: string;
  processed_scan_id: string | null; conditions_met: boolean;
  actions_applied: { action_type: string; applied: boolean; reason?: string }[];
  error: string | null; executed_at: string; duration_ms: number;
  scanned_value: string | null; scan_status: string | null;
}
export interface StatusRuleExecStat {
  rule_id: string; run_count: number; met_count: number;
  last_run_at: string | null; avg_duration_ms: number | null;
}
export async function listStatusRules(): Promise<StatusRule[]>
export async function createStatusRule(body: StatusRuleIn): Promise<StatusRule>
export async function updateStatusRule(id: string, body: StatusRuleIn): Promise<StatusRule>
export async function toggleStatusRule(id: string, enabled: boolean): Promise<StatusRule>
export async function deleteStatusRule(id: string): Promise<void>
export async function getStatusRuleSchema(): Promise<StatusRuleSchema>
export async function listStatusRuleExecutions(params: { ruleId?: string; limit?: number; offset?: number }): Promise<StatusRuleExecution[]>
export async function getStatusRuleExecStats(): Promise<StatusRuleExecStat[]>
```

- Produces in `statusRules.ts`: `summarizeCondition(c, schema): string` (e.g. `"Scan device equals dock-1"`), `summarizeAction(a, schema): string` (label + param values, status params resolved to labels), `optionLabel(options, value): string`.

- [ ] **Step 1: Write the failing helper tests**

```ts
// portal/src/lib/statusRules.test.ts
import { describe, expect, it } from 'vitest';

import type { StatusRuleSchema } from './api';
import { optionLabel, summarizeAction, summarizeCondition } from './statusRules';

const SCHEMA: StatusRuleSchema = {
  trigger_statuses: [{ value: 'rfid_4_into_cage', label: 'Into cage' }],
  match_types: [{ value: 'asset', label: 'Asset' }],
  operators: [
    { key: 'equals', label: 'equals', needs_value: true },
    { key: 'is_null', label: 'is null', needs_value: false },
  ],
  condition_fields: [
    { key: 'scan.device_id', label: 'Scan device', type: 'text' },
  ],
  actions: [
    {
      key: 'set_asset_status', label: 'Set asset status',
      params: [{ name: 'status', type: 'status', options: [
        { value: 'rfid_4_into_cage', label: 'Into cage' }] }],
    },
    { key: 'touch_container_audit', label: 'Record container audit touch', params: [] },
  ],
};

describe('summarizeCondition', () => {
  it('joins field label, operator, value', () => {
    expect(summarizeCondition(
      { field: 'scan.device_id', operator: 'equals', value: 'dock-1' },
      SCHEMA)).toBe('Scan device equals dock-1');
  });
  it('omits value for no-value operators', () => {
    expect(summarizeCondition(
      { field: 'scan.device_id', operator: 'is_null', value: null },
      SCHEMA)).toBe('Scan device is null');
  });
});

describe('summarizeAction', () => {
  it('resolves status params to labels', () => {
    expect(summarizeAction(
      { action_type: 'set_asset_status', params: { status: 'rfid_4_into_cage' } },
      SCHEMA)).toBe('Set asset status → Into cage');
  });
  it('renders paramless actions as the bare label', () => {
    expect(summarizeAction(
      { action_type: 'touch_container_audit', params: {} },
      SCHEMA)).toBe('Record container audit touch');
  });
});

describe('optionLabel', () => {
  it('falls back to the raw value', () => {
    expect(optionLabel([{ value: 'a', label: 'A' }], 'missing')).toBe('missing');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm --prefix portal test -- --run src/lib/statusRules.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `statusRules.ts`**

```ts
// portal/src/lib/statusRules.ts
/** Display helpers for status rules — pure functions over the /schema
 *  payload so list rows and the editor share one rendering of
 *  conditions and actions. No imports from components. */

import type {
  SchemaOption, StatusRuleAction, StatusRuleCondition, StatusRuleSchema,
} from './api';

export function optionLabel(
  options: (string | SchemaOption)[] | undefined, value: string,
): string {
  for (const o of options ?? []) {
    if (typeof o === 'string') { if (o === value) return o; }
    else if (o.value === value) return o.label;
  }
  return value;
}

export function summarizeCondition(
  c: StatusRuleCondition, schema: StatusRuleSchema,
): string {
  const field = schema.condition_fields.find((f) => f.key === c.field);
  const op = schema.operators.find((o) => o.key === c.operator);
  const parts = [field?.label ?? c.field, op?.label ?? c.operator];
  if (op?.needs_value !== false && c.value != null) {
    const fieldOpts = field?.options;
    parts.push(fieldOpts ? optionLabel(fieldOpts, c.value) : c.value);
  }
  return parts.join(' ');
}

export function summarizeAction(
  a: StatusRuleAction, schema: StatusRuleSchema,
): string {
  const def = schema.actions.find((d) => d.key === a.action_type);
  if (!def) return a.action_type;
  const values = def.params.map((p) => {
    const raw = a.params[p.name];
    return optionLabel(p.options, String(raw));
  });
  return values.length ? `${def.label} → ${values.join(', ')}` : def.label;
}
```

Then append the api.ts block: copy the notification-group block's structure exactly (each function: `const resp = await apiFetch(path, init); if (!resp.ok) throw await errorFrom(resp); return resp.json();`), with paths `/status-rules`, `/status-rules/${id}`, `/status-rules/schema`, `/status-rules/executions?...` (build the query string with `URLSearchParams`), `/status-rules/executions/stats`. `toggleStatusRule` PATCHes `{enabled}`; `deleteStatusRule` returns void on 204.

- [ ] **Step 4: Run to verify pass**

Run: `npm --prefix portal test -- --run src/lib/statusRules.test.ts`
Expected: 5 PASS. Also `npm --prefix portal run build` must succeed (type-checks the api.ts block).

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/statusRules.ts portal/src/lib/statusRules.test.ts
git commit -m "feat(portal): status-rules api client + display helpers"
```

---

### Task 10: Portal — page shell, Rules tab, route registration

**Files:**
- Create: `portal/src/pages/StatusRules.tsx`
- Create: `portal/src/components/statusRules/RulesTab.tsx`
- Modify: `portal/src/App.tsx`, `portal/src/layout/navSections.tsx`, `portal/src/components/Topbar.tsx`, `portal/src/components/CommandPalette.tsx`, `portal/src/lib/access.ts`
- Test: `portal/src/pages/StatusRules.test.tsx`

**Interfaces:**
- Consumes: Task 9's client functions + helpers.
- Produces: `RulesTab` prop contract `{ onCount: (n: number | null) => void }` (same as the Scans tabs); an `onEdit`-style modal hook is added in Task 11 — this task renders the list with a disabled/absent editor and wires everything else.

- [ ] **Step 1: Write the failing page test** — model on `portal/src/pages/Notifications.test.tsx` (jsdom pragma, hoisted mocks of `react-router-dom`, `../auth/AuthContext`, `../lib/api`). Cover, with full bodies:

```ts
// portal/src/pages/StatusRules.test.tsx — required cases:
// 1. renders rule rows sorted by priority with trigger chip labels
//    resolved from the mocked schema (mock listStatusRules,
//    getStatusRuleSchema, getStatusRuleExecStats).
// 2. '+ New rule' button hidden when can('status_rules','add') is false.
// 3. enabled switch calls toggleStatusRule and reloads.
// 4. shows the load-error banner when listStatusRules rejects.
```

- [ ] **Step 2: Run to verify failure**

Run: `npm --prefix portal test -- --run src/pages/StatusRules.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the page shell** (mirrors `Scans.tsx`):

```tsx
// portal/src/pages/StatusRules.tsx
/** Admin → Status rules: tabbed manager for scan automation. Rules =
 *  CRUD list + editor; Executions = the per-fire log. Schema comes
 *  from /status-rules/schema so the UI can never drift from the
 *  engine's operators/fields/actions. */

import { useState } from 'react';

import ExecutionsTab from '../components/statusRules/ExecutionsTab';
import RulesTab from '../components/statusRules/RulesTab';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/system.css';

const TABS = [
  { key: 'rules', label: 'Rules', component: RulesTab },
  { key: 'executions', label: 'Executions', component: ExecutionsTab },
] as const;

export default function StatusRules() {
  const [active, setActive] = useState<string>('rules');
  const [count, setCount] = useState<number | null>(null);
  const entry = TABS.find((t) => t.key === active) ?? TABS[0];
  const Tab = entry.component;
  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="page-title">
            Status rules
            <span className="badge-count">{count ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Automation the scan matcher applies — when a scan with a
            checkpoint status matches an entity, these rules fire.
          </p>
        </div>
      </div>
      <div className="sysconf-tabbar" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab"
                  aria-selected={active === t.key}
                  className={`sysconf-tab${active === t.key ? ' active' : ''}`}
                  onClick={() => { setActive(t.key); setCount(null); }}>
            {t.label}
          </button>
        ))}
      </div>
      <Tab onCount={setCount} />
    </div>
  );
}
```

Until Task 12 lands, create `ExecutionsTab.tsx` as a stub in THIS task so the page compiles:

```tsx
// portal/src/components/statusRules/ExecutionsTab.tsx  (stub — Task 12 replaces)
export default function ExecutionsTab({ onCount }: { onCount: (n: number | null) => void }) {
  return <div className="dir-empty">Execution history arrives with the next task.</div>;
}
```

`RulesTab.tsx`: a directory list, deliberately simpler than Notifications (rules number in the dozens — no column menus, virtualization, or CSV; keep search + sorted-by-priority rows). Structure:

- `useEffect` load: `Promise.all([listStatusRules(), getStatusRuleSchema(), getStatusRuleExecStats()])` into state; error string on failure ("You don't have access…" on `ApiError` status 403, else "Couldn't load status rules.").
- Toolbar: `.dir-toolbar` with a `.dir-search` input filtering by name/description/trigger label, `.result-count`, and `+ New rule` (`.btn-solid`, rendered when `can('status_rules', 'add')`) — wired to the editor modal in Task 11 (this task: render the button but have it no-op with a `// Task 11` note removed once wired).
- List: `.dir-list` with `.list-head` columns — Name (name + `.cell-sub` description), Trigger (status chip using the schema color + match-type `.tag`), Priority, Conditions (count), Actions (count via `summarizeAction` tooltip `title`), Runs (stat's `run_count` + relative last run), Enabled (a `.switch` checkbox, disabled unless `can('status_rules','change')`, onChange → `toggleStatusRule(rule.id, !rule.enabled)` then reload), and a row-menu cell (Edit/Duplicate/Delete — Duplicate calls `createStatusRule({...rule, name: rule.name + ' (Copy)', enabled: false, conditions: rule.conditions, actions: rule.actions})` then reload; Delete `window.confirm` then `deleteStatusRule` + reload; Edit no-ops until Task 11).
- Empty states: `.dir-empty` for "No rules yet — create the first one." vs no-search-match.
- `onCount(rules.length)` after load, `onCount(null)` on error.

- [ ] **Step 4: Register the route everywhere**

1. `portal/src/App.tsx`: `import StatusRules from './pages/StatusRules';` + next to the other admin routes:
   ```tsx
   <Route path="/admin/status-rules" element={
     <ProtectedRoute resource="status_rules"><StatusRules /></ProtectedRoute>} />
   ```
2. `portal/src/layout/navSections.tsx`: add to the Admin section (after Scans) — `{ to: '/admin/status-rules', label: 'Status rules', resource: 'status_rules', icon: (…inline 24×24 stroke SVG — a lightning bolt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z" strokeLinejoin="round"/></svg>) }`.
3. `portal/src/components/Topbar.tsx`: `CRUMBS['/admin/status-rules'] = ['Admin', 'Status rules']`; add `{ label: 'Status rules', to: '/admin/status-rules', resource: 'status_rules' }` to `PAGES` (match that array's exact element shape).
4. `portal/src/components/CommandPalette.tsx`: `navGated('Status rules', '/admin/status-rules', 'status_rules')` next to the Scans entry.
5. `portal/src/lib/access.ts`: `'/admin/status-rules': 'status_rules'` in `ROUTE_RESOURCE`.

- [ ] **Step 5: Run tests**

Run: `npm --prefix portal test -- --run src/pages/StatusRules.test.tsx`
Expected: 4 PASS
Then: `npm --prefix portal test -- --run` — the nav/godmode tests must still pass with the new entry.

- [ ] **Step 6: Commit**

```bash
git add portal/src/pages/StatusRules.tsx portal/src/pages/StatusRules.test.tsx portal/src/components/statusRules portal/src/App.tsx portal/src/layout/navSections.tsx portal/src/components/Topbar.tsx portal/src/components/CommandPalette.tsx portal/src/lib/access.ts
git commit -m "feat(portal): /admin/status-rules page — rules list + registration"
```

---

### Task 11: Portal — rule editor modal

**Files:**
- Create: `portal/src/components/statusRules/RuleEditorModal.tsx`
- Modify: `portal/src/components/statusRules/RulesTab.tsx` (wire `+ New rule`, Edit, and pass schema)
- Test: `portal/src/components/statusRules/RuleEditorModal.test.tsx`

**Interfaces:**
- Consumes: Task 9 types + `getStatusRuleSchema` payload (passed in as a prop — no fetch inside the modal).
- Produces: `<RuleEditorModal schema={schema} rule={ruleOrNull} onClose={() => void} onSaved={() => void} />` — `rule === null` creates via `createStatusRule`, otherwise saves via `updateStatusRule`.

- [ ] **Step 1: Write the failing tests** (jsdom; mock `../../lib/api`): full bodies covering —

```ts
// RuleEditorModal.test.tsx — required cases:
// 1. create mode: fill name, pick trigger status + match type, add one
//    action (set_asset_status → pick a status option), submit →
//    createStatusRule called with the exact StatusRuleIn payload.
// 2. save disabled until name, trigger, and ≥1 action present.
// 3. condition row: picking operator 'is_null' hides the value input.
// 4. edit mode: fields pre-filled from the rule prop; submit calls
//    updateStatusRule(rule.id, …).
// 5. shows detail-code error text when the api call rejects
//    (ApiError with detail.code 'bad_action').
```

- [ ] **Step 2: Run to verify failure**

Run: `npm --prefix portal test -- --run src/components/statusRules/RuleEditorModal.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement.** House modal skeleton (`.modal-scrim` > `.modal-card` > `.modal-head`/`.modal-body`/`.modal-foot`, scrim `onMouseDown` close — copy the skeleton from `NewGroupModal` in `portal/src/pages/Notifications.tsx:352-397`). Body sections, all driven by the `schema` prop:

1. **Basics** — `.pf-form` grid: Name (text), Priority (number, hint "lower runs first"), Description (textarea).
2. **Trigger** — two selects: "When a scan with status" (options `schema.trigger_statuses`, render color dot via an inline `<span class="chip">`) "matches a" (options `schema.match_types`).
3. **Conditions** — state `conditions: StatusRuleCondition[]`; each row: field select (`schema.condition_fields`), operator select (all operators; no per-type filtering in v1 — the API validates), then the value control chosen by the selected field's `type` and operator's `needs_value`:
   - `needs_value === false` → no input;
   - field has `options` → select over them;
   - `type === 'bool'` → True/False select (values `"true"`/`"false"`);
   - `type === 'number'` → `<input type="number">`;
   - otherwise text input.
   "Add condition" `.mini-btn`; per-row remove ✕. Header line: "All conditions must be true".
4. **Actions** — state `actions: StatusRuleAction[]`; each row: action select (`schema.actions`), then one control per `param` (`status`/options → select; `bool` → True/False select storing a real boolean; `choice` → select over `options`). Up/down `.mini-btn`s reorder. "Add action". Empty-state hint: "Add at least one action."
5. **Foot** — `.btn-solid` Save (disabled unless `name.trim() && trigger_status && trigger_match_type && actions.length > 0`), `.mini-btn` Cancel, `.pf-error` showing `msgFor(err)` with an `ERRORS` map for codes `bad_trigger`, `bad_condition`, `bad_action`, `rule_not_found`.

On save build the exact `StatusRuleIn` and call create/update; on success `onSaved()` (parent reloads + closes).

In `RulesTab.tsx`: add `const [editing, setEditing] = useState<StatusRule | null | 'new'>(null)`-style state; `+ New rule` → `'new'`, row Edit → the rule; render the modal when set.

- [ ] **Step 4: Run tests**

Run: `npm --prefix portal test -- --run src/components/statusRules/RuleEditorModal.test.tsx src/pages/StatusRules.test.tsx`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/statusRules portal/src/pages/StatusRules.test.tsx
git commit -m "feat(portal): status-rule editor modal — schema-driven builder"
```

---

### Task 12: Portal — Executions tab

**Files:**
- Modify: `portal/src/components/statusRules/ExecutionsTab.tsx` (replace the Task 10 stub)
- Test: `portal/src/components/statusRules/ExecutionsTab.test.tsx`

**Interfaces:**
- Consumes: `listStatusRuleExecutions`, `listStatusRules` (for the filter select), `getStatusRuleSchema` (status chip colors via `scan_status`).
- Produces: `<ExecutionsTab onCount={(n | null) => void} />` — `onCount` receives the loaded row count.

- [ ] **Step 1: Write the failing tests** — full bodies covering:

```ts
// ExecutionsTab.test.tsx — required cases:
// 1. renders execution rows newest-first: time, rule name, scanned
//    value, result chip text 'Executed' (conditions_met && !error),
//    'Conditions not met', or 'Error'.
// 2. error rows render the error text and an 'Error' chip with class
//    'c-red'.
// 3. rule filter select re-calls listStatusRuleExecutions with
//    { ruleId } when changed.
// 4. 'Load more' appends the next offset page and disappears when a
//    short page returns.
```

- [ ] **Step 2: Run to verify failure**

Run: `npm --prefix portal test -- --run src/components/statusRules/ExecutionsTab.test.tsx`
Expected: FAIL against the stub

- [ ] **Step 3: Implement.** Structure:

- Load `Promise.all([listStatusRules(), listStatusRuleExecutions({ limit: PAGE })])` (PAGE = 100); state `rows`, `rules`, `filter: string | ''`, `done: boolean` (last page shorter than PAGE), `error`.
- Toolbar: `.dir-toolbar` with a rule filter `<select>` ("All rules" + one option per rule) and `.result-count`.
- Table: `.dir-list` grid — Time (`.mono`, locale date+time), Rule, Scan (`scanned_value` `.mono`, `.cell-sub` = `scan_status` or '—'), Result (`.chip c-green` "Executed" / `.chip` "Conditions not met" / `.chip c-red` "Error"), Actions (applied count + `skipped n` suffix when any `applied === false`; full `actions_applied` JSON in the cell `title`), Duration (`{duration_ms}ms`).
- Error rows (`error != null`): the Scan cell shows '—' and the row gets a second line rendering the error text in `.cell-sub`.
- Footer `.mini-btn` "Load more" → `listStatusRuleExecutions({ ruleId: filter || undefined, limit: PAGE, offset: rows.length })`, append; hide when `done`.
- `onCount(rows.length)` after each load.

- [ ] **Step 4: Run tests**

Run: `npm --prefix portal test -- --run src/components/statusRules/ExecutionsTab.test.tsx`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/statusRules/ExecutionsTab.tsx portal/src/components/statusRules/ExecutionsTab.test.tsx
git commit -m "feat(portal): status-rules executions tab"
```

---

### Task 13: Full verification

**Files:** none (verification only; fix regressions in place if any surface).

- [ ] **Step 1: Full API suite** — FOREGROUND, one run, timeout 600000ms:

Run: `api/.venv/bin/pytest api/tests -x -q`
Expected: all pass (≈820 pre-existing + ~40 new). Any failure: fix before proceeding.

- [ ] **Step 2: Full portal suite + build** — FOREGROUND:

Run: `npm --prefix portal test -- --run && npm --prefix portal run build`
Expected: all tests pass, build clean.

- [ ] **Step 3: Smoke the worker CLI once against the dev DB**

Run: `api/.venv/bin/serversherpa scan-matching-worker --once`
Expected: exits 0 with "processed a batch" or "inbox empty". (The dev DB holds ~100k seeded raw_scans — one batch is 50 rows; that's fine, this is a smoke test, not a drain.)

- [ ] **Step 4: Clean tree + commit any stragglers**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git status
```

Expected: clean (or only intentional changes; commit them with a descriptive message).

---

## Plan Self-Review (completed at write time)

- **Spec coverage:** §1→Task 1; §2 matcher→Tasks 2/5/6; §3 engine→Tasks 3/4; §4 API→Tasks 7/8 (dev-seed item consciously dropped — no seeding script exists; recorded in Global Constraints); §5 portal→Tasks 9–12; §6 testing→embedded per task + Task 13.
- **Type consistency:** `Match/match_scan` (T2→T5); `Context/OPERATORS/ACTIONS/validate_*` (T3→T4/T7/T8); `apply_rules/RuleExecutionError` (T4→T5); `run_once/run_forever` (T5→T6); wire shapes (T7/T8→T9); client exports (T9→T10/T11/T12) — names checked end-to-end.
- **Known judgment calls for implementers:** condition-operator filtering by field type is deferred to the API validator (editor shows all 9); the editor modal reuses the house `.pf-form`/`.modal-*` classes with no new stylesheet unless a page-specific file proves necessary (then follow the `styles/notifications.css` header-comment convention).
