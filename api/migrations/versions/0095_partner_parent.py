"""Parent partner: partners.parent_id.

A partner can sit under a parent partner (a subcontractor engaged through a
parent firm). Display-only: nothing is inherited. ON DELETE SET NULL so
removing a parent releases its children; the check keeps a row from being its
own parent (longer loops are refused by the API under an advisory lock).

Revision ID: 0095
Revises: 0094
Create Date: 2026-10-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0095"
down_revision: str | None = "0094"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("partners", sa.Column(
        "parent_id", postgresql.UUID(as_uuid=True),
        sa.ForeignKey("partners.id", ondelete="SET NULL",
                      name="partners_parent_id_fkey"),
        nullable=True))
    op.create_index("ix_partners_parent_id", "partners", ["parent_id"])
    op.create_check_constraint(
        "ck_partners_parent_not_self", "partners",
        "parent_id IS NULL OR parent_id <> id")


def downgrade() -> None:
    op.drop_constraint("ck_partners_parent_not_self", "partners", type_="check")
    op.drop_index("ix_partners_parent_id", table_name="partners")
    op.drop_column("partners", "parent_id")
