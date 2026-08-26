"""0024: processes / log_entries / system_config tables + seeded config."""

from sqlalchemy import select

from serversherpa.db.models import LogEntry, SystemConfig, SystemProcess


async def test_system_process_defaults(db):
    p = SystemProcess(name="api", kind="service")
    db.add(p)
    await db.commit()
    await db.refresh(p)
    assert p.pid is None
    assert p.hostname == ""
    assert p.started_at is None and p.heartbeat_at is None
    assert p.stopped_at is None
    assert p.meta == {}


async def test_log_entry_defaults_and_ordering(db):
    db.add_all([
        LogEntry(process="api", level="INFO", levelno=20, message="one"),
        LogEntry(process="api", level="ERROR", levelno=40, message="two"),
    ])
    await db.commit()
    rows = (await db.scalars(
        select(LogEntry).order_by(LogEntry.id))).all()
    assert [r.message for r in rows] == ["one", "two"]
    assert rows[0].id < rows[1].id            # bigserial cursor
    assert rows[0].logger == ""
    assert rows[0].extra == {}
    assert rows[0].at is not None


async def test_logging_config_seeded(db):
    cfg = await db.get(SystemConfig, "logging")
    assert cfg is not None
    assert cfg.data["mode"] == "local"
    assert cfg.data["local_max_rows_per_process"] == 20000
    assert cfg.data["local_max_age_days"] == 14
    assert cfg.data["remote_buffer_rows"] == 10000
    assert cfg.data["min_level"] == "INFO"
    assert cfg.data["syslog"] == {"host": "", "port": 514, "protocol": "udp"}
    cursor = await db.get(SystemConfig, "logging_cursor")
    assert cursor.data == {"last_forwarded_id": 0}
