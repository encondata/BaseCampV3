# Notifications Phase 2, Slice 5 (Wiki Watches Join) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the wiki's watches into the shared `notification_watches` table, keeping the wiki's Watch button, Watching page, auto-watch and fan-out exactly as they behave today. /me then lists wiki watches, and a group can watch a wiki library, folder or page.

**Architecture:**

- Migration 0116 copies `wiki_watches` into `notification_watches` (`wiki_space_id` / `wiki_node_id`) and drops the old table.
- The wiki's routes and `wiki/notify.py` read and write the shared table. Their paths, shapes and audit stay the same.
- The shared watch service learns two things, `wiki_space` and `wiki_node`, judged by the wiki's own access rule.
- The wiki fan-out adds the members of enabled groups that watch the page, its folders or its library, and logs each person's route.
- Portal:
  - /me's and the group page's tables show wiki rows, whose links open the wiki.
  - Add watch gains Wiki.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, PostgreSQL 16, pytest; React 18 + TypeScript, Vitest (portal and wiki web).

**Spec:** `docs/superpowers/specs/2026-11-02-notifications-phase2-design.md` (Build order, slice 5; section 7 "Wiki watches join", plus sections 1, 2, 3 and 9).

## Global Constraints

- **American English.** Grep the changed files for `-ise|-isation|colour|enrol\b|enrolment|behaviour|centre|licence`.
- **Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/notif-phase2`, branch `notif-phase2`.
- **API tests:** `cd api && SS_TEST_DB=serversherpa_test_notif2 PYTHONPATH=src .venv/bin/pytest <files> -q -p no:cacheprovider`. Don't run the whole API suite.
- **Portal and wiki checks:** `cd portal && npx vitest run <files>`, `npx tsc -p .`, `npx vitest run src/styles`, `npm run build`. For the wiki web app, run `cd wiki/web && npx vitest run <files>` if anything there changes. Its `node_modules` may need the main checkout's symlink, as the portal had.
- **Run every test command in the FOREGROUND** (600000 ms timeout).
- **Git hygiene:**
  - Plain single git commands as `git -C <worktree> …`.
  - Never use bare `git stash`, and never commit `api/src/serversherpa/_dev_reload.py`.
  - Trailer exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Migration** `"0116"` (down_revision `"0115"`, slice 4's `status_rule_notified`). Group `categories` were already dropped in 0113, so don't repeat that.
- **The wiki web app's contract doesn't change:**
  - `GET` / `PUT /wiki/watches`, `DELETE /wiki/watches/{id}` and `GET /wiki/nodes/{id}/watch` keep their paths, request and response shapes (`WatchOut{id, node, space, created_at}`, `WatchStateOut{watching, via, watch_id}`), ordering, idempotent PUT, and audit (`wiki_watch`, `watch` / `unwatch`).
  - The wiki web tests must pass unchanged.
- **The wiki's fan-out stays in the request** with its own access rule (`recipients_who_can_view`), its cap and its actor rule.
- **Copy** is exactly as quoted. The mockup supplies "Wiki" (the segment) and "Wiki watches hear every page update and comment, as today."

## Calls this plan makes (beyond the spec)

1. **The two things are `wiki_space` and `wiki_node`.** They are the shared table's two columns, and the names slices 1-2's tests already used as placeholders.
2. **Wiki rows take no event choice.** Their `kinds` stay `[]` (every update and comment, as today). /me's wiki rows have only "Stop watching", and the group page's wiki rows only "Remove".
3. **Chips:** "Wiki library", "Wiki folder" and "Wiki page", by the node's kind. The API sends a `thing_label` on `WatchOut` for this, and the portal falls back to its own labels.
4. **Links are absolute wiki URLs:**
   - `{wiki_origin}/n/{id}` for a node;
   - `{wiki_origin}/library/{key}` for a library.
   - The portal's watch tables open absolute links as plain links.
5. **The wiki's state endpoint and Watch button still reflect only the person's own watches,** as today. A group's watch shows on /me with Via the group.
6. **The wiki's watch-driven notices log their route** (`via` `watch` / `group:<id>`, with `names`), as the sweep's do, so the Delivery log explains them.
7. **The Add watch picker for Wiki:**
   - The field is labeled "Wiki", with the placeholder "Search the wiki…" (new copy, flagged).
   - It searches libraries by name and folders and pages through `GET /wiki/search`.
   - The value is `wiki_space:<id>` or `wiki_node:<id>`.
8. **Check delivery doesn't list wiki watches.** The wiki's kinds aren't "watchable" in the registry (their reach is the wiki's own fan-out).

## Review Focus

- **Nothing changes for the wiki.** Watch, unwatch, the Watching page and its "via folder / library" chips, auto-watch on create, copy, publish and review approve, and every wiki notice reach exactly whom they did before (Task 1: the existing `test_wiki_watches_api.py` and `test_wiki_notify.py` stay green, apart from the swapped model name).
- **Upgrade with existing watches.** Every person watch survives the migration with its target and created time. A downgrade puts them back, and group wiki watches are dropped (Task 1: `test_migration_0116`).
- **A group watches a folder.** An enabled group's members hear a page update under it, through the wiki's own access rule. A member who can't see the page doesn't hear, and a paused group delivers nothing (Task 2: `test_group_wiki_watch_fan_out`).
- **No leaks on /me.** A group's watch on a private page shows on /me only to members who can see it (Task 2: `test_me_lists_only_visible_wiki_watches`).

---

### Task 1: Wiki watches move into the shared table (API)

**Files:**
- Create: `api/migrations/versions/0116_wiki_watches_join.py`
- Modify:
  - `api/src/serversherpa/db/models.py` (`WikiWatch` goes);
  - `api/src/serversherpa/api/routes/wiki/watches.py`, `api/src/serversherpa/wiki/notify.py` (`_watchers`, `watchers_for`, `auto_watch`);
  - `api/tests/conftest.py` (the TRUNCATE list).
- Test: `api/tests/test_migration_0116_wiki_watches_join.py` (new). Update every test that queries `WikiWatch` (`test_wiki_notify.py`, `test_wiki_phase2_schema.py`, `test_wiki_private_printing_enforcement.py`, `test_wiki_mentions.py`, `test_wiki_reviews_api.py`, `test_wiki_comments_api.py`) to `NotificationWatch` with the wiki columns.

**Interfaces:**
- **0116 upgrade:**
  - `INSERT INTO notification_watches (person_id, wiki_space_id, wiki_node_id, kinds, created_by, created_at) SELECT person_id, space_id, node_id, '{}', person_id, created_at FROM wiki_watches ON CONFLICT DO NOTHING`;
  - then drop `wiki_watches` and its three indexes.
- **0116 downgrade:**
  - Recreate `wiki_watches` exactly as 0075 and 0077 left it: CHECK `wiki_watches_target_check`, unique expression index `wiki_watches_person_target_key`, and indexes `wiki_watches_node_idx` and `wiki_watches_space_idx`. Otherwise the older downgrades fail.
  - Copy the person wiki watches back, then delete every wiki row from `notification_watches`.
- **The wiki routes, on `NotificationWatch`:**
  - "Own" means `person_id = me`, and a wiki row is one with `wiki_space_id` or `wiki_node_id` set.
  - The PUT stays idempotent (`on_conflict_do_nothing` against `uq_notification_watches_target`).
  - Every response, filter, order and audit is unchanged.
- **`wiki/notify.py`:** `_watchers` and `auto_watch` use `NotificationWatch` (person rows only in this task, so behavior is identical).

- [ ] **Step 1: Write the failing tests:**
  - `test_migration_0116`, on a throwaway DB (copy `test_migration_0114_device_offline.py`'s pattern):
    - three person watches, on a space, a folder and a page, survive the upgrade with their created times;
    - `wiki_watches` is gone;
    - the downgrade restores them and drops a group wiki row;
    - re-upgrading is clean.
  - Swap `WikiWatch` for `NotificationWatch` in the listed tests, so they fail until the routes move.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `tests/test_migration_0116_wiki_watches_join.py tests/test_wiki_watches_api.py tests/test_wiki_notify.py tests/test_wiki_phase2_schema.py tests/test_wiki_private_printing_enforcement.py tests/test_wiki_mentions.py tests/test_wiki_reviews_api.py tests/test_wiki_comments_api.py tests/test_wiki_route_guards.py tests/test_wiki_migration_downgrade.py`. Also run the wiki web tests `cd wiki/web && npx vitest run src/components/WatchButton.test.tsx src/pages/WatchingPage.test.tsx src/lib/wikiApi.test.ts`, which should be unchanged and green. Expected: PASS.
- [ ] **Step 5: Commit** `feat(wiki): watches live in the shared notification watch table`.

### Task 2: Groups and /me see wiki watches (API)

**Files:**
- Modify:
  - `api/src/serversherpa/notifications/watches.py` (`THINGS`: `wiki_space`, `wiki_node`; `WatchOut.thing_label`);
  - `api/src/serversherpa/notifications/access.py` (wiki branches);
  - `api/src/serversherpa/wiki/notify.py` (group members join the fan-out and their routes are logged);
  - `api/src/serversherpa/api/schemas.py`.
- Test: `api/tests/test_wiki_watch_groups.py` (new), and the shared watch tests.

**Interfaces:**
- **`THINGS["wiki_space"]`:**
  - model `WikiSpace`, label "Wiki library", name = `name`;
  - link `{settings.wiki_origin}/library/{key}`.
- **`THINGS["wiki_node"]`:**
  - model `WikiNode`, name = `title`;
  - row label "Wiki folder" for a folder, else "Wiki page";
  - link `{settings.wiki_origin}/n/{id}`;
  - `can_watch` = not deleted.
- **`WatchOut`** gains `thing_label: str | None`.
- **`access._PAGES`** gains the two wiki things, decided by the wiki's rule:
  - build principals with `principal_from_access` / `principals_for_people`, then use `AccessIndex`;
  - a space needs a level (`levels_for_spaces`);
  - a node goes through `viewable_nodes`: not deleted, a level of view or above, and a published page for view-only people.
  - A page-equivalence test pins each against `GET /wiki/spaces/{key}` and `GET /wiki/nodes/{id}` (the 200/404 sets).
- **`wiki/notify._watchers`:**
  - It returns the person watchers plus the members of enabled groups whose wiki watches match the space or the node chain.
  - It returns routes per person (`watch`, `group:<id>`).
  - `_send` and `_deliver` pass `log_detail={"via": …, "names": …}` to `notify()` for watch-driven sends.
  - The cap, actor exclusion and `recipients_who_can_view` filter are unchanged and apply to the union.

- [ ] **Step 1: Write the failing tests:**
  - `test_group_wiki_watch_fan_out` (Review Focus):
    - an enabled group watching a folder → its members hear a published page under it;
    - a member who can't see the page doesn't;
    - a paused group gives nothing;
    - `via` and `names` are logged.
  - `test_me_lists_only_visible_wiki_watches` (Review Focus), with Via the group and the absolute link.
  - `test_group_watches_a_library_and_a_page` (group routes):
    - 201 with `thing_label`, and the audit;
    - kinds other than `[]` → 422 `invalid_kind`.
  - The wiki access equivalence tests.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step-1 files plus `tests/test_watches_api.py tests/test_group_watches_api.py tests/test_watch_matching.py tests/test_notification_access.py tests/test_wiki_notify.py tests/test_wiki_watches_api.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): groups watch wiki libraries, folders and pages; /me lists wiki watches`.

### Task 3: Portal: wiki rows and the Wiki picker

**Files:**
- Modify:
  - `portal/src/lib/api.ts` (`WatchThing` gains `'wiki_space' | 'wiki_node'`; `Watch.thing_label`; wiki search and space list functions);
  - `portal/src/lib/watches.ts` (`THING_LABELS`);
  - `portal/src/components/notifications/WatchesTable.tsx`, `portal/src/pages/me/WatchesSection.tsx`, `portal/src/components/notifications/GroupWatchesPanel.tsx`, `portal/src/components/notifications/AddGroupWatchModal.tsx`;
  - and their tests.

**Interfaces:**
- **`WatchesTable`:**
  - The chip shows `watch.thing_label ?? THING_LABELS[thing]`.
  - An absolute `link` renders as `<a href>` (it opens the wiki). A relative one stays a router `Link`.
- **Wiki rows:** /me offers only "Stop watching", and the group panel only "Remove" (call 2).
- **AddGroupWatchModal:**
  - The segments are Initiative, Site, Truck, Device, Wiki, Everything.
  - Wiki shows a field "Wiki" with the placeholder "Search the wiki…".
  - It runs a server search via the ComboBox's `onSearch`:
    - libraries from `GET /wiki/spaces` matched by name, with `sub` "Wiki library";
    - folders and pages from `GET /wiki/search?q=…&kind=folder` and `&kind=page`, with `sub` "Wiki folder" / "Wiki page" and the breadcrumbs.
  - The value is `wiki_space:<id>` or `wiki_node:<id>`.
  - The events editor is replaced by the note "Wiki watches hear every page update and comment, as today."
  - Save sends `{thing: 'wiki_space' | 'wiki_node', id, kinds: []}`.
  - A failed search shows "Could not load the wiki." (new copy, flagged with call 7).

- [ ] **Step 1: Write the failing tests:**
  - A wiki row's chip and its absolute link.
  - Wiki rows' row actions.
  - The segment order.
  - The Wiki picker searches libraries, folders and pages and saves the right payload.
  - The note replaces the events editor.
  - Update the pins that count segments.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole portal suite, `npx tsc -p .` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): wiki watches on /me and the group page; groups pick wiki things`.
