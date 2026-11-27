# Move Load Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone tool that runs a whole simulated move against a BaseCamp server at real-time or fast speed, started and watched from its own web page, ending in a Pass / Pass with warnings / Fail result.

**Architecture:** A new top-level `loadtest/` Python package. A pipeline engine moves servers through the profile's stages on an injectable clock; an actions layer turns each step into the same HTTP calls real devices make (32 simulated kiosk devices plus one portal sign-in); a runner owns the run, journals every finished step so a run can be continued, and feeds a small FastAPI app that serves the page and a server-sent-events stream.

**Tech Stack:** Python 3.11+ (3.13 on this Mac), `httpx==0.28.1`, `fastapi==0.141.1`, `uvicorn==0.52.4`, `tomllib`, pytest + pytest-asyncio (`asyncio_mode = "auto"`), vanilla HTML/CSS/JS for the page.

**Spec:** `docs/superpowers/specs/2026-11-27-move-load-test-design.md` — read it before any task.

## Global Constraints

- **No server code changes.** Nothing under `api/`, `portal/`, `kiosk/`, `Android_Kiosk_App/`, `IOS_Kiosk_App/` is edited. The server code is read-only reference.
- **`loadtest/` imports nothing from `serversherpa`.** It must run on a machine that has only this folder.
- **Credentials** (portal password, move password, 2FA code, tokens, station keys, cookies) live in memory only. They never reach the journal, `events.log`, `results.json`, the feed, exception text sent to the page, or test snapshots.
- **Device names** start with `Load test` and serials with `LOADTEST-`.
- **Copy** is American English. Times on the page are 24-hour `HH:MM:SS`.
- **The page** follows light and dark (`prefers-color-scheme`, same tokens as the generator page), never shows a default browser scrollbar, and keeps Start, Stop and Continue visible without scrolling.
- **No charts** and no page elements beyond what the spec's page section lists.
- **Tests run in the foreground** in one continuous command with an explicit timeout. Never background a test run and end the turn.
- **Never touch the dev database or the running dev workers.** Only Task 15 talks to a real server, and only to the scratch stack it starts itself.
- **Commits** end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Work happens on branch `move-load-test` in its own worktree; nothing is merged or pushed.
- **Run tests with:** `cd loadtest && .venv/bin/python -m pytest -q` (Task 1 creates the venv).

## Review Focus

Inputs the spec implies that are most likely to bite, each pinned by a test in the task named:

1. **The server goes away for minutes mid-run** (network drop, API restart). Devices back off and recover; the run does not die; heartbeat failures never fail the run. → Task 9.
2. **A move that does not divide evenly or is tiny** (3 servers; 45 servers; 17 containers). Short last cart, short last container, short last truck, and a move smaller than one cart all finish. → Tasks 4 and 5.
3. **A sign-in that ends mid-run** (24-hour limit, or a lost refresh answer). The device signs in again and the step in hand still lands. → Tasks 7 and 8.
4. **The page is closed, reopened, or open twice; Start is pressed twice.** One run only; a reopened page shows current progress and the feed. → Tasks 12 and 13.
5. **A journal cut off mid-line by a crash, next to finished runs.** Continue finds the right run and ignores the torn line. → Task 3.

## File Structure

```
loadtest/
  README.md                     how to install, start, run, read a result
  pyproject.toml
  .gitignore                    .venv, runs/
  profiles/real-time.toml       every number from the spec's stage tables
  profiles/fast.toml            same stages, 0.5–1 s waits
  src/loadtest/
    __main__.py                 `python -m loadtest` → uvicorn on 0.0.0.0:8795
    profile.py                  Profile dataclasses, load + validate
    clock.py                    Clock protocol, RealClock, FakeClock
    ids.py                      scan ids, tags, device serials and names
    state.py                    RunState: servers, containers, trucks
    journal.py                  JSONL journal: append, replay, find unfinished
    pipeline.py                 stage engine (pure; no HTTP)
    metrics.py                  call timings, counters, time series
    http.py                     timed call with retry rules
    route.py                    OSRM fetch, points along a road line
    client/kiosk.py             one simulated kiosk device
    client/portal.py            the portal sign-in and its reads/writes
    fleet.py                    builds and runs the 32 devices
    actions.py                  Step → device/portal calls, feed lines
    preflight.py                readiness checks
    sampler.py                  backlog / progress / health sampling loop
    finalcheck.py               final check + verdict
    results.py                  results.json assembly
    events.py                   feed ring buffer, events.log, subscribers
    runner.py                   connect → check → start/stop/continue
    web/app.py                  FastAPI routes + SSE
    web/static/index.html       generator page copy + Simulate
    web/static/simulate.js
    web/static/simulate.css
  tests/
    conftest.py
    fakeserver.py               in-process fake BaseCamp API
    test_*.py                   one per module
    e2e/scratch_stack.sh        Task 15: start/stop a scratch server
    e2e/make_move.py            Task 15: create a move on the scratch server
```

## Server Contract

The real server is the source of truth. Paths are under `api/src/serversherpa/`; `K` = `api/routes/kiosk.py`, `SCH` = `api/schemas.py`. Before writing a client call or its fake, open the cited route and schema and copy the real field names.

**Kiosk side** (bearer token from a kiosk sign-in unless noted)

| Call | Where | Notes |
|---|---|---|
| `POST /kiosk/move-login {password}` | K:283, SCH:252 | Returns `SessionOut` (`access_token`, `expires_in`, `session_expires_at`) and sets cookie `ss_refresh` (path `/auth`). |
| `POST /auth/refresh?client=kiosk` | `api/routes/auth.py:293` | Rotates the cookie every time. Replaying an old cookie revokes the sign-in. |
| `POST /kiosk/heartbeat` | K:471, SCH:431 | `{serial, name, mode, sign_in, login_method}`. `mode` is `"web"` for handhelds, `"laptop"` for stations. `login_method` is `"password"` (there is no `"move"`). The first beat binds the session to the serial and registers the device. |
| `POST /kiosk/setup` | K:~820–940, SCH:3942 | `{serial, initiative_id, site_id, scan_status, station_type?, reader?}`. `station_type` `"rfid"` needs `reader` (`ip`, `serial`, `model`, `versions`; SCH:3923) and a laptop device; `"label"` needs no reader. |
| `POST /kiosk/station-key {serial}` | K:944 | Returns `{key}` once. Later calls send `Authorization: Station <key>`. |
| `GET /kiosk/sync/assets?initiative_id=` | K:1018 | Also `/kiosk/sync/containers` (K:1161), `/kiosk/sync/trucks` (K:2362), and the people and label-template sync calls `kiosk/src/lib/sync.ts` makes. |
| `POST /kiosk/assets/{asset_id}/rfid` | K:1835, SCH:4218 | `{serial, rfid_tag, scan_status, client_scan_id, site_id, initiative_id}`. 409 `rfid_in_use`. |
| `POST /kiosk/scans` | K:1566, SCH:4096–4125 | `{serial, scans:[{client_scan_id, scanned_value, scan_type, scanned_at, site_id, initiative_id, scan_status}]}`, ≤100. Reply lists accepted and rejected rows. |
| `POST /kiosk/station/scans` | K:1734, SCH:4128 | Station key. ≤50. RFID Station: `scan_type "rfid"` only. Label Station: `"barcode"` only, status forced to `labeled`. Checkpoint and site may be sent per scan. |
| `POST /kiosk/station/heartbeat` | K:1775 | Station key, RFID Stations only (a Label Station key gets 401). |
| `POST /kiosk/containers/{id}/assets` | K:2125, SCH:4525 | `{serial, asset_id, action: "pack"|"unpack", scanned_value, scan_type, scan_status, client_scan_id, site_id, initiative_id}`. Repeated unpack → 409 `not_in_container`. |
| `POST /kiosk/trucks/{id}/containers` | K:2426, SCH:4659 | `{serial, container_id, action: "load"|"unload", scanned_value, scan_type, scan_status, client_scan_id, …}`. Repeated unload → 409 `not_on_truck`. `scanned_value` is the container's name, `scan_type "barcode"`. |

**Portal side** (bearer token from a portal sign-in; cookie `ss_portal_refresh`)

| Call | Where | Notes |
|---|---|---|
| `POST /auth/login {email, password}` | `api/routes/auth.py:267` | Returns a session, or `{status: "totp_verify"|"totp_enroll", challenge_token}`. |
| `POST /auth/totp/verify` | `api/routes/auth.py:455` | Header `X-Totp-Challenge`, body `{code, remember: true}`. Sets `ss_trust`; a later login carrying it is not challenged. |
| `POST /auth/refresh?client=portal` | `api/routes/auth.py:293` | Rotating, as above. |
| `GET /auth/me` | `api/routes/auth.py` | Who is signed in and what they may do. |
| `GET /initiatives`, `GET /initiatives/{id}` | `api/routes/initiatives.py` | Moves, status, origin and destination site ids. |
| `GET /sites/{id}` | `api/routes/sites.py` | Name, latitude, longitude. |
| `GET /initiatives/{id}/assets` | `api/routes/initiatives.py:1101` | Full roster: asset id, serial, RFID tag, move status. Heavy; readiness and final check only. |
| `GET /initiatives/{id}/asset-totals` | `api/routes/initiatives.py:1111` | Counts by move status. Cheap. |
| `GET /containers?initiative_id=` | `api/routes/containers.py:103` | `asset_count`. |
| `GET /trucks?initiative_id=` | `api/routes/trucks.py:178` | Status, `container_count`. |
| `PATCH /trucks/{id} {status}` | `api/routes/trucks.py:559` | `in_transit`, then `at_destination`. |
| `POST /trucks/{id}/updates` | `api/routes/trucks.py:677`, SCH:5822 | `{location: {lat, lng}, source}`; `extra="forbid"`. No idempotency key. |
| `GET /status-rules` | `api/routes/status_rules.py:176` | `trigger_status`, `trigger_match_type`, `enabled`. |
| `GET /status-values…` for record type `asset` | `api/routes/` (find it) | Active asset status keys. |
| `GET /system/status` | `api/routes/system.py:142` | Public. `read_only`, background `{state, running, total}`. |
| `GET /scans/raw/page?limit=1&…` | `api/routes/scans.py:156` | `total`; filter on device text. |
| `GET /scans/asset/{asset_id}?limit=500` | `api/routes/scans.py:315`, SCH:2029 | Processed scans: `status`, `scanned_at`, `processed_at`, `device_id`. |
| `GET /devtools/health/summary`, `/connections` | `api/routes/health.py:31–80` | 403 when not allowed. |

