"""Off-move sightings and the rule engine. An off-move sighting (an RFID
read of an asset from another of the client's moves) used to skip the
rules entirely. Now it runs exactly the enabled rules that ask for it with
an "Off-move sighting equals true" condition, in the station's move; every
other rule still skips it. The engine also tells each rule's actions which
rule is running (Context.rule_id / rule_name)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, Container, Initiative, InitiativeAsset, ProcessedScan, RawScan,
    StatusRule, StatusRuleAction, StatusRuleCondition, StatusRuleExecution,
)
from serversherpa.scans import worker
from serversherpa.status_rules.catalog import (
    ACTIONS, CONDITION_FIELDS, ActionDef, ActionOutcome, validate_condition,
)
from serversherpa.status_rules.context import Context
from serversherpa.status_rules.engine import apply_rules, invalidate_cache

STATUS = "rfid_4_into_cage"
ASKS = ("scan.off_move", "equals", "true")


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    invalidate_cache()
    monkeypatch.setattr(worker, "_last_sweep", None)
    yield
    invalidate_cache()


@pytest.fixture
def seen(monkeypatch):
    """A recording action, "spy": one entry for every rule whose actions
    ran, with what that rule's context held at the time."""
    calls: list[dict] = []

    async def apply(db, ctx, params):
        calls.append({
            "rule_id": ctx.rule_id, "rule_name": ctx.rule_name,
            "initiative_id": ctx.initiative.id if ctx.initiative else None,
            "initiative_asset": ctx.initiative_asset})
        return ActionOutcome(True)

    monkeypatch.setitem(ACTIONS, "spy", ActionDef("spy", "Spy", (), apply))
    return calls


def _rule(name, *, priority=10, conditions=(), actions=(("spy", {}),),
          match="asset"):
    r = StatusRule(name=name, trigger_status=STATUS, trigger_match_type=match,
                   priority=priority, enabled=True)
    for i, (atype, params) in enumerate(actions, 1):
        r.actions.append(StatusRuleAction(position=i, action_type=atype,
                                          params=params))
    for i, (f, op, v) in enumerate(conditions, 1):
        r.conditions.append(StatusRuleCondition(position=i, field=f,
                                                operator=op, value=v))
    return r


async def _scene(db):
    """The station's move, the other in-progress move the asset really
    belongs to (what the engine would guess), and the asset."""
    station = Initiative(name="Station move", initiative_type="move",
                         status="in_progress")
    elsewhere = Initiative(name="Elsewhere", initiative_type="move",
                           status="in_progress",
                           scheduled_start=datetime.now(UTC))
    asset = Asset(serial_number="SN-OFF", status="unknown")
    db.add_all([station, elsewhere, asset])
    await db.flush()
    db.add(InitiativeAsset(initiative_id=elsewhere.id, asset_id=asset.id,
                           status="loaded_in_system"))
    await db.flush()
    return station, elsewhere, asset


async def _scan(db, asset, *, off_move=False):
    s = ProcessedScan(scanned_value="V", scan_type="rfid", status=STATUS,
                      scanned_at=datetime.now(UTC),
                      processed_at=datetime.now(UTC), device_id="dock-1",
                      match_type="asset", asset_id=asset.id,
                      off_move=off_move)
    db.add(s)
    await db.flush()
    return s


async def _runs(db, scan):
    rows = (await db.scalars(
        select(StatusRuleExecution)
        .where(StatusRuleExecution.processed_scan_id == scan.id)
        .order_by(StatusRuleExecution.id))).all()
    return [(r.rule_name, r.conditions_met) for r in rows]


def _raw(*, off_move, initiative_id=None):
    return RawScan(scanned_value="SN-OFF", scan_type="rfid", status=STATUS,
                   scanned_at=datetime.now(UTC), off_move=off_move,
                   initiative_id=initiative_id)


# ── the condition field ──────────────────────────────────────────────


def test_off_move_is_a_condition_field():
    field = CONDITION_FIELDS["scan.off_move"]
    assert (field.label, field.type, field.options_source) == (
        "Off-move sighting", "bool", None)
    keys = list(CONDITION_FIELDS)
    # appended after the scan fields, before the asset's
    assert keys[keys.index("scan.operator_id") + 1] == "scan.off_move"
    assert keys[keys.index("scan.off_move") + 1] == "asset.status"
    assert validate_condition("scan.off_move", "equals", "true") is None


