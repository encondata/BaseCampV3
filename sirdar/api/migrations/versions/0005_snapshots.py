"""Deploy phase 3: snapshots, the deployment modes that use them, and the
spec's step numbers (Start services moves from 8 to 10 so that 8, start
data services, and 9, restore, run before it).

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-04
"""
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE snapshots (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL UNIQUE,
          origin text NOT NULL CHECK (origin IN ('upload', 'environment')),
          source text NOT NULL,
          status text NOT NULL DEFAULT 'ready'
            CHECK (status IN ('pending', 'ready', 'failed')),
          alembic_revision text,
          size_bytes bigint,
          checksum text,
          object_count integer,
          object_bytes bigint,
          notes text NOT NULL DEFAULT '',
          bundle_file text,
          source_created_at timestamptz,
          created_by uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT snapshots_ready_complete CHECK (status <> 'ready' OR (
            bundle_file IS NOT NULL AND alembic_revision IS NOT NULL
            AND size_bytes IS NOT NULL AND checksum IS NOT NULL))
        );
        ALTER TABLE deployments
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN
            ('update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback')),
          ADD COLUMN snapshot_id uuid REFERENCES snapshots(id) ON DELETE SET NULL,
          ADD COLUMN restore_dump text;
        ALTER TABLE environments
          ADD COLUMN seed_snapshot_id uuid REFERENCES snapshots(id) ON DELETE SET NULL;
        -- Before phase 3 step 8 was always "up" (Start services).
        UPDATE deployment_steps SET number = 10 WHERE key = 'up' AND number = 8;
        UPDATE deployments SET failed_step = 10 WHERE failed_step = 8;
        UPDATE deployments SET start_step = 10 WHERE start_step = 8;
    """)


def downgrade() -> None:
    op.execute("""
        DELETE FROM deployments WHERE mode IN ('snapshot', 'restore_dump', 'rollback');
        DELETE FROM deployment_steps WHERE key IN ('data', 'restore', 'restore_dump', 'export');
        UPDATE deployment_steps SET number = 8 WHERE key = 'up' AND number = 10;
        UPDATE deployments SET failed_step = 8 WHERE failed_step = 10;
        UPDATE deployments SET start_step = 8 WHERE start_step = 10;
        ALTER TABLE environments DROP COLUMN seed_snapshot_id;
        ALTER TABLE deployments
          DROP COLUMN restore_dump,
          DROP COLUMN snapshot_id,
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN ('update', 'reset', 'adopt'));
        DROP TABLE snapshots;
    """)
