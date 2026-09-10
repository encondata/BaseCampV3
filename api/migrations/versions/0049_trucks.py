"""Trucks / shipments (V2 parity): trucks, truck_containers, truck_updates,
the `truck` status vocabulary, and role grants for the new `trucks` resource.

Revision ID: 0049
Revises: 0048
Create Date: 2026-09-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID

revision: str = "0049"
down_revision: str | None = "0048"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TRUCK_STATUSES = """
    INSERT INTO status_values (record_type, key, label, description, color, sort_order)
    VALUES
      ('truck','created','Created','Set up, not yet rolling.','#51606f',1),
      ('truck','active','Active','Loading or ready to depart.','#178a4c',2),
      ('truck','in_transit','In Transit','On the road.','#0f7c86',3),
      ('truck','at_destination','At Destination','Arrived; unloading.','#1668a7',4),
      ('truck','inactive','In-Active','Parked; not in use.','#a36207',5),
      ('truck','historical','Historical','Completed; kept for history.','#6d4fc4',6)
    ON CONFLICT DO NOTHING
"""
FULL = ("view", "add", "change", "delete")
GRANTS = {r: FULL for r in ("developer", "founder", "super_admin", "admin", "staff")}


def upgrade() -> None:
    op.execute(TRUCK_STATUSES)
    op.create_table(
        "trucks",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("legacy_id", sa.BigInteger, unique=True),
        sa.Column("name", CITEXT, nullable=False),
        sa.Column("driver_name", sa.Text),
        sa.Column("co_driver_name", sa.Text),
        sa.Column("team_drive", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("contact_info", sa.Text, nullable=False, server_default=""),
        sa.Column("status", sa.Text, nullable=False, server_default="created"),
        sa.Column("status_record_type", sa.Text,
                  sa.Computed("'truck'", persisted=True), nullable=False),
        sa.Column("load_number", sa.Text),
        sa.Column("seal_id", sa.String(24)),
        sa.Column("tracking_type", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="SET NULL")),
        sa.Column("start_site_id", UUID(as_uuid=True),
                  sa.ForeignKey("sites.id", ondelete="SET NULL")),
        sa.Column("end_site_id", UUID(as_uuid=True),
                  sa.ForeignKey("sites.id", ondelete="SET NULL")),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.ForeignKeyConstraint(["status_record_type", "status"],
                                ["status_values.record_type", "status_values.key"],
                                name="trucks_status_fkey"),
    )
    op.create_table(
        "truck_containers",
        sa.Column("truck_id", UUID(as_uuid=True),
                  sa.ForeignKey("trucks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("container_id", UUID(as_uuid=True),
                  sa.ForeignKey("containers.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_table(
        "truck_updates",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("truck_id", UUID(as_uuid=True),
                  sa.ForeignKey("trucks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("location", sa.Text, nullable=False),
        sa.Column("lat", sa.Float),
        sa.Column("lng", sa.Float),
        sa.Column("approximate_address", sa.Text, nullable=False, server_default=""),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
    )
    op.create_index("ix_truck_updates_truck_recorded", "truck_updates",
                    ["truck_id", sa.text("recorded_at DESC")])
    conn = op.get_bind()
    for role, actions in GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'trucks', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    op.get_bind().execute(sa.text("DELETE FROM role_permissions WHERE resource = 'trucks'"))
    op.drop_index("ix_truck_updates_truck_recorded", table_name="truck_updates")
    op.drop_table("truck_updates")
    op.drop_table("truck_containers")
    op.drop_table("trucks")
    op.execute("DELETE FROM status_values WHERE record_type = 'truck'")
