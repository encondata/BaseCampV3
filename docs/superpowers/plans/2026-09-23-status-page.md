# ServerSherpa Status Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone public status page (own Docker image) that probes the V3 API, Portal, and Kiosk every minute and shows green/red plus 90-day uptime in the portal's look.

**Architecture:** One Python 3.13 process (FastAPI + uvicorn) runs an asyncio checker loop that probes the three services with httpx, records every check in SQLite (raw + daily rollup), applies a 2-strike rule for the displayed state, and serves `GET /api/summary` plus a static Vite/React page. The page imports the portal's CSS from `portal/src/styles` (build context = repo root, like `kiosk/Dockerfile`).

**Tech Stack:** Python 3.13, FastAPI, uvicorn, httpx, sqlite3 (stdlib), pytest + pytest-asyncio + respx; Vite 5, React 18, TypeScript 5.6, vitest 3 + jsdom + @testing-library/react; Docker multi-stage (node:20-alpine → python:3.13-slim).

**Spec:** `docs/superpowers/specs/2026-09-23-status-page-design.md`

## Global Constraints

- Everything lives under `status/` except nothing — do NOT modify `api/`, `portal/`, or `kiosk/` (the page only *imports* portal CSS and copies two images).
- Worktree: `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/status-page`, branch `status-page`. All paths below are relative to it.
- Probes: API `GET {url}/system/status` (200 + JSON object), Portal `GET {url}/` (200 + body contains `id="root"`), Kiosk `GET {url}/config.js` (200). Redirects followed.
- Env: `STATUS_API_URL`, `STATUS_PORTAL_URL`, `STATUS_KIOSK_URL` (required); `STATUS_INTERVAL_SECONDS`=60 (min 10), `STATUS_TIMEOUT_SECONDS`=10, `STATUS_FAILURE_THRESHOLD`=2, `STATUS_DB_PATH`=`/data/status.db`, `STATUS_STATIC_DIR` (default: package `static/` dir).
- Displayed state: `up` on first success; `down` only after `failure_threshold` consecutive failures; `unknown` before any check.
- Retention: raw checks 7 days, daily rollup 90 days (window = today + 89 previous UTC days). Prune hourly.
- `/api/summary` must never contain service URLs or probe `detail`. `Cache-Control: no-store`.
- Security headers on every response: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`.
- No login, no write endpoints; only GET/HEAD.
- Light theme only (portal is light-only). American English in all copy/comments.
- Uptime display: exactly 100 → `100%`; otherwise two decimals truncated (never rounded up), e.g. `99.99%`; null → `—`.
- Subagents: run every test suite in the FOREGROUND with a long timeout (600000 ms). Never background a suite and end your turn waiting.
- Commit message trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## File Structure

```
status/
  .gitignore                     .venv/, web/node_modules/, web/dist/, *.db
  pyproject.toml                 package serversherpa-status (+ dev extras)
  README.md                      what it is, env vars, run/build/deploy
  .env.example
  Dockerfile                     build context = repo root
  docker-compose.yml
  src/serversherpa_status/
    __init__.py
    __main__.py                  `python -m serversherpa_status` → config check + uvicorn
    config.py                    Service, Settings, ConfigError, load_settings()
    probes.py                    ProbeResult, PROBE_PATHS, probe()
    state.py                     Snapshot, StateTracker
    store.py                     CheckRow, DayBar, Store, uptime_percent()
    checker.py                   Checker (run_cycle / run_forever)
    summary.py                   build_summary()
    app.py                       create_app()
    static/.gitkeep              dev fallback static dir (Docker copies the built page here)
  tests/
    conftest.py                  shared Service fixtures
    test_config.py
    test_probes.py
    test_state.py
    test_store.py
    test_checker.py
    test_summary.py
    test_app.py
  web/
    package.json, tsconfig.json, vite.config.ts, index.html
    public/serversherpa-logo.png, public/favicon.ico   (copied from portal/public)
    src/main.tsx, src/App.tsx, src/App.test.tsx
    src/lib/summary.ts, src/lib/summary.test.ts
    src/components/StatusBanner.tsx, ServiceCard.tsx, UptimeStrip.tsx, components.test.tsx
    src/styles/status.css
    src/vite-env.d.ts
```

---

### Task 1: Python package scaffold, config, probes

**Files:**
- Create: `status/.gitignore`, `status/pyproject.toml`, `status/src/serversherpa_status/__init__.py`, `status/src/serversherpa_status/config.py`, `status/src/serversherpa_status/probes.py`, `status/tests/conftest.py`, `status/tests/test_config.py`, `status/tests/test_probes.py`

**Interfaces:**
- Produces:
  - `config.Service(key: str, name: str, url: str)` frozen dataclass; `url` has no trailing slash.
  - `config.Settings(services: tuple[Service, ...], interval_seconds: float, timeout_seconds: float, failure_threshold: int, db_path: str, static_dir: str)` frozen dataclass. Service order is always api, portal, kiosk.
  - `config.ConfigError(Exception)`; `config.load_settings(env: Mapping[str, str] | None = None) -> Settings` (None → `os.environ`).
  - `probes.ProbeResult(ok: bool, latency_ms: int | None, detail: str)` frozen dataclass (`detail == ""` on success).
  - `probes.PROBE_PATHS: dict[str, str]`; `async probes.probe(client: httpx.AsyncClient, service: Service, timeout: float) -> ProbeResult`.

- [ ] **Step 1: Scaffold the package**

`status/.gitignore`:
```
.venv/
web/node_modules/
web/dist/
*.db
*.db-wal
*.db-shm
```

`status/pyproject.toml`:
```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "serversherpa-status"
version = "0.1.0"
description = "ServerSherpa public status page — uptime checker + read-only page"
requires-python = ">=3.13"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "httpx>=0.27",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24",
    "respx>=0.21",
]

[tool.setuptools.packages.find]
where = ["src"]

