# Kiosk Laptop Edition (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Docker image that runs on a laptop, serves the kiosk web app, and puts a small FastAPI + SQLite "edge" service between the browser and the cloud API, so the kiosk keeps working (sign-in, move data, scanning, WebUSB printer tools) with spotty or no internet after one online sign-in and Kiosk Setup.

**Architecture:** One process (`edge`, FastAPI on port 8090) serves the built kiosk bundle and answers every API path the kiosk calls. Online it forwards to the cloud under the signed-in person's own cloud session (tokens kept server-side, encrypted); offline it answers from SQLite (cached responses, argon2 sign-in verifiers, a cached move-password hash) and queues scans/printer events in an outbox that drains when the cloud comes back. The kiosk front end is unchanged except for a runtime `mode: 'laptop'` flag that adds an Edge settings tab, a footer cloud indicator, and edge-owned identity.

**Tech Stack:** Python 3.13, FastAPI, httpx, sqlite3 (stdlib), argon2-cffi, cryptography (Fernet), PyJWT, pytest + pytest-asyncio + respx; kiosk: Vite 5 + React 18 + vitest 3; Docker (node:20-alpine build stage, python:3.13-slim runtime).

**Spec:** `docs/superpowers/specs/2026-10-01-kiosk-laptop-design.md` (read it first; the "Plan-time adjustments" section there lists where this plan deliberately narrows it).

## Global Constraints

