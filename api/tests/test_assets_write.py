"""Assets write paths: create/patch/archive, audit, validation, 403s."""

from sqlalchemy import select

from serversherpa.db.models import Asset, AuditLog, Client, Person, PersonRole
from tests.test_assets_api import login, make_login


async def test_create_update_archive_with_audit(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/assets", headers=hdrs, json={
        "serial_number": "SN-1", "name": "db-01", "status": "active",
        "location_detail": "Rack 4, RU 10"})
    assert resp.status_code == 201, resp.text
    asset_id = resp.json()["id"]
    assert resp.json()["status_label"] == "Active"

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "create"))
    assert row is not None and row.entity_id == asset_id

    resp = await client.patch(f"/assets/{asset_id}", headers=hdrs,
                              json={"location_detail": "Rack 5, RU 2"})
    assert resp.status_code == 200
    upd = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "update"))
    assert upd.changes["location_detail"]["to"] == "Rack 5, RU 2"

    assert (await client.post(f"/assets/{asset_id}/archive",
                              headers=hdrs)).status_code == 204
    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "archive"))
    assert row is not None and row.entity_id == asset_id
    assert (await client.post(f"/assets/{asset_id}/unarchive",
                              headers=hdrs)).status_code == 204
    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "restore"))
    assert row is not None and row.entity_id == asset_id


async def test_default_status_applied(client, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/assets", headers=hdrs, json={"name": "mystery"})
    assert resp.status_code == 201
    assert resp.json()["status"] == "unknown"


async def test_unknown_refs_rejected(client, seeded_user):
    hdrs = await login(client)
    ghost = "00000000-0000-0000-0000-000000000000"
    for field, code in (("model_id", "asset_model_not_found"),
                        ("client_id", "client_not_found"),
                        ("site_id", "site_not_found")):
        resp = await client.post("/assets", headers=hdrs,
                                 json={"name": "x", field: ghost})
        assert resp.status_code == 422, (field, resp.text)
        assert resp.json()["detail"]["code"] == code
    resp = await client.post("/assets", headers=hdrs,
                             json={"name": "x", "status": "nope"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_status"


async def test_rfid_conflict_409(client, seeded_user):
    hdrs = await login(client)
    await client.post("/assets", headers=hdrs, json={"name": "a", "rfid_tag": "T1"})
    resp = await client.post("/assets", headers=hdrs,
                             json={"name": "b", "rfid_tag": "t1"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "rfid_tag_in_use"


async def test_duplicate_serial_allowed_via_api(client, seeded_user):
    hdrs = await login(client)
    assert (await client.post("/assets", headers=hdrs,
                              json={"serial_number": "DUP"})).status_code == 201
    assert (await client.post("/assets", headers=hdrs,
                              json={"serial_number": "DUP"})).status_code == 201


async def test_noop_patch_writes_no_audit(client, db, seeded_user):
    hdrs = await login(client)
    created = (await client.post("/assets", headers=hdrs,
                                 json={"name": "same"})).json()
    asset = await db.get(Asset, created["id"])
    await db.refresh(asset)
    orig_updated_at = asset.updated_at
    resp = await client.patch(f"/assets/{created['id']}", headers=hdrs,
                              json={"name": "same"})
    assert resp.status_code == 200
    upd = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "update"))
    assert upd is None
    asset = await db.get(Asset, created["id"])
    await db.refresh(asset)
    assert asset.updated_at == orig_updated_at   # no-op PATCH must not bump


async def test_client_contact_cannot_write(client, db, seeded_user):
    """Client tiers are read-only, even with an override — the write paths
    are _require_global (same posture as sites)."""
    from serversherpa.db.models import PermissionOverride

    org = Client(name="Acme W")
    db.add(org)
    await db.flush()
    contact = Person(first_name="C", last_name="W")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_admin", client_id=org.id))
    db.add(PermissionOverride(person_id=contact.id, resource="assets",
                              action="add", allow=True))
    db.add(PermissionOverride(person_id=contact.id, resource="assets",
                              action="change", allow=True))
    await db.commit()
    hdrs = await make_login(db, client, contact, "w@acme.example.com")

    resp = await client.post("/assets", headers=hdrs, json={"name": "sneaky"})
    assert resp.status_code == 403

    mine = Asset(name="mine", client_id=org.id)
    db.add(mine)
    await db.commit()
    resp = await client.patch(f"/assets/{mine.id}", headers=hdrs,
                              json={"name": "renamed"})
    assert resp.status_code == 403
    resp = await client.post(f"/assets/{mine.id}/archive", headers=hdrs)
    assert resp.status_code == 403
    resp = await client.post(f"/assets/{mine.id}/unarchive", headers=hdrs)
    assert resp.status_code == 403
