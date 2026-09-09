"""Reports framework (definitions + runs) and the in-app notification inbox.

Seeds the system "Move Report" definition and the `reports` resource grants
(admin FULL; staff view+add; developer/founder/super_admin FULL).

Revision ID: 0046
Revises: 0045
Create Date: 2026-09-09
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID

revision: str = "0046"
down_revision: str | None = "0045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FULL = ("view", "add", "change", "delete")
GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL, "admin": FULL,
    "staff": ("view", "add"),
}
MOVE_REPORT_DEFAULTS = (
    '{"summary": true, "assets_by_source": true, "assets_by_destination": true, '
    '"size_weight": true, "rail_usage": true, "collisions": true, '
    '"source_racks": true, "destination_racks": true}'
)


def upgrade() -> None:
    op.create_table(
        "report_definitions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("report_type", sa.Text(), nullable=False),
        sa.Column("options", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("report_definitions_name_live_idx", "report_definitions",
                    ["name"], unique=True,
                    postgresql_where=sa.text("archived_at IS NULL"))
    op.create_table(
        "report_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("definition_id", UUID(as_uuid=True),
                  sa.ForeignKey("report_definitions.id"), nullable=False),
        sa.Column("report_type", sa.Text(), nullable=False),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id"), nullable=False),
        sa.Column("options", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("error", sa.Text()),
        sa.Column("requested_by", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=False),
        sa.Column("requested_rank", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("notify", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("storage_key", sa.Text()),
        sa.Column("attachment_id", UUID(as_uuid=True), sa.ForeignKey("attachments.id")),
        sa.Column("filename", sa.Text()),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("report_runs_status_created_idx", "report_runs", ["status", "created_at"])
    op.create_index("report_runs_initiative_idx", "report_runs", ["initiative_id"])
    op.create_index("report_runs_requester_idx", "report_runs", ["requested_by", "created_at"])
    op.create_table(
        "notifications",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("link", sa.Text()),
        sa.Column("payload", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("read_at", sa.DateTime(timezone=True)),
    )
    op.create_index("notifications_person_idx", "notifications",
                    ["person_id", "read_at", "created_at"])

    conn = op.get_bind()
    conn.execute(sa.text(
        "INSERT INTO report_definitions (name, description, report_type, options, is_system) "
        "VALUES ('Move Report', 'The full move report: summary, asset lists, "
        "size/weight, rails, collisions and rack elevations.', 'move_report', "
        f"'{MOVE_REPORT_DEFAULTS}'::jsonb, true)"))
    for role, actions in GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'reports', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM role_permissions WHERE resource = 'reports'"))
    op.drop_table("notifications")
    op.drop_table("report_runs")
    op.drop_table("report_definitions")
