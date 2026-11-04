"""API tests for /status-rules — CRUD + toggle, catalog validation, audit, and the names of the
people and groups a rule notifies."""

import time
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import event, select, text

from serversherpa.db.engine import get_engine
from serversherpa.db.models import (
    AuditLog, Asset, NotificationGroup, Person, ProcessedScan, StatusRule,
    StatusRuleExecution,
)
from serversherpa.status_rules import engine
from serversherpa.status_rules.catalog import ACTIONS, CONDITION_FIELDS, OPERATORS
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff
from tests.test_status_rules_engine import _rule


def _prime_cache():
    engine._cache[("x", "asset")] = (time.monotonic(), [])


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


async def test_create_invalidates_engine_cache(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    _prime_cache()
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    assert resp.status_code == 201, resp.text
    assert engine._cache == {}


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


async def test_put_invalidates_engine_cache(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    rule_id = resp.json()["id"]

    _prime_cache()
    resp = await client.put(f"/status-rules/{rule_id}", headers=hdrs,
                            json=_body())
    assert resp.status_code == 200, resp.text
    assert engine._cache == {}


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


async def test_patch_toggle_invalidates_engine_cache(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    rule_id = resp.json()["id"]

    _prime_cache()
    resp = await client.patch(f"/status-rules/{rule_id}", headers=hdrs,
                              json={"enabled": False})
    assert resp.status_code == 200, resp.text
    assert engine._cache == {}


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


async def test_delete_invalidates_engine_cache(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    rule_id = resp.json()["id"]

    _prime_cache()
    resp = await client.delete(f"/status-rules/{rule_id}", headers=hdrs)
    assert resp.status_code == 204
    assert engine._cache == {}


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

    # Every condition field says whether it can be empty, as a real boolean. Of the yes/no
    # fields only the asset's has_rails can (its column is nullable): the rule editor offers
    # the empty checks there and "equals" alone on the off-move flag.
    fields = {f["key"]: f for f in data["condition_fields"]}
    assert set(fields) == set(CONDITION_FIELDS)
    assert all(isinstance(f["nullable"], bool) for f in fields.values())
    assert (fields["asset.has_rails"]["type"], fields["asset.has_rails"]["nullable"]) == (
        "bool", True)
    assert (fields["scan.off_move"]["type"], fields["scan.off_move"]["nullable"]) == (
        "bool", False)
    assert [key for key, f in fields.items() if f["nullable"]] == ["asset.has_rails"]

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

    now = datetime.now(UTC)
    matched = StatusRuleExecution(
        rule_id=rule_id, rule_name="Into cage",
        processed_scan_id=scan.id, conditions_met=True,
        actions_applied=[{"action_type": "set_asset_status"}],
        error=None, duration_ms=12, executed_at=now - timedelta(seconds=60))
    errored = StatusRuleExecution(
        rule_id=None, rule_name="Broken rule",
        processed_scan_id=None, conditions_met=False,
        actions_applied=[], error="boom", duration_ms=3, executed_at=now)
    db.add_all([matched, errored])
    await db.commit()

    resp = await client.get("/status-rules/executions", headers=hdrs)
    assert resp.status_code == 200, resp.text
    items = resp.json()
    assert len(items) == 2
    # newest first — errored is newer (executed_at=now), matched is older (executed_at=now-60s)
    assert items[0]["id"] == errored.id
    assert items[1]["id"] == matched.id

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


# ── the people and groups a rule notifies, by name ───────────────────

async def _recipients(db):
    """A person (known by her preferred name) and a notification group, for a rule to name."""
    person = Person(first_name="Patricia", last_name="Doe", preferred_name="Pat")
    group = NotificationGroup(name="Night shift")
    db.add_all([person, group])
    await db.commit()
    return person, group


def _names(person, group) -> dict[str, str]:
    """What a rule that names this person and group answers in `names`."""
    return {str(person.id): person.display_name, str(group.id): group.name}


def _notify(people=(), groups=()) -> dict:
    """A Notify action as a rule saves it, naming these people and groups (by id)."""
    return {"action_type": "notify",
            "params": {"people": [str(p) for p in people], "groups": [str(g) for g in groups],
                       "watchers": False}}


async def test_rule_names_its_notify_people_and_groups(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    person, group = await _recipients(db)
    resp = await client.post("/status-rules", headers=hdrs, json=_body(
        actions=[_notify([person.id], [group.id])]))
    assert resp.status_code == 201, resp.text
    rule_id = resp.json()["id"]
    names = _names(person, group)
    assert names == {str(person.id): "Pat Doe", str(group.id): "Night shift"}

    resp = await client.get(f"/status-rules/{rule_id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["names"] == names
    resp = await client.get("/status-rules", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert [rule["names"] for rule in resp.json()] == [names]

    # each rule answers its own: another rule's recipients are not in it
    other = Person(first_name="Sam", last_name="Roe")
    db.add(other)
    await db.commit()
    resp = await client.post("/status-rules", headers=hdrs, json=_body(
        name="Second rule", actions=[_notify([other.id])]))
    assert resp.status_code == 201, resp.text
    assert resp.json()["names"] == {str(other.id): "Sam Roe"}
    resp = await client.get("/status-rules", headers=hdrs)
    by_name = {rule["name"]: rule["names"] for rule in resp.json()}
    assert by_name == {"Into cage": names, "Second rule": {str(other.id): "Sam Roe"}}


async def test_rule_names_on_save(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    person, group = await _recipients(db)
    names = _names(person, group)
    body = _body(actions=[_notify([person.id], [group.id])])

    resp = await client.post("/status-rules", headers=hdrs, json=body)
    assert resp.status_code == 201, resp.text
    assert resp.json()["names"] == names
    rule_id = resp.json()["id"]

    resp = await client.put(f"/status-rules/{rule_id}", headers=hdrs,
                            json={**body, "name": "Renamed"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["names"] == names

    resp = await client.patch(f"/status-rules/{rule_id}", headers=hdrs,
                              json={"enabled": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["names"] == names

    # a replace answers what it saved: the group dropped off, so did its name
    resp = await client.put(f"/status-rules/{rule_id}", headers=hdrs, json={
        **body, "actions": [_notify([person.id])]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["names"] == {str(person.id): person.display_name}


async def test_rule_without_notify_has_no_names(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post("/status-rules", headers=hdrs, json=_body())
    assert resp.status_code == 201, resp.text
    assert resp.json()["names"] == {}
    rule_id = resp.json()["id"]

    resp = await client.get(f"/status-rules/{rule_id}", headers=hdrs)
    assert resp.json()["names"] == {}
    resp = await client.get("/status-rules", headers=hdrs)
    assert [rule["names"] for rule in resp.json()] == [{}]


async def test_rule_names_leave_out_unknown_ids(client, db, seeded_user):
    """Saving refuses a person or group that doesn't exist, but one can go after the save (a
    group is deleted). The rule still loads, and the id just has no name. So does a saved value
    that is no id at all (the API never writes one): the page where rules get fixed must open."""
    hdrs = await login_admin(client, db, seeded_user)
    person, group = await _recipients(db)
    gone = {"people": [str(uuid.uuid4()), "not-an-id"], "groups": [str(uuid.uuid4())],
            "watchers": False}
    mixed = {"people": [str(person.id), str(uuid.uuid4())],
             "groups": [str(uuid.uuid4()), str(group.id)], "watchers": False}
    db.add_all([_rule("Gone", actions=[("notify", gone)]),
                _rule("Mixed", actions=[("notify", mixed)])])
    await db.commit()

    resp = await client.get("/status-rules", headers=hdrs)
    assert resp.status_code == 200, resp.text
    by_name = {rule["name"]: rule for rule in resp.json()}
    assert by_name["Gone"]["names"] == {}
    assert by_name["Mixed"]["names"] == _names(person, group)
    resp = await client.get(f"/status-rules/{by_name['Gone']['id']}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["names"] == {}


async def test_rule_names_for_a_status_rules_viewer(client, db, seeded_user):
    """Staff may view status rules and nothing of notifications, so they can't list the people
    or the groups to name a rule's recipients from. The rule says who they are."""
    person, group = await _recipients(db)
    db.add(_rule("Tells people",
                 actions=[("notify", _notify([person.id], [group.id])["params"])]))
    await db.commit()
    hdrs = await login_staff(client, seeded_user)
    assert (await client.get("/notifications/recipients", headers=hdrs)).status_code == 403
    assert (await client.get("/notifications/groups", headers=hdrs)).status_code == 403

    resp = await client.get("/status-rules", headers=hdrs)
    assert resp.status_code == 200, resp.text
    [rule] = resp.json()
    assert rule["names"] == _names(person, group)
    resp = await client.get(f"/status-rules/{rule['id']}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["names"] == _names(person, group)


async def test_rule_names_are_looked_up_once_for_the_whole_list(client, db, seeded_user):
    """Listing many rules reads their people once and their groups once, not once per rule:
    three rules cost no more statements than one."""
    hdrs = await login_admin(client, db, seeded_user)
    sync_engine = get_engine().sync_engine
    statements: list[str] = []

    def record(conn, cursor, statement, *rest):
        statements.append(statement)

    async def add_rule(tag: str):
        person = Person(first_name=tag, last_name="Doe")
        group = NotificationGroup(name=f"Group {tag}")
        db.add_all([person, group])
        await db.commit()
        resp = await client.post("/status-rules", headers=hdrs, json=_body(
            name=f"Rule {tag}", actions=[_notify([person.id], [group.id])]))
        assert resp.status_code == 201, resp.text

    async def list_rules(expected: int) -> int:
        statements.clear()
        event.listen(sync_engine, "before_cursor_execute", record)
        try:
            resp = await client.get("/status-rules", headers=hdrs)
        finally:
            event.remove(sync_engine, "before_cursor_execute", record)
        assert resp.status_code == 200, resp.text
        assert len(resp.json()) == expected
        assert all(len(rule["names"]) == 2 for rule in resp.json())
        return len(statements)

    await add_rule("A")
    one = await list_rules(1)
    await add_rule("B")
    await add_rule("C")
    assert await list_rules(3) == one
