"""Sign-in address blocks (SS-487).

- `sign_in_failures`: one row per failed sign-in attempt (address, route,
  time). Only the last hour matters: 10 failures from one address within
  a rolling hour trip a block, and older rows are pruned on every write.
- `address_blocks`: one row per address that has ever been blocked. The
  ladder is 1 h, 6 h, 12 h, 24 h, then permanent; the level resets to 1
  after 7 days with no new block, or when an admin clears the block.

The address is `bucket_for(rate_limit_ip(request))`: IPv4 as itself, IPv6
by its /64. System › Blocked addresses lists and acts on the blocks.

Revision ID: 0126
Revises: 0125
Create Date: 2026-11-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0126"
down_revision: str | None = "0125"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sign_in_failures",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("address", sa.Text, nullable=False,
                  comment="the client address bucket (IPv4, or IPv6 /64)"),
        sa.Column("route", sa.Text, nullable=False,
                  comment="which sign-in route failed (login, totp_verify, ...)"),
        sa.Column("at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()"),
                  comment="when the attempt failed"),
        comment="failed sign-in attempts in the last hour, for address blocking",
    )
    op.create_index("ix_sign_in_failures_address_at", "sign_in_failures",
                    ["address", "at"])
    op.create_index("ix_sign_in_failures_at", "sign_in_failures", ["at"])

    op.create_table(
        "address_blocks",
        sa.Column("address", sa.Text, primary_key=True,
                  comment="the client address bucket (IPv4, or IPv6 /64)"),
        sa.Column("level", sa.SmallInteger, nullable=False,
                  comment="ladder step of the current or last block: 1-5 "
                          "(5 = permanent); 0 after a clear"),
        sa.Column("permanent", sa.Boolean, nullable=False,
                  server_default=sa.false(),
                  comment="blocked until an admin clears it"),
        sa.Column("blocked_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  comment="start of the current or last block (the 7-day "
                          "escalation reset counts from here)"),
        sa.Column("ends_at", sa.TIMESTAMP(timezone=True), nullable=True,
                  comment="when a timed block ends; NULL when permanent"),
        sa.Column("first_blocked_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  comment="when this address was first blocked"),
        sa.Column("times_blocked", sa.Integer, nullable=False,
                  comment="how many times this address has been blocked"),
        sa.Column("failure_count", sa.Integer, nullable=False,
                  comment="failed attempts that tripped the current or last block"),
        sa.Column("last_route", sa.Text, nullable=False,
                  comment="the route of the failure that tripped the block"),
        sa.Column("cleared_at", sa.TIMESTAMP(timezone=True), nullable=True,
                  comment="when an admin cleared the block"),
        sa.Column("cleared_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True,
                  comment="the admin who cleared the block"),
        sa.Column("made_permanent_at", sa.TIMESTAMP(timezone=True), nullable=True,
                  comment="when an admin made a timed block permanent"),
        sa.Column("made_permanent_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True,
                  comment="the admin who made the block permanent"),
        comment="one row per address blocked from signing in",
    )


def downgrade() -> None:
    op.drop_table("address_blocks")
    op.drop_index("ix_sign_in_failures_at", table_name="sign_in_failures")
    op.drop_index("ix_sign_in_failures_address_at", table_name="sign_in_failures")
    op.drop_table("sign_in_failures")
