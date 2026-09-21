"""asset_models.form_factor round-trips through the catalog API and
rejects anything outside standalone / chassis / node."""

from serversherpa.db.models import Person, PersonRole, Role, RolePermission

from .test_assets_api import make_login


async def _catalog_headers(db, client):
    db.add(Role(name="catalog_editor", description="test-only", scope_anchor="global"))
    await db.flush()
    for action in ("view", "add", "change"):
        db.add(RolePermission(role="catalog_editor", resource="asset_models", action=action))
    person = Person(first_name="Cat", last_name="Editor")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="catalog_editor"))
    await db.commit()
    return await make_login(db, client, person, "catalog@test.example.com")


async def test_create_read_update_form_factor(client, db):
    headers = await _catalog_headers(db, client)
    resp = await client.post("/asset-models", headers=headers, json={
        "make": "Dell", "model": "Isilon H5600", "ru_size": 4, "form_factor": "chassis"})
    assert resp.status_code == 201, resp.text
    mid = resp.json()["id"]
    assert resp.json()["form_factor"] == "chassis"

    resp = await client.get(f"/asset-models/{mid}", headers=headers)
    assert resp.json()["form_factor"] == "chassis"
    resp = await client.get("/asset-models", headers=headers)
    assert [m["form_factor"] for m in resp.json()] == ["chassis"]

    resp = await client.patch(f"/asset-models/{mid}", headers=headers,
                              json={"form_factor": "node"})
    assert resp.status_code == 200 and resp.json()["form_factor"] == "node"
    resp = await client.patch(f"/asset-models/{mid}", headers=headers,
                              json={"form_factor": None})
    assert resp.status_code == 200 and resp.json()["form_factor"] is None


async def test_unknown_form_factor_is_422(client, db):
    headers = await _catalog_headers(db, client)
    resp = await client.post("/asset-models", headers=headers, json={
        "make": "Dell", "model": "X", "form_factor": "blade"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_form_factor"


async def test_form_factor_is_audited(client, db):
    from sqlalchemy import select

    from serversherpa.db.models import AuditLog

    headers = await _catalog_headers(db, client)
    resp = await client.post("/asset-models", headers=headers,
                             json={"make": "Dell", "model": "Y"})
    mid = resp.json()["id"]
    await client.patch(f"/asset-models/{mid}", headers=headers, json={"form_factor": "node"})
    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset_model", AuditLog.entity_id == mid,
        AuditLog.action == "update"))
    assert row is not None and row.changes == {"form_factor": {"from": None, "to": "node"}}
