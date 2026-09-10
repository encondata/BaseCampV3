"""notifications.dismissed_at — soft "Hide" from the bell (rows are kept;
retention policy TBD).

Revision ID: 0048
Revises: 0047
Create Date: 2026-09-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0048"
down_revision: str | None = "0047"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("notifications", sa.Column("dismissed_at", sa.DateTime(timezone=True)))
    op.create_index("notifications_person_live_idx", "notifications",
                    ["person_id", "created_at"], postgresql_where=sa.text("dismissed_at IS NULL"))


def downgrade() -> None:
    op.drop_index("notifications_person_live_idx", table_name="notifications")
    op.drop_column("notifications", "dismissed_at")
