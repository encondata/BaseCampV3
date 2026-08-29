"""time_entries — punch-clock rows for the time-tracking suite (punch
clock + timesheet approvals). One row per clock-in/clock-out span;
`status` walks open -> pending -> approved/rejected. The partial unique
index enforces at most one open (un-clocked-out) entry per person at a
time. The API router and portal UI are deferred; this migration is
storage + grants only.

Revision ID: 0028
Revises: 0027
Create Date: 2026-08-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0028"
down_revision: str | None = "0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TIME_ENTRY_SEEDS = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('time_entry','open','On the clock','','#258bcd',1),
      ('time_entry','pending','Pending review','','#a36207',2),
      ('time_entry','approved','Approved','','#178a4c',3),
      ('time_entry','rejected','Rejected','','#c03540',4)
"""

FULL = ("view", "add", "change", "delete")
TIME_GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": ("view",),
}


def upgrade() -> None:
    op.execute(TIME_ENTRY_SEEDS)

    op.create_table(
        "time_entries",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True),
                  sa.ForeignKey("people.id"), nullable=False),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id")),
        sa.Column("site_id", UUID(as_uuid=True), sa.ForeignKey("sites.id")),
        sa.Column("clock_in_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("clock_out_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("break_minutes", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("status", sa.Text, nullable=False, server_default="open"),
        sa.Column("source", sa.Text, nullable=False, server_default="punch"),
        sa.Column("notes", sa.Text, nullable=False, server_default=""),
        sa.Column("adjusted", sa.Boolean, nullable=False,
                  server_default=sa.false()),
        sa.Column("adjust_reason", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("approved_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("approved_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("reject_reason", sa.Text),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.execute("""
        ALTER TABLE time_entries ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('time_entry') STORED
    """)
    op.create_foreign_key(
        "time_entries_status_fkey", "time_entries", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])

    op.create_index("time_entries_person_clock_in_idx", "time_entries",
                    ["person_id", sa.text("clock_in_at DESC")])
    op.create_index("time_entries_initiative_idx", "time_entries",
                    ["initiative_id"])
    op.create_index("time_entries_status_idx", "time_entries", ["status"])
    op.create_index(
        "one_open_entry_per_person", "time_entries", ["person_id"],
        unique=True, postgresql_where=sa.text("clock_out_at IS NULL"))

    conn = op.get_bind()
    for role, actions in TIME_GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'time', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'time'"))
    op.drop_table("time_entries")
    conn.execute(sa.text(
        "DELETE FROM status_values WHERE record_type = 'time_entry'"))
