"""Postgres logging pipeline: a stdlib handler that batches records to
log_entries from a dedicated thread with its own small SYNC engine, so
logging never blocks the event loop and behaves identically in every
process. Log writes do NOT route through the log-service — logs still
land when it is down (spec architecture decision A)."""

import logging
import queue
import sys
import threading
import time
from datetime import UTC, datetime

_LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40,
           "CRITICAL": 50}


class DbLogHandler(logging.Handler):
    def __init__(self, process: str, *, queue_size: int = 10000,
                 batch_size: int = 200, flush_seconds: float = 1.0,
                 config_refresh_seconds: float = 30.0) -> None:
        super().__init__(level=logging.DEBUG)
        self.process_name = process
        self._batch_size = batch_size
        self._flush_seconds = flush_seconds
        self._config_refresh = config_refresh_seconds
        self._queue: queue.Queue = queue.Queue(maxsize=queue_size)
        self._stop = threading.Event()
        self._engine = None
        self._min_levelno = _LEVELS["INFO"]
        self._config_read_at = 0.0
        self._last_error_at = 0.0
        self._thread = threading.Thread(
            target=self._run, name=f"db-log-{process}", daemon=True)
        self._thread.start()

    # ── producer side (any thread) ─────────────────────────────
    def emit(self, record: logging.LogRecord) -> None:
        if record.name.startswith("serversherpa.system.db_logging"):
            return                          # recursion guard
        try:
            row = {
                "process": self.process_name,
                "level": record.levelname,
                "levelno": record.levelno,
                "logger": record.name,
                "message": self.format(record),
                "extra": {},
                "at": datetime.now(UTC),
            }
        except Exception:
            return
        while True:
            try:
                self._queue.put_nowait(row)
                return
            except queue.Full:              # drop-oldest under pressure
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    return

    def format(self, record: logging.LogRecord) -> str:
        base = record.getMessage()
        if record.exc_info:
            formatter = logging.Formatter()
            base = f"{base}\n{formatter.formatException(record.exc_info)}"
        return base

    # ── flusher thread ─────────────────────────────────────────
    def _get_engine(self):
        if self._engine is None:
            from sqlalchemy import create_engine

            from serversherpa.config import get_settings
            self._engine = create_engine(
                get_settings().sync_database_url, pool_size=1,
                max_overflow=0, pool_pre_ping=True)
        return self._engine

    def _refresh_config(self) -> None:
        now = time.monotonic()
        if now - self._config_read_at < self._config_refresh:
            return
        self._config_read_at = now
        try:
            from serversherpa.system.config_store import read_section_sync
            data = read_section_sync(self._get_engine(), "logging")
            self._min_levelno = _LEVELS.get(
                str(data.get("min_level", "INFO")).upper(), 20)
        except Exception:
            pass                            # keep the previous threshold

    def _write_batch(self, rows: list[dict]) -> None:
        from serversherpa.db.models import LogEntry
        with self._get_engine().begin() as conn:
            conn.execute(LogEntry.__table__.insert(), rows)

    def _drain(self, max_rows: int) -> list[dict]:
        rows: list[dict] = []
        while len(rows) < max_rows:
            try:
                rows.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return rows

    def _run(self) -> None:
        while not self._stop.is_set():
            self._stop.wait(self._flush_seconds)
            self._flush_once()
        while not self._queue.empty():      # final drain: every batch, not one
            self._flush_once()

    def _flush_once(self) -> None:
        self._refresh_config()
        rows = [r for r in self._drain(self._batch_size)
                if r["levelno"] >= self._min_levelno]
        if not rows:
            return
        try:
            self._write_batch(rows)
        except Exception as exc:            # stderr, once a minute, never logs
            now = time.monotonic()
            if now - self._last_error_at > 60:
                self._last_error_at = now
                print(f"[db_logging] flush failed: {exc}", file=sys.stderr)

    def close(self) -> None:
        logging.getLogger().removeHandler(self)
        _installed.pop(self.process_name, None)
        self._stop.set()
        self._thread.join(timeout=5)
        if self._engine is not None:
            self._engine.dispose()
        super().close()


_installed: dict[str, DbLogHandler] = {}


def install(process: str) -> DbLogHandler:
    """Attach the pipeline for this process. Idempotent. Root goes to
    DEBUG (the handler applies the configured min level itself);
    uvicorn.error propagates in; uvicorn.access is never touched."""
    cached = _installed.get(process)
    if cached is not None:
        if cached._thread.is_alive():
            return cached
        # stale handler from a closed pipeline — discard the corpse
        logging.getLogger().removeHandler(cached)
        _installed.pop(process, None)
    root = logging.getLogger()
    if not root.handlers:                   # keep terminals readable
        stderr = logging.StreamHandler()
        stderr.setLevel(logging.INFO)
        stderr.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(stderr)
    root.setLevel(logging.DEBUG)
    handler = DbLogHandler(process)
    root.addHandler(handler)
    logging.getLogger("uvicorn.error").propagate = True
    _installed[process] = handler
    return handler
