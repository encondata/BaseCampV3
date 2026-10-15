# Container Contents List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A container's expanded row shows its contents as a standard asset list (search, sort, column filters, Columns menu, CSV), reusing the Assets list's column definitions.

**Architecture:** API: a shared `assets/items.py` `asset_items()` builder; `ContainerAssetRow` gains `asset: AssetItem`. Portal: the Assets list's columns/sort/CSV/read-only cells move to `components/assets/assetColumns.tsx`; a new `ContainerContentsList` uses them inside `ContainerRowDetail`.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest; React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-15-container-contents-list-design.md` — binding.

## Global Constraints

- `ContainerAssetRow` keeps every current field (`asset_id`, `serial_number`, `name`, `model_name`, `status`, `status_label`, `status_color`, `added_at`, `added_by_name`) and gains `asset: AssetItem`, identical to the `GET /assets/{id}` record for that actor (placement fields included). No migration.
- One `asset_items` call per response (no per-row lookups).
- Asset route responses and the Assets list's look and behavior are unchanged by the extraction.
- Contents list default visible columns, in this order: Asset ID, RFID, Name, Serial, Make / Model. Offered extras: the shared asset columns except `primary` and god-only columns, plus **Packed** (`added_at`; `added_by_name` shown with it). Column choices/order persist under list key `container-contents`.
- Contents list idioms: `dir-search` box + result count, `ColHead` sort + column filters, `FilterSummaryChip`, `ColumnsButton`, `ExportButton`, `listGridStyle` with column floors, natural sort (no `localeCompare`). Row click → `/assets/:id`. Loading "Loading…", empty "No assets in this container.".
- The Edit container dialog's contents list is unchanged.
- House style guardrails (src/styles/*.test.ts: list typography, list-head/listGridStyle rule (h), natural sort, modal dropdowns, rounded scrollbars) must pass. American English.
- Never commit `api/src/serversherpa/_dev_reload.py`. Never `git stash`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to run things (worktree `.claude/worktrees/container-contents`)

- API tests, foreground only, one run at a time, long timeout: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_contents DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>` (`PYTHONPATH` required). Any alembic command must set `SS_DATABASE_URL` to the test DB.
- Portal: `cd portal && npx vitest run <files>`; before committing portal work run the full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: API — shared asset builder and richer contents rows

**Files:** create `api/src/serversherpa/assets/items.py`; modify `api/src/serversherpa/api/routes/assets.py` (`_item`/`_context`/`_detail` → use `asset_items`), `api/src/serversherpa/api/routes/containers.py` (`_asset_rows(db, container_id, actor)`, GET and POST `/{container_id}/assets`), `api/src/serversherpa/api/schemas.py` (`ContainerAssetRow.asset: AssetItem`); tests in `api/tests/test_container_assets_api.py` (or a new `api/tests/test_container_contents_items.py`).

**Produces:** `async def asset_items(db: AsyncSession, assets: Sequence[Asset], actor: AuthContext) -> list[AssetItem]` (order preserved); `ContainerAssetRow.asset`.

- [ ] Step 1: failing tests — GET and POST contents rows carry `asset` equal to `GET /assets/{id}` for the same actor (model, client, site, status, location, placement fields) and keep the old fields; statement count for the contents GET is the same for 2 and 10 packed assets.
- [ ] Step 2: run; confirm failure. Step 3: implement. Step 4: run the new tests plus `tests/test_assets*.py`, `tests/test_container*.py`, `tests/test_asset_placement.py` — pass; ruff clean on touched files. Step 5: commit `feat(containers): contents rows carry the full asset record (shared asset_items builder)`.

### Task 2: Portal — shared asset columns module (no behavior change)

**Files:** create `portal/src/components/assets/assetColumns.tsx`; modify `portal/src/pages/Assets.tsx`; tests: `portal/src/pages/Assets.test.tsx` must pass unchanged, plus a small `portal/src/components/assets/assetColumns.test.tsx` for the moved pieces.

**Produces:** `ASSET_COLUMNS: ColumnDef[]` (today's `COLUMNS`), `assetSortValue(a: AssetItem, key: string): string` (today's `sortValueFor`), `ASSET_CSV_COLUMNS` (today's `CSV_COLUMNS`), and a read-only cell renderer `AssetCell({ asset, colKey })` (or `assetCell(a, key)`) covering every key `cellFor` handles outside the god-mode editing branch. Page-only extras (duplicate-serial chip, Archived / Pending delete chips beside status, god-mode `GodCell`s) stay in `Assets.tsx`, composed around the shared cell.

- [ ] Step 1: write `assetColumns.test.tsx` for the moved pieces (sort values, a few cells). Step 2: move the code; Assets.tsx imports it. Step 3: full `npx vitest run` (Assets tests unchanged and green), `npx tsc -b`, `npm run build`. Step 4: commit `refactor(portal): share the Assets list columns, sort values, CSV and read-only cells`.

### Task 3: Portal — ContainerContentsList in the expanded row

**Files:** create `portal/src/components/containers/ContainerContentsList.tsx` (+ test); modify `portal/src/lib/api.ts` (`ContainerAssetRow.asset: AssetItem`), `portal/src/pages/Containers.tsx` (`ContainerRowDetail` Contents block). Follow the embedded-list pattern of the initiative page's Assets roster (`pages/InitiativeDetail.tsx`) and the toolbar idioms of `pages/Assets.tsx`.

**Consumes:** Task 1's `asset` field; Task 2's `ASSET_COLUMNS`, `assetSortValue`, `ASSET_CSV_COLUMNS`, read-only cell renderer.

- [ ] Step 1: failing tests — default columns and order (Asset ID, RFID, Name, Serial, Make / Model); adding a column (e.g. Status) from the Columns menu; Packed column shows date and who; search narrows rows; header sort orders rows naturally; a column filter narrows rows and the Clear chip resets; Export writes the visible rows; clicking a row navigates to `/assets/:id`; Loading… and the empty text.
- [ ] Step 2: run; confirm failure. Step 3: implement. Step 4: full `npx vitest run`, `npx tsc -b`, `npm run build`. Step 5: commit `feat(portal): container contents as a standard list`.
