# Kiosk Bulk Print Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real `/labels/bulk` page on the kiosk (web and laptop) that prints any label type for the Kiosk Setup move on the printer saved in Printer Setup, mirroring the portal's `/labels/print`.

**Architecture:**
- The API gains `GET /kiosk/labels/bundle`. It shares one query helper with the portal's `/labels/generated/bundle`.
- The portal's `PrintAssetList`, `PrintContainerList` and `usePersistentListState` read list settings through a new `ListPrefsContext`, not `useAuth()`, so the kiosk can import them through `@portal`.
- The kiosk page reads rows from its synced IndexedDB stores, caches each bundle in a new `label_bundles` store, and prints through `StationPrinter`. `StationPrinter` gains `waitForIdle` for the end of a batch.

**Tech Stack:** API: FastAPI, async SQLAlchemy, pytest. Portal and kiosk: React 18, TypeScript, Vite 5, vitest 3 (`// @vitest-environment jsdom` for DOM tests), IndexedDB (`fake-indexeddb` in tests).

**Spec:** `docs/superpowers/specs/2026-11-07-kiosk-bulk-print-design.md` (binding for behavior and copy). Where it is silent, the portal page decides: `portal/src/pages/PrintLabels.tsx` and `docs/superpowers/specs/2026-09-12-print-labels-design.md`.

## Global Constraints

- **Worktree:** work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/kiosk-bulk-print` (branch `kiosk-bulk-print`). Never edit tracked files in the main checkout.
- **Never commit `api/src/serversherpa/_dev_reload.py`.** If it shows as modified, run `git checkout -- api/src/serversherpa/_dev_reload.py` in this worktree only.
- **Commits:** every message ends with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never run bare `git stash`.
- **API tests:** the worktree has no venv. From `api/`, run `SS_TEST_DB=serversherpa_test_kiosk_bulk_print PYTHONPATH=src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest <files> -q -p no:cacheprovider`. `PYTHONPATH=src` is required, or the shared venv imports the main checkout's code. Lint with `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/ruff check <files>`. Don't run the whole API suite.
- **Kiosk:** from `kiosk/`, run `npx vitest run <files>`, `npx tsc -b`, and `npm run build`. **Portal:** from `portal/`, run `npx vitest run <files>` and `npm run build`. `node_modules` in both are symlinks to the main checkout's.
- **Copy:** American English, verbatim from the spec or from the portal page. Kiosk-only strings are fixed in the tasks below. Times are 24-hour.
- **Modals:** use the kiosk's report-generate header: `modal-scrim` › `modal-card reports-modal-card rgm-card` › `modal-head` › `rgm-head-text` (eyebrow `Bulk Print`, `h3`, `page-hint`) plus `modal-close`, with rounded corners (the shared `.modal-card` radius; never square).
- **Look:** every screen follows the kiosk's light and dark themes (tokens only, never a forced theme). No default browser scrollbars: scroll areas use the kiosk's themed scrollbar styling.
- **Printer:** no status checks or waits beyond the spec's. The only new wait is `waitForIdle` at the end of a Bulk Print batch. The Printing Station's print path is unchanged.
- **Policy values:** no new limits. Copies, batch size and blanks use the portal's `SETTING_LIMITS` and `DEFAULT_PRINT_SETTINGS`.
- **No Labeled scans and no outbox rows** from Bulk Print.
- **`@portal` imports:** stylesheets, React-free `.ts`, or the allowlist in `kiosk/src/portalImports.test.ts` only.

## Review Focus

These five cases are the most likely to bite a real user, and no spec test covers them. Each gets a test in the task named.

1. **The synced stores belong to another move.** Kiosk Setup changed but the sync hasn't finished or failed. The page must not list the old move's assets against the new move's labels. It shows the syncing or no-data state instead (Task 8, `rows from another move's sync are not listed`).
2. **A late bundle response for a type the person already left.** It must be dropped, never shown under the new type (Task 8, `a late bundle for the previous type is dropped`).
3. **A move with more than 300 assets.** `VirtualRows` looks for `.portal-main`, but the kiosk scrolls `.kiosk-main`. Without a fix the list renders empty. The lists gain an optional `scroller` prop and the kiosk passes `.kiosk-main` (Task 2, `forwards scroller to VirtualRows`; Task 8 passes it).
4. **A send that fails mid-batch** (USB unplugged). The batch shows `Batch N failed: …`. Reprint resends that batch from its first label, and nothing is half-recorded (Task 9, `a failed send stops the batch and Reprint resends it`).
5. **Saving list settings must not loop, and bad stored settings must not crash.** `saveListPrefs` keeps one identity, so one change makes exactly one save (Task 2, `one change saves once`). A non-JSON, array, or throwing `ss.kiosk.listPrefs` falls back to defaults (Task 3, `unreadable list settings fall back to defaults`).

## Decisions where the spec left a choice

- **`ListPrefsContext` default.** The default is an inert value, not a throw. 133 portal tests mock `useAuth` without `AuthProvider`, and they keep rendering. Only the tests that seed or assert list settings get the `ListPrefsFromAuth` wrapper.
- **Lists' `scroller` prop.** It's a small change to the "unchanged" lists: without it, a move with more than 300 assets renders an empty list on the kiosk.
- **Offline notice.** It uses the portal's actual text ("Offline — using labels downloaded …"), not the spec's paraphrase.
- **Asset ID and make/model.** The portal shows `asset.legacy_id`, so it maps from `legacy_id` (falling back to the numeric `asset_id`). Make and Model come from `make` and `model`, since the portal shows them as two columns.
- **Out-of-scope 404.** It can't be built in a test (`labels` is global-only), so the API test covers unknown and archived moves.
- **`unknown_label_type`** means no `type` row with that key, active or not.

---

### Task 1: API — shared bundle helper and `GET /kiosk/labels/bundle`

**Files:**
- Modify: `api/src/serversherpa/api/routes/labels.py`: extract the query and response of `get_generated_label_bundle` (~line 1982) into a helper. The portal route keeps its signature and docstring.
- Modify: `api/src/serversherpa/api/routes/kiosk.py`: the new route, in the "label vocabulary" section next to `list_label_vocab` (~line 2974). Extend the existing `from serversherpa.api.routes.labels import …` line, and import `GeneratedLabelBundleOut` from schemas.
- Test: `api/tests/test_kiosk_label_bundle_api.py` (new). Rerun `api/tests/test_label_print_bundle_api.py` and `api/tests/test_kiosk_labels_api.py` unchanged.

**Interfaces:**
- Produces, in `labels.py`: `async def generated_label_bundle(db: AsyncSession, ini: Initiative, label_type: str) -> GeneratedLabelBundleOut`. It holds the same `entity_for_type` filter, ordering and fields as today's route. The portal route becomes `ini = await _scoped_initiative(db, actor, initiative_id)` followed by `return await generated_label_bundle(db, ini, label_type)`.
- Produces, in `kiosk.py`: `GET /kiosk/labels/bundle?initiative_id=<uuid>&label_type=<str>`, response `GeneratedLabelBundleOut`, as `async def get_kiosk_label_bundle(db: DbSession, initiative_id: uuid.UUID, label_type: str, actor: AuthContext = require_permission("labels", "view"))`. The checks run in this order:
  1. `actor.access.can("kiosk", "view")`, else `_err(403, "forbidden")`. The kiosk router has no router-level guard; every route carries `kiosk:view` itself.
  2. `_require_move(actor, initiative_id)`, which gives 403 `move_locked`.
  3. `_scoped_initiative(db, actor, initiative_id)` (imported from labels.py), which gives 404 `initiative_not_found`.
  4. A `label_vocab` row with `kind == "type"` and `key == label_type` must exist (active or not), else `_err(422, "unknown_label_type")`.
  5. `return await generated_label_bundle(db, ini, label_type)`.
