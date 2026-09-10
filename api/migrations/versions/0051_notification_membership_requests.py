"""notification_membership_requests — self-service join/leave requests for
notification groups, approved or rejected by anyone with
notifications:change. One open (pending) request per person and group,
enforced by a partial unique index.

Revision ID: 0051
Revises: 0050
Create Date: 2026-09-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0051"
down_revision: str | None = "0050"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "notification_membership_requests",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("group_id", UUID(as_uuid=True),
                  sa.ForeignKey("notification_groups.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id"), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column("decided_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("decision_note", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index(
        "ux_membership_request_pending", "notification_membership_requests",
        ["group_id", "person_id"], unique=True,
        postgresql_where=sa.text("status = 'pending'"))
    op.create_index(
        "ix_membership_requests_status_created", "notification_membership_requests",
        ["status", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_membership_requests_status_created",
                  table_name="notification_membership_requests")
    op.drop_index("ux_membership_request_pending",
                  table_name="notification_membership_requests")
    op.drop_table("notification_membership_requests")
