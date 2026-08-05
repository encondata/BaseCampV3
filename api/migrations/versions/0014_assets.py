"""assets — core registry + make/model catalog + aliases + global notes.
Rebuilt from legacy BaseCamp V2 assets/assets_make_model/assets_make_model_fuzzy:
uuid PKs, editable category lookup, status via status_values, dual-unit
weight/dimensions (server computes the partner), CITEXT identifiers with a
partial-unique rfid_tag, and the damage/notes existence flags deliberately
dropped (damage reports are a designed follow-on; notes become a real table).

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-05
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ASSET_CATEGORIES = [
    ("server", "Server", "Compute hardware.", 1, "#1668a7"),
    ("storage", "Storage", "Disk shelves, arrays, tape.", 2, "#6d4fc4"),
    ("network", "Network", "Switches, routers, firewalls.", 3, "#0f7c86"),
    ("power", "Power", "PDUs, UPSes.", 4, "#a36207"),
    ("other", "Other", "Anything that does not fit the other categories.", 5, "#51606f"),
]

ASSET_STATUSES = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('asset','active','Active','Racked and in service.','#178a4c',1),
      ('asset','in_transit','In transit','Between locations.','#0f7c86',2),
      ('asset','in_storage','In storage','Warehoused, not in service.','#51606f',3),
      ('asset','decommissioned','Decommissioned','Retired; retained for history.','#c03540',4),
      ('asset','unknown','Unknown','Not yet verified.','#a36207',5)
"""

FULL = ("view", "add", "change", "delete")
# assets: staff full, client org roles read-only (their own rows via scope).
ASSET_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": FULL,
    "client_owner": ("view",), "client_admin": ("view",),
    "client_viewer": ("view",),
}
# asset_models: the catalog (incl. the knowledge field) is house IP —
# internal roles only; client actors get a read-only summary embedded in
# asset payloads instead.
MODEL_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": FULL,
}


def upgrade() -> None:
    op.create_table(
        "asset_categories",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("sort_order", sa.Integer, nullable=False),
        sa.Column("color", sa.Text, nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )

    conn = op.get_bind()
    for key, label, desc, order, color in ASSET_CATEGORIES:
        conn.execute(sa.text(
            "INSERT INTO asset_categories (key, label, description, sort_order, color) "
            "VALUES (:k, :l, :d, :o, :c)"),
            {"k": key, "l": label, "d": desc, "o": order, "c": color})
    op.execute(ASSET_STATUSES)

    op.create_table(
        "asset_models",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("make", CITEXT, nullable=False),
        sa.Column("model", CITEXT, nullable=False),
        sa.Column("category", sa.Text, sa.ForeignKey("asset_categories.key")),
        sa.Column("ru_size", sa.Integer),
        # dual-unit pairs: enter either side, the API computes the partner
        sa.Column("weight_lbs", sa.Numeric(8, 2)),
        sa.Column("weight_kg", sa.Numeric(8, 2)),
        sa.Column("length_in", sa.Numeric(8, 2)),
        sa.Column("width_in", sa.Numeric(8, 2)),
        sa.Column("height_in", sa.Numeric(8, 2)),
        sa.Column("length_cm", sa.Numeric(8, 2)),
        sa.Column("width_cm", sa.Numeric(8, 2)),
        sa.Column("height_cm", sa.Numeric(8, 2)),
        sa.Column("mount_type", sa.Text,
                  comment="rails, ears, shelf, custom — validated in code"),
        sa.Column("rail_type", sa.Text, comment="e.g. Dell B7, A15"),
        sa.Column("knowledge", sa.Text, nullable=False, server_default="",
                  comment="field-crew tips & tricks"),
        sa.Column("legacy_id", sa.BigInteger, comment="V2 assets_make_model.id"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("make", "model", name="asset_models_make_model_key"),
    )

    op.create_table(
        "asset_model_aliases",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("model_id", UUID(as_uuid=True),
                  sa.ForeignKey("asset_models.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("alias", CITEXT, nullable=False, unique=True,
                  comment="global-unique: an alias resolves to exactly one model"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("asset_model_aliases_model_idx", "asset_model_aliases",
                    ["model_id"])

    op.create_table(
        "assets",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("serial_number", CITEXT,
                  comment="indexed, deliberately NOT unique — legacy has dupes"),
        sa.Column("name", CITEXT, comment="hostname/label"),
        sa.Column("rfid_tag", CITEXT),
        sa.Column("model_id", UUID(as_uuid=True),
                  sa.ForeignKey("asset_models.id")),
        sa.Column("client_id", UUID(as_uuid=True), sa.ForeignKey("clients.id"),
                  comment="owner; NULL = house gear. Drives client scoping."),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("location_detail", sa.Text, nullable=False, server_default=""),
        sa.Column("status", sa.Text, nullable=False, server_default="unknown"),
        sa.Column("has_rails", sa.Boolean, comment="NULL = unknown"),
        sa.Column("last_seen_at", sa.TIMESTAMP(timezone=True),
                  comment="written by future scan surfaces"),
        sa.Column("legacy_id", sa.BigInteger, comment="V2 assets.id"),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    # composite FK to status_values, same idiom migration 0012 used for sites
    op.execute("""
        ALTER TABLE assets ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "assets_status_fkey", "assets", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])

    op.create_index("assets_serial_idx", "assets", ["serial_number"])
    op.create_index("assets_client_idx", "assets", ["client_id"])
    op.create_index("assets_site_idx", "assets", ["site_id"])
    op.create_index("assets_model_idx", "assets", ["model_id"])
    op.create_index("assets_rfid_uniq", "assets", ["rfid_tag"], unique=True,
                    postgresql_where=sa.text("rfid_tag IS NOT NULL"))

    op.create_table(
        "notes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("entity_type", sa.Text, nullable=False,
                  comment="same vocabulary as attachments; only 'asset' in V1"),
        sa.Column("entity_id", UUID(as_uuid=True), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("updated_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("deleted_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("notes_entity_idx", "notes",
                    ["entity_type", "entity_id", "created_at"])

    for resource, grants in (("assets", ASSET_GRANTS),
                             ("asset_models", MODEL_GRANTS)):
        for role, actions in grants.items():
            for action in actions:
                conn.execute(sa.text(
                    "INSERT INTO role_permissions (role, resource, action) "
                    "VALUES (:r, :res, :a) ON CONFLICT DO NOTHING"),
                    {"r": role, "res": resource, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource IN ('assets', 'asset_models')"))
    op.drop_table("notes")
    op.drop_table("assets")
    op.drop_table("asset_model_aliases")
    op.drop_table("asset_models")
    op.drop_table("asset_categories")
    conn.execute(sa.text("DELETE FROM status_values WHERE record_type = 'asset'"))
