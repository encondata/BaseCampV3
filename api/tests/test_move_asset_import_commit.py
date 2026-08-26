"""Commit pass: per-row writes, RFID, collisions, audit, batching, cancel."""

import json
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, AuditLog, Initiative,
    InitiativeAsset,
)
from serversherpa.imports import move_assets
from serversherpa.imports.move_assets import (
    flag_collisions, parse_row, run_import,
)
from serversherpa.imports.parsing import CANONICAL


async def _move(db):
    ini = Initiative(name="Move C", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    return ini


def _row(n, **over):
    canonical = {c: "" for c in CANONICAL}
    canonical.update(over)
    return parse_row(n, canonical, dict(over), generate_serials=False)


async def test_commit_creates_models_assets_and_roster(db):
    ini = await _move(db)
    model = AssetModel(make="Dell", model="R740", ru_size=2)
    db.add(model)
    await db.commit()

    rows = [
        _row(2, serial_number="SN-1", asset_make="Dell", asset_model="R740",
             priority="Wave 1", source_rack="A1", source_ru="10",
             source_position="Front",
             destination_rack="B1", destination_ru="20",
             destination_position="Rear", data_1="sw1",
             vendor_involvement="y"),
        _row(3, serial_number="SN-2", asset_make="Ghost", asset_model="GX-1"),
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, make_model_mode="hybrid",
                              write=True, source_label="test-file.csv")
    assert result["summary"]["created"] == 2
    assert result["summary"]["models_created"] == 1
    assert result["summary"]["collisions_flagged"] == 0

    a1 = await db.scalar(select(Asset).where(Asset.serial_number == "sn-1"))
    assert a1.model_id == model.id
    assert a1.source == "import"
    ghost = await db.scalar(select(AssetModel).where(
        AssetModel.make == "Ghost"))
    assert ghost is not None and "FORCED" in ghost.knowledge

    assoc = await db.scalar(select(InitiativeAsset).where(
        InitiativeAsset.asset_id == a1.id))
    assert assoc.priority_wave == "Wave 1"
    assert assoc.source_ru == Decimal("10")
    assert assoc.source_position == "Front"
    assert assoc.destination_position == "Rear"
    assert assoc.status == "loaded_in_system"
    assert assoc.vendor_involved is True
    assert json.loads(assoc.cable_info) == {"data_1": "sw1"}
    assert assoc.raw_ft["serial_number"] == "SN-1"

    # ONE summary audit row, not one per asset
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "asset_import"))).all()
    assert len(audits) == 1
    assert audits[0].changes["created"] == 2
    assert audits[0].changes["source"] == "test-file.csv"


async def test_reimport_updates_and_resets_status(db):
    ini = await _move(db)
    rows = [_row(2, serial_number="SN-R", destination_rack="B1",
                 destination_ru="5")]
    await run_import(db, initiative_id=ini.id, added_by=None, rows=rows,
                     write=True)
    assoc = await db.scalar(select(InitiativeAsset).where(
        InitiativeAsset.initiative_id == ini.id))
    assoc.status = "complete"
    assoc.destination_rack = "OLD"
    await db.commit()

    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    assert result["summary"] == {
        "total_rows": 1, "processed_rows": 1, "created": 0, "updated": 1,
        "review": 0, "errors": 0, "collisions_flagged": 0}
    await db.refresh(assoc)
    assert assoc.status == "loaded_in_system"       # v2 parity reset
    assert assoc.destination_rack == "B1"
    # no duplicate asset or roster row
    assert await db.scalar(select(func.count()).select_from(Asset)) == 1
    assert await db.scalar(
        select(func.count()).select_from(InitiativeAsset)) == 1