Errors come from the API's `_err(status, code, …)` helper; read it once to learn the body shape and parse `code` from it.

---

### Task 1: Package scaffold and profiles

**Files:**
- Create: `loadtest/pyproject.toml`, `loadtest/.gitignore`, `loadtest/src/loadtest/__init__.py`, `loadtest/src/loadtest/profile.py`, `loadtest/profiles/real-time.toml`, `loadtest/profiles/fast.toml`, `loadtest/tests/conftest.py`, `loadtest/tests/test_profile.py`

**Interfaces:**
- Produces:

```python
# loadtest/src/loadtest/profile.py
Kind = Literal["each", "cart", "pack", "truck_load", "trip", "truck_unload", "unpack"]
Action = Literal["enroll", "scan", "station_rfid", "station_label", "pack", "unpack", "load", "unload", "trip"]
DeviceKind = Literal["handheld", "rfid_station", "label_station"]

@dataclass(frozen=True)
class StageSpec:
    key: str; label: str; site: Literal["origin", "destination"]
    kind: Kind; action: Action
    checkpoint: str | None; device: DeviceKind | None
    devices: int; crews: int; batch: int
    seconds: tuple[float, float]          # min, max
    per: Literal["server", "cart", "container"]

@dataclass(frozen=True)
class TripSpec:
    hours: float; update_minutes: float; pause_seconds: tuple[float, float]
    @property
    def updates(self) -> int               # hours*60 / update_minutes → 68

@dataclass(frozen=True)
class RetrySpec:
    attempts: int; backoff_seconds: tuple[float, ...]

@dataclass(frozen=True)
class Profile:
    name: str; container_size: int; containers_per_truck: int
    final_status: str; heartbeat_seconds: float; sample_seconds: float
    request_timeout_seconds: float
    retry: RetrySpec; trip: TripSpec; stages: tuple[StageSpec, ...]
    raw: dict                               # the parsed file, for results.json

class ProfileError(ValueError): ...
def load_profile(path: Path) -> Profile
def profile_path(name: str) -> Path        # "real-time" | "fast" → bundled file
def device_count(profile: Profile) -> int
def containers_needed(profile: Profile, servers: int) -> int
def trucks_needed(profile: Profile, containers: int) -> int
```

- [ ] **Step 1: Scaffold.** `pyproject.toml`: project `basecamp-loadtest`, `requires-python = ">=3.11"`, dependencies `httpx==0.28.1`, `fastapi==0.141.1`, `uvicorn==0.52.4`; optional `dev` = `pytest`, `pytest-asyncio`; `[tool.pytest.ini_options] asyncio_mode = "auto"`, `testpaths = ["tests"]`; `[tool.ruff] line-length = 100`; src layout. `.gitignore`: `.venv/`, `runs/`. Then `cd loadtest && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`.

- [ ] **Step 2: Write the two profile files.** Top-level keys in both: `container_size = 20`, `containers_per_truck = 15`, `final_status = "complete"`, `heartbeat_seconds = 60`, `sample_seconds = 10`, `request_timeout_seconds = 30`, `[retry] attempts = 5, backoff_seconds = [1, 2, 5, 10, 30]`. `real-time.toml`: `[trip] hours = 17, update_minutes = 15, pause_seconds = [900, 900]`. `fast.toml`: same `hours` and `update_minutes`, `pause_seconds = [0.5, 1.0]`. Stages, in this order (`[[stage]]` tables):

| key | label | site | kind | action | checkpoint | device | devices | crews | batch | real-time seconds / per | fast seconds / per |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `enroll` | RFID enroll | origin | each | enroll | `pre_stage` | handheld | 5 | 5 | 1 | [15,15] server | [0.5,1] server |
| `cage_exit` | RFID 1 – Cage Exit | origin | cart | station_rfid | `rfid_1_cage_exit` | rfid_station | 1 | 20 | 10 | [600,600] cart | [0.5,1] cart |
| `label` | Label station | origin | each | station_label | `labeled` | label_station | 3 | 3 | 1 | [15,30] server | [0.5,1] server |
| `loading_dock` | RFID 2 – Loading Dock | origin | cart | station_rfid | `rfid_2_loading_dock` | rfid_station | 1 | 4 | 10 | [120,180] cart | [0.5,1] cart |
| `pack` | Pack containers | origin | pack | pack | `in_container` | handheld | 4 | 4 | 1 | [420,420] container | [0.5,1] server |
| `truck_load` | Load truck | origin | truck_load | load | `on_truck` | handheld | 1 | 1 | 1 | [480,480] container | [0.5,1] container |
| `trip` | Truck trip | origin | trip | trip | — | — | 0 | 0 | 1 | — | — |
| `truck_unload` | Unload truck | destination | truck_unload | unload | `received` | handheld | 1 | 1 | 1 | [480,480] container | [0.5,1] container |
| `unpack` | Unpack containers | destination | unpack | unpack | `un_pack` | handheld | 4 | 4 | 1 | [420,420] container | [0.5,1] server |
| `staging` | RFID 3 – Staging | destination | cart | station_rfid | `rfid_3_staging` | rfid_station | 1 | 4 | 10 | [120,180] cart | [0.5,1] cart |
| `into_cage` | RFID 4 – Into Cage | destination | cart | station_rfid | `rfid_4_into_cage` | rfid_station | 1 | 20 | 10 | [600,600] cart | [0.5,1] cart |
| `qa` | QA | destination | each | scan | `qa` | handheld | 5 | 5 | 1 | [15,15] server | [0.5,1] server |
| `complete` | Complete | destination | each | scan | `complete` | handheld | 5 | 5 | 1 | [15,15] server | [0.5,1] server |

- [ ] **Step 3: Write failing tests** in `tests/test_profile.py`:

```python
def test_real_time_profile_matches_the_spec():
    p = load_profile(profile_path("real-time"))
    assert [s.key for s in p.stages] == ["enroll", "cage_exit", "label", "loading_dock", "pack",
        "truck_load", "trip", "truck_unload", "unpack", "staging", "into_cage", "qa", "complete"]
    assert p.trip.updates == 68
    assert device_count(p) == 32
    label = next(s for s in p.stages if s.key == "label")
    assert (label.crews, label.seconds) == (3, (15.0, 30.0))

def test_fast_profile_only_changes_waits():
    rt, fast = load_profile(profile_path("real-time")), load_profile(profile_path("fast"))
    strip = lambda s: dataclasses.replace(s, seconds=(0, 0), per="server")
    assert [strip(s) for s in rt.stages] == [strip(s) for s in fast.stages]
    assert all(s.seconds == (0.5, 1.0) for s in fast.stages if s.kind != "trip")
    assert fast.trip.pause_seconds == (0.5, 1.0) and fast.trip.updates == 68

def test_counts_needed():
    p = load_profile(profile_path("real-time"))
    assert containers_needed(p, 3000) == 150 and trucks_needed(p, 150) == 10
    assert containers_needed(p, 45) == 3 and trucks_needed(p, 17) == 2
```

Plus one `ProfileError` test per validation rule below, each on a mutated copy of the real-time file written to `tmp_path`; each asserts the message names the offending stage key or field.

- [ ] **Step 4: Run** `.venv/bin/python -m pytest tests/test_profile.py -q` → fails (module missing).

- [ ] **Step 5: Implement `profile.py`.** Validation, each raising `ProfileError`: unknown or missing key; `seconds` min > max or negative; `crews`, `devices`, `batch` < 1 on a non-trip stage; duplicate stage `key`; exactly one each of `pack`, `truck_load`, `trip`, `truck_unload`, `unpack`, in that order; no `each` or `cart` stage between `pack` and `unpack`; every stage before `trip` has `site = "origin"` and every stage after it `"destination"`; `kind`/`action` pairs must be one of the pairs in the table above; `action` `enroll`/`scan`/`pack`/`unpack`/`load`/`unload` need `device = "handheld"`, `station_rfid` needs `rfid_station`, `station_label` needs `label_station`; `per` is `cart` only on `cart` stages and `container` only on `pack`, `unpack`, `truck_load`, `truck_unload`; `trip.hours * 60 / trip.update_minutes` is a whole number ≥ 1; `retry.attempts` ≥ 1 with at least one backoff value.

- [ ] **Step 6: Run** the tests → pass. **Commit:** `feat(loadtest): package scaffold and speed profiles`.

---

### Task 2: Clock and ids

**Files:**
- Create: `loadtest/src/loadtest/clock.py`, `loadtest/src/loadtest/ids.py`, `loadtest/tests/test_clock.py`, `loadtest/tests/test_ids.py`

**Interfaces:**
- Produces:

```python
# clock.py
class Clock(Protocol):
    def now(self) -> float: ...                      # epoch seconds
    async def sleep(self, seconds: float) -> None: ...
class RealClock: ...                                 # time.time / asyncio.sleep
class FakeClock:
    def __init__(self, start: float = 1_800_000_000.0): ...
    def now(self) -> float
    async def sleep(self, seconds: float) -> None
    async def run(self, coro: Awaitable[T], *, limit: float | None = None) -> T
    sleeps: list[float]                              # every sleep length asked for, in order

# ids.py
def scan_id(run_id: uuid.UUID, stage_key: str, subject_id: str) -> uuid.UUID      # uuid5, stable
def make_tags(rng: random.Random, count: int) -> list[str]                         # unique
def device_serial(stage_key: str, n: int) -> str     # "LOADTEST-LABEL-2" (n is 1-based)
def device_name(stage_label: str, n: int, of: int) -> str   # "Load test – Label station 2"; no number when of == 1
```

- [ ] **Step 1: Failing tests.**

