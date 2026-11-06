"""The cleanup deployment mode: it runs Delete's steps on an environment that
has never deployed and keeps the environment (and its settings) afterwards.

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-05
"""
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None

_MODES_10 = ("'update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback', 'publish', "
             "'teardown', 'vm_restore', 'activate', 'renew'")


def upgrade() -> None:
    op.execute(f"""
        ALTER TABLE deployments
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN ({_MODES_10}, 'cleanup'));
    """)


def downgrade() -> None:
    op.execute(f"""
        DELETE FROM deployments WHERE mode = 'cleanup';
        ALTER TABLE deployments
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN ({_MODES_10}));
    """)
