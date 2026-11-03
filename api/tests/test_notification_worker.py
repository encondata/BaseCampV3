"""notification-worker placeholder: heartbeat + status logs only, no
delivery pipeline. Fixtures modeled on test_notification_groups_api.py;
run_forever smoke test modeled on test_system_registry.py's direct use
of the `db` fixture alongside a heartbeat task writing through its own
session."""

import asyncio
import inspect
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


async def _until(check, task: asyncio.Task, seconds: float = 30) -> None:
    """Wait for `check()` (plain or async) to hold, up to a generous
    deadline: never a fixed sleep, so a loaded machine waits longer instead
    of failing. `task` is the worker loop: if it has died, the wait fails at
    once with its exception (which the test's cancel-and-gather would
    otherwise swallow)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    while True:
        held = check()
        if inspect.isawaitable(held):
            held = await held
        if held:
            return
        if task.done():
            task.result()               # raises the loop's own exception
            raise AssertionError("the worker loop stopped")
        assert loop.time() < deadline, "the worker loop never got there"
        await asyncio.sleep(0.01)


def _count_loops(monkeypatch, worker_mod) -> list:
    """The worker loop's passes, counted: each delivers the outbox once."""
    passes = []

    async def deliver(maker):
        passes.append(1)

    monkeypatch.setattr(worker_mod, "deliver_once", deliver)
    return passes


async def test_until_fails_at_once_with_the_dead_loops_own_error():
    """A worker loop that died (a bad patch, say) fails the wait at once with
    its own exception, not after the deadline with a generic message."""
    async def crash():
        raise RuntimeError("bad patch")

    task = asyncio.create_task(crash())
    loop = asyncio.get_running_loop()
    started = loop.time()
    with pytest.raises(RuntimeError, match="^bad patch$"):
        await _until(lambda: False, task)
    assert loop.time() - started < 5

    # one that stopped without an error says so
    async def quits():
        return None

    task = asyncio.create_task(quits())
    with pytest.raises(AssertionError, match="the worker loop stopped"):
        await _until(lambda: False, task)


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
        idle = "email delivery off (SMTP not configured)"
        await _until(lambda: idle in caplog.text, task)
        await _until(lambda: db.get(SystemProcess, "notification-worker"), task)
        row = await db.get(SystemProcess, "notification-worker")
        assert row is not None
        assert row.kind == "worker"
        assert row.heartbeat_at is not None
        age = (datetime.now(UTC) - row.heartbeat_at).total_seconds()
        assert age < 5
        assert row.stopped_at is None
        # The first loop iteration must emit the idle status line
        # immediately — the cadence seed cannot defer it 15 minutes.
        assert idle in caplog.text
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
    passes = _count_loops(monkeypatch, worker_mod)
    task = asyncio.create_task(run_forever(poll_seconds=0.01))
    try:
        await _until(lambda: len(passes) >= 4, task)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) == 1   # once on the first pass; the next is an hour away


async def test_run_forever_runs_the_learning_sweep(db, monkeypatch):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def fake_learning(maker):
        calls.append(maker)
        return {"invites": 0, "reminders": 0, "overdue": 0, "errors": 0}

    monkeypatch.setattr(worker_mod, "run_learning_once", fake_learning)
    passes = _count_loops(monkeypatch, worker_mod)
    task = asyncio.create_task(run_forever(poll_seconds=0.01))
    try:
        await _until(lambda: len(passes) >= 4, task)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) == 1   # once on the first pass; the next is a minute away


async def test_learning_sweep_errors_do_not_kill_the_loop(db, monkeypatch, caplog):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def boom(maker):
        calls.append(1)
        raise RuntimeError("db down")

    monkeypatch.setattr(worker_mod, "run_learning_once", boom)
    monkeypatch.setattr(worker_mod, "LEARNING_INTERVAL_SECONDS", 0)
    caplog.set_level(logging.WARNING, logger="serversherpa.notifications.worker")
    task = asyncio.create_task(run_forever(poll_seconds=0.01))
    try:
        await _until(lambda: len(calls) >= 3, task)
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert caplog.text.count("could not run the learning sweep") == 1   # once per outage


async def test_run_forever_runs_the_plan_reminder_sweep(db, monkeypatch):
    """Once on the first pass, then not again for a minute: counted in the
    loop's own passes, not timed."""
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def fake_plans(maker):
        calls.append(maker)
        return {"reminders": 0, "digests": 0, "errors": 0}

    monkeypatch.setattr(worker_mod, "run_plan_reminders_once", fake_plans)
    passes = _count_loops(monkeypatch, worker_mod)
    assert worker_mod.PLANS_INTERVAL_SECONDS == 60
    task = asyncio.create_task(run_forever(poll_seconds=0.01))
    try:
        await _until(lambda: len(passes) >= 4, task)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) == 1   # once on the first pass; the next is a minute away


async def test_plan_sweep_errors_do_not_kill_the_loop(db, monkeypatch, caplog):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def boom(maker):
        calls.append(1)
        raise RuntimeError("db down")

    monkeypatch.setattr(worker_mod, "run_plan_reminders_once", boom)
    monkeypatch.setattr(worker_mod, "PLANS_INTERVAL_SECONDS", 0)
    caplog.set_level(logging.WARNING, logger="serversherpa.notifications.worker")
    task = asyncio.create_task(run_forever(poll_seconds=0.01))
    try:
        await _until(lambda: len(calls) >= 3, task)
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert caplog.text.count("could not run the plan reminder sweep") == 1   # once per outage


async def test_run_plans_logs_what_it_sent(monkeypatch, caplog):
    from serversherpa.notifications import worker as worker_mod

    async def sent(maker):
        return {"reminders": 3, "digests": 1, "errors": 0}

    monkeypatch.setattr(worker_mod, "run_plan_reminders_once", sent)
    caplog.set_level(logging.INFO, logger="serversherpa.notifications.worker")
    state = {"failed": True}
    await worker_mod.run_plans(object(), state)
    assert state == {"failed": False}
    assert "plans: 3 reminder(s), 1 overdue digest(s)" in caplog.text


async def test_run_forever_delivers_the_outbox(db, monkeypatch):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def fake_deliver(maker):
        calls.append(maker)
        return 0

    monkeypatch.setattr(worker_mod, "deliver_once", fake_deliver)
    task = asyncio.create_task(run_forever(poll_seconds=0.01))
    try:
        # the wait is the check: a 2nd delivery inside it is every poll, not hourly
        await _until(lambda: len(calls) >= 2, task)
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
    task = asyncio.create_task(run_forever(poll_seconds=0.01))
    try:
        # the wait is the check: a 2nd try inside it is every poll, not hourly
        await _until(lambda: len(calls) >= 2, task)
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
