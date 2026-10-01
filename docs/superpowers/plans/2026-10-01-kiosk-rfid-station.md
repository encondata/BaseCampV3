# Kiosk RFID Station / Label Station Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kiosk Setup on a laptop asks for the station type. An RFID Station finds, connects to and pairs a Zebra FX9600 (ZIOTC tag-data endpoint → this laptop) before the usual Move → Site → Scan type steps. The portal records `station_type` plus the paired reader's details.

**Architecture:**

- **Cloud:** migration 0086 adds `devices.station_type` and the reader columns. `/kiosk/setup` accepts them. The portal shows them.
- **Edge:** a new `edge/rfid/` package:
  - a ZIOTC client (password list);
  - subnet discovery driven by the laptop-written `host-network.json`;
  - pairing that rewrites the reader's `READER-GATEWAY.endpointConfig.data.event.connections` and verifies it.
- **Installers:** a per-OS host-network helper job, and the UI and reader ports published on `0.0.0.0`.
- **Kiosk UI:** the new steps.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic + Postgres (cloud); FastAPI + sqlite3 + httpx (edge); React 18 + vitest (kiosk, portal); bash 3.2 + PowerShell 5.1 (installers); pytest + Pester.

**Spec:** `docs/superpowers/specs/2026-10-01-kiosk-rfid-station-design.md`. Read it first; section numbers below refer to it. Zebra's ZIOTC OpenAPI was extracted to `/private/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/97f12195-f5cd-488e-abb6-b25f059d8083/scratchpad/ziotc-openapi.json`. Use it for exact response shapes (`readerversion.v1`, `readerstats.v1`, `readerConfigResponse`, `httpPost.v1`, `event.v1`).

## Global Constraints

**Copy and code style**
- American English in all copy and comments.

**Reader access (the ZIOTC client)**
- Username `admin`. Try passwords in this exact order: `Cumulus$G0`, `Cumulu$SG.`, `33q44w40x5`, `change`.
- Passwords are never returned to the browser, never logged and never sent to the cloud. Only the winning index is stored, per reader serial.
- Reader HTTPS runs with verify off. Timeouts: 3 s connect, 10 s read.
- Sign-in: `GET https://<ip>/cloud/localRestLogin` with basic auth. The response carries a token, sent afterwards as `Authorization: Bearer <token>`. Accept the token from a JSON body field `message` or `token`, or from a plain-text body.

**Discovery**
- Port 443, at most 64 connections at once, 0.5 s timeout.
- At most 512 hosts per scan. A subnet larger than /23 means scan the /24 that contains the laptop.
- Keep a host only when `/cloud/version` `model` starts with `FX`.

**Pairing**
- Our connection's `name` starts with the prefix `ServerSherpa Kiosk`; the full form is `ServerSherpa Kiosk <last4 of kiosk serial> (<kiosk name>)`.
- The URL is `http://<laptop-ip>:8091/rfid/<reader-serial>/<token>`. The token is 32 random URL-safe bytes, and it is redacted as `…` in every response and log.
- A reader holds at most 2 data connections.

**Host network file and ports**
- `host-network.json` lives in the data folder. It is stale after 5 minutes and is written every 60 seconds.
- Allowed hosts are re-read at most every 30 seconds.
- Ports: UI `0.0.0.0:8090:8090`, reader `0.0.0.0:8091:8091`.

**Cloud data**
- Migration **0086**. Before creating it, confirm 0086 is still free in every worktree (`git worktree list`, then each `api/migrations/versions`) and in the dev DB `alembic_version`.
- New `devices` columns: `station_type` (`label` | `rfid`, check constraint), `rfid_reader_ip inet`, `rfid_reader_serial text`, `rfid_reader_model text`, `rfid_reader_versions jsonb`, `rfid_paired_at timestamptz`.
- Error codes: `reader_required`, `rfid_needs_laptop` (422, cloud); `reader_unreachable`, `reader_auth_failed`, `reader_not_iotc`, `reader_error`, `reader_paired_elsewhere` (409), `reader_endpoints_full` (409), `reader_verify_failed`, `host_network_unknown` (edge).
- Portal labels: "RFID · Laptop" and "Label Station · Laptop". When `station_type` is null, keep the existing sub-type label.