- The edge is unchanged. Don't add the route to its cacheable list.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_kiosk_label_bundle_api.py`. Reuse `_initiative`, `_asset_on` and `_template` from `tests.test_label_generate_api`. Reuse `_label`, `_container_on` and `_container_label` from `tests.test_label_print_bundle_api`. Reuse `_make` and `PW` from `tests.test_status_values_write`, and `move_password as mp_svc` from services. `URL = "/kiosk/labels/bundle"`.
  - `test_staff_gets_the_bundle_and_a_worker_is_refused`:
    - Create two assets with `top` labels.
    - Staff (`_make(..., "staff", ...)`) gets 200. The labels' `entity_id` set equals both asset ids, and `label_type == "top"`.
    - A worker gets 403 with `detail.code == "forbidden"`.
  - `test_labels_view_without_kiosk_view_is_refused`: a staff person with `PermissionOverride(resource="kiosk", action="view", allow=False)` gets 403 `forbidden`.
  - `test_a_kiosk_sign_in_reaches_the_route`: a staff person signs in with `POST /auth/login` and `{"email", "password": PW, "client": "kiosk"}`, then gets 200.
  - `test_a_locked_session_on_another_move_gets_move_locked`:
    - Set up two moves, both `status="in_progress"`, and `mp_svc.set_password(db, move, "Crew-2026!", actor_id=seeded_user.id)`.
    - `account = await mp_svc.ensure_kiosk_identity(db, move)`, then add `PersonRole(person_id=account.person_id, role="staff")` and commit. Without labels:view the lock is never reached.
    - Sign in with `POST /kiosk/move-login`.
    - The own move gets 200. The other move gets 403 with `detail.code == "move_locked"`.
  - `test_an_unknown_or_archived_move_gets_404`: an archived move and a random UUID each give 404 `initiative_not_found`. Out-of-scope isn't constructible: `labels` is `visible_to={"global"}`, so a scoped actor is refused before the scope check (see the docstring at `tests/test_label_generate_api.py:310`). Say so in this test's docstring.
  - `test_an_unknown_label_type_gets_422`: `label_type=nope` gives 422 with `detail.code == "unknown_label_type"`. The portal route with the same type still answers 200 with `labels == []`, so it's unchanged.
  - `test_the_body_matches_the_portal_route`:
    - Asset A has `top` at 203. Add a second `GeneratedLabel` for A at `dpi_key="300"`. Asset B has a stale `top`. Container C has a `container` label.
    - For `top` and for `container`, compare the portal and kiosk responses as staff: `{k: v for k, v in body.items() if k != "fetched_at"}`. They must be equal.
    - The `top` body has three labels, and the `container` body one.
