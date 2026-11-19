"""Assets with no client get the client of their move (SS-526).

Until now the From-To import never set `assets.client_id`, so imported assets
showed on their client's move roster but not on the client's Assets page. This
one-time fix-up gives every asset that has no client the client of its newest
roster row on a move that has a client — the same "newest row" rule as the
`asset_owner_current` view (0128). Assets that already have a client, and
assets on no client move, are left alone.

Design: docs/superpowers/specs/2026-11-11-from-to-client-of-record-design.md

Revision ID: 0129
Revises: 0128
Create Date: 2026-11-11
"""
import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0129"
down_revision: str | None = "0128"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

log = logging.getLogger("alembic.runtime.migration")

BACKFILL_SQL = """
UPDATE assets a
SET client_id = newest.client_id
FROM (
    SELECT DISTINCT ON (ia.asset_id) ia.asset_id, i.client_id
    FROM initiative_assets ia
    JOIN initiatives i ON i.id = ia.initiative_id
    WHERE i.client_id IS NOT NULL
    ORDER BY ia.asset_id, ia.created_at DESC, ia.id DESC
) newest
WHERE a.id = newest.asset_id AND a.client_id IS NULL
"""


def backfill_asset_clients(conn) -> int:
    """Plain function on a raw connection so the test suite can re-run it
    (same convention as 0091's backfill_visibility). Returns the row count."""
    return conn.execute(sa.text(BACKFILL_SQL)).rowcount


def upgrade() -> None:
    n = backfill_asset_clients(op.get_bind())
    log.info("0129: gave %d asset(s) the client of their move", n)


def downgrade() -> None:
    # No-op on purpose: the backfilled clients stay. Before this fix-up those
    # assets had no client at all, and nothing records which ones were filled
    # in here rather than set by hand or by a later import.
    pass
