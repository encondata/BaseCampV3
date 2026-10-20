"""Initiative code: a short code for a move (or any initiative) that a label
can print, such as `LV3`. Optional; unique among the initiatives that have
one, case-insensitively (CITEXT), so many can have none.

Revision ID: 0100
Revises: 0099
Create Date: 2026-10-19
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT

revision: str = "0100"
down_revision: str | None = "0099"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("initiatives", sa.Column("code", CITEXT, nullable=True))
    op.create_index("ux_initiatives_code", "initiatives", ["code"], unique=True,
                    postgresql_where=sa.text("code IS NOT NULL"))


def downgrade() -> None:
    op.drop_index("ux_initiatives_code", table_name="initiatives")
    op.drop_column("initiatives", "code")
