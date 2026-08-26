# Process Monitor & Logging — Plan 2 (Config + Loki/Syslog Forwarding) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The logging config API + Developer→System Config page (Logging tab with a transport selector), and real remote forwarding in the log-service: Grafana Loki HTTP push (primary) and syslog RFC 5424 (Wazuh-ready).

**Architecture:** `config_store.DEFAULTS` grows `transport`/`loki` keys (defaults-merge — no migration). A pure `forwarders.py` builds Loki push payloads (streams grouped by process/level, ns timestamps) and RFC 5424 frames, with thin async senders. The log-service gains a cursor-driven `forward_pending` drain with exponential backoff and a `forwarding_degraded` flag on its registry row. Three devtools-gated config endpoints (GET masks the Loki password; PUT validates + keeps-on-empty; POST test fires one immediate send). The portal gets a tabbed `/dev/system-config` page whose first tab edits all of it.

**Tech Stack:** FastAPI/httpx/SQLAlchemy (api/), React+TypeScript+vitest (portal/).

**Spec:** `docs/superpowers/specs/2026-08-26-process-monitor-logging-design.md` (amended 2026-08-26 for Loki). Plan 1 shipped the registry/pipeline/viewer; this plan builds ONLY the config + forwarding half.

## Global Constraints

- Branch `feature/initiatives`, repo `/Users/jrh1812/Developer/BaseCampV3`. NO new migration — config shape grows via `config_store.DEFAULTS` merge.
- API tests: `cd api && .venv/bin/pytest tests/<file> -q` (docker stack up). Portal: `cd portal && npx vitest run <file>`; `npx tsc --noEmit`. Foreground only.
- Config shape (exact): `mode: local|local_remote|remote`; `transport: loki|syslog` (default `loki`); `loki: {url: "", username: "", password: "", tenant_id: ""}`; `syslog: {host: "", port: 514, protocol: udp|tcp|tls}`; plus the existing caps/min_level keys.
- Loki push: `POST {url minus trailing /}/loki/api/v1/push`; labels exactly `{app: "serversherpa", process, level, host}`; values `[nanosecond-string, "<logger>: <message>"]` (bare message when logger empty); streams grouped by (process, level); optional HTTP basic auth from username/password; optional `X-Scope-OrgID` from tenant_id; non-2xx ⇒ failure.
- Syslog: RFC 5424, facility 16 (local0), severity map {10:7, 20:6, 30:4, 40:3, 50:2, else 6}; APP-NAME `serversherpa-<process>`; MSG = JSON `{process, level, logger, message, at, extra}`; UDP datagrams, or TCP/TLS with octet-counting framing (`"<len> " + frame`).
- Forwarding: batches of `FORWARD_BATCH = 500` past the `logging_cursor` row's `last_forwarded_id`; cursor advances (and commits) only after a successful send; backoff 10 s doubling to 300 s max; `meta.forwarding_degraded` + `meta.forwarding_error` on the `log-service` registry row while failing, cleared on recovery; retention never blocked.
- Password rules: GET returns `loki.password_set: bool`, never the password; PUT with empty `loki.password` keeps the stored one, non-empty replaces; audit changes NEVER contain the password (diff over masked shapes).
- Config endpoints gate: `require_permission("devtools", "change")`. Errors use `_err` codes; PUT failure code `invalid_logging_config` with a `fields` map.
- Portal: Developer nav item "System Config" (godOnly, devtools) between Developer tools and Database; route `/dev/system-config` behind `ProtectedRoute resource="devtools"`. Sentence-case copy, active verbs.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: DEFAULTS extension + pure forwarders module

**Files:**
- Modify: `api/src/serversherpa/system/config_store.py` (DEFAULTS)
- Create: `api/src/serversherpa/system/forwarders.py`
- Test: `api/tests/test_forwarders.py`

**Interfaces:**
- Produces (consumed by Tasks 2–3):
  - `config_store.DEFAULTS["logging"]` gains `"transport": "loki"` and `"loki": {"url": "", "username": "", "password": "", "tenant_id": ""}`.
  - Row-dict contract used everywhere: `{"process", "level", "levelno", "logger", "message", "extra", "at"(datetime)}`.
  - `forwarders.build_loki_payload(rows: list[dict], hostname: str) -> dict`
  - `forwarders.loki_headers(loki_cfg: dict) -> dict`
  - `async forwarders.send_loki(loki_cfg: dict, rows: list[dict], hostname: str) -> None` (raises RuntimeError on non-2xx)
  - `forwarders.build_syslog_frame(row: dict, hostname: str) -> bytes`
  - `async forwarders.send_syslog(syslog_cfg: dict, rows: list[dict], hostname: str) -> None`
  - `forwarders.transport_configured(cfg: dict) -> bool` — False when `mode == "local"`; else loki ⇒ `loki.url` non-empty, syslog ⇒ `syslog.host` non-empty.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_forwarders.py`:

```python
"""Pure transport builders + the config gate. Senders are exercised in
test_log_service_forwarding.py against live local endpoints."""

import base64
import json
from datetime import UTC, datetime

from serversherpa.system.forwarders import (
    build_loki_payload, build_syslog_frame, loki_headers,
    transport_configured,
)

AT = datetime(2026, 8, 26, 12, 0, 0, tzinfo=UTC)


def _row(**over):
    row = {"process": "api", "level": "INFO", "levelno": 20,
           "logger": "serversherpa.x", "message": "hello", "extra": {},
           "at": AT}
    row.update(over)
    return row


def test_loki_payload_groups_by_process_and_level():
    rows = [_row(), _row(message="again"),
            _row(process="import-worker", level="ERROR", levelno=40,
                 message="boom")]
    payload = build_loki_payload(rows, "devbox")
    assert set(payload) == {"streams"}
    streams = {(s["stream"]["process"], s["stream"]["level"]): s
               for s in payload["streams"]}
    assert set(streams) == {("api", "INFO"), ("import-worker", "ERROR")}
    api_stream = streams[("api", "INFO")]
    assert api_stream["stream"] == {"app": "serversherpa", "process": "api",
                                    "level": "INFO", "host": "devbox"}
    ns = str(int(AT.timestamp() * 1_000_000_000))
    assert api_stream["values"] == [[ns, "serversherpa.x: hello"],
                                    [ns, "serversherpa.x: again"]]


