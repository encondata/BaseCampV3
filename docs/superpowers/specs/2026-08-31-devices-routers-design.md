# Devices table + Routers list

**Date:** 2026-08-31
**Status:** Approved design
**Builds on:** `2026-08-31-scanning-hardware-section-design.md` (the
placeholder section this fills in first).

## Summary

One `devices` table for the whole scanning-hardware fleet — single
table with a `device_type` discriminator and typed per-family columns,
the same unification trade `initiatives` made (typed nullable blocks,
never queryable-data-in-JSON). The Routers page becomes a real list
(GL.iNet routers: name, WAN IP, LAN IP, MAC, serial, uptime) with
delete. The device **self-registration endpoint is deferred** — a
disabled Register button marks the affordance; sample rows are seeded
into the dev DB so the page has data.

## Data model (migration 0037)

New vocabulary record type `device_type`, seeded:
`router` ("Router"), `fixed_reader` ("Fixed Reader"),
`handheld_reader` ("Handheld Reader"), `kiosk` ("Kiosk") — registered
in `status/registry.py` gated on resource `scanning_hardware` (values
manageable on the Variables page like every vocabulary).

Table `devices`:

| column | type | notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `device_type` | TEXT NOT NULL | composite FK → `status_values(record_type='device_type')` via GENERATED `type_record_type` column (house pattern) |
| `name` | CITEXT NOT NULL | |
| `serial` | CITEXT NULL | partial-unique (`WHERE serial IS NOT NULL`) — the future registration upsert key |
| `mac` | CITEXT NULL | partial-unique |
| `site_id` | UUID NULL → sites | |
| `wan_ip` | TEXT NULL | router-typed |
| `lan_ip` | TEXT NULL | router-typed |
| `uptime_seconds` | BIGINT NULL | last reported; displayed as-of `last_seen_at` |
| `last_seen_at` | timestamptz NULL | future heartbeat touchpoint |
| `raw_info` | JSONB NOT NULL default `{}` | last raw registration payload, provenance only — never queried |
| `registered_at` | timestamptz NOT NULL default now() | |
| `created_at` / `updated_at` | timestamptz NOT NULL default now() | |

No `archived_at`: device rows are operational records — delete is a
hard delete, recorded in the audit trail. Indexes: `device_type`,
`name`. Future families add their own typed nullable columns in their
own migrations.

## API (`api/routes/devices.py`, resource `scanning_hardware`)

- `GET /devices?device_type=` — full list (view-gated), newest
  `registered_at` first; items carry every column above plus
  `site_name`.
- `DELETE /devices/{device_id}` — delete-gated; 404
  `device_not_found`; audited (`entity_type="device"`, action
  `delete`, changes = name/type/serial snapshot).
- **Deferred:** the self-registration endpoint (pre-shared-token auth,
  upsert by serial, refreshes IPs/uptime/`last_seen_at`/`raw_info` —
  doubles as the heartbeat). Nothing in this effort may block that
  shape.

## Portal — Routers page

Replaces the `HardwareRouters` placeholder with the full standard
directory list (model: the status-rules RulesTab, itself modeled on
Notifications.tsx): search + result count, Filters (facet: Site),
Columns, CSV export, per-column menus/sort/drag-reorder, state
persisted under page key `'hardware-routers'`.

Columns: **Name** (default sort asc), **WAN IP**, **LAN IP**, **MAC**
(`.mono`), **Serial** (`.mono`), **Uptime** (humanized `14d 3h`, from
`uptime_seconds`; `—` when null) — defaults on; **Last seen**
(locale date-time or `never`) and **Site** — defaults off.

Row action: **Delete** (confirm dialog, gated
`can('scanning_hardware','delete')`, errors surfaced via the house
error-state pattern). Toolbar: **Register router** button, disabled,
with hint copy "Routers self-register — the registration endpoint
arrives with the device agent." (visible regardless of permissions;
it's an affordance marker, not an action).

The other three placeholder pages are untouched. The list fetches
`GET /devices?device_type=router` only.

## Sample data (dev DB only — NOT migration seeds; production starts empty)

Insert directly into the dev database, e.g.:

- `dock-router-1` — GL.iNet GL-MT300N, serial `GL-MT300N-C4A1B2`, mac
  `94:83:C4:12:A1:B2`, wan `203.0.113.14`, lan `192.168.8.1`, uptime
  ≈ 12 days, last_seen recent, site = a real seeded site.
- `warehouse-router` — GL.iNet GL-AR750S, serial `GL-AR750S-77D0E3`,
  mac `94:83:C4:77:D0:E3`, wan `198.51.100.201`, lan `192.168.8.1`,
  uptime ≈ 3 days.
- `raw_info` carries a plausible GL.iNet-ish payload (model, firmware).

## Testing

- API: device model round-trip + vocab FK enforcement; list + type
  filter + site_name join; delete (204, audit row, 404, 403 without
  the grant).
- Portal: pure accessor tests (uptime humanizer, cellText) + page
  tests mirroring the rules-list ones (rows render, delete gating both
  ways, load-error banner, disabled Register button present).
- Browser: seeded routers render with all six columns; delete round-trip
  on one seeded row (then re-insert); console clean.

## Out of scope

Registration/heartbeat endpoint and its auth; edit/add forms; the
other three device families (each gets its own spec); device status
derivation (online/stale) and linkage to `raw_scans.device_id`.
