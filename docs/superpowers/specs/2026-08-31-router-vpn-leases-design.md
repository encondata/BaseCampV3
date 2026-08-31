# Router VPN/fleet columns + DHCP-lease expansion

**Date:** 2026-08-31
**Status:** Approved design
**Builds on:** `2026-08-31-devices-routers-design.md`.

## Summary

The Routers list gains three columns — VPN status, connected-device
count, token expiration — and expandable rows showing the router's
active and reserved DHCP leases with an up indicator. The connected
count is **derived** from lease rows (never stored), so the column can
never disagree with the expansion. All new data is what the future
registration/heartbeat endpoint will sync; until then the dev DB
carries sample rows.

## Data model (migration 0038, `down_revision "0037"`)

`devices` gains:

| column | type | notes |
|---|---|---|
| `vpn_status` | TEXT NULL | reported string, deliberately NOT vocabulary-FK'd — the heartbeat must never be rejected for an unexpected value; the portal maps known values to chips, unknown values render as plain text |
| `token_expires_at` | timestamptz NULL | the router agent's API-token expiry |

New table `device_dhcp_leases`:

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `device_id` | UUID NOT NULL → devices ON DELETE CASCADE | |
| `mac` | CITEXT NOT NULL | |
| `ip` | TEXT NULL | |
| `hostname` | TEXT NULL | |
| `reserved` | BOOL NOT NULL default false | static reservation |
| `up` | BOOL NOT NULL default false | currently connected |
| `last_seen_at` | timestamptz NULL | |
| `created_at` / `updated_at` | timestamptz NOT NULL now() | |

UNIQUE `(device_id, mac)` — the future heartbeat's sync key. A
reserved lease may also be up. Index on `device_id`.

## API

- `GET /devices` items gain `vpn_status`, `token_expires_at`, and
  `connected_count` = COUNT of the device's leases with `up = true`,
  computed via one grouped subquery joined into the existing list
  query (no per-row queries).
- New `GET /devices/{device_id}/leases` (resource `scanning_hardware`,
  view): 404 `device_not_found` for unknown ids; returns all lease
  rows `{id, mac, ip, hostname, reserved, up, last_seen_at}` ordered
  `up DESC, hostname NULLS LAST, mac`.
- The deferred registration/heartbeat endpoint will upsert leases by
  `(device_id, mac)` and set `vpn_status`/`token_expires_at`; nothing
  here may block that.

## Portal — Routers list

New columns inserted after Serial, defaults on, fully wired into the
standard machinery (sort, column filters, facets where noted, CSV,
cellText contract):

| key | label | rendering |
|---|---|---|
| `vpn` | VPN | chip — `connected` → green "Connected", `disconnected` → red "Disconnected", other non-null values plain text as reported, null → `—`; also a Filters facet |
| `connected` | Devices | the derived count, numeric sort |
| `token_expires` | Token expires | locale date; red chip "expired" when past, amber chip when within 7 days, plain date otherwise, `—` when null |

## Row expansion (binding UI rules apply — no kv dumps)

- A chevron cell on every row toggles an expansion panel; one open at
  a time (asset-history-expansion precedent).
- Panel header: view-switcher button bar `Active (N)` / `Reserved (M)`
  — Active = rows with `reserved = false`, Reserved = `reserved =
  true`; counts always visible on both buttons.
- Body: one real aligned table, identical columns in both views:
  **Up** (green dot "Up" / gray dot "Down", accessible text) ·
  **Hostname** · **IP** · **MAC** (`.mono`) · **Last seen** (locale
  date-time). `—` per empty cell. Empty view states: "No active
  leases." / "No reservations."
- Leases fetched on each open (`GET /devices/{id}/leases`); loading
  note while in flight; on failure an inline error with a retry
  affordance. Collapse discards state.

## Sample data (dev DB only — NOT migration seeds)

- `dock-router-1`: `vpn_status='connected'`, `token_expires_at` ≈ now
  + 90 days; leases: `zebra-fx9600-dock` (reserved, up),
  `handheld-tc21-07` (active, up), `kiosk-ipad-3` (active, up),
  `handheld-tc21-02` (active, down, last_seen 2 days ago),
  `printer-dock` (reserved, down).
- `warehouse-router`: `vpn_status='disconnected'`, `token_expires_at`
  ≈ now + 3 days (exercises the amber chip); leases:
  `zebra-fx9600-wh1` (reserved, up), `handheld-tc21-11` (active, up),
  `kiosk-web-wh` (active, down, last_seen 6 hours ago).
- IPs in 192.168.8.x, plausible MACs.

## Testing

- API: lease model round-trip + (device_id, mac) uniqueness + cascade
  on device delete; derived count (up vs down vs reserved mix, zero
  leases → 0); leases endpoint ordering + 404 + external-role 403.
- Portal: accessor tests for the three new cell texts (chip
  thresholds: expired / <7d / healthy / null); page tests — columns
  render, expansion opens and fetches, view switcher swaps
  active/reserved sets, up dots present, lease-fetch error state.
- Browser (required before done, house rule): screenshot the list
  with the new columns AND an open expansion on the seeded data; both
  view-switcher states; console clean.

## Out of scope

Registration/heartbeat endpoint; editing leases or reservations from
the portal; VPN status vocabulary management; per-lease history.
