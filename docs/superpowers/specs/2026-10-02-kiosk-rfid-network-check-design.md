# Kiosk RFID Station — Network check, RFID scan types, Confirm & verify, /rfid_status

Status: approved 2026-10-02. Builds on `2026-10-01-kiosk-rfid-station-design.md` (branch `rfid-station`).

## 1. Goal

The RFID Station path of Kiosk Setup (laptop edition) replaces the step 5 placeholder with a **Network check**. It also limits step 8 to RFID scan types and adds a step 9, **Confirm & verify**, which ends with **Start Reader**. Start Reader opens a new placeholder page, `/rfid_status`.

The RFID path becomes:

| # | Step | Notes |
|---|------|-------|
| 1 | Setup type | unchanged |
| 2 | Reader | unchanged |
| 3 | Connect | unchanged |
| 4 | Pair | unchanged |
| 5 | **Network check** | new (replaces `RfidPlaceholderStep`) |
| 6 | Move | unchanged |
| 7 | Site | unchanged |
| 8 | Scan type | filtered to RFID scan types |
| 9 | **Confirm & verify** | new; Back / Start Reader |

The Label Station path and web mode don't change.

## 2. Checks (edge)

There is one edge endpoint per check. The kiosk calls them one at a time so that each row ticks in order.

`GET /edge/rfid/checks/{name}` requires an edge session. It always answers **200**:

```json
{"name": "reader", "ok": true, "state": "ok", "detail": "FX9600 84248dee5721 — radio connected", "info": {...}}
```

- `state` is `ok`, `fail` or `unknown`.
- `ok` is true only when `state == "ok"`.
- `detail` is short, user-facing text in American English.
- `info` carries the values the page displays. It is absent when there is nothing to show.
- An unknown `name` returns 404 `unknown_check`.

