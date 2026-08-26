"""progress_weight on status_values — admin-editable 0-100 weight driving
the weighted move-asset progress bar (docs/superpowers/specs/
2026-08-25-weighted-progress-design.md). Generic column on the shared
vocabulary table; only move_asset_status is seeded/exposed for now. A
null weight excludes the status from the progress calculation entirely
(parked/error states must not drag the number).

Seed weights are VERBATIM from the design doc's table, which lists all 24
move_asset_status keys (in_container included, as a mid-pipeline state —
v2 process order 6, between pack_logistics (31) and on_truck (46) — weight
38). Two keys are explicitly nulled to match the doc (historical,
location_collision).

Revision ID: 0021
Revises: 0020
Create Date: 2026-08-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# key -> weight, VERBATIM from the design doc's seed table (all 24 keys).
MOVE_ASSET_STATUS_WEIGHTS: dict[str, int | None] = {
    "loaded_in_system": 0,
    "pre_stage": 8,
    "racked": 15,
    "labeled": 23,
    "pack_logistics": 31,
    "in_container": 38,
    "rfid_1_cage_exit": 35,
    "rfid_2_loading_dock": 40,
    "rfid_10_dock_to_truck": 44,
    "on_truck": 46,
    "in_transit": 50,
    "received": 54,
    "un_pack": 62,
    "staged": 69,
    "rfid_3_staging": 65,
    "rfid_4_into_cage": 72,
    "re_racked": 77,
    "cabling": 85,
    "qa": 92,
    "pending_client_handover": 95,
    "complete": 100,
    "e_waste": 100,
    "historical": None,
    "location_collision": None,
}


def upgrade() -> None:
    op.add_column("status_values", sa.Column(
        "progress_weight", sa.Integer, nullable=True,
        comment="0-100 or null (excluded); admin-tunable, currently seeded "
                "only for move_asset_status"))
    op.create_check_constraint(
        "status_values_progress_weight_check", "status_values",
        "progress_weight IS NULL OR "
        "(progress_weight >= 0 AND progress_weight <= 100)")

    conn = op.get_bind()
    for key, weight in MOVE_ASSET_STATUS_WEIGHTS.items():
        conn.execute(sa.text(
            "UPDATE status_values SET progress_weight = :weight "
            "WHERE record_type = 'move_asset_status' AND key = :key"),
            {"weight": weight, "key": key})


def downgrade() -> None:
    op.drop_constraint("status_values_progress_weight_check", "status_values")
    op.drop_column("status_values", "progress_weight")
