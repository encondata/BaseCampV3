"""containers — logistics containers + asset membership.
Rebuilt from legacy V2 containers/containers_assets_list: uuid PKs,
status + type via status_values vocabularies, site FK + free-text
location_detail (the assets idiom, replacing V2's sites_locations FK),
membership in a join table with UNIQUE(asset_id) (one container per
asset — V2 assumed but never enforced this), and the denormalized
container_device_count deliberately dropped (computed in queries).
truck_id arrives in 0016 with the trucks table.

Revision ID: 0015
Revises: 0014
Create Date: 2026-08-06
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONTAINER_SEEDS = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('container','available','Available','Empty or accepting assets.','#178a4c',1),
      ('container','packed','Packed','Loaded and sealed.','#6d4fc4',2),
      ('container','in_transit','In transit','Between locations.','#0f7c86',3),
      ('container','historical','Historical','Retired; retained for history.','#51606f',4),
      ('container_type','pelican_case','Pelican case','Hard transport case.','#1668a7',1),
      ('container_type','shipping_container','Shipping container','Full-size freight container.','#a36207',2),
      ('container_type','cart','Cart','Rolling cart or trolley.','#0f7c86',3)
"""

FULL = ("view", "add", "change", "delete")
# containers: internal-only (like sites) — no client/partner visibility.
CONTAINER_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": FULL,
}


def upgrade() -> None:
    op.execute(CONTAINER_SEEDS)

    op.create_table(
        "containers",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT, nullable=False),
        sa.Column("rfid_tag", CITEXT),
        sa.Column("container_type", sa.Text),
        sa.Column("status", sa.Text, nullable=False, server_default="available"),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("location_detail", sa.Text, nullable=False, server_default=""),
        sa.Column("last_audit_at", sa.TIMESTAMP(timezone=True),
                  comment="written by future scan surfaces"),
        sa.Column("audit_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("last_validated_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("legacy_id", sa.BigInteger, comment="V2 containers.id"),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    # composite FKs to status_values — the 0014 assets idiom, twice
    op.execute("""
        ALTER TABLE containers ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('container') STORED
    """)
    op.create_foreign_key(
        "containers_status_fkey", "containers", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])
    op.execute("""
        ALTER TABLE containers ADD COLUMN type_record_type text
          GENERATED ALWAYS AS ('container_type') STORED
    """)
    # MATCH SIMPLE: a NULL container_type skips the check entirely
    op.create_foreign_key(
        "containers_type_fkey", "containers", "status_values",
        ["type_record_type", "container_type"], ["record_type", "key"])

    op.create_index("containers_name_idx", "containers", ["name"])
    op.create_index("containers_site_idx", "containers", ["site_id"])
    op.create_index("containers_rfid_uniq", "containers", ["rfid_tag"],
                    unique=True,
                    postgresql_where=sa.text("rfid_tag IS NOT NULL"))

    op.create_table(
        "container_assets",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("container_id", UUID(as_uuid=True),
                  sa.ForeignKey("containers.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), sa.ForeignKey("assets.id"),
                  nullable=False, unique=True,
                  comment="UNIQUE: one container per asset"),
        sa.Column("added_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("added_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("last_validated_at", sa.TIMESTAMP(timezone=True)),
    )
    op.create_index("container_assets_container_idx", "container_assets",
                    ["container_id"])

    conn = op.get_bind()
    for role, actions in CONTAINER_GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'containers', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'containers'"))
    op.drop_table("container_assets")
    op.drop_table("containers")
    conn.execute(sa.text(
        "DELETE FROM status_values "
        "WHERE record_type IN ('container', 'container_type')"))
