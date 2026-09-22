# Bulk add or update sites — design

**Request (Jimmy, 2026-09-22):** the first Bulk Actions tool: describe the
columns, download a CSV/XLSX template or an export of the current sites in the
same layout, upload the filled file, match rows to existing sites, and review
"update existing vs add new" before applying.

**Decisions (Jimmy):** a row matches an existing site by **name or
address** (option 1); **admin rank and above may approve updates** (option 1).

## What exists

`api/src/serversherpa/sites/bulk_import.py` + `/sites/bulk-import/*` routes:
template (csv/xlsx/json), upload (csv/xlsx/json, ≤1,000 rows, ≤5 MB),
`preview_rows` classifying each row create / update / unchanged / error with a
per-field diff, all-or-nothing `commit_rows` with per-row update approval and
audit rows. Matching is by name only; approving updates requires
`devtools:change`. The portal surface is the Bulk tab of the New Site dialog
(`SiteBulkImport.tsx`), gated at admin rank. This work keeps the pipeline and
changes the four things above.

## Matching

`normalize_address(text)`: lowercase, every non-alphanumeric character becomes a
space, whitespace collapses, trimmed. Empty stays empty.

`preview_rows` loads every non-archived site once and indexes it by lowercased
name and by `normalize_address(address_line1)` (empty keys skipped). For each
row:

- more than one existing site with the row's name → error
  `multiple existing sites named '{name}'` (unchanged rule);
- more than one existing site at the row's address and no name match → error
  `multiple existing sites at that address: {A}, {B}`;
- the name matches site A and the address matches a different site B → error
  `name matches '{A}' but address matches '{B}'`;
- otherwise the target is the name match (`matched_by: "name"`), else the
  address match (`matched_by: "address"`), else none (`matched_by: null`,
  action create).
- Two rows in the same upload with the same normalized address → error
  `duplicate address within the import` on both (mirrors the name rule).
- Two rows resolving to the same existing site (one by name, one by address)
  → error `two rows match the same existing site '{name}'` on every row in
  the group, naming the site's current name. Applying both would let the
  last row win silently.

An address match with a different name produces a `name` entry in the diff,
so a rename is visible and approved like any other change. The address itself
is diffed like any other field, so an address cleanup (case, punctuation,
spacing) is shown as an ordinary field change even though the match key is
unchanged. Preview rows gain `matched_by` and `matched_name` (the existing
site's current name, null for creates).

## Updates

The `allow_updates` / `devtools:change` coupling is removed: anyone who passes
the bulk gate (`sites:add` plus global actor at rank ≥ 60) sees updates in the
preview and may approve them. `approved_updates` and `rows_invalid` /
`update not approved` behave as today. The `updates_not_allowed` error and the
`update_allowed` response field are removed.

## Export

`GET /sites/bulk-import/export?format=csv|xlsx` (same gate as the template):
every non-archived site, ordered by name, in exactly `COLUMNS` order —
`type` = `site_type`, `partner` = partner name, `clients` = client names joined
with `; `, coordinates as plain decimal text, blanks empty. The XLSX carries the
same Reference sheet as the template. File names `sites-export.csv` /
`sites-export.xlsx`. `export_rows(db)` in `bulk_import.py` builds the rows;
`build_export_csv(rows)` / `build_export_xlsx(rows, types, statuses)` write them
(the template builders are refactored to share the writers).

Both writers carry the portal's formula-injection guard: a cell opening with
`=`, `+`, `-` or `@` that is not a plain number is written as text — prefixed
with `'` in CSV, pinned to a string cell in XLSX — and `_cell()` drops that
one leading `'` on import, so a guarded export re-uploads as `unchanged`.

## Page

`/bulk/sites` — "Add or update sites in bulk", route gated `minRank=ADMIN_RANK`
and `resource="sites"`; the first card on Bulk Actions ("Add or update sites in
bulk", resource `sites`, action `add`, button "Open"). Page sections:

1. **Columns** — a table of every template column: name, required (only
   `name`), what it accepts (free text; type keys; status keys; `US` default;
   decimal degrees; IANA zone; partner name; client names separated by `;`),
   and the example from the template. Source: `SITE_COLUMN_GUIDE` in
   `portal/src/lib/siteBulk.ts`, pinned by a test to the 17 template keys.
2. **Download** — Template (.xlsx), Template (.csv), Current sites (.xlsx),
   Current sites (.csv).
3. **Upload** — one file input (.csv, .xlsx) and a Preview button. The
   pasted-JSON input is dropped.
4. **Preview** — table: Row, Name, Matched by (name / address / new site),
   Action chip (Add / Update / No change / Error), Details (errors, or the diff
   with an Approve checkbox on updates), plus "Approve all updates" and a
   count line "N to add · M to update · K unchanged · E errors".
5. **Apply** — button "Add N sites and update M sites" (disabled until the
   preview is clean and every update is approved). On success the preview is
   replaced by a **review summary** (Jimmy, 2026-09-22: "as with any import or
   bulk action I would like a summary of what was done for review"): the
   commit returns one result per processed row (`row`, `name`, `site_id`,
   `action` created/updated/unchanged, `diff` as applied); the page shows the
   counts line, a table Row / Site (linked to `/sites?open=<id>`) / Result
   (Added / Updated / No change) / Changes (field: old → new), a "Download
   summary (.csv)" button (client-side CSV, columns Row, Site, Result,
   Changes), and an "Open Sites" link. The summary stays until a new file is
   chosen. The commit replays the uploaded cells, never the preview's
   normalized data: each preview row carries `cells` (the uploaded cells after
   normalization, before the create-only status/country defaults) beside
   `data`, and the portal posts `cells` for every non-error row, so a blank
   status or country can never be written onto an existing site.

`SiteBulkImport.tsx` becomes `SiteBulkUpload.tsx` (the upload + preview +
apply block, used by the page). The New Site dialog loses its Bulk tab and the
`canBulk` prop; the Sites page toolbar gets a "Bulk import…" button (admin rank
and `sites:add`) that opens `/bulk/sites`.

## Out of scope

Geocoding; matching on city/postal code; archiving or deleting through the
upload; raising the row or size limits; the pasted-JSON path.

## Testing

- API service: normalize_address; name match, address match, address match
  with rename diff, name↔address conflict, ambiguous address, duplicate
  address within the upload, archived sites ignored; admin update path; export
  rows shape and round trip (export → upload previews all `unchanged`).
- API routes: export csv/xlsx (gate, headers, content), admin can preview and
  commit updates, staff still 403; existing tests updated for the removed
  developer coupling.
- Portal: `SITE_COLUMN_GUIDE` keys; `SiteBulkUpload` (preview rows, approval
  gating, commit payload, matched-by column); `BulkSites` page renders the
  guide and downloads; `BulkActions` shows the card when `sites:add`; Sites
  toolbar button; whole suite + `tsc --noEmit`.
- Live: export the dev sites, re-upload unchanged (all "No change"), edit one
  address line and one name in the file, re-upload, see the address-matched
  rename and apply it.
