"""Push delivery log events: ck_notification_log_event also allows the nine
push events (push_queued, push_not_queued, push_sent, push_dropped, push_failed,
push_retry, push_token_removed, push_snoozed, push_cleared).

Revision ID: 0132
Revises: 0131
Create Date: 2026-11-17
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0132"
down_revision: str | None = "0131"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EVENTS_BEFORE = (
    "inbox_written", "inbox_suppressed", "email_queued", "email_not_queued",
    "email_sent", "email_skipped", "email_retry", "email_failed",
    "email_held", "email_summarized",
)
PUSH_EVENTS = (
    "push_queued", "push_not_queued", "push_sent", "push_dropped", "push_failed",
    "push_retry", "push_token_removed", "push_snoozed", "push_cleared",
)


def _check(events: Sequence[str]) -> str:
    return "event IN (" + ", ".join(f"'{event}'" for event in events) + ")"


def upgrade() -> None:
    op.drop_constraint("ck_notification_log_event", "notification_log", type_="check")
    op.create_check_constraint("ck_notification_log_event", "notification_log",
                               _check(EVENTS_BEFORE + PUSH_EVENTS))


def downgrade() -> None:
    # rows of the push events would block the narrower check
    op.execute("DELETE FROM notification_log WHERE event LIKE 'push\\_%'")
    op.drop_constraint("ck_notification_log_event", "notification_log", type_="check")
    op.create_check_constraint("ck_notification_log_event", "notification_log",
                               _check(EVENTS_BEFORE))
