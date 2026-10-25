# Raw scans: server-side paging — design

**Date:** 2026-10-25 · **Branch:** `raw-scans-paging`

## Problem

Scans › Raw scans (`portal/src/components/scans/RawScansTab.tsx`) loads every
row (`listRawScans({})` → `GET /scans/raw` with no limit; 100,302 rows on dev)
and sorts, filters and searches in the browser. It is the first of the big
lists to move to server-side paging; the shared pieces are built to be reused
for Assets and move rosters later.

## Jimmy's decisions (2026-10-25)

- Infinite scroll: the newest 100 show at once, the next 100 load as you near
  the bottom; no page numbers.
- Keep everything the list has today: search box, every column's filter menu
  (values from the server, not only loaded rows), sort on every column, the
  Columns menu and CSV export of everything that matches.
- Default view: newest first, all time.

## API (`api/src/serversherpa/api/routes/scans.py`; `GET /scans/raw` unchanged)

All gated by `scans:view`, like `GET /scans/raw`.

- **`GET /scans/raw/page`** → `{rows: RawScanItem[], next_cursor: str | null, total: int}`.
  - `sort` (a column key: `primary`, `scan_type`, `scanned`, `device`,
    `operator`, `site`, `location`, `source`, `ingested`, `status`; default
    `scanned`), `dir` (`asc`|`desc`, default `desc`), `limit` (default 100,
    max 500), `cursor` (opaque, from `next_cursor`).
  - `q`: search, case-insensitive substring over the same fields the search
    box covers today (scanned value, scan type label, status label, device,
    operator name, site name, location, source).
  - `filters`: JSON object `{colKey: {text?: str, values?: [str]}}` — the
    portal's `ColumnFilters`, unchanged, so saved filters keep working. Values
    are the **displayed text** (labels and names; `—` means empty); the server
    matches on the same text the column shows.
  - `since` / `until`: the Scanned date range.
  - Keyset paging: rows ordered by the sort expression then `id` (same
    direction); the cursor carries the last row's sort value and id, so pages
    never overlap or skip, even while scans arrive. A bad cursor → 422.
  - Sorting uses the displayed values (scan type/status labels, operator and
    site names) with the database's natural collation (`natural()` helper).
  - `total` = rows matching the same filters (all pages), returned on every
    page.
- **`GET /scans/raw/facets?column=<key>`** + the same `q`/`filters`/`since`/
  `until` minus that column's own filter → `[{value, count}]`: the column's
  distinct displayed values with counts, most frequent first, capped at 500,
  optional `search` to narrow the list (for the scanned-value column).
- **`GET /scans/raw/export`** + the same params → CSV (streamed) of every
  matching row in the current sort, the same columns as today's export.
- **Indexes (migration 0108):** whatever the sort/filter queries need to stay
  fast at 100k+ rows — at least `raw_scans (scanned_at DESC, id DESC)` and
  the per-column sorts the plan identifies by `EXPLAIN`. Target: the first
  page in under 300 ms on dev's 100k rows.

## Portal

- **Shared hook `lib/usePagedList.ts`:** given a fetch-page function, a
  facet function and the list's persisted state (from
  `usePersistentListState`, unchanged), it loads page 1 whenever sort,
  filters, search (debounced ~250 ms) or the date range change; keeps the
  current rows visible with a loading indicator while reloading; drops stale
  responses (sequence numbers); loads the next page when `VirtualRows` nears
  the end; exposes `rows`, `total`, `loading`, `error`, `loadMore`,
  `reload`.
- **`ColumnMenu`** gains an optional async values source (facets) used
  instead of computing values from `allRows`; existing callers unchanged.
- **Raw scans tab:** uses the hook and the paged endpoints; same columns,
  menus, Columns button, result count ("1,240 of 100,302 shown" from
  `total`), Export (server CSV, downloaded with the session's bearer token).
  Scanned's column menu gets a From / To date range (its displayed text is
  locale-formatted, so the server can't match it as text); Ingested keeps
  sort only.
- Loading / empty / error states as today's list.

## Testing

API: keyset paging over every sort key with no duplicates or gaps (incl.
rows inserted between pages and equal sort values), every filter kind
(values incl. `—`, text, date range), search, facets (counts, excluding the
column's own filter, cap, search), export (all matching, sort, CSV
injection-safe like today's export), bad cursor/sort/filters → 422,
`scans:view` gating, and a timing check of the first page on a 100k-row
table.

Portal: the hook (page 1 on each change, debounce, stale-response drop, load
more, rows kept while reloading, error), ColumnMenu async values, the tab
(result count, menus from facets, export call, saved prefs restored).

Live: the real tab against dev's 100k scans — time to first rows before and
after.