def test_loki_line_without_logger_is_bare_message():
    payload = build_loki_payload([_row(logger="")], "devbox")
    assert payload["streams"][0]["values"][0][1] == "hello"


def test_loki_headers_auth_and_tenant():
    assert loki_headers({"url": "x", "username": "", "password": "",
                         "tenant_id": ""}) == {
        "Content-Type": "application/json"}
    headers = loki_headers({"url": "x", "username": "u", "password": "p",
                            "tenant_id": "team1"})
    assert headers["Authorization"] == \
        "Basic " + base64.b64encode(b"u:p").decode()
    assert headers["X-Scope-OrgID"] == "team1"


def test_syslog_frame_shape():
    frame = build_syslog_frame(_row(), "devbox").decode()
    # facility 16, severity 6 (INFO) -> PRI 134
    assert frame.startswith(f"<134>1 {AT.isoformat()} devbox "
                            "serversherpa-api - - - ")
    body = json.loads(frame.split(" - - - ", 1)[1])
    assert body == {"process": "api", "level": "INFO",
                    "logger": "serversherpa.x", "message": "hello",
                    "at": AT.isoformat(), "extra": {}}
    err = build_syslog_frame(_row(levelno=40), "devbox").decode()
    assert err.startswith("<131>1 ")            # 16*8 + 3 (ERROR)
    weird = build_syslog_frame(_row(levelno=25), "devbox").decode()
    assert weird.startswith("<134>1 ")          # unknown levelno -> 6


def _cfg(mode="local_remote", transport="loki", url="http://l:3100",
         host="siem.local"):
    return {"mode": mode, "transport": transport,
            "loki": {"url": url, "username": "", "password": "",
                     "tenant_id": ""},
            "syslog": {"host": host, "port": 514, "protocol": "udp"}}


def test_transport_configured_matrix():
    assert transport_configured(_cfg()) is True
    assert transport_configured(_cfg(mode="local")) is False
    assert transport_configured(_cfg(url="")) is False
    assert transport_configured(_cfg(transport="syslog")) is True
    assert transport_configured(_cfg(transport="syslog", host="")) is False
    assert transport_configured(_cfg(mode="remote")) is True


def test_defaults_grew_transport_keys():
    from serversherpa.system.config_store import DEFAULTS
    logging_defaults = DEFAULTS["logging"]
    assert logging_defaults["transport"] == "loki"
    assert logging_defaults["loki"] == {"url": "", "username": "",
                                        "password": "", "tenant_id": ""}
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_forwarders.py -q`
Expected: FAIL with `ModuleNotFoundError` on `forwarders`.

- [ ] **Step 3: Implement**

In `api/src/serversherpa/system/config_store.py`, extend the logging defaults (after the `"min_level"` line, before `"syslog"`):

```python
        "transport": "loki",
        "loki": {"url": "", "username": "", "password": "",
                 "tenant_id": ""},
```

Also delete the unused `select` from the `from sqlalchemy import select, text` line (a deferred Plan 1 nit — `text` stays).

Create `api/src/serversherpa/system/forwarders.py`:

```python
"""Remote log transports. Primary: Grafana Loki HTTP push (the user's
collector). Secondary: syslog RFC 5424 over UDP/TCP/TLS (Wazuh-ready).
Builders are pure; senders are thin and raise on failure so the
log-service owns retry/backoff policy."""

import asyncio
import base64
import json
import ssl

import httpx

_SEVERITY = {10: 7, 20: 6, 30: 4, 40: 3, 50: 2}   # levelno -> syslog sev
_FACILITY = 16                                     # local0
_LOKI_PUSH_PATH = "/loki/api/v1/push"


def transport_configured(cfg: dict) -> bool:
    if cfg.get("mode") == "local":
        return False
    if cfg.get("transport", "loki") == "loki":
        return bool(cfg.get("loki", {}).get("url"))
    return bool(cfg.get("syslog", {}).get("host"))


# ── Loki ────────────────────────────────────────────────────────────

def build_loki_payload(rows: list[dict], hostname: str) -> dict:
    """Streams grouped by (process, level) — low label cardinality on
    purpose; everything else lives in the line."""
    streams: dict[tuple[str, str], list[list[str]]] = {}
    for r in rows:
        ns = str(int(r["at"].timestamp() * 1_000_000_000))
        line = (f"{r['logger']}: {r['message']}" if r["logger"]
                else r["message"])
        streams.setdefault((r["process"], r["level"]), []).append([ns, line])
    return {"streams": [
        {"stream": {"app": "serversherpa", "process": process,
                    "level": level, "host": hostname},
         "values": values}
        for (process, level), values in streams.items()]}


def loki_headers(loki_cfg: dict) -> dict:
    headers = {"Content-Type": "application/json"}
    if loki_cfg.get("username"):
        raw = f"{loki_cfg['username']}:{loki_cfg.get('password', '')}"
        headers["Authorization"] = (
            "Basic " + base64.b64encode(raw.encode()).decode())
    if loki_cfg.get("tenant_id"):
        headers["X-Scope-OrgID"] = loki_cfg["tenant_id"]
    return headers


async def send_loki(loki_cfg: dict, rows: list[dict],
                    hostname: str) -> None:
    url = loki_cfg["url"].rstrip("/") + _LOKI_PUSH_PATH
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json=build_loki_payload(rows, hostname),
                                 headers=loki_headers(loki_cfg))
    if resp.status_code >= 300:
        raise RuntimeError(
            f"loki push failed: HTTP {resp.status_code}: {resp.text[:200]}")


# ── syslog RFC 5424 ─────────────────────────────────────────────────

