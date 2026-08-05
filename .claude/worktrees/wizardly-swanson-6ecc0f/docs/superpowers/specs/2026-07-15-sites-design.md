# Sites — Design Spec

**Date:** 2026-07-15 · **Status:** Approved
**Scope:** Sites core (expanded schema), site survey, and list/map views. **Out of scope:** site locations (legacy `sites_locations` — never used, deliberately dropped), bulk import/actions (being redesigned separately), pagination (no V3 list paginates yet).

## Background — what we are replacing

Legacy BaseCamp (`~/Desktop/Server Sherpa Master/BaseCamp`) has a Sites feature we are re-building, not porting. Problems in it that this design deliberately fixes:

- Add/Edit Site in portal-v3 are **unwired stubs** (fake success toast, never call the API).
- The SQLAlchemy `Site` model **disagrees with the live DB** (missing `client`, `site_status`; declares `survey_data`/`partner_id` absent from the last dump). No migrations exist — schema history is ad-hoc `pg_dump` files.
- **Dual client relationships**: legacy `sites.client` FK *and* a newer `site_clients` junction, unioned in every query.
- `site_type` free text (matched by case-insensitive string compare — a typo silently breaks the partner-office filter), `site_status` a loose FK to a shared `status_options` table.
- `gps_coordinates` is a free-text `"lat, lon"` string parsed client-side.
- Detail page renders `city/state/zip/description/created_at` — **none exist**; the table has no timestamps at all.
- Site list fetches asset counts **one request per site** in a loop (N+1).
- `GET /sites/templates` references a nonexistent attribute (runtime AttributeError); `siteService.delete()` calls a route that doesn't exist.

Survey field groups carried forward (from `siteSurveyFields.js`): **Site Contact**, **Facility**, **Dock**, **Notes**.

## Decisions (from brainstorm)

1. **Site ↔ client is many-to-many** via `site_clients` only. No legacy single-value FK. (A facility can serve several clients; a client sees all their sites.)
2. **Site type and status are editable lookup tables** (the `worker_levels` pattern) — admins edit values without a deploy.
3. **Survey stays JSONB, with a server-side field registry** — the API validates what it stores; the portal renders from the same authoritative definition.

## 1. Data model — migration 0011

**`site_types`** (editable seed data, mirrors `worker_levels`):
`key` text PK (e.g. `datacenter`), `label` text NOT NULL, `description` text NOT NULL default `''`, `sort_order` int NOT NULL (not unique — presentational only; ties break by `label`), `icon` text, `updated_at`.
Seed: datacenter, office, warehouse, colo, partner_office, other.

**`site_statuses`** (editable seed data):
`key` text PK, `label` text NOT NULL, `description` text NOT NULL default `''`, `color` text NOT NULL (token name, e.g. `c-green`), `sort_order` int NOT NULL (not unique — presentational only; ties break by `label`), `updated_at`.
Seed: active (c-green), planned (c-aqua), inactive (c-slate), decommissioned (c-red).

**`sites`**:
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `name` | CITEXT NOT NULL | |
| `code` | CITEXT | optional short code, like clients/partners |
| `site_type` | text FK `site_types.key` | nullable |
| `status` | text FK `site_statuses.key` NOT NULL | server_default `active` |
| `address_line1/2`, `city`, `region`, `postal_code` | text | structured — mirrors the existing `OrgColumns` shape |
| `country` | text NOT NULL | server_default `US` |
| `latitude` | numeric(9,6) | real number, nullable |
| `longitude` | numeric(9,6) | real number, nullable |
| `timezone` | text | IANA name, nullable |
| `dc_provider` | text | nullable |
| `partner_id` | uuid FK `partners.id` | partner-operated facility; nullable |
| `survey_data` | JSONB NOT NULL | server_default `'{}'::jsonb` |
| `notes` | text | |
| `source`, `source_ref` | text | V3 convention; `source` default `manual` |
| `created_by` | uuid FK `people.id` | |
| `archived_at` | timestamptz | |
| `created_at`, `updated_at` | timestamptz NOT NULL | `now()` |

Constraint: `sites_coords_check` — `(latitude IS NULL) = (longitude IS NULL)` (never half a coordinate).
Index: `sites_partner_idx` on `partner_id`.