```python
async def test_fake_clock_runs_sleepers_in_time_order_without_waiting():
    clock, seen = FakeClock(), []
    async def worker(name, s):
        await clock.sleep(s); seen.append((name, clock.now() - 1_800_000_000.0))
    async def main():
        await asyncio.gather(worker("b", 600), worker("a", 15), worker("c", 61200))
    t0 = time.monotonic(); await clock.run(main())
    assert seen == [("a", 15.0), ("b", 600.0), ("c", 61200.0)]
    assert time.monotonic() - t0 < 1.0

async def test_fake_clock_limit_stops_a_run_that_never_ends():
    clock = FakeClock()
    async def forever():
        while True: await clock.sleep(60)
    with pytest.raises(TimeoutError): await clock.run(forever(), limit=3600)

def test_tags_are_24_uppercase_hex_unique_and_not_zero_led():
    tags = make_tags(random.Random(7), 5000)
    assert len(set(tags)) == 5000
    assert all(re.fullmatch(r"[1-9A-F][0-9A-F]{23}", t) for t in tags)
    assert make_tags(random.Random(7), 5) == tags[:5]

def test_scan_ids_are_stable_and_distinct():
    run = uuid.UUID(int=1)
    assert scan_id(run, "label", "a") == scan_id(run, "label", "a")
    assert len({scan_id(run, "label", "a"), scan_id(run, "qa", "a"), scan_id(run, "label", "b"),
                scan_id(uuid.UUID(int=2), "label", "a")}) == 4

def test_device_names():
    assert device_serial("label", 2) == "LOADTEST-LABEL-2"
    assert device_name("Label station", 2, 3) == "Load test – Label station 2"
    assert device_name("RFID 1 – Cage Exit", 1, 1) == "Load test – RFID 1 – Cage Exit"
```

- [ ] **Step 2: Run** → fail. **Step 3: Implement.** `FakeClock.sleep` parks a future on a heap keyed by wake time. `FakeClock.run` starts the coroutine as a task and loops: yield to the event loop (`await asyncio.sleep(0)`) until a full pass adds no new sleeper and wakes none — spin a fixed 25 passes — then pop every sleeper due at the earliest wake time, set `now` to it and release them. A sleep of 0 or less still yields once. `limit` is virtual seconds since the run began.

- [ ] **Step 4: Run** → pass. **Commit:** `feat(loadtest): injectable clock and stable ids`.

---

### Task 3: Run state and journal

**Files:**
- Create: `loadtest/src/loadtest/state.py`, `loadtest/src/loadtest/journal.py`, `loadtest/tests/test_journal.py`

**Interfaces:**
- Produces:

```python
# state.py
@dataclass
class Server:
    id: str; serial: str; tag: str
    done: dict[str, bool] = field(default_factory=dict)     # stage key → call landed
    container_id: str | None = None
@dataclass
class Container:
    id: str; name: str
    server_ids: list[str] = field(default_factory=list)
    closed: bool = False                 # packing finished
    truck_id: str | None = None          # set when loaded
    unloaded: bool = False
    unpacked: set[str] = field(default_factory=set)
@dataclass
class Truck:
    id: str; name: str
    container_ids: list[str] = field(default_factory=list)
    departed_at: float | None = None
    updates_sent: int = 0; updates_skipped: int = 0
    arrived: bool = False
@dataclass
class RunState:
    run_id: uuid.UUID; server_url: str; move_id: str; move_name: str
    profile_name: str; profile_raw: dict
    origin_site_id: str; destination_site_id: str
    route: list[tuple[float, float]]     # 68 points, lat/lng
    started_at: float
    servers: dict[str, Server]; containers: dict[str, Container]; trucks: dict[str, Truck]
    interruptions: list[tuple[float, float | None]] = field(default_factory=list)   # (stopped_at, resumed_at)
    finished: str | None = None          # None | "completed" | "stopped"
    def apply(self, entry: dict) -> None

# journal.py
class Journal:
    def __init__(self, path: Path): ...
    def append(self, entry: dict) -> None        # one JSON line, flushed
    def close(self) -> None
def start_entry(state: RunState) -> dict         # the "run_started" entry
def load_state(path: Path) -> RunState           # replay; a torn last line is ignored
def find_unfinished(runs_dir: Path) -> Path | None   # newest journal with no "run_finished"
```

Journal entry kinds (`"t"` field) and what `apply` does: `run_started` (builds the state; servers carry `id`, `serial`, `tag`), `stage_done {stage, servers, ok}` (sets `done[stage] = ok` for each), `packed {server, container, ok}`, `container_closed {container}`, `loaded {container, truck, ok}`, `departed {truck, at}`, `location {truck, index, ok}` (sets `updates_sent = index`), `location_skipped {truck, count}`, `arrived {truck}`, `unloaded {container, ok}`, `unpacked {server, container, ok}`, `interrupted {at}`, `resumed {at}`, `run_finished {at, reason}`. Every entry also carries `at`.

- [ ] **Step 1: Failing tests:** a round trip (build a state with 3 servers / 1 container / 1 truck, append one of every entry kind, `load_state` equals the state mutated in memory by the same `apply` calls); `test_torn_last_line_is_ignored` (append half a JSON line by hand; `load_state` succeeds and matches the state before it); `test_find_unfinished_picks_the_newest_open_run` (three run folders under `tmp_path`: finished, unfinished-old, unfinished-new → the new one; only finished ones → `None`); `test_journal_never_holds_secrets` (a `start_entry` for a state built with a server URL containing `user:pw@` is refused with `ValueError`).

- [ ] **Step 2: Run** → fail. **Step 3: Implement.** Journal file is `runs/<YYYY-MM-DD_HHMMSS>/journal.jsonl`; `find_unfinished` sorts folder names.

- [ ] **Step 4: Run** → pass. **Commit:** `feat(loadtest): run state and journal`.

---

### Task 4: Pipeline engine — origin side

**Files:**
- Create: `loadtest/src/loadtest/pipeline.py`, `loadtest/tests/test_pipeline_origin.py`, `loadtest/tests/pipeline_helpers.py`

**Interfaces:**
- Consumes: `Profile`, `StageSpec` (Task 1); `Clock`, `FakeClock` (Task 2); `RunState`, `Journal` (Task 3).
- Produces:

```python
@dataclass(frozen=True)
class Step:
    kind: Literal["each", "cart", "pack", "unpack", "load", "unload", "depart", "location", "arrive"]
    stage: str                    # stage key ("trip" for depart/location/arrive)
    crew: int                     # 0-based crew index within the stage
    server_ids: tuple[str, ...] = ()
    container_id: str | None = None
    truck_id: str | None = None
    index: int = 0                # location update number, 1-based

Perform = Callable[[Step], Awaitable[bool]]        # True when the call landed

@dataclass(frozen=True)
class StageProgress:
    key: str; label: str; done: int; total: int    # servers, except truck stages count containers and trip counts trucks arrived

class Pipeline:
    def __init__(self, profile: Profile, state: RunState, perform: Perform, clock: Clock,
                 rng: random.Random, journal: Journal | None = None,
                 on_change: Callable[[], None] | None = None): ...
    async def run(self) -> None      # returns when every server has passed the last stage
    def progress(self) -> list[StageProgress]
```

Rules the engine implements (spec "Flow rules"):
- A crew **waits, then acts**: it draws a time from the stage's `seconds`, sleeps on the clock, then awaits `perform`. `per = "container"` on a pack stage means that time is one container's; each of the container's servers gets an equal share. `per = "server"` means each pack call gets its own draw.
- After `perform` returns, the engine applies the matching journal entry to `state`, appends it to `journal`, and calls `on_change`. `perform` returning `False` does **not** hold the server back.
- `cart`: a crew takes `batch` ready servers; it takes fewer only when the stage before it has finished everything it will ever send. One `Step` per cart.
- `pack`: a crew takes the next unused container (in the order `state.containers` lists them) and up to `container_size` ready servers, short only at the end. One `Step` per server, then `container_closed`.
- `truck_load`: one crew loads closed containers onto the current truck (in `state.trucks` order), one `Step` each. When the truck holds `containers_per_truck`, or no more containers will ever close, the engine emits `Step(kind="depart")` and starts that truck's trip **without blocking** the next truck's loading. In this task the trip is a stub that only performs `depart`.
- Cancelling the `run()` task stops every crew; no `perform` starts after the cancel.

- [ ] **Step 1: Test helper** `tests/pipeline_helpers.py`: `make_state(servers: int, containers: int, trucks: int) -> RunState` (ids `s0001…`, `c001…`, `t01…`, tags from `make_tags(Random(1), n)`), and a `Recorder` whose `async __call__(step) -> bool` appends `(clock.now() - start, step)` and returns `True` unless the step is in its `fail` set.

- [ ] **Step 2: Failing tests** (real-time profile and `FakeClock` unless noted; run with `clock.run(pipeline.run(), limit=…)`; in this task assert only on origin stages):

```python
async def test_every_server_passes_origin_stages_in_order():          # 45 servers, 3 containers, 1 truck
    # for each server id, the stage keys of the steps naming it are
    # ["enroll", "cage_exit", "label", "loading_dock", "pack"] in that order
async def test_last_cart_is_short_only_after_upstream_is_done():      # 25 servers
    # cage_exit cart sizes == [10, 10, 5]; the 5-cart's step time is later than the last enroll step
async def test_enroll_pace_is_five_people_at_fifteen_seconds():       # 50 servers
    # 5 enroll steps at t=15, 5 at t=30 …; the last at t=150
async def test_label_waits_fall_in_15_to_30_seconds():                # all label draws in clock.sleeps within [15, 30]
async def test_stages_overlap():                                      # 200 servers: first label step earlier than last enroll step
async def test_containers_fill_to_twenty_then_short():                # 45 servers → pack steps per container == [20, 20, 5]
async def test_pack_spreads_one_container_over_seven_minutes():       # one crew's 20 pack steps are 21 s apart
async def test_trucks_depart_full_or_when_nothing_is_left():          # 340 servers, 17 containers, 2 trucks, containers_per_truck 15
    # truck t01: 15 load steps then depart; t02: 2 load steps then depart; each depart is after its last load
async def test_tiny_move_finishes():                                  # 3 servers, 1 container, 1 truck → one cart of 3, one container of 3, depart
async def test_a_failed_call_does_not_hold_the_server_back():         # Recorder fails label for s0001 → s0001 still gets loading_dock and pack; state.servers["s0001"].done["label"] is False
async def test_fast_profile_waits_are_half_to_one_second():           # every clock.sleeps value within [0.5, 1.0]; 40 servers reach depart in < 600 virtual seconds
async def test_cancel_stops_cleanly():                                # cancel after 100 virtual seconds; no step recorded after the cancel; task ends with CancelledError
async def test_journal_and_state_follow_every_step(tmp_path):         # load_state(journal path) == pipeline's state after the run
async def test_progress_counts():                                     # after the run, progress() for enroll..pack is done == total == servers; truck_load done == total == containers
```