- [ ] **Step 2: Run** the new file (command in Global Constraints). Expected: FAIL. The new tests get 404 (no route).
- [ ] **Step 3: Implement** the helper and the route as above. Keep the portal route's docstring, and give the kiosk route one that explains why it exists: a kiosk session can reach only `/kiosk/*`.
- [ ] **Step 4: Run** `tests/test_kiosk_label_bundle_api.py tests/test_label_print_bundle_api.py tests/test_kiosk_labels_api.py tests/test_kiosk_session_scope.py`, then ruff on both route files and the test. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(api): GET /kiosk/labels/bundle sharing the portal bundle query`.

---

### Task 2: Portal — `ListPrefsContext` for the print lists and column state

**Files:**
- Create: `portal/src/lib/listPrefs.tsx`
- Create: `portal/src/test/ListPrefsFromAuth.tsx` (a test-only wrapper)
- Modify: `portal/src/auth/AuthContext.tsx` (`AuthProvider` renders the provider around `children`)
- Modify: `portal/src/lib/columnMenu.tsx`: `usePersistentListState` uses `useListPrefs()`, and `naturalCompare` comes from `./naturalSort`.
- Modify: `portal/src/components/labels/PrintAssetList.tsx` and `PrintContainerList.tsx`:
  - `useListPrefs().listSize` replaces `useAuth().preferences.list_size`.
  - `naturalCompare` comes from `../../lib/naturalSort`.
  - Each gets an optional `scroller?: string` prop, forwarded to `VirtualRows`.
- Tests:
  - Create `portal/src/lib/listPrefs.test.tsx`.
  - Modify `portal/src/lib/columnMenu.test.tsx`, `portal/src/components/labels/PrintAssetList.test.tsx` and `PrintContainerList.test.tsx`.
  - Modify any other portal test the full run shows failing because of this change (see Step 6).

**Interfaces:**
- Produces, in `lib/listPrefs.tsx` (React, no runtime import outside `react`; `UiPreferences` only as `import type`):
  - `export interface ListPrefsValue { listPrefs: Record<string, unknown>; listSize: UiPreferences['list_size'] | undefined; saveListPrefs(next: Record<string, unknown>): void }`.
  - `export const NO_LIST_PREFS: ListPrefsValue`: `{}`, `undefined`, and a no-op save. It is the context default, so a tree with no provider renders and saves nothing, and tests that mock `useAuth` keep rendering.
  - `export const ListPrefsContext = createContext<ListPrefsValue>(NO_LIST_PREFS)`.
  - `export function useListPrefs(): ListPrefsValue`.
  - `export function useAccountListPrefs(preferences: UiPreferences, updatePreferences: (prefs: UiPreferences) => unknown): ListPrefsValue`. It returns `listPrefs: preferences.list_prefs ?? {}` and `listSize: preferences.list_size`. `saveListPrefs(next)` calls `updatePreferences({ ...latestPreferences, list_prefs: next })`. **`saveListPrefs` keeps one identity for the hook's lifetime**: refs hold the latest preferences and update function. A changing identity would re-run the save effect and loop.
  - `usePersistentListState` (signature unchanged) hydrates from `listPrefs[pageKey]` and saves `saveListPrefs({ ...latestListPrefs, [pageKey]: { visible, sortKey, sortDir, filters, order, seen } })`, the same entry shape as today. It reads `saveListPrefs` through a ref, kept out of the save effect's deps.
  - `PrintAssetList` and `PrintContainerList` props gain `scroller?: string`, default undefined, which means VirtualRows' `.portal-main`.
- Produces, in `src/test/ListPrefsFromAuth.tsx`: `export function ListPrefsFromAuth({ children }: { children: ReactNode })`. It reads `useAuth()` (the test's mock) and provides `useAccountListPrefs(preferences, updatePreferences)`. Tests pass it as `render(ui, { wrapper: ListPrefsFromAuth })` or `renderHook(fn, { wrapper: ListPrefsFromAuth })`.

- [ ] **Step 1: Write the failing tests.**
  - `lib/listPrefs.test.tsx`:
    - `the default value renders with no provider`: `renderHook(useListPrefs)` gives `listPrefs` equal to `{}` and `listSize` undefined, and `saveListPrefs({a: 1})` doesn't throw.
    - `account prefs save onto the latest preferences`:
      - `useAccountListPrefs` starts with `{...prefs, list_size: 'large', list_prefs: {a: 1}}`, then rerenders with `accent: 'pink'`.
      - `saveListPrefs({b: 2})` calls `updatePreferences` with `list_prefs: {b: 2}`, `accent: 'pink'` and `list_size: 'large'`.
      - `listSize` is `'large'`.
    - `one change saves once`:
      - A wrapper holds preferences in `useState` and its `updatePreferences` sets them, as `AuthProvider` does.
      - Render `usePersistentListState('sites', …)` inside it and call `setSort('name', -1)`.
      - Advance fake timers by 600 ms, then by 5000 ms more.
      - `updatePreferences` was called exactly once.
    - `AuthProvider provides account list prefs`: render the real `AuthProvider` with `savePreferencesRequest` mocked, and a child that calls `useListPrefs()`. The child sees the provider's value, not `NO_LIST_PREFS` (compare `toBe`).
  - `PrintAssetList.test.tsx`, test `forwards scroller to VirtualRows`:
    - `vi.mock('../../lib/virtualRows', …)` records the `scroller` prop.
    - Rendering with `scroller=".kiosk-main"` records `'.kiosk-main'`. Rendering without it records `undefined`.
  - In `columnMenu.test.tsx`, `PrintAssetList.test.tsx` and `PrintContainerList.test.tsx`, wrap each render in `ListPrefsFromAuth`. Their existing assertions on `auth.updatePreferences` (account saves, other pages' entries kept) stay unchanged.
- [ ] **Step 2: Run** `npx vitest run src/lib/listPrefs.test.tsx src/lib/columnMenu.test.tsx src/components/labels/PrintAssetList.test.tsx src/components/labels/PrintContainerList.test.tsx`. Expected: FAIL, because `lib/listPrefs` doesn't exist.
- [ ] **Step 3: Take a baseline.** Before any product change, run the whole portal suite with `npx vitest run` and save the list of failing files to a file outside the repo. Do the same in `sirdar/web`.
- [ ] **Step 4: Implement** `lib/listPrefs.tsx` and the provider in `AuthProvider`: `const listPrefs = useAccountListPrefs(state.preferences, updatePreferences)`, then `<ListPrefsContext.Provider value={listPrefs}>` inside `AuthContext.Provider`. Also implement the `columnMenu.tsx` and list changes. None of the three shared modules imports `../auth/AuthContext` or `./sites` any more.
- [ ] **Step 5: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 6: Fix each newly failing test.** Run `npx vitest run` again and compare with the baseline. Wrap each new failure's render in `ListPrefsFromAuth`, and change nothing else. Likely ones: tests that seed `preferences.list_prefs` through a mocked `useAuth`, such as `pages/InitiativeDetail.test.tsx`, `pages/MoveDashboard.test.tsx`, `pages/FixedReaders.test.tsx`, `pages/Containers.test.tsx`, `components/scans/RawScansTab.test.tsx` and `components/containers/ContainerContentsList.test.tsx`. Rerun until the failures match the baseline.
- [ ] **Step 7: Run** `npm run build` from `portal/`, and `npx vitest run` from `sirdar/web`, which renders the portal's `AuthProvider`. Expected: the build is clean, and sirdar's failures match its baseline.
- [ ] **Step 8: Commit** `refactor(portal): list settings through ListPrefsContext; print lists take a scroller`.

---

### Task 3: Kiosk — import the portal lists, and keep list settings on the kiosk

**Files:**
- Modify: `kiosk/package.json` and `kiosk/package-lock.json` (add `@tanstack/react-virtual`)
- Modify: `kiosk/vite.config.ts` (`resolve.dedupe`)
- Modify: `kiosk/src/portalImports.test.ts` (`REACT_ALLOWLIST`)
- Create: `kiosk/src/lib/listPrefs.ts`
- Test: `kiosk/src/lib/listPrefs.test.ts` (new, jsdom)

**Interfaces:**
- Consumes: `ListPrefsContext`, `ListPrefsValue` and `usePersistentListState` from Task 2 (`@portal/lib/listPrefs`, `@portal/lib/columnMenu`).
- `REACT_ALLOWLIST` becomes `['components/login/*', 'components/labels/PrintAssetList', 'components/labels/PrintContainerList', 'lib/columnMenu', 'lib/listTools', 'lib/virtualRows', 'lib/listPrefs']`.
- `resolve.dedupe` becomes `['react', 'react-dom', 'gsap', '@tanstack/react-virtual']`.
- Produces, in `kiosk/src/lib/listPrefs.ts` (a `.ts` file; build the element with `createElement`):
  - `export const KIOSK_LIST_PREFS_KEY = 'ss.kiosk.listPrefs'`.
  - `export function readKioskListPrefs(): Record<string, unknown>`. It returns `{}` when the key is missing, not JSON, not a plain object (an array or null counts as not an object), or when `localStorage` throws.
  - `export function writeKioskListPrefs(next: Record<string, unknown>): void`. Best effort: it swallows storage errors.
  - `export function KioskListPrefsProvider({ listSize, children }: { listSize: UiPreferences['list_size'] | undefined; children: ReactNode }): ReactElement`. It provides `{ listPrefs, listSize, saveListPrefs }`. `listPrefs` is state seeded from `readKioskListPrefs()`. `saveListPrefs` keeps one identity: it writes the key and sets the state. The key is not added to Clear Setup's `KEEP_KEYS`, so Clear Setup resets it (pinned in Task 4).

- [ ] **Step 1: Add the dependency.**
  - Run `npm install @tanstack/react-virtual@3.14.10` from `kiosk/` (the portal's version). Check that `package.json` lists `"@tanstack/react-virtual": "^3.14.10"` under `dependencies`.
  - `node_modules` is a symlink, so the package lands in the main checkout's `kiosk/node_modules`. That's additive. Verify with `ls kiosk/node_modules/@tanstack/react-virtual/package.json`, and check that `git -C /Users/jrh1812/Developer/BaseCampV3 status --short` shows no tracked-file change.
  - If npm replaced the symlink with a real folder, that's fine too. Don't commit `node_modules`.
- [ ] **Step 2: Write the failing tests.**
  - `lib/listPrefs.test.ts` (fake timers, `renderHook` with a wrapper of `KioskListPrefsProvider listSize="large"`):
    - `saves and restores sort, filters and columns`:
      - Call `usePersistentListState('labels-print', { visible: new Set(['asset_id', 'name']), sortKey: 'source_rack', sortDir: 1 }, new Set(['asset_id', 'name', 'serial']))`.
      - Run `setSort('name', -1)`, `setFilter('name', { text: 'sw' })` and `setVisibleCols(new Set(['name', 'serial']))`, then advance 600 ms.
      - `JSON.parse(localStorage['ss.kiosk.listPrefs'])['labels-print']` has `sortKey: 'name'`, `sortDir: -1`, `filters: { name: { text: 'sw' } }` and `visible` `['name', 'serial']`.
      - Unmount and render again. The hook starts with sort `name` / -1, that filter, and those columns.
    - `keeps other pages' entries`: seed `{ 'labels-print-containers': { sortKey: 'site' } }`. After a save of `labels-print`, the containers entry is still there.
    - `listSize comes from the prop`: `useListPrefs().listSize` is `'large'`.
    - `unreadable list settings fall back to defaults` (Review Focus 5): for the stored values `'{not json'`, `'[1,2]'` and `'null'`, and for a `localStorage.getItem` that throws, `readKioskListPrefs()` gives `{}` and the hook starts at its defaults.
  - `portalImports.test.ts` is unchanged apart from the allowlist. It must pass, including its dedupe test.
