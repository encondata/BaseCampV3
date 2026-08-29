"""Rename the org status key 'dormant' -> 'inactive' (clients AND
partners). The portal had already relabeled it "In-Active"; this makes
the stored key match. Besides the data rename, the *_status_check CHECK
constraints must be swapped — they enumerate the allowed keys.

Revision ID: 0032
Revises: 0031
Create Date: 2026-08-29
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0032"
down_revision: str | None = "0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _swap(table: str, old: str, new: str) -> None:
    op.execute(f"ALTER TABLE {table} DROP CONSTRAINT {table}_status_check")
    op.execute(f"UPDATE {table} SET status = '{new}' WHERE status = '{old}'")
    op.execute(
        f"ALTER TABLE {table} ADD CONSTRAINT {table}_status_check "
        f"CHECK (status = ANY (ARRAY['prospect'::text, 'active'::text, "
        f"'{new}'::text]))")


def upgrade() -> None:
    _swap("clients", "dormant", "inactive")
    _swap("partners", "dormant", "inactive")


def downgrade() -> None:
    _swap("clients", "inactive", "dormant")
    _swap("partners", "inactive", "dormant")
