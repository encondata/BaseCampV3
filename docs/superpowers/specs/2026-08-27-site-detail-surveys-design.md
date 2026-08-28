# Site detail page + survey data upgrade — design

**Date:** 2026-08-27
**Status:** approved
**Scope:** A full `/sites/:id` detail page (modeled on BaseCampV2 portal-v2 `SiteDetail.jsx`, adapted to V3 house patterns) and an upgrade of site survey data from one JSONB blob to real rows: `site_survey_data` (curated current answers) + `raw_survey_data` (append-only submission trail), both presented as standard lists. V2 reference explored at `~/Developer/BaseCampV2-reference` (recon: portal-v2 `SiteDetail.jsx`, `SiteSurveyDataSection.jsx`, `SiteSurveyRawSection.jsx`, `siteSurveyFields.js`).

## Background & decisions (from brainstorming)

- **V2 truth:** "Site Survey Data" and "Raw Survey Data" were two views of ONE `sites.survey_data` JSONB (typed questionnaire form vs flat key/value dump); no survey tables existed. V3 already improved on V2 by moving the field registry server-side (`api/src/serversherpa/sites/survey.py`) with validation.
- **User decision — upgrade, not port:** real rows. Curated = **one row per (site, field): the current answer** with authorship/provenance. Raw = **every submission ever, append-only** (portal edits now; kiosk/import sources later).
- Both lists use the full standard-list kit. The house UI vocabulary rule from 2026-08-27-asset-detail-surfaces-design.md stands.
- V2 sections deliberately NOT ported: Locations table (V3 removed `sites_locations` by design — `location_detail` lives on assets); separate Images/Documents cards (`NotesFilesPanel` covers notes + attachments).
- The Sites edit modal keeps its grouped `SurveyForm` UX (bulk-entry path) reworked onto the new endpoints; the page's curated list is the precision path.

## 1. Data model — migration `0027_site_survey_rows.py`

### `raw_survey_data` (append-only, log-style)

| Column | Type | Notes |
|---|---|---|
| `id` | BigInteger `Identity()` PK | log-style |
| `site_id` | UUID FK → sites.id, not null | |
| `field_key` | Text, not null | ANY key — strays allowed (V2 raw-editor parity) |
| `value` | JSONB, nullable | scalar: string/bool/number; null = "cleared" submission |
| `captured_at` | timestamptz, not null | when the answer was given |
| `submitted_by` | UUID FK → people.id, nullable | null for future unattended sources |
| `device_id` | Text, not null, default `''` | future kiosk identity |
| `source` | Text, not null, default `''` | `portal` now; `kiosk` / `import` / `migration` |
| `created_at` | timestamptz, not null, default now() | ingest time |

Indexes: `(site_id, id)`. No update/delete paths — rows are permanent.

### `site_survey_data` (curated current answers)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK, gen_random_uuid() | |
| `site_id` | UUID FK → sites.id, not null | |
| `field_key` | Text, not null | must exist in the server-side registry (API-validated; registry is code, not DB) |
| `value` | JSONB, not null | validated against the registry field kind |
| `raw_id` | BigInteger, nullable, FK → raw_survey_data.id | the submission this answer came from |
| `updated_by` | UUID FK → people.id, nullable | |
| `created_at` / `updated_at` | timestamptz, not null, default now() | |

Constraint: `UNIQUE(site_id, field_key)`. Index on `site_id`.

### Data migration + blob removal

- Explode every existing `sites.survey_data` blob: per key → one `raw_survey_data` row (`source='migration'`, `captured_at=now()`, no submitter) and, for registry-known keys with valid values, one `site_survey_data` row pointing at it. Unknown/stray keys land in raw only.
- Then `DROP COLUMN sites.survey_data`. Downgrade recreates the column and re-folds curated rows back into blobs (best-effort; raw history is not reconstructed into the blob).
- The field registry (`sites/survey.py`) is unchanged and remains the single validation source.

## 2. Write flow

One transaction per answer, portal edits write both sides:

1. Append `raw_survey_data` (`source='portal'`, `submitted_by=actor`, `captured_at=now()`, the new value).
2. Upsert `site_survey_data` for (site, field): set `value`, `raw_id`, `updated_by`, bump `updated_at`.
3. Clearing: append a raw row with `value=null`, DELETE the curated row.
4. Audit via snapshot/diff (`entity_type='site'`, action `survey_update`, per-field changes).

Future kiosk/import feeds append raw rows only; a promotion step (deferred, like the scans matcher) will upsert curated rows from them.

## 3. API (routes/sites.py)

