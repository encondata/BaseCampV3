"""Scan troubleshooting data: the matcher's trace and the kiosk's own match.

raw_scans gains
- `kiosk_asset_id`: the asset the kiosk matched the scan to on the device
  (POST /kiosk/scans `asset_id`, the enrolled asset for an RFID enroll),
  which was sent but dropped. Device data, not a foreign key: the kiosk's
  copy of the move can name an asset since deleted.
- `match_trace`: what the scan-matching worker did on its latest attempt
  (the value, tags-only or the full ladder, each lookup with its hits, the
  outcome and why). NULL until the worker has tried; scans recorded before
  this migration keep NULL.

processed_scans gains the same two (copied from the raw row on a match;
manual status edits get a "manual" trace) plus the raw context the worker
used to drop: `client_scan_id`, `scan_status` and `initiative_id`.

/admin/scans shows all of it in an entry's Raw view.

Revision ID: 0125
Revises: 0124
Create Date: 2026-11-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0125"
down_revision: str | None = "0124"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("raw_scans", sa.Column(
        "kiosk_asset_id", UUID(as_uuid=True), nullable=True,
        comment="the asset the kiosk matched on the device, as reported "
                "(not a foreign key: device data)"))
    op.add_column("raw_scans", sa.Column(
        "match_trace", JSONB, nullable=True,
        comment="the scan-matching worker's latest attempt: lookups, "
                "hits, outcome and reason"))
    op.add_column("processed_scans", sa.Column(
        "kiosk_asset_id", UUID(as_uuid=True), nullable=True,
        comment="copied from raw_scans"))
    op.add_column("processed_scans", sa.Column(
        "match_trace", JSONB, nullable=True,
        comment="copied from raw_scans; 'manual' for a portal status edit"))
    op.add_column("processed_scans", sa.Column(
        "client_scan_id", UUID(as_uuid=True), nullable=True,
        comment="copied from raw_scans"))
    op.add_column("processed_scans", sa.Column(
        "scan_status", sa.Text, nullable=True,
        comment="copied from raw_scans"))
    op.add_column("processed_scans", sa.Column(
        "initiative_id", UUID(as_uuid=True),
        sa.ForeignKey("initiatives.id", ondelete="SET NULL"), nullable=True,
        comment="copied from raw_scans: the move the scan belongs to"))
    op.create_index("ix_processed_scans_initiative_id", "processed_scans",
                    ["initiative_id"])


def downgrade() -> None:
    op.drop_index("ix_processed_scans_initiative_id", table_name="processed_scans")
    for col in ("initiative_id", "scan_status", "client_scan_id", "match_trace",
                "kiosk_asset_id"):
        op.drop_column("processed_scans", col)
    for col in ("match_trace", "kiosk_asset_id"):
        op.drop_column("raw_scans", col)
