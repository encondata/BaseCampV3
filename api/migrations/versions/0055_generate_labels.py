"""Generate Labels — queue + result tables.

Design: docs/superpowers/specs/2026-09-11-generate-labels-design.md (§Data).
Adds `label_generation_runs` (the label-worker's queue, same shape as
`report_runs`/`import_jobs`: API creates rows, a separate worker claims
them with FOR UPDATE SKIP LOCKED) and `generated_labels` (one row per
entity/type, template-versioned, replaced on regeneration), plus
`label_templates.generation_rules` (the V2 `label_generation_code` port:
position-split tokens off `source_raw`/`destination_raw` and per-field
length limits).

`generated_labels.initiative_id` is nullable (a label may outlive the
initiative it was generated for) but the natural uniqueness key still
needs to cover it, and two NULLs never compare equal in a plain unique
index — a second run against the same entity/type with no initiative
would insert a duplicate row instead of upserting. Rather than a
two-index scheme (unique-with-initiative + unique-partial-where-null),
this uses a single unique index on
`(entity_type, entity_id, coalesce(initiative_id, '00000000-...'), label_type)`
— one sentinel UUID stands in for "no initiative" so every row, NULL or
not, participates in exactly one uniqueness check.

Revision ID: 0055
Revises: 0054
Create Date: 2026-09-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision: str = "0055"
down_revision: str | None = "0054"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NIL_UUID = "00000000-0000-0000-0000-000000000000"


def upgrade() -> None:
    op.create_table(
        "label_generation_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id"), nullable=False),
        sa.Column("label_types", ARRAY(sa.Text), nullable=False),
        sa.Column("regenerate_existing", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("status", sa.Text, nullable=False, server_default="queued"),
        sa.Column("cancel_requested", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("current_label_type", sa.Text),
        sa.Column("current_item", sa.Text),
        sa.Column("total", sa.Integer, nullable=False, server_default="0"),
        sa.Column("processed", sa.Integer, nullable=False, server_default="0"),
        sa.Column("generated", sa.Integer, nullable=False, server_default="0"),
        sa.Column("skipped", sa.Integer, nullable=False, server_default="0"),
        sa.Column("errors", sa.Integer, nullable=False, server_default="0"),
        sa.Column("error_summary", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("error_details", JSONB, nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("error", sa.Text),
        sa.Column("requested_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id"), nullable=False),
        sa.Column("notify", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("started_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("finished_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("worker_id", sa.Text),
        sa.CheckConstraint(
            "status IN ('queued','running','completed','failed','canceled')",
            name="label_generation_runs_status_check"),
    )
    op.create_index("label_generation_runs_initiative_created_idx",
                    "label_generation_runs", ["initiative_id", sa.text("created_at DESC")])
    # one active (queued/running) run per initiative at a time
    op.create_index(
        "label_generation_runs_one_active_per_initiative", "label_generation_runs",
        ["initiative_id"], unique=True,
        postgresql_where=sa.text("status IN ('queued','running')"))

    op.create_table(
        "generated_labels",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("entity_type", sa.Text, nullable=False),
        sa.Column("entity_id", UUID(as_uuid=True), nullable=False),
        # nullable: a label may outlive the initiative it was generated
        # for — see the module docstring for the uniqueness-index choice
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id")),
        sa.Column("label_type", sa.Text, nullable=False),
        sa.Column("template_id", UUID(as_uuid=True),
                  sa.ForeignKey("label_templates.id"), nullable=False),
        sa.Column("template_version", sa.Integer, nullable=False),
        sa.Column("language_key", sa.Text, nullable=False),
        sa.Column("dpi_key", sa.Text, nullable=False),
        sa.Column("size_key", sa.Text, nullable=False),
        sa.Column("code", sa.Text, nullable=False),
        sa.Column("values", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("run_id", UUID(as_uuid=True),
                  sa.ForeignKey("label_generation_runs.id")),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("stale", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.CheckConstraint("entity_type IN ('asset','container')",
                           name="generated_labels_entity_type_check"),
    )
    op.create_index("generated_labels_entity_idx", "generated_labels",
                    ["entity_type", "entity_id"])
    op.create_index("generated_labels_run_idx", "generated_labels", ["run_id"])
    op.create_index(
        "generated_labels_entity_initiative_type_idx", "generated_labels",
        ["entity_type", "entity_id",
         sa.text(f"coalesce(initiative_id, '{NIL_UUID}'::uuid)"), "label_type"],
        unique=True)

    op.add_column("label_templates", sa.Column(
        "generation_rules", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")))


def downgrade() -> None:
    op.drop_column("label_templates", "generation_rules")
    op.drop_index("generated_labels_entity_initiative_type_idx",
                  table_name="generated_labels")
    op.drop_index("generated_labels_run_idx", table_name="generated_labels")
    op.drop_index("generated_labels_entity_idx", table_name="generated_labels")
    op.drop_table("generated_labels")
    op.drop_index("label_generation_runs_one_active_per_initiative",
                  table_name="label_generation_runs")
    op.drop_index("label_generation_runs_initiative_created_idx",
                  table_name="label_generation_runs")
    op.drop_table("label_generation_runs")
