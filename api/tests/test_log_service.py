"""log-service: retention per config mode + the web probe."""

import uuid
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import func, select

from serversherpa.db.models import (
    LogEntry,
    NotificationEvent,
    NotificationLog,
    SystemConfig,
    SystemProcess,
)
from serversherpa.system import log_service


async def _fill(db, process, n, *, age_days=0):
    at = datetime.now(UTC) - timedelta(days=age_days)
    db.add_all([LogEntry(process=process, level="INFO", levelno=20,
                         message=f"m{i}", at=at) for i in range(n)])
    await db.commit()


async def _set_logging(db, **over):
    cfg = await db.get(SystemConfig, "logging")
    cfg.data = {**cfg.data, **over}
    await db.commit()


async def _count(db, process):
    return await db.scalar(select(func.count()).select_from(LogEntry)
                           .where(LogEntry.process == process))


# Retention tests use process names no live log handler writes ("ret-*"):
# in the shared pytest interpreter, handlers installed by earlier tests
# (api / import-worker) keep flushing stray rows between truncation and
# our assertions, so counts on those names — and the global deleted
# total — are not stable.

async def test_retention_row_cap(db):
    await _set_logging(db, local_max_rows_per_process=10)
    await _fill(db, "ret-a", 25)
    await _fill(db, "ret-b", 5)
    result = await log_service.enforce_retention(db)
    assert result["deleted"] >= 15                    # ours, + any strays
    assert await _count(db, "ret-a") == 10
    assert await _count(db, "ret-b") == 5             # under cap: untouched
    # newest survive
    newest = (await db.scalars(select(LogEntry.message).where(
        LogEntry.process == "ret-a").order_by(LogEntry.id.desc()))).first()
    assert newest == "m24"


async def test_retention_age_cap(db):
    await _set_logging(db, local_max_age_days=7)
    await _fill(db, "ret-age", 3, age_days=10)
    await _fill(db, "ret-age", 2, age_days=0)
    await log_service.enforce_retention(db)
    assert await _count(db, "ret-age") == 2


async def test_retention_deletes_old_notification_log_rows(db):
    # Same cutoff as log_entries. Live log handlers only add fresh rows, so
    # nothing but our two old rows can count toward `deleted` here.
    await _set_logging(db, local_max_age_days=7)
    now = datetime.now(UTC)
    db.add_all([
        NotificationLog(event="inbox_written", channel="inbox", kind="old-1",
                        at=now - timedelta(days=10)),
        NotificationLog(event="email_sent", channel="email", kind="old-2",
                        at=now - timedelta(days=8)),
        NotificationLog(event="inbox_written", channel="inbox", kind="fresh", at=now),
    ])
    await db.commit()
    result = await log_service.enforce_retention(db)
    assert result["deleted"] >= 2
    kept = (await db.scalars(select(NotificationLog.kind))).all()
    assert kept == ["fresh"]


async def test_retention_deletes_old_sent_notification_events(db):
    # A sent event ages out on the same cutoff; one still waiting stays,
    # however long it has waited.
    await _set_logging(db, local_max_age_days=7)
    now = datetime.now(UTC)

    def event(title, *, created_at, sent_at):
        return NotificationEvent(kind="initiative_status_changed", subject_type="initiative",
                                 subject_id=uuid.uuid4(), item={"title": title},
                                 created_at=created_at, sent_at=sent_at)

    db.add_all([
        event("old", created_at=now - timedelta(days=10), sent_at=now - timedelta(days=10)),
        event("waiting", created_at=now - timedelta(days=10), sent_at=None),
        event("fresh", created_at=now - timedelta(days=10), sent_at=now - timedelta(days=1)),
    ])
    await db.commit()
    result = await log_service.enforce_retention(db)
    assert result["deleted"] >= 1
    kept = (await db.scalars(select(NotificationEvent.item["title"].astext)
                             .order_by(NotificationEvent.id))).all()
    assert kept == ["waiting", "fresh"]


async def test_remote_mode_uses_buffer_cap(db):
    await _set_logging(db, mode="remote", remote_buffer_rows=4,
                       local_max_rows_per_process=10000)
    await _fill(db, "ret-buf", 10)
    await log_service.enforce_retention(db)
    assert await _count(db, "ret-buf") == 4


async def test_probe_web_up_and_down(db, monkeypatch):
    class FakeResponse:
        status_code = 200

    async def fake_get(self, url, **kw):
        if "down" in url:
            raise httpx.ConnectError("refused")
        return FakeResponse()

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    await log_service.probe_web(db, "http://portal-up.local")
    row = await db.get(SystemProcess, "web")
    assert row.kind == "probe"
    assert row.heartbeat_at is not None
    assert row.meta["status_code"] == 200
    beat = row.heartbeat_at

    await log_service.probe_web(db, "http://portal-down.local")
    await db.refresh(row)
    assert row.heartbeat_at == beat            # not advanced on failure
    assert "refused" in row.meta["error"]