**Parity, tests and commits**
- Installer parity: every installer change is made in both `install.sh` and `install.ps1`, with tests on both sides.
- Run tests in the FOREGROUND with a 600000 ms timeout. Never background a run.
  - API: from `api/`, `SS_TEST_DB=serversherpa_test_rfid_station PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest …`.
  - Edge: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q -rw`. Create the venv if it is missing: `python3 -m venv .venv && .venv/bin/pip install -q -e '.[dev]'`.
  - Installer: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q ../installer/tests`.
  - Kiosk: `npm --prefix kiosk test` and `npm --prefix kiosk run build`.
  - Portal: `npm --prefix portal test -- <files>` and `npm --prefix portal run build`.
  - Pester: portable pwsh at `/private/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/97f12195-f5cd-488e-abb6-b25f059d8083/scratchpad/pwsh/pwsh`. The modules path is noted in the kiosk-installer worktree's `.superpowers/sdd/task-5-report.md`.
  - Lint: shellcheck at `/opt/homebrew/bin/shellcheck`.
- The worktree needs gitignored symlinks before tests run: `portal/node_modules` and `kiosk/node_modules` to the main checkout's, and `api/.venv` plus `.env` to the main checkout's (`/Users/jrh1812/Developer/BaseCampV3/...`). Create them if missing.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Cloud — migration 0086, setup API, device payloads

**Files:**
- Create: `api/migrations/versions/0086_device_station_type.py`
- Modify: `api/src/serversherpa/db/models.py` (`Device`), `api/src/serversherpa/api/schemas.py` (`KioskSetupIn`, new `KioskReaderIn`, `DeviceItem` and the detail schema the devices routes return), `api/src/serversherpa/api/routes/kiosk.py` (`kiosk_setup`), `api/src/serversherpa/api/routes/devices.py` (list/detail mapping)
- Test: `api/tests/test_kiosk_station_setup.py`, and extend the migration-chain test that exists for 0085 (grep `0085` in `api/tests`) to cover 0086

**Interfaces (produced):**
- `KioskReaderIn {ip: IPvAnyAddress (IPv4), serial: str ≤64, model: str ≤64, versions: dict[str, str ≤64] ≤10 keys}`
- `KioskSetupIn.station_type: Literal['label','rfid'] | None = None` and `KioskSetupIn.reader: KioskReaderIn | None = None`
- Device payloads gain `station_type: str | None` and `rfid_reader: {ip, serial, model, versions, paired_at} | None`

**Behavior (spec §3.2):**
- `rfid` without `reader` returns 422 `reader_required`.
- `rfid` when `device.sub_type != 'laptop'` returns 422 `rfid_needs_laptop`.
- `rfid` sets the reader columns and `rfid_paired_at = now`.
- `label` clears all reader columns.
- `None` leaves both untouched.
- Audit `kiosk_station_setup` with the diff, only when something changed.
- The existing move lock still applies.
- The heartbeat does not touch these columns (add a test).

- [ ] Write failing tests:
  - migration up/down
  - each validation code
  - label clears
  - omit leaves untouched
  - move-locked session still refused
  - audit row
  - list and detail include the fields
  - heartbeat leaves them unchanged

  Use the existing helpers in `tests/test_kiosk_setup_api.py`: `_seed_initiatives`, the `Device(device_type="kiosk", serial=…, sub_type="laptop")` setup, `login`.
- [ ] Implement.
- [ ] Run: `tests/test_kiosk_station_setup.py tests/test_kiosk_setup_api.py tests/test_kiosk_heartbeat_api.py tests/test_devices*.py` plus the migration chain test.
- [ ] Commit: `feat(kiosk): devices.station_type and paired RFID reader (migration 0086); /kiosk/setup accepts them`

### Task 2: Portal — Kiosk Devices type label, filter, Reader panel

**Files:** modify `portal/src/pages/KioskDevices.tsx` and `portal/src/lib/devices.ts` (type + label helper); test `portal/src/pages/KioskDevices.test.tsx`.

**Behavior (spec §3.4):**
- Add `stationTypeLabel(d)` to `lib/devices.ts`:
  - `rfid` + `laptop` → "RFID · Laptop"
  - `label` + `laptop` → "Label Station · Laptop"
  - any other non-null station type → `<Station> · <subTypeLabel>`
  - null → `subTypeLabel(d.sub_type)`
