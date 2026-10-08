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
    assert "email delivery off" in caplog.text


async def test_run_forever_heartbeats_and_marks_stop(db, caplog):
    caplog.set_level(logging.INFO, logger="serversherpa.notifications.worker")
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
        # The first loop iteration must emit the idle status line
        # immediately — the cadence seed cannot defer it 15 minutes.
        assert "email delivery off (SMTP not configured)" in caplog.text
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    await db.refresh(row)
    assert row.stopped_at is not None


async def test_run_forever_runs_the_reminder_sweep(db, caplog, monkeypatch):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def fake_once(maker):
        calls.append(maker)
        return 0

    monkeypatch.setattr(worker_mod, "run_reminders_once", fake_once)
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) == 1   # once on the first loop; the next is an hour away


async def test_run_forever_delivers_the_outbox(db, monkeypatch):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def fake_deliver(maker):
        calls.append(maker)
        return 0

    monkeypatch.setattr(worker_mod, "deliver_once", fake_deliver)
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) >= 2          # every poll, not hourly


async def test_delivery_errors_do_not_kill_the_loop(db, monkeypatch, caplog):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def boom(maker):
        calls.append(1)
        raise RuntimeError("db down")

    monkeypatch.setattr(worker_mod, "deliver_once", boom)
    caplog.set_level(logging.WARNING, logger="serversherpa.notifications.worker")
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) >= 2
    assert caplog.text.count("could not deliver the email outbox") == 1   # once per outage


def test_cli_once_runs_the_status_pass_and_one_delivery_pass(monkeypatch):
    """`notification-worker --once` delivers due mail too (CLI surface only:
    the passes themselves are faked)."""
    from typer.testing import CliRunner

    from serversherpa import cli
    from serversherpa.db import engine as engine_mod
    from serversherpa.mail import delivery
    from serversherpa.notifications import worker as worker_mod

    calls: list[str] = []

    async def fake_status(maker):
        calls.append("status")

    async def fake_deliver(maker):
        calls.append("deliver")
        return 3

    async def no_dispose():
        pass

    monkeypatch.setattr(engine_mod, "get_sessionmaker", lambda: object())
    monkeypatch.setattr(worker_mod, "run_once", fake_status)
    monkeypatch.setattr(delivery, "deliver_once", fake_deliver)
    monkeypatch.setattr(cli, "dispose_engine", no_dispose)
    result = CliRunner().invoke(cli.app, ["notification-worker", "--once"])
    assert result.exit_code == 0, result.output
    assert calls == ["status", "deliver"]
    assert "3" in result.output
