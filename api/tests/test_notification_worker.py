"""notification-worker placeholder: heartbeat + status logs only, no
delivery pipeline. Fixtures modeled on test_notification_groups_api.py;
run_forever smoke test modeled on test_system_registry.py's direct use
of the `db` fixture alongside a heartbeat task writing through its own
session."""

import asyncio
import logging
from datetime import UTC, datetime

import pytest

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    NotificationGroup, NotificationGroupMember, Person, SystemProcess,
)
from serversherpa.notifications.worker import run_forever, run_once, status_counts


async def _person(db, first="Terry", last="Tech"):
    p = Person(first_name=first, last_name=last)
    db.add(p)
    await db.flush()
    return p


async def _group(db, name, *, enabled=True):
    g = NotificationGroup(name=name, enabled=enabled)
    db.add(g)
    await db.flush()
    return g


async def _add_member(db, group, person):
    db.add(NotificationGroupMember(group_id=group.id, person_id=person.id))
    await db.flush()


async def test_status_counts_excludes_disabled_groups(db):
    enabled = await _group(db, "On-call")
    disabled = await _group(db, "Archived", enabled=False)
    p1 = await _person(db, "A")
    p2 = await _person(db, "B")
    p3 = await _person(db, "C")
    await _add_member(db, enabled, p1)
    await _add_member(db, enabled, p2)
    await _add_member(db, disabled, p3)
    await db.commit()

    groups, members = await status_counts(db)
    assert groups == 1
    assert members == 2


async def test_run_once_logs_idle_status_line(db, caplog):
    enabled = await _group(db, "On-call")
    disabled = await _group(db, "Archived", enabled=False)
    p1 = await _person(db, "A")
    p2 = await _person(db, "B")
    p3 = await _person(db, "C")
    await _add_member(db, enabled, p1)
    await _add_member(db, enabled, p2)
    await _add_member(db, disabled, p3)
    await db.commit()

    caplog.set_level(logging.INFO, logger="serversherpa.notifications.worker")
    await run_once(get_sessionmaker())

    assert "1 enabled group" in caplog.text
    assert "2 member(s)" in caplog.text


async def test_run_forever_heartbeats_and_marks_stop(db):
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
        row = await db.get(SystemProcess, "notification-worker")
        assert row is not None
        assert row.kind == "worker"
        assert row.heartbeat_at is not None
        age = (datetime.now(UTC) - row.heartbeat_at).total_seconds()
        assert age < 5
        assert row.stopped_at is None
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    await db.refresh(row)
    assert row.stopped_at is not None
