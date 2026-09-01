"""fixed-reader fields on devices. model is SHARED (every family has
one); antennas_connected/connection_type/scan_status are the
fixed-reader block. connection_type is plain TEXT (device-reported
tolerance, like vpn_status); scan_status is OUR config — the asset
checkpoint this reader stamps (V2 devices_rfid_readers role, read by
the future matcher enrichment) — so it IS vocabulary-FK'd. Readers'
IP reuses lan_ip; reader name = reported raw_scans.device_id (the
tags-read derivation key).

Revision ID: 0039
Revises: 0038
Create Date: 2026-09-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0039"
down_revision: str | None = "0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("model", sa.Text))
    op.add_column("devices", sa.Column(
        "antennas_connected", sa.SmallInteger,
        comment="fixed-reader block; FX9600 has 8 ports"))
    op.add_column("devices", sa.Column(
        "connection_type", sa.Text,
        comment="fixed-reader block; api / mqtt / local_api"))
    op.add_column("devices", sa.Column(
        "scan_status", sa.Text,
        comment="asset checkpoint this reader stamps; matcher reads it"))
    op.execute("""
        ALTER TABLE devices ADD COLUMN scan_status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "devices_scan_status_fkey", "devices", "status_values",
        ["scan_status_record_type", "scan_status"], ["record_type", "key"])


def downgrade() -> None:
    op.drop_constraint("devices_scan_status_fkey", "devices",
                       type_="foreignkey")
    op.drop_column("devices", "scan_status_record_type")
    op.drop_column("devices", "scan_status")
    op.drop_column("devices", "connection_type")
    op.drop_column("devices", "antennas_connected")
    op.drop_column("devices", "model")
