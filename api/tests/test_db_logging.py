"""DB log handler: batching, level threshold, recursion guard, bounds."""

import logging
import time

from sqlalchemy import create_engine, select, text

from serversherpa.config import get_settings
from serversherpa.db.models import LogEntry
from serversherpa.system.db_logging import DbLogHandler


def _wait_for(check, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    return check()


def _count(process):
    engine = create_engine(get_settings().sync_database_url)
    with engine.connect() as conn:
        n = conn.execute(
            text("SELECT count(*) FROM log_entries WHERE process = :p"),
            {"p": process}).scalar()
    engine.dispose()
    return n


async def test_records_land_in_batches(db):
    handler = DbLogHandler("t-batch", flush_seconds=0.1)
    logger = logging.getLogger("serversherpa.test.batch")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        logger.info("hello %s", "world")
        try:
            raise ValueError("boom")
        except ValueError:
            logger.exception("it broke")
        assert _wait_for(lambda: _count("t-batch") == 2)
    finally:
        logger.removeHandler(handler)
        handler.close()
    rows = (await db.scalars(select(LogEntry).where(
        LogEntry.process == "t-batch").order_by(LogEntry.id))).all()
    assert rows[0].message == "hello world"
    assert rows[0].level == "INFO" and rows[0].levelno == 20
    assert rows[0].logger == "serversherpa.test.batch"
    assert "ValueError: boom" in rows[1].message      # traceback included
    assert rows[1].level == "ERROR"


async def test_min_level_filters(db):
    # config seeds min_level INFO — DEBUG records must not land
    handler = DbLogHandler("t-level", flush_seconds=0.1)
    logger = logging.getLogger("serversherpa.test.level")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        logger.debug("too quiet")
        logger.warning("loud enough")
        assert _wait_for(lambda: _count("t-level") == 1)
        time.sleep(0.3)
        assert _count("t-level") == 1
    finally:
        logger.removeHandler(handler)
        handler.close()


async def test_flush_errors_never_recurse(db, monkeypatch):
    handler = DbLogHandler("t-recurse", flush_seconds=0.1)
    monkeypatch.setattr(handler, "_write_batch",
                        lambda rows: (_ for _ in ()).throw(RuntimeError("db down")))
    logger = logging.getLogger("serversherpa.test.recurse")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        logger.error("during outage")
        time.sleep(0.4)                     # give the flusher time to fail
        assert _count("t-recurse") == 0     # nothing landed, nothing crashed
    finally:
        logger.removeHandler(handler)
        handler.close()


async def test_bounded_queue_drops_oldest(db):
    handler = DbLogHandler("t-bound", queue_size=5, flush_seconds=60.0)
    logger = logging.getLogger("serversherpa.test.bound")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        for i in range(20):
            logger.info("msg %d", i)
        # force one flush now by closing (close drains the queue)
    finally:
        logger.removeHandler(handler)
        handler.close()
    rows = _wait_for(lambda: _count("t-bound") == 5) and None
    engine = create_engine(get_settings().sync_database_url)
    with engine.connect() as conn:
        msgs = [r[0] for r in conn.execute(text(
            "SELECT message FROM log_entries WHERE process = 't-bound' "
            "ORDER BY id"))]
    engine.dispose()
    assert len(msgs) == 5
    assert msgs[-1] == "msg 19"             # newest kept, oldest dropped


async def test_close_detaches_from_root_and_registry(db):
    import logging as _logging

    from serversherpa.system import db_logging
    handler = db_logging.install("t-close-detach")
    assert handler in _logging.getLogger().handlers
    handler.close()
    assert handler not in _logging.getLogger().handlers
    assert "t-close-detach" not in db_logging._installed


async def test_reinstall_after_close_returns_live_handler(db):
    from serversherpa.system import db_logging
    first = db_logging.install("t-reinstall")
    first.close()
    second = db_logging.install("t-reinstall")
    try:
        assert second is not first
        assert second._thread.is_alive()
    finally:
        second.close()


async def test_close_drains_every_pending_batch(db):
    handler = DbLogHandler("t-drain", batch_size=3, flush_seconds=60.0)
    logger = logging.getLogger("serversherpa.test.drain")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        for i in range(10):
            logger.info("drain %d", i)
    finally:
        logger.removeHandler(handler)
        handler.close()          # must flush all 4 batches, not just one
    assert _count("t-drain") == 10