def build_syslog_frame(row: dict, hostname: str) -> bytes:
    pri = _FACILITY * 8 + _SEVERITY.get(row["levelno"], 6)
    ts = row["at"].isoformat()
    msg = json.dumps({"process": row["process"], "level": row["level"],
                      "logger": row["logger"], "message": row["message"],
                      "at": ts, "extra": row.get("extra") or {}})
    return (f"<{pri}>1 {ts} {hostname} serversherpa-{row['process']} "
            f"- - - {msg}").encode()


async def send_syslog(syslog_cfg: dict, rows: list[dict],
                      hostname: str) -> None:
    frames = [build_syslog_frame(r, hostname) for r in rows]
    host = syslog_cfg["host"]
    port = int(syslog_cfg["port"])
    protocol = syslog_cfg.get("protocol", "udp")
    if protocol == "udp":
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            asyncio.DatagramProtocol, remote_addr=(host, port))
        try:
            for frame in frames:
                transport.sendto(frame)
        finally:
            transport.close()
        return
    ssl_ctx = ssl.create_default_context() if protocol == "tls" else None
    reader, writer = await asyncio.open_connection(host, port, ssl=ssl_ctx)
    try:
        for frame in frames:                     # octet-counting framing
            writer.write(f"{len(frame)} ".encode() + frame)
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()
```

- [ ] **Step 4: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_forwarders.py tests/test_system_registry.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/system/config_store.py api/src/serversherpa/system/forwarders.py api/tests/test_forwarders.py
git commit -m "feat(api): Loki + syslog forwarders and config defaults

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: log-service forwarding loop

**Files:**
- Modify: `api/src/serversherpa/system/log_service.py`
- Test: `api/tests/test_log_service_forwarding.py`

**Interfaces:**
- Consumes: everything from Task 1; `SystemConfig` (`logging_cursor` row), `SystemProcess`, `LogEntry`.
- Produces:
  - `log_service.FORWARD_BATCH = 500`, `BACKOFF_START = 10.0`, `BACKOFF_MAX = 300.0`.
  - `async log_service.forward_pending(db) -> dict` — drains everything past the cursor in batches via the configured transport; commits the cursor after EACH successful batch; raises on transport failure (cursor holds); returns `{"forwarded": n}` (0 when transport unconfigured).
  - `async log_service.set_forwarding_degraded(db, error: str | None) -> None` — sets/clears `forwarding_degraded` + `forwarding_error` in the `log-service` registry row's meta.
  - `run_forever` gains the backoff'd forwarding step; `run_once` attempts one forward pass (failure logged, not raised).

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_log_service_forwarding.py`:

```python
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
def _quiet_pipeline():
    """Close any live DB log handlers left installed by earlier tests in
    this interpreter — their background flushes would add stray rows and
    break this file's exact forwarded-count assertions."""
    from serversherpa.system import db_logging
    for name in list(db_logging._installed):
        db_logging._installed[name].close()
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
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_log_service_forwarding.py -q`
Expected: FAIL with `AttributeError` (no `forward_pending`).

- [ ] **Step 3: Implement**

In `api/src/serversherpa/system/log_service.py`:

Add imports: `import socket as _socket`, `import time`, and `from serversherpa.db.models import LogEntry, SystemConfig` (extend the existing models import), plus `from serversherpa.system.forwarders import send_loki, send_syslog, transport_configured` and `from sqlalchemy import select`.

Add after the retention section:

```python
FORWARD_BATCH = 500
BACKOFF_START = 10.0
BACKOFF_MAX = 300.0


def _row_dict(entry: LogEntry) -> dict:
    return {"process": entry.process, "level": entry.level,
            "levelno": entry.levelno, "logger": entry.logger,
            "message": entry.message, "extra": entry.extra or {},
            "at": entry.at}


async def forward_pending(db: AsyncSession) -> dict:
    """Drain rows past the forwarding cursor via the configured
    transport. Commits the cursor after each successful batch, so a
    failure never re-sends what already landed. Raises on transport
    failure — the caller owns backoff."""
    cfg = await read_section(db, "logging")
    if not transport_configured(cfg):
        return {"forwarded": 0}
    cursor_row = await db.get(SystemConfig, "logging_cursor")
    if cursor_row is None:
        cursor_row = SystemConfig(section="logging_cursor",
                                  data={"last_forwarded_id": 0})
        db.add(cursor_row)
        await db.flush()
    last = int((cursor_row.data or {}).get("last_forwarded_id", 0))
    hostname = _socket.gethostname()
    total = 0
    while True:
        rows = (await db.scalars(
            select(LogEntry).where(LogEntry.id > last)
            .order_by(LogEntry.id).limit(FORWARD_BATCH))).all()
        if not rows:
            break
        dicts = [_row_dict(r) for r in rows]
        if cfg.get("transport", "loki") == "loki":
            await send_loki(cfg["loki"], dicts, hostname)
        else:
            await send_syslog(cfg["syslog"], dicts, hostname)
        last = rows[-1].id
        cursor_row.data = {"last_forwarded_id": last}
        await db.commit()
        total += len(rows)
        if len(rows) < FORWARD_BATCH:
            break
    if total:
        logger.info("forwarded %d log rows via %s", total,
                    cfg.get("transport", "loki"))
    return {"forwarded": total}


async def set_forwarding_degraded(db: AsyncSession,
                                  error: str | None) -> None:
    row = await db.get(SystemProcess, "log-service")
    if row is None:
        return
    meta = dict(row.meta or {})
    if error is None:
        if "forwarding_degraded" not in meta:
            return
        meta.pop("forwarding_degraded", None)
        meta.pop("forwarding_error", None)
    else:
        meta["forwarding_degraded"] = True
        meta["forwarding_error"] = error[:500]
    row.meta = meta
    await db.commit()
```

Replace `run_once` and `run_forever` with:

