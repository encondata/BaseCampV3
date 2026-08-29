"""db_backups.encrypted — backups may now be created unencrypted (an
explicit choice in the Dev > Database UI); the flag lets the list say
which is which. Existing rows are all encrypted (that was the only
mode), so the default backfills correctly.

Revision ID: 0030
Revises: 0029
Create Date: 2026-08-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision: str | None = "0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("db_backups", sa.Column(
        "encrypted", sa.Boolean, nullable=False, server_default=sa.true()))


def downgrade() -> None:
    op.drop_column("db_backups", "encrypted")