- [ ] **Step 3: Run** `npx vitest run src/lib/listPrefs.test.ts src/portalImports.test.ts`. Expected: FAIL, because `lib/listPrefs` doesn't exist.
- [ ] **Step 4: Implement** `lib/listPrefs.ts` and the allowlist and dedupe changes.
- [ ] **Step 5: Run** the Step 3 command, then `npx tsc -b`. Expected: PASS and clean.
- [ ] **Step 6: Commit** `feat(kiosk): import the portal print lists; list settings kept on the kiosk`.

---

### Task 4: Kiosk — bundle fetch, `label_bundles` store, vocab cache

**Files:**
- Modify: `kiosk/src/lib/localDb.ts`:
  - `DB_VERSION` goes from 7 to 8, and `StoreName` gains `'label_bundles'`.
  - `STORES` gains `'label_bundles'` before `'meta'`.
  - The upgrade creates `label_bundles` with keyPath `key`.
  - The header comment says v8.
- Modify: `kiosk/src/lib/api.ts`: `fetchKioskLabelBundle`, plus re-exported types.
- Create: `kiosk/src/lib/bundleCache.ts`
- Tests:
  - `kiosk/src/lib/localDb.test.ts`: v8 store, and an upgrade from v7.
  - `kiosk/src/lib/api.kioskLabels.test.ts`: the new fetch.
  - `kiosk/src/lib/bundleCache.test.ts` (new, jsdom).
  - `kiosk/src/lib/factoryReset.test.ts`: Clear Setup.

**Interfaces:**
- Produces, in `api.ts`:
  - `export type { GeneratedLabelBundle, GeneratedLabelBundleItem }` from `@portal/lib/api`.
  - `export async function fetchKioskLabelBundle(initiativeId: string, labelType: string): Promise<GeneratedLabelBundle>`. It calls GET `/kiosk/labels/bundle?initiative_id=<enc>&label_type=<enc>` through `apiFetch`/`jsonFrom`, so `edge_offline` becomes `ApiError(0, 'network')`.
- Produces, in `bundleCache.ts`:
  - `export interface CachedBundle extends GeneratedLabelBundle { cached_at: string }`.
  - `export function bundleKey(initiativeId: string, labelType: string): string` gives `` `${initiativeId}:${labelType}` ``.
  - `export function isOfflineError(err: unknown): boolean`: true for an `ApiError` with code `'network'` (which covers `edge_offline`) or `'cloud_sign_in_required'`.
  - `export async function putCachedBundle(bundle: GeneratedLabelBundle, now?: Date): Promise<void>`. The row is `{ key, initiative_id, label_type, cached_at, bundle }`, written with `putRows('label_bundles', …)`.
  - `export async function getCachedBundle(initiativeId: string, labelType: string): Promise<CachedBundle | null>`.
  - `export async function cachedBundleTypes(initiativeId: string): Promise<string[]>`: the label types of this move's cached rows, natural-sorted.
  - `export async function loadBundle(initiativeId: string, labelType: string): Promise<{ bundle: GeneratedLabelBundle; offlineSince: string | null }>`:
    - Online: fetch, put, and return `offlineSince: null`.
    - On `isOfflineError` with a cached row: return that row's bundle with `offlineSince` set to its `cached_at`.
    - Otherwise it rethrows.
  - `export async function loadVocab(): Promise<{ vocab: LabelVocab[]; offline: boolean }>`:
    - Online: `fetchLabelVocab()`, then write meta `'label_vocab'` `{ rows, cached_at }`.
    - On `isOfflineError`: the stored rows with `offline: true`, or `{ vocab: [], offline: true }` when none are stored.
    - Otherwise it rethrows.

- [ ] **Step 1: Write the failing tests.**
  - `localDb.test.ts`:
    - `v8 adds label_bundles`: the `objectStoreNames` of a fresh DB include `label_bundles`.
    - `upgrades a v7 database in place, keeping its data and adding label_bundles`: copy the v6→v7 case's shape.
    - `clearDb empties label_bundles`.
  - `api.kioskLabels.test.ts`, test `gets /kiosk/labels/bundle with both params encoded`: `fetchKioskLabelBundle('i 1', 'top')` calls `http://api.test/kiosk/labels/bundle?initiative_id=i%201&label_type=top`.
  - `bundleCache.test.ts` (fake-indexeddb as in `localDb.test.ts`; `fetch` stubbed as in `api.kioskLabels.test.ts`):
    - `an online load is written through and served`: `offlineSince` is null, and `getCachedBundle('i-1','top')` then has `cached_at` and the same labels.
    - `it.each` over a rejected `fetch` (network), a 503 `{detail:{code:'edge_offline'}}`, and a 403 `{detail:{code:'cloud_sign_in_required'}}`:
      - `falls back to the cache on %s`: with a cached bundle, `loadBundle` resolves to it and `offlineSince` equals its `cached_at`.
      - `loadVocab` resolves to the stored rows with `offline: true`.
    - `rethrows offline with no cache`: `loadBundle` rejects with `code: 'network'`.
    - `rethrows a non-offline error even with a cache`: a 403 `forbidden` rejects.
    - `cachedBundleTypes lists only this move's types`: rows for `i-1:front`, `i-1:top` and `i-2:rail` give `['front', 'top']` for `i-1`.
    - `another move's bundle never serves`: a cached `i-2:top` row doesn't answer `loadBundle('i-1','top')` offline.
  - `factoryReset.test.ts`, test `Clear Setup empties label_bundles and the kiosk list settings`: seed one `label_bundles` row and `localStorage['ss.kiosk.listPrefs']`. After `runClearSetup(...)`, `count('label_bundles') === 0` and the key is null.
