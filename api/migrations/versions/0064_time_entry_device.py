"""Kiosk provenance on `time_entries` — which kiosk took a punch.

`source` already exists (text NOT NULL, default 'punch', migration
0028); the kiosk simply writes 'kiosk' into it, so this migration only
adds the device link:

- `device_id`: the kiosk Device whose screen the punch was taken on.
  Nullable — every self-service punch and every manually entered row
  has none — and ON DELETE SET NULL, since retiring a kiosk must never
  delete someone's timesheet history.

Design: docs/superpowers/specs/2026-09-13-kiosk-web-design.md

Revision ID: 0064
Revises: 0063
Create Date: 2026-09-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0064"
down_revision: str | None = "0063"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("time_entries", sa.Column(
        "device_id", postgresql.UUID(as_uuid=True),
        sa.ForeignKey("devices.id", ondelete="SET NULL"), nullable=True,
        comment="the kiosk this punch was taken on (source = 'kiosk'); "
                "SET NULL so retiring a kiosk never deletes time history"))
    op.create_index("time_entries_device_idx", "time_entries", ["device_id"])


def downgrade() -> None:
    op.drop_index("time_entries_device_idx", table_name="time_entries")
    op.drop_column("time_entries", "device_id")
