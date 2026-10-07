"""The Deploy page flow (deploy phase 8c): which optional apps an
environment runs, and its SMTP server (none: the environment's Mailpit).
The SMTP password is an optional secret (environment_secrets).

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-07
"""
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE environments
          ADD COLUMN apps text[] NOT NULL DEFAULT '{wiki,kiosk,status,mailpit}',
          ADD COLUMN smtp_host text,
          ADD COLUMN smtp_port integer CHECK (smtp_port BETWEEN 1 AND 65535),
          ADD COLUMN smtp_username text,
          ADD COLUMN smtp_from text,
          ADD COLUMN smtp_starttls boolean NOT NULL DEFAULT true,
          ADD CONSTRAINT environments_apps_check
            CHECK (apps <@ ARRAY['wiki', 'kiosk', 'status', 'mailpit']::text[]),
          ADD CONSTRAINT environments_smtp_check
            CHECK ((smtp_host IS NULL) = (smtp_port IS NULL)
                   AND (smtp_host IS NULL) = (smtp_from IS NULL)),
          ADD CONSTRAINT environments_mail_check
            CHECK ('mailpit' = ANY (apps) OR smtp_host IS NOT NULL);
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE environments
          DROP CONSTRAINT environments_mail_check, DROP CONSTRAINT environments_smtp_check,
          DROP CONSTRAINT environments_apps_check,
          DROP COLUMN smtp_starttls, DROP COLUMN smtp_from, DROP COLUMN smtp_username,
          DROP COLUMN smtp_port, DROP COLUMN smtp_host, DROP COLUMN apps;
        DELETE FROM environment_secrets WHERE key = 'SS_SMTP_PASSWORD';
    """)
