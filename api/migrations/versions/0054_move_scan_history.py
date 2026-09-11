"""Move Scan History — seeds the system report definition.

Port of V2's Move Scan History Report (api/reports/scan_history_report.py)
into V3's reports framework — see docs/superpowers/specs/2026-09-11-
move-scan-history-design.md. Data-only migration: seeds the "Move Scan
History" system report definition the way 0046 seeded Move Report and
0052 seeded Site & Move Survey.

Revision ID: 0054
Revises: 0053
Create Date: 2026-09-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0054"
down_revision: str | None = "0053"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFINITION_NAME = "Move Scan History"
REPORT_TYPE = "move_scan_history"
DEFAULT_OPTIONS = '{"default_format": "xlsx", "status_columns": "pipeline"}'
DEFINITION_DESCRIPTION = (
    "Every asset on a move with the first time it reached each status, "
    "plus the full scan history — as an Excel workbook or a PDF with a "
    "document tracking barcode."
)

# A module-level constant (rather than inline in upgrade()) so the test
# suite can execute this exact statement directly — see 0052's own
# INSERT_DEFINITION_SQL and tests/test_site_move_survey_fixtures.py.
INSERT_DEFINITION_SQL = (
    "INSERT INTO report_definitions (name, description, report_type, options, is_system) "
    # CAST(... AS jsonb), not `:options::jsonb` — SQLAlchemy's text() bind-param
    # scanner doesn't resolve a param immediately followed by a `::` cast, and
    # silently leaves it unbound (empty params, driver-side syntax error).
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
