"""Heartbeat registry. Every process upserts its row every 5 s; status
is DERIVED from the timestamps at read time (spec: running/stopped/
failed), never stored — so a kill -9 needs no cleanup to show as
failed once the heartbeat goes stale."""

import asyncio
import os
import socket
from datetime import UTC, datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert

from serversherpa.db.models import SystemProcess

HEARTBEAT_SECONDS = 5
STALE_AFTER_SECONDS = 15          # 3 × the heartbeat interval


def derive_status(heartbeat_at: datetime | None,
                  stopped_at: datetime | None,
                  now: datetime) -> str:
    if stopped_at is not None and (
            heartbeat_at is None or stopped_at >= heartbeat_at):
        return "stopped"
    if heartbeat_at is None:
        return "failed"
    age = (now - heartbeat_at).total_seconds()
    return "running" if age < STALE_AFTER_SECONDS else "failed"


async def _beat(name: str, kind: str, *, first: bool) -> None:
    from serversherpa.db.engine import get_sessionmaker

    now = datetime.now(UTC)
    values = {"kind": kind, "pid": os.getpid(),
              "hostname": socket.gethostname(), "heartbeat_at": now}
    if first:
        values["started_at"] = now
        values["stopped_at"] = None
    stmt = pg_insert(SystemProcess).values(name=name, **values)
    stmt = stmt.on_conflict_do_update(index_elements=["name"], set_=values)
    async with get_sessionmaker()() as db:
        await db.execute(stmt)
        await db.commit()


async def _mark_stopped(name: str) -> None:
    from serversherpa.db.engine import get_sessionmaker

    async with get_sessionmaker()() as db:
        row = await db.get(SystemProcess, name)
        if row is not None:
            row.stopped_at = datetime.now(UTC)
            await db.commit()


async def heartbeat_loop(name: str, kind: str, *,
                         interval: float = HEARTBEAT_SECONDS) -> None:
    first = True
    try:
        while True:
            try:
                await _beat(name, kind, first=first)
                first = False
            except asyncio.CancelledError:
                raise
            except Exception:
                pass          # a DB blip must never kill the host process
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        try:
            await _mark_stopped(name)
        except Exception:
            pass


def start_heartbeat(name: str, kind: str) -> asyncio.Task:
    return asyncio.create_task(heartbeat_loop(name, kind))