- [ ] **Step 3: Run** → fail. **Step 4: Implement** with one `asyncio.Queue` per stage boundary plus an "upstream finished" flag per stage, crews as tasks in an `asyncio.TaskGroup`. Seed the first stage's queue from `state.servers` in id order.

- [ ] **Step 5: Run** → pass. **Commit:** `feat(loadtest): pipeline engine, origin side`.

---

### Task 5: Pipeline engine — trip, destination side, continuing a run

**Files:**
- Modify: `loadtest/src/loadtest/pipeline.py`
- Create: `loadtest/tests/test_pipeline_destination.py`, `loadtest/tests/test_pipeline_resume.py`

**Interfaces:**
- Consumes: Task 4's `Pipeline`, `Step`, helpers.
- Produces: the same `Pipeline` API, now complete. No new public names.

Rules:
- **Trip:** after `depart` lands or fails, the engine journals `departed {truck, at: clock.now()}`, then for `index` 1…`trip.updates`: sleep a draw from `trip.pause_seconds`, perform `Step(kind="location", index=…)`. After the last one it performs `arrive`. With `pause_seconds = [900, 900]` and 68 updates that is exactly 17 hours.
- **Unload:** one crew takes arrived trucks in arrival order and unloads each container, one `Step` each.
- **Unpack:** a crew takes an unloaded container and unpacks its servers one `Step` each (same time-sharing rule as pack); each server is ready for the next stage as soon as it is unpacked.
- **Continuing:** `Pipeline.run()` starts from whatever `state` holds. Servers enter at their first stage not in `done`; a server already packed waits for its container; a closed container not yet loaded is loaded; a truck with `departed_at` set and `arrived` false resumes its trip; an arrived truck with containers not unloaded is unloaded; an unloaded container with servers not yet unpacked is unpacked. A container partly packed is finished before a new one is opened.
- **Trip resume:** when `pause_seconds` min equals max (real time), the next update index is `floor((now - departed_at) / pause) + 1`; the indexes in between were missed — journal `location_skipped {count}` and do not send them. If that index is past the last update, go straight to `arrive`. When min differs from max (fast), continue at `updates_sent + 1`.

- [ ] **Step 1: Failing tests.**

```python
async def test_trip_is_68_updates_over_17_hours():        # 20 servers, 1 container, 1 truck, real-time
    # location indexes == list(range(1, 69)); arrive time - depart time == 61200.0
async def test_trucks_travel_together():                  # 2 trucks: t02's first location step is earlier than t01's arrive
async def test_destination_order_per_server():            # 45 servers: after "pack", each server sees ["unpack", "staging", "into_cage", "qa", "complete"]
async def test_unload_then_unpack_per_container():        # every unpack step of a container is later than that container's unload step
async def test_run_ends_when_every_server_is_complete():  # run() returns; state.servers all have done["complete"]; finished progress == totals
async def test_fast_trip_sends_all_68():                  # fast profile: 68 location steps, each wait within [0.5, 1.0]
async def test_whole_move_uneven_counts():                # 45 servers, 3 containers, 1 truck, fast: every server has exactly 11 stage entries in done (all but "trip" and the two truck stages)
```

Resume tests build a state by running a pipeline to a virtual time, cancelling, reloading the state from its journal, then running a fresh `Pipeline` with a fresh `Recorder`:

```python
async def test_continue_performs_only_what_is_left(tmp_path):   # cancel mid label stage; second run's steps + first run's steps cover each (server, stage) exactly once for every stage whose step had returned before the cancel
async def test_continue_finishes_a_part_packed_container(tmp_path)
async def test_continue_real_time_trip_skips_missed_updates(tmp_path):
    # truck departed, 10 updates sent, runner down 3 h (advance the clock 10800 s before resuming)
    # → next location index == 23 (10 + 12 missed + 1), state.trucks[...].updates_skipped == 12
async def test_continue_real_time_trip_past_arrival_goes_straight_to_arrive(tmp_path)
async def test_continue_fast_trip_continues_at_next_index(tmp_path)     # updates_sent 30 → next index 31, none skipped
```

- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** the whole `tests/` folder → pass. **Commit:** `feat(loadtest): trip, destination side and continuing a run`.

---

### Task 6: Metrics and the timed call

**Files:**
- Create: `loadtest/src/loadtest/metrics.py`, `loadtest/src/loadtest/http.py`, `loadtest/tests/test_metrics.py`, `loadtest/tests/test_http.py`

**Interfaces:**
- Consumes: `RetrySpec`, `Clock`.
- Produces:

```python
# metrics.py
class Metrics:
    def record(self, call: str, ms: float, ok: bool, retries: int = 0) -> None   # one logical call
    def count(self, name: str, n: int = 1) -> None
    def sample(self, series: str, at: float, value: float | dict) -> None
    def calls(self) -> dict[str, dict]     # per call: count, retries, failures, median_ms, p95_ms, max_ms
    def counters(self) -> dict[str, int]
    def series(self) -> dict[str, list[list]]      # [[at, value], …]
    def failed_calls(self) -> int

# http.py
class TokenExpired(Exception): ...
class CallFailed(Exception):
    call: str; status: int | None; code: str | None; retries: int
async def timed_call(client: httpx.AsyncClient, method: str, url: str, *, name: str,
                     metrics: Metrics, clock: Clock, retry: RetrySpec,
                     already_done: Callable[[httpx.Response], bool] | None = None,
                     **request_kwargs) -> httpx.Response
def error_code(response: httpx.Response) -> str | None      # the server's `_err` code
```

`timed_call` rules (spec "When a call fails"): a transport error, a 5xx or a 423 is retried, sleeping `backoff_seconds[i]` (the last value repeats) on the clock, up to `retry.attempts` tries in all; a 401 raises `TokenExpired` at once and records nothing; any other 4xx is final — unless this is a retry and `already_done(response)` is true, which is success. `ms` recorded is the last attempt's time (measured with `time.perf_counter`, not the clock). Exhausted retries and final 4xx record a failure and raise `CallFailed`. Exception text never includes request headers or body.

- [ ] **Step 1: Failing tests** using `httpx.MockTransport` and `FakeClock`: success records `ok` once with `retries == 0`; 503, 503, 200 → success with `retries == 2` and clock sleeps `[1, 2]`; five 503s with `attempts = 5` → `CallFailed(status=503, retries=4)`, one failure recorded; `httpx.ConnectError` twice then 200 → success; 423 is retried; 422 with code `bad_site` → `CallFailed(code="bad_site", retries=0)` and no sleep; 401 → `TokenExpired`, nothing recorded; 503 then 409 `not_in_container` with `already_done=lambda r: error_code(r) == "not_in_container"` → success; the same 409 on the first try → `CallFailed`; percentiles (`record` 1…100 ms → median 50.5, p95 95.05 ± 0.1, max 100); `str(CallFailed)` for a request sent with `headers={"Authorization": "Bearer SECRET"}` and `json={"password": "SECRET"}` does not contain `SECRET`.

