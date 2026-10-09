"""Index auth_sessions.replaced_by.

replaced_by is a NO ACTION self-reference, so deleting a session makes
Postgres look for rows that still point at it. Without an index that lookup
is a sequential scan per deleted row, which makes the data cleanup purge of
expired sessions crawl on a big table (about 10 s per 5,000-row chunk at
100k rows, 0.06 s with the index).

Revision ID: 0093
Revises: 0092
Create Date: 2026-10-09
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0093"
down_revision: str | None = "0092"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("auth_sessions_replaced_by_idx", "auth_sessions", ["replaced_by"])


def downgrade() -> None:
    op.drop_index("auth_sessions_replaced_by_idx", table_name="auth_sessions")
