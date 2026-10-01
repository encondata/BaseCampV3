"""Deploy page: the `deploy` permission grants and trusted SSH host keys.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-01
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

FULL = ("view", "add", "change")   # Deploy has no delete action

# Frozen: the deploy grants this migration seeds (hand-copied, not imported).
DEPLOY_GRANTS: dict[str, tuple[str, ...]] = {
    "developer": FULL,
    "founder": FULL,
    "super_admin": FULL,
    "admin": ("view",),
}


def upgrade() -> None:
    for role, actions in DEPLOY_GRANTS.items():
        for action in actions:
            op.execute(
                f"INSERT INTO role_permissions (role, resource, action) "
                f"SELECT '{role}', 'deploy', '{action}' "
                f"WHERE EXISTS (SELECT 1 FROM roles WHERE name = '{role}') "
                f"ON CONFLICT DO NOTHING")
    op.execute("""
        CREATE TABLE ssh_known_hosts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          host text NOT NULL,
          port integer NOT NULL,
          key_type text NOT NULL,
          fingerprint_sha256 text NOT NULL,
          public_key text NOT NULL,
          trusted_by uuid,
          trusted_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (host, port)
        );
    """)


def downgrade() -> None:
    op.execute("DROP TABLE ssh_known_hosts")
    op.execute("DELETE FROM role_permissions WHERE resource = 'deploy'")
