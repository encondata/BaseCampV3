"""Deploy phase 4: DNS + proxy. Integration credentials, the records Sirdar
manages, the environment's Publish switch, whether a deployment publishes,
the deleting status and the publish / teardown modes.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-04
"""
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE integrations (
          kind text PRIMARY KEY CHECK (kind IN ('cloudflare', 'npm')),
          config jsonb NOT NULL DEFAULT '{}'::jsonb,
          secret_enc bytea,
          updated_by uuid,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE managed_records (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          service text NOT NULL,
          kind text NOT NULL CHECK (kind IN ('dns_record', 'proxy_host', 'certificate')),
          external_id text NOT NULL,
          name text NOT NULL,
          origin text NOT NULL CHECK (origin IN ('created', 'claimed')),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (environment_id, service, kind),
          UNIQUE (kind, external_id)
        );
        -- Environments that exist now were published by hand (or not at
        -- all): they start unpublished until someone turns Publish on.
        ALTER TABLE environments
          ADD COLUMN publish boolean NOT NULL DEFAULT false,
          DROP CONSTRAINT environments_status_check,
          ADD CONSTRAINT environments_status_check CHECK (status IN
            ('new', 'deploying', 'ready', 'failed', 'deleting'));
        ALTER TABLE deployments
          ADD COLUMN publish boolean NOT NULL DEFAULT false,
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN
            ('update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback', 'publish',
             'teardown'));
    """)


def downgrade() -> None:
    op.execute("""
        DELETE FROM deployments WHERE mode IN ('publish', 'teardown');
        DELETE FROM deployment_steps
          WHERE key IN ('dns', 'proxy', 'smoke', 'teardown', 'unproxy', 'undns');
        UPDATE environments SET status = 'failed' WHERE status = 'deleting';
        ALTER TABLE deployments
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN
            ('update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback')),
          DROP COLUMN publish;
        ALTER TABLE environments
          DROP CONSTRAINT environments_status_check,
          ADD CONSTRAINT environments_status_check CHECK (status IN
            ('new', 'deploying', 'ready', 'failed')),
          DROP COLUMN publish;
        DROP TABLE managed_records;
        DROP TABLE integrations;
    """)
