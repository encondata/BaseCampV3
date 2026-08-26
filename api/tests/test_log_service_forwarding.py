"""Forwarding: Loki pushes against a live local HTTP capture server,
syslog against a local UDP listener, cursor semantics, degraded flag."""

import json
import socket
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from sqlalchemy import select

from serversherpa.db.models import LogEntry, SystemConfig, SystemProcess
from serversherpa.system import log_service


@pytest.fixture(autouse=True)
async def _quiet_pipeline(db):
    """Close any live DB log handlers left installed by earlier tests in
    this interpreter — their background flushes would add stray rows and
    break this file's exact forwarded-count assertions. close() itself
    DRAINS each handler's pending queue into log_entries (by design), so
    purge the table afterwards for a truly clean slate."""
    from sqlalchemy import text as sql_text

    from serversherpa.system import db_logging
    for name in list(db_logging._installed):
        db_logging._installed[name].close()
    await db.execute(sql_text("DELETE FROM log_entries"))
    await db.commit()
    yield


class _Capture(BaseHTTPRequestHandler):
    requests: list = []
    status = 204

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        type(self).requests.append({
            "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": json.loads(self.rfile.read(length) or b"{}"),
        })
        self.send_response(type(self).status)
        self.end_headers()

    def log_message(self, *args):
        pass


def _http_server():
    server = HTTPServer(("127.0.0.1", 0), _Capture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


async def _fill(db, n, process="fwd-a", levelno=20, level="INFO"):
    db.add_all([LogEntry(process=process, level=level, levelno=levelno,
                         logger="t", message=f"fwd {i}")
                for i in range(n)])
    await db.commit()


async def _configure(db, **over):
    cfg = await db.get(SystemConfig, "logging")
    data = {**cfg.data, "mode": "local_remote", "transport": "loki", **over}
    cfg.data = data
    await db.commit()


async def _cursor(db):
    row = await db.get(SystemConfig, "logging_cursor")
    await db.refresh(row)
    return row.data["last_forwarded_id"]


async def test_loki_forwarding_advances_cursor(db):
    _Capture.requests = []
    server = _http_server()
    try:
        await _configure(db, loki={
            "url": f"http://127.0.0.1:{server.server_port}",
            "username": "u", "password": "p", "tenant_id": "t1"})
        await _fill(db, 2)
        await _fill(db, 1, process="fwd-b", levelno=40, level="ERROR")
        result = await log_service.forward_pending(db)
        assert result["forwarded"] == 3
        [req] = _Capture.requests
        assert req["path"] == "/loki/api/v1/push"
        assert req["headers"]["x-scope-orgid"] == "t1"
        assert req["headers"]["authorization"].startswith("Basic ")
        labels = {(s["stream"]["process"], s["stream"]["level"])
                  for s in req["body"]["streams"]}
        assert labels == {("fwd-a", "INFO"), ("fwd-b", "ERROR")}
        max_id = await db.scalar(
            select(LogEntry.id).order_by(LogEntry.id.desc()).limit(1))
        assert await _cursor(db) == max_id
        # nothing new -> second pass forwards nothing
        _Capture.requests = []
        assert (await log_service.forward_pending(db))["forwarded"] == 0
        assert _Capture.requests == []
    finally:
        server.shutdown()


async def test_forwarding_batches(db, monkeypatch):
    monkeypatch.setattr(log_service, "FORWARD_BATCH", 2)
    _Capture.requests = []
    server = _http_server()
    try:
        await _configure(db, loki={"url": f"http://127.0.0.1:{server.server_port}",
                                   "username": "", "password": "",
                                   "tenant_id": ""})
        await _fill(db, 5)
        result = await log_service.forward_pending(db)
        assert result["forwarded"] == 5
        assert len(_Capture.requests) == 3          # 2 + 2 + 1
    finally:
        server.shutdown()


async def test_failed_push_holds_cursor(db):
    _Capture.requests = []
    _Capture.status = 500
    server = _http_server()
    try:
        await _configure(db, loki={"url": f"http://127.0.0.1:{server.server_port}",
                                   "username": "", "password": "",
                                   "tenant_id": ""})
        await _fill(db, 2)
        before = await _cursor(db)
        try:
            await log_service.forward_pending(db)
            raised = False
        except Exception:
            raised = True
        assert raised
        assert await _cursor(db) == before
    finally:
        _Capture.status = 204
        server.shutdown()


async def test_syslog_udp_forwarding(db):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))
    sock.settimeout(5)
    try:
        await _configure(db, transport="syslog",
                         syslog={"host": "127.0.0.1",
                                 "port": sock.getsockname()[1],
                                 "protocol": "udp"})
        await _fill(db, 1, process="fwd-sys")
        assert (await log_service.forward_pending(db))["forwarded"] == 1
        frame = sock.recv(65535).decode()
        assert frame.startswith("<134>1 ")
        assert "serversherpa-fwd-sys" in frame
        body = json.loads(frame.split(" - - - ", 1)[1])
        assert body["message"] == "fwd 0"
    finally:
        sock.close()


async def test_unconfigured_forwards_nothing(db):
    await _fill(db, 2)
    assert (await log_service.forward_pending(db))["forwarded"] == 0


async def test_degraded_flag_set_and_cleared(db):
    now = datetime.now(UTC)
    db.add(SystemProcess(name="log-service", kind="worker",
                         heartbeat_at=now, meta={}))
    await db.commit()
    await log_service.set_forwarding_degraded(db, "connection refused")
    row = await db.get(SystemProcess, "log-service")
    await db.refresh(row)
    assert row.meta["forwarding_degraded"] is True
    assert "refused" in row.meta["forwarding_error"]
    await log_service.set_forwarding_degraded(db, None)
    await db.refresh(row)
    assert "forwarding_degraded" not in row.meta
    assert "forwarding_error" not in row.meta
