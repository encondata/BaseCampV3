"""The devices bucket's own Spaces key on a DigitalOcean environment: its
id and its secret (vault-encrypted), empty until step 0 makes the key (only
while the devices app runs). The bucket's name comes from the main one
(<bucket>-devices), so it needs no column.

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-18
"""
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE do_environments
          ADD COLUMN devices_spaces_key_id text,
          ADD COLUMN devices_spaces_secret_enc bytea;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE do_environments
          DROP COLUMN devices_spaces_secret_enc,
          DROP COLUMN devices_spaces_key_id;
    """)