**`site_clients`** junction:
`site_id` uuid FK `sites.id` ON DELETE CASCADE, `client_id` uuid FK `clients.id`, `linked_by` uuid FK `people.id`, `linked_at` timestamptz NOT NULL default now(). PK `(site_id, client_id)`. Index on `client_id`.

Model classes `SiteType`, `SiteStatus`, `Site`, `SiteClient` in `db/models.py`. conftest truncate list gains `sites`, `site_clients`; lookup tables restored to canonical seed between tests (same treatment `worker_levels` already gets).

## 2. Access control

New registry entry in `access/resources.py`:
```python
Resource("sites", "Sites", routes=("/sites",),
         visible_to=frozenset({"global", "client", "partner"}))
```
Seeded matrix (migration 0011 adds rows; keep `access/defaults.py` in sync): developer/founder/super_admin/admin/staff → FULL; client_owner/client_admin/client_viewer → `view`; vendor_owner/vendor_admin/vendor_viewer → `view`; worker/external → none.

**Scoping — `scope.py` gains one capability.** Today `SCOPE_COLUMNS` maps resource → anchor → *column*. A client-anchored actor's sites live behind a junction, which a column cannot express. Change: a scope rule may be a column **or** a callable `(ids) -> ColumnElement`. New entry:
```python
"sites": {
    "client": lambda ids: sa.exists().where(
        sa.and_(SiteClient.site_id == Site.id, SiteClient.client_id.in_(ids))),
    "partner": Site.partner_id,
},
```
`scope_conditions()`'s signature, return contract (`None` / `sa.false()` / OR-of-anchors), and every existing call site are unchanged.

## 3. API — new `routes/sites.py`

All guards via `require_permission`; all list/detail reads apply `scope_conditions("sites", …)`; out-of-scope detail → **404** (never 403); every mutation writes one audit row in the same transaction (`entity_type: "site"`, actions `create` / `update` / `archive` / `restore` / `clients.set` / `survey.update`).

| Endpoint | Guard | Notes |
|---|---|---|
| `GET /sites` | `sites:view` | Scoped list. Each row: site fields + `type_label`, `status_label`, `status_color`, `partner_name`, `clients: [{client_id, name}]`. No pagination (V3 lists are client-filtered via listTools). |
| `GET /sites/{id}` | `sites:view` | Adds `survey_data`. 404 out-of-scope. |
| `POST /sites` | `sites:add` | Non-global actors denied (`forbidden`) — creating a site is an internal act; matches the users-router precedent. |
| `PATCH /sites/{id}` | `sites:change` | Partial; snapshot/diff audit. Validates FK keys exist (422 `unknown_site_type` / `unknown_status`). **Does not accept `survey_data`** — the survey has its own endpoint so its registry validation can never be bypassed. |
| `POST /sites/{id}/archive` · `/unarchive` | `sites:change` | Mirrors stakeholders. |
| `PUT /sites/{id}/clients` | `sites:change` | Body `{client_ids: [uuid]}` — full replace of junction rows; 404 on unknown client. |
| `PUT /sites/{id}/survey` | `sites:change` | Body `{survey_data: {…}}` validated against the registry (§4). |
| `GET /sites/survey-schema` | `sites:view` | The registry, for portal rendering. |
| `GET /site-types` · `GET /site-statuses` | `sites:view` | Lookup values for filters/selects. |
| `PUT /site-types/{key}` · `PUT /site-statuses/{key}` | `settings:change` | Edit label/description/color/sort_order (not `key`). Mirrors worker-levels admin. |

Coordinate validation on create/update: latitude ∈ [-90, 90], longitude ∈ [-180, 180], both-or-neither → 422 `invalid_coordinates`.

## 4. Survey field registry

`api/src/serversherpa/sites/survey.py` — code-side, same spirit as `access/resources.py`:

```python
@dataclass(frozen=True)
class SurveyField:
    key: str
    label: str
    kind: str            # 'text' | 'textarea' | 'bool' | 'int' | 'select'
    group: str           # 'contact' | 'facility' | 'dock' | 'notes'
    options: tuple[str, ...] = ()
```
Groups and fields carried from the legacy JS file: **contact** (name, phone, email), **facility** (floor, elevator_available, security_clearance_required, security_details), **dock** (dock_available, dock_hours, trailer_75ft_accessible, ground_level_entrance, entrance_details, dock_to_dc_distance_ft, floor_covering_required, forklift_required), **notes** (additional_notes).

