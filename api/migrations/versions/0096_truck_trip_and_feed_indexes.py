"""Truck trip start and the dashboard feed indexes.

`trucks.trip_started_at` is when the truck's current trip began (status
changed into active/in_transit from any other status); the shipment map
draws only the points reported since then. Backfill: the latest audited
status change that started a trip, else created_at for a truck that is
currently active/in_transit/at_destination, else NULL.

`ix_truck_updates_recorded_at` and `ix_audit_log_entity_type_at` serve the
shipment feed's newest-first, strictly-older-than-a-cursor reads.

Revision ID: 0096
Revises: 0095
Create Date: 2026-10-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0096"
down_revision: str | None = "0095"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BACKFILL = """
UPDATE trucks t SET trip_started_at = COALESCE(
    (SELECT max(a.at) FROM audit_log a
      WHERE a.entity_type = 'truck'
        AND a.entity_id = t.id::text
        AND a.action IN ('create', 'update')
        AND a.changes->'status'->>'to' IN ('active', 'in_transit')
        AND COALESCE(a.changes->'status'->>'from', '')
            NOT IN ('active', 'in_transit')),
    CASE WHEN t.status IN ('active', 'in_transit', 'at_destination')
         THEN t.created_at END)
"""


def upgrade() -> None:
    op.add_column("trucks", sa.Column(
        "trip_started_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(BACKFILL)
    op.create_index("ix_truck_updates_recorded_at", "truck_updates",
                    [sa.text("recorded_at DESC")])
    op.create_index("ix_audit_log_entity_type_at", "audit_log",
                    ["entity_type", sa.text("at DESC")])


def downgrade() -> None:
    op.drop_index("ix_audit_log_entity_type_at", table_name="audit_log")
    op.drop_index("ix_truck_updates_recorded_at", table_name="truck_updates")
    op.drop_column("trucks", "trip_started_at")
