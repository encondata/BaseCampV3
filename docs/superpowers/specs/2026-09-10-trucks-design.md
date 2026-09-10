# Trucks / Shipments — list, map, and full details (V2 parity)

**Date:** 2026-09-10
**Branch:** `trucks` off `reports` (worktree; fast-forwards into `reports`)
**Status:** Approved design

## Purpose

Replace the Logistics → Trucks / Shipments placeholder with a working
feature cloned from BaseCamp V2's Trucks page: a map of every active truck
at its latest reported position (with breadcrumb trails), the truck list in
the portal's standard directory-list design, a full-details page per truck
(drivers, load, tracking, route, the truck's own trail map, location
updates, containers on the truck, notes & files), and a location-update
endpoint a tracker or kiosk can post to. Two sample trucks are seeded in
dev so the map and trails have something to show.

## V2 reference (portal-v4 `Trucks.jsx` / `TruckDetail.jsx`, `portal_routes.py`)

- `trucks`: truck_name, driver_name, co_driver_name, team_drive, contact_info,
  truck_status (→ status_options 'Trucks': Created, Active, In Transit,
  At-Destination, In-Active, Historical), load_number, assigned_move,
  containers_on_truck JSONB (container ids), tracking_type JSONB
  `{type, update_type: 'API'|…, tracker_id}`, seal_id, start_site, end_site;
  two unused placeholder columns (dropped here).
- `trucks_updates`: truck_id, update_timestamp, update_location ("lat, lng"
  text), approximate_address.
- List: name / status / driver / load # / seal / move / start / end; search
  across those; sort; "show historical" toggle; auto-refresh.
- Map (`/trucks/map-data`): non-historical trucks with a parseable latest
  location; status-colored markers; `/trucks/map-trails` = each truck's
  update coordinates for a polyline; trails toggle; fullscreen.
- Detail: header + status + team-drive chip; load/seal; drivers; tracking
  type/update type/tracker id; start/end site links; map with a marker per
  update + latest; updates table; containers on truck w/ status; notes &
  files; clear updates.
- Dump: 15 V2 trucks (Historical, move 13), 0 updates — NOT imported now;
  `legacy_id` keeps the door open.

## Data (migration 0049)

```
trucks
  id uuid pk, legacy_id bigint null unique,
  name citext not null, driver_name text, co_driver_name text,
  team_drive bool not null default false, contact_info text not null default '',
  status text not null default 'created'  (FK status_values 'truck' vocab via the
     same GENERATED status_record_type pattern the other status tables use),
  load_number text, seal_id varchar(24),
  tracking_type jsonb not null default '{}'  ({"type","update_type","tracker_id"}),
  initiative_id uuid null FK initiatives(id) on delete set null,   -- V2 assigned_move
  start_site_id uuid null FK sites(id) on delete set null,
  end_site_id uuid null FK sites(id) on delete set null,
  created_by uuid null FK people(id), created_at, updated_at, archived_at null
truck_containers (truck_id FK cascade, container_id FK cascade, added_at) pk(truck_id, container_id)
truck_updates
  id uuid pk, truck_id FK cascade, recorded_at timestamptz not null,
  location text not null (V2's raw "lat, lng"), lat double null, lng double null (parsed),
  approximate_address text not null default '', source text not null default 'manual'
  index (truck_id, recorded_at desc)
```

