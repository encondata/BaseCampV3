# Status Page: Alerts, Maintenance, Background Processing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ntfy alerts on outages/recoveries/maintenance, a maintenance + announcement display, and a "Background processing" card fed by a new public worker summary in the API.

**Architecture:** The API's public `GET /system/status` gains an aggregate `background` object (no names). The status checker already fetches that endpoint; it now parses the body into an `ApiStatus` (maintenance, announcement, background), records a pseudo-service check under key `background`, and hands the latest `ApiStatus` to the summary. An `AlertWatcher` diffs displayed states after every cycle and publishes to ntfy.

**Tech Stack:** API — FastAPI/SQLAlchemy/pytest (real Postgres). Status — Python 3.13 FastAPI/httpx/sqlite/pytest+respx; Vite/React/TS + vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-status-alerts-maintenance-background-design.md` (on branch `status-page`).

## Global Constraints

- Two worktrees. **Task 1 only:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/public-background-status` (branch `public-background-status`, off `main`). **Tasks 2–4:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/status-page` (branch `status-page`). Never touch the main checkout; never merge or push.
- Never show or send service URLs, hostnames, worker names, or probe error detail — in `/api/summary`, `/system/status`, the page, or alerts. Titles only. The only link allowed in an alert is `STATUS_PUBLIC_URL` as the `click` target.
- Background: `kind == "worker"` rows only; `stopped` rows excluded; `running` counts `running`+`paused`; state `down` if any `failed`, else `paused` if any `paused`, else `running`; `null` when no rows remain.
- Maintenance/announcement messages: trimmed, empty → `None`, capped at 500 characters, plain text.
- `overall` precedence: `degraded` (any down) → `maintenance` (active) → `operational` (all up/paused) → `unknown`.
- Background card key `background`, title `Background processing`; ok unless reported `down`; `paused` display when tracked `up` and latest report `paused`.
- ntfy env: `STATUS_NTFY_TOPIC` (enables; `^[A-Za-z0-9_-]{1,64}$`), `STATUS_NTFY_SERVER` (default `https://ntfy.sh`), `STATUS_NTFY_TOKEN` (optional Bearer), `STATUS_PUBLIC_URL` (optional click). Publish = `POST {server}/` JSON `{topic,title,message,priority,tags[,click]}`, 10 s timeout, failures logged never raised.
- Alert table: up/unknown→down "{Name} is down" p4 `rotating_light`; down→up "{Name} is back up" (+ "Down for …") p3 `white_check_mark`; maintenance off→on "Maintenance started" (+message) p2 `construction`; on→off "Maintenance ended" p2 `white_check_mark`. Paused never alerts; first maintenance observation never alerts; seeding never alerts.
- American English. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run every suite in the FOREGROUND with a 600000 ms timeout; never background a suite and end your turn waiting.

---

### Task 1: API — public background summary on `/system/status`

**Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/public-background-status`

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (`SystemStatusOut`, new `BackgroundStatusOut`)
- Modify: `api/src/serversherpa/api/routes/system.py` (`_status_from`, `system_status`)
- Test: `api/tests/test_system_admin_api.py`

**Interfaces:**
- Produces (public JSON): `"background": {"state": "running"|"down"|"paused", "running": int, "total": int} | null` on `GET /system/status`.

**Test setup notes:** tests use the shared API conftest (real Postgres). In a worktree, run with a private test DB and the worktree source first on the path:
```bash
cd api && SS_TEST_DB=serversherpa_test_pbs PYTHONPATH=src ../../../../api/.venv/bin/pytest -q tests/test_system_admin_api.py
```
First, if the worktree has no `.env`, symlink the main checkout's (never copy it): `ln -s /Users/jrh1812/Developer/BaseCampV3/.env /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/public-background-status/.env` — and never commit it (it is git-ignored).
(The venv lives in the main checkout: `/Users/jrh1812/Developer/BaseCampV3/api/.venv`. conftest creates and migrates `serversherpa_test_pbs` itself.) Create `SystemProcess` rows directly like `tests/test_db_testing.py:124` does. The `processes` table is truncated between tests by conftest.

- [ ] **Step 1: Write failing tests** (append to `api/tests/test_system_admin_api.py`; also update `test_status_is_public_and_defaults_off` to expect `"background": None`):

```python
from datetime import UTC, datetime, timedelta

