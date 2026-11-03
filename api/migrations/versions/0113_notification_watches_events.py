"""Notifications Phase 2, slice 1: watches and events, and groups lose their hidden
categories.

- `notification_watches`: a person's or a notification group's subscription to one thing
  (an initiative, site, truck, device, or a wiki library, folder or page), or to chosen
  event types everywhere (an Everything watch, which has no thing). `kinds` names the
  event types heard; empty means every type that applies to the thing. Three CHECKs keep
  the shape: exactly one of `person_id` and `group_id`; at most one thing column; and an
  Everything watch names at least one kind. A unique index (`NULLS NOT DISTINCT`, so two
  Everything watches collide) allows one row per subscriber and thing. Deleting the
  subscriber or the thing deletes its watches (CASCADE); deleting whoever made one only
  clears the link (SET NULL). Each thing column has a partial index for the fan-out's
  lookup of a thing's watchers. Only the initiative, site and truck columns are used in
  this slice; the device and wiki columns wait for their slices.
- `notification_events`: something that happened, waiting to be turned into notifications.
  `notifications/events.announce()` adds a row in the caller's transaction and the
  notification worker's sweep sends the waiting ones (`sent_at` null), oldest first. Sent
  rows are kept for the Logging retention to remove, as the delivery log's are. The actor
  and the status rule are links that clear when their rows go (SET NULL), so an event
  outlives both.
- `notification_groups.categories` and its CHECK `ck_notification_groups_categories` are
  dropped. Watches give a group its job; the values were test data, and they named
  categories that are never watchable (spec section 3).

Rolling back drops both tables, rows and all, and puts `categories` back as 0092 made it
(NOT NULL, default empty) with the CHECK as 0109 widened it. Existing groups come back with
no categories: the dropped values are not restored.

Design: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md

Revision ID: 0113
Revises: 0112
Create Date: 2026-11-02
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision: str = "0113"
down_revision: str | None = "0112"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# the things a watch can point at: (column, the table it references)
THINGS = (
    ("initiative_id", "initiatives"),
    ("site_id", "sites"),
    ("truck_id", "trucks"),
    ("device_id", "devices"),
    ("wiki_space_id", "wiki_spaces"),
    ("wiki_node_id", "wiki_nodes"),
)
THING_COLUMNS = tuple(column for column, _table in THINGS)
THINGS_SET = f"num_nonnulls({', '.join(THING_COLUMNS)})"

# 0092's CHECK as 0109 widened it: the downgrade puts it back
CATEGORIES_CHECK = ("categories <@ ARRAY['approvals','reports','wiki','security',"
                    "'learning']::text[]")


def upgrade() -> None:
    op.create_table(
        "notification_watches",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), nullable=True),
        sa.Column("group_id", UUID(as_uuid=True),
                  sa.ForeignKey("notification_groups.id", ondelete="CASCADE"), nullable=True),
        *(sa.Column(column, UUID(as_uuid=True),
                    sa.ForeignKey(f"{table}.id", ondelete="CASCADE"), nullable=True)
          for column, table in THINGS),
        sa.Column("kinds", ARRAY(sa.Text()), nullable=False,
                  server_default=sa.text("'{}'::text[]")),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("(person_id IS NULL) <> (group_id IS NULL)",
                           name="ck_notification_watches_subscriber"),
        sa.CheckConstraint(f"{THINGS_SET} <= 1", name="ck_notification_watches_one_thing"),
        sa.CheckConstraint(f"{THINGS_SET} = 1 OR cardinality(kinds) > 0",
                           name="ck_notification_watches_everything_kinds"),
    )
    # one watch per subscriber and thing; the subscriber leads, so a person's own
    # watches are found through it
    op.create_index("uq_notification_watches_target", "notification_watches",
                    ["person_id", "group_id", *THING_COLUMNS],
                    unique=True, postgresql_nulls_not_distinct=True)
    op.create_index("ix_notification_watches_group_id", "notification_watches", ["group_id"])
    # a thing's watchers, for the fan-out and for the cascade when the thing is deleted
    for column in THING_COLUMNS:
        op.create_index(f"ix_notification_watches_{column}", "notification_watches", [column],
                        postgresql_where=sa.text(f"{column} IS NOT NULL"))

    op.create_table(
        "notification_events",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("subject_type", sa.Text(), nullable=False),
        sa.Column("subject_id", UUID(as_uuid=True), nullable=False),
        sa.Column("reaches", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("actor_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True),
        sa.Column("person_ids", ARRAY(UUID(as_uuid=True)), nullable=False,
                  server_default=sa.text("'{}'::uuid[]")),
        sa.Column("group_ids", ARRAY(UUID(as_uuid=True)), nullable=False,
                  server_default=sa.text("'{}'::uuid[]")),
        sa.Column("watchers", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("rule_id", UUID(as_uuid=True),
                  sa.ForeignKey("status_rules.id", ondelete="SET NULL"), nullable=True),
        sa.Column("item", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("sent_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    # the sweep's read (the rows still waiting, in id order) and the retention delete
    op.create_index("ix_notification_events_waiting", "notification_events", ["id"],
                    postgresql_where=sa.text("sent_at IS NULL"))
    op.create_index("ix_notification_events_sent_at", "notification_events", ["sent_at"])

    op.drop_constraint("ck_notification_groups_categories", "notification_groups",
                       type_="check")
    op.drop_column("notification_groups", "categories")


def downgrade() -> None:
    op.drop_table("notification_events")      # its indexes go with it
    op.drop_table("notification_watches")     # its indexes and checks go with it

    # existing groups come back with no categories
    op.add_column("notification_groups", sa.Column(
        "categories", ARRAY(sa.Text()), nullable=False,
        server_default=sa.text("'{}'::text[]")))
    op.create_check_constraint("ck_notification_groups_categories", "notification_groups",
                               CATEGORIES_CHECK)
