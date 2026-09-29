"""Wiki: Phase 2 collaboration schema — comments, page templates, watches
(subscriptions), and the review/approval workflow, plus the review-cycle
columns on `wiki_nodes` and two enum widenings.

Design: docs/superpowers/specs/2026-09-25-wiki-design.md (§7).
Plan: docs/superpowers/plans/2026-09-26-wiki-phase2.md.

`_by` columns follow the Phase 1 (0074) convention already on
`wiki_nodes`: a column naming the *creator* of a record (`created_by`,
`wiki_templates.created_by`) is a plain FK to `people` (no ondelete,
matching `wiki_spaces.created_by` etc.) since that history is never
nulled out; a column naming the *last actor on a mutable field*
(`resolved_by`, `decided_by`, `last_reviewed_by` — siblings of
`wiki_nodes.updated_by`/`deleted_by`/`owner_id`) is FK ... ON DELETE SET
NULL, since the field itself can legitimately go back to "nobody".

`wiki_comments.thread_id` is deliberately NOT a foreign key: it holds the
id of the thread's first comment, including on that very row (a comment
sets its own id as its thread_id when it starts a new thread), which
would make the very first insert satisfy no FK yet.

Revision ID: 0075
Revises: 0074
Create Date: 2026-09-26
"""
import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0075"
down_revision: str | None = "0074"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NIL_UUID = "00000000-0000-0000-0000-000000000000"

PAGE_VERSION_KIND_CHECK = (
    "kind IN ('autosave','published','restored','imported','submitted')")
JOB_KIND_CHECK = "kind IN ('file_preview','file_extract','purge','reminders')"


# ── builtin template content ────────────────────────────────────────
# Small helpers so the four seed docs below read as an outline instead of
# a wall of nested dicts. Every node name matches wiki/web/src/editor/
# schema.ts (StarterKit + Callout + TaskList/TaskItem): paragraph,
# heading{level}, bulletList/orderedList > listItem, taskList > taskItem
# {checked}, callout{variant}.

def _text(s: str) -> dict:
    return {"type": "text", "text": s}


def _p(s: str | None = None) -> dict:
    return {"type": "paragraph", "content": [_text(s)]} if s else {"type": "paragraph"}


def _heading(level: int, s: str) -> dict:
    return {"type": "heading", "attrs": {"level": level}, "content": [_text(s)]}


def _li(s: str) -> dict:
    return {"type": "listItem", "content": [_p(s)]}


def _bullet_list(items: list[str]) -> dict:
    return {"type": "bulletList", "content": [_li(i) for i in items]}


def _ordered_list(items: list[str]) -> dict:
    return {"type": "orderedList", "content": [_li(i) for i in items]}


def _task_item(s: str, checked: bool = False) -> dict:
    return {"type": "taskItem", "attrs": {"checked": checked}, "content": [_p(s)]}


def _task_list(items: list[str]) -> dict:
    return {"type": "taskList", "content": [_task_item(i) for i in items]}


def _callout(variant: str, s: str) -> dict:
    return {"type": "callout", "attrs": {"variant": variant}, "content": [_p(s)]}


def _doc(*blocks: dict) -> dict:
    return {"type": "doc", "content": list(blocks)}


SOP_CONTENT = _doc(
    _heading(1, "Standard Operating Procedure: [Title]"),
    _heading(2, "Purpose"),
    _p("Describe why this procedure exists and the outcome it ensures."),
    _heading(2, "Scope"),
    _p("State what this SOP covers, and anything it explicitly does not."),
    _heading(2, "Responsibilities"),
    _bullet_list(["Owner: who maintains this SOP.",
                  "Performers: who is expected to carry it out."]),
    _heading(2, "Procedure"),
    _ordered_list(["Step one.", "Step two.", "Step three."]),
    _callout("warning", "Safety: note any hazards, required PPE, or "
                        "lockout/tagout steps before proceeding."),
    _heading(2, "Revision Notes"),
    _p("Date, author, and a short summary of each change to this SOP."),
)

HOWTO_CONTENT = _doc(
    _heading(1, "How to [do the thing]"),
    _heading(2, "Overview"),
    _p("A sentence or two on what this guide accomplishes and who it's for."),
    _heading(2, "Before You Start"),
    _bullet_list(["Access or permissions you need.",
                  "Tools or accounts required."]),
    _heading(2, "Steps"),
    _ordered_list(["First step.", "Second step.", "Third step."]),
    _callout("tip", "Tip: call out a shortcut or best practice here."),
    _heading(2, "Related Pages"),
    _p("Link to related how-tos or reference pages."),
)

