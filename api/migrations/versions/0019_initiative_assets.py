"""initiative_assets — per-move asset roster (V2 moves_assets_list
parity), join table between initiatives and assets. Assets reach a move
only via the future bulk-import script or dev seeding — no interactive
picker. Seeds the move_asset_status vocabulary verbatim from V2's
current process_order (RFID 10 has none in prod; seeded after RFID 4
with sort_order 24 per the design doc).

Revision ID: 0019
Revises: 0018
Create Date: 2026-08-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

MOVE_ASSET_STATUS_SEEDS = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('move_asset_status','loaded_in_system','Loaded In System','','#808080',1),
      ('move_asset_status','pre_stage','Pre-Stage','','#caa0a0',2),
      ('move_asset_status','racked','Racked','','#273FF5',3),
      ('move_asset_status','labeled','Labeled','','#F5BE27',4),
      ('move_asset_status','pack_logistics','Pack / Logistics','','#31F527',5),
      ('move_asset_status','in_container','In Container','','#31F527',6),
      ('move_asset_status','on_truck','On Truck','','#31F527',7),
      ('move_asset_status','received','Received','','#31F527',8),
      ('move_asset_status','un_pack','Un-Pack','','#31F527',9),
      ('move_asset_status','staged','Staged','','#27F5AD',10),
      ('move_asset_status','re_racked','Re-Racked','','#31F527',11),
      ('move_asset_status','cabling','Cabling','','#31F527',12),
      ('move_asset_status','qa','QA','','#31F527',13),
      ('move_asset_status','complete','Complete','','#8E27F5',14),
      ('move_asset_status','rfid_1_cage_exit','RFID 1 - Cage Exit','','#31F527',20),
      ('move_asset_status','rfid_2_loading_dock','RFID 2 - Loading Dock','','#29d3f5',21),
      ('move_asset_status','rfid_3_staging','RFID 3 - Staging','','#f58b29',22),
      ('move_asset_status','rfid_4_into_cage','RFID 4 - Into Cage','','#f5297a',23),
      ('move_asset_status','rfid_10_dock_to_truck','RFID 10 - Dock to Truck (Auto Container Pack)','','#1890ff',24),
      ('move_asset_status','in_transit','In Transit','','#F52727',50),
      ('move_asset_status','e_waste','e-waste','','#EE27F5',51),
      ('move_asset_status','pending_client_handover','Pending Client Handover','','#00FF00',96),
      ('move_asset_status','historical','Historical','','#27F5F2',99),
      ('move_asset_status','location_collision','Location Collision','','#FF0000',100)
"""


def upgrade() -> None:
    op.execute(MOVE_ASSET_STATUS_SEEDS)

    op.create_table(
        "initiative_assets",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), sa.ForeignKey("assets.id"),
                  nullable=False),
        sa.Column("priority_wave", sa.String(30)),
        sa.Column("disposition", sa.Text),
        sa.Column("owner", sa.Text),
        sa.Column("source_rack", sa.Text),
        sa.Column("source_ru", sa.Numeric),
        sa.Column("source_verified", sa.Boolean),
        sa.Column("source_position", sa.Text),
        sa.Column("destination_rack", sa.Text),
        sa.Column("destination_ru", sa.Numeric),
        sa.Column("destination_verified", sa.Boolean),
        sa.Column("destination_position", sa.Text),
        sa.Column("cable_info", sa.Text),
        sa.Column("vendor_involved", sa.Boolean),
        sa.Column("status", sa.Text, nullable=False,
                  server_default="loaded_in_system"),
        sa.Column("added_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("initiative_id", "asset_id",
                            name="initiative_assets_uniq"),
    )
    # composite FK to status_values — the 0014/0015/0016 idiom
    op.execute("""
        ALTER TABLE initiative_assets ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('move_asset_status') STORED
    """)
    op.create_foreign_key(
        "initiative_assets_status_fkey", "initiative_assets", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])

    op.create_index("initiative_assets_initiative_idx", "initiative_assets",
                    ["initiative_id"])
    op.create_index("initiative_assets_asset_idx", "initiative_assets",
                    ["asset_id"])


def downgrade() -> None:
    op.drop_table("initiative_assets")
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM status_values WHERE record_type = 'move_asset_status'"))
