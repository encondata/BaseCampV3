"""API tests for /status-rules — CRUD + toggle, catalog validation, audit."""

from datetime import UTC, datetime

from sqlalchemy import select, text

from serversherpa.db.models import (
    AuditLog, Asset, ProcessedScan, StatusRule, StatusRuleExecution,
)
from serversherpa.status_rules.catalog import ACTIONS, OPERATORS
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff


def _body(**over):
    base = dict(
        name="Into cage",
        description="Marks assets racked when scanned into the cage",
        trigger_status="rfid_4_into_cage",
        trigger_match_type="asset",
        priority=10,
        enabled=True,
        conditions=[
            {"field": "scan.device_id", "operator": "equals", "value": "dock-1"},
        ],
        actions=[
            {"action_type": "set_asset_status",
             "params": {"status": "in_container"}},
            {"action_type": "touch_container_audit", "params": {}},
        ],
    )
    base.update(over)
    return base


async def test_create_and_list_round_trip(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert created["name"] == "Into cage"
    assert len(created["conditions"]) == 1
    assert len(created["actions"]) == 2

    resp = await client.get("/status-rules", headers=hdrs)
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    rule = items[0]
    assert rule["id"] == created["id"]
    assert rule["conditions"] == [
        {"field": "scan.device_id", "operator": "equals", "value": "dock-1"},
    ]
    assert rule["actions"] == [
        {"action_type": "set_asset_status", "params": {"status": "in_container"}},
        {"action_type": "touch_container_audit", "params": {}},
    ]

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "status_rule", AuditLog.action == "create"))
    assert row is not None and row.entity_id == created["id"]


async def test_create_rejects_bad_trigger_status(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs,
                             json=_body(trigger_status="nope"))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_trigger"


async def test_create_rejects_unknown_condition_field(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body(
        conditions=[{"field": "x.y", "operator": "equals", "value": "1"}]))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_condition"


async def test_create_rejects_bad_action_params(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body(
        actions=[{"action_type": "set_asset_status", "params": {}}]))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_action"


async def test_create_rejects_unknown_status_param_key(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body(
        actions=[{"action_type": "set_asset_status",
                 "params": {"status": "not-a-key"}}]))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_action"


