"""kiosk_type -> sub_type: the column is the shared per-family type
field now that handhelds use it too (kiosk: laptop/pi; handheld:
android/ios/zebra). Pure rename — data preserved.

Revision ID: 0041
Revises: 0040
Create Date: 2026-09-01
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0041"
down_revision: str | None = "0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("devices", "kiosk_type", new_column_name="sub_type")


def downgrade() -> None:
    op.alter_column("devices", "sub_type", new_column_name="kiosk_type")
