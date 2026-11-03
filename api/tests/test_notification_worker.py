"""notification-worker: heartbeat, the sweeps and status logs. The idle status line
reports the email held for a summary. Run_forever smoke tests modeled on
test_system_registry.py's direct use of the `db` fixture alongside a heartbeat task
writing through its own session."""

import asyncio
import logging
from datetime import UTC, datetime

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import NotificationHeld, Person, SystemProcess
from serversherpa.notifications.worker import held_count, run_forever, run_once


async def _person(db, first="Terry", last="Tech"):
    p = Person(first_name=first, last_name=last)
    db.add(p)
    await db.flush()
    return p


async def _hold(db, person, *, reason="quiet_hours"):
    """One notification email held for `person`'s summary (no inbox row behind it: a
    deleted notification leaves the held row, and it still waits)."""
    db.add(NotificationHeld(person_id=person.id, kind="report_ready", category="reports",
                            reason=reason, held_at=datetime.now(UTC)))
    await db.flush()


def _worker_lines(caplog) -> list[str]:
    return [record.getMessage() for record in caplog.records
            if record.name == "serversherpa.notifications.worker"]


async def test_held_count_counts_every_held_email(db):
    assert await held_count(db) == 0
    a = await _person(db, "A")
    b = await _person(db, "B")
    await _hold(db, a)
    await _hold(db, a, reason="inactive_day")
    await _hold(db, b)
    await db.commit()

    assert await held_count(db) == 3


async def test_run_once_logs_idle_status_line(db, caplog):
    a = await _person(db, "A")
    b = await _person(db, "B")
    await _hold(db, a)
    await _hold(db, a)
    await _hold(db, b, reason="inactive_day")
    await db.commit()

    caplog.set_level(logging.INFO, logger="serversherpa.notifications.worker")
    await run_once(get_sessionmaker())

    # one line, and it says nothing of groups or members: they no longer decide email
    assert _worker_lines(caplog) == [
        "idle — 3 email(s) waiting for a summary; email delivery off (SMTP not configured)"]


async def test_run_once_idle_line_with_nothing_held(db, caplog):
    caplog.set_level(logging.INFO, logger="serversherpa.notifications.worker")
    await run_once(get_sessionmaker())

    assert _worker_lines(caplog) == [
        "idle — 0 email(s) waiting for a summary; email delivery off (SMTP not configured)"]


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


async def test_run_forever_runs_the_learning_sweep(db, monkeypatch):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def fake_learning(maker):
        calls.append(maker)
        return {"invites": 0, "reminders": 0, "overdue": 0, "errors": 0}

    monkeypatch.setattr(worker_mod, "run_learning_once", fake_learning)
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) == 1   # once on the first loop; the next is a minute away


async def test_run_forever_runs_the_summary_sweep(db, monkeypatch, caplog):
    from serversherpa.notifications import worker as worker_mod

    calls = []

    async def fake_summaries(maker):
        calls.append(maker)
        return 2

    monkeypatch.setattr(worker_mod, "run_summaries_once", fake_summaries)
    caplog.set_level(logging.INFO, logger="serversherpa.notifications.worker")
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert len(calls) == 1   # once on the first loop; the next is a minute away
    assert "queued 2 notification summary email(s)" in caplog.text


async def test_summary_sweep_errors_do_not_kill_the_loop(db, monkeypatch, caplog):
    from serversherpa.notifications import worker as worker_mod

    async def boom(maker):
        raise RuntimeError("db down")

    monkeypatch.setattr(worker_mod, "run_summaries_once", boom)
    monkeypatch.setattr(worker_mod, "SUMMARY_INTERVAL_SECONDS", 0)
    caplog.set_level(logging.WARNING, logger="serversherpa.notifications.worker")
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert caplog.text.count("could not run the summary sweep") == 1   # once per outage


