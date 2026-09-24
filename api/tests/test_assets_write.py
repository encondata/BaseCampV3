"""Assets write paths: create/patch/archive, audit, validation, 403s."""

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Asset,
    AuditLog,
    Client,
    PermissionOverride,
    Person,
    PersonRole,
    ProcessedScan,
    StatusRuleExecution,
)
from serversherpa.status_rules.engine import invalidate_cache
from tests.test_assets_api import login, make_login
from tests.test_status_rules_engine import _rule


@pytest.fixture(autouse=True)
def _fresh_cache():
    invalidate_cache()
    yield
    invalidate_cache()


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


async def test_archive_requires_delete_not_just_change(client, db, seeded_user):
    """Archive is the only delete affordance assets have — it must be gated
    on `delete`, not `change`, even for a global (staff-anchored) actor."""
    admin = await login(client)
    asset_id = (await client.post("/assets", headers=admin,
                                  json={"name": "gated"})).json()["id"]

    changer = Person(first_name="Ch", last_name="Anger")
    db.add(changer)
    await db.flush()
    db.add(PersonRole(person_id=changer.id, role="staff"))
    db.add(PermissionOverride(person_id=changer.id, resource="assets",
                              action="delete", allow=False))
    await db.commit()
    hdrs = await make_login(db, client, changer, "changer@test.example.com")

    assert (await client.post(f"/assets/{asset_id}/archive",
                              headers=hdrs)).status_code == 403
    assert (await client.post(f"/assets/{asset_id}/unarchive",
                              headers=hdrs)).status_code == 403

    assert (await client.post(f"/assets/{asset_id}/archive",
                              headers=admin)).status_code == 204
    assert (await client.post(f"/assets/{asset_id}/unarchive",
                              headers=admin)).status_code == 204


async def test_pod_number_create_patch_and_clear(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/assets", headers=hdrs, json={
        "serial_number": "SN-POD", "name": "pod-01", "pod_number": "14"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["pod_number"] == "14"
    asset_id = resp.json()["id"]

    resp = await client.patch(f"/assets/{asset_id}", headers=hdrs,
                              json={"pod_number": "P-07"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["pod_number"] == "P-07"
    upd = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "update"))
    assert upd.changes["pod_number"] == {"from": "14", "to": "P-07"}

    resp = await client.patch(f"/assets/{asset_id}", headers=hdrs,
                              json={"pod_number": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["pod_number"] is None


async def test_status_change_on_asset_page_records_a_manual_scan(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/assets", headers=hdrs, json={
        "serial_number": "SN-EDIT", "name": "edit-01", "status": "active"})
    assert resp.status_code == 201, resp.text
    asset_id = resp.json()["id"]

    resp = await client.patch(f"/assets/{asset_id}", headers=hdrs,
                              json={"status": "in_transit"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "in_transit"

    scan = (await db.scalars(select(ProcessedScan))).one()
    assert scan.scan_type == "manual"
    assert scan.status == "in_transit"
    assert scan.source == "asset_edit"
    assert scan.device_id == "portal"
    assert scan.operator_id == seeded_user.id
    assert scan.match_type == "asset"
    assert str(scan.asset_id) == asset_id


async def test_no_scan_for_same_status_or_other_fields(client, db, seeded_user):
    hdrs = await login(client)
    created = (await client.post("/assets", headers=hdrs, json={
        "serial_number": "SN-EDIT2", "name": "edit-02", "status": "active"})).json()
    asset_id = created["id"]

    for body in ({"status": "active"}, {"name": "renamed"}):
        resp = await client.patch(f"/assets/{asset_id}", headers=hdrs, json=body)
        assert resp.status_code == 200, resp.text
    assert (await db.scalars(select(ProcessedScan))).all() == []


async def test_rules_fire_on_the_asset_page_status_edit(client, db, seeded_user):
    hdrs = await login(client)
    created = (await client.post("/assets", headers=hdrs, json={
        "serial_number": "SN-EDIT3", "name": "edit-03", "status": "active"})).json()
    asset_id = created["id"]
    db.add(_rule("Stage", status="in_transit", actions=(
        ("set_asset_status", {"status": "in_storage"}),)))
    await db.commit()

    resp = await client.patch(f"/assets/{asset_id}", headers=hdrs,
                              json={"status": "in_transit"})
    assert resp.status_code == 200, resp.text
    # response already reflects the rule's side-effect on the asset
    assert resp.json()["status"] == "in_storage"
    asset = await db.get(Asset, asset_id)
    await db.refresh(asset)
    assert asset.status == "in_storage"
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.conditions_met is True
    scan = (await db.scalars(select(ProcessedScan))).one()
    assert ex.processed_scan_id == scan.id


async def test_failing_rule_blocks_the_asset_page_edit(client, db, seeded_user):
    hdrs = await login(client)
    created = (await client.post("/assets", headers=hdrs, json={
        "serial_number": "SN-EDIT4", "name": "edit-04", "status": "active"})).json()
    asset_id = created["id"]
    db.add(_rule("Broken", status="in_transit", actions=(
        ("set_asset_status", {"status": "no-such-status"}),)))
    await db.commit()

    resp = await client.patch(f"/assets/{asset_id}", headers=hdrs,
                              json={"status": "in_transit", "name": "should-not-stick"})
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "rule_failed"
    assert detail["rule_name"] == "Broken"
    assert detail["reason"]

    # nothing persisted: status, other patched fields, scan, audit
    asset = await db.get(Asset, asset_id)
    await db.refresh(asset)
    assert asset.status == "active"
    assert asset.name == "edit-04"
    assert (await db.scalars(select(ProcessedScan))).all() == []
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "update"))).all()
    assert audits == []

    # ...but the failure itself left a server-side trace for the admin UI
    executions = (await db.scalars(select(StatusRuleExecution))).all()
    assert len(executions) == 1
    ex = executions[0]
    assert ex.rule_name == "Broken"
    assert ex.processed_scan_id is None
    assert ex.error
