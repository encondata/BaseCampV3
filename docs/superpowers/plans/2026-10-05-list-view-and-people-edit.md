# List view preference + People edit table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "List view" account preference (expanded / collapsed / remember last) driving a collapsible Assets list on the initiative detail page, and an Edit table mode for the People section gated on rank 80+.

**Architecture:** One new UiPreferences field (`list_view`), per-list open state in `list_prefs.open_state[listKey]`, a `useListCollapse(listKey)` hook over a controlled-mode `CollapsePanel`, and a rank-gated `peopleEditing` toggle reusing GodEditToggle/GodCell.

**Tech Stack:** FastAPI + pydantic (api/), React + TypeScript + vitest/testing-library (portal/).

Spec: `docs/superpowers/specs/2026-10-05-list-view-and-people-edit-design.md`.

## Global Constraints

- Preference field: `list_view: 'expanded' | 'collapsed' | 'last'`, default `'expanded'`.
- Per-list storage: `list_prefs.open_state = { [listKey]: boolean }`; constant `LIST_OPEN_STATE_KEY = 'open_state'`; first list key `initiative-assets`.
- Chevron click always records the new state (any `list_view` value), merged onto the latest preferences, saved immediately (no debounce), never clobbering other `list_prefs` entries or other preference fields.
- `last` with no saved boolean for the key starts open; a missing `list_view` behaves as `expanded`.
- MePreferences copy, verbatim: group eyebrow **Lists**; row label **List view**; hint **How collapsible lists start when you open a page.**; buttons **Start expanded** / **Start collapsed** / **Remember last**.
- CollapsePanel without `open` behaves exactly as today (Notes & files, SiteDetail unchanged).
- Assets header text stays exactly `Assets` / `Assets — N` (N = assets.length on a move).
- People Edit table: `visible={maxRank >= SUPER_ADMIN_RANK && canChange}` with `export const SUPER_ADMIN_RANK = 80;` in `portal/src/lib/access.ts`. Independent of god mode. Hidden at rank 60.
- People editable fields unchanged (Work type, Site worked, Rating via GodCell + updateInitiativePerson). No server permission change.
- American English in all copy, comments, and docs.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`. Never commit `api/src/serversherpa/_dev_reload.py`.
- API tests: from `api/`, `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_list_view .venv/bin/pytest -q <files>` (foreground). Portal: from `portal/`, `npx vitest run <files>` and `npx tsc -b`.

---

### Task 1: API `list_view` preference

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (class `UiPreferences`, ~lines 62–96)
- Test: `api/tests/test_preferences.py`

**Interfaces:**
- Produces: `UiPreferences.list_view: Literal["expanded", "collapsed", "last"] = "expanded"` in every login / `/auth/me` / PUT `/auth/me/preferences` response.

- [ ] **Step 1: Write the failing tests.** In `api/tests/test_preferences.py`: add `"list_view": "last",` to the `PREFS` dict (after `"nav_size"`), add `"list_view": "expanded",` to the expected dict in `test_login_returns_default_preferences`, and add:

```python
async def test_list_view_rejects_unknown_value(client, seeded_user):
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    resp = await client.put("/auth/me/preferences",
                            json={**PREFS, "list_view": "sideways"}, headers=headers)
    assert resp.status_code == 422