| name | What it does | ok when | info |
|------|--------------|---------|------|
| `reader` | Opens the current paired reader (`pairing.open_reader`, stored password, stored scheme/port), then `GET /cloud/status` and `GET /cloud/config`. | `radioConnection == "connected"` **and** the config still holds our connection (`is_ours`). | `reader_ip`, `endpoint_ip` (host from our connection's URL), `endpoint_url` (redacted, `…` for the token), `reading` (bool, from `radioActivitiy == "active"`) |
| `router` | Reads `gateway` from `host-network.json`, then TCP-connects to it on 53, 80 and 443, concurrently with a 1.5 s timeout each. | Any port connects **or** is refused (a refusal means the host is up). | `gateway`, `lan_ip` (the laptop address on the reader's subnet, `pairing.laptop_address` rules) |
| `portal` | `upstream.probe()` (`GET /system/status`). | The cloud answers. | — |
| `registration` | `POST /kiosk/heartbeat` as the session person, with the edge identity (`serial`, `name`, `mode: "laptop"`). | `registration` is `ok` or `soon`. | `wan_ip` (the heartbeat's new `client_ip`), `registration`, `device_name` |
| `setup` | `GET /kiosk/setup?serial=<edge serial>` as the session person. | The device row exists and matches the laptop's saved setup (`laptop_setup`): initiative, site, scan status, `station_type == "rfid"`, and `rfid_reader_serial` equal to the current pairing's serial. | `initiative_name`, `site_name`, `scan_status_label`, `reader_serial`; on mismatch, `detail` names the first field that differs |

**States:**

- No pairing makes `reader` `fail` with "Pair a reader first".
- A missing or stale `host-network.json`, or one without a gateway, makes `router` `unknown` with "Re-run the install command to update the network helper". Unknown counts as not ok.
- An offline session (`session.offline`) or `CloudOffline` makes `portal`, `registration` and `setup` `fail` with "Can't reach the portal".
- A missing cloud session (`as_person` returns None) is `fail` with "Sign in again".

**Reader access and token rules:**

- Reader calls go through the same `pair_lock` as pairing, so a check never interleaves with a rewrite.
- The reader is opened with `pairing.open_reader`, so the stored password index is tried first. The reader was already fingerprinted and paired.
- The token never appears in any `detail` or `info`. `redact_url` covers this.

## 3. Reader start, stop and status (edge)

- `POST /edge/rfid/start` (online session): opens the paired reader and sends `PUT /cloud/start` with `{"doNotPersistState": false}`, so a power-cycled reader resumes reading. Returns `{"reading": true}`.
- `POST /edge/rfid/stop` (edge session): `PUT /cloud/stop`. Returns `{"reading": false}`.
- `GET /edge/rfid/status` (edge session): returns `{"reader": <pairing.current()>, "reading": bool, "radio": "connected"|..., "reachable": bool}`.
  - With no pairing it returns `{"reader": null}`.
  - An unreachable reader returns `reachable: false` and is not an error.
- **Errors:**
  - start and stop map `ReaderError` through `reader_http_error` as connect and pair do;
  - no pairing gives 409 `reader_required`;
  - an offline session on start gives 503 `edge_offline`.
- `ZiotcClient` gains `start(persist: bool = True)`.
- The fake reader gains `PUT /cloud/start`. It sets `reading = True`, records the body in `starts`, and reports `radioActivitiy` `active`/`inactive` in `/cloud/status`.

## 4. Gateway in host-network.json (installer helpers)

- `host-network.json` gains `"gateway": "10.10.48.1"`, the IPv4 default gateway. The key is omitted when there isn't one.
- How each OS finds it:
  - **macOS:** `route -n get default`, the `gateway:` line.
  - **Linux:** `ip -j -4 route show default`, the first entry's `gateway`.
  - **Windows:** `Get-NetRoute -DestinationPrefix 0.0.0.0/0` with the lowest `RouteMetric + InterfaceMetric`; its `NextHop`, skipping `0.0.0.0`.
- Only a valid, non-loopback IPv4 address is written.
- `edge/hostnet.py`'s `read_host_network` stays as it is. A new `read_gateway(data_dir) -> str | None` returns the gateway only when the file is fresh.

## 5. Cloud API

- **The heartbeat no longer clears `version`** when a beat omits it (`device.version` is updated only when `body.version` is not None), so the edge's registration check can beat without knowing the kiosk app version.
- **`HeartbeatOut` gains `client_ip: str | None`.** It is the caller's public address from the existing `deps.client_ip` (the Caddy X-Forwarded-For rule), and becomes the WAN IP. It is not stored. No migration.
- **`GET /kiosk/setup?serial=…`** (`kiosk:view`) returns the device's current setup:
  - fields: `device_id`, `initiative_id`, `initiative_name`, `site_id`, `site_name`, `scan_status`, `scan_status_label`, `station_type`, `reader` (`{ip, serial, model}` or null);
  - unknown serial, or a device that isn't a kiosk: 404 `device_not_found`;
  - a move-password session sees only a device set up for its own move: anything else is 404 as well;
  - `initiative_id`/`site_id` come from `current_initiative_id`/`site_id`.
- The edge pass-through for `/kiosk/heartbeat` forwards `client_ip` unchanged. The browser's own heartbeat sees it too, which is harmless.

## 6. Kiosk UI

### Step 5 — Network check (`NetworkCheckStep`)

- **Rows, in order:** Reader online and ready · Local network to the router · Portal responds · Kiosk registered.
  - A row shows a spinner, then a green check (`ok`), or a red ✕ with `detail` (`fail`/`unknown`).
  - The checks run one after another. A failed check doesn't stop the later ones, so every problem shows at once.
- **Info panel**, filled as checks return:
  - **Reader endpoint IP:** `endpoint_ip`
  - **Laptop LAN IP:** `lan_ip`
  - **WAN IP:** `wan_ip`
  - A value not known yet shows `—`.
- **Moving on:**
  - When all four are ok, a "All checks passed" line shows and the step advances to step 6 after 1.5 s.
  - With any failure: **Run again** and **Back** buttons. Back goes to the Pair step.
  - The auto-advance timer is cleared on unmount.

### Step 8 — Scan type

- In the RFID path, the scan-type cards are filtered to those whose `label` contains `rfid`, ignoring case. The list is already only active asset status values.
- **No matches:** "No RFID scan types are set up. Add an active status value with RFID in its name on the portal's Variables page." with a Back button.
- Picking a card still submits Kiosk Setup as today. On success the RFID path goes to step 9 instead of finishing.
- The Label path and web mode see the full list as before.

### Step 9 — Confirm & verify (`ConfirmStep`)

- **Summary card:**
  - Move, Site (with source/destination role), Scan type: from the setup result.
  - Reader: model, serial, IP. Endpoint: `endpoint_url`, redacted.
- **Rows:** Reader online · Portal reachable · Portal has this kiosk's setup. These use the `reader`, `portal` and `setup` checks, run in order like step 5.
- **Buttons:**
  - **Back** returns to step 8.
  - **Start Reader** is enabled only when all three rows are ok, and is busy while starting.
    - On success it navigates to `/rfid_status`.
    - On failure it shows the error text, using the existing `readerErrorText` mapping, and stays on the page.

### `/rfid_status` (placeholder page, `RfidStatus`)

- **Route:** `/rfid_status`, inside `KioskGuard` + `KioskShell`.
  - Laptop mode only.
  - Web mode, or a laptop with no pairing, redirects to `/`.
- **Content:**
  - Heading "RFID reader".
  - Reader summary: model, serial, IP.
  - A state chip: Reading (green) / Stopped / Unreachable.
  - Polls `GET /edge/rfid/status` every 5 s while visible.
- **Buttons:** **Stop Reader** when reading, **Start Reader** when stopped, busy while waiting.
- **Hint:** "Live tag reads will show here in a later release."
- No other links. The kiosk shell's normal navigation applies.

## 7. Errors and copy

- All copy is American English, short.
- Reader errors reuse `readerErrorText`.
- New codes the kiosk maps:
  - `reader_required`: "Pair a reader first", with Back to the reader step on step 9.
  - `edge_offline`: the existing copy.

## 8. Testing

- **Edge (pytest, fake reader):**
  - each check's ok, fail and unknown paths;
  - the token is never in a response;
  - start/stop/status;
  - `read_gateway` freshness;
  - start sends `doNotPersistState: false`;
  - `pair_lock` is held.
- **Installer:**
  - gateway parsing for macOS `route` output, Linux `ip -j route`, and Windows `Get-NetRoute` (Pester with mocked cmdlets);
  - the key is omitted when there is no default route.
- **API:**
  - `client_ip` on the heartbeat (XFF honored);
  - `GET /kiosk/setup`: the shape, 404s, and the move-password scope.
- **Kiosk (vitest):**
  - step order and the 9-step labels;
  - Network check: ticking order, info panel, auto-advance, Run again;
  - the RFID filter and its empty state;
  - Confirm: rows, Start Reader enabled only when green, navigation;
  - `/rfid_status`: chip states, Stop/Start, redirect when unpaired or in web mode.
- **Live:** against the real FX9600 at 10.10.48.119, run the whole path to `/rfid_status` and confirm the reader reports active.

## 9. Out of scope

- Receiving or storing tag data on 8091.
- Reader antenna and power settings.
- A real `/rfid_status` dashboard.
- iOS and Android.
