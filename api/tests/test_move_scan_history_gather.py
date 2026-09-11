"""gather() pulls an initiative + its asset roster + earliest-per-status
scan progress into plain dataclasses; columns_for() slices that into the
pipeline/all column sets. Port of V2's `run()`
(api/reports/scan_history_report.py) — see docs/superpowers/specs/
2026-09-11-move-scan-history-design.md."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from serversherpa.db.models import (
    Asset, Client, Initiative, InitiativeAsset, ProcessedScan, Site, StatusValue,
)
from serversherpa.reports.move_report.gather import InitiativeUnavailable as MoveReportUnavailable
from serversherpa.reports.move_scan_history.gather import (
    PIPELINE_STATUS_KEYS, InitiativeUnavailable, columns_for, gather,
)

T0 = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)


def _scan(asset_id, status, scanned_at, *, archived_at=None):
    return ProcessedScan(
        scanned_value=f"EPC-{asset_id}-{status}-{scanned_at.isoformat()}",
        scan_type="rfid", scanned_at=scanned_at, processed_at=scanned_at,
        match_type="asset", asset_id=asset_id, status=status, archived_at=archived_at)


async def _seed_move(db):
    client = Client(name="Acme")
    src = Site(name="DC-A", status="active")
    dst = Site(name="DC-B", status="active")
    db.add_all([client, src, dst])
    await db.flush()
    ini = Initiative(name="NAP11 Move", initiative_type="move", status="planned",
                     client_id=client.id, origin_site_id=src.id, destination_site_id=dst.id,
                     scheduled_start=datetime(2026, 3, 15, 9, 0, tzinfo=UTC))
    db.add(ini)
    await db.flush()

    # Legacy (human) Asset IDs assigned out of insertion order, to prove
    # gather() sorts the roster by Asset.legacy_id, not insertion order.
    asset_a = Asset(legacy_id=300, serial_number="SN-A", name="Asset A")
    asset_b = Asset(legacy_id=100, serial_number="SN-B", name="Asset B")
    asset_c = Asset(legacy_id=200, serial_number="SN-C", name="Asset C")
    db.add_all([asset_a, asset_b, asset_c])
    await db.flush()

    db.add_all([
        InitiativeAsset(initiative_id=ini.id, asset_id=asset_a.id),
        InitiativeAsset(initiative_id=ini.id, asset_id=asset_b.id),
        InitiativeAsset(initiative_id=ini.id, asset_id=asset_c.id),
    ])

    # A status outside the canonical (conftest-restored) asset vocabulary,
    # marked inactive — proves "all" mode (and this module's pipeline
    # mode, which only appends *active* off-pipeline statuses) never
    # surfaces it as a column, even though it was actually scanned.
    db.add(StatusValue(record_type="asset", key="deprecated_test",
                       label="Deprecated Test", color="#000000", sort_order=999,
                       is_active=False))
    await db.flush()

    db.add_all([
        # duplicate (asset, status) with different times -> earliest kept
        _scan(asset_b.id, "complete", T0 + timedelta(hours=2)),
        _scan(asset_b.id, "complete", T0 + timedelta(hours=1)),
        # null-status scan -> ignored
        _scan(asset_c.id, None, T0 + timedelta(hours=3)),
        # archived scan -> ignored
        _scan(asset_c.id, "qa", T0 + timedelta(hours=4), archived_at=T0 + timedelta(hours=5)),
        # off-pipeline (but active) status -> appended after 'complete' in pipeline mode
        _scan(asset_a.id, "cabling", T0 + timedelta(minutes=30)),
        # inactive status, still a valid (non-null, non-archived) scan
        _scan(asset_c.id, "deprecated_test", T0 + timedelta(hours=6)),
    ])
    await db.commit()
    return ini


async def test_gather_roster_ordered_by_legacy_id(db):
    ini = await _seed_move(db)
    data = await gather(db, ini.id)
    assert [a.asset_id for a in data.assets] == [100, 200, 300]
    assert [a.serial_number for a in data.assets] == ["SN-B", "SN-C", "SN-A"]
    assert [a.name for a in data.assets] == ["Asset B", "Asset C", "Asset A"]


async def test_gather_move_fields(db):
    ini = await _seed_move(db)
    data = await gather(db, ini.id)
    assert data.initiative_id == ini.id
    assert data.name == "NAP11 Move"
    assert data.client_name == "Acme"
    assert data.scheduled_start == datetime(2026, 3, 15, 9, 0, tzinfo=UTC)
    assert data.source_name == "DC-A"
    assert data.destination_name == "DC-B"


async def test_gather_dedupes_to_earliest_scan_per_asset_status(db):
    ini = await _seed_move(db)
    data = await gather(db, ini.id)
    # asset_b (legacy 100): only the earlier of the two 'complete' scans
    [hit] = data.scan_progress[100]
    assert hit.status_key == "complete" and hit.at == T0 + timedelta(hours=1)


async def test_gather_ignores_null_status_and_archived_scans(db):
    ini = await _seed_move(db)
    data = await gather(db, ini.id)
    # asset_c (legacy 200) had a null-status scan and an archived 'qa'
    # scan — neither counts, only the (active, non-null) deprecated_test one
    [hit] = data.scan_progress[200]
    assert hit.status_key == "deprecated_test"


async def test_gather_scanned_assets_and_last_scan_at(db):
    ini = await _seed_move(db)
    data = await gather(db, ini.id)
    # a (cabling), b (complete), c (deprecated_test) all have >=1 valid hit
    assert data.scanned_assets == 3
    assert data.total_assets == 3
    assert data.last_scan_at == T0 + timedelta(hours=6)


async def test_gather_completion_by_complete_status(db):
    ini = await _seed_move(db)
    data = await gather(db, ini.id)
    # only asset_b (legacy 100) reached 'complete'
    assert data.completed == 1
    assert data.completion_pct == round(1 / 3 * 100)


async def test_pipeline_status_keys_matches_v2_order():
    assert PIPELINE_STATUS_KEYS == (
        "pre_stage", "rfid_1_cage_exit", "labeled", "rfid_2_loading_dock",
        "pack_logistics", "in_container", "in_transit", "received", "un_pack",
        "rfid_3_staging", "rfid_4_into_cage", "re_racked", "qa", "complete",
    )


async def test_columns_for_pipeline_appends_off_pipeline_scanned_status(db):
    ini = await _seed_move(db)
    data = await gather(db, ini.id)
    cols = columns_for(data, "pipeline")
    assert [c.key for c in cols[:14]] == list(PIPELINE_STATUS_KEYS)
    assert [c.key for c in cols[14:]] == ["cabling"]  # appended after 'complete'
    complete_col = next(c for c in cols if c.key == "complete")
    assert complete_col.scan_count == 1
    cabling_col = next(c for c in cols if c.key == "cabling")
    assert cabling_col.in_pipeline is False and cabling_col.scan_count == 1


async def test_columns_for_pipeline_and_all_never_surface_inactive_status(db):
    ini = await _seed_move(db)
    data = await gather(db, ini.id)
    pipeline_keys = {c.key for c in columns_for(data, "pipeline")}
    all_keys = {c.key for c in columns_for(data, "all")}
    assert "deprecated_test" not in pipeline_keys
    assert "deprecated_test" not in all_keys


async def test_columns_for_all_includes_pipeline_then_other_active_statuses(db):
    ini = await _seed_move(db)
    data = await gather(db, ini.id)
    cols = columns_for(data, "all")
    assert [c.key for c in cols[:14]] == list(PIPELINE_STATUS_KEYS)
    assert "cabling" in {c.key for c in cols[14:]}
    # every non-pipeline column in "all" mode is active
    assert all(not c.in_pipeline for c in cols[14:])


async def test_columns_for_unknown_mode_raises(db):
    ini = await _seed_move(db)
    data = await gather(db, ini.id)
    with pytest.raises(ValueError):
        columns_for(data, "bogus")


async def test_gather_empty_move(db):
    client = Client(name="Acme")
    db.add(client)
    await db.flush()
    ini = Initiative(name="Empty Move", initiative_type="move", status="planned",
                     client_id=client.id)
    db.add(ini)
    await db.commit()

    data = await gather(db, ini.id)
    assert data.assets == []
    assert data.total_assets == 0
    assert data.scanned_assets == 0
    assert data.completed == 0
    assert data.completion_pct == 0
    assert data.last_scan_at is None
    assert data.scan_progress == {}
    # no client/site name required to be N/A here — that's an xlsx concern
    pipeline_cols = columns_for(data, "pipeline")
    assert [c.key for c in pipeline_cols] == list(PIPELINE_STATUS_KEYS)
    assert all(c.scan_count == 0 for c in pipeline_cols)


async def test_gather_rejects_missing_or_archived_initiative(db):
    with pytest.raises(InitiativeUnavailable):
        await gather(db, uuid4())

    ini = Initiative(name="Old Move", initiative_type="move", status="completed",
                     archived_at=datetime.now(UTC))
    db.add(ini)
    await db.commit()
    with pytest.raises(InitiativeUnavailable):
        await gather(db, ini.id)


def test_initiative_unavailable_is_shared_with_move_report():
    """reports/worker.py only catches move_report.gather.InitiativeUnavailable
    — this module MUST reuse that exact class (not a lookalike) so a
    move_scan_history run failure maps onto the same 'initiative_unavailable'
    error without any change to worker.py."""
    assert InitiativeUnavailable is MoveReportUnavailable
