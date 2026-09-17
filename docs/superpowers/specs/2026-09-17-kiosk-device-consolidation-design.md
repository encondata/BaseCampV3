# Kiosk device consolidation — design

**Date:** 2026-09-17
**Branch:** `kiosk-consolidate`, off `main` @ `118926e`

## Problem

`/hardware/handheld-readers` models a distinction that does not exist in this
system. Nothing in the API or the Android app ever creates a
`device_type='handheld_reader'` row — the only producer is a human clicking
"+ New handheld" on that page, and there are zero such rows. Meanwhile every
kiosk client, Android included, pairs through `/kiosk`, where
`api/routes/kiosk.py:211` hardcodes `device_type="kiosk"` and stores the
client's reported `mode` as `sub_type`. Jimmy confirmed every handheld in the
fleet will run a version of the kiosk app, so there is no second category.

Two defects surfaced alongside it:

1. **The Kiosk Devices edit modal cannot represent its own data.**
   `KioskDevices.tsx:492` offers only `Laptop` and `Pi`, while the live kiosks
   are `android` and `web`.
2. **Any manual `sub_type` edit is silently reverted.** `kiosk.py:223` assigns
   `device.sub_type = body.mode` on every re-pair, so a hand-set value survives
   only until the device next checks in.

## Zebra Android devices are derived, not chosen

Jimmy wants six kinds: Laptop, Pi, Android, **Android (Zebra)**, iOS, Web.

"Android (Zebra)" cannot be a manual selection, because defect 2 would revert
it on the next check-in — the dropdown would appear to work and would not. It
does not need to be: the Android app **already sends the evidence** on every
pair. Live `raw_info` from a paired kiosk:

```json
{"model": "Pixel 10 Pro XL", "manufacturer": "Google", "datawedge": "false",
 "android_version": "17", "sdk_int": "37"}
```

`datawedge` is Zebra's own scanning middleware; a Zebra handheld reports
`manufacturer: "Zebra Technologies"` and `datawedge: "true"`.

**So the server derives it at pairing:** when `mode == "android"` and `raw_info`
indicates Zebra hardware, `sub_type` is stored as `zebra`. No Android release is
needed, the classification is right the first time a device pairs, it is
re-derived on every re-pair instead of being overwritten, and a device swapped
for different hardware reclassifies itself.

The client's `mode` Literal is unchanged — the app keeps reporting `android`,
and `zebra` is a server-side refinement of it. `zebra` is also the value the old
handheld page used, so any converted legacy row lands on a label that exists.

**Detection rule:** `manufacturer` containing "zebra" (case-insensitive) is the
primary signal; `datawedge == "true"` is accepted as a fallback in case the
manufacturer string varies across Zebra models. Either is sufficient.

## Changes

1. **`labels`-style derivation helper** in the kiosk route module — a pure
   function over `(mode, raw_info)` returning the stored `sub_type`, so the rule
   is unit-testable without a request. Called on both the create and the update
   branch of pairing.
2. **Kiosk Devices edit modal** offers all six, via `subTypeLabel` in
   `portal/src/lib/devices.ts`, whose `zebra` label becomes `Android (Zebra)`.
   The dropdown remains meaningful for manually created rows that never pair;
   for paired devices the derivation wins on the next check-in, which is the
   correct precedence.
3. **Remove the Handheld Readers page**: `portal/src/pages/HandheldReaders.tsx`
   and its test, the route at `App.tsx:180`, the nav entry at
   `navSections.tsx:465`, and the entry in `scanningHardwareNav.test.tsx:20`.
4. **Migration 0067** converts any `device_type='handheld_reader'` device to
   `'kiosk'`, preserving `sub_type`, and then removes the `handheld_reader`
   row from the `device_type` vocab. **That order matters** — `device_type` is
   foreign-keyed to `status_values`, so deleting the vocab row first would fail
   against any surviving device. Zero such rows exist today; the migration is
   written for the case where they do.

## Deliberately not doing

- **Not changing the overwrite behavior itself.** Pairing continues to assign
  `sub_type` on every check-in. The device is the authority on what it is, and
  making a manual edit stick forever is how stale classifications happen. The
  derivation makes the overwritten value correct rather than wrong, which is the
  actual fix.
- **Not adding `zebra` to the client `mode` Literal.** The app reports what it
  knows (`android`); the server refines it. Adding a mode the app never sends
  would be a second, unreachable path to the same value.
- **Not adding a CHECK constraint on `sub_type`.** It is free text today and a
  converted legacy value must survive rather than fail an upgrade.
