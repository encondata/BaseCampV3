"""Move-assets bulk import: the import_jobs queue table (claimed by the
separate import-worker process with FOR UPDATE SKIP LOCKED), plus the two
v2-parity columns deferred to this slice — initiative_assets.raw_ft (the
complete original spreadsheet row; nothing from an upload is dropped) and
label_info (unused until label printing lands).

Revision ID: 0023
Revises: 0022
Create Date: 2026-08-26
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("initiative_assets", sa.Column("raw_ft", JSONB))
    op.add_column("initiative_assets", sa.Column("label_info", JSONB))

    op.create_table(
        "import_jobs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id")),
        sa.Column("filename", sa.Text, nullable=False),
        sa.Column("file_key", sa.Text, nullable=False, server_default=""),
        sa.Column("options", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("phase", sa.Text, nullable=False,
                  server_default="validate"),
        sa.Column("status", sa.Text, nullable=False,
                  server_default="queued"),
        sa.Column("total_rows", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("processed_rows", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("created_count", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("updated_count", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("error_count", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("results", JSONB),
        sa.Column("cancel_requested", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("error", sa.Text),
        sa.Column("progress_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("started_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("finished_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("import_jobs_queue_idx", "import_jobs",
                    ["status", "created_at"])


def downgrade() -> None:
    op.drop_table("import_jobs")
    op.drop_column("initiative_assets", "label_info")
    op.drop_column("initiative_assets", "raw_ft")
