"""The log-service worker: retention enforcement + the web-server
probe. Plan 2 adds syslog forwarding here. Runs as its own process
(`serversherpa log-service`) and is listed in the registry like any
other worker. Retention failure modes never crash the loop."""

import asyncio
import logging
import socket as _socket
import time
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import LogEntry, SystemConfig, SystemProcess
from serversherpa.system.config_store import read_section
from serversherpa.system.forwarders import (
    NonRetryableTransportError,
    send_loki,
    send_syslog,
    transport_configured,
)

logger = logging.getLogger("serversherpa.system.log_service")

# Probe every tick: the probe stamps the web row's heartbeat, and the
# registry derives "failed" after 15 s of silence — a 30 s cadence (the
# spec's every-3rd-tick) made a healthy web row flip-flop to failed.
PROBE_EVERY_TICKS = 1


async def enforce_retention(db: AsyncSession) -> dict:
    cfg = await read_section(db, "logging")
    row_cap = int(cfg["remote_buffer_rows"] if cfg["mode"] == "remote"
                  else cfg["local_max_rows_per_process"])
    max_age_days = int(cfg["local_max_age_days"])
    deleted = 0

    processes = [r[0] for r in await db.execute(
        text("SELECT DISTINCT process FROM log_entries"))]
    for process in processes:
        result = await db.execute(text("""
            DELETE FROM log_entries WHERE process = :p AND id <= (
                SELECT id FROM log_entries WHERE process = :p
                ORDER BY id DESC OFFSET :cap LIMIT 1)
        """), {"p": process, "cap": row_cap})
        deleted += result.rowcount or 0

    cutoff = datetime.now(UTC) - timedelta(days=max_age_days)
    result = await db.execute(
        text("DELETE FROM log_entries WHERE at < :cutoff"),
        {"cutoff": cutoff})
    deleted += result.rowcount or 0
    await db.commit()
    if deleted:
        logger.info("retention deleted %d log rows", deleted)
    return {"deleted": deleted}


async def probe_web(db: AsyncSession, url: str) -> None:
    values: dict = {"kind": "probe"}
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url)
        values["heartbeat_at"] = datetime.now(UTC)
        values["meta"] = {"url": url, "status_code": resp.status_code}
    except Exception as exc:
        values["meta"] = {"url": url, "error": str(exc)}
    stmt = pg_insert(SystemProcess).values(name="web", **values)
    stmt = stmt.on_conflict_do_update(index_elements=["name"], set_=values)
    await db.execute(stmt)
    await db.commit()


FORWARD_BATCH = 500
BACKOFF_START = 10.0
BACKOFF_MAX = 300.0


def _row_dict(entry: LogEntry) -> dict:
    return {"process": entry.process, "level": entry.level,
            "levelno": entry.levelno, "logger": entry.logger,
            "message": entry.message, "extra": entry.extra or {},
            "at": entry.at}


async def forward_pending(db: AsyncSession) -> dict:
    """Drain rows past the forwarding cursor via the configured
    transport. Commits the cursor after each batch — sent or skipped —
    so a failure never re-sends what already landed, and a permanent
    4xx rejection never wedges the cursor on poison rows. Raises on
    retryable transport failure — the caller owns backoff."""
    cfg = await read_section(db, "logging")
    if not transport_configured(cfg):
        return {"forwarded": 0, "skipped": 0}
    cursor_row = await db.get(SystemConfig, "logging_cursor")
    if cursor_row is None:
        cursor_row = SystemConfig(section="logging_cursor",
                                  data={"last_forwarded_id": 0})
        db.add(cursor_row)
        await db.flush()
    last = int((cursor_row.data or {}).get("last_forwarded_id", 0))
    hostname = _socket.gethostname()
    total = 0
    skipped = 0
    while True:
        rows = (await db.scalars(
            select(LogEntry).where(LogEntry.id > last)
            .order_by(LogEntry.id).limit(FORWARD_BATCH))).all()
        if not rows:
            break
        dicts = [_row_dict(r) for r in rows]
        try:
            if cfg.get("transport", "loki") == "loki":
                await send_loki(cfg["loki"], dicts, hostname)
            else:
                await send_syslog(cfg["syslog"], dicts, hostname)
        except NonRetryableTransportError as exc:
            logger.warning(
                "skipping %d unforwardable rows (ids %s-%s): %s",
                len(rows), rows[0].id, rows[-1].id, exc)
            skipped += len(rows)
        else:
            total += len(rows)
        last = rows[-1].id
        cursor_row.data = {"last_forwarded_id": last}
        await db.commit()
        if len(rows) < FORWARD_BATCH:
            break
    if total or skipped:
        logger.info("forwarded %d log rows via %s (%d skipped)", total,
                    cfg.get("transport", "loki"), skipped)
    return {"forwarded": total, "skipped": skipped}


async def set_forwarding_degraded(db: AsyncSession,
                                  error: str | None) -> None:
    row = await db.get(SystemProcess, "log-service")
    if row is None:
        return
    meta = dict(row.meta or {})
    if error is None:
        if "forwarding_degraded" not in meta:
            return
        meta.pop("forwarding_degraded", None)
        meta.pop("forwarding_error", None)
    else:
        meta["forwarding_degraded"] = True
        meta["forwarding_error"] = error[:500]
    row.meta = meta
    await db.commit()


async def run_once() -> None:
    from serversherpa.config import get_settings
    from serversherpa.db.engine import get_sessionmaker

    async with get_sessionmaker()() as db:
        await enforce_retention(db)
        await probe_web(db, get_settings().portal_origin)
        try:
            await forward_pending(db)
        except Exception:
            await db.rollback()
            logger.exception("forwarding failed")


async def run_forever(poll_seconds: float = 10.0) -> None:
    from serversherpa.config import get_settings
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("log-service")
    heartbeat = start_heartbeat("log-service", "worker")
    logger.info("log-service watching retention + probe + forwarding")
    tick = 0
    backoff = BACKOFF_START
    next_forward_at = 0.0
    try:
        while True:
            try:
                async with get_sessionmaker()() as db:
                    await enforce_retention(db)
                    if tick % PROBE_EVERY_TICKS == 0:
                        await probe_web(db, get_settings().portal_origin)
            except Exception:
                logger.exception("log-service tick failed")
            if time.monotonic() >= next_forward_at:
                try:
                    async with get_sessionmaker()() as db:
                        await forward_pending(db)
                        await set_forwarding_degraded(db, None)
                    backoff = BACKOFF_START
                    next_forward_at = 0.0
                except Exception as exc:
                    logger.warning("forwarding failed: %s", exc)
                    try:
                        async with get_sessionmaker()() as db:
                            await set_forwarding_degraded(db, str(exc))
                    except Exception:
                        pass
                    next_forward_at = time.monotonic() + backoff
                    backoff = min(backoff * 2, BACKOFF_MAX)
            tick += 1
            await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
