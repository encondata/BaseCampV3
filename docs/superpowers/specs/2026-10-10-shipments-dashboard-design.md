# Shipment tracking dashboard — design

**Date:** 2026-10-10
**Tracker:** Dashboards › "Recent truck activity feed" (Feature Parity 9, Gaps line 24, Not built; To-Do #23). Related: "Live truck map" (Partial).
**Branch:** `shipments-dash`

## Goal

A new **Shipments** dashboard (`/dashboards/shipments`) for staff: an
auto-refreshing live map of trucks with their current-trip tracks, a feed of
truck and container updates, counts, and a per-truck table — V2's "Recent
truck updates", grown into a wall-screen view.

## Jimmy's decisions (2026-10-10)

- Its own dashboard with an auto-refreshing map of trucks and tracks.
- Feed: truck location updates, truck status changes, containers loaded /
  unloaded (not pack/unpack).
- All active trucks by default with a move filter; auto-refresh on at 30 s;
  paused while the tab is hidden.
- Tracks: the current trip only, capped at the latest 500 points per truck.

## Facts this builds on

- Positions are rows in `truck_updates` (`recorded_at`, `lat`, `lng`,
  `approximate_address`, `source`), written by `POST /trucks/{id}/updates`
  (manual) and the demo seed. No provider feed exists (separate Gaps row).
- Truck status changes are audited (`audit_log`, `entity_type='truck'`,
  `action='update'`, `changes.status {from,to}`); container loads/unloads are
  audited as `kiosk_truck_load` / `kiosk_truck_unload` on the truck (with
  container_id, container_name, asset_count) and via the truck PATCH /
  bulk import container changes (check how those are audited; include them
  if they are).
- Trucks and containers are global-only resources (`visible_to={"global"}`).
- `components/trucks/TrucksMap.tsx` already draws status-colored markers and
  trails and refits only when the set of trucks changes.

## Data — migration 0096

- `trucks.trip_started_at timestamptz NULL`.
  - Set to `now()` whenever a truck's status changes **into** `active` or
    `in_transit` from any status other than `active`/`in_transit` (so
    Active → In transit keeps the same trip). Applies to every status writer:
    the truck PATCH and the truck bulk import (and any other writer found).
  - Backfill: the time of the latest audit row for that truck whose
    `changes.status.to` is `active` or `in_transit` and whose `from` is
    neither; else the truck's `created_at` when its status is currently
    `active`/`in_transit`/`at_destination`; else NULL.
- Index `ix_truck_updates_recorded_at` on `truck_updates (recorded_at DESC)`.
- Index `ix_audit_log_entity_type_at` on `audit_log (entity_type, at DESC)`.

## API (`api/routes/trucks.py`, routes declared above `/{truck_id}`)

All gated by `trucks:view`.

- **`GET /trucks/map`** gains query params (existing callers unchanged):
  - `initiative_id` (optional) — only that move's trucks;
  - `statuses` (optional, repeatable) — e.g. `active,in_transit,at_destination`;
  - `trip=true` — trails limited to points with `recorded_at >=
    trip_started_at` (all points when `trip_started_at` is NULL), newest
    `TRAIL_POINT_CAP = 500` per truck, returned oldest→newest.
  - Trails fetched in one set-based query (window function / LATERAL), not
    per truck.
  - Each point adds `end_site` `{name, latitude, longitude}` when the truck
    has a destination site with coordinates (for the destination pin).
- **`GET /trucks/feed`** → `{events: [...], next_before: <iso or null>}`.
  - Params: `initiative_id` (optional), `limit` (default 50, max 200),
    `before` (ISO timestamp cursor; events strictly older).
  - Event kinds (`kind`): `location` (from `truck_updates`: address or
    "lat, lng", source), `status` (from truck `update` audit rows with a
    status change: from/to labels + colors, actor name), `load` / `unload`
    (from kiosk load/unload audit rows and any PATCH/bulk container change
    rows: container name, asset count, via `kiosk`/`portal`/`import`, actor).
  - Every event: `id` (stable string, e.g. `loc:<uuid>` / `audit:<id>`),
    `at`, `kind`, `truck_id`, `truck_name`, `load_number`, `initiative_id`,
    `initiative_name`, plus the kind's fields. Archived trucks' past events
    still appear; deleted trucks' audit rows are skipped.
  - Merged newest-first across the sources with set-based queries (each
    source limited to `limit` rows older than `before`, then merged and
    trimmed), no per-row lookups.
- **`GET /trucks/summary`** → `{in_transit, active, at_destination,
  containers_on_board}` (optional `initiative_id`), non-archived trucks.

## Portal

**Nav / routing:** "Shipments" under Dashboards (`/dashboards/shipments`,
resource `trucks`, after Move), `App.tsx` route under
`<ProtectedRoute resource="trucks">`, Topbar crumbs and command-palette
entry.

**Page** (`pages/ShipmentsDashboard.tsx`, dashboard idioms from
`styles/dashboard.css` — `dash-head`, `dash-ctrls`, `dash-asof`,
`dash-grid`/`dash-span-N`, `dash-panel`, `dash-kpis`):

- **Header:** title "Shipment tracking", Move picker (`ComboBox`, "All
  moves" + non-archived moves that have trucks), Refresh select (Off, 15 s,
  30 s, 60 s, 5 min; default 30 s), "updated {time}" stamp.
- **Refresh:** one `refreshAll` (`Promise.allSettled`, keeps last data on a
  failed tick); pauses while `document.hidden`; refreshes immediately when the
  tab becomes visible again (if refresh isn't Off). Move change refetches.
- **Counts:** In transit, Loading (Active), At destination, Containers on
  board.
- **Map** (full width, ~460 px; fullscreen button like the Trucks page):
  `TrucksMap` with trails on, data from `/trucks/map?trip=true&statuses=
  active,in_transit,at_destination[&initiative_id]`; destination pins
  (small hollow markers) per truck's `end_site`; `scrollWheelZoom` off until
  fullscreen; dark-theme tile filter like `.dash-sites-map`; the
  `.trucks-map-panel` stacking fix; empty state "No trucks with a recorded
  position yet. Add a location update on a truck to see it here." Clicking a
  truck opens `/logistics/trucks/:id`.
- **Update feed** (`mini-list` rows): icon by kind, truck name (link) +
  load number, the event text, relative time (`relativeTime`, full time on
  hover). Texts: location "{address} · {source}"; status "{from} → {to}"
  (chips) "by {actor}"; load "Loaded {container} ({n} assets) · {via}";
  unload "Unloaded {container} · {via}". "Show older" button uses
  `next_before`. On refresh, new events prepend without losing loaded older
  pages.
- **Trucks table** (standard list: `dir-list`/`ColHead`/`listGridStyle`
  with column floors, natural sort): Truck (link), Status chip, Load #,
  Route (origin → destination), Last location, Last update (age), Containers.
  Data from `/trucks` (filtered to non-archived, the three statuses, and the
  move).

**Main dashboard:** the in-transit map's "Live truck tracking · coming
soon" badge becomes a link "Live tracking →" to `/dashboards/shipments`
(shown only with `trucks:view`; otherwise no badge).

## Testing

API: migration (column, indexes, backfill cases); trip_started_at set/kept
rules on PATCH and bulk import; map params (move filter, statuses, trip
window, 500 cap, oldest→newest order, set-based — assert query count stays
flat as trucks grow, end_site); feed (each kind, merge order, cursor
paging without duplicates or gaps, move filter, limit cap, deleted-truck
audit rows skipped, archived trucks included); summary counts; all 403 for
non-staff.

Portal: nav entry and route gating; header controls; refresh interval and
hidden-tab pause/resume (fake timers + `visibilitychange`); move filter
refetch; counts; map props (trails, trip query); feed rows per kind, Show
older, prepend on refresh; trucks table; main-dashboard badge link.

## Out of scope

Automatic position feeds (Macropoint, Copeland, Tive), client-facing
shipment views, container pack/unpack events, alerts for stale trucks.
