"""Fresh start (deploy phase 8a): the first super admin an environment that
starts empty gets on its first deploy (step 11), and the deployments that
run that step.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-07
"""
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE environment_first_admins (
          environment_id uuid PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
          first_name text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 100),
          last_name text NOT NULL CHECK (length(last_name) BETWEEN 1 AND 100),
          email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
          password_mode text NOT NULL CHECK (password_mode IN ('typed', 'invite')),
          -- vault-encrypted; typed only, and NULL again once step 11 used it
          password_enc bytea,
          done_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT environment_first_admins_password_check
            CHECK (password_mode = 'typed' OR password_enc IS NULL)
        );
        ALTER TABLE deployments ADD COLUMN first_admin boolean NOT NULL DEFAULT false;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE deployments DROP COLUMN first_admin;
        DROP TABLE environment_first_admins;
    """)
