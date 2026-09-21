"""Model form factor and the orphan_node placement status.

Multi-node chassis hold nodes at fractional RUs (33.1 .. 33.4 under the
chassis at 33). The placement rule (serversherpa.racks.placement) reads
that from the position alone; `asset_models.form_factor` only enriches
it: `standalone`, `chassis` or `node`, null meaning unknown and treated
as standalone. A `node` at an integer RU or a `standalone` at a slot is
reported as a form-factor mismatch; the rail report skips nodes.

`orphan_node` is a review status in the asset vocabulary for a node with
no device starting at its RU. Like `location_collision` it carries no
progress weight.

The backfill sets form_factor from the model NAME on rows where it is
still null: `node` where the model contains "(Node)" or ends in " node",
then `chassis` where it contains "Chassis". Nothing else is inferred; a
wrong inference is worse than a blank.

Both data steps live in plain functions taking a raw connection so the
test suite can re-run them (clean_db re-seeds status_values before every
test), the 0066/0067 convention.

Downgrade returns orphan_node rows to loaded_in_system before deleting
the vocabulary row (initiative_assets.status is foreign-keyed to it).

Revision ID: 0068
Revises: 0067
Create Date: 2026-09-21
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0068"
down_revision: str | None = "0067"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FORM_FACTORS = ("standalone", "chassis", "node")


def seed_orphan_status(conn) -> None:
    conn.execute(sa.text("""
        INSERT INTO status_values
          (record_type, key, label, description, color, sort_order, progress_weight)
        VALUES ('asset', 'orphan_node', 'Orphan node',
                'A node (fractional RU) with no device starting at its RU. Review the rack position.',
                '#d97706', 0, NULL)
        ON CONFLICT (record_type, key) DO NOTHING
    """))


def backfill_form_factor(conn) -> None:
    conn.execute(sa.text("""
        UPDATE asset_models SET form_factor = 'node'
        WHERE form_factor IS NULL
          AND (model ILIKE '%(node)%' OR model ILIKE '% node')
    """))
    conn.execute(sa.text("""
        UPDATE asset_models SET form_factor = 'chassis'
        WHERE form_factor IS NULL AND model ILIKE '%chassis%'
    """))


def upgrade() -> None:
    op.add_column("asset_models", sa.Column("form_factor", sa.Text(), nullable=True))
    op.create_check_constraint(
        "asset_models_form_factor_check", "asset_models",
        "form_factor IN ('standalone', 'chassis', 'node')")
    conn = op.get_bind()
    seed_orphan_status(conn)
    backfill_form_factor(conn)


def downgrade() -> None:
    op.execute("UPDATE initiative_assets SET status = 'loaded_in_system' "
               "WHERE status = 'orphan_node'")
    op.execute("DELETE FROM status_values WHERE record_type = 'asset' AND key = 'orphan_node'")
    op.drop_constraint("asset_models_form_factor_check", "asset_models", type_="check")
    op.drop_column("asset_models", "form_factor")