```python
async def run_once() -> None:
    from serversherpa.config import get_settings
    from serversherpa.db.engine import get_sessionmaker

    async with get_sessionmaker()() as db:
        await enforce_retention(db)
        await probe_web(db, get_settings().portal_origin)
        try:
            await forward_pending(db)
        except Exception:
            await db.rollback()
            logger.exception("forwarding failed")


async def run_forever(poll_seconds: float = 10.0) -> None:
    from serversherpa.config import get_settings
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("log-service")
    heartbeat = start_heartbeat("log-service", "worker")
    logger.info("log-service watching retention + probe + forwarding")
    tick = 0
    backoff = BACKOFF_START
    next_forward_at = 0.0
    try:
        while True:
            try:
                async with get_sessionmaker()() as db:
                    await enforce_retention(db)
                    if tick % PROBE_EVERY_TICKS == 0:
                        await probe_web(db, get_settings().portal_origin)
            except Exception:
                logger.exception("log-service tick failed")
            if time.monotonic() >= next_forward_at:
                try:
                    async with get_sessionmaker()() as db:
                        await forward_pending(db)
                        await set_forwarding_degraded(db, None)
                    backoff = BACKOFF_START
                    next_forward_at = 0.0
                except Exception as exc:
                    logger.warning("forwarding failed: %s", exc)
                    try:
                        async with get_sessionmaker()() as db:
                            await set_forwarding_degraded(db, str(exc))
                    except Exception:
                        pass
                    next_forward_at = time.monotonic() + backoff
                    backoff = min(backoff * 2, BACKOFF_MAX)
            tick += 1
            await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
```

- [ ] **Step 4: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_log_service_forwarding.py tests/test_log_service.py tests/test_cli_log_service.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/system/log_service.py api/tests/test_log_service_forwarding.py
git commit -m "feat(api): log-service remote forwarding — Loki/syslog, cursor, backoff, degraded flag

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: config endpoints — GET / PUT / test

**Files:**
- Create: `api/src/serversherpa/system/logging_config.py`
- Modify: `api/src/serversherpa/api/routes/system.py` (append)
- Test: `api/tests/test_logging_config.py` (pure) and `api/tests/test_logging_config_api.py` (routes)

**Interfaces:**
- Produces (pure, in `logging_config.py`):
  - `mask_logging(cfg: dict) -> dict` — deep-copied; `loki.password` removed, `loki.password_set: bool` added.
  - `apply_password_rule(incoming: dict, stored: dict) -> dict` — deep-copied incoming with `password_set` stripped; empty/missing `loki.password` replaced by the stored password.
  - `validate_logging(cfg: dict) -> dict[str, str]` — field-path → message; empty when valid. Rules: `mode` in enum; `transport` in {loki, syslog}; `local_max_rows_per_process` int 1000–1_000_000; `local_max_age_days` int 1–365; `remote_buffer_rows` int 1000–1_000_000; `min_level` in DEBUG/INFO/WARNING/ERROR/CRITICAL; when mode includes remote and transport is loki: `loki.url` starts with http:// or https://; when transport is syslog: `syslog.host` non-empty, `syslog.port` int 1–65535, `syslog.protocol` in {udp, tcp, tls}.
- Produces (routes): `GET /system/config/logging` (masked section), `PUT /system/config/logging` (dict body; 422 `invalid_logging_config` + `fields`; audited `entity_type="system"`, `action="logging_config_update"` with masked before/after diff; returns masked result), `POST /system/config/logging/test` (`{"logged": true, "forwarded": bool, "error": str|null}`). All `require_permission("devtools", "change")`.

- [ ] **Step 1: Write the failing pure tests**

Create `api/tests/test_logging_config.py`:

```python
"""Pure config shaping: masking, password keep-rule, validation."""

from serversherpa.system.config_store import DEFAULTS
from serversherpa.system.logging_config import (
    apply_password_rule, mask_logging, validate_logging,
)


def _cfg(**over):
    cfg = {**DEFAULTS["logging"]}
    cfg["loki"] = {**cfg["loki"]}
    cfg["syslog"] = {**cfg["syslog"]}
    for key, value in over.items():
        if isinstance(value, dict):
            cfg[key] = {**cfg[key], **value}
        else:
            cfg[key] = value
    return cfg


def test_mask_hides_password():
    masked = mask_logging(_cfg(loki={"password": "hunter2"}))
    assert "password" not in masked["loki"]
    assert masked["loki"]["password_set"] is True
    assert mask_logging(_cfg())["loki"]["password_set"] is False


def test_password_rule_keeps_and_replaces():
    stored = _cfg(loki={"password": "old"})
    kept = apply_password_rule(_cfg(loki={"password": ""}), stored)
    assert kept["loki"]["password"] == "old"
    replaced = apply_password_rule(_cfg(loki={"password": "new"}), stored)
    assert replaced["loki"]["password"] == "new"
    # password_set from a GET round-trip never persists
    via_get = apply_password_rule(
        {**_cfg(), "loki": {**_cfg()["loki"], "password_set": True}}, stored)
    assert "password_set" not in via_get["loki"]


def test_validate_accepts_defaults_and_good_remote():
    assert validate_logging(_cfg()) == {}
    assert validate_logging(_cfg(
        mode="local_remote", loki={"url": "http://loki:3100"})) == {}
    assert validate_logging(_cfg(
        mode="remote", transport="syslog",
        syslog={"host": "wazuh.local"})) == {}


def test_validate_rejects_bad_fields():
    assert "mode" in validate_logging(_cfg(mode="sometimes"))
    assert "transport" in validate_logging(_cfg(transport="carrier-pigeon"))
    assert "min_level" in validate_logging(_cfg(min_level="LOUD"))
    assert "local_max_rows_per_process" in validate_logging(
        _cfg(local_max_rows_per_process=10))
    assert "local_max_age_days" in validate_logging(
        _cfg(local_max_age_days=0))
    assert "loki.url" in validate_logging(_cfg(mode="local_remote"))
    assert "loki.url" in validate_logging(
        _cfg(mode="remote", loki={"url": "ftp://nope"}))
    assert "syslog.host" in validate_logging(
        _cfg(mode="remote", transport="syslog", syslog={"host": ""}))
    assert "syslog.port" in validate_logging(
        _cfg(mode="remote", transport="syslog",
             syslog={"host": "x", "port": 70000}))
    assert "syslog.protocol" in validate_logging(
        _cfg(mode="remote", transport="syslog",
             syslog={"host": "x", "protocol": "smoke-signal"}))
    # local mode skips transport requireds
    assert validate_logging(_cfg(mode="local")) == {}
```

