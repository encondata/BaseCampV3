"""devices — one table for the whole scanning-hardware fleet.
device_type discriminates (same unification trade as initiatives:
typed nullable per-family columns, never queryable-data-in-JSON);
wan_ip/lan_ip/uptime are the router block, future families add their
own columns in their own migrations. raw_info holds the device's last
raw registration payload verbatim (provenance only). serial is the
future registration endpoint's upsert key. Hard delete — no
archived_at; deletes are audited.

Revision ID: 0037
Revises: 0036
Create Date: 2026-08-31
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID

revision: str = "0037"
down_revision: str | None = "0036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

VOCAB_SEEDS = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('device_type','router','Router','GL.iNet site router.','#1668a7',1),
      ('device_type','fixed_reader','Fixed Reader','Zebra FX9600 fixed RFID reader.','#178a4c',2),
      ('device_type','handheld_reader','Handheld Reader','Android / iOS / Zebra handheld scanner.','#6d4fc4',3),
      ('device_type','kiosk','Kiosk','Web or iPad kiosk station.','#a36207',4)
"""


def upgrade() -> None:
    op.execute(VOCAB_SEEDS)
    op.create_table(
        "devices",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("device_type", sa.Text, nullable=False),
        sa.Column("name", CITEXT, nullable=False),
        sa.Column("serial", CITEXT,
                  comment="registration upsert key (future endpoint)"),
        sa.Column("mac", CITEXT),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("wan_ip", sa.Text, comment="router-typed"),
        sa.Column("lan_ip", sa.Text, comment="router-typed"),
        sa.Column("uptime_seconds", sa.BigInteger,
                  comment="last reported; display as-of last_seen_at"),
        sa.Column("last_seen_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("raw_info", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb"),
                  comment="last raw registration payload; never queried"),
        sa.Column("registered_at", sa.TIMESTAMP(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.execute("""
        ALTER TABLE devices ADD COLUMN type_record_type text
          GENERATED ALWAYS AS ('device_type') STORED
    """)
    op.create_foreign_key(
        "devices_device_type_fkey", "devices", "status_values",
        ["type_record_type", "device_type"], ["record_type", "key"])
    op.create_index("devices_type_idx", "devices", ["device_type"])
    op.create_index("devices_name_idx", "devices", ["name"])
    op.create_index("devices_serial_uniq", "devices", ["serial"],
                    unique=True, postgresql_where=sa.text("serial IS NOT NULL"))
    op.create_index("devices_mac_uniq", "devices", ["mac"],
                    unique=True, postgresql_where=sa.text("mac IS NOT NULL"))


def downgrade() -> None:
    op.drop_table("devices")
    op.get_bind().execute(sa.text(
        "DELETE FROM status_values WHERE record_type = 'device_type'"))