- The existing **Type** column (`sub_type` key), its cell text, its ColumnMenu filter options and its group key all use `stationTypeLabel`. That gives the filter for free, because the column filter options come from the rendered labels.
- Add a **Reader** panel in the kiosk's existing expansion/detail UI, following the file's existing expansion pattern and portal UI idioms (no raw native controls). It is shown only when `rfid_reader` is set, with rows for IP, model, serial, versions (reader app, radio, cloud agent) and paired time (local format).
- Column-floor rules: if the Type column needs more width for "Label Station · Laptop", follow the list-column-floors recipe (short/long header, floor in px, `cell-line`). Check `portal/src/lib/listColumns*` or the guardrail tests if width changes.

- [ ] Write failing vitest cases:
  - label mapping
  - filter options include both labels
  - Reader panel rendered for an RFID kiosk and absent otherwise
- [ ] Implement.
- [ ] Run the KioskDevices tests, the list guardrail tests (grep `guardrail` in `portal/src`), and `npm --prefix portal run build`.
- [ ] Commit: `feat(portal): Kiosk Devices shows RFID / Label Station type and the paired reader`

### Task 3: Edge — ZIOTC client and fake reader

**Files:**
- Create: `kiosk_laptop/edge/src/edge/rfid/__init__.py`, `kiosk_laptop/edge/src/edge/rfid/ziotc.py`
- Create: `kiosk_laptop/edge/tests/fake_reader.py` (an ASGI app that imitates a reader, served to the client through `httpx.ASGITransport` or respx)
- Test: `kiosk_laptop/edge/tests/test_ziotc.py`

**Interfaces (produced):**
- `PASSWORDS: tuple[str, ...]` in the global order.
- `class ReaderError(Exception)` with `code: str` and `message: str`. Codes: `reader_unreachable`, `reader_auth_failed`, `reader_not_iotc`, `reader_error`.
- `class ZiotcClient(ip: str, *, transport=None, password_first: int | None = None)`. Every call is `async`:
  - `login() -> int`: returns the password index that worked.
  - `version() -> dict`
  - `status() -> dict`
  - `get_config() -> dict`
  - `put_config(payload: dict) -> None`
  - `aclose()`
- `async def probe(ip, transport=None, password_first=None) -> dict | None`: returns `{ip, model, serial, versions, status, password_index}`, or `None` when the host isn't an FX reader. Raises `ReaderError` for auth/unreachable only when called directly from connect, not from discovery.
- `versions` = `{readerApplication, radioFirmware, cloudAgentApplication}` taken from `/cloud/version`.

**Behavior:**
- Try the password at `password_first` first, then the rest in order.
- 401/403 → next password; all fail → `reader_auth_failed`.
- Transport error or timeout → `reader_unreachable`.
- 404 on `/cloud/*` → `reader_not_iotc`.
- 422/500 → `reader_error` carrying the reader's `message`.
- Never put a password in an exception message, log line or repr.

**Fake reader:**
- Configurable password (by index); `version` and `status` from the spec examples; an in-memory config with `READER-GATEWAY.endpointConfig.data.event.connections`.
- `PUT /cloud/config` enforces the 2-connection limit with the spec's 422 message.
- Modes: `not_iotc` (404 everywhere), `unreachable` (raise a transport error), and `verify_mismatch` (the PUT succeeds but the GET returns the old config).

- [ ] Write failing tests for each behavior above, including that the password index is honored first.
- [ ] Implement.
- [ ] Run the edge suite.
- [ ] Commit: `feat(kiosk-laptop): ZIOTC client for Zebra FX readers with the password list, and a fake reader for tests`

### Task 4: Edge — host network file, allowed hosts, LAN notice

**Files:**
- Create: `kiosk_laptop/edge/src/edge/hostnet.py`
- Modify: `kiosk_laptop/edge/src/edge/app.py` (TrustedHostMiddleware allowed hosts become dynamic; `/config.js` adds `lanAccess`)
- Test: `kiosk_laptop/edge/tests/test_hostnet.py`

