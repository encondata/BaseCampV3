"""Sirdar initial schema + the four default roles and their permissions.

Revision ID: 0001
Revises:
Create Date: 2026-10-01
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

FULL = ("view", "add", "change", "delete")
# Frozen snapshot of access/defaults.py at 0001 (test_access.py compares).
ROLES = [("developer", "Developer", 100), ("founder", "Founder", 100),
         ("super_admin", "Super admin", 80), ("admin", "Administrator", 60)]
GRANTS = {
    "developer": {"dashboard": ("view",), "users": FULL, "access": FULL,
                  "audit": ("view",), "settings": FULL, "devtools": FULL},
    "founder": {"dashboard": ("view",), "users": FULL, "access": FULL,
                "audit": ("view",), "settings": FULL},
    "super_admin": {"dashboard": ("view",), "users": FULL, "access": ("view", "change"),
                    "audit": ("view",), "settings": ("view", "change")},
    "admin": {"dashboard": ("view",), "users": ("view",), "access": ("view",),
              "audit": ("view",), "settings": ("view",)},
}


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")
    op.execute("""
        CREATE TABLE roles (
          name text PRIMARY KEY,
          label text NOT NULL,
          rank integer NOT NULL,
          color text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE users (
          person_id uuid PRIMARY KEY,
          source text NOT NULL CHECK (source IN ('portal', 'local')),
          email citext NOT NULL UNIQUE,
          first_name text NOT NULL,
          last_name text NOT NULL,
          preferred_name text,
          job_title text,
          password_hash text,
          must_change_password boolean NOT NULL DEFAULT false,
          password_updated_at timestamptz,
          password_expires_at timestamptz,
          totp_secret_enc bytea,
          totp_confirmed_at timestamptz,
          totp_last_counter bigint,
          totp_enabled boolean NOT NULL DEFAULT false,
          totp_required boolean NOT NULL DEFAULT false,
          failed_login_count integer NOT NULL DEFAULT 0,
          locked_until timestamptz,
          last_login_at timestamptz,
          last_login_ip inet,
          disabled_at timestamptz,
          disabled_reason text,
          last_imported_at timestamptz,
          ui_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE user_roles (
          person_id uuid NOT NULL REFERENCES users(person_id) ON DELETE CASCADE,
          role text NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
          PRIMARY KEY (person_id, role)
        );
        CREATE TABLE role_permissions (
          role text NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
          resource text NOT NULL,
          action text NOT NULL,
          PRIMARY KEY (role, resource, action)
        );
        CREATE TABLE permission_overrides (
          person_id uuid NOT NULL REFERENCES users(person_id) ON DELETE CASCADE,
          resource text NOT NULL,
          action text NOT NULL,
          allow boolean NOT NULL,
          set_by uuid REFERENCES users(person_id),
          set_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (person_id, resource, action)
        );
        CREATE TABLE totp_backup_codes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          person_id uuid NOT NULL REFERENCES users(person_id) ON DELETE CASCADE,
          code_hash text NOT NULL,
          used_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_totp_backup_codes_person ON totp_backup_codes (person_id);
        CREATE TABLE auth_sessions (
          id uuid PRIMARY KEY,
          person_id uuid NOT NULL REFERENCES users(person_id) ON DELETE CASCADE,
          family_id uuid NOT NULL,
          token_hash text NOT NULL UNIQUE,
          expires_at timestamptz NOT NULL,
          rotated_at timestamptz,
          replaced_by uuid REFERENCES auth_sessions(id),
          revoked_at timestamptz,
          revoke_reason text,
          ip_address inet,
          user_agent text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_auth_sessions_person ON auth_sessions (person_id);
        CREATE INDEX ix_auth_sessions_family ON auth_sessions (family_id);
        CREATE TABLE audit_log (
          id bigserial PRIMARY KEY,
          at timestamptz NOT NULL DEFAULT now(),
          actor_id uuid,
          action text NOT NULL,
          entity_type text NOT NULL,
          entity_id text,
          ip inet,
          changes jsonb NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX ix_audit_log_at ON audit_log (at DESC);
        CREATE TABLE import_runs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          started_at timestamptz NOT NULL DEFAULT now(),
          finished_at timestamptz,
          actor_id uuid,
          trigger text NOT NULL CHECK (trigger IN ('cli', 'web')),
          status text NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
          error text,
          added integer NOT NULL DEFAULT 0,
          updated integer NOT NULL DEFAULT 0,
          unchanged integer NOT NULL DEFAULT 0,
          disabled integer NOT NULL DEFAULT 0,
          skipped integer NOT NULL DEFAULT 0,
          rows jsonb NOT NULL DEFAULT '[]'::jsonb
        );
        CREATE INDEX ix_import_runs_started ON import_runs (started_at DESC);
    """)
    for name, label, rank in ROLES:
        op.execute(f"INSERT INTO roles (name, label, rank) VALUES ('{name}', '{label}', {rank})")
    for role, grants in GRANTS.items():
        for resource, actions in grants.items():
            for action in actions:
                op.execute("INSERT INTO role_permissions (role, resource, action) "
                           f"VALUES ('{role}', '{resource}', '{action}')")


def downgrade() -> None:
    op.execute("""
        DROP TABLE import_runs, audit_log, auth_sessions, totp_backup_codes,
                   permission_overrides, role_permissions, user_roles, users, roles
    """)
