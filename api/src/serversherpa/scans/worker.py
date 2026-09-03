"""The scan-matching worker loop (`serversherpa scan-matching-worker`).
One transaction per scan: match → insert processed row → apply status
rules → delete the raw row. Errors roll back the whole scan (raw row
intact — no V2-style silent loss); a follow-up transaction stamps
match_attempted_at and logs an error execution so the slow sweep
retries it. No signal handlers, matching the import worker: safety is
per-scan commits + idempotent re-runs."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, ProcessedScan, RawScan, StatusRuleExecution,
)
from serversherpa.scans.matching import match_scan
from serversherpa.status_rules.engine import RuleExecutionError, apply_rules

logger = logging.getLogger("serversherpa.scans.worker")

BATCH_LIMIT = 50
RETRY_SWEEP_SECONDS = 900   # unmatched rows re-tried every 15 min
# Wall-clock time of the last sweep pass. Doubles as both the cadence
# gate (has RETRY_SWEEP_SECONDS elapsed since we last swept?) and the
# eligibility cutoff for the NEXT pass, so a row this worker just
# stamped during the current pass can't be picked back up by the very
# next call — recomputing the cutoff as "now - RETRY_SWEEP_SECONDS" on
# every triggered sweep would collapse to "now" whenever
# RETRY_SWEEP_SECONDS is small (e.g. 0 in tests), immediately
# resweeping rows this same process just stamped.
_last_sweep: datetime | None = None

_COPY_FIELDS = ("scanned_value", "scan_type", "status", "scanned_at",
                "device_id", "operator_id", "site_id", "location_detail",
                "source")


async def _stamp_error(maker, raw_id: int, err: Exception) -> None:
    rule_id = getattr(err, "rule_id", None)
    rule_name = getattr(err, "rule_name", None)
    try:
        async with maker() as db:
            raw = await db.get(RawScan, raw_id)
            if raw is not None:
                raw.match_attempted_at = datetime.now(UTC)
            db.add(StatusRuleExecution(
                rule_id=rule_id, rule_name=rule_name or "(scan processing)",
                processed_scan_id=None, conditions_met=rule_id is not None,
                actions_applied=[], error=str(err)[:2000]))
            await db.commit()
    except Exception:
        logger.exception("failed to record error for raw scan %s", raw_id)


async def process_raw_scan(maker, raw_id: int) -> str:
    try:
        async with maker() as db:
            raw = await db.scalar(
                select(RawScan).where(RawScan.id == raw_id)
                .with_for_update(skip_locked=True))
            if raw is None:
                return "gone"
            match = await match_scan(db, raw.scanned_value)
            if match is None:
                raw.match_attempted_at = datetime.now(UTC)
                await db.commit()
                return "unmatched"
            processed = ProcessedScan(
                **{f: getattr(raw, f) for f in _COPY_FIELDS},
                raw_scan_id=raw.id, match_type=match.match_type,
                asset_id=(match.target_id
                          if match.match_type == "asset" else None),
                container_id=(match.target_id
                              if match.match_type == "container" else None),
                person_id=(match.target_id
                           if match.match_type == "person" else None),
                processed_at=datetime.now(UTC))
            db.add(processed)
            await db.flush()
            if match.match_type == "asset":
                asset = await db.get(Asset, match.target_id)
                if (asset.last_seen_at is None
                        or asset.last_seen_at < raw.scanned_at):
                    asset.last_seen_at = raw.scanned_at
            await apply_rules(db, processed)
            await db.delete(raw)
            await db.commit()
            return "matched"
    except RuleExecutionError as err:
        logger.exception("raw scan %s: rule failed", raw_id)
        await _stamp_error(maker, raw_id, err)
        return "error"
    except Exception as err:
        logger.exception("raw scan %s: processing failed", raw_id)
        await _stamp_error(maker, raw_id, err)
        return "error"


async def run_once(maker) -> bool:
    """One batch pass. The slow sweep re-tries previously attempted rows
    (late-registered tags); it runs at most every RETRY_SWEEP_SECONDS."""
    global _last_sweep
    async with maker() as db:
        ids = list((await db.scalars(
            select(RawScan.id)
            .where(RawScan.match_attempted_at.is_(None))
            .order_by(RawScan.id).limit(BATCH_LIMIT))).all())
        wall_now = datetime.now(UTC)
        if (_last_sweep is None
                or (wall_now - _last_sweep).total_seconds()
                >= RETRY_SWEEP_SECONDS):
            cutoff = (_last_sweep if _last_sweep is not None
                      else wall_now - timedelta(seconds=RETRY_SWEEP_SECONDS))
            ids += (await db.scalars(
                select(RawScan.id)
                .where(RawScan.match_attempted_at < cutoff)
                .order_by(RawScan.match_attempted_at).limit(BATCH_LIMIT))).all()
            _last_sweep = wall_now
    for raw_id in ids:
        await process_raw_scan(maker, raw_id)
    return bool(ids)


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("scan-matching-worker")
    pause_state = {"paused": False}
    check_state = {}
    heartbeat = start_heartbeat("scan-matching-worker", "worker",
                                meta_fn=lambda: dict(pause_state))
    logger.info("scan-matching worker online — batch %d, sweep every %ds",
                BATCH_LIMIT, RETRY_SWEEP_SECONDS)
    maker = get_sessionmaker()
    try:
        while True:
            # read-only mode's "also pause background services": idle (still
            # heart-beating as paused) until the flag clears — no work lost
            if await poll_workers_paused(maker, check_state):
                if not pause_state["paused"]:
                    logger.info("paused by read-only maintenance mode")
                pause_state["paused"] = True
                await asyncio.sleep(poll_seconds)
                continue
            if pause_state["paused"]:
                logger.info("resumed")
            pause_state["paused"] = False
            worked = await run_once(maker)
            if not worked:
                await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
