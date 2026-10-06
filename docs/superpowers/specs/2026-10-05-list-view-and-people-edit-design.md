# List view preference + People edit table — design

Date: 2026-10-05. Branch `list-view-people-edit`. Tracker: Gaps row 20
"Bulk edit of the assigned team" (Feature Parity row 75, To-Do #25).

## 1. "List view" preference and a collapsible Assets list

**Goal.** The Assets section on the initiative full-detail page
(`/initiatives/:id`) collapses with the same chevron as Notes & files. How
lists start is a user preference saved to the account, built so other
lists can opt in later with one line.

**Preference.** New `UiPreferences.list_view: 'expanded' | 'collapsed' |
'last'`, default `'expanded'`, on the API model (`api/src/serversherpa/api/schemas.py`)
and the portal type (`portal/src/lib/api.ts`) plus `DEFAULT_PREFERENCES`
(`portal/src/lib/settings.ts`). It is shown on /me › Preferences in a new
**Lists** group under Appearance as a `seg-mini` row:

- Label **List view**, hint "How collapsible lists start when you open a page."
- Buttons **Start expanded** / **Start collapsed** / **Remember last**.

**Per-list state.** Each collapsible list has a stable key; the first is
`initiative-assets`. Its last open state is stored in the existing
free-form `list_prefs` under one shared map:
`list_prefs.open_state = { "initiative-assets": false, … }`. Clicking the
chevron always records the new state, whatever the preference is, so
switching to "Remember last" later picks up the most recent click. The
save merges onto the latest preferences (same `prefsRef` idiom as
`usePersistentListState`) and fires immediately, with no debounce.

**Starting state** (computed once, at mount):

| list_view | starts |
|-----------|--------|
| expanded (or missing) | open |
| collapsed | closed |
| last | `open_state[key]` if it is a boolean, else open |

**Pieces.**

- `CollapsePanel` gains an optional controlled mode: `open` + `onToggle(next)`.
  Without `open` it behaves exactly as today (`defaultOpen`, uncontrolled), so
  Notes & files and SiteDetail are unchanged. `render="lazy"` still mounts
  the body on first open in both modes.
- `portal/src/lib/listCollapse.ts` exports `useListCollapse(listKey)` →
  `{ open, setOpen }` plus the pure `initialListOpen(prefs, listKey)` and
  the `LIST_OPEN_STATE_KEY = 'open_state'` constant.
- The Assets `init-panel` wraps its whole body (hint, error, progress bar,
  toolbar, list, action error) in `<CollapsePanel title={…same "Assets — N"
  text…} open={…} onToggle={…}>`. The header text is unchanged.

## 2. People edit table (Gaps 20)

The People section gets the same **Edit table** button the Assets section
has (GodEditToggle), with its own `peopleEditing` state instead of
`useGodEdit()`.

- Visible when `maxRank >= SUPER_ADMIN_RANK && canChange`, where
  `SUPER_ADMIN_RANK = 80` is a new export in `portal/src/lib/access.ts`.
  Super admin (80) and developer/Top (100) see it whether or not god mode
  is on; admin (60) never sees it, god mode included.
- Editable cells are unchanged: Work type, Site worked, Rating, saved per
  cell on Enter/blur through the existing `GodCell` + `updateInitiativePerson`.
- The server permission is unchanged (`initiatives:change`).

## Testing

- API: login defaults include `list_view: "expanded"`; a PUT with
  `"last"` round-trips; an unknown value is a 422.
- Portal: CollapsePanel controlled mode; `initialListOpen` for all three
  modes and the missing/non-boolean cases; `useListCollapse` saves a
  merged `open_state` without clobbering other `list_prefs` entries;
  MePreferences row updates `list_view`; InitiativeDetail Assets starts
  open/closed per the preference and the chevron saves; People Edit table
  shown at rank 80 and 100, hidden at rank 60, and turns Work type into an
  editor.

## Out of scope

Other lists adopting `useListCollapse` (later, one key each).
