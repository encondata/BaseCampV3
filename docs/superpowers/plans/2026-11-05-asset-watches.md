# Asset Watches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person watches one asset, either on its own or on an initiative, for its next update or for a status. They get one notification when that happens, and the watch ends.

**Architecture:**
- A new `asset_watches` table stores each watch with a snapshot of the asset taken when it was set.
- A once-a-minute check in the notification worker compares each watch's snapshot with the asset's current state and sends one `asset_watch` notice through `notify()`.
- The portal adds a Watch modal, reached from the asset page, the move asset page, and both lists' Actions menus, and lists asset watches in /me "What you watch".

**Tech Stack:** FastAPI, async SQLAlchemy, Alembic and Postgres 16 (API). React, TypeScript and vitest (portal).

**Spec:** `docs/superpowers/specs/2026-11-05-asset-watches-design.md`. It is binding for behavior and for every user-facing string.

## Global Constraints

- **Worktree:** work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/asset-watches` (branch `asset-watches`). Never touch the main checkout.
- **Never commit `api/src/serversherpa/_dev_reload.py`.** If it shows as modified, restore it with `git checkout -- api/src/serversherpa/_dev_reload.py` in this worktree only.
- **Commit trailer:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Stash:** never run bare `git stash`.
- **API tests:** run from `api/` with `SS_TEST_DB=serversherpa_test_asset_watches PYTHONPATH=src .venv/bin/pytest -q -p no:cacheprovider <files>`.
- **Portal tests:** run from `portal/` with `npx vitest run <files>`. Finish each portal task with `npm run build`.
- **Copy:** user-facing copy is American English and comes verbatim from the spec. Times are 24-hour ("15:05"), never AM/PM.
- **Migration:** `0121`, with `down_revision = "0120"`, file `api/migrations/versions/0121_asset_watches.py`. It was 0120 on 0119 until main's Dock Station took 0120.
- **Transactions:**
  - `notify()` and the service functions never commit. Routes commit.
  - The check runs one session and one transaction per run, and claims rows `FOR UPDATE SKIP LOCKED`.
- **Access:** one test, used everywhere: `notifications/access.py` (`viewers` / `visible_among`) with `"asset"` for a watch on the asset and `"initiative"` for a watch on an initiative. Active accounts come from `active_ids`.
- **Portal controls** are the house ones:
  - `RowActionsMenu` ("Actions ▾", `ACTIONS_TRACK`)
  - `NotificationModal` / `StandardModal` (eyebrow, h3, page-hint)
  - `ChoiceField` (segmented)
  - `ComboBox`, which auto-portals inside `.modal-card`
  - the `.watch-btn` look of `WatchButton`
  - No new CSS unless a test or the build needs it.
- **Dependencies:** none new.

## Review Focus

These five cases are the most likely to bite a real user. Each one gets a test in the task named.

1. On an initiative, the row status and `Asset.status` differ. "Status becomes" must read the row status for a watch set on an initiative, and the asset's own status otherwise (Task 2).
2. A long transaction commits a scan whose `processed_at` is earlier than the watch's `created_at`. "Next update" must still fire, via the scan count (Task 2).
3. Two workers run the check at once. The person hears once (Task 2).
4. Someone loses access to the asset, or their account is deactivated, before the change happens. Nothing is sent, and the watch ends (Task 2).
5. On the initiative page, a viewer without `initiatives:change` must get an Actions button holding only "Watch…". Editors keep Edit and Remove beside it (Task 4).

---

### Task 1: Table, service and routes

**Files:**
- Create: `api/migrations/versions/0121_asset_watches.py`
- Modify: `api/src/serversherpa/db/models.py` (add `AssetWatch` next to `NotificationWatch`)
- Create: `api/src/serversherpa/notifications/asset_watches.py`
- Modify: `api/src/serversherpa/api/schemas.py` (add `AssetWatchIn`, `AssetWatchPatch`, `AssetWatchOut`, `AssetWatchStateOut`)
- Modify: `api/src/serversherpa/api/routes/me.py` (five routes, next to the watch routes)
- Test: `api/tests/test_asset_watches_api.py`

**Interfaces:**
- Produces, in `notifications/asset_watches.py`:
  - `CONDITIONS = ("next_update", "status")`.
  - `def asset_label(asset) -> str`: the serial number, else the name, else `str(id)`.
  - `async def snapshot(db, asset_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, dict]`. Its shape is below. It uses a fixed number of queries whatever the number of ids.
  - `async def add_asset_watch(db, person_id, *, asset_id, initiative_id, condition, status) -> AssetWatch`.
  - `async def change_asset_watch(db, person_id, watch_id, *, condition, status) -> AssetWatch`.
  - `async def remove_asset_watch(db, person_id, watch_id) -> None`.
  - `async def list_asset_watches(db, person_id) -> list[AssetWatchOut]`.
  - `async def asset_watch_state(db, person_id, asset_id, initiative_id) -> AssetWatchStateOut`.
  - Each raises the module's own error class, whose code and HTTP status match the spec's table. Mirror how `notifications/watches.py` raises errors and how `me.py` maps them.
- Snapshot shape (UUIDs as `str`, datetimes as `isoformat()`, `None` when empty):
  ```
  {"asset": {"updated_at", "last_seen_at", "status", "site_id", "location_detail", "archived_at"},
   "rows": {"<initiative_asset id>": {"initiative_id", "status", "updated_at"}},
   "container_id": str|None, "truck_id": str|None,
   "scans": {"count": int, "latest": str|None}}
  ```
  - **Container:** the asset's `container_assets` row. Skip archived containers, as `assets/placement.py` does.
  - **Truck:** that container's `truck_containers` row with the latest `added_at`. Skip archived trucks.
  - **Scans:** `count(*)` and `max(processed_at)` over `processed_scans` where `asset_id` matches, all rows included.
- `AssetWatchOut` has these fields: `id`, `asset_id`, `asset_name`, `initiative_id`, `initiative_name`, `initiative_asset_id`, `condition`, `status`, `status_label`, `current_status`, `current_status_label`, `link`, `created_at`.
  - `current_status` is the asset's own status for a watch on the asset, and the row status for a watch on an initiative. The /me Change flow needs it.
  - `link` follows the spec's Link section.
- Routes take the paths, bodies and error codes in the spec's "Routes" section exactly.
- **Audit:** use the same helper and actions as the person's other watches in `me.py` (`watch.add`, `watch.update`, `watch.remove` on their account), with `thing: "asset"` in the changes.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_asset_watches_api.py`. Use the fixtures and sign-in helpers that `api/tests/test_me_watches*.py` (or the nearest watch-route test) already uses.
  - `test_post_on_asset_returns_201_with_link_and_snapshot`: 201; `condition == "next_update"`; `initiative_id is None`; `link == f"/assets/{asset_id}"`; the stored `baseline` has exactly the keys `asset`, `rows`, `container_id`, `truck_id` and `scans`.
  - `test_post_on_initiative_links_to_move_asset_page`: `link == f"/initiatives/{iid}/assets/{row_id}"`; `initiative_asset_id == row_id`; `current_status` is the row status.
  - `test_post_twice_is_already_watching`: 409 `already_watching`. A watch on the same asset on an initiative is a separate place, so it gets 201.
  - `test_status_watch_needs_a_status`: 422 `status_required`.
  - `test_status_watch_refuses_the_current_status`: an asset with status A whose row on the initiative has status B.
    - Asset-level watch for A: 422 `already_at_status`.
    - Initiative watch for B: 422 `already_at_status`.
    - Initiative watch for A: 201.
  - `test_bad_status_and_status_on_next_update_are_invalid`: 422 `invalid_status` for an unknown key, for an inactive key, and for `condition="next_update"` with a status.
  - `test_unknown_condition_is_invalid`: 422 `invalid_condition`.
  - `test_asset_not_on_initiative`: 422 `not_on_initiative`.
  - `test_asset_the_person_cannot_open_is_not_found`: a client-scoped user and another client's asset get 404 `thing_not_found`. So does a random UUID.
  - `test_patch_takes_a_new_snapshot_and_time`: change to `status`; `created_at` is later; the baseline reflects a change made in between.
  - `test_delete_then_delete_again_is_not_found`: 204, then 404 `watch_not_found`. So is another person's watch id.
  - `test_state_is_per_asset_and_place`.
  - `test_list_shows_only_own_watches_the_person_can_open`.
  - `test_writes_are_audited_on_the_account`: three audit rows, `watch.add`, `watch.update` and `watch.remove`, each with `thing == "asset"`.
  - `test_snapshot_reads_rows_container_truck_and_scans`: pack the asset into a container, load that container on a truck, add two processed scans, and put the asset on two initiatives. The snapshot shows the container, the truck, `count == 2`, the latest `processed_at`, and both rows.