from serversherpa.db.models import SystemProcess


async def _proc(db, name, kind="worker", *, beat_age=1, stopped=False, paused=False):
    now = datetime.now(UTC)
    beat = now - timedelta(seconds=beat_age)
    db.add(SystemProcess(
        name=name, kind=kind, pid=1, hostname="h", started_at=beat - timedelta(hours=1),
        heartbeat_at=beat, stopped_at=(beat + timedelta(seconds=1)) if stopped else None,
        meta={"paused": True} if paused else None,
    ))
    await db.commit()


async def test_background_null_without_workers(client, db):
    await _proc(db, "api", kind="service")
    assert (await client.get("/system/status")).json()["background"] is None


async def test_background_running(client, db):
    await _proc(db, "scan-matching-worker")
    await _proc(db, "import-worker")
    assert (await client.get("/system/status")).json()["background"] == {
        "state": "running", "running": 2, "total": 2}


async def test_background_down_when_a_heartbeat_is_stale(client, db):
    await _proc(db, "scan-matching-worker", beat_age=600)
    await _proc(db, "import-worker")
    assert (await client.get("/system/status")).json()["background"] == {
        "state": "down", "running": 1, "total": 2}


async def test_background_ignores_cleanly_stopped_workers(client, db):
    await _proc(db, "report-worker", beat_age=600, stopped=True)
    await _proc(db, "import-worker")
    assert (await client.get("/system/status")).json()["background"] == {
        "state": "running", "running": 1, "total": 1}


async def test_background_paused(client, db):
    await _proc(db, "import-worker", paused=True)
    await _proc(db, "label-worker")
    assert (await client.get("/system/status")).json()["background"] == {
        "state": "paused", "running": 2, "total": 2}


async def test_background_down_wins_over_paused(client, db):
    await _proc(db, "import-worker", paused=True)
    await _proc(db, "label-worker", beat_age=600)
    assert (await client.get("/system/status")).json()["background"]["state"] == "down"


async def test_background_ignores_services_and_probes(client, db):
    await _proc(db, "api", kind="service", beat_age=600)
    await _proc(db, "web", kind="probe", beat_age=600)
    await _proc(db, "import-worker")
    assert (await client.get("/system/status")).json()["background"] == {
        "state": "running", "running": 1, "total": 1}


async def test_background_never_names_workers(client, db):
    await _proc(db, "scan-matching-worker", beat_age=600)
    body = (await client.get("/system/status")).text
    assert "scan-matching" not in body and "worker" not in body.replace('"workers_paused"', "")
```

- [ ] **Step 2: Run to verify failure** — expected: KeyError / assertion on `background`.

- [ ] **Step 3: Implement**

`schemas.py` (above `SystemStatusOut`):
```python
class BackgroundStatusOut(BaseModel):
    """Aggregate worker health for the public status page — counts only,
    never process names."""

    state: Literal["running", "down", "paused"]
    running: int
    total: int
```
and add `background: BackgroundStatusOut | None = None` to `SystemStatusOut` (check `Literal` is imported in schemas.py; add `from typing import Literal` if not).

`routes/system.py`:
```python
async def _background(db) -> BackgroundStatusOut | None:
    now = datetime.now(UTC)
    rows = (await db.scalars(
        select(SystemProcess).where(SystemProcess.kind == "worker"))).all()
    statuses = [derive_status(p.heartbeat_at, p.stopped_at, now, meta=p.meta) for p in rows]
    # a clean stop (deploy, deliberate shutdown) is not an outage
    statuses = [s for s in statuses if s != "stopped"]
    if not statuses:
        return None
    if "failed" in statuses:
        state = "down"
    elif "paused" in statuses:
        state = "paused"
    else:
        state = "running"
    alive = sum(1 for s in statuses if s in ("running", "paused"))
    return BackgroundStatusOut(state=state, running=alive, total=len(statuses))
