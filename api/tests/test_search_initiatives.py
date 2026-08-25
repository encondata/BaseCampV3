"""Global search covers initiatives (name / location / sky-command ref)."""

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
