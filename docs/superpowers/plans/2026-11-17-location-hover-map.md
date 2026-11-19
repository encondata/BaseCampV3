# Location Hover Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering (or focusing) the container or truck name in the initiative full details assets list opens a small static map of the container's last known position: the truck's newest GPS report, else the container's site pin, else a note.

**Architecture:** A new API lookup `GET /containers/{id}/position` (helper `container_position` in `assets/placement.py`, beside the placement rules it mirrors) answers `truck | site | none`, applying the same permission and scope gates as the Location links. The portal fetches it lazily on hover through a 60 s per-container cache, and renders it in a portaled hover card (`LocationMapPreview`) modeled on `PhotoPreview`. `AssetLocation` gains an opt-in `mapPreview` prop, and only InitiativeDetail turns it on in this step.

**Tech Stack:** FastAPI + SQLAlchemy async + Postgres (pytest, real DB); React + react-leaflet + Vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-11-17-location-hover-map-design.md`

## Global Constraints

- Branch `location-hover-map` in a worktree off `main`. **Workspace setup:**
  - Symlink `portal/node_modules` and `api/.venv` to the main checkout's copies. Never run `npm install` in the worktree, because it replaces the symlink.
  - Run the API tests with `PYTHONPATH=src` and `SS_TEST_DB=serversherpa_test_lochover`.
- Run every test command in the FOREGROUND with a 600000 ms timeout. Never background a suite.
- Never commit `api/src/serversherpa/_dev_reload.py`.
- **Copy:** American English, sentence case. Use exactly the strings this plan gives.
- **Times:** 24-hour HH:MM (`hourCycle: 'h23'`), never AM/PM.
- **The hover card:**
  - follows light/dark through the theme tokens and portals into `.portal-shell`
  - has rounded corners (`border-radius: 14px`, like `.pp-card`)
  - takes no inline `fontSize`; type comes from classes
- `.leaflet-container` isolation already lives in `styles/chrome.css` (guardrail `styles/leafletStacking.test.ts`). Do not add a second rule.
- **Permissions:**
  - containers: `containers:view` + `scope_conditions("containers")`
  - trucks: `trucks:view` + `scope_conditions("trucks")`
  - sites: `sites:view` + `scope_conditions("sites")`
  - archived containers and trucks are skipped
- Nothing is fetched until a hover has lasted 300 ms (`PREVIEW_DELAY_MS`).

## Review Focus

1. **A truck whose newest report has no coordinates but an older one does.** The answer must be the older report with coordinates, not `none`. This is pinned in Task 1 (`test_truck_uses_newest_report_with_coordinates`).
2. **A truck with no reports at all.** The answer is `kind: "truck"` with null coordinates, never a fall-back to the site pin. The popup says "<truck> hasn't reported a position yet". This is pinned in Tasks 1 and 2.
3. **A viewer with `containers:view` but no `trucks:view`, for a container on a truck.** The answer drops to the site pin, so the popup must not leak the truck name. This is pinned in Task 1 (`test_without_trucks_view_falls_to_site`).
4. **Two hovers on the same container within a minute** (the container link and the truck link in one cell) make one request. A failed request is not cached, so the next hover retries. This is pinned in Task 2.
5. **Clicking the link while the card is open** still navigates, and the row does not toggle (`stopPropagation` stays on the links). This is pinned in Task 3.

---

### Task 1: API — `GET /containers/{id}/position`

**Files:**
- Modify: `api/src/serversherpa/assets/placement.py` (add `Position` and `container_position`)
- Modify: `api/src/serversherpa/api/schemas.py` (add `ContainerPositionOut` near `ContainerItem`)
- Modify: `api/src/serversherpa/api/routes/containers.py` (add the route after `get_container`, at about line 170)
- Test: `api/tests/test_container_position.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class Position: kind: Literal["truck","site","none"]; name: str | None = None; lat: float | None = None; lng: float | None = None; recorded_at: datetime | None = None; approximate_address: str = ""`
  - `async def container_position(db: AsyncSession, container: Container, access: AccessInfo, person_id: uuid.UUID) -> Position`. The container has already been loaded, and it has already passed the container gate.
  - `class ContainerPositionOut(BaseModel)` has the same fields. Coordinates are `float | None`.
  - Route: `GET /containers/{container_id}/position` → `ContainerPositionOut`. It needs `require_permission("containers", "view")`. It returns 404 `container_not_found` when the container is missing, archived, or outside `scope_conditions("containers")`.
- Task 2 relies on the JSON: `{"kind","name","lat","lng","recorded_at","approximate_address"}`.

**Rules for `container_position`, checked in order:**
1. **The truck step** runs if `access.can("trucks","view")`. Find the container's latest non-archived truck in scope: order by `TruckContainer.added_at DESC, Truck.id`, the same as `asset_placements`.
   - If there is one, return `kind="truck"` with that truck's name. The coordinates and time come from its newest `TruckUpdate` where `lat IS NOT NULL AND lng IS NOT NULL` (order by `recorded_at DESC, id DESC`, limit 1).
   - If the truck has no such report, return `kind="truck"` with the name and null coordinates and time.
2. **The site step** runs if `container.site_id` is set and `access.can("sites","view")`. Load the site under `scope_conditions("sites")`.
   - If it has both `latitude` and `longitude`, return `kind="site"` with the site name and `float()` coordinates.
3. **Otherwise** return `Position(kind="none")`.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_container_position.py`.
  - Reuse `_staff`, `_asset`, `_box` and `_truck` (and `T0`, `PID`) from `.test_asset_placement`, and `login` from `.test_assets_api`.
  - Add a local `_site(db, name="ATL1", lat=33.75, lng=-84.39)` helper and a `_report(db, truck, minutes, lat, lng, address="")` helper. The second inserts a `TruckUpdate` with `location=f"{lat}, {lng}"` and `recorded_at=T0+timedelta(minutes=minutes)`.
  - Use `FULL = _staff(containers=1, trucks=1, sites=1)`.
  - Tests and assertions:
    - `test_truck_with_report`: a box on a truck with a report `(1, 33.1, -84.2, "I-85 N")` gives `Position("truck", "Truck 1", 33.1, -84.2, T0+1min, "I-85 N")`.
    - `test_truck_uses_newest_report_with_coordinates`: a report at minute 1 with coordinates, then one at minute 5 with `lat=lng=None`, gives the minute-1 coordinates and time.
    - `test_truck_without_report_does_not_fall_back_to_site`: the box has a site with a pin and a truck with no reports. The result is `Position("truck", "Truck 1")`.
    - `test_latest_truck_wins`: two trucks, added at minutes 0 and 10. The name is the minute-10 truck's.
    - `test_archived_truck_falls_to_site`: the only truck is archived and the box has a site with a pin, so `kind == "site"` and the name is the site's.
    - `test_without_trucks_view_falls_to_site`: `_staff(containers=1, sites=1)` with a box on a truck and a site gives `kind == "site"`, and the result has no truck name anywhere.
    - `test_site_pin`: no truck, a site at `(33.75, -84.39)`, gives `Position("site", "ATL1", 33.75, -84.39)`.
    - `test_site_without_pin_is_none`: a site with `latitude=None` gives `Position("none")`.
    - `test_without_sites_view_is_none`: `_staff(containers=1, trucks=1)`, no truck, site with a pin, gives `Position("none")`.
    - `test_no_truck_no_site_is_none`: gives `Position("none")`.
    - `test_route_returns_position(client, db, seeded_user)`: as the logged-in admin, `GET /containers/{id}/position` returns 200 and `{"kind": "site", "name": "ATL1", "lat": 33.75, "lng": -84.39, "recorded_at": None, "approximate_address": ""}`.
    - `test_route_404_for_missing_and_archived(client, db, seeded_user)`: a random uuid and an archived container both return 404 with `detail.code == "container_not_found"`.
    - `test_route_client_user_forbidden(client, db, seeded_user)`: a client contact made via `_client_contact` gets 403 or 404, never 200. Assert `status_code in (403, 404)`.

