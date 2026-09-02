"""Client roles gain initiatives:view — the client work-history slice.

Revision ID: 0044
Revises: 0043
Create Date: 2026-09-02
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0044"
down_revision: str | None = "0043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ROLES = ("client_owner", "client_admin", "client_viewer")


def upgrade() -> None:
    conn = op.get_bind()
    for role in ROLES:
        conn.execute(sa.text(
            "INSERT INTO role_permissions (role, resource, action) "
            "VALUES (:r, 'initiatives', 'view') ON CONFLICT DO NOTHING"),
            {"r": role})


def downgrade() -> None:
    conn = op.get_bind()
    for role in ROLES:
        conn.execute(sa.text(
            "DELETE FROM role_permissions WHERE role = :r "
            "AND resource = 'initiatives' AND action = 'view'"),
            {"r": role})
