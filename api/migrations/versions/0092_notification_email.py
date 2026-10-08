"""Notification email: groups own event categories; the mail outbox records
which kind of notification a row came from and which inbox row it mirrors.

Revision ID: 0092
Revises: 0091
Create Date: 2026-10-08
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0092"
down_revision: str | None = "0091"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CATEGORIES_CHECK = "categories <@ ARRAY['approvals','reports','wiki','security']::text[]"


def upgrade() -> None:
    op.add_column("notification_groups", sa.Column(
        "categories", postgresql.ARRAY(sa.Text()), nullable=False,
        server_default=sa.text("'{}'::text[]")))
    op.create_check_constraint("ck_notification_groups_categories",
                               "notification_groups", CATEGORIES_CHECK)
    op.add_column("email_outbox", sa.Column("kind", sa.Text(), nullable=True))
    op.add_column("email_outbox", sa.Column(
        "notification_id", postgresql.UUID(as_uuid=True),
        sa.ForeignKey("notifications.id", ondelete="SET NULL"), nullable=True))


def downgrade() -> None:
    op.drop_column("email_outbox", "notification_id")
    op.drop_column("email_outbox", "kind")
    op.drop_constraint("ck_notification_groups_categories", "notification_groups", type_="check")
    op.drop_column("notification_groups", "categories")
