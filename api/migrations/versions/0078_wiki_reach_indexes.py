"""Wiki: Phase 3 supporting indexes — the FK columns 0076 added that no
existing index covers.

- `wiki_share_links(node_id)`: the node cascade on purge, and the page's
  Share dialog listing a node's links.
- `wiki_help_links(node_id)`: the node cascade on purge.
- `wiki_search_log(person_id)`: the ON DELETE SET NULL when a person is
  deleted (the only other index is on `at`).

Revision ID: 0078
Revises: 0077
Create Date: 2026-09-26
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0078"
down_revision: str | None = "0077"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEXES: list[tuple[str, str, list[str]]] = [
    ("wiki_share_links_node_idx", "wiki_share_links", ["node_id"]),
    ("wiki_help_links_node_idx", "wiki_help_links", ["node_id"]),
    ("wiki_search_log_person_idx", "wiki_search_log", ["person_id"]),
]


def upgrade() -> None:
    for name, table, columns in INDEXES:
        op.create_index(name, table, columns)


def downgrade() -> None:
    for name, table, _ in reversed(INDEXES):
        op.drop_index(name, table_name=table)
