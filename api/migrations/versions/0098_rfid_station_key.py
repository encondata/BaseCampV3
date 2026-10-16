"""RFID station keys: a per-kiosk upload secret (sha256 only), the moves each
kiosk was ever keyed for, and the Off move flag on raw/processed scans.

Revision ID: 0098
Revises: 0097
Create Date: 2026-10-16
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0098"
down_revision: str | None = "0097"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.TIMESTAMP(timezone=True)


def upgrade() -> None:
    op.add_column("devices", sa.Column("station_key_hash", sa.Text, nullable=True))
    op.create_unique_constraint("uq_devices_station_key_hash", "devices",
                                ["station_key_hash"])
    op.add_column("devices", sa.Column("station_key_issued_at", TS, nullable=True))
    op.add_column("devices", sa.Column(
        "station_key_issued_by", UUID(as_uuid=True),
        sa.ForeignKey("people.id"), nullable=True))
    op.add_column("devices", sa.Column("station_key_issued_via", sa.Text, nullable=True))
    op.create_table(
        "device_station_moves",
        sa.Column("device_id", UUID(as_uuid=True),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"), nullable=False),
        sa.Column("first_issued_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("device_id", "initiative_id"),
    )
    for table in ("raw_scans", "processed_scans"):
        op.add_column(table, sa.Column("off_move", sa.Boolean, nullable=False,
                                       server_default=sa.text("false")))


def downgrade() -> None:
    for table in ("processed_scans", "raw_scans"):
        op.drop_column(table, "off_move")
    op.drop_table("device_station_moves")
    op.drop_column("devices", "station_key_issued_via")
    op.drop_column("devices", "station_key_issued_by")
    op.drop_column("devices", "station_key_issued_at")
    op.drop_constraint("uq_devices_station_key_hash", "devices", type_="unique")
    op.drop_column("devices", "station_key_hash")
