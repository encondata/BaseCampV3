"""Two-factor authentication.

Adds the per-user / per-group / per-role `totp_required` policy flags, the
TOTP replay guard (`totp_last_counter`), one-time backup codes, and
trusted browsers ("Remember this browser" skips the code for N days).

Revision ID: 0071
Revises: 0070
Create Date: 2026-09-23
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0071"
down_revision: str | None = "0070"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("user_accounts", sa.Column(
        "totp_required", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("user_accounts", sa.Column(
        "totp_last_counter", sa.BigInteger(), nullable=True,
        comment="Last accepted TOTP time step; codes at or below it are replays"))
    op.add_column("access_groups", sa.Column(
        "totp_required", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("roles", sa.Column(
        "totp_required", sa.Boolean(), nullable=False, server_default=sa.text("false")))

    op.create_table(
        "totp_backup_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("user_accounts.person_id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_totp_backup_codes_person", "totp_backup_codes", ["person_id"])

    op.create_table(
        "trusted_devices",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("user_accounts.person_id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_trusted_devices_person", "trusted_devices", ["person_id"])


def downgrade() -> None:
    op.drop_index("ix_trusted_devices_person", table_name="trusted_devices")
    op.drop_table("trusted_devices")
    op.drop_index("ix_totp_backup_codes_person", table_name="totp_backup_codes")
    op.drop_table("totp_backup_codes")
    op.drop_column("roles", "totp_required")
    op.drop_column("access_groups", "totp_required")
    op.drop_column("user_accounts", "totp_last_counter")
    op.drop_column("user_accounts", "totp_required")