Status vocabulary: `status/registry.py` gains `StatusRecordType("truck",
"Truck", sources=(("trucks","status"),), resource="trucks")`; migration
seeds record_type `truck`: created (#51606f), active (#178a4c), in_transit
(#0f7c86), at_destination (#1668a7), inactive (#a36207), historical
(#6d4fc4). "On the map" = status ≠ historical (V2 rule).

Access: new resource `trucks` (`access/resources.py`, routes
`/logistics/trucks`), grants like containers (developer/founder/super_admin/
admin FULL; staff FULL; client roles none). Notes host `truck` in
`NOTE_HOSTS` (routes/notes.py) + attachments grants follow the host.

## API (`routes/trucks.py`, prefix `/trucks`)

- `GET /trucks?include_archived=` → `TruckItem[]`: all columns + `status_label/
  status_color`, `initiative_name`, `start_site_name`, `end_site_name`,
  `container_count`, `last_update` {recorded_at, lat, lng, approximate_address}
  | null. Sorted name asc.
- `POST /trucks` (`TruckCreateIn`: name required; every other column
  optional; `container_ids: uuid[]`) → 201 `TruckItem`. `PATCH /trucks/{id}`
  (`TruckUpdateIn`, all optional, `extra="forbid"`, exclude_unset; status
  validated against the truck vocab → 422 `unknown_status`; sites/
  initiative existence → 404 `site_not_found`/`initiative_not_found`;
  `container_ids` replaces the link set). `DELETE /trucks/{id}` → archive
  (`archived_at`), 204. Audit `entity_type="truck"`.
- `GET /trucks/{id}` → `TruckDetail` = `TruckItem` + `containers[]`
  ({id, name, status_label, status_color, asset_count}).
- `GET /trucks/map?trails=true|false` → `[{id, name, status, status_label,
  status_color, driver_name, load_number, seal_id, last_update, trail:
  [{recorded_at, lat, lng}] (when trails)}]` for non-archived, non-
  historical trucks that have ≥1 update with parsed coordinates.
- `GET /trucks/{id}/updates` → newest first. `POST /trucks/{id}/updates`
  (`{location: "lat, lng" | {lat, lng}, approximate_address?, recorded_at?,
  source?}`) parses coordinates (lat −90..90, lng −180..180 else 422
  `invalid_location`), 201. `DELETE /trucks/{id}/updates` clears them
  (audit `updates_cleared`). All gated `trucks:view` / `trucks:change`.

## Portal

- `lib/api.ts`: `TruckItem`, `TruckDetail`, `TruckUpdate`, `TruckMapPoint`,
  `listTrucks`, `getTruck`, `createTruck`, `updateTruck`, `archiveTruck`,
  `listTruckUpdates`, `addTruckUpdate`, `clearTruckUpdates`, `getTrucksMap`.
- `lib/trucks.ts`: `truckSearchText`, `truckCellText`, `TRUCK_ERRORS`,
  `parseLocation`, `formFromTruck`/`truckPayload`, `TRUCK_GOD_FIELDS`.
- `pages/Trucks.tsx` (`/logistics/trucks`, page key `trucks`): page-hint +
  toolbar (filter box, "Show historical" toggle, Refresh-timer
  `REFRESH_OPTIONS` copied verbatim from MoveDashboard, Columns, Export,
  "+ New truck"). **Map panel** (`components/trucks/TrucksMap.tsx`,
  react-leaflet on `mapTiles.ts` tiles): a status-colored `CircleMarker`
  per mapped truck at its latest position, tooltip name · status ·
  address · age; "Trails" toggle draws each truck's polyline; "Fullscreen"
  opens the same map in a modal; markers follow the list's current filter
  (V2 behavior); empty state "No trucks are reporting a location." Then
  the **standard directory list** (`dir-list` / `list-head` / `row-main` +
  golden cell classes, `usePersistentListState`, `ColumnMenu`, row
  expansion with a `kv` summary + "Full details" + Edit/Archive via
  `RowActionsMenu`). Columns: Truck (primary: name + load #), Status
  (chip), Driver(s), Seal (mono), Move, From → To, Last update (mono, age),
  Containers (count). Row-detail and the list obey the list-typography
  rule; no page CSS typography.
- `pages/TruckDetail.tsx` (`/logistics/trucks/:id`): `profile-hero` chrome
  (name, status chip, team-drive chip, load # / seal mono, Edit button);
  sections: Drivers & contact; Tracking (type / update type / tracker id);
  Route (start → end site links to `/sites/...`, assigned move link);
  **Trail map** (marker per update, latest highlighted, polyline);
  Location updates (`DataTable`: when / location mono / address / source)
  with "Add update" (manual form: location + address) and "Clear updates"
  (confirm); Containers on truck (mini list, name → container, status
  chip, asset count); Notes & Files (`NotesFilesPanel` host `truck`).
- `components/trucks/TruckEditModal.tsx`: pf-form (name, drivers, team
  drive, contact, status ComboBox from the `truck` vocab, load #, seal,
  tracking type/update type/tracker id, move ComboBox, start/end site
  ComboBoxes, containers multi-picker).
- Nav: the Logistics item's resource → `trucks`; CommandPalette entry.
  Home's TransitMap badge unchanged (live tracking later).

## Seed

CLI `serversherpa seed-demo-trucks` (idempotent, keyed on name): "Demo
Truck 1" (in_transit, ACC4 → DA11, driver + co-driver team drive, 6 updates
along I-95 over the last day) and "Demo Truck 2" (at_destination, 3
updates), each with `tracking_type {type:'gps', update_type:'API',
tracker_id}`; attached to NAP11 Hall Migration (demo) when present.

## Testing

API: model/migration (truck vocab seeded, GENERATED status column, FK
cascades), CRUD + validation + audit, map endpoint (historical excluded,
unparsable updates excluded, trails), updates post/parse/clear, notes host,
grants (staff can, client role 403), seed command idempotent. Portal: lib
helpers, Trucks page (list renders, filter, historical toggle, map markers
follow filter — react-leaflet mocked like SitesMap tests), TruckDetail
(sections, add/clear updates), edit modal payload, guardrail (list
typography) green. Live: seed → list + map on 5174, detail trail map, add
an update and watch the marker move.

## Out of scope

V2 truck import (legacy_id ready), tracker/kiosk clients, geocoding
addresses, container assignment from the container side, Home live map.
