"""Notification delivery log: one row per notification or email decision, and
`email_outbox.skip_reason` for mail dropped before it was sent.

- `notification_log`: written by notifications/delivery_log.py record() in the
  caller's transaction. Its links to people, notifications and email_outbox
  are ON DELETE SET NULL, each indexed so the cleanup purges of old
  notifications and mail never scan the table per deleted row: the trail
  outlives what it describes. `channel` also allows the channels that may
  arrive later (text, push); the writer accepts only the ones in use. Rows
  older than the Logging setting `local_max_age_days` are deleted by the
  log-service retention pass.
- `email_outbox.skip_reason`: the reason code of a `skipped` row (NULL for
  every other status).
- One-time data step: approval cards (membership requests, router approvals,
  password-reset requests) decided before this revision are marked read, as
  every decision marks its copies read from now on. Pending and open cards
  stay unread; a card already read keeps its first read time.

Rolling back drops the table and the column (the log and the recorded skip
reasons are lost). It leaves the read state alone: that step is data only.

Design: docs/superpowers/specs/2026-10-31-notifications-phase0-design.md

Revision ID: 0110
Revises: 0109
Create Date: 2026-10-31
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0110"
down_revision: str | None = "0109"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EVENTS_CHECK = (
    "event IN ('inbox_written', 'inbox_suppressed', 'email_queued', "
    "'email_not_queued', 'email_sent', 'email_skipped', 'email_retry', 'email_failed')"
)
CHANNELS_CHECK = "channel IN ('inbox', 'email', 'text', 'push')"


def upgrade() -> None:
    op.create_table(
        "notification_log",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("event", sa.Text(), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True),
        sa.Column("notification_id", UUID(as_uuid=True),
                  sa.ForeignKey("notifications.id", ondelete="SET NULL"), nullable=True),
        sa.Column("outbox_id", UUID(as_uuid=True),
                  sa.ForeignKey("email_outbox.id", ondelete="SET NULL"), nullable=True),
        sa.Column("kind", sa.Text(), nullable=True),
        sa.Column("category", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("detail", JSONB(), nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("process", sa.Text(), nullable=True),
        sa.CheckConstraint(EVENTS_CHECK, name="ck_notification_log_event"),
        sa.CheckConstraint(CHANNELS_CHECK, name="ck_notification_log_channel"),
    )
    # newest first and the retention delete; a person's own trail by keyset
    # (person_id, id); the three links the SET NULL cascades walk
    op.create_index("notification_log_at_idx", "notification_log", ["at"])
    op.create_index("notification_log_person_idx", "notification_log", ["person_id", "id"])
    op.create_index("notification_log_notification_idx", "notification_log",
                    ["notification_id"])
    op.create_index("notification_log_outbox_idx", "notification_log", ["outbox_id"])

    op.add_column("email_outbox", sa.Column("skip_reason", sa.Text(), nullable=True))

    # Approval cards decided before this revision stay unread otherwise: the
    # rule that a decision marks every copy read only applies to new ones.
    op.execute(
        "UPDATE notifications SET read_at = COALESCE(read_at, now()) "
        "WHERE kind IN ('membership_request', 'router_approval', 'password_reset_request') "
        "AND payload ->> 'state' IS NOT NULL "
        "AND payload ->> 'state' NOT IN ('pending', 'open')")


def downgrade() -> None:
    # the read state set by upgrade's data step is left as it is
    op.drop_column("email_outbox", "skip_reason")
    op.drop_table("notification_log")      # its indexes and checks go with it
