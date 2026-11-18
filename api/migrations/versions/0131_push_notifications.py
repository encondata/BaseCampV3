"""Push notifications: device registrations, the send outbox and the snooze column.

- push_registrations: one row per device (unique), holding its push token and the
  hash of the per-device secret the device uses to refresh or remove it.
- push_outbox: one row per message to send (a notification or a clear). A partial
  unique index allows one queued row per notification and message type.
- notifications.push_snoozed_until: a snoozed notification is not pushed again
  until this time.

Revision ID: 0131
Revises: 0130
Create Date: 2026-11-17
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0131"
down_revision: str | None = "0130"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _id() -> sa.Column:
    return sa.Column("id", UUID(as_uuid=True), primary_key=True,
                     server_default=sa.text("gen_random_uuid()"))


def _now(name: str) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=False,
                     server_default=sa.text("now()"))


def upgrade() -> None:
    op.create_table(
        "push_registrations",
        _id(),
        sa.Column("device_id", UUID(as_uuid=True),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False,
                  unique=True),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), nullable=False),
        sa.Column("platform", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("token", sa.Text(), nullable=False, unique=True),
        sa.Column("secret_hash", sa.Text(), nullable=False),
        _now("created_at"),
        _now("updated_at"),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.CheckConstraint("platform IN ('android', 'ios')",
                           name="ck_push_registrations_platform"),
        sa.CheckConstraint("provider IN ('fcm', 'apns')",
                           name="ck_push_registrations_provider"),
    )
    op.create_index("push_registrations_person_idx", "push_registrations", ["person_id"])

    op.create_table(
        "push_outbox",
        _id(),
        sa.Column("notification_id", UUID(as_uuid=True),
                  sa.ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), nullable=False),
        sa.Column("send_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("message_type", sa.Text(), nullable=False),
        _now("created_at"),
        sa.Column("handled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("reason IN ('new', 'snooze', 'clear')",
                           name="ck_push_outbox_reason"),
        sa.CheckConstraint("state IN ('queued', 'sent', 'dropped', 'failed')",
                           name="ck_push_outbox_state"),
        sa.CheckConstraint("message_type IN ('notification', 'clear')",
                           name="ck_push_outbox_message_type"),
    )
    op.create_index("push_outbox_one_queued_idx", "push_outbox",
                    ["notification_id", "message_type"], unique=True,
                    postgresql_where=sa.text("state = 'queued'"))
    op.create_index("push_outbox_state_send_idx", "push_outbox", ["state", "send_at"])

    op.add_column("notifications",
                  sa.Column("push_snoozed_until", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("notifications", "push_snoozed_until")
    op.drop_table("push_outbox")
    op.drop_table("push_registrations")