- [ ] **Step 2: Run the tests and see them fail** (missing module or routes).
- [ ] **Step 3: Write the migration and the model.** Constraints:
  - `ck_asset_watches_condition`: `condition IN ('next_update','status')`.
  - `ck_asset_watches_status`: `(condition = 'status') = (status IS NOT NULL)`.
  - The unique index `uq_asset_watches_target` on (person_id, asset_id, initiative_id), declared NULLS NOT DISTINCT the way `NotificationWatch` declares its own.
  - Foreign keys `ON DELETE CASCADE` to `people`, `assets` and `initiatives`.
- [ ] **Step 4: Write the service module, the schemas and the routes.**
  - Validate in the spec's order: access, then initiative row, then condition, then status.
  - The asset statuses are the active `status_values` for record type `asset`. Use the existing helper that serves `/status-values`.
  - Status labels come from `status/labels.py`.
- [ ] **Step 5: Run Task 1's tests, plus `tests/test_me*.py` and `tests/test_notification_watches*.py`, and see them pass.** Also check the migration: run `alembic heads` from `api/` and confirm the single head is 0121.
- [ ] **Step 6: Commit**, with the message "feat(notifications): asset watches table, service and routes" and the trailer.

### Task 2: The check, the notice and the Assets category

**Files:**
- Modify: `api/src/serversherpa/notifications/kinds.py` (add the `"assets": "Assets"` category after `"initiatives"`, and the kind `"asset_watch": KindInfo("assets", "Asset watch")`)
- Modify: `api/src/serversherpa/notifications/company.py` (`CONFIGURABLE_CATEGORIES` gains `"assets"` after `"initiatives"`)
- Modify: `api/src/serversherpa/config_store.py` (the `DEFAULTS` notifications defaults gain `assets` with Inbox and Email on)
- Create: `api/src/serversherpa/notifications/asset_watch_check.py`
- Modify: `api/src/serversherpa/notifications/worker.py`
- Modify: `api/tests/test_notification_kinds.py` (its hard-coded tables), `api/tests/test_notification_worker.py` (the order test), and any company-defaults test that pins the category list
- Modify: `portal/src/lib/api.ts` (`NotificationCategory` gains `'assets'`) and `portal/src/lib/notificationKinds.ts` (the category label "Assets" and the kind label "Asset watch"), plus the portal tests that pin them
- Test: `api/tests/test_asset_watch_check.py`

