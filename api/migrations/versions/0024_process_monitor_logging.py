"""Process monitor + logging pipeline: the heartbeat registry
(processes), the log store (log_entries), and system_config with the
seeded logging section + forwarding cursor. Status is derived at read
time from heartbeat_at/stopped_at — never stored.

Revision ID: 0024
Revises: 0023
Create Date: 2026-08-26
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOGGING_DEFAULTS = (
    '{"mode": "local", "local_max_rows_per_process": 20000, '
    '"local_max_age_days": 14, "remote_buffer_rows": 10000, '
    '"min_level": "INFO", '
    '"syslog": {"host": "", "port": 514, "protocol": "udp"}}'
)


def upgrade() -> None:
    op.create_table(
        "processes",
        sa.Column("name", sa.Text, primary_key=True),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("pid", sa.Integer),
        sa.Column("hostname", sa.Text, nullable=False, server_default=""),
        sa.Column("started_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("heartbeat_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("stopped_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("meta", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
    )

    op.create_table(
        "log_entries",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("process", sa.Text, nullable=False),
        sa.Column("level", sa.Text, nullable=False),
        sa.Column("levelno", sa.Integer, nullable=False),
        sa.Column("logger", sa.Text, nullable=False, server_default=""),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("extra", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("log_entries_process_id_idx", "log_entries",
                    ["process", "id"])
    op.create_index("log_entries_process_level_idx", "log_entries",
                    ["process", "levelno", "id"])

    op.create_table(
        "system_config",
        sa.Column("section", sa.Text, primary_key=True),
        sa.Column("data", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id")),
    )
    op.execute(
        "INSERT INTO system_config (section, data) VALUES "
        f"('logging', '{LOGGING_DEFAULTS}'::jsonb), "
        "('logging_cursor', '{\"last_forwarded_id\": 0}'::jsonb)"
    )


def downgrade() -> None:
    op.drop_table("system_config")
    op.drop_table("log_entries")
    op.drop_table("processes")
