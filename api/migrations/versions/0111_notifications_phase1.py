"""Notifications Phase 1: held email, two new log events, and each person's
own switches in place of their per-category choice.

- `notification_held`: one row per notification email held for its recipient's
  summary (quiet hours or a day off). The email is not rendered or queued at
  notify time, so a row only points at the inbox row. A person's deletion
  deletes their rows (CASCADE); a deleted notification leaves the row with the
  link cleared (SET NULL), so the summary can drop it with a logged reason. Rows
  are deleted once handled; the history lives in `notification_log`.
- `ck_notification_log_event` allows ten events: the eight of 0110 plus
  `email_held` and `email_summarized`.
- One-time data step over `user_accounts.ui_prefs`. `notif.categories` (a choice
  of email, inbox or off for each category) becomes `notif.switches`, holding
  only what the person turned off: `inbox` -> `{"email": false}`, `off` ->
  `{"inbox": false, "email": false}`; `email`, or anything else, adds nothing,
  because the company defaults start out all on. Only the four configurable
  categories carry over (account security is always on). It merges into any
  `switches` already there, a value already set winning, and removes
  `categories`. The legacy keys `critical`, `email`, `maint` and `digest` are
  stripped from `notif`, so they can never leak into a field of the new shape.
  An account without a `notif` object is not touched.

Rolling back restores `categories` from `switches` (inbox off -> `off`, else
email off -> `inbox`, else `email`, for all five categories) and drops
`switches` and `schedule`; it deletes the `email_held` and `email_summarized`
log rows so the eight-event CHECK can return, and drops the table. The legacy
keys and the held rows are not restored.

Design: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md

Revision ID: 0111
Revises: 0110
Create Date: 2026-11-01
"""
import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0111"
down_revision: str | None = "0110"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EVENTS_BEFORE = (
    "inbox_written", "inbox_suppressed", "email_queued", "email_not_queued",
    "email_sent", "email_skipped", "email_retry", "email_failed",
)
EVENTS_AFTER = EVENTS_BEFORE + ("email_held", "email_summarized")

REASON_CHECK = "reason IN ('quiet_hours', 'inactive_day')"

# The categories that carry a switch. Account security is always on, so it
# never has one (the rollback still writes it back, as "email").
CONFIGURABLE = ("approvals", "reports", "wiki", "learning")
LEGACY_KEYS = ("critical", "email", "maint", "digest")

# the old choice -> the switch values it turns off
SWITCHES_OF_CHOICE = {
    "inbox": {"email": False},
    "off": {"inbox": False, "email": False},
}


def _events_check(events: Sequence[str]) -> str:
    return "event IN (" + ", ".join(f"'{event}'" for event in events) + ")"


def _switches_from_choices(notif: dict) -> dict:
    """`notif` in the new shape: categories moved into switches, legacy keys gone."""
    out = {key: value for key, value in notif.items()
           if key != "categories" and key not in LEGACY_KEYS}
    categories = notif.get("categories")
    converted = {}
    if isinstance(categories, dict):
        for category in CONFIGURABLE:
            choice = categories.get(category)
            if isinstance(choice, str) and choice in SWITCHES_OF_CHOICE:
                converted[category] = dict(SWITCHES_OF_CHOICE[choice])
    if converted:
        switches = out.get("switches")
        merged = dict(switches) if isinstance(switches, dict) else {}
        for category, values in converted.items():
            existing = merged.get(category)
            # a value the person already set in the new shape wins
            merged[category] = {**values, **existing} if isinstance(existing, dict) else values
        out["switches"] = merged
    return out


def _choice_from_switches(own: object) -> str:
    """The old choice for one category's own values."""
    if not isinstance(own, dict):
        return "email"
    if own.get("inbox") is False:
        return "off"
    if own.get("email") is False:
        return "inbox"
    return "email"


def _choices_from_switches(notif: dict) -> dict:
    """`notif` in the old shape: switches turned back into a choice per category."""
    switches = notif.get("switches")
    switches = switches if isinstance(switches, dict) else {}
    out = {key: value for key, value in notif.items() if key not in ("switches", "schedule")}
    out["categories"] = {category: _choice_from_switches(switches.get(category))
                         for category in CONFIGURABLE}
    out["categories"]["security"] = "email"       # always on, whatever else is stored
    return out


def _rewrite_notif(convert) -> None:
    """Apply `convert` to the `notif` object of every account that has one,
    writing only the accounts it changes."""
    conn = op.get_bind()
    rows = conn.execute(sa.text(
        "SELECT person_id, ui_prefs FROM user_accounts "
        "WHERE jsonb_typeof(ui_prefs -> 'notif') = 'object'")).fetchall()
    for person_id, prefs in rows:
        converted = convert(prefs["notif"])
        if converted != prefs["notif"]:
            conn.execute(
                sa.text("UPDATE user_accounts SET ui_prefs = CAST(:prefs AS jsonb) "
                        "WHERE person_id = :person_id"),
                {"prefs": json.dumps({**prefs, "notif": converted}), "person_id": person_id})


def upgrade() -> None:
    op.create_table(
        "notification_held",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), nullable=False),
        sa.Column("notification_id", UUID(as_uuid=True),
                  sa.ForeignKey("notifications.id", ondelete="SET NULL"), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("held_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.CheckConstraint(REASON_CHECK, name="ck_notification_held_reason"),
    )
    # a person's held rows, oldest first: the sweep's due check and its read
    op.create_index("notification_held_person_idx", "notification_held",
                    ["person_id", "held_at"])

    op.drop_constraint("ck_notification_log_event", "notification_log", type_="check")
    op.create_check_constraint("ck_notification_log_event", "notification_log",
                               _events_check(EVENTS_AFTER))

    _rewrite_notif(_switches_from_choices)


def downgrade() -> None:
    _rewrite_notif(_choices_from_switches)

    # rows of the two new events would block the narrower check
    op.execute("DELETE FROM notification_log "
               "WHERE event IN ('email_held', 'email_summarized')")
    op.drop_constraint("ck_notification_log_event", "notification_log", type_="check")
    op.create_check_constraint("ck_notification_log_event", "notification_log",
                               _events_check(EVENTS_BEFORE))

    op.drop_table("notification_held")      # its index and check go with it
