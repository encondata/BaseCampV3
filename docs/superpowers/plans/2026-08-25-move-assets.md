# Move Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** V2-parity move assets: `initiative_assets` join table + vocabulary + endpoints in the API, the assets table (filters/columns/search/progress/CSV, edit dialog, remove) on the move Full Details page, and the rack elevation modal last.

**Architecture:** Backend follows the ContainerAsset + InitiativePerson patterns (model, migration 0019, `move_asset_status` registry entry + seed, sub-routes on the `initiatives` resource with audit). Frontend extends portal/src/pages/InitiativeDetail.tsx with an Assets section built on the shared list machinery (`ColumnMenu`, `ColumnsButton` + `usePersistentListState`, `exportCsv`), an edit-dialog modal, and a self-contained SVG rack-view modal.

**Tech Stack:** FastAPI + SQLAlchemy(async) + Alembic + pytest; React 18 + TS + vitest.

**Spec:** docs/superpowers/specs/2026-08-25-move-assets-design.md — the requirements source; every task's implementer reads it in full. The prod reference dump is api/backups/backup_20260825_193157.sql (gitignored).

## Global Constraints

- API commands run from `api/` (`.venv`), portal from `portal/`. API verify: `.venv/bin/pytest` green (441 baseline), migration up/down works against the dev DB. Portal verify: `npx tsc -b`, `npm test` (370 baseline), `npm run build`.
- Reference patterns: `ContainerAsset` model + `containers.py` asset routes; `InitiativePerson`/people routes + audit in `routes/initiatives.py`; status registry in `serversherpa/status/registry.py`; seeds in migration 0012/0013 style.
- Vocab keys/labels/colors/sort orders come VERBATIM from the spec's table.
- Progress rule: status key == `complete` only.
- Frontend reuses: `.init-panel`, `idet-` classes, `ColumnMenu`/`passesColumnFilters`, `ColumnsButton` (`onReorder`), `usePersistentListState` (pageKey `initiative_assets`), `exportCsv`, modal shell classes, `run()` mutation pattern, ComboBox.
- Commits end with:

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: model + migration + vocabulary

**Files:** Modify `api/src/serversherpa/db/models.py`, `api/src/serversherpa/status/registry.py`; Create `api/migrations/versions/0019_initiative_assets.py`; Test `api/tests/test_status_registry.py` (extend), new `api/tests/test_initiative_assets_model.py` only if a model-level test is warranted (else cover via Task 2's API tests).

**Interfaces produced:** `InitiativeAsset` model (table `initiative_assets`) with the spec's exact columns; registry entry `StatusRecordType("move_asset_status", "Move asset status", table="initiative_assets", column="status", resource="initiatives")`; migration 0019 creating the table (FKs, unique pair, server-default status `loaded_in_system`) and seeding the 24 `status_values` rows from the spec table (delete them + drop table on downgrade).

- [ ] TDD: registry test asserting the new record type; migration written; `alembic upgrade head` + `downgrade -1` + `upgrade head` clean against dev DB; full pytest green; commit `feat(api): initiative_assets model, migration, move_asset_status vocabulary`.

### Task 2: endpoints + tests

**Files:** Modify `api/src/serversherpa/api/routes/initiatives.py`, `api/src/serversherpa/lib` only if shared helpers exist there; Test: new `api/tests/test_initiative_assets_api.py`.

**Interfaces produced (consumed by Task 3):**
- `GET /initiatives/{id}/assets` → `[InitiativeAssetOut]`: id, asset_id, priority_wave, disposition, owner, source_rack, source_ru (stringified decimal or number — pick one and document in the schema), source_verified, source_position, destination_rack, destination_ru, destination_verified, destination_position, cable_info, vendor_involved, status, status_label, status_color, created_at, updated_at, and embedded `asset`: {id, legacy_id, serial_number, name, rfid_tag, model_make, model_name, ru_size, location_detail, client_name, status, status_label, status_color}.
- `POST /initiatives/{id}/assets` `{asset_ids: [uuid]}` per spec error codes (`not_a_move`, `assets_not_found`, `assets_already_on_initiative`).
- `PATCH /initiatives/assets/{assoc_id}` whitelist per spec (`invalid_ru`, `unknown_status`).
- `DELETE /initiatives/assets/{assoc_id}`.
All gated `initiatives` change (GET: view), audited like people/links.

- [ ] TDD: tests first (attach/list/patch/detach happy paths + every spec error + cascade delete of initiative removes rows + non-move rejection); implement; full pytest green; commit `feat(api): move asset endpoints`.

### Task 3: portal api client + assets table (read-only)

**Files:** Modify `portal/src/lib/api.ts` (types + 4 client fns), `portal/src/lib/initiatives.ts` (cell-text accessor + column defs + CSV columns + MOVE_ASSET_ERRORS), `portal/src/pages/InitiativeDetail.tsx` (Assets section for moves), `portal/src/styles/initiatives.css`; Test: `portal/src/lib/initiatives.test.ts` (extend or create) for the pure helpers (progress computation, cell text).

**Interfaces produced:** `InitiativeAssetRow` type mirroring Task 2's payload; `listInitiativeAssets/addInitiativeAssets/updateInitiativeAsset/removeInitiativeAsset`; `MOVE_ASSET_COLUMNS: ColumnDef[]` (spec's default/optional split), `moveAssetCellText(row, colKey)`, `moveAssetProgress(rows) -> {complete, total, pct}`.

