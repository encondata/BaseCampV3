"""Kiosk scan ingest — three nullable columns on `raw_scans` for the
kiosk batch endpoint (POST /kiosk/scans):

- `client_scan_id`: the kiosk-generated id for a scan, unique where it
  is set (partial index, so every pre-kiosk row and any future
  reader/import row keeps its NULL). This is what makes ingest
  idempotent — a kiosk that retries a batch it never saw the response
  for re-sends the same ids and stores nothing new.
- `scan_status`: the checkpoint the scanning device was set to, as the
  device reported it. Deliberately NOT FK'd into status_values, unlike
  the existing `status` column: this is device-reported enrichment
  data, the counterpart of `devices.scan_status`, kept verbatim even if
  the vocabulary later changes under it. `status` stays the FK'd column
  the matcher copies into processed_scans and status rules trigger on.
- `initiative_id`: the move the scan belongs to (the kiosk's current
  move). ON DELETE SET NULL — deleting a move must not delete scan
  history.

Design: docs/superpowers/specs/2026-09-13-kiosk-web-design.md

Revision ID: 0063
Revises: 0062
Create Date: 2026-09-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0063"
down_revision: str | None = "0062"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("raw_scans", sa.Column(
        "client_scan_id", postgresql.UUID(as_uuid=True), nullable=True,
        comment="kiosk-generated scan id; makes batch ingest idempotent"))
    op.create_index(
        "raw_scans_client_scan_id_uniq", "raw_scans", ["client_scan_id"],
        unique=True, postgresql_where=sa.text("client_scan_id IS NOT NULL"))
    op.add_column("raw_scans", sa.Column(
        "scan_status", sa.Text(), nullable=True,
        comment="checkpoint the scanning device was set to, as reported; "
                "un-FK'd device data (cf. devices.scan_status) — `status` "
                "is the vocabulary-checked column the matcher copies"))
    op.add_column("raw_scans", sa.Column(
        "initiative_id", postgresql.UUID(as_uuid=True),
        sa.ForeignKey("initiatives.id", ondelete="SET NULL"), nullable=True,
        comment="the move this scan belongs to; SET NULL so deleting a "
                "move never deletes scan history"))


def downgrade() -> None:
    op.drop_column("raw_scans", "initiative_id")
    op.drop_column("raw_scans", "scan_status")
    op.drop_index("raw_scans_client_scan_id_uniq", table_name="raw_scans")
    op.drop_column("raw_scans", "client_scan_id")
