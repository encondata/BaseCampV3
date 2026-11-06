"""Rack asset category.

Adds the `rack` row to asset_categories so a model can say it is a rack.
The crate estimate on Bulk Actions › Create a move in steps leaves rack
models out, because racks ship standalone and never go in a crate.

Rolling back removes the row; any model filed under it goes back to having
no category.

Revision ID: 0123
Revises: 0122
Create Date: 2026-11-06
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0123"
down_revision: str | None = "0122"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO asset_categories (key, label, description, sort_order, color)
        VALUES ('rack', 'Rack', 'Rack frames and cabinets; shipped standalone, never crated.',
                45, '#7a5c3e')
        ON CONFLICT (key) DO NOTHING
    """)


def downgrade() -> None:
    op.execute("UPDATE asset_models SET category = NULL WHERE category = 'rack'")
    op.execute("DELETE FROM asset_categories WHERE key = 'rack'")