- American English in all copy, comments and docs (color, customize, recognize).
- Edge listens on container port **8090**; compose publishes it on `${EDGE_BIND:-127.0.0.1}:8090`.
- `/data` holds `identity.json`, `edge.key`, `edge.db`; it is a **host bind mount** (default `~/ServerSherpaKiosk`), never a named volume.
- `identity.json` is never rewritten except by an admin rename; serial format `kiosk-laptop-<uuid4>`, default name `Kiosk XXXX` (last 4 of serial, upper-case), name 1–80 chars after trim.
- Offline sign-in window `EDGE_OFFLINE_LOGIN_DAYS` default **14**; offline sessions last **12 hours**; offline failure limit **10 per 5 minutes** per key.
- Upstream timeouts: **5 s connect / 15 s read**. Only transport errors (`httpx.TransportError`) mean "offline"; any HTTP answer is the cloud's answer.
- Edge access tokens: HS256 JWT, `typ: "edge"`, TTL **900 s**. Refresh cookie `ss_refresh`, `path=/auth`, httpOnly, SameSite=Lax.
- Error bodies use the cloud's shape: `{"detail": {"code": "<code>"}}`. New codes: `edge_offline` (503), `cloud_sign_in_required` (401), `not_authenticated` (401), `forbidden` (403), `outbox_not_empty` (409), `bad_name` (422).
- Outbox scan batches ≤ **100** (the cloud's `KioskScanBatchIn` limit); backoff ladder **5, 15, 60, 300, 900 s** then `failed`.
- Admin = `max_rank >= 60`.
- In `app.py`, every `app.include_router(...)` and explicit route (`/config.js`) is registered ABOVE the `/{full_path:path}` catch-all — FastAPI matches in registration order, so a router added after it is unreachable.
- Python edge tests: `kiosk_laptop/edge/.venv/bin/python -m pytest` from `kiosk_laptop/edge`. Cloud API tests: from `api/`, `SS_TEST_DB=serversherpa_test_kiosk_laptop PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest …` (the venv's editable install points at the MAIN checkout — without `PYTHONPATH` you test the wrong code). Run every suite in the FOREGROUND with a long timeout (600000 ms); never background a test run.
- Kiosk tests: `npm --prefix kiosk test -- <files>`; DOM tests start with `// @vitest-environment jsdom`. Kiosk imports from `@portal` must stay React-free `.ts` or CSS (`kiosk/src/portalImports.test.ts` enforces it).
- Commit after every task with the message given; end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

```
kiosk_laptop/
  Dockerfile                      Task 12
  docker-compose.yml              Task 12
  README.md                       Task 12
  scripts/smoke.sh                Task 12
  edge/
    pyproject.toml                Task 1
    src/edge/
      __init__.py                 Task 1
      __main__.py                 Task 2  (reset-key CLI)
      config.py                   Task 1  Settings + load_settings()
      db.py                       Task 1  Store (sqlite, schema steps), now_iso/iso
      identity.py                 Task 1  Identity load_or_create/rename
      static.py                   Task 1  web files + SPA fallback
      app.py                      Task 1, extended in 3–8
      crypto.py                   Task 2  Keys, encrypt/decrypt, verifiers
      sessions.py                 Task 2  edge-issued sessions
      deps.py                     Task 2  current_session/require_session/require_admin/err
      upstream.py                 Task 3  cloud client + cloud_sessions
      outbox.py                   Task 4  queue + worker
      offline.py                  Task 5  verifier cache + rate limit
      sync.py                     Task 6  Syncer
      background.py               Task 8  probe/drain/sync loop
      routes/__init__.py          Task 1
      routes/auth.py              Task 5
      routes/kiosk.py             Task 4 (scans, printer events), Task 6 (setup)
      routes/proxy.py             Task 6
      routes/edge.py              Task 1 (identity GET), Task 7 (rest)
    tests/
      conftest.py                 Task 1, extended in 2–3
      test_identity.py test_db.py test_static.py            Task 1
      test_crypto.py test_sessions.py                         Task 2
      test_upstream.py                                        Task 3
      test_outbox.py                                          Task 4
      test_auth_routes.py                                     Task 5
      test_proxy.py test_sync.py                              Task 6
      test_edge_routes.py                                     Task 7
      test_background.py                                      Task 8
api/src/serversherpa/api/schemas.py      Task 9 (3 new models)
api/src/serversherpa/api/routes/kiosk.py Task 9 (GET /kiosk/edge/move-passwords)
api/tests/test_kiosk_edge_move_passwords.py, api/tests/test_edge_contract.py  Task 9
kiosk/src/lib/config.ts platform.ts identity.ts api.ts edgeStatus.ts settingsTabs.ts   Task 10
kiosk/src/components/EdgePanel.tsx, ThisKioskPanel.tsx, pages/Settings.tsx, pages/Login.tsx, layout/KioskShell.tsx   Task 11
```

---

### Task 1: Edge package scaffold — settings, SQLite store, fixed identity, web files

**Files:**
- Create: `kiosk_laptop/edge/pyproject.toml`, `kiosk_laptop/edge/src/edge/{__init__,config,db,identity,static,app}.py`, `kiosk_laptop/edge/src/edge/routes/{__init__,edge}.py`
- Create: `kiosk_laptop/edge/tests/{conftest,test_identity,test_db,test_static}.py`

**Interfaces:**
- Produces: `Settings` dataclass (fields below), `load_settings() -> Settings`; `Store(path)` with `.one(sql, params) -> sqlite3.Row | None`, `.all(sql, params) -> list[Row]`, `.run(sql, params) -> int` (rowcount), `.tx()` context manager yielding the connection, `.close()`; `now_iso() -> str`, `iso(dt_or_str) -> str` (normalized UTC, seconds precision); `Identity(serial, name, created_at)`, `load_or_create(data_dir) -> Identity`, `rename(data_dir, current, name) -> Identity` (raises `ValueError("bad_name")`); `create_app(settings, *, transport=None) -> FastAPI` with `app.state.settings/.store/.identity`; tests' fixtures `settings`, `cloud` (respx router), `app`, `client`, constant `CLOUD = "http://cloud.test"`.

- [ ] **Step 1: Create the venv and package skeleton**

`kiosk_laptop/edge/pyproject.toml`:

```toml
[project]
name = "serversherpa-edge"
version = "0.1.0"
description = "ServerSherpa kiosk laptop edition — local edge API (FastAPI + SQLite)"
requires-python = ">=3.13"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "httpx>=0.27",
    "argon2-cffi>=23.1",
    "cryptography>=42",
    "pyjwt>=2.9",
]

[project.optional-dependencies]
dev = ["pytest>=8.0", "pytest-asyncio>=0.24", "respx>=0.21"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.ruff]
line-length = 100
src = ["src"]
```

`kiosk_laptop/edge/src/edge/__init__.py`:

```python
"""ServerSherpa kiosk, laptop edition: the local edge API. Design:
docs/superpowers/specs/2026-10-01-kiosk-laptop-design.md"""
```

`kiosk_laptop/edge/src/edge/routes/__init__.py`: empty file.

Run:
```bash
cd kiosk_laptop/edge && python3 -m venv .venv && .venv/bin/pip install -q -e '.[dev]'
```
Expected: installs without error (`.venv` is already git-ignored by the root `.gitignore`).

- [ ] **Step 2: Write the failing tests**

`kiosk_laptop/edge/tests/conftest.py`:

```python
import httpx
import pytest
import respx

from edge.app import create_app
from edge.config import Settings

CLOUD = "http://cloud.test"


@pytest.fixture
def settings(tmp_path):
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><div id=\"root\"></div>")
    (web / "assets" / "app.js").write_text("console.log('kiosk')")
    return Settings(cloud_api_url=CLOUD, portal_url="http://portal.test",
                    data_dir=tmp_path / "data", web_dir=web, background=False)


@pytest.fixture
def cloud():
    with respx.mock(base_url=CLOUD, assert_all_called=False) as router:
        yield router


@pytest.fixture
def app(settings, cloud):
    return create_app(settings)


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://edge.test") as c:
        yield c
```

`kiosk_laptop/edge/tests/test_identity.py`:

```python
import json

import pytest

from edge.identity import load_or_create, rename


def test_first_start_generates_and_persists(tmp_path):
    ident = load_or_create(tmp_path)
    assert ident.serial.startswith("kiosk-laptop-")
    assert ident.name == f"Kiosk {ident.serial[-4:].upper()}"
    on_disk = json.loads((tmp_path / "identity.json").read_text())
    assert on_disk["serial"] == ident.serial


def test_later_starts_reuse_the_same_identity(tmp_path):
    first = load_or_create(tmp_path)
    assert load_or_create(tmp_path) == first


def test_rename_keeps_serial_and_persists(tmp_path):
    first = load_or_create(tmp_path)
    renamed = rename(tmp_path, first, "  Dock Door 3  ")
    assert renamed.serial == first.serial
    assert renamed.name == "Dock Door 3"
    assert load_or_create(tmp_path).name == "Dock Door 3"


@pytest.mark.parametrize("bad", ["", "   ", "x" * 81])
def test_rename_rejects_bad_names(tmp_path, bad):
    first = load_or_create(tmp_path)
    with pytest.raises(ValueError, match="bad_name"):
        rename(tmp_path, first, bad)


def test_corrupt_identity_refuses_rather_than_regenerating(tmp_path):
    (tmp_path / "identity.json").write_text("{not json")
    with pytest.raises(ValueError):
        load_or_create(tmp_path)
```

`kiosk_laptop/edge/tests/test_db.py`:

```python
import pytest

from edge.db import SCHEMA_STEPS, Store, iso


def test_schema_created_and_versioned(tmp_path):
    store = Store(tmp_path / "edge.db")
    tables = {r["name"] for r in store.all("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"edge_sessions", "cloud_sessions", "offline_logins", "login_failures",
            "move_passwords", "cache", "sync_meta", "outbox", "schema_version"} <= tables
    assert store.one("SELECT version FROM schema_version")["version"] == len(SCHEMA_STEPS)
    store.close()
    # reopening is a no-op upgrade
    again = Store(tmp_path / "edge.db")
    assert again.one("SELECT version FROM schema_version")["version"] == len(SCHEMA_STEPS)


def test_tx_rolls_back_on_error(tmp_path):
    store = Store(tmp_path / "edge.db")
    with pytest.raises(RuntimeError):
        with store.tx() as c:
            c.execute("INSERT INTO cache(key, status, body, stored_at) VALUES ('k', 200, 'b', 'now')")
            raise RuntimeError("boom")
    assert store.one("SELECT * FROM cache WHERE key='k'") is None


def test_iso_normalizes_to_utc_seconds():
    assert iso("2026-10-01T12:00:00.123456Z") == "2026-10-01T12:00:00+00:00"
    assert iso("2026-10-01T07:00:00-05:00") == "2026-10-01T12:00:00+00:00"
```

`kiosk_laptop/edge/tests/test_static.py`:

```python
async def test_root_serves_index(client):
    r = await client.get("/")
    assert r.status_code == 200
    assert '<div id="root">' in r.text


async def test_asset_file_served(client):
    r = await client.get("/assets/app.js")
    assert r.status_code == 200
    assert "kiosk" in r.text


async def test_spa_route_falls_back_to_index(client):
    r = await client.get("/labels/printers")
    assert r.status_code == 200
    assert '<div id="root">' in r.text


async def test_path_traversal_gets_index_not_file(client, settings):
    (settings.data_dir / "secret.txt").write_text("nope")
    r = await client.get("/../data/secret.txt")
    assert "nope" not in r.text


async def test_config_js_carries_laptop_mode_and_identity(client, app):
    r = await client.get("/config.js")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    assert '"mode": "laptop"' in r.text
    assert app.state.identity.serial in r.text
    assert "apiUrl: window.location.origin" in r.text


async def test_edge_identity_endpoint(client, app):
    r = await client.get("/edge/identity")
    assert r.json() == {"serial": app.state.identity.serial, "name": app.state.identity.name}


async def test_unknown_non_get_is_404(client):
    r = await client.post("/not-an-api")
    assert r.status_code == 404
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`
Expected: collection errors — `ModuleNotFoundError: No module named 'edge.app'`.

- [ ] **Step 4: Implement**

`kiosk_laptop/edge/src/edge/config.py`:

```python
"""Runtime settings, read from EDGE_* environment variables."""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    cloud_api_url: str
    portal_url: str = ""
    data_dir: Path = Path("/data")
    web_dir: Path = Path("/app/web")
    offline_login_days: int = 14
    sync_interval_s: int = 300
    probe_interval_s: int = 30
    background: bool = True
    secure_cookies: bool = False


def load_settings() -> Settings:
    cloud = os.environ.get("EDGE_CLOUD_API_URL", "").strip().rstrip("/")
    if not cloud:
        raise RuntimeError("EDGE_CLOUD_API_URL is required (e.g. https://api.serversherpa.com)")
    return Settings(
        cloud_api_url=cloud,
        portal_url=os.environ.get("EDGE_PORTAL_URL", "").strip().rstrip("/"),
        data_dir=Path(os.environ.get("EDGE_DATA_DIR", "/data")),
        web_dir=Path(os.environ.get("EDGE_WEB_DIR", "/app/web")),
        offline_login_days=int(os.environ.get("EDGE_OFFLINE_LOGIN_DAYS", "14")),
        sync_interval_s=int(os.environ.get("EDGE_SYNC_INTERVAL_S", "300")),
        background=os.environ.get("EDGE_BACKGROUND", "1") != "0",
        secure_cookies=os.environ.get("EDGE_SECURE_COOKIES", "0") == "1",
    )
```

`kiosk_laptop/edge/src/edge/db.py`:

```python
"""The edge's SQLite store. One connection shared across the app behind a
lock (sqlite is fast enough locally that handlers call it inline). Schema
is a list of SQL steps; `schema_version` records how many have run, so an
upgraded image only applies the new ones."""

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

SCHEMA_STEPS: list[str] = [
    """
    CREATE TABLE edge_sessions (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL, refresh_hash TEXT NOT NULL UNIQUE,
        offline INTEGER NOT NULL, session_json TEXT NOT NULL, expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL, revoked_at TEXT);
    CREATE TABLE cloud_sessions (
        person_id TEXT PRIMARY KEY, refresh_enc TEXT NOT NULL, access_enc TEXT,
        access_expires_at TEXT, ending INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE offline_logins (
        email TEXT PRIMARY KEY, person_id TEXT NOT NULL, verifier TEXT NOT NULL,
        session_json TEXT NOT NULL, cached_at TEXT NOT NULL);
    CREATE TABLE login_failures (key TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE move_passwords (
        initiative_id TEXT PRIMARY KEY, name TEXT NOT NULL, verifier TEXT NOT NULL,
        session_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE cache (
        key TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, stored_at TEXT NOT NULL);
    CREATE TABLE sync_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1), initiative_id TEXT, actor_person_id TEXT,
        synced_at TEXT, last_error TEXT);
    CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, person_id TEXT NOT NULL,
        person_name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT,
        created_at TEXT NOT NULL, dedupe_key TEXT UNIQUE);
    CREATE INDEX outbox_due ON outbox (status, next_attempt_at);
    """,
]


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def iso(value: datetime | str) -> str:
    """Normalize to UTC with seconds precision, so stored times compare as strings."""
    dt = datetime.fromisoformat(value) if isinstance(value, str) else value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).replace(microsecond=0).isoformat()


class Store:
    def __init__(self, path: Path) -> None:
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False,
                                    isolation_level=None, timeout=5.0)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self._migrate()

    def _migrate(self) -> None:
        with self.tx() as c:
            c.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
            row = c.execute("SELECT version FROM schema_version").fetchone()
            current = row[0] if row else 0
            for step in SCHEMA_STEPS[current:]:
                # executescript() would COMMIT the open transaction; run statements singly
                for stmt in step.split(";"):
                    if stmt.strip():
                        c.execute(stmt)
            if row is None:
                c.execute("INSERT INTO schema_version (version) VALUES (?)", (len(SCHEMA_STEPS),))
            else:
                c.execute("UPDATE schema_version SET version = ?", (len(SCHEMA_STEPS),))

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            self.conn.execute("COMMIT")

    def one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        with self._lock:
            return self.conn.execute(sql, params).fetchone()

    def all(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self.conn.execute(sql, params).fetchall()

    def run(self, sql: str, params: tuple = ()) -> int:
        with self._lock:
            return self.conn.execute(sql, params).rowcount

    def close(self) -> None:
        with self._lock:
            self.conn.close()
```

`kiosk_laptop/edge/src/edge/identity.py`:

```python
"""Who this laptop is. Generated once, kept in /data/identity.json, and
never regenerated while that file exists — the cloud upserts the kiosk's
Device row by serial, so a new serial would make the laptop a stranger.
A corrupt file is an error, not a reason to mint a new identity."""

import json
import os
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

from edge.db import now_iso

NAME_MAX = 80


@dataclass(frozen=True)
class Identity:
    serial: str
    name: str
    created_at: str


def default_name(serial: str) -> str:
    return f"Kiosk {serial[-4:].upper()}"


def _path(data_dir: Path) -> Path:
    return data_dir / "identity.json"


def _write(path: Path, ident: Identity) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(asdict(ident)))
    os.replace(tmp, path)


def load_or_create(data_dir: Path) -> Identity:
    path = _path(data_dir)
    if path.exists():
        raw = json.loads(path.read_text())  # ValueError on corruption: refuse to start
        return Identity(serial=raw["serial"], name=raw["name"], created_at=raw["created_at"])
    serial = f"kiosk-laptop-{uuid.uuid4()}"
    ident = Identity(serial=serial, name=default_name(serial), created_at=now_iso())
    _write(path, ident)
    return ident


def rename(data_dir: Path, current: Identity, name: str) -> Identity:
    trimmed = name.strip()
    if not trimmed or len(trimmed) > NAME_MAX:
        raise ValueError("bad_name")
    renamed = Identity(serial=current.serial, name=trimmed, created_at=current.created_at)
    _write(_path(data_dir), renamed)
    return renamed
```

`kiosk_laptop/edge/src/edge/static.py`:

```python
"""The kiosk bundle: real files when they exist under web_dir, index.html
for everything else (client-side routes like /labels/printers)."""

from pathlib import Path

from fastapi.responses import FileResponse


def serve(web_dir: Path, path: str) -> FileResponse:
    root = web_dir.resolve()
    candidate = (root / path.lstrip("/")).resolve()
    if candidate.is_file() and candidate.is_relative_to(root):
        return FileResponse(candidate)
    return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})
```

`kiosk_laptop/edge/src/edge/routes/edge.py`:

```python
"""/edge/* — the laptop's own endpoints (identity now; status and admin
actions in Task 7)."""

from fastapi import APIRouter, Request

router = APIRouter(prefix="/edge")


@router.get("/identity")
async def get_identity(request: Request) -> dict:
    ident = request.app.state.identity
    return {"serial": ident.serial, "name": ident.name}
```

`kiosk_laptop/edge/src/edge/app.py`:

```python
"""The edge app factory. State is built eagerly (not in lifespan) so tests
driving the app through httpx.ASGITransport — which runs no lifespan — see
the same app the container runs; lifespan only starts background work."""

import json

from fastapi import FastAPI, Request, Response
from fastapi.responses import PlainTextResponse

from edge import static
from edge.config import Settings, load_settings
from edge.db import Store
from edge.identity import load_or_create
from edge.routes import edge as edge_routes

API_PREFIXES = ("/auth/", "/kiosk/", "/system/")


def create_app(settings: Settings | None = None, *, transport=None) -> FastAPI:
    settings = settings or load_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    app = FastAPI(title="ServerSherpa Kiosk Edge", docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.settings = settings
    app.state.identity = load_or_create(settings.data_dir)
    app.state.store = Store(settings.data_dir / "edge.db")

    app.include_router(edge_routes.router)

    @app.get("/config.js")
    async def config_js(request: Request) -> Response:
        ident = request.app.state.identity
        body = (
            "window.__KIOSK_CONFIG__ = { apiUrl: window.location.origin, "
            f"portalUrl: {json.dumps(settings.portal_url)}, "
            '"mode": "laptop", '
            f'"identity": {json.dumps({"serial": ident.serial, "name": ident.name})} }};\n'
        )
        return PlainTextResponse(body, media_type="application/javascript",
                                 headers={"Cache-Control": "no-store"})

    @app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def catch_all(request: Request, full_path: str) -> Response:
        path = "/" + full_path
        if path.startswith(API_PREFIXES):
            return Response(status_code=404)  # replaced by the proxy in Task 6
        if request.method != "GET":
            return Response(status_code=404)
        return static.serve(settings.web_dir, path)

    return app
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add kiosk_laptop/edge
git commit -m "feat(kiosk-laptop): edge package scaffold — settings, sqlite store, fixed identity, web files + config.js

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Keys, offline verifiers, edge-issued sessions, reset-key CLI

**Files:**
- Create: `kiosk_laptop/edge/src/edge/{crypto,sessions,deps,__main__}.py`
- Modify: `kiosk_laptop/edge/src/edge/app.py` (load keys into `app.state.keys`)
- Modify: `kiosk_laptop/edge/tests/conftest.py` (add `session_out()` and `make_session()` helpers)
- Test: `kiosk_laptop/edge/tests/test_crypto.py`, `kiosk_laptop/edge/tests/test_sessions.py`

**Interfaces:**
- Consumes: `Store`, `now_iso`, `iso` (Task 1).
- Produces:
  - `crypto.KeyFileError(RuntimeError)`; `crypto.Keys(fernet, jwt_secret)`; `load_or_create_keys(data_dir) -> Keys`; `encrypt(keys, s) -> str`; `decrypt(keys, s) -> str`; `make_verifier(secret) -> str`; `check_verifier(verifier, secret) -> bool`.
  - `sessions.ACCESS_TTL_S = 900`, `sessions.OFFLINE_SESSION_HOURS = 12`, `sessions.TOKEN_FIELDS`; `EdgeSession(id, person_id, offline, session, expires_at)` with properties `move_id -> str | None`, `max_rank -> int`, `person_name -> str`; `template_from(session_out: dict) -> dict`; `issue(store, keys, *, template, offline, expires_at) -> tuple[dict, str]` (SessionOut-shaped dict, refresh token); `from_access_token(store, keys, token) -> EdgeSession | None`; `refresh(store, keys, refresh_token) -> tuple[dict, str] | None`; `revoke(store, refresh_token) -> EdgeSession | None`; `has_live_session(store, person_id) -> bool`; `offline_expiry() -> str`.
  - `deps.err(status, code, **extra) -> HTTPException`; `deps.current_session(request) -> EdgeSession | None`; `deps.require_session(request) -> EdgeSession` (401 `not_authenticated`); `deps.require_admin(request) -> EdgeSession` (403 `forbidden`); `deps.ADMIN_RANK = 60`.
  - conftest: `session_out(person_id="p-1", name="Jane Doe", max_rank=10, kiosk_move=None, access_token="cloud-access-1") -> dict` (a cloud SessionOut), `make_session(app, **kw) -> dict` (Authorization header for a fresh edge session).

- [ ] **Step 1: Write the failing tests**

Append to `kiosk_laptop/edge/tests/conftest.py`:

```python
from edge import sessions


def session_out(person_id="p-1", name="Jane Doe", max_rank=10, kiosk_move=None,
                access_token="cloud-access-1", email="jane@example.com"):
    """A cloud SessionOut, as /auth/login returns it."""
    return {
        "status": "ok", "access_token": access_token, "token_type": "bearer",
        "expires_in": 900, "session_expires_at": "2099-01-01T00:00:00Z",
        "person": {"id": person_id, "display_name": name, "first_name": name.split()[0],
                   "last_name": name.split()[-1], "email": email},
        "roles": ["worker"], "must_change_password": False, "must_change_reason": None,
        "password_expires_at": None, "preferences": {}, "perms": {"kiosk": {"view": True}},
        "max_rank": max_rank, "scope": {"global": False, "client_ids": [], "partner_ids": []},
        "password_min_length": 8,
        "totp": {"enrolled": False, "enrolled_at": None, "required": False,
                 "backup_codes_remaining": None},
        "kiosk_move": kiosk_move,
    }


def make_session(app, offline=False, **kw):
    out, _refresh = sessions.issue(app.state.store, app.state.keys,
                                   template=sessions.template_from(session_out(**kw)),
                                   offline=offline, expires_at="2099-01-01T00:00:00Z")
    return {"Authorization": f"Bearer {out['access_token']}"}
```

`kiosk_laptop/edge/tests/test_crypto.py`:

```python
import os
import stat

import pytest

from edge.crypto import (
    KeyFileError, check_verifier, decrypt, encrypt, load_or_create_keys, make_verifier,
)


def test_key_created_0600_and_reloaded(tmp_path):
    keys = load_or_create_keys(tmp_path)
    mode = stat.S_IMODE(os.stat(tmp_path / "edge.key").st_mode)
    assert mode == 0o600
    again = load_or_create_keys(tmp_path)
    assert decrypt(again, encrypt(keys, "secret")) == "secret"
    assert again.jwt_secret == keys.jwt_secret


def test_corrupt_key_file_refuses(tmp_path):
    (tmp_path / "edge.key").write_text("garbage")
    with pytest.raises(KeyFileError):
        load_or_create_keys(tmp_path)


def test_verifier_round_trip():
    v = make_verifier("CorrectHorse9!")
    assert check_verifier(v, "CorrectHorse9!")
    assert not check_verifier(v, "wrong")
    assert not check_verifier("not-a-hash", "CorrectHorse9!")
```

`kiosk_laptop/edge/tests/test_sessions.py`:

```python
import jwt

from edge import sessions
from tests.conftest import session_out


def _issue(app, **kw):
    return sessions.issue(app.state.store, app.state.keys,
                          template=sessions.template_from(session_out(**kw)),
                          offline=False, expires_at="2099-01-01T00:00:00Z")


def test_issue_returns_sessionout_shape_with_edge_token(app):
    out, refresh = _issue(app)
    assert out["status"] == "ok" and out["token_type"] == "bearer"
    assert out["expires_in"] == sessions.ACCESS_TTL_S
    assert out["access_token"] != "cloud-access-1"
    assert out["person"]["id"] == "p-1"
    assert out["session_expires_at"] == "2099-01-01T00:00:00+00:00"
    assert refresh


def test_access_token_resolves_to_session(app):
    out, _ = _issue(app, max_rank=60)
    s = sessions.from_access_token(app.state.store, app.state.keys, out["access_token"])
    assert s.person_id == "p-1" and s.max_rank == 60 and s.offline is False
    assert s.person_name == "Jane Doe"


def test_foreign_or_tampered_tokens_rejected(app):
    bad = jwt.encode({"sid": "x", "typ": "edge", "exp": 9999999999}, "other", algorithm="HS256")
    assert sessions.from_access_token(app.state.store, app.state.keys, bad) is None
    assert sessions.from_access_token(app.state.store, app.state.keys, "cloud-access-1") is None


def test_refresh_rotates_and_old_refresh_dies(app):
    _, r1 = _issue(app)
    out, r2 = sessions.refresh(app.state.store, app.state.keys, r1)
    assert out["person"]["id"] == "p-1" and r2 != r1
    assert sessions.refresh(app.state.store, app.state.keys, r1) is None


def test_revoke_kills_access_and_refresh(app):
    out, r1 = _issue(app)
    ended = sessions.revoke(app.state.store, r1)
    assert ended.person_id == "p-1"
    assert sessions.from_access_token(app.state.store, app.state.keys, out["access_token"]) is None
    assert sessions.refresh(app.state.store, app.state.keys, r1) is None
    assert sessions.has_live_session(app.state.store, "p-1") is False


def test_move_id_from_kiosk_move(app):
    out, _ = _issue(app, kiosk_move={"initiative_id": "m-1", "name": "Move"})
    s = sessions.from_access_token(app.state.store, app.state.keys, out["access_token"])
    assert s.move_id == "m-1"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q tests/test_crypto.py tests/test_sessions.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'edge.crypto'`.

- [ ] **Step 3: Implement**

`kiosk_laptop/edge/src/edge/crypto.py`:

```python
"""Secrets at rest. /data/edge.key holds a Fernet key (cloud tokens) and
the JWT secret (edge access tokens); it is created 0600 on first start and
never silently replaced — a new key would orphan every encrypted token, so
an unreadable file stops the edge until `python -m edge reset-key`."""

import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.fernet import Fernet

KEY_FILE = "edge.key"
_hasher = PasswordHasher()


class KeyFileError(RuntimeError):
    pass


@dataclass(frozen=True)
class Keys:
    fernet: Fernet
    jwt_secret: str


def load_or_create_keys(data_dir: Path) -> Keys:
    path = data_dir / KEY_FILE
    if path.exists():
        try:
            raw = json.loads(path.read_text())
            return Keys(fernet=Fernet(raw["fernet"].encode()), jwt_secret=raw["jwt"])
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise KeyFileError(f"{path} is unreadable; run `python -m edge reset-key`") from exc
    raw = {"fernet": Fernet.generate_key().decode(), "jwt": secrets.token_urlsafe(48)}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(raw, fh)
    return Keys(fernet=Fernet(raw["fernet"].encode()), jwt_secret=raw["jwt"])


def encrypt(keys: Keys, value: str) -> str:
    return keys.fernet.encrypt(value.encode()).decode()


def decrypt(keys: Keys, value: str) -> str:
    return keys.fernet.decrypt(value.encode()).decode()


def make_verifier(secret: str) -> str:
    return _hasher.hash(secret)


def check_verifier(verifier: str, secret: str) -> bool:
    try:
        return _hasher.verify(verifier, secret)
    except (VerificationError, InvalidHashError):
        return False
```

`kiosk_laptop/edge/src/edge/sessions.py`:

```python
"""Sessions the edge issues to the browser. Same SessionOut shape as the
cloud (so the kiosk's auth code is unchanged), but the access token is an
edge JWT and the refresh token lives in edge_sessions — the cloud's own
tokens never reach the browser (see upstream.py)."""

import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt

from edge.crypto import Keys
from edge.db import Store, iso, now_iso

ACCESS_TTL_S = 900
OFFLINE_SESSION_HOURS = 12
TOKEN_FIELDS = ("status", "access_token", "token_type", "expires_in", "session_expires_at")


@dataclass(frozen=True)
class EdgeSession:
    id: str
    person_id: str
    offline: bool
    session: dict
    expires_at: str

    @property
    def move_id(self) -> str | None:
        move = self.session.get("kiosk_move")
        return str(move["initiative_id"]) if move else None

    @property
    def max_rank(self) -> int:
        return int(self.session.get("max_rank", 0))

    @property
    def person_name(self) -> str:
        person = self.session.get("person") or {}
        return person.get("display_name") or self.person_id


def template_from(session_out: dict) -> dict:
    return {k: v for k, v in session_out.items() if k not in TOKEN_FIELDS}


def offline_expiry() -> str:
    return iso(datetime.now(UTC) + timedelta(hours=OFFLINE_SESSION_HOURS))


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _access_token(keys: Keys, sid: str) -> str:
    exp = int((datetime.now(UTC) + timedelta(seconds=ACCESS_TTL_S)).timestamp())
    return jwt.encode({"sid": sid, "typ": "edge", "exp": exp}, keys.jwt_secret, algorithm="HS256")


def _out(template: dict, token: str, expires_at: str) -> dict:
    return {**template, "status": "ok", "access_token": token, "token_type": "bearer",
            "expires_in": ACCESS_TTL_S, "session_expires_at": expires_at}


def _session(row) -> EdgeSession:
    return EdgeSession(id=row["id"], person_id=row["person_id"], offline=bool(row["offline"]),
                       session=json.loads(row["session_json"]), expires_at=row["expires_at"])


def issue(store: Store, keys: Keys, *, template: dict, offline: bool,
          expires_at: str) -> tuple[dict, str]:
    sid = str(uuid.uuid4())
    refresh_token = secrets.token_urlsafe(32)
    expires = iso(expires_at)
    store.run(
        "INSERT INTO edge_sessions (id, person_id, refresh_hash, offline, session_json, "
        "expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, str(template["person"]["id"]), _hash(refresh_token), int(offline),
         json.dumps(template), expires, now_iso()))
    return _out(template, _access_token(keys, sid), expires), refresh_token


def from_access_token(store: Store, keys: Keys, token: str) -> EdgeSession | None:
    try:
        claims = jwt.decode(token, keys.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if claims.get("typ") != "edge":
        return None
    row = store.one("SELECT * FROM edge_sessions WHERE id = ? AND revoked_at IS NULL "
                    "AND expires_at > ?", (claims.get("sid"), now_iso()))
    return _session(row) if row else None


def refresh(store: Store, keys: Keys, refresh_token: str) -> tuple[dict, str] | None:
    row = store.one("SELECT * FROM edge_sessions WHERE refresh_hash = ? AND revoked_at IS NULL "
                    "AND expires_at > ?", (_hash(refresh_token), now_iso()))
    if row is None:
        return None
    new_refresh = secrets.token_urlsafe(32)
    store.run("UPDATE edge_sessions SET refresh_hash = ? WHERE id = ?",
              (_hash(new_refresh), row["id"]))
    return (_out(json.loads(row["session_json"]), _access_token(keys, row["id"]),
                 row["expires_at"]), new_refresh)


def revoke(store: Store, refresh_token: str) -> EdgeSession | None:
    row = store.one("SELECT * FROM edge_sessions WHERE refresh_hash = ? AND revoked_at IS NULL",
                    (_hash(refresh_token),))
    if row is None:
        return None
    store.run("UPDATE edge_sessions SET revoked_at = ? WHERE id = ?", (now_iso(), row["id"]))
    return _session(row)


def has_live_session(store: Store, person_id: str) -> bool:
    return store.one("SELECT 1 FROM edge_sessions WHERE person_id = ? AND revoked_at IS NULL "
                     "AND expires_at > ?", (person_id, now_iso())) is not None
```

`kiosk_laptop/edge/src/edge/deps.py`:

```python
"""Request helpers shared by the edge routes."""

from fastapi import HTTPException, Request

from edge import sessions
from edge.sessions import EdgeSession

ADMIN_RANK = 60


def err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def current_session(request: Request) -> EdgeSession | None:
    token = bearer(request)
    if token is None:
        return None
    st = request.app.state
    return sessions.from_access_token(st.store, st.keys, token)


def require_session(request: Request) -> EdgeSession:
    session = current_session(request)
    if session is None:
        raise err(401, "not_authenticated")
    return session


def require_admin(request: Request) -> EdgeSession:
    session = require_session(request)
    if session.max_rank < ADMIN_RANK:
        raise err(403, "forbidden")
    return session
```

`kiosk_laptop/edge/src/edge/__main__.py`:

```python
"""`python -m edge reset-key [--data-dir /data]` — replace an unreadable
edge.key. Everything encrypted under the old key (cloud tokens) and every
offline verifier and edge session is deleted; people sign in online again.
Queued work stays and uploads once its owner signs in online."""

import argparse
import sqlite3
from pathlib import Path

from edge.crypto import KEY_FILE


def main() -> None:
    parser = argparse.ArgumentParser(prog="edge")
    parser.add_argument("command", choices=["reset-key"])
    parser.add_argument("--data-dir", default="/data")
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    (data_dir / KEY_FILE).unlink(missing_ok=True)
    db = data_dir / "edge.db"
    if db.exists():
        conn = sqlite3.connect(db)
        with conn:
            for table in ("cloud_sessions", "offline_logins", "edge_sessions"):
                conn.execute(f"DELETE FROM {table}")
            conn.execute("UPDATE outbox SET status = 'needs_sign_in' "
                         "WHERE status IN ('queued', 'sending')")
        conn.close()
    print("edge.key removed; a new one is created on the next start. Everyone signs in online again.")


if __name__ == "__main__":
    main()
```

In `kiosk_laptop/edge/src/edge/app.py`, add the import and the state line right after `app.state.store = ...`:

```python
from edge.crypto import load_or_create_keys
```
```python
    app.state.keys = load_or_create_keys(settings.data_dir)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/edge
git commit -m "feat(kiosk-laptop): edge key file, argon2 verifiers, edge-issued sessions, reset-key CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Upstream client — online detection and per-person cloud sessions

**Files:**
- Create: `kiosk_laptop/edge/src/edge/upstream.py`
- Modify: `kiosk_laptop/edge/src/edge/app.py` (`app.state.upstream`, closed on shutdown)
- Test: `kiosk_laptop/edge/tests/test_upstream.py`

**Interfaces:**
- Consumes: `Store`, `now_iso`, `iso` (Task 1); `Keys`, `encrypt`, `decrypt` (Task 2).
- Produces: `CloudOffline(Exception)`; `REFRESH_COOKIE = "ss_refresh"`; `refresh_cookie_from(resp: httpx.Response) -> str | None`; `Upstream(settings, store, keys, *, transport=None)` with attributes `online: bool`, `last_contact: str | None`, and methods `async request(method, path, **httpx_kwargs) -> httpx.Response` (raises `CloudOffline`), `async probe() -> bool`, `save_session(person_id, *, refresh_token, access_token, expires_in) -> None`, `has_session(person_id) -> bool`, `latest_session_person() -> str | None`, `drop_session(person_id) -> None`, `mark_ending(person_id) -> None`, `ending_people() -> list[str]`, `async as_person(person_id, method, path, **httpx_kwargs) -> httpx.Response | None` (None = no usable cloud session; raises `CloudOffline`), `async end_session(person_id) -> bool`, `async aclose()`.

- [ ] **Step 1: Write the failing tests**

`kiosk_laptop/edge/tests/test_upstream.py`:

```python
import httpx
import pytest

from edge.upstream import CloudOffline, refresh_cookie_from


def _set_cookie(token):
    return {"set-cookie": f"ss_refresh={token}; HttpOnly; Path=/auth; SameSite=lax"}


async def test_transport_error_is_offline(app, cloud):
    cloud.get("/system/status").mock(side_effect=httpx.ConnectError("down"))
    up = app.state.upstream
    with pytest.raises(CloudOffline):
        await up.request("GET", "/system/status")
    assert up.online is False
    assert await up.probe() is False


async def test_any_http_answer_is_online(app, cloud):
    cloud.get("/system/status").respond(503, json={"detail": "x"})
    up = app.state.upstream
    resp = await up.request("GET", "/system/status")
    assert resp.status_code == 503 and up.online is True and up.last_contact


def test_refresh_cookie_parsed_from_set_cookie():
    resp = httpx.Response(200, headers=[("set-cookie", "other=1; Path=/"),
                                        ("set-cookie", "ss_refresh=abc123; HttpOnly; Path=/auth")])
    assert refresh_cookie_from(resp) == "abc123"
    assert refresh_cookie_from(httpx.Response(200)) is None


async def test_as_person_uses_stored_access_token(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    route = cloud.get("/kiosk/setup-options").respond(200, json={"ok": True})
    resp = await up.as_person("p-1", "GET", "/kiosk/setup-options")
    assert resp.json() == {"ok": True}
    assert route.calls[0].request.headers["authorization"] == "Bearer a1"


async def test_as_person_refreshes_on_401_and_stores_rotated_cookie(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="stale", expires_in=900)
    cloud.get("/kiosk/setup-options").mock(side_effect=[
        httpx.Response(401, json={"detail": {"code": "token_expired"}}),
        httpx.Response(200, json={"ok": True}),
    ])
    refresh = cloud.post("/auth/refresh").respond(
        200, json={"access_token": "a2", "expires_in": 900}, headers=_set_cookie("r2"))
    resp = await up.as_person("p-1", "GET", "/kiosk/setup-options")
    assert resp.status_code == 200
    assert refresh.calls[0].request.headers["cookie"] == "ss_refresh=r1"
    assert up._refresh_token("p-1") == "r2"     # the rotated token is the one kept


async def test_rejected_refresh_drops_the_cloud_session(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=-60)
    cloud.post("/auth/refresh").respond(401, json={"detail": {"code": "invalid_refresh"}})
    assert await up.as_person("p-1", "GET", "/kiosk/setup-options") is None
    assert up.has_session("p-1") is False


async def test_no_session_returns_none_without_network(app, cloud):
    assert await app.state.upstream.as_person("nobody", "GET", "/x") is None
    assert len(cloud.calls) == 0


async def test_end_session_logs_out_and_drops(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    logout = cloud.post("/auth/logout").respond(204)
    assert await up.end_session("p-1") is True
    assert logout.calls[0].request.headers["cookie"] == "ss_refresh=r1"
    assert up.has_session("p-1") is False


async def test_tokens_are_encrypted_at_rest(app):
    app.state.upstream.save_session("p-1", refresh_token="r1-secret", access_token="a1-secret",
                                     expires_in=900)
    row = app.state.store.one("SELECT * FROM cloud_sessions WHERE person_id='p-1'")
    assert "r1-secret" not in row["refresh_enc"] and "a1-secret" not in row["access_enc"]
```

(`_refresh_token(person_id) -> str | None` is a small private reader the implementation provides; the test uses it to check the rotated cookie was kept.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q tests/test_upstream.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'edge.upstream'` / `AttributeError: 'State' object has no attribute 'upstream'`.

- [ ] **Step 3: Implement**

`kiosk_laptop/edge/src/edge/upstream.py`:

```python
"""The edge's line to the cloud API.

Only transport failures (connect refused, DNS, timeouts) mean "offline";
any HTTP answer — 401, 5xx, anything — is the cloud's answer and is
returned to the caller. Each person who signed in online has their own
cloud session here (encrypted); the edge always acts on the cloud AS that
person, so attribution is never forged. A per-person lock keeps two
concurrent requests from both spending one rotating refresh token."""

import asyncio
from datetime import UTC, datetime, timedelta

import httpx

from edge.config import Settings
from edge.crypto import Keys, decrypt, encrypt
from edge.db import Store, iso, now_iso

REFRESH_COOKIE = "ss_refresh"


class CloudOffline(Exception):
    pass


def refresh_cookie_from(resp: httpx.Response) -> str | None:
    for header in resp.headers.get_list("set-cookie"):
        name, _, rest = header.partition("=")
        if name.strip() == REFRESH_COOKIE:
            value = rest.split(";", 1)[0].strip()
            return value or None
    return None


class Upstream:
    def __init__(self, settings: Settings, store: Store, keys: Keys, *, transport=None) -> None:
        self.store = store
        self.keys = keys
        self.client = httpx.AsyncClient(base_url=settings.cloud_api_url,
                                        timeout=httpx.Timeout(15.0, connect=5.0),
                                        transport=transport)
        self.online = False
        self.last_contact: str | None = None
        self._locks: dict[str, asyncio.Lock] = {}

    async def aclose(self) -> None:
        await self.client.aclose()

    async def request(self, method: str, path: str, **kw) -> httpx.Response:
        try:
            resp = await self.client.request(method, path, **kw)
        except httpx.TransportError as exc:
            self.online = False
            raise CloudOffline(str(exc)) from exc
        self.online = True
        self.last_contact = now_iso()
        return resp

    async def probe(self) -> bool:
        try:
            await self.request("GET", "/system/status")
        except CloudOffline:
            return False
        return True

    # ── stored cloud sessions ──────────────────────────────────────

    def save_session(self, person_id: str, *, refresh_token: str, access_token: str,
                     expires_in: int) -> None:
        expires = iso(datetime.now(UTC) + timedelta(seconds=expires_in - 30))
        self.store.run(
            "INSERT INTO cloud_sessions (person_id, refresh_enc, access_enc, access_expires_at, "
            "ending, updated_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(person_id) DO UPDATE SET "
            "refresh_enc = excluded.refresh_enc, access_enc = excluded.access_enc, "
            "access_expires_at = excluded.access_expires_at, ending = 0, "
            "updated_at = excluded.updated_at",
            (person_id, encrypt(self.keys, refresh_token), encrypt(self.keys, access_token),
             expires, now_iso()))

    def has_session(self, person_id: str) -> bool:
        return self.store.one("SELECT 1 FROM cloud_sessions WHERE person_id = ?",
                              (person_id,)) is not None

    def latest_session_person(self) -> str | None:
        row = self.store.one("SELECT person_id FROM cloud_sessions WHERE ending = 0 "
                             "ORDER BY updated_at DESC LIMIT 1")
        return row["person_id"] if row else None

    def drop_session(self, person_id: str) -> None:
        self.store.run("DELETE FROM cloud_sessions WHERE person_id = ?", (person_id,))

    def mark_ending(self, person_id: str) -> None:
        self.store.run("UPDATE cloud_sessions SET ending = 1 WHERE person_id = ?", (person_id,))

    def ending_people(self) -> list[str]:
        return [r["person_id"] for r in
                self.store.all("SELECT person_id FROM cloud_sessions WHERE ending = 1")]

    def _refresh_token(self, person_id: str) -> str | None:
        row = self.store.one("SELECT refresh_enc FROM cloud_sessions WHERE person_id = ?",
                             (person_id,))
        return decrypt(self.keys, row["refresh_enc"]) if row else None

    def _fresh_access(self, person_id: str) -> str | None:
        row = self.store.one("SELECT access_enc, access_expires_at FROM cloud_sessions "
                             "WHERE person_id = ?", (person_id,))
        if row and row["access_enc"] and row["access_expires_at"] > now_iso():
            return decrypt(self.keys, row["access_enc"])
        return None

    async def _refresh(self, person_id: str, stale: str | None) -> str | None:
        lock = self._locks.setdefault(person_id, asyncio.Lock())
        async with lock:
            current = self._fresh_access(person_id)
            if current is not None and current != stale:
                return current  # another request refreshed while we waited
            refresh_token = self._refresh_token(person_id)
            if refresh_token is None:
                return None
            resp = await self.request("POST", "/auth/refresh",
                                      headers={"Cookie": f"{REFRESH_COOKIE}={refresh_token}"})
            if resp.status_code in (401, 403):
                self.drop_session(person_id)
                return None
            if resp.status_code != 200:
                raise CloudOffline(f"refresh answered {resp.status_code}")
            data = resp.json()
            self.save_session(person_id,
                              refresh_token=refresh_cookie_from(resp) or refresh_token,
                              access_token=data["access_token"], expires_in=data["expires_in"])
            return data["access_token"]

    async def as_person(self, person_id: str, method: str, path: str,
                        **kw) -> httpx.Response | None:
        if not self.has_session(person_id):
            return None
        token = self._fresh_access(person_id) or await self._refresh(person_id, None)
        if token is None:
            return None
        headers = dict(kw.pop("headers", None) or {})
        headers["Authorization"] = f"Bearer {token}"
        resp = await self.request(method, path, headers=headers, **kw)
        if resp.status_code == 401:
            token = await self._refresh(person_id, token)
            if token is None:
                return None
            headers["Authorization"] = f"Bearer {token}"
            resp = await self.request(method, path, headers=headers, **kw)
        return resp

    async def end_session(self, person_id: str) -> bool:
        refresh_token = self._refresh_token(person_id)
        if refresh_token is None:
            return True
        try:
            await self.request("POST", "/auth/logout",
                               headers={"Cookie": f"{REFRESH_COOKIE}={refresh_token}"})
        except CloudOffline:
            return False
        self.drop_session(person_id)
        return True
```

In `app.py`: import `from edge.upstream import Upstream`; after `app.state.keys = ...` add
```python
    app.state.upstream = Upstream(settings, app.state.store, app.state.keys, transport=transport)
```
and give the app a lifespan that closes it (background work is added in Task 8):
```python
from contextlib import asynccontextmanager
```
```python
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await app.state.upstream.aclose()
        app.state.store.close()
```
and pass `lifespan=lifespan` to `FastAPI(...)` (define `lifespan` above the `FastAPI(...)` call).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/edge
git commit -m "feat(kiosk-laptop): upstream client — offline detection, encrypted per-person cloud sessions with locked refresh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Outbox — queue scans and printer events, drain them as their owner

**Files:**
- Create: `kiosk_laptop/edge/src/edge/outbox.py`, `kiosk_laptop/edge/src/edge/routes/kiosk.py`
- Modify: `kiosk_laptop/edge/src/edge/app.py` (`app.state.outbox`, `app.state.outbox_wake`, include kiosk router before the catch-all; call `outbox.requeue_sending` at startup)
- Test: `kiosk_laptop/edge/tests/test_outbox.py`

**Interfaces:**
- Consumes: `Store`, `now_iso`, `iso`; `Upstream`, `CloudOffline`; `deps.require_session`; conftest `make_session`.
- Produces: constants `KIND_SCAN = "scan"`, `KIND_PRINTER = "printer_event"`, `BACKOFF_S = (5, 15, 60, 300, 900)`, `SCAN_BATCH = 100`, `PENDING = ("queued", "sending", "needs_sign_in", "failed")`; functions `enqueue_scans(store, person_id, person_name, scans: list[dict]) -> None`, `enqueue_printer_event(store, person_id, person_name, payload: dict) -> None`, `release_waiting(store, person_id) -> int`, `retry_failed(store) -> int`, `requeue_sending(store) -> None`, `counts(store) -> dict[str, int]` (keys: queued, sending, sent, rejected, failed, needs_sign_in), `waiting(store) -> list[dict]` (`{"person_name", "count"}`), `pending_count(store) -> int`; class `OutboxWorker(store, upstream, serial_getter: Callable[[], str])` with `async drain_once() -> int` (rows sent). Routes `POST /kiosk/scans`, `POST /kiosk/printer-events`.

- [ ] **Step 1: Write the failing tests**

`kiosk_laptop/edge/tests/test_outbox.py`:

```python
import json

import httpx

from edge import outbox
from tests.conftest import make_session


def _scan(n):
    return {"client_scan_id": f"00000000-0000-4000-8000-{n:012d}", "scanned_value": f"A{n}",
            "scan_type": "barcode", "scanned_at": "2026-10-01T12:00:00Z"}


async def test_scans_route_accepts_and_queues(app, client):
    hdrs = make_session(app)
    body = {"serial": "browser-serial", "scans": [_scan(1), _scan(2)]}
    r = await client.post("/kiosk/scans", json=body, headers=hdrs)
    assert r.status_code == 200
    assert r.json() == {"accepted": [_scan(1)["client_scan_id"], _scan(2)["client_scan_id"]],
                        "rejected": []}
    assert outbox.counts(app.state.store)["queued"] == 2
    # the same scan twice is still one row (idempotent on client_scan_id)
    await client.post("/kiosk/scans", json=body, headers=hdrs)
    assert outbox.counts(app.state.store)["queued"] == 2


async def test_scans_route_needs_a_session(client):
    r = await client.post("/kiosk/scans", json={"serial": "s", "scans": [_scan(1)]})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "not_authenticated"


async def test_printer_event_queued(app, client):
    r = await client.post("/kiosk/printer-events", json={"serial": "s", "event": "printed"},
                          headers=make_session(app))
    assert r.status_code == 204
    assert outbox.counts(app.state.store)["queued"] == 1


async def test_drain_sends_as_owner_with_edge_serial_in_batches(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(i) for i in range(150)])
    route = cloud.post("/kiosk/scans").mock(side_effect=lambda req: httpx.Response(
        200, json={"accepted": [s["client_scan_id"] for s in json.loads(req.content)["scans"]],
                   "rejected": []}))
    sent = await app.state.outbox.drain_once()
    assert sent == 150
    assert [len(json.loads(c.request.content)["scans"]) for c in route.calls] == [100, 50]
    first = json.loads(route.calls[0].request.content)
    assert first["serial"] == app.state.identity.serial
    assert route.calls[0].request.headers["authorization"] == "Bearer a1"
    assert outbox.counts(store)["sent"] == 150


async def test_rejected_codes_are_kept_not_retried(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1), _scan(2)])
    cloud.post("/kiosk/scans").respond(200, json={
        "accepted": [_scan(1)["client_scan_id"]],
        "rejected": [{"client_scan_id": _scan(2)["client_scan_id"], "code": "move_locked"}]})
    await app.state.outbox.drain_once()
    c = outbox.counts(store)
    assert c["sent"] == 1 and c["rejected"] == 1
    row = store.one("SELECT last_error FROM outbox WHERE status='rejected'")
    assert row["last_error"] == "move_locked"


