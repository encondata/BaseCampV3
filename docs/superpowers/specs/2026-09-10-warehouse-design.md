# Warehouse — per-site inventory of containers, tagged assets, and counted stock

**Date:** 2026-09-10 · **Status:** approved (Part 1 in conversation; Part 2 per
the choices made during brainstorming) · **Route:** `/logistics/warehouse`
(replaces the placeholder) · **Resource:** `warehouse`

## Purpose

We store equipment at several sites that act as warehouses: pallets, crates,
D-containers, and loose shelf stock. Some of it is tracked as tagged assets
(serial / RFID, one row per unit); much of it is only ever a count ("24
PDUs", "6 spools of Cat6"). Today the portal can only show tagged assets and
containers, so the count-only stock is invisible. The Warehouse page shows,
for one warehouse at a time, everything that is there — containers with
their contents, loose tagged assets, and counted **stock lines** — and lets
staff add, adjust, and move stock. Pick / ship lists (tag items to pull from
a warehouse and send to a real site) are a follow-up spec built on this
inventory.

Decisions made during brainstorming: v1 is the inventory view only; stock
lines are free text + optional catalog model; stock and assets may sit in a
container or loose at the site; the page is "pick a warehouse, then its
inventory" with summary tiles and one standard list whose container rows
expand to show contents.

## Data (migration 0050)

Nothing changes on `assets`, `containers`, or `container_assets`. A
warehouse **is** a site whose `site_type = 'warehouse'` (the vocabulary
already has it).

### `stock_lines`

| column | type | notes |
|---|---|---|
| id | uuid pk | `gen_random_uuid()` |
| site_id | uuid → sites, NOT NULL | must be a site typed `warehouse` at write time (422 `site_not_warehouse`) |
| container_id | uuid → containers, nullable | when set, the container must be at the same site (422 `container_not_at_site`); `ON DELETE SET NULL` |
| model_id | uuid → asset_models, nullable | optional catalog link; `ON DELETE SET NULL` |
| description | text NOT NULL | free text, e.g. "PDU, 30A vertical"; required even when a model is linked (defaults in the UI to "Make Model") |
| quantity | integer NOT NULL, CHECK ≥ 0 | |
| unit | text NOT NULL default `'each'` | free text; the UI offers each / box / pallet / spool / roll / bag / case as suggestions |
| location_detail | text NOT NULL default `''` | "Rack 3, shelf B" |
| notes | text NOT NULL default `''` | |
| source | text NOT NULL default `'manual'` | |
| created_by | uuid → people, nullable | |
| created_at / updated_at | timestamptz | `now()` |
| archived_at | timestamptz, nullable | archive instead of delete |

Indexes: `stock_lines_site_idx (site_id)`, `stock_lines_container_idx
(container_id)`, `stock_lines_model_idx (model_id)`.

### Vocabulary

`status_values` gains three `container_type` rows (idempotent insert):
`pallet` "Pallet" #a36207, `crate` "Crate" #6d4fc4, `d_container`
"D-container" #0f7c86, sorted after the existing three. Editable on the
variables page like any vocabulary.

### Resource and grants

`Resource("warehouse", "Warehouse", routes=("/logistics/warehouse",),
visible_to={"global"})` after `trucks` in `access/resources.py`; FULL for
developer / founder / super_admin / admin / staff in `access/defaults.py`
and in the migration's grant rows (mirror 0049). Pinned sets in
`test_access_registry.py` gain `warehouse`.

### Models

`StockLine` appended after `TruckUpdate` in `db/models.py`, mirroring the
column table above (`archived_at`, `created_by`, relationships to Site,
Container, AssetModel lazy). No `status` column and no status vocabulary —
a stock line's only state is its quantity (0 is allowed: "we are out")
and whether it is archived.

## API (`routes/warehouse.py`, prefix `/warehouse`)

All endpoints gated `warehouse:view` / `warehouse:change` /
`warehouse:add` / `warehouse:delete` via `require_permission`. Global-only
resource, so no row scope.

- `GET /warehouse/sites` → `WarehouseSiteOut[]`: every non-archived site
  with `site_type = 'warehouse'`, name asc, with counts: `container_count`,
  `asset_count` (assets whose `site_id` is the site and `archived_at IS
  NULL`, whether loose or in a container), `stock_line_count` (active
  lines), `stock_units` (sum of active quantities). Fields: id, name, code,
  city, region, status/status_label/status_color, the four counts.
- `GET /warehouse/{site_id}/inventory` → `WarehouseInventoryOut`:
  - `site`: the `WarehouseSiteOut` above (404 `site_not_found`; 422
    `site_not_warehouse` if the site isn't typed warehouse).
  - `containers[]`: non-archived containers with `site_id = site`, each
    `{id, name, rfid_tag, container_type, type_label, type_color, status,
    status_label, status_color, location_detail, assets[], stock[]}` where
    `assets[]` are the container's linked non-archived assets (`AssetRef`:
    id, legacy_id, serial_number, name, model_name, status, status_label,
    status_color) and `stock[]` are the active stock lines whose
    `container_id` is that container.
  - `loose_assets[]`: `AssetRef` for non-archived assets at the site that
    are NOT linked to any container at the site.
  - `loose_stock[]`: active stock lines at the site with `container_id IS
    NULL`.
  - Sorted: containers by name (natural), assets by name/serial, stock by
    description. Built with set-based queries (one per kind), never per-row
    lookups.
- `POST /warehouse/stock` (`StockLineCreateIn`: site_id required, container_id,
  model_id, description required non-blank, quantity ≥ 0, unit default
  "each", location_detail, notes; `extra="forbid"`) → 201 `StockLineOut`.
  Validation: site exists and is a warehouse; container (if any) exists,
  non-archived, and is at that site; model (if any) exists (404
  `model_not_found`). Audit `entity_type="stock_line"`, action `create`.
- `PATCH /warehouse/stock/{id}` (`StockLineUpdateIn`: every field optional,
  `extra="forbid"`, exclude_unset; `description`/`quantity`/`unit` reject
  explicit null with 422 `<field>_required`; `container_id: null` means
  "make loose"; changing `site_id` or `container_id` re-runs the same
  placement checks) → `StockLineOut`. Audit `update` with the standard
  `diff()` of before/after so quantity changes show from → to.
- `POST /warehouse/stock/{id}/archive` and `/unarchive` → 204 (mirror
  containers).
- `StockLineOut`: id, site_id, site_name, container_id, container_name,
  model_id, model_make, model_model, description, quantity, unit,
  location_detail, notes, archived_at, created_at, updated_at.

Error codes: `site_not_found`, `site_not_warehouse`, `container_not_found`,
`container_not_at_site`, `model_not_found`, `description_required`,
`quantity_required`, `unit_required`, `quantity_invalid` (negative —
pydantic `ge=0` surfaces as the standard 422 shape; the portal maps it),
`stock_line_not_found`, `forbidden`.

Moving tagged assets or editing containers from this page uses the existing
`/assets` and `/containers` endpoints and their permissions — the warehouse
API never writes those tables.

## Portal

Follow the portal idioms (`.dir-search`, `.org-select`, `.segmented`,
chips, `RowActionsMenu`, `.pf-form`, `ComboBox`, modals sized to content —
never raw native controls) and the list-typography rule (tokens and
primitives only; no typography in page CSS).

- `lib/api.ts`: `WarehouseSite`, `WarehouseInventory`, `WarehouseContainer`,
  `AssetRef`, `StockLine`; `listWarehouseSites`, `getWarehouseInventory`,
  `createStockLine`, `updateStockLine`, `archiveStockLine`.
- `lib/warehouse.ts`: `flattenInventory(inv)` → the list rows (see below),
  `inventorySearchText(row)`, `inventoryCellText(row, colKey)`,
  `STOCK_ERRORS`, `formFromStockLine`, `stockPayload`, `UNIT_SUGGESTIONS`,
  `modelLabel(m)`.
- `pages/Warehouse.tsx` (`/logistics/warehouse`, page key `warehouse`):
  - Page hint + **warehouse selector**: an `.org-select`-style dropdown of
    warehouse sites ("ACC4 Storage · 12 containers · 480 units"); the
    chosen site id persists in `localStorage` (`warehouse.site`) and in the
    URL `?site=` so links deep-link. Empty state when no site is typed
    Warehouse: "No sites are typed Warehouse yet." with a link to Sites.
  - **Summary tiles** (existing dashboard tile idiom): Containers, Tagged
    assets, Stock lines, Units in stock.
  - **Inventory list** — the standard directory list with
    `usePersistentListState('warehouse', …)`, `.dir-search` filter,
    `ColumnMenu`, `VirtualRows`, export. Rows are a flattened tree:
    - container rows (kind `container`): primary = name (`.pn b`) + type
      chip; columns Kind (chip: Container), Model / Type, Qty (mono: number
      of assets + stock units inside, e.g. "3 assets · 40 units"), Location
      (cell-sub), Status (chip), Updated (mono). Expanding a container row
      shows its contents as a **mini list** (`mini-list`/`mini-row`): one
      row per asset (serial/name, model, status chip) and per stock line
      (description, qty × unit, model), each with its own Edit action.
    - loose asset rows (kind `asset`): primary = serial or name, columns
      Kind chip "Asset", Model, Qty "1", Location, Status chip.
    - loose stock rows (kind `stock`): primary = description, Kind chip
      "Stock", Model (make model or "—"), Qty (mono "24 each"), Location,
      Status "—".
    - A `.segmented` kind filter above the list: All / Containers / Assets /
      Stock. "Show archived" is NOT offered in v1 (archived lines are hidden).
    - `RowActionsMenu` per row: container → Edit (opens the existing
      `ContainerEditModal`) and "Open in Containers" (`/logistics/containers?focus=`);
      asset → Edit (existing `AssetEditModal`) and "Open in Assets";
      stock → Edit, Move (a small `.pf-form` modal: container ComboBox
      limited to this warehouse's containers plus "Loose at site"), Archive
      (confirm).
  - Toolbar: `+ Add stock` (opens `StockLineModal`), `+ New container`
    (existing `ContainerEditModal` with the site preselected), Columns,
    Export.
  - Non-blanking refetch after every write; errors mapped via
    `STOCK_ERRORS[code] ?? message`.
- `components/warehouse/StockLineModal.tsx` (`.pf-form`, modal sized to
  content): Description (required), Quantity (numeric, ≥ 0), Unit
  (`ComboBox` with `UNIT_SUGGESTIONS`, free text allowed), Model
  (`ComboBox` of `listAssetModels()` "Make Model", clearable; picking a model
  fills a blank Description with "Make Model"), Container (`ComboBox` of the
  warehouse's containers or "Loose at site"), Location detail, Notes. The
  site is fixed to the selected warehouse (shown read-only in the header).
- Nav: the Logistics "Warehouse" item's `resource` → `warehouse`;
  CommandPalette `navGated('Warehouse', '/logistics/warehouse', 'warehouse')`.
- `styles/warehouse.css`: layout only (selector row, tiles grid, nested
  mini-list indent, modal widths).

## Seed

`serversherpa seed-demo-warehouse` (idempotent by name): if no site is typed
`warehouse`, creates "Demo Warehouse (Ashburn)"; creates containers
"Pallet A-01" (pallet), "Crate C-07" (crate), "D-Container D-02"
(d_container) at that site; stock lines: 24 × "PDU, 30A vertical" (each, on
Pallet A-01), 6 × "Cat6 patch, 10 ft" (box, in Crate C-07), 40 × "Cage nuts
M6" (bag, loose, "Shelf B"), 2 × "Rack PDU (spare)" linked to any existing
asset model whose category is `pdu`/`power` when present (loose). No assets
are created or moved.

## Testing

- API: model/migration test (table, check constraint, FK set-null on
  container delete, vocabulary rows, grants); routes test (sites counts,
  inventory shape incl. a container with an asset + a stock line and loose
  items, placement validation errors, PATCH null rejection, quantity 0 ok,
  negative 422, archive hides, permissions 403 for a worker); seed test
  (idempotent, counts).
- Portal: `lib/warehouse.test.ts` (flatten/search/cell text/payload);
  `pages/Warehouse.test.tsx` (selector picks a site and loads inventory,
  tiles, kind filter, expand a container shows contents, add stock posts
  and refetches, error copy); `StockLineModal.test.tsx` (required
  description, model fill-in, payload shape with `container_id: null` for
  loose). Typography guardrail green with no new allowlist entries.
- Live: dev DB `alembic upgrade head` + `seed-demo-warehouse`, verify on the
  worktree servers (5174 / 8001).

## Out of scope (follow-ups)

Pick / ship lists; inbound / outbound receiving flows; transfer requests;
movement history beyond the audit log; converting a stock line into N
tagged assets; per-warehouse bins/zones; archived-line browsing;
client/partner visibility.