- [ ] **Step 2: Write the failing route tests**

Create `api/tests/test_logging_config_api.py`:

```python
"""Config endpoints: gates, masking, keep-rule, audit redaction, test."""

import json

from sqlalchemy import select

from serversherpa.db.models import AuditLog, SystemConfig

from .test_assets_api import login
from .test_system_api import _developer_headers, _super_admin_headers


def _remote_body(**over):
    body = {"mode": "local_remote",
            "local_max_rows_per_process": 20000, "local_max_age_days": 14,
            "remote_buffer_rows": 10000, "min_level": "INFO",
            "transport": "loki",
            "loki": {"url": "http://loki:3100", "username": "u",
                     "password": "sekrit", "tenant_id": ""},
            "syslog": {"host": "", "port": 514, "protocol": "udp"}}
    body.update(over)
    return body


async def test_gates(client, db, seeded_user):
    staff = await login(client)
    assert (await client.get("/system/config/logging",
                             headers=staff)).status_code == 403
    sa = await _super_admin_headers(db, client)
    assert (await client.get("/system/config/logging",
                             headers=sa)).status_code == 403


async def test_get_returns_masked_defaults(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    resp = await client.get("/system/config/logging", headers=dev)
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "local"
    assert body["transport"] == "loki"
    assert "password" not in body["loki"]
    assert body["loki"]["password_set"] is False


async def test_put_roundtrip_and_password_keep(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    resp = await client.put("/system/config/logging", headers=dev,
                            json=_remote_body())
    assert resp.status_code == 200, resp.text
    assert "password" not in resp.json()["loki"]
    assert resp.json()["loki"]["password_set"] is True

    stored = await db.get(SystemConfig, "logging")
    await db.refresh(stored)
    assert stored.data["loki"]["password"] == "sekrit"

    # empty password on the next PUT keeps the stored secret
    resp = await client.put("/system/config/logging", headers=dev,
                            json=_remote_body(
                                loki={"url": "http://loki:3100",
                                      "username": "u", "password": "",
                                      "tenant_id": ""}))
    assert resp.status_code == 200
    await db.refresh(stored)
    assert stored.data["loki"]["password"] == "sekrit"


async def test_put_validation_errors(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    resp = await client.put("/system/config/logging", headers=dev,
                            json=_remote_body(loki={"url": "", "username": "",
                                                    "password": "",
                                                    "tenant_id": ""}))
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "invalid_logging_config"
    assert "loki.url" in detail["fields"]


async def test_audit_never_contains_password(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    await client.put("/system/config/logging", headers=dev,
                     json=_remote_body())
    entry = await db.scalar(select(AuditLog).where(
        AuditLog.action == "logging_config_update"))
    assert entry is not None
    assert "sekrit" not in json.dumps(entry.changes)


async def test_test_endpoint(client, db, seeded_user, monkeypatch):
    dev = await _developer_headers(db, client)
    # local mode: logs but does not forward
    resp = await client.post("/system/config/logging/test", headers=dev)
    assert resp.json() == {"logged": True, "forwarded": False, "error": None}

    await client.put("/system/config/logging", headers=dev,
                     json=_remote_body())

    calls = {}

    async def fake_send_loki(cfg, rows, hostname):
        calls["cfg"] = cfg
        calls["rows"] = rows

    from serversherpa.api.routes import system as system_routes
    monkeypatch.setattr(system_routes, "send_loki", fake_send_loki)
    resp = await client.post("/system/config/logging/test", headers=dev)
    assert resp.json()["forwarded"] is True
    assert calls["rows"][0]["message"] == "Test event from System Config"
    assert calls["cfg"]["password"] == "sekrit"     # real secret used

    async def broken(cfg, rows, hostname):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(system_routes, "send_loki", broken)
    resp = await client.post("/system/config/logging/test", headers=dev)
    body = resp.json()
    assert body["forwarded"] is False
    assert "refused" in body["error"]
```

- [ ] **Step 3: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_logging_config.py tests/test_logging_config_api.py -q`
Expected: FAIL (module + routes missing).

- [ ] **Step 4: Implement logging_config.py**

Create `api/src/serversherpa/system/logging_config.py`:

```python
"""Logging-config shaping shared by the API routes: masking (the Loki
password never leaves the server), the PUT password keep-rule, and
validation. Pure — no I/O."""

import copy

MODES = ("local", "local_remote", "remote")
TRANSPORTS = ("loki", "syslog")
LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
PROTOCOLS = ("udp", "tcp", "tls")
ROW_CAP_RANGE = (1000, 1_000_000)
AGE_RANGE = (1, 365)


def mask_logging(cfg: dict) -> dict:
    masked = copy.deepcopy(cfg)
    loki = masked.setdefault("loki", {})
    loki["password_set"] = bool(loki.pop("password", ""))
    return masked


def apply_password_rule(incoming: dict, stored: dict) -> dict:
    data = copy.deepcopy(incoming)
    loki = data.setdefault("loki", {})
    loki.pop("password_set", None)
    if not loki.get("password"):
        loki["password"] = stored.get("loki", {}).get("password", "")
    return data


def _int_in(value, lo, hi) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) \
        and lo <= value <= hi


