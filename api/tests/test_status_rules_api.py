"""API tests for /status-rules — CRUD + toggle, catalog validation, audit."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, StatusRule
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
