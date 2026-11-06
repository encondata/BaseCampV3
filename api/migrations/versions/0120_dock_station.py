"""Dock Station type: `devices.station_type` gains 'dock'
('label' | 'rfid' | 'timeclock' | 'dock'; null = not chosen). A Dock laptop
pairs an RFID reader and holds a station key like an RFID Station, and its key
is served by the same upload, telemetry, client-asset and sound routes.

Adds `dock_passes`: one row per finished pass the laptop sent, keyed by the
laptop's own pass id, holding the reply so a retried send gets the same
answer back. A pass belongs to its device (gone with it) and names the crate
it was packed into (cleared if the crate is deleted).

Rolling back drops `dock_passes`, then clears 'dock' to null (not chosen)
before restoring the three-value check.

Design: docs/superpowers/specs/2026-11-05-dock-station-design.md

Revision ID: 0120
Revises: 0119
Create Date: 2026-11-05
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0120"
down_revision: str | None = "0119"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_devices_station_type", "devices", type_="check")
    op.create_check_constraint(
        "ck_devices_station_type", "devices",
        "station_type IS NULL OR station_type IN ('label', 'rfid', 'timeclock', 'dock')")
    op.create_table(
        "dock_passes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("device_id", UUID(as_uuid=True),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("container_id", UUID(as_uuid=True),
                  sa.ForeignKey("containers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("closed_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("reply", JSONB(), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_table("dock_passes")
    op.execute("UPDATE devices SET station_type = NULL WHERE station_type = 'dock'")
    op.drop_constraint("ck_devices_station_type", "devices", type_="check")
    op.create_check_constraint(
        "ck_devices_station_type", "devices",
        "station_type IS NULL OR station_type IN ('label', 'rfid', 'timeclock')")
