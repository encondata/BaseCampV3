"""Model spec lookup: model flags, the lookup queue, suggestions.

Revision ID: 0080
Revises: 0073
Create Date: 2026-09-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0080"
down_revision: str | None = "0073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("asset_models", sa.Column(
        "private", sa.Boolean, nullable=False, server_default=sa.text("false")))
    op.add_column("asset_models", sa.Column(
        "spec_lookup_skip", sa.Boolean, nullable=False, server_default=sa.text("false")))
    op.add_column("asset_models", sa.Column(
        "specs_looked_up_at", sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        "spec_lookup_jobs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("model_id", UUID(as_uuid=True),
                  sa.ForeignKey("asset_models.id", ondelete="CASCADE"), nullable=False),
        sa.Column("priority", sa.Integer, nullable=False, server_default="0"),
        sa.Column("status", sa.Text, nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("requested_by", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("input_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("search_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("worker_id", sa.Text, nullable=True),
        sa.CheckConstraint("status IN ('queued','running','done','failed')",
                           name="spec_lookup_jobs_status_check"),
    )
    op.create_index("spec_lookup_jobs_one_active", "spec_lookup_jobs", ["model_id"],
                    unique=True, postgresql_where=sa.text("status IN ('queued','running')"))
    op.create_index("spec_lookup_jobs_claim", "spec_lookup_jobs",
                    ["status", "priority", "created_at"])

    op.create_table(
        "spec_suggestions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("model_id", UUID(as_uuid=True),
                  sa.ForeignKey("asset_models.id", ondelete="CASCADE"), nullable=False),
        sa.Column("job_id", UUID(as_uuid=True),
                  sa.ForeignKey("spec_lookup_jobs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("field", sa.Text, nullable=False),
        sa.Column("value", sa.Text, nullable=False),
        sa.Column("unit", sa.Text, nullable=True),
        sa.Column("source_url", sa.Text, nullable=False),
        sa.Column("quote", sa.Text, nullable=False),
        sa.Column("previous_value", sa.Text, nullable=True),
        sa.Column("status", sa.Text, nullable=False, server_default="pending"),
        sa.Column("decided_by", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint(
            "field IN ('ru_size','weight','length','width','height',"
            "'mount_type','rail_type','knowledge')", name="spec_suggestions_field_check"),
        sa.CheckConstraint(
            "status IN ('pending','applied','approved','rejected','reverted')",
            name="spec_suggestions_status_check"),
        sa.CheckConstraint("unit IS NULL OR unit IN ('lbs','kg','in','cm')",
                           name="spec_suggestions_unit_check"),
    )
    op.create_index("spec_suggestions_model_status", "spec_suggestions", ["model_id", "status"])
    op.create_index("spec_suggestions_status_created", "spec_suggestions",
                    ["status", "created_at"])


def downgrade() -> None:
    op.drop_table("spec_suggestions")
    op.drop_table("spec_lookup_jobs")
    op.drop_column("asset_models", "specs_looked_up_at")
    op.drop_column("asset_models", "spec_lookup_skip")
    op.drop_column("asset_models", "private")
