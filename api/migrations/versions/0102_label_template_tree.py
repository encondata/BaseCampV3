"""Label template tree: a builder template (the parent, `schema_version`
2) keeps its design in real units plus its sample values, and owns one
DPI child per entry of `dpis` — a full copy of the design pinned to that
DPI (`parent_id`, `dpi_key`); any other row's `dpis` is its one DPI. A child remembers the parent version it was
generated from and how many hand edits sit on top (`child_edits`,
`customized`); a customized child the parent has moved past is kept,
renamed "… Old" and `is_old` when an updated one replaces it. One current
child per parent and DPI. Older rows stay as they are (`schema_version`
1, no parent).

`label_template_versions` keeps every saved state of every template,
keyed (template, version, child_edits): a child's versions count under its
parent's (`v7.2`). Each existing template gets its current state as its
first version. A 600 DPI vocabulary row joins 203 and 300 for the third
child.

Design: docs/superpowers/specs/2026-10-19-label-builder-design.md §3.4, §4.1

Revision ID: 0102
Revises: 0101
Create Date: 2026-10-20
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

revision: str = "0102"
down_revision: str | None = "0101"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CHILD_DPI_IDX = "label_templates_child_dpi_idx"


def upgrade() -> None:
    op.add_column("label_templates", sa.Column(
        "parent_id", UUID(as_uuid=True),
        sa.ForeignKey("label_templates.id", ondelete="CASCADE"), nullable=True))
    op.add_column("label_templates", sa.Column(
        "schema_version", sa.Integer, nullable=False, server_default="1"))
    op.add_column("label_templates", sa.Column(
        "samples", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")))
    op.add_column("label_templates", sa.Column(
        "dpis", ARRAY(sa.Text), nullable=False,
        server_default=sa.text("'{203,300,600}'::text[]")))
    op.add_column("label_templates", sa.Column(
        "generated_from_version", sa.Integer, nullable=True))
    op.add_column("label_templates", sa.Column(
        "child_edits", sa.Integer, nullable=False, server_default="0"))
    op.add_column("label_templates", sa.Column(
        "customized", sa.Boolean, nullable=False, server_default=sa.text("false")))
    op.add_column("label_templates", sa.Column(
        "is_old", sa.Boolean, nullable=False, server_default=sa.text("false")))
    # a row that isn't a parent prints at its one DPI
    op.execute("UPDATE label_templates SET dpis = ARRAY[dpi_key]")
    op.create_index("label_templates_parent_idx", "label_templates", ["parent_id"])
    op.create_index(CHILD_DPI_IDX, "label_templates", ["parent_id", "dpi_key"], unique=True,
                    postgresql_where=sa.text("parent_id IS NOT NULL AND NOT is_old"))
    op.create_check_constraint(
        "ck_label_templates_child_schema", "label_templates",
        "parent_id IS NULL OR schema_version >= 2")

    op.create_table(
        "label_template_versions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("template_id", UUID(as_uuid=True),
                  sa.ForeignKey("label_templates.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("child_edits", sa.Integer, nullable=False, server_default="0"),
        sa.Column("design", JSONB, nullable=True),
        sa.Column("code", sa.Text, nullable=True),
        sa.Column("samples", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("summary", sa.Text, nullable=False, server_default=""),
        sa.Column("note", sa.Text, nullable=False, server_default=""),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("template_id", "version", "child_edits",
                            name="label_template_versions_key"),
    )
    op.execute(
        "INSERT INTO label_template_versions (template_id, version, child_edits, design, "
        "code, samples, summary, created_at) "
        "SELECT id, version, 0, design, code, '{}'::jsonb, "
        "'Saved before versions were kept', updated_at FROM label_templates")
    op.execute(
        "INSERT INTO label_vocab (kind, key, label, description, meta, sort_order) "
        "VALUES ('dpi', '600', '600 DPI', '', '{\"dots\": 600}', 3) "
        "ON CONFLICT (kind, key) DO NOTHING")


def downgrade() -> None:
    op.drop_table("label_template_versions")
    # the old schema has no children: they go, and their parents with them
    # (a parent's design is a schema 2 design the old code can't print)
    op.execute("DELETE FROM generated_labels WHERE template_id IN "
               "(SELECT id FROM label_templates WHERE schema_version >= 2)")
    op.execute("DELETE FROM label_templates WHERE parent_id IS NOT NULL")
    op.execute("DELETE FROM label_templates WHERE schema_version >= 2")
    op.drop_constraint("ck_label_templates_child_schema", "label_templates", type_="check")
    op.drop_index(CHILD_DPI_IDX, table_name="label_templates")
    op.drop_index("label_templates_parent_idx", table_name="label_templates")
    for col in ("is_old", "customized", "child_edits", "generated_from_version", "dpis",
                "samples", "schema_version", "parent_id"):
        op.drop_column("label_templates", col)
    op.execute("DELETE FROM label_vocab WHERE kind = 'dpi' AND key = '600' AND NOT EXISTS "
               "(SELECT 1 FROM label_templates WHERE dpi_key = '600')")
