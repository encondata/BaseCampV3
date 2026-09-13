"""Kiosk (web mode): the `kiosk` permission resource — view only, granted
to developer/founder/super_admin/admin/staff/worker — and
kiosk_pair_requests, the 'link with phone' sign-in table.

Design: docs/superpowers/specs/2026-09-13-kiosk-web-design.md

Revision ID: 0061
Revises: 0060
Create Date: 2026-09-13
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0061"
down_revision: str | None = "0060"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KIOSK_ROLES = ("developer", "founder", "super_admin", "admin", "staff", "worker")


def upgrade() -> None:
    op.create_table(
        "kiosk_pair_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("code", sa.Text(), nullable=False, unique=True),
        sa.Column("poll_token_hash", sa.Text(), nullable=False),
        sa.Column("serial", postgresql.CITEXT(), nullable=False),
        sa.Column("kiosk_name", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("approved_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("people.id")),
        sa.Column("ip_address", sa.Text()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("kiosk_pair_requests_ip_created_idx", "kiosk_pair_requests",
                    ["ip_address", "created_at"])
    op.create_index("kiosk_pair_requests_serial_idx", "kiosk_pair_requests",
                    ["serial"])
    conn = op.get_bind()
    for role in KIOSK_ROLES:
        conn.execute(sa.text(
            "INSERT INTO role_permissions (role, resource, action) "
            "VALUES (:r, 'kiosk', 'view') ON CONFLICT DO NOTHING"), {"r": role})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM role_permissions WHERE resource = 'kiosk'"))
    op.drop_index("kiosk_pair_requests_serial_idx", table_name="kiosk_pair_requests")
    op.drop_index("kiosk_pair_requests_ip_created_idx", table_name="kiosk_pair_requests")
    op.drop_table("kiosk_pair_requests")
