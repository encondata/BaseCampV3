"""Pod numbers on assets and move rosters.

A pod is the group of racks a device sits in (Nap 14 numbers its pods,
Nap 9 does not). `assets.pod_number` is where the asset is today;
`initiative_assets.source_pod` / `destination_pod` are where it leaves
from and lands on one move, so a move between Naps records both.

Free text, no format check, no backfill.

Revision ID: 0069
Revises: 0068
Create Date: 2026-09-21
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0069"
down_revision: str | None = "0068"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("assets", sa.Column("pod_number", sa.Text(), nullable=True))
    op.add_column("initiative_assets",
                  sa.Column("source_pod", sa.Text(), nullable=True))
    op.add_column("initiative_assets",
                  sa.Column("destination_pod", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("initiative_assets", "destination_pod")
    op.drop_column("initiative_assets", "source_pod")
    op.drop_column("assets", "pod_number")
