"""Worker travel: whether the worker will travel (null = not set), the
region they'll travel to, and any travel restrictions — three nullable
columns on worker_profiles.

Revision ID: 0118
Revises: 0117
Create Date: 2026-11-04
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0118"
down_revision: str | None = "0117"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("worker_profiles", sa.Column("will_travel", sa.Boolean(), nullable=True))
    op.add_column("worker_profiles", sa.Column("travel_region", sa.Text(), nullable=True))
    op.add_column("worker_profiles", sa.Column("travel_restrictions", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("worker_profiles", "travel_restrictions")
    op.drop_column("worker_profiles", "travel_region")
    op.drop_column("worker_profiles", "will_travel")
