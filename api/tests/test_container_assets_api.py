"""Container membership — add/list/remove, the all-or-nothing 409."""

from serversherpa.db.models import Asset

from .test_assets_api import login


async def _mk_container(client, hdrs, name):
    resp = await client.post("/containers", headers=hdrs, json={"name": name})
    assert resp.status_code == 201
    return resp.json()["id"]


async def test_add_list_remove(client, db, seeded_user):
    hdrs = await login(client)
    cid = await _mk_container(client, hdrs, "C1")
    a1, a2 = Asset(serial_number="SN-1"), Asset(serial_number="SN-2")
    db.add_all([a1, a2])
    await db.commit()

    resp = await client.post(f"/containers/{cid}/assets", headers=hdrs,
                             json={"asset_ids": [str(a1.id), str(a2.id)]})
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert {r["serial_number"] for r in rows} == {"SN-1", "SN-2"}
    assert all(r["added_by_name"] for r in rows)

    resp = await client.get(f"/containers/{cid}", headers=hdrs)
    assert resp.json()["asset_count"] == 2

    resp = await client.delete(f"/containers/{cid}/assets/{a1.id}",
                               headers=hdrs)
    assert resp.status_code == 204
    resp = await client.get(f"/containers/{cid}/assets", headers=hdrs)
    assert [r["serial_number"] for r in resp.json()] == ["SN-2"]


async def test_conflict_is_all_or_nothing(client, db, seeded_user):
    hdrs = await login(client)
    c1 = await _mk_container(client, hdrs, "Taken")
    c2 = await _mk_container(client, hdrs, "Target")
    a1, a2 = Asset(serial_number="F-1"), Asset(serial_number="F-2")
    db.add_all([a1, a2])
    await db.commit()
    await client.post(f"/containers/{c1}/assets", headers=hdrs,
                      json={"asset_ids": [str(a1.id)]})

    resp = await client.post(f"/containers/{c2}/assets", headers=hdrs,
                             json={"asset_ids": [str(a1.id), str(a2.id)]})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "assets_in_containers"
    assert detail["conflicts"] == [{
        "asset_id": str(a1.id), "container_id": c1, "container_name": "Taken",
    }]
    # a2 must NOT have been added
    resp = await client.get(f"/containers/{c2}/assets", headers=hdrs)
    assert resp.json() == []


async def test_add_unknown_asset_422(client, db, seeded_user):
    hdrs = await login(client)
    cid = await _mk_container(client, hdrs, "C")
    resp = await client.post(
        f"/containers/{cid}/assets", headers=hdrs,
        json={"asset_ids": ["00000000-0000-0000-0000-000000000000"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "asset_not_found"
