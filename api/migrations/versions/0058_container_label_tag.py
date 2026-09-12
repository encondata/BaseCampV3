"""Container label tag — the tag chosen per container on the Container
Labels page (Priority / Vendor / Accessories / E-Waste / Warehouse) now
lives on the container itself, so any surface that reads a container
(the Container Labels page, the containers list, a report run) agrees
on its tag instead of it being a per-generation-only choice.

Design: docs/superpowers/specs/2026-09-12-container-labels-design.md
Addendum 2026-09-12 — the label tag lives on the container.

Revision ID: 0058
Revises: 0057
Create Date: 2026-09-12
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0058"
down_revision: str | None = "0057"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Kept as a literal here (not imported from serversherpa.labels.tags) so
# this migration stays frozen regardless of future application changes —
# same convention as other migrations that inline their own CHECK values.
LABEL_TAG_KEYS = ("priority", "vendor", "accessories", "ewaste", "warehouse")
CHECK_NAME = "containers_label_tag_check"


def upgrade() -> None:
    op.add_column("containers", sa.Column("label_tag", sa.Text(), nullable=True))
    op.create_check_constraint(
        CHECK_NAME, "containers",
        "label_tag IN (" + ", ".join(f"'{k}'" for k in LABEL_TAG_KEYS) + ")")


def downgrade() -> None:
    op.drop_constraint(CHECK_NAME, "containers")
    op.drop_column("containers", "label_tag")
