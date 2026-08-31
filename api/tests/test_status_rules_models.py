"""Status-rules storage: migration 0035 tables, relationships, FK
enforcement, cascade behavior, and the raw_scans attempt column."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    RawScan, StatusRule, StatusRuleAction, StatusRuleCondition,
    StatusRuleExecution,
)


def _rule(**over):
    base = dict(name="Into cage", trigger_status="rfid_4_into_cage",
                trigger_match_type="asset", priority=10, enabled=True)
    base.update(over)
    return StatusRule(**base)


async def test_rule_with_children_round_trips(db):
    rule = _rule()
    rule.conditions.append(StatusRuleCondition(
        position=1, field="scan.device_id", operator="equals", value="dock-1"))
    rule.actions.append(StatusRuleAction(
        position=1, action_type="set_asset_status",
        params={"status": "rfid_4_into_cage"}))
    db.add(rule)
    await db.commit()

    got = await db.scalar(select(StatusRule).where(StatusRule.id == rule.id))
    assert got.trigger_status == "rfid_4_into_cage"
    assert got.conditions[0].operator == "equals"
    assert got.actions[0].params == {"status": "rfid_4_into_cage"}


async def test_children_cascade_on_rule_delete(db):
    rule = _rule()
    rule.actions.append(StatusRuleAction(
        position=1, action_type="set_asset_status", params={"status": "unknown"}))
    db.add(rule)
    await db.commit()
    await db.delete(rule)
    await db.commit()
    assert (await db.scalars(select(StatusRuleAction))).all() == []


async def test_trigger_status_fk_rejects_unknown_key(db):
    db.add(_rule(trigger_status="not-a-status"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_execution_survives_rule_delete_with_name(db):
    rule = _rule()
    db.add(rule)
    await db.commit()
    db.add(StatusRuleExecution(
        rule_id=rule.id, rule_name=rule.name, processed_scan_id=None,
        conditions_met=True, actions_applied=[], duration_ms=3))
    await db.commit()
    await db.delete(rule)
    await db.commit()
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.rule_id is None
    assert ex.rule_name == "Into cage"


async def test_raw_scan_match_attempted_at(db):
    scan = RawScan(scanned_value="SN-1", scan_type="rfid",
                   scanned_at=datetime.now(UTC))
    db.add(scan)
    await db.commit()
    assert scan.match_attempted_at is None
    scan.match_attempted_at = datetime.now(UTC)
    await db.commit()
