"""Clear Setup on a kiosk: a pending request on the device row, repeated on
every heartbeat reply until the kiosk acknowledges its id.

Revision ID: 0086
Revises: 0085
Create Date: 2026-10-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0086"
down_revision: str | None = "0085"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("setup_clear_id", UUID(as_uuid=True), nullable=True))
    op.add_column("devices", sa.Column(
        "setup_clear_requested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("devices", sa.Column(
        "setup_clear_requested_by", UUID(as_uuid=True),
        sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "setup_clear_requested_by")
    op.drop_column("devices", "setup_clear_requested_at")
    op.drop_column("devices", "setup_clear_id")