**Interfaces (produced):**
- `@dataclass HostInterface(name: str, ipv4: str, prefix: int)`
- `read_host_network(data_dir, *, now=None) -> tuple[list[HostInterface], bool]`: returns `(interfaces, fresh)`, where fresh means `updated_at` is within 300 s. Missing or unparseable file → `([], False)`.
- `laptop_ip_for(reader_ip, interfaces) -> str | None`: the interface whose network contains `reader_ip`.
- `scan_targets(interfaces) -> list[str]`: host IPs per spec §2.2, deduplicated, at most 512 per interface, excluding the laptop's own IPs.
- `class DynamicHosts`: re-reads `host-network.json` at most every 30 s and exposes `allowed() -> set[str]`, which is `localhost`, `127.0.0.1`, `[::1]`, `EDGE_ALLOWED_HOSTS`, plus the fresh IPs.
  - Replace the static TrustedHostMiddleware with a small middleware that uses it. Keep the 400 for unknown hosts, and keep `edge.test` working in tests via `EDGE_ALLOWED_HOSTS` as the existing tests do.
- `/config.js` includes `"lanAccess": true|false`, true when the request `Host` is neither localhost nor a loopback address.

- [ ] Write failing tests:
  - fresh/stale/missing file
  - `laptop_ip_for`
  - `scan_targets` for a /24, a /22 (falls back to the /24) and a /30
  - the allowed-hosts refresh (a new IP is accepted after the file changes and 30 s pass, using an injectable clock)
  - an unknown host gets 400
  - `lanAccess` true for a LAN host, false for localhost
- [ ] Implement.
- [ ] Run the edge suite.
- [ ] Commit: `feat(kiosk-laptop): laptop network file, dynamic allowed hosts, LAN-access flag`

### Task 5: Edge — discovery job and endpoints

**Files:**
- Create: `kiosk_laptop/edge/src/edge/rfid/discovery.py`, `kiosk_laptop/edge/src/edge/routes/rfid.py` (router with prefix `/edge/rfid`)
- Modify: `app.py` (include the router ABOVE the catch-all; put the discovery service on `app.state`)
- Test: `kiosk_laptop/edge/tests/test_rfid_discovery.py`

**Interfaces:**
- `class Discovery(store, data_dir, *, connect=…, probe=…)`. `connect` is an injectable async TCP-connect check and `probe` is `ziotc.probe`.
  - `start() -> str` returns a scan id and cancels any running scan.
  - `snapshot() -> dict` has the shape in spec §2.2.
- Endpoints (edge session required):
  - `POST /edge/rfid/scan` → `{scan_id}`
  - `GET /edge/rfid/scan` → snapshot
- `paired_with`: when a probed reader's config holds a connection whose name starts with `ServerSherpa Kiosk` and is not this kiosk's, report its name. The probe needs `get_config` for this; do it within the same signed-in client.
- The scan runs as an asyncio task with a semaphore of 64. `probed` and `total` update as it goes.
- With no fresh interfaces: `state = 'failed'`, `host.fresh = false`, no scanning.

- [ ] Write failing tests (inject `connect` and `probe` fakes; never touch the real network):
  - progress counts
  - FX hosts kept, non-FX dropped
  - a timeout counted as probed
  - a rescan cancels the earlier one
  - stale host → failed
  - an unauthenticated request → 401
- [ ] Implement.
- [ ] Run the edge suite.
- [ ] Commit: `feat(kiosk-laptop): FX reader discovery on the laptop's subnet`

### Task 6: Edge — connect, pair, pass-through to /kiosk/setup

**Files:**
- Create: `kiosk_laptop/edge/src/edge/rfid/pairing.py`
- Modify: `routes/rfid.py`; `db.py` (append a SCHEMA_STEP with tables `rfid_readers(serial PK, ip, model, versions TEXT, password_index INT, token TEXT, laptop_ip, paired_at)` and `rfid_pairing(id INTEGER PRIMARY KEY CHECK(id=1), serial)`); `routes/kiosk.py` (the setup route adds `station_type` and `reader`)
- Test: `kiosk_laptop/edge/tests/test_rfid_pairing.py`