- [ ] **Step 2: Run** `npx vitest run src/lib/localDb.test.ts src/lib/api.kioskLabels.test.ts src/lib/bundleCache.test.ts src/lib/factoryReset.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the store, the fetch and `bundleCache.ts`.
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run src/lib`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kiosk): label bundle fetch with an IndexedDB cache and offline vocab`.

---

### Task 5: Kiosk — row adapter and Bulk Print settings helpers

**Files:**
- Modify: `kiosk/src/lib/api.ts`: `KioskAssetRow` and `KioskContainerRow` gain fields the API already sends.
- Create: `kiosk/src/lib/bulkPrintRows.ts`
- Create: `kiosk/src/lib/bulkPrintSettings.ts`
- Tests: `kiosk/src/lib/bulkPrintRows.test.ts`, `kiosk/src/lib/bulkPrintSettings.test.ts` (new, jsdom for localStorage)

**Interfaces:**
- `KioskAssetRow` gains optional fields (optional so existing fixtures compile):
  - `legacy_id?: number | null`
  - `source_rack`, `source_ru`, `source_ru_raw`, `source_position`, `source_pod`
  - `destination_rack`, `destination_ru`, `destination_ru_raw`, `destination_position`, `destination_pod`
  - `priority_wave`, `disposition`, `owner`
  - `pod_number`, `asset_status`, `asset_status_label`, `roster_status`, `roster_status_label`
  - `vendor_involved?: boolean | null`
  - All the unnamed ones are `?: string | null`.
- `KioskContainerRow` gains `legacy_id?: number | null` and `container_type_label?: string | null`.
- Produces, in `bulkPrintRows.ts`:
  - `export function ruNumber(display: string | null | undefined, raw: string | null | undefined): number | null` returns `Number(raw ?? display)`, or null when that's not finite or both are absent.
  - `export function toPrintAssetRow(a: KioskAssetRow): InitiativeAssetRow`. Mapping:
    - `id` and `asset_id` come from `a.id`, the UUID that bundles key `entity_id` by.
    - `asset.id` is `a.id`.
    - `asset.legacy_id` is `a.legacy_id ?? ruNumber(a.asset_id, null)`. The portal's Asset ID column shows `asset.legacy_id`.
    - `asset.name` and `asset.serial_number` keep their names.
    - `asset.model_make` comes from `a.make` and `asset.model_name` from `a.model`. The portal list has separate Make and Model columns. `make_model` is their joined text.
    - `asset.rfid_tag` comes from `a.rfid`, and `asset.pod_number` keeps its name.
    - `asset.status` and `asset.status_label` come from `asset_status` / `asset_status_label` (or `''`). `asset.status_color` is `''`.
    - The other summary fields are null.
    - Rack, position, pod, wave, disposition and owner keep their names (null when absent).
    - `source_ru` / `destination_ru` come from `ruNumber(*_ru, *_ru_raw)`.
    - `status` / `status_label` come from `roster_status` / `roster_status_label` (or `''`). `status_color` is `''`, so the chip shows plain.
    - Verified, `cable_info` and `vendor_involved` are null (`vendor_involved` from the row when present). `created_at` and `updated_at` are `''`.
  - `export function toPrintContainerItem(c: KioskContainerRow): ContainerItem`:
    - `type_label` comes from `container_type_label ?? null`. `type_color` is null and `status_color` is `''`.
    - `archived_at` is null: the sync sends only unarchived containers.
    - `location_detail` is `''`, `last_audit_at` / `last_validated_at` are null, and `created_at` is `''`.
    - `label_tag` is cast to `TagKey | null`.
    - `id`, `name`, `rfid_tag`, `container_type`, `status`, `status_label`, `site_id`, `site_name` and `asset_count` keep their names.
- Produces, in `bulkPrintSettings.ts` (from `@portal/lib/printLabels`; `withPrintMode` from `./stationPrinter`):
  - `export function bulkSettingsModified(s: PrintSettings): boolean`: `settingsModified` with both offsets set to 0, so stored offsets never light the dot.
  - `export function writeBulkSettings(s: PrintSettings): void`: `writePrintSettings({ ...readPrintSettings(), copies, batchSize, printByRack, blanksBetweenRacks })`, so the offsets PrinterTools keeps survive.
  - `export function resetBulkSettings(s: PrintSettings): PrintSettings`: `s` with the four fields at `DEFAULT_PRINT_SETTINGS`, offsets kept.
  - `export function stationZpl(zpl: string, s: PrintSettings, saved: LabelStationSettings, opts?: { singleCopy?: boolean }): string`: `withPrintMode(applyPrintSettings(zpl, { ...s, horizontalOffset: saved.offset_x, verticalOffset: saved.offset_y }, opts), saved.peel)`.

- [ ] **Step 1: Write the failing tests.**
  - `bulkPrintRows.test.ts`, test `maps the id, RU and status fields`:
    - Input: `{ id: 'u-1', asset_id: '1042', legacy_id: 1042, make: 'Dell', model: 'R640', source_rack: 'A12', source_ru: '14', source_ru_raw: '14.50', destination_ru: null, roster_status_label: 'Packed', … }`.
    - Expected: `asset_id === 'u-1'`, `asset.legacy_id === 1042`, `asset.model_make === 'Dell'`, `source_ru === 14.5`, `destination_ru === null`, `status_label === 'Packed'` and `status_color === ''`.
    - Also: `ruNumber('U?', null)` is null, `ruNumber('22', undefined)` is 22, and `legacy_id` absent with `asset_id: ''` gives `asset.legacy_id === null`.
  - `bulkPrintRows.test.ts`, test `maps a container`: `container_type_label: 'Crate'` gives `type_label: 'Crate'`, `type_color: null`, `archived_at: null` and `status_color: ''`.
  - `bulkPrintSettings.test.ts`:
    - `the settings window keeps the stored offsets`: seed `labels.print.settings` with `{ verticalOffset: 12, horizontalOffset: -4, copies: 1, batchSize: 50, printByRack: false, blanksBetweenRacks: 1 }`. `writeBulkSettings({ ...DEFAULT_PRINT_SETTINGS, copies: 3 })` leaves `readPrintSettings()` with `verticalOffset 12`, `horizontalOffset -4` and `copies 3`.
    - `offsets alone are not modified`: `bulkSettingsModified({ ...DEFAULT_PRINT_SETTINGS, verticalOffset: 12 })` is false, and `copies: 2` is true.
    - `reset keeps offsets`.
    - `stationZpl uses the saved offsets and print mode`: `stationZpl('^XA^FDA^FS^XZ', DEFAULT_PRINT_SETTINGS, { offset_x: 8, offset_y: -3, peel: true, … })` contains `^MMP`, `^LS-8` and `^LT-3`. With `peel: false` it contains `^MMT`. With `copies: 2` and `singleCopy: true` it has no `^PQ2`.
- [ ] **Step 2: Run** `npx vitest run src/lib/bulkPrintRows.test.ts src/lib/bulkPrintSettings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules and the type additions.
- [ ] **Step 4: Run** the Step 2 command and `npx tsc -b`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(kiosk): Bulk Print row adapter and settings helpers`.

---

### Task 6: Kiosk — `StationPrinter.waitForIdle`

**Files:**
- Modify: `kiosk/src/lib/stationPrinter.ts`: `StationPrinter` and `Transport` gain `waitForIdle`.
  - `usbStationPrinter` forwards to `zebra.waitForIdle`.
  - `networkStationPrinter` forwards to `networkZebraPrinter(ip).waitForIdle` (from `./networkZebra`), which polls `~HS` once a second through the edge for at most 60 s.
- Modify: every `StationPrinter` fake that `npx tsc -b` flags. Add `waitForIdle: vi.fn(async () => undefined)` and nothing else. These are likely in `components/setup/TestLabelModal.test.tsx`, `lib/useStationPrinter.test.ts`, `lib/printQueue.test.ts`, `pages/StationPrinterTools.test.tsx` and `pages/PrintingStation.test.tsx`.
- Tests: `kiosk/src/lib/stationPrinter.test.ts`, `kiosk/src/pages/PrintingStation.test.tsx`

**Interfaces:**
- Produces: `StationPrinter.waitForIdle(labelsSent: number, onQueued?: (queued: number) => void): Promise<void>`.

- [ ] **Step 1: Write the failing tests.**
  - `stationPrinter.test.ts`, test `waitForIdle over USB calls the hook's`: a fake `zebra.waitForIdle` gets `(7, onQueued)`.
  - `stationPrinter.test.ts`, test `waitForIdle over the network polls ~HS through the edge until nothing is queued`:
    - Mock `printerQuery` to answer `~HS` with 2 queued formats, then 0. Use fake timers.
    - `onQueued` gets `[2, 0]`. Every query went to `10.0.0.40` with `~HS`.
  - `PrintingStation.test.tsx`, test `the Printing Station never waits for idle`: add `waitForIdle: station.waitForIdle` (a `vi.fn`) to the mocked printer. After a scan prints, `station.waitForIdle` was not called.
