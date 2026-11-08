# Kiosk Bulk Print — design

Date: 2026-11-07. Branch `kiosk-bulk-print`.

## What Jimmy asked for

"Build the Bulk Print page for the web kiosk. Mirror the /labels/print as much
as possible from the portal with the obvious exception that we won't have to
select a move as that is part of the kiosk setup." His answers:

- Label types: "any label type, same as the portal".
- Access: "staff and above. hide the menu option if not staff or above".
- Printer: "use the printer saved in Printer Setup".
- Mockups: "no, just mirror the portal page".

The portal page's behavior contract is
`docs/superpowers/specs/2026-09-12-print-labels-design.md` and its code is
`portal/src/pages/PrintLabels.tsx`. Where this document is silent, the kiosk
page behaves the way the portal page does.

## The page

`/labels/bulk` (Label Printing › Bulk Print) replaces today's placeholder
`LabelSectionPage` for the `bulk` section. It works on a web kiosk and on a
laptop. Its layout follows the portal page, with two differences:

- **No Initiative step.** The move is the one in Kiosk Setup
  (`readKioskSetup().initiativeId`). The header names the move.
- **No Printer step.** It prints on the printer saved in Printer Setup, read
  through the label backend (`labelBackend.getSettings()`) and reached through
  `useStationPrinter()`. Over USB on a web kiosk, and over USB or the network
  on a laptop. A summary line shows the saved printer (model or IP) and its
  DPI, with a link to Printer Setup. With no saved printer, the page says so,
  links to Printer Setup, and nothing prints.

So there is one step card, **Label type**, followed by the roster card and the
Ready to print bar.

### Kept from the portal

- **Label type.** Every type the portal offers: the move's label vocabulary
  (`/kiosk/labels/vocab`) without the person types (ID badges are excluded, as
  in the portal), plus Custom ZPL. A type's `default_copies` seeds copies the
  same way.
- **Two modes, as in the portal.** Asset mode for asset label types, container
  mode for container types (`isContainerLabelType`). Each mode keeps its own
  selection and shown rows.
- **The list.** Checkboxes, select all and none, search, the Ready and Missing
  segmented filter, and rack order for assets. The kiosk's list keeps the
  portal list's columns and status logic (`labelStatusFor`, `missingLabelIds`,
  `staleLabelCount`).
- **Print settings window.** Copies, batch size, print by rack, and blanks
  between racks. These are stored in localStorage under the portal's key and
  shape (`readPrintSettings` / `writePrintSettings`). Offsets are not in this
  window (see below).
- **Ready to print bar, batch progress window, and Reprint.** Batching,
  pausing between batches, the auto-next countdown, rack separators and blank
  labels all work as in the portal (`printOrder`, `containerPrintOrder`,
  `batchBounds`, `rackSeparatorZpl`, `blankLabelsZpl`). Each label goes out
  through `StationPrinter.send`.
- **Custom ZPL.** Sent once with nothing ticked, or once per ticked asset, as
  in the portal.
- **Offline.** Each label bundle the page loads online is written to a kiosk
  cache. When the network fails, the page serves the cached bundle and shows
  the portal's "Offline — showing labels cached …" notice.

### Kiosk rules (my calls, agreed in the playback)

1. **Labels come from a new kiosk route** (below), returning the same
   generated labels the portal prints. A kiosk sign-in can only reach
   `/kiosk/*`, so the portal's `/labels/generated/bundle` is out of reach.
2. **DPI.** The page keeps only labels at the saved printer's DPI
   (`bundleAtDpi`). Labels at another DPI count as missing, with the portal's
   message saying to generate them at that DPI. There is no DPI picker:
   Printer Setup owns the DPI.
3. **Offsets and print mode come from Printer Setup.** Every label goes out as
   `withPrintMode(applyPrintSettings(zpl, {...settings, horizontalOffset:
   saved.offset_x, verticalOffset: saved.offset_y}), saved.peel)`. Printer
   Setup's alignment test is the place to adjust them.
4. **No Labeled scans.** As in the portal, Bulk Print records nothing. The
   Printing Station is still where printing records a Labeled scan.
5. **No "Offline labels" download window.** A kiosk has one move, and the
   write-through cache already covers it.
