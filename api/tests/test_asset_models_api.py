"""Asset-models catalog API: CRUD, unit computation, aliases, 409s."""

from sqlalchemy import select

from serversherpa.db.models import AssetModel, AssetModelAlias, AuditLog
from tests.test_assets_api import login


async def test_create_computes_partner_units(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/asset-models", headers=hdrs, json={
        "make": "Dell", "model": "R740", "category": "server", "ru_size": 2,
        "weight_lbs": 50, "length_in": 32, "width_in": 17.09, "height_in": 3.42,
        "mount_type": "rails", "rail_type": "B7", "knowledge": "Slide latches stick."})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["weight_kg"] == 22.68
    assert body["length_cm"] == 81.28
    assert body["category_label"] == "Server"
    assert body["aliases"] == []

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset_model", AuditLog.action == "create"))
    assert row is not None and row.entity_id == body["id"]


async def test_metric_entry_computes_imperial(client, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/asset-models", headers=hdrs, json={
        "make": "HPE", "model": "DL380", "weight_kg": 20})
    assert resp.status_code == 201
    assert resp.json()["weight_lbs"] == 44.09


async def test_duplicate_make_model_409(client, seeded_user):
    hdrs = await login(client)
    await client.post("/asset-models", headers=hdrs,
                      json={"make": "Dell", "model": "R640"})
    resp = await client.post("/asset-models", headers=hdrs,
                             json={"make": "dell", "model": "r640"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "duplicate_model"


async def test_unknown_category_and_mount_422(client, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/asset-models", headers=hdrs, json={
        "make": "X", "model": "Y", "category": "spaceship"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_category"
    resp = await client.post("/asset-models", headers=hdrs, json={
        "make": "X", "model": "Y", "mount_type": "sticky_tape"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_mount_type"


async def test_patch_recomputes_changed_side(client, db, seeded_user):
    hdrs = await login(client)
    created = (await client.post("/asset-models", headers=hdrs, json={
        "make": "Dell", "model": "R750", "weight_lbs": 50})).json()
    resp = await client.patch(f"/asset-models/{created['id']}", headers=hdrs,
                              json={"weight_kg": 30})
    assert resp.status_code == 200
    assert resp.json()["weight_kg"] == 30
    assert resp.json()["weight_lbs"] == 66.14      # recomputed from changed side


async def test_aliases_put_replaces_and_conflicts(client, db, seeded_user):
    hdrs = await login(client)
    m1 = (await client.post("/asset-models", headers=hdrs,
                            json={"make": "Dell", "model": "R840"})).json()
    m2 = (await client.post("/asset-models", headers=hdrs,
                            json={"make": "Dell", "model": "R940"})).json()

    resp = await client.put(f"/asset-models/{m1['id']}/aliases", headers=hdrs,
                            json={"aliases": ["PowerEdge R840", "PE-R840"]})
    assert resp.status_code == 200
    assert sorted(resp.json()["aliases"]) == ["PE-R840", "PowerEdge R840"]

    # replace: old alias gone, new one in
    resp = await client.put(f"/asset-models/{m1['id']}/aliases", headers=hdrs,
                            json={"aliases": ["PE-R840"]})
    assert resp.json()["aliases"] == ["PE-R840"]

    # another model claiming it → 409 with the owner named
    resp = await client.put(f"/asset-models/{m2['id']}/aliases", headers=hdrs,
                            json={"aliases": ["pe-r840"]})     # CITEXT clash
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "alias_in_use"


async def test_categories_endpoint(client, seeded_user):
    hdrs = await login(client)
    cats = (await client.get("/asset-categories", headers=hdrs)).json()
    assert [c["key"] for c in cats][:2] == ["server", "storage"]   # sort_order
    assert all(c["color"].startswith("#") for c in cats)


async def test_noop_patch_writes_no_audit(client, db, seeded_user):
    hdrs = await login(client)
    created = (await client.post("/asset-models", headers=hdrs, json={
        "make": "Dell", "model": "R760", "knowledge": "same"})).json()
    resp = await client.patch(f"/asset-models/{created['id']}", headers=hdrs,
                              json={"knowledge": "same"})
    assert resp.status_code == 200
    upd = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset_model", AuditLog.action == "update"))
    assert upd is None


async def test_patch_null_knowledge_422(client, seeded_user):
    hdrs = await login(client)
    created = (await client.post("/asset-models", headers=hdrs, json={
        "make": "Dell", "model": "R770"})).json()
    resp = await client.patch(f"/asset-models/{created['id']}", headers=hdrs,
                              json={"knowledge": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "knowledge_required"


async def test_aliases_rejects_extra_keys(client, seeded_user):
    hdrs = await login(client)
    created = (await client.post("/asset-models", headers=hdrs, json={
        "make": "Dell", "model": "R780"})).json()
    resp = await client.put(f"/asset-models/{created['id']}/aliases", headers=hdrs,
                            json={"aliases": ["X1"], "bogus": True})
    assert resp.status_code == 422
