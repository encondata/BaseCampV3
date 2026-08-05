# Sites Bulk Import — Design Spec

**Date:** 2026-08-05 · **Status:** Approved (design conversation 2026-08-05)
**Scope:** Bulk creation (and developer-approved update) of sites from pasted JSON or an uploaded CSV/XLSX file, inside the existing New-site modal. Template downloads for all three shapes.
**Out of scope:** survey data (post-create only, validated by the survey registry), bulk import for other entities (assets will reuse the machinery later), bulk *actions* (archive/edit-many), background/async processing (batches are hundreds of rows, not millions).

## Background

The Sites spec (2026-07-15) deferred "bulk import/actions" as a separate redesign. This is the import half, for sites only. Legacy portal-v4 had `BulkAddSites.jsx` against the old API; none of it is ported — this is a new design on V3 conventions.

## Decisions (from brainstorm)

1. **All-or-nothing.** Preview validates every row; commit applies every row in one transaction or nothing. There is no partial import.
2. **Duplicates depend on who you are.** A row whose `name` matches an existing site (case-insensitive):
   - **Admin path:** row error — import is create-only.
   - **Developer path (god mode unlocked):** the row becomes a proposed **update** showing a field-level diff (old → new, changed fields only). Every duplicate must be explicitly approved before commit is allowed; to skip one, fix or remove the row. Server-side this path is gated on the `devtools` resource (literal developer role) — god mode reveals the UI, the role authorizes it.
3. **Org references are exact names.** `partner` is one partner name; `clients` is a semicolon-separated list of client names. Case-insensitive exact match; no match → row error.
4. **Admin-only feature.** The Bulk toggle renders only for `maxRank ≥ 60`; endpoints enforce `sites:add` + actor `max_rank ≥ 60`.
5. **Template = the create-modal fields, nothing else.** Survey excluded.
6. **Server-side parsing.** CSV/XLSX/JSON all normalize to the same row shape on the API; the portal never parses spreadsheets. Adds `openpyxl` to the API dependencies.

## 1. Row shape and validation rules

Canonical row (JSON object keys = CSV/XLSX header row, all lowercase):

`name` (required, non-empty) · `code` · `type` · `status` · `address_line1` · `address_line2` · `city` · `region` · `postal_code` · `country` · `latitude` · `longitude` · `timezone` · `dc_provider` · `partner` · `clients` · `notes`

Rules (each violation is a row error carrying row number + message):

- Unknown column/key → error on the whole payload (typo protection), listing the unknown names.
- `name` required; duplicate names **within the payload** are always errors (both rows flagged).
- `type` / `status`: must be an existing `site_types.key` / `site_statuses.key`. Blank `type` → null; blank `status` → `active` (the DB default).
- `latitude`/`longitude`: numeric, −90..90 / −180..180, **both or neither** (mirrors the DB check).
- Blank `country` → `US` (DB default). All string cells are trimmed; empty string ≡ blank.
- `partner`: single partner name; `clients`: semicolon-separated client names, each resolved independently; empty items ignored.
- **Update rows (developer path) — blank means "no change."** A blank cell never clears an existing value; clearing stays a UI operation. For create rows, blank means null/default as above.
- Diff semantics: changed scalar fields listed old → new; `clients` diffs as names added/removed; `partner` as old name → new name. A duplicate row with **zero** effective changes is reported as `unchanged` and requires no approval (commit ignores it).

## 2. API

New router section in `routes/sites.py` (same file — it owns the `sites` resource):

**`GET /sites/bulk-import/template?format=xlsx|csv|json`** — requires `sites:add` + `max_rank ≥ 60`.
- `csv`: header row + 2 sample rows.
- `xlsx` (openpyxl): sheet `Sites` (headers + 2 sample rows) + read-only sheet `Reference` listing valid `type` keys, `status` keys with labels.
- `json`: the same 2 sample rows as an array. The portal fetches this when bulk mode opens and uses it as the textarea prefill, so the sample can never drift from the API's truth.