- [ ] Build the section: progress bar, search box, ColumnMenu headers, ColumnsButton (visibility + order, pageKey `initiative_assets`), CSV export, empty state — read-only (no edit/remove yet). Moves only; placeholder stays otherwise. Verify tsc/tests/build; commit `feat(portal): move assets table — read-only columns, filters, progress, export`.

### Task 4: edit dialog + remove

**Files:** Modify `portal/src/pages/InitiativeDetail.tsx`, `portal/src/styles/initiatives.css`.

- [ ] Edit dialog (modal shell): move-status ComboBox (vocab via a `listMoveAssetStatuses()` client fn against the status-values endpoint — add to api.ts consistent with `listInitiativeWorkTypes`), wave, disposition, owner, source rack/RU/position/verified, destination rack/RU/position/verified, cable info, vendor involved; empty → null semantics; Save → PATCH → refetch. Remove per row via run() pattern. All behind canChange. Verify; commit `feat(portal): move asset edit dialog + remove`.

### Task 5: dev seed + controller browser verification

- [ ] Controller: create a move initiative in the dev DB, attach ~10 real assets via the POST endpoint (curl with dev token or a tiny script), verify the full flow in the browser (columns, filters, order persistence, progress, edit round-trip, remove, CSV). Fix-forward findings. Record in ledger.

### Task 5b (user feedback): toolbar alignment + inline edit-table mode

**Files:** Modify `portal/src/pages/InitiativeDetail.tsx`, `portal/src/lib/initiatives.ts`, `portal/src/styles/initiatives.css` (if needed).

User feedback after first live look: (1) the assets toolbar controls (search, count, filter chip, Columns, Export) sit left-aligned — wrap them in the standard `.toolbar-right` div exactly as Initiatives.tsx's toolbar does so they right-align; (2) add an "edit table" mode for admin- and developer-level accounts (`maxRank >= ADMIN_RANK && can('initiatives','change')`): a `GodEditToggle` in the assets toolbar (visible on that gate, NOT gated on godMode) that flips the table into inline per-cell editing via the existing `GodCell` machinery — define `MOVE_ASSET_EDIT_FIELDS` in lib/initiatives.ts as `GodField<InitiativeAssetRow>[]` covering: priority_wave (text), disposition (text), owner (text), source_rack (text), source_ru (number), source_position (text), source_verified (bool), destination_rack (text), destination_ru (number), destination_position (text), destination_verified (bool), cable_info (text), vendor_involved (bool), status (select over move-asset statuses). `patch = (id, body) => updateInitiativeAsset(id, body)`, `onRowSaved` replaces the row in state, `errorMap = MOVE_ASSET_ERRORS`. Asset-identity columns (Asset ID/Name/Serial/Make-Model/RFID/Location/Client/Asset Status/Added/Updated) stay read-only in edit mode. People-section reorder to last is handled separately by the controller.

- [ ] Implement, verify `npx tsc -b`/`npm test`/build, commit `feat(portal): move assets toolbar alignment + inline edit table`.

### Task 6: rack view modal

**Files:** Create `portal/src/components/initiatives/RackViewModal.tsx`; Modify `portal/src/pages/InitiativeDetail.tsx` (clickable rack cells), `portal/src/styles/initiatives.css`; Test: placement math as a pure helper (`rackLayout(rows, rackName, side) -> blocks`) in a lib test.

- [ ] Per spec's Rack view section: 54-RU SVG elevation, decimal RU placement, ru_size block heights, verified fill vs outline, position note on block, name/serial labels, scrim/Esc close. Rack cells in the table become buttons when non-empty. Verify + browser check; commit `feat(portal): rack elevation view for move assets`.

### Task 7: final verification

- [ ] Full API + portal suites, build, final whole-branch review of the slice, browser pass over everything. Ledger.
