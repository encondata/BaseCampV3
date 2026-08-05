"""sites — expanded schema with editable type/status lookups, M:N client
links, real lat/lon columns, and a JSONB survey blob. Replaces the legacy
BaseCamp sites table (free-text type/status, "lat, lon" string, dual client
relationships, no timestamps).

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-15
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SITE_TYPES = [
    ("datacenter", "Data centre", "Colocation or owned data centre space.", 1, "server"),
    ("office", "Office", "Corporate or branch office.", 2, "building"),
    ("warehouse", "Warehouse", "Storage or staging facility.", 3, "box"),
    ("colo", "Colocation", "Shared colocation floor.", 4, "server"),
    ("partner_office", "Partner office", "Facility operated by a partner.", 5, "handshake"),
    ("other", "Other", "Anything that does not fit the other types.", 6, "pin"),
]

SITE_STATUSES = [
    ("active", "Active", "In service.", "c-green", 1),
    ("planned", "Planned", "Not yet in service.", "c-aqua", 2),
    ("inactive", "Inactive", "Temporarily out of service.", "c-slate", 3),
    ("decommissioned", "Decommissioned", "Retired; retained for history.", "c-red", 4),
]

# sites matrix: internal-only. No client_*/vendor_* grants — Sites is not
# visible to org-anchored actors at all (see access/resources.py visible_to).
FULL = ("view", "add", "change", "delete")
SITE_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": FULL,
}


def upgrade() -> None:
    op.create_table(
        "site_types",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("sort_order", sa.Integer, nullable=False),
        sa.Column("icon", sa.Text),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_table(
        "site_statuses",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("color", sa.Text, nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )

    conn = op.get_bind()
    for key, label, desc, order, icon in SITE_TYPES:
        conn.execute(sa.text(
            "INSERT INTO site_types (key, label, description, sort_order, icon) "
            "VALUES (:k, :l, :d, :o, :i)"),
            {"k": key, "l": label, "d": desc, "o": order, "i": icon})
    for key, label, desc, color, order in SITE_STATUSES:
        conn.execute(sa.text(
            "INSERT INTO site_statuses (key, label, description, color, sort_order) "
            "VALUES (:k, :l, :d, :c, :o)"),
            {"k": key, "l": label, "d": desc, "c": color, "o": order})

    op.create_table(
        "sites",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT, nullable=False),
        sa.Column("code", CITEXT),
        sa.Column("site_type", sa.Text, sa.ForeignKey("site_types.key")),
        sa.Column("status", sa.Text, sa.ForeignKey("site_statuses.key"),
                  nullable=False, server_default="active"),
        sa.Column("address_line1", sa.Text),
        sa.Column("address_line2", sa.Text),
        sa.Column("city", sa.Text),
        sa.Column("region", sa.Text),
        sa.Column("postal_code", sa.Text),
        sa.Column("country", sa.Text, nullable=False, server_default="US"),
        sa.Column("latitude", sa.Numeric(9, 6)),
        sa.Column("longitude", sa.Numeric(9, 6)),
        sa.Column("timezone", sa.Text, comment="IANA name, e.g. America/New_York"),
        sa.Column("dc_provider", sa.Text),
        sa.Column("partner_id", UUID(as_uuid=True), sa.ForeignKey("partners.id"),
                  comment="partner-operated facility; NULL = ours or a client's"),
        sa.Column("survey_data", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("notes", sa.Text),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        # never half a coordinate — the legacy free-text "lat, lon" allowed it
        sa.CheckConstraint("(latitude IS NULL) = (longitude IS NULL)",
                           name="sites_coords_check"),
    )
    op.create_index("sites_partner_idx", "sites", ["partner_id"])

    op.create_table(
        "site_clients",
        sa.Column("site_id", UUID(as_uuid=True),
                  sa.ForeignKey("sites.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("client_id", UUID(as_uuid=True), sa.ForeignKey("clients.id"),
                  primary_key=True),
        sa.Column("linked_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("linked_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("site_clients_client_idx", "site_clients", ["client_id"])

    for role, actions in SITE_GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'sites', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM role_permissions WHERE resource = 'sites'"))
    op.drop_table("site_clients")
    op.drop_table("sites")
    op.drop_table("site_statuses")
    op.drop_table("site_types")