- [ ] **Step 2: Run** → fail. **Step 3: Implement** (read the API's `_err` helper first for `error_code`). **Step 4: Run** → pass. **Commit:** `feat(loadtest): metrics and retrying timed call`.

---

### Task 7: Fake server and the kiosk device client

**Files:**
- Create: `loadtest/tests/fakeserver.py`, `loadtest/src/loadtest/client/__init__.py`, `loadtest/src/loadtest/client/kiosk.py`, `loadtest/tests/test_kiosk_client.py`
- Modify: `loadtest/tests/conftest.py` (fixtures)

**Interfaces:**
- Consumes: `timed_call`, `Metrics`, `Clock`, `RetrySpec`, `DeviceKind`.
- Produces:

```python
# tests/fakeserver.py — an in-memory stand-in for the kiosk and portal API
class FakeBaseCamp:
    app: FastAPI                                  # use with httpx.ASGITransport(app=fake.app)
    def __init__(self, clock: Clock): ...
    def add_move(self, *, servers: int, containers: int, trucks: int, status: str = "in_progress",
                 password: str = "move-pass-1") -> str          # returns move id; creates two sites with lat/lng
    def add_portal_user(self, email: str, password: str, *, totp: Literal[None, "verify", "enroll"] = None,
                        code: str = "123456", permissions: set[str] | None = None) -> None
    def fail(self, method: str, path_regex: str, *, status: int = 503, times: int = 1,
             after_effect: bool = False) -> None  # after_effect: do the work, then answer `status` (a lost answer)
    def down(self, on: bool) -> None              # every request raises a connect error while on
    def process_scans(self, *, duplicate_on_replay: bool = True) -> None   # move raw scans to processed, like the worker
    raw_scans: list[dict]; processed_scans: list[dict]; devices: dict[str, dict]
    requests: list[tuple[str, str]]               # (method, path) log
    session_seconds: float = 86400; token_seconds: float = 900
```

The fake copies the real request models' **required** fields and limits (batch ≤ 100 / ≤ 50, station type rules, `rfid_needs_laptop`, RFID-only / barcode-only stations, label status forced to `labeled`, rotating refresh cookie that revokes on replay, 409 `rfid_in_use`, `not_in_container`, `not_on_truck`, `move_locked`, raw-scan idempotency on `client_scan_id` only while the raw row exists). It answers with the real response field names. Portal routes are added in Task 8.

```python
# client/kiosk.py
@dataclass(frozen=True)
class ScanOut:
    client_scan_id: uuid.UUID; scanned_value: str; scan_type: Literal["rfid", "barcode"]
    scanned_at: datetime; scan_status: str; site_id: str; initiative_id: str

@dataclass(frozen=True)
class SyncData:
    assets: list[dict]; containers: list[dict]; trucks: list[dict]

class KioskDevice:
    def __init__(self, *, base_url: str, serial: str, name: str, kind: DeviceKind,
                 metrics: Metrics, clock: Clock, retry: RetrySpec, timeout: float,
                 transport: httpx.AsyncBaseTransport | None = None): ...
    serial: str; name: str; kind: DeviceKind
    async def sign_in(self, move_password: str) -> None      # move-login, then a sign-in heartbeat
    async def setup(self, *, initiative_id: str, site_id: str, scan_status: str) -> None   # stations also fetch their key
    async def sync(self, initiative_id: str) -> SyncData     # every call runSync makes
    async def heartbeat(self) -> None                        # never raises CallFailed; returns after recording
    async def enroll(self, *, asset_id: str, tag: str, scan: ScanOut) -> bool
    async def send_scans(self, scans: list[ScanOut]) -> int  # number the server accepted
    async def pack(self, *, container_id: str, asset_id: str, scan: ScanOut) -> bool
    async def unpack(self, *, container_id: str, asset_id: str, scan: ScanOut) -> bool
    async def load(self, *, truck_id: str, container_id: str, scan: ScanOut) -> bool
    async def unload(self, *, truck_id: str, container_id: str, scan: ScanOut) -> bool
    async def close(self) -> None
```

Behavior:
- Metric names: `move-login`, `refresh`, `heartbeat`, `station-heartbeat`, `setup`, `station-key`, `sync`, `enroll`, `scans`, `station-scans`, `pack`, `unpack`, `load`, `unload`.
- `send_scans` posts to `/kiosk/station/scans` with the station key on stations, `/kiosk/scans` with the bearer token on handhelds; it splits lists over the route's batch limit; rows the server rejects count as `metrics.count("scans_rejected")` and are not in the returned number.
- `enroll`, `pack`, `unpack`, `load`, `unload`, `send_scans` return `False`/a short count on `CallFailed` instead of raising; a retried scan-bearing call adds its scan count to `metrics.count("scans_retried")` and remembers the ids in `device.retried_scan_ids: set[uuid.UUID]`.
- `already_done` for the four state-changing calls: read the real routes (K:2125–2260, K:2426–2560) and treat every code that means "already in the wanted state" as done on a retry.
- Tokens: one `asyncio.Lock` per device. Refresh when the access token is within 60 s of `expires_in`, or on `TokenExpired`. A refresh that fails for any reason is not retried: sign in again with the kept move password, send a sign-in heartbeat, then redo the call once. A sign-in past `session_expires_at` is replaced the same way. Stations use the token only until they hold a key.
- `heartbeat` on an RFID Station with a key posts `/kiosk/station/heartbeat`; on a Label Station with a key it does nothing; on a handheld it posts `/kiosk/heartbeat` (`sign_in: false`).
- The device keeps its own `httpx.AsyncClient` (own cookie jar). `repr` and exceptions never show the token, key or password.

- [ ] **Step 1: Write the fake** and its fixtures (`fake`, `clock`, `metrics`, `retry` and a `device(kind=…)` factory in `conftest.py`).

- [ ] **Step 2: Failing tests** in `test_kiosk_client.py`: handheld `sign_in` + `setup` → `fake.devices["LOADTEST-ENROLL-1"]` has mode `web`, the move, origin site and `pre_stage`; RFID Station `setup` sends `mode "laptop"`, a reader with all four fields, and ends holding a key (later `send_scans` carries `Authorization: Station …` and no bearer); Label Station `send_scans` lands as `labeled`; `enroll` writes the tag and one raw scan with the given `client_scan_id`; `send_scans` of 120 scans on a handheld makes 2 requests, on a station 3; a rejected row lowers the returned count and bumps `scans_rejected`; `pack`/`unpack`/`load`/`unload` change the fake's membership; `fake.fail("POST", r"/kiosk/containers/.*/assets", after_effect=True)` then `unpack` → returns `True` (lost answer, 409 on retry treated as done); same for `unload`; **Review Focus 3:** with `fake.token_seconds = 900`, advancing the clock 20 minutes then `send_scans` refreshes once and lands; advancing 25 hours → a new `move-login` and the scans land; `fake.fail("POST", r"/auth/refresh", after_effect=True)` → the device does **not** replay the refresh, signs in again, and the scans land; a `sync` makes the same set of GET paths `kiosk/src/lib/sync.ts` `runSync` makes; `heartbeat` during `fake.down(True)` returns normally and records a failed `heartbeat`; `repr(device)` contains neither token nor password.

- [ ] **Step 3: Run** → fail. **Step 4: Implement `client/kiosk.py`.** **Step 5: Run** → pass. **Commit:** `feat(loadtest): fake server and kiosk device client`.

---

### Task 8: Portal client and road route

**Files:**
- Create: `loadtest/src/loadtest/client/portal.py`, `loadtest/src/loadtest/route.py`, `loadtest/tests/test_portal_client.py`, `loadtest/tests/test_route.py`
- Modify: `loadtest/tests/fakeserver.py` (portal routes)

**Interfaces:**
- Produces:

```python
# client/portal.py
@dataclass(frozen=True)
class SiteInfo: id: str; name: str; lat: float | None; lng: float | None
@dataclass(frozen=True)
class MoveInfo: id: str; name: str; status: str; origin: SiteInfo | None; destination: SiteInfo | None
@dataclass(frozen=True)
class RosterRow: asset_id: str; serial: str | None; rfid_tag: str | None; status: str | None
@dataclass(frozen=True)
class ContainerInfo: id: str; name: str; asset_count: int; truck_id: str | None
@dataclass(frozen=True)
class TruckInfo: id: str; name: str; status: str; container_count: int
@dataclass(frozen=True)
class AssetScan: status: str | None; scanned_at: datetime; processed_at: datetime; device_id: str
@dataclass(frozen=True)
class SystemStatus: read_only: bool; workers_running: int; workers_total: int

class TotpEnrollRequired(Exception): ...
class PortalClient:
    def __init__(self, *, base_url: str, metrics: Metrics, clock: Clock, retry: RetrySpec,
                 timeout: float, transport: httpx.AsyncBaseTransport | None = None): ...
    async def login(self, email: str, password: str) -> Literal["ok", "totp_required"]   # raises TotpEnrollRequired
    async def verify_totp(self, code: str) -> None                 # sends remember: true
    async def can(self, resource: str, action: str) -> bool
    async def moves(self) -> list[MoveInfo]                        # type "move", not archived
    async def move(self, move_id: str) -> MoveInfo                 # with both sites' coordinates
    async def roster(self, move_id: str) -> list[RosterRow]
    async def containers(self, move_id: str) -> list[ContainerInfo]
    async def trucks(self, move_id: str) -> list[TruckInfo]
    async def rule_checkpoints(self) -> set[str]                   # trigger statuses with an enabled asset rule
    async def asset_statuses(self) -> set[str]                     # active asset status keys
    async def system_status(self) -> SystemStatus
    async def set_truck_status(self, truck_id: str, status: str) -> bool
    async def add_truck_location(self, truck_id: str, lat: float, lng: float) -> bool
    async def waiting_scans(self, device_prefix: str = "Load test") -> int
    async def asset_totals(self, move_id: str) -> dict[str, int]
    async def asset_scans(self, asset_id: str) -> list[AssetScan]
    async def db_health(self) -> dict | None                       # None when the account may not read it
    async def close(self) -> None

# route.py
class RouteError(Exception): ...
async def fetch_route(origin: tuple[float, float], destination: tuple[float, float], *,
                      router_url: str = "https://router.project-osrm.org",
                      transport: httpx.AsyncBaseTransport | None = None) -> list[tuple[float, float]]   # lat, lng
def points_along(line: list[tuple[float, float]], count: int) -> list[tuple[float, float]]
```

Behavior:
- Portal token handling mirrors Task 7 (lock, refresh early, never replay a refresh). When a sign-in ends, sign in again with the kept email and password; the kept `ss_trust` cookie means no new code. If the server asks for a code anyway, raise `CallFailed(code="totp_required")`.
- Metric names: `portal-login`, `portal-refresh`, `truck-status`, `truck-location`, `waiting-scans`, `asset-totals`, `asset-scans`, `system-status`, `db-health`, and `portal-read` for the readiness reads.
- A retried `add_truck_location` bumps `metrics.count("locations_retried")`.
- `fetch_route` calls `GET {router_url}/route/v1/driving/{lng},{lat};{lng},{lat}?overview=full&geometries=geojson` and returns `routes[0].geometry.coordinates` flipped to `(lat, lng)`. Any non-200, `code != "Ok"`, or fewer than 2 points raises `RouteError` with a plain message. One attempt plus two retries on transport errors.
- `points_along(line, count)` returns `count` points; point `k` (1-based) is `k / count` of the line's length along it (haversine lengths, linear interpolation inside a segment). The last point is the line's end.

- [ ] **Step 1: Add portal routes to the fake** with the real field names (login with optional 2FA, refresh, me/permissions, initiatives, sites, roster, asset-totals, containers, trucks GET/PATCH/updates, status-rules, asset status values, system status, raw page `total` with device filter, asset scan history from `processed_scans`, health → 403 unless permitted).

- [ ] **Step 2: Failing tests:** login ok; login → `totp_required` → `verify_totp("123456")` ok and the request carried `X-Totp-Challenge` and `remember: true`; `totp="enroll"` → `TotpEnrollRequired`; wrong password → `CallFailed` whose text lacks the password; **Review Focus 3:** after 25 clock-hours a read signs in again without a code (the fake requires `ss_trust`); each read returns the dataclasses above from fake data; `waiting_scans()` counts only raw scans whose device text starts with `Load test`; `db_health()` → `None` on 403; `set_truck_status` then `trucks()` shows `in_transit`; `add_truck_location` stores canonical lat/lng. Route: `points_along([(0,0),(0,1),(0,3)], 3)` ≈ `[(0,1),(0,2),(0,3)]` (± 1e-6); `points_along` of a real-shaped 500-point line with `count=68` returns 68 points with strictly increasing distance from the start and the last equal to the line's end; `fetch_route` against a `MockTransport` returning a recorded OSRM-shaped body returns flipped coordinates and requested `…/driving/-96.8,32.7;-84.4,33.7?overview=full&geometries=geojson` for origin `(32.7, -96.8)`, destination `(33.7, -84.4)`; `code: "NoRoute"` → `RouteError`.

- [ ] **Step 3: Run** → fail. **Step 4: Implement.** **Step 5: Run** → pass. **Commit:** `feat(loadtest): portal client and road route`.

---

### Task 9: Events, fleet and actions

**Files:**
- Create: `loadtest/src/loadtest/events.py`, `loadtest/src/loadtest/fleet.py`, `loadtest/src/loadtest/actions.py`, `loadtest/tests/test_actions.py`

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces:

```python
# events.py
@dataclass(frozen=True)
class FeedLine: at: float; device: str; action: str; subject: str; ok: bool; ms: float | None; note: str = ""
class Events:
    def __init__(self, log_path: Path | None, keep: int = 500): ...
    def feed(self, line: FeedLine) -> None            # ring buffer + events.log line + subscribers
    def recent(self) -> list[FeedLine]
    def subscribe(self) -> asyncio.Queue[FeedLine]    # bounded (1000); a full queue drops its oldest
    def unsubscribe(self, q) -> None
    def close(self) -> None

# fleet.py
class Fleet:
    def __init__(self, *, profile: Profile, base_url: str, move: MoveInfo, metrics: Metrics,
                 clock: Clock, events: Events, transport=None): ...
    devices: list[KioskDevice]                        # 32 for the bundled profiles
    async def start(self, move_password: str) -> SyncData   # sign in, set up, sync every device; start heartbeats
    def device_for(self, stage_key: str, crew: int) -> KioskDevice   # crew % stage.devices
    async def stop(self) -> None

# actions.py
class Actions:
    def __init__(self, *, profile: Profile, state: RunState, fleet: Fleet, portal: PortalClient,
                 events: Events, metrics: Metrics, clock: Clock): ...
    async def perform(self, step: Step) -> bool
```

Behavior:
- `Fleet` makes `stage.devices` devices per stage that has a device: serial `device_serial(stage.key, n)`, name `device_name(stage.label, n, stage.devices)`, site = the move's origin or destination by `stage.site`, checkpoint = `stage.checkpoint`. `start` signs devices in **one at a time** for the first device (it may create the move's kiosk identity), then the rest 8 at a time; each runs `sign_in`, `setup`, `sync`. It returns the first device's `SyncData`. Heartbeats: one task per device, every `profile.heartbeat_seconds` on the clock, first beat at a random offset within one interval.
- `Actions.perform` maps a `Step` to calls. Scan ids are `scan_id(state.run_id, step.stage, subject)` with subject = the server id, or the container id for load/unload. `scanned_at` is `clock.now()`.
  - `each` + `enroll` → `device.enroll(asset_id, tag=server.tag, scan=…)` with `scan_type "rfid"`, value the tag.
  - `each` + `scan` → `send_scans([one barcode scan of the serial])`.
  - `each` + `station_label` → same through the Label Station.
  - `cart` + `station_rfid` → `send_scans([one rfid scan per server, value its tag])` in one call; landed only when every scan was accepted.
  - `pack` / `unpack` → barcode of the serial; `load` / `unload` → barcode of the container's name.
  - `depart` → `portal.set_truck_status(truck, "in_transit")`; `location` → `portal.add_truck_location(truck, *state.route[index - 1])`; `arrive` → `portal.set_truck_status(truck, "at_destination")`.