[tool.setuptools.package-data]
"serversherpa_status" = ["static/*", "static/**/*"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

`status/src/serversherpa_status/__init__.py`:
```python
"""ServerSherpa public status page: uptime checker + read-only page."""
```

Create the venv and install:
```bash
python3.13 -m venv status/.venv
status/.venv/bin/pip install -q -e 'status[dev]'
```

- [ ] **Step 2: Write failing config + probe tests**

`status/tests/conftest.py`:
```python
import pytest

from serversherpa_status.config import Service


@pytest.fixture
def api_service() -> Service:
    return Service("api", "API", "http://api.test")


@pytest.fixture
def portal_service() -> Service:
    return Service("portal", "Portal", "http://portal.test")


@pytest.fixture
def kiosk_service() -> Service:
    return Service("kiosk", "Kiosk", "http://kiosk.test")
```

`status/tests/test_config.py`:
```python
import pytest

from serversherpa_status.config import ConfigError, load_settings

BASE = {
    "STATUS_API_URL": "https://api.example.com/",
    "STATUS_PORTAL_URL": "https://portal.example.com",
    "STATUS_KIOSK_URL": "https://kiosk.example.com//",
}


def test_defaults_and_trailing_slashes_stripped():
    s = load_settings(BASE)
    assert [(x.key, x.name, x.url) for x in s.services] == [
        ("api", "API", "https://api.example.com"),
        ("portal", "Portal", "https://portal.example.com"),
        ("kiosk", "Kiosk", "https://kiosk.example.com"),
    ]
    assert s.interval_seconds == 60
    assert s.timeout_seconds == 10
    assert s.failure_threshold == 2
    assert s.db_path == "/data/status.db"
    assert s.static_dir.endswith("static")


@pytest.mark.parametrize("missing", list(BASE))
def test_missing_url_names_the_variable(missing):
    env = {k: v for k, v in BASE.items() if k != missing}
    with pytest.raises(ConfigError, match=missing):
        load_settings(env)


def test_blank_url_is_missing():
    with pytest.raises(ConfigError, match="STATUS_API_URL"):
        load_settings({**BASE, "STATUS_API_URL": "  "})


def test_url_must_be_http():
    with pytest.raises(ConfigError, match="STATUS_PORTAL_URL"):
        load_settings({**BASE, "STATUS_PORTAL_URL": "portal.example.com"})


def test_overrides():
    s = load_settings({
        **BASE,
        "STATUS_INTERVAL_SECONDS": "15",
        "STATUS_TIMEOUT_SECONDS": "3.5",
        "STATUS_FAILURE_THRESHOLD": "3",
        "STATUS_DB_PATH": "/tmp/x.db",
        "STATUS_STATIC_DIR": "/srv/page",
    })
    assert (s.interval_seconds, s.timeout_seconds, s.failure_threshold) == (15, 3.5, 3)
    assert (s.db_path, s.static_dir) == ("/tmp/x.db", "/srv/page")


@pytest.mark.parametrize("var,value", [
    ("STATUS_INTERVAL_SECONDS", "5"),
    ("STATUS_INTERVAL_SECONDS", "soon"),
    ("STATUS_TIMEOUT_SECONDS", "0"),
    ("STATUS_FAILURE_THRESHOLD", "0"),
    ("STATUS_FAILURE_THRESHOLD", "1.5"),
])
def test_bad_numbers_rejected(var, value):
    with pytest.raises(ConfigError, match=var):
        load_settings({**BASE, var: value})
```

`status/tests/test_probes.py`:
```python
import httpx
import pytest
import respx

from serversherpa_status.probes import probe


async def run(service):
    async with httpx.AsyncClient() as client:
        return await probe(client, service, 5)


@respx.mock
async def test_api_green_on_json_object(api_service):
    respx.get("http://api.test/system/status").respond(200, json={"read_only": False})
    r = await run(api_service)
    assert r.ok and r.detail == "" and isinstance(r.latency_ms, int)


@respx.mock
async def test_api_red_on_non_object_json(api_service):
    respx.get("http://api.test/system/status").respond(200, json=[1, 2])
    r = await run(api_service)
    assert not r.ok and r.detail == "unexpected response body"


@respx.mock
async def test_api_red_on_html(api_service):
    respx.get("http://api.test/system/status").respond(200, text="<html>proxy error</html>")
    r = await run(api_service)
    assert not r.ok and r.detail == "unexpected response body"


@respx.mock
async def test_api_red_on_500(api_service):
    respx.get("http://api.test/system/status").respond(500, json={"detail": "db down"})
    r = await run(api_service)
    assert not r.ok and r.detail == "HTTP 500" and isinstance(r.latency_ms, int)


@respx.mock
async def test_portal_green_when_spa_root_present(portal_service):
    respx.get("http://portal.test/").respond(200, text='<div id="root"></div>')
    assert (await run(portal_service)).ok


@respx.mock
async def test_portal_red_without_spa_root(portal_service):
    respx.get("http://portal.test/").respond(200, text="Welcome to nginx!")
    r = await run(portal_service)
    assert not r.ok and r.detail == "unexpected response body"


@respx.mock
async def test_kiosk_green_on_200(kiosk_service):
    respx.get("http://kiosk.test/config.js").respond(200, text="window.__KIOSK_CONFIG__ = {};")
    assert (await run(kiosk_service)).ok


@respx.mock
async def test_redirect_is_followed(kiosk_service):
    respx.get("http://kiosk.test/config.js").respond(301, headers={"Location": "http://kiosk.test/c.js"})
    respx.get("http://kiosk.test/c.js").respond(200, text="ok")
    assert (await run(kiosk_service)).ok


@respx.mock
async def test_timeout(kiosk_service):
    respx.get("http://kiosk.test/config.js").mock(side_effect=httpx.ConnectTimeout("slow"))
    r = await run(kiosk_service)
    assert r == type(r)(False, None, "timeout")


@respx.mock
async def test_connection_error(kiosk_service):
    respx.get("http://kiosk.test/config.js").mock(side_effect=httpx.ConnectError("refused"))
    r = await run(kiosk_service)
    assert not r.ok and r.latency_ms is None and r.detail == "connection error: ConnectError"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd status && .venv/bin/pytest -q`
Expected: collection errors — `ModuleNotFoundError: No module named 'serversherpa_status.config'`.

- [ ] **Step 4: Implement config.py and probes.py**

`status/src/serversherpa_status/config.py`:
```python
"""Environment → Settings. Fails loudly: a status page pointed at nothing
would render a permanent 'Checking…', which is worse than not starting."""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_STATIC_DIR = str(Path(__file__).parent / "static")

# (key, display name, env var) — order is the display order on the page.
SERVICES = (
    ("api", "API", "STATUS_API_URL"),
    ("portal", "Portal", "STATUS_PORTAL_URL"),
    ("kiosk", "Kiosk", "STATUS_KIOSK_URL"),
)


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Service:
    key: str
    name: str
    url: str


@dataclass(frozen=True)
class Settings:
    services: tuple[Service, ...]
    interval_seconds: float
    timeout_seconds: float
    failure_threshold: int
    db_path: str
    static_dir: str


def _number(env: Mapping[str, str], var: str, default: float, minimum: float) -> float:
    raw = env.get(var, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{var} must be a number (got {raw!r})") from None
    if value < minimum:
        raise ConfigError(f"{var} must be at least {minimum:g} (got {raw!r})")
    return value


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    services = []
    for key, name, var in SERVICES:
        url = env.get(var, "").strip().rstrip("/")
        if not url:
            raise ConfigError(f"{var} is required (e.g. https://{key}.serversherpa.com)")
        if not url.startswith(("http://", "https://")):
            raise ConfigError(f"{var} must start with http:// or https:// (got {url!r})")
        services.append(Service(key, name, url))

    threshold_raw = env.get("STATUS_FAILURE_THRESHOLD", "").strip() or "2"
    try:
        threshold = int(threshold_raw)
    except ValueError:
        raise ConfigError(
            f"STATUS_FAILURE_THRESHOLD must be a whole number (got {threshold_raw!r})"
        ) from None
    if threshold < 1:
        raise ConfigError(f"STATUS_FAILURE_THRESHOLD must be at least 1 (got {threshold_raw!r})")

    return Settings(
        services=tuple(services),
        interval_seconds=_number(env, "STATUS_INTERVAL_SECONDS", 60, 10),
        timeout_seconds=_number(env, "STATUS_TIMEOUT_SECONDS", 10, 0.1),
        failure_threshold=threshold,
        db_path=env.get("STATUS_DB_PATH", "").strip() or "/data/status.db",
        static_dir=env.get("STATUS_STATIC_DIR", "").strip() or DEFAULT_STATIC_DIR,
    )
```

`status/src/serversherpa_status/probes.py`:
```python
"""One HTTP probe per service. A probe never raises: every outcome is a
ProbeResult, and anything short of the expected response is a failure."""

import time
from dataclasses import dataclass

import httpx

from serversherpa_status.config import Service

# The API probe reads the database (/system/status), so a dead DB reads red;
# /healthz would only prove the process is alive. The kiosk's config.js is
# written by its entrypoint, so a 200 proves Caddy AND the runtime config.
PROBE_PATHS = {"api": "/system/status", "portal": "/", "kiosk": "/config.js"}

DETAIL_MAX = 200


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    latency_ms: int | None
    detail: str


def _body_problem(key: str, resp: httpx.Response) -> bool:
    if key == "api":
        try:
            return not isinstance(resp.json(), dict)
        except ValueError:
            return True
    if key == "portal":
        return 'id="root"' not in resp.text
    return False


async def probe(client: httpx.AsyncClient, service: Service, timeout: float) -> ProbeResult:
    url = service.url + PROBE_PATHS[service.key]
    started = time.monotonic()
    try:
        resp = await client.get(url, timeout=timeout, follow_redirects=True)
    except httpx.TimeoutException:
        return ProbeResult(False, None, "timeout")
    except httpx.HTTPError as exc:
        return ProbeResult(False, None, f"connection error: {type(exc).__name__}"[:DETAIL_MAX])
    latency = int(round((time.monotonic() - started) * 1000))
    if resp.status_code != 200:
        return ProbeResult(False, latency, f"HTTP {resp.status_code}")
    if _body_problem(service.key, resp):
        return ProbeResult(False, latency, "unexpected response body")
    return ProbeResult(True, latency, "")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd status && .venv/bin/pytest -q`
Expected: all pass (config ~14 cases, probes 10).

- [ ] **Step 6: Commit**

```bash
git add status/.gitignore status/pyproject.toml status/src status/tests
git commit -m "feat(status): package scaffold, env config, service probes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: State tracker (2-strike rule) and SQLite store

**Files:**
- Create: `status/src/serversherpa_status/state.py`, `status/src/serversherpa_status/store.py`, `status/tests/test_state.py`, `status/tests/test_store.py`

**Interfaces:**
- Consumes: nothing from Task 1 beyond the package.
- Produces:
  - `state.Snapshot(state: str, last_checked_at: datetime | None, latency_ms: int | None)` frozen dataclass; `state` ∈ `"up" | "down" | "unknown"`.
  - `state.StateTracker(keys: Iterable[str], threshold: int)` with `.record(key: str, ok: bool, latency_ms: int | None, at: datetime) -> None` and `.snapshot(key: str) -> Snapshot`.
  - `store.CheckRow(at: datetime, ok: bool, latency_ms: int | None)` frozen dataclass.
  - `store.DayBar(day: str, ok: int | None, total: int | None)` frozen dataclass (`day` = `YYYY-MM-DD`).
  - `store.Store(path: str)` with `.record(service: str, at: datetime, ok: bool, latency_ms: int | None, detail: str) -> None`, `.recent(service: str, limit: int) -> list[CheckRow]` (oldest first), `.prune(now: datetime) -> None`, `.daily(service: str, today: date, days: int = 90) -> list[DayBar]` (oldest first, exactly `days` entries ending at `today`), `.close() -> None`.
  - `store.uptime_percent(bars: Iterable[DayBar]) -> float | None` — Σok/Σtotal×100 rounded to 4 decimals; None if no data.
  - Constants `store.RAW_RETENTION = timedelta(days=7)`, `store.WINDOW_DAYS = 90`.
  - All datetimes are timezone-aware UTC; `Store` converts any aware datetime with `.astimezone(UTC)` and raises `ValueError` on naive ones.

- [ ] **Step 1: Write failing tests**

`status/tests/test_state.py`:
```python
from datetime import UTC, datetime, timedelta

from serversherpa_status.state import StateTracker

T0 = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


def at(n):
    return T0 + timedelta(minutes=n)


def test_unknown_before_any_check():
    s = StateTracker(["api"], 2).snapshot("api")
    assert (s.state, s.last_checked_at, s.latency_ms) == ("unknown", None, None)


def test_first_success_is_up():
    t = StateTracker(["api"], 2)
    t.record("api", True, 40, at(0))
    assert t.snapshot("api").state == "up"
    assert t.snapshot("api").latency_ms == 40
    assert t.snapshot("api").last_checked_at == at(0)


def test_one_failure_keeps_up_two_flip_down():
    t = StateTracker(["api"], 2)
    t.record("api", True, 40, at(0))
    t.record("api", False, None, at(1))
    assert t.snapshot("api").state == "up"
    t.record("api", False, None, at(2))
    assert t.snapshot("api").state == "down"
    assert t.snapshot("api").last_checked_at == at(2)


def test_single_success_recovers():
    t = StateTracker(["api"], 2)
    for n in range(3):
        t.record("api", False, None, at(n))
    t.record("api", True, 55, at(3))
    assert t.snapshot("api").state == "up"


def test_failure_streak_resets_after_success():
    t = StateTracker(["api"], 2)
    t.record("api", False, None, at(0))
    t.record("api", True, 10, at(1))
    t.record("api", False, None, at(2))
    assert t.snapshot("api").state == "up"


def test_first_failure_from_unknown_stays_unknown():
    t = StateTracker(["api"], 2)
    t.record("api", False, None, at(0))
    assert t.snapshot("api").state == "unknown"
    t.record("api", False, None, at(1))
    assert t.snapshot("api").state == "down"


def test_threshold_one_flips_immediately():
    t = StateTracker(["api"], 1)
    t.record("api", False, None, at(0))
    assert t.snapshot("api").state == "down"


def test_services_are_independent():
    t = StateTracker(["api", "kiosk"], 2)
    t.record("api", True, 1, at(0))
    assert t.snapshot("kiosk").state == "unknown"
```

`status/tests/test_store.py`:
```python
from datetime import UTC, date, datetime, timedelta

import pytest

from serversherpa_status.store import DayBar, Store, uptime_percent

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "nested" / "status.db"))
    yield s
    s.close()