- [ ] **Step 2: Run** `npx vitest run src/lib/stationPrinter.test.ts src/pages/PrintingStation.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**, then fix the fakes `tsc` names.
- [ ] **Step 4: Run** `npx tsc -b` and `npx vitest run src/lib src/pages/PrintingStation.test.tsx src/pages/StationPrinterTools.test.tsx src/components/setup`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(kiosk): StationPrinter.waitForIdle over USB and the network`.

---

### Task 7: Kiosk — Bulk Print settings and batch windows

**Files:**
- Create: `kiosk/src/components/labels/BulkPrintSettingsModal.tsx`, `kiosk/src/components/labels/BulkPrintBatchModal.tsx`
- Tests: `kiosk/src/components/labels/BulkPrintSettingsModal.test.tsx`, `BulkPrintBatchModal.test.tsx` (new, jsdom)

**Interfaces:**
- Consumes: `bulkSettingsModified` and `resetBulkSettings` (Task 5), and the kiosk `Switch` (`components/Switch.tsx`, prop `on`, not `checked`).
- Produces:
  - `export default function BulkPrintSettingsModal(props: { settings: PrintSettings; onChange(next: PrintSettings): void; onClose(): void })`.
    - Fields from the portal's `PrintSettingsModal`, with the same labels, hints, `ps-<key>` ids, free-text-then-clamp-on-blur/Enter behavior and `clampSetting`:
      - **Copies** ("Number of copies per label")
      - **Batch size** ("Labels per batch before pausing")
      - **Print by rack**, with the portal's description
      - **Blanks between racks** ("Labels fed at each rack change", disabled while Print by rack is off)
    - No offsets, alignment test, size or DPI.
    - Sections are "Copies" and "Rack order".
    - Header: eyebrow `Bulk Print`, h3 `Print settings`, hint `Copies apply to every label sent from this page. Settings are kept on this kiosk. Offsets come from Printer Setup.`
    - Footer: `Reset` (disabled unless `bulkSettingsModified`; sends `resetBulkSettings(settings)`) and `Done`.
    - Escape and a scrim click close it.
  - `export interface BatchPrintState`, with exactly the portal `PrintBatchModal`'s fields.
  - `export default function BulkPrintBatchModal(props: { state: BatchPrintState; subtitle: string; onAutoPrintNextChange(v: boolean): void; onPrintNext(): void; onReprint(): void; onCancel(): void; onDone(): void })`.
    - A port of the portal's `PrintBatchModal`: same markup classes, KPIs, copy, toggle text, status lines, buttons and Escape rule. The eyebrow is `Bulk Print`. It uses the kiosk `Switch`.

- [ ] **Step 1: Write the failing tests.**
  - Settings:
    - `edits copies and clamps on blur`: type `0` in Copies and blur. `onChange` gets `copies: 1`.
    - `Reset is off when only offsets differ`: with `settings` `{ ...DEFAULT_PRINT_SETTINGS, verticalOffset: 12 }`, the Reset button is disabled.
    - `has no offset or alignment controls`: `queryByLabelText('Vertical offset')` is null, and so is `queryByText('Print test label')`.
    - `blanks are disabled until Print by rack is on`.
  - Batch:
    - `shows progress and the waiting line`: with `{ printedCount: 1, total: 3, printing: true, finishing: true, currentBatch: 1, … }`, it shows `1 of 3` and `Batch 1 sent - waiting for printer to finish printing…`.
    - `shows the countdown`: `autoCountdown: 4` shows `Batch 1 complete! Next batch starts automatically in 4s… (turn off the toggle to pause)`.
    - `failed state offers Reprint, not Print next`: `error: 'Batch 1 failed: x'` shows the error. `Reprint current batch` is enabled and `Print next batch (…)` is disabled.
    - `Escape cancels only between batches`.
    - `both modals have the report-generate header`: the `.modal-card.rgm-card .rgm-head-text .eyebrow` text is `Bulk Print`.
- [ ] **Step 2: Run** `npx vitest run src/components/labels`. Expected: FAIL.
- [ ] **Step 3: Implement** both modals.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kiosk): Bulk Print settings and batch windows`.

---

### Task 8: Kiosk — Bulk Print page: printer, type, labels and list

**Files:**
- Create: `kiosk/src/pages/BulkPrint.tsx`
- Modify: `kiosk/src/styles/kiosk.css`: `.bulk-print .plabels-steps` uses two tracks (Label type and Ready to print), and one column under the existing kiosk narrow breakpoint. Tokens only.
- Test: `kiosk/src/pages/BulkPrint.test.tsx` (new, jsdom)

**Interfaces:**
- Consumes:
  - From earlier tasks: `useStationPrinter`, `labelBackend().kind`, `useKioskSetup`, `useSyncStatus`, `getAll`/`readMeta`, `loadBundle`/`loadVocab`/`cachedBundleTypes` (Task 4), `toPrintAssetRow`/`toPrintContainerItem` (Task 5), `KioskListPrefsProvider` (Task 3, `listSize` from `useKioskAuth().preferences?.list_size`), the portal lists with `scroller=".kiosk-main"` (Task 2), and the modals (Task 7).
  - From `@portal/lib/printLabels` and `@portal/lib/labels`: `LABEL_TYPE_CUSTOM`, `bundleAtDpi`, `bundleByEntity`, `dpisByEntity`, `labelStatusFor`, `defaultCopiesFor`, `vocabOfKind`, `isPersonLabelType`, `isContainerLabelType` and `vocabLabel`. Also `relativeTime` from `@portal/lib/format`.
  - Stylesheets: `@portal/styles/labels.css` and `@portal/styles/dashboard.css`.
- Produces: `export default function BulkPrint()`, the root `<div className="portal-page plabels-page bulk-print">`. Task 9 adds printing to this file.
- What the page shows, mirroring `PrintLabels.tsx` where the spec is silent:
  - **Header:** eyebrow `Kiosk · Label Printing`, h1 `Bulk Print`, and the hint `${initiativeName} · ${siteName}`. With no setup, the hint is `Finish Kiosk Setup first.` and nothing else renders.
  - **Settings button:** `plabels-gear` with the modified dot from `bulkSettingsModified`. There is no Offline cache button.
  - **Summary line:** `N assets` / `N containers` and the portal's `Cached for offline · N labels · <relative>` / `Not cached` chip.
  - **Notices:**
    - The portal's offline notice, verbatim: ``Offline — using labels downloaded ${relativeTime(offlineSince)}. Printing works; changes made elsewhere are not reflected.``
    - The dismissable `plabels-notice` strip.
  - **Step 1 — Label type:**
    - Choice cards (kiosk `components/printers/ChoiceCard`) for the type vocab without person types, plus `Custom` with the portal descriptions and coverage text.
    - Offline with no vocab: the move's `cachedBundleTypes`, labeled by key. None either way gives the notice `Couldn't load label types.`
    - The first choice is selected once the choices arrive.
    - A type change seeds copies from `defaultCopiesFor`, never persisted, with the portal's `handleLabelTypeChange` and `updateSettings` rules. `updateSettings` uses `bulkSettingsModified` in place of `settingsModified` and writes with `writeBulkSettings`.
    - Custom shows the portal's Raw ZPL textarea.
    - With missing labels, the hint is `Generate labels in the portal for the ${noun}s that are missing one.` (no link: the kiosk has no Generate page).
  - **Step 2 — `Assets to print` / `Containers to print`:**
    - The portal list for the mode with `rows` from the adapter, `resetKey={initiativeId}` and `scroller=".kiosk-main"`.
    - `statusOf` and `dpisOf` follow the portal. `printerDpi` is `String(settings.dpi)` when settings exist, else null, so the DPI column shows only with no saved printer.
    - Labels are `bundleAtDpi(bundle, printerDpi)`. Labels at another DPI read Missing.
    - `onRefresh` re-reads the local stores.
  - **Step 3 — Ready to print:**
    - The printer state, then the portal's hint and the Print button (Task 9 wires it).
    - Printer states:
      - `ready`: `Printer: ${model ?? 'USB printer'} · ${dpi} DPI` for USB, or `Printer: ${ip} · ${dpi} DPI` for network, plus a link `Printer Setup` to `/labels/printers`.
      - `loading`: `Connecting to the label printer…`
      - `needs_usb`: `The label printer isn't connected. Connect it to start printing.` with a `Connect printer` button calling `connectUsb`.
      - `no_settings` on the web: `No printer is set up on this kiosk. Set one up in Printer Setup.` ("Printer Setup" links to `/labels/printers`).
      - `no_settings` on the edge: `This laptop isn't set up to print labels. Make it a Label Station in Kiosk Setup to print here.` ("Kiosk Setup" links to `/setup`).
  - **Rows:**
    - Read `assets` and `containers` with `getAll`, and `readMeta('sync')`, on mount, when the sync phase becomes `done` or `idle`, and when `initiativeId` changes.
    - The rows count only when `meta.sync.initiativeId === setup.initiativeId` (Review Focus 1).
    - Otherwise, with phase `running`: `Downloading move data…`. Without `running`: `No move data on this kiosk. Sync it from Kiosk Setup.`
    - A change of `initiativeId` clears both selections and displayed rows.
  - **Bundle:**
    - `loadBundle(initiativeId, type)` on every move or type change, not for Custom.
    - A result whose move or type no longer matches is dropped (refs, as in the portal).
    - `offlineSince` drives the offline notice.
    - Failure gives the notice ``Couldn't load ${typeLabel} labels.`` with action `Retry`, which loads it again.
    - The `online` window event reloads the bundle, as in the portal.

