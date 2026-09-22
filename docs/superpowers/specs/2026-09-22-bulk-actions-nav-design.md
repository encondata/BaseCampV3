# Bulk Actions navigation section — design

**Request (Jimmy, 2026-09-22):** a new "Bulk Actions" sidebar section directly
above Admin, visible only to admin rank (60) and higher. For now only the
section, its route gate, and an empty landing page; the tools it will hold
(copy access, site bulk import, add containers in bulk, import assets to a
move, generate/print labels, catalog review, clear offline kiosks) are built
one by one afterward as cards on that page.

## Navigation

`portal/src/layout/navSections.tsx`: a new `NavSection` inserted immediately
before the Admin section:

- label `Bulk Actions`, icon: a stack-of-layers outline (three offset
  rounded rectangles) in the same 24×24 stroke style as the other icons.
- one item: `{ to: '/bulk', label: 'Bulk Actions', resource: 'dashboard', minRank: 60, end: true }`.
  `resource: 'dashboard'` mirrors the Processes item: the gate is the rank,
  and `dashboard` is viewable by every internal role. `ADMIN_RANK` from
  `lib/access.ts` (60) is the value used, not a literal.

Visibility needs no new mechanism: `isNavItemVisible` already hides items
below `minRank`, and a section with no visible items is not rendered.

## Route and page

`portal/src/App.tsx`: `<Route path="/bulk" element={<ProtectedRoute minRank={ADMIN_RANK}><BulkActions /></ProtectedRoute>} />`
(same shape as `/system/processes`). Direct navigation below rank 60 gets the
existing "No access" page.

`portal/src/pages/BulkActions.tsx`: the house page shell — `portal-page`,
eyebrow `Admin`, title `Bulk Actions`, hint "One place for the jobs that touch
many records at once." — followed by an empty state (`dir-empty`):
**Nothing here yet** / "Bulk tools will appear here as they are added." The
page holds a `BULK_TOOLS` array typed `BulkTool[]` (`{ key, title,
description, resource?, action }`), empty for now, and renders cards from it
in a `bulk-grid` when non-empty; this is the seam later work fills.

## Tests

- `portal/src/layout/bulkActionsNav.test.tsx`: the section sits immediately
  before Admin, has exactly the `/bulk` item, and that item carries
  `minRank === ADMIN_RANK`; `isNavItemVisible` hides it at rank 59 and shows
  it at rank 60 with `can` returning true.
- `portal/src/pages/BulkActions.test.tsx`: renders the empty state.
- Existing nav-order tests (Labels/Reports adjacency, Scanning Hardware
  bounds, Admin uniqueness) keep passing.

## Out of scope

Any tool card, API changes, a new access resource.
