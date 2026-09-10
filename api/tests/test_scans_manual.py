"""Manual status edits recorded as processed scans (spec 2026-09-03)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Asset, Initiative, InitiativeAsset, Person, ProcessedScan,
    StatusRuleExecution,
)
from serversherpa.scans.manual import (
    PORTAL_DEVICE_ID, SOURCE_INITIATIVE_ASSET_EDIT, record_status_edit,
)
from serversherpa.status_rules.engine import RuleExecutionError, invalidate_cache

from tests.test_status_rules_engine import _rule


@pytest.fixture(autouse=True)
def _fresh_cache():
    invalidate_cache()
    yield
    invalidate_cache()


async def _setup(db, *, serial="SN-42", asset_status="active"):
    editor = Person(first_name="Eddie", last_name="Editor")
    asset = Asset(serial_number=serial, name="srv-1", status=asset_status)
    move = Initiative(name="Move", initiative_type="move", status="planned")
    db.add_all([editor, asset, move])
    await db.flush()
    assoc = InitiativeAsset(initiative_id=move.id, asset_id=asset.id,
                            status="in_transit")
    db.add(assoc)
    await db.flush()
    return editor, asset, move, assoc


async def test_records_a_manual_scan_with_the_editor(db):
    editor, asset, _move, assoc = await _setup(db)
    before = datetime.now(UTC)
    scan = await record_status_edit(db, assoc=assoc, asset=asset,
                                    status="in_transit",
                                    actor_person_id=editor.id)
    await db.commit()

    row = (await db.scalars(select(ProcessedScan))).one()
    assert row.id == scan.id
    assert row.scanned_value == "SN-42"
    assert row.scan_type == "manual"
    assert row.status == "in_transit"
    assert row.scanned_at == row.processed_at >= before
    assert row.device_id == PORTAL_DEVICE_ID == "portal"
    assert row.operator_id == editor.id
    assert row.site_id is None and row.location_detail == ""
    assert row.source == SOURCE_INITIATIVE_ASSET_EDIT == "initiative_asset_edit"
    assert row.raw_scan_id is None
    assert row.match_type == "asset" and row.asset_id == asset.id
    assert asset.last_seen_at is None            # not a presence read


async def test_falls_back_to_the_asset_id_without_a_serial(db):
    editor, asset, _move, assoc = await _setup(db, serial=None)
    await record_status_edit(db, assoc=assoc, asset=asset, status="in_transit",
                             actor_person_id=editor.id)
    await db.commit()
    row = (await db.scalars(select(ProcessedScan))).one()
    assert row.scanned_value == str(asset.id)


async def test_runs_rules_against_the_edited_initiative(db):
    editor, asset, _move, assoc = await _setup(db)
    db.add(_rule("Stage it", status="in_transit", actions=(
        ("set_asset_status", {"status": "in_storage"}),
        ("set_initiative_asset_status", {"status": "loaded_in_system"}),)))
    await db.flush()
    await record_status_edit(db, assoc=assoc, asset=asset, status="in_transit",
                             actor_person_id=editor.id)
    await db.commit()
    assert asset.status == "in_storage"
    assert assoc.status == "loaded_in_system"
    ex = (await db.scalars(select(StatusRuleExecution))).one()
    assert ex.conditions_met is True and ex.error is None


async def test_rule_failure_propagates(db):
    editor, asset, _move, assoc = await _setup(db)
    db.add(_rule("Broken", status="in_transit", actions=(
        ("set_asset_status", {"status": "no-such-status"}),)))
    await db.flush()
    with pytest.raises(RuleExecutionError) as exc:
        await record_status_edit(db, assoc=assoc, asset=asset, status="in_transit",
                                 actor_person_id=editor.id)
    assert exc.value.rule_name == "Broken"
