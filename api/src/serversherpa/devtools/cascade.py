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
