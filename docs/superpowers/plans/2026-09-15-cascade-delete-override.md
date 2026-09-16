# Cascade Delete Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Developer › Database › Reconcile an override that deletes a record plus every row attached to it, after showing exactly what will be destroyed and requiring the record's name to be typed.

**Architecture:** One schema-walking engine in a new module collects the levels of the reference graph below a doomed row; `plan_cascade` formats those levels as a preview and `execute_cascade` applies them, so the preview and the delete cannot disagree. Two new endpoints wrap it. The Reconcile tab gains a modal that renders the plan and gates the destroy button on a typed confirmation.

**Tech Stack:** FastAPI + SQLAlchemy async (Core `Table` metadata reflection) + pytest against real Postgres; React 18 + TypeScript + vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-09-15-cascade-delete-override-design.md`

## Global Constraints

- Work in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail` on branch `user-detail`. Never `cd` to the main checkout.
- Every python command sets `PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src` and `SS_TEST_DB=serversherpa_test_user_detail`; the venv is symlinked at `api/.venv`.
- Run suites in the FOREGROUND in one continuous command with an explicit timeout (600000 ms). Never background a suite and end the turn waiting.
- Lint gate for this plan: `api/.venv/bin/ruff check --select F401,E501 <files>` (ruff in this venv is unpinned 0.16.7 whose default rules flag pre-existing repo debt; do not reformat unrelated code). Ruff line length 100.
- Never commit `api/src/serversherpa/_dev_reload.py`; restore it with `git checkout -- api/src/serversherpa/_dev_reload.py`. Never `git add portal/node_modules` (a symlink).
- No migration. No new npm or python dependencies.
- American English in all copy, comments and docs.
- `audit_log` is never purged, at any depth, by an explicit guard.
- The list typography guardrail `portal/src/styles/listTypography.test.ts` must stay green: no raw `<table>` outside `DataTable`, no typography properties outside `directory.css`.
- Every new modal carries the report-generate header (`.rgm-head-text` with `.eyebrow`, `h3`, `.page-hint`) and sizes to its content.
- Commit after each task with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `api/src/serversherpa/devtools/cascade.py` (new) | schema walk, `CascadePlan`, `plan_cascade`, `execute_cascade`, shared `label_expr` / `check_guarded` / `references_to` |
| `api/src/serversherpa/api/routes/devtools.py` | imports the shared helpers instead of defining them; two new endpoints; `db_handled` on reference reports |
| `api/src/serversherpa/api/schemas.py` | `CascadeStepOut`, `CascadePlanOut`, `CascadeDeleteIn`; `PendingDeleteReference.db_handled` |
| `api/tests/test_devtools_cascade.py` (new) | engine and endpoint tests |
| `portal/src/lib/api.ts` | cascade types, `getCascadePreview`, `cascadeDelete`, `db_handled` on the reference type |
| `portal/src/lib/pendingDeletes.ts` | `canForceDelete` treats `db_handled` as satisfied |
| `portal/src/components/dev/CascadeDeleteModal.tsx` (new) | preview + typed confirmation + destroy |
| `portal/src/pages/DevDatabase.tsx` | Override button, modal wiring, `db_handled` wording |
| `portal/src/styles/system.css` | `dev-cascade-` layout rules |

---

### Task 1: Shared helpers move into the cascade module

Pure refactor with no behavior change, so the existing devtools suites prove it. It exists so Task 2's walk and `devtools.py` share one definition of "what points at this" rather than two.

**Files:**
- Create: `api/src/serversherpa/devtools/cascade.py`
- Modify: `api/src/serversherpa/api/routes/devtools.py` (delete `_label_expr`, `_check_guarded`, `_references_to`; import the new names; update call sites in `_find_references` and `_detach_references`)
- Test: existing `api/tests/test_pending_deletes_api.py`, `api/tests/test_devtools.py`

**Interfaces:**
- Produces: `label_expr(table: Table)` (unchanged behavior), `check_guarded(table: Table, col) -> bool`, `references_to(table: Table) -> Iterator[tuple[Table, Column, Column]]` yielding `(child_table, child_column, parent_column)` for every foreign key targeting any primary-key column of `table`.
- Produces: `NEVER_PURGE = frozenset({"audit_log"})`, `MAX_DEPTH = 6`.

- [ ] **Step 1: Record the green baseline**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_pending_deletes_api.py tests/test_devtools.py
```
Expected: all pass. Note the counts.

- [ ] **Step 2: Create `api/src/serversherpa/devtools/cascade.py`**

```python
"""Cascade delete: what else dies when a god-mode reconcile target dies.

The walk below is the single source of truth for both the preview a
developer confirms and the statements that actually run, so the two can
never disagree. It is deliberately schema-driven rather than a hand-kept
list of tables: a new table with a required foreign key joins the cascade
the moment it exists."""

import re
from collections.abc import Iterator

from sqlalchemy import CheckConstraint, String, cast, func
from sqlalchemy.sql.schema import Column, Table

from serversherpa.db.models import Base

# How many levels of dependent rows the walk will follow before giving up.
# Six is far beyond anything in this schema (the deepest real chain is
# person -> user_accounts -> auth_sessions, i.e. two) and exists so a
# future circular structure fails loudly instead of spinning.
MAX_DEPTH = 6

# Tables whose rows are never deleted as collateral, whatever the schema
# says. Deleting a record must not delete the record of deleting it.
NEVER_PURGE = frozenset({"audit_log"})

# How to render a human label for a row in a referencing table. Unmapped
# tables fall back to the row's own primary key, stringified — never blank.
_NAME_LABELED = {"initiatives", "sites", "containers", "clients", "partners"}


def label_expr(table: Table):
    if table.name in _NAME_LABELED:
        return table.c.name
    if table.name == "assets":
        return func.coalesce(table.c.serial_number, table.c.name)
    if table.name == "people":
        return table.c.first_name + " " + table.c.last_name
    if table.name == "asset_models":
        return table.c.make + " " + table.c.model
    pk = next(iter(table.primary_key.columns))
    return cast(pk, String)


def check_guarded(table: Table, col: Column) -> bool:
    """True when a CHECK constraint on `table` mentions `col` — the column
    may be nullable, yet nulling it can trip the CHECK and roll the whole
    delete back (processed_scans_match_target_chk keeps the match_type
    target FK non-null)."""
    return any(
        isinstance(constraint, CheckConstraint)
        and re.search(rf"\b{re.escape(col.name)}\b", str(constraint.sqltext))
        for constraint in table.constraints)


def references_to(table: Table) -> Iterator[tuple[Table, Column, Column]]:
    """Yields (child_table, child_column, parent_column) for every column
    anywhere in the schema whose foreign key targets a primary-key column
    of `table` — the mechanism behind reference discovery, force-null and
    the cascade walk alike."""
    pk_cols = set(table.primary_key.columns)
    for other in Base.metadata.tables.values():
        for fk in other.foreign_keys:
            if fk.column in pk_cols:
                yield other, fk.parent, fk.column
```

- [ ] **Step 3: Point `devtools.py` at the shared helpers**

Delete the `_NAME_LABELED`, `_label_expr`, `_check_guarded` and `_references_to` definitions from `api/src/serversherpa/api/routes/devtools.py`. Add to its imports:

```python
from serversherpa.devtools.cascade import check_guarded, label_expr, references_to
```

In `_find_references`, change the loop header from `for table, col in _references_to(model):` to:

```python
    for table, col, _parent in references_to(model.__table__):
