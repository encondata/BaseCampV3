"""Signed builds remember when they last failed, so a failed build is
retried at most once every ten minutes.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-17
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE signed_builds ADD COLUMN failed_at timestamptz;")


def downgrade() -> None:
    op.execute("ALTER TABLE signed_builds DROP COLUMN failed_at;")
