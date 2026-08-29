"""partners.service_region replaces partners.tier — partners aren't
tiered, they need a freeform record of which regions they service.
Clients keep tier unchanged (it stays on the clients table; only the
partners table changes here).

Revision ID: 0031
Revises: 0030
Create Date: 2026-08-29
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0031"
down_revision: str | None = "0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("partners", "tier")
    op.add_column("partners", sa.Column("service_region", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("partners", "service_region")
    op.add_column("partners", sa.Column(
        "tier", sa.Text, nullable=False, server_default="standard"))
