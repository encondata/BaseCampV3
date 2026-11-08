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
  `useStationPrinter()`. A web kiosk saves only USB printers. A laptop Label
  Station uses USB or a network printer.
  - A summary line shows the saved printer (model, or IP) and its DPI, with a
    link to Printer Setup.
  - **Web kiosk with no saved printer:** "No printer is set up on this kiosk.
    Set one up in Printer Setup." with a link. Nothing prints.
  - **Laptop that isn't a Label Station:** `GET /edge/label-station` returns
    null, so there is no printer to use. The page says "This laptop isn't set
    up to print labels. Make it a Label Station in Kiosk Setup to print here."
    Nothing prints.

So there is one step card, **Label type**, followed by the roster card and the
Ready to print bar.

### Kept from the portal

- **Label type.** Every label type in the label vocabulary
  (`/kiosk/labels/vocab`, which is global, not per move), plus Custom ZPL. The
  person types (ID badges) are left out, as in the portal. A type's
  `meta.default_copies` seeds copies the same way.
- **Two modes, as in the portal.** Asset mode for asset label types, container
  mode for container types (`isContainerLabelType`). Each mode keeps its own
  selection and shown rows.
- **The list** (see "Lists" below for what carries over).
- **Print settings window.** Copies, batch size, print by rack, and blanks
  between racks. These use the portal's localStorage key and shape
  (`readPrintSettings` / `writePrintSettings`). The window always writes
  `{...readPrintSettings(), ...its four fields}`, so the offsets that
  `/labels/printers` keeps under the same key (PrinterTools,
  AlignmentTestModal) survive. Its "modified" indicator ignores offsets. The
  portal window's offset fields, alignment test, and size and DPI pickers are
  left out, since Printer Setup owns those.
- **Ready to print bar, batch progress window, and Reprint.** Batching, the
  auto-next countdown, rack separators and blank labels work as in the portal
  (`printOrder`, `containerPrintOrder`, `batchBounds`, `rackSeparatorZpl`,
  `blankLabelsZpl`). Each label goes out through `StationPrinter.send`. The end
  of a batch is **OPEN QUESTION 1**.
- **Custom ZPL.** Sent once with nothing ticked, or once per ticked asset, as
  in the portal.
- **Offline.** Each label bundle the page loads online is written to a kiosk
  cache. When the network fails, the page serves the cached bundle and shows
  the portal's "Offline — showing labels cached …" notice.

### Kiosk rules (agreed in the playback)

1. **Labels come from a new kiosk route** (below), returning the same
   generated labels the portal prints. A kiosk sign-in can only reach
   `/kiosk/*`, so the portal's `/labels/generated/bundle` is out of reach.
2. **DPI.** The page keeps only labels at the saved printer's DPI
   (`bundleAtDpi(bundle, String(saved.dpi))`). Labels at another DPI count as
   missing, with the portal's message saying to generate them at that DPI.
   There is no DPI picker: Printer Setup owns the DPI.
3. **Offsets and print mode come from Printer Setup.** Every label goes out as
   `withPrintMode(applyPrintSettings(zpl, {...settings, horizontalOffset:
   saved.offset_x, verticalOffset: saved.offset_y}), saved.peel)`. Printer
   Setup's alignment test is the place to adjust them.
4. **No Labeled scans.** As in the portal, Bulk Print records nothing. Nothing
   is queued in the outbox. The Printing Station is still where printing
   records a Labeled scan.
5. **No "Offline labels" download window.** A kiosk has one move, and the
   write-through cache already covers it.
6. **The roster comes from the kiosk's synced move data**, not from
   `/assets`: the parsed `assets` and `containers` stores, so the list works
   offline. Archived containers are excluded, as in the portal. See "Rows" for
   the field mapping.

### Rows

