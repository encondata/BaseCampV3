"""log-service: retention per config mode + the web probe."""

from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import func, select

from serversherpa.db.models import LogEntry, SystemConfig, SystemProcess
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


async def test_retention_row_cap(db):
    await _set_logging(db, local_max_rows_per_process=10)
    await _fill(db, "api", 25)
    await _fill(db, "import-worker", 5)
    result = await log_service.enforce_retention(db)
    assert result["deleted"] == 15
    assert await _count(db, "api") == 10
    assert await _count(db, "import-worker") == 5     # under cap: untouched
    # newest survive
    newest = (await db.scalars(select(LogEntry.message).where(
        LogEntry.process == "api").order_by(LogEntry.id.desc()))).first()
    assert newest == "m24"


async def test_retention_age_cap(db):
    await _set_logging(db, local_max_age_days=7)
    await _fill(db, "api", 3, age_days=10)
    await _fill(db, "api", 2, age_days=0)
    await log_service.enforce_retention(db)
    assert await _count(db, "api") == 2


async def test_remote_mode_uses_buffer_cap(db):
    await _set_logging(db, mode="remote", remote_buffer_rows=4,
                       local_max_rows_per_process=10000)
    await _fill(db, "api", 10)
    await log_service.enforce_retention(db)
    assert await _count(db, "api") == 4


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
