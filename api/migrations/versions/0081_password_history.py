"""Password history for the reuse rule (To-Do #32).

One row per password an account has had. Backfilled with each account's
current hash so the current password counts as the newest of the "last
N" from day one.

Revision ID: 0081
Revises: 0073
Create Date: 2026-09-28

Numbered 0081: 0074–0079 belong to the unmerged `wiki` branch and 0080 to the
unmerged `spec-lookup` branch. Whichever of those merges first, re-point
`down_revision` at merge time.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0081"
down_revision: str | None = "0073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "password_history",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("user_accounts.person_id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_password_history_person_created", "password_history",
                    ["person_id", sa.text("created_at DESC")])
    op.execute(
        "INSERT INTO password_history (person_id, password_hash, created_at) "
        "SELECT person_id, password_hash, COALESCE(password_updated_at, now()) "
        "FROM user_accounts WHERE password_hash IS NOT NULL")


def downgrade() -> None:
    op.drop_index("ix_password_history_person_created", table_name="password_history")
    op.drop_table("password_history")
