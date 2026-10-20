"""ID badge templates: the built-in ID Badge label type (`("type",
"id_badge")`, "ID Badge", sorted after the five kiosk types) and the
`label_images` table, the label builder's library of static images (a
template's image element references one by id; the original upload is
stored uncropped). Soft-deleted rows keep their key so an image still in a
design degrades to "no image".

A designer may already have made a pending `id_badge` row through New
template › Custom…: the seed takes it over (activates it, sets its label,
description and sort). Rolling back drops the table and the row.

Design: docs/superpowers/specs/2026-10-20-badge-templates-design.md §4.1, §4.3

Revision ID: 0104
Revises: 0103
Create Date: 2026-10-20
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0104"
down_revision: str | None = "0103"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DELETED_IDX = "label_images_deleted_at_idx"


def upgrade() -> None:
    op.execute("""
        INSERT INTO label_vocab (kind, key, label, description, meta, sort_order, is_active)
        VALUES ('type', 'id_badge', 'ID Badge', 'A worker''s or staff member''s ID badge.',
                '{}', 6, true)
        ON CONFLICT (kind, key) DO UPDATE
        SET label = EXCLUDED.label, description = EXCLUDED.description,
            sort_order = EXCLUDED.sort_order, is_active = true, updated_at = now()
    """)
    op.create_table(
        "label_images",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("mime", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(DELETED_IDX, "label_images", ["deleted_at"])


def downgrade() -> None:
    op.drop_index(DELETED_IDX, table_name="label_images")
    op.drop_table("label_images")
    op.execute("DELETE FROM label_vocab WHERE kind = 'type' AND key = 'id_badge'")