async def test_list_view_defaults_when_absent(client, seeded_user):
    body = await _login(client)
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    legacy = {k: v for k, v in PREFS.items() if k != "list_view"}
    resp = await client.put("/auth/me/preferences", json=legacy, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["list_view"] == "expanded"
```

- [ ] **Step 2: Run** `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_list_view .venv/bin/pytest -q tests/test_preferences.py` — expect failures (missing key / no 422).
- [ ] **Step 3: Implement.** In `UiPreferences`, after `nav_size`, add:

```python
    # How collapsible lists start: always open, always closed, or each
    # list's last state (kept in list_prefs["open_state"]).
    list_view: Literal["expanded", "collapsed", "last"] = "expanded"
```

- [ ] **Step 4: Run** the same command — all pass. Also grep `api/tests` for other exact-equality assertions on the full preferences dict (`"nav_size": "default"`) and add `list_view` where needed; run those files.
- [ ] **Step 5: Commit** `feat(api): list_view UI preference (expanded / collapsed / last)`.

---

### Task 2: Portal preference type + /me › Preferences "List view" row

**Files:**
- Modify: `portal/src/lib/api.ts` (`interface UiPreferences`, ~line 62–76)
- Modify: `portal/src/lib/settings.ts` (`DEFAULT_PREFERENCES`)
- Modify: `portal/src/pages/me/MePreferences.tsx`
- Modify: every test fixture typed as `UiPreferences` (they use `satisfies UiPreferences` or are typed objects; `npx tsc -b` lists them — about 25 files containing `nav_size`)
- Test: `portal/src/pages/me/MePreferences.test.tsx`

**Interfaces:**
- Produces: `UiPreferences['list_view']` (`'expanded' | 'collapsed' | 'last'`), `DEFAULT_PREFERENCES.list_view === 'expanded'`, and `export const LIST_VIEWS: UiPreferences['list_view'][] = ['expanded', 'collapsed', 'last'];` in `portal/src/lib/settings.ts`.

- [ ] **Step 1: Failing test** in `MePreferences.test.tsx` (add `list_view: 'expanded',` to its fixture too):

```tsx
it('List view row updates list_view', async () => {
  render(<MePreferences />);
  const r = row('List view');
  expect(within(r).getByText('How collapsible lists start when you open a page.')).not.toBeNull();
  expect(within(r).getByRole('button', { name: 'Start expanded' }).className).toBe('on');
  fireEvent.click(within(r).getByRole('button', { name: 'Remember last' }));
  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ list_view: 'last' }),
  ));
  fireEvent.click(within(r).getByRole('button', { name: 'Start collapsed' }));
  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ list_view: 'collapsed' }),
  ));
});
```

(Match the existing tests' style in that file for how `update` reaches `updatePreferences`; if a sibling test asserts differently, follow it.)

- [ ] **Step 2: Run** `npx vitest run src/pages/me/MePreferences.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
  - `api.ts`: add `list_view: 'expanded' | 'collapsed' | 'last';` after `nav_size`, with a one-line comment.
  - `settings.ts`: `list_view: 'expanded',` in `DEFAULT_PREFERENCES`; export `LIST_VIEWS` next to `NAV_MODES`.
  - `MePreferences.tsx`: after the "List text size" row and before the Navigation eyebrow, add:

```tsx
          <div className="eyebrow" style={{ padding: '18px 20px 0' }}>Lists</div>
          <div className="set-row">
            <div className="set-label">
              <b>List view</b>
              <span>How collapsible lists start when you open a page.</span>
            </div>
            <div className="seg-mini">
              {LIST_VIEWS.map((v) => (
                <button key={v} className={(preferences.list_view ?? 'expanded') === v ? 'on' : ''}
                        onClick={() => update({ list_view: v })}>
                  {v === 'expanded' ? 'Start expanded' : v === 'collapsed' ? 'Start collapsed' : 'Remember last'}
                </button>
              ))}
            </div>
          </div>
```

  - Add `list_view: 'expanded',` to every `UiPreferences` test fixture that `npx tsc -b` flags (insert after `nav_size: 'default',`).
- [ ] **Step 4: Run** `npx vitest run src/pages/me` and `npx tsc -b` — pass, no type errors.
- [ ] **Step 5: Commit** `feat(portal): List view preference on /me › Preferences`.

---

### Task 3: Controlled CollapsePanel + useListCollapse + collapsible Assets