- Every `perform` emits one `FeedLine`: device name (or `Truck <name>`), action (the stage label; `location`, `departed`, `arrived` for trip steps), subject (`SN <serial>`, `10 tags`, the container name, or `lat, lng` to 4 places), ok, and the call's ms.
- `perform` never raises except `asyncio.CancelledError`.

- [ ] **Step 1: Failing tests** (fake server, `FakeClock`, fast profile, a 45-server / 3-container / 1-truck move; build `RunState` from `fleet.start`'s sync data via a small helper kept in the test file until Task 12 gives it a home):

```python
async def test_fleet_brings_up_32_named_devices():      # fake.devices has 32 serials all starting "LOADTEST-", names all starting "Load test"; stations are laptops with keys
async def test_whole_move_lands_on_the_fake():          # Pipeline(perform=actions.perform) runs to the end; then fake.process_scans():
    # every server: tag set; processed scans per server by checkpoint == one each of
    # pre_stage, rfid_1_cage_exit, labeled, rfid_2_loading_dock, in_container, un_pack, rfid_3_staging, rfid_4_into_cage, qa, complete
    # every container: empty, off its truck, one on_truck and one received scan; truck at_destination with 68 updates
async def test_scan_ids_are_stable_across_a_restart():  # two Actions built on the same state send the same client_scan_id for the same step
async def test_feed_lines_carry_no_secrets_and_read_well()   # one line per step; no line contains the move password, a token or a key; a label line reads device "Load test – Label station 2", action "Label station", subject "SN …"
async def test_heartbeats_tick_every_minute():          # real-time profile, clock advanced 10 minutes while idle → each device ≥ 9 heartbeat calls; Label Stations 0
async def test_server_outage_does_not_kill_the_run():   # Review Focus 1: fake.down(True) for 120 virtual seconds mid-run, then back → pipeline finishes, metrics.failed_calls() counts no heartbeat, and every server still reaches "complete" in state
async def test_events_ring_keeps_500_and_log_keeps_all(tmp_path)
```

- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** the whole suite → pass. **Commit:** `feat(loadtest): device fleet, actions and feed`.

---

### Task 10: Readiness check

**Files:**
- Create: `loadtest/src/loadtest/preflight.py`, `loadtest/tests/test_preflight.py`

**Interfaces:**
- Produces:

```python
@dataclass(frozen=True)
class Check: key: str; label: str; status: Literal["pass", "fail", "warn"]; detail: str
@dataclass(frozen=True)
class CheckReport:
    checks: list[Check]; can_start: bool
    move: MoveInfo | None; roster: list[RosterRow]; containers: list[ContainerInfo]; trucks: list[TruckInfo]
    route: list[tuple[float, float]]             # trip.updates points, empty when not found

async def run_checks(*, portal: PortalClient, profile: Profile, base_url: str, move_id: str,
                     move_password: str, metrics: Metrics, clock: Clock, router_url: str,
                     transport=None, router_transport=None) -> CheckReport
```

Checks, in this order, with these keys and labels (each `detail` says what was found and, on fail, what to fix):

| key | label | fails when |
|---|---|---|
| `portal_access` | Portal sign-in can change trucks and read scans | `can("trucks","change")`, `can("scans","view")` or `can("initiatives","view")` is false |
| `move_password` | Move password signs a kiosk in | a throwaway `KioskDevice` (`LOADTEST-CHECK`) `sign_in` fails |
| `move_status` | Move is In progress | status is not `in_progress` |
| `servers` | Servers have serials and no RFID tags | roster empty, any row lacks a serial, or any has a tag (detail gives the counts) |
| `containers` | Enough empty containers | fewer than `containers_needed`, or any on the move is not empty (detail: "150 needed, 148 found") |
| `trucks` | Enough trucks, none departed | fewer than `trucks_needed`, or one is `in_transit`/`at_destination` |
| `route` | Road route between the sites | a site lacks latitude or longitude, or `fetch_route` raises (detail names the routing service host) |
| `checkpoints` | Every checkpoint is an active status | any profile checkpoint is missing from `asset_statuses()` (detail lists them) |
| `server_ready` | Workers running, not read-only | `read_only`, or `workers_running < workers_total` |
| `rules` | Status rules | **warn** listing checkpoints with no enabled asset rule; pass when none |
| `notifications` | Notifications | always **warn**: "This run changes truck statuses and fires status rules, so the server sends its normal notifications to anyone watching this move, its trucks or its sites." |

`can_start` is true when no check failed. A check that cannot run because an earlier one failed is reported `fail` with detail "Not checked: fix the lines above first." The move-password check never signs in more than once per `run_checks` call (failed sign-ins count toward server lockouts).

- [ ] **Step 1: Failing tests:** an all-good fake move → every check `pass` except the two warnings, `can_start` true, `len(report.route) == 68`; one test per failing row above (mutate the fake: wrong move password, status `planned`, a server with a tag, 2 containers for 45 servers, a truck already `in_transit`, a site without coordinates, router returns `NoRoute`, checkpoint `qa` inactive, `read_only`), each asserting that check's status, a detail that names the numbers or keys, and `can_start` false; rules warning lists `on_truck` and `received` when the fake has no rules for them; the wrong-password test asserts exactly one `move-login` request reached the fake.

- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** → pass. **Commit:** `feat(loadtest): readiness check`.

---

### Task 11: Sampler, final check and results

**Files:**
- Create: `loadtest/src/loadtest/sampler.py`, `loadtest/src/loadtest/finalcheck.py`, `loadtest/src/loadtest/results.py`, `loadtest/tests/test_finalcheck.py`, `loadtest/tests/test_sampler.py`

**Interfaces:**
- Produces:

```python
# sampler.py
class Sampler:
    def __init__(self, *, portal: PortalClient, move_id: str, metrics: Metrics, clock: Clock, every: float): ...
    latest: dict        # {"waiting": int|None, "waiting_peak": int, "workers": "9/9"|None, "totals": {...}}
    async def run(self) -> None                   # loops until cancelled; one failed read never stops it
    async def wait_for_catch_up(self, *, quiet_samples: int = 6, timeout: float = 3600) -> float | None
        # seconds until waiting == 0; None if it stops shrinking for `quiet_samples` samples or times out

# finalcheck.py
@dataclass(frozen=True)
class Finding: level: Literal["fail", "warn"]; text: str
@dataclass(frozen=True)
class FinalReport:
    verdict: Literal["Pass", "Pass with warnings", "Fail"]
    findings: list[Finding]
    scans_sent: int; scans_processed: int; scans_twice: int; scans_missing: int
    delay_ms: dict            # median, p95, max of processed_at - scanned_at
async def final_check(*, portal: PortalClient, state: RunState, profile: Profile, metrics: Metrics,
                      rule_checkpoints: set[str], stopped_early: bool, concurrency: int = 8) -> FinalReport

# results.py
def build_results(*, state: RunState, profile: Profile, metrics: Metrics, report: FinalReport | None,
                  catch_up_seconds: float | None, ended_at: float, reason: str) -> dict
def write_results(run_dir: Path, results: dict) -> Path       # results.json
```

Behavior:
- `Sampler` series names: `waiting`, `workers_running`, `asset_totals` (dict by status), `db_health` (dict; skipped for good after the first `None`).
- `final_check` reads each server's scan history (`concurrency` at a time) and the roster, containers and trucks once. Expected scans per server: one per stage whose step **landed** (`server.done[stage]` true) with a checkpoint, matched by `(checkpoint, scanned_at)` — count rows per checkpoint. Zero rows → missing (fail). Two or more → processed twice (warn). Label-stage scans are expected under `labeled`.
- Other findings: a step that did not land (fail, grouped by stage with a count and the first three serials); `metrics.failed_calls() > 0` (fail, "N calls failed for good"); a server without its tag (fail); a server whose move status is not `profile.final_status` (fail) — skipped with a warn "Move status not checked: no enabled rule for the Complete checkpoint" when the last stage's checkpoint is not in `rule_checkpoints`; a container not empty or still on a truck (fail); a truck not `at_destination` (fail); truck location updates skipped or retried (warn with counts).
- `stopped_early`: only stages each server actually finished are expected; status, container and truck checks are skipped; the verdict is `Fail` with the first finding "Run was stopped before it finished."
- Verdict: any fail → `Fail`; else any warn → `Pass with warnings`; else `Pass`.
- `build_results` keys: `run` (server URL, move id and name, counts, profile name and `raw`, started, ended, reason, interruptions), `verdict`, `findings`, `calls`, `counters`, `scans`, `scan_delay_ms`, `backlog` (peak, catch-up seconds), `series`. It raises `ValueError` if any string value equals a secret passed in its `secrets: set[str]` keyword.

- [ ] **Step 1: Failing tests** (fake server; reuse the Task 9 whole-move run as a fixture): clean run after `fake.process_scans()` → `Pass`, `scans_sent == scans_processed`, zero twice/missing, `delay_ms["median"] >= 0`; fake with no `on_truck`/`received`/`complete` rules → `Pass with warnings` and the move-status finding; drop one processed scan from the fake → `Fail` with a finding naming the checkpoint and serial; duplicate one processed scan → `Pass with warnings`, `scans_twice == 1`; a server left at `qa` status with the `complete` rule present → `Fail`; a container left with an asset → `Fail`; `stopped_early=True` half-way → `Fail`, first finding is the stopped line, no missing-scan finding for stages not reached; sampler: `latest["waiting"]` follows the fake's raw count and `waiting_peak` holds the max; `wait_for_catch_up` returns the virtual seconds until the fake processes its scans, and `None` when 3 scans stay unmatched; a `portal.waiting_scans` failure in one tick does not end `run()`; `build_results(…, secrets={"move-pass-1"})` raises when a finding text contains `move-pass-1`.

- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** → pass. **Commit:** `feat(loadtest): sampler, final check and results`.

---

### Task 12: Runner

**Files:**
- Create: `loadtest/src/loadtest/runner.py`, `loadtest/tests/test_runner.py`

**Interfaces:**
- Produces:

```python
Phase = Literal["idle", "connected", "checked", "starting", "running", "finishing", "done", "stopped", "error"]

class RunnerError(Exception):
    code: str        # "bad_phase" | "totp_enroll" | "sign_in_failed" | "not_ready" | "no_unfinished_run" | …
    message: str     # safe to show on the page

class Runner:
    def __init__(self, *, runs_dir: Path, clock: Clock | None = None, router_url: str | None = None,
                 transport=None, router_transport=None): ...
    phase: Phase
    async def connect(self, server: str, email: str, password: str, totp_code: str | None = None) -> dict
        # {"status": "ok", "moves": [{id, name, status}]} | {"status": "totp_required"}
    async def check(self, move_id: str, move_password: str, speed: Literal["real-time", "fast"]) -> CheckReport
    async def start(self) -> None                # needs the last check to have can_start
    async def stop(self) -> None
    def unfinished(self) -> dict | None          # {run_dir, server, move_name, speed, started_at, servers, done}
    async def continue_run(self, password: str, move_password: str, email: str, totp_code: str | None = None) -> dict
    async def discard_unfinished(self) -> None   # appends run_finished reason "discarded"
    def snapshot(self) -> dict                   # everything the page draws; never a secret
    def result(self) -> dict | None              # last results.json content
    events: Events
```

Behavior:
- `start` creates `runs/<stamp>/`, builds `RunState` (servers from the roster with tags from `make_tags(random.Random(run_id.int), n)`, the first `containers_needed` containers and `trucks_needed` trucks by name order, route from the check), writes `run_started`, brings up the `Fleet`, starts `Sampler` and `Pipeline` as background tasks, phase `running`. Fleet start-up failure → phase `error` with a safe message, journal `run_finished reason "error"`.
- When the pipeline ends: phase `finishing` → `wait_for_catch_up` → `final_check` → `write_results` → journal `run_finished reason "completed"` → phase `done`.
- `stop`: cancel pipeline, wait for calls in flight (≤ 30 s), `final_check(stopped_early=True)`, write results, journal `run_finished reason "stopped"`, phase `stopped`. Stop during `finishing` skips the rest of the wait and runs the final check at once.
- `continue_run`: signs the portal in again, loads the state from the unfinished journal, re-reads the profile from `state.profile_raw` (so a profile file edited since does not change a run in flight), journals `resumed`, then proceeds as `start` does after the state exists. An `interrupted` entry is written with the journal's last `at` when the unfinished run has none.
- `snapshot()` → `{phase, error, connected: {server, email}, move: {name, servers, containers, trucks}, speed, started_at, elapsed, overall: {done, total}, stages: [{key, label, done, total}], trucks: {loaded, on_road, arrived, furthest: {name, percent}}, server: {waiting, waiting_peak, workers, failed_calls}, verdict, unfinished: …}`. `overall.done` is servers whose last stage is done.
- One run at a time: `start`/`continue_run` outside phase `checked`/`idle`-with-unfinished raise `RunnerError("bad_phase")`. Passwords are dropped from memory when a run ends.
- A new `connect` while a run is `running` raises `bad_phase`.

- [ ] **Step 1: Failing tests** (fake server, `FakeClock` driving `runner` through `clock.run`, fast speed, 45-server move): connect → check → start → run to `done`; `result()["verdict"] == "Pass"` (the test processes fake scans on a clock ticker) and `runs/*/results.json` + `events.log` + `journal.jsonl` exist; connect with a 2FA user returns `totp_required`, then connect again with the code returns moves; `totp="enroll"` → `RunnerError("totp_enroll")` with a message telling the user to finish 2FA setup in the portal; `start` before a passing check → `not_ready`; **Review Focus 4:** two `start()` calls awaited together → exactly one run folder and one `bad_phase`; `stop()` mid-run → phase `stopped`, verdict `Fail`, journal ends `run_finished`; a runner whose pipeline is cancelled hard (simulate a crash: drop the runner without `stop`) then a **new** `Runner` on the same `runs_dir` → `unfinished()` describes it, `continue_run(…)` finishes the move, the fake ends with exactly one processed scan per (server, checkpoint) when `process_scans(duplicate_on_replay=False)`, and `result()["run"]["interruptions"]` has one entry; `discard_unfinished()` → `unfinished()` is `None`; `snapshot()` JSON-serializes and contains none of: portal password, move password, 2FA code, any token or station key issued by the fake; none of those appear in any file under `runs/`.

- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** the whole suite → pass. **Commit:** `feat(loadtest): runner with stop and continue`.

---

### Task 13: Web app

**Files:**
- Create: `loadtest/src/loadtest/web/__init__.py`, `loadtest/src/loadtest/web/app.py`, `loadtest/src/loadtest/__main__.py`, `loadtest/tests/test_web.py`, placeholder `loadtest/src/loadtest/web/static/index.html` (replaced in Task 14)

**Interfaces:**
- Produces: `create_app(runner: Runner) -> FastAPI`; `python -m loadtest [--host 0.0.0.0] [--port 8795] [--runs-dir runs]`, which prints `Move load test: http://<lan-ip>:8795` (and the localhost URL) on start. Router URL comes from env `LOADTEST_ROUTER_URL` (default `https://router.project-osrm.org`).

| Route | Body → answer |
|---|---|
| `GET /` | the page |
| `GET /static/*` | page assets |
| `GET /api/state` | `runner.snapshot()` |
| `POST /api/connect` | `{server, email, password, totp_code?}` → `{status, moves?}` |
| `POST /api/check` | `{move_id, move_password, speed}` → `{checks: [{key, label, status, detail}], can_start, summary: {servers, containers, trucks, containers_needed, trucks_needed}}` |
| `POST /api/start` | → `202 {}` |
| `POST /api/stop` | → `202 {}` |
| `POST /api/continue` | `{email, password, move_password, totp_code?}` → `{status}` |
| `POST /api/discard` | → `{}` |
| `GET /api/result` | results.json content, or 404 |
| `GET /api/events` | `text/event-stream`: on connect, one `snapshot` event and one `feed` event per line in `events.recent()`; then `feed` events as they happen and a `snapshot` event every second while a run is active (every 5 s otherwise) |

Errors: `RunnerError` → `409 {"code", "message"}`; body validation → `422` **without echoing the request body** (install a `RequestValidationError` handler that returns field names only). No route ever returns a password, token or key. A feed event is `{at, time: "HH:MM:SS", device, action, subject, ok, ms, note}` with `time` in the runner machine's local 24-hour time.

- [ ] **Step 1: Failing tests** with `httpx.AsyncClient(transport=ASGITransport(app))` over a `Runner` on the fake server: state starts `idle`; connect → check → start → poll state to `done` → `GET /api/result` has a verdict; `POST /api/start` twice → second is 409 `bad_phase`; a 422 for `{"server": 5, "password": "SECRET-X"}` does not contain `SECRET-X`; **Review Focus 4:** two `/api/events` streams opened mid-run each receive a first `snapshot` event and the buffered `feed` lines, and both keep receiving; closing one leaves the other working and `runner.events` holds one subscriber fewer; `GET /` returns HTML; `python -m loadtest --help` exits 0.

- [ ] **Step 2: Run** → fail. **Step 3: Implement** (SSE by hand with `StreamingResponse`; send a `: keep-alive` comment every 15 s; stop the generator when the client disconnects). **Step 4: Run** → pass. **Commit:** `feat(loadtest): web app and event stream`.

---

### Task 14: The page

**Files:**
- Create: `loadtest/src/loadtest/web/static/index.html` (from `docs/mockups/data-generator.html` — see Step 1), `loadtest/src/loadtest/web/static/simulate.js`, `loadtest/src/loadtest/web/static/simulate.css`, `loadtest/tests/test_page.py`

**Interfaces:**
- Consumes: the Task 13 routes exactly as listed.

- [ ] **Step 1: Bring the generator page in.** The source file is **untracked** and exists only in the main checkout: copy `/Users/jrh1812/Developer/BaseCampV3/docs/mockups/data-generator.html` to `static/index.html`. Do not edit or remove the original. Keep its styles, tokens, light/dark handling and the whole Generate flow working as it is.

- [ ] **Step 2: Generate gains one summary line.** After a From-To list is generated, the existing summary also shows: `Containers needed: N · Trucks needed: M (20 per container, 15 containers per truck)`, where N = ceil(devices / 20), M = ceil(N / 15). No other change to Generate.

- [ ] **Step 3: Make the Simulate card live.** Remove its "Coming later" chip and disabled state; choosing it shows the Simulate view, built from the page's existing form, button, card and chip styles (no new visual language). Four states driven by `/api/state` and `/api/events`:
  1. **Connect** — fields Server, Portal email, Password, 2FA code (shown only after a `totp_required` answer), Move (a select filled from the connect answer; In-progress moves first, others shown with their status), Move password, Speed (two-option segmented control: Real time / Fast). Button **Check server**. If `snapshot.unfinished` is set, a panel above the form: "A run on {move_name} ({speed}) was interrupted — {done} of {servers} servers complete." with **Continue run** (asks for portal email, password, move password, and the code if asked) and **Start new run** (calls `/api/discard`).
  2. **Readiness** — one row per check: a pass / fail / warning mark, the label, the detail. Buttons **Start** (disabled until `can_start`) and **Check again**. A summary line: `{servers} servers · {containers} containers · {trucks} trucks · {speed}`.
  3. **Run** — laid out as the spec's "Step 3 — run" sketch: header line (move, counts, speed), overall bar with `done / total complete`, elapsed `HH:MM:SS`, **Stop**; one row per stage with `done/total` and a bar; a Trucks line (`loaded N · on the road N · arrived N`, plus the furthest truck's name and percent of route while any is on the road); a Server line (`waiting scans N (peak N) · workers a/b · failed calls N`); the live feed. Feed columns: time, device, action, subject, `ok`/`failed`, `N ms`. Newest at the bottom, auto-scrolling unless the user has scrolled up; at most 500 rows in the DOM. The feed scrolls inside its own panel with the page's styled scrollbar; the header, overall bar and Stop never scroll away. Stop asks "Stop this run? It cannot be picked up again." before calling `/api/stop`.
  4. **Result** — the verdict as a large chip (green Pass, amber Pass with warnings, red Fail), the findings list, then tables: calls (call, count, retries, failures, median, 95th, slowest in ms), scans (sent, processed, processed twice, never processed), scan delay, backlog (peak, catch-up time), and the run facts. A line with the folder the files were saved to. Button **New run** returns to Connect.
  On load and on every reconnect the page asks `/api/state` and shows the matching state, so a reopened page lands on the run in progress. `EventSource` reconnects by itself; on reconnect the feed panel is cleared before the buffered lines arrive.
  Errors from the API (`{code, message}`) show `message` in the form's existing error style. Password fields are `type="password"` with `autocomplete="off"` and are cleared after a successful connect and after start.

