# Kiosk laptop — RFID Station / Label Station setup

**Date:** 2026-10-01 · **Branch:** `rfid-station` (based on `kiosk-installer`, PR encondata/BaseCampV3#1, unmerged) · **Status:** design approved by Jimmy

**Builds on:**
- `docs/superpowers/specs/2026-10-01-kiosk-laptop-design.md` (the laptop edge)
- `docs/superpowers/specs/2026-10-01-kiosk-laptop-installer-design.md` (the installer)

## Goal

Kiosk Setup on a laptop starts by asking what the station is.

- A **Label Station** goes through today's steps unchanged.
- An **RFID Station** first finds a Zebra FX9600 on the local network, connects to it, and *pairs* it: it points the reader's IoT Connector (ZIOTC) tag-data endpoint at this laptop. Then it shows a placeholder page, then today's Move → Site → Scan type steps.
- When setup finishes, the portal records the kiosk as **RFID · Laptop** or **Label Station · Laptop**, together with the paired reader's details.

Tag data itself is **out of scope**. Nothing receives or processes reads yet. A later phase adds an API that stores reads in the database and a worker that processes them.

## Decisions (Jimmy, 2026-10-01)

| Topic | Decision |
|---|---|
| Laptop network address | A **host helper** on the laptop writes its current addresses to the data folder. The edge reads them to choose subnets to scan and the pairing address. |
| Reader → laptop path | Port **8091** published on all interfaces for future tag data; nothing listens in this phase. |
| Kiosk UI exposure | The UI listens on **`0.0.0.0:8090`** (was `127.0.0.1`) so other devices on the LAN can use it over plain HTTP. Sign-in pages reached through a LAN address show an "unencrypted connection" notice. WebUSB printing works only on the laptop itself (localhost). |
| Reader credentials | Username `admin`. Passwords tried in order: `Cumulus$G0`, `Cumulu$SG.`, `33q44w40x5`, then Zebra's default `change`. Hard-coded in the edge; these readers hold nothing sensitive. |
| Tag data | Not handled now. Pairing succeeds when the reader accepts the endpoint and a read-back of its config shows it. |
| Station type in the portal | A new `devices.station_type` (`label` \| `rfid`). `sub_type` stays `laptop`. The device row also stores the paired reader's details. |

## 1. Kiosk Setup flow

The **Step 1** card picker asks "What is this station?" and offers **Label Station** and **RFID Station**.

- **Label Station:** Move → Site → Scan type, exactly as today.
- **RFID Station:** Select reader → Connect → Pair → Placeholder → Move → Site → Scan type.

The step counter follows the path: for example "Step 3 of 8 · Connect" (RFID) or "Step 2 of 4 · Move" (Label). **Back** works on every step. Re-running Kiosk Setup can switch the station type or the reader.

### 1.1 Select reader

- On entering, the edge starts a subnet scan. The UI polls its progress and lists readers as they are found. Each card shows:
  - IP
  - model
  - serial
  - "Already paired with *Kiosk ABCD*", when the reader's ZIOTC config holds another kiosk's ServerSherpa connection. The connection's `name` carries the kiosk name.
- **Scan again** restarts the scan.
- **Enter IP manually** opens a field for the reader's IP, validated as IPv4.
- If no fresh laptop address is known (§2.1), the step says so. It offers manual entry of both the reader's IP and the laptop IP to pair with.

### 1.2 Connect

The edge signs in with the password list (§2.3), then reads `/cloud/status` and `/cloud/version`. On success the step shows:

- model
- serial
- reader application version
- radio firmware
- cloud agent (IoT Connector) version
- status summary

It then offers **Pair this reader**. Errors:

- No password worked: "Couldn't sign in to this reader."
- The host answers but has no IoT Connector API: "This reader isn't in IoT Connector (Local REST) mode — set it in the reader's web console."
- Unreachable or timed out: "Can't reach <ip>."

### 1.3 Pair

The edge rewrites the reader's data endpoint (§2.4) and verifies it by reading the config back.

- If another kiosk already holds the reader (§1.1), a confirm dialog comes first: "This reader is paired with *Kiosk ABCD*. Pair it with this kiosk instead?"
- Success shows "Paired with FX9600 *serial* at *ip*" and **Continue**.
- Failures show the reader's error message plus **Try again**.

### 1.4 Placeholder

"RFID settings — coming soon", with **Continue**.

### 1.5 Move → Site → Scan type

These are today's steps unchanged. Finishing sends the setup to the cloud with the station type and, for RFID, the reader (§3.2).

## 2. Edge and laptop

### 2.1 Host helper: `host-network.json`

The installer adds a small job that writes `<data dir>/host-network.json`:

```json
{"updated_at": "2026-10-01T18:00:00Z",
 "interfaces": [{"name": "en0", "ipv4": "10.10.48.57", "prefix": 24}]}
```

- **Schedule:** it runs at startup or sign-in, and every 60 seconds.
  - Linux: systemd timer `serversherpa-kiosk-hostnet.timer`, as root, 10 s after boot and every 60 s.
  - macOS: launch agent `com.serversherpa.kiosk.hostnet`, as the desktop user (who owns the data folder there), at load and every 60 s.
  - Windows: scheduled task `ServerSherpa Kiosk Host Network`, as **SYSTEM** (`NT AUTHORITY\SYSTEM`, service account, highest run level). It has two triggers: at startup, and every minute indefinitely. It runs `powershell.exe -NoProfile -NonInteractive -File hostnet.ps1`, in session 0, so no window ever shows. It is allowed on battery, starts when available and runs one instance at a time. SYSTEM already has full control of the data folder and the script.
  - The installer runs the job once after registering it and waits up to 10 s for a fresh file. If none appears, it warns: "Couldn't confirm the network helper is running — RFID setup may not find readers."
- **Tools:** only built-in ones.
  - Linux: `ip -j -4 addr`, keeping only interfaces with a `/sys/class/net/<name>/device` entry (real adapters).
  - macOS: `ifconfig`, plus `networksetup -listallhardwareports` to know the real adapters.
  - Windows: `Get-NetIPAddress -AddressFamily IPv4` (only `AddressState` `Preferred`) joined with `Get-NetAdapter -Physical`.
- **Exclusions:**
  - loopback
  - link-local `169.254.0.0/16`
  - Docker, WSL, Hyper-V, VPN/tunnel and bridge adapters (`docker*`, `br-*`, `veth*`, `vEthernet*`, `utun*`, `tun*`, `tap*`, `wg*`, `bridge*`)
  - adapters that are down
- **Write:** atomic (temp file plus rename), owned and readable as the data folder requires.
- **Uninstall** removes the job.
- **Freshness:** the edge treats the file as stale after **5 minutes**, and treats a missing or stale file as "unknown".

### 2.2 Discovery: `edge/rfid/discovery.py`

- **Scope:** scan the subnet of each fresh interface, capped at **512** host addresses per scan. For a subnet larger than /23, scan the /24 containing the laptop.
  - TCP connect to ports **443 and 80**, at most **64** connections at once, **0.5 s** timeout. One candidate per IP: **443** (HTTPS) when it is open, else 80 (plain HTTP).
  - **Fingerprint first, no credentials (Jimmy, final review D1):** an unauthenticated `GET /cloud/localRestLogin` and `GET /cloud/version`. A host is a Zebra candidate only when (a) the `WWW-Authenticate` realm, the `Server` header or the body mentions Zebra, FX or IoT Connector, or (b) the sign-in answers 401 **and** `/cloud/version` is refused in ZIOTC's JSON error shape `{"code": <int>, "message": <str>}`. A bare 401 everywhere (a NAS, a printer) is not a candidate. Non-candidates are dropped with zero credential attempts. The signals come from Zebra's OpenAPI, not a real FX9600 capture yet; they will be refined from one.
  - A candidate is signed in to only with the password index remembered for that IP. With none remembered, the scan sends no password and lists the host as "Zebra reader found — select it to connect" (`needs_connect: true`, model and serial unknown). Signed in, a host whose `model` starts with `FX` is kept; others are dropped. The full password list is tried only by an explicit Connect (§1.2).
- **State:** the scan is a single background job per edge. Starting a new scan cancels a running one.
- **Endpoints:** both require an edge session.
  - `POST /edge/rfid/scan` starts a scan and returns `{scan_id}`.
  - `GET /edge/rfid/scan` returns:

    ```
    {scan_id, state: running|done|failed, probed, total,
     readers: [{ip, scheme, port, model, serial, paired_with: name|null, needs_connect}],
     host: {ips: [...], fresh: bool}}
    ```

### 2.3 ZIOTC client: `edge/rfid/ziotc.py`

- **Transport:** HTTPS to `https://<ip>` (port 443) with certificate verification **off** (the readers use self-signed certificates), or plain HTTP to `http://<ip>` (port 80). Connect and pair use where the latest scan found the reader, else where it answered before, else 443 then 80 for a manually entered IP. The scheme and port are remembered per reader serial (`rfid_readers.scheme`, `port`). Timeouts: 3 s connect, 10 s read.
- **Sign-in:** `GET /cloud/localRestLogin` with HTTP basic auth `admin:<password>`. It returns a token, which is sent as `Authorization: Bearer <token>` on later calls.
  - Passwords are tried in order: `Cumulus$G0`, `Cumulu$SG.`, `33q44w40x5`, `change`.
  - A 401/403 tries the next password.
  - Any other failure stops the attempt.
- **Password memory:** the index of the password that worked is remembered per reader serial in SQLite (`rfid_readers.password_index`, looked up by the reader's IP) and tried first next time; a scan tries only that one (§2.2). A successful Connect remembers it without creating a pairing token. **Passwords are never sent to the browser, logged, or sent to the cloud.**
- **Calls:**
  - `GET /cloud/status`
  - `GET /cloud/version`, which returns `model`, `serialNumber`, `readerApplication`, `radioFirmware`, `cloudAgentApplication`
  - `GET /cloud/config` and `PUT /cloud/config`
- **Errors:** they map to stable codes: `reader_unreachable`, `reader_auth_failed`, `reader_not_iotc` (a 404 on `/cloud/*`), and `reader_error` (carrying the reader's `message`).

### 2.4 Pairing: `edge/rfid/pairing.py`

1. **Get the config:** `GET /cloud/config` and take the `READER-GATEWAY` object.
2. **Build the connection:**

   ```json
   {"type": "httpPost",
    "name": "ServerSherpa Kiosk <serial-suffix> (<kiosk name>)",
    "description": "ServerSherpa kiosk <serial>",
    "options": {"URL": "http://<laptop-ip>:8091/rfid/<reader-serial>/<token>",
                "security": {"verifyPeer": false, "verifyHost": false}}}
   ```

   - `<laptop-ip>` is the fresh laptop address on the same subnet as the reader, or the manual laptop IP.
   - `<token>` is 32 random URL-safe bytes, kept per reader in SQLite.
3. **Edit `endpointConfig.data.event.connections`:**
   - Drop any connection whose `name` starts with `ServerSherpa Kiosk`. If it belongs to another kiosk serial and the request lacks `confirm_takeover: true`, answer 409 `reader_paired_elsewhere` with that kiosk's name.
   - Then append ours.
   - If the result would hold more than **2** connections (the reader's limit), answer 409 `reader_endpoints_full` and change nothing.
4. **Write:** `PUT /cloud/config` with only `{"READER-GATEWAY": <edited object>}`.
5. **Verify:** `GET /cloud/config` again, and confirm our connection is present with the same URL. A mismatch is `reader_verify_failed`.
6. **Record:** store the pairing in SQLite: `rfid_readers` holds `serial`, `ip`, `model`, `versions` JSON, `password_index`, `token`, `paired_at`, `laptop_ip`, `scheme`, `port`. A single `rfid_pairing` row marks which serial is current.
7. **Release the old reader:** when the current serial changes, the edge makes a best-effort GET/PUT on the previous reader that removes only the connection(s) the "ours" rule matches. A failure is logged (never the token) and never fails the new pairing.

A Label Station setup the cloud accepts deletes the `rfid_pairing` row (the `rfid_readers` row, with its password index and token, stays).

**Endpoints** (edge session required):

- `POST /edge/rfid/connect {ip}` → `{ip, model, serial, versions, status, paired_with}`
- `POST /edge/rfid/pair {ip, laptop_ip?, confirm_takeover?}` → `{paired: true, reader: {...}, endpoint_url}`. The token in the URL is replaced with `…` in every response and log. Without `laptop_ip`: no fresh host file is 409 `host_network_unknown`; a fresh one with no address on the reader's subnet is 409 `reader_not_on_subnet`.
- Connect and pair refuse an offline edge session with 503 `edge_offline` (Kiosk Setup can't finish without the cloud). Scanning stays open.
- `GET /edge/rfid/reader` → the current pairing, or null.

### 2.5 UI binding and host check

- **Binding:** the installers publish `0.0.0.0:8090:8090` and `0.0.0.0:8091:8091` (the runtime compose template). The repo's development compose file follows.
- **Host check:** TrustedHostMiddleware still applies. Allowed hosts are `localhost`, `127.0.0.1`, `[::1]`, `EDGE_ALLOWED_HOSTS`, and **the laptop's fresh IPs from `host-network.json`**, re-read at most every 30 seconds.
- **Unencrypted notice:** `/config.js` exposes `lanAccess: true` when the request's host is not localhost. The kiosk login page then shows "This connection isn't encrypted — sign in only on a trusted network."
- **Shared laptop setup (Jimmy, final review D2):** Kiosk Setup belongs to the laptop, not to each browser. After the cloud accepts `/kiosk/setup`, the edge stores the result in SQLite (move, site and role, scan type and label, station type, and for RFID the reader's ip, serial, model and versions) and serves it at `GET /edge/setup` (edge session required; `null` before the first setup; cleared by Wipe). A laptop-mode browser with no complete local setup loads it and downloads the move data, so a phone on the LAN starts set up rather than blank. Kiosk Setup reached through a LAN address says it changes the laptop itself.
- **README:** the "keep 127.0.0.1" warning is replaced by a LAN-access section covering what works (everything but WebUSB printing, with the laptop's shared setup) and the cleartext caveat. TLS stays future work.

## 3. Cloud: database, API, portal

### 3.1 Migration (0086)

Before numbering, confirm 0086 is still free in every worktree and the dev DB. On `devices`:

- `station_type text NULL` with `CHECK (station_type IN ('label','rfid'))`
- `rfid_reader_ip inet NULL`
- `rfid_reader_serial text NULL`
- `rfid_reader_model text NULL`
- `rfid_reader_versions jsonb NULL`
- `rfid_paired_at timestamptz NULL`

The downgrade drops them.

### 3.2 API

- **`KioskSetupIn`** gains `station_type: Literal['label','rfid'] | None` and `reader: KioskReaderIn | None`.
  - `KioskReaderIn` has `ip`, `serial` (max 64), `model` (max 64), and `versions` (a dict of short strings).
  - `rfid` requires `reader`; a missing reader is 422 `reader_required`.
  - `rfid` requires the device's `sub_type == 'laptop'`, otherwise 422 `rfid_needs_laptop`.
  - `label` clears the reader columns.
  - Omitting `station_type` (older kiosks) leaves both untouched.
  - Existing move-lock and serial-ownership rules apply unchanged.
- **Audit:** `kiosk_station_setup` with the before/after diff.
- **Device payloads:** list and detail return `station_type` and a `rfid_reader` object (or null).
- **Heartbeat:** never touches these columns.

### 3.3 Edge pass-through

The edge's `/kiosk/setup` route adds `station_type` and, for RFID, `reader` from its current pairing. The browser does not send reader details; the edge supplies them.

### 3.4 Portal

**Hardware › Kiosk Devices:**

- A **Type** column showing "RFID · Laptop", "Label Station · Laptop", or the existing sub-type label when `station_type` is null. It follows the list-column-floor rules.
- A station-type filter chip.
- In the kiosk's detail or expansion, a **Reader** panel: IP, model, serial, versions, and paired time.

All of these reuse the existing list, chip and detail idioms.

### 3.5 Kiosk UI

- The footer mode shows "RFID · Laptop" or "Label Station · Laptop" after setup.
- Settings › This Kiosk shows the station type and the paired reader.
- Kiosk Setup's summary card includes the station type, and the reader for RFID.

## 4. Testing

**Edge (pytest):**

- A **fake ZIOTC reader**: an in-process HTTPS app built from Zebra's published API shapes (version, status, config). Tests cover:
  - the password order, and remembering the index that worked
  - mapping to `reader_auth_failed`, `reader_not_iotc` and `reader_unreachable`
  - status and version parsing
  - the config edit: replace ours, keep others, refuse a 3rd connection, takeover needing confirm, read-back mismatch
  - the token redacted in responses and logs
- A discovery test with fake hosts (FX, non-FX, timeout), progress counts, cancel-on-rescan, and stale or missing `host-network.json`.
- The allowed-hosts refresh from `host-network.json`, and `lanAccess` in `/config.js`.

**Installer (pytest + Pester):**

- host-helper output parsing for each OS's tool format
- exclusion rules
- atomic write
- job registration and removal
- the compose template publishing 8090 and 8091 on `0.0.0.0`

**Cloud (pytest):**

- migration up and down
- setup validation: `reader_required`, `rfid_needs_laptop`, `label` clears the reader, an omitted station type leaves it untouched
- the move lock
- the audit entry
- device list and detail fields
- the heartbeat not touching them

**Kiosk and portal (vitest):**

- step branching and counts
- back navigation
- manual IP
- scan states: running, empty, found, stale host
- the takeover confirm
- error messages
- the footer and This Kiosk display
- the portal Type column, filter and Reader panel

**Manual (needs hardware), on a real FX9600:**

- discovery on the laptop's subnet
- each password path
- pairing, then confirming the endpoint in the reader's web console
- re-pairing to a second laptop (takeover)
- the "endpoints full" message
- LAN access to the kiosk UI from a phone, showing the unencrypted notice

## Out of scope

- Receiving and storing tag data, and the processing worker
- TLS for the edge
- Reader settings (power, antennas, region): that is the placeholder page
- Multiple readers per kiosk
- Non-FX readers
