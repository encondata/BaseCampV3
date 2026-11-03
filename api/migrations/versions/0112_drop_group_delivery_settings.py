"""Groups keep members only: the delivery columns and their CHECKs are dropped.

Since Notifications Phase 1 a person's own switches and schedule decide their
email (notifications/email.py), so a notification group no longer carries delivery
settings and a member no longer overrides them. A group is a name, a description,
Active or Paused, its members and their join and leave requests.

- `notification_groups` loses `channels`, `quiet_start`, `quiet_end`, `timezone`,
  `active_days`, `dnd_behavior` and `urgent_bypass`, and the CHECKs
  `notification_groups_channels_check`, `_active_days_check`, `_dnd_behavior_check`
  and `_quiet_pair_check`. `categories` and its CHECK stay: the API still reads
  and writes it, and nothing shows it.
- `notification_group_members` loses its overrides of those: `channels`,
  `quiet_mode`, `quiet_start`, `quiet_end`, `timezone`, `active_days`,
  `dnd_behavior` and `urgent_bypass`, and the CHECKs
  `notification_group_members_channels_check`, `_active_days_check`,
  `_quiet_mode_check`, `_dnd_behavior_check` and `_quiet_custom_check`.

The values in those columns go with them: they were test data (spec section 6).
Rolling back restores the schema, not the values. The columns return with the
defaults migration 0033 gave them (0034's for the timezone) and so do their CHECKs,
which leaves every existing group on the defaults and every member without
overrides.

Design: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md

Revision ID: 0112
Revises: 0111
Create Date: 2026-11-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY

revision: str = "0112"
down_revision: str | None = "0111"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CHANNELS = "ARRAY['email','text','push','web']::text[]"
DAYS = "ARRAY['mon','tue','wed','thu','fri','sat','sun']::text[]"

# (name, expression) exactly as migration 0033 made them, in the order it made them
GROUP_CHECKS = (
    ("notification_groups_channels_check", f"channels <@ {CHANNELS}"),
    ("notification_groups_active_days_check", f"active_days <@ {DAYS}"),
    ("notification_groups_dnd_behavior_check", "dnd_behavior IN ('defer','skip')"),
    ("notification_groups_quiet_pair_check", "(quiet_start IS NULL) = (quiet_end IS NULL)"),
)
MEMBER_CHECKS = (
    ("notification_group_members_channels_check",
     f"channels IS NULL OR channels <@ {CHANNELS}"),
    ("notification_group_members_active_days_check",
     f"active_days IS NULL OR active_days <@ {DAYS}"),
    ("notification_group_members_quiet_mode_check",
     "quiet_mode IS NULL OR quiet_mode IN ('none','custom')"),
    ("notification_group_members_dnd_behavior_check",
     "dnd_behavior IS NULL OR dnd_behavior IN ('defer','skip')"),
    ("notification_group_members_quiet_custom_check",
     "quiet_mode IS DISTINCT FROM 'custom' OR "
     "(quiet_start IS NOT NULL AND quiet_end IS NOT NULL)"),
)


def _group_columns() -> list[sa.Column]:
    """The group's columns as 0033 made them, with 0034's timezone default."""
    return [
        sa.Column("channels", ARRAY(sa.Text), nullable=False,
                  server_default=sa.text("'{email,web}'::text[]")),
        sa.Column("quiet_start", sa.Time),
        sa.Column("quiet_end", sa.Time),
        sa.Column("timezone", sa.Text, nullable=False,
                  server_default="America/New_York"),
        sa.Column("active_days", ARRAY(sa.Text), nullable=False,
                  server_default=sa.text("'{mon,tue,wed,thu,fri,sat,sun}'::text[]")),
        sa.Column("dnd_behavior", sa.Text, nullable=False, server_default="defer"),
        sa.Column("urgent_bypass", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
    ]


def _member_columns() -> list[sa.Column]:
    """The member's overrides as 0033 made them: all nullable, NULL meaning inherit."""
    return [
        sa.Column("channels", ARRAY(sa.Text)),
        sa.Column("quiet_mode", sa.Text),
        sa.Column("quiet_start", sa.Time),
        sa.Column("quiet_end", sa.Time),
        sa.Column("timezone", sa.Text),
        sa.Column("active_days", ARRAY(sa.Text)),
        sa.Column("dnd_behavior", sa.Text),
        sa.Column("urgent_bypass", sa.Boolean),
    ]


def upgrade() -> None:
    # the CHECKs first, by name, so the migration says what goes; the columns follow
    for name, _expression in GROUP_CHECKS:
        op.drop_constraint(name, "notification_groups", type_="check")
    for name, _expression in MEMBER_CHECKS:
        op.drop_constraint(name, "notification_group_members", type_="check")
    for column in _group_columns():
        op.drop_column("notification_groups", column.name)
    for column in _member_columns():
        op.drop_column("notification_group_members", column.name)


def downgrade() -> None:
    # existing groups take the defaults and existing members have no overrides
    for column in _group_columns():
        op.add_column("notification_groups", column)
    for column in _member_columns():
        op.add_column("notification_group_members", column)
    for name, expression in GROUP_CHECKS:
        op.create_check_constraint(name, "notification_groups", expression)
    for name, expression in MEMBER_CHECKS:
        op.create_check_constraint(name, "notification_group_members", expression)
