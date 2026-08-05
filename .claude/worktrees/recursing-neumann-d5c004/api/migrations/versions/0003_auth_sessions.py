"""auth_sessions — rotating refresh-token sessions with reuse detection

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import INET, UUID

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "auth_sessions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("user_accounts.person_id"), nullable=False),
        sa.Column("family_id", UUID(as_uuid=True), nullable=False,
                  comment="constant across rotations; identifies one login event"),
        sa.Column("token_hash", sa.Text, nullable=False, unique=True,
                  comment="SHA-256 of the opaque refresh token; raw token never stored"),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        # rotation chain
        sa.Column("rotated_at", sa.TIMESTAMP(timezone=True),
                  comment="set when refreshed; a rotated token presented again = reuse"),
        sa.Column("replaced_by", UUID(as_uuid=True),
                  sa.ForeignKey("auth_sessions.id"),
                  comment="successor session in the same family"),
        # revocation
        sa.Column("revoked_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("revoke_reason", sa.Text),
        # client telemetry
        sa.Column("ip_address", INET),
        sa.Column("user_agent", sa.Text),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint(
            "revoke_reason IN ('logout', 'reuse_detected', 'admin', "
            "'password_change', 'account_disabled')",
            name="auth_sessions_revoke_reason_check"),
        # revoked rows always say why; live rows never carry a reason
        sa.CheckConstraint("(revoked_at IS NULL) = (revoke_reason IS NULL)",
                           name="auth_sessions_revoke_pair_check"),
        # a rotated row must point at its successor
        sa.CheckConstraint("(rotated_at IS NULL) = (replaced_by IS NULL)",
                           name="auth_sessions_rotation_pair_check"),
    )

    # hot path: look up an incoming refresh token (unique index already covers
    # token_hash); these cover family revocation and "active sessions" screens
    op.create_index("auth_sessions_family_idx", "auth_sessions", ["family_id"])
    op.create_index("auth_sessions_person_active_idx", "auth_sessions", ["person_id"],
                    postgresql_where=sa.text("revoked_at IS NULL AND rotated_at IS NULL"))


def downgrade() -> None:
    op.drop_table("auth_sessions")