- [ ] **Step 4: Page tests** in `test_page.py` (string checks on the served files, no browser): `/` contains the Generate view's existing heading text and no "Coming later"; `simulate.js` references each of `/api/state`, `/api/connect`, `/api/check`, `/api/start`, `/api/stop`, `/api/continue`, `/api/discard`, `/api/result`, `/api/events`; `simulate.css` has a `prefers-color-scheme: dark` block or uses only the page's existing color variables (assert no hex color literal outside `:root`/theme blocks); neither file contains `localStorage.setItem` with a password field id.

- [ ] **Step 5: Look at it.** Start `python -m loadtest --port 8795` against the fake server (a tiny `tests/serve_fake.py` that runs the fake on port 8796 with a 60-server move and a ticker that processes scans), open the page, and walk Generate, Connect, Readiness, a Fast run to the result, Stop on a second run, and Continue after killing the runner mid-run — in light and dark and at 1280 and 390 px wide. Fix what looks wrong against the generator page's own look. Save screenshots of the four Simulate states to the scratchpad and name them in the task report.

- [ ] **Step 6: Run** the whole suite → pass. **Commit:** `feat(loadtest): generator and simulate page`.

---

### Task 15: Real-server run and README

**Files:**
- Create: `loadtest/tests/e2e/scratch_stack.sh`, `loadtest/tests/e2e/make_move.py`, `loadtest/README.md`
- Modify: whatever earlier-task code the real server proves wrong (each fix with a fake-server test that would have caught it)

