"""Generated labels per DPI: a portal generation run prints at one DPI
(`label_generation_runs.dpi_key`, 300 for the runs before this), and
`generated_labels` keeps one label per entity, initiative, type AND DPI,
so a 203 run never replaces the 300 labels. The unique index from 0055
gains `dpi_key`, with the same nil-uuid stand-in for a missing initiative.

Rolling back keeps the newest label of each old key (entity, initiative,
type) and drops the others.

Design: docs/superpowers/specs/2026-10-19-label-builder-design.md §4.1

Revision ID: 0103
Revises: 0102
Create Date: 2026-10-20
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0103"
down_revision: str | None = "0102"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NIL_UUID = "00000000-0000-0000-0000-000000000000"
OLD_IDX = "generated_labels_entity_initiative_type_idx"
NEW_IDX = "generated_labels_entity_initiative_type_dpi_idx"


def upgrade() -> None:
    op.add_column("label_generation_runs", sa.Column(
        "dpi_key", sa.Text, nullable=False, server_default="300"))
    op.create_index(
        NEW_IDX, "generated_labels",
        ["entity_type", "entity_id",
         sa.text(f"coalesce(initiative_id, '{NIL_UUID}'::uuid)"), "label_type", "dpi_key"],
        unique=True)
    op.drop_index(OLD_IDX, table_name="generated_labels")


def downgrade() -> None:
    op.execute(
        "DELETE FROM generated_labels g USING ("
        "  SELECT id, row_number() OVER ("
        "    PARTITION BY entity_type, entity_id, "
        f"     coalesce(initiative_id, '{NIL_UUID}'::uuid), label_type "
        "    ORDER BY generated_at DESC, id DESC) AS n"
        "  FROM generated_labels) ranked "
        "WHERE g.id = ranked.id AND ranked.n > 1")
    op.create_index(
        OLD_IDX, "generated_labels",
        ["entity_type", "entity_id",
         sa.text(f"coalesce(initiative_id, '{NIL_UUID}'::uuid)"), "label_type"],
        unique=True)
    op.drop_index(NEW_IDX, table_name="generated_labels")
    op.drop_column("label_generation_runs", "dpi_key")
