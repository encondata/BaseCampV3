"""The bare environment name (deploy/home.py): every environment that
isn't production gets a home row in environment_services (hostname = its
base domain, host and port the portal's), so its next publish adds the A
record, the proxy host and the redirect to its portal. No schema change:
managed_records keys on (environment_id, service, kind) already.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-08
"""
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO environment_services (environment_id, service, host_ip, port, hostname,
                                          proxied)
        SELECT e.id, 'home', p.host_ip, p.port, e.base_domain, false
          FROM environments e
          JOIN environment_services p ON p.environment_id = e.id AND p.service = 'portal'
         WHERE e.type <> 'production'
        ON CONFLICT (environment_id, service) DO NOTHING;
    """)


def downgrade() -> None:
    # Managed records for home stay: the code below 0014 sees them as stale
    # on the next publish and removes what Sirdar created.
    op.execute("DELETE FROM environment_services WHERE service = 'home';")
