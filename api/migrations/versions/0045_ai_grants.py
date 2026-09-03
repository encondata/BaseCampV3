"""AI assistant: admin, developer, founder, and super_admin roles gain
ai:view.

Revision ID: 0045
Revises: 0044
Create Date: 2026-09-03
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0045"
down_revision: str | None = "0044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ROLES = ("admin", "developer", "founder", "super_admin")


def upgrade() -> None:
    conn = op.get_bind()
    for role in ROLES:
        conn.execute(sa.text(
            "INSERT INTO role_permissions (role, resource, action) "
            "VALUES (:r, 'ai', 'view') ON CONFLICT DO NOTHING"), {"r": role})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'ai' AND action = 'view'"))
