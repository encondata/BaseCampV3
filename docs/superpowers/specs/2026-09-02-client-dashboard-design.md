# Client Dashboard

**Date:** 2026-09-02
**Branch:** `labels`
**Status:** Approved design

## Purpose

Replace the `/dashboards/clients` placeholder with a professional
client-facing dashboard. Two audiences, one route: internal users pick any
client from a dropdown; client-anchored users (roles `client_owner` /
`client_admin` / `client_viewer`, anchored via `person_roles.client_id`)
land here as their MAIN dashboard and see only data attributed to their
client. **No financials — the system tracks none.** All client-facing
surfaces are read-only by construction (existing server rules).

## Access changes (the substantive API work)

Initiatives become client-visible, per the V2 "client work-history"
direction the code anticipated:

1. `access/resources.py`: the `initiatives` Resource's `visible_to` gains
   `"client"` (comment updated — no longer "internal-only for the first
   slice").
2. `access/scope.py` `SCOPE_COLUMNS` gains
   `"initiatives": {"client": Initiative.client_id}`.
3. `routes/initiatives.py`:
   - `list_initiatives` applies `scope_conditions("initiatives", ...)`
     (None for global actors — behavior unchanged for them).
   - `_get_initiative` gains the scope probe (out-of-scope id → 404, the
     `_get_org`/`_get_asset` pattern) — this transitively protects every
     `/initiatives/{id}/...` read that goes through it (verify the roster
     endpoint `GET /initiatives/{id}/assets` does; make it so if not).
4. `routes/time.py` `GET /time/summary?initiative_id=`: add the same
   scoped-initiative probe — today it accepts any initiative id; once
   client roles hold `initiatives:view` it must 404 for out-of-scope ids.
5. Grants: migration `0044_client_initiatives_grants.py` inserts
   `initiatives:view` for `client_owner`, `client_admin`, `client_viewer`
   (ON CONFLICT DO NOTHING; downgrade deletes those three rows only);
   `access/defaults.py` updated to match. Writes (`add/change/delete`)
   remain ungranted to client roles; mutation endpoints already require
   them.

## New endpoint: `GET /clients/{org_id}/activity`

Gate `require_permission("clients", "view")` + the existing `_get_org`
scope probe (client actors 404 on other orgs). Params `limit`
(default 30, 1–100). Response:

```json
{ "events": [{ "id": "...", "scanned_at": "...", "asset_id": "...",
   "asset_name": "core-sw-01", "serial_number": "C7X-00412-A",
   "status": "in_transit", "status_label": "In Transit",
   "status_color": "#1668a7", "site_name": "NAP11 - Switch",
   "device_id": "dock-reader-1" }],
  "activity_7d": 137 }
```

- Source: `processed_scans` where `archived_at IS NULL` and `asset_id IN
  (SELECT id FROM assets WHERE client_id = :org AND archived_at IS NULL)`,
  ordered `scanned_at DESC`, limited. `activity_7d` counts the same join
  over the trailing 7 days (independent of `limit`).
- `status_label`/`status_color` resolved from the asset status vocab (the
  scans payload convention, fallback `#51606f`); `asset_name` /
  `serial_number` from the asset row; `site_name` batch-resolved. No N+1.
- Lives under the `clients` resource so client anchors reach it without
  any `scans` grant.

## Portal

### Landing + nav

- `Home.tsx`: when `scope` is loaded, `!scope.global`, and
  `scope.client_ids.length > 0` → `<Navigate to="/dashboards/clients"
  replace />`.
- `navSections.tsx`: `NavItem` gains `globalOnly?: boolean`;
  `isNavItemVisible` (lib/godmode.ts) takes the scope's `global` flag and
  hides `globalOnly` items for non-global users (signature grows —
  update its unit tests). Main Dashboard, Move Dashboard, and People
  Dashboard get `globalOnly: true`; Client Dashboard stays for everyone.
  A client user's Dashboards section therefore shows exactly "Client
  Dashboard".

### Page (`portal/src/pages/ClientDashboard.tsx`)

Route keeps `ProtectedRoute resource="dashboard"`.

- **Header** `.dash-head`: title + `.dash-ctrls` with the standard
  Auto-refresh select (REFRESH_OPTIONS copied verbatim, default Off,
  aria-label="Auto-refresh", non-blanking refresh, `.dash-asof` dot) and
  the **Client control**: options from `listClients()` (internal users →
  all unarchived clients; client users → exactly their rows, same code
  path). More than one option → `<select aria-label="Client">`; exactly
  one → static client name text. Selection defaults to the first option;
  changing it reloads the client-dependent panels.
- **Identity band** (`section.dash-panel.dash-span-12`, class
  `cdash-hero`): 44px logo (`logo_url` or `avatarGradient(name)` +
  `initials(name)`), client name, tier chip (existing TIER_META styling
  precedent), status chip, and muted meta line (account manager name ·
  website · city/region when present). A
  `.dash-panel-link` "Client profile" → `/stakeholders/clients/{id}`
  renders for everyone (the target renders correctly for client actors
  too — it reads via the `clients` resource).
- **KPI strip** (4 `.dash-kpi` tiles): **Active initiatives** (unarchived
  initiatives for the client), **Total assets**, **In transit** (assets
  with status `in_transit`), **Activity · 7d** (`activity_7d`). Skeletons
  while loading; `Intl.NumberFormat`.
- **Initiatives panel** (`dash-span-12`, title "Initiatives"): rows for
  the client's unarchived initiatives (active first — no `real_end_at` —
  then by `scheduled_start` desc): name (Link `/initiatives/{id}`), type
  chip (`type_label`/`type_color`), status chip, scheduled window
  (`longDate` start – end), origin → destination site names when present,
  and a progress bar for up to `MAX_PROGRESS_FETCHES = 5` active move
  initiatives (client-side `moveAssetProgress` over
  `listInitiativeAssets`, the Home.tsx precedent — cap constant copied
  with the same name). Empty: "No initiatives yet." Data source:
  `listInitiatives()` filtered client-side by `client_id === selected`
  (the StakeholderDetail precedent; server-side scoping already narrows
  the payload for client actors).
