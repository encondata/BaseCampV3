"""DigitalOcean environments (deploy phase 7): the two DigitalOcean
accounts (the token stored in 0009 becomes the Production account's), the
DigitalOcean record of an environment (do_environments), its slots
(do_slots) and the ownership record of every resource Sirdar made there
(do_resources), Sirdar's ACME account keys, Blue/Green fields on
environments, DigitalOcean fields on deployments, the production type and
the activate and renew modes (used by phase 7b).

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-05
"""
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

_MODES_9 = ("'update', 'reset', 'adopt', 'snapshot', 'restore_dump', 'rollback', 'publish', "
            "'teardown', 'vm_restore'")


def upgrade() -> None:
    op.execute(f"""
        CREATE TABLE do_accounts (
          key text PRIMARY KEY CHECK (key IN ('production', 'development')),
          label text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
          region text CHECK (region ~ '^[a-z]{{3}}[0-9]$'),
          token_enc bytea,
          renewal_token_enc bytea,
          team_uuid text,
          team_name text,
          updated_by uuid,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO do_accounts (key, label)
          VALUES ('production', 'Production'), ('development', 'Development');
        UPDATE do_accounts a
          SET token_enc = i.secret_enc, updated_by = i.updated_by, updated_at = i.updated_at
          FROM integrations i
          WHERE i.kind = 'digitalocean' AND a.key = 'production';
        DELETE FROM integrations WHERE kind = 'digitalocean';
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check
            CHECK (kind IN ('cloudflare', 'npm', 'proxmox', 'esxi'));

        ALTER TABLE environments
          DROP CONSTRAINT environments_type_check,
          ADD CONSTRAINT environments_type_check
            CHECK (type IN ('dev', 'beta', 'custom', 'production')),
          ADD COLUMN slots text[] NOT NULL DEFAULT '{{}}',
          ADD COLUMN active_slot text,
          ADD COLUMN auto_activate boolean NOT NULL DEFAULT false,
          ADD COLUMN retiring boolean NOT NULL DEFAULT false,
          ADD CONSTRAINT environments_slots_check
            CHECK (slots <@ ARRAY['blue', 'green', 'orange', 'purple']::text[]
                   AND cardinality(array_positions(slots, 'blue')) <= 1
                   AND cardinality(array_positions(slots, 'green')) <= 1
                   AND cardinality(array_positions(slots, 'orange')) <= 1
                   AND cardinality(array_positions(slots, 'purple')) <= 1),
          ADD CONSTRAINT environments_active_slot_check
            CHECK (active_slot IS NULL OR active_slot = ANY (slots)),
          ADD CONSTRAINT environments_production_check
            CHECK (type <> 'production' OR (target_id = 'digitalocean' AND NOT auto_activate
                                            AND slots = ARRAY['blue', 'green']::text[]));
        -- At most one production environment that isn't being retired: a
        -- cutover builds the next one while the old one retires.
        CREATE UNIQUE INDEX environments_one_production ON environments ((true))
          WHERE type = 'production' AND NOT retiring;

        ALTER TABLE deployments
          ADD COLUMN cloud boolean NOT NULL DEFAULT false,
          ADD COLUMN slot text,
          ADD COLUMN go_live boolean NOT NULL DEFAULT false,
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check
            CHECK (mode IN ({_MODES_9}, 'activate', 'renew'));

        CREATE TABLE do_environments (
          environment_id uuid PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
          account_key text NOT NULL REFERENCES do_accounts(key) ON DELETE RESTRICT,
          team_uuid text,
          region text NOT NULL CHECK (region ~ '^[a-z]{{3}}[0-9]$'),
          droplet_size text NOT NULL,
          droplet_image text NOT NULL DEFAULT 'ubuntu-24-04-x64',
          db_size text NOT NULL,
          db_standby boolean NOT NULL DEFAULT false,
          acme_staging boolean NOT NULL DEFAULT false,
          ssh_public_key text NOT NULL,
          ssh_private_key_enc bytea NOT NULL,
          acme_key_enc bytea NOT NULL,
          vpc_ip_range text,
          lb_ip text,
          db_host text,
          db_port integer,
          db_admin_password_enc bytea,
          db_ca_cert text,
          bucket text NOT NULL UNIQUE,
          spaces_key_id text,
          spaces_secret_enc bytea,
          cert_not_after timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE do_slots (
          environment_id uuid NOT NULL
            REFERENCES do_environments(environment_id) ON DELETE CASCADE,
          slot text NOT NULL CHECK (slot IN ('blue', 'green', 'orange', 'purple')),
          host_key_public text NOT NULL,
          host_key_private_enc bytea,
          droplet_id text,
          public_ip text,
          private_ip text,
          sha text,
          image_tag text,
          last_check_ok boolean,
          last_check_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (environment_id, slot)
        );

        CREATE TABLE do_resources (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          -- RESTRICT: an environment can't be deleted while it still owns
          -- DigitalOcean resources (step 18 forgets each row as it removes it).
          environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
          kind text NOT NULL CHECK (kind IN ('vpc', 'droplet', 'database', 'spaces_key',
                                             'bucket', 'certificate', 'load_balancer',
                                             'firewall')),
          do_id text NOT NULL,
          name text NOT NULL,
          slot text CHECK (slot IN ('blue', 'green', 'orange', 'purple')),
          origin text NOT NULL DEFAULT 'created' CHECK (origin IN ('created', 'claimed')),
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (kind, do_id)
        );
        CREATE INDEX do_resources_environment ON do_resources (environment_id);

        CREATE TABLE acme_accounts (
          directory text PRIMARY KEY,
          key_enc bytea NOT NULL,
          kid text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
    """)