async def test_run_forever_runs_the_event_sweep_before_the_summaries(db, monkeypatch, caplog):
    from serversherpa.notifications import worker as worker_mod

    calls = []
    summaries_ran = asyncio.Event()

    async def fake_events(maker):
        calls.append("events")
        return 3

    async def fake_summaries(maker):
        calls.append("summaries")
        summaries_ran.set()
        return 0

    monkeypatch.setattr(worker_mod, "run_events_once", fake_events)
    monkeypatch.setattr(worker_mod, "run_summaries_once", fake_summaries)
    caplog.set_level(logging.INFO, logger="serversherpa.notifications.worker")
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        # The first loop does other work (the outbox, the reminder and learning sweeps) before
        # the two under test, and how long that takes depends on the machine: wait until the
        # summaries have run, with a limit only to end a hang, rather than for a fixed time.
        await asyncio.wait_for(summaries_ran.wait(), timeout=60)
        # Then let several more polls go by: neither sweep is due again for a minute.
        await asyncio.sleep(0.3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    # once each on the first loop, the events first; the next are a minute away
    assert calls == ["events", "summaries"]
    assert "wrote 3 notification(s) from events" in caplog.text


async def test_event_sweep_errors_do_not_kill_the_loop(db, monkeypatch, caplog):
    from serversherpa.notifications import worker as worker_mod

    async def boom(maker):
        raise RuntimeError("db down")

    monkeypatch.setattr(worker_mod, "run_events_once", boom)
    monkeypatch.setattr(worker_mod, "EVENTS_INTERVAL_SECONDS", 0)
    caplog.set_level(logging.WARNING, logger="serversherpa.notifications.worker")
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert caplog.text.count("could not run the event sweep") == 1   # once per outage
    assert "RuntimeError" in caplog.text
    assert "db down" not in caplog.text          # the class only, never the text


async def test_learning_sweep_errors_do_not_kill_the_loop(db, monkeypatch, caplog):
    from serversherpa.notifications import worker as worker_mod

    async def boom(maker):
        raise RuntimeError("db down")

    monkeypatch.setattr(worker_mod, "run_learning_once", boom)
    monkeypatch.setattr(worker_mod, "LEARNING_INTERVAL_SECONDS", 0)
    caplog.set_level(logging.WARNING, logger="serversherpa.notifications.worker")
    task = asyncio.create_task(run_forever(poll_seconds=0.05))
    try:
        await asyncio.sleep(0.3)
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert caplog.text.count("could not run the learning sweep") == 1   # once per outage


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


def test_cli_once_runs_the_status_pass_the_sweeps_and_one_delivery_pass(monkeypatch):
    """`notification-worker --once` turns waiting events into notifications,
    sends the summaries that are due, then delivers due mail, so what the
    sweeps queue goes out in the same run (CLI surface only: the passes
    themselves are faked)."""
    from typer.testing import CliRunner

    from serversherpa import cli
    from serversherpa.db import engine as engine_mod
    from serversherpa.mail import delivery
    from serversherpa.notifications import worker as worker_mod

    calls: list[str] = []

    async def fake_status(maker):
        calls.append("status")

    async def fake_events(maker):
        calls.append("events")
        return 4

    async def fake_summaries(maker):
        calls.append("summaries")
        return 2

    async def fake_deliver(maker):
        calls.append("deliver")
        return 3

    async def no_dispose():
        pass

    monkeypatch.setattr(engine_mod, "get_sessionmaker", lambda: object())
    monkeypatch.setattr(worker_mod, "run_once", fake_status)
    monkeypatch.setattr(worker_mod, "run_events_once", fake_events)
    monkeypatch.setattr(worker_mod, "run_summaries_once", fake_summaries)
    monkeypatch.setattr(delivery, "deliver_once", fake_deliver)
    monkeypatch.setattr(cli, "dispose_engine", no_dispose)
    result = CliRunner().invoke(cli.app, ["notification-worker", "--once"])
    assert result.exit_code == 0, result.output
    assert calls == ["status", "events", "summaries", "deliver"]
    assert "wrote 4 notification(s) from events" in result.output
    assert "queued 2 summary email(s)" in result.output
    assert "processed 3 queued email(s)" in result.output
