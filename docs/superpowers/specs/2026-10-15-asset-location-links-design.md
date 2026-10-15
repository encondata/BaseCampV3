# Asset location links — design

**Date:** 2026-10-15
**Branch:** `asset-placement`
**Ask:** a team member, relayed by Jimmy — when an asset sits in a container
(or that container is on a truck), its Location should be a link to that
container / truck instead of plain text.

## Jimmy's decisions (2026-10-15)

- The link comes from the asset's **actual container** (the `container_assets`
  row), not from the location text.
- When the container is on a truck, Location shows **both, each linked**:
  `ATL1-W1M-DC-01 · on ATL1-T01 (Wave 1)`.
- A container link opens the **Containers list with that row expanded**
  (`/logistics/containers?open=<id>`) — there is no container detail page.
- **Every screen that shows an asset's location**: Assets list (column and
  expanded row), asset detail page, move asset page, move rosters (initiative
  page and Move dashboard), Warehouse asset rows.

## Facts this builds on

- An asset's location is free text, `assets.location_detail`. The status rule
  action `set_asset_location_from_container` writes the bare container name
  into it; no writer ever puts a truck there.
- Structure: `container_assets.asset_id` is unique (an asset is in at most one
  container); `truck_containers (truck_id, container_id)` puts a container on a
  truck (the kiosk and portal treat it as one truck).
- Containers and trucks are global-only resources: `scope_conditions` returns
  `sa.false()` for non-global actors (no client/partner scope columns).
- `/logistics/containers?open=<id>` opens that row (`initialOpenId`, read on
  page load). `/logistics/trucks/:id` is the truck page.
- Bug: TruckDetail links its containers as `/logistics/containers?focus=<id>`,
  which the Containers page ignores.

## API

New module `api/src/serversherpa/assets/placement.py`:

```python
@dataclass(frozen=True)
class Placement:
    container_id: uuid.UUID
    container_name: str
    truck_id: uuid.UUID | None = None
    truck_name: str | None = None

async def asset_placements(db, asset_ids, access, person_id) -> dict[uuid.UUID, Placement]
```

- Container: the asset's `container_assets` row joined to `containers`,
  skipping archived containers. Included only when
  `access.can("containers", "view")` and the container passes
  `scope_conditions("containers", access, person_id)` (applied in the query).
- Truck: the container's `truck_containers` row joined to `trucks`, skipping
  archived trucks; if more than one, the latest `truck_containers.added_at`.
  Included only when `access.can("trucks", "view")` and the truck passes
  `scope_conditions("trucks", …)`. A truck is only reported alongside a
  visible container.
- Set-based: at most two queries however many assets (no per-asset lookups).
  Empty `asset_ids` → `{}` with no query.

Response fields — `container_id`, `container_name`, `truck_id`, `truck_name`
(all optional, default `None`) added to:

- `AssetItem` — `GET /assets`, `GET /assets/{id}`, create, PATCH (routes/assets.py
  `_context`/`_detail` gain the actor).
- `InitiativeAssetSummary` — every `_initiative_asset_rows` caller
  (routes/initiatives.py), which gains the actor.
- `AssetRef` — Warehouse inventory (routes/warehouse.py `_asset_ref`).

`location_detail` is unchanged everywhere.

## Portal

- `lib/api.ts`: the four optional fields on `AssetItem`, `InitiativeAssetSummary`
  (TS name as used there) and `AssetRef`.
- `lib/assets.ts`: `placementText(p)` — `"<container> · on <truck>"`,
  `"<container>"`, or the location text (`'—'` handled by callers as today).
  Sort, filter/search and CSV for every Location column use it, so they match
  what is shown.
- New `components/assets/AssetLocation.tsx`: renders the container name as a
  `<Link to="/logistics/containers?open=<id>">`, then ` · on ` and the truck
  name as a `<Link to="/logistics/trucks/<id>">`; without a container it
  renders the location text (or `—`). Same cell classes as the text it
  replaces. Clicks inside list rows must not toggle the row
  (`stopPropagation`).
- Used in: Assets list Location column + expanded row; AssetDetail;
  MoveAssetDetail; the move roster Location cell (InitiativeDetail and
  MoveDashboard, `lib/initiatives.ts` text via `placementText`); Warehouse
  asset rows (loose assets can be in another site's container or on a truck).
- TruckDetail container links → `/logistics/containers?open=<id>`.

Out of scope: scan history Location columns (the place a *scan* happened, not
where the asset is now), the containers' own Location, a container detail
page, writing truck names into `location_detail`.

## Testing

API (`tests/test_asset_placement.py` plus additions to the assets, initiative
assets and warehouse route tests): asset in a container on a truck; container
only; no container; archived container skipped; archived truck skipped; two
trucks → latest; a client/partner actor gets none of the fields; staff without
`trucks:view` get the container only; query count flat as assets grow;
the three responses carry the fields.

Portal: `placementText`; `AssetLocation` renders both links, container only,
and text fallback; each screen shows the links; sort/search/CSV use the shown
text; TruckDetail link uses `?open=`.

Live check on the dev stack: asset 102466 (`atl1-web-001`) is in container
ATL1-W1M-DC-01, which is on truck ATL1-T01 (Wave 1) — Location should read
`ATL1-W1M-DC-01 · on ATL1-T01 (Wave 1)` with both links working.