```
`_status_from(cfg)` gains a `background` parameter passed into `SystemStatusOut(...)`; `system_status` becomes:
```python
    return _status_from(await read_admin_config(db), await _background(db))
```
Check every other caller of `_status_from` (grep) and pass `None` or the real value as appropriate — if `PUT /system/admin` returns a `SystemStatusOut`, keep its shape valid. Update the route docstring: "Public: the login page shows banners before anyone signs in; the status page reads worker health (counts only)."

- [ ] **Step 4: Run** `tests/test_system_admin_api.py` then the whole `tests/` suite once (foreground, 600000 ms; the full suite takes ~15+ minutes). Expected: all pass.

- [ ] **Step 5: Commit** — `feat(api): public worker-health summary on /system/status (counts only)`

---

### Task 2: Status backend — parse API status, background pseudo-service, maintenance in the summary

**Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/status-page` (venv `status/.venv`; `cd status && .venv/bin/pytest -q`)

**Files:**
- Create: `status/src/serversherpa_status/api_status.py`, `status/tests/test_api_status.py`
- Modify: `probes.py` (payload), `checker.py`, `summary.py`, `app.py`, `state.py` only if needed
- Modify tests: `test_probes.py`, `test_checker.py`, `test_summary.py`, `test_app.py`

**Interfaces:**
- Consumes: Task 1's JSON shape (tolerantly — it may be absent).
- Produces:
  - `probes.ProbeResult(ok, latency_ms, detail, payload: dict | None = None)` — `payload` is the parsed JSON object for a successful `api` probe, else `None`.
  - `api_status.BACKGROUND_KEY = "background"`, `BACKGROUND_NAME = "Background processing"`, `MESSAGE_MAX = 500`.
  - `api_status.Background(state: str, running: int, total: int)` frozen; `api_status.ApiStatus(maintenance: bool, maintenance_message: str | None, announcement: str | None, background: Background | None)` frozen.
  - `api_status.parse_api_status(payload: dict) -> ApiStatus` — never raises; bad/missing fields → falsy/None; `background` only when `state in {"running","down","paused"}` and `running`/`total` are non-negative ints.
  - `api_status.LatestApiStatus` — holder with `.set(value: ApiStatus | None, at: datetime)`, `.get(now: datetime, stale_after: float) -> ApiStatus | None` (None when unset or older than `stale_after` seconds).
  - `Checker(settings, store, tracker, client, clock=utcnow, latest: LatestApiStatus | None = None)`; `seed_tracker` also seeds `BACKGROUND_KEY`.
  - `StateTracker` in `app.py` is built with keys `[s.key for s in settings.services] + [BACKGROUND_KEY]`; `app.state.latest_api_status` holds the `LatestApiStatus`.
  - `build_summary(settings, store, tracker, now, latest: LatestApiStatus | None = None) -> dict` — adds `maintenance`, `announcement`, background entry, new `overall`.

