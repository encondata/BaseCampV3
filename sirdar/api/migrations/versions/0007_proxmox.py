"""Deploy phase 5: Proxmox targets. The proxmox integration kind, the VMs
Sirdar builds (the ownership record), the VM flags of a deployment and the
vm_restore mode.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-04
"""
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check
            CHECK (kind IN ('cloudflare', 'npm', 'proxmox'));
        -- One row per Proxmox environment: Sirdar manages only the VM named
        -- here, by the id it reserved before Terraform created it.
        CREATE TABLE proxmox_vms (
          environment_id uuid PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
          node text NOT NULL,
          vmid integer UNIQUE CHECK (vmid BETWEEN 100 AND 999999999),
          name text NOT NULL UNIQUE,
          cores integer NOT NULL CHECK (cores BETWEEN 1 AND 64),
          memory_mb integer NOT NULL CHECK (memory_mb BETWEEN 2048 AND 262144),
          disk_gb integer NOT NULL CHECK (disk_gb BETWEEN 20 AND 4096),
          ip_mode text NOT NULL CHECK (ip_mode IN ('static', 'dhcp')),
          ip_cidr text,
          gateway text,
          ip text,
          ssh_public_key text NOT NULL,
          ssh_private_key_enc bytea NOT NULL,
          keep_snapshots integer NOT NULL DEFAULT 3 CHECK (keep_snapshots BETWEEN 1 AND 10),
          created boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK ((ip_mode = 'static') = (ip_cidr IS NOT NULL AND gateway IS NOT NULL))
        );
        ALTER TABLE deployments
          ADD COLUMN vm boolean NOT NULL DEFAULT false,
          ADD COLUMN take_vm_snapshot boolean NOT NULL DEFAULT false,
          ADD COLUMN vm_snapshot text,
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN
            ('update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback', 'publish',
             'teardown', 'vm_restore'));
    """)


def downgrade() -> None:
    # Environments on target 'proxmox' stay: deleting them would orphan their VMs.
    # For the same reason it refuses while proxmox_vms (the ownership record and
    # each VM's SSH key) has rows, before anything is dropped.
    op.execute("""
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM proxmox_vms) THEN
            RAISE EXCEPTION 'Can''t downgrade below 0007 while Sirdar manages Proxmox VMs; '
              'delete those environments first.';
          END IF;
        END
        $$;
        DELETE FROM deployments WHERE mode = 'vm_restore';
        DELETE FROM deployment_steps WHERE key IN ('provision', 'vm_restore', 'destroy');
        DELETE FROM integrations WHERE kind = 'proxmox';
        ALTER TABLE deployments
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN
            ('update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback', 'publish',
             'teardown')),
          DROP COLUMN vm_snapshot,
          DROP COLUMN take_vm_snapshot,
          DROP COLUMN vm;
        DROP TABLE proxmox_vms;
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check CHECK (kind IN ('cloudflare', 'npm'));
    """)
