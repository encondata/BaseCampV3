"""Force delete: deployments.force, a Delete environment that skips every
step that fails and removes the environment from Sirdar anyway (for an
environment Sirdar can't reach). Only a teardown is ever forced.

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-10
"""
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE deployments
          ADD COLUMN force boolean NOT NULL DEFAULT false,
          ADD CONSTRAINT deployments_force_is_teardown CHECK (NOT force OR mode = 'teardown');
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE deployments
          DROP CONSTRAINT deployments_force_is_teardown,
          DROP COLUMN force;
    """)
