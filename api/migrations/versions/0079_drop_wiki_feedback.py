"""Wiki: drop wiki_feedback — the "Was this page helpful?" feature (the
PUT /pages/{id}/feedback and GET .../feedback/mine routes, and the
Helpfulness/Recent "No" comments analytics cards) is removed.

The downgrade recreates the table exactly as 0076 created it.

Revision ID: 0079
Revises: 0078
Create Date: 2026-09-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0079"
down_revision: str | None = "0078"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("wiki_feedback")


def downgrade() -> None:
    op.create_table(
        "wiki_feedback",
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("helpful", sa.Boolean, nullable=False),
        sa.Column("comment", sa.Text),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("comment IS NULL OR char_length(comment) <= 2000",
                           name="wiki_feedback_comment_length_check"),
    )