- [ ] **Step 1: Write the failing tests** in `BulkPrint.test.tsx`. Mirror `PrintingStation.test.tsx`'s harness:
  - fake-indexeddb, `writeKioskSetup` for `i-1`, and `replaceAllMulti` with assets, containers and meta `sync` `{ initiativeId: 'i-1' }`.
  - `vi.mock('../lib/useStationPrinter')` with a hoisted `station` (state, settings `{ dpi: 203, offset_x: 0, offset_y: 0, peel: false, printer: { type: 'usb', model: 'ZD421', ip: null, serial: null } }`, and a printer fake with `send` and `waitForIdle`).
  - `vi.mock('../lib/api')` overriding `fetchLabelVocab` and `fetchKioskLabelBundle`.
  - `vi.mock('../auth/KioskAuthContext')` with `preferences: { list_size: 'default' }`.
  - Vocab: `top` ("Top Label"), `front` ("Front Label"), `container` (`meta.default_copies: 5`) and `id_badge`. Two assets, `a-1` (rack A01, RU 20) and `a-2`.
  - Tests:
    - `a type's labels load and the list shows Ready and Missing`: the bundle has `a-1` at 203 only. The a-1 row reads `Ready` and the a-2 row reads `Missing`. The type cards include `Top Label` and `Custom`, and not `ID Badge`.
    - `labels at another DPI count as missing`: the bundle has `a-2` at 300 only. a-2 reads `Missing`, and there is no DPI column header.
    - `the printer line names the saved printer`: `Printer: ZD421 · 203 DPI` and a `Printer Setup` link to `/labels/printers`.
    - `a web kiosk with no saved printer says so`: state `no_settings` with web mode shows the exact web copy, and the Print button is disabled.
    - `a laptop that isn't a Label Station says so`: `window.__KIOSK_CONFIG__ = { mode: 'laptop' }` with `no_settings` shows the exact laptop copy.
    - `it.each(['network', 'edge_offline', 'cloud_sign_in_required'])` `offline on %s serves the cached bundle and vocab`:
      - Seed `putCachedBundle` and meta `label_vocab`. Mock both fetches to reject with the matching `ApiError` (`ApiError(0,'network')` for the first two, since `edge_offline` maps to it in `api.ts`; `ApiError(403,'cloud_sign_in_required')`).
      - The offline notice starts with `Offline — using labels downloaded`, a-1 reads `Ready`, and `Top Label` is a card.
    - `offline with no vocab uses the cached bundles' types`: a card `front` exists.
    - `a failed load with no cache offers Retry`: shows `Couldn't load Top Label labels.`. Clicking `Retry` calls `fetchKioskLabelBundle` a second time.
    - `rows from another move's sync are not listed` (Review Focus 1): meta `sync.initiativeId` is `i-0`, so it shows `No move data on this kiosk. Sync it from Kiosk Setup.` and no a-1 row.
    - `a late bundle for the previous type is dropped` (Review Focus 2):
      - The `top` fetch is held on a deferred promise. Switch to `Front Label`, whose bundle resolves with a-2 Ready.
      - Then resolve `top` with a-1 Ready. a-1 still reads `Missing`.
    - `a container type lists containers and seeds 5 copies without saving them`:
      - Choosing `container` shows `Containers to print` with the synced crate, and the settings window's Copies field reads 5.
      - `readPrintSettings().copies` is still 1.
      - Switching back to `Top Label` makes Copies read 1.
    - `the move changing clears the selection`: tick a-1, then `writeKioskSetup` for `i-2` with matching data. No row is ticked.
- [ ] **Step 2: Run** `npx vitest run src/pages/BulkPrint.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** `BulkPrint.tsx` (the print button can be inert until Task 9) and the CSS.
- [ ] **Step 4: Run** the Step 2 command and `npx tsc -b`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(kiosk): Bulk Print page — printer, label type and the move's list`.

---

### Task 9: Kiosk — Bulk Print printing: send, batches, wait, Custom

**Files:**
- Modify: `kiosk/src/pages/BulkPrint.tsx`
- Test: `kiosk/src/pages/BulkPrint.print.test.tsx` (new, jsdom; same harness as Task 8, factored into `kiosk/src/pages/bulkPrintTestHarness.tsx` if both files need it)