def test_creates_parent_dir_and_records(store, tmp_path):
    store.record("api", NOW, True, 42, "")
    assert (tmp_path / "nested" / "status.db").exists()
    rows = store.recent("api", 5)
    assert len(rows) == 1
    assert (rows[0].at, rows[0].ok, rows[0].latency_ms) == (NOW, True, 42)


def test_recent_is_oldest_first_and_limited(store):
    for n in range(5):
        store.record("api", NOW + timedelta(minutes=n), n % 2 == 0, n, "")
    rows = store.recent("api", 2)
    assert [r.at for r in rows] == [NOW + timedelta(minutes=3), NOW + timedelta(minutes=4)]
    assert [r.ok for r in rows] == [False, True]


def test_recent_is_per_service(store):
    store.record("api", NOW, True, 1, "")
    assert store.recent("kiosk", 5) == []


def test_daily_rollup_counts(store):
    store.record("api", NOW, True, 1, "")
    store.record("api", NOW + timedelta(minutes=1), False, None, "timeout")
    store.record("api", NOW + timedelta(minutes=2), True, 1, "")
    bars = store.daily("api", NOW.date(), 90)
    assert len(bars) == 90
    assert bars[-1] == DayBar("2026-09-23", 2, 3)
    assert bars[0] == DayBar("2026-06-26", None, None)


def test_daily_uses_utc_day(store):
    from datetime import timezone
    est = timezone(timedelta(hours=-5))
    # 22:00 EST on the 22nd is 03:00 UTC on the 23rd
    store.record("api", datetime(2026, 9, 22, 22, 0, tzinfo=est), True, 1, "")
    assert store.daily("api", date(2026, 9, 23), 2)[-1] == DayBar("2026-09-23", 1, 1)


def test_naive_datetime_rejected(store):
    with pytest.raises(ValueError):
        store.record("api", datetime(2026, 9, 23, 12, 0), True, 1, "")


def test_prune_drops_old_raw_and_old_days(store):
    store.record("api", NOW - timedelta(days=8), True, 1, "")
    store.record("api", NOW - timedelta(days=6), True, 1, "")
    store.record("api", NOW - timedelta(days=95), True, 1, "")
    store.prune(NOW)
    assert [r.at for r in store.recent("api", 10)] == [NOW - timedelta(days=6)]
    # the 8-day-old day survives in the rollup (inside 90 days); the 95-day-old one is gone
    bars = {b.day: b for b in store.daily("api", NOW.date(), 90) if b.total}
    assert set(bars) == {"2026-09-15", "2026-09-17"}
    import sqlite3
    conn = sqlite3.connect(store.path)
    assert conn.execute("SELECT COUNT(*) FROM daily").fetchone()[0] == 2
    conn.close()


def test_prune_keeps_exactly_90_days(store):
    store.record("api", NOW - timedelta(days=89), True, 1, "")
    store.record("api", NOW - timedelta(days=90), True, 1, "")
    store.prune(NOW)
    days = [b.day for b in store.daily("api", NOW.date(), 90) if b.total]
    assert days == ["2026-06-26"]


def test_survives_reopen(tmp_path):
    path = str(tmp_path / "s.db")
    s = Store(path)
    s.record("api", NOW, True, 1, "")
    s.close()
    s2 = Store(path)
    assert len(s2.recent("api", 5)) == 1
    s2.close()


def test_uptime_percent():
    assert uptime_percent([DayBar("a", None, None)]) is None
    assert uptime_percent([]) is None
    assert uptime_percent([DayBar("a", 3, 4), DayBar("b", None, None), DayBar("c", 4, 4)]) == 87.5
    assert uptime_percent([DayBar("a", 2, 3)]) == 66.6667
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd status && .venv/bin/pytest -q tests/test_state.py tests/test_store.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'serversherpa_status.state'` / `.store`.

- [ ] **Step 3: Implement state.py and store.py**

`status/src/serversherpa_status/state.py`:
```python
"""Displayed state per service. One failed check is noise; a service reads
'down' only after `threshold` consecutive failures, and 'up' again on the
first success. Every check still counts toward uptime (see store.py)."""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Snapshot:
    state: str  # "up" | "down" | "unknown"
    last_checked_at: datetime | None
    latency_ms: int | None


class StateTracker:
    def __init__(self, keys: Iterable[str], threshold: int) -> None:
        self._threshold = threshold
        self._fails = {k: 0 for k in keys}
        self._snap = {k: Snapshot("unknown", None, None) for k in self._fails}

    def record(self, key: str, ok: bool, latency_ms: int | None, at: datetime) -> None:
        prev = self._snap[key].state
        if ok:
            self._fails[key] = 0
            state = "up"
        else:
            self._fails[key] += 1
            state = "down" if self._fails[key] >= self._threshold else prev
        self._snap[key] = Snapshot(state, at, latency_ms)

    def snapshot(self, key: str) -> Snapshot:
        return self._snap[key]
```

`status/src/serversherpa_status/store.py`:
```python
"""SQLite history: raw checks (7 days) + a per-UTC-day rollup (90 days).
One connection, used only from the event-loop thread; each write is a
tiny transaction, so it is called inline rather than via a thread pool."""

import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

RAW_RETENTION = timedelta(days=7)
WINDOW_DAYS = 90

SCHEMA = """
CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY,
    service TEXT NOT NULL,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS checks_service_at ON checks (service, at);
CREATE TABLE IF NOT EXISTS daily (
    service TEXT NOT NULL,
    day TEXT NOT NULL,
    ok_count INTEGER NOT NULL,
    total_count INTEGER NOT NULL,
    PRIMARY KEY (service, day)
);
"""


@dataclass(frozen=True)
class CheckRow:
    at: datetime
    ok: bool
    latency_ms: int | None


@dataclass(frozen=True)
class DayBar:
    day: str
    ok: int | None
    total: int | None


def _utc(at: datetime) -> datetime:
    if at.tzinfo is None:
        raise ValueError("naive datetime; pass a timezone-aware value")
    return at.astimezone(UTC)


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, isolation_level=None)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)

    def close(self) -> None:
        self._conn.close()

    def record(
        self, service: str, at: datetime, ok: bool, latency_ms: int | None, detail: str
    ) -> None:
        at = _utc(at)
        with self._conn:
            self._conn.execute("BEGIN")
            self._conn.execute(
                "INSERT INTO checks (service, at, ok, latency_ms, detail) VALUES (?, ?, ?, ?, ?)",
                (service, at.isoformat(), int(ok), latency_ms, detail),
            )
            self._conn.execute(
                "INSERT INTO daily (service, day, ok_count, total_count) VALUES (?, ?, ?, 1) "
                "ON CONFLICT (service, day) DO UPDATE SET "
                "ok_count = ok_count + excluded.ok_count, total_count = total_count + 1",
                (service, at.date().isoformat(), int(ok)),
            )

    def recent(self, service: str, limit: int) -> list[CheckRow]:
        rows = self._conn.execute(
            "SELECT at, ok, latency_ms FROM checks WHERE service = ? ORDER BY at DESC, id DESC LIMIT ?",
            (service, limit),
        ).fetchall()
        return [CheckRow(datetime.fromisoformat(a), bool(o), lat) for a, o, lat in reversed(rows)]

    def prune(self, now: datetime) -> None:
        now = _utc(now)
        oldest_day = now.date() - timedelta(days=WINDOW_DAYS - 1)
        with self._conn:
            self._conn.execute("BEGIN")
            self._conn.execute(
                "DELETE FROM checks WHERE at < ?", ((now - RAW_RETENTION).isoformat(),)
            )
            self._conn.execute("DELETE FROM daily WHERE day < ?", (oldest_day.isoformat(),))

    def daily(self, service: str, today: date, days: int = WINDOW_DAYS) -> list[DayBar]:
        first = today - timedelta(days=days - 1)
        found = dict(
            ((d, (o, t)) for d, o, t in self._conn.execute(
                "SELECT day, ok_count, total_count FROM daily "
                "WHERE service = ? AND day >= ? AND day <= ?",
                (service, first.isoformat(), today.isoformat()),
            ))
        )
        bars = []
        for n in range(days):
            day = (first + timedelta(days=n)).isoformat()
            ok, total = found.get(day, (None, None))
            bars.append(DayBar(day, ok, total))
        return bars


def uptime_percent(bars: Iterable[DayBar]) -> float | None:
    ok = total = 0
    for b in bars:
        if b.total:
            ok += b.ok or 0
            total += b.total
    return round(ok / total * 100, 4) if total else None
