# GL.iNet router agent — self-registration, approval, and status reports

**Date:** 2026-10-01
**Status:** Approved design
**Builds on:** `2026-08-31-devices-routers-design.md`,
`2026-08-31-router-vpn-leases-design.md` (both deferred the router
self-registration endpoint this spec delivers).

## Summary

A small shell agent installed on GL.iNet routers (GL-AC2100 and
GL-MT3000, OpenWrt-based firmware 3.x/4.x) sends a status report to the
API every 5 minutes. A router identifies itself by its **WAN MAC
address** plus a **router-generated secret**. The first report from an
unknown MAC registers the router as **pending** and sends an approval
notification to every scanning-hardware admin. Nothing in a report is
stored until an admin approves the router on Scanning Hardware ›
Routers (or from the inbox popover). Approval is persistent until it is
manually revoked. The agent is send-only: it reads nothing back from
the API except the HTTP status code.

## Router side — `router_agent/` (new top-level folder)

| file | purpose |
|---|---|
| `basecamp-router.sh` | collects data, builds the JSON, POSTs it |
| `basecamp-router.init` | procd service (`/etc/init.d/basecamp-router`), enabled at boot, runs the reporter loop |
| `install.sh` | one-line installer and `--uninstall` |
| `README.md` | install, uninstall, troubleshooting, what is sent |
| `test/` | fixture tests (canned `ubus`/`uci`/`iwinfo` output) |

**Language:** BusyBox `ash` using only tools present on stock GL.iNet
firmware: `ubus`, `uci`, `jsonfilter`, `iwinfo`, `ip`, `wg`, `curl`.
`curl` is required. Stock GL.iNet firmware ships it; the installer stops
with an `opkg install curl` hint if it is missing, because
`uclient-fetch` can't set a JSON content type. JSON is built with
`jshn.sh` (`/usr/share/libubox/jshn.sh`), which is part of OpenWrt, and
read with `jsonfilter`. No packages are installed.

### Install

After the branch is merged and pushed to GitHub, run this on the router
over SSH:

```sh
curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh | sh -s -- --api https://<api-host>
```

`install.sh`:

1. Checks it is running on OpenWrt as root, and that the API URL is
   given and uses `https://`.
2. Downloads `basecamp-router.sh` to `/usr/bin/basecamp-router` and the
   init script to `/etc/init.d/basecamp-router` from the same raw
   GitHub ref. `--ref <branch|tag>` overrides `main`.
3. Writes the UCI config `/etc/config/basecamp` (`api_url`,
   `interval` = 300 seconds, `enabled` = 1). On a re-install, existing
   values are kept unless flags override them.
4. Generates `/etc/basecamp/secret` only if it does not already exist:
   32 bytes from `/dev/urandom`, hex-encoded, mode 600. A re-install
   keeps the secret, so the router does not need re-approval.
5. Adds `/etc/basecamp/`, `/etc/config/basecamp`, the binary and the
   init script to `/etc/sysupgrade.conf`, so they survive firmware
   upgrades.
