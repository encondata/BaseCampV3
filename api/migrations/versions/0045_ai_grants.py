"""AI assistant: admin + developer roles gain ai:use.

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

ROLES = ("admin", "developer")


def upgrade() -> None:
    op.drop_constraint("role_permissions_action_check", "role_permissions")
    op.create_check_constraint(
        "role_permissions_action_check", "role_permissions",
        "action IN ('view','add','change','delete','use')")
    conn = op.get_bind()
    for role in ROLES:
        conn.execute(sa.text(
            "INSERT INTO role_permissions (role, resource, action) "
            "VALUES (:r, 'ai', 'use') ON CONFLICT DO NOTHING"), {"r": role})


def downgrade() -> None:
    conn = op.get_bind()
    for role in ROLES:
        conn.execute(sa.text(
            "DELETE FROM role_permissions WHERE role = :r "
            "AND resource = 'ai' AND action = 'use'"), {"r": role})
    op.drop_constraint("role_permissions_action_check", "role_permissions")
    op.create_check_constraint(
        "role_permissions_action_check", "role_permissions",
        "action IN ('view','add','change','delete')")
