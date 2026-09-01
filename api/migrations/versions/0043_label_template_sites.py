"""label_template_sites — site scoping for label templates.

Empty assignment set = GLOBAL (usable everywhere); rows narrow a template
to specific sites. Deliberate replacement for V2's CSV `sites` column:
real FKs both ways, CASCADE so deleting a site or template cleans up its
assignments (a template losing its last site becomes global).

Revision ID: 0043
Revises: 0042
Create Date: 2026-09-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0043"
down_revision: str | None = "0042"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "label_template_sites",
        sa.Column("template_id", UUID(as_uuid=True),
                  sa.ForeignKey("label_templates.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("site_id", UUID(as_uuid=True),
                  sa.ForeignKey("sites.id", ondelete="CASCADE"),
                  primary_key=True),
    )
    op.create_index("label_template_sites_site_idx", "label_template_sites",
                    ["site_id"])


def downgrade() -> None:
    op.drop_table("label_template_sites")