**Files:**
- Modify: `portal/src/components/CollapsePanel.tsx`
- Create: `portal/src/components/CollapsePanel.test.tsx`
- Create: `portal/src/lib/listCollapse.ts`
- Create: `portal/src/lib/listCollapse.test.tsx`
- Modify: `portal/src/pages/InitiativeDetail.tsx` (Assets `init-panel`, ~line 758 to ~904)
- Test: `portal/src/pages/InitiativeDetail.test.tsx`

**Interfaces:**
- Consumes: `UiPreferences.list_view` (Task 2), `useAuth()` → `{ preferences, updatePreferences }`.
- Produces:
  - `CollapsePanel` props add `open?: boolean; onToggle?: (next: boolean) => void`.
  - `listCollapse.ts`: `export const LIST_OPEN_STATE_KEY = 'open_state';`, `export function initialListOpen(prefs: UiPreferences, listKey: string): boolean`, `export function useListCollapse(listKey: string): { open: boolean; setOpen: (next: boolean) => void }`.

- [ ] **Step 1: Failing tests.**

`CollapsePanel.test.tsx` (jsdom): (a) uncontrolled: `defaultOpen` false → body hidden; click head → visible, `aria-expanded="true"`. (b) controlled: `open={false}` + `onToggle` spy → click calls `onToggle(true)` and the body STAYS hidden until the parent rerenders with `open={true}`. (c) controlled + `render="lazy"`: children not mounted while `open={false}`; rerender `open={true}` → mounted; rerender `open={false}` → still mounted (hidden).

`listCollapse.test.tsx` (jsdom, mock `../auth/AuthContext` like `MePreferences.test.tsx` with a mutable `preferences` and an `updatePreferences` spy):
- `initialListOpen`: expanded → true; collapsed → false (even if `open_state[key]` is true); last + `open_state[key] === false` → false; last + no entry → true; last + non-boolean entry (`'no'`) → true; `list_view` undefined → true.
- `useListCollapse` (via `renderHook`): with `list_prefs: { initiative_assets: { visible: ['a'] }, open_state: { other: true } }`, calling `setOpen(false)` flips `open` to false and calls `updatePreferences` once with `list_prefs` equal to `{ initiative_assets: { visible: ['a'] }, open_state: { other: true, 'initiative-assets': false } }` and all other preference fields preserved. Also with `list_view: 'expanded'` the click is still saved.

`InitiativeDetail.test.tsx`: make the mocked `preferences` mutable (hoisted object reset in `beforeEach` to `list_view: 'expanded'`, `list_prefs: {}`), then:

```tsx
const assetsPanelHead = async () =>
  (await screen.findByRole('button', { name: /^Assets/ }));

it('assets panel: starts open with List view = expanded, and the chevron saves the state', async () => {
  const user = userEvent.setup();
  renderPage();
  const head = await assetsPanelHead();
  expect(head.getAttribute('aria-expanded')).toBe('true');
  expect(await screen.findByText('switch-01')).not.toBeNull();
  await user.click(head);
  expect(head.getAttribute('aria-expanded')).toBe('false');
  expect(updatePreferences).toHaveBeenCalledWith(expect.objectContaining({
    list_prefs: expect.objectContaining({ open_state: { 'initiative-assets': false } }),
  }));
});

it('assets panel: starts collapsed with List view = collapsed', async () => {
  prefs.list_view = 'collapsed';
  renderPage();
  expect((await assetsPanelHead()).getAttribute('aria-expanded')).toBe('false');
});

it('assets panel: Remember last restores the saved state', async () => {
  prefs.list_view = 'last';
  prefs.list_prefs = { open_state: { 'initiative-assets': false } };
  renderPage();
  expect((await assetsPanelHead()).getAttribute('aria-expanded')).toBe('false');
});
```

