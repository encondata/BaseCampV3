# List typography standardization + list text size preference

**Date:** 2026-09-09
**Branch:** `list-typography` off `reports` (built in a worktree; fast-forwards into `reports`)
**Status:** Approved design (user pre-approved implementation)

## Purpose

Every row-based surface in the portal reads with ONE typography — the
Assets list's — and users can scale that typography from Settings
(Small / Default / Large / Extra large). Today ~15 parallel row systems
carry their own hardcoded sizes; a guardrail test stops that from
recurring.

## Audit (as-built)

- Golden template: `portal/src/styles/directory.css` `.dir-list` family.
  Head: mono 10px, uppercase, 0.14em, muted, 42px. Primary `.pn b`
  14px/600 dark; `.pn span` mono 11.5px muted. `.cell-top` 13.5px dark;
  `.cell-sub` 12px/300 muted; `.cell .mono` mono 12px muted. `.chip`
  12px/500 24px tall; `.chip.tag` mono 11px. Row `.row-main` padding
  12px 20px, min-height 66px; compact density 52px / 8px 20px.
  Row-detail `.kv dt` 12.5px/300, `.kv dd` 13px, `.kv dd.mono` 12px;
  `.dir-avatar` 36px (compact 30px, 11px initials).
- Only two page rules override golden classes
  (`dashboard.css .pdash-clock-row .dir-avatar`, `sites.css
  .site-map-detail-head .pn b`).
- Raw `<table>` surfaces (7): `components/access/MatrixTable.tsx`,
  `components/containers/ContainerBulkImport.tsx`,
  `components/hardware/RouterLeases.tsx`,
  `components/notifications/MembersPanel.tsx`,
  `components/scans/ScanHistoryTable.tsx`,
  `components/sites/SiteBulkImport.tsx`, `pages/WorkerDetail.tsx`.
- Custom row families with their own typography: `dashboard.css`
  (`dash-board-row`, `dash-dist-row`, `dash-feed-row`, `dash-scan-row`,
  `mdash-wave-row`, `pdash-clock-row`, `cdash-act-row`,
  `cdash-init-row`, `dash-grid-line`), `access.css` (`mem-row`,
  `gate-row`, `pm-table`/`pm-cell`/`pm-col-head`), `system.css`
  (`envtab-*`, `sys-proc-list`, `sysconf-row`), `initiatives.css`
  (`idet-time-list`, `idet-time-row`, `idet-donut-legend-row`,
  `imp-missing-row`), `time.css` (`time-active-row`,
  `time-recent-row`, `time-row-static`), `profile.css`
  (`activity-list`), `notifications.css` (`ngd-members-table`,
  `ngd-switch-row`), `hardware.css` (`lease-table`), `reports.css`
  (`ini-picker-row`, `report-section-row`), `sites.css` (`bulk-row-*`),
  `assets.css` (`nf-list`).
- Preferences: `UiPreferences` (api/schemas.py, `extra="ignore"`;
  portal `lib/api.ts`), defaults in `lib/settings.ts`, applied by
  `applyPreferences` as `data-*` attributes on `.portal-shell`
  (`data-density` today). Settings row control: `.seg-mini`.

## 1. Token layer (`directory.css`)

Declared on `.portal-shell` (so the login page, which has no shell, is
unaffected):

```css
.portal-shell { --list-scale: 1; }
.portal-shell[data-list-size='small']  { --list-scale: 0.9; }
.portal-shell[data-list-size='large']  { --list-scale: 1.15; }
.portal-shell[data-list-size='xlarge'] { --list-scale: 1.3; }
.portal-shell {
  --list-fs-head: calc(10px * var(--list-scale));
  --list-fs-primary: calc(14px * var(--list-scale));
  --list-fs-primary-sub: calc(11.5px * var(--list-scale));
  --list-fs-cell: calc(13.5px * var(--list-scale));
  --list-fs-sub: calc(12px * var(--list-scale));
  --list-fs-mono: calc(12px * var(--list-scale));
  --list-fs-chip: calc(12px * var(--list-scale));
  --list-fs-chip-tag: calc(11px * var(--list-scale));
  --list-fs-kv-label: calc(12.5px * var(--list-scale));
  --list-fs-kv-value: calc(13px * var(--list-scale));
  --list-row-min-h: calc(66px * var(--list-scale));
  --list-row-pad-y: calc(12px * var(--list-scale));
  --list-head-h: calc(42px * var(--list-scale));
  --list-mini-row-min-h: calc(44px * var(--list-scale));
  --list-chip-h: calc(24px * var(--list-scale));
  --list-avatar: calc(36px * var(--list-scale));
}
.portal-shell[data-density='compact'] {
  --list-row-min-h: calc(52px * var(--list-scale));
  --list-row-pad-y: calc(8px * var(--list-scale));
  --list-mini-row-min-h: calc(38px * var(--list-scale));
  --list-avatar: calc(30px * var(--list-scale));
}
```

Every golden rule switches its literal to the matching token (the
existing compact-density block collapses into the token override above).
`Default` (scale 1) is pixel-identical to today. Font families never
change with size: display font for names/values, `var(--font-mono)` for
identifiers (serials, tags, RU, ids, timestamps in mono cells).

