"""Validate pass: the full decision path with zero writes."""

import uuid

from sqlalchemy import func, select

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, Initiative, InitiativeAsset,
)
from serversherpa.imports.move_assets import parse_row, run_import
from serversherpa.imports.parsing import CANONICAL


async def _move(db):
    ini = Initiative(name="Move V", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    return ini


def _row(n, **over):
    canonical = {c: "" for c in CANONICAL}
    canonical.update(over)
    return parse_row(n, canonical, dict(over), generate_serials=False)


async def _counts(db):
    return (await db.scalar(select(func.count()).select_from(Asset)),
            await db.scalar(select(func.count()).select_from(AssetModel)),
            await db.scalar(select(func.count()).select_from(InitiativeAsset)))


async def test_validate_writes_nothing_and_reports(db):
    ini = await _move(db)
    model = AssetModel(make="Dell", model="R740")
    db.add(model)
    await db.flush()
    db.add(AssetModelAlias(model_id=model.id, alias="Dell PE R740"))
    existing = Asset(serial_number="sn-old", model_id=model.id)
    db.add(existing)
    await db.flush()
    db.add(InitiativeAsset(initiative_id=ini.id, asset_id=existing.id))
    await db.commit()
    before = await _counts(db)

    rows = [
        _row(2, serial_number="SN-OLD"),                       # on move -> updated
        _row(3, serial_number="sn-new1", asset_make="Dell",
             asset_model="R740"),                              # exact -> created
        _row(4, serial_number="sn-new2",
             asset_model="Dell PE R740"),                      # alias -> created
        _row(5, serial_number="sn-new3", asset_make="Ghost",
             asset_model="GX-1"),                              # no match -> review
        _row(6, serial_number="sn-new1"),                      # dup in file -> updated
        _row(7),                                               # parse error entry
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=False)

    assert await _counts(db) == before                         # nothing written
    by_row = {d["row"]: d for d in result["details"]}
    assert by_row[2]["status"] == "updated"
    assert by_row[2]["match_method"] == "existing_asset"
    assert by_row[3]["status"] == "created"
    assert by_row[3]["match_method"] == "exact"
    assert by_row[4]["match_method"] == "fuzzy"
    assert by_row[5]["status"] == "review"
    assert by_row[6]["status"] == "updated"                    # second sight of sn-new1
    assert by_row[7]["status"] == "error"
    assert result["summary"] == {
        "total_rows": 6, "processed_rows": 6, "created": 2, "updated": 2,
        "review": 1, "errors": 1,
    }
    assert result["cancelled"] is False


async def test_validate_force_and_hybrid_simulate_model_creation(db):
    ini = await _move(db)
    before = await _counts(db)
    rows = [_row(2, serial_number="sn-f", asset_make="Ghost",
                 asset_model="GX-1")]
    for mode in ("force", "hybrid"):
        result = await run_import(db, initiative_id=ini.id, added_by=None,
                                  rows=rows, make_model_mode=mode,
                                  write=False)
        [d] = result["details"]
        assert d["status"] == "created"
        assert d["match_method"] == "force_created"
        assert d["make_model_final"] == "Ghost GX-1"
        assert result["summary"]["models_created"] == 1
    assert await _counts(db) == before


async def test_validate_rfid_conflict_notes(db):
    ini = await _move(db)
    holder = Asset(serial_number="sn-holder", rfid_tag="TAG-1")
    db.add(holder)
    await db.commit()
    rows = [
        _row(2, serial_number="sn-a", rfid_tag="TAG-1"),   # taken in DB
        _row(3, serial_number="sn-b", rfid_tag="TAG-2"),
        _row(4, serial_number="sn-c", rfid_tag="TAG-2"),   # taken by row 3
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=False)
    by_row = {d["row"]: d for d in result["details"]}
    assert "TAG-1" in by_row[2]["message"] and "skipped" in by_row[2]["message"]
    assert "skipped" not in by_row[3]["message"]
    assert "TAG-2" in by_row[4]["message"] and "skipped" in by_row[4]["message"]


async def test_no_make_model_at_all_still_creates(db):
    ini = await _move(db)
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=[_row(2, serial_number="sn-bare")],
                              write=False)
    [d] = result["details"]
    assert d["status"] == "created"
    assert d["match_method"] == "none"


async def test_prefix_duplicated_make_model_matches_existing(db):
    # Catalog has Dell R640. The file supplies Make="Dell",
    # Model="Dell R640" (model cell duplicates the make prefix) — the
    # raw "dell dell r640" key must still resolve to the existing
    # catalog entry instead of falling to review/force-create.
    ini = await _move(db)
    db.add(AssetModel(make="Dell", model="R640"))
    await db.commit()

    row = _row(2, serial_number="sn-p", asset_make="Dell",
              asset_model="Dell R640")
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=[row], make_model_mode="fuzzy",
                              write=False)
    [d] = result["details"]
    assert d["status"] == "created"
    assert d["match_method"] == "exact"
    assert d["make_model_final"] == "Dell R640"

    # A second hybrid commit run (different serial, same input) must not
    # create a duplicate AssetModel — neither within nor across runs.
    for serial in ("sn-p1", "sn-p2"):
        await run_import(
            db, initiative_id=ini.id, added_by=None,
            rows=[_row(2, serial_number=serial, asset_make="Dell",
                      asset_model="Dell R640")],
            make_model_mode="hybrid", write=True)

    model_count = await db.scalar(select(func.count()).select_from(AssetModel))
    assert model_count == 1
