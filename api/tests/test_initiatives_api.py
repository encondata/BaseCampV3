"""Initiatives CRUD — roundtrip, validation codes, type-change gate,
archive, permission gates."""

import uuid

from serversherpa.db.models import Person, PersonRole, Site

from .test_assets_api import login, make_login


async def _admin_login(db, client):
    admin = Person(first_name="Bob", last_name="Boss")
    db.add(admin)
    await db.flush()
    db.add(PersonRole(person_id=admin.id, role="admin"))
    await db.commit()
    return await make_login(db, client, admin, "bob@test.example.com")


async def test_crud_roundtrip(client, db, seeded_user):
    headers = await login(client)
    resp = await client.post("/initiatives", headers=headers, json={
        "name": "Denver DC migration", "initiative_type": "project",
        "sub_type": "migration", "description": "Phase 1"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "planned"
    assert body["status_label"] == "Planned"
    assert body["type_label"] == "Project"
    assert body["sub_type_label"] == "Migration"
    iid = body["id"]

    resp = await client.get("/initiatives", headers=headers)
    assert [i["id"] for i in resp.json()] == [iid]

    resp = await client.patch(f"/initiatives/{iid}", headers=headers,
                              json={"status": "in_progress",
                                    "location": "Denver, CO"})
    assert resp.status_code == 200
    assert resp.json()["status_label"] == "In progress"
    assert resp.json()["location"] == "Denver, CO"

    resp = await client.get(f"/initiatives/{iid}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["people"] == []


async def test_create_move_with_move_block(client, db, seeded_user):
    headers = await login(client)
    a = Site(name="DC-East")
    b = Site(name="DC-West")
    db.add_all([a, b])
    await db.commit()
    resp = await client.post("/initiatives", headers=headers, json={
        "name": "East to West", "initiative_type": "move",
        "origin_site_id": str(a.id), "destination_site_id": str(b.id),
        "shipping_types": ["truck", "rail"], "priority_devices": True})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["origin_site_name"] == "DC-East"
    assert body["destination_site_name"] == "DC-West"
    assert body["shipping_types"] == ["truck", "rail"]


async def test_validation_codes(client, db, seeded_user):
    headers = await login(client)
    cases = [
        ({"name": "", "initiative_type": "project"}, "name_required"),
        ({"name": "X", "initiative_type": "bogus"},
         "unknown_initiative_type"),
        ({"name": "X", "initiative_type": "project", "status": "bogus"},
         "unknown_status"),
        ({"name": "X", "initiative_type": "project", "sub_type": "bogus"},
         "unknown_sub_type"),
        ({"name": "X", "initiative_type": "project",
          "client_id": str(uuid.uuid4())}, "client_not_found"),
        ({"name": "X", "initiative_type": "project",
          "site_id": str(uuid.uuid4())}, "site_not_found"),
        ({"name": "X", "initiative_type": "move",
          "shipping_partner_id": str(uuid.uuid4())}, "partner_not_found"),
        ({"name": "X", "initiative_type": "move",
          "shipping_types": ["hovercraft"]}, "unknown_shipping_type"),
    ]
    for payload, code in cases:
        resp = await client.post("/initiatives", headers=headers, json=payload)
        assert resp.status_code == 422, (payload, resp.text)
        assert resp.json()["detail"]["code"] == code


async def test_type_change_admin_only(client, db, seeded_user):
    staff = await login(client)
    site = Site(name="DC-East")
    db.add(site)
    await db.commit()
    resp = await client.post("/initiatives", headers=staff, json={
        "name": "Started as move", "initiative_type": "move",
        "origin_site_id": str(site.id)})
    iid = resp.json()["id"]

    # staff (rank 40) may not change the type
    resp = await client.patch(f"/initiatives/{iid}", headers=staff,
                              json={"initiative_type": "project"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "type_change_forbidden"

    # admin (rank 60) may — and the old move field is retained, not wiped
    admin = await _admin_login(db, client)
    resp = await client.patch(f"/initiatives/{iid}", headers=admin,
                              json={"initiative_type": "project"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["initiative_type"] == "project"
    assert resp.json()["origin_site_id"] == str(site.id)

    # a no-op "change" to the same type is not gated
    resp = await client.patch(f"/initiatives/{iid}", headers=staff,
                              json={"initiative_type": "project"})
    assert resp.status_code == 200


async def test_archive_unarchive(client, db, seeded_user):
    headers = await login(client)
    resp = await client.post("/initiatives", headers=headers,
                             json={"name": "X", "initiative_type": "event"})
    iid = resp.json()["id"]
    assert (await client.post(f"/initiatives/{iid}/archive",
                              headers=headers)).status_code == 204
    resp = await client.get(f"/initiatives/{iid}", headers=headers)
    assert resp.json()["archived_at"] is not None
    assert (await client.post(f"/initiatives/{iid}/unarchive",
                              headers=headers)).status_code == 204


async def test_worker_role_forbidden(client, db, seeded_user):
    w = Person(first_name="Wally", last_name="Worker")
    db.add(w)
    await db.flush()
    db.add(PersonRole(person_id=w.id, role="worker"))
    await db.commit()
    headers = await make_login(db, client, w, "wally@test.example.com")
    assert (await client.get("/initiatives",
                             headers=headers)).status_code == 403


async def test_shipping_type_usage_counts(client, db, seeded_user):
    """The Variables page usage counter must survive the text[] column."""
    from serversherpa.db.models import Person, PersonRole

    headers = await login(client)
    await client.post("/initiatives", headers=headers, json={
        "name": "X", "initiative_type": "move", "shipping_types": ["truck"]})

    # The devtools unfiltered listing populates usage_count and must count
    # array-type columns correctly via unnest()
    dev = Person(first_name="D", last_name="Dev")
    db.add(dev)
    await db.flush()
    db.add(PersonRole(person_id=dev.id, role="developer"))
    await db.commit()
    from .test_assets_api import make_login
    dev_headers = await make_login(db, client, dev, "dev@test.example.com")

    resp = await client.get("/status-values", headers=dev_headers)
    assert resp.status_code == 200, resp.text
    by_key = {r["key"]: r for r in resp.json()
              if r["record_type"] == "shipping_type"}
    assert by_key["truck"]["usage_count"] == 1
    assert by_key["air"]["usage_count"] == 0


async def test_unknown_id_404(client, db, seeded_user):
    headers = await login(client)
    resp = await client.get(f"/initiatives/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"