`validate_survey(data) -> dict` — rejects unknown keys (422 `unknown_survey_field`), wrong types (422 `invalid_survey_value`), coerces/strips strings, drops empty values. No field is required (partial surveys are normal).

## 5. Portal — `/sites`

New `portal/src/pages/Sites.tsx`, route `/sites` (resource `sites`), nav item under **Operations**; `ROUTE_RESOURCE` + CommandPalette entries. Leaflet + react-leaflet added as deps; OpenStreetMap tiles (no API key).

- **List** (default view): shared **Filters / Columns / Export** toolbar (`listTools.tsx`, `Workers.tsx` is the reference consumer). Columns: Name, Type chip, Status chip (color from lookup), Clients chips, City, Country, DC provider, Coords indicator. Filters: type, status, client, country, has-coords.
- **List ⇄ Map toggle** in the toolbar. Map: markers from `latitude`/`longitude` (sites without coords are listed beneath the map as "no coordinates"), auto-fit bounds, popup with name / type / clients / status chip.
- **Row expansion — read-only** ([[expand-read-edit-modal]]): address block, coordinates + timezone, clients, partner, DC provider, survey summary (filled-group count), notes. One **Edit** button, gated `can('sites','change')`.
- **Edit modal**: all site fields (type/status selects from lookups, structured address, lat/lon, timezone, dc_provider, partner ComboBox), client links (multi ComboBox → `PUT /sites/{id}/clients`), and the **survey form rendered from `/sites/survey-schema`**, grouped into the four sections. Archive/unarchive action lives here too.
- **New site** button (gated `can('sites','add')`) → same modal in create mode (name required; everything else optional).
- Error codes surfaced readably: `unknown_site_type`, `unknown_status`, `invalid_coordinates`, `unknown_survey_field`, `invalid_survey_value`, `forbidden`.

## 6. Testing

**API** (pytest, no dev-DB seeding): junction scoping (client contact sees only linked sites; partner-anchored sees `partner_id` matches; out-of-scope detail 404; non-global create denied); CRUD + audit rows + archive/restore; `PUT /clients` full-replace semantics + unknown client 404; coordinate validation (out of range, half-set); survey validation (unknown key, wrong type, valid partial); lookup admin (edit label, `settings:change` guard, unknown key 404); migration 0011 up/down.
**Portal**: `npm run build` + vitest on pure helpers (filter predicates, survey payload builder, coord parsing/formatting).

## 7. Deliberately deferred

Site locations (dropped as unused); bulk import/actions (separate redesign); pagination; asset counts on the list (the legacy N+1 — needs a batched aggregate when assets exist in V3); site photos/attachments; client self-service editing of their own sites.

## Amendment 2026-07-15 — Sites are internal-only

**Decision (user, at final review):** only internal users may reach Sites. No client or partner account should see the nav item, let alone a site row.

This supersedes §2's `visible_to = {global, client, partner}` and the org-tier `view` grants:
- `sites` resource `visible_to = frozenset({"global"})` — the resolver's hard gate then blocks every org-anchored actor before overrides are consulted, so no override can grant a client/vendor contact access.
- Migration 0011 seeds sites grants for internal roles ONLY (developer, founder, super_admin, admin, staff). No client_*/vendor_* rows.
- Consequence: `scope_conditions("sites", …)` is only ever called with a global actor and always returns `None`, so the junction-aware scope rule (and the callable-rule extension added for it) is unreachable. Both are removed rather than kept as dead code. **If client visibility of their own sites is ever wanted, the junction rule and its tests are in git history at commit `3571b3e`** — re-add `visible_to` anchors, the matrix grants, the `SCOPE_COLUMNS["sites"]` entry, and `_match`'s callable dispatch.
- `_require_global` on every site mutation stays: cheap defence in depth, and it keeps the write path correct if the read gate is ever widened.
- No portal change needed — the nav item and route already gate on `can('sites','view')`, which org-anchored actors will no longer have.

This also resolves the final review's one Important finding (cross-tenant readability of co-located client names and survey data): with no external reader, the path does not exist.
