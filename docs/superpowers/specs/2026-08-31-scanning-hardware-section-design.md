# Scanning Hardware section (placeholders)

**Date:** 2026-08-31
**Status:** Approved design

## Summary

A new sidebar section, **Scanning Hardware**, between Stakeholders and
Admin, holding four placeholder pages — one per device family the
scanning pipeline runs on. Placeholders only: no data model, no API
endpoints, no tables. Each device family gets its own spec → plan →
build later; this effort just claims the navigation, routes, and access
surface so those efforts have a home.

## Pages and routes

| Nav item | Route | Hint copy names |
|---|---|---|
| Handheld Readers | `/hardware/handheld-readers` | Android, iOS, and Zebra (Android) handheld scanners |
| Fixed Readers | `/hardware/fixed-readers` | Zebra FX9600 fixed RFID readers |
| Kiosk Devices | `/hardware/kiosks` | Web and iOS (iPad) kiosk stations |
| Routers | `/hardware/routers` | GL.iNet site routers |

Each page: standard `.portal-page` head (eyebrow **Scanning Hardware**,
page title, `.page-hint` naming the device models) and a `.dir-empty`
body: "Nothing here yet — device records land when this section is
built out." No other content.

## Access

One resource for the whole section — split-per-type is deferred until a
device family actually needs different access:

- `Resource("scanning_hardware", "Scanning hardware", routes=(all four
  routes), visible_to={"global"})` in `access/resources.py`.
- Grants via **migration 0036** (`down_revision "0035"`), same posture
  as scans/status_rules: developer / founder / super_admin / admin =
  view+add+change+delete, staff = view. Mirrored in
  `access/defaults.py` (`_ALL`, `admin`, `staff`).
- All four routes wrapped in `ProtectedRoute resource="scanning_hardware"`.

## Registration touchpoints (all hand-maintained)

Portal: routes in `App.tsx` (between the Stakeholders and Admin
groups); new section in `layout/navSections.tsx` between Stakeholders
and Admin with per-item inline SVG icons; `CRUMBS`
(`['Scanning Hardware', <item>]`) and `PAGES` entries in
`components/Topbar.tsx`; `navGated` entries in
`components/CommandPalette.tsx`; `ROUTE_RESOURCE` entries in
`lib/access.ts`. API: `resources.py`, `defaults.py`, migration 0036.

## Testing

- API: registry/access tests updated for the new resource; migration
  applies in the standard test harness.
- Portal: one test file covering the four pages (title + hint render;
  content hidden without `scanning_hardware` view); existing
  nav/godmode suites green with the new section; full suite + build.
- Browser spot-check: section appears between Stakeholders and Admin,
  all four pages load with their copy.

## Out of scope

Everything real: device schemas, CRUD, APIs, per-type resources,
linkage to `raw_scans.device_id`. Each device family is its own future
spec.
