"""Initiative move assets — attach/list/patch/detach, v2-parity fields,
error codes, audit rows, cascade delete, and permission gating."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, AuditLog, Client, Initiative, Person, PersonRole,
    Role, RolePermission,
)

from .test_assets_api import login, make_login


async def _move(client, headers, name="Move A"):
    resp = await client.post("/initiatives", headers=headers,
                             json={"name": name, "initiative_type": "move"})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _project(client, headers, name="Proj A"):
    resp = await client.post("/initiatives", headers=headers,
                             json={"name": name, "initiative_type": "project"})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _asset(db, **kw):
    a = Asset(**kw)
    db.add(a)
    await db.flush()
    return a


async def _view_only_headers(db, client_api):
    """A person who can view initiatives but not change them."""
    db.add(Role(name="initiatives_viewer", description="test-only",
                scope_anchor="global"))
    await db.flush()
    db.add(RolePermission(role="initiatives_viewer", resource="initiatives",
                          action="view"))
    nobody = Person(first_name="View", last_name="Only")
    db.add(nobody)
    await db.flush()
    db.add(PersonRole(person_id=nobody.id, role="initiatives_viewer"))
    await db.commit()
    return await make_login(db, client_api, nobody, "viewonly@test.example.com")


async def test_attach_list_and_embedded_asset(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    org = Client(name="Acme")
    db.add(org)
    await db.flush()
    model = AssetModel(make="Dell", model="R740", ru_size=2)
    db.add(model)
    await db.flush()
    a1 = await _asset(db, serial_number="SN-2", name="web-02",
                      model_id=model.id, client_id=org.id, legacy_id=42,
                      rfid_tag="RF-2", location_detail="Hall B")
    a2 = await _asset(db, serial_number="SN-1", name="web-01")
    await db.commit()

    resp = await client.post(f"/initiatives/{iid}/assets", headers=headers,
                             json={"asset_ids": [str(a1.id), str(a2.id)]})
    assert resp.status_code == 201, resp.text
    rows = resp.json()
    assert len(rows) == 2
    # GET ordering: priority_wave NULLS LAST (both null here), then serial
    resp = await client.get(f"/initiatives/{iid}/assets", headers=headers)
    assert resp.status_code == 200
    rows = resp.json()
    assert [r["asset"]["serial_number"] for r in rows] == ["SN-1", "SN-2"]

    row = next(r for r in rows if r["asset"]["serial_number"] == "SN-2")
    assert row["status"] == "loaded_in_system"
    assert row["status_label"] == "Loaded In System"
    assert row["status_color"] == "#808080"
    assert row["asset"]["id"] == str(a1.id)
    assert row["asset"]["legacy_id"] == 42
    assert row["asset"]["name"] == "web-02"
    assert row["asset"]["rfid_tag"] == "RF-2"
    assert row["asset"]["model_make"] == "Dell"
    assert row["asset"]["model_name"] == "R740"
    assert row["asset"]["ru_size"] == 2
    assert row["asset"]["location_detail"] == "Hall B"
    assert row["asset"]["client_name"] == "Acme"
    assert row["asset"]["status"] == "unknown"

    # audit row written for the attach
    audit_rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "initiative",
        AuditLog.entity_id == iid,
        AuditLog.action == "asset_add"))).all()
    assert len(audit_rows) == 1


async def test_priority_wave_ordering(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    a1 = await _asset(db, serial_number="SN-A")
    a2 = await _asset(db, serial_number="SN-B")
    a3 = await _asset(db, serial_number="SN-C")
    await db.commit()
    await client.post(f"/initiatives/{iid}/assets", headers=headers,
                      json={"asset_ids": [str(a1.id), str(a2.id), str(a3.id)]})
    rows = (await client.get(f"/initiatives/{iid}/assets",
                             headers=headers)).json()
    ids = {r["asset"]["serial_number"]: r["id"] for r in rows}
    # give SN-B a wave, leave SN-A/SN-C null — waved row must NOT sort last
    await client.patch(f"/initiatives/assets/{ids['SN-B']}", headers=headers,
                       json={"priority_wave": "1"})
    rows = (await client.get(f"/initiatives/{iid}/assets",
                             headers=headers)).json()
    assert [r["asset"]["serial_number"] for r in rows] == \
        ["SN-B", "SN-A", "SN-C"]


async def test_attach_not_a_move(client, db, seeded_user):
    headers = await login(client)
    iid = await _project(client, headers)
    a = await _asset(db, serial_number="SN-9")
    await db.commit()
    resp = await client.post(f"/initiatives/{iid}/assets", headers=headers,
                             json={"asset_ids": [str(a.id)]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "not_a_move"


async def test_attach_assets_not_found(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    missing = str(uuid.uuid4())
    resp = await client.post(f"/initiatives/{iid}/assets", headers=headers,
                             json={"asset_ids": [missing]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "assets_not_found"
    assert resp.json()["detail"]["asset_ids"] == [missing]


async def test_attach_already_on_initiative_nothing_partial(client, db,
                                                             seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    a1 = await _asset(db, serial_number="SN-1")
    a2 = await _asset(db, serial_number="SN-2")
    await db.commit()
    assert (await client.post(
        f"/initiatives/{iid}/assets", headers=headers,
        json={"asset_ids": [str(a1.id)]})).status_code == 201

    resp = await client.post(f"/initiatives/{iid}/assets", headers=headers,
                             json={"asset_ids": [str(a1.id), str(a2.id)]})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "assets_already_on_initiative"
    assert resp.json()["detail"]["asset_ids"] == [str(a1.id)]

    # nothing partially applied — a2 must NOT have been attached
    rows = (await client.get(f"/initiatives/{iid}/assets",
                             headers=headers)).json()
    assert len(rows) == 1


async def test_attach_race_loser_gets_409(client, db, seeded_user,
                                          monkeypatch):
    """A concurrent double-attach that slips past the pre-check must still
    surface the 409 via the unique-constraint violation, not a 500."""
    from serversherpa.api.routes import initiatives as initiatives_routes

    headers = await login(client)
    iid = await _move(client, headers)
    a = await _asset(db, serial_number="SN-race")
    await db.commit()
    assert (await client.post(
        f"/initiatives/{iid}/assets", headers=headers,
        json={"asset_ids": [str(a.id)]})).status_code == 201

    orig = initiatives_routes._already_attached

    async def _races_past_check(db, initiative_id, asset_ids):
        return set()

    monkeypatch.setattr(initiatives_routes, "_already_attached",
                        _races_past_check)
    resp = await client.post(f"/initiatives/{iid}/assets", headers=headers,
                             json={"asset_ids": [str(a.id)]})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "assets_already_on_initiative"
    del orig


async def test_patch_whitelist_and_ru_number(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    a = await _asset(db, serial_number="SN-patch")
    await db.commit()
    rows = (await client.post(
        f"/initiatives/{iid}/assets", headers=headers,
        json={"asset_ids": [str(a.id)]})).json()
    assoc_id = rows[0]["id"]

    resp = await client.patch(f"/initiatives/assets/{assoc_id}",
                              headers=headers, json={
                                  "priority_wave": "Wave 1",
                                  "disposition": "keep",
                                  "owner": "Bob",
                                  "source_rack": "11.01.01",
                                  "source_ru": 12.5,
                                  "source_verified": True,
                                  "source_position": "front",
                                  "destination_rack": "BJ08",
                                  "destination_ru": "20",
                                  "destination_verified": False,
                                  "destination_position": "rear",
                                  "cable_info": "2x CAT6",
                                  "vendor_involved": True,
                                  "status": "racked",
                              })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["priority_wave"] == "Wave 1"
    assert body["source_ru"] == 12.5
    assert isinstance(body["source_ru"], float)
    assert body["destination_ru"] == 20.0
    assert body["status"] == "racked"
    assert body["status_label"] == "Racked"

    # updated_at bumped
    assert body["updated_at"] >= body["created_at"]

    # audit row with before/after diff
    audit_rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "initiative",
        AuditLog.entity_id == iid,
        AuditLog.action == "asset_update"))).all()
    assert len(audit_rows) == 1
    changes = audit_rows[0].changes
    assert changes["status"] == {"from": "loaded_in_system", "to": "racked"}

    # empty string clears nullable text fields
    resp = await client.patch(f"/initiatives/assets/{assoc_id}",
                              headers=headers, json={"disposition": ""})
    assert resp.status_code == 200
    assert resp.json()["disposition"] is None

    # a field outside the whitelist is rejected
    resp = await client.patch(f"/initiatives/assets/{assoc_id}",
                              headers=headers, json={"asset_id": str(uuid.uuid4())})
    assert resp.status_code == 422


async def test_patch_invalid_ru(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    a = await _asset(db, serial_number="SN-ru")
    await db.commit()
    assoc_id = (await client.post(
        f"/initiatives/{iid}/assets", headers=headers,
        json={"asset_ids": [str(a.id)]})).json()[0]["id"]

    resp = await client.patch(f"/initiatives/assets/{assoc_id}",
                              headers=headers, json={"source_ru": "not-a-number"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_ru"


async def test_patch_unknown_status(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    a = await _asset(db, serial_number="SN-status")
    await db.commit()
    assoc_id = (await client.post(
        f"/initiatives/{iid}/assets", headers=headers,
        json={"asset_ids": [str(a.id)]})).json()[0]["id"]

    resp = await client.patch(f"/initiatives/assets/{assoc_id}",
                              headers=headers, json={"status": "bogus"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_status"


async def test_patch_not_found(client, db, seeded_user):
    headers = await login(client)
    resp = await client.patch(f"/initiatives/assets/{uuid.uuid4()}",
                              headers=headers, json={"owner": "X"})
    assert resp.status_code == 404


async def test_remove_asset_and_audit(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    a = await _asset(db, serial_number="SN-remove")
    await db.commit()
    assoc_id = (await client.post(
        f"/initiatives/{iid}/assets", headers=headers,
        json={"asset_ids": [str(a.id)]})).json()[0]["id"]

    resp = await client.delete(f"/initiatives/assets/{assoc_id}",
                               headers=headers)
    assert resp.status_code == 204
    rows = (await client.get(f"/initiatives/{iid}/assets",
                             headers=headers)).json()
    assert rows == []

    audit_rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "initiative",
        AuditLog.entity_id == iid,
        AuditLog.action == "asset_remove"))).all()
    assert len(audit_rows) == 1


async def test_remove_not_found(client, db, seeded_user):
    headers = await login(client)
    resp = await client.delete(f"/initiatives/assets/{uuid.uuid4()}",
                               headers=headers)
    assert resp.status_code == 404


async def test_cascade_delete_removes_rows(db, seeded_user):
    """Initiative CASCADE (FK ondelete) covers initiative_assets rows on a
    hard delete of the initiative."""
    from serversherpa.db.models import InitiativeAsset

    initiative = Initiative(name="Doomed move", initiative_type="move",
                            status="planned")
    db.add(initiative)
    await db.flush()
    a = await _asset(db, serial_number="SN-cascade")
    await db.flush()
    db.add(InitiativeAsset(initiative_id=initiative.id, asset_id=a.id))
    await db.commit()

    existing = (await db.scalars(select(InitiativeAsset).where(
        InitiativeAsset.initiative_id == initiative.id))).all()
    assert len(existing) == 1

    await db.delete(initiative)
    await db.commit()

    remaining = (await db.scalars(select(InitiativeAsset).where(
        InitiativeAsset.initiative_id == initiative.id))).all()
    assert remaining == []


async def test_view_only_user_gets_get_not_write(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    a = await _asset(db, serial_number="SN-view")
    await db.commit()
    assoc_id = (await client.post(
        f"/initiatives/{iid}/assets", headers=headers,
        json={"asset_ids": [str(a.id)]})).json()[0]["id"]

    view_headers = await _view_only_headers(db, client)
    assert (await client.get(f"/initiatives/{iid}/assets",
                             headers=view_headers)).status_code == 200
    assert (await client.post(
        f"/initiatives/{iid}/assets", headers=view_headers,
        json={"asset_ids": [str(a.id)]})).status_code == 403
    assert (await client.patch(
        f"/initiatives/assets/{assoc_id}", headers=view_headers,
        json={"owner": "X"})).status_code == 403
    assert (await client.delete(
        f"/initiatives/assets/{assoc_id}", headers=view_headers)
            ).status_code == 403
