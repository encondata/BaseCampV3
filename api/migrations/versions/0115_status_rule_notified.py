"""Notifications Phase 2, slice 4: a status rule remembers when it last notified about a thing.

- `status_rule_notified`: when a rule's Notify action last told anyone about a matched thing (an
  asset, a container or a person). The action notifies about the same thing again only an hour
  later; it checks and sets the row in one upsert, so two scan workers matching the same thing at
  once notify once. The primary key is the rule and the thing (`rule_id`, `subject_type`,
  `subject_id`); deleting the rule deletes its rows (CASCADE). The thing is not a foreign key:
  it is one of three tables, and a row about a deleted thing is never matched again.

Rolling back drops the table: each rule's next match after an upgrade notifies, whenever it last
did.

Design: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md

Revision ID: 0115
Revises: 0114
Create Date: 2026-11-03
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0115"
down_revision: str | None = "0114"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "status_rule_notified",
        sa.Column("rule_id", UUID(as_uuid=True),
                  sa.ForeignKey("status_rules.id", ondelete="CASCADE"), nullable=False),
        sa.Column("subject_type", sa.Text(), nullable=False),
        sa.Column("subject_id", UUID(as_uuid=True), nullable=False),
        sa.Column("notified_at", sa.TIMESTAMP(timezone=True), nullable=False),
        # the guard's lookup and the cascade from a deleted rule both lead with the rule
        sa.PrimaryKeyConstraint("rule_id", "subject_type", "subject_id"),
    )


def downgrade() -> None:
    op.drop_table("status_rule_notified")
