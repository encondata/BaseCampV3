"""Signed builds can fail for good: a capability the App ID lacks isn't
retried until a new upload.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-18
"""
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE signed_builds ADD COLUMN permanent boolean NOT NULL DEFAULT false;")


def downgrade() -> None:
    op.execute("ALTER TABLE signed_builds DROP COLUMN permanent;")