```

Note: `isolation_level=None` puts sqlite3 in autocommit; the explicit `BEGIN` plus `with self._conn:` (which commits on success / rolls back on error) makes each record/prune one transaction. ISO strings from `astimezone(UTC)` all carry `+00:00`, so lexical comparison in `DELETE … WHERE at < ?` is chronological.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd status && .venv/bin/pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add status/src/serversherpa_status/state.py status/src/serversherpa_status/store.py status/tests/test_state.py status/tests/test_store.py
git commit -m "feat(status): 2-strike state tracker and SQLite check history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Checker loop, summary, FastAPI app, entrypoint

**Files:**
- Create: `status/src/serversherpa_status/checker.py`, `summary.py`, `app.py`, `__main__.py`, `static/.gitkeep`; `status/tests/test_checker.py`, `test_summary.py`, `test_app.py`

**Interfaces:**
- Consumes: `Settings`, `Service`, `load_settings`, `ConfigError` (config); `probe`, `ProbeResult` (probes); `StateTracker`, `Snapshot` (state); `Store`, `DayBar`, `uptime_percent`, `WINDOW_DAYS` (store).
- Produces:
  - `checker.Checker(settings: Settings, store: Store, tracker: StateTracker, client: httpx.AsyncClient, clock: Callable[[], datetime] = utcnow)` with `async run_cycle() -> None` and `async run_forever() -> None`; `checker.utcnow() -> datetime`; `checker.seed_tracker(tracker, store, settings) -> None` (replays the last `failure_threshold` checks per service so a restart doesn't show "Checking…").
  - `summary.build_summary(settings: Settings, store: Store, tracker: StateTracker, now: datetime) -> dict` — the JSON shape in the spec.
  - `app.create_app(settings: Settings | None = None, *, start_checker: bool = True) -> FastAPI` — `app.state.store`, `app.state.tracker` available inside the lifespan.
  - `python -m serversherpa_status` runs uvicorn on `0.0.0.0:${PORT:-8080}`, exits 2 with `status: <message>` on ConfigError.

- [ ] **Step 1: Write failing tests**

`status/tests/test_checker.py`:
```python
import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import respx

from serversherpa_status.checker import Checker, seed_tracker
from serversherpa_status.config import load_settings
from serversherpa_status.state import StateTracker
from serversherpa_status.store import Store

T0 = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


@pytest.fixture
def settings(tmp_path):
    return load_settings({
        "STATUS_API_URL": "http://api.test",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_INTERVAL_SECONDS": "10",
        "STATUS_DB_PATH": str(tmp_path / "s.db"),
    })


@pytest.fixture
def store(settings):
    s = Store(settings.db_path)
    yield s
    s.close()


def routes(api_ok=True, portal_ok=True, kiosk_ok=True):
    respx.get("http://api.test/system/status").respond(200 if api_ok else 503, json={})
    respx.get("http://portal.test/").respond(200 if portal_ok else 502, text='<div id="root">')
    respx.get("http://kiosk.test/config.js").respond(200 if kiosk_ok else 502, text="x")


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self):
        return self.now


@respx.mock
async def test_cycle_records_every_service(settings, store):
    routes(kiosk_ok=False)
    tracker = StateTracker([s.key for s in settings.services], 2)
    async with httpx.AsyncClient() as client:
        await Checker(settings, store, tracker, client, clock=Clock()).run_cycle()
    assert [r.ok for r in store.recent("api", 5)] == [True]
    assert [r.ok for r in store.recent("kiosk", 5)] == [False]
    assert tracker.snapshot("api").state == "up"
    assert tracker.snapshot("kiosk").state == "unknown"  # one strike only


@respx.mock
async def test_two_failed_cycles_flip_down(settings, store):
    routes(api_ok=False)
    tracker = StateTracker([s.key for s in settings.services], 2)
    clock = Clock()
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client, clock=clock)
        await c.run_cycle()
        clock.now += timedelta(minutes=1)
        await c.run_cycle()
    assert tracker.snapshot("api").state == "down"
    assert tracker.snapshot("api").last_checked_at == clock.now


@respx.mock
async def test_prunes_on_first_cycle_then_hourly(settings, store, monkeypatch):
    routes()
    calls = []
    monkeypatch.setattr(store, "prune", lambda now: calls.append(now))
    tracker = StateTracker([s.key for s in settings.services], 2)
    clock = Clock()
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client, clock=clock)
        await c.run_cycle()
        clock.now += timedelta(minutes=30)
        await c.run_cycle()
        clock.now += timedelta(minutes=31)
        await c.run_cycle()
    assert calls == [T0, T0 + timedelta(minutes=61)]


async def test_run_forever_survives_a_crashing_cycle(settings, store, monkeypatch):
    tracker = StateTracker([s.key for s in settings.services], 2)
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client)
        calls = 0

        async def flaky():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("boom")
            if calls >= 3:
                raise asyncio.CancelledError

        monkeypatch.setattr(c, "run_cycle", flaky)
        real_sleep = asyncio.sleep  # capture first: the patch below replaces asyncio.sleep globally
        monkeypatch.setattr(asyncio, "sleep", lambda s: real_sleep(0))
        with pytest.raises(asyncio.CancelledError):
            await c.run_forever()
    assert calls == 3


def test_seed_tracker_replays_recent_checks(settings, store):
    for n, ok in enumerate([True, False, False]):
        store.record("api", T0 + timedelta(minutes=n), ok, None, "")
    store.record("kiosk", T0, True, 12, "")
    tracker = StateTracker([s.key for s in settings.services], 2)
    seed_tracker(tracker, store, settings)
    assert tracker.snapshot("api").state == "down"
    assert tracker.snapshot("kiosk").state == "up"
    assert tracker.snapshot("kiosk").latency_ms == 12
    assert tracker.snapshot("portal").state == "unknown"
```

`status/tests/test_summary.py`:
```python
from datetime import UTC, datetime, timedelta

import pytest

from serversherpa_status.config import load_settings
from serversherpa_status.state import StateTracker
from serversherpa_status.store import Store
from serversherpa_status.summary import build_summary

NOW = datetime(2026, 9, 23, 12, 0, 5, tzinfo=UTC)


@pytest.fixture
def ctx(tmp_path):
    settings = load_settings({
        "STATUS_API_URL": "http://secret-api.internal:8000",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_DB_PATH": str(tmp_path / "s.db"),
    })
    store = Store(settings.db_path)
    tracker = StateTracker([s.key for s in settings.services], 2)
    yield settings, store, tracker
    store.close()


def test_unknown_before_any_checks(ctx):
    out = build_summary(*ctx, NOW)
    assert out["overall"] == "unknown"
    assert out["generated_at"] == "2026-09-23T12:00:05Z"
    assert [s["key"] for s in out["services"]] == ["api", "portal", "kiosk"]
    api = out["services"][0]
    assert api == {
        "key": "api", "name": "API", "state": "unknown",
        "last_checked_at": None, "latency_ms": None, "uptime_90d": None,
        "days": api["days"],
    }
    assert len(api["days"]) == 90
    assert api["days"][0] == {"day": "2026-06-26", "ok": None, "total": None}
    assert api["days"][-1]["day"] == "2026-09-23"


def test_operational_and_degraded(ctx):
    settings, store, tracker = ctx
    for s in settings.services:
        store.record(s.key, NOW, True, 30, "")
        tracker.record(s.key, True, 30, NOW)
    out = build_summary(settings, store, tracker, NOW)
    assert out["overall"] == "operational"
    assert out["services"][0]["uptime_90d"] == 100.0
    assert out["services"][0]["last_checked_at"] == "2026-09-23T12:00:05Z"
    assert out["services"][0]["days"][-1] == {"day": "2026-09-23", "ok": 1, "total": 1}

    for n in (1, 2):
        at = NOW + timedelta(minutes=n)
        store.record("kiosk", at, False, None, "HTTP 502 from http://kiosk.test")
        tracker.record("kiosk", False, None, at)
    out = build_summary(settings, store, tracker, NOW + timedelta(minutes=2))
    assert out["overall"] == "degraded"
    kiosk = out["services"][2]
    assert kiosk["state"] == "down"
    assert kiosk["uptime_90d"] == 33.3333


def test_mixed_up_and_unknown_is_unknown(ctx):
    settings, store, tracker = ctx
    tracker.record("api", True, 1, NOW)
    assert build_summary(settings, store, tracker, NOW)["overall"] == "unknown"


def test_never_leaks_urls_or_detail(ctx):
    settings, store, tracker = ctx
    store.record("api", NOW, False, None, "connection error to secret-api.internal")
    tracker.record("api", False, None, NOW)
    blob = repr(build_summary(settings, store, tracker, NOW))
    assert "secret-api" not in blob
    assert "internal" not in blob
    assert "http" not in blob
```

`status/tests/test_app.py`:
```python
import pytest
from datetime import UTC, datetime
from fastapi.testclient import TestClient

from serversherpa_status.app import create_app
from serversherpa_status.config import load_settings


