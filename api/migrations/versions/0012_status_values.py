"""status_values — one discriminated table for every entity's status
vocabulary. Folds in site_statuses and replaces worker_profiles' status
CHECK constraint.

Revision ID: 0012
Revises: 0011
Create Date: 2026-07-15
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

WORKER_STATUSES = """
    INSERT INTO status_values
      (record_type, key, label, description, color, sort_order)
    VALUES
      ('worker','active','Active','Available for dispatch.','c-green',1),
      ('worker','standby','Standby','Temporarily unavailable.','c-amber',2),
      ('worker','blacklist','Blacklist','Do not dispatch; reason required.','c-red',3)
"""


def upgrade() -> None:
    op.create_table(
        "status_values",
        sa.Column("record_type", sa.Text, primary_key=True),
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("color", sa.Text, nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )

    # carry the four site statuses over verbatim
    op.execute("""
        INSERT INTO status_values
          (record_type, key, label, description, color, sort_order)
        SELECT 'site', key, label, description, color, sort_order
        FROM site_statuses
    """)
    op.execute(WORKER_STATUSES)

    # a constant column Postgres computes, so it cannot drift — gives the
    # composite FK something to point at
    op.execute("""
        ALTER TABLE sites ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('site') STORED
    """)
    op.execute("""
        ALTER TABLE worker_profiles ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('worker') STORED
    """)

    op.drop_constraint("sites_status_fkey", "sites", type_="foreignkey")
    op.create_foreign_key(
        "sites_status_fkey", "sites", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])
    op.create_foreign_key(
        "worker_profiles_status_fkey", "worker_profiles", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])

    # superseded by the FK above; blacklist_note_check is deliberately kept
    op.drop_constraint("worker_profiles_status_check", "worker_profiles",
                       type_="check")
    op.drop_table("site_statuses")


def downgrade() -> None:
    # This is a lossy downgrade — 0011's site_statuses has no room for what
    # 0012 introduced, so some things do not come back:
    #   - Only record_type='site' rows round-trip into site_statuses below.
    #     Anything created since 0012 under a different record_type — a
    #     custom worker status, or a whole new record_type — is discarded
    #     silently. If it is unused it just vanishes; if a worker_profiles
    #     row still holds a custom status, the create_check_constraint call
    #     near the bottom validates existing rows and HARD-FAILS the
    #     downgrade instead. That abort is intentional and safe (env.py
    #     runs the migration in one transaction; Postgres DDL is
    #     transactional, so the whole downgrade rolls back cleanly) — it is
    #     just not spelled out anywhere else, hence this comment.
    #   - is_active has no counterpart column in site_statuses, so it is
    #     dropped along with the rest of the row. A site status that was
    #     deactivated post-0012 comes back ACTIVE after this downgrade.
    # None of this is fixable within site_statuses' 0011 shape without
    # changing that table's DDL, which is out of scope here.
    op.create_table(
        "site_statuses",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("color", sa.Text, nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.execute("""
        INSERT INTO site_statuses (key, label, description, color, sort_order)
        SELECT key, label, description, color, sort_order
        FROM status_values WHERE record_type = 'site'
    """)

    op.drop_constraint("worker_profiles_status_fkey", "worker_profiles",
                       type_="foreignkey")
    op.drop_constraint("sites_status_fkey", "sites", type_="foreignkey")
    op.drop_column("worker_profiles", "status_record_type")
    op.drop_column("sites", "status_record_type")

    op.create_foreign_key(
        "sites_status_fkey", "sites", "site_statuses", ["status"], ["key"])
    op.create_check_constraint(
        "worker_profiles_status_check", "worker_profiles",
        "status IN ('active', 'standby', 'blacklist')")
    op.drop_table("status_values")