## 2. Three primitives (all on the tokens; page CSS = layout only)

1. **Directory list** — `.dir-list` / `.list-head` / `.dir-row` /
   `.row-main` / `.cell*` / `.chip` / `.kv`: unchanged markup contract.
2. **Mini list** (new, `directory.css`): header-less compact rows.
   ```html
   <div class="mini-list">
     <div class="mini-row">            <!-- grid; page sets columns -->
       <div class="cell-primary"><div class="pn"><b>Name</b><span>sub</span></div></div>
       <span class="cell-top">…</span> <span class="mono">…</span> <span class="chip …">…</span>
     </div>
   </div>
   ```
   `.mini-row { display:grid; align-items:center; gap:12px; min-height:
   var(--list-mini-row-min-h); padding: calc(var(--list-row-pad-y)*0.5)
   0; border-bottom:1px solid var(--paper-line) }` — reuses the cell
   classes verbatim so typography is the golden tokens. Optional
   `.mini-list-head` (head token) when a panel needs column labels.
3. **Data table** (new, `directory.css` + `components/DataTable.tsx`):
   the ONLY sanctioned `<table>`. `DataTable({ columns: {key, label,
   align?, mono?}[], rows: ReactNode[][] | records, rowKey, empty? })`
   renders `<table class="data-table">` with `<th>` on the head token
   and `<td>` on cell/mono tokens, row min-height the mini row token,
   zebra-free, `.paper-line` dividers. Column widths/alignments via
   props; pages never style `td` typography.

Migration map (surface → primitive): dashboards' rows/feeds/legends →
mini list; access `mem-row`/`gate-row` → mini list; `pm-table` (matrix)
→ data table; system `sys-proc-list` → directory list (it already has a
head) and `envtab-*`/`sysconf-row` → mini list; initiatives
`idet-time-list` → mini list, `imp-missing-row` → mini list,
`idet-donut-legend-row` → mini list; time `time-*-row` → mini list;
profile `activity-list` → mini list; notifications `ngd-members-table` →
data table, `ngd-switch-row` stays (a form row, not a list); hardware
`lease-table` → data table; reports pickers/sections → mini list; sites
`bulk-row-*` + container bulk preview → data table; assets `nf-list` →
mini list; WorkerDetail table → data table; scan history → data table.
The two golden-class overrides are deleted (avatar size = token; the
site-map head keeps 15px only via a documented allowlist entry — it is a
detail heading, not a list row).

## 3. Settings — List text size

- API: `UiPreferences.list_size: Literal["small","default","large","xlarge"] = "default"`
  (unknown values → 422 like `density`; missing → default).
- Portal: `UiPreferences.list_size` type + default `'default'` in
  `lib/settings.ts`; `applyPreferences` sets
  `shell.setAttribute('data-list-size', prefs.list_size)`.
- Settings.tsx: new `set-row` **List text size** directly below
  Interface density, `.seg-mini` with Small / Default / Large / Extra
  large; sub-copy "Scales every list and table — pick what reads best on
  your screen." Optimistic update via the existing `update()`.

## 4. Guardrail (`portal/src/styles/listTypography.test.ts`)

Node-environment vitest that reads the source tree and fails when:
- (a) a stylesheet other than `directory.css` contains a rule whose
  selector matches `/(row|cell|list|table|chip|mono|\bpn\b|\bps\b|head)/`
  and declares `font-size`, `font-family`, `font-weight`, `line-height`
  or `min-height`;
- (b) a `.tsx` under `pages/` or `components/` other than
  `components/DataTable.tsx` contains `<table`;
- (c) `directory.css` declares any of those properties with a literal
  `px` inside a rule for `.dir-list|.list-head|.row-main|.cell|.chip|
  .kv|.mini-|.data-table` selectors instead of a `var(--list-…)`.
An allowlist `portal/src/styles/listTypography.allow.json`
(`[{ "file", "selector", "reason" }]`) exempts deliberate exceptions;
each entry needs a reason. Ships in enforce mode with an empty-or-tiny
allowlist (the site-map detail heading).

## 5. Rollout order

1. Tokens + primitives + Settings + API (no visual change at Default;
   guardrail in report mode prints the violation list).
2. Migrate families: dashboards → access/system → initiatives/time/
   profile/reports/assets → tables (bulk previews, leases, members, scan
   history, matrix, worker detail).
3. Flip the guardrail to enforce; suites green.
4. Live verify at Default and Extra large: Assets, Move Dashboard, Access
   matrix, one bulk-import preview.

## Testing

API: `test_preferences.py` — list_size round-trips, bad value 422,
missing → default. Portal: guardrail test; `DataTable` render test;
`applyPreferences` sets `data-list-size`; Settings row renders and
PUTs; existing page tests unchanged (markup contracts kept — mini rows
keep the same text/labels so `getByText` assertions hold).

## Out of scope

Page titles/eyebrows, forms, modals, cards, rack SVG, print sheets,
login page, the `.seg-mini` control itself.
