# Logistics Section (Containers + Trucks) — Design Spec

**Date:** 2026-08-05 · **Status:** Draft (pending review)
**Scope:** New **Logistics** nav group with Containers and Trucks — data model, API route modules, list/detail/edit pages following the Assets pattern, portal-managed container contents, truck GPS schema + ingest endpoint + live map, and per-list bulk CSV/XLSX import.
**Out of scope (deferred, designed-for):** Moves and any move-assignment fields, container labels/printing (future Labels section), packing manifests, kiosk/iOS scan surfaces, tracking-provider ingest bridges (Macropoint/Copeland/Tive), site sub-locations table.

## Background — what we are replacing

Legacy BaseCamp V2 (`/Volumes/Extreme SSD/Code Backups/BaseCamp V2/portal-v2`, FastAPI backend in `../api`) has a Logistics sidebar section with two domains:

- `containers` — container_name, free-text container_type, container_rfid, status FK to shared `status_options` (`association_type='Containers'`), site FK + `sites_locations` FK, move FK, truck FK, denormalized `container_device_count`, last_audit/audit_by/last_validated. Asset membership lives in a `containers_assets_list` join table (container_id, asset_id, added_at, added_by, last_validation) — populated only by kiosk/iOS scanning, never the portal.
- `trucks` — truck_name, driver_name, co_driver_name, team_drive bool, contact_info, status FK (`association_type='Trucks'`), load_number, seal_id, `tracking_type` JSONB (`{type, update_type, tracker_id}` with hardcoded providers Macropoint/Copeland/Tive), assigned_move FK, start_site/end_site FKs, two unused placeholder columns. Location history in `trucks_updates` with coordinates stored as a raw `"lat, lng"` text string parsed at read time.
- Pages: Containers list/detail/new/edit, Trucks list/detail/new/edit (with live react-leaflet map, trails, fullscreen 2-min auto-refresh), BulkAddContainers, BulkAddTrucks, ContainerLabels.

Problems this design deliberately fixes:

- Coordinates as parse-at-read text → real `latitude`/`longitude` numeric columns.
- Denormalized `container_device_count` recomputed by hand after every membership write → computed `COUNT` in queries.
- Free-text container_type and page-hardcoded tracking providers → Variables-page vocabularies.
- Container membership had no uniqueness constraint (an asset could be in two containers) → UNIQUE on `asset_id`.
- Status id 48 ("Assigned to Truck") hardcoded in the backend to swap a container's displayed location for the truck name → truck assignment is its own field, no magic status behavior.
- V2 bulk-upload default-site/default-move form params were silently dropped due to frontend/backend name mismatches → no hidden defaults at all; every value comes from the file and unresolvable values are per-row errors.
- `tracking_type` JSONB blob → three plain columns (`tracking_provider`, `tracking_update_type`, `tracker_id`), queryable and filterable.

## Decisions (from brainstorm)

1. **All four pieces in scope:** Containers core, Trucks core, truck GPS map + location history, bulk CSV/XLSX import.
2. **Approach A — two vertical slices.** Containers end-to-end first (migration → API → portal → import), then Trucks (which adds the GPS table, ingest endpoint, and map). Each slice lands working and testable.
3. **GPS is schema + API only.** A `POST /trucks/{id}/location-updates` endpoint is the sole data source; provider ingest bridges are a later project. Map empty states say "No location data yet" plainly.
4. **Container location = site FK + free text** (`site_id` + `location_detail`), exactly matching the V3 Asset pattern. No `site_locations` table now; it can be introduced later without rework.
5. **Portal manages container contents.** Unlike V2 (scan-only), container detail gets Add Assets (multi-select ComboBox) and per-row Remove. Membership keeps `added_at`/`added_by` so scan surfaces can share the same table later.
6. **Four new vocabularies**, all Variables-page editable via the status registry: `container` (status), `container_type`, `truck` (status), `tracking_provider`.
7. **Membership is a join table, not `assets.container_id`** — preserves who/when metadata, leaves the Asset table untouched, and the UNIQUE(asset_id) constraint enforces one-container-per-asset.
8. **No move fields anywhere yet.** `containers.truck_id` stays (trucks exist in this build); `move_id`/`assigned_move` arrive with the future Moves section as additive migrations.
9. **No stat cards** on the lists — the V3 list pattern (toolbar + column menus) doesn't include them; consistency wins over V2 fidelity.
10. **Bulk import lives on each list's toolbar** (Import next to Export), not a separate Bulk Actions section.

