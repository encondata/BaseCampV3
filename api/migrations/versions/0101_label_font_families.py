"""Label font families: every font-library file can belong to one of the
label builder's families (`family` slug + `weight`, see
serversherpa.labels.fonts), and `source_url` records where a seeded file
was downloaded from. `resident` marks Zebra's own Swiss 721 Condensed
Bold (`TT0003M_.TTF`): it is never pushed to a printer or served to a
browser, and its row exists without a file until one is uploaded for its
metrics, so `storage_key` becomes nullable (a non-resident row still needs
a file). One active file per family and weight.

Design: docs/superpowers/specs/2026-10-19-label-builder-design.md §4.4

Revision ID: 0101
Revises: 0100
Create Date: 2026-10-20
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0101"
down_revision: str | None = "0100"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FAMILY_IDX = "label_fonts_family_weight_active_idx"


def upgrade() -> None:
    op.add_column("label_fonts", sa.Column("family", sa.Text(), nullable=True))
    op.add_column("label_fonts", sa.Column("weight", sa.Text(), nullable=True))
    op.add_column("label_fonts", sa.Column("resident", sa.Boolean(), nullable=False,
                                           server_default=sa.text("false")))
    op.add_column("label_fonts", sa.Column("source_url", sa.Text(), nullable=True))
    op.alter_column("label_fonts", "storage_key", existing_type=sa.Text(), nullable=True)
    op.create_check_constraint(
        "ck_label_fonts_weight", "label_fonts",
        "weight IS NULL OR weight IN ('regular', 'bold')")
    op.create_check_constraint(
        "ck_label_fonts_family_weight", "label_fonts",
        "(family IS NULL) = (weight IS NULL)")
    op.create_check_constraint(
        "ck_label_fonts_file", "label_fonts",
        "resident OR storage_key IS NOT NULL")
    op.create_index(FAMILY_IDX, "label_fonts", ["family", "weight"], unique=True,
                    postgresql_where=sa.text("deleted_at IS NULL AND family IS NOT NULL"))


def downgrade() -> None:
    op.drop_index(FAMILY_IDX, table_name="label_fonts")
    op.drop_constraint("ck_label_fonts_file", "label_fonts", type_="check")
    op.drop_constraint("ck_label_fonts_family_weight", "label_fonts", type_="check")
    op.drop_constraint("ck_label_fonts_weight", "label_fonts", type_="check")
    # a resident row with no file has nothing the old schema can hold
    op.execute("DELETE FROM label_fonts WHERE storage_key IS NULL")
    op.alter_column("label_fonts", "storage_key", existing_type=sa.Text(), nullable=False)
    op.drop_column("label_fonts", "source_url")
    op.drop_column("label_fonts", "resident")
    op.drop_column("label_fonts", "weight")
    op.drop_column("label_fonts", "family")
