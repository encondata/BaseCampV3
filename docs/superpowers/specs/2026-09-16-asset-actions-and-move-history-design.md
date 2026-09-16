# Asset list actions menu and asset move history

**Date:** 2026-09-16 · **Status:** approved (Jimmy, 2026-09-16: consolidate the list's Edit into an inline Actions menu visible while collapsed; asset page gets Overview/History tabs; move history stays compact, rack and RU detail behind the link) · **Branch:** `user-detail` (worktree off `main` @ ad84c30)

## Problem

Two gaps on `/assets`.

**The list buries its only action.** The row expansion ends in a `detail-actions` strip whose sole interactive control is an Edit button, so editing an asset costs a row click first. The Users list solved the same problem on 2026-09-16 with a shared `RowActionsMenu` in its own column, visible while the row is collapsed. Assets should match.

**Nothing reaches the detail page, and it is missing half the history.** `/assets/:assetId` already exists (`portal/src/pages/AssetDetail.tsx`) with identity, location and status, notes and files, and scan history, but no page links to it — it is reachable only by typing the URL. It also carries no move history, even though `initiative_assets` records every move roster the asset has appeared on, with source and destination rack, RU, verification flags and disposition. An asset's two histories are scanning and moving; the page tells only half the story.

## Design

### Assets list — `portal/src/pages/Assets.tsx`

Mirrors the Users list exactly, so the two directories behave the same way.

- `grid.gridTemplateColumns` gains a fixed `100px` actions column before the trailing `30px` chevron, and `.list-head` gains a matching empty `col-head` slot.
- Each row renders `<RowActionsMenu actions={rowActions(asset)} />` (`portal/src/components/hardware/RowActionsMenu.tsx`) in that cell, inside a wrapper whose `onClick` calls `stopPropagation` so the trigger never toggles the expansion. The menu portals to `document.body`, so its item clicks never reach `row-main`.
- `rowActions(asset)` returns, in order: **Full details** → `/assets/${asset.id}`, always; **Edit** → opens `AssetEditModal`, only when `can('assets','change')`. A viewer with neither still gets Full details, so the trigger is never empty.
- `AssetRowDetail` loses its Edit button. It keeps Identity, Location & ownership, Notes & Files and the god-mode delete. The `detail-actions` block renders only when `godVisible`, since the delete becomes its only occupant; the `canEdit` branch and the `onEdit` prop go away.

The god delete deliberately stays its own control rather than joining the menu, matching the Users list.

### Asset page — `portal/src/pages/AssetDetail.tsx`

- Routes: `/assets/:assetId` (Overview) and `/assets/:assetId/history` (History), both `ProtectedRoute resource="assets"`, one element with the tab derived from the path exactly as `UserDetail` does.
- A `segmented` tab strip sits directly under the existing `idet-header`, keeping the page's current initiative-detail chrome rather than restyling it.
- **Overview** keeps today's three panels unchanged: Identity, Location & status, Notes & Files.
- **History** holds a new Move history panel above the existing `ScanHistoryTable`. Both are `init-panel` blocks with an `eyebrow-sm` heading, matching the page.
- The header's Edit button stays where it is on both tabs.

**Move history table** (`DataTable`, `ariaLabel="Move history"`), one row per `initiative_assets` row, newest scheduled first:

| Column | Content |
|---|---|
| Move | initiative name, linking to `/initiatives/{initiative_id}` |
| Status | the move's own status chip |
| Asset status | this asset's status on that move (`initiative_assets.status`) |
| Scheduled | the move's `scheduled_start` to `scheduled_end` |
| (action) | `mini-btn` "Open move row" → `/initiatives/{initiative_id}/assets/{row_id}` |

Rack, RU, verification, disposition, wave, owner and cable info are deliberately absent; that detail lives on the move row page the action opens.

`scheduled_start` and `scheduled_end` are date-only values stored at midnight UTC. They must render through `parseApiDay` (`portal/src/lib/timeline.ts`) fed into `longDateOf` (`portal/src/lib/format.ts`), the pairing `InitiativeHoverCard.tsx:78` already uses. Plain `longDate` names the previous day for anyone west of UTC. A row with neither date reads `—`.

Empty state: "This asset has not been on a move."

### API — `api/src/serversherpa/api/routes/assets.py`

**`GET /assets/{asset_id}/moves` → `list[AssetMoveRow]`**, `require_permission("assets", "view")`.

- 404 `asset_not_found` when the asset is missing or outside the caller's asset scope, matching `get_asset`.
- Rows are joined to `initiatives` and filtered by `scope_conditions("initiatives", actor.access, actor.person.id)`. An asset can sit on moves belonging to more than one client, and a client-anchored user must not learn about another client's move through an asset they can see. This is the one security-relevant line in the feature.
- Status labels resolve through `status_labels(db, "initiative")` for the move and `status_labels(db, "asset")` for the roster row, spread with `status_fields`, the same way `initiatives.py` builds its roster payload.
- Order: `scheduled_start` descending with nulls last, then `initiative_assets.created_at` descending, so an unscheduled move still lands in a stable place.

```
AssetMoveRow:
  row_id: uuid                  # initiative_assets.id — the move-row page key
  initiative_id: uuid
  initiative_name: str
  initiative_status: str
  initiative_status_label: str
  initiative_status_color: str
  asset_status: str
  asset_status_label: str
  asset_status_color: str
  scheduled_start: datetime | None
  scheduled_end: datetime | None
  added_at: datetime            # initiative_assets.created_at
```

Portal client: `AssetMoveRow` mirroring it field for field, and `listAssetMoves(assetId)`.

## Error handling

- A failed move-history fetch renders "Could not load move history." with a Retry button inside the panel, leaving the scan history below it untouched.
- An unknown or out-of-scope asset keeps the page's existing "Asset not found" state.
- `/assets/:id/history` for a caller without `scans:view` still shows move history; the scan panel is already gated on that permission and stays hidden.

## Testing

**API — `api/tests/test_asset_moves_api.py` (new), real Postgres:**

- An asset on two initiatives returns both rows, newest scheduled first, with the move name, both status labels and the roster row id.
- An asset on no initiative returns `[]`.
- Unknown asset id → 404 `asset_not_found`.
- A client-anchored actor holding `assets:view` sees only the moves belonging to their own client, even when the asset sits on two clients' moves. This is the scope test and must assert the other client's move is absent, not merely that the call succeeds.
- A row whose initiative has no scheduled dates still returns, with nulls.

**Portal:**

- `AssetDetail.test.tsx` (new): both tabs render; Overview shows Identity and not the history panels; History shows move history and scan history; a move row links to the initiative and its action to `/initiatives/{id}/assets/{rowId}`; the empty state renders; a failed fetch offers Retry.
- `Assets.test.tsx`: the collapsed row exposes an Actions trigger; the menu lists Full details and Edit; Full details navigates to `/assets/:id`; Edit opens the modal; clicking the trigger does not expand the row; a read-only actor's menu holds Full details alone.
- The list typography guardrail stays green; any new CSS is layout only.

**Live verification** on the dev stack: open `/assets`, use the Actions menu on a collapsed row to reach a detail page, confirm both tabs, and check an asset that appears on the seeded move initiative shows its roster row with working links in both directions.

## Out of scope

- Restyling the asset page to the `/me` hero chrome; it keeps its initiative-detail header.
- Editing move roster fields from this page; the move row page owns that.
- Adding an asset to a move from here.
- Any change to scan history, which already works.
