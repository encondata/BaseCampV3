"""Wiki: a page's document type.

`wiki_pages.doc_type` — one of a fixed list ("Operating Procedure", "Work
Instruction", "Guide", "Policy", "Reference"; the API enforces it), shown
on the cover of an exported PDF. Null means none.

Revision ID: 0085
Revises: 0084
Create Date: 2026-09-30
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0085"
down_revision: str | None = "0084"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("wiki_pages", sa.Column("doc_type", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("wiki_pages", "doc_type")