TROUBLESHOOTING_CONTENT = _doc(
    _heading(1, "Troubleshooting: [Issue]"),
    _heading(2, "Symptoms"),
    _bullet_list(["What the user sees or reports.",
                  "Any error messages or codes."]),
    _heading(2, "Possible Causes"),
    _bullet_list(["Cause one.", "Cause two."]),
    _heading(2, "Resolution Steps"),
    _ordered_list(["Check this first.", "Try this fix.",
                   "Verify the issue is resolved."]),
    _callout("danger", "If the steps above don't resolve the issue, escalate "
                       "rather than continuing to troubleshoot."),
    _heading(2, "Related Links"),
    _p("Link to related runbooks or past incidents."),
)

MEETING_NOTES_CONTENT = _doc(
    _heading(1, "Meeting Notes: [Topic] — [Date]"),
    _heading(2, "Attendees"),
    _bullet_list(["Name (role)"]),
    _heading(2, "Agenda"),
    _ordered_list(["Topic one.", "Topic two."]),
    _heading(2, "Discussion"),
    _p("Summarize what was discussed for each agenda item."),
    _heading(2, "Action Items"),
    _task_list(["Who does what, by when."]),
    _heading(2, "Next Meeting"),
    _p("Date and any carryover topics."),
)

# (name, description, icon, content) — is_builtin=true, space_id=NULL (global)
BUILTIN_TEMPLATES: list[tuple[str, str, str, dict]] = [
    ("SOP",
     ("A standard operating procedure: purpose, scope, responsibilities, a "
      "step-by-step procedure, and a safety callout."),
     "clipboard-list", SOP_CONTENT),
    ("How-to guide",
     "A short, step-by-step guide for accomplishing one task.",
     "compass", HOWTO_CONTENT),
    ("Troubleshooting",
     "A structured guide for diagnosing and resolving a specific issue.",
     "wrench", TROUBLESHOOTING_CONTENT),
    ("Meeting notes",
     "Attendees, agenda, discussion, and action items for a meeting.",
     "users", MEETING_NOTES_CONTENT),
]


def _q(value: str) -> str:
    """Single-quoted SQL literal with quotes doubled."""
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _seed_statements() -> list[str]:
    """The exact statements `seed()` runs, in order. A plain list (rather
    than inlining each `op.execute(...)` call) so both `upgrade()` and the
    test suite iterate the identical set of statements. ON CONFLICT targets
    the `wiki_templates_space_name_key` expression index so re-running
    this is a no-op — the same convention as 0066's `seed(conn)`."""
    return [
        f"""
        INSERT INTO wiki_templates
            (space_id, name, description, icon, content_json, is_builtin)
        VALUES (NULL, {_q(name)}, {_q(description)}, {_q(icon)},
                {_q(json.dumps(content))}::jsonb, true)
        ON CONFLICT (coalesce(space_id, '{NIL_UUID}'::uuid), lower(name))
        DO NOTHING
        """
        for name, description, icon, content in BUILTIN_TEMPLATES
    ]


def seed(conn) -> None:
    """Seed the four builtin templates against `conn` (a raw/sync
    connection). Idempotent, so a test file may re-run it after `clean_db`
    truncates `wiki_templates` — the same convention 0066's
    `test_container_zpl_templates.py` uses for its seed rows."""
    for sql in _seed_statements():
        conn.execute(sa.text(sql))


