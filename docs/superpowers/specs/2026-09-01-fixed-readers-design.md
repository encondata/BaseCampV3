# Fixed Readers list

**Date:** 2026-09-01
**Status:** Approved design
**Builds on:** `2026-08-31-devices-routers-design.md` and
`2026-08-31-router-vpn-leases-design.md` (the unified `devices`
registry this extends).

## Summary

The Fixed Readers placeholder becomes a real list of Zebra FX9600
readers, built on the same standard machinery as the Routers page.
Two structural additions: a shared `model` column on `devices`, and
the reader block (`antennas_connected`, `connection_type`,
`scan_status`). **Tags read (24h) is derived from the scan pipeline**
— the first live link between the device registry and `raw_scans` —
via the documented convention that a fixed reader's `name` equals the
identity string it reports in `raw_scans.device_id`. `scan_status` is
the checkpoint this reader stamps (V2's `devices_rfid_readers`
role); the (future) matcher enrichment reads it.

## Data model (migration 0039, `down_revision "0038"`)

`devices` gains:

| column | type | scope / notes |
|---|---|---|
| `model` | TEXT NULL | shared — every family has a model; routers may adopt it (currently only in `raw_info`) |
| `antennas_connected` | SMALLINT NULL | reader block; FX9600 has 8 ports, displayed `N / 8` |
| `connection_type` | TEXT NULL | reader block; expected `api` / `mqtt` / `local_api`; un-FK'd (same tolerance rationale as `vpn_status`) |
| `scan_status` | TEXT NULL | reader block; composite FK → `status_values(record_type='asset')` via GENERATED `scan_status_record_type` — our config, integrity-protected |

Readers' IP address reuses the existing `lan_ip` column (one address,
on the LAN), displayed as "IP"; documented in the `Device` docstring.
Also documented there: **fixed reader `name` = the reported
`raw_scans.device_id` string** (renaming a reader visibly zeroes its
tag counts — acceptable, recoverable).

## API

`GET /devices` items gain `model`, `antennas_connected`,
`connection_type`, `scan_status`, `scan_status_label`,
`scan_status_color` (vocab join; label/color NULL when `scan_status`
is), and derived `tags_read_24h` = COUNT of `raw_scans` rows +
`processed_scans` rows where `device_id = devices.name` and
`scanned_at >= now() - interval '24 hours'` — two grouped subqueries
outer-joined on name, no per-row queries. 0 (never NULL) when no
scans match. Delete endpoint unchanged (readers use the same one).
Registration/heartbeat still deferred.

## Portal — Fixed Readers page

Replaces the `FixedReaders` placeholder. Full standard directory list
in the Routers.tsx mold: page key `'hardware-fixed-readers'`, fetches
`GET /devices?device_type=fixed_reader`, default sort `name` asc,
search / Filters / Columns / CSV / persisted state, per-row Delete
(confirm, delete-gated), disabled toolbar button **Register reader**
with hint "Readers self-register — the registration endpoint arrives
with the device agent."

Columns (defaults on unless noted):

| key | label | rendering |
|---|---|---|
| `name` | Name | text |
| `model` | Model | text, `—` null |
| `mac` | MAC | `.mono` |
| `ip` | IP | `lan_ip`, `—` null |
| `uptime` | Uptime | humanized (existing `formatUptime`) |
| `tags_24h` | Tags (24h) | derived count, numeric sort |
| `antennas` | Antennas | `N / 8`, `—` null |
| `connection` | Connection | tag: `api`→API, `mqtt`→MQTT, `local_api`→Local API, other values as-is, `—` null |
| `scan_status` | Scan Type | status chip in the vocab color; `—` null |
| `site` | Site | site_name, `—` null |
| `last_seen` | Last seen | default OFF, locale date-time / `never` |

Facets: Site, Connection, Scan Type (labels). CSV: all columns + id.
No row expansion in this round (the second "Site" in the request was
a duplicate; per-antenna detail is a future follow-up).

Shared accessors: extend `lib/devices.ts` (`deviceCellText` etc.)
with the new keys plus `connectionLabel(type)`; the Routers page is
untouched except that nothing breaks (new DeviceItem fields are
additive).

## Sample data (dev DB only — NOT migration seeds)

Three FX9600 rows (`device_type='fixed_reader'`, model `FX9600`,
serials `FX9600-*`, MACs, `lan_ip` 192.168.8.x, uptimes, sites set):

- `dock-reader-1` — antennas 8, `connection_type='api'`,
  `scan_status='rfid_1_cage_exit'`
- `dock-reader-2` — antennas 4, `connection_type='mqtt'`,
  `scan_status='rfid_10_dock_to_truck'`
- `warehouse-reader-1` — antennas 2, `connection_type='local_api'`,
  `scan_status='rfid_4_into_cage'`, zero tags (no matching scans)

The two dock readers are named to match the seeded scans'
`device_id` strings. Because the seeded scan spread has likely aged
out of any 24h window, the seed step also inserts a few hundred fresh
`raw_scans` rows (device_id `dock-reader-1`/`dock-reader-2`,
`scanned_at` within the last 24h, statuses matching each reader's
checkpoint) so Tags (24h) shows real non-zero counts.

## Testing

- API: new-column round-trip; `scan_status` FK rejects unknown keys;
  `tags_read_24h` derivation (raw+processed summed, outside-window
  excluded, unlinked reader → 0, other-device_id scans not counted);
  vocab label/color join.
- Portal: accessor tests (antennas / connection / scan-status /
  tags cell text), page tests in the Routers.test.tsx mold (columns,
  chips, Delete gating + stopPropagation-free — no expansion here,
  Register disabled, error banner).
- Browser screenshot gate on the seeded rows: chips/colors, real tag
  counts, facets; console clean.

## Out of scope

Registration/heartbeat; matcher enrichment reading `scan_status`;
per-antenna detail/expansion; edit forms; handhelds and kiosks.