The portal helpers (`printOrder`, `rackOf`, `labelStatusFor`,
`missingLabelIds`, `staleLabelCount`) work on the portal's `InitiativeAssetRow`.
There, `asset_id` is the asset's UUID, which is what a bundle's `entity_id`
holds. The kiosk's `KioskAssetOut` uses `id` for the UUID and `asset_id` for
the human legacy id. A kiosk adapter, `lib/bulkPrintRows.ts`, turns synced rows
into the portal shape so the helpers run unchanged:

| Portal field (`InitiativeAssetRow`) | Kiosk source (`KioskAssetOut`) |
|---|---|
| `asset_id` (UUID, the selection key) | `id` |
| `asset.asset_id` (shown Asset ID) | `asset_id` |
| `asset.name`, `asset.serial_number`, make/model | `name`, `serial_number`, `make_model` |
| `source_rack` / `destination_rack` | same names |
| `source_ru` / `destination_ru` (number or null) | `Number(source_ru_raw ?? source_ru)`; null when that isn't a finite number |
| `source_position` / `destination_position`, `*_pod` | same names |
| `priority_wave`, `disposition`, `owner` | same names |
| `status_label` | `roster_status_label` |
| `status_color` | none: the status shows as a plain chip |

For containers, `ContainerItem.type_label` maps from `container_type_label`.
Status and type show as plain chips, since the sync has no colors.
`legacy_id`, `name`, `label_tag` and `rfid_tag` keep their names.

The kiosk's TypeScript types `KioskAssetRow` and `KioskContainerRow`
(`kiosk/src/lib/api.ts`) gain the fields above that the API already sends. No
API sync change is needed.

### Lists

The portal lists are built on React tools the kiosk can't import
(`lib/columnMenu.tsx`, `lib/listTools.tsx`, `lib/virtualRows.tsx`, and the
portal auth context for preferences). The kiosk gets its own asset list and
container list, with the same columns (less any the sync lacks) and:

- checkboxes, select all and none of the shown rows;
- search across the shown columns;
- the Ready / Missing segmented filter, with counts;
- sort by clicking a column header, natural order, with the asset list's
  rack-and-RU tie-break;
- a DPI-missing reason in the status cell, as in the portal;
- virtual rows, so a roster of thousands scrolls smoothly. This is a small
  kiosk helper; the rows are a fixed height.

**Not carried over** (see OPEN QUESTION 2): per-column filter menus, the
column picker, and saved list preferences.

### Access

