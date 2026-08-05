"""partner_type (single) → partner_types (array) — a partner can do
several things (e.g. staffing AND logistics).

Revision ID: 0008
Revises: 0007
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("partners", sa.Column(
        "partner_types", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb"),
        comment="list of types; validated by the API layer"))
    # preserve existing single type as a one-element array
    op.execute("UPDATE partners SET partner_types = to_jsonb(ARRAY[partner_type])")
    op.drop_constraint("partners_type_check", "partners")
    op.drop_column("partners", "partner_type")


def downgrade() -> None:
    op.add_column("partners", sa.Column(
        "partner_type", sa.Text, nullable=False, server_default="other"))
    op.execute("""
        UPDATE partners SET partner_type =
        COALESCE(partner_types->>0, 'other')
    """)
    op.create_check_constraint(
        "partners_type_check", "partners",
        "partner_type IN ('staffing', 'logistics', 'subcontractor', "
        "'consultant', 'other')")
    op.drop_column("partners", "partner_types")
