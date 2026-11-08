"""Switchyard, the second LAN proxy beside Nginx Proxy Manager: its
integration kind, the switchyard_host managed-record kind (Switchyard's host
ids are its own, so they can't share proxy_host's (kind, external_id)
uniqueness with NPM's), and environments.proxy, the proxy a LAN environment
publishes through. Existing LAN environments keep NPM; DigitalOcean
environments use none (NULL).

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-07
"""
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check CHECK (kind IN
            ('cloudflare', 'npm', 'switchyard', 'proxmox', 'esxi'));
        ALTER TABLE managed_records
          DROP CONSTRAINT managed_records_kind_check,
          ADD CONSTRAINT managed_records_kind_check CHECK (kind IN
            ('dns_record', 'proxy_host', 'certificate', 'switchyard_host'));
        ALTER TABLE environments
          ADD COLUMN proxy text CHECK (proxy IN ('switchyard', 'npm')),
          ADD CONSTRAINT environments_cloud_has_no_proxy
            CHECK (target_id <> 'digitalocean' OR proxy IS NULL);
        UPDATE environments SET proxy = 'npm' WHERE target_id <> 'digitalocean';
    """)


def downgrade() -> None:
    # Refused while Sirdar manages Switchyard hosts or an environment
    # publishes through Switchyard: below 0018 they would be NPM's.
    op.execute("""
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM managed_records WHERE kind = 'switchyard_host')
             OR EXISTS (SELECT 1 FROM environments WHERE proxy = 'switchyard') THEN
            RAISE EXCEPTION 'Can''t downgrade below 0018 while environments publish '
                            'through Switchyard';
          END IF;
        END $$;
        DELETE FROM integrations WHERE kind = 'switchyard';
        ALTER TABLE environments
          DROP CONSTRAINT environments_cloud_has_no_proxy,
          DROP COLUMN proxy;
        ALTER TABLE managed_records
          DROP CONSTRAINT managed_records_kind_check,
          ADD CONSTRAINT managed_records_kind_check CHECK (kind IN
            ('dns_record', 'proxy_host', 'certificate'));
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check CHECK (kind IN
            ('cloudflare', 'npm', 'proxmox', 'esxi'));
    """)
