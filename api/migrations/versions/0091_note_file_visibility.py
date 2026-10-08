"""Note and file visibility — Everyone / Internal / Admin.

Adds `visibility` to notes and attachments (see
docs/superpowers/specs/2026-10-08-note-file-visibility-design.md) and
backfills it so nobody gains or loses access: notes and non-avatar files
on initiatives, people, clients and partners were staff-only before, so
they become `internal`; everything else stays `everyone`.

Revision ID: 0091
Revises: 0090
Create Date: 2026-10-08
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0091"
down_revision: str | None = "0090"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LEVELS_CHECK = "visibility IN ('everyone', 'internal', 'admin')"
INTERNAL_HOSTS = "('initiative', 'person', 'client', 'partner')"


def backfill_visibility(conn) -> None:
    """Plain function on a raw connection so the test suite can re-run it
    (same convention as 0068's backfill_form_factor)."""
    conn.execute(sa.text(
        f"UPDATE notes SET visibility = 'internal' WHERE entity_type IN {INTERNAL_HOSTS}"))
    conn.execute(sa.text(
        f"UPDATE attachments SET visibility = 'internal' "
        f"WHERE entity_type IN {INTERNAL_HOSTS} AND kind <> 'avatar'"))


def upgrade() -> None:
    for table in ("notes", "attachments"):
        op.add_column(table, sa.Column(
            "visibility", sa.Text(), nullable=False, server_default="everyone"))
        op.create_check_constraint(f"ck_{table}_visibility", table, LEVELS_CHECK)
    backfill_visibility(op.get_bind())


def downgrade() -> None:
    for table in ("notes", "attachments"):
        op.drop_constraint(f"ck_{table}_visibility", table, type_="check")
        op.drop_column(table, "visibility")
