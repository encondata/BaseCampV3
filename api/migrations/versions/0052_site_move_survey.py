"""Site & Move Survey — framework groundwork.

Makes `report_runs.initiative_id` nullable (the survey can target a
partner + manually chosen sites with no initiative at all) and seeds the
system "Site & Move Survey" report definition, the way 0046 seeded Move
Report.

Revision ID: 0052
Revises: 0051
Create Date: 2026-09-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0052"
down_revision: str | None = "0051"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFINITION_NAME = "Site & Move Survey"
REPORT_TYPE = "site_move_survey"
DEFAULT_OPTIONS = (
    '{"company_name": "Cumulus Solutions Group", '
    '"include_transportation_standards": true, "include_site_photos": true, '
    '"condensed_assets": true}'
)
DEFINITION_DESCRIPTION = (
    "Fills a logistics partner's questionnaire with a move's sites, "
    "contacts, survey answers and equipment list, and appends the "
    "company Transportation Standards and site photos."
)

# A module-level constant (rather than inline in upgrade()) so the test
# suite can execute this exact statement directly — see
# tests/test_site_move_survey_fixtures.py.
INSERT_DEFINITION_SQL = (
    "INSERT INTO report_definitions (name, description, report_type, options, is_system) "
    # CAST(... AS jsonb), not `:options::jsonb` — SQLAlchemy's text() bind-param
    # scanner doesn't resolve a param immediately followed by a `::` cast, and
    # silently leaves it unbound (empty params, driver-side syntax error).
    "VALUES (:name, :description, :report_type, CAST(:options AS jsonb), true) "
    "ON CONFLICT (name) WHERE archived_at IS NULL DO NOTHING"
)


def upgrade() -> None:
    op.alter_column("report_runs", "initiative_id", nullable=True)

    conn = op.get_bind()
    conn.execute(sa.text(INSERT_DEFINITION_SQL), {
        "name": DEFINITION_NAME, "description": DEFINITION_DESCRIPTION,
        "report_type": REPORT_TYPE, "options": DEFAULT_OPTIONS})


def assert_no_standalone_runs(conn) -> None:
    """Refuse to restore NOT NULL over runs that have no initiative — the
    state a Site & Move Survey run leaves behind. Shared with the test so
    the guard itself is what gets exercised."""
    remaining_nulls = conn.execute(sa.text(
        "SELECT count(*) FROM report_runs WHERE initiative_id IS NULL")).scalar()
    if remaining_nulls:
        raise RuntimeError(
            f"cannot restore report_runs.initiative_id NOT NULL: "
            f"{remaining_nulls} run(s) have no initiative")


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM report_definitions WHERE report_type = :report_type"),
        {"report_type": REPORT_TYPE})

    assert_no_standalone_runs(conn)
    op.alter_column("report_runs", "initiative_id", nullable=False)
