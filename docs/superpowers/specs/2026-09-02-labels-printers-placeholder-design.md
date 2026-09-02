# Labels → Printers placeholder

**Date:** 2026-09-02  **Branch:** `labels`  **Status:** Approved design

Add a fourth item to the Labels nav section: **Printers**, LAST in the
section (Print Labels, Generate Labels, Templates, Printers) — hardware
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

## Amendment (2026-09-02, user request): structured page, not bare Placeholder

`/labels/printers` becomes a real page component `portal/src/pages/Printers.tsx`
(App.tsx route swaps `Placeholder` for it; nav/crumbs/palette unchanged):

- Page head: eyebrow "Labels", title "Printers", hint as before.
- `.subs-tabs` tab strip (Variables pattern, role=tablist/tab,
  aria-selected): **Zebra Printers** (default) and **Brother Printers**.
- Zebra tab: three option rows — **Test Label Alignment**, **Install
  Fonts**, **Full Printer Setup** — each a `.dir-list`-style row with a
  one-line description and a `chip tag` "Coming soon" badge; rows are
  inert (no click behavior yet).
  - Descriptions: alignment = "Print a calibration label and dial in
    offsets."; fonts = "Push the house label fonts to the printer's
    storage."; setup = "Guided first-time configuration for a new Zebra
    printer."
- Brother tab: a `.dir-empty` body — "Brother printer tools are coming
  soon." (no options yet).
- Test `portal/src/pages/Printers.test.tsx`: default tab shows the three
  options each with a Coming soon chip; switching tabs shows the Brother
  empty state.
