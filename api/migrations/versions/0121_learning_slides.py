"""Learning slides: a document's reading style ('document' | 'slides').

`learning_documents.reading_style` (default 'document') says whether a worker
reads the page top to bottom or steps through it as slides. A slide deck is
the page's own content split at its horizontal rules, so nothing is stored per
slide; the assignment remembers how far a worker got instead:
`learning_assignments.slide_reached` (1-based, null = not started),
`slide_version_id` (the version that position was counted in, cleared if the
version is deleted) and `slide_language` (the translation it was counted in).

`learning_signoffs.slides_viewed` records how many slides the worker had seen
when they signed (null for a document read).

Rolling back drops the five columns and the check; slide documents become
plain documents and signed sign-offs keep everything else.

Design: docs/superpowers/specs/2026-11-05-learning-slides-design.md

Revision ID: 0121
Revises: 0120
Create Date: 2026-11-05
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0121"
down_revision: str | None = "0120"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("learning_documents", sa.Column(
        "reading_style", sa.Text(), nullable=False, server_default="document"))
    op.create_check_constraint(
        "ck_learning_documents_reading_style", "learning_documents",
        "reading_style IN ('document', 'slides')")
    op.add_column("learning_assignments", sa.Column("slide_reached", sa.Integer()))
    op.add_column("learning_assignments", sa.Column(
        "slide_version_id", UUID(as_uuid=True),
        sa.ForeignKey("learning_document_versions.id", ondelete="SET NULL")))
    op.add_column("learning_assignments", sa.Column("slide_language", sa.Text()))
    op.add_column("learning_signoffs", sa.Column("slides_viewed", sa.Integer()))


def downgrade() -> None:
    op.drop_column("learning_signoffs", "slides_viewed")
    op.drop_column("learning_assignments", "slide_language")
    op.drop_column("learning_assignments", "slide_version_id")
    op.drop_column("learning_assignments", "slide_reached")
    op.drop_constraint("ck_learning_documents_reading_style", "learning_documents",
                       type_="check")
    op.drop_column("learning_documents", "reading_style")