async def test_per_row_semantics_bad_rows_do_not_block(db):
    ini = await _move(db)
    rows = [
        _row(2, serial_number="SN-OK"),
        _row(3),                                            # error row
        _row(4, serial_number="SN-REV", asset_make="Nope",
             asset_model="NX"),                             # review (fuzzy)
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    assert result["summary"]["created"] == 1
    assert result["summary"]["errors"] == 1
    assert result["summary"]["review"] == 1
    assert await db.scalar(
        select(func.count()).select_from(InitiativeAsset)) == 1


async def test_rfid_written_and_conflicts_skipped(db):
    ini = await _move(db)
    holder = Asset(serial_number="sn-holder", rfid_tag="TAG-1")
    bare = Asset(serial_number="sn-bare")
    db.add_all([holder, bare])
    await db.commit()
    rows = [
        _row(2, serial_number="SN-NEW", rfid_tag="TAG-1"),   # conflict: skip
        _row(3, serial_number="SN-BARE", rfid_tag="TAG-9"),  # existing asset: write
    ]
    await run_import(db, initiative_id=ini.id, added_by=None, rows=rows,
                     write=True)
    created = await db.scalar(select(Asset).where(
        Asset.serial_number == "sn-new"))
    assert created.rfid_tag is None
    await db.refresh(bare)
    assert bare.rfid_tag == "TAG-9"


async def test_collision_detection_flags_overlaps(db):
    ini = await _move(db)
    model = AssetModel(make="Big", model="4U", ru_size=4)
    db.add(model)
    await db.commit()
    rows = [
        _row(2, serial_number="SN-A", asset_make="Big", asset_model="4U",
             destination_rack="R1", destination_ru="10"),    # RUs 10-13
        _row(3, serial_number="SN-B",
             destination_rack="R1", destination_ru="12"),    # RU 12 (size 1)
        _row(4, serial_number="SN-C",
             destination_rack="R1", destination_ru="30"),    # clear
        _row(5, serial_number="SN-D",
             destination_rack="R2", destination_ru="12"),    # other rack
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    assert result["summary"]["collisions_flagged"] == 2
    statuses = dict((await db.execute(
        select(Asset.serial_number, InitiativeAsset.status)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id))).all())
    assert statuses["sn-a"] == "location_collision"
    assert statuses["sn-b"] == "location_collision"
    assert statuses["sn-c"] == "loaded_in_system"
    assert statuses["sn-d"] == "loaded_in_system"


async def test_batching_progress_and_cancel(db, monkeypatch):
    monkeypatch.setattr(move_assets, "BATCH_SIZE", 2)
    ini = await _move(db)
    rows = [_row(n, serial_number=f"SN-{n}") for n in range(2, 8)]  # 6 rows
    seen = []

    async def progress(processed, created, updated, errors):
        seen.append(processed)

    async def cancel_after_first_batch() -> bool:
        return len(seen) >= 1

    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True, progress=progress,
                              is_cancelled=cancel_after_first_batch)
    assert result["cancelled"] is True
    assert result["summary"]["processed_rows"] == 2
    # first batch is durably committed
    assert await db.scalar(
        select(func.count()).select_from(InitiativeAsset)) == 2


async def test_batch_checkpoint_fires_when_boundary_is_error_row(db, monkeypatch):
    monkeypatch.setattr(move_assets, "BATCH_SIZE", 2)
    ini = await _move(db)
    canonical_err = {c: "" for c in CANONICAL}
    rows = [
        _row(2, serial_number="SN-1"),
        parse_row(3, canonical_err, {}, generate_serials=False),  # error row on the boundary
        _row(4, serial_number="SN-2"),
        _row(5, serial_number="SN-3"),
    ]
    seen = []

    async def progress(processed, created, updated, errors):
        seen.append((processed, errors))

    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True, progress=progress)
    # boundary at processed=2 lands on the error row — checkpoint must still fire
    assert (2, 1) in seen
    assert result["summary"]["created"] == 3


async def test_review_row_keeps_rfid_skip_note(db):
    ini = await _move(db)
    holder = Asset(serial_number="sn-holder", rfid_tag="TAG-R")
    db.add(holder)
    await db.commit()
    # fuzzy mode + unmatched make/model -> review row; conflicting RFID -> note
    rows = [_row(2, serial_number="SN-REV", asset_make="Nope",
                 asset_model="NX", rfid_tag="TAG-R")]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    [d] = result["details"]
    assert d["status"] == "review"
    assert "not found" in d["message"]
    assert "TAG-R" in d["message"] and "skipped" in d["message"]