- [ ] **Step 2: Run and see them fail**

  Run: `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_lochover .venv/bin/pytest tests/test_container_position.py -q`

  Expected: errors on importing `container_position` / `Position`.

- [ ] **Step 3: Implement**
  - Add `Position` and `container_position` in `placement.py`, following the rules above and the `asset_placements` query style. Add one line to the module docstring about the new helper.
  - Add the `ContainerPositionOut` schema.
  - Add the route. Load the container with `_get_container`, then return 404 if it is archived or fails `scope_conditions("containers", actor.access, actor.person.id)` (check with a `select(Container.id).where(Container.id == id, cond)`). Then return `ContainerPositionOut(**asdict(pos))`.

- [ ] **Step 4: Run and see them pass**

  Run the same command, then `tests/test_asset_placement.py tests/test_containers_api.py -q`.

  Expected: all pass.

- [ ] **Step 5: Commit**

  `git add api/src/serversherpa/assets/placement.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/containers.py api/tests/test_container_position.py && git commit -m "feat(api): GET /containers/{id}/position — truck GPS, site pin, or none"`

---

### Task 2: Portal — position client, cache and `LocationMapPreview`

**Files:**
- Modify: `portal/src/lib/api.ts` (add the `ContainerPosition` type and `getContainerPosition` next to the container functions)
- Create: `portal/src/lib/containerPosition.ts` (the cache and display text)
- Create: `portal/src/components/assets/LocationMapPreview.tsx`
- Create: `portal/src/styles/location-map-preview.css` (class prefix `lmp-`)
- Test: `portal/src/lib/containerPosition.test.ts`, `portal/src/components/assets/LocationMapPreview.test.tsx`