**Interfaces:**
- Consumes: `stationZpl` (Task 5), `StationPrinter.send` / `waitForIdle` (Task 6), `BulkPrintBatchModal` (Task 7). From `@portal/lib/printLabels`: `printOrder`, `containerPrintOrder`, `batchBounds`, `batchCount`, `missingLabelIds`, `staleLabelCount`, `rackOf`, `rackSeparatorZpl`, `blankLabelsZpl`, `labelDots` and `showsRackName`.
- The behavior is the portal's `sendLabel` / `sendRange` / `validateForPrint` / `printBatch` / `handlePrint` / auto-next / `closeBatch`, with these changes:
  - `sendLabel(zpl, singleCopy)` is `printer.send(stationZpl(zpl, settings, station.settings!, { singleCopy }))`.
  - `zplFor` uses `printerDpi = String(station.settings.dpi)`.
  - `validateForPrint`'s first check is `station.state !== 'ready' || !station.printer`. It keeps the portal's message text. There are no DPI-reading or DPI-choosing branches.
  - `printBatch` calls `printer.waitForIdle((end - start) * (settings.copies || 1) + blanksSent, onQueued)` after the range is sent. It's only on the batch path, as in the portal. The inline path (selection ≤ batch size) doesn't wait.
  - The batch subtitle is `${initiativeName} · ${typeLabel} · ${total} labels in ${totalBatches} batches of ${batchSize}`.
  - Nothing is queued in the outbox, and `labelBackend().recordPrinted` is never called.
  - The Print button is disabled unless the printer state is `ready`, a type is chosen, there are ids, and nothing is printing.

- [ ] **Step 1: Write the failing tests.** The saved printer is `{ offset_x: 8, offset_y: -3, peel: true }`. Bundle codes are `^XA^FD<id>^FS^XZ`. Use real timers, or fake timers with `shouldAdvanceTime`; the 100 ms label delay stays.
  - `a print sends each label with the saved offsets and print mode`:
    - Tick a-1 and a-2 and click `Print 2 labels`.
    - `sent` equals the two `stationZpl(code, settings, saved)` results in list order. Each has `^MMP`, `^LS-8` and `^LT-3`.
    - Shows `Successfully printed 2 label(s)`, and `waitForIdle` was not called (inline path).
  - `at the end of a batch waitForIdle gets the labels sent and progress follows onQueued`:
    - Batch size 2 through the settings window, three assets ticked. `waitForIdle` calls `onQueued(1)` and then resolves.
    - `waitForIdle` was first called with `(2, expect.any(Function))`. Shows `1 of 3` while waiting, then `Batch 1 complete! Ready to print next batch.`.
    - `Print next batch (1 labels)` sends the third. The second `waitForIdle` call is `(1, …)`, and the window ends with `All 3 labels printed successfully!`.
  - `copies count in the wait`: copies 2 and batch size 1 give `waitForIdle(2, …)`.
  - `print by rack feeds blanks between racks`:
    - Print by rack on with 2 blanks. Assets are in racks A01 (RU 20 and RU 10) and A02, with type `top`.
    - `sent` is `[A01 RU 20, A01 RU 10, stationZpl(blankLabelsZpl(2), …, { singleCopy: true }), A02]`.
  - `a Front job leads with a named separator`: with type `front`, `sent[0]` is `stationZpl(rackSeparatorZpl('A01', 2, labelDots(item, vocab)), …, { singleCopy: true })`.
  - `custom ZPL sends once with nothing ticked`: Custom with `^XA^FDHi^FS^XZ` and nothing ticked shows `Print 1 label`. `sent` is `[stationZpl('^XA^FDHi^FS^XZ', …)]`.
  - `custom ZPL sends once per ticked asset`: two ticked give two sends of the same ZPL.
  - `missing labels block the print`: a-2 missing at 203 shows `1 selected asset(s) have no Top Label at 203 DPI — generate at 203 DPI.`, nothing is sent, and `Deselect missing` unticks a-2.
  - `no outbox scan is queued`: after a print, `getAll('outbox')` is empty and `api.postLabelPrinted` wasn't called.
  - `a failed send stops the batch and Reprint resends it` (Review Focus 4):
    - Batch size 2. `send` rejects on its second call with `Error('USB transfer failed')`.
    - Shows `Batch 1 failed: USB transfer failed`, with Reprint enabled and Print next disabled.
    - After `send` is fixed, `Reprint current batch` sends batch 1's two labels from the first.
  - `auto print next counts down from 5 s`: toggle on, then batch 1 completes. Shows `…in 5s…` and later sends batch 2 without a click (fake timers).
- [ ] **Step 2: Run** `npx vitest run src/pages/BulkPrint.print.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** printing in `BulkPrint.tsx`.
- [ ] **Step 4: Run** `npx vitest run src/pages/BulkPrint.test.tsx src/pages/BulkPrint.print.test.tsx` and `npx tsc -b`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(kiosk): Bulk Print printing — batches wait for the printer like the portal`.

---

### Task 10: Kiosk — access, routing, card, and verification

**Files:**
- Modify: `kiosk/src/pages/Labels.tsx`: the `bulk` tile shows only when `useKioskAuth().can('labels', 'view')`.
- Modify: `kiosk/src/App.tsx`: `LabelSectionRoute` returns `<BulkPrint />` for `bulk` when `can('labels', 'view')`, else `<Navigate to="/labels" replace />`. Update its comment, since Bulk Print is no longer a placeholder.
- Tests: `kiosk/src/pages/Labels.test.tsx` and `kiosk/src/pages/Labels.routing.test.tsx`. Add a `can` to their `KioskAuthContext` mocks. The routing test mocks `./BulkPrint` with a stand-in, as it does for `PrintingStation`.

**Interfaces:**
- Consumes: `useKioskAuth().can(resource, action)` and `BulkPrint` (Tasks 8 and 9).

- [ ] **Step 1: Write the failing tests.**
  - `Labels.test.tsx`:
    - `the Bulk Print card is hidden without labels:view`: with `can` returning false there are two links and no `Bulk Print`.
    - `the Bulk Print card shows with labels:view`: three links, and `Bulk Print` links to `/labels/bulk`.
    - Update the existing three-tile test to grant `labels:view`.
  - `Labels.routing.test.tsx`:
    - `/labels/bulk opens Bulk Print with labels:view` on a web kiosk and on a laptop that isn't a Label Station. Both render the stand-in.
    - `/labels/bulk without labels:view redirects to Label Printing`: the launcher heading `Label Printing` shows, and the stand-in doesn't.
- [ ] **Step 2: Run** `npx vitest run src/pages/Labels.test.tsx src/pages/Labels.routing.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the gating and the route.
- [ ] **Step 4: Run the full kiosk checks** from `kiosk/`: `npx vitest run` (all pass; note the count), `npx tsc -b` (clean), and `npm run build` (clean). Then `npm run build:labelgen` followed by `git status --short`: the Android and iOS bundles must be unchanged.
- [ ] **Step 5: Run the portal checks** from `portal/`: `npx vitest run` (failures match Task 2's baseline) and `npm run build`.
- [ ] **Step 6: Live check** (`superpowers:verification-before-completion`).
  - On the dev web kiosk, sign in as staff:
    - The Bulk Print card shows.
    - `/labels/bulk` lists the move.
    - Print a batch larger than the batch size to the USB Zebra. The waiting line shows, then `Batch 1 complete!`.
    - Check light and dark themes, rounded modal corners, and themed scrollbars on the list.
    - If the dev move has more than 300 assets, check that the list scrolls and renders rows.
  - Sign in as a worker (and with a move password): there is no card, and `/labels/bulk` redirects.
  - On the shared 8090 laptop, only read the page. Print nothing and change no settings there.
- [ ] **Step 7: Commit** `feat(kiosk): Bulk Print for staff and above on Label Printing`.