# ── which rules an off-move sighting runs ────────────────────────────


async def test_off_move_sightings_run_only_rules_that_ask(db, seen):
    station, elsewhere, asset = await _scene(db)
    db.add_all([
        _rule("Asks", priority=10, conditions=(ASKS,)),
        _rule("Silent", priority=20),
        _rule("Reads only", priority=30,
              conditions=(("scan.off_move", "equals", "false"),)),
    ])
    await db.flush()

    sighting = await _scan(db, asset, off_move=True)
    assert await apply_rules(
        db, sighting, off_move_initiative_id=station.id) == 1
    assert await _runs(db, sighting) == [("Asks", True)]
    execution = (await db.scalars(select(StatusRuleExecution))).one()
    assert execution.actions_applied == [
        {"action_type": "spy", "applied": True}]
    # the rule ran in the station's move, not the one the asset belongs to
    assert [(c["rule_name"], c["initiative_id"]) for c in seen] == [
        ("Asks", station.id)]
    assert seen[0]["initiative_asset"] is None      # a sighting has no roster row

    # The same read, not off-move: all three are evaluated as today, the
    # asking rule is unmet, and the move is still the engine's in-progress
    # guess (the station's move is for sightings only).
    seen.clear()
    read = await _scan(db, asset)
    assert await apply_rules(
        db, read, off_move_initiative_id=station.id) == 3
    assert await _runs(db, read) == [
        ("Asks", False), ("Silent", True), ("Reads only", True)]
    assert [(c["rule_name"], c["initiative_id"]) for c in seen] == [
        ("Silent", elsewhere.id), ("Reads only", elsewhere.id)]


async def test_existing_rules_still_skip_off_move(db, seen):
    station, _, asset = await _scene(db)
    db.add_all([
        _rule("Plain"),
        _rule("Device", conditions=(("scan.device_id", "equals", "dock-1"),)),
        _rule("Reads only",
              conditions=(("scan.off_move", "equals", "false"),)),
    ])
    await db.flush()
    sighting = await _scan(db, asset, off_move=True)

    assert await apply_rules(
        db, sighting, off_move_initiative_id=station.id) == 0
    assert (await db.scalars(select(StatusRuleExecution))).all() == []
    assert seen == []


@pytest.mark.parametrize("operator, value, asks", [
    ("equals", "true", True),
    ("equals", "True", True),
    ("equals", "TRUE", True),
    ("equals", "false", False),
    ("not_equals", "false", False),
    ("not_equals", "true", False),
    ("contains", "true", False),
    ("is_not_null", None, False),
])
async def test_only_equals_true_asks(db, seen, operator, value, asks):
    station, _, asset = await _scene(db)
    db.add(_rule("Candidate", conditions=(("scan.off_move", operator, value),)))
    await db.flush()
    sighting = await _scan(db, asset, off_move=True)

    n = await apply_rules(db, sighting, off_move_initiative_id=station.id)
    assert n == (1 if asks else 0)
    assert [c["rule_name"] for c in seen] == (["Candidate"] if asks else [])


async def test_an_asking_rule_still_needs_its_other_conditions(db, seen):
    station, _, asset = await _scene(db)
    db.add(_rule("Asks, wrong device", conditions=(
        ASKS, ("scan.device_id", "equals", "dock-9"))))
    await db.flush()
    sighting = await _scan(db, asset, off_move=True)

    assert await apply_rules(
        db, sighting, off_move_initiative_id=station.id) == 1
    assert await _runs(db, sighting) == [("Asks, wrong device", False)]
    assert seen == []


# ── the rule's initiative ────────────────────────────────────────────


async def test_a_sighting_without_a_station_move_has_no_initiative(db, seen):
    _, _, asset = await _scene(db)     # the asset is in another in-progress move
    db.add(_rule("Asks", conditions=(ASKS,)))
    await db.flush()
    sighting = await _scan(db, asset, off_move=True)

    assert await apply_rules(db, sighting) == 1
    assert [c["initiative_id"] for c in seen] == [None]   # no in-progress guess