This task is the only one that talks to a real server. It must not write to the dev database (`serversherpa` on the dev Postgres), must not stop, restart or replace any running dev process, and must not send any request to hosts other than localhost — the road route in this task comes from a canned route served by `make_move.py --serve-route 8797` (an OSRM-shaped answer for two made-up coordinates), set through `LOADTEST_ROUTER_URL`.

- [ ] **Step 1: `scratch_stack.sh up|down`.** `up`: create database `serversherpa_loadtest` on the dev Postgres container; restore `/Users/jrh1812/Developer/BaseCampV3/api/backups/clean-starter-20NOV26.sql` into it; run the API's migrations to head against it; start, from the main checkout's `api/.venv` and with the database URL overridden by environment only, an API on port 8010 (`--reload` off), one `scan-matching-worker` and one `import-worker`, each `nohup … &` with logs and pid files under the scratchpad. Read `api/src/serversherpa/config.py` for the setting names; if object storage can be pointed at a separate bucket by environment, do that, otherwise note in the README section "What the scratch stack shares" that import files land in the dev bucket. `down`: stop exactly the pids it started and drop the scratch database. Create a scratch super admin with the repo's own CLI (`bootstrap-admin`, then `set-password`) using a password generated at run time and written only to a file in the scratchpad; make sure that account is not asked for 2FA on the scratch database.

- [ ] **Step 2: `make_move.py`.** Using the portal API on the scratch server only: create two sites with made-up coordinates, generate a From-To CSV for `--servers N` (serial, make, model, source and destination rack and RU; RFID Tag blank), run the move-setup wizard calls (`/bulk/move-setup…`, spec §"What exists today") with `make_model_mode=force`, `containers_needed` crates and `trucks_needed` trucks, wait for the import worker, set the move `in_progress` with a kiosk password generated at run time. Print the move id.

- [ ] **Step 3: Fast run, 60 servers.** Start the tool against `http://localhost:8010`, drive it through its own HTTP API (connect, check, start), and wait for `done`. Expected: verdict `Pass with warnings` (the starter data has no rule for `on_truck` or `received`) with no `fail` finding; every server's move status `complete`; `scans.sent == scans.processed`; scan delay numbers present. Fix every mismatch between the clients and the real server found here, adding the matching rule to the fake.

- [ ] **Step 4: Real-time smoke.** Start a real-time run on a fresh 20-server move, let it run 3 minutes, check the feed shows enroll scans about 15 s apart per device and heartbeats each minute, then Stop. Expected: phase `stopped`, verdict `Fail` with the stopped line first.

- [ ] **Step 5: Continue.** Fresh 60-server fast run; kill the runner process (`kill -9`) about a third of the way; start it again; `GET /api/state` shows `unfinished`; continue; expected final verdict as in Step 3, and note in the task report how many scans the server processed twice.

- [ ] **Step 6: README.** Sections: What this is; Install (`python3 -m venv .venv && .venv/bin/pip install -e .`); Before a run (generate the From-To, create the move in the portal with the container and truck counts the page shows, set it In progress, set a move password; on a test server take a Developer › Database › Testing snapshot first); Start (`.venv/bin/python -m loadtest`, open the printed address); The two speeds and how long each takes; Changing the numbers (the profile files, with the stage table); The road route (which service is asked, what is sent, `LOADTEST_ROUTER_URL` to use your own); Reading the result (each verdict, each table, what "processed twice" means and why it happens); Continuing an interrupted run; What a run leaves on the server (scans, 32 "Load test" devices, truck updates, notifications) and how to clear it; Keeping the runner machine awake for a real-time run; Developing (tests, the fake server, the scratch stack).

- [ ] **Step 7:** `scratch_stack.sh down`; confirm no process it started is left and the scratch database is gone. Run the whole suite → pass. **Commit:** `feat(loadtest): real-server run fixes, e2e helpers and README`.
