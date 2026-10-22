"""Time Clock station type: `devices.station_type` gains 'timeclock'
('label' | 'rfid' | 'timeclock'; null = not chosen). A Time Clock laptop
holds a station key like the RFID and Label Stations, but the upload
routes refuse it (403 wrong_station_type).

Rolling back clears 'timeclock' to null (not chosen) before restoring the
two-value check.

Design: docs/superpowers/specs/2026-10-20-kiosk-timeclock-station-design.md

Revision ID: 0105
Revises: 0104
Create Date: 2026-10-20
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0105"
down_revision: str | None = "0104"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_devices_station_type", "devices", type_="check")
    op.create_check_constraint(
        "ck_devices_station_type", "devices",
        "station_type IS NULL OR station_type IN ('label', 'rfid', 'timeclock')")


def downgrade() -> None:
    op.execute("UPDATE devices SET station_type = NULL WHERE station_type = 'timeclock'")
    op.drop_constraint("ck_devices_station_type", "devices", type_="check")
    op.create_check_constraint(
        "ck_devices_station_type", "devices",
        "station_type IS NULL OR station_type IN ('label', 'rfid')")