- `GET /sites/{site_id}/survey` → curated rows, denormalized: `field_key`, `label`, `group`, `group_label`, `kind` (from the registry), `value`, `updated_by`/`updated_by_name`, `updated_at`, `raw_id`. Registered-but-unanswered fields are NOT server-fabricated — the portal builds placeholder rows from `/sites/survey-schema` (already exists).
- `GET /sites/{site_id}/survey/raw` → full list newest-first (`id desc`): `field_key`, `registered` (bool, computed against the registry), `value`, `captured_at`, `submitted_by_name`, `device_id`, `source`, `created_at`. Per-site volume is small — unpaged.
- `PUT /sites/{site_id}/survey/{field_key}` body `{value}` → validates key ∈ registry + value vs kind (reusing `validate_survey`'s per-field logic), executes the write flow, returns the updated curated row. Errors: `unknown_survey_field`, `invalid_survey_value` (422), `site_not_found` (404).
- `DELETE /sites/{site_id}/survey/{field_key}` → the clear flow (204; 404 if no curated row).
- REMOVED: `PUT /sites/{site_id}/survey` (blob endpoint) and `survey_data` from `SiteDetail` payloads. `GET /sites/survey-schema` unchanged.
- Permissions: reads `sites: view`; writes `sites: change`. Verified: neither sites bulk-import nor the V2 importer writes `survey_data` (the V2 importer folds legacy survey blobs into a text note only — `sites/v2_import.py:236-251`), so no import-path changes are needed.

## 4. Portal — `/sites/:id` page (`pages/SiteDetail.tsx`)

House detail chrome (the MoveAssetDetail/AssetDetail pattern): `.idet-back` "← Sites" → `/sites`; `.idet-header` — title = site name, status chip + type chip in the hint line, `.idet-header-actions` with **Edit** (`.btn-solid`, gated `sites: change`) opening the existing `SiteEditModal`. Not-found state for unknown ids.

Panels (`.init-panel`):
1. **Overview** — `dl.kv`: address lines, city/region/postal/country, type chip, status chip, partner, timezone, DC provider, coordinates (text), created/updated.
2. **Map** — reuse the existing `SitesMap` component (leaflet already shipped) as a single-site map when coordinates exist; `page-hint` "No coordinates recorded." otherwise.
3. **Clients** — the M:N client links (names, linked dates) as read-only `dl.kv`/chips; editing stays in the modal.
4. **Notes & files** — `NotesFilesPanel entityType="site"` (canWrite = `sites: change`).
5. **Site Survey Data** — standard list (below).
6. **Raw Survey Data** — standard list (below).

### Site Survey Data list (curated)

- Rows = registry fields (from `/sites/survey-schema`) merged with the curated answers: every registered field appears, unanswered ones with `—` — the V2 "n/17 filled" picture, fillable in place. Header count badge shows `filled/total`.
- Columns: **Field · Group · Value · Updated by · Updated** (Group renders as a plain label; Value renders by kind — bool as Yes/No, select as its option, text/int plain; `—` when unanswered).
- Full standard kit: filter box, column menus, sort, ColumnsButton + reorder, CSV export, `usePersistentListState('site_survey', …)`.
- **Inline editing** (gated `sites: change`): the Value cell is editable in place via the `GodCell` machinery with kind-appropriate widgets (text input, Yes/No combo, number, select) — but WITHOUT god-mode gating: survey entry is normal data entry, so the edit affordance follows `sites: change` alone (an explicit deviation from god-edit's god-mode gate, contained to this list). Save calls the PUT; clearing a value calls the DELETE.
- No row expansion (rows are atomic); no archived column.

### Raw Survey Data list (append-only)

- Read-only standard list, newest first: **Captured · Field · Value · Registered · Source · Submitted by · Device**. `Registered` = Yes/`—` flag for stray keys. Full standard kit, `usePersistentListState('raw_survey', …)`, CSV. No editing, no expansion.

### Pure logic

`portal/src/lib/siteSurvey.ts` (+ tests): searchText/cellText for both lists, value rendering per kind, merge of schema + curated rows into display rows, error map.

## 5. Integration

- Search-everywhere `site` hits → `navigate(/sites/${id})` (the initiatives treatment; Topbar.tsx one-liner).
- Sites list row expansion gains **Full Details ↗** (`mini-btn` Link) — the roster pattern.
- `auditFormat.entityHref`: the `site` mapping changes from the list-with-`?open=` link to the detail page (`/sites/${entity_id}`) — audit Record links land on the full page, matching the new navigation convention.
- Sites list expansion's survey summary + `SiteEditModal`'s `SurveyForm`: reworked to the new endpoints (form loads curated rows keyed by field, saves changed fields via the PUT per field — sequential is fine at 17 fields).

## 6. Testing

- **API**: migration explode (blob → rows, strays raw-only) + downgrade re-fold; write-flow (PUT appends raw + upserts curated same transaction; DELETE appends null-raw + removes curated); validation errors; raw ordering + `registered` flag; permission gates.
- **Portal**: `lib/siteSurvey.ts` unit tests (merge, cellText, value rendering); suites green; browser pass — page panels, inline survey editing round-trip, raw trail grows on each edit, stray-key display, Sites modal survey form still works, search hit lands on the page.

## Out of scope

- Kiosk/import raw feeds and the raw→curated promotion step (deferred, like the scans matcher); survey field registry editing UI; per-move surveys (`{{move.survey.*}}` — V2 gap, still deferred); the V2 site-move-survey xlsx report generator; Locations section.
