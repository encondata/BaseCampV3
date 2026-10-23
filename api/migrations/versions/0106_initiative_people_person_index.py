"""Index initiative_people on (person_id, created_at DESC).

A worker's history (the portal's worker page, and the kiosk Rolodex's
"Previous jobs", which keeps the newest 50) reads one person's memberships
newest first. The table had an index on initiative_id only, so each read
scanned every membership; this one serves the filter and the newest-first
order (ties by initiative name are sorted after the join).

Revision ID: 0106
Revises: 0105
Create Date: 2026-10-23
"""
from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "0106"
down_revision: str | None = "0105"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "initiative_people_person_created_idx", "initiative_people",
        ["person_id", text("created_at DESC")])


def downgrade() -> None:
    op.drop_index("initiative_people_person_created_idx", table_name="initiative_people")
