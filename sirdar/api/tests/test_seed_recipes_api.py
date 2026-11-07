"""Seed Data recipes API (Task 5)."""

import uuid

from sqlalchemy import select, text

from sirdar_api.db.models import AuditLog, Snapshot

from .api_helpers import auth_headers

BASE = "/api/seed/recipes"


async def _audits(db, action):
    return [r.changes for r in await db.scalars(
        select(AuditLog).where(AuditLog.action == action).order_by(AuditLog.id))]


async def test_crud_roundtrip(client, db):
    h = await auth_headers(client, db)
    assert (await client.get(BASE, headers=h)).json() == []
    resp = await client.post(BASE, json={"name": "Demo", "notes": "n"}, headers=h)
    assert resp.status_code == 201
    rid = resp.json()["id"]
    assert resp.json()["tables"] == {} and resp.json()["files"] == {}
    body = {"tables": {"sites": {"mode": "rows", "pks": [{"id": "1"}, {"id": "2"}, {"id": "1"}]},
                       "racks": {"mode": "all"},
                       "memberships": {"mode": "rows", "pks": [{"team": "7", "person": "1"}]}},
            "files": {"logos/n.png": True, "x.pdf": False}, "notes": "new"}
    resp = await client.put(f"{BASE}/{rid}", json=body, headers=h)
    assert resp.status_code == 200, resp.text
    got = (await client.get(f"{BASE}/{rid}", headers=h)).json()
    assert got["name"] == "Demo" and got["notes"] == "new"
    assert got["tables"]["racks"] == {"mode": "all", "pks": []}
    assert got["tables"]["sites"] == {"mode": "rows", "pks": [{"id": "1"}, {"id": "2"}]}
    assert got["tables"]["memberships"]["pks"] == [{"person": "1", "team": "7"}]
    assert got["files"] == {"logos/n.png": True, "x.pdf": False}
    (row,) = (await client.get(BASE, headers=h)).json()
    assert (row["tables"], row["rows"], row["files"]) == (3, 3, 2)
    # replace again: old content goes
    resp = await client.put(f"{BASE}/{rid}", json={"tables": {"racks": {"mode": "all"}}}, headers=h)
    got = resp.json()
    assert list(got["tables"]) == ["racks"] and got["files"] == {}
    assert (await client.delete(f"{BASE}/{rid}", headers=h)).status_code == 204
    assert (await client.get(f"{BASE}/{rid}", headers=h)).status_code == 404
    assert (await client.get(BASE, headers=h)).json() == []


async def test_validation(client, db):
    h = await auth_headers(client, db)
    rid = (await client.post(BASE, json={"name": "V"}, headers=h)).json()["id"]
    for tables in ({"t": {"mode": "some"}},
                   {"t": {"mode": "rows", "pks": [{"id": {"a": 1}}]}},
                   {"t": {"mode": "rows", "pks": [{"id": 1}]}},
                   {"t": {"mode": "rows", "pks": ["1"]}}):
        resp = await client.put(f"{BASE}/{rid}", json={"tables": tables}, headers=h)
        assert resp.status_code == 422, tables
    assert (await client.post(BASE, json={"name": "  "}, headers=h)).status_code == 422


async def test_no_row_cap(client, db):
    h = await auth_headers(client, db)
    rid = (await client.post(BASE, json={"name": "Big"}, headers=h)).json()["id"]
    pks = [{"id": str(i)} for i in range(12000)]
    resp = await client.put(f"{BASE}/{rid}", json={"tables": {"t": {"mode": "rows", "pks": pks}}},
                            headers=h)
    assert resp.status_code == 200
    assert len(resp.json()["tables"]["t"]["pks"]) == 12000


async def test_name_taken(client, db):
    h = await auth_headers(client, db)
    await client.post(BASE, json={"name": "A"}, headers=h)
    resp = await client.post(BASE, json={"name": "A"}, headers=h)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "recipe_name_taken"
    rid = (await client.post(BASE, json={"name": "B"}, headers=h)).json()["id"]
    resp = await client.put(f"{BASE}/{rid}", json={"name": "A"}, headers=h)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "recipe_name_taken"
    resp = await client.put(f"{BASE}/{rid}", json={"name": "B2"}, headers=h)
    assert resp.json()["name"] == "B2"


async def test_not_found(client, db):
    h = await auth_headers(client, db)
    missing = f"{BASE}/{uuid.uuid4()}"
    assert (await client.get(missing, headers=h)).status_code == 404
    assert (await client.put(missing, json={}, headers=h)).status_code == 404