@pytest.fixture
def client(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html><body>status page</body></html>")
    settings = load_settings({
        "STATUS_API_URL": "http://api.test",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_DB_PATH": str(tmp_path / "s.db"),
        "STATUS_STATIC_DIR": str(static),
    })
    app = create_app(settings, start_checker=False)
    with TestClient(app) as c:
        yield c


def test_summary(client):
    now = datetime.now(UTC)
    client.app.state.store.record("api", now, True, 20, "")
    client.app.state.tracker.record("api", True, 20, now)
    resp = client.get("/api/summary")
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"
    body = resp.json()
    assert body["services"][0]["state"] == "up"
    assert body["services"][0]["days"][-1]["total"] == 1


def test_healthz(client):
    assert client.get("/healthz").json() == {"status": "ok"}


def test_page_served_at_root(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "status page" in resp.text


def test_security_headers_everywhere(client):
    for path in ("/", "/api/summary", "/healthz", "/nope"):
        h = client.get(path).headers
        assert h["x-frame-options"] == "DENY"
        assert h["x-content-type-options"] == "nosniff"
        assert h["referrer-policy"] == "same-origin"


def test_no_writes(client):
    assert client.post("/api/summary").status_code == 405
    assert client.post("/").status_code == 405
    assert client.delete("/healthz").status_code == 405


def test_unknown_path_404(client):
    assert client.get("/nope").status_code == 404


def test_no_openapi_or_docs(client):
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_seeds_state_from_history(tmp_path):
    settings = load_settings({
        "STATUS_API_URL": "http://api.test",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_DB_PATH": str(tmp_path / "s.db"),
        "STATUS_STATIC_DIR": str(tmp_path),
    })
    from serversherpa_status.store import Store
    s = Store(settings.db_path)
    s.record("portal", datetime.now(UTC), True, 9, "")
    s.close()
    with TestClient(create_app(settings, start_checker=False)) as c:
        assert c.get("/api/summary").json()["services"][1]["state"] == "up"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd status && .venv/bin/pytest -q tests/test_checker.py tests/test_summary.py tests/test_app.py`
Expected: FAIL — `ModuleNotFoundError` for `checker`, `summary`, `app`.

- [ ] **Step 3: Implement checker.py, summary.py, app.py, __main__.py**

`status/src/serversherpa_status/checker.py`:
```python
"""The background loop: probe every service concurrently, record each
result, prune hourly. A crashing cycle is logged and the loop carries on —
a status page whose checker died silently would freeze on stale green."""

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx

from serversherpa_status.config import Settings
from serversherpa_status.probes import probe
from serversherpa_status.state import StateTracker
from serversherpa_status.store import Store

log = logging.getLogger("serversherpa_status.checker")

PRUNE_EVERY = timedelta(hours=1)


def utcnow() -> datetime:
    return datetime.now(UTC)


def seed_tracker(tracker: StateTracker, store: Store, settings: Settings) -> None:
    for service in settings.services:
        for row in store.recent(service.key, settings.failure_threshold):
            tracker.record(service.key, row.ok, row.latency_ms, row.at)


class Checker:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        tracker: StateTracker,
        client: httpx.AsyncClient,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self._settings = settings
        self._store = store
        self._tracker = tracker
        self._client = client
        self._clock = clock
        self._last_prune: datetime | None = None

    async def run_cycle(self) -> None:
        services = self._settings.services
        results = await asyncio.gather(
            *(probe(self._client, s, self._settings.timeout_seconds) for s in services)
        )
        now = self._clock()
        for service, result in zip(services, results):
            self._store.record(service.key, now, result.ok, result.latency_ms, result.detail)
            self._tracker.record(service.key, result.ok, result.latency_ms, now)
            if not result.ok:
                log.warning("%s check failed: %s", service.key, result.detail)
        if self._last_prune is None or now - self._last_prune >= PRUNE_EVERY:
            self._store.prune(now)
            self._last_prune = now

    async def run_forever(self) -> None:
        while True:
            try:
                await self.run_cycle()
            except Exception:
                log.exception("status check cycle failed; retrying next interval")
            await asyncio.sleep(self._settings.interval_seconds)
```

`status/src/serversherpa_status/summary.py`:
```python
"""The public JSON. Built only from display names, states, and counts —
service URLs and probe details never leave the container."""

from datetime import UTC, datetime

from serversherpa_status.config import Settings
from serversherpa_status.state import StateTracker
from serversherpa_status.store import WINDOW_DAYS, Store, uptime_percent


def _iso(at: datetime | None) -> str | None:
    if at is None:
        return None
    return at.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_summary(settings: Settings, store: Store, tracker: StateTracker, now: datetime) -> dict:
    today = now.astimezone(UTC).date()
    services = []
    for s in settings.services:
        snap = tracker.snapshot(s.key)
        bars = store.daily(s.key, today, WINDOW_DAYS)
        services.append({
            "key": s.key,
            "name": s.name,
            "state": snap.state,
            "last_checked_at": _iso(snap.last_checked_at),
            "latency_ms": snap.latency_ms,
            "uptime_90d": uptime_percent(bars),
            "days": [{"day": b.day, "ok": b.ok, "total": b.total} for b in bars],
        })
    states = {s["state"] for s in services}
    if "down" in states:
        overall = "degraded"
    elif states == {"up"}:
        overall = "operational"
    else:
        overall = "unknown"
    return {"generated_at": _iso(now), "overall": overall, "services": services}
```

`status/src/serversherpa_status/app.py`:
```python
"""FastAPI app: GET /api/summary, GET /healthz, and the built page.
Read-only by construction — no route accepts anything but GET/HEAD."""

import asyncio
import contextlib
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from serversherpa_status.checker import Checker, seed_tracker, utcnow
from serversherpa_status.config import Settings, load_settings
from serversherpa_status.state import StateTracker
from serversherpa_status.store import Store
from serversherpa_status.summary import build_summary

SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
}
USER_AGENT = "ServerSherpa-Status/0.1"


def create_app(settings: Settings | None = None, *, start_checker: bool = True) -> FastAPI:
    settings = settings or load_settings()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store = Store(settings.db_path)
        tracker = StateTracker([s.key for s in settings.services], settings.failure_threshold)
        seed_tracker(tracker, store, settings)
        app.state.store = store
        app.state.tracker = tracker
        client = httpx.AsyncClient(headers={"User-Agent": USER_AGENT})
        task = None
        if start_checker:
            task = asyncio.create_task(Checker(settings, store, tracker, client).run_forever())
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await client.aclose()
            store.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.update(SECURITY_HEADERS)
        return response

    @app.get("/api/summary")
    async def summary(request: Request) -> JSONResponse:
        body = build_summary(settings, request.app.state.store, request.app.state.tracker, utcnow())
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok"}

    static = Path(settings.static_dir)
    if static.is_dir():
        app.mount("/", StaticFiles(directory=static, html=True), name="page")

    return app
```

`status/src/serversherpa_status/__main__.py`:
```python
"""`python -m serversherpa_status` — validate config, then serve on :8080."""

import logging
import os
import sys

import uvicorn

from serversherpa_status.app import create_app
from serversherpa_status.config import ConfigError, load_settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"status: {exc}", file=sys.stderr)
        sys.exit(2)
    uvicorn.run(
        create_app(settings),
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8080")),
        proxy_headers=True,
        forwarded_allow_ips="*",
        access_log=False,
    )


if __name__ == "__main__":
    main()
```

`status/src/serversherpa_status/static/.gitkeep`: empty file.

Note on `/nope`: StaticFiles returns 404 for missing files and 405 for non-GET/HEAD, so the `POST /` and `/nope` tests pass through the mount. Routes declared with `@app.get` return 405 for other methods automatically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd status && .venv/bin/pytest -q`
Expected: all pass. If `test_security_headers_everywhere` fails on `/nope` (404 from the mount), confirm the middleware is registered with `@app.middleware("http")` — it wraps mounted apps too.

- [ ] **Step 5: Smoke-run the entrypoint's config error**

Run: `cd status && env -u STATUS_API_URL .venv/bin/python -m serversherpa_status; echo "exit=$?"`
Expected: `status: STATUS_API_URL is required (e.g. https://api.serversherpa.com)` and `exit=2`.

- [ ] **Step 6: Commit**

```bash
git add status/src status/tests
git commit -m "feat(status): checker loop, public summary endpoint, FastAPI app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The page (Vite + React, portal look)

**Files:**
- Create: `status/web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `public/serversherpa-logo.png`, `public/favicon.ico`, `src/vite-env.d.ts`, `src/main.tsx`, `src/App.tsx`, `src/App.test.tsx`, `src/lib/summary.ts`, `src/lib/summary.test.ts`, `src/components/StatusBanner.tsx`, `src/components/ServiceCard.tsx`, `src/components/UptimeStrip.tsx`, `src/components/components.test.tsx`, `src/styles/status.css`

**Interfaces:**
- Consumes: `GET /api/summary` JSON from Task 3 (shape below).
- Produces (TypeScript, `src/lib/summary.ts`):
  - `type ServiceState = 'up' | 'down' | 'unknown'`; `type Overall = 'operational' | 'degraded' | 'unknown'`
  - `interface DayBar { day: string; ok: number | null; total: number | null }`
  - `interface ServiceSummary { key: string; name: string; state: ServiceState; last_checked_at: string | null; latency_ms: number | null; uptime_90d: number | null; days: DayBar[] }`
  - `interface Summary { generated_at: string; overall: Overall; services: ServiceSummary[] }`
  - `fetchSummary(signal?: AbortSignal): Promise<Summary>`; `formatUptime(pct: number | null): string`; `barTone(bar: DayBar): 'up' | 'down' | 'none'`; `dayUptime(bar: DayBar): string`; `formatClock(iso: string | Date): string`; `formatDay(day: string): string`; `POLL_MS = 30000`.

- [ ] **Step 1: Scaffold the web project**

```bash
mkdir -p status/web/public status/web/src/lib status/web/src/components status/web/src/styles
cp portal/public/images/serversherpa-logo.png status/web/public/serversherpa-logo.png
cp portal/public/favicon.ico status/web/public/favicon.ico
```

`status/web/package.json`:
```json
{
  "name": "serversherpa-status-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "build:bundle": "vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.2",
    "@types/node": "^22.20.2",
    "@types/react": "^18.3.10",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.2",
    "jsdom": "^29.1.1",
    "typescript": "~5.6.2",
    "vite": "^5.4.8",
    "vitest": "^3.2.4"
  }
}
```

`status/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "types": ["vite/client", "node"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@portal/*": ["../../portal/src/*"] }
  },
  "include": ["src"]
}
```

