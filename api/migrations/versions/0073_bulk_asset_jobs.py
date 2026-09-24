"""Bulk asset update jobs.

`import_jobs` also carries Bulk Actions › Update assets in bulk: those jobs
belong to no move (initiative_id NULL) and keep their parsed rows in
`payload` while the admin previews and picks.

Revision ID: 0073
Revises: 0072
Create Date: 2026-09-24
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0073"
down_revision: str | None = "0072"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("import_jobs", "initiative_id", nullable=True)
    op.add_column("import_jobs", sa.Column("payload", JSONB, nullable=True))


def downgrade() -> None:
    op.execute("DELETE FROM import_jobs WHERE initiative_id IS NULL")
    op.drop_column("import_jobs", "payload")
    op.alter_column("import_jobs", "initiative_id", nullable=False)
