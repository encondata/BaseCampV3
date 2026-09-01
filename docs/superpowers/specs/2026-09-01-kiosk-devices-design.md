# Kiosk Devices page

**Date:** 2026-09-01
**Status:** Approved design
**Builds on:** the unified `devices` registry
(`2026-08-31-devices-routers-design.md` and successors).

## Summary

The Kiosk Devices placeholder becomes a real page. Kiosks differ from
routers/readers in one important way: they are **manually
provisioned** — created and edited from the portal — so this feature
introduces the registry's first create/edit surface (a modal) plus
Register / De-Register actions with a derived registration lifecycle.
The kiosk-side pairing endpoint remains deferred.

## Data model (migration 0040, `down_revision "0039"`)

`devices` gains:

| column | type | scope / notes |
|---|---|---|
| `version` | TEXT NULL | shared — app/firmware version string |
| `kiosk_type` | TEXT NULL | kiosk block; `laptop` / `pi` |
| `current_initiative_id` | UUID NULL → initiatives.id | kiosk block; the selected move |

Reused columns: `lan_ip` = the kiosk's IP; `scan_status` = Current
Selected Scan Type (same FK'd asset-vocab column readers use);
`token_expires_at` = **registration expiry**; `registered_at` =
last registration time.

## Registration lifecycle (derived — no status column)

| state | condition | chip |
|---|---|---|
| Registered | `token_expires_at` > now + 7d | green |
| Expires soon | within 7 days | amber |
| Expired | past | red |
| Unregistered | NULL | neutral tag |

(Same `tokenExpiryState` helper the Routers token column uses.)

- **Register** (`POST /devices/{device_id}/register`, body
  `{"days": int}` default 30, 422 `bad_days` unless 1–365): sets
  `registered_at = now()`, `token_expires_at = now() + days`. Serves
  as both first registration and renewal.
- **De-Register** (`POST /devices/{device_id}/deregister`): sets
  `token_expires_at = NULL` (leaves `registered_at` as history).
- Both change-gated on `scanning_hardware`, audited
  (`entity_type="device"`, actions `register` / `deregister`).

## API

- `GET /devices` items gain `version`, `kiosk_type`,
  `current_initiative_id`, `current_initiative_name` (outer join to
  initiatives).
- `POST /devices` (add-gated, audited `create`): body = `device_type`
  plus the PATCH field set below; `device_type` validated against the
  `device_type` vocabulary, `scan_status` against the asset
  vocabulary (422 `bad_scan_status`), `current_initiative_id` must
  exist (422 `bad_initiative`). Returns the created item.
- `PATCH /devices/{device_id}` (change-gated, diff-audited `update`):
  allowed fields exactly `name, kiosk_type, mac, lan_ip, version,
  site_id, current_initiative_id, scan_status` — anything else in
  the body is a 422 `bad_field`. Same value validations as POST.
  Explicit nulls allowed for the nullable fields (clearing a move /
  scan type is legitimate); `name` may not be nulled or emptied
  (422 `bad_name`).
- Move options: the portal reuses the existing initiatives list
  endpoint and filters client-side to unarchived `initiative_type ==
  'move'` with status `planned` or `in_progress`.

## Portal — Kiosk Devices page

Standard directory list (page key `'hardware-kiosks'`), replacing the
`KioskDevices` placeholder; fetches
`GET /devices?device_type=kiosk`; default sort `name` asc.

Columns (defaults on unless noted):

| key | label | rendering |
|---|---|---|
| `name` | Name | text |
| `kiosk_type` | Type | tag: `laptop`→Laptop, `pi`→Pi, other as-is, `—` null |
| `ip` | IP | `lan_ip`, `—` |
| `mac` | MAC | `.mono`, `—` |
| `version` | Version | text, `—` |
| `registration` | Registration | lifecycle chip per the table above |
| `current_move` | Current Move | `current_initiative_name`, `—` |
| `scan_status` | Scan Type | vocab-colored chip (existing mechanism, truncating) |
| `site` | Site | site_name, `—` |
| `expires` | Expires | default OFF; locale date, `—` |
| `last_seen` | Last seen | default OFF |

Facets: Type, Registration (the four states), Site. CSV: all columns
+ id, filename `kiosks`. Toolbar: **+ New kiosk** (add-gated) — no
disabled register-affordance button on this page; kiosks are
portal-provisioned.

Row actions (mini-buttons, stopPropagation not needed — no
expansion): **Edit** (change-gated) · **Register** (label "Renew"
when currently registered/expiring; opens a small modal with a Days
number field defaulting 30 + confirm) or **De-Register** (shown when
registered/expiring/expired; confirm dialog) · **Delete**
(delete-gated, confirm).

### Edit / Create modal (binding form rules apply)

One `KioskEditModal` component used for both modes. House modal
skeleton; **label-above-control in a consistent 2-column grid**,
section heading distinct from field labels, no floating checkboxes:

- Name* (text) · Type (select: Laptop / Pi)
- MAC (text) · IP (text)
- Version (text) · Site (select over sites, "— none")
- Current Move (select over planned+in-progress unarchived moves,
  "— none") · Scan Type (select over asset vocab with color dots,
  "— none")

Save disabled until Name is non-empty. Create mode POSTs with
`device_type: 'kiosk'`; edit mode PATCHes only the changed fields.
Registration dates never appear in this modal (action-driven only).
Errors surface via the house detail-code map (`bad_scan_status`,
`bad_initiative`, `bad_field`, `bad_name`, `bad_days`).

## Sample data (dev DB only — NOT migration seeds)

- `kiosk-dock-1` — laptop, v2.4.1, MAC/IP set, site set, registered
  (`registered_at` now, expiry now+30d), current move = the "NAP11
  Hall Migration (demo)" initiative, `scan_status='rfid_1_cage_exit'`.
- `kiosk-wh-1` — pi, v2.4.1, registered but expiry now+3d (amber).
- `kiosk-spare` — pi, v2.3.9, unregistered (NULL expiry), no move,
  no scan type.

## Testing

- API: POST/PATCH validation incl. allowed-field enforcement +
  explicit-null semantics + name guard; register (default and custom
  days, 422 out of range) / deregister transitions + audit rows;
  initiative-name join; 403s per action.
- Portal: registration-state accessor/chip tests; page tests (columns,
  contextual Register-vs-Renew/De-Register visibility, modal create
  POST payload incl. device_type kiosk, edit PATCH sends only changed
  fields, error surfacing); move-option filtering helper test.
- Browser screenshot gate: the list with all three registration
  states, AND the open modal (form-rules check: aligned 2-column
  grid, labeled selects), register→renew round-trip on a seeded row;
  console clean.

## Out of scope

Kiosk-side pairing/registration endpoint and tokens; what the kiosk
client does with `current_initiative_id`/`scan_status`; handhelds;
bulk provisioning.