`status/web/vite.config.ts`:
```ts
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

// The page borrows the portal's stylesheets (tokens, fonts, panels) through
// this alias so it can never drift from the portal's look. Only CSS is
// imported from the portal — no components, no portal node_modules.
const portalSrc = fileURLToPath(new URL('../../portal/src', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@portal': portalSrc } },
  server: {
    port: 5176,
    strictPort: true,
    fs: { allow: [repoRoot] },
    // `npm run dev` against a locally running status server
    proxy: { '/api': 'http://localhost:8080' },
  },
  test: {
    environment: 'jsdom',
    css: false,
    exclude: [...configDefaults.exclude, '**/._*'],
  },
});
```

`status/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Live status and uptime for ServerSherpa." />
    <link rel="icon" href="/favicon.ico" sizes="32x32" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Geologica:wght@200;300;400;500;600;800&family=Fragment+Mono:ital@0;1&display=swap" rel="stylesheet" />
    <title>ServerSherpa Status</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`status/web/src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

Install: `npm --prefix status/web install` (creates `status/web/package-lock.json` — commit it; the Dockerfile uses `npm ci`).

- [ ] **Step 2: Write failing tests**

`status/web/src/lib/summary.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

import { barTone, dayUptime, formatDay, formatUptime } from './summary';

describe('formatUptime', () => {
  it('shows exactly 100 as 100%', () => expect(formatUptime(100)).toBe('100%'));
  it('truncates, never rounds up to 100', () => expect(formatUptime(99.9999)).toBe('99.99%'));
  it('keeps two decimals', () => expect(formatUptime(87.5)).toBe('87.50%'));
  it('truncates rather than rounds', () => expect(formatUptime(66.6667)).toBe('66.66%'));
  it('shows a dash for no data', () => expect(formatUptime(null)).toBe('—'));
});

describe('barTone', () => {
  it('no data', () => expect(barTone({ day: 'd', ok: null, total: null })).toBe('none'));
  it('zero total', () => expect(barTone({ day: 'd', ok: 0, total: 0 })).toBe('none'));
  it('perfect day', () => expect(barTone({ day: 'd', ok: 5, total: 5 })).toBe('up'));
  it('any failure is red', () => expect(barTone({ day: 'd', ok: 1439, total: 1440 })).toBe('down'));
});

describe('dayUptime / formatDay', () => {
  it('day uptime text', () => {
    expect(dayUptime({ day: 'd', ok: 1439, total: 1440 })).toBe('99.93%');
    expect(dayUptime({ day: 'd', ok: null, total: null })).toBe('No data');
  });
  it('formats a UTC day without shifting it', () =>
    expect(formatDay('2026-09-23')).toBe('Sep 23, 2026'));
});
```

`status/web/src/components/components.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DayBar, ServiceSummary } from '../lib/summary';
import ServiceCard from './ServiceCard';
import StatusBanner from './StatusBanner';
import UptimeStrip from './UptimeStrip';

function days(fill: (i: number) => DayBar['ok']): DayBar[] {
  return Array.from({ length: 90 }, (_, i) => {
    const ok = fill(i);
    return { day: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, ok, total: ok === null ? null : 10 };
  });
}

const up: ServiceSummary = {
  key: 'api', name: 'API', state: 'up', last_checked_at: '2026-09-23T12:00:00Z',
  latency_ms: 42, uptime_90d: 99.99, days: days(() => 10),
};

describe('StatusBanner', () => {
  it('operational', () => {
    render(<StatusBanner overall="operational" services={[up]} />);
    expect(screen.getByRole('status').textContent).toContain('All systems operational');
  });
  it('degraded names the count', () => {
    render(<StatusBanner overall="degraded" services={[up, { ...up, key: 'k', name: 'Kiosk', state: 'down' }]} />);
    expect(screen.getByRole('status').textContent).toContain('1 service down');
  });
  it('plural', () => {
    const down = { ...up, state: 'down' as const };
    render(<StatusBanner overall="degraded" services={[down, down]} />);
    expect(screen.getByRole('status').textContent).toContain('2 services down');
  });
  it('unknown', () => {
    render(<StatusBanner overall="unknown" services={[]} />);
    expect(screen.getByRole('status').textContent).toContain('Checking');
  });
});

describe('ServiceCard', () => {
  it('shows name, state, latency, uptime', () => {
    render(<ServiceCard service={up} />);
    expect(screen.getByRole('heading', { name: 'API' })).toBeTruthy();
    expect(screen.getByText('Operational')).toBeTruthy();
    expect(screen.getByText('42 ms')).toBeTruthy();
    expect(screen.getByText('99.99%')).toBeTruthy();
  });
  it('down', () => {
    render(<ServiceCard service={{ ...up, state: 'down', latency_ms: null }} />);
    expect(screen.getByText('Down')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('UptimeStrip', () => {
  it('renders 90 bars with tones', () => {
    const { container } = render(
      <UptimeStrip days={days((i) => (i < 10 ? null : i === 50 ? 7 : 10))} />,
    );
    expect(container.querySelectorAll('.ss-bar')).toHaveLength(90);
    expect(container.querySelectorAll('.ss-bar-none')).toHaveLength(10);
    expect(container.querySelectorAll('.ss-bar-down')).toHaveLength(1);
    expect(container.querySelectorAll('.ss-bar-up')).toHaveLength(79);
    // the oldest 60 carry the class the phone layout hides
    expect(container.querySelectorAll('.ss-bar-old')).toHaveLength(60);
  });
  it('bars are labeled for assistive tech', () => {
    render(<UptimeStrip days={days(() => 10)} />);
    expect(screen.getAllByRole('img')[89].getAttribute('aria-label')).toMatch(/100%/);
  });
});
```

`status/web/src/App.test.tsx`:
```tsx
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import type { Summary } from './lib/summary';

const summary: Summary = {
  generated_at: '2026-09-23T12:00:00Z',
  overall: 'operational',
  services: ['API', 'Portal', 'Kiosk'].map((name) => ({
    key: name.toLowerCase(), name, state: 'up', last_checked_at: '2026-09-23T12:00:00Z',
    latency_ms: 10, uptime_90d: 100,
    days: Array.from({ length: 90 }, (_, i) => ({ day: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, ok: 1, total: 1 })),
  })),
};

describe('App', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders the three services from /api/summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(summary)));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('All systems operational')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['API', 'Portal', 'Kiosk']);
    expect(fetchMock).toHaveBeenCalledWith('/api/summary', expect.objectContaining({ cache: 'no-store' }));
  });

  it('keeps last data and warns when a refresh fails — never fakes green', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(summary)))
      .mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByText('All systems operational');
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(await screen.findByText(/Status data may be stale/)).toBeTruthy();
    expect(screen.getByText('All systems operational')).toBeTruthy();
  });

  it('shows an error state when the first load fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));
    render(<App />);
    expect(await screen.findByText(/Status is unavailable right now/)).toBeTruthy();
    expect(screen.queryByText('All systems operational')).toBeNull();
  });
});
```

