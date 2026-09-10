"""Trucks API — CRUD, location updates, and the map query."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Client, Container, Site

from tests.test_initiative_assets_api import _move
from tests.test_initiatives_client_scope import client_login
from tests.test_sites_api import login


async def test_crud_roundtrip_with_labels_and_audit(client, db, seeded_user):
    hdrs = await login(client)

    resp = await client.post("/trucks", headers=hdrs, json={"name": "Truck 1"})
    assert resp.status_code == 201, resp.text
    truck = resp.json()
    assert truck["status"] == "created"
    assert truck["status_label"] == "Created"
    assert truck["status_color"] == "#51606f"
    assert truck["container_count"] == 0
    assert truck["last_update"] is None
    truck_id = truck["id"]

    start = Site(name="Start Site")
    end = Site(name="End Site")
    db.add_all([start, end])
    container = Container(name="Crate A")
    db.add(container)
    await db.commit()
    initiative_id = await _move(client, hdrs)

    resp = await client.patch(f"/trucks/{truck_id}", headers=hdrs, json={
        "status": "in_transit",
        "start_site_id": str(start.id), "end_site_id": str(end.id),
        "initiative_id": initiative_id,
        "container_ids": [str(container.id)],
    })
    assert resp.status_code == 200, resp.text
    updated = resp.json()
    assert updated["status"] == "in_transit"
    assert updated["status_label"] == "In Transit"
    assert updated["start_site_name"] == "Start Site"
    assert updated["end_site_name"] == "End Site"
    assert updated["initiative_name"] == "Move A"
    assert updated["container_count"] == 1

    resp = await client.get("/trucks", headers=hdrs)
    assert resp.status_code == 200
    assert any(t["id"] == truck_id for t in resp.json())

    resp = await client.post(f"/trucks/{truck_id}/archive", headers=hdrs)
    assert resp.status_code == 204

    resp = await client.get("/trucks", headers=hdrs)
    assert all(t["id"] != truck_id for t in resp.json())        # excluded by default
    resp = await client.get("/trucks?include_archived=true", headers=hdrs)
    assert any(t["id"] == truck_id for t in resp.json())        # visible with flag

    resp = await client.post(f"/trucks/{truck_id}/unarchive", headers=hdrs)
    assert resp.status_code == 204

    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "truck",
        AuditLog.entity_id == truck_id))).all()
    actions = {r.action for r in rows}
    assert {"create", "update", "archive", "restore"} <= actions


async def test_validation_codes(client, db, seeded_user):
    hdrs = await login(client)

    resp = await client.post("/trucks", headers=hdrs, json={"name": ""})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "name_required"

    resp = await client.post("/trucks", headers=hdrs, json={
        "name": "T", "status": "teleporting"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_status"

    resp = await client.post("/trucks", headers=hdrs, json={
        "name": "T", "start_site_id": str(uuid.uuid4())})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "site_not_found"

    resp = await client.post("/trucks", headers=hdrs, json={
        "name": "T", "initiative_id": str(uuid.uuid4())})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "initiative_not_found"

    resp = await client.post("/trucks", headers=hdrs, json={
        "name": "T", "container_ids": [str(uuid.uuid4())]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "container_not_found"

    resp = await client.post("/trucks", headers=hdrs, json={"name": "T2"})
    assert resp.status_code == 201
    truck_id = resp.json()["id"]
    resp = await client.patch(f"/trucks/{truck_id}", headers=hdrs,
                              json={"bogus_field": 1})
    assert resp.status_code == 422


async def test_updates_post_list_clear_and_last_update(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/trucks", headers=hdrs, json={"name": "Truck U"})
    assert resp.status_code == 201
    truck_id = resp.json()["id"]

    resp = await client.post(f"/trucks/{truck_id}/updates", headers=hdrs, json={
        "location": "39.0, -77.4",
        "recorded_at": "2026-01-01T00:00:00Z"})
    assert resp.status_code == 201, resp.text
    first = resp.json()
    assert first["lat"] == 39.0 and first["lng"] == -77.4
    assert first["source"] == "manual"
    assert first["recorded_at"] is not None

    resp = await client.post(f"/trucks/{truck_id}/updates", headers=hdrs, json={
        "location": {"lat": 40.0, "lng": -78.0},
        "recorded_at": "2026-01-01T01:00:00Z"})
    assert resp.status_code == 201, resp.text
    second = resp.json()
    assert second["lat"] == 40.0 and second["lng"] == -78.0

    resp = await client.post(f"/trucks/{truck_id}/updates", headers=hdrs, json={
        "location": "abc"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_location"

    resp = await client.get(f"/trucks/{truck_id}/updates", headers=hdrs)
    assert resp.status_code == 200
    listing = resp.json()
    assert len(listing) == 2
    assert listing[0]["id"] == second["id"]      # newest-first
    assert listing[1]["id"] == first["id"]

    resp = await client.get(f"/trucks/{truck_id}", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json()["last_update"]["lat"] == 40.0

    resp = await client.delete(f"/trucks/{truck_id}/updates", headers=hdrs)
    assert resp.status_code == 204

    resp = await client.get(f"/trucks/{truck_id}/updates", headers=hdrs)
    assert resp.json() == []

    resp = await client.get(f"/trucks/{truck_id}", headers=hdrs)
    assert resp.json()["last_update"] is None


async def test_map_excludes_historical_archived_and_unlocated(client, db, seeded_user):
    hdrs = await login(client)

    async def _make_truck(name, status):
        resp = await client.post("/trucks", headers=hdrs,
                                 json={"name": name, "status": status})
        assert resp.status_code == 201, resp.text
        return resp.json()["id"]

    mapped_id = await _make_truck("Mapped", "in_transit")
    historical_id = await _make_truck("Historical", "historical")
    archived_id = await _make_truck("Archived", "active")
    unlocated_id = await _make_truck("Unlocated", "active")

    for tid in (mapped_id, historical_id, archived_id):
        resp = await client.post(f"/trucks/{tid}/updates", headers=hdrs, json={
            "location": {"lat": 39.0, "lng": -77.0},
            "recorded_at": "2026-01-01T00:00:00Z"})
        assert resp.status_code == 201
        resp = await client.post(f"/trucks/{tid}/updates", headers=hdrs, json={
            "location": {"lat": 39.1, "lng": -77.1},
            "recorded_at": "2026-01-01T01:00:00Z"})
        assert resp.status_code == 201

    resp = await client.post(f"/trucks/{archived_id}/archive", headers=hdrs)
    assert resp.status_code == 204

    resp = await client.get("/trucks/map", headers=hdrs)
    assert resp.status_code == 200
    ids = {t["id"] for t in resp.json()}
    assert ids == {mapped_id}                    # historical/archived/unlocated excluded
    assert unlocated_id not in ids

    resp = await client.get("/trucks/map?trails=true", headers=hdrs)
    assert resp.status_code == 200
    point = next(t for t in resp.json() if t["id"] == mapped_id)
    assert [p["lat"] for p in point["trail"]] == [39.0, 39.1]  # oldest-first


async def test_gates(client, db, seeded_user):
    org = Client(name="Gate Org")
    db.add(org)
    await db.commit()
    hdrs = await client_login(db, client, org.id)

    resp = await client.get("/trucks", headers=hdrs)
    assert resp.status_code == 403


async def test_patch_rejects_null_for_required_fields(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/trucks", headers=hdrs, json={"name": "Req"})
    assert resp.status_code == 201, resp.text
    truck_id = resp.json()["id"]

    for field in ("status", "contact_info", "team_drive", "tracking_type"):
        resp = await client.patch(f"/trucks/{truck_id}", headers=hdrs,
                                  json={field: None})
        assert resp.status_code == 422, (field, resp.text)
        assert resp.json()["detail"]["code"] == f"{field}_required"

    resp = await client.patch(f"/trucks/{truck_id}", headers=hdrs,
                              json={"driver_name": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["driver_name"] is None