(If the head's accessible name differs, e.g. includes the count, keep the `/^Assets/` regex; make sure it does not also match another button.)

- [ ] **Step 2: Run** the three test files — FAIL.
- [ ] **Step 3: Implement.**

`CollapsePanel.tsx`:

```tsx
export default function CollapsePanel({
  title, badge, defaultOpen = false, open, onToggle, render = 'always', children,
}: {
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  /** Controlled mode: pass `open` (and `onToggle`) to own the state. */
  open?: boolean;
  onToggle?: (next: boolean) => void;
  render?: 'always' | 'lazy';
  children: ReactNode;
}) {
  const controlled = open !== undefined;
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = controlled ? open : innerOpen;
  const [everOpened, setEverOpened] = useState(isOpen);
  if (isOpen && !everOpened) setEverOpened(true);
  const body = render === 'lazy' && !everOpened ? null : children;
  const toggle = () => {
    const next = !isOpen;
    if (!controlled) setInnerOpen(next);
    onToggle?.(next);
  };
  // …same JSX, using isOpen and onClick={toggle}
}
```

Update the header doc comment to mention controlled mode and `useListCollapse`.

`listCollapse.ts`:

```ts
/**
 * useListCollapse — open/closed state for a collapsible list, driven by
 * the account's `list_view` preference (expanded / collapsed / last).
 * Every toggle is recorded in list_prefs.open_state[listKey] so "Remember
 * last" can restore it; the save merges onto the latest preferences.
 * A new list opts in with its own stable key — see the List view spec
 * (docs/superpowers/specs/2026-10-05-list-view-and-people-edit-design.md).
 */
import { useCallback, useRef, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import type { UiPreferences } from './api';

export const LIST_OPEN_STATE_KEY = 'open_state';

function openStateMap(prefs: UiPreferences): Record<string, unknown> {
  const map = prefs.list_prefs?.[LIST_OPEN_STATE_KEY];
  return map && typeof map === 'object' && !Array.isArray(map)
    ? (map as Record<string, unknown>) : {};
}

export function initialListOpen(prefs: UiPreferences, listKey: string): boolean {
  const mode = prefs.list_view ?? 'expanded';
  if (mode === 'collapsed') return false;
  if (mode === 'last') {
    const stored = openStateMap(prefs)[listKey];
    return typeof stored === 'boolean' ? stored : true;
  }
  return true;
}

export function useListCollapse(listKey: string) {
  const { preferences, updatePreferences } = useAuth();
  const [open, setOpenState] = useState(() => initialListOpen(preferences, listKey));
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    const current = prefsRef.current;
    void updatePreferences({
      ...current,
      list_prefs: {
        ...current.list_prefs,
        [LIST_OPEN_STATE_KEY]: { ...openStateMap(current), [listKey]: next },
      },
    });
  }, [listKey, updatePreferences]);
  return { open, setOpen };
}
```

`InitiativeDetail.tsx`: near the other Assets state (`assetsEditing`, ~line 285) add `const assetsPanel = useListCollapse('initiative-assets');`. In the Assets `init-panel` replace `<p className="eyebrow-sm">Assets{…}</p>` with `<CollapsePanel title={`Assets${isMove ? ` — ${assets.length}` : ''}`} open={assetsPanel.open} onToggle={assetsPanel.setOpen}>` wrapping everything that was in the panel after the eyebrow (the not-a-move hint, the error, the empty hint, and the progress/toolbar/list fragment), closing before the panel's `</div>`. Import `CollapsePanel` from `../components/CollapsePanel` and `useListCollapse` from `../lib/listCollapse`.

- [ ] **Step 4: Run** `npx vitest run src/components/CollapsePanel.test.tsx src/lib/listCollapse.test.tsx src/pages/InitiativeDetail.test.tsx src/components/NotesFilesPanel.test.tsx` (skip a file that doesn't exist) and `npx tsc -b` — pass. Existing InitiativeDetail assets tests must still pass unchanged (the panel starts open by default).
- [ ] **Step 5: Commit** `feat(portal): collapsible Assets list on initiatives, driven by the List view preference`.

---

### Task 4: People Edit table gated on rank 80+

**Files:**
- Modify: `portal/src/lib/access.ts` (add `SUPER_ADMIN_RANK`)
- Modify: `portal/src/pages/InitiativeDetail.tsx` (lines ~197, ~283–285 comment, ~548–552, ~1013–1018)
- Test: `portal/src/pages/InitiativeDetail.test.tsx`

**Interfaces:**
- Produces: `export const SUPER_ADMIN_RANK = 80;` in `portal/src/lib/access.ts` next to `ADMIN_RANK`.

- [ ] **Step 1: Failing tests** in `InitiativeDetail.test.tsx` (the mock already has `godMode: false`). The People section's toolbar is the one containing the "Filter people…" input; scope queries to it so the Assets "Edit table" button doesn't interfere:

```tsx
const peopleToolbar = async () =>
  (await screen.findByPlaceholderText('Filter people…')).closest('.dir-toolbar') as HTMLElement;

it('people list: Edit table shows for super admin (80) without god mode and edits Work type', async () => {
  auth.maxRank = 80;
  api.listInitiativeWorkTypes.mockResolvedValue([{ id: 'wt1', label: 'Tech', color: null }]);
  const user = userEvent.setup();
  renderPage();
  await user.click(within(await peopleToolbar()).getByRole('button', { name: 'Edit table' }));
  const row = await personRow();
  expect(row.closest('.dir-list')!.classList.contains('editing')).toBe(true);
  expect(within(row).getAllByRole('combobox').length).toBeGreaterThan(0);
});

it('people list: Edit table shows for developer (100)', async () => {
  auth.maxRank = 100;
  renderPage();
  expect(within(await peopleToolbar()).getByRole('button', { name: 'Edit table' })).not.toBeNull();
});

it('people list: Edit table is hidden for admin (60)', async () => {
  auth.maxRank = 60;
  renderPage();
  expect(within(await peopleToolbar()).queryByRole('button', { name: 'Edit table' })).toBeNull();
});

it('people list: Edit table is hidden without change permission', async () => {
  auth.maxRank = 100;
  auth.can = (_r, a) => a !== 'change';
  renderPage();
  expect(within(await peopleToolbar()).queryByRole('button', { name: 'Edit table' })).toBeNull();
});
```

(Adjust the work-type fixture shape to what `listInitiativeWorkTypes` returns, and the editor role to what GodCell renders for `select`/`combo`/`number` — a `<select>` is role `combobox`, a number input is `spinbutton`. If `canChange` is derived from a different permission than `change`, mirror the existing "Re-check placement is hidden without change permission" test.)

- [ ] **Step 2: Run** `npx vitest run src/pages/InitiativeDetail.test.tsx` — the 80 and 100 cases FAIL.
- [ ] **Step 3: Implement.**
  - `access.ts`: `export const SUPER_ADMIN_RANK = 80;` with a one-line comment, beside `ADMIN_RANK`.
  - `InitiativeDetail.tsx`: replace `const god = useGodEdit();` with `const [peopleEditing, setPeopleEditing] = useState(false);` and a comment: People edit table is gated on rank (super admin 80+) plus change permission, not god mode. Replace every `god.editing` with `peopleEditing`; the People toggle becomes `<GodEditToggle editing={peopleEditing} onToggle={() => setPeopleEditing((e) => !e)} visible={maxRank >= SUPER_ADMIN_RANK && canChange} />`. Update the Assets comment near line 283 so it no longer references `useGodEdit`/`god.editing`. Remove `useGodEdit` from the import and drop `godMode` from the `useAuth()` destructure if nothing else in the file uses them (tsc/eslint will tell you).
- [ ] **Step 4: Run** `npx vitest run src/pages/InitiativeDetail.test.tsx` and `npx tsc -b` — pass.
- [ ] **Step 5: Commit** `feat(portal): People Edit table on initiatives for super admin and above (Gaps 20)`.
