# Initiative Full Details Page — Design

**Date:** 2026-08-25
**Status:** Approved (user: "lets build it so I can see what it looks like")

## Goal

A dedicated Full Details page per initiative, in the spirit of BaseCampV2's
ProjectDetail/MoveDetail (one scrollable page: header with all fields on top,
then sections), reached from a **Full details** button next to Edit in the
Initiatives list's expanded row. Includes a placeholder Assets section (assets
land in the next slice) and expanded People, Linked initiatives, and
Notes & Attachments sections.

## Route + entry

- New route `/initiatives/:id` in portal/src/App.tsx, wrapped in
  `<ProtectedRoute resource="initiatives">`. Page component:
  portal/src/pages/InitiativeDetail.tsx.
- In `InitiativeRowDetail` (portal/src/pages/Initiatives.tsx), the
  `detail-actions` bar gains a **Full details** button (btn-ghost) beside the
  Edit (btn-solid) button, navigating to `/initiatives/${id}` via
  react-router's `useNavigate`.
- The page has a "← Initiatives" back link to `/initiatives`.
- Linked initiatives on the page navigate to `/initiatives/<other_id>`
  (the page reloads its data when `:id` changes).

## Data

- `getInitiative(id)` → `InitiativeDetail` (all fields + people + links).
- Vocab + option loads mirror Initiatives.tsx, gated by the same `can()`
  checks: statuses/types/subTypes/workTypes/shippingTypes always;
  sites/clients/partners/workers only when viewable. Needed for the Edit
  modal, the People edit dialog, and resolving move partner-role names.
- `listInitiatives()` for the link-an-initiative combobox options.

## Page layout (top to bottom)

1. **Header** — back link; initiative name (large) with type chip, sub-type
   chip (when set), status chip, and an "Archived" tag when `archived_at`;
   description paragraph under the title when present; **Edit** button
   (visible with `can('initiatives','change')`) on the right, opening the
   existing `InitiativeEditModal` with the same props as the list page;
   `onSaved` refetches the detail.
2. **Info cards** (two-column grid, stacking on narrow):
   - *Overview*: Type, Sub-type, Status, Client, Site (non-moves), Location,
     Scheduled (start → end), Actual (real_start_at → real_end_at),
     Sky Command ID (projects only), Created.
   - *Move* (moves only): Origin → Destination, Shipping types,
     Shipping partner, Priority devices, Origin/Destination vendor involved,
     and the six role partners (Origin/Destination × Tech/Cable/Logistics)
     resolved to names from the partners list (id shown as — when the list
     isn't viewable or the id is unset).
3. **Assets** — full-width placeholder panel: eyebrow "Assets", hint text
   "Asset tracking lands here next." No behavior.
4. **People** — full-width; count in the eyebrow. Table columns: Name,
   Work type (chip), Site worked, Rating (★ n), row actions Edit + Remove
   (canChange only). **Edit** opens a small dialog (same modal shell style as
   the codebase's modals): Work type ComboBox (clearable), Site worked
   ComboBox over sites (clearable), Rating numeric input 1–5 (empty = null);
   Save PATCHes via `updateInitiativePerson(assocId, {work_type,
   site_worked_id, rating})` and refetches. Add-person row (ComboBox person +
   ComboBox work type + Add) as in the expanded row today.
5. **Linked initiatives** — full-width; Contains/Part-of rows with type chip
   and unlink (children only), plus the link-as-child ComboBox + Link button;
   names navigate to the other initiative's detail page.
6. **Notes & Attachments** — full-width `NotesFilesPanel`
   (`entityType="initiative"`, `canWrite={canChange}`).

## Error handling

- Load failure: 403/404 → "Initiative not found — it may have been deleted,
  or you may not have access." with the back link; other errors → "Failed to
  load initiative." Retry not required.
- Mutations use the row-detail's `run()` pattern: per-section inline error
  (`pf-error`), busy-disable while in flight, refetch on success.

## Styling

- Reuse existing vocab: `.init-panel`, `.kv`, `.eyebrow-sm`, `.page-hint`,
  `.chip`, `.init-row/.init-rows/.init-add`, `.btn-solid/.btn-ghost/.mini-btn`.
- New page-scoped classes (prefix `idet-`) in
  portal/src/styles/initiatives.css for the header block, card grid, and
  people table. No new stylesheet file.

## Out of scope

- Real assets data (next slice fills the Assets section).
- God-mode editing / god delete on the detail page (stays in the list row).
- Man-hours, images lightbox, PDF reports, bulk modes from V2.
- Changing the expanded-row behavior (it keeps its quick People/Links/Notes).

## Testing

No new lib functions (all API clients exist). Repo convention keeps pages
thin/untested; existing suites must stay green. Verification is a live
browser pass: navigate from the row, header/cards render for a move and a
non-move, person edit round-trip, link navigation, notes panel loads.
