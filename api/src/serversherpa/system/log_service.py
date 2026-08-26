"""The log-service worker: retention enforcement + the web-server
probe. Plan 2 adds syslog forwarding here. Runs as its own process
(`serversherpa log-service`) and is listed in the registry like any
other worker. Retention failure modes never crash the loop."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import SystemProcess
from serversherpa.system.config_store import read_section

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


async def run_once() -> None:
    from serversherpa.config import get_settings
    from serversherpa.db.engine import get_sessionmaker

    async with get_sessionmaker()() as db:
        await enforce_retention(db)
        await probe_web(db, get_settings().portal_origin)


async def run_forever(poll_seconds: float = 10.0) -> None:
    from serversherpa.config import get_settings
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("log-service")
    heartbeat = start_heartbeat("log-service", "worker")
    logger.info("log-service watching retention + web probe")
    tick = 0
    try:
        while True:
            try:
                async with get_sessionmaker()() as db:
                    await enforce_retention(db)
                    if tick % PROBE_EVERY_TICKS == 0:
                        await probe_web(db, get_settings().portal_origin)
            except Exception:
                logger.exception("log-service tick failed")
            tick += 1
            await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
