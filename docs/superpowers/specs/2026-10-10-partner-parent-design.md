# Parent and subsidiary partners — design

**Date:** 2026-10-10
**Tracker:** Stakeholders › "Parent and subsidiary partners" (Feature Parity 180, Gaps line 90, Not built; To-Do #35)
**Branch:** `partner-parent`

## Goal

A partner company can sit under a parent partner (a subcontractor engaged
through a parent firm). Staff set the parent from the partner edit form or
add children from the parent's page; the hierarchy is shown on the partner
page and as an optional column on the Partners list.

## V2

`partners.parent_partner` (self-FK, `ON DELETE SET NULL`), one level in
practice; detail page showed a "Parent Partner" link and a "Child Partners
(N)" table (Name, Services, Region). It could not be set in the app (DB
only). No cycle or depth checks, nothing inherited, no client equivalent.

## Jimmy's decisions (2026-10-10)

- Set the parent with a picker in the partner edit form (plus Add child on
  the detail page).
- Display only: no access inheritance — a partner's users still see only the
  partners they're granted.
- Partners list stays flat with an optional Parent column.

## Data — migration 0095

`partners.parent_id uuid NULL REFERENCES partners(id) ON DELETE SET NULL`,
index `ix_partners_parent_id`, check `ck_partners_parent_not_self`
(`parent_id IS NULL OR parent_id <> id`). Model `Partner.parent_id`.
Clients unchanged.

## API (`api/routes/stakeholders.py`, partner branch of `_make_org_router`)

- `OrgCreateIn` / `OrgUpdateIn` gain optional `parent_id: uuid | None`
  (`null` on PATCH clears it). On the clients router a `parent_id` key →
  422 `parent_not_allowed`.
- Validation when `parent_id` is set (create and patch), inside a
  transaction holding an advisory xact lock (dedicated key, like
  initiatives' `LINK_GRAPH_LOCK_KEY`):
  - equals the partner itself → 422 `self_parent`;
  - not found or not visible to the actor (`scope_conditions("partners")`)
    → 422 `parent_not_found`;
  - the partner appears among the proposed parent's ancestors (walk
    `parent_id` upward, bounded by a 100-step guard) → 422 `circular_parent`.
  - Archived parents are allowed (V2 had no rule).
- `OrgItem` (partners) gains `parent_id`, `parent_name` and `child_count`.
  `parent_name` (and `parent_id`) are null when the parent isn't visible to
  the actor; `child_count` counts children visible to the actor
  (non-archived and archived alike).
- `GET /partners/{id}/children` → the partner's visible children as
  `OrgItem` rows, sorted naturally by name (`natural()`), same permission
  as `GET /partners/{id}` (404 when the partner itself isn't visible).
- Parent changes are staff-only: a create or PATCH body containing a
  `parent_id` key from a non-global actor (`access.is_global` false) → 403
  `forbidden`, checked before any lock or lookup. Partner users see the
  hierarchy where in scope but cannot change it.
- Changes are audited by the existing PATCH snapshot/diff (`parent_id`
  added to the tracked fields).
- Add child / Remove on the detail page are PATCHes of the child
  (`parent_id` = parent / `null`), so they reuse the same validation and
  `partners:change`.

## Portal

- **Edit modal** (`OrgDirectory` edit form for partners): a **Parent
  partner** field using the house `ComboBox` (searchable; portals out of the
  modal per the modal-dropdown guardrail), options = visible partners
  excluding the partner itself and its descendants (descendants computed
  from the loaded list's `parent_id`s; the API still enforces), plus
  **None**. Create form gets the same field.
- **Partner detail** (`pages/StakeholderDetail.tsx`):
  - Details `<dl>`: a **Parent partner** row linking to
    `/partners/{parent_id}` (shown only when set and visible).
  - A **Child partners** `init-panel` after Details: list (standard
    `dir-list`/`ColHead`/`listGridStyle` with floors per the list recipe,
    sized against `LIST_FIT.initPanel`) with Name (link), Types, Region,
    Status; count badge. With `partners:change`: **Add child** (opens a small
    modal — house header pattern: eyebrow "Partners", title "Add a child
    partner", description — with a `ComboBox` of partners that have no
    parent and aren't this partner or its ancestors) and a **Remove** row
    action (clears that child's parent; `window.confirm`). Empty state:
    "No child partners."
  - Panel shown when the partner has children or the viewer can change.
- **Partners list** (`pages/OrgDirectory.tsx`, partner config): a new
  optional column **Parent** (off by default, partner-only), sortable
  (natural) and filterable through the existing ColumnMenu, showing the
  parent name (link-styled text, no navigation from the row cell needed).
  Defaults stay within `LIST_FIT.page`.

## Testing

API: migration (column, FK SET NULL on parent delete, self check, index);
create and patch with parent; `null` clears; self 422; unknown / out-of-
scope parent 422; cycle 422 (A→B, then B→A; and a 3-level loop);
clients router rejects `parent_id`; `OrgItem` fields incl. null
`parent_name` for an out-of-scope parent seen by a partner-scoped user and
`child_count` scoped; children endpoint (sorted, scoped, 404 for invisible
partner); audit row on parent change; concurrent cycle protection via the
lock (two PATCHes that would form a loop — at least assert the lock call is
taken, or run two sessions).

Portal: edit/create form field (options exclude self and descendants,
None clears, sends `parent_id`); detail page Parent row and Child partners
panel (list, Add child modal, Remove with confirm, hidden controls without
change, empty state); Partners list Parent column (off by default, sort,
filter); guardrails.

## Out of scope

Client hierarchies, access inheritance, rolling up workers/moves from
children, a nested tree list, depth limits.
