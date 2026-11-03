"""Notifications Phase 2, slice 5: the wiki's watches join `notification_watches`.

- Every row of `wiki_watches` (a person watching a library, a folder or a page) is copied into
  `notification_watches`: the library into `wiki_space_id`, the folder or page into
  `wiki_node_id`, with the same id and created time. Its events stay empty (a wiki watch hears
  every update and comment, as before) and the person is the one who made it. A row the shared
  table already has for that person and thing is left as it is. Keeping the ids keeps a watch
  the wiki already handed out, and the audit rows that name it, pointing at the same thing.
- `wiki_watches`, with its unique index (`wiki_watches_person_target_key`), its two lookup
  indexes (`wiki_watches_node_idx`, `wiki_watches_space_idx`) and its check
  (`wiki_watches_target_check`), is dropped. The wiki's routes and fan-out read the shared table
  from now on, and a notification group can watch a wiki thing too (the next change).

Rolling back puts `wiki_watches` back as 0075 and 0077 left it, so their own rollbacks still
find it, and copies every person's wiki watch back with its id and created time. The wiki rows
are then deleted from `notification_watches`: a group's wiki watches have no place in the old
table and go with them, and nothing but the wiki's rows is touched.

Design: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md

Revision ID: 0116
Revises: 0115
Create Date: 2026-11-03
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0116"
down_revision: str | None = "0115"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# 0075's expression index counts a missing space or node as this, so one person has one watch
# per target
NIL_UUID = "00000000-0000-0000-0000-000000000000"

# a watch on a library, a folder or a page
IS_WIKI = "(wiki_space_id IS NOT NULL OR wiki_node_id IS NOT NULL)"


def upgrade() -> None:
    op.execute(
        "INSERT INTO notification_watches "
        "(id, person_id, wiki_space_id, wiki_node_id, kinds, created_by, created_at) "
        "SELECT id, person_id, space_id, node_id, '{}'::text[], person_id, created_at "
        "FROM wiki_watches ON CONFLICT DO NOTHING")
    op.drop_index("wiki_watches_space_idx", table_name="wiki_watches")
    op.drop_index("wiki_watches_node_idx", table_name="wiki_watches")
    op.drop_index("wiki_watches_person_target_key", table_name="wiki_watches")
    op.drop_table("wiki_watches")


def downgrade() -> None:
    # as 0075 made it ...
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
    # ... and 0077's lookup indexes
    op.create_index("wiki_watches_node_idx", "wiki_watches", ["node_id"])
    op.create_index("wiki_watches_space_idx", "wiki_watches", ["space_id"])

    op.execute(
        "INSERT INTO wiki_watches (id, person_id, space_id, node_id, created_at) "
        "SELECT id, person_id, wiki_space_id, wiki_node_id, created_at "
        f"FROM notification_watches WHERE person_id IS NOT NULL AND {IS_WIKI}")
    op.execute(f"DELETE FROM notification_watches WHERE {IS_WIKI}")