## 1. Data model — migrations 0015 (containers) and 0016 (trucks)

Ordering note: `containers.truck_id` references `trucks`, but Containers ships first — so `truck_id` is **added in 0016**, not 0015. The containers API/UI simply has no truck column until the Trucks slice lands.

**`containers`** (0015):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `name` | CITEXT NOT NULL | indexed |
| `rfid_tag` | CITEXT | nullable; partial unique index where not null (same rule as assets) |
| `container_type` | text | nullable; vocabulary key, `record_type='container_type'` |
| `status` | text NOT NULL default `'available'` | vocabulary key, `record_type='container'` |
| `site_id` | uuid FK `sites.id` | nullable |
| `location_detail` | text NOT NULL default `''` | free text, matches assets |
| `last_audit_at` | timestamptz | nullable; written by future scan surfaces |
| `audit_by` | uuid FK `people.id` | nullable |
| `last_validated_at` | timestamptz | nullable |
| `legacy_id` | bigint | nullable; for migrating V2 rows |
| `source`, `source_ref`, `created_by`, `archived_at`, `created_at`, `updated_at` | | standard V3 audit/source columns |

**`container_assets`** (0015):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `container_id` | uuid FK `containers.id` ON DELETE CASCADE | |
| `asset_id` | uuid FK `assets.id` | **UNIQUE** — one container per asset |
| `added_at` | timestamptz default now() | |
| `added_by` | uuid FK `people.id` | nullable |
| `last_validated_at` | timestamptz | nullable; for future scan validation |

**`trucks`** (0016):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | CITEXT NOT NULL | indexed |
| `driver_name`, `co_driver_name` | text | nullable |
| `team_drive` | boolean NOT NULL default false | |
| `contact_info` | text | nullable; phone or email, free-form like V2 |
| `status` | text NOT NULL default `'created'` | vocabulary key, `record_type='truck'` |
| `load_number` | text | nullable |
| `seal_id` | text | nullable; max length 24 enforced in API + UI |
| `tracking_provider` | text | nullable; vocabulary key, `record_type='tracking_provider'` |
| `tracking_update_type` | text | nullable; `'api'` or `'email'`, checked in API |
| `tracker_id` | text | nullable |
| `start_site_id`, `end_site_id` | uuid FK `sites.id` | nullable |
| `legacy_id` | bigint | nullable |
| `source`, `source_ref`, `created_by`, `archived_at`, `created_at`, `updated_at` | | standard columns |

Also in 0016: `ALTER TABLE containers ADD COLUMN truck_id uuid REFERENCES trucks(id)` (nullable; SET NULL on truck delete).

**`truck_location_updates`** (0016):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `truck_id` | uuid FK `trucks.id` ON DELETE CASCADE | indexed with `recorded_at` |
| `recorded_at` | timestamptz NOT NULL default now() | |
| `latitude` | numeric(9,6) NOT NULL | range-checked in API |
| `longitude` | numeric(9,6) NOT NULL | |
| `approximate_address` | text | nullable |

**Status registry** (`status/registry.py`) gains four record types:

- `container` → table `containers`, column `status`, resource `containers`
- `container_type` → table `containers`, column `container_type`, resource `containers`
- `truck` → table `trucks`, column `status`, resource `trucks`
- `tracking_provider` → table `trucks`, column `tracking_provider`, resource `trucks`

**Vocabulary seeds** (colors use existing theme tokens per the vocabulary-colors rules):

