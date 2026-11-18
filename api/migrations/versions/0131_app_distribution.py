"""The `app_distribution` permission resource ("Apps") and its grants.

developer, founder, super_admin and admin get view/add/change/delete; staff
get view. Mirrors access/defaults.py.

Revision ID: 0131
Revises: 0130
Create Date: 2026-11-17
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0131"
down_revision: str | None = "0130"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FULL = ("view", "add", "change", "delete")
FULL_ROLES = ("developer", "founder", "super_admin", "admin")


def upgrade() -> None:
    conn = op.get_bind()
    grants = [(role, action) for role in FULL_ROLES for action in FULL]
    grants.append(("staff", "view"))
    for role, action in grants:
        conn.execute(sa.text(
            "INSERT INTO role_permissions (role, resource, action) "
            "VALUES (:r, 'app_distribution', :a) ON CONFLICT DO NOTHING"),
            {"r": role, "a": action})


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'app_distribution'"))
