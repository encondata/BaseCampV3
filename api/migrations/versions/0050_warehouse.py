"""Warehouse inventory: stock_lines (counted stock at a warehouse site,
optionally inside a container / linked to a catalog model), three more
container types, and grants for the new `warehouse` resource.

Revision ID: 0050
Revises: 0049
Create Date: 2026-09-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0050"
down_revision: str | None = "0049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONTAINER_TYPES = """
    INSERT INTO status_values (record_type, key, label, description, color, sort_order)
    VALUES
      ('container_type','pallet','Pallet','Wrapped pallet of boxed or loose stock.','#a36207',10),
      ('container_type','crate','Crate','Wooden or plastic shipping crate.','#6d4fc4',11),
      ('container_type','d_container','D-container','Wheeled D-container / roll cage.','#0f7c86',12)
    ON CONFLICT DO NOTHING
"""
FULL = ("view", "add", "change", "delete")
GRANTS = {r: FULL for r in ("developer", "founder", "super_admin", "admin", "staff")}


def upgrade() -> None:
    op.execute(CONTAINER_TYPES)
    op.create_table(
        "stock_lines",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("site_id", UUID(as_uuid=True),
                  sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("container_id", UUID(as_uuid=True),
                  sa.ForeignKey("containers.id", ondelete="SET NULL")),
        sa.Column("model_id", UUID(as_uuid=True),
                  sa.ForeignKey("asset_models.id", ondelete="SET NULL")),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("unit", sa.Text, nullable=False, server_default="each"),
        sa.Column("location_detail", sa.Text, nullable=False, server_default=""),
        sa.Column("notes", sa.Text, nullable=False, server_default=""),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("quantity >= 0", name="ck_stock_lines_quantity_nonneg"),
    )
    op.create_index("stock_lines_site_idx", "stock_lines", ["site_id"])
    op.create_index("stock_lines_container_idx", "stock_lines", ["container_id"])
    op.create_index("stock_lines_model_idx", "stock_lines", ["model_id"])
    conn = op.get_bind()
    for role, actions in GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'warehouse', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    op.get_bind().execute(sa.text("DELETE FROM role_permissions WHERE resource = 'warehouse'"))
    op.drop_index("stock_lines_model_idx", table_name="stock_lines")
    op.drop_index("stock_lines_container_idx", table_name="stock_lines")
    op.drop_index("stock_lines_site_idx", table_name="stock_lines")
    op.drop_table("stock_lines")
    op.execute("DELETE FROM status_values WHERE record_type = 'container_type' "
               "AND key IN ('pallet','crate','d_container')")
