DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text NOT NULL,
  last_name text NOT NULL,
  preferred_name text,
  job_title text,
  email citext,
  phone text,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  postal_code text,
  country text NOT NULL DEFAULT 'US',
  archived_at timestamptz
);
CREATE TABLE user_accounts (
  person_id uuid PRIMARY KEY REFERENCES people(id),
  email citext NOT NULL,
  password_hash text,
  must_change_password boolean NOT NULL DEFAULT false,
  password_updated_at timestamptz,
  totp_secret_enc bytea,
  totp_confirmed_at timestamptz,
  totp_required boolean NOT NULL DEFAULT false,
  totp_last_counter bigint,
  disabled_at timestamptz
);
CREATE TABLE roles (
  name text PRIMARY KEY,
  label text,
  rank integer NOT NULL DEFAULT 0,
  scope_anchor text NOT NULL DEFAULT 'global',
  color text,
  totp_required boolean NOT NULL DEFAULT false
);
CREATE TABLE person_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id),
  role text NOT NULL REFERENCES roles(name),
  revoked_at timestamptz
);
CREATE TABLE access_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  totp_required boolean NOT NULL DEFAULT false
);
CREATE TABLE access_group_members (
  group_id uuid NOT NULL REFERENCES access_groups(id),
  person_id uuid NOT NULL REFERENCES people(id),
  PRIMARY KEY (group_id, person_id)
);
CREATE TABLE totp_backup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES user_accounts(person_id),
  code_hash text NOT NULL,
  used_at timestamptz
);
CREATE TABLE system_config (
  section text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
