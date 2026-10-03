"""Deploy pipeline: environments, their services and encrypted secrets,
deployments and their steps.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-03
"""
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE environments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL UNIQUE,
          type text NOT NULL CHECK (type IN ('dev', 'beta', 'custom')),
          target_id text NOT NULL,
          base_domain text NOT NULL,
          git_ref text NOT NULL DEFAULT 'main',
          current_sha text,
          image_tag text,
          status text NOT NULL DEFAULT 'new'
            CHECK (status IN ('new', 'deploying', 'ready', 'failed')),
          proxy_ip text NOT NULL,
          bind_ip text NOT NULL DEFAULT '0.0.0.0',
          keep_dumps integer NOT NULL DEFAULT 5,
          spaces_bucket text NOT NULL DEFAULT 'serversherpa',
          log_level text NOT NULL DEFAULT 'INFO',
          created_by uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE environment_services (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          service text NOT NULL,
          host_ip text NOT NULL,
          port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
          hostname text,
          proxied boolean NOT NULL DEFAULT false,
          UNIQUE (environment_id, service)
        );
        CREATE TABLE environment_secrets (
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          key text NOT NULL,
          value_enc bytea NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (environment_id, key)
        );
        CREATE TABLE deployments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          mode text NOT NULL CHECK (mode IN ('update', 'reset', 'adopt')),
          git_ref text NOT NULL,
          sha text NOT NULL,
          status text NOT NULL CHECK (status IN
            ('running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'adopted')),
          start_step integer NOT NULL DEFAULT 1,
          retry_of uuid REFERENCES deployments(id) ON DELETE SET NULL,
          failed_step integer,
          dump_path text,
          previous_sha text,
          error text,
          actor_id uuid,
          started_at timestamptz NOT NULL DEFAULT now(),
          finished_at timestamptz,
          -- clock_timestamp, not now(): "latest deployment" must order rows
          -- created in the same transaction too.
          created_at timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        -- The per-environment deploy lock.
        CREATE UNIQUE INDEX deployments_one_running ON deployments (environment_id)
          WHERE status = 'running';
        CREATE INDEX deployments_environment_created
          ON deployments (environment_id, created_at DESC);
        CREATE TABLE deployment_steps (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
          number integer NOT NULL,
          key text NOT NULL,
          name text NOT NULL,
          status text NOT NULL DEFAULT 'pending' CHECK (status IN
            ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled',
             'interrupted', 'not_run')),
          started_at timestamptz,
          finished_at timestamptz,
          log text NOT NULL DEFAULT '',
          UNIQUE (deployment_id, number)
        );
    """)


def downgrade() -> None:
    op.execute("""
        DROP TABLE deployment_steps;
        DROP TABLE deployments;
        DROP TABLE environment_secrets;
        DROP TABLE environment_services;
        DROP TABLE environments;
    """)
