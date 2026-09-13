"""Label font library — TrueType fonts admins upload once and push to a
Zebra printer's E: drive from Labels → Printers (Install Fonts). `name` is
the printer-side object name (Zebra 8.3, e.g. 85620388.TTF); unique among
non-deleted rows so a deleted font's name can be reused.

Design: docs/superpowers/specs/2026-09-12-zebra-printer-tools-design.md

Revision ID: 0060
Revises: 0059
Create Date: 2026-09-12
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0060"
down_revision: str | None = "0059"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NAME_IDX = "label_fonts_name_active_idx"


def upgrade() -> None:
    op.create_table(
        "label_fonts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", postgresql.CITEXT(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False, server_default=""),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False, server_default="font/ttf"),
        sa.Column("uploaded_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("people.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(NAME_IDX, "label_fonts", ["name"], unique=True,
                    postgresql_where=sa.text("deleted_at IS NULL"))


def downgrade() -> None:
    op.drop_index(NAME_IDX, table_name="label_fonts")
    op.drop_table("label_fonts")