async def test_a_container_sighting_gets_the_stations_move(db, seen):
    station, _, _ = await _scene(db)
    crate = Container(name="crate-7")
    db.add(crate)
    db.add(_rule("Asks", match="container", conditions=(ASKS,)))
    await db.flush()
    sighting = ProcessedScan(
        scanned_value="V", scan_type="rfid", status=STATUS,
        scanned_at=datetime.now(UTC), processed_at=datetime.now(UTC),
        device_id="dock-1", match_type="container", container_id=crate.id,
        off_move=True)
    db.add(sighting)
    await db.flush()

    assert await apply_rules(
        db, sighting, off_move_initiative_id=station.id) == 1
    assert [c["initiative_id"] for c in seen] == [station.id]


# ── the context carries the rule ─────────────────────────────────────


def test_context_rule_defaults_to_none():
    ctx = Context(scan=None)
    assert ctx.rule_id is None and ctx.rule_name is None


async def test_context_carries_the_rule(db, seen):
    _, _, asset = await _scene(db)
    first = _rule("First", priority=5)
    gated = _rule("Gated", priority=7, conditions=(
        ("scan.device_id", "equals", "dock-9"),))
    second = _rule("Second", priority=10)
    db.add_all([first, gated, second])
    await db.flush()
    scan = await _scan(db, asset)

    assert await apply_rules(db, scan) == 3
    # each rule's actions see their own rule, never a previous one's; the
    # unmet rule's actions never ran
    assert [(c["rule_id"], c["rule_name"]) for c in seen] == [
        (first.id, "First"), (second.id, "Second")]


# ── the scan worker ──────────────────────────────────────────────────


async def test_worker_runs_the_asking_rules_for_a_sighting(db, seen):
    station, _, asset = await _scene(db)
    db.add_all([_rule("Asks", conditions=(ASKS,)), _rule("Silent")])
    raw = _raw(off_move=True, initiative_id=station.id)
    db.add(raw)
    await db.commit()

    assert await worker.process_raw_scan(get_sessionmaker(), raw.id) == "matched"

    async with get_sessionmaker()() as check:
        sighting = (await check.scalars(select(ProcessedScan))).one()
        assert sighting.off_move is True and sighting.asset_id == asset.id
        runs = (await check.scalars(select(StatusRuleExecution))).all()
        assert [(r.rule_name, r.conditions_met, r.processed_scan_id)
                for r in runs] == [("Asks", True, sighting.id)]
        assert (await check.scalars(select(RawScan))).all() == []
        assert (await check.get(Asset, asset.id)).last_seen_at is not None
    # the station's move, not the one the asset belongs to
    assert [(c["rule_name"], c["initiative_id"]) for c in seen] == [
        ("Asks", station.id)]


async def test_worker_normal_scan_keeps_its_in_progress_move(db, seen):
    station, elsewhere, _ = await _scene(db)
    db.add_all([_rule("Asks", priority=10, conditions=(ASKS,)),
                _rule("Silent", priority=20)])
    raw = _raw(off_move=False, initiative_id=station.id)
    db.add(raw)
    await db.commit()

    assert await worker.process_raw_scan(get_sessionmaker(), raw.id) == "matched"

    async with get_sessionmaker()() as check:
        read = (await check.scalars(select(ProcessedScan))).one()
        runs = (await check.scalars(select(StatusRuleExecution)
                                    .order_by(StatusRuleExecution.id))).all()
        assert [(r.rule_name, r.conditions_met, r.processed_scan_id)
                for r in runs] == [("Asks", False, read.id),
                                   ("Silent", True, read.id)]
    assert [(c["rule_name"], c["initiative_id"]) for c in seen] == [
        ("Silent", elsewhere.id)]


async def test_worker_a_failing_off_move_rule_rolls_the_sighting_back(db):
    asset = Asset(serial_number="SN-OFF", status="unknown")
    rule = _rule("Boom", conditions=(ASKS,), actions=(
        ("set_asset_status", {"status": "not-a-key"}),))
    raw = _raw(off_move=True)
    db.add_all([asset, rule, raw])
    await db.commit()

    assert await worker.process_raw_scan(get_sessionmaker(), raw.id) == "error"

    async with get_sessionmaker()() as check:
        left = (await check.scalars(select(RawScan))).one()    # still raw
        assert left.match_attempted_at is not None
        assert (await check.scalars(select(ProcessedScan))).all() == []
        assert (await check.get(Asset, asset.id)).status == "unknown"
        failure = (await check.scalars(select(StatusRuleExecution))).one()
        assert failure.rule_name == "Boom" and failure.error is not None
        assert failure.processed_scan_id is None
