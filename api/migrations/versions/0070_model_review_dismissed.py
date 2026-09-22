"""Catalog review dismissals.

`asset_models.review_dismissed_at` marks a model an admin has looked at on
the Makes / Models Review view (importer-created rows and likely
duplicates) and decided to keep as is. Null means "not reviewed".

Revision ID: 0070
Revises: 0069
Create Date: 2026-09-22
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0070"
down_revision: str | None = "0069"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("asset_models", sa.Column(
        "review_dismissed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("asset_models", "review_dismissed_at")