def validate_logging(cfg: dict) -> dict[str, str]:
    errors: dict[str, str] = {}
    if cfg.get("mode") not in MODES:
        errors["mode"] = "must be local, local_remote, or remote"
    if cfg.get("transport", "loki") not in TRANSPORTS:
        errors["transport"] = "must be loki or syslog"
    if not _int_in(cfg.get("local_max_rows_per_process"), *ROW_CAP_RANGE):
        errors["local_max_rows_per_process"] = \
            f"must be an integer {ROW_CAP_RANGE[0]}–{ROW_CAP_RANGE[1]}"
    if not _int_in(cfg.get("remote_buffer_rows"), *ROW_CAP_RANGE):
        errors["remote_buffer_rows"] = \
            f"must be an integer {ROW_CAP_RANGE[0]}–{ROW_CAP_RANGE[1]}"
    if not _int_in(cfg.get("local_max_age_days"), *AGE_RANGE):
        errors["local_max_age_days"] = \
            f"must be an integer {AGE_RANGE[0]}–{AGE_RANGE[1]}"
    if cfg.get("min_level") not in LEVELS:
        errors["min_level"] = "must be a log level name"

    remote = cfg.get("mode") in ("local_remote", "remote")
    transport = cfg.get("transport", "loki")
    if remote and transport == "loki":
        url = cfg.get("loki", {}).get("url", "")
        if not (isinstance(url, str)
                and url.startswith(("http://", "https://"))):
            errors["loki.url"] = "must be an http(s) URL"
    if remote and transport == "syslog":
        syslog = cfg.get("syslog", {})
        if not syslog.get("host"):
            errors["syslog.host"] = "required for syslog forwarding"
        if not _int_in(syslog.get("port"), 1, 65535):
            errors["syslog.port"] = "must be 1–65535"
        if syslog.get("protocol") not in PROTOCOLS:
            errors["syslog.protocol"] = "must be udp, tcp, or tls"
    return errors
```

- [ ] **Step 5: Implement the routes**

In `api/src/serversherpa/api/routes/system.py`:

Extend imports: `from fastapi import Body`; `from datetime import UTC, datetime` (already there — verify); `from serversherpa.db.models import SystemConfig` (extend existing models import); `from serversherpa.system.config_store import read_section`; `from serversherpa.system.forwarders import send_loki, send_syslog, transport_configured`; `from serversherpa.system.logging_config import apply_password_rule, mask_logging, validate_logging`; `import logging`; `import socket as _socket`.

Append at the end of the file:

```python
# ── logging config (Plan 2) ────────────────────────────────────────

_config_logger = logging.getLogger("serversherpa.system.config")


