"""Kiosk settings in the portal: one config document per kiosk on devices
(version, when and where it last changed, when the kiosk last reported and
which version it has applied), and kiosk_sounds for uploaded sounds kept in
the Spaces bucket.

Revision ID: 0099
Revises: 0098
Create Date: 2026-10-17
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0099"
down_revision: str | None = "0098"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.TIMESTAMP(timezone=True)


def upgrade() -> None:
    op.add_column("devices", sa.Column("config", JSONB, nullable=True))
    op.add_column("devices", sa.Column("config_version", sa.Integer, nullable=False,
                                       server_default=sa.text("0")))
    op.add_column("devices", sa.Column("config_changed_at", TS, nullable=True))
    op.add_column("devices", sa.Column("config_source", sa.Text, nullable=True))
    op.add_column("devices", sa.Column(
        "config_changed_by", UUID(as_uuid=True),
        sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True))
    op.add_column("devices", sa.Column("config_reported_at", TS, nullable=True))
    op.add_column("devices", sa.Column("config_applied_version", sa.Integer, nullable=True))
    op.create_check_constraint(
        "ck_devices_config_source", "devices",
        "config_source IS NULL OR config_source IN ('kiosk', 'portal')")

    op.create_table(
        "kiosk_sounds",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("content_type", sa.Text, nullable=False),
        sa.Column("size", sa.Integer, nullable=False),
        sa.Column("storage_key", sa.Text, nullable=False, unique=True),
        sa.Column("uploaded_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True),
        sa.Column("uploaded_from_device", UUID(as_uuid=True),
                  sa.ForeignKey("devices.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_table("kiosk_sounds")
    op.drop_constraint("ck_devices_config_source", "devices", type_="check")
    for col in ("config_applied_version", "config_reported_at", "config_changed_by",
                "config_source", "config_changed_at", "config_version", "config"):
        op.drop_column("devices", col)