async def test_offline_leaves_rows_queued_without_spending_attempts(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    cloud.post("/kiosk/scans").mock(side_effect=httpx.ConnectError("down"))
    assert await app.state.outbox.drain_once() == 0
    row = store.one("SELECT status, attempts FROM outbox")
    assert (row["status"], row["attempts"]) == ("queued", 0)


async def test_no_cloud_session_waits_for_sign_in_then_releases(app, cloud):
    store = app.state.store
    outbox.enqueue_scans(store, "p-2", "Sam Lee", [_scan(1), _scan(2)])
    await app.state.outbox.drain_once()
    assert outbox.counts(store)["needs_sign_in"] == 2
    assert outbox.waiting(store) == [{"person_name": "Sam Lee", "count": 2}]
    assert outbox.release_waiting(store, "p-2") == 2
    assert outbox.counts(store)["queued"] == 2


async def test_server_errors_back_off_then_fail(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    cloud.post("/kiosk/scans").respond(500)
    await app.state.outbox.drain_once()
    row = store.one("SELECT status, attempts, next_attempt_at FROM outbox")
    assert row["status"] == "queued" and row["attempts"] == 1
    store.run("UPDATE outbox SET attempts = ?, next_attempt_at = '2000-01-01T00:00:00+00:00'",
              (len(outbox.BACKOFF_S),))
    await app.state.outbox.drain_once()
    assert outbox.counts(store)["failed"] == 1
    assert outbox.retry_failed(store) == 1
    assert outbox.counts(store)["queued"] == 1


async def test_requeue_sending_on_startup(app):
    store = app.state.store
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    store.run("UPDATE outbox SET status='sending'")
    outbox.requeue_sending(store)
    assert outbox.counts(store)["queued"] == 1


async def test_ending_session_logged_out_after_its_rows_drain(app, cloud):
    store, up = app.state.store, app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    up.mark_ending("p-1")
    outbox.enqueue_scans(store, "p-1", "Jane Doe", [_scan(1)])
    cloud.post("/kiosk/scans").respond(200, json={"accepted": [_scan(1)["client_scan_id"]],
                                                  "rejected": []})
    logout = cloud.post("/auth/logout").respond(204)
    await app.state.outbox.drain_once()
    assert logout.called and up.has_session("p-1") is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q tests/test_outbox.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'edge.outbox'`.

- [ ] **Step 3: Implement**

`kiosk_laptop/edge/src/edge/outbox.py`:

```python
"""The upstream queue. The browser's own outbox sends scans to the edge,
which accepts them at once and owns getting them to the cloud: in order,
batched (≤100, the cloud's limit), as the person whose session took them.
Offline is not a failure — rows stay queued and no attempt is spent. A
cloud rejection code is final (shown, never retried); 5xx/408/423/429 back
off along BACKOFF_S and end `failed` (operator: Retry failed); a person
with no usable cloud session parks their rows as `needs_sign_in` until they
sign in online again (release_waiting)."""

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from edge.db import Store, iso, now_iso
from edge.sessions import has_live_session
from edge.upstream import CloudOffline, Upstream

KIND_SCAN = "scan"
KIND_PRINTER = "printer_event"
BACKOFF_S = (5, 15, 60, 300, 900)
SCAN_BATCH = 100
STATUSES = ("queued", "sending", "sent", "rejected", "failed", "needs_sign_in")
PENDING = ("queued", "sending", "needs_sign_in", "failed")
TRANSIENT = {408, 423, 429}


def _insert(store: Store, kind: str, person_id: str, person_name: str, payload: dict,
            dedupe_key: str | None) -> None:
    now = now_iso()
    store.run(
        "INSERT OR IGNORE INTO outbox (kind, person_id, person_name, payload, next_attempt_at, "
        "created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (kind, person_id, person_name, json.dumps(payload), now, now, dedupe_key))


def enqueue_scans(store: Store, person_id: str, person_name: str, scans: list[dict]) -> None:
    for scan in scans:
        _insert(store, KIND_SCAN, person_id, person_name, scan,
                f"scan:{scan['client_scan_id']}")


def enqueue_printer_event(store: Store, person_id: str, person_name: str,
                          payload: dict) -> None:
    _insert(store, KIND_PRINTER, person_id, person_name, payload, None)


def release_waiting(store: Store, person_id: str) -> int:
    return store.run("UPDATE outbox SET status = 'queued', next_attempt_at = ? "
                     "WHERE person_id = ? AND status = 'needs_sign_in'", (now_iso(), person_id))


def retry_failed(store: Store) -> int:
    return store.run("UPDATE outbox SET status = 'queued', attempts = 0, next_attempt_at = ? "
                     "WHERE status IN ('failed', 'needs_sign_in')", (now_iso(),))


def requeue_sending(store: Store) -> None:
    store.run("UPDATE outbox SET status = 'queued' WHERE status = 'sending'")


def counts(store: Store) -> dict[str, int]:
    out = dict.fromkeys(STATUSES, 0)
    for row in store.all("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status"):
        out[row["status"]] = row["n"]
    return out


def waiting(store: Store) -> list[dict]:
    return [{"person_name": r["person_name"], "count": r["n"]} for r in store.all(
        "SELECT person_name, COUNT(*) AS n FROM outbox WHERE status = 'needs_sign_in' "
        "GROUP BY person_id, person_name ORDER BY person_name")]


def pending_count(store: Store) -> int:
    marks = ",".join("?" * len(PENDING))
    return store.one(f"SELECT COUNT(*) AS n FROM outbox WHERE status IN ({marks})",
                     PENDING)["n"]


def _code(resp) -> str:
    try:
        return resp.json()["detail"]["code"]
    except (ValueError, KeyError, TypeError):
        return f"http_{resp.status_code}"


class OutboxWorker:
    def __init__(self, store: Store, upstream: Upstream, serial_getter: Callable[[], str]) -> None:
        self.store = store
        self.upstream = upstream
        self.serial = serial_getter

    def _due_group(self) -> list:
        rows = self.store.all("SELECT * FROM outbox WHERE status = 'queued' AND "
                              "next_attempt_at <= ? ORDER BY id LIMIT ?", (now_iso(), SCAN_BATCH))
        if not rows:
            return []
        first = rows[0]
        if first["kind"] != KIND_SCAN:
            return [first]
        group = []
        for row in rows:
            if row["kind"] != KIND_SCAN or row["person_id"] != first["person_id"]:
                break
            group.append(row)
        return group

    def _set(self, ids: list[int], status: str, error: str | None = None) -> None:
        marks = ",".join("?" * len(ids))
        self.store.run(f"UPDATE outbox SET status = ?, last_error = ? WHERE id IN ({marks})",
                       (status, error, *ids))

    def _back_off(self, rows: list, error: str) -> None:
        for row in rows:
            attempts = row["attempts"] + 1
            if attempts > len(BACKOFF_S):
                self._set([row["id"]], "failed", error)
                continue
            due = iso(datetime.now(UTC) + timedelta(seconds=BACKOFF_S[attempts - 1]))
            self.store.run("UPDATE outbox SET status = 'queued', attempts = ?, "
                           "next_attempt_at = ?, last_error = ? WHERE id = ?",
                           (attempts, due, error, row["id"]))

    async def _send(self, rows: list):
        first = rows[0]
        if first["kind"] == KIND_SCAN:
            body = {"serial": self.serial(), "scans": [json.loads(r["payload"]) for r in rows]}
            return await self.upstream.as_person(first["person_id"], "POST", "/kiosk/scans",
                                                 json=body)
        body = {**json.loads(first["payload"]), "serial": self.serial()}
        return await self.upstream.as_person(first["person_id"], "POST",
                                             "/kiosk/printer-events", json=body)

    async def drain_once(self) -> int:
        sent = 0
        while group := self._due_group():
            ids = [r["id"] for r in group]
            self._set(ids, "sending")
            try:
                resp = await self._send(group)
            except CloudOffline:
                self._set(ids, "queued")
                break
            if resp is None:
                self._set(ids, "needs_sign_in")
                continue
            if resp.status_code in (200, 204):
                rejected = {}
                if group[0]["kind"] == KIND_SCAN and resp.status_code == 200:
                    rejected = {r["client_scan_id"]: r["code"]
                                for r in resp.json().get("rejected", [])}
                for row in group:
                    scan_id = json.loads(row["payload"]).get("client_scan_id")
                    if scan_id in rejected:
                        self._set([row["id"]], "rejected", rejected[scan_id])
                    else:
                        self._set([row["id"]], "sent")
                        sent += 1
            elif resp.status_code >= 500 or resp.status_code in TRANSIENT:
                self._back_off(group, _code(resp))
            else:
                self._set(ids, "failed", _code(resp))
        await self._end_sessions()
        return sent

    async def _end_sessions(self) -> None:
        for person_id in self.upstream.ending_people():
            busy = self.store.one("SELECT 1 FROM outbox WHERE person_id = ? AND status IN "
                                  "('queued', 'sending')", (person_id,))
            if busy is None and not has_live_session(self.store, person_id):
                await self.upstream.end_session(person_id)
```

`kiosk_laptop/edge/src/edge/routes/kiosk.py`:

```python
"""Kiosk endpoints the edge answers itself rather than proxying."""

from fastapi import APIRouter, Depends, Request, Response

from edge import outbox
from edge.deps import err, require_session
from edge.sessions import EdgeSession

router = APIRouter(prefix="/kiosk")


@router.post("/scans")
async def scans(request: Request, session: EdgeSession = Depends(require_session)) -> dict:
    body = await request.json()
    items = body.get("scans") if isinstance(body, dict) else None
    if not isinstance(items, list) or not items or len(items) > outbox.SCAN_BATCH \
            or not all(isinstance(s, dict) and s.get("client_scan_id") for s in items):
        raise err(422, "bad_scans")
    outbox.enqueue_scans(request.app.state.store, session.person_id, session.person_name, items)
    request.app.state.outbox_wake.set()
    return {"accepted": [s["client_scan_id"] for s in items], "rejected": []}


@router.post("/printer-events", status_code=204)
async def printer_events(request: Request,
                         session: EdgeSession = Depends(require_session)) -> Response:
    body = await request.json()
    if not isinstance(body, dict):
        raise err(422, "bad_event")
    outbox.enqueue_printer_event(request.app.state.store, session.person_id,
                                 session.person_name, body)
    request.app.state.outbox_wake.set()
    return Response(status_code=204)
```

In `app.py`: add imports `import asyncio`, `from edge import outbox`, `from edge.outbox import OutboxWorker`, `from edge.routes import kiosk as kiosk_routes`; after `app.state.upstream = ...`:

```python
    app.state.outbox = OutboxWorker(app.state.store, app.state.upstream,
                                    lambda: app.state.identity.serial)
    app.state.outbox_wake = asyncio.Event()
    outbox.requeue_sending(app.state.store)
```
and `app.include_router(kiosk_routes.router)` next to the edge router (both before the catch-all is declared).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/edge
git commit -m "feat(kiosk-laptop): edge outbox — scans and printer events queue locally and drain as their owner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sign-in through the edge — online adopt, offline fallback, refresh, sign-out

**Files:**
- Create: `kiosk_laptop/edge/src/edge/offline.py`, `kiosk_laptop/edge/src/edge/routes/auth.py`
- Modify: `kiosk_laptop/edge/src/edge/app.py` (include auth router before the catch-all)
- Test: `kiosk_laptop/edge/tests/test_auth_routes.py`

**Interfaces:**
- Consumes: `sessions.*`, `deps.*`, `crypto.make_verifier/check_verifier`, `Upstream`, `CloudOffline`, `refresh_cookie_from`, `outbox.release_waiting`, conftest `session_out`.
- Produces: `offline.FAIL_LIMIT = 10`, `offline.FAIL_WINDOW_S = 300`; `offline.cache_login(store, email, password, template)`, `offline.forget_login(store, email)`, `offline.check_login(store, email, password, days) -> dict | None`, `offline.check_move_password(store, password) -> dict | None`, `offline.too_many_failures(store, key) -> bool`, `offline.record_failure(store, key)`; `routes.auth.adopt(state, resp, data) -> tuple[dict, str]` (used by Task 6 too); `routes.auth.set_refresh_cookie(response, settings, token, expires_at)`; routes `POST /auth/login`, `POST /kiosk/move-login`, `POST /kiosk/pair/{code}/poll`, `POST /auth/refresh`, `POST /auth/logout`.

- [ ] **Step 1: Write the failing tests**

`kiosk_laptop/edge/tests/test_auth_routes.py`:

```python
import json

import httpx

from edge import outbox
from tests.conftest import session_out

LOGIN = {"email": "Jane@Example.com", "password": "CorrectHorse9!"}
SET_COOKIE = {"set-cookie": "ss_refresh=cloud-r1; HttpOnly; Path=/auth"}


def _cloud_login_ok(cloud, **kw):
    return cloud.post("/auth/login").respond(200, json=session_out(**kw), headers=SET_COOKIE)


def _offline(cloud):
    cloud.post("/auth/login").mock(side_effect=httpx.ConnectError("down"))
    cloud.post("/kiosk/move-login").mock(side_effect=httpx.ConnectError("down"))


async def test_online_login_adopts_cloud_session(app, client, cloud):
    route = _cloud_login_ok(cloud)
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 200
    data = r.json()
    assert data["access_token"] != "cloud-access-1"           # edge token, not the cloud's
    assert data["person"]["id"] == "p-1"
    assert "cloud-r1" not in r.headers.get("set-cookie", "")    # cloud cookie never leaks
    assert client.cookies.get("ss_refresh")                     # edge cookie set
    assert json.loads(route.calls[0].request.content)["client"] == "kiosk"
    assert app.state.upstream.has_session("p-1")
    assert app.state.store.one("SELECT 1 FROM offline_logins WHERE email='jane@example.com'")


async def test_online_login_releases_waiting_rows(app, client, cloud):
    outbox.enqueue_scans(app.state.store, "p-1", "Jane Doe", [{"client_scan_id": "s1"}])
    app.state.store.run("UPDATE outbox SET status='needs_sign_in'")
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    assert outbox.counts(app.state.store)["queued"] == 1


async def test_two_factor_challenge_passes_through(client, cloud):
    challenge = {"status": "totp_verify", "challenge_token": "c", "backup_codes_remaining": 3}
    cloud.post("/auth/login").respond(200, json=challenge)
    r = await client.post("/auth/login", json=LOGIN)
    assert r.json() == challenge


async def test_cloud_rejection_passes_through_and_forgets_verifier(app, client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    cloud.post("/auth/login").respond(401, json={"detail": {"code": "invalid_credentials"}})
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_credentials"
    assert app.state.store.one("SELECT 1 FROM offline_logins") is None


async def test_offline_login_with_cached_verifier(app, client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    _offline(cloud)
    r = await client.post("/auth/login", json={**LOGIN, "email": "jane@example.com "})
    assert r.status_code == 200 and r.json()["person"]["id"] == "p-1"
    row = app.state.store.one("SELECT offline FROM edge_sessions ORDER BY created_at DESC")
    assert row["offline"] == 1


async def test_offline_login_wrong_password_or_unknown(client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    _offline(cloud)
    r = await client.post("/auth/login", json={**LOGIN, "password": "nope"})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_credentials"
    r = await client.post("/auth/login", json={"email": "who@x.com", "password": "x"})
    assert r.status_code == 401


async def test_offline_login_expires_after_window(app, client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    app.state.store.run("UPDATE offline_logins SET cached_at='2000-01-01T00:00:00+00:00'")
    _offline(cloud)
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 401


async def test_offline_login_rate_limited(client, cloud):
    _offline(cloud)
    for _ in range(10):
        await client.post("/auth/login", json={**LOGIN, "password": "bad"})
    r = await client.post("/auth/login", json=LOGIN)
    assert r.status_code == 423 and r.json()["detail"]["code"] == "account_locked"


async def test_move_login_offline_uses_cached_hash(app, client, cloud):
    from edge.crypto import make_verifier
    from edge.sessions import template_from
    tpl = template_from(session_out(person_id="kiosk-m1", name="Kiosk Move",
                                    kiosk_move={"initiative_id": "m-1", "name": "Move"}))
    app.state.store.run(
        "INSERT INTO move_passwords VALUES ('m-1', 'Move', ?, ?, '2026-10-01T00:00:00+00:00')",
        (make_verifier("Crew-2026!"), json.dumps(tpl)))
    _offline(cloud)
    r = await client.post("/kiosk/move-login", json={"password": "Crew-2026!"})
    assert r.status_code == 200 and r.json()["kiosk_move"]["initiative_id"] == "m-1"
    r = await client.post("/kiosk/move-login", json={"password": "wrong-pass"})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_move_password"


async def test_move_login_online_adopts(app, client, cloud):
    cloud.post("/kiosk/move-login").respond(
        200, json=session_out(person_id="kiosk-m1",
                              kiosk_move={"initiative_id": "m-1", "name": "Move"}),
        headers=SET_COOKIE)
    r = await client.post("/kiosk/move-login", json={"password": "Crew-2026!"})
    assert r.status_code == 200 and app.state.upstream.has_session("kiosk-m1")


async def test_pair_poll_approved_is_adopted(app, client, cloud):
    cloud.post("/kiosk/pair/AB12/poll").respond(
        200, json={"status": "approved", "session": session_out()}, headers=SET_COOKIE)
    r = await client.post("/kiosk/pair/AB12/poll", json={"poll_token": "t"})
    body = r.json()
    assert body["status"] == "approved"
    assert body["session"]["access_token"] != "cloud-access-1"
    assert app.state.upstream.has_session("p-1")


async def test_pair_poll_pending_passes_through(client, cloud):
    cloud.post("/kiosk/pair/AB12/poll").respond(200, json={"status": "pending", "session": None})
    r = await client.post("/kiosk/pair/AB12/poll", json={"poll_token": "t"})
    assert r.json() == {"status": "pending", "session": None}


async def test_pair_poll_offline_is_edge_offline(client, cloud):
    cloud.post("/kiosk/pair/AB12/poll").mock(side_effect=httpx.ConnectError("down"))
    r = await client.post("/kiosk/pair/AB12/poll", json={"poll_token": "t"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"


async def test_refresh_and_logout(app, client, cloud):
    _cloud_login_ok(cloud)
    await client.post("/auth/login", json=LOGIN)
    r = await client.post("/auth/refresh")
    assert r.status_code == 200 and r.json()["person"]["id"] == "p-1"
    r = await client.post("/auth/logout")
    assert r.status_code == 204
    # the cloud session is kept until the outbox drains, then ended
    assert app.state.upstream.ending_people() == ["p-1"]
    r = await client.post("/auth/refresh")
    assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_refresh"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q tests/test_auth_routes.py`
Expected: FAIL — 404s from the catch-all / `ModuleNotFoundError: No module named 'edge.offline'`.

- [ ] **Step 3: Implement**

`kiosk_laptop/edge/src/edge/offline.py`:

```python
"""What lets someone sign in with no internet: an argon2 verifier of the
password they last used successfully online on this laptop (kept for
EDGE_OFFLINE_LOGIN_DAYS), and the hashed password of the move this laptop
is set up for (from the cloud, see sync.py). Failures are rate-limited
locally — the cloud's lockout can't help while it is unreachable."""

import json
from datetime import UTC, datetime, timedelta

from edge.crypto import check_verifier, make_verifier
from edge.db import Store, iso, now_iso

FAIL_LIMIT = 10
FAIL_WINDOW_S = 300


def cache_login(store: Store, email: str, password: str, template: dict) -> None:
    store.run(
        "INSERT INTO offline_logins (email, person_id, verifier, session_json, cached_at) "
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET person_id = excluded.person_id, "
        "verifier = excluded.verifier, session_json = excluded.session_json, "
        "cached_at = excluded.cached_at",
        (email, str(template["person"]["id"]), make_verifier(password), json.dumps(template),
         now_iso()))


def forget_login(store: Store, email: str) -> None:
    store.run("DELETE FROM offline_logins WHERE email = ?", (email,))


def check_login(store: Store, email: str, password: str, days: int) -> dict | None:
    row = store.one("SELECT * FROM offline_logins WHERE email = ?", (email,))
    oldest = iso(datetime.now(UTC) - timedelta(days=days))
    if row is None or row["cached_at"] < oldest or not check_verifier(row["verifier"], password):
        return None
    return json.loads(row["session_json"])


def check_move_password(store: Store, password: str) -> dict | None:
    for row in store.all("SELECT verifier, session_json FROM move_passwords"):
        if check_verifier(row["verifier"], password):
            return json.loads(row["session_json"])
    return None


def too_many_failures(store: Store, key: str) -> bool:
    since = iso(datetime.now(UTC) - timedelta(seconds=FAIL_WINDOW_S))
    store.run("DELETE FROM login_failures WHERE at < ?", (since,))
    row = store.one("SELECT COUNT(*) AS n FROM login_failures WHERE key = ?", (key,))
    return row["n"] >= FAIL_LIMIT


def record_failure(store: Store, key: str) -> None:
    store.run("INSERT INTO login_failures (key, at) VALUES (?, ?)", (key, now_iso()))
```

`kiosk_laptop/edge/src/edge/routes/auth.py`:

```python
"""Sign-in through the edge. Online, the cloud decides and the edge
ADOPTS the result: it keeps the cloud tokens server-side (encrypted, per
person) and hands the browser its own edge session in the same SessionOut
shape. Offline, the edge decides from what it cached. The cloud's error
codes reach the browser unchanged."""

from datetime import datetime
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Cookie, Request, Response
from fastapi.responses import JSONResponse

from edge import offline, outbox, sessions
from edge.config import Settings
from edge.deps import err
from edge.upstream import REFRESH_COOKIE, CloudOffline, refresh_cookie_from

router = APIRouter()


def set_refresh_cookie(response: Response, settings: Settings, token: str,
                       expires_at: str) -> None:
    response.set_cookie(REFRESH_COOKIE, token, expires=datetime.fromisoformat(expires_at),
                        httponly=True, secure=settings.secure_cookies, samesite="lax",
                        path="/auth")


def _clear_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path="/auth")


def passthrough(resp: httpx.Response) -> Response:
    return Response(content=resp.content, status_code=resp.status_code,
                    media_type=resp.headers.get("content-type", "application/json"))


def adopt(state, resp: httpx.Response, data: dict) -> tuple[dict, str]:
    person_id = str(data["person"]["id"])
    cloud_refresh = refresh_cookie_from(resp)
    if cloud_refresh:
        state.upstream.save_session(person_id, refresh_token=cloud_refresh,
                                    access_token=data["access_token"],
                                    expires_in=data["expires_in"])
        if outbox.release_waiting(state.store, person_id):
            state.outbox_wake.set()
    return sessions.issue(state.store, state.keys, template=sessions.template_from(data),
                          offline=False, expires_at=data["session_expires_at"])


def _session_response(state, out: dict, refresh_token: str) -> JSONResponse:
    response = JSONResponse(out)
    set_refresh_cookie(response, state.settings, refresh_token, out["session_expires_at"])
    return response


def _offline_session(state, template: dict) -> JSONResponse:
    out, refresh_token = sessions.issue(state.store, state.keys, template=template,
                                        offline=True, expires_at=sessions.offline_expiry())
    return _session_response(state, out, refresh_token)


@router.post("/auth/login")
async def login(request: Request) -> Response:
    st = request.app.state
    body = await request.json()
    body["client"] = "kiosk"
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    try:
        resp = await st.upstream.request("POST", "/auth/login", json=body)
    except CloudOffline:
        key = f"login:{email}"
        if offline.too_many_failures(st.store, key):
            raise err(423, "account_locked") from None
        template = offline.check_login(st.store, email, password, st.settings.offline_login_days)
        if template is None:
            offline.record_failure(st.store, key)
            raise err(401, "invalid_credentials") from None
        return _offline_session(st, template)
    if resp.status_code == 200:
        data = resp.json()
        if data.get("status") != "ok":
            return JSONResponse(data)  # 2FA challenge: the kiosk shows its message
        out, refresh_token = adopt(st, resp, data)
        offline.cache_login(st.store, email, password, sessions.template_from(data))
        return _session_response(st, out, refresh_token)
    if resp.status_code in (401, 403):
        offline.forget_login(st.store, email)
    return passthrough(resp)


@router.post("/kiosk/move-login")
async def move_login(request: Request) -> Response:
    st = request.app.state
    body = await request.json()
    password = str(body.get("password", ""))
    try:
        resp = await st.upstream.request("POST", "/kiosk/move-login", json=body)
    except CloudOffline:
        if offline.too_many_failures(st.store, "move"):
            raise err(429, "move_login_rate_limited") from None
        template = offline.check_move_password(st.store, password)
        if template is None:
            offline.record_failure(st.store, "move")
            raise err(401, "invalid_move_password") from None
        return _offline_session(st, template)
    if resp.status_code == 200:
        out, refresh_token = adopt(st, resp, resp.json())
        return _session_response(st, out, refresh_token)
    return passthrough(resp)


@router.post("/kiosk/pair/{code}/poll")
async def pair_poll(code: str, request: Request) -> Response:
    st = request.app.state
    try:
        resp = await st.upstream.request("POST", f"/kiosk/pair/{quote(code, safe='')}/poll",
                                         content=await request.body(),
                                         headers={"content-type": "application/json"})
    except CloudOffline:
        raise err(503, "edge_offline") from None
    if resp.status_code == 200:
        data = resp.json()
        if data.get("status") == "approved" and data.get("session"):
            out, refresh_token = adopt(st, resp, data["session"])
            response = JSONResponse({**data, "session": out})
            set_refresh_cookie(response, st.settings, refresh_token, out["session_expires_at"])
            return response
    return passthrough(resp)


@router.post("/auth/refresh")
async def refresh(request: Request, ss_refresh: str | None = Cookie(None)) -> Response:
    st = request.app.state
    got = sessions.refresh(st.store, st.keys, ss_refresh) if ss_refresh else None
    if got is None:
        response = JSONResponse({"detail": {"code": "invalid_refresh"}}, status_code=401)
        _clear_cookie(response)
        return response
    out, refresh_token = got
    return _session_response(st, out, refresh_token)


@router.post("/auth/logout", status_code=204)
async def logout(request: Request, ss_refresh: str | None = Cookie(None)) -> Response:
    st = request.app.state
    ended = sessions.revoke(st.store, ss_refresh) if ss_refresh else None
    if ended and not sessions.has_live_session(st.store, ended.person_id):
        # end the cloud session only once this person's queued work has gone up
        st.upstream.mark_ending(ended.person_id)
        st.outbox_wake.set()
    response = Response(status_code=204)
    _clear_cookie(response)
    return response
```

In `app.py`: `from edge.routes import auth as auth_routes` and `app.include_router(auth_routes.router)` with the other routers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/edge
git commit -m "feat(kiosk-laptop): sign-in through the edge — adopt cloud sessions, offline verifiers + move password, refresh, deferred sign-out

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Proxy with read-through cache, Kiosk Setup, and move sync

**Files:**
- Create: `kiosk_laptop/edge/src/edge/routes/proxy.py`, `kiosk_laptop/edge/src/edge/sync.py`
- Modify: `kiosk_laptop/edge/src/edge/routes/kiosk.py` (add `POST /kiosk/setup`)
- Modify: `kiosk_laptop/edge/src/edge/app.py` (`app.state.syncer`; catch-all calls `proxy.forward`)
- Test: `kiosk_laptop/edge/tests/test_proxy.py`, `kiosk_laptop/edge/tests/test_sync.py`

**Interfaces:**
- Consumes: everything above; `routes.auth.passthrough`.
- Produces: `proxy.CACHEABLE`, `proxy.OFFLINE_OK_WRITES`, `proxy.cache_key(path, query) -> str`, `proxy.store_cache(store, key, status, body)`, `async proxy.forward(request, path) -> Response`, `proxy.rewrite_body(path, body: bytes, identity) -> bytes`; `sync.sync_paths(initiative_id) -> list[str]`; `Syncer(store, upstream, serial_getter)` with `set_target(initiative_id, actor_person_id)`, `meta() -> dict` (`initiative_id, actor_person_id, synced_at, last_error`), `async run() -> dict` (returns `meta()`).

- [ ] **Step 1: Write the failing tests**

`kiosk_laptop/edge/tests/test_proxy.py`:

```python
import json

import httpx

from tests.conftest import make_session

ASSETS = "/kiosk/sync/assets?initiative_id=m-1"


def _online_as(app):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)


async def test_get_forwarded_as_person_and_cached(app, client, cloud):
    _online_as(app)
    route = cloud.get(ASSETS).respond(200, json={"assets": [1]})
    r = await client.get(ASSETS, headers=make_session(app))
    assert r.json() == {"assets": [1]}
    assert route.calls[0].request.headers["authorization"] == "Bearer a1"
    assert app.state.store.one("SELECT 1 FROM cache WHERE key=?", (ASSETS,))


async def test_offline_serves_cache_with_marker(app, client, cloud):
    _online_as(app)
    cloud.get(ASSETS).respond(200, json={"assets": [1]})
    hdrs = make_session(app)
    await client.get(ASSETS, headers=hdrs)
    cloud.get(ASSETS).mock(side_effect=httpx.ConnectError("down"))
    r = await client.get(ASSETS, headers=hdrs)
    assert r.status_code == 200 and r.json() == {"assets": [1]}
    assert r.headers["x-edge-cache"] == "hit"


async def test_offline_signed_in_person_without_cloud_session_reads_shared_cache(app, client):
    app.state.store.run("INSERT INTO cache VALUES (?, 200, ?, 'now')",
                        (ASSETS, json.dumps({"assets": [2]})))
    r = await client.get(ASSETS, headers=make_session(app, person_id="p-9"))
    assert r.json() == {"assets": [2]}


async def test_cacheable_kiosk_reads_need_a_session(client):
    r = await client.get(ASSETS)
    assert r.status_code == 401


async def test_move_locked_session_cannot_read_another_moves_cache(app, client):
    app.state.store.run("INSERT INTO cache VALUES (?, 200, '{}', 'now')",
                        ("/kiosk/sync/assets?initiative_id=m-2",))
    hdrs = make_session(app, kiosk_move={"initiative_id": "m-1", "name": "Move"})
    r = await client.get("/kiosk/sync/assets?initiative_id=m-2", headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked"


async def test_offline_setup_options_filtered_for_move_session(app, client):
    body = {"initiatives": [{"id": "m-1"}, {"id": "m-2"}], "scan_types": []}
    app.state.store.run("INSERT INTO cache VALUES ('/kiosk/setup-options', 200, ?, 'now')",
                        (json.dumps(body),))
    hdrs = make_session(app, kiosk_move={"initiative_id": "m-1", "name": "Move"})
    r = await client.get("/kiosk/setup-options", headers=hdrs)
    assert [i["id"] for i in r.json()["initiatives"]] == ["m-1"]


async def test_online_only_write_offline_is_edge_offline(app, client, cloud):
    _online_as(app)
    cloud.post("/kiosk/assets/a-1/rfid").mock(side_effect=httpx.ConnectError("down"))
    r = await client.post("/kiosk/assets/a-1/rfid", json={"rfid_tag": "E2"},
                          headers=make_session(app))
    assert r.status_code == 503 and r.json()["detail"]["code"] == "edge_offline"


async def test_sign_out_offline_is_204(app, client):
    r = await client.post("/kiosk/sign-out", json={"serial": "x"}, headers=make_session(app))
    assert r.status_code == 204


async def test_heartbeat_body_rewritten_to_edge_identity(app, client, cloud):
    _online_as(app)
    route = cloud.post("/kiosk/heartbeat").respond(200, json={"registration": "ok"})
    await client.post("/kiosk/heartbeat", headers=make_session(app),
                      json={"serial": "browser", "name": "Browser", "mode": "web", "version": "1"})
    sent = json.loads(route.calls[0].request.content)
    ident = app.state.identity
    assert (sent["serial"], sent["name"], sent["mode"]) == (ident.serial, ident.name, "laptop")


async def test_signed_in_online_without_cloud_session_must_sign_in_again(app, client, cloud):
    cloud.get("/system/status").respond(200, json={})
    await app.state.upstream.probe()
    r = await client.post("/kiosk/assets/a-1/rfid", json={}, headers=make_session(app))
    assert r.status_code == 401 and r.json()["detail"]["code"] == "cloud_sign_in_required"


async def test_anonymous_requests_forwarded_and_cloud_cookies_stripped(client, cloud):
    cloud.get("/system/status").respond(200, json={"read_only": False},
                                        headers={"set-cookie": "x=1; Path=/"})
    r = await client.get("/system/status")
    assert r.json() == {"read_only": False} and "set-cookie" not in r.headers


async def test_non_edge_bearer_forwarded_verbatim(client, cloud):
    route = cloud.post("/auth/totp/verify").respond(200, json={"ok": 1})
    await client.post("/auth/totp/verify", json={"code": "1"},
                      headers={"Authorization": "Bearer challenge-token"})
    assert route.calls[0].request.headers["authorization"] == "Bearer challenge-token"
```

`kiosk_laptop/edge/tests/test_sync.py`:

```python
import json

import httpx

from edge.sync import sync_paths
from tests.conftest import make_session, session_out


def _mock_sync(cloud, initiative="m-1", mp_status=200, moves=None):
    for path in sync_paths(initiative):
        cloud.get(path).respond(200, json={"path": path})
    cloud.get(url__regex=r"/kiosk/edge/move-passwords.*").respond(
        mp_status, json={"moves": moves or []})


async def test_setup_forwards_then_syncs(app, client, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    setup = cloud.post("/kiosk/setup").respond(200, json={"initiative_id": "m-1"})
    _mock_sync(cloud)
    r = await client.post("/kiosk/setup", headers=make_session(app),
                          json={"serial": "browser", "initiative_id": "m-1", "site_id": "s",
                                "scan_status": "x"})
    assert r.status_code == 200
    assert json.loads(setup.calls[0].request.content)["serial"] == app.state.identity.serial
    meta = app.state.syncer.meta()
    assert meta["initiative_id"] == "m-1" and meta["synced_at"] and meta["last_error"] is None
    keys = {r["key"] for r in app.state.store.all("SELECT key FROM cache")}
    assert set(sync_paths("m-1")) <= keys


async def test_setup_offline_is_edge_offline(app, client, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    cloud.post("/kiosk/setup").mock(side_effect=httpx.ConnectError("down"))
    r = await client.post("/kiosk/setup", headers=make_session(app), json={"initiative_id": "m-1"})
    assert r.status_code == 503


async def test_sync_replaces_move_passwords(app, cloud):
    from edge.crypto import make_verifier
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    tpl = {k: v for k, v in session_out(person_id="km", kiosk_move={
        "initiative_id": "m-1", "name": "Move"}).items()
        if k not in ("status", "access_token", "token_type", "expires_in", "session_expires_at")}
    _mock_sync(cloud, moves=[{"initiative_id": "m-1", "name": "Move",
                              "argon2_hash": make_verifier("Crew-2026!"), "session": tpl}])
    app.state.store.run("INSERT INTO move_passwords VALUES ('old', 'Old', 'v', '{}', 'now')")
    await app.state.syncer.run()
    rows = app.state.store.all("SELECT initiative_id FROM move_passwords")
    assert [r["initiative_id"] for r in rows] == ["m-1"]


async def test_sync_keeps_move_passwords_when_endpoint_refuses(app, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    _mock_sync(cloud, mp_status=403)
    app.state.store.run("INSERT INTO move_passwords VALUES ('m-1', 'Move', 'v', '{}', 'now')")
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None
    assert app.state.store.one("SELECT 1 FROM move_passwords WHERE initiative_id='m-1'")


async def test_failed_pull_leaves_old_snapshot_intact(app, cloud):
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.set_target("m-1", "p-1")
    key = sync_paths("m-1")[0]
    app.state.store.run("INSERT INTO cache VALUES (?, 200, 'old', 'then')", (key,))
    for path in sync_paths("m-1"):
        cloud.get(path).respond(500 if path.startswith("/kiosk/sync/trucks") else 200, json={})
    meta = await app.state.syncer.run()
    assert meta["last_error"].startswith("http_500")
    assert app.state.store.one("SELECT body FROM cache WHERE key=?", (key,))["body"] == "old"


async def test_sync_falls_back_to_latest_cloud_session(app, cloud):
    app.state.upstream.save_session("p-2", refresh_token="r2", access_token="a2", expires_in=900)
    app.state.syncer.set_target("m-1", "p-gone")
    _mock_sync(cloud)
    meta = await app.state.syncer.run()
    assert meta["last_error"] is None


async def test_sync_without_any_cloud_session_records_needs_sign_in(app):
    app.state.syncer.set_target("m-1", "p-1")
    meta = await app.state.syncer.run()
    assert meta["last_error"] == "needs_sign_in"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q tests/test_proxy.py tests/test_sync.py`
Expected: FAIL — 404s / `ModuleNotFoundError: No module named 'edge.sync'`.

- [ ] **Step 3: Implement**

`kiosk_laptop/edge/src/edge/routes/proxy.py`:

```python
"""Everything under /auth, /kiosk and /system that the edge doesn't answer
itself goes to the cloud — as the signed-in person when there is an edge
session, verbatim otherwise (2FA challenge tokens, anonymous status).

Reads the kiosk needs offline are cached on the way back (one shared copy:
move data is the same for everyone signed in to this kiosk) and served
from SQLite when the cloud is unreachable — never across a move lock.
Writes have no offline fallback here: the outbox handles scans and
printer events; everything else answers 503 `edge_offline`, which the
kiosk shows as its normal offline message."""

import json
from urllib.parse import parse_qs

from fastapi import Request, Response
from fastapi.responses import JSONResponse

from edge.db import Store, now_iso
from edge.deps import current_session, err
from edge.identity import Identity
from edge.sessions import EdgeSession
from edge.upstream import CloudOffline

CACHEABLE = ("/kiosk/sync/", "/kiosk/setup-options", "/kiosk/labels/vocab", "/system/status")
ANONYMOUS_OK = ("/system/status",)
OFFLINE_OK_WRITES = {"/kiosk/sign-out"}
DROP_HEADERS = {"content-length", "transfer-encoding", "connection", "set-cookie",
                "content-encoding", "keep-alive"}


def cache_key(path: str, query: str) -> str:
    return f"{path}?{query}" if query else path


def store_cache(store: Store, key: str, status: int, body: str) -> None:
    store.run("INSERT INTO cache (key, status, body, stored_at) VALUES (?, ?, ?, ?) "
              "ON CONFLICT(key) DO UPDATE SET status = excluded.status, body = excluded.body, "
              "stored_at = excluded.stored_at", (key, status, body, now_iso()))


def rewrite_body(path: str, body: bytes, identity: Identity) -> bytes:
    """The laptop's identity is the edge's, whatever the browser thinks."""
    if not body:
        return body
    try:
        data = json.loads(body)
    except ValueError:
        return body
    if not isinstance(data, dict):
        return body
    if "serial" in data:
        data["serial"] = identity.serial
    if path in ("/kiosk/heartbeat", "/kiosk/pair"):
        data["name"] = identity.name
    if path == "/kiosk/heartbeat":
        data["mode"] = "laptop"
    return json.dumps(data).encode()


def _cached(store: Store, session: EdgeSession | None, path: str, query: str) -> Response | None:
    row = store.one("SELECT status, body FROM cache WHERE key = ?", (cache_key(path, query),))
    if row is None:
        return None
    hit = {"X-Edge-Cache": "hit"}
    if session is not None and session.move_id is not None:
        initiative = parse_qs(query).get("initiative_id", [None])[0]
        if path.startswith("/kiosk/sync/") and path != "/kiosk/sync/people" \
                and initiative != session.move_id:
            raise err(403, "move_locked")
        if path == "/kiosk/setup-options":
            data = json.loads(row["body"])
            data["initiatives"] = [i for i in data.get("initiatives", [])
                                   if str(i.get("id")) == session.move_id]
            return JSONResponse(data, status_code=row["status"], headers=hit)
    return Response(row["body"], status_code=row["status"], media_type="application/json",
                    headers=hit)


def _offline_answer(store, session, method, path, query, cacheable) -> Response:
    if cacheable and (cached := _cached(store, session, path, query)) is not None:
        return cached
    if method != "GET" and path in OFFLINE_OK_WRITES:
        return Response(status_code=204)
    raise err(503, "edge_offline")


async def forward(request: Request, path: str) -> Response:
    st = request.app.state
    session = current_session(request)
    method = request.method
    query = request.url.query
    cacheable = method == "GET" and path.startswith(CACHEABLE)
    if cacheable and session is None and not path.startswith(ANONYMOUS_OK):
        raise err(401, "not_authenticated")
    body = rewrite_body(path, await request.body(), st.identity)
    headers = {"content-type": request.headers.get("content-type", "application/json")} \
        if body else {}
    target = cache_key(path, query)
    try:
        if session is not None:
            if not st.upstream.has_session(session.person_id):
                if not st.upstream.online or cacheable:
                    return _offline_answer(st.store, session, method, path, query, cacheable)
                raise err(401, "cloud_sign_in_required")
            resp = await st.upstream.as_person(session.person_id, method, target,
                                               content=body, headers=headers)
            if resp is None:
                raise err(401, "cloud_sign_in_required")
        else:
            if auth := request.headers.get("authorization"):
                headers["authorization"] = auth
            resp = await st.upstream.request(method, target, content=body, headers=headers)
    except CloudOffline:
        return _offline_answer(st.store, session, method, path, query, cacheable)
    if cacheable and resp.status_code == 200:
        store_cache(st.store, target, 200, resp.text)
    out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in DROP_HEADERS}
    return Response(content=resp.content, status_code=resp.status_code, headers=out_headers)
```

`kiosk_laptop/edge/src/edge/sync.py`:

```python
"""Pull the move this laptop is set up for into SQLite: the same reads the
kiosk makes after Kiosk Setup, stored as the cache entries the proxy serves
offline, plus the move's hashed password (so a move sign-in works with no
internet). All-or-nothing: every read must succeed before any is written,
in one transaction, so a dropped connection never leaves mixed data."""

import json
from collections.abc import Callable
from urllib.parse import quote

from edge.db import Store, now_iso
from edge.upstream import CloudOffline, Upstream


def sync_paths(initiative_id: str) -> list[str]:
    q = f"initiative_id={quote(initiative_id, safe='')}"
    return [f"/kiosk/sync/assets?{q}", "/kiosk/sync/people", f"/kiosk/sync/containers?{q}",
            f"/kiosk/sync/trucks?{q}", "/kiosk/labels/vocab", "/kiosk/setup-options"]


class Syncer:
    def __init__(self, store: Store, upstream: Upstream, serial_getter: Callable[[], str]) -> None:
        self.store = store
        self.upstream = upstream
        self.serial = serial_getter
        store.run("INSERT OR IGNORE INTO sync_meta (id) VALUES (1)")

    def set_target(self, initiative_id: str, actor_person_id: str) -> None:
        self.store.run("UPDATE sync_meta SET initiative_id = ?, actor_person_id = ? WHERE id = 1",
                       (initiative_id, actor_person_id))

    def meta(self) -> dict:
        row = self.store.one("SELECT initiative_id, actor_person_id, synced_at, last_error "
                             "FROM sync_meta WHERE id = 1")
        return dict(row)

    def _error(self, code: str) -> dict:
        self.store.run("UPDATE sync_meta SET last_error = ? WHERE id = 1", (code,))
        return self.meta()

    async def run(self) -> dict:
        meta = self.meta()
        initiative = meta["initiative_id"]
        if not initiative:
            return meta
        actor = meta["actor_person_id"]
        if not actor or not self.upstream.has_session(actor):
            actor = self.upstream.latest_session_person()
        if actor is None:
            return self._error("needs_sign_in")
        pulled: list[tuple[str, str]] = []
        try:
            for path in sync_paths(initiative):
                resp = await self.upstream.as_person(actor, "GET", path)
                if resp is None:
                    return self._error("needs_sign_in")
                if resp.status_code != 200:
                    return self._error(f"http_{resp.status_code}:{path}")
                pulled.append((path, resp.text))
            moves = await self.upstream.as_person(
                actor, "GET", f"/kiosk/edge/move-passwords?serial={quote(self.serial(), safe='')}")
        except CloudOffline:
            return self._error("offline")
        with self.store.tx() as c:
            for path, body in pulled:
                c.execute("INSERT INTO cache (key, status, body, stored_at) VALUES (?, 200, ?, ?) "
                          "ON CONFLICT(key) DO UPDATE SET status = 200, body = excluded.body, "
                          "stored_at = excluded.stored_at", (path, body, now_iso()))
            if moves is not None and moves.status_code == 200:
                c.execute("DELETE FROM move_passwords")
                for m in moves.json().get("moves", []):
                    c.execute("INSERT INTO move_passwords (initiative_id, name, verifier, "
                              "session_json, updated_at) VALUES (?, ?, ?, ?, ?)",
                              (str(m["initiative_id"]), m["name"], m["argon2_hash"],
                               json.dumps(m["session"]), now_iso()))
            c.execute("UPDATE sync_meta SET synced_at = ?, last_error = NULL WHERE id = 1",
                      (now_iso(),))
        return self.meta()
```

Add to `kiosk_laptop/edge/src/edge/routes/kiosk.py`:

```python
from edge.routes.auth import passthrough
from edge.routes.proxy import rewrite_body
from edge.upstream import CloudOffline


@router.post("/setup")
async def setup(request: Request, session: EdgeSession = Depends(require_session)) -> Response:
    """Kiosk Setup needs the cloud. On success the laptop is now set up for
    that move, so pull it down before answering — the browser's own download
    that follows then reads what the edge just stored."""
    st = request.app.state
    body = rewrite_body("/kiosk/setup", await request.body(), st.identity)
    try:
        resp = await st.upstream.as_person(session.person_id, "POST", "/kiosk/setup",
                                           content=body,
                                           headers={"content-type": "application/json"})
    except CloudOffline:
        raise err(503, "edge_offline") from None
    if resp is None:
        raise err(401, "cloud_sign_in_required")
    if resp.status_code == 200:
        st.syncer.set_target(str(resp.json()["initiative_id"]), session.person_id)
        await st.syncer.run()
    return passthrough(resp)
```

In `app.py`: `from edge.sync import Syncer` and `from edge.routes import proxy`; after the outbox lines:

```python
    app.state.syncer = Syncer(app.state.store, app.state.upstream,
                              lambda: app.state.identity.serial)
```
and in `catch_all` replace `return Response(status_code=404)  # replaced by the proxy in Task 6` with `return await proxy.forward(request, path)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/edge
git commit -m "feat(kiosk-laptop): proxy with offline read-through cache and move lock, Kiosk Setup + atomic move sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: /edge status and admin endpoints — status, sync now, retry, wipe, rename

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/routes/edge.py`
- Test: `kiosk_laptop/edge/tests/test_edge_routes.py`

**Interfaces:**
- Consumes: `deps.current_session/require_session/require_admin/err`, `outbox.counts/waiting/retry_failed/pending_count`, `Syncer`, `identity.rename`.
- Produces: `GET /edge/status` → `{"cloud": {"online", "last_contact"}, "sync": {"initiative_id", "synced_at", "last_error"}, "outbox": {status: n}, "waiting": [{"person_name", "count"}], "session": {"offline": bool} | null, "identity": {"serial", "name"}}` (anonymous callers get `session: null` and `waiting: []`); `POST /edge/sync` (session) → status; `POST /edge/outbox/retry` (session) → `{"requeued": n}`; `POST /edge/wipe` (admin, body `{"confirm"?: "WIPE"}`) → `{"cleared_move_data": bool}` or 409 `outbox_not_empty` with `pending`; `POST /edge/identity` (admin, body `{"name"}`) → `{"serial", "name"}`, 422 `bad_name`.

- [ ] **Step 1: Write the failing tests**

`kiosk_laptop/edge/tests/test_edge_routes.py`:

```python
from edge import outbox
from tests.conftest import make_session


async def test_status_anonymous(app, client):
    r = await client.get("/edge/status")
    body = r.json()
    assert body["cloud"]["online"] is False
    assert body["session"] is None and body["waiting"] == []
    assert body["identity"]["serial"] == app.state.identity.serial
    assert body["outbox"]["queued"] == 0


async def test_status_signed_in_offline_session(app, client):
    outbox.enqueue_scans(app.state.store, "p-2", "Sam Lee", [{"client_scan_id": "s1"}])
    app.state.store.run("UPDATE outbox SET status='needs_sign_in'")
    r = await client.get("/edge/status", headers=make_session(app, offline=True))
    body = r.json()
    assert body["session"] == {"offline": True}
    assert body["waiting"] == [{"person_name": "Sam Lee", "count": 1}]


async def test_sync_and_retry_need_a_session(client):
    assert (await client.post("/edge/sync")).status_code == 401
    assert (await client.post("/edge/outbox/retry")).status_code == 401


async def test_retry(app, client):
    outbox.enqueue_scans(app.state.store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    app.state.store.run("UPDATE outbox SET status='failed'")
    r = await client.post("/edge/outbox/retry", headers=make_session(app))
    assert r.json() == {"requeued": 1}


async def test_rename_admin_only(app, client):
    r = await client.post("/edge/identity", json={"name": "Dock 3"}, headers=make_session(app))
    assert r.status_code == 403
    admin = make_session(app, max_rank=60)
    r = await client.post("/edge/identity", json={"name": "  Dock 3 "}, headers=admin)
    assert r.json()["name"] == "Dock 3" and app.state.identity.name == "Dock 3"
    r = await client.post("/edge/identity", json={"name": ""}, headers=admin)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_name"


async def test_wipe_clears_auth_and_move_data_when_outbox_empty(app, client):
    store = app.state.store
    app.state.upstream.save_session("p-1", refresh_token="r", access_token="a", expires_in=900)
    store.run("INSERT INTO cache VALUES ('/kiosk/sync/people', 200, '{}', 'now')")
    store.run("INSERT INTO move_passwords VALUES ('m', 'M', 'v', '{}', 'now')")
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.json() == {"cleared_move_data": True}
    for table in ("cloud_sessions", "offline_logins", "edge_sessions", "move_passwords", "cache"):
        assert store.one(f"SELECT COUNT(*) AS n FROM {table}")["n"] == 0
    assert (app.state.settings.data_dir / "identity.json").exists()


async def test_wipe_with_pending_outbox_needs_typed_confirm(app, client):
    store = app.state.store
    outbox.enqueue_scans(store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    admin = make_session(app, max_rank=60)
    r = await client.post("/edge/wipe", json={}, headers=admin)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "outbox_not_empty", "pending": 1}
    admin = make_session(app, max_rank=60)
    r = await client.post("/edge/wipe", json={"confirm": "WIPE"}, headers=admin)
    assert r.json() == {"cleared_move_data": True}
    assert store.one("SELECT COUNT(*) AS n FROM outbox")["n"] == 0


async def test_wipe_not_for_workers(app, client):
    r = await client.post("/edge/wipe", json={}, headers=make_session(app))
    assert r.status_code == 403
```

Note on `test_wipe_with_pending_outbox_needs_typed_confirm`: the 409 path must NOT clear anything (the admin's session survives), so the second call can reuse a fresh session either way.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q tests/test_edge_routes.py`
Expected: FAIL — 404/405 on the new routes.

- [ ] **Step 3: Implement** — replace `kiosk_laptop/edge/src/edge/routes/edge.py` with:

```python
"""/edge/* — the laptop's own endpoints: identity, status for the footer and
the Edge settings tab, and the operator/admin actions."""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from edge import outbox
from edge.deps import current_session, err, require_admin, require_session
from edge.identity import rename
from edge.sessions import EdgeSession

router = APIRouter(prefix="/edge")

AUTH_TABLES = ("cloud_sessions", "offline_logins", "edge_sessions", "login_failures",
               "move_passwords")
MOVE_TABLES = ("cache", "outbox")


def _status(request: Request, session: EdgeSession | None) -> dict:
    st = request.app.state
    meta = st.syncer.meta()
    return {
        "cloud": {"online": st.upstream.online, "last_contact": st.upstream.last_contact},
        "sync": {"initiative_id": meta["initiative_id"], "synced_at": meta["synced_at"],
                 "last_error": meta["last_error"]},
        "outbox": outbox.counts(st.store),
        "waiting": outbox.waiting(st.store) if session else [],
        "session": {"offline": session.offline} if session else None,
        "identity": {"serial": st.identity.serial, "name": st.identity.name},
    }


@router.get("/identity")
async def get_identity(request: Request) -> dict:
    ident = request.app.state.identity
    return {"serial": ident.serial, "name": ident.name}


@router.post("/identity")
async def set_identity(request: Request, _: EdgeSession = Depends(require_admin)) -> dict:
    body = await request.json()
    st = request.app.state
    try:
        st.identity = rename(st.settings.data_dir, st.identity, str(body.get("name", "")))
    except ValueError:
        raise err(422, "bad_name") from None
    return {"serial": st.identity.serial, "name": st.identity.name}


@router.get("/status")
async def status(request: Request) -> dict:
    return _status(request, current_session(request))


@router.post("/sync")
async def sync_now(request: Request, session: EdgeSession = Depends(require_session)) -> dict:
    await request.app.state.syncer.run()
    return _status(request, session)


@router.post("/outbox/retry")
async def retry(request: Request, _: EdgeSession = Depends(require_session)) -> dict:
    n = outbox.retry_failed(request.app.state.store)
    request.app.state.outbox_wake.set()
    return {"requeued": n}


@router.post("/wipe")
async def wipe(request: Request, _: EdgeSession = Depends(require_admin)) -> JSONResponse:
    st = request.app.state
    body = await request.json()
    pending = outbox.pending_count(st.store)
    if pending and body.get("confirm") != "WIPE":
        raise err(409, "outbox_not_empty", pending=pending)
    with st.store.tx() as c:
        for table in AUTH_TABLES + MOVE_TABLES:
            c.execute(f"DELETE FROM {table}")
        c.execute("UPDATE sync_meta SET initiative_id = NULL, actor_person_id = NULL, "
                  "synced_at = NULL, last_error = NULL WHERE id = 1")
    response = JSONResponse({"cleared_move_data": True})
    response.delete_cookie("ss_refresh", path="/auth")
    return response
```

(The spec's "clears move data only when the outbox is empty" is realized as: an empty outbox wipes everything at once; a non-empty one refuses until the typed `WIPE` confirmation, then wipes everything including the queue. Identity and `edge.key` are never touched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/edge
git commit -m "feat(kiosk-laptop): /edge status, sync now, retry failed, admin wipe and rename

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Background loop — probe, drain, periodic sync

**Files:**
- Create: `kiosk_laptop/edge/src/edge/background.py`
- Modify: `kiosk_laptop/edge/src/edge/app.py` (lifespan starts/stops it when `settings.background`)
- Test: `kiosk_laptop/edge/tests/test_background.py`

**Interfaces:**
- Consumes: `app.state.upstream/.outbox/.syncer/.outbox_wake/.settings`.
- Produces: `Background(state)` with `async tick(now: float) -> None` (one iteration: probe; if online drain, and sync when `now - last_sync >= sync_interval_s`), `start()`, `async stop()`.

- [ ] **Step 1: Write the failing test**

`kiosk_laptop/edge/tests/test_background.py`:

```python
import httpx

from edge import outbox
from edge.background import Background


async def test_tick_drains_and_syncs_when_online(app, cloud):
    cloud.get("/system/status").respond(200, json={})
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(app.state.store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    cloud.post("/kiosk/scans").respond(200, json={"accepted": ["s1"], "rejected": []})
    calls = []
    app.state.syncer.run = lambda: calls.append(1) or _done()
    bg = Background(app.state)
    await bg.tick(now=1000.0)
    assert outbox.counts(app.state.store)["sent"] == 1
    assert calls == [1]
    await bg.tick(now=1001.0)               # inside the sync interval: no second sync
    assert calls == [1]


async def test_tick_offline_does_nothing(app, cloud):
    cloud.get("/system/status").mock(side_effect=httpx.ConnectError("down"))
    bg = Background(app.state)
    await bg.tick(now=1000.0)
    assert app.state.upstream.online is False


async def _done():
    return {}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q tests/test_background.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'edge.background'`.

- [ ] **Step 3: Implement**

`kiosk_laptop/edge/src/edge/background.py`:

```python
"""The edge's heartbeat: every probe interval (or as soon as something is
queued) check the cloud; when it answers, drain the outbox, and refresh the
move every sync interval. One bad iteration is logged, never fatal."""

import asyncio
import contextlib
import logging
import time

log = logging.getLogger("edge.background")


class Background:
    def __init__(self, state) -> None:
        self.state = state
        self.last_sync = float("-inf")
        self._task: asyncio.Task | None = None

    async def tick(self, now: float) -> None:
        st = self.state
        if not await st.upstream.probe():
            return
        await st.outbox.drain_once()
        if now - self.last_sync >= st.settings.sync_interval_s:
            self.last_sync = now
            await st.syncer.run()

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick(time.monotonic())
            except Exception:
                log.exception("background tick failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.state.outbox_wake.wait(),
                                       timeout=self.state.settings.probe_interval_s)
            self.state.outbox_wake.clear()

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
```

In `app.py`, change the lifespan to:

```python
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runner = Background(app.state) if settings.background else None
        if runner:
            runner.start()
        yield
        if runner:
            await runner.stop()
        await app.state.upstream.aclose()
        app.state.store.close()
```
with `from edge.background import Background`.

- [ ] **Step 4: Run all edge tests**

Run: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/edge
git commit -m "feat(kiosk-laptop): background probe/drain/sync loop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Cloud — `GET /kiosk/edge/move-passwords` and the edge contract test

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (after `KioskMoveOut`/`SessionOut`, add three models)
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (new route + imports)
- Create: `api/tests/test_kiosk_edge_move_passwords.py`, `api/tests/test_edge_contract.py`

**Interfaces:**
- Produces: `SessionTemplateOut` (= `SessionOut` minus `status/access_token/token_type/expires_in/session_expires_at`), `KioskEdgeMovePassword {initiative_id, name, argon2_hash, session: SessionTemplateOut}`, `KioskEdgeMovePasswordsOut {moves: list[KioskEdgeMovePassword]}`; route `GET /kiosk/edge/move-passwords?serial=` (needs `kiosk:view`; 403 `move_locked` for move sessions; 404 `device_not_found`; returns the move the kiosk Device with that serial is set up on — `Device.current_initiative_id` — only when it is a move, active, and has a password; audited `kiosk_edge_move_password`). The edge (Task 6) already consumes this shape.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_kiosk_edge_move_passwords.py`:

```python
"""GET /kiosk/edge/move-passwords — the laptop edge caches the hashed
password of the move it is set up for, so a move sign-in works offline.
Only that one move, only while active, never to a move session, and the
plaintext/fingerprint key never leave the server."""

from argon2 import PasswordHasher
from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, Initiative
from serversherpa.services import move_password as svc
from tests.test_status_values_write import _make

PW = "Crew-2026!"
SERIAL = "kiosk-laptop-edge-mp-1"


async def _setup(db, client, *, status="in_progress", password=True, set_up=True):
    hdrs = await _make(db, client, "admin", "edge-mp-admin@test.example.com")
    init = Initiative(name="Edge MP Move", initiative_type="move", status=status)
    db.add(init)
    await db.flush()
    if password:
        await svc.set_password(db, init, PW, actor_id=None)
    device = Device(device_type="kiosk", name="Laptop", serial=SERIAL,
                    current_initiative_id=init.id if set_up else None)
    db.add(device)
    await db.commit()
    return hdrs, init


async def test_returns_hash_and_session_template_for_the_set_up_move(client, db, seeded_user):
    hdrs, init = await _setup(db, client)
    r = await client.get(f"/kiosk/edge/move-passwords?serial={SERIAL}", headers=hdrs)
    assert r.status_code == 200, r.text
    [move] = r.json()["moves"]
    assert move["initiative_id"] == str(init.id)
    assert PasswordHasher().verify(move["argon2_hash"], PW)
    assert PW not in r.text
    assert move["session"]["kiosk_move"]["initiative_id"] == str(init.id)
    assert move["session"]["perms"]["kiosk"]["view"] is True
    assert "access_token" not in move["session"]
    logged = await db.scalar(select(AuditLog).where(AuditLog.action == "kiosk_edge_move_password"))
    assert logged is not None


async def test_inactive_unset_or_passwordless_moves_return_nothing(client, db, seeded_user):
    hdrs, init = await _setup(db, client, status="completed")
    r = await client.get(f"/kiosk/edge/move-passwords?serial={SERIAL}", headers=hdrs)
    assert r.json() == {"moves": []}


async def test_device_not_set_up_returns_nothing(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, set_up=False)
    r = await client.get(f"/kiosk/edge/move-passwords?serial={SERIAL}", headers=hdrs)
    assert r.json() == {"moves": []}


async def test_unknown_device_404(client, db, seeded_user):
    hdrs, _ = await _setup(db, client)
    r = await client.get("/kiosk/edge/move-passwords?serial=nope", headers=hdrs)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "device_not_found"


async def test_move_session_refused(client, db, seeded_user):
    await _setup(db, client)
    login = await client.post("/kiosk/move-login", json={"password": PW})
    hdrs = {"Authorization": f"Bearer {login.json()['access_token']}"}
    r = await client.get(f"/kiosk/edge/move-passwords?serial={SERIAL}", headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked"


async def test_needs_kiosk_view(client, db, seeded_user):
    await _setup(db, client)
    r = await client.get(f"/kiosk/edge/move-passwords?serial={SERIAL}")
    assert r.status_code == 401
```

Before relying on `svc.set_password(db, init, PW, actor_id=None)`, read its signature in `api/src/serversherpa/services/move_password.py:102` and pass whatever it requires (an admin `actor_id` from the `_make` person if `None` is refused). Likewise confirm `_make(db, client, "admin", email)` returns auth headers by reading `api/tests/test_status_values_write.py`.

`api/tests/test_edge_contract.py`:

```python
"""The laptop edge (kiosk_laptop/edge) treats cloud bodies as opaque JSON
except for these fields. If one of these assertions fails, the edge needs
the matching change before the cloud ships."""

import typing

from serversherpa.api.schemas import (
    HeartbeatIn, KioskScanBatchIn, KioskScanIn, SessionOut, SessionTemplateOut,
)

TOKEN_FIELDS = {"status", "access_token", "token_type", "expires_in", "session_expires_at"}


def test_session_template_is_sessionout_minus_token_fields():
    assert set(SessionTemplateOut.model_fields) == set(SessionOut.model_fields) - TOKEN_FIELDS


def test_sessionout_carries_what_the_edge_reads():
    assert {"access_token", "expires_in", "session_expires_at", "person", "max_rank",
            "kiosk_move"} <= set(SessionOut.model_fields)


def test_heartbeat_accepts_laptop_mode():
    assert "laptop" in typing.get_args(HeartbeatIn.model_fields["mode"].annotation)


def test_scan_batch_shape_and_limit():
    assert {"serial", "scans"} <= set(KioskScanBatchIn.model_fields)
    limit = [m.max_length for m in KioskScanBatchIn.model_fields["scans"].metadata
             if hasattr(m, "max_length")]
    assert limit == [100]
    assert "client_scan_id" in KioskScanIn.model_fields
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `api/`, foreground, 600000 ms timeout):
```bash
cd api && SS_TEST_DB=serversherpa_test_kiosk_laptop PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q tests/test_kiosk_edge_move_passwords.py tests/test_edge_contract.py
```
Expected: FAIL — `ImportError: cannot import name 'SessionTemplateOut'`.

- [ ] **Step 3: Implement**

In `api/src/serversherpa/api/schemas.py`, directly after `class LoginChallengeOut` (which follows `SessionOut`), add:

```python
class SessionTemplateOut(BaseModel):
    """A SessionOut without its tokens — what the laptop edge needs to mint
    its own offline session for a move's kiosk identity."""

    person: PersonOut
    roles: list[str]
    must_change_password: bool
    must_change_reason: Literal["temporary", "expired"] | None = None
    password_expires_at: datetime | None = None
    preferences: UiPreferences
    perms: dict[str, dict[str, bool]]
    max_rank: int
    scope: ScopeOut
    password_min_length: int = 8
    totp: TotpStatusOut
    kiosk_move: KioskMoveOut | None = None


class KioskEdgeMovePassword(BaseModel):
    initiative_id: uuid.UUID
    name: str
    argon2_hash: str
    session: SessionTemplateOut


class KioskEdgeMovePasswordsOut(BaseModel):
    moves: list[KioskEdgeMovePassword]
```

In `api/src/serversherpa/api/routes/kiosk.py`: add `KioskEdgeMovePassword, KioskEdgeMovePasswordsOut, SessionTemplateOut, UiPreferences` to the schemas import; add `from argon2 import PasswordHasher`; change the auth import to `from serversherpa.api.routes.auth import _scope_out, person_out, session_response, totp_status_out`; add `from serversherpa.config import get_settings` if not already imported. Then add, right after the `move_login` route:

```python
_EDGE_HASHER = PasswordHasher()


@router.get("/edge/move-passwords", response_model=KioskEdgeMovePasswordsOut)
async def edge_move_passwords(
    db: DbSession,
    serial: str = Query(min_length=1, max_length=120),
    actor: AuthContext = require_permission("kiosk", "view"),
) -> KioskEdgeMovePasswordsOut:
    """For the laptop edge: an argon2 hash of the password of the move the
    kiosk with `serial` is set up on, plus the session template for that
    move's kiosk identity, so a move sign-in works offline. Only that move,
    only while active; the plaintext and the HMAC fingerprint key never
    leave the server. Spec: docs/superpowers/specs/2026-10-01-kiosk-laptop-design.md"""
    if actor.session.initiative_id is not None:
        raise _err(403, "move_locked")
    device = await db.scalar(select(Device).where(Device.serial == serial))
    if device is None or device.device_type != "kiosk":
        raise _err(404, "device_not_found")
    initiative = (await db.get(Initiative, device.current_initiative_id)
                  if device.current_initiative_id else None)
    moves: list[KioskEdgeMovePassword] = []
    if (initiative is not None and initiative.kiosk_password_enc
            and move_password_service.is_move(initiative)
            and move_password_service.is_move_active(initiative)):
        account = await move_password_service.ensure_kiosk_identity(db, initiative)
        access = await resolve_access(db, account.person_id)
        if access.can("kiosk", "view"):
            template = SessionTemplateOut(
                person=person_out(account.person), roles=access.role_names,
                must_change_password=False,
                preferences=UiPreferences.model_validate(account.ui_prefs or {}),
                perms=access.perms, max_rank=access.max_rank, scope=_scope_out(access),
                password_min_length=get_settings().password_min_length,
                totp=await totp_status_out(db, account),
                kiosk_move=KioskMoveOut(initiative_id=initiative.id, name=initiative.name))
            moves.append(KioskEdgeMovePassword(
                initiative_id=initiative.id, name=initiative.name,
                argon2_hash=_EDGE_HASHER.hash(move_password_service.reveal(initiative)),
                session=template))
            audit(db, actor_id=actor.person.id, entity_type="initiative",
                  entity_id=str(initiative.id), action="kiosk_edge_move_password",
                  changes={"serial": serial})
    await db.commit()
    return KioskEdgeMovePasswordsOut(moves=moves)
```

- [ ] **Step 4: Run tests to verify they pass, then the kiosk and auth suites around it**

```bash
cd api && SS_TEST_DB=serversherpa_test_kiosk_laptop PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q tests/test_kiosk_edge_move_passwords.py tests/test_edge_contract.py tests/test_move_password_lock.py tests/test_kiosk_access.py tests/test_kiosk_session_scope.py
```
Expected: all pass. (`test_kiosk_access.py` may enumerate every kiosk route and its permission; if it fails because the new route is missing from its table, add the route there with `kiosk:view`.)

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/kiosk.py api/tests/test_kiosk_edge_move_passwords.py api/tests/test_edge_contract.py
git commit -m "feat(kiosk): GET /kiosk/edge/move-passwords for the laptop edge, plus the edge contract test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Kiosk front end — laptop mode, edge-owned identity, edge API helpers

**Files:**
- Modify: `kiosk/src/lib/config.ts`, `kiosk/src/lib/platform.ts`, `kiosk/src/lib/identity.ts`, `kiosk/src/lib/api.ts`
- Create: `kiosk/src/lib/edgeStatus.ts`, `kiosk/src/lib/platform.test.ts`, `kiosk/src/lib/edgeStatus.test.ts`
- Modify: `kiosk/src/lib/identity.test.ts`, `kiosk/src/lib/api.test.ts` (append cases)

**Interfaces:**
- Produces: `laptopIdentity(): { serial: string; name: string } | undefined` (config.ts); `platform(): { mode: KioskMode; label: string }` now returns `{ mode: 'laptop', label: 'Laptop' }` when `window.__KIOSK_CONFIG__.mode === 'laptop'`; `isLaptop(): boolean`; `setLaptopName(name: string): void` (identity.ts); in api.ts: `edge_offline` error code is mapped to `ApiError(0, 'network')`; `interface EdgeStatus`; `getEdgeStatus(): Promise<EdgeStatus>`; `edgeSyncNow(): Promise<EdgeStatus>`; `edgeRetryFailed(): Promise<{ requeued: number }>`; `edgeWipe(confirm?: string): Promise<{ cleared_move_data: boolean }>`; `renameLaptopKiosk(name: string): Promise<{ serial: string; name: string }>`; in edgeStatus.ts: `EDGE_POLL_MS = 15_000`, `useEdgeStatus(): { status: EdgeStatus | null; refresh: () => Promise<void> }`.

- [ ] **Step 1: Make sure the worktree has kiosk dependencies**

Run: `test -d kiosk/node_modules || npm ci --prefix kiosk`
Expected: exits 0.

- [ ] **Step 2: Write the failing tests**

`kiosk/src/lib/platform.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { isLaptop, platform } from './platform';

afterEach(() => { delete window.__KIOSK_CONFIG__; });

describe('platform', () => {
  it('is web by default', () => {
    expect(platform()).toEqual({ mode: 'web', label: 'Web' });
    expect(isLaptop()).toBe(false);
  });

  it('is laptop when the edge config says so', () => {
    window.__KIOSK_CONFIG__ = { mode: 'laptop' };
    expect(platform()).toEqual({ mode: 'laptop', label: 'Laptop' });
    expect(isLaptop()).toBe(true);
  });
});
```

Append to `kiosk/src/lib/identity.test.ts` (keep its existing imports; add `setLaptopName` to the identity import and `afterEach` to the vitest import if missing):

```ts
describe('laptop identity', () => {
  afterEach(() => { delete window.__KIOSK_CONFIG__; });

  it('uses the edge identity and ignores cookies/localStorage', () => {
    localStorage.setItem('ss.kiosk.serial', 'kiosk-web-old');
    window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1234', name: 'Dock 3' } };
    expect(getIdentity()).toEqual({ serial: 'kiosk-laptop-1234', name: 'Dock 3', persistent: true });
  });

  it('reflects a rename made through the edge', () => {
    window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1234', name: 'Dock 3' } };
    setLaptopName('Dock 4');
    expect(getIdentity().name).toBe('Dock 4');
  });
});
```

Append to `kiosk/src/lib/api.test.ts` (reuse that file's existing fetch-stubbing helpers; read the top of the file first and follow its pattern — the assertion that matters is):

```ts
it('maps the edge_offline code to the network error the screens already handle', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ detail: { code: 'edge_offline' } }), { status: 503 })));
  await expect(getSetupOptions()).rejects.toMatchObject({ status: 0, code: 'network' });
});
```

`kiosk/src/lib/edgeStatus.test.ts`:

```ts
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useEdgeStatus } from './edgeStatus';

const STATUS = {
  cloud: { online: false, last_contact: null },
  sync: { initiative_id: null, synced_at: null, last_error: null },
  outbox: { queued: 2, sending: 0, sent: 0, rejected: 0, failed: 0, needs_sign_in: 0 },
  waiting: [], session: null, identity: { serial: 's', name: 'n' },
};

afterEach(() => { delete window.__KIOSK_CONFIG__; vi.unstubAllGlobals(); });

describe('useEdgeStatus', () => {
  it('stays null and never fetches outside laptop mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useEdgeStatus());
    expect(result.current.status).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads /edge/status in laptop mode', async () => {
    window.__KIOSK_CONFIG__ = { mode: 'laptop', apiUrl: 'http://edge.test' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(STATUS))));
    const { result } = renderHook(() => useEdgeStatus());
    await waitFor(() => expect(result.current.status?.outbox.queued).toBe(2));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.status?.cloud.online).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm --prefix kiosk test -- src/lib/platform.test.ts src/lib/identity.test.ts src/lib/api.test.ts src/lib/edgeStatus.test.ts`
Expected: FAIL — `isLaptop` / `setLaptopName` / `./edgeStatus` not found; the `edge_offline` case rejects with code `edge_offline`.

- [ ] **Step 4: Implement**

`kiosk/src/lib/config.ts` — widen the global type and add a reader (keep everything else):

```ts
declare global {
  interface Window {
    __KIOSK_CONFIG__?: {
      apiUrl?: string;
      portalUrl?: string;
      /** 'laptop' when served by the laptop edition's edge (kiosk_laptop/). */
      mode?: string;
      /** The laptop's fixed identity, owned by the edge (/data/identity.json). */
      identity?: { serial: string; name: string };
    };
  }
}
```
```ts
/** The edge-owned identity in laptop mode; undefined everywhere else. */
export function laptopIdentity(): { serial: string; name: string } | undefined {
  if (typeof window === 'undefined') return undefined;
  const id = window.__KIOSK_CONFIG__?.identity;
  return id?.serial ? id : undefined;
}
```

`kiosk/src/lib/platform.ts` — replace the body:

```ts
/**
 * Which of the kiosk's run modes this is. The laptop edition's edge serves
 * `config.js` with `mode: 'laptop'`; everything else is web. `mode` is what
 * the heartbeat reports as the Device sub_type (the edge also forces it).
 */

export type KioskMode = 'web' | 'laptop' | 'pi' | 'android' | 'ios';

export function platform(): { mode: KioskMode; label: string } {
  const mode = typeof window !== 'undefined' ? window.__KIOSK_CONFIG__?.mode : undefined;
  return mode === 'laptop' ? { mode: 'laptop', label: 'Laptop' } : { mode: 'web', label: 'Web' };
}

export function isLaptop(): boolean {
  return platform().mode === 'laptop';
}
```

`kiosk/src/lib/identity.ts` — add `import { laptopIdentity } from './config';`, a module variable and the early return:

```ts
/** A rename made through the edge this page load (config.js is fetched
 *  once, so it would otherwise show the old name until a reload). */
let laptopName: string | null = null;

export function setLaptopName(name: string): void {
  laptopName = name;
}
```
and as the first lines of `getIdentity()`:
```ts
  // Laptop edition: the edge owns the identity (identity.json), so a
  // different browser or cleared site data can't make this a new kiosk.
  const laptop = laptopIdentity();
  if (laptop) return { serial: laptop.serial, name: laptopName ?? laptop.name, persistent: true };
```
Add a sentence to the file's header comment: "In the laptop edition the edge supplies the identity instead (see `laptopIdentity`)."

`kiosk/src/lib/api.ts`:

In `errorFrom`, before `return new ApiError(resp.status, code, detail);`:
```ts
  // The laptop edge answers 503 edge_offline when the cloud is unreachable;
  // to every screen that is the same as the network being down.
  if (code === 'edge_offline') return new ApiError(0, 'network', detail);
```

Append a section at the end:

```ts
// ── laptop edge (kiosk_laptop/) ─────────────────────────────────────

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'rejected' | 'failed' | 'needs_sign_in';

export interface EdgeStatus {
  cloud: { online: boolean; last_contact: string | null };
  sync: { initiative_id: string | null; synced_at: string | null; last_error: string | null };
  outbox: Record<OutboxStatus, number>;
  waiting: { person_name: string; count: number }[];
  session: { offline: boolean } | null;
  identity: { serial: string; name: string };
}

/** Polled by the footer and the Login page, signed in or not — so it sends
 *  the token if there is one but never triggers a refresh. */
export async function getEdgeStatus(): Promise<EdgeStatus> {
  const resp = await request(`${apiUrl()}/edge/status`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  return jsonFrom<EdgeStatus>(resp);
}

export async function edgeSyncNow(): Promise<EdgeStatus> {
  return jsonFrom<EdgeStatus>(await apiFetch('/edge/sync', { method: 'POST' }));
}

export async function edgeRetryFailed(): Promise<{ requeued: number }> {
  return jsonFrom<{ requeued: number }>(await apiFetch('/edge/outbox/retry', { method: 'POST' }));
}

/** 409 `outbox_not_empty` (detail.pending) until confirm is 'WIPE'. */
export async function edgeWipe(confirm?: string): Promise<{ cleared_move_data: boolean }> {
  const resp = await apiFetch('/edge/wipe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(confirm ? { confirm } : {}),
  });
  return jsonFrom<{ cleared_move_data: boolean }>(resp);
}

export async function renameLaptopKiosk(name: string): Promise<{ serial: string; name: string }> {
  const resp = await apiFetch('/edge/identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return jsonFrom<{ serial: string; name: string }>(resp);
}
```

`kiosk/src/lib/edgeStatus.ts`:

```ts
/** The laptop edge's status (cloud reachability, sync, upload queue),
 *  polled while mounted. Outside laptop mode it never fetches and stays
 *  null, so callers can render it unconditionally. A failed poll keeps the
 *  last answer — the edge is on localhost, so a failure is transient. */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getEdgeStatus, type EdgeStatus } from './api';
import { isLaptop } from './platform';

export const EDGE_POLL_MS = 15_000;

export function useEdgeStatus(): { status: EdgeStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<EdgeStatus | null>(null);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    if (!isLaptop()) return;
    try {
      const next = await getEdgeStatus();
      if (live.current) setStatus(next);
    } catch {
      /* keep the last answer */
    }
  }, []);

  useEffect(() => {
    live.current = true;
    if (!isLaptop()) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh(), EDGE_POLL_MS);
    return () => { live.current = false; clearInterval(timer); };
  }, [refresh]);

  return { status, refresh };
}
```

- [ ] **Step 5: Run tests to verify they pass, then the whole kiosk suite and the type check**

Run: `npm --prefix kiosk test -- src/lib/platform.test.ts src/lib/identity.test.ts src/lib/api.test.ts src/lib/edgeStatus.test.ts`
Expected: PASS.
Run: `npm --prefix kiosk test && npx --prefix kiosk tsc -b kiosk`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add kiosk/src/lib
git commit -m "feat(kiosk): laptop mode from the edge config, edge-owned identity, edge status/API helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Kiosk UI — Edge settings tab, footer cloud indicator, Login and rename in laptop mode

**Files:**
- Modify: `kiosk/src/lib/settingsTabs.ts` (+ `settingsTabs.test.ts`), `kiosk/src/pages/Settings.tsx`, `kiosk/src/layout/KioskShell.tsx` (+ test), `kiosk/src/pages/Login.tsx` (+ test), `kiosk/src/components/ThisKioskPanel.tsx` (+ test)
- Create: `kiosk/src/components/EdgePanel.tsx`, `kiosk/src/components/EdgePanel.test.tsx`

**Interfaces:**
- Consumes: Task 10's `isLaptop`, `useEdgeStatus`, `edgeSyncNow`, `edgeRetryFailed`, `edgeWipe`, `renameLaptopKiosk`, `setLaptopName`, `ApiError`; existing `useKioskAuth()` (`isAdmin`, `status`, `logout`, `heartbeatNow`), `clearDb` + `resetSyncStatus` from `../lib/localDb` / `../lib/sync` (read `Settings.tsx` for the exact import names it already uses for "Clear local data").
- Produces: `SettingsTab.laptopOnly?: boolean`; `visibleTabs(tabs, { isAdmin, isDeveloper, signedIn, laptop? })`; settings tab id `'edge'`; default export `EdgePanel`.

- [ ] **Step 1: Write the failing tests**

Append to `kiosk/src/lib/settingsTabs.test.ts`:

```ts
describe('edge tab', () => {
  it('appears only in laptop mode', () => {
    const base = { isAdmin: false, isDeveloper: false, signedIn: true };
    expect(visibleTabs(SETTINGS_TABS, base).map((t) => t.id)).not.toContain('edge');
    expect(visibleTabs(SETTINGS_TABS, { ...base, laptop: true }).map((t) => t.id)).toContain('edge');
  });
});
```

`kiosk/src/components/EdgePanel.test.tsx` — mock the hook and API module, render, and assert. Follow the mocking style of an existing component test such as `kiosk/src/components/ThisKioskPanel.test.tsx` (read it first: it shows how `useKioskAuth` is mocked). Cases:

```tsx
// @vitest-environment jsdom
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** EdgePanel navigates to /login after a wipe, so it needs a router. */
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const status = {
  cloud: { online: false, last_contact: '2026-10-01T12:00:00+00:00' },
  sync: { initiative_id: 'm-1', synced_at: '2026-10-01T11:00:00+00:00', last_error: null },
  outbox: { queued: 3, sending: 0, sent: 10, rejected: 1, failed: 2, needs_sign_in: 3 },
  waiting: [{ person_name: 'Jane Doe', count: 3 }],
  session: { offline: true }, identity: { serial: 's', name: 'n' },
};
const refresh = vi.fn(async () => {});
vi.mock('../lib/edgeStatus', () => ({ useEdgeStatus: () => ({ status, refresh }) }));
const api = vi.hoisted(() => ({
  edgeSyncNow: vi.fn(), edgeRetryFailed: vi.fn(), edgeWipe: vi.fn(),
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<object>()), ...api }));
const auth = vi.hoisted(() => ({ isAdmin: false, logout: vi.fn(async () => {}) }));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

import EdgePanel from './EdgePanel';

beforeEach(() => { vi.clearAllMocks(); auth.isAdmin = false; });

describe('EdgePanel', () => {
  it('shows cloud, sync and queue state with the waiting list', () => {
    render(<EdgePanel />);
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.getByText(/3 scans waiting for Jane Doe to sign in online/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wipe this laptop' })).toBeNull();
  });

  it('Sync now and Retry failed call the edge then refresh', async () => {
    api.edgeSyncNow.mockResolvedValue(status);
    api.edgeRetryFailed.mockResolvedValue({ requeued: 5 });
    render(<EdgePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it('admin wipe asks for WIPE when uploads are pending', async () => {
    auth.isAdmin = true;
    const { ApiError } = await import('../lib/api');
    api.edgeWipe.mockRejectedValueOnce(new ApiError(409, 'outbox_not_empty', { code: 'outbox_not_empty', pending: 6 }))
      .mockResolvedValueOnce({ cleared_move_data: true });
    render(<EdgePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Wipe this laptop' }));
    await screen.findByText(/6 queued items have not reached the portal/);
    fireEvent.change(screen.getByLabelText('Type WIPE to confirm'), { target: { value: 'WIPE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Wipe anyway' }));
    await waitFor(() => expect(api.edgeWipe).toHaveBeenLastCalledWith('WIPE'));
    await waitFor(() => expect(auth.logout).toHaveBeenCalled());
  });
});
```

(If `Settings.tsx`'s clear-local-data helpers come from different modules than `../lib/localDb` / `../lib/sync`, mock those too so the wipe test doesn't touch IndexedDB.)

KioskShell, Login, ThisKioskPanel tests — add one case each to the existing test files, mocking `../lib/edgeStatus` and setting `window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: {...} }`:
- KioskShell: with `status.cloud.online=false` and `session.offline=true` the footer shows an item labelled `Cloud` with class `is-bad` and an item `Sign-in` / `Offline`; with no edge status (web mode) neither appears.
- Login: in laptop mode with `cloud.online=false`, after clicking "Other ways to sign in", there is no "Link with phone" button but "Move password" is present; with `cloud.online=true` both are present.
- ThisKioskPanel: in laptop mode as a non-admin the name input is read-only and a hint says "Only an admin can rename this laptop."; as an admin, saving calls `renameLaptopKiosk('Dock 9')` (mocked to resolve `{ serial, name: 'Dock 9' }`) and then `heartbeatNow`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix kiosk test -- src/lib/settingsTabs.test.ts src/components/EdgePanel.test.tsx src/layout/KioskShell.test.tsx src/pages/Login.test.tsx src/components/ThisKioskPanel.test.tsx`
Expected: FAIL — no `edge` tab, `EdgePanel` missing, new cases fail.

- [ ] **Step 3: Implement**

`kiosk/src/lib/settingsTabs.ts`: add `'edge'` to `SettingsTabId`; add to `SettingsTab`:
```ts
  /** Only in the laptop edition (the edge's own controls). */
  laptopOnly?: boolean;
```
insert before the `admin` entry:
```ts
  { id: 'edge', label: 'Edge', blurb: 'Cloud connection, local move data, and the upload queue for this laptop.', laptopOnly: true },
```
and change `visibleTabs`:
```ts
export function visibleTabs(
  tabs: SettingsTab[],
  { isAdmin, isDeveloper, signedIn, laptop = false }:
    { isAdmin: boolean; isDeveloper: boolean; signedIn: boolean; laptop?: boolean },
): SettingsTab[] {
  const forMode = tabs.filter((t) => laptop || !t.laptopOnly);
  if (!signedIn) return forMode.filter((t) => t.anon);
  return forMode.filter((t) => {
    if (t.requires === 'admin') return isAdmin;
    if (t.requires === 'developer') return isDeveloper;
    return true;
  });
}
```

`kiosk/src/pages/Settings.tsx`: `import EdgePanel from '../components/EdgePanel';` and `import { isLaptop } from '../lib/platform';`; change the `visibleTabs` call to `visibleTabs(SETTINGS_TABS, { isAdmin, isDeveloper, signedIn, laptop: isLaptop() })`; next to `{active.id === 'this-kiosk' && <ThisKioskPanel />}` add `{active.id === 'edge' && <EdgePanel />}`.

`kiosk/src/components/EdgePanel.tsx`:

```tsx
/** Settings › Edge (laptop edition only): is the cloud reachable, what move
 *  data does this laptop hold, and what is still waiting to upload. Sync
 *  now / Retry failed for anyone signed in; Wipe this laptop for admins,
 *  with a typed WIPE gate when queued work would be lost. */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useKioskAuth } from '../auth/KioskAuthContext';
import { ApiError, edgeRetryFailed, edgeSyncNow, edgeWipe } from '../lib/api';
import { useEdgeStatus } from '../lib/edgeStatus';
import { clearDb } from '../lib/localDb';
import { resetSyncStatus } from '../lib/sync';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

export default function EdgePanel() {
  const { isAdmin, logout } = useKioskAuth();
  const navigate = useNavigate();
  const { status, refresh } = useEdgeStatus();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [wipePending, setWipePending] = useState<number | null>(null);
  const [typed, setTyped] = useState('');

  if (!status) return <p className="page-hint">Checking this laptop's edge service…</p>;

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNote('');
    try {
      await action();
      setNote(done);
    } catch {
      setNote('That did not work. Check the cloud connection and try again.');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const wipe = async (confirm?: string) => {
    setBusy(true);
    try {
      const result = await edgeWipe(confirm);
      if (result.cleared_move_data) await clearDb().then(resetSyncStatus).catch(() => {});
      await logout();
      navigate('/login');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'outbox_not_empty') {
        setWipePending((e.detail as { pending?: number } | undefined)?.pending ?? 0);
      } else {
        setNote('Wipe failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const o = status.outbox;
  return (
    <>
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Cloud</span>
          <p className="page-hint">Last contact {when(status.cloud.last_contact)}</p>
        </div>
        <span className={`chip ${status.cloud.online ? 'c-green' : 'c-red'}`}>
          <span className="dot" />{status.cloud.online ? 'Online' : 'Offline'}
        </span>
      </div>
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Move data</span>
          <p className="page-hint">
            {status.sync.initiative_id
              ? `Synced ${when(status.sync.synced_at)}${status.sync.last_error ? ` · last attempt failed (${status.sync.last_error})` : ''}`
              : 'No move set up yet. Run Kiosk Setup while online.'}
          </p>
        </div>
        <button type="button" className="mini-btn" disabled={busy}
                onClick={() => void run(edgeSyncNow, 'Move data refreshed.')}>
          Sync now
        </button>
      </div>
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Upload queue</span>
          <p className="page-hint">
            {o.queued + o.sending} waiting · {o.sent} sent · {o.failed} failed · {o.rejected} rejected
          </p>
          {status.waiting.map((w) => (
            <p key={w.person_name} className="page-hint">
              {w.count} scans waiting for {w.person_name} to sign in online
            </p>
          ))}
        </div>
        <button type="button" className="mini-btn" disabled={busy}
                onClick={() => void run(edgeRetryFailed, 'Failed uploads queued again.')}>
          Retry failed
        </button>
      </div>
      {note && <p className="form-notice" role="status">{note}</p>}
      {isAdmin && (
        <div className="settings-row">
          <div>
            <span className="settings-row-label">Wipe this laptop</span>
            <p className="page-hint">
              Signs everyone out and removes saved sign-ins, the move password, and move data.
              This laptop's name and serial stay.
            </p>
            {wipePending !== null && (
              <div className="pf-form">
                <p className="form-error" role="alert">
                  {wipePending} queued items have not reached the portal and will be lost.
                </p>
                <label htmlFor="edge-wipe-confirm">Type WIPE to confirm</label>
                <input id="edge-wipe-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} />
                <button type="button" className="btn-solid" disabled={busy || typed !== 'WIPE'}
                        onClick={() => void wipe('WIPE')}>
                  Wipe anyway
                </button>
              </div>
            )}
          </div>
          {wipePending === null && (
            <button type="button" className="mini-btn" disabled={busy} onClick={() => void wipe()}>
              Wipe this laptop
            </button>
          )}
        </div>
      )}
    </>
  );
}
```

(Before writing, open `Settings.tsx` to confirm the import paths of `clearDb` and `resetSyncStatus` and the class names `settings-row` / `settings-row-label` / `chip c-green`; use whatever it already uses. Also check `kiosk/src/styles/` has rules for each class name used here — if one is missing, use the nearest existing class rather than adding CSS.)

`kiosk/src/layout/KioskShell.tsx`: `import { useEdgeStatus } from '../lib/edgeStatus';`; inside the component after `const sync = useSyncStatus();` add `const { status: edge } = useEdgeStatus();`; after the `Data Sync` push:

```tsx
  if (edge) {
    const queued = edge.outbox.queued + edge.outbox.sending + edge.outbox.needs_sign_in;
    footItems.push({
      label: 'Cloud',
      status: edge.cloud.online ? 'good' : 'bad',
      title: `${edge.cloud.online ? 'Online' : 'Offline'}`
        + `${edge.cloud.last_contact ? ` · last contact ${new Date(edge.cloud.last_contact).toLocaleString()}` : ''}`
        + ` · ${queued} queued`,
    });
    if (edge.session?.offline) footItems.push({ label: 'Sign-in', value: 'Offline' });
  }
```

`kiosk/src/pages/Login.tsx`: `import { useEdgeStatus } from '../lib/edgeStatus';`; in the component `const { status: edge } = useEdgeStatus();` and `const canLink = !edge || edge.cloud.online;` (comment: "Linking with a phone needs the cloud; on an offline laptop only the methods the edge can check stay."); wrap the Link-with-phone button: `{canLink && (<button … onClick={() => setView('link')}>…Link with phone</button>)}`.

`kiosk/src/components/ThisKioskPanel.tsx`: import `isLaptop` from `../lib/platform`, `renameLaptopKiosk` and `ApiError` from `../lib/api`, `setLaptopName` from `../lib/identity`; read `isAdmin` from `useKioskAuth()`. Compute `const laptop = isLaptop(); const canRename = !laptop || (status === 'authed' && isAdmin);`. Make `submit` handle laptop mode first:

```tsx
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (laptop) {
      renameLaptopKiosk(name).then(
        (next) => {
          setLaptopName(next.name);
          setIdentity(getIdentity());
          setError('');
          setSaved(true);
          if (status === 'authed') void heartbeatNow();
        },
        (err) => {
          setSaved(false);
          setError(err instanceof ApiError && err.code === 'bad_name'
            ? 'Enter a name between 1 and 80 characters.'
            : 'Only an admin can rename this laptop.');
        },
      );
      return;
    }
    // …existing web-mode body unchanged…
  };
```
Give the name input `readOnly={!canRename}`, render `{laptop && !canRename && <p className="page-hint">Only an admin can rename this laptop.</p>}` under it, and render the Save button only when `canRename`.

- [ ] **Step 4: Run tests to verify they pass, then the full kiosk suite, type check and bundle**

Run: `npm --prefix kiosk test -- src/lib/settingsTabs.test.ts src/components/EdgePanel.test.tsx src/layout/KioskShell.test.tsx src/pages/Login.test.tsx src/components/ThisKioskPanel.test.tsx`
Expected: PASS.
Run: `npm --prefix kiosk test && npm --prefix kiosk run build`
Expected: all pass; `tsc -b` and `vite build` succeed.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src
git commit -m "feat(kiosk): laptop UI — Edge settings tab, footer cloud indicator, offline-aware login, admin-only rename

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Docker image, compose file, README, smoke script

**Files:**
- Create: `kiosk_laptop/Dockerfile`, `kiosk_laptop/docker-compose.yml`, `kiosk_laptop/README.md`, `kiosk_laptop/scripts/smoke.sh`
- Modify: root `.dockerignore` (exclude `kiosk_laptop/edge/.venv`, `**/.pytest_cache`) — read it first and add only what is missing.

**Interfaces:**
- Consumes: the whole edge package and the kiosk bundle (`npm --prefix kiosk run build:bundle` → `kiosk/dist`).
- Produces: image `serversherpa-kiosk-laptop`, compose service `edge`, `kiosk_laptop/scripts/smoke.sh` (exit 0 = image works).

- [ ] **Step 1: Write the smoke script (the test for this task)**

`kiosk_laptop/scripts/smoke.sh`:

```bash
#!/bin/sh
# Builds the laptop image and checks it against an unreachable cloud:
# the app is served, config.js says laptop, the identity is fixed across a
# restart, and offline sign-in with no cached verifier is a clean 401.
set -eu
cd "$(dirname "$0")/../.."
IMAGE=serversherpa-kiosk-laptop:smoke
DATA=$(mktemp -d)
NAME=kiosk-laptop-smoke
docker build -q -f kiosk_laptop/Dockerfile -t "$IMAGE" . >/dev/null
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT
start() {
  docker run -d --name "$NAME" -p 127.0.0.1:18090:8090 -v "$DATA:/data" \
    -e EDGE_CLOUD_API_URL=http://127.0.0.1:9 "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do curl -fs http://127.0.0.1:18090/edge/identity >/dev/null && return; sleep 1; done
  echo "edge did not start"; docker logs "$NAME"; exit 1
}
start
curl -fs http://127.0.0.1:18090/ | grep -q '<div id="root">' || { echo "index not served"; exit 1; }
curl -fs http://127.0.0.1:18090/config.js | grep -q '"mode": "laptop"' || { echo "config.js wrong"; exit 1; }
SERIAL=$(curl -fs http://127.0.0.1:18090/edge/identity | sed 's/.*"serial":"\([^"]*\)".*/\1/')
case "$SERIAL" in kiosk-laptop-*) ;; *) echo "bad serial $SERIAL"; exit 1;; esac
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"email":"a@b.c","password":"x"}' http://127.0.0.1:18090/auth/login)
[ "$CODE" = 401 ] || { echo "offline login answered $CODE"; exit 1; }
docker rm -f "$NAME" >/dev/null
start
AGAIN=$(curl -fs http://127.0.0.1:18090/edge/identity | sed 's/.*"serial":"\([^"]*\)".*/\1/')
[ "$AGAIN" = "$SERIAL" ] || { echo "serial changed across restart"; exit 1; }
echo "smoke OK ($SERIAL)"
```

Run: `chmod +x kiosk_laptop/scripts/smoke.sh && kiosk_laptop/scripts/smoke.sh`
Expected: FAIL — `kiosk_laptop/Dockerfile` not found.

- [ ] **Step 2: Write the Dockerfile and compose file**

`kiosk_laptop/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# ServerSherpa kiosk — laptop edition. One process: the edge API (FastAPI +
# SQLite) serving the kiosk bundle and standing between it and the cloud.
# Build context is the REPO ROOT (the kiosk imports portal/src via @portal;
# see kiosk/Dockerfile for why the bundle is built with `vite build` only).
#
#   docker build -f kiosk_laptop/Dockerfile -t serversherpa-kiosk-laptop .
#   docker compose -f kiosk_laptop/docker-compose.yml up -d

FROM node:20-alpine AS web
ARG KIOSK_VERSION=0.0.0
WORKDIR /app
COPY kiosk/package.json kiosk/package-lock.json ./kiosk/
RUN npm ci --prefix kiosk --ignore-scripts
COPY portal/src ./portal/src
COPY kiosk ./kiosk
ENV VITE_KIOSK_VERSION=$KIOSK_VERSION
RUN npm --prefix kiosk run build:bundle

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    EDGE_DATA_DIR=/data EDGE_WEB_DIR=/app/web
WORKDIR /app
COPY kiosk_laptop/edge/pyproject.toml ./edge/pyproject.toml
COPY kiosk_laptop/edge/src ./edge/src
RUN pip install --no-cache-dir ./edge
COPY --from=web /app/kiosk/dist /app/web
EXPOSE 8090
CMD ["uvicorn", "edge.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8090"]
```

`kiosk_laptop/docker-compose.yml`:

```yaml
# ServerSherpa kiosk — laptop edition.
#   EDGE_CLOUD_API_URL=https://api.serversherpa.com docker compose -f kiosk_laptop/docker-compose.yml up -d
# /data is a folder on this laptop (not a Docker volume) so `down -v`, a
# Docker Desktop reset or a reinstall can't delete the kiosk's identity,
# its key, or scans still waiting to upload. Back that folder up.
name: serversherpa-kiosk-laptop
services:
  edge:
    image: serversherpa-kiosk-laptop:latest
    build:
      context: ..
      dockerfile: kiosk_laptop/Dockerfile
    restart: unless-stopped
    ports:
      - "${EDGE_BIND:-127.0.0.1}:8090:8090"
    environment:
      EDGE_CLOUD_API_URL: ${EDGE_CLOUD_API_URL:?set EDGE_CLOUD_API_URL to the ServerSherpa API}
      EDGE_PORTAL_URL: ${EDGE_PORTAL_URL:-}
    volumes:
      - "${EDGE_DATA_HOST_DIR:-~/ServerSherpaKiosk}:/data"
```

Check root `.dockerignore`; ensure it excludes `**/node_modules`, `**/.venv`, `**/__pycache__`, `**/.pytest_cache` (add the missing lines).

- [ ] **Step 3: Run the smoke script**

Run: `kiosk_laptop/scripts/smoke.sh` (foreground, 600000 ms timeout — the first build downloads base images)
Expected: `smoke OK (kiosk-laptop-…)`.

Also verify compose expands the `~` default on this Mac:
```bash
EDGE_CLOUD_API_URL=http://127.0.0.1:9 docker compose -f kiosk_laptop/docker-compose.yml config | grep -A2 volumes
```
Expected: the source path is `/Users/<you>/ServerSherpaKiosk`. If it prints a literal `~`, change the default to `${HOME}/ServerSherpaKiosk` and note in the README that Windows users set `EDGE_DATA_HOST_DIR`.

- [ ] **Step 4: Write the README**

`kiosk_laptop/README.md` — sections, each a few lines: **What it is** (laptop edition: label printing via WebUSB now, FX9600 RFID next; works offline after one online sign-in + Kiosk Setup); **Requirements** (Docker Desktop; Chrome or Edge for WebUSB printing); **Install** (clone or copy the repo, set `EDGE_CLOUD_API_URL`, `docker compose -f kiosk_laptop/docker-compose.yml up -d`, open `http://localhost:8090`); **First run** (sign in online → the laptop registers → Kiosk Setup → move data downloads → from then on it works offline); **Offline** (who can sign in offline: anyone who signed in online on this laptop in the last 14 days, and the set-up move's password; what works offline: scanning, label printer tools; what needs the cloud: RFID enroll, packing containers, loading trucks, clock in/out, Kiosk Setup, link with phone); **Data and backups** (`~/ServerSherpaKiosk` holds `identity.json` — the kiosk's permanent serial and name, `edge.key`, `edge.db`; back it up; deleting it makes a brand-new kiosk); **Updating** (`git pull && docker compose … up -d --build` keeps the data folder); **Troubleshooting** (logs `docker compose … logs -f edge`; "edge.key is unreadable" → `docker compose … run --rm edge python -m edge reset-key`; LAN/VPN later via `EDGE_BIND`).

- [ ] **Step 5: Commit**

```bash
git add kiosk_laptop/Dockerfile kiosk_laptop/docker-compose.yml kiosk_laptop/README.md kiosk_laptop/scripts/smoke.sh .dockerignore
git commit -m "feat(kiosk-laptop): Docker image, compose file with a host data folder, README, smoke script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Live verification against the dev API, spec notes (controller)

This task is run by the controlling session, not an implementer subagent.

- [ ] **Step 1:** Ensure the dev API is running (port 8000) with this branch's API changes (Task 9) — start it from this worktree with `PYTHONPATH=<worktree>/api/src` per the dev-workflow memory, detached with `nohup … & disown`, logs in `.devlogs/`.
- [ ] **Step 2:** `EDGE_CLOUD_API_URL=http://host.docker.internal:8000 EDGE_DATA_HOST_DIR=$PWD/.devlogs/kiosk-laptop-data docker compose -f kiosk_laptop/docker-compose.yml up -d --build`, then open `http://localhost:8090` in the browser pane.
- [ ] **Step 3 (online):** sign in with a dev account that has `kiosk:view`; confirm the portal's Kiosk Devices list shows one `Laptop` kiosk with the serial from `/edge/identity`; run Kiosk Setup on a move that has a kiosk password; confirm the footer shows Data Sync good and Cloud good; scan a known asset barcode on Scanning; confirm the scan reaches the portal; open Label Printing › Printers (vocab loads).
- [ ] **Step 4 (offline):** stop the dev API. Within 30 s the footer Cloud turns bad. Sign out; sign in again with the same email/password (offline sign-in → footer "Sign-in Offline"); scan two assets (the Edge tab shows 2 waiting); try RFID Enroll (expect the normal "can't reach the server" message); sign out and sign in with the move password offline.
- [ ] **Step 5 (reconnect):** start the dev API again; within a probe interval the outbox drains (Edge tab: 0 waiting) — but the offline-signed-in person's rows show "waiting for … to sign in online" if their cloud session ended; sign in online and watch them drain; confirm the scans in the portal are attributed to that person.
- [ ] **Step 6 (identity):** `docker compose … up -d --build --force-recreate`; the serial and name are unchanged and the portal still shows one kiosk row.
- [ ] **Step 7:** Append an "Implementation notes" section to the spec recording anything that diverged during the build, commit it, and stop the compose stack.
```

