# Assets Section — Design Spec

**Date:** 2026-08-05 · **Status:** Draft (pending review)
**Scope:** Core asset registry — `assets` + make/model catalog + aliases, a new global `notes` table, client-scoped visibility, Assets + Makes/Models pages, nav changes (new **Assets** and **Admin** sections), global-search and command-palette registration.
**Out of scope (deferred, designed-for):** bulk import, containers, RFID scan surfaces, damage-report workflow, the Admin "Lookups" editor page, per-page search helpers.

## Background — what we are replacing

Legacy BaseCamp V2 (`/Volumes/Extreme SSD/Code Backups/BaseCamp V2`, DB dump
`server-prep/backups/SS-DB_Backup_20251217_172922.sql` — 10,388 assets, 395 make/models)
has a full Assets feature we are re-building, not porting:

- `assets` — serial_number, name, rfid_tag, make_model FK, free-text `location`, `status` FK to shared `status_options`, `damage` bool, `notes` bool, client FK, has_rails, site FK, last_seen_at.
- `assets_make_model` — make, model, weight (text, unit unspecified), ru_size (text), dimensions (text, e.g. `32x1.5x18.5`), mount_type, rail_type, knowledge (tips & tricks), `device_catagory` (sic).
- `assets_make_model_fuzzy` — alias strings for matching scans/imports to catalog rows.
- Polymorphic `notes` table; images via `image_associations`; container and move junction tables reference assets.
- Pages: Assets list, AssetDetail, EditAsset, MakeModel/MakeModelDetail/EditMakeModel/NewMakeModel, BulkUpdateAssets, ClientAssetLookup.

Problems this design deliberately fixes:

- `damage` bool pointed at a stub table containing only an `id` column — a hand-maintained flag with no workflow behind it.
- `notes` bool was an "are there notes" existence flag that could drift.
- Weight/RU/dimensions stored as unvalidated text ("Note the measurement unit" as a column comment).
- Free-text `location` alongside a site FK, with no convention.
- `ClientAssetLookup` was a special-cased page instead of row-level scoping.

## Decisions (from brainstorm)

1. **V1 is the core registry only.** List/detail/create/edit for assets and the catalog. No bulk import, containers, or RFID surfaces yet — but fields they need (`rfid_tag`, `last_seen_at`, `legacy_id`) exist from day one.
2. **Client-scoped visibility from day one.** Client org roles (owner/admin/viewer) see their own org's assets read-only, via the standard resolver + `scope_conditions()` machinery. Staff see everything.
3. **Location = site FK + free text.** `site_id` (nullable FK) plus `location_detail` text ("Hall B, Rack 14, RU 22", "Truck 3"). Structured rack/RU modeling can arrive later without rework.
4. **Damage flag dropped; damage reports are the designed follow-on.** Future `damage_reports` table: asset_id, description, reported_by/at, workflow status via `status_values`, photos as attachments on the report. "Asset is damaged" becomes *derived* (has an open report), never a manually toggled bool. Interim: a `status_values` entry (e.g. "Damaged – pending review") if crews need a signal before the workflow ships.
5. **Notes become a real global feature now.** New polymorphic `notes` table (attachments-style `entity_type`/`entity_id`), surfaced with attachments in one **Notes & Files** panel on asset detail — the old portal's "document, image, or note" panel, rebuilt. Other sections can adopt the panel later.
6. **Dual-unit weight and dimensions.** Enter either unit system; the server computes the partner. Both stored — exports/sorts/filters never convert at runtime.
7. **Serial numbers are indexed but NOT unique.** Legacy data has dupes and test junk; the UI warns on duplicate serial instead of the DB rejecting.
8. **`rfid_tag` IS unique where present** (partial unique index) — two assets can't share a live tag.
9. **Makes/Models management lives in a new Admin nav section** (above System). Jimmy also designated Admin as the future home of a **Lookups** editor page (site types/statuses, worker levels, asset statuses, device categories — APIs exist, UI deferred). **Open reconciliation, not blocking V1:** the god-mode Variables page (`/dev/database/variables`) already edits raw vocabulary, under the standing rule "changing what values EXIST is developer-only." When the Lookups page gets designed, decide whether it supersedes that rule or becomes a curated staff-facing subset with Variables remaining the developer escape hatch. Asset statuses in V1 follow the current rule (edited via Variables, god-only).
10. **Everything registers in global search and the ⌘K palette** — standing rule for all new sections, recorded here because Assets is the first section landing after it was made explicit.