async def test_audit_counts_only(client, db):
    h = await auth_headers(client, db)
    rid = (await client.post(BASE, json={"name": "Aud"}, headers=h)).json()["id"]
    await client.put(f"{BASE}/{rid}", headers=h, json={
        "tables": {"sites": {"mode": "rows", "pks": [{"id": "SECRET-1"}, {"id": "SECRET-2"}]}},
        "files": {"secret/key.png": True}})
    await client.delete(f"{BASE}/{rid}", headers=h)
    assert await _audits(db, "seed.recipe_create") == [{}]
    assert await _audits(db, "seed.recipe_change") == [{"tables": 1, "rows": 2, "files": 1}]
    assert await _audits(db, "seed.recipe_delete") == [{"tables": 1, "rows": 2, "files": 1}]
    dump = str([r.changes for r in await db.scalars(select(AuditLog))])
    assert "SECRET" not in dump


async def test_delete_keeps_snapshots(client, db, tmp_path):
    h = await auth_headers(client, db)
    rid = (await client.post(BASE, json={"name": "S"}, headers=h)).json()["id"]
    snap_id = uuid.uuid4()
    await db.execute(text(
        "INSERT INTO snapshots (id, name, origin, source, status, recipe_id) "
        "VALUES (:i, 'snap', 'recipe', 'uat', 'failed', :r)"),
        {"i": snap_id, "r": uuid.UUID(rid)})
    await db.commit()
    assert (await client.delete(f"{BASE}/{rid}", headers=h)).status_code == 204
    snap = await db.get(Snapshot, snap_id, populate_existing=True)
    assert snap is not None and snap.recipe_id is None


async def test_permissions_per_action(client, db):
    ro = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    dev = await auth_headers(client, db)
    rid = (await client.post(BASE, json={"name": "P"}, headers=dev)).json()["id"]
    # admin has view only
    assert (await client.get(BASE, headers=ro)).status_code == 200
    assert (await client.get(f"{BASE}/{rid}", headers=ro)).status_code == 200
    assert (await client.post(BASE, json={"name": "Q"}, headers=ro)).status_code == 403
    assert (await client.put(f"{BASE}/{rid}", json={}, headers=ro)).status_code == 403
    assert (await client.delete(f"{BASE}/{rid}", headers=ro)).status_code == 403
    # delete needs change, which the developer has
    assert (await client.delete(f"{BASE}/{rid}", headers=dev)).status_code == 204
    # no token
    assert (await client.get(BASE)).status_code == 401
    # no view at all
    await db.execute(text("DELETE FROM role_permissions WHERE role = 'admin' "
                          "AND resource = 'seed_data'"))
    await db.commit()
    assert (await client.get(BASE, headers=ro)).status_code == 403


async def test_works_without_scratch(client, db):
    h = await auth_headers(client, db)
    assert (await client.get(BASE, headers=h)).status_code == 200


async def test_concurrent_puts_last_write_wins(client, db):
    import asyncio
    h = await auth_headers(client, db)
    rid = (await client.post(BASE, json={"name": "C"}, headers=h)).json()["id"]
    bodies = [{"tables": {f"t{i}": {"mode": "rows", "pks": [{"id": str(n)} for n in range(500)]}}}
              for i in range(2)]
    resps = await asyncio.gather(*(client.put(f"{BASE}/{rid}", json=b, headers=h)
                                   for b in bodies))
    assert [r.status_code for r in resps] == [200, 200]
    got = (await client.get(f"{BASE}/{rid}", headers=h)).json()
    assert len(got["tables"]) == 1 and len(next(iter(got["tables"].values()))["pks"]) == 500


async def test_rename_collision_at_flush_is_409(client, db, monkeypatch):
    from sirdar_api.api.routes import seed as seed_routes

    async def _skip(*_a, **_k):
        return None                                  # as if the competing commit came after the check

    h = await auth_headers(client, db)
    await client.post(BASE, json={"name": "Taken"}, headers=h)
    rid = (await client.post(BASE, json={"name": "Mine"}, headers=h)).json()["id"]
    monkeypatch.setattr(seed_routes, "_name_free", _skip)
    resp = await client.put(f"{BASE}/{rid}", json={"name": "Taken"}, headers=h)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "recipe_name_taken"
    assert (await client.get(f"{BASE}/{rid}", headers=h)).json()["name"] == "Mine"