- `container` status: `available`, `packed`, `assigned_to_truck`, `in_transit`, `historical`
- `container_type`: `pelican_case`, `shipping_container`, `cart`
- `truck` status: `created`, `active`, `historical`
- `tracking_provider`: `macropoint`, `copeland`, `tive`

Deliberate drops from V2: `containers_manifest` (belongs to a future packing feature), `container_device_count`, trucks `placeholder1/2`, the status-48 location swap, and portal-invisible `PATCH truck_id` write paths (truck assignment will be explicit in the V3 UI).

## 2. API

Two new route modules mirroring `assets.py` conventions: session auth, permission gates, structured error keys, audit logging with field diffs on writes, soft-delete via `archived_at`.

**`api/routes/containers.py`** → `/containers` (resource `containers`):

- `GET /containers` — standard list contract (filter/search/sort/pagination as Assets). Rows include site name, vocabulary label+color for status/type, computed `asset_count`, and (post-0016) truck id+name. Filterable by `truck_id`, `site_id`, `status`, `container_type`.
- `POST /containers` · `GET /containers/{id}` · `PATCH /containers/{id}` · archive/unarchive matching the Assets routes.
- `GET /containers/{id}/assets` — membership joined to asset serial/name/model/status.
- `POST /containers/{id}/assets` — body `{asset_ids: [...]}`; stamps `added_by` from session. If any asset is already in another container → 409 with `{asset_id, container_id, container_name}` per conflict so the UI can say where it is. No partial writes: the batch is all-or-nothing.
- `DELETE /containers/{id}/assets/{asset_id}` — remove one.
- `POST /containers/import` — bulk CSV (multipart); see §5.

**`api/routes/trucks.py`** → `/trucks` (resource `trucks`):

- `GET /trucks` — list rows include start/end site names, vocabulary labels, container count, latest location update (coords + recorded_at) when one exists.
- `POST /trucks` · `GET /trucks/{id}` · `PATCH /trucks/{id}` · archive/unarchive. Validation: `seal_id` ≤ 24 chars; `tracking_update_type`/`tracker_id` only meaningful when `tracking_provider` set (clearing the provider clears all three).
- `GET /trucks/{id}/location-updates` — newest first.
- `POST /trucks/{id}/location-updates` — the ingest endpoint. Body `{latitude, longitude, recorded_at?, approximate_address?}`; latitude ∈ [-90, 90], longitude ∈ [-180, 180]; `recorded_at` defaults to now. Authenticated like every other route; a future provider bridge is just another API client.
- `DELETE /trucks/{id}/location-updates` — clear history (destructive; client confirms).
- `GET /trucks/map-data` — non-archived, non-historical trucks having ≥1 update: latest coordinate, recorded_at, name, status, seal/load for the tooltip.
- `GET /trucks/map-trails` — per-truck ordered coordinate arrays for the polyline overlay.
- `POST /trucks/import` — bulk CSV; see §5.

**Access control:** two new resources `containers` and `trucks` in `access/resources.py`, appearing in the Access page grid and gating nav + routes like every existing section. Both register in global search and the ⌘K command palette (standing rule for new sections).

## 3. Portal UI — core pages

New **Logistics** nav group between Assets and People: **Containers** (`/logistics/containers`), **Trucks** (`/logistics/trucks`).

Both pages are instances of the established V3 list pattern (Assets is the template):