## 1. Data model — migration 0014

**`asset_categories`** (editable lookup, mirrors `site_types`):
`key` text PK, `label` text NOT NULL, `description` text NOT NULL default `''`, `sort_order` int NOT NULL default 0, `updated_at`.
Seed: `server`, `storage`, `network`, `power`, `other` (legacy `device_catagory` values, typo retired).

**`status_values`** seed rows, `record_type = 'asset'` (same pattern as sites/workers):
`active` (c-green), `in_transit` (c-aqua), `in_storage` (c-slate), `decommissioned` (c-red), `unknown` (c-amber). Exact set editable post-launch. Note: legacy `status_options` rows for `association_type = 'Assets'` (Pre-Stage, Racked, Labeled, Pack/Logistics, On Truck, Received, QA, Complete, …) are **move-pipeline stages**, not registry lifecycle states — they belong to the future activities/moves workflow (asset lines will carry their own stage), so V1 deliberately seeds a simple lifecycle set instead of porting them.

**`asset_models`** (the catalog; legacy `assets_make_model`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `make` | CITEXT NOT NULL | "Dell", "HP" |
| `model` | CITEXT NOT NULL | unique together with `make` |
| `category` | text FK `asset_categories.key` | nullable |
| `ru_size` | integer | nullable (legacy text) |
| `weight_lbs` | numeric(8,2) | nullable; dual-unit pair |
| `weight_kg` | numeric(8,2) | nullable; dual-unit pair |
| `length_in`, `width_in`, `height_in` | numeric(8,2) | nullable; dual-unit trio |
| `length_cm`, `width_cm`, `height_cm` | numeric(8,2) | nullable; dual-unit trio |
| `mount_type` | text | vocabulary: `rails`, `ears`, `shelf`, `custom`; nullable |
| `rail_type` | text | free text ("Dell B7", "A15") |
| `knowledge` | text NOT NULL default `''` | field-crew tips & tricks |
| `legacy_id` | bigint | nullable, import mapping |
| `created_at`, `updated_at` | timestamptz NOT NULL | `now()` |

Constraint: `asset_models_make_model_key` UNIQUE (make, model).
Check constraints (each unit pair all-or-nothing is NOT enforced — a lone lbs value is fine because the server always fills the partner; see §2).

**`asset_model_aliases`** (legacy `assets_make_model_fuzzy`):
`id` uuid PK, `model_id` uuid FK `asset_models.id` ON DELETE CASCADE, `alias` CITEXT NOT NULL UNIQUE, `created_at`.
Global-unique alias: an alias resolves to exactly one model.

**`assets`**:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `serial_number` | CITEXT | nullable, indexed, **not unique** (UI warns) |
| `name` | CITEXT | nullable — hostname/label |
| `rfid_tag` | CITEXT | nullable; partial UNIQUE index `WHERE rfid_tag IS NOT NULL` |
| `model_id` | uuid FK `asset_models.id` | nullable |
| `client_id` | uuid FK `clients.id` | nullable (house gear); drives client scoping |
| `site_id` | uuid FK `sites.id` | nullable |
| `location_detail` | text NOT NULL default `''` | free text within/beyond the site |
| `status_record_type` | text NOT NULL default `'asset'` | composite-FK pattern shared with sites/workers |
| `status` | text NOT NULL | FK `(status_record_type, status)` → `status_values`; default `unknown` |
| `has_rails` | boolean | nullable = unknown; whether *this unit's* rails are present |
| `last_seen_at` | timestamptz | nullable; written by future scan surfaces |
| `legacy_id` | bigint | nullable, import mapping |
| `source`, `source_ref` | text | V3 convention, `source` default `manual` |
| `created_by` | uuid FK `people.id` | |
| `archived_at` | timestamptz | soft archive like sites |
| `created_at`, `updated_at` | timestamptz NOT NULL | `now()` |

Indexes: `assets_serial_idx` (serial_number), `assets_client_idx` (client_id), `assets_site_idx` (site_id), `assets_model_idx` (model_id).

**`notes`** (new, global):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `entity_type` | text NOT NULL | e.g. `asset` — same vocabulary as attachments |
| `entity_id` | uuid NOT NULL | |
| `body` | text NOT NULL | |
| `created_by` | uuid FK `people.id` | nullable (system notes) |
| `updated_by` | uuid FK `people.id` | nullable |
| `deleted_at` | timestamptz | soft delete, matches attachments |
| `created_at`, `updated_at` | timestamptz NOT NULL | `now()` |

Index: `notes_entity_idx` (entity_type, entity_id, created_at).

Dropped from legacy on purpose: `damage` (Decision 4), `notes` bool (Decision 5), free-text `location` (Decision 3), `assets.status` → shared `status_options` (replaced by `status_values`).

## 2. Unit conversion rules (server-side, one place)

- Factors: `1 lb = 0.453592 kg`, `1 in = 2.54 cm`. Round to 2 decimals.
- On create/update the payload may carry either side of a pair (or both). If exactly one side is present, the server computes the partner. If both are present, they are stored as sent (caller is authoritative — this is what import will use).
- On edit, the side the user *changed* wins and recomputes its partner (the portal sends only the changed side plus its recomputed partner; the API applies the same rule regardless).
- Dimensions travel as three numbers per unit system. The portal offers an `L x W x H` single-input that parses `32 x 1.5 x 18.5` (separators: `x`, `×`, comma) into the trio, plus per-field inputs.
- Weight/dimension fields accept null (unknown) — clearing one side clears the pair.

## 3. Access control

New resources in the code-side registry (`access/resources.py`):

- **`assets`** — `visible_to` includes global roles **and client org roles**. Row scoping: non-global client-anchored actors see rows where `assets.client_id` belongs to their org (via `scope_conditions()`); client tiers are read-only (no add/change/remove grants). Staff ranks per the standard matrix.
- **`asset_models`** — internal-only resource (catalog + knowledge is house IP). Client users never hit the catalog endpoints; asset payloads **embed** a read-only model summary (make, model, category, ru_size) so their asset lists still render fully.

Notes and attachments on an asset inherit the asset's visibility; note create/edit stays internal-only in V1 (clients read, staff write — matching read-only client tiers).

All mutations `require_permission()` + `audit_log` rides the mutation transaction (existing conventions).

## 4. API

`/assets` router:
- `GET /assets` — list; filters: search (serial/name/rfid), client_id, site_id, status, category, model_id, archived. Embeds model summary + client/site names. No pagination (no V3 list paginates yet).
- `POST /assets` · `GET /assets/{id}` · `PATCH /assets/{id}` — standard; PATCH rejects `status_record_type`. Duplicate-serial check endpoint or list-filter reuse for the UI warning.
- Archive/unarchive via PATCH `archived_at` (sites precedent).

`/asset-models` router (internal-only):
- `GET /asset-models` — list; filters: search (make/model/alias), category, mount_type.
- `POST /asset-models` · `GET /asset-models/{id}` · `PATCH /asset-models/{id}`.
- Alias management: `PUT /asset-models/{id}/aliases` replaces the alias list atomically (409 on alias owned by another model).
- Delete: **not offered** (10k assets reference models; archived/merge tooling is future work).

`/notes` router (generic from day one):
- `GET /notes?entity_type=asset&entity_id=…` · `POST /notes` · `PATCH /notes/{id}` · `DELETE /notes/{id}` (soft).
- Permission derives from the *host entity's* resource (an `entity_type → resource` map in code; only `asset` registered in V1).

Unit conversion (§2) implemented once in the asset-models service layer.

## 5. Portal

**Nav** (`navSections.tsx`) — final order:
**Assets** (new, above Operations): *Assets* → `/assets`, resource `assets`.
Operations · People · Stakeholders · **Admin** (new, above System): *Makes / Models* → `/admin/asset-models`, resource `asset_models`. · System · Developer.

**Assets page** (`/assets`) — standard list pattern (shared toolbar: Filters/Columns/Export via `listTools.tsx`):
- Columns: Serial, Name, Make/Model, Category, Client, Site, Status (colored per status_values), RU, Last seen. Default visible set kept tight; the rest behind Columns.
- Row expansion: read-only detail (all fields, model summary incl. knowledge, **Notes & Files panel**) with a single **Edit** button opening the edit modal ([[expand-read-edit-modal]] rule).
- New-asset modal from the toolbar: serial (with inline duplicate warning on blur), name, model (type-to-filter ComboBox searching make/model/alias), client, site, location_detail, status, has_rails, rfid_tag.
- Client-scoped users get the same page, rows pre-scoped, no mutation affordances.

**Makes / Models page** (`/admin/asset-models`) — same list pattern:
- Columns: Make, Model, Category, RU, Weight (both units), Dimensions (both units), Mount, Rail type, Alias count.
- Expansion: read-only display with **knowledge** rendered prominently + alias chips; Edit button → modal (all fields; dual-unit weight/dimension inputs per §2; alias editor add/remove).
- New-model form in a modal from the toolbar.

**Notes & Files panel** (new shared component): merged chronological list of notes and attachments for an entity; add-note inline composer; file upload via the existing attachments flow; note edit/delete for staff. Built generic (`entityType`, `entityId` props), shipped on asset expansion first.

**Global search + palette (Decision 10):**
- `search.py` gains sections: `asset` (matches serial_number, name, rfid_tag; resource `assets` — client scoping applies to search results too) and `asset_model` (matches make, model, alias; resource `asset_models`).
- ⌘K palette: verify nav-derived commands pick up the two new pages; add explicit entries if the palette's command list is static.

**Standing UI rules honored:** list toolbar controls, type-to-filter dropdowns, no card grids, expand-read-edit-modal, no test records in the dev DB.

## 6. Testing

- API: pytest coverage for CRUD both routers, unit-conversion rules (each direction, both-present, clearing), alias uniqueness 409, client-scoped list/search filtering (client A cannot see client B's assets; model summary embedded while `/asset-models` 403s), notes permission derivation, audit rows on mutations, PATCH rejection of `status_record_type`.
- Portal: build + `npm test` for nav/search registration (mirroring `godmode.test.ts` NAV_SECTIONS assertions); list pages verified by build + browser preview (no component-test infra yet — known gap).
- Migration 0014 up/down clean on an empty DB and on the current dev DB.

## 7. Future / deferred (recorded, not designed here)

- **Bulk import** of the 10,388 legacy assets + 395 models (legacy_id mapping exists; unparseable legacy dimension text appends to `knowledge` rather than silently dropping).
- **Damage reports workflow** (Decision 4 shape).
- **Containers**, **RFID scan surfaces** (fields already present).
- **Admin → Lookups page** for all editable vocabularies (site types/statuses, worker levels, asset statuses, asset categories).
- **Search helpers** — per-page hint text/descriptors that influence search options (Jimmy's idea, 2026-08-05; revisit after Assets ships).
- **Model merge/archive tooling** (needed before catalog delete is ever offered).
