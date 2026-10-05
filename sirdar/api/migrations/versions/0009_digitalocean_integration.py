"""The digitalocean integration kind: the DigitalOcean API token entered in
Settings › Integrations (SIRDAR_DEPLOY_DO_TOKEN stays the fallback when none
is stored).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-05
"""
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check
            CHECK (kind IN ('cloudflare', 'npm', 'proxmox', 'esxi', 'digitalocean'));
    """)


def downgrade() -> None:
    # The stored token is dropped: SIRDAR_DEPLOY_DO_TOKEN is the only source below 0009.
    op.execute("""
        DELETE FROM integrations WHERE kind = 'digitalocean';
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check
            CHECK (kind IN ('cloudflare', 'npm', 'proxmox', 'esxi'));
    """)
