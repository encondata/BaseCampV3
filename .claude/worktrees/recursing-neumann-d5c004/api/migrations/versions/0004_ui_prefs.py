"""ui_prefs — per-account UI preferences (accent, theme, density, ...)

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_accounts",
        sa.Column("ui_prefs", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb"),
                  comment="validated by the API layer (UiPreferences schema)"),
    )


def downgrade() -> None:
    op.drop_column("user_accounts", "ui_prefs")
