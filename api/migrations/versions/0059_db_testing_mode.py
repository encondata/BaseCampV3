"""DB testing mode — db_testing_sessions + db_backups.purpose.

A password-gated Testing tab on Developer -> Database: snapshot the
database (own worker process), let the user make changes, then revert to
the snapshot or keep the changes. `db_backups.purpose` distinguishes a
manual backup from the snapshot a testing session takes, so the Backups
tab can label it.

Design: docs/superpowers/specs/2026-09-12-db-testing-mode-design.md

Revision ID: 0059
Revises: 0058
Create Date: 2026-09-12
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0059"
down_revision: str | None = "0058"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS_CHECK = "db_testing_sessions_status_check"
ENDED_WITH_CHECK = "db_testing_sessions_ended_with_check"
ONE_ACTIVE_IDX = "db_testing_sessions_one_active_idx"
PURPOSE_CHECK = "db_backups_purpose_check"


def upgrade() -> None:
    op.add_column(
        "db_backups",
        sa.Column("purpose", sa.Text(), nullable=False,
                  server_default="manual"))
    op.create_check_constraint(
        PURPOSE_CHECK, "db_backups",
        "purpose IN ('manual', 'testing_snapshot')")

    op.create_table(
        "db_testing_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("snapshot_backup_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("db_backups.id", ondelete="SET NULL")),
        sa.Column("row_counts", postgresql.JSONB(), nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("audit_watermark", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("ended_with", sa.Text()),
        sa.Column("error", sa.Text()),
        sa.Column("worker_id", sa.Text()),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True)),
        sa.Column("previous_banner", postgresql.JSONB()),
    )
    op.create_check_constraint(
        STATUS_CHECK, "db_testing_sessions",
        "status IN ('snapshotting', 'active', 'reverting', 'ended', 'failed')")
    op.create_check_constraint(
        ENDED_WITH_CHECK, "db_testing_sessions",
        "ended_with IS NULL OR ended_with IN ('reverted', 'kept')")
    # At most one unfinished session ever — a unique index on a constant
    # expression, scoped by the partial WHERE, is the standard Postgres
    # idiom for "at most one row matching this predicate".
    op.execute(
        f"CREATE UNIQUE INDEX {ONE_ACTIVE_IDX} ON db_testing_sessions ((1)) "
        "WHERE status IN ('snapshotting', 'active', 'reverting')")


def downgrade() -> None:
    op.execute(f"DROP INDEX {ONE_ACTIVE_IDX}")
    op.drop_table("db_testing_sessions")
    op.drop_constraint(PURPOSE_CHECK, "db_backups")
    op.drop_column("db_backups", "purpose")
