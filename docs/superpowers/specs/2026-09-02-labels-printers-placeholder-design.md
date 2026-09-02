# Labels → Printers placeholder

**Date:** 2026-09-02  **Branch:** `labels`  **Status:** Approved design

Add a fourth item to the Labels nav section: **Printers**, LAST in the
section (Print Labels, Templates, Generate Labels, Printers) — hardware
config belongs at the end, mirroring how Routers ends Scanning Hardware.

- Route `/labels/printers`, resource `labels`, standard `Placeholder`
  (eyebrow "Labels", title "Printers", hint "Registered Zebra and Brother
  label printers — configuration and status." + the stock coming-soon line).
- Registration points, mirroring the existing Labels items exactly:
  `navSections.tsx` (distinct device-style icon — Print Labels keeps the
  printer glyph), `App.tsx` route, `Topbar.tsx` CRUMBS
  (`['Labels', 'Printers']`) + PAGES, `CommandPalette.tsx`
  `navGated('Printers', '/labels/printers', 'labels')`,
  `lib/access.ts` ROUTE_RESOURCE.
- Server `access/resources.py`: add `/labels/printers` to the `labels`
  resource's routes tuple (keeps the server route registry honest; no
  grants change — same resource).
- Tests: extend `labelsNav.test.tsx`'s item-order assertion to the four
  routes; full portal suite + build stay green. The real Printers page
  (registration, status, driver config) is a future spec.
