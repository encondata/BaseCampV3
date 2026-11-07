"""Seed Data recipes: the recipe tables, the snapshot columns that link a
recipe-made snapshot to its recipe and source, and the `seed_data` grants.

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-07
"""
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None

FULL = ("view", "add", "change")   # Seed Data has no delete action, like Deploy

# Frozen: the seed_data grants this migration seeds (hand-copied, not imported).
SEED_DATA_GRANTS: dict[str, tuple[str, ...]] = {
    "developer": FULL,
    "founder": FULL,
    "super_admin": FULL,
    "admin": ("view",),
}


def upgrade() -> None:
    op.execute("""
        CREATE TABLE seed_recipes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL UNIQUE,
          notes text NOT NULL DEFAULT '',
          created_by uuid,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE seed_recipe_tables (
          recipe_id uuid NOT NULL REFERENCES seed_recipes(id) ON DELETE CASCADE,
          table_name text NOT NULL,
          mode text NOT NULL CHECK (mode IN ('rows', 'all')),
          PRIMARY KEY (recipe_id, table_name)
        );
        CREATE TABLE seed_recipe_rows (
          recipe_id uuid NOT NULL REFERENCES seed_recipes(id) ON DELETE CASCADE,
          table_name text NOT NULL,
          pk jsonb NOT NULL,
          PRIMARY KEY (recipe_id, table_name, pk)
        );
        CREATE TABLE seed_recipe_files (
          recipe_id uuid NOT NULL REFERENCES seed_recipes(id) ON DELETE CASCADE,
          key text NOT NULL,
          keep boolean NOT NULL,
          PRIMARY KEY (recipe_id, key)
        );
        ALTER TABLE snapshots
          DROP CONSTRAINT snapshots_origin_check,
          ADD CONSTRAINT snapshots_origin_check CHECK (origin IN ('upload', 'environment', 'recipe')),
          ADD COLUMN recipe_id uuid REFERENCES seed_recipes(id) ON DELETE SET NULL,
          ADD COLUMN source_snapshot_id uuid REFERENCES snapshots(id) ON DELETE SET NULL,
          ADD COLUMN reset_passwords boolean NOT NULL DEFAULT false;
    """)
    for role, actions in SEED_DATA_GRANTS.items():
        for action in actions:
            op.execute(
                f"INSERT INTO role_permissions (role, resource, action) "
                f"SELECT '{role}', 'seed_data', '{action}' "
                f"WHERE EXISTS (SELECT 1 FROM roles WHERE name = '{role}') "
                f"ON CONFLICT DO NOTHING")


def downgrade() -> None:
    # Recipe bundle files stay on disk in SIRDAR_SNAPSHOTS_DIR; remove them by hand.
    op.execute("DELETE FROM role_permissions WHERE resource = 'seed_data'")
    op.execute("""
        DELETE FROM snapshots WHERE origin = 'recipe';
        ALTER TABLE snapshots
          DROP COLUMN reset_passwords,
          DROP COLUMN source_snapshot_id,
          DROP COLUMN recipe_id,
          DROP CONSTRAINT snapshots_origin_check,
          ADD CONSTRAINT snapshots_origin_check CHECK (origin IN ('upload', 'environment'));
        DROP TABLE seed_recipe_files;
        DROP TABLE seed_recipe_rows;
        DROP TABLE seed_recipe_tables;
        DROP TABLE seed_recipes;
    """)
