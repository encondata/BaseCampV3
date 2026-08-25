"""pending_deletes — god-mode staging area for hard deletes. A developer
marks an entity; the marker sits visible (and undoable) until an explicit
reconcile pass hard-deletes every still-marked target. entity_label is a
display-only snapshot (the name at mark time) so the list still reads
sensibly even if the target changes before reconcile runs.

Revision ID: 0018
Revises: 0017
Create Date: 2026-08-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "pending_deletes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("entity_type", sa.Text, nullable=False),
        sa.Column("entity_id", UUID(as_uuid=True), nullable=False),
        sa.Column("entity_label", sa.Text, nullable=False, server_default=""),
        sa.Column("marked_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("marked_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("entity_type", "entity_id",
                            name="pending_deletes_target_uniq"),
    )


def downgrade() -> None:
    op.drop_table("pending_deletes")
