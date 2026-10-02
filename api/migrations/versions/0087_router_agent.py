"""GL.iNet router agent: approval state, pinned secret (hashed), the
candidate secret awaiting approval, and the last report's source IP.
NULL approval_state = not an agent router (kiosks, readers, hand-made rows).

Revision ID: 0087
Revises: 0086
Create Date: 2026-10-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0087"
down_revision: str | None = "0086"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("approval_state", sa.Text(), nullable=True))
    op.create_check_constraint(
        "devices_approval_state_check", "devices",
        "approval_state IN ('pending', 'approved', 'revoked')")
    op.add_column("devices", sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("devices", sa.Column(
        "approved_by", UUID(as_uuid=True),
        sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True))
    op.add_column("devices", sa.Column("agent_secret_hash", sa.Text(), nullable=True))
    op.add_column("devices", sa.Column("pending_secret_hash", sa.Text(), nullable=True))
    op.add_column("devices", sa.Column(
        "secret_mismatch", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("devices", sa.Column("agent_source_ip", sa.Text(), nullable=True))
    # the per-IP registration cap counts recent router_register audit rows
    # (immutable, so moving a router to another address can't launder it)
    op.create_index(
        "audit_log_router_register_ip_at_idx", "audit_log", ["ip", "at"],
        postgresql_where=sa.text("action = 'router_register'"))


def downgrade() -> None:
    op.drop_index("audit_log_router_register_ip_at_idx", table_name="audit_log")
    op.drop_column("devices", "agent_source_ip")
    op.drop_column("devices", "secret_mismatch")
    op.drop_column("devices", "pending_secret_hash")
    op.drop_column("devices", "agent_secret_hash")
    op.drop_column("devices", "approved_by")
    op.drop_column("devices", "approved_at")
    op.drop_constraint("devices_approval_state_check", "devices", type_="check")
    op.drop_column("devices", "approval_state")