**Endpoints:**
- `POST /edge/rfid/connect {ip}` → `{ip, model, serial, versions, status, paired_with}`. It stores the password index.
- `POST /edge/rfid/pair {ip, laptop_ip?, confirm_takeover?}` follows the steps in spec §2.4 and returns `{paired: true, reader: {ip, serial, model, versions, paired_at}, endpoint_url: <redacted>}`.
  - It needs a laptop IP: `laptop_ip` from the body, else `laptop_ip_for(ip, fresh interfaces)`. If neither is available → 409 `host_network_unknown`.
- `GET /edge/rfid/reader` → the current pairing, or null.
- Setup pass-through: the edge `/kiosk/setup` request body may carry `station_type` (`label` | `rfid`) from the browser.
  - For `rfid`, the edge adds `reader` from the current pairing; with no pairing → 409 `reader_required`.
  - For `label`, it forwards `station_type` only.

- [ ] Write failing tests against the fake reader:
  - connect success and each error
  - pair adds our connection; keeps others; replaces our own earlier connection
  - pair refuses a third connection
  - takeover → 409 with the name; with confirm it succeeds
  - verify mismatch → `reader_verify_failed`
  - the token is redacted in the response and in caplog
  - no laptop IP → `host_network_unknown`
  - setup pass-through adds `reader` for rfid and refuses without a pairing
- [ ] Implement.
- [ ] Run the edge suite.
- [ ] Commit: `feat(kiosk-laptop): connect to and pair an FX reader (ZIOTC endpoint → this laptop); setup sends the station type and reader`

### Task 7: Installers — host-network helper, LAN ports, README

**Files:**
- Modify: `kiosk_laptop/installer/install.sh`, `install.ps1`, `docker-compose.yml` (runtime template: `0.0.0.0:8090:8090` and `0.0.0.0:8091:8091`), `kiosk_laptop/docker-compose.yml` (dev: the same ports; drop the `EDGE_BIND` 127.0.0.1 default or default it to 0.0.0.0), `kiosk_laptop/README.md`
- Create: `kiosk_laptop/installer/hostnet.sh` and `kiosk_laptop/installer/hostnet.ps1`
- Tests: in the installer pytest and Pester suites

**Behavior (spec §2.1):**
- Each helper prints nothing and writes `<data dir>/host-network.json` atomically. Exclusion rules follow the spec.
- Parsing is a separate testable function, fed captured tool output:
  - `ip -j -4 addr` (Linux)
  - `ifconfig` + `networksetup -listallhardwareports` (macOS)
  - `Get-NetIPAddress` / `Get-NetAdapter -Physical` objects (Windows; mock them)
- Jobs:
  - Linux: `serversherpa-kiosk-hostnet.service` + `.timer` (`OnBootSec=10s`, `OnUnitActiveSec=60s`, runs as root).
  - macOS: launch agent `com.serversherpa.kiosk.hostnet` (`StartInterval` 60, `RunAtLoad`), running as the desktop user. Writable for that user: the data folder is owned by the desktop user on macOS.
  - Windows: scheduled task `ServerSherpa Kiosk Host Network`, hidden, at logon and repeating every 1 minute indefinitely, running as the desktop user, battery-allowed. The data folder ACL already grants the desktop user write access; confirm it.
- The installer installs the helper alongside `update.*`/`launch.*` and registers the job. Uninstall removes it. Both directions are tested on both sides.
- README: replace the "keep 127.0.0.1" text with a "Using the kiosk from other devices" section: the URL `http://<laptop-ip>:8090`, unencrypted, label printing only on the laptop. Add an "RFID station" section: pairing runs from Kiosk Setup, the reader needs IoT Connector Local REST mode, and port 8091 is used.

- [ ] Write failing tests:
  - parser outputs for each OS's sample text/objects, including exclusions
  - the atomic write
  - job unit/plist/task specs
  - install registers the job; uninstall removes it
  - the compose template ports
- [ ] Implement. Run the installer pytest, shellcheck, Pester and PSScriptAnalyzer.
- [ ] Commit: `feat(kiosk-installer): host-network helper job on all three OSes; kiosk UI and reader ports on 0.0.0.0`

### Task 8: Kiosk UI — station type and RFID steps