@router.get("/config/logging")
async def get_logging_config(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    return mask_logging(await read_section(db, "logging"))


@router.put("/config/logging")
async def put_logging_config(
    db: DbSession,
    body: dict = Body(...),
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    stored = await read_section(db, "logging")
    data = apply_password_rule(body, stored)
    errors = validate_logging(data)
    if errors:
        raise _err(422, "invalid_logging_config", fields=errors)

    row = await db.get(SystemConfig, "logging")
    if row is None:
        row = SystemConfig(section="logging")
        db.add(row)
    row.data = data
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor.person.id
    before, after = mask_logging(stored), mask_logging(data)
    changes = {key: {"from": before.get(key), "to": after.get(key)}
               for key in after if before.get(key) != after.get(key)}
    audit(db, actor_id=actor.person.id, entity_type="system",
          entity_id="logging", action="logging_config_update",
          changes=changes)
    await db.commit()
    return mask_logging(data)


@router.post("/config/logging/test")
async def test_logging_config(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    _config_logger.warning("Test event from System Config")
    cfg = await read_section(db, "logging")
    forwarded, error = False, None
    if transport_configured(cfg):
        row = {"process": "api", "level": "WARNING", "levelno": 30,
               "logger": "serversherpa.system.config",
               "message": "Test event from System Config", "extra": {},
               "at": datetime.now(UTC)}
        try:
            if cfg.get("transport", "loki") == "loki":
                await send_loki(cfg["loki"], [row], _socket.gethostname())
            else:
                await send_syslog(cfg["syslog"], [row],
                                  _socket.gethostname())
            forwarded = True
        except Exception as exc:
            error = str(exc)
    return {"logged": True, "forwarded": forwarded, "error": error}
```

- [ ] **Step 6: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_logging_config.py tests/test_logging_config_api.py tests/test_system_api.py -q`
Expected: all passed.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/system/logging_config.py api/src/serversherpa/api/routes/system.py api/tests/test_logging_config.py api/tests/test_logging_config_api.py
git commit -m "feat(api): logging config endpoints — masked GET, validated PUT, test event

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Portal — System Config page + Logging tab

**Files:**
- Modify: `portal/src/lib/api.ts` (append config client)
- Create: `portal/src/lib/systemConfig.ts`
- Test: `portal/src/lib/systemConfig.test.ts`
- Create: `portal/src/pages/SystemConfig.tsx`
- Create: `portal/src/components/system/LoggingTab.tsx`
- Modify: `portal/src/layout/navSections.tsx` (Developer item)
- Modify: `portal/src/App.tsx` (route)
- Modify: `portal/src/styles/system.css` (form styles)

**Interfaces:**
- Consumes: Task 3's endpoints; existing ApiError `(status, code, detail)`.
- Produces (api.ts): `LoggingConfig` type mirroring the API shape (loki has `password?: string` for sends and `password_set?: boolean` from GETs), `getLoggingConfig()`, `putLoggingConfig(cfg)` (on 422 the ApiError's `detail` carries `{fields}`), `testLoggingConfig(): Promise<{logged: boolean; forwarded: boolean; error: string | null}>`.
- Produces (systemConfig.ts): `validateLoggingForm(cfg): Record<string, string>` (client mirror of the server rules), `serverFieldErrors(e: unknown): Record<string, string>` (extracts `fields` from a 422 ApiError, else `{}`).

- [ ] **Step 1: Write the failing helper tests**

Create `portal/src/lib/systemConfig.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { ApiError, type LoggingConfig } from './api';
import { serverFieldErrors, validateLoggingForm } from './systemConfig';

const base = (): LoggingConfig => ({
  mode: 'local', local_max_rows_per_process: 20000,
  local_max_age_days: 14, remote_buffer_rows: 10000, min_level: 'INFO',
  transport: 'loki',
  loki: { url: '', username: '', password: '', tenant_id: '' },
  syslog: { host: '', port: 514, protocol: 'udp' },
});

describe('validateLoggingForm', () => {
  it('accepts defaults and good remote configs', () => {
    expect(validateLoggingForm(base())).toEqual({});
    expect(validateLoggingForm({
      ...base(), mode: 'local_remote',
      loki: { ...base().loki, url: 'http://loki:3100' },
    })).toEqual({});
    expect(validateLoggingForm({
      ...base(), mode: 'remote', transport: 'syslog',
      syslog: { host: 'wazuh.local', port: 514, protocol: 'udp' },
    })).toEqual({});
  });
  it('flags missing transport requirements only when remote', () => {
    expect(validateLoggingForm({ ...base(), mode: 'local_remote' }))
      .toHaveProperty(['loki.url']);
    expect(validateLoggingForm({
      ...base(), mode: 'remote', transport: 'syslog',
    })).toHaveProperty(['syslog.host']);
    expect(validateLoggingForm(base())).toEqual({});
  });
  it('flags bad numbers', () => {
    expect(validateLoggingForm({ ...base(), local_max_age_days: 0 }))
      .toHaveProperty(['local_max_age_days']);
    expect(validateLoggingForm({
      ...base(), mode: 'remote', transport: 'syslog',
      syslog: { host: 'x', port: 70000, protocol: 'udp' },
    })).toHaveProperty(['syslog.port']);
  });
});

describe('serverFieldErrors', () => {
  it('extracts the fields map from a 422', () => {
    const err = new ApiError(422, 'invalid_logging_config',
      { code: 'invalid_logging_config', fields: { 'loki.url': 'bad' } });
    expect(serverFieldErrors(err)).toEqual({ 'loki.url': 'bad' });
  });
  it('empty for anything else', () => {
    expect(serverFieldErrors(new Error('x'))).toEqual({});
    expect(serverFieldErrors(new ApiError(500, 'boom'))).toEqual({});
  });
});
```

NOTE: check `ApiError`'s real constructor/`detail` field in `portal/src/lib/api.ts` before writing — the test sketch assumes `(status, code, detail)` with `detail` holding the response's detail object; adapt to reality (mirroring how `errorFrom` builds it).

- [ ] **Step 2: Run — must fail**

Run: `cd portal && npx vitest run src/lib/systemConfig.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the lib pieces**

Append to `portal/src/lib/api.ts`:

```typescript
// ── system config: logging section ──────────────────────────────────

export interface LoggingConfig {
  mode: 'local' | 'local_remote' | 'remote';
  local_max_rows_per_process: number;
  local_max_age_days: number;
  remote_buffer_rows: number;
  min_level: string;
  transport: 'loki' | 'syslog';
  loki: { url: string; username: string; password?: string;
          password_set?: boolean; tenant_id: string };
  syslog: { host: string; port: number; protocol: 'udp' | 'tcp' | 'tls' };
}

export async function getLoggingConfig(): Promise<LoggingConfig> {
  const resp = await apiFetch('/system/config/logging');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function putLoggingConfig(
  cfg: LoggingConfig,
): Promise<LoggingConfig> {
  const resp = await apiFetch('/system/config/logging', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function testLoggingConfig(): Promise<{
  logged: boolean; forwarded: boolean; error: string | null;
}> {
  const resp = await apiFetch('/system/config/logging/test',
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

Create `portal/src/lib/systemConfig.ts`:

```typescript
/** Pure helpers for the System Config → Logging tab. */

import { ApiError, type LoggingConfig } from './api';

const LEVELS = new Set(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);

function intIn(value: number, lo: number, hi: number): boolean {
  return Number.isInteger(value) && value >= lo && value <= hi;
}

export function validateLoggingForm(
  cfg: LoggingConfig,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!intIn(cfg.local_max_rows_per_process, 1000, 1_000_000)) {
    errors.local_max_rows_per_process = 'Enter 1,000–1,000,000 rows.';
  }
  if (!intIn(cfg.remote_buffer_rows, 1000, 1_000_000)) {
    errors.remote_buffer_rows = 'Enter 1,000–1,000,000 rows.';
  }
  if (!intIn(cfg.local_max_age_days, 1, 365)) {
    errors.local_max_age_days = 'Enter 1–365 days.';
  }
  if (!LEVELS.has(cfg.min_level)) {
    errors.min_level = 'Pick a log level.';
  }
  const remote = cfg.mode !== 'local';
  if (remote && cfg.transport === 'loki'
      && !/^https?:\/\//.test(cfg.loki.url)) {
    errors['loki.url'] = 'Enter the Loki base URL (http:// or https://).';
  }
  if (remote && cfg.transport === 'syslog') {
    if (!cfg.syslog.host) errors['syslog.host'] = 'Enter the syslog host.';
    if (!intIn(cfg.syslog.port, 1, 65535)) {
      errors['syslog.port'] = 'Enter a port 1–65535.';
    }
  }
  return errors;
}

export function serverFieldErrors(e: unknown): Record<string, string> {
  if (e instanceof ApiError && e.code === 'invalid_logging_config') {
    const fields = (e.detail as { fields?: Record<string, string> } | null)
      ?.fields;
    if (fields) return fields;
  }
  return {};
}
```

(Adapt `e.detail` access to ApiError's real field per the Step 1 NOTE.)

- [ ] **Step 4: Build the page + tab + nav + route**

Create `portal/src/pages/SystemConfig.tsx` — a thin tab shell:

```tsx
/** Developer → System Config: tabbed system settings. Each tab is one
 *  component; adding a tab = one entry + one file. */

import { useState } from 'react';

import LoggingTab from '../components/system/LoggingTab';
import '../styles/system.css';

const TABS = [
  { key: 'logging', label: 'Logging', component: LoggingTab },
] as const;

export default function SystemConfig() {
  const [active, setActive] = useState<string>(TABS[0].key);
  const Tab = TABS.find((t) => t.key === active)?.component ?? LoggingTab;
  return (
    <div className="portal-page">
      <div className="eyebrow">Developer</div>
      <h1 className="page-title">System Config</h1>
      <div className="sysconf-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button"
                  className={`mini-btn${active === t.key ? ' active' : ''}`}
                  onClick={() => setActive(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <Tab />
    </div>
  );
}
```

Create `portal/src/components/system/LoggingTab.tsx`. Structure spec — every commented behavior must be REAL code, reusing the portal's form idioms (`init-panel`, `init-field`-style labels, `imp-`-style radio groups from the import page, `mini-btn`/`btn-solid`, `pf-error` inline errors):

```tsx
/** Logging tab: local/remote modes, storage limits, and the remote
 *  transport (Grafana Loki push, or syslog RFC 5424 for a SIEM). */

import { useCallback, useEffect, useState } from 'react';

import {
  getLoggingConfig, putLoggingConfig, testLoggingConfig,
  type LoggingConfig,
} from '../../lib/api';
import { serverFieldErrors, validateLoggingForm } from '../../lib/systemConfig';

export default function LoggingTab() {
  const [cfg, setCfg] = useState<LoggingConfig | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /* on mount: getLoggingConfig -> setCfg (password field starts empty;
     placeholder shows "unchanged" when password_set) */
  /* set<field> helpers that update cfg immutably and clear that field's
     error + the saved flag */
  /* save(): client validateLoggingForm first (setErrors + stop);
     putLoggingConfig; on 422 merge serverFieldErrors; on success setCfg
     from the response (password cleared again), saved=true */
  /* test(): testLoggingConfig -> "Logged locally." /
     "Logged and forwarded." / `Forwarding failed: ${error}` */

  /* render:
     - mode radio group (three options w/ one-line muted explainers:
       "Local only — logs stay in Postgres.",
       "Local + remote — keep local copies and forward.",
       "Remote — forward, keep a small local buffer.")
     - Storage limits group: max rows per process, max age days; buffer
       rows input shown only when mode === 'remote'. Minimum level select.
     - Remote transport group (shown when mode !== 'local'): radio
       "Grafana Loki" / "Syslog (RFC 5424)".
       Loki fields: URL, Username (optional), Password (type=password,
       placeholder '••••••••  (unchanged)' when password_set and value
       empty), Tenant ID (optional).
       Syslog fields: Host, Port (number), Protocol select udp/tcp/tls.
     - inline field errors under each input (pf-error)
     - footer: btn-solid "Save changes" (busy-disabled), mini-btn
       "Send test event", saved tick "Saved." fading text, testResult
       line, loadError banner (dir-empty) when the GET failed. */
}
```

Nav: in `portal/src/layout/navSections.tsx`, insert into the Developer section between "Developer tools" and "Database":

```tsx
      {
        to: '/dev/system-config',
        label: 'System Config',
        resource: 'devtools',
        godOnly: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
            <path d="M1 14h6M9 8h6M17 16h6" />
          </svg>
        ),
      },
```

Route in `portal/src/App.tsx`, next to the other /dev routes:

```tsx
            <Route path="/dev/system-config" element={
              <ProtectedRoute resource="devtools"><SystemConfig /></ProtectedRoute>
            } />
```

Styles appended to `portal/src/styles/system.css`:

```css
/* System Config */
.sysconf-tabs { display: flex; gap: 8px; margin: 14px 0 18px; }
.sysconf-form { max-width: 640px; display: flex; flex-direction: column;
  gap: 18px; }
.sysconf-group { display: flex; flex-direction: column; gap: 8px; }
.sysconf-group > label { font-weight: 600; font-size: 13px; }
.sysconf-hint { color: var(--text-mute); font-size: 12px; }
.sysconf-row { display: flex; gap: 12px; flex-wrap: wrap; }
.sysconf-row > div { flex: 1 1 180px; }
.sysconf-form input, .sysconf-form select { height: 34px; padding: 0 10px;
  border-radius: 9px; border: 1px solid var(--paper-line);
  background: var(--surface, #fff); font-size: 13px; width: 100%;
  color: var(--text-dark); }
.sysconf-actions { display: flex; align-items: center; gap: 12px; }
.sysconf-saved { color: var(--c-green, #178a4c); font-size: 12.5px; }
```

- [ ] **Step 5: Verify**

Run: `cd portal && npx tsc --noEmit && npx vitest run`
Expected: clean + all green.

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/systemConfig.ts portal/src/lib/systemConfig.test.ts portal/src/pages/SystemConfig.tsx portal/src/components/system/LoggingTab.tsx portal/src/layout/navSections.tsx portal/src/App.tsx portal/src/styles/system.css
git commit -m "feat(portal): System Config page — Logging tab with Loki/syslog transport

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Live end-to-end verification with a real Loki (controller)

**Files:** none (verification; fix-forward).

- [ ] **Step 1: Run a local Loki**

```bash
docker run -d --name serversherpa-dev-loki -p 3100:3100 grafana/loki:3.0.0
```

Wait for readiness: `curl -s http://localhost:3100/ready` → `ready`.

- [ ] **Step 2: Configure through the UI**

In the browser (god mode): Developer → System Config → Logging. Mode "Local + remote", transport "Grafana Loki", URL `http://localhost:3100`, no auth. Save → "Saved." Send test event → "Logged and forwarded."

- [ ] **Step 3: Prove ingestion**

```bash
curl -s "http://localhost:3100/loki/api/v1/query_range" --data-urlencode 'query={app="serversherpa"}' | head -c 600
```

Expected: streams with `process`/`level` labels and real log lines (the log-service forwards the backlog within ~10 s). Also verify the Processes page shows NO "forwarding degraded" chip; then stop Loki (`docker stop serversherpa-dev-loki`), wait ~20 s, confirm the chip appears on log-service; start Loki again, confirm it clears and the cursor catches up.

- [ ] **Step 4: Validation UX check**

In the UI: switch transport to Syslog with an empty host → Save shows the inline "Enter the syslog host." error and no PUT lands. Switch back to Loki.

- [ ] **Step 5: Full suites + cleanup**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/api && .venv/bin/pytest -q
```

```bash
cd /Users/jrh1812/Developer/BaseCampV3/portal && npx tsc --noEmit && npx vitest run
```

Expected: green. Leave the Loki container running or stop it per the user's preference (note whichever in the summary); reset the logging config to Local via the UI if the user doesn't want dev forwarding left on.
