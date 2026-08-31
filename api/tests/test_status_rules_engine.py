"""Engine orchestration: trigger selection, priority order, AND
conditions, execution logging (met and not-met), per-action skips,
NULL-status short-circuit, active-initiative resolution, cache TTL,
and RuleExecutionError wrapping."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Asset, Container, ContainerAsset, Initiative, InitiativeAsset,
    ProcessedScan, StatusRule, StatusRuleAction, StatusRuleCondition,
    StatusRuleExecution,
)
from serversherpa.status_rules import engine
from serversherpa.status_rules.engine import (
    RuleExecutionError, apply_rules, invalidate_cache,
)


@pytest.fixture(autouse=True)
def _fresh_cache():
    invalidate_cache()
    yield
    invalidate_cache()


def _rule(name, *, status="rfid_4_into_cage", match="asset", priority=10,
          enabled=True, actions=(), conditions=()):
    r = StatusRule(name=name, trigger_status=status,
                   trigger_match_type=match, priority=priority,
                   enabled=enabled)
    for i, (atype, params) in enumerate(actions, 1):
        r.actions.append(StatusRuleAction(position=i, action_type=atype,
                                          params=params))
    for i, (f, op, v) in enumerate(conditions, 1):
        r.conditions.append(StatusRuleCondition(position=i, field=f,
                                                operator=op, value=v))
    return r


async def _asset_scan(db, asset, *, status="rfid_4_into_cage",
                      device="dock-1"):
    s = ProcessedScan(scanned_value="V", scan_type="rfid", status=status,
                      scanned_at=datetime.now(UTC),
                      processed_at=datetime.now(UTC), device_id=device,
                      match_type="asset", asset_id=asset.id)
    db.add(s)
    await db.flush()
    return s


async def test_matching_rule_fires_and_logs(db):
    a = Asset(status="unknown")
    db.add(a)
    db.add(_rule("Cage", actions=(
        ("set_asset_status", {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)

    n = await apply_rules(db, scan)
    await db.commit()

    assert n == 1
    assert a.status == "rfid_4_into_cage"
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.conditions_met is True
    assert ex.processed_scan_id == scan.id
    assert ex.actions_applied == [
        {"action_type": "set_asset_status", "applied": True}]


async def test_null_status_and_wrong_trigger_skip_engine(db):
    a = Asset()
    db.add(a)
    db.add(_rule("Cage", actions=(
        ("set_asset_status", {"status": "rfid_4_into_cage"}),)))
    db.add(_rule("Other status", status="rfid_1_cage_exit", actions=(
        ("set_asset_status", {"status": "rfid_1_cage_exit"}),)))
    db.add(_rule("Container trigger", match="container", actions=(
        ("set_container_status", {"status": "available"}),)))
    await db.flush()
    bare = await _asset_scan(db, a, status=None)
    assert await apply_rules(db, bare) == 0

    scan = await _asset_scan(db, a)
    invalidate_cache()
    assert await apply_rules(db, scan) == 1     # only "Cage"


async def test_disabled_rule_does_not_fire(db):
    a = Asset()
    db.add(a)
    db.add(_rule("Off", enabled=False, actions=(
        ("set_asset_status", {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 0


async def test_priority_orders_execution(db):
    a = Asset(status="unknown")
    db.add(a)
    db.add(_rule("Second", priority=20, actions=(
        ("set_asset_status", {"status": "rfid_10_dock_to_truck"}),)))
    db.add(_rule("First", priority=5, actions=(
        ("set_asset_status", {"status": "rfid_1_cage_exit"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 2
    assert a.status == "rfid_10_dock_to_truck"   # later priority wins last write


async def test_failed_condition_logs_but_skips_actions(db):
    a = Asset(status="unknown")
    db.add(a)
    db.add(_rule("Gated", conditions=(("scan.device_id", "equals", "dock-9"),),
                 actions=(("set_asset_status",
                           {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    scan = await _asset_scan(db, a, device="dock-1")
    assert await apply_rules(db, scan) == 1
    assert a.status == "unknown"
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.conditions_met is False
    assert ex.actions_applied == []


async def test_active_initiative_resolved_for_asset_match(db):
    a = Asset()
    db.add(a)
    live = Initiative(name="Live", initiative_type="move",
                      status="in_progress",
                      scheduled_start=datetime.now(UTC))
    stale = Initiative(name="Planned", initiative_type="move",
                       status="planned")
    archived = Initiative(name="Archived", initiative_type="move",
                          status="in_progress",
                          archived_at=datetime.now(UTC),
                          scheduled_start=datetime.now(UTC))
    db.add_all([live, stale, archived])
    await db.flush()
    db.add(InitiativeAsset(initiative_id=live.id, asset_id=a.id,
                           status="loaded_in_system"))
    db.add(InitiativeAsset(initiative_id=stale.id, asset_id=a.id,
                           status="loaded_in_system"))
    db.add(InitiativeAsset(initiative_id=archived.id, asset_id=a.id,
                           status="loaded_in_system"))
    db.add(_rule("Roster", actions=(
        ("set_initiative_asset_status", {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 1
    rows = (await db.scalars(select(InitiativeAsset).where(
        InitiativeAsset.initiative_id == live.id))).one()
    assert rows.status == "rfid_4_into_cage"
    archived_rows = (await db.scalars(select(InitiativeAsset).where(
        InitiativeAsset.initiative_id == archived.id))).one()
    assert archived_rows.status == "loaded_in_system"


async def test_missing_context_action_is_recorded_skip(db):
    a = Asset()
    db.add(a)
    db.add(_rule("Roster only", actions=(
        ("set_initiative_asset_status", {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 1
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.actions_applied == [
        {"action_type": "set_initiative_asset_status", "applied": False,
         "reason": "no_active_initiative"}]


async def test_action_error_raises_rule_execution_error(db):
    a = Asset()
    db.add(a)
    db.add(_rule("Boom", actions=(
        ("set_asset_status", {"status": "not-a-real-status-key"}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    with pytest.raises(RuleExecutionError) as err:
        await apply_rules(db, scan)
        await db.commit()     # FK fires at flush inside apply_rules or here
    assert err.value.rule_name == "Boom"


async def test_cache_serves_stale_until_ttl(db, monkeypatch):
    a = Asset()
    db.add(a)
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 0     # cache now holds "no rules"

    db.add(_rule("New", actions=(
        ("set_asset_status", {"status": "rfid_4_into_cage"}),)))
    await db.flush()
    assert await apply_rules(db, scan) == 0     # still cached

    monkeypatch.setattr(engine, "RULE_CACHE_SECONDS", 0)
    assert await apply_rules(db, scan) == 1


async def test_asset_context_resolves_containing_container(db):
    a = Asset()
    c = Container(name="crate-7")
    db.add_all([a, c])
    await db.flush()
    db.add(ContainerAsset(container_id=c.id, asset_id=a.id))
    db.add(_rule("Pack location", status="rfid_4_into_cage", actions=(
        ("set_asset_location_from_container", {}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 1
    assert a.location_detail == "crate-7"


async def test_asset_context_without_container_skips(db):
    a = Asset()
    db.add(a)
    db.add(_rule("Pack location", status="rfid_4_into_cage", actions=(
        ("set_asset_location_from_container", {}),)))
    await db.flush()
    scan = await _asset_scan(db, a)
    assert await apply_rules(db, scan) == 1
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.actions_applied == [
        {"action_type": "set_asset_location_from_container",
         "applied": False, "reason": "not_in_container"}]
