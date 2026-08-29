"""db_backups — metadata for encrypted full-database dumps made via
Dev -> Database -> Backups. The dump bytes (an OpenSSL-compatible AES-256
envelope around a pg_dump, keyed by the creator's own account password)
live in Spaces at storage_key; this table just tracks who made one, when,
and how big it is, for listing/download/delete. The API and portal UI are
Tasks 1-2 of the same plan; this migration is storage + model only.

Revision ID: 0029
Revises: 0028
Create Date: 2026-08-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0029"
down_revision: str | None = "0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "db_backups",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("filename", sa.Text, nullable=False),
        sa.Column("storage_key", sa.Text, nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_table("db_backups")
