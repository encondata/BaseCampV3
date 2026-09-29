"""Move passwords for kiosk sign-in: an encrypted per-initiative password,
its keyed fingerprint (unique = unique across moves, and the sign-in
lookup), the move's hidden kiosk identity, and the move a kiosk session
is locked to.

Revision ID: 0083
Revises: 0082
Create Date: 2026-09-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0083"
down_revision: str | None = "0082"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("initiatives", sa.Column("kiosk_password_enc", sa.Text, nullable=True))
    op.add_column("initiatives", sa.Column("kiosk_password_fp", sa.Text, nullable=True))
    op.add_column("initiatives", sa.Column(
        "kiosk_person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=True))
    op.create_index("ux_initiatives_kiosk_password_fp", "initiatives",
                    ["kiosk_password_fp"], unique=True)
    op.add_column("auth_sessions", sa.Column(
        "initiative_id", UUID(as_uuid=True), sa.ForeignKey("initiatives.id"), nullable=True))
    # a move's hidden kiosk identity is a person with source 'kiosk_move'
    op.drop_constraint("people_source_check", "people", type_="check")
    op.create_check_constraint(
        "people_source_check", "people",
        "source IN ('manual', 'import', 'api', 'kiosk_move')")


def downgrade() -> None:
    remaining = op.get_bind().execute(
        sa.text("SELECT count(*) FROM people WHERE source = 'kiosk_move'")).scalar()
    if remaining:
        raise RuntimeError(
            "cannot downgrade 0083: kiosk_move people exist "
            "(delete the moves' kiosk identities first)")
    op.drop_constraint("people_source_check", "people", type_="check")
    op.create_check_constraint(
        "people_source_check", "people", "source IN ('manual', 'import', 'api')")
    op.drop_column("auth_sessions", "initiative_id")
    op.drop_index("ux_initiatives_kiosk_password_fp", table_name="initiatives")
    op.drop_column("initiatives", "kiosk_person_id")
    op.drop_column("initiatives", "kiosk_password_fp")
    op.drop_column("initiatives", "kiosk_password_enc")
