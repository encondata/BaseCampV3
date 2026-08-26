"""Merge the move_asset_status vocabulary into asset — one status list
serves assets.status and initiative_assets.status (docs/superpowers/
specs/2026-08-25-merge-asset-status-design.md).

The 23 non-colliding move keys copy over verbatim (label/description/
color/is_active/progress_weight) at sort_order 0 — "unset"; the user
renumbers by hand in Variables. The one collision, in_transit, keeps
the asset row (and its sort_order 2) but takes move's look and weight
(In Transit, #f52727, 50). initiative_assets.status_record_type
(GENERATED) rebuilds as 'asset'.

Downgrade note: it fails (FK violation) if any assets.status row uses a
moved workflow key by then — loud failure beats silently corrupting
asset statuses.

Revision ID: 0022
Revises: 0021
Create Date: 2026-08-26
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The 0019 seed keys (as amended by 0020/0021) — the rows this migration
# moves. Literal so downgrade never guesses which asset rows came from
# the merge. Values are the 0019/0020 sort orders downgrade restores.
MOVED_KEY_SORT_ORDERS: dict[str, int] = {
    "loaded_in_system": 1,
    "pre_stage": 2,
    "racked": 3,
    "labeled": 4,
    "pack_logistics": 5,
    "in_container": 6,
    "on_truck": 7,
    "received": 8,
    "un_pack": 9,
    "staged": 10,
    "re_racked": 11,
    "cabling": 12,
    "qa": 13,
    "complete": 14,
    "rfid_1_cage_exit": 20,
    "rfid_2_loading_dock": 21,
    "rfid_3_staging": 22,
    "rfid_4_into_cage": 23,
    "rfid_10_dock_to_truck": 24,
    "in_transit": 50,
    "e_waste": 51,
    "pending_client_handover": 96,
    "historical": 99,
    "location_collision": 100,
}


def upgrade() -> None:
    conn = op.get_bind()
    # 1. copy the non-colliding rows into the asset vocabulary — weights
    #    verbatim, sort_order 0 ("unset"; renumbered by hand later)
    conn.execute(sa.text("""
        INSERT INTO status_values
          (record_type, key, label, description, color, sort_order,
           is_active, progress_weight)
        SELECT 'asset', key, label, description, color, 0,
               is_active, progress_weight
        FROM status_values
        WHERE record_type = 'move_asset_status' AND key <> 'in_transit'
    """))
    # 2. the collision keeps the asset row, takes move's look and weight
    conn.execute(sa.text("""
        UPDATE status_values
        SET label = 'In Transit', color = '#f52727', progress_weight = 50
        WHERE record_type = 'asset' AND key = 'in_transit'
    """))
    # 3. re-point initiative_assets at the asset vocabulary. A generated
    #    column's expression can't be altered in place — rebuild it (the
    #    0019 idiom), FK dropped around the rebuild.
    op.drop_constraint("initiative_assets_status_fkey", "initiative_assets",
                       type_="foreignkey")
    op.drop_column("initiative_assets", "status_record_type")
    op.execute("""
        ALTER TABLE initiative_assets ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "initiative_assets_status_fkey", "initiative_assets",
        "status_values",
        ["status_record_type", "status"], ["record_type", "key"])
    # 4. the old vocabulary is now unreferenced
    conn.execute(sa.text(
        "DELETE FROM status_values WHERE record_type = 'move_asset_status'"))


def downgrade() -> None:
    conn = op.get_bind()
    # re-create the move vocabulary from the merged rows, restoring the
    # 0019/0020 sort orders (in_transit copies back with move's look —
    # exactly what it had pre-merge)
    for key, sort_order in MOVED_KEY_SORT_ORDERS.items():
        conn.execute(sa.text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order,
               is_active, progress_weight)
            SELECT 'move_asset_status', key, label, description, color,
                   :sort_order, is_active, progress_weight
            FROM status_values
            WHERE record_type = 'asset' AND key = :key
        """), {"key": key, "sort_order": sort_order})
    op.drop_constraint("initiative_assets_status_fkey", "initiative_assets",
                       type_="foreignkey")
    op.drop_column("initiative_assets", "status_record_type")
    op.execute("""
        ALTER TABLE initiative_assets ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('move_asset_status') STORED
    """)
    op.create_foreign_key(
        "initiative_assets_status_fkey", "initiative_assets",
        "status_values",
        ["status_record_type", "status"], ["record_type", "key"])
    # the asset vocabulary sheds the moved rows; in_transit reverts to
    # its 0014 look and unset weight
    keys = [k for k in MOVED_KEY_SORT_ORDERS if k != "in_transit"]
    conn.execute(
        sa.text("DELETE FROM status_values "
                "WHERE record_type = 'asset' AND key IN :keys")
        .bindparams(sa.bindparam("keys", expanding=True)),
        {"keys": keys})
    conn.execute(sa.text("""
        UPDATE status_values
        SET label = 'In transit', color = '#0f7c86', progress_weight = NULL
        WHERE record_type = 'asset' AND key = 'in_transit'
    """))
