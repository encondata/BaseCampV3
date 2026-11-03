"""Notifications Phase 2, slice 2: devices remember an offline notice, and events count failures.

- `devices.offline_notified_at`: when the notification worker's device check announced that this
  device stopped checking in. The check sets it with the announcement, so one outage is announced
  once, and clears it once the device is seen again. NULL means no notice is out.
- Rollout: every covered device that is offline right now is marked as already announced
  (`offline_notified_at = now()`), so deploying sends nothing for outages that were already going
  on. It copies the rule of services/device_online.py as it stands today, in SQL: an RFID Station
  kiosk (laptop, station type rfid), any fixed reader, or an approved router, that has checked in
  (a device never seen is skipped), and has been quiet for more than 3 minutes (a router, more
  than 4), or is a fixed reader whose station reported it unreachable. The numbers are the
  screens' own. They are repeated here and do not follow later changes to that module.
- `notification_events.attempts`: how many sweeps have failed on the event, NOT NULL and 0 for
  events that already exist. It lets the sweep take the events that failed least first, so one
  that always fails drops behind newer ones instead of blocking them. It adds no retry limit.

Rolling back drops both columns: the notices and the failure counts are lost, and the next
upgrade marks whatever is offline by then.

Design: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md

Revision ID: 0114
Revises: 0113
Create Date: 2026-11-02
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0114"
down_revision: str | None = "0113"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The rule is "quiet for more than the threshold", and the unreachable flag is the one the
# station writes with a reader report: a JSON boolean.
ROLLOUT_MARKS = """
UPDATE devices SET offline_notified_at = now()
WHERE last_seen_at IS NOT NULL AND (
    (device_type = 'kiosk' AND sub_type = 'laptop' AND station_type = 'rfid'
        AND now() - last_seen_at > interval '3 minutes')
    OR (device_type = 'fixed_reader'
        AND (now() - last_seen_at > interval '3 minutes'
             OR raw_info ->> 'reachable' = 'false'))
    OR (device_type = 'router' AND approval_state = 'approved'
        AND now() - last_seen_at > interval '4 minutes')
)
"""


def upgrade() -> None:
    op.add_column("devices", sa.Column(
        "offline_notified_at", sa.TIMESTAMP(timezone=True), nullable=True))
    op.add_column("notification_events", sa.Column(
        "attempts", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.execute(ROLLOUT_MARKS)


def downgrade() -> None:
    op.drop_column("notification_events", "attempts")
    op.drop_column("devices", "offline_notified_at")