**Interfaces:**
- Consumes: the Task 1 JSON, plus `previewPosition` and `PREVIEW_DELAY_MS` exported from `components/PhotoPreview.tsx`.
- Produces:
  - `export interface ContainerPosition { kind: 'truck' | 'site' | 'none'; name: string | null; lat: number | null; lng: number | null; recorded_at: string | null; approximate_address: string }`
  - `export async function getContainerPosition(id: string): Promise<ContainerPosition>`, built with `apiFetch` / `errorFrom` like `getTruck`.
  - `export const POSITION_TTL_MS = 60_000;`
  - `export function loadContainerPosition(id: string, now = Date.now()): Promise<ContainerPosition>`. It caches the in-flight promise and then the value per id for `POSITION_TTL_MS`. A rejection deletes the entry.
  - `export function clearPositionCache(): void`, for tests.
  - `export function positionLines(p: ContainerPosition, nowMs = Date.now()): { title: string; detail: string; note: string | null }`. The exact copy:
    - truck with coordinates: title = the truck name, detail = `Last report ${HH:MM} · ${relativeTime(recorded_at)}`, plus `` ` · ${approximate_address}` `` when it isn't empty, and note = null
    - truck without coordinates: title = the name, detail = `''`, note = `` `${name} hasn't reported a position yet` ``
    - site: title = the name, detail = `Site location, not a live position`, note = null
    - none: title = `''`, detail = `''`, note = `No known position`
  - HH:MM is `new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })`.
  - `export default function LocationMapPreview({ containerId, children }: { containerId: string; children: ReactNode })`.

**`LocationMapPreview` behavior.** Copy the `PhotoPreview` mechanics:
- Children are wrapped in a `display: contents` `span.lmp-wrap`, and the card anchors off the first element child's rect.
- It opens after `PREVIEW_DELAY_MS`.
- It closes on mouse leave, scroll (capture), Escape and unmount.
- The card is portaled into `.closest('.portal-shell') ?? document.body` and has `pointer-events: none`.
- It never stops events.

On top of those mechanics:
- **Keyboard:** it also opens on `onFocus` and closes on `onBlur`. Both bubble in React, so focusing the wrapped link works.
- **Fetching:** the fetch starts only when the delay elapses, with `loadContainerPosition(containerId)`.
- **Card contents:**
  - while loading: `Loading position…`
  - on error: `Couldn't load the position`
  - otherwise: `positionLines`
- **The map:** a 280 × 160 px box, shown only when `lat`/`lng` are non-null.
  - It's a `MapContainer` with `center=[lat,lng]`, `zoom={12}`, and `zoomControl`, `dragging`, `scrollWheelZoom`, `doubleClickZoom`, `touchZoom`, `boxZoom` and `keyboard` all false.
  - Tiles are `MAP_TILE_URL`/`MAP_TILE_ATTRIBUTION`, with one `CircleMarker` of radius 7.
  - The marker's `pathOptions` classes are `lmp-pin-truck` for a truck and `lmp-pin-site` for a site, colored in CSS with `--c-blue` and `--c-green`.
- **Layout:** the title (`.lmp-title`) goes above the map, and the detail (`.lmp-detail`) or note (`.lmp-note`, muted) below it.
- **Position:** the card size estimate for `previewPosition` is `EST_W = 296`, `EST_H = 230`. It's re-measured in a layout effect, as in `PhotoPreview`.
- **CSS:** `.lmp-card` uses `position: fixed`, `z-index: 1200`, `padding: 8px`, `border: 1px solid var(--paper-line)`, `border-radius: 14px`, `background: var(--surface, #fff)` and the `.pp-card` shadow. The map box gets `border-radius: 10px; overflow: hidden`.

