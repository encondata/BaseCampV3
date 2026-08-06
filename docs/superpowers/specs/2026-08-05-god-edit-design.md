# God-Mode Direct Table Editing — Design Spec

**Date:** 2026-08-05 · **Status:** Approved (design approved in conversation; Jimmy asked to proceed straight to code)
**Scope:** Inline per-cell editing on every list page when god mode is unlocked. Portal-only — zero API changes.
**Out of scope:** raw/devtools write path (normal-API validation stands), M:N cells (site↔clients), alias sets, role/account grants, bulk/batch editing, new component-test infra.

## Decisions (from brainstorm)

1. **Write path: the normal per-resource PATCH endpoints.** Validation, row scoping, and audit are untouched. God mode keeps its "reveals, never grants" rule — the UI appears with god mode, authority stays the actor's real grants.
2. **Save granularity: per cell.** Enter/blur commits `{field: value}` as a one-field PATCH; Esc reverts; response item replaces the row in list state. Cell-level error display (red ring + mapped message) keeps the cell in edit mode. Paired validations (lat/lon) legitimately error on lone edits.
3. **Inputs are type-aware:** text/number inputs, ComboBox for record-backed fields (house rule), native select for tiny enums and the yes/no/unknown tri-state.
4. **Field scope: visible columns + god columns.** Every visible column mapping 1:1 to a writable field becomes editable. Writable fields lacking a column get `godOnly: true` ColumnDef entries — hidden from the Columns picker unless god mode is on. Computed/rollup cells are read-only and gray out in edit mode. The primary cell edits its (up to two) fields as stacked inputs.
5. **Rollout: all seven list surfaces in one project** — mechanism first, then Assets, Makes/Models, Sites, Workers, Users, External, Clients/Partners (OrgDirectory).

## Architecture — descriptor-driven cell layer

**`portal/src/lib/godEdit.tsx`** (new, shared):
- `interface GodField { column: string; field: string; kind: 'text' | 'number' | 'combo' | 'select' | 'bool'; options?: () => ComboOption[] | SelectOption[]; toPatch?: (raw: string) => unknown; fromRow: (row) => string; readOnly?: never }` — one entry per editable column. Columns without an entry render their normal cell (read-only).
- `useGodEdit(config)` hook: holds `{ editing: boolean, toggle() }` plus per-cell commit state; exposed to the page.
- `<GodCell row column field …>`: renders the type-aware input when editing; commit on Enter/blur → `patch(row.id, body)` (the page's api method, injected) → `onRowSaved(updated)`; Esc reverts; in-cell spinner; on ApiError shows the page's mapped message under a red ring and stays in edit mode.
- Toolbar toggle: a god-only pencil button (`godMode` from AuthContext gates its render) using the existing `btn-ghost` style, `aria-pressed`, amber accent when active.
- CSS in `portal/src/styles/god-edit.css`: editable-cell tint (amber family, `--accent`-derived), red error ring, disabled/readonly gray.

**Per-page adoption** (pattern identical everywhere):
1. Page's pure lib exports `GOD_FIELDS: GodField[]` (+ `toPatch` helpers where a field needs mapping — tri-state bools, numerics, unit-pair single-side sends).
2. `COLUMNS` gains `godOnly?: boolean` defs for writable fields without columns; `ColumnsButton` filters `godOnly` entries unless god mode (extend `listTools.tsx` minimally: `ColumnDef.godOnly?: boolean`, `ColumnsButton`/page filter by `godMode`).
3. `cellFor(row, key)` routes through `GodCell` when editing && a descriptor exists for `key`; otherwise unchanged.
4. Primary cell: wrapped the same way with its stacked fields.

**Per-page field notes:**
- **Assets:** serial/name (primary), rfid, model (combo), client (combo), site (combo), status (combo), location, has_rails (tri-state god column), last_seen read-only.
- **Makes/Models:** make/model (primary), category (combo), ru (number), weight lb + kg god columns (each sends only its side; server computes partner), six dim god columns likewise, mount (select), rail type, knowledge god column (textarea-flavored text input). Aliases count cell read-only.
- **Sites:** name/code (primary), type (combo), status (combo), city/region/postal/country/address god columns, dc_provider, timezone, lat + lon as two god columns (numbers; combined Coords display column stays read-only), notes god column. Clients rollup read-only.
- **Workers:** level (combo), status (combo), text profile fields per its list; cert rollups read-only.
- **Users / External:** person text fields (names, title, phone) editable; email, roles, account state cells read-only (guarded flows own them).
- **Clients / Partners (OrgDirectory):** org text fields + status/type combos per its config; contact rollups read-only.
- Any page-specific PATCH quirks follow that page's existing modal payload semantics (reuse its payload helpers).

**Error handling:** each page already has an error-code→copy map for its modal; GodCell takes it as a prop. Unknown codes fall back to "Could not save."

**Testing:** descriptor maps + toPatch helpers unit-tested in each page's lib test file (pure). `listTools` godOnly filtering unit-tested. No component tests (no infra); browser pass per page is the gate.
