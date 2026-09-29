"""Wiki: Phase 2 follow-ups — builtin template icons as glyphs, and the
supporting indexes Phase 2's cascades and watcher lookups need.

- 0075 seeded the four builtin templates with icon *names*
  ('clipboard-list', 'compass', 'wrench', 'users'), but the UI shows
  `icon` as a glyph in front of the name. This rewrites them to emoji
  (only where the row still holds 0075's word, so it is idempotent).
  0075 itself is left alone: it is already applied, and a fresh install
  runs this right after it.
- `wiki_watches(node_id)` and `(space_id)`: the watcher lookup
  (`space_id = … OR node_id IN (…)`) and the node/space cascades can't
  use the person-first unique index.
- `wiki_reviews(version_id)` (the version FK cascade) and a non-partial
  `wiki_reviews(node_id)` (the node cascade on purge — the existing index
  only covers pending rows).

Revision ID: 0077
Revises: 0076
Create Date: 2026-09-26
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0077"
down_revision: str | None = "0076"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# builtin template name -> (0075's icon name, the glyph it becomes)
BUILTIN_ICONS: dict[str, tuple[str, str]] = {
    "SOP": ("clipboard-list", "📋"),
    "How-to guide": ("compass", "🧭"),
    "Troubleshooting": ("wrench", "🔧"),
    "Meeting notes": ("users", "👥"),
}

INDEXES: list[tuple[str, str, list[str]]] = [
    ("wiki_watches_node_idx", "wiki_watches", ["node_id"]),
    ("wiki_watches_space_idx", "wiki_watches", ["space_id"]),
    ("wiki_reviews_version_idx", "wiki_reviews", ["version_id"]),
    ("wiki_reviews_node_idx", "wiki_reviews", ["node_id"]),
]


def _q(value: str) -> str:
    """Single-quoted SQL literal with quotes doubled."""
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _icon_statements(*, reverse: bool = False) -> list[str]:
    """UPDATEs turning each builtin's 0075 icon name into its glyph (or,
    `reverse`, back). Only a row still holding the old value changes."""
    out = []
    for name, (word, glyph) in BUILTIN_ICONS.items():
        old, new = (glyph, word) if reverse else (word, glyph)
        out.append(
            f"UPDATE wiki_templates SET icon = {_q(new)} "
            f"WHERE is_builtin AND space_id IS NULL AND name = {_q(name)} "
            f"AND icon = {_q(old)}")
    return out


def fix_icons(conn) -> None:
    """Run the icon rewrite against `conn` (a raw/sync connection) — tests
    call this after re-seeding 0075's builtins into a truncated table."""
    from sqlalchemy import text

    for statement in _icon_statements():
        conn.execute(text(statement))


def upgrade() -> None:
    for statement in _icon_statements():
        op.execute(statement)
    for name, table, columns in INDEXES:
        op.create_index(name, table, columns)


def downgrade() -> None:
    for name, table, _ in reversed(INDEXES):
        op.drop_index(name, table_name=table)
    for statement in _icon_statements(reverse=True):
        op.execute(statement)
