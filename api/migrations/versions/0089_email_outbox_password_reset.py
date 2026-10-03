"""Email outbox + password reset tokens.

`email_outbox` — every outbound email, rendered at enqueue time and
delivered by notification-worker (status queued/sending/sent/failed/
skipped). `password_reset_tokens` — SHA-256 hashes of self-service reset
links (single use, short-lived).

Revision ID: 0089
Revises: 0088
Create Date: 2026-10-03
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, UUID

revision: str = "0089"
down_revision: str | None = "0088"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.TIMESTAMP(timezone=True)


def upgrade() -> None:
    op.create_table(
        "email_outbox",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("template", sa.Text, nullable=False),
        sa.Column("to_address", CITEXT, nullable=False),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True),
        sa.Column("subject", sa.Text, nullable=False),
        sa.Column("html_body", sa.Text, nullable=False),
        sa.Column("text_body", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("next_attempt_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.Column("last_error", sa.Text, nullable=True),
        sa.Column("worker_id", sa.Text, nullable=True),
        sa.Column("heartbeat_at", TS, nullable=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.Column("sent_at", TS, nullable=True),
        sa.CheckConstraint(
            "status IN ('queued', 'sending', 'sent', 'failed', 'skipped')",
            name="ck_email_outbox_status"),
    )
    op.create_index("ix_email_outbox_due", "email_outbox", ["status", "next_attempt_at"])

    op.create_table(
        "password_reset_tokens",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("user_accounts.person_id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("token_hash", sa.Text, nullable=False, unique=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("used_at", TS, nullable=True),
        sa.Column("requested_ip", sa.Text, nullable=True),
    )
    op.create_index("ix_password_reset_tokens_person", "password_reset_tokens", ["person_id"])


def downgrade() -> None:
    op.drop_index("ix_password_reset_tokens_person", table_name="password_reset_tokens")
    op.drop_table("password_reset_tokens")
    op.drop_index("ix_email_outbox_due", table_name="email_outbox")
    op.drop_table("email_outbox")
