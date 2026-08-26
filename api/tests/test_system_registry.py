"""Heartbeat registry: upserts, clean-stop marking, derived status."""

import asyncio
from datetime import UTC, datetime, timedelta

from serversherpa.db.models import SystemProcess
from serversherpa.system import config_store
from serversherpa.system.registry import derive_status, heartbeat_loop

NOW = datetime(2026, 8, 26, 12, 0, 0, tzinfo=UTC)


def test_derive_status():
    fresh = NOW - timedelta(seconds=3)
    stale = NOW - timedelta(seconds=60)
    assert derive_status(fresh, None, NOW) == "running"
    assert derive_status(stale, None, NOW) == "failed"
    assert derive_status(None, None, NOW) == "failed"        # never beat
    # clean stop after the last beat
    assert derive_status(stale, stale + timedelta(seconds=1), NOW) == "stopped"
    # restart after an old clean stop: fresh beat wins
    assert derive_status(fresh, stale, NOW) == "running"
    # stopped marker also beats a still-fresh heartbeat when newer
    assert derive_status(fresh, NOW, NOW) == "stopped"


async def test_heartbeat_loop_upserts_and_marks_stop(db):
    task = asyncio.create_task(
        heartbeat_loop("testproc", "worker", interval=0.05))
    await asyncio.sleep(0.2)
    row = await db.get(SystemProcess, "testproc")
    assert row is not None
    assert row.kind == "worker"
    assert row.pid is not None
    assert row.hostname != ""
    assert row.started_at is not None
    first_beat = row.heartbeat_at
    assert first_beat is not None

    await asyncio.sleep(0.15)
    await db.refresh(row)
    assert row.heartbeat_at > first_beat                     # keeps beating

    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    await db.refresh(row)
    assert row.stopped_at is not None                        # clean stop


async def test_restart_overwrites_previous_run(db):
    task = asyncio.create_task(
        heartbeat_loop("testproc", "worker", interval=0.05))
    await asyncio.sleep(0.15)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    task = asyncio.create_task(
        heartbeat_loop("testproc", "worker", interval=0.05))
    await asyncio.sleep(0.15)
    row = await db.get(SystemProcess, "testproc")
    await db.refresh(row)
    assert row.stopped_at is None                            # cleared on start
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_config_store_defaults_and_merge(db):
    data = await config_store.read_section(db, "logging")
    assert data["mode"] == "local"                           # seeded row
    missing = await config_store.read_section(db, "nonexistent")
    assert missing == {}
    # row values win over defaults
    from serversherpa.db.models import SystemConfig
    cfg = await db.get(SystemConfig, "logging")
    cfg.data = {**cfg.data, "min_level": "DEBUG"}
    await db.commit()
    data = await config_store.read_section(db, "logging")
    assert data["min_level"] == "DEBUG"
    assert data["local_max_age_days"] == 14                  # default kept
