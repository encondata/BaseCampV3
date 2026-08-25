"""move_asset_status colors — normalize to lowercase hex.

0019 seeded these verbatim from V2's process_order table, which mixed
upper/lowercase hex digits (e.g. '#273FF5'). Every other status_values
color in the system is lowercase (enforced by
test_vocabulary_colors_model.py::test_every_status_value_color_is_hex),
and the schema-level HexColor validator lowercases on write — this
migration brings the 0019 seed data in line with that invariant. Hex
colors are case-insensitive, so no visual change.

Revision ID: 0020
Revises: 0019
Create Date: 2026-08-25
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        UPDATE status_values SET color = lower(color)
        WHERE record_type = 'move_asset_status'
    """)


def downgrade() -> None:
    # case-only normalization — no meaningful downgrade
    pass
