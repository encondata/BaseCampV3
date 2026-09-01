# Handheld Readers + consolidated row Actions menu

**Date:** 2026-09-01
**Status:** Approved design
**Builds on:** `2026-09-01-kiosk-devices-design.md` (this page is its
sibling and generalizes its modal).

## Summary

The last placeholder becomes real: Handheld Readers is a
KioskDevices-style page for `device_type='handheld_reader'` with
sub-types **android / ios / zebra**, the same field set, registration
lifecycle, and provisioning modal. Alongside it, one UI change on both
kiosk and handheld lists: the per-row Edit / Register-or-Renew /
De-Register / Delete buttons collapse into a single expanding
**Actions** menu.

## Data model (migration 0041, `down_revision "0040"`)

No new columns. One rename: `devices.kiosk_type` → **`sub_type`** —
it is the shared per-family type field (kiosk: `laptop`/`pi`;
handheld_reader: `android`/`ios`/`zebra`). `ALTER TABLE devices RENAME
COLUMN`; downgrade renames back. The wire shape renames with it:
`DeviceItem.sub_type`, PATCH/POST allowlist swaps `kiosk_type` for
`sub_type` (unknown key `kiosk_type` now → 422 `bad_field`), portal
`DeviceItem`/`DeviceWrite` renamed. Acceptable now: only dev data and
this week's code reference it.

## Handheld Readers page

`portal/src/pages/HandheldReaders.tsx`, a KioskDevices sibling:

- Fetches `GET /devices?device_type=handheld_reader`; page key
  `'hardware-handhelds'`; default sort `name` asc.
- Head: title `Handheld Readers`, hint
  `Android, iOS, and Zebra handheld scanners.`
- Columns identical to the kiosk page (Name · Type · IP · MAC ·
  Version · Registration · Current Move · Scan Type · Site; Expires +
  Last seen default-off) with Type rendering `android`→`Android`,
  `ios`→`iOS`, `zebra`→`Zebra` tags (other values as-is, `—` null).
- Facets Type / Registration / Site; CSV all columns + id, filename
  `handheld-readers`; toolbar **+ New handheld** (add-gated).
- Registration lifecycle, chips, and action semantics identical to
  kiosks (same derived states, same endpoints, same days modal).
- Replaces the `HandheldReaders` placeholder export (removing the last
  one — `ScanningHardware.tsx` shrinks to just the shared `Placeholder`
  removal or deletion of the file if nothing remains; keep the file
  only if the nav-wiring test lives there — move that test to a
  standalone `scanningHardwareNav.test.tsx` if the page file dies).

## Shared modal

`KioskEditModal` generalizes to
`portal/src/components/hardware/DeviceEditModal.tsx`:

- Props: `deviceType: string`, `noun: string` (e.g. "kiosk" /
  "handheld"), `typeOptions: {value, label}[]`, `device: DeviceItem |
  null`, `onClose`, `onSaved`.
- Behavior unchanged from the kiosk modal (2-column `.pf-form`,
  label-above-control, move options = unarchived move-type
  planned/in_progress, scan options = active asset vocab, PATCH sends
  changed fields only, create POSTs the given `device_type`). The Type
  select renders `typeOptions`.
- KioskDevices passes Laptop/Pi; HandheldReaders passes
  Android/iOS/Zebra. The old `KioskEditModal` name disappears; its
  tests move/rename with it.

## Row Actions menu (kiosks + handhelds only)

New shared `portal/src/components/hardware/RowActionsMenu.tsx`, built
on the same popover mechanics the column menus use (`.pop-menu` in
`lib/columnMenu.tsx` / `column-menu.css` — reuse its open/close +
click-away/Escape handling, extracting a small hook only if one isn't
already exported):

- Trigger: one compact `Actions ▾` `.mini-btn` per row (trailing track
  shrinks to ~110px).
- Items, in order, permission-gated exactly as the buttons were:
  **Edit** (change) · **Register** (state `none`) or **Renew** (other
  states) (change) · **De-Register** (states other than `none`)
  (change) · **Delete** (delete, destructive styling, last, separated).
  A viewer with no grants sees no Actions button at all.
- Selecting an item closes the menu then runs the exact existing flow
  (modal / days modal / confirm). One menu open at a time; Escape and
  click-away close.
- Applied to KioskDevices and HandheldReaders only; Routers and Fixed
  Readers keep inline buttons for now.

## Sample data (dev DB only — NOT migration seeds)

- `handheld-a54-01` — android, v2.4.1, MAC/IP, site, registered
  (now+30d), current move = NAP11 demo, `scan_status='rfid_1_cage_exit'`.
- `handheld-iphone-02` — ios, v2.4.1, registered, expiry now+2d
  (amber), no move.
- `handheld-tc21-07` — zebra, v2.3.9, unregistered (NULL expiry),
  `registered_at` defaulted — name matches a seeded scan `device_id`
  for future linkage.

## Testing

- API: existing device tests updated for the `sub_type` rename (field
  name only, no semantic changes); PATCH with `kiosk_type` now 422
  `bad_field` (pinned).
- Portal: `RowActionsMenu` unit tests (opens/closes, Escape/click-away,
  contextual Register-vs-Renew/De-Register items, permission gating,
  item click runs callback + closes); Handhelds page tests mirroring
  the kiosk ones; kiosk page tests updated to drive actions through
  the menu; `DeviceEditModal` tests renamed + a typeOptions case.
- Browser screenshot gate: both pages, each with the Actions menu OPEN;
  the handheld create modal; register round-trip via the menu on a
  handheld; console clean.

## Out of scope

Rolling the Actions menu out to Routers/Fixed Readers; registration/
heartbeat endpoint; per-device detail pages.