def upgrade() -> None:
    # ── wiki_comments ────────────────────────────────────────────
    op.create_table(
        "wiki_comments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), nullable=False),
        # id of the thread's first comment (itself, for that first comment).
        # Not a FK — see module docstring.
        sa.Column("thread_id", UUID(as_uuid=True), nullable=False),
        sa.Column("parent_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_comments.id", ondelete="CASCADE")),
        # true = an inline thread anchored to a commentThread mark (id) in
        # the page's doc; false = a page-level (non-anchored) comment.
        sa.Column("anchor", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("body", JSONB, nullable=False),
        sa.Column("author_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("edited_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("deleted_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("resolved_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("resolved_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
    )
    op.create_index("wiki_comments_node_thread_created_idx", "wiki_comments",
                    ["node_id", "thread_id", "created_at"])

    # ── wiki_templates ───────────────────────────────────────────
    op.create_table(
        "wiki_templates",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        # NULL = global (available in every space)
        sa.Column("space_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_spaces.id", ondelete="CASCADE")),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("icon", sa.Text, nullable=False, server_default=""),
        sa.Column("content_json", JSONB, nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("is_builtin", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 120",
                           name="wiki_templates_name_length_check"),
    )
    op.create_index(
        "wiki_templates_space_name_key", "wiki_templates",
        [sa.text(f"coalesce(space_id, '{NIL_UUID}'::uuid)"), sa.text("lower(name)")],
        unique=True)

    # ── wiki_watches ─────────────────────────────────────────────
    op.create_table(
        "wiki_watches",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), nullable=False),
        sa.Column("space_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_spaces.id", ondelete="CASCADE")),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("(space_id IS NULL) <> (node_id IS NULL)",
                           name="wiki_watches_target_check"),
    )
    op.create_index(
        "wiki_watches_person_target_key", "wiki_watches",
        ["person_id", sa.text(f"coalesce(space_id, '{NIL_UUID}'::uuid)"),
         sa.text(f"coalesce(node_id, '{NIL_UUID}'::uuid)")],
        unique=True)

    # ── wiki_reviews ─────────────────────────────────────────────
    op.create_table(
        "wiki_reviews",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), nullable=False),
        # the snapshot submitted for review (kind='submitted')
        sa.Column("version_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_page_versions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("requested_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("note", sa.Text, nullable=False, server_default=""),
        sa.Column("status", sa.Text, nullable=False, server_default="pending"),
        sa.Column("decided_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("decided_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("decision_note", sa.Text, nullable=False, server_default=""),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('pending','approved','rejected','withdrawn')",
                           name="wiki_reviews_status_check"),
    )
    # one pending review per page at a time
    op.create_index("wiki_reviews_pending_node_key", "wiki_reviews", ["node_id"],
                    unique=True, postgresql_where=sa.text("status = 'pending'"))

    # ── wiki_nodes: review-cycle columns ─────────────────────────
    op.add_column("wiki_nodes", sa.Column("review_interval_months", sa.Integer))
    op.add_column("wiki_nodes", sa.Column(
        "next_review_at", sa.TIMESTAMP(timezone=True)))
    op.add_column("wiki_nodes", sa.Column(
        "last_reviewed_at", sa.TIMESTAMP(timezone=True)))
    op.add_column("wiki_nodes", sa.Column(
        "last_reviewed_by", UUID(as_uuid=True),
        sa.ForeignKey("people.id", ondelete="SET NULL")))
    # the due date (next_review_at) this node was last notified for, so the
    # reminders job doesn't re-notify every run while a review stays overdue
    op.add_column("wiki_nodes", sa.Column(
        "review_notified_for", sa.TIMESTAMP(timezone=True)))

    # ── enum widenings ───────────────────────────────────────────
    op.drop_constraint("wiki_page_versions_kind_check", "wiki_page_versions",
                       type_="check")
    op.create_check_constraint(
        "wiki_page_versions_kind_check", "wiki_page_versions", PAGE_VERSION_KIND_CHECK)

    op.drop_constraint("wiki_jobs_kind_check", "wiki_jobs", type_="check")
    op.create_check_constraint("wiki_jobs_kind_check", "wiki_jobs", JOB_KIND_CHECK)

    # ── seed the four builtin templates ──────────────────────────
    seed(op.get_bind())


def downgrade() -> None:
    # Rows only this revision's kinds allow would fail the narrower checks:
    # the worker queues a `reminders` job at start-up, and a review's
    # snapshot is a `submitted` version. The review rows go with their
    # table below; a snapshot stays in the page's history as an autosave.
    op.execute("DELETE FROM wiki_jobs WHERE kind = 'reminders'")
    op.drop_constraint("wiki_jobs_kind_check", "wiki_jobs", type_="check")
    op.create_check_constraint(
        "wiki_jobs_kind_check", "wiki_jobs",
        "kind IN ('file_preview','file_extract','purge')")

    op.execute("UPDATE wiki_page_versions SET kind = 'autosave' WHERE kind = 'submitted'")
    op.drop_constraint("wiki_page_versions_kind_check", "wiki_page_versions",
                       type_="check")
    op.create_check_constraint(
        "wiki_page_versions_kind_check", "wiki_page_versions",
        "kind IN ('autosave','published','restored','imported')")

    op.drop_column("wiki_nodes", "review_notified_for")
    op.drop_column("wiki_nodes", "last_reviewed_by")
    op.drop_column("wiki_nodes", "last_reviewed_at")
    op.drop_column("wiki_nodes", "next_review_at")
    op.drop_column("wiki_nodes", "review_interval_months")

    op.drop_index("wiki_reviews_pending_node_key", table_name="wiki_reviews")
    op.drop_table("wiki_reviews")

    op.drop_index("wiki_watches_person_target_key", table_name="wiki_watches")
    op.drop_table("wiki_watches")

    op.drop_index("wiki_templates_space_name_key", table_name="wiki_templates")
    op.drop_table("wiki_templates")

    op.drop_index("wiki_comments_node_thread_created_idx", table_name="wiki_comments")
    op.drop_table("wiki_comments")
