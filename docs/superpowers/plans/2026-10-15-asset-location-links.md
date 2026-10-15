# Asset Location Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An asset's Location links to the container it is in and, when that container is on a truck, to the truck — on every screen that shows an asset's location.

**Architecture:** A new `assets/placement.py` resolves asset → container → truck in at most two set-based queries, gated by `containers:view` / `trucks:view` and their `scope_conditions`. `AssetItem`, `InitiativeAssetSummary` and `AssetRef` gain optional `container_id/container_name/truck_id/truck_name`. The portal adds `placementText` and an `AssetLocation` component used by every asset Location cell.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest; React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-15-asset-location-links-design.md` — binding.

## Global Constraints

- No migration. `location_detail` is unchanged everywhere (still returned, still edited as text).
- Placement: container from `container_assets` joined to `containers`, archived containers skipped; truck from `truck_containers` joined to `trucks`, archived trucks skipped, latest `truck_containers.added_at` wins; a truck only alongside a visible container.
- Gating: container fields only when `access.can("containers", "view")` AND the container passes `scope_conditions("containers", access, person_id)`; truck fields only when `access.can("trucks", "view")` AND the truck passes `scope_conditions("trucks", access, person_id)`. Apply the scope condition inside the query (None = unrestricted; `sa.false()` = nothing).
- At most two queries per call however many assets; empty input → `{}` with no query.
- New response fields, all optional with default `None`: `container_id`, `container_name`, `truck_id`, `truck_name` on `AssetItem`, `InitiativeAssetSummary`, `AssetRef`.
- Display: `"<container> · on <truck>"` (middle dot U+00B7, spaces around it); container link `/logistics/containers?open=<id>`; truck link `/logistics/trucks/<id>`; no container → the location text, or `—` when empty. Sort, filter/search and CSV use the same text as shown.
- TruckDetail container links change from `?focus=` to `?open=`.
- House idioms (natural sort, existing cell classes, `react-router-dom` `Link`), American English.
- Never commit `api/src/serversherpa/_dev_reload.py`. Never `git stash`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to run things (worktree `.claude/worktrees/asset-placement`)

- API tests, foreground only, one run at a time, long timeout: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_assetplace DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>` (`PYTHONPATH` is required — the .venv is an editable install of the main checkout). Any alembic command must set `SS_DATABASE_URL` to the test DB, never the dev DB.
- Portal: `cd portal && npx vitest run <files>`; before committing portal work run the full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: API — placement helper and the three responses

**Files:** create `api/src/serversherpa/assets/placement.py`, `api/tests/test_asset_placement.py`; modify `api/src/serversherpa/api/schemas.py` (`AssetItem`, `InitiativeAssetSummary`, `AssetRef`), `api/src/serversherpa/api/routes/assets.py` (`_item`, `_context`, `_detail`, `list_assets`, `get_asset`, create, PATCH), `api/src/serversherpa/api/routes/initiatives.py` (`_initiative_asset_rows` gains `actor`; update all three callers), `api/src/serversherpa/api/routes/warehouse.py` (`_asset_ref` and the inventory route).

**Produces:**

```python
@dataclass(frozen=True)
class Placement:
    container_id: uuid.UUID
    container_name: str
    truck_id: uuid.UUID | None = None
    truck_name: str | None = None

async def asset_placements(
    db: AsyncSession, asset_ids: Iterable[uuid.UUID],
    access: AccessInfo, person_id: uuid.UUID,
) -> dict[uuid.UUID, Placement]: ...
```

- [ ] Step 1: failing tests — helper: in a container on a truck; container only; no container (absent from dict); archived container skipped; archived truck skipped; two trucks → latest `added_at`; non-global (client) access → `{}`; global access without `trucks:view` → container only; without `containers:view` → `{}`; empty ids → `{}`; query count flat as assets grow (count statements with a SQLAlchemy event listener — see `tests/test_trucks_map_trip.py` for the pattern). Routes: `GET /assets`, `GET /assets/{id}`, `GET /initiatives/{id}/assets`, and the Warehouse inventory endpoint carry the four fields for a staff user; a client user's `GET /assets` does not.
- [ ] Step 2: run; confirm failure. Step 3: implement. Step 4: run the new file plus `tests/test_assets*.py`, `tests/test_initiative*asset*.py`, `tests/test_warehouse*.py` — pass; ruff clean on touched files. Step 5: commit `feat(assets): asset placement — container and truck on asset, roster and warehouse responses`.

### Task 2: Portal — AssetLocation everywhere an asset's location shows

**Files:** modify `portal/src/lib/api.ts` (types), `portal/src/lib/assets.ts` (`placementText`, the Location filter/search text at ~42/65), `portal/src/pages/Assets.tsx` (Location column ~424, sort ~119, CSV ~139, expanded row ~627), `portal/src/pages/AssetDetail.tsx` (~148), `portal/src/pages/MoveAssetDetail.tsx` (~134), `portal/src/lib/initiatives.ts` (~392) with the roster Location cells in `portal/src/pages/InitiativeDetail.tsx` and `portal/src/pages/MoveDashboard.tsx`, `portal/src/lib/warehouse.ts` (`assetRow` ~62) and `portal/src/pages/Warehouse.tsx` (Location cell ~375 and sort ~103), `portal/src/pages/TruckDetail.tsx` (~416 `?focus=` → `?open=`); create `portal/src/components/assets/AssetLocation.tsx` (+ test).

**Consumes:** the four optional API fields from Task 1.

**Produces:** `placementText(p: { location_detail?: string | null; container_name?: string | null; truck_name?: string | null }): string` and `<AssetLocation asset={…} className=… />`.

- [ ] Step 1: failing tests — `placementText` (both, container only, text, empty); `AssetLocation` renders the two links with the right hrefs, container only, text fallback, `—` when empty, and a click on a link does not bubble to a row handler; each screen shows the links for an asset with placement (Assets list cell + expanded row, AssetDetail, MoveAssetDetail, roster on InitiativeDetail and MoveDashboard, Warehouse asset row); Assets sort/search/CSV use the shown text; TruckDetail container link uses `?open=`.
- [ ] Step 2: run; confirm failure. Step 3: implement. Step 4: full `npx vitest run`, `npx tsc -b`, `npm run build`. Step 5: commit `feat(portal): asset Location links to its container and truck`.
