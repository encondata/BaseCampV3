# ComboBox menus escape modal cards — plan

**Goal:** a ComboBox rendered inside a `.modal-card` portals its menu to
`document.body` automatically, so the card's `max-height: 88vh;
overflow-y: auto` (portal/src/styles/chrome.css `.modal-card`) no longer
clips the menu. Today only FixMakeModelDialog opts in with `portal`
(main 955b3022).

## Global Constraints

- Detect the modal with `wrapRef.current?.closest('.modal-card')` **when the
  menu opens** (not once on mount). An explicit `portal` prop keeps working
  exactly as today (portals everywhere, in or out of a modal).
- A ComboBox outside any `.modal-card` and without `portal` behaves exactly
  as today (menu inside `.combo-wrap`, no inline style).
- A portaled menu still closes on a window/ancestor scroll or a resize, but
  NOT when the scroll is the menu's own list.
- TDD: failing test first, watch it fail, then implement.
- American English in comments, copy, and docs.
- Run `npx vitest run` and `npx tsc -b` from `portal/` in the FOREGROUND
  with a long timeout (600000 ms). Never background a suite.
- Never `git stash`. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Task 1: ComboBox auto-portals inside a `.modal-card`

**Files:** `portal/src/components/ComboBox.tsx`,
`portal/src/components/ComboBox.test.tsx`.

Implementation:

1. Add state `inModalCard` (boolean, default `false`). When the list opens
   (`openList`, and the `onChange` path that calls `setOpen(true)`), set it
   from `!!wrapRef.current?.closest('.modal-card')` — factor one small
   helper so both paths share it.
2. `const portaled = portal || inModalCard;` and use `portaled` everywhere
   the component currently reads `portal` for behavior: the layout effect
   (anchor placement + `setAnchor(null)` on close, and its deps), the
   scroll/resize-close effect (and its deps), `portalStyle`, and the
   `createPortal` choice in the render.
3. Update the header doc comment: the menu portals when `portal` is set OR
   automatically when the ComboBox sits inside a `.modal-card` (whose
   `overflow-y: auto` would otherwise clip it). Keep the `portal` prop's
   inline comment accurate.

Tests (new `describe('inside a .modal-card', …)` block in
ComboBox.test.tsx; render the ComboBox inside
`<div className="modal-card">…</div>`, no `portal` prop):

- the open menu's `parentElement` is `document.body`, it is not inside the
  card, and `style.position === 'fixed'`  ← the RED test
- selecting an option by mousedown calls `onChange` with its value and
  closes the menu
- keyboard: ArrowDown then Enter selects the second option
- a mousedown outside both the card's ComboBox and the menu closes it
- scrolling the menu's own list keeps it open; scrolling the `.modal-card`
  element closes it
- a ComboBox outside any `.modal-card` without `portal` still renders the
  menu inside its wrapper (the existing test covers this — keep it)

Keep all existing ComboBox tests and
`portal/src/components/initiatives/FixMakeModelDialog.test.tsx` passing.
Run the full portal suite + `npx tsc -b` before committing.

## Task 2: Shared placement hook; TagInput portals inside a `.modal-card` too

TagInput (portal/src/components/TagInput.tsx) renders its own in-place
`<div className="combo-menu">` and is used inside dialogs
(variables/WorkerLevelEditModal, pages/External, pages/OrgDirectory), so it
clips exactly like ComboBox did.

**Files:** new `portal/src/components/useMenuPlacement.ts` (name may be
adjusted to fit house naming), `ComboBox.tsx`, `TagInput.tsx`, new
`portal/src/components/TagInput.test.tsx`.

1. Extract ComboBox's placement logic into a hook shared by both
   components: given the wrapper ref, the menu ref, `open`, an explicit
   `portal` flag, a re-measure dependency (the filter text), and an
   `onDismiss` callback, it decides `portaled` (explicit flag OR wrapper
   inside `.modal-card`, detected when the menu opens), computes the
   drop-up flip (existing `shouldDropUp` + `MENU_NEEDED_HEIGHT`), places a
   portaled menu (existing `Anchor` / `MENU_GAP` / fixed style,
   zIndex 1200, hidden-at-origin until placed), and closes a portaled menu
   on window/ancestor scroll (except the menu's own list) or resize. It
   returns what the component needs to render (`portaled`, `dropUp`, the
   style). `shouldDropUp` stays exported from ComboBox.tsx (re-export is
   fine) so existing imports/tests keep working. This step is a pure
   refactor for ComboBox: all ComboBox tests stay green unchanged.
2. TagInput uses the hook (no new `portal` prop needed — auto in a
   `.modal-card` only): renders its menu through `createPortal` to
   `document.body` when portaled, adds the `drop-up` class when flipping,
   and its outside-click guard treats a mousedown on the (portaled) menu
   as inside, as ComboBox does.
3. TDD — TagInput.test.tsx (jsdom, same style as ComboBox.test.tsx):
   inside a `.modal-card` the suggestion menu's parent is `document.body`;
   clicking (mousedown) a suggestion adds the tag via `onChange`; outside
   a `.modal-card` the menu stays inside `.tag-input-wrap`; a window
   scroll closes the portaled menu, scrolling the menu itself does not.

## Task 3: Guardrail — no clippable popup inside a modal card

Requested by Jimmy: a permanent check in the style of
`portal/src/styles/naturalSort.test.ts` / `listTypography.test.ts` (a
vitest that scans source and fails with a `path:line: reason` list).

**File:** new `portal/src/styles/modalDropdowns.test.ts`.

- **Popup classes** are derived from the CSS, not hand-listed: every class
  in `portal/src/styles/**/*.css` whose rule declares
  `position: absolute` and whose name reads as a floating menu
  (matches /menu|popover|suggest|dropdown|listbox/). `combo-menu` and
  `pop-menu` must be in the derived set (assert it, so a CSS rename can't
  silently empty the check).
- **Scan** non-test `.tsx` files under `portal/src` with the TypeScript
  compiler API (`typescript` is already a devDependency): find each JSX
  element whose `className` contains the `modal-card` class; inside its
  subtree (same file), any JSX element whose `className` (string literal,
  template literal, or string parts of an expression) contains a popup
  class is a violation unless it sits inside a `createPortal(...)` call.
  Report `portal/src/<path>:<line>: <class> inside .modal-card can be
  clipped — <how to fix>` (fix: use ComboBox, which portals automatically
  in a dialog, or render the menu through createPortal like
  RowActionsMenu / ColumnMenu).
- **Fixture tests** for the scanner (pure function over a source string +
  class set): flags an in-place `pop-menu` inside a modal card; ignores
  one outside the card; ignores one under `createPortal`; catches a
  template-literal className; plus the CSS derivation test above. Then the
  real-tree test: zero violations. No allowlist. If the real tree has
  violations, fix them (portal the menu) — report any that need more than
  a mechanical change as DONE_WITH_CONCERNS with the list.
- **Header comment:** names the rule; why (`.modal-card` is
  `max-height: 88vh; overflow-y: auto`, which clipped Fix make/model's
  list on 2026-10-06 — fixed in main 955b3022 — and ComboBox/TagInput now
  portal automatically inside a dialog); how to satisfy it; its known
  limit (a shared component that renders an in-place popup, used inside a
  dialog from another file, isn't seen by a per-file scan — ComboBox and
  TagInput cover themselves by auto-portaling).

## Task 4: Audit every ComboBox / TagInput inside a modal

Files containing both `modal-card` and `<ComboBox` (24), plus the TagInput dialog users (variables/WorkerLevelEditModal, pages/External, pages/OrgDirectory):
access/CopyAccessModal, access/GroupsTab, access/RolesTab,
assets/AssetEditModal, assets/ModelEditModal, assets/ModelMergeModal,
containers/BulkContainersModal, containers/ContainerEditModal,
initiatives/AssetEditDialog, initiatives/FixMakeModelDialog,
labels/PrintSettingsModal, notifications/EditSettingsModal,
notifications/OverrideEditorModal, printers/AlignmentTestModal,
printers/PrinterSetupModal, reports/CompleteSiteSurveyModal,
sites/SiteEditModal, time/TimeEntryEditModal, trucks/TruckEditModal,
warehouse/StockLineModal, warehouse/StockMoveModal (all under
portal/src/components/), and pages/External, pages/InitiativeDetail,
pages/OrgDirectory.

For each, check (and fix anything that breaks now that the menu lives
under `document.body`):

- **Dismissal:** how the modal closes on outside interaction. A scrim
  `onClick`/`onMouseDown` guarded by `e.target === e.currentTarget` is safe;
  any document-level mousedown/click listener that closes the modal when the
  target is outside the card (`!cardRef.current.contains(target)`) would now
  close the modal when the user picks an option — must treat
  `.combo-menu` targets as inside.
- **Escape:** the modal's Escape handler still lets ComboBox's open-list
  Escape close only the list (ComboBox `preventDefault`s it).
- **Focus traps:** none should steal focus when the menu (outside the card)
  is clicked — options use `mousedown` + `preventDefault`.
- **Scoped CSS:** any selector that styles `.combo-menu` / `.kbar-item`
  through a modal ancestor (e.g. `.some-card .combo-menu`) no longer
  matches a portaled menu.
- **Tests:** each file's tests (`*.test.tsx` beside it or under
  `__tests__`) that locate options through the card (`within(card)`,
  `container.querySelector('.combo-menu')`) would now miss them.

Write the per-file audit results as a table in the report file
(file → dismissal mechanism → finding → action). Run the full portal suite
+ `npx tsc -b`. Commit any fixes (TDD for behavior fixes). If nothing needs
changing, commit nothing and say so.
