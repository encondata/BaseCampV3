"""LAN Blue/Green (deploy phase 8b): VM rows get a role (main for the one VM
of a single-server environment; data, orange and purple for a Blue/Green
one), each slot's commit and smoke test (vm_slots), and the deployments that
run a LAN Blue/Green plan.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-07
"""
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

_ROLES = "('main', 'data', 'orange', 'purple')"


def upgrade() -> None:
    op.execute(f"""
        ALTER TABLE proxmox_vms
          ADD COLUMN role text NOT NULL DEFAULT 'main' CHECK (role IN {_ROLES}),
          DROP CONSTRAINT proxmox_vms_pkey,
          ADD PRIMARY KEY (environment_id, role);
        ALTER TABLE esxi_vms
          ADD COLUMN role text NOT NULL DEFAULT 'main' CHECK (role IN {_ROLES}),
          DROP CONSTRAINT esxi_vms_pkey,
          ADD PRIMARY KEY (environment_id, role);

        CREATE TABLE vm_slots (
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          slot text NOT NULL CHECK (slot IN ('orange', 'purple')),
          sha text,
          image_tag text,
          last_check_ok boolean,
          last_check_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (environment_id, slot)
        );

        ALTER TABLE deployments ADD COLUMN bluegreen boolean NOT NULL DEFAULT false;
    """)


def downgrade() -> None:
    # Refuses while a Blue/Green environment exists: its VMs would lose their records.
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM proxmox_vms WHERE role <> 'main')
             OR EXISTS (SELECT 1 FROM esxi_vms WHERE role <> 'main') THEN
            RAISE EXCEPTION 'Can''t downgrade below 0012 while Blue/Green VMs exist: '
                            'delete those environments first.';
          END IF;
        END $$;
        ALTER TABLE deployments DROP COLUMN bluegreen;
        DROP TABLE vm_slots;
        ALTER TABLE esxi_vms DROP CONSTRAINT esxi_vms_pkey,
          ADD PRIMARY KEY (environment_id), DROP COLUMN role;
        ALTER TABLE proxmox_vms DROP CONSTRAINT proxmox_vms_pkey,
          ADD PRIMARY KEY (environment_id), DROP COLUMN role;
    """)
