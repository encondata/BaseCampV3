"""Index raw_scans for the server-paged Raw scans list.

The list pages by keyset on (sort value, id), newest scan first by default
and, on the Ingested column, by created_at. Both orders now come straight
off an index, so the first page and every later one read only the rows they
return instead of sorting the table:

  raw_scans_scanned_at_id_idx  (scanned_at DESC, id DESC) — the default
      order, its reverse, the since/until range and the keyset condition;
  raw_scans_created_at_id_idx  (created_at DESC, id DESC) — sorting by
      Ingested.

The other columns sort by display text through a joined label or name and
the `natural` collation (which must not be used in an index), so they sort
in the database with a top-N sort; at 100k rows that is under 100 ms.

Revision ID: 0108
Revises: 0107
Create Date: 2026-10-25
"""
from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "0108"
down_revision: str | None = "0107"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("raw_scans_scanned_at_id_idx", "raw_scans",
                    [text("scanned_at DESC"), text("id DESC")])
    op.create_index("raw_scans_created_at_id_idx", "raw_scans",
                    [text("created_at DESC"), text("id DESC")])


def downgrade() -> None:
    op.drop_index("raw_scans_created_at_id_idx", table_name="raw_scans")
    op.drop_index("raw_scans_scanned_at_id_idx", table_name="raw_scans")