- [ ] **Step 1: Failing tests.** Write these (exact assertions):
  - `test_api_status.py`:
    - `parse_api_status({"read_only": True, "read_only_message": "  Cutover  ", "banner": "Hi", "background": {"state": "down", "running": 1, "total": 3}})` → `ApiStatus(True, "Cutover", "Hi", Background("down", 1, 3))`.
    - `{}` → `ApiStatus(False, None, None, None)`; `{"read_only": "yes"}` → maintenance `False` (only real `True` counts); blank messages → `None`; a 600-char message → length 500.
    - background rejected (→ None) for: missing state, `state: "exploded"`, `running: -1`, `total: "9"`, `background: []`.
    - `LatestApiStatus`: `.get` returns None before `.set`; returns the value when fresh; None when older than `stale_after`; `.set(None, t)` clears.
  - `test_probes.py`: successful api probe → `r.payload == {"read_only": False}`; portal/kiosk/wiki success → `payload is None`; failed api probe → `payload is None`.
  - `test_checker.py` (respx routes as existing tests do):
    - API returns `background: {"state": "running", ...}` → after one cycle `tracker.snapshot("background").state == "up"` and `store.recent("background", 5)` has one ok row; `latest.get(...)` has the parsed status.
    - background `"down"` for two cycles → tracker `down`; `"paused"` → recorded ok.
    - API without `background` → no `background` rows recorded.
    - API probe failing → `latest.get(...) is None` and no `background` row recorded that cycle.
    - `seed_tracker` seeds `background` from history.
  - `test_summary.py`:
    - background entry present only once `tracker.snapshot("background").last_checked_at` is set; it is the LAST service, `key == "background"`, `name == "Background processing"`, `latency_ms is None`, and carries `"workers": {"running": 7, "total": 9}` from the latest report (`"workers": None` when no fresh report). Regular services carry no `workers` key.
    - tracked up + latest report `paused` → entry `state == "paused"`; overall `operational` when everything else up.
    - maintenance active → `summary["maintenance"] == {"active": True, "message": "Cutover"}`, overall `maintenance`; with a service down → overall `degraded`.
    - no latest status (None or stale) → `maintenance is None`, `announcement is None`.
    - announcement passes through; no URL/hostname appears in `repr(summary)` (reuse the existing leak test's pattern).
  - `test_app.py`: `/api/summary` includes `maintenance` and `announcement` keys; set `client.app.state.latest_api_status.set(ApiStatus(True, "M", None, None), now)` → `overall == "maintenance"`.

- [ ] **Step 2: Run** — expect failures (module missing, keys missing).

- [ ] **Step 3: Implement.** Key code:

`api_status.py`:
```python
"""What the API's public /system/status says beyond "I'm up": maintenance
mode, the broadcast announcement, and aggregate worker health. Parsed
tolerantly — an older or odd API simply yields "not known"."""

from dataclasses import dataclass
from datetime import datetime

BACKGROUND_KEY = "background"
BACKGROUND_NAME = "Background processing"
MESSAGE_MAX = 500
_STATES = {"running", "down", "paused"}


@dataclass(frozen=True)
class Background:
    state: str
    running: int
    total: int


@dataclass(frozen=True)
class ApiStatus:
    maintenance: bool
    maintenance_message: str | None
    announcement: str | None
    background: Background | None


def _text(value) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:MESSAGE_MAX] or None


def _count(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _background(value) -> Background | None:
    if not isinstance(value, dict) or value.get("state") not in _STATES:
        return None
    running, total = _count(value.get("running")), _count(value.get("total"))
    if running is None or total is None:
        return None
    return Background(value["state"], running, total)


def parse_api_status(payload: dict) -> ApiStatus:
    maintenance = payload.get("read_only") is True
    return ApiStatus(
        maintenance=maintenance,
        maintenance_message=_text(payload.get("read_only_message")) if maintenance else None,
        announcement=_text(payload.get("banner")),
        background=_background(payload.get("background")),
    )


class LatestApiStatus:
    def __init__(self) -> None:
        self._value: ApiStatus | None = None
        self._at: datetime | None = None

    def set(self, value: ApiStatus | None, at: datetime) -> None:
        self._value, self._at = value, at

    def get(self, now: datetime, stale_after: float) -> ApiStatus | None:
        if self._value is None or self._at is None:
            return None
        if (now - self._at).total_seconds() > stale_after:
            return None
        return self._value
```

`probes.py`: add `payload: dict | None = None` to `ProbeResult`; `_body_problem` for api keeps its check; on success for `service.key == "api"` return `ProbeResult(True, latency, "", resp.json())` (it is known to be a dict).

`checker.py` `run_cycle`, after the per-service loop and before pruning:
```python
        api_result = next((r for s, r in zip(services, results) if s.key == "api"), None)
        status = parse_api_status(api_result.payload) if api_result and api_result.ok and api_result.payload else None
        if self._latest is not None:
            self._latest.set(status, now)
        if status is not None and status.background is not None:
            ok = status.background.state != "down"
            self._tracker.record(BACKGROUND_KEY, ok, None, now)
            try:
                self._store.record(BACKGROUND_KEY, now, ok, None,
                                   "" if ok else "workers down")
            except Exception:
                store_ok = False
                log.exception("failed to record background check")
```
`seed_tracker` loops over `[s.key for s in settings.services] + [BACKGROUND_KEY]`.

`summary.py`: build the regular entries as today, then:
```python
    latest_status = latest.get(now, stale_after) if latest is not None else None
    bg_snap = tracker.snapshot(BACKGROUND_KEY)
    if bg_snap.last_checked_at is not None:
        # same staleness handling as services; "paused" overrides a tracked "up"
        ...
        entry["workers"] = (
            {"running": latest_status.background.running, "total": latest_status.background.total}
            if latest_status and latest_status.background else None)
```
Refactor the per-entry construction into one helper used for services and background (no duplicated staleness logic). Overall per the Global Constraints precedence, treating `paused` like `up`. Add:
```python
    "maintenance": ({"active": latest_status.maintenance, "message": latest_status.maintenance_message}
                    if latest_status is not None else None),
    "announcement": latest_status.announcement if latest_status is not None else None,
```
`app.py`: create `latest = LatestApiStatus()` in the lifespan, store on `app.state.latest_api_status`, pass to `Checker(..., latest=latest)` and to `build_summary(..., latest=state.latest_api_status)`. The 5 s summary cache stays.

- [ ] **Step 4: Run** full `status` pytest (foreground). Expected: all pass, no warnings.

- [ ] **Step 5: Commit** — `feat(status): read maintenance, announcement, and worker health from the API; background card data`

---

### Task 3: Status page — maintenance banner, announcement, Background card

**Worktree:** status-page (`npm --prefix status/web test`, `npm --prefix status/web run build`)

**Files:**
- Modify: `status/web/src/lib/summary.ts`, `components/StatusBanner.tsx`, `components/ServiceCard.tsx`, `App.tsx`, `styles/status.css`
- Test: `status/web/src/components/components.test.tsx`, `status/web/src/App.test.tsx`

**Interfaces:**
- Consumes (Task 2 JSON): `overall` may be `"maintenance"`; `maintenance: {active, message} | null`; `announcement: string | null`; a service entry may have `state: "paused"` and (background only) `workers: {running, total} | null`.
- Produces TS: `ServiceState = 'up' | 'down' | 'unknown' | 'paused'`; `Overall = 'operational' | 'degraded' | 'maintenance' | 'unknown'`; `ServiceSummary.workers?: { running: number; total: number } | null`; `Summary.maintenance: { active: boolean; message: string | null } | null`; `Summary.announcement: string | null`.

- [ ] **Step 1: Failing tests** (plain `.textContent` assertions, no jest-dom):
  - `StatusBanner overall="maintenance" maintenance={{active:true, message:'Cutover until 14:00'}}` → role=status text contains `Scheduled maintenance` and `Cutover until 14:00`; has class `ss-banner-maintenance`.
  - maintenance with `message: null` → just `Scheduled maintenance`.
  - `degraded` still says `1 service down` even if maintenance is passed (precedence is decided server-side; the banner follows `overall`).
  - `ServiceCard` background entry `{state:'paused', workers:{running:9,total:9}, latency_ms:null}` → chip `Paused` with class `ss-chip-paused`, a `Workers` stat reading `9 of 9 running`, and no `Response time` label.
  - background `workers: null` → `Workers` stat `—`.
  - regular service cards still show `Response time` (no `Workers`).
  - `App` with `announcement: 'Hello all'` → an element with class `ss-announcement` containing `Hello all`; with `announcement: null` → none.
  - `App` never renders `http`/`serversherpa.com` (existing test keeps passing with the new fields in the fixture — update the fixture with `maintenance: null, announcement: null`).

- [ ] **Step 2: Run** — expect failures.

- [ ] **Step 3: Implement**
  - `StatusBanner` props `{ overall, services, maintenance }`; `maintenance` tone → text `Scheduled maintenance` plus, when present, a second line `<span className="ss-banner-detail">{message}</span>`; tone class `ss-banner-maintenance`, dot `ss-dot-maintenance`.
  - `ServiceCard`: `STATE_WORD` gains `paused: 'Paused'`; when `s.workers !== undefined` (background entry) render `<div><dt>Workers</dt><dd>{s.workers ? `${s.workers.running} of ${s.workers.total} running` : '—'}</dd></div>` in place of Response time.
  - `App.tsx`: pass `maintenance={data.maintenance}` to the banner; render `{data.announcement && <div className="ss-announcement" role="note">{data.announcement}</div>}` directly under the header (above the stale notice).
  - `status.css` (portal tokens; amber = `--c-amber*`, blue = `--c-blue*`):
    ```css
    .ss-dot-maintenance, .ss-dot-paused { background: var(--c-amber); }
    .ss-banner-maintenance { background: var(--c-amber-bg); border-color: var(--c-amber-bd); color: var(--c-amber); flex-wrap: wrap; }
    .ss-banner-detail { flex-basis: 100%; margin-left: 22px; font-weight: 400; font-size: 14px; color: var(--text-dark); }
    .ss-chip-paused { color: var(--c-amber); background: var(--c-amber-bg); border-color: var(--c-amber-bd); }
    .ss-announcement { margin-bottom: 16px; padding: 12px 16px; border-radius: 10px; border: 1px solid var(--c-blue-bd); background: var(--c-blue-bg); color: var(--text-dark); font-size: 14px; white-space: pre-line; }
    ```

- [ ] **Step 4: Run** `npm --prefix status/web test` and `npm --prefix status/web run build` — all pass, tsc clean.

- [ ] **Step 5: Commit** — `feat(status): maintenance banner, announcement note, and the Background processing card`

---

### Task 4: ntfy alerts + test command + docs

**Worktree:** status-page

**Files:**
- Create: `status/src/serversherpa_status/alerts.py`, `status/tests/test_alerts.py`
- Modify: `config.py` (+`NtfyConfig`, `Settings.ntfy`), `checker.py`, `app.py`, `__main__.py`, `tests/test_config.py`, `tests/test_checker.py`
- Docs: `status/README.md`, `status/.env.example`, `status/docker-compose.yml`

**Interfaces:**
- Consumes: `StateTracker.snapshot(key).state`, `LatestApiStatus`, `BACKGROUND_KEY`/`BACKGROUND_NAME` (Task 2).
- Produces:
  - `config.NtfyConfig(server: str, topic: str, token: str | None, click_url: str | None)` frozen; `Settings.ntfy: NtfyConfig | None` (None unless `STATUS_NTFY_TOPIC` set). Validation: topic `^[A-Za-z0-9_-]{1,64}$`, server and public URL must start with `http://`/`https://` (trailing `/` stripped) → `ConfigError` naming the variable.
  - `alerts.Alert(title: str, message: str, priority: int, tags: tuple[str, ...])` frozen.
  - `alerts.AlertWatcher(names: dict[str, str])` with `.prime(states: dict[str, str])` and `.evaluate(states: dict[str, str], maintenance: bool | None, maintenance_message: str | None, now: datetime) -> list[Alert]`.
  - `alerts.format_duration(seconds: float) -> str` — `under a minute`, `14 min`, `2 h 5 min`, `3 h`.
  - `async alerts.publish(client: httpx.AsyncClient, cfg: NtfyConfig, alert: Alert) -> bool`.
  - `Checker(..., watcher: AlertWatcher | None = None)`; `python -m serversherpa_status test-alert`.

- [ ] **Step 1: Failing tests** — `test_alerts.py`:
  - `format_duration`: 30 → `under a minute`; 14*60+20 → `14 min`; 2*3600+5*60 → `2 h 5 min`; 3*3600 → `3 h`.
  - Watcher primed `{"kiosk": "up"}`; evaluate `{"kiosk": "down"}` → one `Alert("Kiosk is down", <message>, 4, ("rotating_light",))`; evaluating `down` again → `[]`; later `{"kiosk": "up"}` 14 min after → `Alert("Kiosk is back up", "Down for 14 min", 3, ("white_check_mark",))`.
  - primed `down` (from history) then `up` → recovery alert whose message does not include "Down for" (start unknown).
  - `unknown → down` alerts; `unknown → up` does not; `up → unknown` does not.
  - maintenance: first `evaluate(..., maintenance=True, ...)` → no maintenance alert; then `False` → `Alert("Maintenance ended", …, 2, ("white_check_mark",))`; then `True` with message "Cutover" → `Alert("Maintenance started", "Cutover", 2, ("construction",))`; `None` leaves the previous value untouched (no alert, and a later flip still compares with the last known value).
  - titles use `names` (e.g. `"background" → "Background processing is down"`); `repr` of every alert contains no `http`.
  - `publish` with respx: posts to `https://ntfy.test/` JSON `{"topic","title","message","priority","tags"}` (+`"click"` only when `click_url` set), `Authorization: Bearer tok` only when token set; returns True on 200; returns False (no raise) on 500 and on `httpx.ConnectError`.
  - `test_config.py`: no topic → `ntfy is None`; topic set → defaults (`https://ntfy.sh`, token None, click None); bad topic `"has space"` → ConfigError naming `STATUS_NTFY_TOPIC`; `STATUS_NTFY_SERVER="ntfy.sh"` → ConfigError; `STATUS_PUBLIC_URL` trailing slash stripped.
  - `test_checker.py`: with a watcher + ntfy route mocked, kiosk failing for two cycles → exactly one POST to ntfy with title `Kiosk is down`; a watcher-less Checker makes no ntfy request; an ntfy 500 doesn't stop the cycle (tracker still updated).
  - `test-alert` command (test via `serversherpa_status.__main__.run_test_alert(settings) -> int`, respx): returns 0 on 200, 1 on 500, 2 when `settings.ntfy is None`.

- [ ] **Step 2: Run** — expect failures.

- [ ] **Step 3: Implement.** Key code for `alerts.py`:
```python
"""Push alerts to ntfy when the displayed state changes. Titles only —
never URLs or probe detail — and a failed publish never affects checks."""

import logging
from dataclasses import dataclass
from datetime import datetime

import httpx

from serversherpa_status.config import NtfyConfig

log = logging.getLogger("serversherpa_status.alerts")
PUBLISH_TIMEOUT = 10.0


@dataclass(frozen=True)
class Alert:
    title: str
    message: str
    priority: int
    tags: tuple[str, ...]


def format_duration(seconds: float) -> str:
    minutes = int(seconds // 60)
    if minutes < 1:
        return "under a minute"
    hours, minutes = divmod(minutes, 60)
    if not hours:
        return f"{minutes} min"
    return f"{hours} h {minutes} min" if minutes else f"{hours} h"


class AlertWatcher:
    def __init__(self, names: dict[str, str]) -> None:
        self._names = names
        self._states: dict[str, str] = {}
        self._down_since: dict[str, datetime] = {}
        self._maintenance: bool | None = None

    def prime(self, states: dict[str, str]) -> None:
        self._states = dict(states)

    def evaluate(self, states, maintenance, maintenance_message, now) -> list[Alert]:
        alerts = []
        for key, new in states.items():
            old = self._states.get(key, "unknown")
            name = self._names.get(key, key)
            if new == "down" and old in ("up", "unknown"):
                self._down_since[key] = now
                alerts.append(Alert(f"{name} is down",
                                    f"{name} failed its last checks.", 4, ("rotating_light",)))
            elif new == "up" and old == "down":
                since = self._down_since.pop(key, None)
                message = (f"Down for {format_duration((now - since).total_seconds())}"
                           if since else f"{name} is responding again.")
                alerts.append(Alert(f"{name} is back up", message, 3, ("white_check_mark",)))
            self._states[key] = new
        if maintenance is not None:
            if self._maintenance is False and maintenance:
                alerts.append(Alert("Maintenance started",
                                    maintenance_message or "The system is in read-only maintenance mode.",
                                    2, ("construction",)))
            elif self._maintenance is True and not maintenance:
                alerts.append(Alert("Maintenance ended", "Read-only maintenance mode is off.",
                                    2, ("white_check_mark",)))
            self._maintenance = maintenance
        return alerts


async def publish(client: httpx.AsyncClient, cfg: NtfyConfig, alert: Alert) -> bool:
    body = {"topic": cfg.topic, "title": alert.title, "message": alert.message,
            "priority": alert.priority, "tags": list(alert.tags)}
    if cfg.click_url:
        body["click"] = cfg.click_url
    headers = {"Authorization": f"Bearer {cfg.token}"} if cfg.token else {}
    try:
        resp = await client.post(f"{cfg.server}/", json=body, headers=headers, timeout=PUBLISH_TIMEOUT)
    except httpx.HTTPError as exc:
        log.warning("ntfy publish failed: %s", type(exc).__name__)
        return False
    if resp.status_code >= 300:
        log.warning("ntfy publish failed: HTTP %s", resp.status_code)
        return False
    return True
```
Checker integration (end of `run_cycle`, after the background block; states are raw tracker states, not staleness-adjusted):
```python
        if self._watcher is not None and self._settings.ntfy is not None:
            keys = [s.key for s in services] + [BACKGROUND_KEY]
            states = {k: self._tracker.snapshot(k).state for k in keys}
            alerts = self._watcher.evaluate(
                states, status.maintenance if status else None,
                status.maintenance_message if status else None, now)
            for alert in alerts:
                await publish(self._client, self._settings.ntfy, alert)
```
`app.py` lifespan: after `seed_tracker`, when `settings.ntfy` is set build `AlertWatcher({s.key: s.name for s in settings.services} | {BACKGROUND_KEY: BACKGROUND_NAME})`, `prime` it from the seeded tracker states, and pass it to the `Checker`. `__main__.py`: `run_test_alert(settings) -> int` (async publish of `Alert("Test alert", "The ServerSherpa status page can reach this topic.", 3, ("white_check_mark",))` with a fresh `httpx.AsyncClient`; prints a one-line result) and `main()` dispatches `sys.argv[1:] == ["test-alert"]` to it after loading settings (`sys.exit(run_test_alert(settings))`).

Docs:
- `.env.example`: commented block for the four ntfy vars with a note to pick a long random topic, e.g. `serversherpa-status-7f3k9q2m`.
- `docker-compose.yml`: pass through `STATUS_NTFY_TOPIC`, `STATUS_NTFY_SERVER`, `STATUS_NTFY_TOKEN`, `STATUS_PUBLIC_URL` with `${VAR:-}` defaults.
- `README.md`: an "Alerts (ntfy)" section (subscribe in the ntfy app to the topic; env vars; the event table; `docker compose -f status/docker-compose.yml --env-file status/.env exec status python -m serversherpa_status test-alert`; public topics are readable by anyone who knows the name; the status box can't alert about itself), a "Maintenance and background processing" section (what the amber banner and the card mean; the card needs an API that reports `background`; a retired worker counts as down until its Processes row is deleted), and the config table rows.

- [ ] **Step 4: Run** full `status` pytest + vitest + build (foreground). All pass, no warnings.

- [ ] **Step 5: Commit** — `feat(status): ntfy alerts for outages, recoveries, and maintenance; test-alert command`

---

**Controller-only verification (after Task 4):**
1. Run the Task 1 API from its worktree on port 8001 against the dev DB (the dev DB has six dead workers → background should read `down`).
2. Run a local ntfy server: `docker run -d --name ss-ntfy -p 8099:80 binwiederhier/ntfy serve`, subscribe with `curl -s localhost:8099/<topic>/json`.
3. Rebuild the status image; run it with `STATUS_API_URL=http://host.docker.internal:8001`, `STATUS_NTFY_SERVER=http://host.docker.internal:8099`, `STATUS_NTFY_TOPIC=ss-verify`, interval 10. Confirm: Background card red with "N of M running"; a "Background processing is down" alert arrives; `test-alert` arrives; toggling read-only in the dev portal shows the amber banner and a "Maintenance started" alert, and turning it off sends "Maintenance ended"; the page never shows a URL. Screenshot desktop + mobile.