- **Asset fleet panel** (`dash-span-5`, title "Asset fleet by status"):
  `Distribution` over the client's assets (client-side filter of
  `listAssets()` by `client_id`, statuses labeled via
  `listAssetStatuses()` — the Home.tsx assetDist pattern). Total in the
  panel head. Empty: "No assets on file."
- **Recent activity panel** (`dash-span-7`, title "Recent activity"):
  rows from the activity endpoint — status-colored dot, asset name
  (serial muted), status label, site · device, `relativeTime`. Rows link via
  `lib/scans.ts`'s existing match deep-link helper (asset-match
  convention), passing a synthetic `{match_type: 'asset', asset_id}`
  or calling its asset branch directly — reuse, don't reinvent. Empty: "No scan activity yet."
- Per-panel permission gates: initiatives panel needs
  `can('initiatives','view')`; assets panel `can('assets','view')`;
  activity + identity + picker need `can('clients','view')`. A user with
  `dashboard` but none of those sees the head plus "Nothing your
  permissions can show here yet." (People Dashboard copy).
- Refresh: one `refreshAll` reloading clients list, initiatives, assets,
  activity for the selected client without blanking.

## Error handling

- Quiet per-fetch catches; loaded panels keep stale data; as-of stamp
  advances on any settled cycle.
- No clients visible (internal user, empty table) → picker disabled +
  page-level empty "No clients yet."
- Selected client archived mid-session: rows simply disappear on next
  refresh cycle (list excludes archived); selection resets to first
  option.

## Testing

- API: initiative scoping (client-anchored fixture user: list returns
  only their client's initiatives; foreign initiative GET → 404; roster
  read of foreign initiative → 404; global actor unchanged; time/summary
  foreign id → 404); grants migration (client_viewer can list
  initiatives); activity endpoint (join correctness, 7d count independent
  of limit, foreign org 404 for client actor, empty shape, vocab
  labels/colors, no N+1 by construction).
- Portal: `isNavItemVisible` globalOnly cases; Home redirect (client
  scope → Navigate, global → normal render); page tests — picker renders
  options / static single name, panels render from mocks, KPI values,
  activity rows, per-permission hiding, refresh interval refetch.
- Live verification: attach the demo move + a batch of dev assets to
  Broadcom, create a client-anchored test account
  (`client-dev@test.example.com`, `client_admin` on Broadcom), walk BOTH
  personas in the browser (internal picker view; client login → redirect,
  tidy nav, scoped data), screenshots.

## Out of scope

Financials (none exist); client-facing writes; partner dashboard; sites
panel (sites remain global-only); per-client notification digests; Move
Dashboard client filters.