(No jest-dom: assertions use plain `.textContent` / `toBeTruthy()`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm --prefix status/web test`
Expected: FAIL — cannot resolve `./summary`, `./ServiceCard`, `./App`.

- [ ] **Step 4: Implement lib + components + App + styles**

`status/web/src/lib/summary.ts`:
```ts
export type ServiceState = 'up' | 'down' | 'unknown';
export type Overall = 'operational' | 'degraded' | 'unknown';

export interface DayBar { day: string; ok: number | null; total: number | null }

export interface ServiceSummary {
  key: string;
  name: string;
  state: ServiceState;
  last_checked_at: string | null;
  latency_ms: number | null;
  uptime_90d: number | null;
  days: DayBar[];
}

export interface Summary { generated_at: string; overall: Overall; services: ServiceSummary[] }

export const POLL_MS = 30_000;

export async function fetchSummary(signal?: AbortSignal): Promise<Summary> {
  const resp = await fetch('/api/summary', { cache: 'no-store', signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as Summary;
}

/** Two decimals, truncated — 99.9999 must never read as 100%. */
export function formatUptime(pct: number | null): string {
  if (pct === null) return '—';
  if (pct >= 100) return '100%';
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

export function barTone(bar: DayBar): 'up' | 'down' | 'none' {
  if (!bar.total) return 'none';
  return bar.ok === bar.total ? 'up' : 'down';
}

export function dayUptime(bar: DayBar): string {
  if (!bar.total) return 'No data';
  return formatUptime(((bar.ok ?? 0) / bar.total) * 100);
}

const DAY_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const CLOCK_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** Days are UTC calendar days; format them in UTC so they never shift. */
export function formatDay(day: string): string {
  return DAY_FMT.format(new Date(`${day}T00:00:00Z`));
}

export function formatClock(at: string | Date): string {
  return CLOCK_FMT.format(typeof at === 'string' ? new Date(at) : at);
}
```

`status/web/src/components/StatusBanner.tsx`:
```tsx
import type { Overall, ServiceSummary } from '../lib/summary';

interface Props { overall: Overall; services: ServiceSummary[] }

export default function StatusBanner({ overall, services }: Props) {
  const down = services.filter((s) => s.state === 'down').length;
  const text =
    overall === 'operational' ? 'All systems operational'
    : overall === 'degraded' ? `${down} ${down === 1 ? 'service' : 'services'} down`
    : 'Checking services…';
  const tone = overall === 'operational' ? 'up' : overall === 'degraded' ? 'down' : 'unknown';
  return (
    <div className={`ss-banner ss-banner-${tone}`} role="status" aria-live="polite">
      <span className={`ss-dot ss-dot-${tone}`} aria-hidden="true" />
      <span className="ss-banner-text">{text}</span>
    </div>
  );
}
```

`status/web/src/components/UptimeStrip.tsx`:
```tsx
import { useState } from 'react';

import { barTone, dayUptime, formatDay, type DayBar } from '../lib/summary';

/** Bars older than this many days are hidden on phones (keeps bars tappable). */
const PHONE_DAYS = 30;

export default function UptimeStrip({ days }: { days: DayBar[] }) {
  const [active, setActive] = useState<number | null>(null);
  const cutoff = days.length - PHONE_DAYS;
  const bar = active === null ? null : days[active];
  return (
    <div className="ss-strip-wrap" onMouseLeave={() => setActive(null)}>
      <div className="ss-strip">
        {days.map((d, i) => {
          const label = `${formatDay(d.day)}: ${dayUptime(d)}`;
          return (
            <span
              key={d.day + i}
              role="img"
              aria-label={label}
              tabIndex={0}
              className={`ss-bar ss-bar-${barTone(d)}${i < cutoff ? ' ss-bar-old' : ''}${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            />
          );
        })}
      </div>
      {bar && active !== null && (
        <div
          className={`ss-tip${active > days.length / 2 ? ' ss-tip-left' : ''}`}
          style={{ left: `${((active + 0.5) / days.length) * 100}%` }}
          aria-hidden="true"
        >
          <div className="ss-tip-day">{formatDay(bar.day)}</div>
          <div className="ss-tip-pct">{dayUptime(bar)}</div>
          {bar.total ? <div className="ss-tip-count">{bar.ok} of {bar.total} checks passed</div> : null}
        </div>
      )}
      <div className="ss-axis">
        <span className="ss-axis-long">{days.length} days ago</span>
        <span className="ss-axis-short">{PHONE_DAYS} days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}
```

`status/web/src/components/ServiceCard.tsx`:
```tsx
import { formatClock, formatUptime, type ServiceSummary } from '../lib/summary';
import UptimeStrip from './UptimeStrip';

const STATE_WORD = { up: 'Operational', down: 'Down', unknown: 'Checking' } as const;

export default function ServiceCard({ service }: { service: ServiceSummary }) {
  const s = service;
  return (
    <section className="panel ss-card" aria-labelledby={`svc-${s.key}`}>
      <div className="panel-head">
        <div className="ss-card-title">
          <span className={`ss-dot ss-dot-${s.state}`} aria-hidden="true" />
          <h2 id={`svc-${s.key}`}>{s.name}</h2>
        </div>
        <span className={`ss-chip ss-chip-${s.state}`}>{STATE_WORD[s.state]}</span>
      </div>
      <div className="panel-body">
        <dl className="ss-stats">
          <div><dt>90-day uptime</dt><dd>{formatUptime(s.uptime_90d)}</dd></div>
          <div><dt>Response time</dt><dd>{s.latency_ms === null ? '—' : `${s.latency_ms} ms`}</dd></div>
          <div><dt>Last checked</dt><dd>{s.last_checked_at ? formatClock(s.last_checked_at) : 'Never'}</dd></div>
        </dl>
        <UptimeStrip days={s.days} />
      </div>
    </section>
  );
}
```

Note: when `latency_ms` is null AND `uptime_90d` is null, two `—` render; the down-card test sets only `latency_ms: null` (uptime 99.99), so `getByText('—')` finds exactly one.

`status/web/src/App.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from 'react';

import ServiceCard from './components/ServiceCard';
import StatusBanner from './components/StatusBanner';
import { fetchSummary, formatClock, POLL_MS, type Summary } from './lib/summary';

export default function App() {
  const [data, setData] = useState<Summary | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const next = await fetchSummary(ctrl.signal);
      setData(next);
      setLoadedAt(new Date());
      setFailed(false);
    } catch {
      if (!ctrl.signal.aborted) setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      inflight.current?.abort();
    };
  }, [load]);

  return (
    <div className="portal-shell ss-shell">
      <main className="portal-page ss-page">
        <header className="ss-header">
          <div className="ss-brand">
            <img src="/serversherpa-logo.png" alt="" className="ss-logo" />
            <div>
              <div className="eyebrow">ServerSherpa</div>
              <h1 className="page-title">System Status</h1>
            </div>
          </div>
          {loadedAt && <div className="ss-updated">Updated {formatClock(loadedAt)}</div>}
        </header>

        {failed && data && loadedAt && (
          <div className="ss-stale" role="alert">
            Status data may be stale — last updated {formatClock(loadedAt)}. Retrying…
          </div>
        )}

        {data ? (
          <>
            <StatusBanner overall={data.overall} services={data.services} />
            <div className="ss-cards">
              {data.services.map((s) => <ServiceCard key={s.key} service={s} />)}
            </div>
          </>
        ) : failed ? (
          <div className="ss-stale" role="alert">Status is unavailable right now. Retrying…</div>
        ) : (
          <div className="ss-loading">Loading status…</div>
        )}

        <footer className="ss-footer">
          Checks run every minute. A service shows down after two failed checks in a row.
        </footer>
      </main>
    </div>
  );
}
```

`status/web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@portal/styles/base.css';
import '@portal/styles/portal-theme.css';
import '@portal/styles/directory.css';
import '@portal/styles/profile.css';
import './styles/status.css';

import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`status/web/src/styles/status.css`:
```css
/* Status page — portal tokens (.portal-shell light palette from
   portal-theme.css + directory.css), .panel from profile.css. The shell's
   app-frame layout (nav grid, 100vh, overflow hidden, ink background) is
   undone here: this is a single scrolling document. */

/* tokens live on .portal-shell, not body — literal = light --paper-2 */
body { background: #f1f4f7; }
html, body, #root { height: auto; min-height: 100%; }

.portal-shell.ss-shell {
  display: block;
  height: auto;
  min-height: 100vh;
  overflow: visible;
  background: var(--paper-2);
  color: var(--text-dark);
}

.ss-page {
  max-width: 960px;
  margin: 0 auto;
}

.ss-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
.ss-brand { display: flex; align-items: center; gap: 16px; flex: 1 1 auto; min-width: 0; }
.ss-brand > div { flex: 1; min-width: 0; }
.ss-logo { width: 44px; height: 44px; object-fit: contain; flex: 0 0 auto; }
.ss-updated { font-family: var(--font-mono); font-size: 12px; color: var(--text-mute); }

/* dots — same geometry as the portal's .sys-dot */
.ss-dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; display: inline-block; }
.ss-dot-up { background: var(--c-green); animation: ss-pulse 2s infinite; }
.ss-dot-down { background: var(--c-red); }
.ss-dot-unknown { background: var(--c-slate); }
@keyframes ss-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(23, 138, 76, 0.4); }
  50% { box-shadow: 0 0 0 5px rgba(23, 138, 76, 0); }
}
@media (prefers-reduced-motion: reduce) { .ss-dot-up { animation: none; } }

.ss-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-radius: 14px;
  border: 1px solid;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 20px;
}
.ss-banner-up { background: var(--c-green-bg); border-color: var(--c-green-bd); color: var(--c-green); }
.ss-banner-down { background: var(--c-red-bg); border-color: var(--c-red-bd); color: var(--c-red); }
.ss-banner-unknown { background: var(--c-slate-bg); border-color: var(--c-slate-bd); color: var(--c-slate); }

.ss-stale, .ss-loading {
  margin-bottom: 20px;
  padding: 12px 16px;
  border-radius: 10px;
  font-size: 13.5px;
}
.ss-stale { border: 1px solid var(--c-amber-bd); background: var(--c-amber-bg); color: var(--text-dark); }
.ss-loading { color: var(--text-mute); }

.ss-cards { display: grid; gap: 18px; }
.ss-cards .panel + .panel { margin-top: 0; }
.ss-card { overflow: visible; }
.ss-card .panel-head { border-radius: 16px 16px 0 0; }
.ss-card-title { display: flex; align-items: center; gap: 10px; }
.ss-card-title h2 { margin: 0; font-size: 15.5px; font-weight: 600; color: var(--text-dark); }

.ss-chip {
  font-size: 12px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid;
}
.ss-chip-up { color: var(--c-green); background: var(--c-green-bg); border-color: var(--c-green-bd); }
.ss-chip-down { color: var(--c-red); background: var(--c-red-bg); border-color: var(--c-red-bd); }
.ss-chip-unknown { color: var(--c-slate); background: var(--c-slate-bg); border-color: var(--c-slate-bd); }

.ss-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 0 0 18px;
}
.ss-stats dt {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-mute);
}
.ss-stats dd {
  margin: 4px 0 0;
  font-family: var(--font-mono);
  font-size: 18px;
  color: var(--text-dark);
}

.ss-strip-wrap { position: relative; }
.ss-strip { display: flex; gap: 2px; height: 34px; }
.ss-bar {
  flex: 1 1 0;
  min-width: 0;
  border-radius: 2px;
  outline: none;
  transition: opacity 0.12s ease;
}
.ss-bar-up { background: var(--c-green); }
.ss-bar-down { background: var(--c-red); }
.ss-bar-none { background: var(--paper-line); }
.ss-strip:hover .ss-bar:not(.is-active) { opacity: 0.55; }
.ss-bar:focus-visible { box-shadow: 0 0 0 2px var(--accent); }

.ss-tip {
  position: absolute;
  bottom: calc(100% - 10px);
  /* anchored inward so edge bars never push the tip outside the card:
     left-half bars anchor its left edge, right-half bars (.ss-tip-left) its right */
  transform: translate(-12px, -8px);
  background: var(--ink);
  color: var(--snow);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 5;
}
.ss-tip-left { transform: translate(calc(-100% + 12px), -8px); }
.ss-tip-day { font-weight: 600; }
.ss-tip-pct { font-family: var(--font-mono); }
.ss-tip-count { color: #8a97aa; }

.ss-axis {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-mute);
}
.ss-axis-short { display: none; }

.ss-footer {
  margin-top: 28px;
  font-size: 12.5px;
  color: var(--text-mute);
}

@media (max-width: 600px) {
  .portal-page.ss-page { padding: 24px 16px; }
  .ss-bar-old { display: none; }
  .ss-axis-long { display: none; }
  .ss-axis-short { display: inline; }
  .ss-stats { grid-template-columns: 1fr 1fr; }
  .ss-stats > div:last-child { grid-column: 1 / -1; }
  .ss-strip { gap: 3px; }
}
```

- [ ] **Step 5: Run tests, typecheck, and build**

Run: `npm --prefix status/web test && npm --prefix status/web run build`
Expected: vitest all pass; `tsc -b` clean; `vite build` writes `status/web/dist/index.html`.

- [ ] **Step 6: Commit**

```bash
git add status/web
git commit -m "feat(status): public status page in the portal look

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docker image, compose, README, live verification

**Files:**
- Create: `status/Dockerfile`, `status/docker-compose.yml`, `status/.env.example`, `status/README.md`

**Interfaces:**
- Consumes: `python -m serversherpa_status` (Task 3), `status/web` build (Task 4), `STATUS_STATIC_DIR`.
- Produces: image `serversherpa-status`, port 8080, volume `/data`.

- [ ] **Step 1: Check the repo's .dockerignore**

Run: `ls -la .dockerignore kiosk/.dockerignore 2>/dev/null; cat .dockerignore 2>/dev/null`
If a root `.dockerignore` exists and excludes `status/` or `portal/src/styles`, STOP and report (do not edit it — it is shared with the kiosk build). If none exists, do NOT create one; the Dockerfile COPYs only the paths it needs.

- [ ] **Step 2: Write the Dockerfile**

`status/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1
# ServerSherpa public status page. Build context is the REPO ROOT: the page
# imports the portal's stylesheets from portal/src via its @portal alias
# (kiosk/Dockerfile precedent). Only CSS comes from the portal, so portal's
# own node_modules are never installed.
#
#   docker build -f status/Dockerfile -t serversherpa-status .
#   docker run -p 8095:8080 -v status-data:/data \
#       -e STATUS_API_URL=https://api.serversherpa.com \
#       -e STATUS_PORTAL_URL=https://portal.serversherpa.com \
#       -e STATUS_KIOSK_URL=https://kiosk.serversherpa.com serversherpa-status

FROM node:20-alpine AS web
WORKDIR /app
COPY status/web/package.json status/web/package-lock.json ./status/web/
RUN npm ci --prefix status/web --ignore-scripts
COPY portal/src/styles ./portal/src/styles
COPY status/web ./status/web
RUN npm --prefix status/web run build:bundle

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    STATUS_DB_PATH=/data/status.db STATUS_STATIC_DIR=/app/static PORT=8080
WORKDIR /app
COPY status/pyproject.toml ./
COPY status/src ./src
RUN pip install --no-cache-dir . && rm -rf src pyproject.toml build
COPY --from=web /app/status/web/dist /app/static
RUN useradd --system --uid 10001 status && mkdir -p /data && chown status /data
USER status
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"
CMD ["python", "-m", "serversherpa_status"]
```

Note: `portal/src/styles/*.css` may reference `url(...)` assets outside `styles/` (fonts/images). Before building, run `grep -n "url(" portal/src/styles/{base,portal-theme,directory,profile}.css`. If any resolve to files outside `portal/src/styles`, add a matching `COPY` line for that path (e.g. `COPY portal/src/assets ./portal/src/assets`) so `vite build` resolves it.

- [ ] **Step 3: Compose, env example, README**

`status/docker-compose.yml`:
```yaml
# ServerSherpa public status page — one container behind the reverse proxy
# (status.serversherpa.com → this port).
#
#   cp status/.env.example status/.env   # then edit the three URLs
#   docker compose -f status/docker-compose.yml --env-file status/.env up -d --build
#
# The CONTAINER makes the checks, so the URLs must be reachable from inside
# it: public URLs work anywhere; internal hostnames work when this joins the
# same Docker network as the services.
name: serversherpa-status

services:
  status:
    build:
      context: ..
      dockerfile: status/Dockerfile
    ports:
      - "${STATUS_PORT:-8095}:8080"
    environment:
      STATUS_API_URL: ${STATUS_API_URL:?set STATUS_API_URL in status/.env}
      STATUS_PORTAL_URL: ${STATUS_PORTAL_URL:?set STATUS_PORTAL_URL in status/.env}
      STATUS_KIOSK_URL: ${STATUS_KIOSK_URL:?set STATUS_KIOSK_URL in status/.env}
      STATUS_INTERVAL_SECONDS: ${STATUS_INTERVAL_SECONDS:-60}
      STATUS_TIMEOUT_SECONDS: ${STATUS_TIMEOUT_SECONDS:-10}
      STATUS_FAILURE_THRESHOLD: ${STATUS_FAILURE_THRESHOLD:-2}
    volumes:
      - status-data:/data
    restart: unless-stopped

volumes:
  status-data:
```

`status/.env.example`:
```
# Where the status container sends its checks (must be reachable from inside the container)
STATUS_API_URL=https://api.serversherpa.com
STATUS_PORTAL_URL=https://portal.serversherpa.com
STATUS_KIOSK_URL=https://kiosk.serversherpa.com
# Host port the reverse proxy forwards status.serversherpa.com to
STATUS_PORT=8095
# Optional tuning
# STATUS_INTERVAL_SECONDS=60
# STATUS_TIMEOUT_SECONDS=10
# STATUS_FAILURE_THRESHOLD=2
```

Note: the root `.gitignore` has `.env.*` with `!.env.example`, so `status/.env.example` is committed and `status/.env` is not.

`status/README.md`:
```markdown
# ServerSherpa status page

Public, read-only status page for `status.serversherpa.com`. No login. It checks
the API, Portal, and Kiosk every minute and shows green/red plus 90-day uptime.

## What "up" means

| Service | Check | Up when |
|---|---|---|
| API | `GET {STATUS_API_URL}/system/status` | 200 + JSON object (this reads the database) |
| Portal | `GET {STATUS_PORTAL_URL}/` | 200 + the app's `id="root"` in the page |
| Kiosk | `GET {STATUS_KIOSK_URL}/config.js` | 200 |

A service shows **down** after 2 failed checks in a row and **up** again on the first
success. Every check counts toward uptime. History lives in SQLite at `/data/status.db`
(raw checks 7 days, daily totals 90 days) — mount a volume there.

## Configuration

| Variable | Default | |
|---|---|---|
| `STATUS_API_URL` | required | |
| `STATUS_PORTAL_URL` | required | |
| `STATUS_KIOSK_URL` | required | |
| `STATUS_INTERVAL_SECONDS` | 60 | minimum 10 |
| `STATUS_TIMEOUT_SECONDS` | 10 | |
| `STATUS_FAILURE_THRESHOLD` | 2 | |
| `STATUS_DB_PATH` | `/data/status.db` | |

## Deploy

    cp status/.env.example status/.env
    docker compose -f status/docker-compose.yml --env-file status/.env up -d --build

Point the reverse proxy's `status.serversherpa.com` host at the container's port
(default host port 8095 → container 8080). `GET /healthz` is the container health check.

## Develop

    python3.13 -m venv status/.venv && status/.venv/bin/pip install -e 'status[dev]'
    (cd status && .venv/bin/pytest -q)
    npm --prefix status/web install && npm --prefix status/web test

Run the checker + API locally and the page with hot reload:

    STATUS_API_URL=http://localhost:8000 STATUS_PORTAL_URL=http://localhost:5173 \
    STATUS_KIOSK_URL=http://localhost:5174 STATUS_DB_PATH=status/dev.db \
    status/.venv/bin/python -m serversherpa_status
    npm --prefix status/web run dev      # http://localhost:5176, proxies /api to :8080

The page imports the portal's stylesheets (`portal/src/styles`) so it always matches
the portal's look.
```

Note on the dev kiosk probe: the Vite dev server serves `/config.js` from `kiosk/public` only if it exists there. Run `ls kiosk/public/config.js`; if absent, the dev kiosk (Vite) will answer `/config.js` with index.html fallback (200) — acceptable for dev. Record what you observe in the report.

- [ ] **Step 4: Build the image**

Run: `docker build -f status/Dockerfile -t serversherpa-status .` (from the worktree root; timeout 600000)
Expected: build succeeds.

- [ ] **Step 5: Live verification against the dev stack**

The dev API/portal/kiosk run on the host (ports 8000/5173/5174) — reach them from the container via `host.docker.internal`. Use a short interval:

```bash
docker run -d --name ss-status-verify -p 8095:8080 \
  -e STATUS_API_URL=http://host.docker.internal:8000 \
  -e STATUS_PORTAL_URL=http://host.docker.internal:5173 \
  -e STATUS_KIOSK_URL=http://host.docker.internal:5174 \
  -e STATUS_INTERVAL_SECONDS=10 serversherpa-status
sleep 25
curl -s localhost:8095/api/summary | python3 -m json.tool | head -40
curl -sI localhost:8095/ | head -8
docker inspect --format '{{.State.Health.Status}}' ss-status-verify
```
Expected: services the dev stack is running report `"state": "up"`; headers include the three security headers; health `healthy` (after start period). Vite may reject `Host: host.docker.internal` (allowedHosts) with 403 → that service reads down; if so, note it — it's a dev-only artifact of Vite's host check, not a status-page bug — and re-verify that service using `https://portal.dev.serversherpa.com` / `https://kiosk.dev.serversherpa.com` instead.

Then check the page renders (controller does this in the browser pane — see below) and clean up:
```bash
docker rm -f ss-status-verify
```

- [ ] **Step 6: Commit**

```bash
git add status/Dockerfile status/docker-compose.yml status/.env.example status/README.md
git commit -m "feat(status): Docker image, compose file, and README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Controller-only verification (after Task 5):** run the container again, open `http://localhost:8095/` in the browser pane, screenshot desktop and 375px widths, hover a bar for the tooltip, stop one probe target (e.g. point `STATUS_KIOSK_URL` at a dead port) and confirm it goes red after two intervals with the banner reading "1 service down".
