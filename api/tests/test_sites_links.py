from sqlalchemy import select

from serversherpa.db.models import AuditLog, Client, Site, SiteClient
from tests.test_sites_api import login


async def test_set_clients_full_replace(client, db, seeded_user):
    hdrs = await login(client)
    ca, cb = Client(name="Acme L"), Client(name="Bcme L")
    db.add_all([ca, cb])
    await db.flush()
    site = Site(name="Shared DC")
    db.add(site)
    await db.commit()

    resp = await client.put(f"/sites/{site.id}/clients", headers=hdrs,
                            json={"client_ids": [str(ca.id), str(cb.id)]})
    assert resp.status_code == 200
    assert {c["name"] for c in resp.json()["clients"]} == {"Acme L", "Bcme L"}

    # full replace: dropping one removes exactly one junction row
    resp = await client.put(f"/sites/{site.id}/clients", headers=hdrs,
                            json={"client_ids": [str(cb.id)]})
    rows = list(await db.scalars(
        select(SiteClient.client_id).where(SiteClient.site_id == site.id)))
    assert rows == [cb.id]

    row = await db.scalar(select(AuditLog).where(AuditLog.action == "clients.set"))
    assert row is not None

    bad = await client.put(f"/sites/{site.id}/clients", headers=hdrs,
                           json={"client_ids": ["00000000-0000-0000-0000-000000000000"]})
    assert bad.status_code == 404
    assert bad.json()["detail"]["code"] == "client_not_found"
