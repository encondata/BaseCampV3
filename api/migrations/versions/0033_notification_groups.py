"""notification_groups — schema for Task 1 of the notification-groups
plan: a group carries the default delivery channels, quiet hours, active
days, and DND behavior for its members; a member row may override any of
those (NULL = inherit the group value). Also seeds the new `notifications`
permission resource (admin and up, full CRUD). Task 2 adds member
endpoints; the React UI is a later task — this migration is schema only.

Revision ID: 0033
Revises: 0032
Create Date: 2026-08-29
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT, UUID

revision: str = "0033"
down_revision: str | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FULL = ("view", "add", "change", "delete")
NOTIFICATION_ROLES = ("developer", "founder", "super_admin", "admin")


def upgrade() -> None:
    op.create_table(
        "notification_groups",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT, nullable=False, unique=True),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("channels", ARRAY(sa.Text), nullable=False,
                  server_default=sa.text("'{email,web}'::text[]")),
        sa.Column("quiet_start", sa.Time),
        sa.Column("quiet_end", sa.Time),
        sa.Column("timezone", sa.Text, nullable=False,
                  server_default="America/Chicago"),
        sa.Column("active_days", ARRAY(sa.Text), nullable=False,
                  server_default=sa.text(
                      "'{mon,tue,wed,thu,fri,sat,sun}'::text[]")),
        sa.Column("dnd_behavior", sa.Text, nullable=False,
                  server_default="defer"),
        sa.Column("urgent_bypass", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("enabled", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint(
            "channels <@ ARRAY['email','text','push','web']::text[]",
            name="notification_groups_channels_check"),
        sa.CheckConstraint(
            "active_days <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']"
            "::text[]",
            name="notification_groups_active_days_check"),
        sa.CheckConstraint(
            "dnd_behavior IN ('defer','skip')",
            name="notification_groups_dnd_behavior_check"),
        sa.CheckConstraint(
            "(quiet_start IS NULL) = (quiet_end IS NULL)",
            name="notification_groups_quiet_pair_check"),
    )

    op.create_table(
        "notification_group_members",
        sa.Column("group_id", UUID(as_uuid=True),
                  sa.ForeignKey("notification_groups.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("added_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("added_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        # nullable per-member overrides — NULL means "inherit the group value"
        sa.Column("channels", ARRAY(sa.Text)),
        sa.Column("quiet_mode", sa.Text),
        sa.Column("quiet_start", sa.Time),
        sa.Column("quiet_end", sa.Time),
        sa.Column("timezone", sa.Text),
        sa.Column("active_days", ARRAY(sa.Text)),
        sa.Column("dnd_behavior", sa.Text),
        sa.Column("urgent_bypass", sa.Boolean),
        sa.CheckConstraint(
            "channels IS NULL OR "
            "channels <@ ARRAY['email','text','push','web']::text[]",
            name="notification_group_members_channels_check"),
        sa.CheckConstraint(
            "active_days IS NULL OR "
            "active_days <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']"
            "::text[]",
            name="notification_group_members_active_days_check"),
        sa.CheckConstraint(
            "quiet_mode IS NULL OR quiet_mode IN ('none','custom')",
            name="notification_group_members_quiet_mode_check"),
        sa.CheckConstraint(
            "dnd_behavior IS NULL OR dnd_behavior IN ('defer','skip')",
            name="notification_group_members_dnd_behavior_check"),
        sa.CheckConstraint(
            "quiet_mode IS DISTINCT FROM 'custom' OR "
            "(quiet_start IS NOT NULL AND quiet_end IS NOT NULL)",
            name="notification_group_members_quiet_custom_check"),
    )

    conn = op.get_bind()
    for role in NOTIFICATION_ROLES:
        for action in FULL:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'notifications', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    op.execute("DELETE FROM role_permissions WHERE resource = 'notifications'")
    op.drop_table("notification_group_members")
    op.drop_table("notification_groups")
