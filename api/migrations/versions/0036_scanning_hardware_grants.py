"""scanning_hardware — role grants for the new Scanning Hardware portal
section (placeholder pages; no tables). One resource covers all four
device-family routes; per-type resources are deferred until a family
needs different access.

Revision ID: 0036
Revises: 0035
Create Date: 2026-08-31
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0036"
down_revision: str | None = "0035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FULL = ("view", "add", "change", "delete")
GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL,
    "admin": FULL, "staff": ("view",),
}


def upgrade() -> None:
    conn = op.get_bind()
    for role, actions in GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'scanning_hardware', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    op.get_bind().execute(sa.text(
        "DELETE FROM role_permissions WHERE resource = 'scanning_hardware'"))
