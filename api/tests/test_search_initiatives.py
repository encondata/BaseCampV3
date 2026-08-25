"""Global search covers initiatives (name / location / sky-command ref /
client name / site names)."""

from serversherpa.db.models import Client

from .test_assets_api import login


async def test_search_finds_initiatives(client, db, seeded_user):
    headers = await login(client)
    await client.post("/initiatives", headers=headers, json={
        "name": "Denver DC migration", "initiative_type": "project",
        "sky_command_project_id": "SKY-441"})
    for q in ("denver", "sky-441"):
        resp = await client.get(f"/search?q={q}", headers=headers)
        assert resp.status_code == 200
        hits = [r for r in resp.json()["results"]
                if r["kind"] == "initiative"]
        assert hits and hits[0]["label"] == "Denver DC migration", q


async def test_search_finds_initiatives_by_client_name(client, db, seeded_user):
    headers = await login(client)
    org = Client(name="Acme Corp")
    db.add(org)
    await db.commit()
    await client.post("/initiatives", headers=headers, json={
        "name": "Warehouse rollout", "initiative_type": "project",
        "client_id": str(org.id)})
    resp = await client.get("/search?q=acme", headers=headers)
    assert resp.status_code == 200
    hits = [r for r in resp.json()["results"] if r["kind"] == "initiative"]
    assert hits and hits[0]["label"] == "Warehouse rollout"
    assert hits[0]["sub"] == "Project"
