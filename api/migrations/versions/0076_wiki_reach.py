"""Wiki: Phase 3 reach — schema for public share links, help links, and
analytics (page views, feedback, search log). `wiki_jobs.kind` widens to
add 'export' and 'retention' (the worker's export-file job and the daily
analytics/export retention sweep).

Design: docs/superpowers/specs/2026-09-25-wiki-design.md (§8 Phase 3).

`wiki_share_links.created_by`/`wiki_help_links.created_by` follow the
Phase 1 (0074) convention already on `wiki_nodes`: a column naming the
*creator* of a record is a plain FK to `people` (no ondelete), since that
history is never nulled out.

`wiki_search_log.person_id` is FK ... ON DELETE SET NULL instead — a log
row outlives the person who triggered it, so the row stays (with
`person_id` cleared) rather than being deleted with them.

`wiki_page_views` and `wiki_feedback` have no surrogate id: they key
directly on `(node_id, person_id[, viewed_on])`, so both FKs are ON
DELETE CASCADE — there's no "keep the row, clear the person" option when
the person is half the key.

Revision ID: 0076
Revises: 0075
Create Date: 2026-09-26
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0076"
down_revision: str | None = "0075"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JOB_KIND_CHECK = (
    "kind IN ('file_preview','file_extract','purge','reminders','export','retention')")
JOB_KIND_CHECK_PRE_0076 = "kind IN ('file_preview','file_extract','purge','reminders')"


def upgrade() -> None:
    # ── wiki_share_links ─────────────────────────────────────────
    op.create_table(
        "wiki_share_links",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), nullable=False),
        # only the sha256 hash is stored; the token itself is shown once,
        # on creation, and never persisted.
        sa.Column("token_hash", sa.Text, nullable=False, unique=True),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("revoked_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("view_count", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("last_viewed_at", sa.TIMESTAMP(timezone=True)),
    )

    # ── wiki_help_links ──────────────────────────────────────────
    op.create_table(
        "wiki_help_links",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        # e.g. "portal:/bulk/time" or "kiosk:/enroll" — a route pattern,
        # matched by longest prefix at lookup time.
        sa.Column("context", sa.Text, nullable=False, unique=True),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("char_length(context) BETWEEN 1 AND 300",
                           name="wiki_help_links_context_length_check"),
    )

    # ── wiki_page_views ──────────────────────────────────────────
    op.create_table(
        "wiki_page_views",
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("viewed_on", sa.Date, primary_key=True),
        sa.Column("count", sa.Integer, nullable=False),
    )

    # ── wiki_feedback ────────────────────────────────────────────
    op.create_table(
        "wiki_feedback",
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("helpful", sa.Boolean, nullable=False),
        sa.Column("comment", sa.Text),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("comment IS NULL OR char_length(comment) <= 2000",
                           name="wiki_feedback_comment_length_check"),
    )

    # ── wiki_search_log ──────────────────────────────────────────
    op.create_table(
        "wiki_search_log",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("query", sa.Text, nullable=False),
        sa.Column("result_count", sa.Integer, nullable=False),
        sa.Column("at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("wiki_search_log_at_idx", "wiki_search_log", ["at"])

    # ── enum widening ─────────────────────────────────────────────
    op.drop_constraint("wiki_jobs_kind_check", "wiki_jobs", type_="check")
    op.create_check_constraint("wiki_jobs_kind_check", "wiki_jobs", JOB_KIND_CHECK)


def downgrade() -> None:
    op.drop_constraint("wiki_jobs_kind_check", "wiki_jobs", type_="check")
    op.create_check_constraint(
        "wiki_jobs_kind_check", "wiki_jobs", JOB_KIND_CHECK_PRE_0076)

    op.drop_index("wiki_search_log_at_idx", table_name="wiki_search_log")
    op.drop_table("wiki_search_log")

    op.drop_table("wiki_feedback")

    op.drop_table("wiki_page_views")

    op.drop_table("wiki_help_links")

    op.drop_table("wiki_share_links")
