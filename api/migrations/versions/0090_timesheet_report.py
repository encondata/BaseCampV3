"""Timesheet report — seeds the system report definition.

Hours worked by person and job over a date range, as Excel or PDF — see
docs/superpowers/specs/2026-10-06-timesheet-report-design.md. Data-only
migration: seeds the "Timesheet" system report definition the way 0054
seeded Move Scan History.

Revision ID: 0090
Revises: 0089
Create Date: 2026-10-06
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0090"
down_revision: str | None = "0089"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFINITION_NAME = "Timesheet"
REPORT_TYPE = "timesheet"
DEFAULT_OPTIONS = (
    '{"default_format": "xlsx", "default_views": ["day", "punch"], '
    '"default_statuses": ["approved", "pending"]}'
)
DEFINITION_DESCRIPTION = (
    "Hours worked by person and job over a date range, with a day view, "
    "every punch and verification flags, as Excel or PDF."
)

# A module-level constant so the test suite can execute this exact
# statement directly (see 0054 and tests/test_timesheet_seed.py).
INSERT_DEFINITION_SQL = (
    "INSERT INTO report_definitions (name, description, report_type, options, is_system) "
    # CAST(... AS jsonb), not `:options::jsonb` — see 0054.
    "VALUES (:name, :description, :report_type, CAST(:options AS jsonb), true) "
    "ON CONFLICT (name) WHERE archived_at IS NULL DO NOTHING"
)

DELETE_DEFINITION_SQL = (
    "DELETE FROM report_definitions WHERE report_type = :report_type"
)


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(INSERT_DEFINITION_SQL), {
        "name": DEFINITION_NAME, "description": DEFINITION_DESCRIPTION,
        "report_type": REPORT_TYPE, "options": DEFAULT_OPTIONS})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(DELETE_DEFINITION_SQL), {"report_type": REPORT_TYPE})