**Files:**
- Modify: `kiosk/src/pages/KioskSetup.tsx` (+ test), `kiosk/src/lib/api.ts` (rfid helpers, `station_type` in `submitKioskSetup`), `kiosk/src/lib/kioskSetup.ts` (selection gains `stationType` and an optional `reader` summary; old saved selections without them stay valid), `kiosk/src/layout/KioskShell.tsx` (footer mode label), `kiosk/src/components/ThisKioskPanel.tsx` (station type and reader), `kiosk/src/pages/Login.tsx` (LAN notice when `window.__KIOSK_CONFIG__.lanAccess`), `kiosk/src/lib/config.ts` (type for `lanAccess`)
- Possibly create step components under `kiosk/src/components/setup/` to keep `KioskSetup.tsx` focused, e.g. `StationTypeStep.tsx`, `ReaderStep.tsx`, `ConnectStep.tsx`, `PairStep.tsx`, `RfidPlaceholderStep.tsx`

**Interfaces (api.ts):**
- `startReaderScan(): Promise<{scan_id: string}>`
- `getReaderScan(): Promise<ReaderScan>`
- `connectReader(ip): Promise<ReaderInfo>`
- `pairReader({ip, laptop_ip?, confirm_takeover?}): Promise<PairResult>`
- `getPairedReader(): Promise<PairedReader | null>`
- `submitKioskSetup` body gains `station_type`

**Behavior (spec §1):**
- Steps and labels exactly as in the spec. The count depends on the path.
- **Back** works on every step. Re-entering setup pre-selects the saved station type.
- In laptop mode only:
  - Step 1 offers both cards.
  - In web mode (not a laptop) the station-type step is skipped and the setup behaves exactly as today. RFID needs the laptop edge.
- Reader step:
  - polls `getReaderScan` every 1 s while running
  - shows a progress bar
  - shows cards with "Already paired with …"
  - offers **Scan again** and **Enter IP manually** (IPv4 validation)
  - when the host is not fresh: an explanation plus manual reader IP and laptop IP fields
- Connect step: shows the details listed in spec §1.2, with error messages mapped from the codes.
- Pair step:
  - takeover confirm, using the existing confirm/modal idiom (modal header pattern)
  - success message
  - **Try again**
- Placeholder step: "RFID settings — coming soon" and **Continue**.
- Finishing sends `station_type`.
- The footer and This Kiosk show "RFID · Laptop" / "Label Station · Laptop" once set.
- Reuse the existing setup-card, page and button classes; no new CSS unless a needed class is missing.

- [ ] Write failing vitest cases:
  - web mode unchanged
  - laptop mode label path count
  - RFID path through every step with mocked api
  - back navigation
  - manual IP validation
  - stale-host fields
  - each connect error message
  - takeover confirm
  - pair success
  - `submitKioskSetup` called with `station_type`
  - footer label
  - LAN notice on Login
- [ ] Implement.
- [ ] Run `npm --prefix kiosk test` and `npm --prefix kiosk run build`.
- [ ] Commit: `feat(kiosk): station type step and RFID reader setup (find, connect, pair)`

### Task 9 (controller): Live verification

The controller runs this, not an implementer.

1. **Branch API:** start the branch API on :8001 from this worktree.
2. **Image:** build the image and run it through the installer's runtime compose on this Mac, the same way as the earlier live installer test (local registry plus a promote helper; the user types sudo in the Terminal pane). The user must approve the live install again first.
3. **Fake FX reader on the LAN:** run the fake reader as a real HTTPS server on this Mac's LAN IP, port 443. Use a scratchpad script with a self-signed cert and `uvicorn` from the edge venv. Binding 443 needs sudo, so run it through the Terminal pane, or put it on another port and use manual IP entry with an `ip:port` form if the edge supports it. Then:
   - drive Kiosk Setup in the browser: RFID → scan (or manual IP) → connect → pair → placeholder → move/site/scan type;
   - confirm the fake reader's config now holds our `httpPost` connection;
   - confirm the portal's Kiosk Devices shows "RFID · Laptop" and the Reader panel.
4. **Label path:** run Kiosk Setup again choosing Label Station, and confirm the portal shows "Label Station · Laptop" with the reader cleared.
5. **LAN access:** from this Mac's LAN IP (`http://<ip>:8090`), the kiosk loads and the login shows the unencrypted notice.
6. **Record and clean up:** write results into the spec's Implementation notes, then uninstall.
