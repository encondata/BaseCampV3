"""The `natural` collation: numbers inside text compare by value and case is
ignored, so lists read "Rack 2, Rack 10" instead of "Rack 10, Rack 2".

ICU, numeric (kn), case-insensitive (ks-level2), non-deterministic — used
ONLY in ORDER BY (see serversherpa.db.ordering.natural). Postgres 16 with
ICU, which the dev and production servers have.

Revision ID: 0082
Revises: 0080
Create Date: 2026-09-28

Chains after 0080 (spec-lookup, merged; 0080 itself revises 0081). The
unmerged `wiki` branch (0074–0079) re-points its first migration when it
merges.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0082"
down_revision: str | None = "0080"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        'CREATE COLLATION "natural" (provider = icu, '
        "locale = 'en-u-kn-true-ks-level2', deterministic = false)")


def downgrade() -> None:
    op.execute('DROP COLLATION "natural"')
