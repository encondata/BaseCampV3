"""device_dhcp_leases + router VPN/token columns. vpn_status is plain
TEXT on purpose — the (deferred) heartbeat reports it and must never
be rejected for an unexpected value; the portal maps known values to
chips. connected counts are DERIVED from lease rows at read time,
never stored, so the list can't disagree with the expansion.
(device_id, mac) is the future heartbeat's lease-sync key.

Revision ID: 0038
Revises: 0037
Create Date: 2026-08-31
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0038"
down_revision: str | None = "0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column(
        "vpn_status", sa.Text,
        comment="reported string; not vocabulary-FK'd by design"))
    op.add_column("devices", sa.Column(
        "token_expires_at", sa.TIMESTAMP(timezone=True),
        comment="router agent API-token expiry"))
    op.create_table(
        "device_dhcp_leases",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("device_id", UUID(as_uuid=True),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("mac", CITEXT, nullable=False),
        sa.Column("ip", sa.Text),
        sa.Column("hostname", sa.Text),
        sa.Column("reserved", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("up", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("last_seen_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("device_id", "mac",
                            name="device_dhcp_leases_device_mac_uniq"),
    )
    op.create_index("device_dhcp_leases_device_idx", "device_dhcp_leases",
                    ["device_id"])


def downgrade() -> None:
    op.drop_table("device_dhcp_leases")
    op.drop_column("devices", "token_expires_at")
    op.drop_column("devices", "vpn_status")
