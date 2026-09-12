"""Containers API — CRUD, labels, vocab/ref validation, archive, gates."""

from datetime import UTC, datetime

from serversherpa.db.models import Client, Initiative, Person, PersonRole, Site

from .test_assets_api import login, make_login


async def test_crud_roundtrip(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="DC-1")
    db.add(site)
    await db.commit()

    resp = await client.post("/containers", headers=hdrs, json={
        "name": "Crate A", "container_type": "pelican_case",
        "rfid_tag": "RF-001", "site_id": str(site.id),
        "location_detail": "Dock 3",
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "available"
    assert body["status_label"] == "Available"
    assert body["type_label"] == "Pelican case"
    assert body["site_name"] == "DC-1"
    assert body["asset_count"] == 0
    cid = body["id"]

    resp = await client.get("/containers", headers=hdrs)
    assert [c["id"] for c in resp.json()] == [cid]

    resp = await client.patch(f"/containers/{cid}", headers=hdrs,
                              json={"status": "packed", "site_id": None})
    assert resp.status_code == 200
    assert resp.json()["status"] == "packed"
    assert resp.json()["site_name"] is None


async def test_validation_errors(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers", headers=hdrs,
                             json={"name": "X", "status": "nope"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_status"

    resp = await client.post("/containers", headers=hdrs,
                             json={"name": "X", "container_type": "nope"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_container_type"

    await client.post("/containers", headers=hdrs,
                      json={"name": "A", "rfid_tag": "DUP-1"})
    resp = await client.post("/containers", headers=hdrs,
                             json={"name": "B", "rfid_tag": "DUP-1"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "rfid_tag_in_use"

    resp = await client.patch("/containers/00000000-0000-0000-0000-000000000000",
                              headers=hdrs, json={"name": "Z"})
    assert resp.status_code == 404

    resp = await client.post("/containers", headers=hdrs, json={
        "name": "X", "site_id": "00000000-0000-0000-0000-000000000000",
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "site_not_found"

    resp = await client.post("/containers", headers=hdrs, json={"name": "Req"})
    cid = resp.json()["id"]
    resp = await client.patch(f"/containers/{cid}", headers=hdrs,
                              json={"name": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "name_required"

    resp = await client.patch(f"/containers/{cid}", headers=hdrs,
                              json={"location_detail": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "location_detail_required"

    resp = await client.patch(f"/containers/{cid}", headers=hdrs,
                              json={"status": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "status_required"

    resp = await client.post("/containers", headers=hdrs, json={"name": ""})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "name_required"

    resp = await client.patch(f"/containers/{cid}", headers=hdrs,
                              json={"name": ""})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "name_required"


async def test_archive_roundtrip(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers", headers=hdrs, json={"name": "Arch"})
    cid = resp.json()["id"]
    assert (await client.post(f"/containers/{cid}/archive",
                              headers=hdrs)).status_code == 204
    resp = await client.get(f"/containers/{cid}", headers=hdrs)
    assert resp.json()["archived_at"] is not None
    assert (await client.post(f"/containers/{cid}/unarchive",
                              headers=hdrs)).status_code == 204


async def test_initiative_id_round_trip_and_filter(client, db, seeded_user):
    hdrs = await login(client)
    ini1 = Initiative(name="NAP11", initiative_type="move", status="planned")
    ini2 = Initiative(name="NAP12", initiative_type="move", status="planned")
    db.add_all([ini1, ini2])
    await db.commit()

    resp = await client.post("/containers", headers=hdrs, json={
        "name": "Crate B", "initiative_id": str(ini1.id),
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["initiative_id"] == str(ini1.id)
    assert body["initiative_name"] == "NAP11"
    cid = body["id"]

    # explicit null clears (exclude_unset — omitting the key leaves it alone)
    resp = await client.patch(f"/containers/{cid}", headers=hdrs,
                              json={"initiative_id": str(ini2.id)})
    assert resp.status_code == 200
    assert resp.json()["initiative_id"] == str(ini2.id)
    assert resp.json()["initiative_name"] == "NAP12"

    resp = await client.patch(f"/containers/{cid}", headers=hdrs,
                              json={"location_detail": "Bay 2"})
    assert resp.status_code == 200
    assert resp.json()["initiative_id"] == str(ini2.id)   # untouched — key omitted

    resp = await client.patch(f"/containers/{cid}", headers=hdrs,
                              json={"initiative_id": None})
    assert resp.status_code == 200
    assert resp.json()["initiative_id"] is None
    assert resp.json()["initiative_name"] is None

    # filter
    resp = await client.post("/containers", headers=hdrs, json={
        "name": "Crate C", "initiative_id": str(ini1.id),
    })
    other_cid = resp.json()["id"]
    resp = await client.get("/containers", headers=hdrs,
                            params={"initiative_id": str(ini1.id)})
    assert [c["id"] for c in resp.json()] == [other_cid]


async def test_initiative_id_404_for_unknown_and_archived(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers", headers=hdrs, json={
        "name": "Crate D",
        "initiative_id": "00000000-0000-0000-0000-000000000000",
    })
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"

    archived = Initiative(name="Done Move", initiative_type="move", status="completed",
                          archived_at=datetime.now(UTC))
    db.add(archived)
    await db.commit()

    resp = await client.post("/containers", headers=hdrs, json={
        "name": "Crate E", "initiative_id": str(archived.id),
    })
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"

    cid = (await client.post("/containers", headers=hdrs,
                             json={"name": "Crate F"})).json()["id"]
    resp = await client.patch(f"/containers/{cid}", headers=hdrs,
                              json={"initiative_id": str(archived.id)})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"


async def test_no_permission_403(client, db, seeded_user):
    org = Client(name="Org")
    db.add(org)
    await db.flush()
    nobody = Person(first_name="No", last_name="Body")
    db.add(nobody)
    await db.flush()
    db.add(PersonRole(person_id=nobody.id, role="client_viewer", client_id=org.id))
    await db.commit()
    hdrs = await make_login(db, client, nobody, "nobody@test.example.com")
    assert (await client.get("/containers", headers=hdrs)).status_code == 403
