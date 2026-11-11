"""Client groups: staff-only groups endpoints and the Owner review list."""

from serversherpa.clientgroups import service as cg
from tests.client_groups_fixtures import client_user, seed_grouped_client
from tests.test_stakeholders import _headers


async def _seeded(db):
    s = await seed_grouped_client(db)
    await cg.rematch_client(db, s.client.id)
    await db.commit()
    return s


async def test_crud_roundtrip(client, seeded_user, db):
    s = await _seeded(db)
    h = await _headers(client)
    base = f"/clients/{s.client.id}/groups"
    r = await client.post(base, headers=h, json={"name": "  Network  "})
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    assert r.json()["name"] == "Network"
    assert r.json()["aliases"] == [] and r.json()["asset_count"] == 0
    r = await client.post(base, headers=h, json={"name": "network"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "group_name_taken"
    r = await client.patch(f"{base}/{gid}", headers=h,
                           json={"name": "Networks", "aliases": ["Net"]})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Networks"
    assert "Net" in r.json()["aliases"] and "Network" in r.json()["aliases"]
    names = {g["name"] for g in (await client.get(base, headers=h)).json()}
    assert names == {"Platform", "Storage", "Networks"}
    assert (await client.delete(f"{base}/{gid}", headers=h)).status_code == 204
    names = {g["name"] for g in (await client.get(base, headers=h)).json()}
    assert names == {"Platform", "Storage"}
    assert (await client.delete(f"{base}/{gid}", headers=h)).status_code == 404


async def test_delete_refused_while_chips_held(client, seeded_user, db):
    s = await _seeded(db)
    h = await _headers(client)
    await client_user(db, client, s.client.id, "client_individual",
                      group_ids=[s.groups["Platform"].id])
    r = await client.delete(f"/clients/{s.client.id}/groups/{s.groups['Platform'].id}",
                            headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "group_in_use"


async def test_client_owner_gets_403(client, seeded_user, db):
    s = await _seeded(db)
    h = await client_user(db, client, s.client.id, "client_owner")
    base = f"/clients/{s.client.id}/groups"
    for r in (await client.get(base, headers=h),
              await client.post(base, headers=h, json={"name": "X"}),
              await client.get(f"{base}/review", headers=h)):
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["code"] == "forbidden"


async def test_missing_client_404(client, seeded_user, db):
    h = await _headers(client)
    r = await client.get("/clients/00000000-0000-0000-0000-000000000001/groups", headers=h)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "org_not_found"


async def test_review_list_and_match(client, seeded_user, db):
    s = await _seeded(db)
    h = await _headers(client)
    base = f"/clients/{s.client.id}/groups"
    r = await client.get(f"{base}/review", headers=h)
    assert r.status_code == 200
    assert [v["value"] for v in r.json()] == ["Platfrom"]
    assert r.json()[0]["asset_count"] == 1 and r.json()[0]["dismissed"] is False
    r = await client.post(f"{base}/review/dismiss", headers=h,
                          json={"value": "Platfrom", "dismissed": True})
    assert r.status_code == 204
    assert (await client.get(f"{base}/review", headers=h)).json() == []
    r = await client.get(f"{base}/review?include_dismissed=true", headers=h)
    assert r.json()[0]["dismissed"] is True
    r = await client.post(f"{base}/review/match", headers=h,
                          json={"value": "Platfrom", "group_id": str(s.groups["Platform"].id)})
    assert r.status_code == 204, r.text
    assert (await client.get(f"{base}/review?include_dismissed=true", headers=h)).json() == []
    plat = next(g for g in (await client.get(base, headers=h)).json()
                if g["name"] == "Platform")
    assert plat["asset_count"] == 2 and "Platfrom" in plat["aliases"]
    r = await client.post(f"{base}/review/match", headers=h,
                          json={"value": "x", "group_id": "00000000-0000-0000-0000-000000000001"})
    assert r.status_code == 404 and r.json()["detail"]["code"] == "group_not_found"


async def test_merge_dry_run_shape(client, seeded_user, db):
    s = await _seeded(db)
    h = await _headers(client)
    base = f"/clients/{s.client.id}/groups"
    tgt, src = s.groups["Platform"].id, s.groups["Storage"].id
    r = await client.post(f"{base}/{tgt}/merge", headers=h,
                          json={"source_id": str(src), "dry_run": True})
    assert r.status_code == 200, r.text
    assert r.json() == {"aliases_added": ["Storage"], "rows_moved": 1,
                        "people_moved": 0, "conflicts": []}
    assert len((await client.get(base, headers=h)).json()) == 2
    r = await client.post(f"{base}/{tgt}/merge", headers=h,
                          json={"source_id": str(src), "dry_run": False})
    assert r.status_code == 200
    groups = (await client.get(base, headers=h)).json()
    assert [g["name"] for g in groups] == ["Platform"]
    assert groups[0]["asset_count"] == 2
    r = await client.post(f"{base}/{tgt}/merge", headers=h,
                          json={"source_id": str(tgt), "dry_run": True})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "same_group"


async def test_counts(client, seeded_user, db):
    s = await _seeded(db)
    h = await _headers(client)
    plat = s.groups["Platform"].id
    await client_user(db, client, s.client.id, "client_individual", group_ids=[plat])
    await client_user(db, client, s.client.id, "client_viewer", group_ids=[plat],
                      email="cg-two@test.example.com")
    rows = (await client.get(f"/clients/{s.client.id}/groups", headers=h)).json()
    by = {g["name"]: g for g in rows}
    assert by["Platform"]["asset_count"] == 1 and by["Platform"]["people_count"] == 2
    assert by["Storage"]["asset_count"] == 1 and by["Storage"]["people_count"] == 0
