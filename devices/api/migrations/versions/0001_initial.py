"""Devices initial schema: apps and versions, iPhones and their profiles,
signed builds, enrollment links, uploads, the job queue and Apple settings.

Revision ID: 0001
Revises:
Create Date: 2026-11-17
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE apple_settings (
          id integer PRIMARY KEY CONSTRAINT apple_settings_singleton CHECK (id = 1),
          team_id text,
          issuer_id text,
          key_id text,
          p8_enc bytea,
          p12_enc bytea,
          p12_password_enc bytea,
          cert_name text,
          cert_serial text,
          cert_expires_at timestamptz,
          asc_certificate_id text,
          updated_by uuid,
          updated_by_name text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE apps (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          platform text NOT NULL
            CONSTRAINT apps_platform_check CHECK (platform IN ('android', 'ios')),
          identifier text NOT NULL,
          name text NOT NULL,
          icon_key text,
          signing_digest text,
          asc_bundle_id text,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT apps_platform_identifier_key UNIQUE (platform, identifier)
        );

        CREATE TABLE app_versions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
          version_name text NOT NULL,
          build text NOT NULL,
          build_sort bigint NOT NULL,
          notes text NOT NULL DEFAULT '',
          file_key text NOT NULL,
          size bigint NOT NULL,
          sha256 text NOT NULL,
          min_os text,
          uploaded_by uuid NOT NULL,
          uploaded_by_name text NOT NULL,
          uploaded_at timestamptz NOT NULL DEFAULT now(),
          is_current boolean NOT NULL DEFAULT false,
          deleted_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT app_versions_app_id_version_name_build_key
            UNIQUE (app_id, version_name, build)
        );
        CREATE UNIQUE INDEX app_versions_one_current_idx ON app_versions (app_id)
          WHERE is_current AND deleted_at IS NULL;

        CREATE TABLE ios_devices (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          udid text NOT NULL UNIQUE,
          name text NOT NULL,
          product text NOT NULL,
          os_version text NOT NULL,
          serial text,
          added_by uuid NOT NULL,
          added_by_name text NOT NULL,
          added_at timestamptz NOT NULL DEFAULT now(),
          status text NOT NULL DEFAULT 'pending'
            CONSTRAINT ios_devices_status_check
            CHECK (status IN ('pending', 'registered', 'failed', 'disabled')),
          error text,
          asc_device_id text,
          device_class text,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE ios_profiles (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          app_id uuid NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
          asc_profile_id text NOT NULL,
          uuid text NOT NULL,
          content bytea NOT NULL,
          expires_at timestamptz NOT NULL,
          device_ids uuid[] NOT NULL DEFAULT '{}',
          created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE signed_builds (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          version_id uuid NOT NULL REFERENCES app_versions(id) ON DELETE CASCADE,
          profile_uuid text NOT NULL,
          status text NOT NULL DEFAULT 'queued'
            CONSTRAINT signed_builds_status_check
            CHECK (status IN ('queued', 'running', 'ready', 'failed')),
          file_key text,
          error text,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT signed_builds_version_id_profile_uuid_key UNIQUE (version_id, profile_uuid)
        );

        CREATE TABLE enroll_tokens (
          token_hash text PRIMARY KEY,
          person_id uuid NOT NULL,
          person_name text NOT NULL,
          device_name text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL,
          used_at timestamptz
        );

        CREATE TABLE uploads (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          file_key text NOT NULL,
          filename text NOT NULL,
          size bigint NOT NULL,
          created_by uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          inspected jsonb,
          committed_at timestamptz
        );

        CREATE TABLE jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          kind text NOT NULL
            CONSTRAINT jobs_kind_check
            CHECK (kind IN ('register_device', 'rebuild_profiles', 'sign_build',
                            'ensure_bundle', 'disable_device', 'sync_devices')),
          payload jsonb,
          status text NOT NULL DEFAULT 'queued'
            CONSTRAINT jobs_status_check
            CHECK (status IN ('queued', 'running', 'done', 'failed')),
          attempts integer NOT NULL DEFAULT 0,
          error text,
          result jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          started_at timestamptz,
          progress_at timestamptz,
          finished_at timestamptz
        );
        CREATE INDEX jobs_status_created_idx ON jobs (status, created_at);

        CREATE TABLE apple_device_counts (
          device_class text PRIMARY KEY,
          count integer NOT NULL DEFAULT 0,
          synced_at timestamptz NOT NULL DEFAULT now()
        );
    """)


def downgrade() -> None:
    op.execute("""
        DROP TABLE apple_device_counts;
        DROP TABLE jobs;
        DROP TABLE uploads;
        DROP TABLE enroll_tokens;
        DROP TABLE signed_builds;
        DROP TABLE ios_profiles;
        DROP TABLE ios_devices;
        DROP TABLE app_versions;
        DROP TABLE apps;
        DROP TABLE apple_settings;
    """)
