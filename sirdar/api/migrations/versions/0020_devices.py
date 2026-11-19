"""The devices app (devices, port 8093) as an optional app, on by default
for new environments. Existing environments keep their apps: turning Devices
on in Settings generates its secrets then.

Every environment with a portal row and no devices row gets one on the
portal's host: 8093, or the first free port at or above it. An SSH target
can share its host with other SSH environments, so their ports on that host
count too (any bind address of theirs or ours being 0.0.0.0, or the same
one); a VM or droplet only avoids its own. It has no hostname until devices
is turned on.

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-18
"""
import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None

DEVICES_PORT = 8093


def _shares_host(target_id: str) -> bool:
    return target_id == "ssh" or target_id.startswith("ssh:")


def upgrade() -> None:
    op.execute("""
        ALTER TABLE environments
          DROP CONSTRAINT environments_apps_check,
          ADD CONSTRAINT environments_apps_check
            CHECK (apps <@ ARRAY['wiki', 'kiosk', 'learn', 'status', 'devices',
                                 'mailpit']::text[]),
          ALTER COLUMN apps SET DEFAULT '{wiki,kiosk,learn,status,devices,mailpit}';
    """)
    conn = op.get_bind()
    todo = conn.execute(sa.text("""
        SELECT e.id, e.target_id, e.bind_ip, p.host_ip
          FROM environments e
          JOIN environment_services p ON p.environment_id = e.id AND p.service = 'portal'
         WHERE NOT EXISTS (SELECT 1 FROM environment_services s
                            WHERE s.environment_id = e.id AND s.service = 'devices')
         ORDER BY e.created_at, e.name
    """)).all()
    for env_id, target_id, bind_ip, host_ip in todo:
        used = set(conn.execute(sa.text("""
            SELECT s.port
              FROM environment_services s
              JOIN environments o ON o.id = s.environment_id
             WHERE s.environment_id = :env_id
                OR (CAST(:shared AS boolean) AND s.host_ip = :host_ip
                    AND (o.target_id = 'ssh' OR left(o.target_id, 4) = 'ssh:')
                    AND (o.bind_ip = '0.0.0.0' OR CAST(:bind_ip AS text) = '0.0.0.0'
                         OR o.bind_ip = :bind_ip))
        """), {"env_id": env_id, "shared": _shares_host(target_id), "host_ip": host_ip,
               "bind_ip": bind_ip}).scalars())
        port = DEVICES_PORT
        while port in used:
            port += 1
        conn.execute(sa.text("""
            INSERT INTO environment_services (environment_id, service, host_ip, port, hostname,
                                              proxied)
            VALUES (:env_id, 'devices', :host_ip, :port, NULL, false)
        """), {"env_id": env_id, "host_ip": host_ip, "port": port})


def downgrade() -> None:
    # The devices rows stay: the code at 0019 creates and keeps them too.
    op.execute("""
        UPDATE environments SET apps = array_remove(apps, 'devices');
        ALTER TABLE environments
          DROP CONSTRAINT environments_apps_check,
          ADD CONSTRAINT environments_apps_check
            CHECK (apps <@ ARRAY['wiki', 'kiosk', 'learn', 'status', 'mailpit']::text[]),
          ALTER COLUMN apps SET DEFAULT '{wiki,kiosk,learn,status,mailpit}';
    """)