6. Enables and starts the service, sends one report immediately, and
   prints the HTTP result ("registered — waiting for approval in the
   portal" / "approved — reporting").

`install.sh --uninstall` stops and disables the service, then removes
the files and the sysupgrade entries. It leaves the secret only if
`--keep-secret` is passed.

### Report loop

The procd service runs `basecamp-router run`. It first waits 30-60
seconds, so the WAN is up after a boot and the installer's own report is
past the API's 20-second spacing. Then it sends a report and sleeps for
`interval` plus a random jitter of 0-30 seconds, and repeats. It retries
on the next tick and never backs up a queue. Errors go to `logread`
with the tag `basecamp`. `basecamp-router once` sends a single report
and prints the response; this is for troubleshooting.

### Report payload (`schema_version: 1`)

```json
{
  "schema_version": 1,
  "agent_version": "1.0.0",
  "wan_mac": "94:83:c4:aa:bb:cc",
  "secret": "<64 hex>",
  "model": "GL-MT3000",
  "firmware": "4.5.0",
  "hostname": "GL-MT3000-1a2",
  "uptime_seconds": 86400,
  "wan": { "ip": "203.0.113.7", "gateway": "203.0.113.1", "proto": "dhcp", "up": true },
  "lan": { "ip": "192.168.8.1", "netmask": "255.255.255.0" },
  "wifi": [
    { "radio": "radio0", "band": "2g", "ssid": "Site-WiFi", "channel": 6,
      "enabled": true, "clients": 4 }
  ],
  "clients": { "total": 9, "wired": 3, "wireless": 6 },
  "dhcp_clients": [
    { "mac": "aa:bb:cc:dd:ee:01", "ip": "192.168.8.120", "hostname": "kiosk-01",
      "reserved": false, "up": true }
  ],
  "vpn": [
    { "name": "wgclient1", "type": "wireguard", "role": "client", "enabled": true,
      "up": true, "endpoint": "vpn.example.com:51820", "last_handshake_seconds": 42 }
  ]
}
```

Where each value comes from:

- **WAN MAC:** the MAC of the device behind `network.wan`
  (`ubus call network.interface.wan status` → `l3_device`/`device`, then
  `/sys/class/net/<dev>/address`). The value is lower-cased and
  colon-separated.
- **Model / firmware:** `/tmp/sysinfo/model` (or `ubus call system
  board`) and `/etc/glversion` (falling back to
  `/etc/openwrt_release`).
- **Uptime:** `/proc/uptime`.
- **DHCP clients:** `/tmp/dhcp.leases` for dynamic leases, `uci show
  dhcp` host entries for reservations, and `ip neigh` (REACHABLE, STALE
  or DELAY) for `up`. Reserved hosts with no lease are still reported,
  with `up` taken from `ip neigh`.
- **WiFi:** `uci show wireless` for SSID, enabled flag and band;
  `iwinfo <ifname> info` for the live channel; `iwinfo <ifname>
  assoclist` for station counts.
- **Client counts:** wireless is the sum of the assoclist counts; wired
  is the number of `up` DHCP clients whose MAC is not in any assoclist;
  total is wired plus wireless.
- **VPN:**
  - WireGuard: `uci` `network` interfaces with `proto=wireguard`, plus
    `wg show <if> latest-handshakes`. A tunnel counts as up when the
    last handshake was within 180 seconds.
  - OpenVPN: `uci` `openvpn` sections, plus a check that the process is
    running and the tun interface exists.
  - Tailscale and ZeroTier are reported only if their binaries exist.
  - GL.iNet 4.x stores client tunnels under `wireguard`/`ovpnclient`
    UCI configs; the script reads both layouts.
  - Each tunnel's `role` is `client` or `server`.

The payload is capped: at most 512 DHCP clients and 32 VPN entries; the
API rejects anything bigger with 413. Any collector that fails reports
`null` for its section rather than aborting the report.

## API side

### Endpoint: `POST /router-agent/report`

This is a new router module, `api/src/serversherpa/api/routes/router_agent.py`.
It has no user session and is not under the kiosk-session prefixes.
Business logic lives in `api/src/serversherpa/services/router_agent.py`.

**Validation:** Pydantic schema; MAC must be a valid 48-bit unicast
address; the secret must be 64 hex characters; the body must be 256 KB
or less.

**Rate limit:** counted in the database like kiosk pairing, using
`rate_limit_ip()`, with no new table.
- Per router: a report that arrives within 20 seconds of that router's
  previous `last_seen_at` gets 429 and is not stored. A per-IP report
  count would need a hit log; per-router spacing gives the same
  protection, because an unknown MAC can only get in through the
  registration cap.
- At most 10 new-router registrations per IP per hour, counted from the
  `router_register` audit rows' `ip`. Audit rows can't be changed, so a
  router that moves to another address can't launder the count. A per-IP
  advisory lock serializes concurrent first reports.
- Going over either limit returns 429.

**Decision table** (rows keyed by MAC, `device_type = 'router'`):

| situation | effect | response |
|---|---|---|
| unknown MAC | create router row: `approval_state='pending'`, `agent_secret_hash`, identity only (mac, model, firmware, hostname, `last_seen_at`, `agent_source_ip`); audit `router_register`; notify approvers | 202 `{"state":"pending"}` |
| MAC belongs to a non-router device | nothing stored | 409 |
| pending, previously approved (`approved_at` set), secret matches | **auto-restore**: `approval_state='approved'`, store the full snapshot, clear `pending_secret_hash`, keep `secret_mismatch = true`; audit `router_auto_restore` (no actor); no notification. This undoes a forged report's knock-down; revoke clears `approved_at`, so a revoked router never takes this row | 200 `{"state":"approved"}` |
| pending (never approved) or revoked, secret matches | refresh identity fields + `last_seen_at` + `agent_source_ip`; discard the rest; revoked moves to pending; clear `pending_secret_hash` (so an attacker's candidate can't be promoted by a later approval); `secret_mismatch` is **not** cleared; no notification | 202 `{"state":"pending"}` |
| pending or revoked, secret differs | set only `pending_secret_hash` (the newest non-pinned secret), `secret_mismatch = true` and `updated_at`; revoked moves to pending. Identity fields, `agent_source_ip`, `raw_info` and `last_seen_at` are untouched, so a forgery can't erase evidence or rate-limit the real router (approving accepts the newest secret) | 202 |
| approved, secret matches | store the full snapshot (below) | 200 `{"state":"approved"}` |
| approved, secret differs | **discard data**; set `approval_state='pending'`, `pending_secret_hash` = new hash, `secret_mismatch = true`, `updated_at` and nothing else (no identity, `agent_source_ip`, `raw_info` or `last_seen_at` change); audit `router_secret_mismatch`; no notification | 202 `{"state":"pending"}` |

`secret_mismatch` means "a different secret was seen since the last admin
decision". Only approve and revoke reset it; a genuine report never does,
not even an auto-restore: the evidence stays until an admin dismisses it.

Secrets are stored only as SHA-256 hashes. Because they are 256-bit
random values, a salted KDF adds nothing. Hashes are compared with
`hmac.compare_digest`. The response body never says why a report was
held, so a caller can't use it to test MACs.

**Snapshot write (approved routers only), in one transaction:**
- `devices`: `wan_ip`, `lan_ip`, `uptime_seconds`, `last_seen_at`,
  `agent_source_ip`, `vpn_status`, and `raw_info` replaced with
  `{model, firmware, hostname, agent_version, wan, lan, wifi, clients,
  vpn}`.
- `vpn_status` is a summary string: `up` (every enabled tunnel is up),
  `down` (none are), `partial`, or `none` (no tunnels configured).
- `device_dhcp_leases`: synced by `(device_id, mac)`. Upsert every
  reported client. Clients that are no longer reported get `up = false`.
  They are deleted only after they have been missing for 7 days, which
  keeps the history shown in the expansion.
- If the router reports `dhcp_clients` as `null` because the collector
  failed, the lease table is left untouched.

**Notification:** sent on first registration only.
- Kind `router_approval`, sent via `notify()` to every person whose
  role grants `('scanning_hardware','change')`. The approver lookup is
  the `notifications/requests.py approver_ids()` query with the
  resource and action made parameters.
- Title "Router waiting for approval"; the body has the model,
  hostname, MAC and source IP; the link is `/hardware/routers?focus=<id>`.
- `payload = {device_id, state: 'pending'}`.
- When any approver acts, from the page or the popover, every copy is
  resolved with the same pattern as `resolve_copies()`.

### Admin endpoints (on `routes/devices.py`, `scanning_hardware:change`)

- **`POST /devices/{id}/approve`** → `approval_state='approved'`,
  `approved_at`, `approved_by`.
  - If a `pending_secret_hash` exists, it is promoted to
    `agent_secret_hash` and `secret_mismatch` is cleared.
  - The action is audited and notification copies are resolved.
  - It is a guarded UPDATE on `approval_state <> 'approved'`, so double
    approvals are no-ops.
  - On a router that is already approved and has `secret_mismatch`, it
    **dismisses the warning**: `secret_mismatch = false`,
    `pending_secret_hash = NULL`, no candidate promoted, `approved_at` and
    `approved_by` unchanged; audited `router_mismatch_dismissed`; no
    copies resolved. A second call is a no-op (guarded UPDATE).
- **`POST /devices/{id}/revoke`** → `approval_state='revoked'`;
  `approved_at` and `approved_by` are cleared (the audit row keeps who
  approved it), which is what stops an auto-restore; the snapshot is
  kept for reference; audited; copies resolved.
- The popover's **Reject** button for a pending router calls
  `revoke`. There is no separate reject endpoint.
- `DELETE /devices/{id}`: already exists. A deleted router that reports
  again registers as new and notifies again.

`GET /devices` adds `approval_state`, `approved_at`, `approved_by_name`,
`secret_mismatch`, `agent_source_ip`, and `raw_info.wifi/vpn/clients`
for routers.

### Existing `register` / `token_expires_at`

The router approval replaces the old manual "Register" and token-expiry
idea for routers.
- On the Routers page, the existing Token column becomes **Approval**.
- `POST /devices/{id}/register` and `/deregister` stay for kiosks only.
  The router UI stops calling them.
- `token_expires_at` is left untouched on existing rows. No migration
  of old sample data is needed.

## Data model — migration 0087 (`down_revision "0086"`)

`devices` gains:

| column | type | notes |
|---|---|---|
| `approval_state` | TEXT NULL, CHECK in (`pending`,`approved`,`revoked`) | NULL for non-agent devices |
| `approved_at` | timestamptz NULL | |
| `approved_by` | UUID NULL → people ON DELETE SET NULL | |
| `agent_secret_hash` | TEXT NULL | sha256 hex |
| `pending_secret_hash` | TEXT NULL | candidate secret awaiting approval |
| `secret_mismatch` | BOOL NOT NULL default false | |
| `agent_source_ip` | TEXT NULL | last report's source IP |

There is also a partial index on `audit_log (ip, at)` where
`action = 'router_register'`, used by the registration rate limit.

**Migration numbering:** before merging, check every worktree and the
dev DB for 0087. The `rfid-station` branch already collides at 0086 and
may take 0087 when it is re-pointed.

## Portal — Scanning Hardware › Routers

- **Approval column:** a chip showing Pending (amber), Approved (green)
  or Revoked (grey), plus a "Secret changed" warning badge when
  `secret_mismatch` is true. Its tooltip reads "This MAC reported with a
  different secret — the router was reset, reinstalled, or is being
  impersonated." On an approved row it reads "A report with a different
  secret was seen; the router has since proved itself with its approved
  secret." An approved row with the badge also gets a **Dismiss warning**
  action (confirm, then `approve`).
- **Status column:** derived from `last_seen_at`. It is Online when the
  router was seen within 3 × 300 s plus jitter (16 minutes), Offline
  otherwise, and Never for pending routers that were never seen.
- **Row Actions menu** (the shared `RowActionsMenu`): Approve (pending
  or revoked), Revoke (approved), Delete. Approve and Revoke confirm with
  `window.confirm`, the Kiosk Devices idiom, and the message names the
  MAC, model and source IP.
- **Expanded row tabs:** DHCP clients (existing `RouterLeases`), WiFi
  (radio, band, SSID, channel, enabled, clients) and VPN (name, type,
  role, up/down chip, endpoint, last handshake). For pending or revoked
  routers, the expansion shows only the identity panel and the line
  "Reports are held until this router is approved."
- **Clients column:** shows `raw_info.clients.total` when present,
  otherwise the existing count derived from leases.
- **"Register router" button:** the current disabled button is replaced
  by a "How to add a router" button. It opens a modal with the install
  command, already filled in with this deployment's API URL, plus a copy
  button.
- **`?focus=<id>`:** scrolls to the row and expands it.
- **Inbox popover:** `NotificationsPanel.tsx` gets a `router_approval`
  branch with Approve and Reject buttons, reusing the membership-request
  strip.
- All copy uses American English. List-typography, column-floor and
  natural-sort guardrails apply.

## Error handling

- **Agent:**
  - Network or HTTP failures are logged and retried on the next tick.
  - A 429 makes it skip one extra interval.
  - A 409 or 4xx is logged as an error, and the agent keeps running.
  - The agent never deletes its secret by itself.
- **API:**
  - Malformed payloads return 422 and store nothing.
  - Unexpected `vpn`/`wifi` shapes are stored as reported inside
    `raw_info`; only the summary fields are validated strictly.
  - Read-only maintenance mode does not block router reports. They are
    telemetry with no user session, which is the same reasoning as
    `/kiosk/printer-events`; approvals are still frozen, because they
    are signed-in admin writes.

## Testing

- **API (pytest):**
  - Each row of the decision table.
  - Approve, revoke and reject, including the promotion of the pending
    secret and the guarded double-approve.
  - Notification fan-out, sent once, and copies resolved.
  - Both rate limits.
  - Lease sync: upsert, `up=false`, the 7-day purge, and `null` leaving
    leases untouched.
  - `vpn_status` summary.
  - The 413 and 422 cases.
- **Portal (vitest):** Approval column and chips; actions per state;
  WiFi/VPN tabs; held-reports panel; popover approve/reject; install
  modal.
- **Agent:** `router_agent/test/run.sh` runs `basecamp-router.sh`
  under BusyBox `ash` in an `openwrt/rootfs` Docker image with stubbed
  `ubus`/`uci`/`iwinfo`/`ip`/`wg` returning fixture output for 3.x and
  4.x layouts. The test asserts on the produced JSON (`--dry-run` prints
  instead of POSTing). `install.sh` is tested in the same container
  against a local file server.
- **Live verify:**
  - In an OpenWrt container: run install.sh against the dev API; check
    the pending row and the notification; approve; check that the
    snapshot appears.
  - Change the secret; check that the row goes back to pending with the
    mismatch badge.
  - On a real AC2100/MT3000 if one is available. Otherwise record that
    hardware is unverified.

## Out of scope

- Commands from the portal to the router; the agent is send-only.
- History or time-series storage.
- Auto-assigning a site to a router (still set by hand on the row).
- Other router vendors.