**`POST /sites/bulk-import/preview`** — same gate. Accepts either `{"rows": [...]}` JSON or a multipart file (`.csv`/`.xlsx`), max 5 MB / 1,000 rows.
Response: `{"rows": [{"row": 2, "name": "…", "action": "create" | "update" | "unchanged" | "error", "errors": ["…"], "diff": {"field": {"old": …, "new": …}, "clients": {"add": […], "remove": […]}}, "site_id": "…", "data": {…normalized row…}}], "can_commit": bool, "update_allowed": bool}`
`data` is the normalized row (post-trim, post-default) — commit replays exactly these, so a file upload never needs re-uploading at commit time.
- `update` actions appear only when the caller passes the `devtools` gate; otherwise those rows are `error` ("site '<name>' already exists").
- `update_allowed` tells the portal which UI to render.

**`POST /sites/bulk-import/commit`** — same gate; the request replays the full normalized rows (`{"rows": [...], "approved_updates": ["<site_id>", …]}`) — JSON only (the portal holds the normalized rows from preview).
- Server re-runs the entire preview validation inside the transaction. Any error, any `update` row whose `site_id` is not in `approved_updates`, or `approved_updates` present without the `devtools` gate → **422, nothing imported**, same per-row error payload.
- Success: creates + approved updates committed atomically. Response `{"created": n, "updated": n, "unchanged": n}`.
- Audit: one `audit_log` row per created/updated site (standard create/update actions, changes populated) **plus** one `site_bulk_import` summary row (counts, actor, filename-or-paste). Rides the same transaction.

Parsing/validation/diff logic lives in `src/serversherpa/sites/bulk_import.py` (service layer, no HTTP concerns) so an eventual assets importer can lift the row-pipeline shape without dragging site specifics.

## 3. Portal

**`SiteEditModal.tsx`** create mode gains a two-tab toggle at the top: **Single site | Bulk import** — rendered only when `maxRank >= 60` (AuthContext). Edit mode is untouched.

**Bulk pane** (new `components/sites/SiteBulkImport.tsx`):
- Row of template buttons: `Template (.xlsx)` `Template (.csv)` — direct downloads of the template endpoint.
- Textarea prefilled with the sample JSON (fetched from the template endpoint, `format=json`); user overwrites/pastes. Below it a file input accepting `.csv,.xlsx`. If both a file and edited JSON are present, **pasted JSON wins** (the file input clears with a note).
- **Preview** button → renders the response as a compact table: row #, name, action chip (`create` green / `update` amber / `unchanged` gray / `error` red), error messages inline.
- God-mode path (`update_allowed`): each `update` row expands to its field diff (old → new, client adds/removes) with an **Approve** checkbox. A "approve all" control at the top.
- **Import** button enabled only when `can_commit` and every `update` row is approved. On success: toast "`N` sites created, `M` updated", modal closes, list refetches.
- Errors from commit re-render the preview table (the all-or-nothing 422 payload is the same shape).

No new nav/search surface — this lives inside the existing Sites page, so no `navSections`/palette/search changes.

## 4. Testing

API (`tests/test_sites_bulk_import.py`):
- Template: xlsx round-trips through openpyxl with both sheets; csv headers match the canonical row shape; json sample passes preview with zero errors (self-consistency guard).
- Parsing: csv and xlsx of the same rows normalize identically to JSON input.
- Validation: unknown column; missing name; in-payload duplicate names; bad type/status key; half a coordinate; out-of-range lat; unknown partner/client name; >1,000 rows.
- Duplicates: admin sees `error`; developer sees `update` with correct diff (scalar, partner rename, client add+remove); zero-change duplicate → `unchanged`.
- Atomicity: commit with one bad row imports nothing (count sites before/after); commit with unapproved update → 422 nothing imported; `approved_updates` from a non-developer → 422.
- Permissions: staff below admin rank → 403 on all three endpoints; client-org users → 403.
- Audit: per-site rows + summary row present after a successful commit.
- Blank-cell semantics: update row with blank city leaves existing city; create row with blank status gets `active`.

Portal: component test for `SiteBulkImport` (preview table rendering, approve-gating of the Import button) following the existing `SiteEditModal.test.tsx` pattern; NAV/search tests untouched (no new surfaces).

## 5. Future (recorded, not designed)

- Assets bulk import (the 10,388-row legacy load) reusing the row-pipeline shape from `sites/bulk_import.py`.
- Bulk actions (archive many, edit many) — separate design.
- Async/background imports if batch sizes ever outgrow a request cycle.
