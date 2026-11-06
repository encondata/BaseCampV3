"""The learning site (learn, port 8092) as an optional app, and two columns
for later work: an environment's kiosk signing digests (plain, not secret;
rendered as SS_KIOSK_SIGNING_DIGESTS) and whether a deployment seeds starter
content (step 20).

Learn joins the apps of every environment that runs the wiki (its documents
render there), and every environment with a portal row and no learn row gets
one on the portal's host: 8092, or the first free port at or above it. An
SSH target can share its host with other SSH environments, so their ports on
that host count too (any bind address of theirs or ours being 0.0.0.0, or the
same one); a VM or droplet only avoids its own. It is named learn.<base
domain> where learn is on. The next Update writes STACK_APPS with learn and
its publish adds the DNS record, proxy host and certificate name.

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-05
"""
import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

LEARN_PORT = 8092


def _shares_host(target_id: str) -> bool:
    return target_id == "ssh" or target_id.startswith("ssh:")


def upgrade() -> None:
    op.execute("""
        ALTER TABLE environments
          DROP CONSTRAINT environments_apps_check,
          ADD CONSTRAINT environments_apps_check
            CHECK (apps <@ ARRAY['wiki', 'kiosk', 'learn', 'status', 'mailpit']::text[]),
          ALTER COLUMN apps SET DEFAULT '{wiki,kiosk,learn,status,mailpit}',
          ADD COLUMN kiosk_signing_digests text[] NOT NULL DEFAULT '{}';
        UPDATE environments
           SET apps = ARRAY(SELECT t.app
                              FROM unnest(ARRAY['wiki', 'kiosk', 'learn', 'status', 'mailpit'])
                                   WITH ORDINALITY AS t(app, i)
                             WHERE t.app = ANY (apps) OR t.app = 'learn'
                             ORDER BY t.i)
         WHERE 'wiki' = ANY (apps) AND NOT 'learn' = ANY (apps);
        ALTER TABLE environments
          ADD CONSTRAINT environments_learn_check
            CHECK (NOT 'learn' = ANY (apps) OR 'wiki' = ANY (apps));
        ALTER TABLE deployments ADD COLUMN seed_content boolean NOT NULL DEFAULT false;
    """)
    conn = op.get_bind()
    todo = conn.execute(sa.text("""
        SELECT e.id, e.target_id, e.bind_ip, e.base_domain, 'learn' = ANY (e.apps), p.host_ip
          FROM environments e
          JOIN environment_services p ON p.environment_id = e.id AND p.service = 'portal'
         WHERE NOT EXISTS (SELECT 1 FROM environment_services s
                            WHERE s.environment_id = e.id AND s.service = 'learn')
         ORDER BY e.created_at, e.name
    """)).all()
    for env_id, target_id, bind_ip, domain, learn_on, host_ip in todo:
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
        port = LEARN_PORT
        while port in used:
            port += 1
        conn.execute(sa.text("""
            INSERT INTO environment_services (environment_id, service, host_ip, port, hostname,
                                              proxied)
            VALUES (:env_id, 'learn', :host_ip, :port, :hostname, false)
        """), {"env_id": env_id, "host_ip": host_ip, "port": port,
               "hostname": f"learn.{domain}" if learn_on else None})


def downgrade() -> None:
    # Managed records for learn stay: the code below 0015 sees them as stale on
    # the next publish and removes what Sirdar created.
    op.execute("""
        DELETE FROM environment_services WHERE service = 'learn';
        ALTER TABLE deployments DROP COLUMN seed_content;
        ALTER TABLE environments
          DROP CONSTRAINT environments_learn_check,
          DROP COLUMN kiosk_signing_digests;
        UPDATE environments SET apps = array_remove(apps, 'learn');
        ALTER TABLE environments
          DROP CONSTRAINT environments_apps_check,
          ADD CONSTRAINT environments_apps_check
            CHECK (apps <@ ARRAY['wiki', 'kiosk', 'status', 'mailpit']::text[]),
          ALTER COLUMN apps SET DEFAULT '{wiki,kiosk,status,mailpit}';
    """)