6. **The roster comes from the kiosk's synced move data**, not from
   `/assets`. Assets come from the stored assets sync body (`assets_raw`,
   which carries rack, RU, pod and statuses) and containers from the
   `containers` store. So the list works offline, and its rows are the move's
   current sync. Where the portal list shows a column the sync body lacks, the
   kiosk list leaves that column out. Archived containers are excluded, as in
   the portal.

### Access

- The Bulk Print card on Label Printing, and its breadcrumb level, show only
  when the signed-in person has `labels:view` (`can('labels', 'view')` on the
  kiosk session's perms). That means staff and above: admin, developer,
  founder, super_admin and staff. Workers never see it.
- Opening `/labels/bulk` without `labels:view` redirects to Label Printing.
- The API route below refuses anyone without `labels:view`. Hiding the card
  is not the security boundary.

## API

`GET /kiosk/labels/bundle?initiative_id=<uuid>&label_type=<str>` in
`api/src/serversherpa/api/routes/kiosk.py`.

- **Auth.** A kiosk session (`kiosk:view`) plus `labels:view`. Either missing
  gives 403.
- **Scope.** `initiative_id` must be the kiosk's set-up move, checked the same
  way the other `/kiosk/sync/*` routes check it. Any other move gives 404.
- **Body.** The same response model and query as
  `GET /labels/generated/bundle` (`GeneratedLabelBundleOut`). The shared query
  moves into one helper that both routes call, so the two can never drift
  apart. An unknown `label_type` returns the portal route's error.
- **Laptop.** The edge already proxies `/kiosk/*` to the cloud as the
  signed-in person, so no edge change is needed. Offline on a laptop, the
  proxy fails and the page falls back to its cache, as on the web.

## Code layout

React components from the portal can't be imported into the kiosk (the
`@portal` guardrail allows React only from `components/login/*`), and the
portal lists use the portal's auth context. So:

- **Imported from `@portal` unchanged** (React-free): `lib/printLabels.ts`,
  `lib/labels.ts`, and the cache logic, if `lib/labelCache.ts` can take a
  database name. The kiosk uses its own IndexedDB database so it never shares
  one with a portal open in the same browser. If `labelCache.ts` can't be
  reused cleanly, the kiosk gets a small bundle cache in its own `localDb`.
- **Kiosk copies of the portal components**, kept as close to the portal's as
  the kiosk's own primitives allow: `BulkPrint.tsx` (the page), an asset list,
  a container list, a Print settings modal and a batch modal. The modals use
  the kiosk's modal header pattern and rounded corners. Lists follow the
  kiosk's light and dark themes and its scrollbar styling.
- `lib/api.ts` gains `fetchKioskLabelBundle(initiativeId, labelType)`.
- `lib/labelSections.ts` / `pages/Labels.tsx` / `lib/breadcrumbs.ts` gain the
  `labels:view` gate for the `bulk` section.

## Errors and edge cases

- **No move set up.** The page says to open Kiosk Setup (the same copy the
  other label screens use).
- **No saved printer, or the printer doesn't answer.** The no-printer notice;
  a send failure stops the batch with the portal's failure state and Reprint.
- **Move data not synced yet.** The list shows the kiosk's "syncing" state and
  printing waits.
- **Bundle fetch fails with no cache.** The portal's "couldn't load labels"
  notice with Retry.
- **The move changes in Kiosk Setup.** Selections reset. The cache is keyed by
  move and type, so another move's labels are never shown.
- **Clear Setup** also clears the bulk-print cache (it erases all local data).

## Testing

- **API (pytest).** Staff gets the bundle; a worker gets 403; another move's
  id gets 404; a non-kiosk session is refused by the usual scope rule; the
  body equals the portal route's for the same move and type.
- **Kiosk (vitest).** The card is hidden without `labels:view` and shown with
  it; the route redirects without it; a type's labels load and the list shows
  Ready and Missing; other-DPI labels count as missing; a print sends each
  label through `send` with the saved offsets and print mode; batching, rack
  separators and blanks; Custom ZPL; the offline fallback; no outbox scan is
  queued; Clear Setup empties the cache.
- **Live.** On the dev web kiosk, sign in as staff and as a worker, then print
  a batch to the USB Zebra. Check the laptop build only by reading the page,
  since the 8090 laptop is a shared Label Station.
