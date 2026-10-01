"""Wiki: private items and "Allow printing".

`wiki_nodes.is_private` — a private node (and everything inside it) is
visible only to its author (`created_by`) and developers, whatever the
grants, library membership or wiki administrator permission say.

`wiki_nodes.allow_printing` — null inherits (the nearest ancestor with a
value, else the library's `allow_printing` setting, which lives in
`wiki_spaces.settings` and needs no column); true/false set it for the
node and everything below that doesn't set its own.

Revision ID: 0084
Revises: 0079
Create Date: 2026-09-30
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0084"
down_revision: str | None = "0079"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("wiki_nodes", sa.Column(
        "is_private", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("wiki_nodes", sa.Column("allow_printing", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("wiki_nodes", "allow_printing")
    op.drop_column("wiki_nodes", "is_private")