- The Bulk Print card on Label Printing shows only when the signed-in person
  has `labels:view` (`can('labels', 'view')` on the kiosk session's perms).
  Login and refresh responses carry the full `access.perms`, so this means
  staff and above: admin, developer, founder, super_admin and staff. Workers,
  including a move-password sign-in, never see the card.
- Opening `/labels/bulk` without `labels:view` redirects to Label Printing.
  The breadcrumb trail needs no change: it is a pure function of the path, and
  the redirect covers access.
- The API route refuses anyone without `labels:view`. Hiding the card is not
  the security boundary.

## API

`GET /kiosk/labels/bundle?initiative_id=<uuid>&label_type=<str>` in
`api/src/serversherpa/api/routes/kiosk.py`.

- **Auth.** `kiosk:view` (the router's guard) plus
  `require_permission("labels", "view")`. A missing permission gives 403.
- **Scope.** `_require_move` first: a move-password session on another move
  gives 403 `move_locked`. Then the portal route's `_scoped_initiative`: an
  unknown, archived or out-of-scope move gives 404, as on the portal.
- **Type.** A `label_type` that isn't in the label vocabulary gives 422
  `unknown_label_type`. The portal route is unchanged.
- **Body.** The same response model and query as
  `GET /labels/generated/bundle` (`GeneratedLabelBundleOut`). The query moves
  into one helper that both routes call, so they can't drift apart.
- **Laptop.** The edge already proxies `/kiosk/*` to the cloud as the
  signed-in person, so no edge change is needed. The route is not added to the
  edge's cacheable list. Offline, the proxy answers `edge_offline`, which the
  kiosk already reads as a network failure. An offline sign-in gets 403
  `cloud_sign_in_required`. The page treats both as offline and falls back to
  its cache.

## Code layout

- **From `@portal`, unchanged** (React-free, already importable):
  `lib/printLabels.ts` and `lib/labels.ts`.
- **Bundle cache.** A new `label_bundles` store in the kiosk's own
  `serversherpa-kiosk` IndexedDB, keyed by `<initiative_id>:<label_type>`. It
  holds the bundle and `cached_at`, bumps `DB_VERSION` from 7 to 8, and is
  added to `STORES`, so `ALL_STORES`, `clearEverything()` and Clear Setup empty
  it with no extra code. The portal's `labelCache.ts` is not reused, because
  its database name is a constant.
- **Vocab offline.** The last vocab fetched is kept in the `meta` store. With
  no network, the type list comes from there. If there is none, it comes from
  the types of the move's cached bundles, as the portal does.
- **Kiosk pages and components:**
  - `pages/BulkPrint.tsx`;
  - `components/bulkPrint/BulkAssetList.tsx` and `BulkContainerList.tsx`;
  - `BulkPrintSettingsModal.tsx` and `BulkPrintBatchModal.tsx`, using the
    kiosk's modal header pattern and rounded corners;
  - `lib/bulkPrintRows.ts` (the adapter) and `lib/virtualRows.ts` (the
    helper).

  Everything follows the kiosk's light and dark themes and its scrollbar
  styling.
- `lib/api.ts` gains `fetchKioskLabelBundle(initiativeId, labelType)`.
- `App.tsx` routes `bulk` to `BulkPrint`, behind the `labels:view` redirect.
  `pages/Labels.tsx` hides the card without it.

## Errors and edge cases

- **No move set up.** The page says to open Kiosk Setup, with the same copy
  the other label screens use.
- **No saved printer.** See "The page".
- **The printer doesn't answer, or a send fails.** The batch stops in the
  portal's failed state, with Reprint.
- **Move data not synced yet.** The list shows the kiosk's syncing state and
  printing waits.
- **The bundle fetch fails with no cache.** The portal's "couldn't load
  labels" notice, with Retry.
- **The move changes in Kiosk Setup.** Selections reset. The cache is keyed by
  move and type, so another move's labels never show.
- **Clear Setup** empties the cache, since `label_bundles` is in `STORES`.

## Open questions for Jimmy

1. **The end of a batch.**
   - The portal waits after each batch until the printer says every label is
     out (`printer.waitForIdle`, a `~HS` poll). Then it shows "Batch complete"
     and starts the next batch's countdown.
   - In peel mode, that wait lasts until every label has been taken.
   - The kiosk's printer connection has no such wait, and the standing rule is
     no printer checks in the print path unless asked.
   - Options: (a) no wait: a batch is done when it has been sent; (b) the
     portal's wait, on USB and over the network.
2. **List tools.** Whether per-column filter menus, the column picker and
   saved list preferences are needed on the kiosk.

## Testing

- **API (pytest).**
  - Staff gets the bundle, and a worker gets 403.
  - A locked session on another move gets 403 `move_locked`.
  - An unknown, archived or out-of-scope move gets 404.
  - An unknown type gets 422 `unknown_label_type`.
  - The body equals the portal route's for the same move and type, ignoring
    `fetched_at`.
- **Kiosk (vitest).**
  - The card is hidden without `labels:view` and shown with it, and the route
    redirects without it.
  - The adapter maps the id, RU and status fields.
  - A type's labels load, and the list shows Ready and Missing.
  - Labels at another DPI count as missing.
  - A print sends each label through `send` with the saved offsets and print
    mode.
  - Batching, rack separators and blanks.
  - Custom ZPL.
  - The settings window keeps the stored offsets.
  - The offline fallback works on `network`, `edge_offline` and
    `cloud_sign_in_required`, for both vocab and bundle.
  - No outbox scan is queued.
  - The not-a-Label-Station laptop copy.
  - Clear Setup empties `label_bundles`.
- **Live.** On the dev web kiosk, sign in as staff and as a worker, then print
  a batch to the USB Zebra. On the shared 8090 laptop, only read the page.
