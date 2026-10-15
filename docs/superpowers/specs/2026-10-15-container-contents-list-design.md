# Container contents list — design

**Date:** 2026-10-15
**Branch:** `container-contents`

## Goal

On /logistics/containers, a container's expanded row lists its contents as
plain `serial — name · status` lines. Make it a standard list like the Assets
list: searchable, sortable, filterable, with a Columns menu, saved column
choices and CSV export.

## Jimmy's decisions (2026-10-15)

- The list stays **in the container's expanded row** (no container page).
- **Default columns, in this order:** Asset ID, RFID, Name, Serial, Make / Model.
  More columns can be added from the Columns menu, like other lists.
- **Clicking a row opens the asset's page** (`/assets/:id`).

## API

- New module `api/src/serversherpa/assets/items.py` with
  `async def asset_items(db, assets, actor) -> list[AssetItem]` — the single
  builder of `AssetItem` (status/model/client/site lookups and the placement
  fields), moved out of `routes/assets.py` (`_context`/`_item`/`_detail`), which
  now calls it. Responses of the asset routes are unchanged.
- `ContainerAssetRow` keeps every current field (`asset_id`, `serial_number`,
  `name`, `model_name`, `status`, `status_label`, `status_color`, `added_at`,
  `added_by_name`) and gains `asset: AssetItem` — the same record `GET /assets`
  returns for that asset. Both `GET` and `POST /containers/{id}/assets` return
  it (`_asset_rows` gains the actor). One `asset_items` call per response, not
  one per row.
- No migration.

## Portal

- **Shared asset columns** — new `portal/src/components/assets/assetColumns.tsx`:
  the Assets list's `COLUMNS`, sort values (`sortValueFor`), CSV columns and the
  read-only cell renderer (everything in `cellFor` except the god-mode editing
  branch and the page-only chips) move here; `pages/Assets.tsx` imports them.
  The Assets list looks and behaves exactly as before.
- **Contents list** — new `portal/src/components/containers/ContainerContentsList.tsx`,
  rendered in place of the Contents `kv` block in `ContainerRowDetail`:
  - Columns: the shared asset columns except the combined `primary`
    (Serial / Name) and god-only ones, plus **Packed** (`added_at`, with
    `added_by_name` as the second line / tooltip). Default visible, in order:
    Asset ID, RFID, Name, Serial, Make / Model.
  - Standard list idioms like the initiative page's Assets roster: `dir-search`
    filter box and result count, `ColHead` sort + column filters,
    `FilterSummaryChip` with Clear, `ColumnsButton` (column choices and order
    saved under their own list key, `container-contents`), `ExportButton`
    (CSV of the visible rows), `listGridStyle` with column floors, natural sort.
  - Row click opens `/assets/:id`.
  - Loading / empty states as today ("Loading…", "No assets in this container.").
- The Edit container dialog's contents list is unchanged.

## Testing

API: `GET`/`POST /containers/{id}/assets` rows carry `asset` equal to the
`GET /assets/{id}` record (incl. placement fields) and keep the old fields;
query count does not grow per row; asset routes' existing tests still pass.

Portal: Assets list tests pass unchanged after the extraction; contents list —
default columns and order, adding a column from the Columns menu, search,
sort, a column filter, CSV export, row click navigates to the asset page,
loading/empty states.
