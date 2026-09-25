"""Wiki: Phase 1 schema — spaces, the node tree, pages/files and their
version history, page-embedded assets, grants, favorites, and the
background job queue. The `wiki` permission resource is granted to every
role at `view`; `add` to internal staff+; `delete` to admin+.

Design: docs/superpowers/specs/2026-09-25-wiki-design.md (§2 Data model).
Plan: docs/superpowers/plans/2026-09-25-wiki-phase1.md.

Table creation order works around three forward references (a table
whose FK target doesn't exist yet): `wiki_spaces.home_node_id` (needs
`wiki_nodes`), `wiki_pages.published_version_id` (needs
`wiki_page_versions`), and `wiki_files.current_version_id` (needs
`wiki_file_versions`). Each of those columns is created bare and given
its FK via a follow-up `op.create_foreign_key` once the target table
exists.

Comment/template/watch/review tables are later phases, not here.

Revision ID: 0074
Revises: 0073
Create Date: 2026-09-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT, JSONB, TSVECTOR, UUID

revision: str = "0074"
down_revision: str | None = "0073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NIL_UUID = "00000000-0000-0000-0000-000000000000"

# every system role holds wiki:view; add/delete are staged narrower.
# Keep in sync with serversherpa/access/defaults.py (live copy).
ALL_ROLES = (
    "developer", "founder", "super_admin", "admin", "staff",
    "client_owner", "client_admin", "client_viewer",
    "vendor_owner", "vendor_admin", "vendor_viewer",
    "worker", "external",
)
ADD_ROLES = ("developer", "founder", "super_admin", "admin", "staff")
DELETE_ROLES = ("developer", "founder", "super_admin", "admin")


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    # ── wiki_spaces ──────────────────────────────────────────────
    op.create_table(
        "wiki_spaces",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("key", CITEXT, nullable=False, unique=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("icon", sa.Text),
        sa.Column("color", sa.Text),
        # FK to wiki_nodes added below once that table exists
        sa.Column("home_node_id", UUID(as_uuid=True)),
        sa.Column("settings", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("archived_at", sa.TIMESTAMP(timezone=True)),
        sa.CheckConstraint("key ~ '^[a-z0-9][a-z0-9-]{1,39}$'",
                           name="wiki_spaces_key_check"),
    )

    # ── wiki_nodes ───────────────────────────────────────────────
    op.create_table(
        "wiki_nodes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("space_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_spaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("parent_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE")),
        sa.Column("path", ARRAY(UUID(as_uuid=True)), nullable=False,
                  server_default=sa.text("'{}'")),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("position", sa.Float, nullable=False, server_default="0"),
        sa.Column("inherit_permissions", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("owner_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("updated_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("deleted_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL")),
        # a subtree soft-deleted together shares one batch id so it
        # restores together
        sa.Column("deleted_batch", UUID(as_uuid=True)),
        sa.Column("search_tsv", TSVECTOR),
        sa.CheckConstraint("kind IN ('folder','page','file')",
                           name="wiki_nodes_kind_check"),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 200",
                           name="wiki_nodes_title_length_check"),
    )
    op.create_index("wiki_nodes_path_idx", "wiki_nodes", ["path"],
                    postgresql_using="gin")
    op.create_index("wiki_nodes_search_tsv_idx", "wiki_nodes", ["search_tsv"],
                    postgresql_using="gin")
    op.create_index("wiki_nodes_title_trgm_idx", "wiki_nodes", ["title"],
                    postgresql_using="gin",
                    postgresql_ops={"title": "gin_trgm_ops"})
    op.create_index(
        "wiki_nodes_space_parent_position_idx", "wiki_nodes",
        ["space_id", "parent_id", "position"],
        postgresql_where=sa.text("deleted_at IS NULL"))

    op.create_foreign_key(
        "wiki_spaces_home_node_fkey", "wiki_spaces", "wiki_nodes",
        ["home_node_id"], ["id"], ondelete="SET NULL")

    # ── wiki_pages ───────────────────────────────────────────────
    op.create_table(
        "wiki_pages",
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("ydoc", sa.LargeBinary),
        # none_as_null: see JSONB(none_as_null=True) note on the ORM model
        sa.Column("draft_json", JSONB),
        sa.Column("draft_text", sa.Text),
        sa.Column("draft_updated_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("draft_updated_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        # FK to wiki_page_versions added below once that table exists
        sa.Column("published_version_id", UUID(as_uuid=True)),
        sa.Column("has_unpublished_changes", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("last_autosave_version_at", sa.TIMESTAMP(timezone=True)),
    )

    # ── wiki_page_versions ───────────────────────────────────────
    op.create_table(
        "wiki_page_versions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version_no", sa.Integer, nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("content_json", JSONB),
        sa.Column("content_text", sa.Text),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("note", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("node_id", "version_no",
                            name="wiki_page_versions_node_version_key"),
        sa.CheckConstraint(
            "kind IN ('autosave','published','restored','imported')",
            name="wiki_page_versions_kind_check"),
    )

    op.create_foreign_key(
        "wiki_pages_published_version_fkey", "wiki_pages", "wiki_page_versions",
        ["published_version_id"], ["id"], ondelete="SET NULL")

    # ── wiki_files ───────────────────────────────────────────────
    op.create_table(
        "wiki_files",
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"),
                  primary_key=True),
        # FK to wiki_file_versions added below once that table exists
        sa.Column("current_version_id", UUID(as_uuid=True)),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
    )

    # ── wiki_file_versions ───────────────────────────────────────
    op.create_table(
        "wiki_file_versions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version_no", sa.Integer, nullable=False),
        sa.Column("storage_key", sa.Text, nullable=False),
        sa.Column("filename", sa.Text, nullable=False),
        sa.Column("content_type", sa.Text, nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("sha256", sa.Text),
        sa.Column("preview_kind", sa.Text, nullable=False),
        sa.Column("preview_key", sa.Text),
        sa.Column("preview_status", sa.Text, nullable=False, server_default="pending"),
        sa.Column("text_extract", sa.Text),
        sa.Column("extract_status", sa.Text, nullable=False, server_default="pending"),
        sa.Column("note", sa.Text),
        sa.Column("uploaded_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("node_id", "version_no",
                            name="wiki_file_versions_node_version_key"),
        sa.CheckConstraint("preview_kind IN ('native','pdf','none')",
                           name="wiki_file_versions_preview_kind_check"),
        sa.CheckConstraint(
            "preview_status IN ('pending','ready','failed','skipped')",
            name="wiki_file_versions_preview_status_check"),
        sa.CheckConstraint(
            "extract_status IN ('pending','ready','failed','skipped')",
            name="wiki_file_versions_extract_status_check"),
    )

    op.create_foreign_key(
        "wiki_files_current_version_fkey", "wiki_files", "wiki_file_versions",
        ["current_version_id"], ["id"], ondelete="SET NULL")

    # ── wiki_page_assets ─────────────────────────────────────────
    op.create_table(
        "wiki_page_assets",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("storage_key", sa.Text, nullable=False),
        sa.Column("filename", sa.Text, nullable=False),
        sa.Column("content_type", sa.Text, nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column("uploaded_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.TIMESTAMP(timezone=True)),
    )
    op.create_index("wiki_page_assets_node_idx", "wiki_page_assets", ["node_id"])

    # ── wiki_grants ──────────────────────────────────────────────
    op.create_table(
        "wiki_grants",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("space_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_spaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE")),
        sa.Column("principal_type", sa.Text, nullable=False),
        sa.Column("principal_id", sa.Text),
        sa.Column("level", sa.Text, nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.CheckConstraint(
            "principal_type IN ('everyone','internal','role','access_group',"
            "'person','client','partner')",
            name="wiki_grants_principal_type_check"),
        sa.CheckConstraint("level IN ('view','edit','manage')",
                           name="wiki_grants_level_check"),
    )
    op.create_index(
        "wiki_grants_space_node_principal_key", "wiki_grants",
        ["space_id", sa.text(f"coalesce(node_id, '{NIL_UUID}'::uuid)"),
         "principal_type", sa.text("coalesce(principal_id, '')")],
        unique=True)

    # ── wiki_favorites ───────────────────────────────────────────
    op.create_table(
        "wiki_favorites",
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )

    # ── wiki_jobs ────────────────────────────────────────────────
    op.create_table(
        "wiki_jobs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("node_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_nodes.id", ondelete="SET NULL")),
        sa.Column("file_version_id", UUID(as_uuid=True),
                  sa.ForeignKey("wiki_file_versions.id", ondelete="SET NULL")),
        sa.Column("payload", JSONB),
        sa.Column("status", sa.Text, nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("error", sa.Text),
        sa.Column("result", JSONB),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("started_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("progress_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("finished_at", sa.TIMESTAMP(timezone=True)),
        sa.CheckConstraint("kind IN ('file_preview','file_extract','purge')",
                           name="wiki_jobs_kind_check"),
        sa.CheckConstraint("status IN ('queued','running','done','failed')",
                           name="wiki_jobs_status_check"),
    )
    op.create_index("wiki_jobs_status_created_idx", "wiki_jobs",
                    ["status", "created_at"])

    # ── access grants ────────────────────────────────────────────
    conn = op.get_bind()
    for role in ALL_ROLES:
        conn.execute(sa.text(
            "INSERT INTO role_permissions (role, resource, action) "
            "VALUES (:r, 'wiki', 'view') ON CONFLICT DO NOTHING"), {"r": role})
    for role in ADD_ROLES:
        conn.execute(sa.text(
            "INSERT INTO role_permissions (role, resource, action) "
            "VALUES (:r, 'wiki', 'add') ON CONFLICT DO NOTHING"), {"r": role})
    for role in DELETE_ROLES:
        conn.execute(sa.text(
            "INSERT INTO role_permissions (role, resource, action) "
            "VALUES (:r, 'wiki', 'delete') ON CONFLICT DO NOTHING"), {"r": role})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM role_permissions WHERE resource = 'wiki'"))

    op.drop_table("wiki_jobs")
    op.drop_table("wiki_favorites")
    op.drop_index("wiki_grants_space_node_principal_key", table_name="wiki_grants")
    op.drop_table("wiki_grants")
    op.drop_index("wiki_page_assets_node_idx", table_name="wiki_page_assets")
    op.drop_table("wiki_page_assets")
    op.drop_constraint("wiki_files_current_version_fkey", "wiki_files",
                       type_="foreignkey")
    op.drop_table("wiki_file_versions")
    op.drop_table("wiki_files")
    op.drop_constraint("wiki_pages_published_version_fkey", "wiki_pages",
                       type_="foreignkey")
    op.drop_table("wiki_page_versions")
    op.drop_table("wiki_pages")
    op.drop_constraint("wiki_spaces_home_node_fkey", "wiki_spaces",
                       type_="foreignkey")
    op.drop_index("wiki_nodes_space_parent_position_idx", table_name="wiki_nodes")
    op.drop_index("wiki_nodes_title_trgm_idx", table_name="wiki_nodes")
    op.drop_index("wiki_nodes_search_tsv_idx", table_name="wiki_nodes")
    op.drop_index("wiki_nodes_path_idx", table_name="wiki_nodes")
    op.drop_table("wiki_nodes")
    op.drop_table("wiki_spaces")

    # extension intentionally left in place — other schema objects may
    # already depend on pg_trgm by the time this downgrades