**Interfaces:**
- Consumes `snapshot`, `asset_label` and `AssetWatch` from Task 1.
- Produces `async def run_asset_watches_once(maker, *, now: datetime | None = None) -> int`, which returns how many watches ended.
- `def watch_time(at: datetime) -> str` gives "Nov 5, 15:05 EST": 24-hour, in `DEFAULT_TIMEZONE` with the zone abbreviation.
- The module calls `notify(db, watch.person_id, "asset_watch", title, body=body, link=link)` with the literal kind, so the kinds test's source scan finds it.
- **Worker:**
  - Add the constant `ASSET_WATCH_INTERVAL_SECONDS = 60` (renamed from `ASSET_WATCH_INTERVAL` in the final fix wave, to match its siblings) and a `run_asset_watches(maker, state)` wrapper that logs once per outage, the way the others do.
  - Seed its timer one interval in the past.
  - Run it after the device check and before the event sweep, so the order the test asserts becomes `["devices", "asset_watches", "events", "summaries"]`.
- **Stored defaults:** a stored `notifications` config that predates `assets` must read Assets as on for both Inbox and Email. Check how `company.py` merges the stored values with `DEFAULTS`, and pin it with a test.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_asset_watch_check.py`. Each test arms a watch with Task 1's service, makes one change, runs `run_asset_watches_once(get_sessionmaker(), now=NOW)`, and reads the results back in a fresh session.
  - `test_next_update_quiet_without_changes`: two runs, no inbox row, and the watch is still there.
  - `test_next_update_fires_on_a_scan`: a processed scan shaped like the worker's, with `raw_scan_id` set and a site.
    - One inbox row of kind `asset_watch`, titled `f"{serial}: scanned at {site}"`.
    - The watch is deleted, and the run returns 1.
  - `test_next_update_fires_on_a_scan_dated_before_the_watch`: `processed_at` is one minute before `created_at`, and it still fires (Review Focus 2).
  - `test_manual_status_edit_title`: `raw_scan_id` None, status `received`, an operator. The title is `f"{serial}: status set to {label} by {name}"`.
  - `test_off_move_sighting_title`: `f"{serial}: seen off-move at {site}"`.
  - `test_packing_and_truck_titles`:
    - `"packed into {container}"`
    - `"taken out of {container}"` (a separate watch)
    - `"loaded on {truck}"`
    - `"taken off {truck}"`
  - `test_roster_titles`: `"added to {initiative}"` and `"removed from {initiative}"`.
  - `test_record_edit_titles`: a status change without a scan gives `"status changed to {label}"`. A location-only edit gives `"record updated"`.
  - `test_status_watch_on_asset_reads_asset_status`:
    - A row status change alone sends nothing.
    - `Asset.status = X` sends `f"{serial} is now {label}"` (Review Focus 1).
  - `test_status_watch_on_initiative_reads_row_status`:
    - `Asset.status = X` alone sends nothing.
    - Row status X sends `f"{serial} is now {label} on {initiative}"`.
  - `test_status_watch_ends_when_the_row_goes`: the title is `f"{serial} was removed from {initiative}"`, and the body's first line is `f"Your watch for status {label} on it has ended."`.
  - `test_body_lines_and_times`: with a fixed `NOW` and fixed times, the body lines match the spec exactly, in order, joined with `"\n"`. Times read like "Nov 5, 15:05 EST".
  - `test_links`:
    - `/assets/{id}` for a watch on the asset.
    - `/initiatives/{iid}/assets/{row}` for a watch on an initiative.
    - `/assets/{id}` once the row is gone.
  - `test_no_access_or_inactive_ends_silently`: the person is deactivated, or their client scope no longer covers the asset. No inbox row, and the watch is deleted (Review Focus 4).
  - `test_inbox_switch_off_still_ends_the_watch`.
  - `test_two_runs_at_once_notify_once`: `asyncio.gather` two runs with separate sessions, and exactly one inbox row (Review Focus 3).
  - Plus the updated tests: the kinds test (`asset_watch` registered and found by the source scan); the worker order test; and `test_stored_defaults_without_assets_read_on` wherever the company-defaults tests live.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement the category, the kind, the check and the worker wiring.**
  - Decide what happened with a pure function over (the watch, the current snapshot, the newest scan). The spec's order sets the precedence.
  - Load the newest scan's site, location, operator name and status in the same run. Labels come from `status/labels.py`, and the placement text follows the spec.
  - Before calling `notify()`, check access and an active account. Delete every watch that ended.
- [ ] **Step 4: Run Task 2's tests, Task 1's tests, and `tests/test_notification*.py`, and see them pass.** From `portal/`, also run `npx vitest run src/lib` and any test that imports `notificationKinds`, and see them pass.
- [ ] **Step 5: Commit**, with the message "feat(notifications): the asset-watch check and the Assets category" and the trailer.

### Task 3: Portal client, Watch modal, Watch button and hook

**Files:**
- Modify: `portal/src/lib/api.ts` (the types and five functions below, in the watch block, mirroring the existing watch calls)
- Modify: `portal/src/lib/watches.ts` (add `ASSET_THING_LABEL = 'Asset'` and `assetWatchEventsText(w: AssetWatch): string`)
- Create: `portal/src/components/notifications/WatchAssetModal.tsx` and `.test.tsx`
- Create: `portal/src/components/notifications/AssetWatchButton.tsx` and `.test.tsx`
- Create: `portal/src/components/notifications/useAssetWatches.ts` and `.test.ts`
- Test: `portal/src/lib/api.assetWatches.test.ts`

**Interfaces:**
- `type AssetWatchCondition = 'next_update' | 'status'`.
- `interface AssetWatch` mirrors the fields of `AssetWatchOut`.
- `interface AssetWatchIn { asset_id: string; initiative_id?: string | null; condition: AssetWatchCondition; status?: string | null }`.
- `interface AssetWatchState { watching: boolean; watch: AssetWatch | null }`.
- The five functions:
  - `listMyAssetWatches(): Promise<AssetWatch[]>`
  - `getAssetWatchState(assetId: string, initiativeId?: string | null): Promise<AssetWatchState>`
  - `createMyAssetWatch(body: AssetWatchIn): Promise<AssetWatch>`
  - `updateMyAssetWatch(id: string, body: { condition: AssetWatchCondition; status?: string | null }): Promise<AssetWatch>`
  - `deleteMyAssetWatch(id: string): Promise<void>`
- `assetWatchEventsText` returns "Next update", or "Status becomes {status_label ?? status}".
- `WatchAssetModal` props: `{ assetId, assetName, initiativeId?, initiativeName?, currentStatus, currentStatusLabel, watch: AssetWatch | null, onClose(): void, onSaved(watch: AssetWatch | null): void }`.
  - `onSaved(null)` means the watch was stopped.
  - It loads `listAssetStatuses()` for the picker and leaves `currentStatus` out.
  - Its copy, choices and buttons come exactly from the spec's "The Watch modal" section.
  - An `already_at_status` error shows "It already has that status. Pick another one, or watch for its next update."
  - Any other error goes through the existing `watchErrorMessage`.
- `AssetWatchButton` props: `{ assetId, assetName, initiativeId?, initiativeName?, currentStatus, currentStatusLabel }`.
  - It reads `getAssetWatchState` and renders nothing until that is known. A failed read counts as not watching.
  - It looks like `WatchButton`: `btn-ghost watch-btn`, eye icon, "Watch" / "Watching", `aria-pressed`, and `.on` while watching.
  - A click opens the modal. After a save or a stop it updates its state from `onSaved`.
- `useAssetWatches()` returns `{ watches: AssetWatch[], watchFor(assetId: string, initiativeId?: string | null): AssetWatch | undefined, reload(): void }`. It loads once.

- [ ] **Step 1: Write the failing tests.**
  - API paths, methods and bodies for the five calls.
  - The modal:
    - It shows the eyebrow, title, hint and the "On {initiative}" line.
    - Next update is selected by default.
    - Status becomes shows the picker without the current status, and the hint reads "Its status is {label} now." On an initiative it reads "Its status on this initiative is {label} now."
    - Watch sends `createMyAssetWatch` with the right body.
    - An existing watch shows Save and Stop watching. Save calls `updateMyAssetWatch`; Stop calls `deleteMyAssetWatch` and then `onSaved(null)`.
    - The `already_at_status` message.
  - The button: nothing renders before the state is known; "Watch" vs "Watching" with `aria-pressed`; a click opens the modal.
  - The hook: `watchFor` matches on the asset and the place. `null` and `undefined` initiatives count as the same place.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new tests plus `src/components/notifications` and `src/lib`, then `npm run build`, and see them pass.**
- [ ] **Step 5: Commit**, with the message "feat(portal): Watch asset modal, button and client" and the trailer.

### Task 4: Watch on the asset pages and in both lists

**Files:**
- Modify: `portal/src/pages/AssetDetail.tsx` and `.test.tsx`
- Modify: `portal/src/pages/MoveAssetDetail.tsx` and `.test.tsx`
- Modify: `portal/src/pages/Assets.tsx` and `.test.tsx`
- Modify: `portal/src/pages/InitiativeDetail.tsx` and `.test.tsx`

**Interfaces:** consumes `AssetWatchButton`, `WatchAssetModal`, `useAssetWatches` and `asset_label`'s rule (serial, else name, else id) from Tasks 1 and 3.

- **AssetDetail:**
  - `AssetWatchButton` goes in `.idet-header-actions`, outside the `canChange` gate, the way `SiteDetail.tsx` places its Watch button.
  - Its current status is the asset's status and label.
  - The status list for the modal is loaded inside the modal, so the page's `canChange` gate on `listAssetStatuses()` stays as it is.
- **MoveAssetDetail:** the same button with `initiativeId`, the initiative name, and the row status as the current status.
- **Assets list:** `rowActions(a)` adds `{ key: 'watch', label: watchFor(a.id) ? 'Watching…' : 'Watch…', onSelect }`. It opens `WatchAssetModal` for the asset with no initiative, then calls `reload()`.
- **InitiativeDetail roster:**
  - Ungate the Actions cell, the grid track and the header spacer that are now behind `canChange`.
  - Edit and Remove stay behind `canChange`. Watch ("Watch…" / "Watching…" through `watchFor(row.asset_id, initiativeId)`) is for everyone who can see the list.
  - The modal gets the initiative and the row status.

- [ ] **Step 1: Write the failing tests.**
  - AssetDetail: a viewer without `assets:change` sees Watch; a click opens the modal.
  - MoveAssetDetail: the same, with the "On {initiative}" line.
  - Assets: the row menu has "Watch…", or "Watching…" when the hook finds a watch.
  - InitiativeDetail: a viewer without `initiatives:change` gets an Actions button with only "Watch…"; an editor sees Edit, Remove and Watch… (Review Focus 5). Update the existing test that asserted no trigger for viewers, and assert menu items via `screen`, since the menu is portaled.
  - Add the new API calls to each page test's `api` mock.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the four page tests plus `src/components/notifications`, then `npm run build`, and see them pass.**
- [ ] **Step 5: Commit**, with the message "feat(portal): watch an asset from its pages and both lists" and the trailer.

### Task 5: Asset watches in /me "What you watch"

**Files:**
- Modify: `portal/src/pages/me/WatchesSection.tsx` and `.test.tsx`
- Modify: `portal/src/components/notifications/WatchesTable.tsx` and `.test.tsx`, only if the row type needs widening

**Interfaces:** consumes `listMyAssetWatches`, `deleteMyAssetWatch`, `WatchAssetModal`, `assetWatchEventsText` and `ASSET_THING_LABEL`.

- `WatchesSection` loads the asset watches beside the other watches and shows them in the same table, after the existing rows, newest first.
  - **Watching:** `asset_name`, linked to `link`, with an "Asset" chip. A watch on an initiative adds " on {initiative_name}".
  - **Events:** `assetWatchEventsText`.
  - **Via:** "You".
  - **Actions:** "Change…" opens `WatchAssetModal` with the watch and its `current_status`. Destructive "Stop watching" calls `deleteMyAssetWatch`, tolerates `watch_not_found`, shows other errors in the section's `pf-error`, and reloads.
- The group page's watch tables don't change.

- [ ] **Step 1: Write the failing tests:**
  - An asset row renders the name link, the chip, "on {initiative}", the events text and "You".
  - Change… opens the modal.
  - Stop watching deletes and reloads, and `watch_not_found` is tolerated.
  - The existing rows are unchanged.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the /me tests plus `src/components/notifications`, then `npm run build`, and see them pass.**
- [ ] **Step 5: Commit**, with the message "feat(portal): asset watches in What you watch" and the trailer.
