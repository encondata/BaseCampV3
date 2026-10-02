# Kiosk RFID Network Check, Confirm & Verify, /rfid_status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the RFID placeholder step with a Network check, filter step 8 to RFID scan types, add a Confirm & verify step 9 with Start Reader, and add a `/rfid_status` placeholder page.

**Architecture:**
- The edge (FastAPI, `kiosk_laptop/edge`) gains `GET /edge/rfid/checks/{name}`, which runs one check per call, plus reader start/stop/status endpoints.
- The installer's host-network helpers add the default gateway to `host-network.json`.
- The cloud API returns the caller's public IP on the heartbeat and gains a read-back `GET /kiosk/setup`.
- The kiosk (React/Vite, `kiosk/`) adds two wizard steps and one page that call the edge.

**Tech Stack:** Python 3.12 / FastAPI / httpx / sqlite3 (edge), FastAPI + SQLAlchemy async + Postgres (API), React 18 + TypeScript + vitest (kiosk), bash 3.2 + PowerShell 5.1 (installer).

**Spec:** `docs/superpowers/specs/2026-10-02-kiosk-rfid-network-check-design.md`. Read it; it is binding.

## Global Constraints

- **Where to work:** worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/rfid-station`, branch `rfid-station`.
- **Staging:** stage files **by explicit path only**. Never use `git add -A`, `git add .` or `git add -f`. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Suites run in the FOREGROUND**, with a 600000 ms timeout:
  - Edge: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`
  - Installer: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q ../installer/tests`, plus `shellcheck kiosk_laptop/installer/*.sh`
  - Pester: portable pwsh at `/private/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/97f12195-f5cd-488e-abb6-b25f059d8083/scratchpad/pwsh/pwsh`. Run `Invoke-Pester kiosk_laptop/installer/tests/hostnet.Tests.ps1`. The modules path is in `../kiosk-installer/.superpowers/sdd/task-5-report.md`.
  - API: `cd api && SS_TEST_DB=serversherpa_test_rfid_station PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q <files>`
  - Kiosk: `npm --prefix kiosk test -- --run` and `npm --prefix kiosk run build`
- **Copy:** all copy, comments and docs use American English.
- **Check response shape** (spec §2), always HTTP 200:
  - `{"name": str, "ok": bool, "state": "ok"|"fail"|"unknown", "detail": str, "info"?: dict}`
  - `ok` is `state == "ok"`.
- **Check names**, in this order: `reader`, `router`, `portal`, `registration`, `setup`.
  - Step 5 runs the first four.
  - Step 9 runs `reader`, `portal`, `setup`.
- **Gateway probe:** ports `(53, 80, 443)`, timeout `1.5` s each, run concurrently. A connection refused counts as reachable.
- **Start sends** `PUT /cloud/start` with body `{"doNotPersistState": false}`.
- **Stop sends** `PUT /cloud/stop` with no body; this already exists as `ZiotcClient.stop()`.
- **Token rule:** the pairing token never appears in any response or log. Use `pairing.redact_url`.
- **RFID scan-type filter:** `label.toLowerCase().includes('rfid')`, RFID path only.
- **Network check:** waits for the operator to click Continue; it never auto-advances.
- **`/rfid_status` poll interval:** `5000` ms.
- **No migration.**

---

### Task 1: Gateway in host-network.json (installer helpers)

**Files:**
- Modify: `kiosk_laptop/installer/hostnet.sh`
- Modify: `kiosk_laptop/installer/hostnet.ps1`
- Test: `kiosk_laptop/installer/tests/test_hostnet_sh.py`
- Test: `kiosk_laptop/installer/tests/hostnet.Tests.ps1`

**Interfaces:**
- Produces the `host-network.json` key `"gateway": "<ipv4>"`, written after `"interfaces"` and omitted when there is no default route or it isn't a usable IPv4 address (not loopback, unspecified, link-local, multicast or broadcast).
- Consumed by Task 2's `read_gateway`.

**bash (`hostnet.sh`):**
- Add `parse_gateway_macos`: reads `route -n get default` output on stdin and prints the value of the `gateway:` line.
- Add `parse_gateway_linux`: reads `ip -j -4 route show default` on stdin and prints the first `"gateway"` value. Use awk, the same way `parse_linux` does; bash 3.2, no jq.
- Add `usable_gateway`: prints its argument only when it is a dotted-quad IPv4 address with every octet 0–255, and is not `0.0.0.0`, `127.*`, `169.254.*`, `224.0.0.0` and above, or `255.255.255.255`.
- Add `gateway`: runs the OS tool, ignores its failure, and prints the usable gateway or nothing.
- `to_json STAMP [GATEWAY]`: when GATEWAY is non-empty, append `, "gateway": "<gw>"` before the closing brace.
- `main`: pass `"$(gateway)"` to `to_json`.
- A failure of the route tool must not fail the run: the interfaces are still written.

```bash
# parse_gateway_macos: `route -n get default` on stdin -> the gateway address.
parse_gateway_macos() { awk '$1 == "gateway:" { print $2; exit }'; }

# parse_gateway_linux: `ip -j -4 route show default` on stdin -> the first gateway.
parse_gateway_linux() {
  tr ',' '\n' | awk -F '"' '$2 == "gateway" { print $4; exit }'
}

# usable_gateway IP: IP when it is a unicast, non-loopback, non-link-local IPv4.
usable_gateway() {
  printf '%s\n' "$1" | awk -F . '
    NF != 4 { exit 1 }
    { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i > 255) exit 1 }
    $1 == 0 || $1 == 127 || $1 >= 224 || ($1 == 169 && $2 == 254) { exit 1 }
    { print; exit 0 }'
}

# gateway: this OS's default gateway, or nothing.
gateway() {
  local raw
  if [ "$OS" = Darwin ]; then
    raw=$(route -n get default 2>/dev/null | parse_gateway_macos)
  else
    raw=$(ip -j -4 route show default 2>/dev/null | parse_gateway_linux)
  fi
  [ -n "$raw" ] && usable_gateway "$raw"
  return 0
}
```

**Tests (pytest, library mode, following the existing `test_hostnet_sh.py` helpers):**
- `parse_gateway_macos` on a real-looking `route -n get default` capture (`   route to: default` / `destination: default` / `       mask: default` / `    gateway: 10.10.48.1` / `  interface: en0`) gives `10.10.48.1`.
- `parse_gateway_linux` on `[{"dst":"default","gateway":"10.10.48.1","dev":"eth0","protocol":"dhcp","prefsrc":"10.10.48.57","metric":100,"flags":[]}]` gives `10.10.48.1`. On `[]` it gives an empty string.
- `usable_gateway` is parametrized: it accepts `10.10.48.1` and `192.168.1.254`, and rejects `0.0.0.0`, `127.0.0.1`, `169.254.1.1`, `224.0.0.1`, `255.255.255.255`, `10.0.0`, `10.0.0.256` and `fe80::1`.
- `to_json` with a gateway gives JSON whose `json.loads(...)["gateway"] == "10.10.48.1"`. Without one, the `"gateway"` key is absent.
- **main (Linux):** with a stub `ip` that answers `addr` and `route` differently, the written file has `gateway`.
- **main (macOS):** with a stub `route`, the written file has `gateway`.
- **main:** when the route stub exits 1, the file is still written, without `gateway`.

**PowerShell (`hostnet.ps1`):**
- `Get-HostnetGateway -Routes <objects>` returns the `NextHop` of the route with the lowest `RouteMetric + InterfaceMetric`, skipping `0.0.0.0`. The result is validated with the existing `Test-HostnetAddress`, or the same rules if that function's meaning differs; read it first. It returns `$null` when nothing qualifies.
- `ConvertTo-HostNetworkJson` gains `[string]$Gateway`. When it is set, append `,"gateway":` + `(ConvertTo-Json -InputObject $Gateway -Compress)` before the closing `}`.
- `Invoke-HostNetwork`: `$routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)`. A failure gives no gateway, never exit 1. Pass the result to `ConvertTo-HostNetworkJson`.
- **Pester:**
  - lowest metric wins;
  - `0.0.0.0` is skipped;
  - no routes gives `$null`;
  - the JSON has or omits `gateway`;
  - `Invoke-HostNetwork` with `Get-NetRoute` mocked to throw still writes the file.

- [ ] Write the failing pytest and Pester tests above; run them; they fail.
- [ ] Implement the bash functions and the PowerShell functions.
- [ ] Run the installer pytest suite, shellcheck, and the Pester hostnet tests; all pass.
- [ ] Update the header comment of each script to show `"gateway"` in the example JSON.
- [ ] Commit: `feat(installer): host-network helpers record the default gateway`

---

### Task 2: Edge — gateway reader, reader start/stop/status

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/hostnet.py` (add `read_gateway`)
- Modify: `kiosk_laptop/edge/src/edge/rfid/ziotc.py` (add `start`)
- Modify: `kiosk_laptop/edge/src/edge/rfid/pairing.py` (add `current_client` helper)
- Modify: `kiosk_laptop/edge/src/edge/routes/rfid.py` (add start/stop/status routes)
- Modify: `kiosk_laptop/edge/tests/fake_reader.py` (`/cloud/start`; `radioActivity` follows `reading`)
- Test: `kiosk_laptop/edge/tests/test_hostnet.py`, `kiosk_laptop/edge/tests/test_rfid_reader_control.py` (new), `kiosk_laptop/edge/tests/test_ziotc.py`

**Interfaces:**
- `hostnet.read_gateway(data_dir, *, now=None) -> str | None`: the `gateway` from a fresh file (same freshness rule as `read_host_network`), validated as IPv4 with `_usable`. Otherwise None. Never raises.
- `ZiotcClient.start(persist: bool = True) -> None`: `await self._call("PUT", "/cloud/start", json={"doNotPersistState": not persist})`.
- `pairing.open_current(store, *, transport) -> tuple[ZiotcClient, dict, Row]`: opens the current paired reader through `open_reader(store, row["ip"], transport=transport)`. With no pairing it raises `err(409, "reader_required")`. The caller closes the client.
- **Edge routes** (prefix `/edge/rfid`, all need an edge session):
  - `POST /start`: depends on `online`; holds `pair_lock`; `open_current`; `client.start()`. Returns `{"reading": true}`. `ReaderError` goes through `pairing.reader_http_error`.
  - `POST /stop`: no `online` needed; holds `pair_lock`; `client.stop()`. Returns `{"reading": false}`.
  - `GET /status`: holds `pair_lock`.
    - No pairing: `{"reader": null}`.
    - Otherwise: `{"reader": pairing.current(store), "reachable": bool, "reading": bool, "radio": str|None}`.
    - `reading` is `ziotc.is_reading(status)` (the real field is `radioActivity`; the old `radioActivitiy` also counts). `radio` is `status.get("radioConnection")`.
    - Any `ReaderError` gives `reachable: false, reading: false, radio: null`, still HTTP 200.

**Fake reader:**
- `PUT /cloud/start` (bearer required): appends the JSON body to `reader.starts`, sets `reader.reading = True`, and answers `HTMLResponse("")`.
- `/cloud/status` returns `{**reader.status, "radioActivity": "active" if reader.reading else "inactive"}`.
- Initialize `self.starts: list = []`.

```python
# edge/routes/rfid.py additions
@router.post("/start", dependencies=[Depends(online)])
async def start(request: Request) -> dict:
    st = request.app.state
    async with st.pair_lock:
        try:
            client, _version, _row = await pairing.open_current(st.store, transport=st.reader_transport)
            async with client:
                await client.start()
        except ReaderError as exc:
            raise pairing.reader_http_error(exc) from None
    return {"reading": True}
```

(`ZiotcClient` is an async context manager already; `__aexit__` closes it.)

**Tests (`test_rfid_reader_control.py`):** reuse the helpers in `test_rfid_pairing.py` (`use_reader`, `pair`, `make_session`), importing them or copying the small ones.
- Each of start, stop and status needs a session (401 without one).
- With no pairing:
  - start and stop answer 409 `reader_required`;
  - status answers `{"reader": None}`.
- After pairing:
  - start gives 200 `{"reading": True}`, and `reader.starts == [{"doNotPersistState": False}]`;
  - status then gives `reading: True`, `reachable: True`, `radio: "connected"`;
  - stop gives `{"reading": False}`, with `reader.stops` incremented and status `reading: False`.
- Start with an offline session gives 503 `edge_offline`. Stop with an offline session works.
- With the reader in `unreachable` mode after pairing, status gives `reachable: False`, HTTP 200.
- A response body never contains the stored token: check `stored(app)["token"] not in r.text` for all three.

**`test_hostnet.py`:**
- `read_gateway`: fresh file with a gateway gives the gateway.
- Missing key, stale file, garbage value (`"x"`, `"127.0.0.1"`) and a missing file all give None.

**`test_ziotc.py`:** `start()` sends `{"doNotPersistState": False}`; `start(persist=False)` sends `True`.

- [ ] Write the failing tests; run them; they fail.
- [ ] Implement.
- [ ] Run the full edge suite; all pass.
- [ ] Commit: `feat(edge): reader start/stop/status and the host gateway`

---

### Task 3: Cloud API — heartbeat `client_ip`, version kept, `GET /kiosk/setup`

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (add `HeartbeatOut.client_ip`; add `KioskSetupReadOut`, `KioskSetupReaderOut`)
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (heartbeat; new GET route)
- Test: `api/tests/test_kiosk_heartbeat_api.py`, `api/tests/test_kiosk_station_setup.py`

**Interfaces:**

```python
class HeartbeatOut(BaseModel):
    device_id: uuid.UUID
    name: str
    registration: Literal["ok", "soon", "expired", "none"]
    token_expires_at: datetime | None
    client_ip: str | None = None   # the caller's public address as the API sees it

class KioskSetupReaderOut(BaseModel):
    ip: str | None
    serial: str
    model: str | None

class KioskSetupReadOut(BaseModel):
    device_id: uuid.UUID
    initiative_id: uuid.UUID | None
    initiative_name: str | None
    site_id: uuid.UUID | None
    site_name: str | None
    scan_status: str | None
    scan_status_label: str | None
    station_type: Literal["label", "rfid"] | None
    reader: KioskSetupReaderOut | None
```

**Heartbeat changes:**
- Add a `request: Request` parameter.
- `client_ip=client_ip(request)` uses `serversherpa.api.deps.client_ip`.
- In the existing-device branch, write `device.version = body.version` only `if body.version is not None`.

**`GET /kiosk/setup`:**
- Signature: `serial: str = Query(min_length=1, max_length=120)`, `require_permission("kiosk", "view")`.
- Find the `Device` by serial with `device_type == "kiosk"`. If there is none: `_err(404, "device_not_found")`.
- **Move-password session** (`actor.session.initiative_id is not None`): if `device.current_initiative_id != actor.session.initiative_id`, answer 404 `device_not_found`.
- **Field sources:**
  - `initiative_name` and `site_name`: `db.get(Initiative, ...)` and `db.get(Site, ...)`.
  - `scan_status_label`: `db.get(StatusValue, ("asset", device.scan_status))`, then its `.label`.
  - `reader`: set when `device.rfid_reader_serial` is set, as `{ip: str(device.rfid_reader_ip) if set, serial, model}`.
- **Route order:** register the GET next to the existing `POST /setup`. GET and POST on the same path don't conflict, but check nothing like `/setup/{x}` shadows it.

**Tests:**
- **Heartbeat:**
  - `client_ip` equals the request's client host when there's no proxy header, and the forwarded address when a trusted XFF is present (follow how existing tests exercise `client_ip`; grep `x-forwarded-for` in `api/tests`).
  - A beat without `version` keeps the stored version.
- **`GET /kiosk/setup`:**
  - After `POST /kiosk/setup` with `station_type: "rfid"` and a reader, GET returns the names, label, `station_type: "rfid"` and the reader serial. The token is never involved.
  - An unknown serial gives 404 `device_not_found`.
  - A move-password session for another move gives 404.
  - A missing `kiosk:view` gives 403.

- [ ] Write the failing tests; run them; they fail.
- [ ] Implement.
- [ ] Run `tests/test_kiosk_heartbeat_api.py tests/test_kiosk_station_setup.py tests/test_kiosk_setup_api.py`; all pass.
- [ ] Commit: `feat(api): heartbeat returns client_ip and keeps version; GET /kiosk/setup read-back`

---

### Task 4: Edge — `GET /edge/rfid/checks/{name}`

**Files:**
- Create: `kiosk_laptop/edge/src/edge/rfid/checks.py`
- Modify: `kiosk_laptop/edge/src/edge/routes/rfid.py`
- Modify: `kiosk_laptop/edge/src/edge/app.py` (add `app.state.gateway_knock = checks.knock`)
- Test: `kiosk_laptop/edge/tests/test_rfid_checks.py` (new)

**Interfaces:**
- Consumes:
  - `pairing.open_current`, `pairing.current_row`, `pairing.connection_url`, `pairing.is_ours`, `pairing.get_connections` and `pairing.redact_url`;
  - `hostnet.read_gateway`, `hostnet.read_host_network` and `hostnet.laptop_ip_for`;
  - `upstream.probe()` and `upstream.as_person`;
  - `laptop_setup.load`.
- Produces: `checks.run(name, app_state, session) -> dict` and `checks.CHECK_NAMES`.

```python
"""Kiosk Setup's network and verify checks (spec §2): one check per call so the
kiosk can tick them off in order. Every answer is HTTP 200 with
{"name", "ok", "state", "detail", "info"?}; the pairing token never appears."""

import asyncio
from urllib.parse import urlparse

from edge import hostnet, laptop_setup
from edge.rfid import pairing
from edge.rfid.ziotc import ReaderError
from edge.upstream import CloudOffline

CHECK_NAMES = ("reader", "router", "portal", "registration", "setup")
GATEWAY_PORTS = (53, 80, 443)
GATEWAY_TIMEOUT_S = 1.5
OFFLINE = "Can't reach the portal"


def result(name: str, state: str, detail: str, info: dict | None = None) -> dict:
    out = {"name": name, "ok": state == "ok", "state": state, "detail": detail}
    if info:
        out["info"] = info
    return out


async def knock(ip: str, port: int) -> bool:
    """True when something at ip:port answered: connected, or refused (the host is up)."""
    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(ip, port),
                                                 GATEWAY_TIMEOUT_S)
    except ConnectionRefusedError:
        return True
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    return True
```

**`reader` check:**
- `row = pairing.current_row(st.store)`. If there is none: `fail`, "Pair a reader first".
- Under `st.pair_lock`, open the reader with `open_current` and read `status()` and `get_config()`.
- Find our connection: `next((c for c in get_connections(config) if is_ours(c, st.identity, row["serial"], row["token"])), None)`.
- **info:**
  - `reader_ip`: `row["ip"]`
  - `endpoint_ip`: `urlparse(connection_url(ours)).hostname` when ours exists
  - `endpoint_url`: `redact_url(connection_url(ours))`
  - `reading`: `ziotc.is_reading(status)`
- **States:**
  - `ok` when `status.get("radioConnection") == "connected"` and ours exists. Detail: `f"{model} {serial} — radio connected"`, where model comes from the version.
  - `fail` when ours is missing: "The reader no longer sends to this laptop — pair it again".
  - `fail` when the radio is not connected: `f"Reader radio is {radioConnection or 'unknown'}"`.
  - `ReaderError`: `fail` with detail `exc.message` passed through `redact_url`-safe text. It must never include the token; the existing `redact_token(text, row["token"])` handles this.

**`router` check:**
- `gw = hostnet.read_gateway(data_dir)`.
- `lan_ip`: `laptop_ip_for(row ip, interfaces)` when there is a pairing, else the first fresh interface's ipv4, else None.
- If `gw` is None: `unknown`, "Re-run the install command to update the network helper", info `{lan_ip}`.
- Otherwise: `hits = await asyncio.gather(*(st.gateway_knock(gw, p) for p in GATEWAY_PORTS))`.
  - Any hit: `ok`, `f"Router {gw} answered"`.
  - None: `fail`, `f"Router {gw} didn't answer"`.
  - info in both cases: `{gateway, lan_ip}`.

**`portal` check:**
- `session.offline`: `fail` with `OFFLINE`.
- Otherwise `ok`, "Portal responded", when `await st.upstream.probe()` succeeds, else `fail` with `OFFLINE`.

**`registration` check:**
- `session.offline`: `fail` with `OFFLINE`.
- Call `resp = await st.upstream.as_person(session.person_id, "POST", "/kiosk/heartbeat", json={"serial": st.identity.serial, "name": st.identity.name, "mode": "laptop"})`.
  - `CloudOffline`: `fail` with `OFFLINE`.
  - `None`: `fail`, "Sign in again".
  - A non-200: `fail`, `f"Portal answered {resp.status_code}"`.
- On 200, `registration in ("ok", "soon")` gives `ok` with `f"Registered as {name}"`.
- Otherwise `fail`: "This kiosk's registration has expired — ask an admin to renew it on the portal", or "This kiosk isn't registered yet" for `none`.
- info: `{wan_ip: client_ip, registration, device_name: name}`.

**`setup` check:**
- `session.offline`: `fail` with `OFFLINE`.
- `saved = laptop_setup.load(st.store)`. If there is none: `fail`, "Finish Kiosk Setup first".
- Call `resp = as_person(..., "GET", "/kiosk/setup", params={"serial": st.identity.serial})`.
  - A 404: `fail`, "The portal has no setup for this kiosk".
  - Other failures: as in `registration`.
- **Compare, in order:**
  1. `initiative_id`: "Move"
  2. `site_id`: "Site"
  3. `scan_status`: "Scan type"
  4. `station_type`: "Station type"
  5. `reader.serial` vs `current_row` serial: "Reader"
- The first mismatch gives `fail`, `f"{label} on the portal doesn't match this laptop"`.
- All equal gives `ok`, "Portal has this kiosk's setup".
- info: `{initiative_name, site_name, scan_status_label, reader_serial}`, taken from the portal answer.

**Route:**

```python
@router.get("/checks/{name}")
async def check(name: str, request: Request,
                session: EdgeSession = Depends(require_session)) -> dict:
    if name not in checks.CHECK_NAMES:
        raise err(404, "unknown_check")
    return await checks.run(name, request.app.state, session)
```

`require_session` already guards the router; using it as a parameter dependency as well gives the session object. Check how `routes/kiosk.py` gets the session (`session: EdgeSession = Depends(require_session)`) and match it.

**Tests (`test_rfid_checks.py`):** use the fake reader, `respx` (`cloud` fixture) for the cloud, and `app.state.gateway_knock` replaced by an async fake.
- An unknown name gives 404 `unknown_check`.
- A request without a session gives 401.
- **reader:**
  - no pairing: fail "Pair a reader first";
  - paired: ok, with `endpoint_ip == "10.0.0.5"`, `reader_ip`, and `endpoint_url` ending `/…`;
  - ours removed from the fake's config: fail;
  - the fake's `status["radioConnection"] = "disconnected"`: fail;
  - unreachable: fail;
  - after a start, `info.reading` is True;
  - the token is absent from every response.
- **router:**
  - no file: unknown;
  - fresh file with gateway, knock returns True for 443 only: ok;
  - knock always False: fail;
  - info `lan_ip` is the interface on the reader's subnet.
- **portal:**
  - `respx` `GET /system/status` 200: ok;
  - `respx` side_effect `httpx.ConnectError`: fail;
  - offline session: fail.
- **registration:**
  - `respx` heartbeat answers `{"device_id": ..., "name": "Kiosk 28A8", "registration": "ok", "token_expires_at": null, "client_ip": "203.0.113.7"}`: ok, `info.wan_ip == "203.0.113.7"`;
  - `expired`: fail;
  - the request body sent upstream has `mode == "laptop"` and the edge serial, and no `version` key.
- **setup:**
  - matching portal answer: ok;
  - scan type differs: fail "Scan type on the portal doesn't match this laptop";
  - 404: fail;
  - no saved laptop setup: fail.
  - Seed `laptop_setup` via `laptop_setup.save(store, {...}, "rfid")` after pairing.

- [ ] Write the failing tests; run them; they fail.
- [ ] Implement `checks.py`, the route, and the app.state hook.
- [ ] Run the full edge suite; all pass.
- [ ] Commit: `feat(edge): network and verify checks for Kiosk Setup`

---

### Task 5: Kiosk — Network check step and the RFID scan-type filter

**Files:**
- Modify: `kiosk/src/lib/api.ts`. Add:
  - `CheckName`, `CheckResult` and `runCheck(name)`;
  - `startReader()`, `stopReader()` and `getReaderStatus()` with a `ReaderStatus` type, used by Task 6;
  - `client_ip?: string | null` on the heartbeat response type.
- Create: `kiosk/src/components/setup/NetworkCheckStep.tsx`, `kiosk/src/components/setup/CheckList.tsx` (shared rows UI, reused by Task 6)
- Delete: `kiosk/src/components/setup/RfidPlaceholderStep.tsx`, after checking nothing else imports it.
- Modify: `kiosk/src/pages/KioskSetup.tsx`:
  - step `'rfid'` becomes `'network'`, labeled "Network check";
  - add step `'confirm'` (Task 6 renders it). The RFID path becomes `['type','reader','connect','pair','network','move','site','scan','confirm']`.
  - filter the scan types.
- Modify: the kiosk CSS file that styles `.setup-*` (grep for `.setup-steps`). Add `.check-list` rows. Reuse the existing tokens and chip classes; no new colors.
- Test: `kiosk/src/components/setup/NetworkCheckStep.test.tsx` (new), `kiosk/src/pages/KioskSetup.test.tsx`

**Interfaces:**

```ts
export type CheckName = 'reader' | 'router' | 'portal' | 'registration' | 'setup';
export interface CheckResult {
  name: CheckName; ok: boolean; state: 'ok' | 'fail' | 'unknown'; detail: string;
  info?: Record<string, string | boolean | null>;
}
export async function runCheck(name: CheckName): Promise<CheckResult> // GET /edge/rfid/checks/{name}
export interface ReaderStatus {
  reader: { ip: string; serial: string; model: string; endpoint_url: string | null } | null;
  reachable?: boolean; reading?: boolean; radio?: string | null;
}
export async function startReader(): Promise<{ reading: boolean }>   // POST /edge/rfid/start
export async function stopReader(): Promise<{ reading: boolean }>    // POST /edge/rfid/stop
export async function getReaderStatus(): Promise<ReaderStatus>       // GET /edge/rfid/status
```

Match the existing reader helpers in `api.ts` (`connectReader`, `getEdgeSetup`) for how edge URLs and errors are built.

**`CheckList` props:** `{ items: { name: CheckName; label: string }[]; results: Partial<Record<CheckName, CheckResult>>; running: CheckName | null }`.
- **Row states:**
  - The running row shows a spinner. Reuse an existing spinner class; grep `spinner` in `kiosk/src`.
  - An `ok` result shows a green check: an inline SVG with `aria-label="passed"` and the class `check-ok`.
  - A `fail` or `unknown` result shows a red ✕ (`aria-label="failed"`) plus `detail` in `.form-error` text.
  - A row not yet run shows a muted dot.

**`NetworkCheckStep` props:** `{ onContinue: () => void; onBack: () => void }`.
- **Items:**
  - `reader`: "Reader online and ready"
  - `router`: "Local network to the router"
  - `portal`: "Portal responds"
  - `registration`: "Kiosk registered"
- **Running the checks:**
  - On mount and on **Run again**, run them sequentially with `for … await runCheck(name)`.
  - Record each result as it lands. A rejected promise becomes `{state: 'fail', detail: <ApiError code or 'unknown_error'>}`.
  - Keep going after a failure.
- **Info panel** (`<dl>`):
  - Reader endpoint IP: `results.reader?.info?.endpoint_ip`
  - Laptop LAN IP: `results.router?.info?.lan_ip`
  - WAN IP: `results.registration?.info?.wan_ip`
  - A value not known yet shows `—`.
- **All ok:** show "All checks passed" with **Back** (`mini-btn`) and **Continue** (`btn-solid`); Continue calls `onContinue`. Nothing advances on a timer.
- **Any not ok:** show **Back** (`mini-btn`) and **Run again** (`btn-solid`) once the run finishes. Neither shows while a run is in progress.
- Guard against a stale run: a run id ref, so results from an earlier run are ignored.

**`KioskSetup.tsx` scan-type filter:**
- `const scanTypes = stationType === 'rfid' && laptop ? options.scan_types.filter((s) => s.label.toLowerCase().includes('rfid')) : options.scan_types;`
- Use it for the cards.
- **Empty RFID list:** `<p className="page-hint">No RFID scan types are set up. Add an active status value with RFID in its name on the portal's Variables page.</p>` with a Back button.
- The revalidation effect that clears a stale `scanStatus` also uses the filtered list in the RFID path.

**Tests:**
- **`NetworkCheckStep.test.tsx`** (mock `runCheck`):
  - the checks are called in order `reader, router, portal, registration`;
  - each row shows passed;
  - the info panel shows the three IPs;
  - `onContinue` is not called after any amount of time until Continue is clicked;
  - with one fail, the other three still run, Run again and Back show, and `onContinue` is never called;
  - Run again re-runs all four;
  - an unknown router state shows its detail.
- **`KioskSetup.test.tsx`:**
  - the RFID path label reads "Step 5 of 9 · Network check";
  - the RFID path shows only scan types whose label contains RFID in any case (seed `RFID Received`, `rfid out`, `Received`);
  - the empty state text;
  - the Label path still shows all.
  - Update existing tests that referenced the placeholder text "RFID settings — coming soon", or "of 8", to the new steps.

- [ ] Write the failing tests; run them; they fail.
- [ ] Implement.
- [ ] Run `npm --prefix kiosk test -- --run` and `npm --prefix kiosk run build`; all pass.
- [ ] Commit: `feat(kiosk): RFID Network check step and RFID-only scan types`

---

### Task 6: Confirm & verify step, Start Reader, and the edge event log

**Files:**
- Create: `kiosk/src/components/setup/ConfirmStep.tsx`
- Create: `kiosk_laptop/edge/src/edge/rfid/events.py`
- Modify: `kiosk/src/pages/KioskSetup.tsx`:
  - in the RFID path, `finish()` saves as today and then `setStep('confirm')` **instead of** closing the wizard. The sync still starts.
  - render `ConfirmStep` for `'confirm'`.
- Modify: `kiosk/src/lib/api.ts`. Add `RfidEvent`, `getRfidEvents()`, and `antennas` on `ReaderStatus`.
- Modify: `kiosk_laptop/edge/src/edge/db.py`: append one SCHEMA_STEP. Never edit earlier steps.
- Modify: `kiosk_laptop/edge/src/edge/routes/rfid.py` (record events; `GET /edge/rfid/events`; `antennas` on status)
- Modify: `kiosk_laptop/edge/src/edge/routes/kiosk.py` (record setup events)
- Modify: `kiosk_laptop/edge/src/edge/rfid/checks.py` (record the portal check-in)
- Test: `kiosk/src/components/setup/ConfirmStep.test.tsx`, `kiosk/src/pages/KioskSetup.test.tsx`, `kiosk_laptop/edge/tests/test_rfid_events.py` (new)

**Edge event log (feeds the dashboard's System Events panel, Task 7):**
- **SCHEMA_STEP:**
  ```sql
  CREATE TABLE rfid_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')
  ```
- **`events.record(store, kind, title, detail="")`:**
  - inserts a row with `at = now_iso()`;
  - then keeps only the newest 200 rows (`DELETE FROM rfid_events WHERE id <= (SELECT MAX(id) FROM rfid_events) - 200`);
  - never raises (it logs and swallows).
- **`events.recent(store, limit=50) -> list[dict]`:** newest first, `{id, at, kind, title, detail}`, with `limit` clamped to 1..200.
- **Kinds and copy** (American English; never the token):

  | Kind | Title | Detail |
  |---|---|---|
  | `reader_connected` | "Reader connected" | `"{model} · {ip}"` |
  | `reader_paired` | "Reader paired" | `"{model} · sends to {laptop_ip}"` |
  | `reader_started` | "Reader started" | `"{model} · Started by {person name}"` |
  | `reader_stopped` | "Reader stopped" | `"Stopped by {person name}"` |
  | `move_loaded` | "Move loaded" | `initiative_name` |
  | `scan_type_selected` | "Scan type selected" | `"{scan_status_label} · {Label Station or RFID Station}"` |
  | `portal_check_in` | "Portal check-in successful", or "Portal check-in failed" on a fail | "Connected to ServerSherpa", or the failure detail |

  The person name comes from the edge session: `session.person_name`, as the outbox uses it.
- **Recorded after success:**
  - connect: `reader_connected`;
  - pair: `reader_paired`;
  - start: `reader_started`;
  - stop: `reader_stopped`;
  - edge `/kiosk/setup` on a 200: `move_loaded` + `scan_type_selected`;
  - the `registration` check: `portal_check_in`, on ok and on fail.
- **`GET /edge/rfid/events?limit=N`** (edge session): `{"events": [...]}`.
- **`GET /edge/rfid/status`** also returns `antennas`: the sorted list of antenna port names whose value is `"connected"` in the reader's `/cloud/status` `antennas` object, `[]` when unknown.
- Wipe (the edge's existing wipe path; grep `laptop_setup` in the wipe code) also clears `rfid_events`.
- **Tests (`test_rfid_events.py`):**
  - record/recent order and limit clamp;
  - the 200-row cap;
  - `record` never raises on a closed or broken store (monkeypatch `store.run` to raise);
  - each route writes its event with the right title and detail;
  - the person name is in start/stop;
  - the token is never in any event (pair, then check every row);
  - `/events` needs a session;
  - status `antennas` comes from the fake's `STATUS` (`["1", "2"]`);
  - wipe clears the events.

**ConfirmStep:** as below.

**Interfaces:**
- Consumes `runCheck`, `startReader` and `CheckList` from Task 5. It also consumes the existing `readerErrorText` / `codeOf` in `components/setup/readerSetup.ts`.
- `ConfirmStep` props:

```ts
{ setup: { initiativeName: string; siteName: string; siteRole: 'source' | 'destination'; scanLabel: string };
  reader: { ip: string; serial: string; model: string; endpoint_url: string | null } | null;
  onBack: () => void; onStarted: () => void; onPairAgain: () => void }
```

- **Summary card** (`.setup-summary`):
  - Move: `initiativeName`
  - Site: `siteName` (role)
  - Scan type: `scanLabel`
  - Reader: `model serial at ip`
  - Endpoint: `endpoint_url` or `—`
- **Checks:** `CheckList` with
  - `reader`: "Reader online"
  - `portal`: "Portal reachable"
  - `setup`: "Portal has this kiosk's setup"
  - They run sequentially on mount, with **Run again** on failure.
- **Buttons:**
  - **Back** (`mini-btn`) calls `onBack`, which goes to the scan step.
  - **Start Reader** (`btn-solid`) is disabled until all three are ok, and while starting shows "Starting…".
- **Start:** `await startReader()`.
  - On success, call `onStarted()`.
  - On error, show `readerErrorText(err, reader.ip) ?? \`Couldn't start the reader (${codeOf(err)}).\`` as `role="alert"`.
  - `reader_required`: "Pair a reader first", with a "Back to the reader step" button that calls `onPairAgain`.
- **In `KioskSetup`:**
  - `onStarted = () => { setWizardOpen(false); navigate('/rfid_status'); }`
  - `onPairAgain = () => setStep('reader')`
  - The reader prop comes from `paired?.reader`, and `endpoint_url` from `paired`. Read `PairResult` in `api.ts` for exact field names.
- `/rfid_status` itself is Task 7. Until then the App's catch-all redirects it; tests assert the navigation call.

**Tests:**
- **`ConfirmStep.test.tsx`:**
  - checks run in the order `reader, portal, setup`;
  - Start Reader is disabled until all pass, then enabled;
  - a click calls `startReader` and then `onStarted`;
  - a start error shows the alert and does not call `onStarted`;
  - a `reader_required` error shows the pair-again button, which calls `onPairAgain`;
  - a failed check shows Run again;
  - the summary card shows move, site (role), scan type, reader and endpoint.
- **`KioskSetup.test.tsx`:**
  - in the RFID path, picking a scan type submits and shows "Step 9 of 9 · Confirm & verify" instead of the summary;
  - Start Reader navigates to `/rfid_status`;
  - the Label path still closes to the summary after the scan type.

- [ ] Write the failing tests (edge and kiosk); run them; they fail.
- [ ] Implement.
- [ ] Run the edge suite, `npm --prefix kiosk test -- --run` and `npm --prefix kiosk run build`; all pass.
- [ ] Commit (two commits are fine): `feat(edge): RFID event log and connected antennas` and `feat(kiosk): Confirm & verify step and Start Reader`

---

### Task 7: `/rfid_status` — the RFID Reader Dashboard (from Jimmy's mockup)

**Files:**
- Create: `kiosk/src/pages/RfidStatus.tsx`, `kiosk/src/pages/RfidStatus.test.tsx`
- Modify: `kiosk/src/App.tsx`: add the route `/rfid_status`, wrapped `<KioskGuard><KioskShell><RfidStatus /></KioskShell></KioskGuard>`, next to `/setup`.
- Modify: the kiosk stylesheet (`kiosk/src/styles/kiosk.css` or wherever `.setup-*` lives). Add an `.rfid-dash-*` block using **existing color tokens only**.

**What the mockup shows.** The KioskShell already supplies the top bar (ServerSherpa · KIOSK · LAPTOP, kiosk name, Registered chip, person, Sign out) and the footer (MODE / VERSION / MOVE / SITE / SCAN / Data Sync / Cloud). The page body is:

1. **Title row:**
   - `h1` "RFID Reader Dashboard";
   - sub-line "Live asset reads and reader activity.";
   - on the right, a status pill: green dot + "Reading", gray "Stopped", or red "Unreachable".
2. **Six tiles in one row.** They wrap to 3 + 3 and then 2 columns on narrow screens. Each tile has an icon, an uppercase small label, a big value and a sub-line. Icons are inline SVGs: tag, barcode, clock, sliders, document, broadcast.

   | Tile | Value | Sub-line |
   |---|---|---|
   | TAGS READ TODAY | `—` | "Waiting for tag data" (no tag source yet) |
   | MOVE PROGRESS | `— / {assets}` | "Waiting for tag data", with an empty progress bar |
   | LOCAL TIME | live `HH:MM:SS` (24-hour, ticking every second) | `Fri, Oct 2, 2026 · CDT`, via `toLocaleDateString(undefined, {weekday:'short', month:'short', day:'numeric', year:'numeric'})` + `Intl.DateTimeFormat(undefined, {timeZoneName:'short'})` |
   | ACTIVE MOVE | `selection.initiativeName` | `{siteName} ({siteRole})` |
   | SCAN TYPE | `selection.scanLabel` | "Station: RFID · Laptop" |
   | READER STATUS | dot + Reading/Stopped/Unreachable | `{model} · Antennas {list}`, e.g. "Antennas 1 – 4" when contiguous, else "Antennas 1, 3"; "No antennas connected" when the list is empty |

   - MOVE PROGRESS takes `{assets}` from the kiosk's local sync summary (`useSyncStatus().assets`). When unknown, it shows `—`.
   - ACTIVE MOVE and SCAN TYPE come from `useKioskSetup()`.
3. **Two panels side by side:** Live Tag Reads takes about 2/3 of the width, System Events about 1/3. They stack on narrow screens.
   - **Live Tag Reads:**
     - title, sub-line "Newest first.";
     - a table with headers Tag ID · Serial Number · Computer Name · Make / Model;
     - an empty state row "No tag reads yet — live reads arrive when tag data is connected.";
     - the footnote "Live view only · Older rows leave this screen.";
     - monospace for Tag ID and Serial, as in the mockup.
     - The table is the existing list primitive the kiosk uses, if there is one (grep `list-scroll` / `data-table` in `kiosk/src`). Otherwise use a plain `<table className="rfid-dash-table">`.
   - **System Events:**
     - title, sub-line "Live activity.";
     - rows from `getRfidEvents()`, newest first: icon by kind, `HH:MM:SS` time, bold title, muted detail.
     - **Icons by kind:**
       - `portal_check_in`: green dot when the title says successful, red dot when failed;
       - `reader_started`: gear;
       - `scan_type_selected`: document;
       - `move_loaded`: sliders;
       - `reader_connected` and `reader_paired`: wifi;
       - `reader_stopped`: red dot.
     - Empty state: "No activity yet."
4. **Two big buttons in one row**, full width, about 50/50:
   - **START:** green, play icon, title "START", sub-line "Start RFID reader". While reading it is disabled and dimmed, with sub-line "Already reading".
   - **STOP:** red, square icon, title "STOP", sub-line "Stop RFID reader". While stopped it is disabled and dimmed, with sub-line "Already stopped".
   - Both are disabled when unreachable, with sub-line "Reader unreachable".
   - While a call runs, the clicked button shows "Starting…" or "Stopping…".
   - After a click, re-fetch status and events.
   - Errors use `readerErrorText` in a `role="alert"` line under the buttons.

**Behavior:**
- **Guards:**
  - `!isLaptop()`: `<Navigate to="/" replace />`.
  - `getReaderStatus()` returns `reader: null`: `<Navigate to="/" replace />`.
- **Polling:**
  - `getReaderStatus()` and `getRfidEvents()` on mount and every 5000 ms;
  - the clock ticks every 1000 ms;
  - clear all intervals on unmount.
- **Colors:** use existing tokens, such as the chip green/red and the accent. The page must read well in the kiosk's dark theme (the mockup) and its light theme. Check how other kiosk pages handle both.

**Tests (`RfidStatus.test.tsx`)** (mock the API; fake timers):
- the title and the six tile labels render;
- Reading / Stopped / Unreachable change the pill, the READER STATUS tile and the button states;
- START is disabled with "Already reading" while reading;
- STOP calls `stopReader`, then re-fetches status and events;
- START calls `startReader`;
- an antennas label formats `["1","2","3","4"]` as "Antennas 1 – 4" and `["1","3"]` as "Antennas 1, 3";
- events render newest first with their titles and details, and the empty state shows when there are none;
- the Live Tag Reads empty state shows;
- MOVE PROGRESS shows `— / 500` when the sync summary has 500 assets;
- the clock advances after 1000 ms;
- `reader: null` and web mode redirect to `/`;
- the poll fires again after 5000 ms.

- [ ] Write the failing tests; run them; they fail.
- [ ] Implement.
- [ ] Run `npm --prefix kiosk test -- --run` and `npm --prefix kiosk run build`; all pass.
- [ ] Commit: `feat(kiosk): RFID Reader Dashboard at /rfid_status`

---

### After the tasks (controller)

1. Final whole-branch review over `git merge-base main HEAD..HEAD`, limited to this plan's commits (from `d1db2bee`).
2. Update the README's laptop section. Add one paragraph for the Network check and `/rfid_status`, and say that existing installs pick up the gateway when the helper updates (re-run the install command).
3. Rebuild the container:

   ```bash
   EDGE_CLOUD_API_URL=http://host.docker.internal:8001 EDGE_DATA_HOST_DIR=$PWD/.devlogs/rfid-live-data docker compose -f kiosk_laptop/docker-compose.yml up -d --build
   ```

   Re-run `kiosk_laptop/installer/hostnet.sh` with `KIOSK_DATA_DIR=$PWD/.devlogs/rfid-live-data` so `gateway` appears, and restart the API on 8001 from this worktree.
4. Live check with Jimmy against the FX9600 at 10.10.48.119: the whole RFID path through to `/rfid_status`, with the reader reporting Reading.
