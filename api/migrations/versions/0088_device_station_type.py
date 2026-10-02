"""Kiosk station type and the paired RFID reader.

`devices.station_type` ('label' | 'rfid'; null = not chosen) and the paired
Zebra FX reader's address, serial, model, versions and pairing time. Set by
POST /kiosk/setup; the heartbeat never touches them.

Revision ID: 0088
Revises: 0087
Create Date: 2026-10-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0088"
down_revision: str | None = "0087"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("station_type", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_devices_station_type", "devices",
        "station_type IS NULL OR station_type IN ('label', 'rfid')")
    op.add_column("devices", sa.Column("rfid_reader_ip", postgresql.INET(), nullable=True))
    op.add_column("devices", sa.Column("rfid_reader_serial", sa.Text(), nullable=True))
    op.add_column("devices", sa.Column("rfid_reader_model", sa.Text(), nullable=True))
    op.add_column("devices", sa.Column(
        "rfid_reader_versions", postgresql.JSONB(none_as_null=True), nullable=True))
    op.add_column("devices", sa.Column(
        "rfid_paired_at", sa.TIMESTAMP(timezone=True), nullable=True))


def downgrade() -> None:
    for col in ("rfid_paired_at", "rfid_reader_versions", "rfid_reader_model",
                "rfid_reader_serial", "rfid_reader_ip"):
        op.drop_column("devices", col)
    op.drop_constraint("ck_devices_station_type", "devices", type_="check")
    op.drop_column("devices", "station_type")
