"""Count sign-in attempts made while an address is blocked (SS-487).

A blocked address gets a 429 before its credentials are checked, so those
attempts never reach `sign_in_failures`. Two columns on `address_blocks`
keep them visible: how many attempts the current (or last) block turned
away, and when the latest one came. Both reset when a new block trips.

Revision ID: 0127
Revises: 0126
Create Date: 2026-11-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0127"
down_revision: str | None = "0126"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("address_blocks", sa.Column(
        "attempts_while_blocked", sa.Integer, nullable=False, server_default=sa.text("0"),
        comment="sign-in attempts turned away by this block (reset when a new block trips)"))
    op.add_column("address_blocks", sa.Column(
        "last_attempt_at", sa.TIMESTAMP(timezone=True), nullable=True,
        comment="when the latest attempt was turned away by this block"))


def downgrade() -> None:
    op.drop_column("address_blocks", "last_attempt_at")
    op.drop_column("address_blocks", "attempts_while_blocked")
