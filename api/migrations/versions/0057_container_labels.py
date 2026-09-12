"""Container Labels — containers gain an optional initiative link (V2's
`containers.move_id`, ported V3-style — V3 had no such link before), and
the system report definition is seeded.

Design: docs/superpowers/specs/2026-09-12-container-labels-design.md
(§ Data). Port of V2's `/labels/containers` page; the label PDF itself
is a Node-rendered bundle (Task 2), and `report_type = "container_labels"`
runs it server-side through the existing reports framework — the
definition is seeded here the way 0054 seeded Move Scan History.

Revision ID: 0057
Revises: 0056
Create Date: 2026-09-12
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0057"
down_revision: str | None = "0056"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFINITION_NAME = "Container Labels"
REPORT_TYPE = "container_labels"
DEFAULT_OPTIONS = "{}"
DEFINITION_DESCRIPTION = (
    "Avery 5164 sheets — one page per container with five barcode labels "
    "and one QR info label, exactly as V2 produced them."
)

# Same style as 0054/0052's own module-level INSERT constant — the test
# suite can execute this exact statement directly.
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
    op.add_column("containers", sa.Column(
        "initiative_id", UUID(as_uuid=True),
        sa.ForeignKey("initiatives.id", ondelete="SET NULL")))
    op.create_index("containers_initiative_idx", "containers", ["initiative_id"])

    conn = op.get_bind()
    conn.execute(sa.text(INSERT_DEFINITION_SQL), {
        "name": DEFINITION_NAME, "description": DEFINITION_DESCRIPTION,
        "report_type": REPORT_TYPE, "options": DEFAULT_OPTIONS})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(DELETE_DEFINITION_SQL), {"report_type": REPORT_TYPE})
    op.drop_index("containers_initiative_idx", table_name="containers")
    op.drop_column("containers", "initiative_id")