- Shared table, column menus with Excel-style cross-filtered value scoping, persistent list prefs, toolbar with Filters + Columns + Export (+ Import, §5). Status/type render as colored vocabulary chips. Deep-link filters supported.
- **Containers columns:** Name, Type, RFID, Assets (count), Status, Site, Location, Truck (after slice 2), Updated.
- **Trucks columns:** Name (natural/alphanumeric sort), Driver, Status, Load Number, Seal ID (monospace), Start Site, End Site, Containers (count), Last Update, Updated.
- Row expansion is read-only display; all edits behind an Edit button opening the modal (house rule).
- Edit modals: every record-backed dropdown is the shared ComboBox with type-to-filter (site pickers, vocabulary pickers). Truck form: `tracking_update_type` and `tracker_id` disabled until a provider is chosen; clearing the provider clears them. Seal ID maxLength 24.
- **Container detail:** fields + contained-assets table (sortable, searchable, rows link to the asset). **Add Assets** opens a multi-select asset ComboBox — assets already in another container are selectable but produce the 409 message naming that container; per-row **Remove** with confirm. Notes/attachments via the existing `NotesFilesPanel`.
- **Truck detail:** grouped fields (Basic / Driver / Tracking / Route with site links), containers-on-this-truck table (rows link to container detail; this is where a container's `truck_id` gets assigned/cleared), location history (§4), `NotesFilesPanel`.

## 4. GPS map

Library: **react-leaflet + OSM tiles** (new portal dependency; no API keys).

**Trucks list map** — collapsible panel over the table:

- Markers for every non-historical, non-archived truck with a fix; color by update age (fresh/stale/old); permanent name tooltips; auto fit-to-bounds.
- The list's filter state for historical trucks applies to the map — one filter, both views.
- Fullscreen dialog adds a **Show Trails** toggle (per-truck colored polylines from `map-trails`) and auto-refresh every 2 minutes while open, with a last-refreshed indicator.
- Data from `map-data`/`map-trails`, not list rows.

**Truck detail — location history** (collapsible):

- Map: markers numbered in sequence, latest highlighted, dashed route polyline.
- Updates table: timestamp, coordinates (monospace), approximate address.
- **Clear History** → confirm dialog → `DELETE /trucks/{id}/location-updates`.

Empty state everywhere: "No location data yet" — expected until something posts to the ingest endpoint.

## 5. Bulk import

Import button on each list toolbar (visible to users with create permission). Modal flow: download template (CSV or XLSX) → upload → per-row created/error results table.

- **Containers template:** `name` (required), `container_type`, `rfid_tag`, `site_name`, `location_detail`, `status`.
- **Trucks template:** `name` (required), `driver_name`, `co_driver_name`, `team_drive` (true/false), `contact_info`, `load_number`, `seal_id`, `status`.
- Resolution is case-insensitive: `site_name` against sites; `container_type`/`status` against vocabulary labels **or** keys. Unresolvable values are per-row errors, never silent drops or hidden defaults.
- XLSX converted client-side (`xlsx` package, as V2 did); the API accepts CSV multipart only.
- Rows that fail validation don't block valid rows (per-row transaction semantics, matching V2's created/errors/details result shape).

## 6. Testing & error handling

**API (pytest, like existing route modules):** CRUD + archive round-trips for both domains; permission gates (403 without resource access); membership — add, batch-conflict 409 payload shape, uniqueness under concurrent adds, remove; seal-id length and tracking-field dependency validation; coordinate range validation and default `recorded_at` on the ingest endpoint; map-data excludes historical/archived/fixless trucks; bulk import row resolution (bad site name, bad vocab value, duplicate name behavior) and per-row error reporting.

**Portal:** verified against the dev server (portal components remain untestable per the known `lib/api.ts` module-scope-window issue; not addressed here). Manual pass covers: column menus + prefs on both lists, deep-link filters, edit modal validation, add/remove assets including the conflict message, map rendering with seeded updates posted via the API, import happy path + error rows.

**Error handling:** structured error keys as elsewhere; 409-with-context on membership conflicts; confirm dialogs on all destructive actions (archive, clear history, remove asset); vocabulary keys guarded exactly like assets (a stored key missing from the active vocabulary renders as its raw key, never crashes).

## Build order (Approach A)

1. **Slice 1 — Containers:** migration 0015 + registry entries + seeds → `containers.py` routes + tests → Containers list/detail/edit + membership UI → containers import.
2. **Slice 2 — Trucks:** migration 0016 (trucks, truck_location_updates, containers.truck_id) + registry + seeds → `trucks.py` routes + tests → Trucks list/detail/edit → GPS map (list + detail) → trucks import → truck column/assignment appears on Containers.
