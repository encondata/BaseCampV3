from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, Client, Person, PersonRole, Site
from tests.test_sites_api import login, make_login


async def test_create_update_archive_with_audit(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/sites", headers=hdrs, json={
        "name": "New DC", "site_type": "datacenter", "city": "Reno",
        "latitude": 39.5296, "longitude": -119.8138})
    assert resp.status_code == 201, resp.text
    site_id = resp.json()["id"]
    assert resp.json()["status"] == "active"          # server default
    assert resp.json()["latitude"] == 39.5296

    row = await db.scalar(select(AuditLog).where(AuditLog.action == "create",
                                                 AuditLog.entity_type == "site"))
    assert row is not None and row.entity_id == site_id

    resp = await client.patch(f"/sites/{site_id}", headers=hdrs,
                              json={"dc_provider": "Switch", "status": "planned"})
    assert resp.status_code == 200
    assert resp.json()["status_label"] == "Planned"
    upd = await db.scalar(select(AuditLog).where(AuditLog.action == "update",
                                                 AuditLog.entity_type == "site"))
    assert upd.changes["dc_provider"]["to"] == "Switch"

    assert (await client.post(f"/sites/{site_id}/archive",
                              headers=hdrs)).status_code == 204
    site = await db.get(Site, site_id)
    await db.refresh(site)
    assert site.archived_at is not None
    assert (await client.post(f"/sites/{site_id}/unarchive",
                              headers=hdrs)).status_code == 204


async def test_coordinate_validation(client, seeded_user):
    hdrs = await login(client)
    bad = await client.post("/sites", headers=hdrs,
                            json={"name": "Bad", "latitude": 95.0, "longitude": 0.0})
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "invalid_coordinates"
    half = await client.post("/sites", headers=hdrs,
                             json={"name": "Half", "latitude": 40.0})
    assert half.status_code == 422
    assert half.json()["detail"]["code"] == "invalid_coordinates"


async def test_unknown_lookup_rejected(client, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/sites", headers=hdrs,
                             json={"name": "X", "site_type": "spaceport"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_site_type"
    resp = await client.post("/sites", headers=hdrs,
                             json={"name": "Y", "status": "haunted"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_status"


async def test_patch_rejects_survey_data(client, seeded_user):
    """Survey has its own endpoint so registry validation can't be bypassed."""
    hdrs = await login(client)
    site_id = (await client.post("/sites", headers=hdrs,
                                 json={"name": "S"})).json()["id"]
    resp = await client.patch(f"/sites/{site_id}", headers=hdrs,
                              json={"survey_data": {"contact_name": "X"}})
    assert resp.status_code == 422


async def test_update_rejects_null_on_non_nullable_fields(client, db, seeded_user):
    """`{"country": null}` used to blind-setattr None onto a NOT NULL column
    and 500 with an IntegrityError. Must 422 with a `{field}_required` code
    instead — mirrors the existing name_required guard."""
    hdrs = await login(client)
    site_id = (await client.post("/sites", headers=hdrs,
                                 json={"name": "Null Guard"})).json()["id"]

    resp = await client.patch(f"/sites/{site_id}", headers=hdrs,
                              json={"country": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "country_required"

    resp = await client.patch(f"/sites/{site_id}", headers=hdrs,
                              json={"status": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "status_required"

    resp = await client.patch(f"/sites/{site_id}", headers=hdrs,
                              json={"name": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "name_required"

    # a valid PATCH still works
    resp = await client.patch(f"/sites/{site_id}", headers=hdrs,
                              json={"country": "CA"})
    assert resp.status_code == 200
    assert resp.json()["country"] == "CA"


async def test_noop_patch_does_not_bump_updated_at_or_audit(client, db, seeded_user):
    hdrs = await login(client)
    site_id = (await client.post("/sites", headers=hdrs,
                                 json={"name": "No-op Site"})).json()["id"]
    site = await db.get(Site, site_id)
    await db.refresh(site)
    before_updated_at = site.updated_at

    audit_count_before = len((await db.scalars(
        select(AuditLog).where(AuditLog.entity_id == site_id))).all())

    resp = await client.patch(f"/sites/{site_id}", headers=hdrs, json={})
    assert resp.status_code == 200

    await db.refresh(site)
    assert site.updated_at == before_updated_at
    audit_count_after = len((await db.scalars(
        select(AuditLog).where(AuditLog.entity_id == site_id))).all())
    assert audit_count_after == audit_count_before


async def test_patch_coordinates_on_existing_site_audits_cleanly(client, db, seeded_user):
    """Review finding: a Site loaded from the DB returns Decimal for
    latitude/longitude (Numeric(9,6)). `_jsonable` didn't handle Decimal, so
    snapshot()/diff() on a PATCH that touches coordinates on an EXISTING site
    (not the just-created one, which still holds Python floats) would emit a
    Decimal into audit_log.changes and the engine's default json.dumps would
    TypeError mid-transaction -> 500 with a poisoned transaction."""
    hdrs = await login(client)
    site_id = (await client.post("/sites", headers=hdrs, json={
        "name": "Coord Site", "latitude": 39.5296, "longitude": -119.8138,
    })).json()["id"]

    resp = await client.patch(f"/sites/{site_id}", headers=hdrs, json={
        "latitude": 40.7128, "longitude": -74.0060,
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["latitude"] == 40.7128
    assert resp.json()["longitude"] == -74.0060

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_id == site_id, AuditLog.action == "update"))
    assert row is not None
    assert row.changes["latitude"]["to"] == 40.7128


async def test_non_global_actor_cannot_create(client, db, seeded_user):
    """A client contact with a sites:add override still may not create sites."""
    from serversherpa.db.models import PermissionOverride
    acme = Client(name="Acme NG")
    db.add(acme)
    await db.flush()
    contact = Person(first_name="C", last_name="NG")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_admin", client_id=acme.id))
    db.add(PermissionOverride(person_id=contact.id, resource="sites",
                              action="add", allow=True))
    await db.commit()
    hdrs = await make_login(db, client, contact, "ngsite@acme.example.com")
    resp = await client.post("/sites", headers=hdrs, json={"name": "Sneaky"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"
