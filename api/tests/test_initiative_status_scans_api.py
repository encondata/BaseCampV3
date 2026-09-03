"""PATCH /initiatives/assets/{id}: status changes become manual processed
scans and run the rules engine in the request."""

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AuditLog, InitiativeAsset, ProcessedScan, StatusRuleExecution,
)
from serversherpa.status_rules.engine import invalidate_cache

from tests.test_assets_api import login
from tests.test_initiative_assets_api import _asset, _move
from tests.test_status_rules_engine import _rule


@pytest.fixture(autouse=True)
def _fresh_cache():
    invalidate_cache()
    yield
    invalidate_cache()


async def _attached(client, db, hdrs, **asset_kw):
    iid = await _move(client, hdrs)
    asset = await _asset(db, serial_number="SN-9", name="srv-9",
                         status="active", **asset_kw)
    await db.commit()
    resp = await client.post(f"/initiatives/{iid}/assets", headers=hdrs,
                             json={"asset_ids": [str(asset.id)]})
    assert resp.status_code == 201, resp.text
    row = resp.json()[0]
    return iid, asset, row


async def test_status_change_records_a_manual_scan(client, db, seeded_user):
    hdrs = await login(client)
    _iid, asset, row = await _attached(client, db, hdrs)
    resp = await client.patch(f"/initiatives/assets/{row['id']}", headers=hdrs,
                              json={"status": "in_transit"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "in_transit"

    scan = (await db.scalars(select(ProcessedScan))).one()
    assert scan.scan_type == "manual"
    assert scan.status == "in_transit"
    assert scan.asset_id == asset.id
    assert scan.operator_id == seeded_user.id
    assert scan.device_id == "portal"
    assert scan.source == "initiative_asset_edit"
    assert scan.site_id is None and scan.raw_scan_id is None
    assert scan.scanned_value == "SN-9"


async def test_no_scan_for_same_status_or_other_fields(client, db, seeded_user):
    hdrs = await login(client)
    _iid, _asset, row = await _attached(client, db, hdrs)
    current = row["status"]
    for body in ({"status": current}, {"owner": "Ops"}, {"source_rack": "R1"}):
        resp = await client.patch(f"/initiatives/assets/{row['id']}",
                                  headers=hdrs, json=body)
        assert resp.status_code == 200, resp.text
    assert (await db.scalars(select(ProcessedScan))).all() == []


async def test_rules_fire_in_the_request_against_this_initiative(client, db, seeded_user):
    hdrs = await login(client)
    iid, asset, row = await _attached(client, db, hdrs)
    db.add(_rule("Stage", status="in_transit", actions=(
        ("set_asset_status", {"status": "in_storage"}),)))
    await db.commit()

    resp = await client.patch(f"/initiatives/assets/{row['id']}", headers=hdrs,
                              json={"status": "in_transit"})
    assert resp.status_code == 200, resp.text
    # response already reflects the rule's side-effect on the asset
    assert resp.json()["asset"]["status"] == "in_storage"
    await db.refresh(asset)
    assert asset.status == "in_storage"
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.conditions_met is True
    scan = (await db.scalars(select(ProcessedScan))).one()
    assert ex.processed_scan_id == scan.id


async def test_rule_failure_blocks_the_edit(client, db, seeded_user):
    hdrs = await login(client)
    _iid, asset, row = await _attached(client, db, hdrs)
    db.add(_rule("Broken", status="in_transit", actions=(
        ("set_asset_status", {"status": "no-such-status"}),)))
    await db.commit()

    resp = await client.patch(f"/initiatives/assets/{row['id']}", headers=hdrs,
                              json={"status": "in_transit"})
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "rule_failed"
    assert detail["rule_name"] == "Broken"
    assert detail["reason"]

    # nothing persisted: status, scan, audit
    assoc = await db.get(InitiativeAsset, row["id"])
    await db.refresh(assoc)
    assert assoc.status == row["status"]
    assert (await db.scalars(select(ProcessedScan))).all() == []
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "asset_update"))).all()
    assert audits == []

    # ...but the failure itself left a server-side trace for the admin UI
    executions = (await db.scalars(select(StatusRuleExecution))).all()
    assert len(executions) == 1
    ex = executions[0]
    assert ex.rule_name == "Broken"
    assert ex.processed_scan_id is None
    assert ex.error


async def test_provenance_reports_the_manual_scan(client, db, seeded_user):
    hdrs = await login(client)
    _iid, asset, row = await _attached(client, db, hdrs)
    resp = await client.patch(f"/initiatives/assets/{row['id']}", headers=hdrs,
                              json={"status": "in_transit"})
    assert resp.status_code == 200
    resp = await client.get("/status/provenance", headers=hdrs, params={
        "entity_type": "asset", "entity_id": str(asset.id),
        "status": "in_transit"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "scan"
    assert body["scan_type"] == "manual"
    assert body["device_id"] == "portal"
    assert body["actor_name"] == "Alice Anderson"   # the signed-in editor