def downgrade() -> None:
    # Refuses while Sirdar manages anything on DigitalOcean: dropping the
    # records would orphan droplets, databases and buckets that cost money.
    # The Production token goes back to the digitalocean integration; the
    # Development token has nowhere to go and is dropped.
    op.execute(f"""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM do_environments) OR EXISTS (SELECT 1 FROM do_resources)
             OR EXISTS (SELECT 1 FROM environments
                        WHERE type = 'production' OR target_id = 'digitalocean') THEN
            RAISE EXCEPTION 'Can''t downgrade below 0010 while Sirdar manages DigitalOcean '
                            'environments: delete them first.';
          END IF;
        END $$;
        ALTER TABLE integrations
          DROP CONSTRAINT integrations_kind_check,
          ADD CONSTRAINT integrations_kind_check
            CHECK (kind IN ('cloudflare', 'npm', 'proxmox', 'esxi', 'digitalocean'));
        INSERT INTO integrations (kind, config, secret_enc, updated_by, updated_at)
          SELECT 'digitalocean', '{{}}', token_enc, updated_by, updated_at
          FROM do_accounts WHERE key = 'production' AND token_enc IS NOT NULL;
        DROP TABLE acme_accounts, do_resources, do_slots, do_environments, do_accounts;
        DELETE FROM deployments WHERE mode IN ('activate', 'renew');
        ALTER TABLE deployments
          DROP COLUMN cloud, DROP COLUMN slot, DROP COLUMN go_live,
          DROP CONSTRAINT deployments_mode_check,
          ADD CONSTRAINT deployments_mode_check CHECK (mode IN ({_MODES_9}));
        DROP INDEX environments_one_production;
        ALTER TABLE environments
          DROP CONSTRAINT environments_production_check,
          DROP CONSTRAINT environments_active_slot_check,
          DROP CONSTRAINT environments_slots_check,
          DROP COLUMN slots, DROP COLUMN active_slot, DROP COLUMN auto_activate,
          DROP COLUMN retiring,
          DROP CONSTRAINT environments_type_check,
          ADD CONSTRAINT environments_type_check CHECK (type IN ('dev', 'beta', 'custom'));
    """)