```

and the two body call sites from `_label_expr(...)` to `label_expr(...)` and `_check_guarded(table, col)` to `check_guarded(table, col)`. In `_detach_references`, change its loop header the same way. Leave `_other_fk`, `PURGE_ROW_TABLES` and `_ACTOR_COLUMNS` in `devtools.py` — they serve force mode only.

- [ ] **Step 4: Lint and re-run the baseline suites**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && .venv/bin/ruff check --select F401,E501 src/serversherpa/devtools/cascade.py src/serversherpa/api/routes/devtools.py && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_pending_deletes_api.py tests/test_devtools.py
```
Expected: ruff clean; the same counts as Step 1. Remove any import ruff reports as unused (`CheckConstraint`, `String`, `cast`, `re` may become unused in `devtools.py`).

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add api/src/serversherpa/devtools/cascade.py api/src/serversherpa/api/routes/devtools.py && git commit -m "refactor(devtools): share reference-discovery helpers from a cascade module

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The walk and the plan

**Files:**
- Modify: `api/src/serversherpa/devtools/cascade.py`
- Test: `api/tests/test_devtools_cascade.py` (create)

**Interfaces:**
- Consumes: `references_to`, `label_expr`, `check_guarded`, `MAX_DEPTH`, `NEVER_PURGE` (Task 1).
- Produces: `@dataclass(frozen=True) CascadeStep(table: str, column: str, action: str, count: int, labels: list[str], depth: int)` where `action` is one of `"purge" | "clear" | "db_cascade" | "db_set_null"`.
- Produces: `@dataclass CascadePlan(entity_type: str, entity_id: uuid.UUID, label: str, steps: list[CascadeStep], blocked: list[str], total_rows_deleted: int, total_rows_cleared: int)`.
- Produces: `async def collect_levels(db, table, entity_id, *, max_depth=MAX_DEPTH, protected_tables=frozenset()) -> tuple[list[_Level], list[str]]` — internal, consumed by Task 3's executor.
- Produces: `async def plan_cascade(db, model, entity_id, *, entity_type, label, max_depth=MAX_DEPTH, protected_tables=frozenset()) -> CascadePlan`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_devtools_cascade.py`:

```python
"""Cascade delete: the schema walk that decides what else dies with a
reconcile target, and the endpoints that preview and run it."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AccessGroup, AccessGroupMember, AuditLog, AuthSession, PendingDelete,
    Person, PersonRole, TimeEntry, UserAccount, WorkerProfile,
)
from serversherpa.devtools.cascade import plan_cascade
from serversherpa.security.passwords import hash_password
from tests.test_devtools import login, set_role


async def _developer(db, client, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    return await login(client)


async def _person_with_everything(db, *, first="Doomed", last="Person"):
    """A person carrying one row in each shape the walk must handle: a
    required dependent (user_accounts), a transitive dependent that FKs the
    dependent rather than the person (auth_sessions), a self-reference
    inside that table (replaced_by), plain required dependents, and a
    business record (time_entries)."""
    person = Person(first_name=first, last_name=last)
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email=f"{first.lower()}@test.example.com",
        password_hash=hash_password(
            "CorrectHorse9!",
            pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=person.id, role="staff"))
    db.add(WorkerProfile(person_id=person.id, status="active"))
    group = AccessGroup(name=f"Group {first}")
    db.add(group)
    await db.flush()
    db.add(AccessGroupMember(group_id=group.id, person_id=person.id))
    db.add(TimeEntry(person_id=person.id, started_at=datetime.now(UTC)))
    await db.flush()
    first_session = AuthSession(
        person_id=person.id, family_id=uuid.uuid4(), token_hash="a",
        expires_at=datetime.now(UTC))
    db.add(first_session)
    await db.flush()
    db.add(AuthSession(
        person_id=person.id, family_id=uuid.uuid4(), token_hash="b",
        expires_at=datetime.now(UTC), replaced_by=first_session.id))
    await db.commit()
    return person


def _step(plan, table, column=None):
    for s in plan.steps:
        if s.table == table and (column is None or s.column == column):
            return s
    return None


async def test_plan_classifies_every_reference_shape(db, seeded_user):
    person = await _person_with_everything(db)

    plan = await plan_cascade(db, Person, person.id,
                              entity_type="person", label="Doomed Person")

    assert plan.blocked == []
    # required dependents are purged
    for table in ("user_accounts", "person_roles", "worker_profiles",
                  "access_group_members", "time_entries"):
        step = _step(plan, table)
        assert step is not None, f"{table} missing from plan"
        assert step.action == "purge", f"{table} should purge, got {step.action}"
    # auth_sessions FKs user_accounts.person_id, not people.id — depth 1
    sessions = _step(plan, "auth_sessions", "person_id")
    assert sessions is not None and sessions.action == "purge"
    assert sessions.depth == 1
    assert sessions.count == 2
    # the self-reference inside auth_sessions is cleared, not purged
    replaced = _step(plan, "auth_sessions", "replaced_by")
    assert replaced is not None and replaced.action == "clear"
    # nullable provenance columns are cleared
    assert _step(plan, "audit_log").action == "clear"
    assert plan.total_rows_deleted >= 7


async def test_plan_reports_database_handled_foreign_keys(db, seeded_user):
    """notification_group_members.person_id declares ON DELETE CASCADE, so
    the database removes it — the plan must say so instead of purging it."""
    from serversherpa.db.models import NotificationGroup, NotificationGroupMember

    person = Person(first_name="Notified", last_name="Person")
    db.add(person)
    group = NotificationGroup(
        name="Ops", description="", channels=["email"],
        timezone="America/New_York", active_days=["mon"],
        dnd_behavior="defer", urgent_bypass=False, enabled=True)
    db.add_all([person, group])
    await db.flush()
    db.add(NotificationGroupMember(group_id=group.id, person_id=person.id))
    await db.commit()

    plan = await plan_cascade(db, Person, person.id,
                              entity_type="person", label="Notified Person")

    step = _step(plan, "notification_group_members", "person_id")
    assert step is not None
    assert step.action == "db_cascade"
    assert step.count == 1


async def test_plan_never_purges_the_audit_log(db, seeded_user):
    person = Person(first_name="Audited", last_name="Person")
    db.add(person)
    await db.flush()
    db.add(AuditLog(actor_person_id=person.id, entity_type="person",
                    entity_id=str(person.id), action="person.update", changes={}))
    await db.commit()

    plan = await plan_cascade(db, Person, person.id,
                              entity_type="person", label="Audited Person")

    step = _step(plan, "audit_log")
    assert step.action == "clear"
    assert all(s.action != "purge" or s.table != "audit_log" for s in plan.steps)


async def test_plan_refuses_to_take_another_deletable_record_with_it(db, seeded_user):
    """Nothing in today's schema requires one reconcile-able entity to point
    at another, so this pins the guard directly: name a table the walk will
    reach as protected and it must refuse rather than purge."""
    person = await _person_with_everything(db, first="Protected")

    plan = await plan_cascade(
        db, Person, person.id, entity_type="person", label="Protected Person",
        protected_tables=frozenset({"user_accounts"}))

    assert any("user_accounts" in reason for reason in plan.blocked)
    assert _step(plan, "user_accounts") is None


async def test_plan_blocks_when_depth_is_exhausted(db, seeded_user):
    person = await _person_with_everything(db, first="Shallow")

    plan = await plan_cascade(db, Person, person.id, entity_type="person",
                              label="Shallow Person", max_depth=0)

    assert plan.blocked != []
    assert any("depth" in reason.lower() for reason in plan.blocked)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_devtools_cascade.py
```
Expected: FAIL with `ImportError: cannot import name 'plan_cascade'` (5 tests).

If `TimeEntry(...)` or `AuthSession(...)` rejects those keyword arguments, open `api/src/serversherpa/db/models.py`, read the class, and pass every column without a server default. Do not change the models.

- [ ] **Step 3: Add the walk and the plan to `cascade.py`**

Append to `api/src/serversherpa/devtools/cascade.py`:

```python
@dataclass(frozen=True)
class CascadeStep:
    """One (table, column) the cascade touches, and how."""

    table: str
    column: str
    action: str          # purge | clear | db_cascade | db_set_null
    count: int
    labels: list[str]
    depth: int


@dataclass
class CascadePlan:
    entity_type: str
    entity_id: uuid.UUID
    label: str
    steps: list[CascadeStep]
    blocked: list[str]
    total_rows_deleted: int
    total_rows_cleared: int


@dataclass
class _Level:
    """Internal: a step plus the live key values it applies to, so the
    executor can act without re-deriving them from scratch."""

    table: Table
    column: Column
    action: str
    parent_values: list
    depth: int


def _fk_ondelete(table: Table, col: Column) -> str | None:
    for fk in table.foreign_keys:
        if fk.parent is col:
            return (fk.ondelete or "").upper() or None
    return None


async def collect_levels(
    db, table: Table, entity_id, *, max_depth: int = MAX_DEPTH,
    protected_tables: frozenset[str] = frozenset(),
) -> tuple[list[_Level], list[str]]:
    """Breadth-first walk from one doomed row. Returns the levels to act on
    and the reasons, if any, the cascade must refuse to run.

    `protected_tables` names tables whose rows are records in their own
    right (the reconcile-able entities). Reaching one is a refusal, not a
    purge: deleting a person must never quietly delete a site."""
    levels: list[_Level] = []
    blocked: list[str] = []
    seen: set[tuple[str, str]] = set()
    pk_col = next(iter(table.primary_key.columns))
    frontier = [(table, pk_col, [entity_id], 0)]

    while frontier:
        parent_table, parent_key, values, depth = frontier.pop(0)
        if not values:
            continue
        if depth > max_depth:
            blocked.append(
                f"{parent_table.name}: more than {max_depth} levels of "
                "dependent rows — refusing to walk further")
            continue
        for child_table, child_col, target_col in references_to(parent_table):
            key = (child_table.name, child_col.name)
            if key in seen:
                continue
            if target_col is not parent_key:
                blocked.append(
                    f"{child_table.name}.{child_col.name} references "
                    f"{parent_table.name}.{target_col.name}, which this walk "
                    "does not track")
                seen.add(key)
                continue
            count = await db.scalar(
                select(func.count()).select_from(child_table)
                .where(child_col.in_(values)))
            if not count:
                continue
            seen.add(key)
            ondelete = _fk_ondelete(child_table, child_col)
            if ondelete == "CASCADE":
                action = "db_cascade"
            elif ondelete == "SET NULL":
                action = "db_set_null"
            elif child_col.nullable and not check_guarded(child_table, child_col):
                action = "clear"
            elif child_col.nullable:
                blocked.append(
                    f"{child_table.name}.{child_col.name} is kept non-null by "
                    "a database rule — delete those rows first")
                continue
            elif child_table.name in NEVER_PURGE:
                blocked.append(
                    f"{child_table.name}.{child_col.name} is required and "
                    f"{child_table.name} is never deleted")
                continue
            elif child_table.name in protected_tables:
                # A record that can be marked for deletion in its own right
                # is never collateral: mark and reconcile it separately.
                blocked.append(
                    f"{child_table.name} rows point at this record and are "
                    "themselves deletable records — mark them for deletion "
                    "on their own instead")
                continue
            else:
                action = "purge"
            levels.append(_Level(table=child_table, column=child_col,
                                 action=action, parent_values=list(values),
                                 depth=depth))
            if action != "purge" or child_table is parent_table:
                continue
            child_pk = next(iter(child_table.primary_key.columns))
            if not any(True for _ in references_to(child_table)):
                continue
            child_ids = list(await db.scalars(
                select(child_pk).where(child_col.in_(values))))
            frontier.append((child_table, child_pk, child_ids, depth + 1))
    return levels, blocked


async def plan_cascade(
    db, model: type, entity_id, *, entity_type: str, label: str,
    max_depth: int = MAX_DEPTH,
    protected_tables: frozenset[str] = frozenset(),
) -> CascadePlan:
    """The preview: every row the cascade would destroy or detach, with
    counts and up to three sample labels each. Writes nothing."""
    levels, blocked = await collect_levels(
        db, model.__table__, entity_id, max_depth=max_depth,
        protected_tables=protected_tables)
    steps: list[CascadeStep] = []
    deleted = cleared = 0
    for level in levels:
        count = await db.scalar(
            select(func.count()).select_from(level.table)
            .where(level.column.in_(level.parent_values)))
        labels = [str(v) for v in await db.scalars(
            select(label_expr(level.table)).select_from(level.table)
            .where(level.column.in_(level.parent_values)).limit(3))]
        steps.append(CascadeStep(
            table=level.table.name, column=level.column.name,
            action=level.action, count=count or 0, labels=labels,
            depth=level.depth))
        if level.action == "purge":
            deleted += count or 0
        elif level.action == "clear":
            cleared += count or 0
    steps.sort(key=lambda s: (s.action != "purge", -s.depth, s.table))
    return CascadePlan(
        entity_type=entity_type, entity_id=entity_id, label=label,
        steps=steps, blocked=blocked,
        total_rows_deleted=deleted, total_rows_cleared=cleared)
```

Extend the module imports at the top to `import uuid`, `from dataclasses import dataclass`, and add `select` to the sqlalchemy import line.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: 5 passed.

If `test_plan_classifies_every_reference_shape` reports `auth_sessions` at depth 0, the walk followed `people.id` rather than `user_accounts.person_id` — check `references_to` is comparing `fk.column` identity against the parent table's primary-key columns.

- [ ] **Step 5: Lint and commit**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && .venv/bin/ruff check --select F401,E501 src/serversherpa/devtools/cascade.py tests/test_devtools_cascade.py
```
Expected: clean.

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add api/src/serversherpa/devtools/cascade.py api/tests/test_devtools_cascade.py && git commit -m "feat(devtools): cascade plan walks the reference graph below a doomed row

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Executing the plan

**Files:**
- Modify: `api/src/serversherpa/devtools/cascade.py`
- Test: `api/tests/test_devtools_cascade.py` (append)

**Interfaces:**
- Consumes: `collect_levels`, `CascadePlan` (Task 2).
- Produces: `async def execute_cascade(db, model, entity_id, *, max_depth=MAX_DEPTH, protected_tables=frozenset()) -> dict[str, dict[str, int]]` returning `{"deleted_rows": {table: n}, "cleared_references": {"table.column": n}}`. Raises `CascadeBlocked(reasons: list[str])` when the fresh walk is blocked. Deletes no target row and commits nothing — the caller owns both.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_devtools_cascade.py`:

```python
async def test_execute_removes_exactly_the_planned_rows(db, seeded_user):
    from sqlalchemy import delete as sa_delete

    from serversherpa.devtools.cascade import execute_cascade

    doomed = await _person_with_everything(db, first="Doomed")
    keeper = await _person_with_everything(db, first="Keeper")

    result = await execute_cascade(db, Person, doomed.id)
    await db.execute(sa_delete(Person.__table__).where(Person.id == doomed.id))
    await db.commit()

    assert result["deleted_rows"]["user_accounts"] == 1
    assert result["deleted_rows"]["auth_sessions"] == 2
    assert result["deleted_rows"]["time_entries"] == 1
    assert await db.get(Person, doomed.id) is None
    for model, col in ((UserAccount, UserAccount.person_id),
                       (PersonRole, PersonRole.person_id),
                       (WorkerProfile, WorkerProfile.person_id),
                       (AccessGroupMember, AccessGroupMember.person_id),
                       (TimeEntry, TimeEntry.person_id),
                       (AuthSession, AuthSession.person_id)):
        assert (await db.scalars(select(model).where(col == doomed.id))).first() is None
    # the untouched neighbour keeps every one of its rows
    for model, col in ((UserAccount, UserAccount.person_id),
                       (PersonRole, PersonRole.person_id),
                       (TimeEntry, TimeEntry.person_id)):
        assert (await db.scalars(select(model).where(col == keeper.id))).first() is not None
    assert (await db.scalars(
        select(AuthSession).where(AuthSession.person_id == keeper.id))).all()


async def test_execute_refuses_a_blocked_plan(db, seeded_user):
    from serversherpa.devtools.cascade import CascadeBlocked, execute_cascade

    person = await _person_with_everything(db, first="Blocked")

    try:
        await execute_cascade(db, Person, person.id, max_depth=0)
    except CascadeBlocked as exc:
        assert exc.reasons != []
    else:
        raise AssertionError("expected CascadeBlocked")

    await db.rollback()
    assert await db.get(Person, person.id) is not None
    assert (await db.scalars(
        select(UserAccount).where(UserAccount.person_id == person.id))).first() is not None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_devtools_cascade.py -k execute
```
Expected: FAIL with `cannot import name 'execute_cascade'`.

- [ ] **Step 3: Add the executor**

Append to `api/src/serversherpa/devtools/cascade.py`:

```python
class CascadeBlocked(Exception):
    """The walk found something it will not destroy. Carries every reason
    so the caller can show them all rather than the first."""

    def __init__(self, reasons: list[str]):
        super().__init__("; ".join(reasons))
        self.reasons = reasons


async def execute_cascade(
    db, model: type, entity_id, *, max_depth: int = MAX_DEPTH,
    protected_tables: frozenset[str] = frozenset(),
) -> dict[str, dict[str, int]]:
    """Apply the cascade for one doomed row: clear every detachable
    reference, then delete dependent rows deepest-first. The caller deletes
    the target row itself and owns the transaction — nothing here commits.

    The walk is repeated against live rows rather than replaying the
    preview's identifiers, so a row added since the preview is destroyed
    too and the returned counts are the truth."""
    levels, blocked = await collect_levels(
        db, model.__table__, entity_id, max_depth=max_depth,
        protected_tables=protected_tables)
    if blocked:
        raise CascadeBlocked(blocked)

    cleared: dict[str, int] = {}
    deleted: dict[str, int] = {}
    # Clears first, at any depth: a nulled column never blocks a delete,
    # and the self-reference inside a purged table (auth_sessions.
    # replaced_by) has to go before that table's rows do.
    for level in (lvl for lvl in levels if lvl.action == "clear"):
        result = await db.execute(
            update(level.table)
            .where(level.column.in_(level.parent_values))
            .values({level.column.name: None}))
        if result.rowcount:
            key = f"{level.table.name}.{level.column.name}"
            cleared[key] = cleared.get(key, 0) + result.rowcount
    # Then purges, deepest first, so children die before their parents.
    for level in sorted((lvl for lvl in levels if lvl.action == "purge"),
                        key=lambda lvl: -lvl.depth):
        result = await db.execute(
            delete(level.table).where(level.column.in_(level.parent_values)))
        if result.rowcount:
            deleted[level.table.name] = (
                deleted.get(level.table.name, 0) + result.rowcount)
    await db.flush()
    return {"deleted_rows": deleted, "cleared_references": cleared}
```

Add `delete` and `update` to the module's sqlalchemy import line.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_devtools_cascade.py
```
Expected: 7 passed.

If the purge of `auth_sessions` fails on `replaced_by`, the clear phase did not cover it — confirm the walk emits a `clear` level for the self-reference and that clears run before purges.

- [ ] **Step 5: Lint and commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && .venv/bin/ruff check --select F401,E501 src/serversherpa/devtools/cascade.py tests/test_devtools_cascade.py
```

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add api/src/serversherpa/devtools/cascade.py api/tests/test_devtools_cascade.py && git commit -m "feat(devtools): execute a cascade plan, clears first then deepest purges

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Preview and delete endpoints

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (append after `PendingDeleteReconcileOut`, ~line 1534; and add one field to `PendingDeleteReference`, ~line 1504)
- Modify: `api/src/serversherpa/api/routes/devtools.py` (after `reconcile_pending_delete`, ~line 382)
- Test: `api/tests/test_devtools_cascade.py` (append)

**Interfaces:**
- Consumes: `plan_cascade`, `execute_cascade`, `CascadeBlocked` (Tasks 2–3); `DELETABLE`, `_err`, `audit` (existing in `devtools.py`).
- Produces: `GET /devtools/pending-deletes/{marker_id}/cascade-preview -> CascadePlanOut`; `POST /devtools/pending-deletes/{marker_id}/cascade-delete` body `CascadeDeleteIn` `-> PendingDeleteReconcileOut`.
- Produces: `PendingDeleteReference.db_handled: bool` — the portal mirrors this field in Task 5.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_devtools_cascade.py`:

```python
async def _marker(db, person, label):
    marker = PendingDelete(entity_type="person", entity_id=person.id,
                           entity_label=label)
    db.add(marker)
    await db.commit()
    return marker


async def test_preview_lists_the_plan(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    person = await _person_with_everything(db, first="Preview")
    marker = await _marker(db, person, "Preview Person")

    resp = await client.get(
        f"/devtools/pending-deletes/{marker.id}/cascade-preview", headers=hdrs)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["label"] == "Preview Person"
    assert body["blocked"] == []
    assert body["total_rows_deleted"] >= 7
    by_table = {(s["table"], s["column"]): s for s in body["steps"]}
    assert by_table[("user_accounts", "person_id")]["action"] == "purge"
    assert by_table[("auth_sessions", "person_id")]["depth"] == 1
    assert by_table[("audit_log", "actor_person_id")]["action"] == "clear"
    # purges sort ahead of clears so the destructive rows read first
    assert body["steps"][0]["action"] == "purge"


async def test_preview_404s_for_an_unknown_marker(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get(
        f"/devtools/pending-deletes/{uuid.uuid4()}/cascade-preview", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "marker_not_found"


async def test_cascade_delete_destroys_everything_and_audits(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    person = await _person_with_everything(db, first="Gone")
    marker = await _marker(db, person, "Gone Person")

    resp = await client.post(
        f"/devtools/pending-deletes/{marker.id}/cascade-delete", headers=hdrs,
        json={"confirm_label": "Gone Person"})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"deleted": 1, "failed": []}
    assert await db.get(Person, person.id) is None
    assert await db.get(PendingDelete, marker.id) is None
    assert (await db.scalars(
        select(AuthSession).where(AuthSession.person_id == person.id))).first() is None

    log = await db.scalar(
        select(AuditLog).where(AuditLog.action == "cascade_delete"))
    assert log is not None
    assert log.entity_id == str(person.id)
    assert log.changes["label"] == "Gone Person"
    assert log.changes["deleted_rows"]["user_accounts"] == 1


async def test_cascade_delete_requires_the_exact_label(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    person = await _person_with_everything(db, first="Safe")
    marker = await _marker(db, person, "Safe Person")

    resp = await client.post(
        f"/devtools/pending-deletes/{marker.id}/cascade-delete", headers=hdrs,
        json={"confirm_label": "safe person"})

    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "label_mismatch"
    assert await db.get(Person, person.id) is not None

    # surrounding whitespace is forgiven
    resp = await client.post(
        f"/devtools/pending-deletes/{marker.id}/cascade-delete", headers=hdrs,
        json={"confirm_label": "  Safe Person  "})
    assert resp.status_code == 200, resp.text
    assert await db.get(Person, person.id) is None


async def test_cascade_delete_refuses_a_marker_without_a_label(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    person = await _person_with_everything(db, first="Nameless")
    marker = await _marker(db, person, "")

    resp = await client.post(
        f"/devtools/pending-deletes/{marker.id}/cascade-delete", headers=hdrs,
        json={"confirm_label": ""})

    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "label_unavailable"
    assert await db.get(Person, person.id) is not None


async def test_references_report_marks_database_handled_foreign_keys(
        client, db, seeded_user):
    """The failure list used to present an ON DELETE CASCADE reference as a
    blocker; it never was."""
    from serversherpa.db.models import NotificationGroup, NotificationGroupMember

    hdrs = await _developer(db, client, seeded_user)
    person = Person(first_name="Reported", last_name="Person")
    group = NotificationGroup(
        name="Ops2", description="", channels=["email"],
        timezone="America/New_York", active_days=["mon"],
        dnd_behavior="defer", urgent_bypass=False, enabled=True)
    db.add_all([person, group])
    await db.flush()
    db.add(NotificationGroupMember(group_id=group.id, person_id=person.id))
    db.add(PersonRole(person_id=person.id, role="staff"))
    marker = await _marker(db, person, "Reported Person")

    resp = await client.post(
        f"/devtools/pending-deletes/{marker.id}/reconcile", headers=hdrs)

    failure = resp.json()["failed"][0]
    refs = {(r["table"], r["column"]): r for r in failure["references"]}
    assert refs[("notification_group_members", "person_id")]["db_handled"] is True
    assert refs[("person_roles", "person_id")]["db_handled"] is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_devtools_cascade.py
```
Expected: the six new tests FAIL (404 / 405 for the new routes, `KeyError: 'db_handled'` for the last).

- [ ] **Step 3: Add the schemas**

In `api/src/serversherpa/api/schemas.py`, add one field to `PendingDeleteReference` directly after `check_guarded`:

```python
    # True when the foreign key itself declares ON DELETE CASCADE or SET
    # NULL: the database clears this reference on delete, so it never
    # blocked anything and must not be reported as a blocker.
    db_handled: bool = False
```

Append after `PendingDeleteReconcileOut`:

```python
class CascadeStepOut(BaseModel):
    """One (table, column) a cascade delete touches, and how."""

    table: str
    column: str
    action: str          # purge | clear | db_cascade | db_set_null
    count: int
    labels: list[str] = []
    depth: int


class CascadePlanOut(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    label: str
    steps: list[CascadeStepOut] = []
    # non-empty means the cascade will refuse to run, with these reasons
    blocked: list[str] = []
    total_rows_deleted: int
    total_rows_cleared: int


class CascadeDeleteIn(BaseModel):
    """The record's own label, typed by the operator. Guards against a
    stale preview in a forgotten browser tab destroying the wrong row."""

    confirm_label: str
    model_config = ConfigDict(extra="forbid")
```

- [ ] **Step 4: Add the endpoints and the reporting fix**

In `api/src/serversherpa/api/routes/devtools.py` extend the imports:

```python
from serversherpa.api.schemas import (
    CascadeDeleteIn, CascadePlanOut, DbBackupCreateIn, DbBackupItem,
    DbTestingChanges, DbTestingEndIn, DbTestingSessionOut, DbTestingStartIn,
    DbTestingStatusOut, DbTestingTableChange, GodModeIn, PendingDeleteCreateIn,
    PendingDeleteFailure, PendingDeleteOut, PendingDeleteReconcileOut,
    PendingDeleteReference,
)
from serversherpa.devtools.cascade import (
    CascadeBlocked, check_guarded, execute_cascade, label_expr, plan_cascade,
    references_to,
)
```

In `_find_references`, fill the new field. Add above the `refs.append(...)` call:

```python
        ondelete = next((fk.ondelete or "" for fk in table.foreign_keys
                         if fk.parent is col), "").upper()
```

and pass `db_handled=ondelete in ("CASCADE", "SET NULL"),` into `PendingDeleteReference(...)`.

Add after `reconcile_pending_delete`:

```python
async def _load_marker(db: DbSession, marker_id: uuid.UUID) -> PendingDelete:
    marker = await db.get(PendingDelete, marker_id)
    if marker is None:
        raise _err(404, "marker_not_found")
    return marker


def _protected_tables(model: type) -> frozenset[str]:
    """Every reconcile-able entity's table except the target's own: those
    are records in their own right and must never be collateral."""
    return frozenset(
        m.__table__.name for m in DELETABLE.values()
        if m.__table__.name != model.__table__.name)


@router.get("/pending-deletes/{marker_id}/cascade-preview",
            response_model=CascadePlanOut)
async def cascade_preview(
    marker_id: uuid.UUID,
    db: DbSession,
    _actor: AuthContext = require_permission("devtools", "change"),
) -> CascadePlanOut:
    """Everything a cascade delete would destroy or detach for one marker.
    Writes nothing — the same walk the delete runs, reported instead of
    applied, so the two can never disagree."""
    marker = await _load_marker(db, marker_id)
    model = DELETABLE[marker.entity_type]
    plan = await plan_cascade(
        db, model, marker.entity_id, entity_type=marker.entity_type,
        label=marker.entity_label, protected_tables=_protected_tables(model))
    return CascadePlanOut(**plan.__dict__)


@router.post("/pending-deletes/{marker_id}/cascade-delete",
             response_model=PendingDeleteReconcileOut)
async def cascade_delete(
    marker_id: uuid.UUID,
    body: CascadeDeleteIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> PendingDeleteReconcileOut:
    """Delete a marked record and every row attached to it. Irreversible,
    so the caller must type the record's own label back: a stale preview in
    a forgotten tab cannot destroy whatever now sits at this marker."""
    marker = await _load_marker(db, marker_id)
    if not marker.entity_label.strip():
        raise _err(422, "label_unavailable")
    if body.confirm_label.strip() != marker.entity_label.strip():
        raise _err(422, "label_mismatch")

    model = DELETABLE[marker.entity_type]
    target_table = model.__table__
    target_pk = next(iter(target_table.primary_key.columns))
    entity_type, entity_id = marker.entity_type, marker.entity_id
    label = marker.entity_label
    try:
        async with db.begin_nested():
            counts = await execute_cascade(
                db, model, entity_id,
                protected_tables=_protected_tables(model))
            await db.execute(
                delete(target_table).where(target_pk == entity_id))
            await db.flush()
            audit(db, actor_id=actor.person.id, entity_type=entity_type,
                  entity_id=str(entity_id), action="cascade_delete",
                  changes={"label": label, **counts})
            await db.delete(marker)
            await db.flush()
    except CascadeBlocked as exc:
        raise _err(409, "cascade_blocked", reasons=exc.reasons) from exc
    except IntegrityError:
        await db.rollback()
        return PendingDeleteReconcileOut(deleted=0, failed=[
            PendingDeleteFailure(
                entity_type=entity_type, entity_id=entity_id, label=label,
                reason="fk_violation",
                references=await _find_references(db, model, entity_id))])
    await db.commit()
    return PendingDeleteReconcileOut(deleted=1, failed=[])
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail .venv/bin/pytest -q --no-header -p no:cacheprovider tests/test_devtools_cascade.py tests/test_pending_deletes_api.py tests/test_devtools.py
```
Expected: all pass.

If `CascadeBlocked` escapes the `begin_nested()` block without rolling back, move the `plan`/`blocked` check ahead of the savepoint by calling `plan_cascade` first and raising on `plan.blocked`.

- [ ] **Step 6: Lint and commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api && .venv/bin/ruff check --select F401,E501 src/serversherpa/api/routes/devtools.py src/serversherpa/api/schemas.py tests/test_devtools_cascade.py
```

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add api/src/serversherpa/api/routes/devtools.py api/src/serversherpa/api/schemas.py api/tests/test_devtools_cascade.py && git commit -m "feat(devtools): cascade preview and cascade delete endpoints

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Portal API client and the force-delete reporting fix

**Files:**
- Modify: `portal/src/lib/api.ts` (the pending-delete block, ~lines 2655–2705)
- Modify: `portal/src/lib/pendingDeletes.ts:20-27`
- Test: `portal/src/lib/pendingDeletes.test.ts` (create or append if present)

**Interfaces:**
- Produces: `CascadeStep`, `CascadePlan`, `getCascadePreview(markerId): Promise<CascadePlan>`, `cascadeDelete(markerId, confirmLabel): Promise<PendingDeleteReconcileOut>`, `PendingDeleteReference.db_handled: boolean`.

- [ ] **Step 1: Write the failing test**

Create `portal/src/lib/pendingDeletes.test.ts` (if it exists, append the `describe` block and merge imports):

```ts
import { describe, expect, it } from 'vitest';

import { canForceDelete } from './pendingDeletes';
import type { PendingDeleteReference } from './api';

const ref = (over: Partial<PendingDeleteReference>): PendingDeleteReference => ({
  table: 't', column: 'c', nullable: false, purgeable: false,
  check_guarded: false, db_handled: false, count: 1, labels: [], ...over,
});

describe('canForceDelete', () => {
  it('accepts nullable and purgeable references', () => {
    expect(canForceDelete([ref({ nullable: true }), ref({ purgeable: true })])).toBe(true);
  });

  it('rejects a required reference', () => {
    expect(canForceDelete([ref({})])).toBe(false);
  });

  it('rejects a check-guarded nullable reference', () => {
    expect(canForceDelete([ref({ nullable: true, check_guarded: true })])).toBe(false);
  });

  it('treats a database-handled reference as already satisfied', () => {
    expect(canForceDelete([ref({ db_handled: true })])).toBe(true);
    expect(canForceDelete([ref({ db_handled: true }), ref({})])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/lib/pendingDeletes.test.ts`
Expected: FAIL — the `db_handled` case returns false, and TypeScript rejects the unknown property.

- [ ] **Step 3: Add the types and helpers to `portal/src/lib/api.ts`**

Add one field to `PendingDeleteReference`, after `check_guarded`:

```ts
  /** the foreign key declares ON DELETE CASCADE or SET NULL, so the
   *  database clears it on delete — it never blocked anything */
  db_handled: boolean;
```

Insert after `reconcilePendingDelete`:

```ts
/* ── cascade delete override ───────────────────────────────────── */

export interface CascadeStep {
  table: string;
  column: string;
  /** purge deletes the rows; clear nulls the column; db_* is the
   *  database's own ON DELETE rule doing it for us */
  action: 'purge' | 'clear' | 'db_cascade' | 'db_set_null';
  count: number;
  labels: string[];
  depth: number;
}

export interface CascadePlan {
  entity_type: string;
  entity_id: string;
  label: string;
  steps: CascadeStep[];
  /** non-empty means the delete will refuse to run, with these reasons */
  blocked: string[];
  total_rows_deleted: number;
  total_rows_cleared: number;
}

/** Everything a cascade delete would destroy for one marker. Read-only —
 *  the server builds it with the same walk the delete runs. */
export async function getCascadePreview(markerId: string): Promise<CascadePlan> {
  const resp = await apiFetch(`/devtools/pending-deletes/${markerId}/cascade-preview`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Irreversible. `confirmLabel` must equal the marker's own label or the
 *  server refuses with `label_mismatch`. */
export async function cascadeDelete(
  markerId: string, confirmLabel: string,
): Promise<PendingDeleteReconcileOut> {
  const resp = await apiFetch(`/devtools/pending-deletes/${markerId}/cascade-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm_label: confirmLabel }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 4: Teach `canForceDelete` about `db_handled`**

In `portal/src/lib/pendingDeletes.ts` replace the predicate body:

```ts
export function canForceDelete(references: PendingDeleteReference[]): boolean {
  return references.length > 0
    && references.every((r) => r.db_handled
      || (r.nullable && !r.check_guarded) || r.purgeable);
}
```

Extend the doc comment above it with: `A db_handled reference is cleared by the database's own ON DELETE rule, so it never stood in the way.`

- [ ] **Step 5: Run the tests and type-check**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/lib/pendingDeletes.test.ts src/pages/DevDatabase.test.tsx && npx tsc -b --noEmit`
Expected: all pass, tsc clean. If `DevDatabase.test.tsx` fixtures construct a `PendingDeleteReference` without `db_handled`, add the field to those fixtures.

- [ ] **Step 6: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add portal/src/lib/api.ts portal/src/lib/pendingDeletes.ts portal/src/lib/pendingDeletes.test.ts portal/src/pages/DevDatabase.test.tsx && git commit -m "feat(portal): cascade delete API client; force delete stops counting db-handled references as blockers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The cascade delete modal

**Files:**
- Create: `portal/src/components/dev/CascadeDeleteModal.tsx`
- Modify: `portal/src/styles/system.css` (append)
- Test: `portal/src/components/dev/CascadeDeleteModal.test.tsx` (create)

**Interfaces:**
- Consumes: `getCascadePreview`, `cascadeDelete`, `CascadePlan`, `PendingDeleteReconcileOut`, `ApiError` (Task 5); `DataTable` from `portal/src/components/DataTable`.
- Produces: `CascadeDeleteModal` default export with props `{ markerId: string; label: string; onClose(): void; onDeleted(result: PendingDeleteReconcileOut): void }`.

- [ ] **Step 1: Write the failing tests**

Create `portal/src/components/dev/CascadeDeleteModal.test.tsx`:

```tsx
// @vitest-environment jsdom
/**
 * The override modal: it must show what will die before it will let you
 * kill it, and the destroy button stays inert until the record's own name
 * is typed back.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CascadePlan } from '../../lib/api';

const api = vi.hoisted(() => ({
  getCascadePreview: vi.fn(),
  cascadeDelete: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const PLAN: CascadePlan = {
  entity_type: 'person',
  entity_id: 'p1',
  label: 'Guido Huizing',
  steps: [
    { table: 'user_accounts', column: 'person_id', action: 'purge', count: 1, labels: ['guido@x.test'], depth: 0 },
    { table: 'auth_sessions', column: 'person_id', action: 'purge', count: 2, labels: [], depth: 1 },
    { table: 'audit_log', column: 'actor_person_id', action: 'clear', count: 5, labels: [], depth: 0 },
    { table: 'notification_group_members', column: 'person_id', action: 'db_cascade', count: 1, labels: ['Ops'], depth: 0 },
  ],
  blocked: [],
  total_rows_deleted: 3,
  total_rows_cleared: 5,
};

const onClose = vi.fn();
const onDeleted = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  api.getCascadePreview.mockResolvedValue(PLAN);
  api.cascadeDelete.mockResolvedValue({ deleted: 1, failed: [] });
});
afterEach(cleanup);

const { default: CascadeDeleteModal } = await import('./CascadeDeleteModal');

const renderModal = () => render(
  <CascadeDeleteModal markerId="m1" label="Guido Huizing"
                      onClose={onClose} onDeleted={onDeleted} />,
);

it('renders every step with its wording and counts', async () => {
  renderModal();
  expect(await screen.findByRole('table', { name: 'Cascade delete plan' })).toBeTruthy();
  expect(screen.getByText('user_accounts')).toBeTruthy();
  expect(screen.getAllByText('Deleted').length).toBe(2);
  expect(screen.getByText('Reference cleared')).toBeTruthy();
  expect(screen.getByText('Handled by the database')).toBeTruthy();
  expect(screen.getByText(/3 rows in 2 tables will be permanently deleted/)).toBeTruthy();
});

it('keeps the destroy button disabled until the label is typed exactly', async () => {
  renderModal();
  const button = await screen.findByRole('button', { name: 'Delete permanently' });
  expect(button).toBeDisabled();
  const field = screen.getByLabelText(/Type Guido Huizing to confirm/);
  fireEvent.change(field, { target: { value: 'guido huizing' } });
  expect(button).toBeDisabled();
  fireEvent.change(field, { target: { value: '  Guido Huizing  ' } });
  expect(button).not.toBeDisabled();
});

it('posts the typed label and reports the result', async () => {
  renderModal();
  const button = await screen.findByRole('button', { name: 'Delete permanently' });
  fireEvent.change(screen.getByLabelText(/Type Guido Huizing to confirm/),
                   { target: { value: 'Guido Huizing' } });
  fireEvent.click(button);
  await waitFor(() => expect(api.cascadeDelete).toHaveBeenCalledWith('m1', 'Guido Huizing'));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ deleted: 1, failed: [] }));
});

it('never enables the button for a blocked plan', async () => {
  api.getCascadePreview.mockResolvedValue({
    ...PLAN, blocked: ['processed_scans.person_id is kept non-null by a database rule'] });
  renderModal();
  expect(await screen.findByText(/kept non-null by a database rule/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Type Guido Huizing to confirm/),
                   { target: { value: 'Guido Huizing' } });
  expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
});

it('keeps itself open and explains a server refusal', async () => {
  const { ApiError } = await import('../../lib/api');
  api.cascadeDelete.mockRejectedValue(new ApiError(422, 'label_mismatch'));
  renderModal();
  fireEvent.change(await screen.findByLabelText(/Type Guido Huizing to confirm/),
                   { target: { value: 'Guido Huizing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
  expect(await screen.findByText(/name did not match/i)).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

it('offers a retry when the preview cannot be built', async () => {
  api.getCascadePreview.mockRejectedValueOnce(new Error('network'));
  renderModal();
  expect(await screen.findByText('Could not build the delete plan.')).toBeTruthy();
  api.getCascadePreview.mockResolvedValue(PLAN);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('table', { name: 'Cascade delete plan' })).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/components/dev/CascadeDeleteModal.test.tsx`
Expected: FAIL — module `./CascadeDeleteModal` not found.

- [ ] **Step 3: Create the modal**

Create `portal/src/components/dev/CascadeDeleteModal.tsx`:

```tsx
/**
 * CascadeDeleteModal — the override behind Reconcile's "Cannot force" dead
 * end. It shows every row that will be destroyed before it will destroy
 * any of them, and the destroy button stays inert until the operator types
 * the record's own name back.
 */
import { useCallback, useEffect, useState } from 'react';

import DataTable from '../DataTable';
import {
  ApiError, cascadeDelete, getCascadePreview,
  type CascadePlan, type CascadeStep, type PendingDeleteReconcileOut,
} from '../../lib/api';

const ACTION_LABEL: Record<CascadeStep['action'], string> = {
  purge: 'Deleted',
  clear: 'Reference cleared',
  db_cascade: 'Handled by the database',
  db_set_null: 'Handled by the database',
};

const ERRORS: Record<string, string> = {
  label_mismatch: 'That name did not match this record — nothing was deleted.',
  label_unavailable: 'This record has no name to confirm against, so it cannot be deleted here.',
  cascade_blocked: 'The plan changed and now includes something that cannot be deleted. Review it and try again.',
  marker_not_found: 'This record is no longer pending deletion.',
};

export default function CascadeDeleteModal({ markerId, label, onClose, onDeleted }: {
  markerId: string;
  label: string;
  onClose: () => void;
  onDeleted: (result: PendingDeleteReconcileOut) => void;
}) {
  const [plan, setPlan] = useState<CascadePlan | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setPlan(await getCascadePreview(markerId));
    } catch {
      setLoadError(true);
    }
  }, [markerId]);

  useEffect(() => { void load(); }, [load]);

  const blocked = (plan?.blocked.length ?? 0) > 0;
  const confirmed = typed.trim() === label.trim() && label.trim() !== '';
  const tables = new Set(plan?.steps.filter((s) => s.action === 'purge')
    .map((s) => s.table)).size;

  const destroy = async () => {
    setBusy(true);
    setError('');
    try {
      onDeleted(await cascadeDelete(markerId, typed.trim()));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError(ERRORS[code] ?? 'Could not delete — try again.');
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className="modal-card reports-modal-card rgm-card dev-cascade-card"
           role="dialog" aria-label="Cascade delete">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Database</div>
            <h3>Delete {label} and everything attached</h3>
            <p className="page-hint">
              This cannot be undone. Every row listed below is destroyed permanently.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close"
                  onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>

        <div className="modal-body">
          {loadError && (
            <div className="dir-empty">
              <b>Could not build the delete plan.</b>
              <button type="button" className="mini-btn" style={{ marginTop: 8 }}
                      onClick={() => void load()}>Retry</button>
            </div>
          )}

          {!loadError && plan === null && (
            <p className="set-note" style={{ padding: 0 }}>Building the plan…</p>
          )}

          {plan !== null && (
            <>
              <div className="dev-cascade-summary">
                <span className="chip c-red">
                  <span className="dot" />
                  {plan.total_rows_deleted} row{plan.total_rows_deleted === 1 ? '' : 's'}
                  {' '}in {tables} table{tables === 1 ? '' : 's'} will be permanently deleted
                </span>
                {plan.total_rows_cleared > 0 && (
                  <span className="chip tag">
                    {plan.total_rows_cleared} reference
                    {plan.total_rows_cleared === 1 ? '' : 's'} will be cleared
                  </span>
                )}
              </div>

              {blocked && (
                <div className="dir-empty" style={{ marginBottom: 12 }}>
                  <b>This record cannot be deleted yet</b>
                  <ul className="dev-cascade-blocked">
                    {plan.blocked.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                </div>
              )}

              <DataTable ariaLabel="Cascade delete plan" emptyText="Nothing else references this record"
                columns={[
                  { key: 'table', label: 'Table' },
                  { key: 'action', label: 'What happens' },
                  { key: 'count', label: 'Rows', align: 'right' },
                  { key: 'examples', label: 'Examples' },
                ]}
                rows={plan.steps.map((s) => ({
                  key: `${s.table}.${s.column}`,
                  cells: [
                    <span className="mono">{s.table}</span>,
                    ACTION_LABEL[s.action],
                    String(s.count),
                    s.labels.length > 0 ? s.labels.join(', ') : '—',
                  ],
                }))} />

              <div className="pf-form dev-cascade-confirm">
                <div className="full">
                  <label htmlFor="cascade-confirm">Type {label} to confirm</label>
                  <input id="cascade-confirm" value={typed} autoComplete="off"
                         disabled={busy || blocked}
                         onChange={(e) => setTyped(e.target.value)} />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn-solid btn-danger"
                  disabled={busy || blocked || !confirmed || plan === null}
                  onClick={() => void destroy()}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the layout CSS**

Append to `portal/src/styles/system.css`:

```css
/* ── cascade delete override (Dev › Database › Reconcile) ────────── */

.modal-card.reports-modal-card.rgm-card.dev-cascade-card {
  width: min(880px, 96vw);
  max-width: 96vw;
}
.dev-cascade-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.dev-cascade-blocked { margin: 6px 0 0; padding-left: 18px; text-align: left; }
.dev-cascade-confirm { margin-top: 16px; }
```

No typography properties, so the guardrail stays green.

- [ ] **Step 5: Run the tests and type-check**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/components/dev/CascadeDeleteModal.test.tsx src/styles/listTypography.test.ts && npx tsc -b --noEmit`
Expected: 6 passed, guardrail green, tsc clean.

If React warns about missing keys on the `DataTable` cells, wrap each JSX cell in a keyed fragment. Test output must be pristine.

- [ ] **Step 6: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add portal/src/components/dev/CascadeDeleteModal.tsx portal/src/components/dev/CascadeDeleteModal.test.tsx portal/src/styles/system.css && git commit -m "feat(portal): cascade delete modal previews every row before destroying it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire the override into the Reconcile tab

**Files:**
- Modify: `portal/src/pages/DevDatabase.tsx` (the failure list, ~lines 232–275)
- Test: `portal/src/pages/DevDatabase.test.tsx` (append)

**Interfaces:**
- Consumes: `CascadeDeleteModal` (Task 6), `canForceDelete` (Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `portal/src/pages/DevDatabase.test.tsx` (read the file's existing mocks first; add `getCascadePreview` and `cascadeDelete` to its hoisted api object, and `db_handled: false` to any existing reference fixture):

```tsx
it('offers the override where force delete is impossible', async () => {
  // a required reference: force cannot help, the override must be offered
  await renderReconcileWithFailure([
    { table: 'person_roles', column: 'person_id', nullable: false, purgeable: false,
      check_guarded: false, db_handled: false, count: 1, labels: [] },
  ]);
  expect(await screen.findByRole('button', {
    name: 'Override — delete this and everything attached' })).toBeTruthy();
  expect(screen.queryByText(/Cannot force/)).toBeNull();
});

it('does not count a database-handled reference as a blocker', async () => {
  await renderReconcileWithFailure([
    { table: 'notification_group_members', column: 'person_id', nullable: false,
      purgeable: false, check_guarded: false, db_handled: true, count: 1, labels: ['Ops'] },
  ]);
  expect(await screen.findByText(/handled automatically by the database/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Force delete — detach references' })).toBeTruthy();
});

it('opens the override modal and refreshes after it deletes', async () => {
  await renderReconcileWithFailure([
    { table: 'person_roles', column: 'person_id', nullable: false, purgeable: false,
      check_guarded: false, db_handled: false, count: 1, labels: [] },
  ]);
  fireEvent.click(await screen.findByRole('button', {
    name: 'Override — delete this and everything attached' }));
  expect(await screen.findByRole('dialog', { name: 'Cascade delete' })).toBeTruthy();
});
```

Add a `renderReconcileWithFailure(references)` helper to the file that renders the page, resolves `listPendingDeletes` with one marker, clicks Reconcile, and resolves `reconcilePendingDeletes` with a single failure carrying those references. Model it on the file's existing reconcile test.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/pages/DevDatabase.test.tsx`
Expected: the three new tests FAIL.

- [ ] **Step 3: Wire the page**

In `portal/src/pages/DevDatabase.tsx`:

Add the import `import CascadeDeleteModal from '../components/dev/CascadeDeleteModal';` and state `const [cascadeFor, setCascadeFor] = useState<PendingDeleteFailure | null>(null);`.

In the failure list, replace the `canForce ? (…) : (…)` block's else branch and extend the reference wording. The reference line gains, before the `check_guarded` clause:

```tsx
                            {r.db_handled
                              && ' — handled automatically by the database'}
```

and the button area becomes:

```tsx
                    {f.references.length > 0 && (
                      <div className="dev-cascade-actions">
                        {canForce && (
                          <button
                            type="button"
                            className="mini-btn sm danger"
                            disabled={busyId !== null}
                            onClick={() => void handleForceDelete(f)}
                          >
                            Force delete — detach references
                          </button>
                        )}
                        <button
                          type="button"
                          className="mini-btn sm danger"
                          disabled={busyId !== null}
                          onClick={() => setCascadeFor(f)}
                        >
                          Override — delete this and everything attached
                        </button>
                      </div>
                    )}
```

The `checkGuarded` const and the two "Cannot force" strings are removed; delete them and anything left unused.

Render the modal near the page's other modals. The marker id comes from the pending list, keyed by entity id — reuse the page's existing marker lookup (the same one `handleForceDelete` uses to call `reconcilePendingDelete`):

```tsx
      {cascadeFor && (
        <CascadeDeleteModal
          markerId={markerIdFor(cascadeFor)}
          label={cascadeFor.label}
          onClose={() => setCascadeFor(null)}
          onDeleted={(res) => {
            setCascadeFor(null);
            setResult(res);
            void refresh();
          }}
        />
      )}
```

Read `handleForceDelete` first and reuse its exact marker-lookup expression and refresh call rather than inventing `markerIdFor` and `refresh` if they are named differently.

Append to `portal/src/styles/system.css`:

```css
.dev-cascade-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
```

- [ ] **Step 4: Run the tests, type-check, guardrail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run src/pages/DevDatabase.test.tsx src/styles/listTypography.test.ts && npx tsc -b --noEmit`
Expected: all pass, guardrail green, tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && git add portal/src/pages/DevDatabase.tsx portal/src/pages/DevDatabase.test.tsx portal/src/styles/system.css && git commit -m "feat(portal): Reconcile offers the cascade override instead of a dead end

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Full suites and live verification

- [ ] **Step 1: Full API suite**

The suite runs ~18 minutes, which exceeds the foreground tool timeout. Run it detached to a log and poll until the summary line appears:

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && rm -f .devlogs/api-cascade.log && (PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src SS_TEST_DB=serversherpa_test_user_detail nohup api/.venv/bin/pytest -q --no-header -p no:cacheprovider api/tests > .devlogs/api-cascade.log 2>&1 &) ; until grep -qE "^[0-9]+ (passed|failed)" .devlogs/api-cascade.log 2>/dev/null; do sleep 20; done; tail -2 .devlogs/api-cascade.log
```
Expected: `1838 passed` plus the new cascade tests, no failures.

- [ ] **Step 2: Full portal suite, type-check, build**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/portal && npx vitest run && npx tsc -b --noEmit && npm run build`
Expected: all green.

- [ ] **Step 3: Live verification**

The dev stack for this branch runs on API port 8001 and portal port 5175 (ports 8000/5173/5174 belong to another session's worktree — do not touch them). If they are not running:

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail && (PYTHONPATH=/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-detail/api/src nohup api/.venv/bin/python -m uvicorn --reload --factory serversherpa.api.app:create_app --app-dir api/src --host 0.0.0.0 --port 8001 > .devlogs/api.log 2>&1 &) && (VITE_API_URL=http://localhost:8001 nohup npm --prefix portal run dev -- --port 5175 --strictPort > .devlogs/portal.log 2>&1 &) && sleep 8 && lsof -nP -iTCP:8001 -iTCP:5175 -sTCP:LISTEN
```

In the browser at `http://localhost:5175`, sign in as `claude-dev@test.example.com` / `wt-verify-2026` (fill the fields with `form_input`, then `document.querySelector('form').requestSubmit()` — the login page's reveal animation does not run in the pane). Unlock god mode by typing a word from `SS_GOD_MODE_WORDS` into the command palette. Then:

1. Mark a disposable person for deletion from `/people/users` (the Actions menu's god delete), open `/dev/database`, press Reconcile, and confirm the failure now offers **Override — delete this and everything attached**.
2. Open the override. Screenshot the plan: it must list the account, roles and any sessions as Deleted, the audit log as Reference cleared, and any notification membership as Handled by the database.
3. Confirm the destroy button is inert until the name is typed, then delete. Confirm the record is gone from `/people/users` and the audit log at `/admin/audit` shows one `cascade_delete` entry with its table counts.
4. Repeat for a person carrying a time entry, to exercise the business-record path.

Fix anything that looks wrong in the source, re-screenshot, and commit as `fix(portal): …` or `fix(devtools): …`.

- [ ] **Step 4: Report**

`git status` must be clean apart from `.devlogs/` and `portal/node_modules`. Restore `api/src/serversherpa/_dev_reload.py` if the dev API touched it. Report the final commit, both suite counts, and the screenshots taken.

---

## Self-review notes

- Spec coverage: engine module and classification table (Tasks 1–2), `audit_log` guard and depth cap (Task 2), execution order and re-derivation (Task 3), both endpoints, label confirmation, audit row and the `db_handled` reporting fix (Task 4), portal client and `canForceDelete` (Task 5), modal with preview, summary, blocked state and typed confirmation (Task 6), Reconcile wiring (Task 7), suites and live pass (Task 8).
- The spec's "a plan reaching another `DELETABLE` record is blocked" rule is implemented as `protected_tables`, threaded from the endpoints through `plan_cascade` and `execute_cascade` into the walk. No required foreign key between two deletable entities exists in today's schema, so no real case exercises it; Task 2's test pins the guard directly by naming `user_accounts` as protected. Building it rather than documenting it means a future schema change fails loudly instead of quietly deleting a site.
- Type consistency: `CascadeStep.action` values match between the dataclass (Task 2), the pydantic schema (Task 4) and the TypeScript union (Task 5); `execute_cascade` returns the exact keys the audit row and `CascadeDeleteModal` expect.