async def test_put_replaces_children(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    rule_id = resp.json()["id"]

    resp = await client.put(f"/status-rules/{rule_id}", headers=hdrs, json=_body(
        conditions=[{"field": "asset.status", "operator": "not_equals",
                    "value": "active"}],
        actions=[{"action_type": "set_container_status",
                 "params": {"status": "packed"}}],
    ))
    assert resp.status_code == 200, resp.text

    resp = await client.get(f"/status-rules/{rule_id}", headers=hdrs)
    assert resp.status_code == 200
    body = resp.json()
    assert body["conditions"] == [
        {"field": "asset.status", "operator": "not_equals", "value": "active"},
    ]
    assert body["actions"] == [
        {"action_type": "set_container_status", "params": {"status": "packed"}},
    ]

    from serversherpa.db.models import StatusRuleAction, StatusRuleCondition
    remaining_conditions = (await db.scalars(select(StatusRuleCondition).where(
        StatusRuleCondition.rule_id == rule_id))).all()
    remaining_actions = (await db.scalars(select(StatusRuleAction).where(
        StatusRuleAction.rule_id == rule_id))).all()
    assert len(remaining_conditions) == 1
    assert remaining_conditions[0].field == "asset.status"
    assert len(remaining_actions) == 1
    assert remaining_actions[0].action_type == "set_container_status"


async def test_patch_toggles_enabled(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    rule_id = resp.json()["id"]

    resp = await client.patch(f"/status-rules/{rule_id}", headers=hdrs,
                              json={"enabled": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["enabled"] is False

    resp = await client.get(f"/status-rules/{rule_id}", headers=hdrs)
    assert resp.json()["enabled"] is False

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "status_rule", AuditLog.action == "toggle"))
    assert row is not None and row.entity_id == rule_id


async def test_delete_removes_rule(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    rule_id = resp.json()["id"]

    resp = await client.delete(f"/status-rules/{rule_id}", headers=hdrs)
    assert resp.status_code == 204

    resp = await client.get(f"/status-rules/{rule_id}", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "rule_not_found"

    assert await db.get(StatusRule, rule_id) is None

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "status_rule", AuditLog.action == "delete"))
    assert row is not None and row.entity_id == rule_id


async def test_permission_denied_without_grant(client, db, seeded_user):
    hdrs = await login_staff(client, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    assert resp.status_code == 403


async def test_schema_endpoint_shape(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.get("/status-rules/schema", headers=hdrs)
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert len(data["trigger_statuses"]) > 0
    assert any(s["value"].startswith("rfid") for s in data["trigger_statuses"])

    assert {o["key"] for o in data["operators"]} == set(OPERATORS)
    assert len(data["operators"]) == 9

    for action in data["actions"]:
        catalog_action = ACTIONS[action["key"]]
        status_param_names = {p.name for p in catalog_action.params
                              if p.type == "status"}
        for param in action["params"]:
            if param["name"] in status_param_names:
                assert len(param.get("options") or []) > 0

    assert "sites" in data
    assert isinstance(data["sites"], list)


async def test_executions_list_and_filter(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    rule_id = resp.json()["id"]

    asset = Asset(status="unknown")
    db.add(asset)
    await db.flush()
    scan = ProcessedScan(
        scanned_value="TAG-1", scan_type="rfid", status="rfid_4_into_cage",
        scanned_at=datetime.now(UTC), processed_at=datetime.now(UTC),
        match_type="asset", asset_id=asset.id)
    db.add(scan)
    await db.flush()

    matched = StatusRuleExecution(
        rule_id=rule_id, rule_name="Into cage",
        processed_scan_id=scan.id, conditions_met=True,
        actions_applied=[{"action_type": "set_asset_status"}],
        error=None, duration_ms=12)
    errored = StatusRuleExecution(
        rule_id=None, rule_name="Broken rule",
        processed_scan_id=None, conditions_met=False,
        actions_applied=[], error="boom", duration_ms=3)
    db.add_all([matched, errored])
    await db.commit()

    resp = await client.get("/status-rules/executions", headers=hdrs)
    assert resp.status_code == 200, resp.text
    items = resp.json()
    assert len(items) == 2
    # newest first
    assert items[0]["executed_at"] >= items[1]["executed_at"]

    by_id = {item["id"]: item for item in items}
    matched_item = by_id[matched.id]
    assert matched_item["scanned_value"] == "TAG-1"
    assert matched_item["scan_status"] == "rfid_4_into_cage"
    assert matched_item["rule_id"] == rule_id
    assert matched_item["conditions_met"] is True

    error_item = by_id[errored.id]
    assert error_item["scanned_value"] is None
    assert error_item["scan_status"] is None
    assert error_item["rule_id"] is None
    assert error_item["error"] == "boom"

    resp = await client.get(
        "/status-rules/executions", headers=hdrs,
        params={"rule_id": rule_id})
    assert resp.status_code == 200, resp.text
    filtered = resp.json()
    assert len(filtered) == 1
    assert filtered[0]["id"] == matched.id


async def test_executions_stats(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    rule_a = resp.json()["id"]
    resp = await client.post("/status-rules", headers=hdrs,
                             json=_body(name="Second rule"))
    rule_b = resp.json()["id"]

    db.add_all([
        StatusRuleExecution(
            rule_id=rule_a, rule_name="Into cage", processed_scan_id=None,
            conditions_met=True, actions_applied=[], error=None,
            duration_ms=10),
        StatusRuleExecution(
            rule_id=rule_a, rule_name="Into cage", processed_scan_id=None,
            conditions_met=False, actions_applied=[], error=None,
            duration_ms=20),
        StatusRuleExecution(
            rule_id=rule_b, rule_name="Second rule", processed_scan_id=None,
            conditions_met=True, actions_applied=[], error=None,
            duration_ms=30),
    ])
    await db.commit()

    resp = await client.get("/status-rules/executions/stats", headers=hdrs)
    assert resp.status_code == 200, resp.text
    stats = {row["rule_id"]: row for row in resp.json()}

    assert stats[rule_a]["run_count"] == 2
    assert stats[rule_a]["met_count"] == 1
    assert stats[rule_a]["avg_duration_ms"] == 15.0
    assert stats[rule_a]["last_run_at"] is not None

    assert stats[rule_b]["run_count"] == 1
    assert stats[rule_b]["met_count"] == 1
    assert stats[rule_b]["avg_duration_ms"] == 30.0


async def test_executions_require_view(client, db, seeded_user):
    # "staff" carries status_rules:view by default (RULE_GRANTS in
    # migration 0035); "external" has no grants at all, so it's the role
    # to prove the endpoint is actually permission-gated.
    await db.execute(text(
        "UPDATE person_roles SET role='external' WHERE person_id=:p"),
        {"p": seeded_user.id})
    await db.commit()
    hdrs = await login_staff(client, seeded_user)
    resp = await client.get("/status-rules/executions", headers=hdrs)
    assert resp.status_code == 403
