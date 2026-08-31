"""Worker semantics: true move on match, attempt stamping on no-match,
built-in last_seen_at, error rollback + error execution row, batch
pickup, and the slow retry sweep. run_forever smoke modeled on
test_notification_worker.py."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, ProcessedScan, RawScan, StatusRule, StatusRuleAction,
    StatusRuleExecution, SystemProcess,
)
from serversherpa.scans import worker
from serversherpa.status_rules.engine import invalidate_cache


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    invalidate_cache()
    monkeypatch.setattr(worker, "_last_sweep", None)
    yield
    invalidate_cache()


def _raw(value, *, status="rfid_4_into_cage", attempted=None):
    return RawScan(scanned_value=value, scan_type="rfid", status=status,
                   scanned_at=datetime.now(UTC),
                   match_attempted_at=attempted)


async def test_match_moves_row_and_sets_last_seen(db):
    a = Asset(serial_number="SN-1")
    scan = _raw("SN-1")
    db.add_all([a, scan])
    await db.commit()

    result = await worker.process_raw_scan(get_sessionmaker(), scan.id)
    assert result == "matched"

    async with get_sessionmaker()() as check:
        assert (await check.scalars(select(RawScan))).all() == []
        moved = (await check.scalars(select(ProcessedScan))).one()
        assert moved.match_type == "asset"
        assert moved.asset_id == a.id
        assert moved.raw_scan_id == scan.id
        assert moved.scanned_value == "SN-1"
        seen = await check.get(Asset, a.id)
        assert seen.last_seen_at == moved.scanned_at


async def test_no_match_stamps_and_row_stays(db):
    scan = _raw("nobody-home")
    db.add(scan)
    await db.commit()
    assert await worker.process_raw_scan(get_sessionmaker(), scan.id) == "unmatched"
    async with get_sessionmaker()() as check:
        row = (await check.scalars(select(RawScan))).one()
        assert row.match_attempted_at is not None


async def test_rule_error_rolls_back_and_logs_error_execution(db):
    a = Asset(serial_number="SN-2", status="unknown")
    rule = StatusRule(name="Boom", trigger_status="rfid_4_into_cage",
                      trigger_match_type="asset")
    rule.actions.append(StatusRuleAction(
        position=1, action_type="set_asset_status",
        params={"status": "not-a-key"}))
    scan = _raw("SN-2")
    db.add_all([a, rule, scan])
    await db.commit()

    assert await worker.process_raw_scan(get_sessionmaker(), scan.id) == "error"

    async with get_sessionmaker()() as check:
        raw = (await check.scalars(select(RawScan))).one()   # still raw
        assert raw.match_attempted_at is not None
        assert (await check.scalars(select(ProcessedScan))).all() == []
        asset = await check.get(Asset, a.id)
        assert asset.status == "unknown"                     # rolled back
        ex = (await check.scalars(select(StatusRuleExecution))).one()
        assert ex.error is not None
        assert ex.rule_name == "Boom"
        assert ex.processed_scan_id is None


async def test_run_once_picks_fresh_rows_and_sweeps_stale(db, monkeypatch):
    monkeypatch.setattr(worker, "RETRY_SWEEP_SECONDS", 0)
    a = Asset(serial_number="LATE-REG")
    fresh = _raw("nobody")
    stale = _raw("LATE-REG",
                 attempted=datetime.now(UTC) - timedelta(hours=1))
    db.add_all([a, fresh, stale])
    await db.commit()

    worked = await worker.run_once(get_sessionmaker())
    assert worked is True

    async with get_sessionmaker()() as check:
        # stale row matched now that the asset exists; fresh row stamped.
        assert (await check.scalars(select(ProcessedScan))).one().asset_id == a.id
        leftover = (await check.scalars(select(RawScan))).one()
        assert leftover.scanned_value == "nobody"
        assert leftover.match_attempted_at is not None

    assert await worker.run_once(get_sessionmaker()) is False   # all stamped


async def test_sweep_retries_oldest_attempted_first(db, monkeypatch):
    monkeypatch.setattr(worker, "RETRY_SWEEP_SECONDS", 0)
    monkeypatch.setattr(worker, "BATCH_LIMIT", 1)
    now = datetime.now(UTC)
    a = _raw("SWEEP-A", attempted=now - timedelta(hours=1))
    b = _raw("SWEEP-B", attempted=now - timedelta(hours=2))
    db.add_all([a, b])
    await db.commit()
    a_id, b_id, a_stamp = a.id, b.id, a.match_attempted_at

    await worker.run_once(get_sessionmaker())

    async with get_sessionmaker()() as check:
        a_after = await check.get(RawScan, a_id)
        b_after = await check.get(RawScan, b_id)
        # b has the older (more stale) match_attempted_at, so it must be
        # the row re-attempted this pass — its stamp is now newer than
        # a's original stamp. Under order_by(RawScan.id) this fails
        # because the lower-id row (a) is swept instead.
        assert b_after.match_attempted_at > a_stamp
        assert a_after.match_attempted_at == a_stamp


async def test_run_forever_heartbeats_and_stops(db):
    task = asyncio.create_task(worker.run_forever(poll_seconds=0.05))
    try:
        for _ in range(80):
            await asyncio.sleep(0.05)
            row = await db.scalar(select(SystemProcess).where(
                SystemProcess.name == "scan-matching-worker"))
            if row is not None:
                break
        assert row is not None
        assert row.kind == "worker"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
