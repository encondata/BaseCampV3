"""attachments — generic file associations (avatars now; asset photos,
project documents later). Polymorphic entity reference, so no FK on
entity_id; the API layer validates entity_type + existence.

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "attachments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("entity_type", sa.Text, nullable=False,
                  comment="person | (asset, project, client … later)"),
        sa.Column("entity_id", UUID(as_uuid=True), nullable=False,
                  comment="polymorphic — validated by the API, no FK"),
        sa.Column("kind", sa.Text, nullable=False,
                  comment="avatar | photo | document"),
        sa.Column("storage_key", sa.Text, nullable=False, unique=True,
                  comment="object key in Spaces/MinIO; bucket stays private"),
        sa.Column("filename", sa.Text, nullable=False),
        sa.Column("content_type", sa.Text, nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("uploaded_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("deleted_at", sa.TIMESTAMP(timezone=True),
                  comment="soft delete; object cleanup is a maintenance job"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index(
        "attachments_entity_idx", "attachments",
        ["entity_type", "entity_id", "kind"],
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("attachments")
