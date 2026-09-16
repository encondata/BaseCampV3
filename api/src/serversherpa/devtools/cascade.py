"""Cascade delete: what else dies when a god-mode reconcile target dies.

The walk below is the single source of truth for both the preview a
developer confirms and the statements that actually run, so the two can
never disagree. It is deliberately schema-driven rather than a hand-kept
list of tables: a new table with a required foreign key joins the cascade
the moment it exists."""

import re
import uuid
from collections.abc import Iterator
from dataclasses import dataclass

from sqlalchemy import CheckConstraint, String, cast, delete, func, select, update
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
    # Rows the DATABASE destroys via ON DELETE CASCADE — not counted in
    # total_rows_deleted (which is only what this walk's own DELETEs
    # remove), but just as gone. Kept separate so a caller can report the
    # two truthfully instead of picking one.
    total_rows_db_deleted: int


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
    # The bool tracks whether `values`' own rows are themselves doomed by a
    # purge level already queued (the root entity is not — the caller
    # deletes it separately — but every table this walk recurses into is,
    # since recursion only ever follows a purge).
    frontier = [(table, pk_col, [entity_id], 0, False)]

    while frontier:
        parent_table, parent_key, values, depth, parent_purged = frontier.pop(0)
        if not values:
            continue
        if depth > max_depth:
            blocked.append(
                f"{parent_table.name}: exceeds the max depth of {max_depth} "
                "levels of dependent rows — refusing to walk further")
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
            if child_table is parent_table and parent_purged:
                # A self-reference inside a table this cascade is already
                # purging (auth_sessions.replaced_by, say) needs no clear
                # step at all: the purge below deletes every row in
                # `values` — referencer and referenced alike — in one
                # DELETE statement, and a plain NO ACTION foreign key is
                # checked at end of statement, so both ends going together
                # satisfies it without ever nulling anything first. A
                # self-reference on the ROOT table (people.created_by
                # pointing at the doomed person from another person's row)
                # does not take this branch — parent_purged is False there
                # — and still falls through to an ordinary clear/purge
                # classification below.
                seen.add(key)
                continue
            count = await db.scalar(
                select(func.count()).select_from(child_table)
                .where(child_col.in_(values)))
            if not count:
                continue
            seen.add(key)
            ondelete = _fk_ondelete(child_table, child_col)
            # NEVER_PURGE is checked before the ON DELETE branches below, not
            # after: today audit_log.actor_person_id is nullable with no
            # ondelete, so it falls all the way through to "clear" and this
            # guard never fires for it — that is correct and must keep
            # working. But if a future migration ever puts ON DELETE CASCADE
            # on an audit_log foreign key, that FK must still be refused
            # rather than classified db_cascade: letting Postgres silently
            # delete the record of the deletion is exactly what this guard
            # exists to prevent, and it can only prevent it by outranking
            # the db_cascade branch rather than following it.
            if child_table.name in NEVER_PURGE and (
                    not child_col.nullable or ondelete == "CASCADE"):
                blocked.append(
                    f"{child_table.name}.{child_col.name} is required and "
                    f"{child_table.name} is never deleted")
                continue
            if ondelete == "CASCADE":
                action = "db_cascade"
            elif ondelete == "SET NULL":
                action = "db_set_null"
            elif child_col.nullable and not check_guarded(child_table, child_col):
                action = "clear"
            elif child_col.nullable:
                blocked.append(
                    f"{child_table.name}.{child_col.name} is kept non-null by "
                    "a database rule, so the cascade will not touch the "
                    f"{child_table.name} rows blocking it")
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
            frontier.append((child_table, child_pk, child_ids, depth + 1, True))
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
    deleted = cleared = db_deleted = 0
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
        elif level.action == "db_cascade":
            db_deleted += count or 0
    steps.sort(key=lambda s: (s.action != "purge", -s.depth, s.table))
    return CascadePlan(
        entity_type=entity_type, entity_id=entity_id, label=label,
        steps=steps, blocked=blocked,
        total_rows_deleted=deleted, total_rows_cleared=cleared,
        total_rows_db_deleted=db_deleted)


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
    # Clears first, at any depth: a nulled column never blocks a delete.
    # (A self-reference inside a table this cascade purges — auth_sessions.
    # replaced_by, say — never shows up here: collect_levels skips it
    # because the purge below deletes both ends of that reference in the
    # same statement.)
    #
    # The order here is load-bearing, not incidental — a single row can be
    # both cleared and purged. A time entry the doomed person clocked AND
    # approved (person_id and approved_by both point at them) needs
    # approved_by nulled before the purge deletes the row out from under
    # it; run purges first and the clear finds nothing left to touch.
    # test_execute_removes_exactly_the_planned_rows pins this down via
    # cleared_references["time_entries.approved_by"].
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
