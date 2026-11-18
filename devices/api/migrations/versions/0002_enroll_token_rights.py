"""Enrollment links remember what their creator could do: re-enable a
disabled iPhone (delete) and rename someone else's (change).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-17
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE enroll_tokens
          ADD COLUMN can_reenable boolean NOT NULL DEFAULT false,
          ADD COLUMN can_update_existing boolean NOT NULL DEFAULT false;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE enroll_tokens
          DROP COLUMN can_update_existing,
          DROP COLUMN can_reenable;
    """)