- [ ] **Step 1: Write the failing tests**
  - **`containerPosition.test.ts`:** mock `./api`'s `getContainerPosition`.
    - `it('makes one request per container within a minute')`: two `loadContainerPosition('c1')` calls give 1 request. A call at `now + POSITION_TTL_MS + 1` gives 2.
    - `it('does not cache a failure')`: the first call rejects, the second resolves, and there are 2 requests.
    - `it('words each kind')`: the four `positionLines` cases with the exact strings above.
      - Use `recorded_at` = 2026-11-17T14:32:00 local and `nowMs` 3 hours later.
      - Expect `detail === 'Last report 14:32 · 3h ago · I-85 N'`.
      - Truck without coordinates gives `note === "Truck 1 hasn't reported a position yet"`.
  - **`LocationMapPreview.test.tsx`:** jsdom, with react-leaflet mocked as in `TrucksMap.test.tsx`: `MapContainer` → `<div data-testid="map" data-center=...>`, `CircleMarker` → `<div className={pathOptions.className}>`, `TileLayer` → null. Use fake timers with `shouldAdvanceTime`, and mock `../../lib/containerPosition`'s `loadContainerPosition`.
    - `it('fetches nothing before 300 ms and nothing on a quick pass')`: mouseenter and then mouseleave at 200 ms make 0 calls.
    - `it('shows the truck map after the delay')`: after the delay, the card is inside `.portal-shell`, the map is centered on `33.1,-84.2`, there's an `.lmp-pin-truck` marker, and the title is `Truck 1`.
    - `it('shows a note and no map for a truck with no report')`.
    - `it('labels a site pin')`: `Site location, not a live position` with an `.lmp-pin-site` marker.
    - `it('shows the error line when loading fails')`: `Couldn't load the position`.
    - `it('opens on focus and closes on blur')`.
    - `it('closes on leave, scroll and Escape')`.
    - `it('does not stop clicks on the wrapped link')`: a parent `onClick` spy still fires once.

- [ ] **Step 2: Run and see them fail**

  Run: `cd portal && npx vitest run src/lib/containerPosition.test.ts src/components/assets/LocationMapPreview.test.tsx`

  Expected: FAIL, with the modules not found.

- [ ] **Step 3: Implement** the API function, the cache module, the component and the CSS, as specified above.

- [ ] **Step 4: Run and see them pass**

  Run the same command, then `npx vitest run src/styles` (the guardrails).

  Expected: all pass.

- [ ] **Step 5: Commit**

  `git add portal/src/lib/api.ts portal/src/lib/containerPosition.ts portal/src/lib/containerPosition.test.ts portal/src/components/assets/LocationMapPreview.tsx portal/src/components/assets/LocationMapPreview.test.tsx portal/src/styles/location-map-preview.css && git commit -m "feat(portal): LocationMapPreview hover card with cached container position"`

---

### Task 3: Portal — wire it into `AssetLocation` and the initiative assets list

**Files:**
- Modify: `portal/src/components/assets/AssetLocation.tsx`
- Modify: `portal/src/pages/InitiativeDetail.tsx:744`
- Test: `portal/src/components/assets/AssetLocation.test.tsx`

**Interfaces:**
- Consumes: `LocationMapPreview` from Task 2.
- Produces: `AssetLocation({ asset, className, mapPreview }: { asset: AssetLocationAsset; className?: string; mapPreview?: boolean })`.
  - When `mapPreview` is set and `container_id` is present, both the container `Link` and the truck `Link` are each wrapped in `<LocationMapPreview containerId={container_id}>`.
  - Without the prop, the output is unchanged.
  - Plain-text locations never get a preview.
- Update the component's doc comment to mention the prop.

- [ ] **Step 1: Write the failing tests** (add to `AssetLocation.test.tsx`, with `./LocationMapPreview` mocked to `({children}) => <span data-testid="lmp">{children}</span>`):
  - `it('wraps the container and truck links when mapPreview is on')`: there are 2 `lmp` wrappers and `textContent` is unchanged (`'ATL1-W1M-DC-01 · on ATL1-T01 (Wave 1)'`).
  - `it('adds no preview without the prop or without a container')`: there are 0 `lmp` wrappers.
  - `it('link clicks still stop propagation with mapPreview on')`: a parent `onClick` spy is not called when the container link is clicked.
  - The existing tests pass unchanged.

- [ ] **Step 2: Run and see them fail**

  Run: `cd portal && npx vitest run src/components/assets/AssetLocation.test.tsx`

  Expected: the new tests fail.

- [ ] **Step 3: Implement** the prop. In `InitiativeDetail.tsx`, line 744 becomes `<AssetLocation asset={a.asset} className="cell-top cell-line" mapPreview />`.

- [ ] **Step 4: Run the portal suite**

  Run: `cd portal && npx vitest run && npx tsc -b`

  Expected: all pass, with no type errors.

- [ ] **Step 5: Commit**

  `git add portal/src/components/assets/AssetLocation.tsx portal/src/components/assets/AssetLocation.test.tsx portal/src/pages/InitiativeDetail.tsx && git commit -m "feat(portal): hover map on container/truck locations in the initiative assets list (SS-531)"`
