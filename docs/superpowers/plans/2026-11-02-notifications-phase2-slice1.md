# Notifications Phase 2, Slice 1 (Watches and Events) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People and groups can watch an initiative, site or truck, or chosen event types everywhere. Initiative and truck status changes reach them through the notification worker's one-minute sweep: access is checked, items are grouped per person per type, and the Delivery log explains each decision.

**Architecture:**

- **Data:** migration 0113 adds `notification_watches` and `notification_events` and drops the hidden `notification_groups.categories`.
- **Announcing:** `notifications/events.announce()` adds one event row to the caller's session. `notifications/status_changes.py` builds the initiative and truck events (title, link, the things they reach). It is called from the initiative edit and from the three truck status-change paths.
- **Who can see what:** `notifications/access.py` answers, for any set of people, who can see an initiative, site or truck. It makes exactly the decision each page makes.
- **Watches:** `notifications/watches.py` validates and stores watches and works out which watches an event matches. The routes are `/auth/me/watches` and `/notifications/groups/{id}/watches`.
- **Sending:** `notifications/event_sweep.run_events_once` runs every 60 s in notification-worker.
  - It claims waiting events with SKIP LOCKED and resolves their recipients.
  - It filters out the actor, inactive accounts and people without access, and applies the cap.
  - It groups the items per person per type and calls `notify()`.
- **Explaining:**
  - The send-time re-check gains `no_access` and `not_watching`.
  - Check delivery lists the watches that would hear a type.
  - The Delivery log shows each route.
- **Portal:**
  - a Watch button on initiative, site and truck pages;
  - "What you watch" on /me;
  - "What this group watches" on the group page;
  - Delivery log and Check delivery additions.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, PostgreSQL 16, pytest (real Postgres); React 18 + TypeScript, Vite, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-02-notifications-phase2-design.md` (Build order, slice 1).

## Global Constraints

- **American English** everywhere (copy, comments, commit messages). Before committing, grep the changed files for `-ise|-isation|colour|enrol\b|enrolment|behaviour|centre|licence`.
- **Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/notif-phase2`, branch `notif-phase2`. Work only there and never `cd` into the main checkout.
- **API tests:** `cd api && SS_TEST_DB=serversherpa_test_notif2 PYTHONPATH=src .venv/bin/pytest <files> -q -p no:cacheprovider`. `PYTHONPATH=src` is required, because the shared venv otherwise imports the main checkout's code. Do not run the whole API suite (about 90 minutes); run the files each task names.
- **Portal checks:**
  - tests: `cd portal && npx vitest run <files>`
  - typecheck: `cd portal && npx tsc -p .`
  - guardrails: `cd portal && npx vitest run src/styles`
  - build: `cd portal && npm run build`. It type-checks test files too.
- **Run every test command in the FOREGROUND,** in one continuous run with a 600000 ms timeout. Never background a suite and end your turn waiting.
- **Git hygiene:**
  - Never use bare `git stash`.
  - Never commit `api/src/serversherpa/_dev_reload.py`; restore it with `git checkout -- api/src/serversherpa/_dev_reload.py` if a run touched it.
  - Commit trailer, exactly: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Session discipline:** `notify()`, `record()` and `announce()` add to the caller's session and never commit. Routes and sweeps commit.
- **Log privacy:** no email address or message body in a `notification_log` row's `detail` or in a log line.
- **Two copies of every worker:** production runs two stacks on one database. Every sweep claims its rows with `FOR UPDATE SKIP LOCKED`.
- **No new policy numbers:** the event sweep runs every 60 s, and the recipient cap is `MAX_RECIPIENTS` (500) from `wiki/notify.py`.
- **Migration:** `"0113"` with down_revision `"0112"`. This slice adds no other migration.
- **Things in this slice:** `initiative`, `site`, `truck`, plus `everything` (an Everything watch). The device and wiki columns exist, but the API answers 422 `invalid_thing` for those kinds until their slices.
- **No `state` key in a new notification payload:** `recheck_notification` reads `payload.state` as "resolved".
- **Copy:** UI copy is exactly as quoted in the spec, in this plan (taken from the mockup Jimmy approved) or in "Calls this plan makes". New tests use neutral names ("Group A", "Person A", "Initiative A").
- **Portal controls:**
  - Reuse `Switch` (named via `label`), `.segmented` / `ChoiceField`, `ComboBox`, chips, `DataTable`, `RowActionsMenu` and `NotificationModal` (which carries the standard header).
  - Modal footers follow `EditGroupModal`: `btn-solid` submit, `mini-btn` Cancel, `span.pf-error[role=alert]`.
  - No raw `<select>`, time input or bare checkbox in touched UI. A new table wrapper class joins the themed-scrollbar list in `styles/notifications.css` (`:is(.swgrid, .nd-crit, .ngd-members)`).
- **Permissions:** group watch routes use `require_permission("notifications", "view" | "change")`. The `notifications` resource is global-only (`access/resources.py`).

## Calls this plan makes (beyond the spec)

1. **Group `categories` is dropped in 0113,** not in the wiki migration. Once Initiatives and Trucks join `CATEGORIES`, a group save carrying them would pass `validate_settings` and then fail the 0109 CHECK.
2. **Group-watch audit follows the repo convention:** `entity_type="notification_group"` with actions `watch.add`, `watch.update` and `watch.remove`. The spec's `notification_group_watch_*` names predate that check.
3. **An Active group is `NotificationGroup.enabled`,** which the portal shows as Enabled or Paused.
4. **An active account follows the wiki's rule** (`wiki/notify.py:101-107`): an account row exists, `disabled_at` is null and `archived_at` is null.
5. **/me lists only watches on things the person can see now,** whether their own or a group's. A watch on something they can't see stays stored and silent (spec §1), but is not listed, so no thing's name leaks through a group.
6. **/me lists only Active groups' watches,** because a Paused group delivers nothing.
7. **The watch tables use `DataTable`,** as the spec says. `DataTable` has no column menu, so the "Since" column is left out of both tables, as in the mockup.
8. **An event whose subject no longer exists** is marked sent, with no notifications and no log rows.
9. **The cap of 500 applies to candidates before filtering,** in route order (named people, named groups, watches), as `wiki/notify.py` does.
10. **`notify()` gains `log_detail`,** which is merged into the detail of the inbox row it logs (`inbox_written` or `inbox_suppressed`).
11. **A truck change applied from MacroPoint** carries the message's own time as its line, in the reference zone with its abbreviation (e.g. "Nov 2, 3:04 PM EST"). Other truck and initiative changes have no line.
12. **Error copy:**
    - `already_watching` → "You're already watching this."
    - other watch errors use the house fallback `Request failed (<code>).`
    - the Watch button's failure toast is the wiki's "Couldn't update your watch."
    - `read_only_mode` shows the server's message wherever it surfaces.
13. **The group "Choose events…" modal** uses the mockup's description, "Pick the events this group hears about." The group empty state is "This group isn't watching anything yet."

## Review Focus

- **A client user's Everything watch.** A client-anchored person with an Everything watch on "Initiative status changed" hears only about their own client's initiatives. Another client's change logs `inbox_suppressed` with reason `no_access` for them, and nothing about it reaches their inbox (Task 6: `test_everything_watch_respects_client_scope`).
- **Pausing a group.** Pausing stops the group's watches at once: the next sweep skips its members. An email already held from that group's watch is dropped at send time with `not_watching` (Tasks 6 and 7: `test_paused_group_hears_nothing`, `test_recheck_not_watching_after_pause`).
- **A MacroPoint burst.** One apply moves three trucks of one initiative, one of them twice. Each watcher of that initiative gets one notification, "Truck status changed (4)", with the lines oldest first and linked to the initiative (Task 6: `test_burst_groups_into_one_notification`).
- **The editor, and two routes to one person.** The person who changed a status never hears about it, even through a group or an Everything watch. Someone reached by their own watch and by a group gets one notification, and its log `via` lists both routes (Task 6: `test_actor_never_notified`, `test_two_routes_one_notification`).
- **Two workers at once.** Two `run_events_once` calls running concurrently over the same waiting events write each notification once (Task 6: `test_concurrent_sweeps_do_not_double_send`).

---

### Task 1: Watch and event tables (API), and groups lose `categories`

**Files:**
- Create: `api/migrations/versions/0113_notification_watches_events.py`
- Modify: `api/src/serversherpa/db/models.py` (add `NotificationWatch` and `NotificationEvent`; `NotificationGroup` loses `categories`)
- Modify: `api/src/serversherpa/api/routes/notifications.py` (`GROUP_FIELDS`, `validate_settings`, `_normalize_categories` and the group out-builder drop categories)
- Modify: `api/src/serversherpa/api/routes/me.py` (around :260, no categories)
- Modify: `api/src/serversherpa/api/schemas.py` (`NotificationGroupSettings` goes; the create and patch inputs, `NotificationGroupOut` and `MyNotificationGroupOut` lose `categories`)
- Modify: the portal's group types and calls in `portal/src/lib/api.ts`, and anything else in `portal/src` that reads or sends a group's `categories`
- Test: `api/tests/test_migration_0113_watches_events.py` (new). Update every API and portal test that sends or reads a group's `categories`.

**Interfaces:**
- Produces `NotificationWatch`, table `notification_watches`:
  - `id` uuid PK
  - `person_id` → people, CASCADE, null; `group_id` → notification_groups, CASCADE, null
  - thing columns `initiative_id`, `site_id`, `truck_id`, `device_id`, `wiki_space_id`, `wiki_node_id`: each FK CASCADE to its table as named in `models.py`, null
  - `kinds` ARRAY(Text), NOT NULL, server default `'{}'`
  - `created_by` → people, SET NULL; `created_at` timestamptz, NOT NULL, default now
  - CHECK `ck_notification_watches_subscriber`: `(person_id IS NULL) <> (group_id IS NULL)`
  - CHECK `ck_notification_watches_one_thing`: `num_nonnulls(<six thing columns>) <= 1`
  - CHECK `ck_notification_watches_everything_kinds`: `num_nonnulls(<six>) = 1 OR cardinality(kinds) > 0`
  - unique index `uq_notification_watches_target` on `(person_id, group_id, <six>)` `NULLS NOT DISTINCT`
  - indexes `ix_notification_watches_group_id`, plus one partial index per thing column (`WHERE <col> IS NOT NULL`)
- Produces `NotificationEvent`, table `notification_events`:
  - `id` bigint identity PK; `kind` Text NOT NULL; `subject_type` Text NOT NULL; `subject_id` uuid NOT NULL
  - `reaches` JSONB NOT NULL default `'[]'`; `actor_id` → people, SET NULL
  - `person_ids` and `group_ids`: ARRAY(UUID) NOT NULL default `'{}'`
  - `watchers` bool NOT NULL default true; `rule_id` → status_rules, SET NULL; `item` JSONB NOT NULL default `'{}'`
  - `created_at` timestamptz NOT NULL default now; `sent_at` timestamptz null
  - indexes `ix_notification_events_waiting` on `(id) WHERE sent_at IS NULL`, and `ix_notification_events_sent_at` on `(sent_at)`
- 0113 drops `notification_groups.categories` with its CHECK `ck_notification_groups_categories`.
- The downgrade drops both tables and restores `categories` as ARRAY(Text) NOT NULL default `'{}'`, with the 0109 CHECK values (approvals, reports, wiki, security, learning).
- The group create and patch inputs keep `extra="forbid"`, so a body that still sends `categories` gets 422.

- [ ] **Step 1: Write the failing tests** in `test_migration_0113_watches_events.py`. Copy the throwaway-DB pattern of `test_migration_0111_notifications_phase1.py`, using DB `<SS_TEST_DB>_m0113`.
  - `test_watch_checks`: at 0113,
    - a person watch on an initiative inserts;
    - a row with both `person_id` and `group_id` raises IntegrityError;
    - a row with `initiative_id` and `site_id` raises IntegrityError;
    - an Everything row (no thing) with `kinds = '{}'` raises IntegrityError;
    - a second identical watch (same person and initiative) raises a unique violation;
    - two Everything rows for one person (kinds `{x}` and `{y}`) raise a unique violation.
  - `test_event_defaults`: an event inserted with only `kind`, `subject_type` and `subject_id` reads back with `reaches == []`, `watchers is True`, `person_ids == []` and `sent_at is None`.
  - `test_group_categories_dropped`: a group created at 0112 with `categories = '{wiki}'` survives the upgrade, and the column is gone.
  - `test_downgrade_restores`: at 0112 both tables are gone and `categories` is back, empty. Inserting `'{wiki}'` works and `'{nope}'` fails the CHECK.
  - In `test_notification_groups_api.py`: POST and PATCH with `categories` → 422; group GET responses have no `categories` key.
- [ ] **Step 2: Run them to verify they fail** with `… pytest tests/test_migration_0113_watches_events.py tests/test_notification_groups_api.py`. Expected: FAIL (no revision 0113; `categories` still accepted).
- [ ] **Step 3: Implement** the migration and the models, remove `categories` from the group schemas, routes and me.py, and update the portal's group types and callers.
- [ ] **Step 4: Run**
  - API: `tests/test_migration_0113_watches_events.py tests/test_migration_0112_drop_group_delivery_settings.py tests/test_notification_groups_api.py tests/test_notification_self_service.py`. Then run `cd api && PYTHONPATH=src .venv/bin/alembic heads` → `0113 (head)`.
  - Portal: `npx vitest run src/pages/NotificationGroupDetail.test.tsx src/pages/me src/components/notifications`, then `npx tsc -p .`.
  - Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): watch and event tables; groups drop their hidden categories`.

### Task 2: Announce initiative and truck status changes (API)

**Files:**
- Modify: `api/src/serversherpa/notifications/kinds.py`, `api/src/serversherpa/notifications/company.py`, `api/src/serversherpa/system/config_store.py` (`DEFAULTS["notifications"]["defaults"]`)
- Modify: `api/src/serversherpa/api/schemas.py` (`NotificationKindOut`, `NotificationKindSettingOut`) and `api/src/serversherpa/api/routes/notifications.py` (where those rows are built)
- Create: `api/src/serversherpa/notifications/events.py`, `api/src/serversherpa/notifications/status_changes.py`
- Modify: `api/src/serversherpa/services/initiatives.py`. It gains `ancestor_ids`, moved from `api/routes/initiatives.py:783` (`_ancestor_ids`); the route imports it from there.
- Modify the call sites:
  - `api/src/serversherpa/api/routes/initiatives.py` (`update_initiative`)
  - `api/src/serversherpa/api/routes/trucks.py` (`update_truck`)
  - `api/src/serversherpa/trucks/bulk_import.py` (`_apply_update`)
  - `api/src/serversherpa/trucks/macropoint/apply.py` (`apply_messages`)
- Test: `api/tests/test_notification_events.py` (new). Update `test_notification_kinds.py`, `test_notification_settings_api.py`, and `test_notification_log_api.py::test_kinds_report_critical_and_locked`.

**Interfaces:**
- In `kinds.py`:
  - `KindInfo` gains `reaches: tuple[str, ...] = ()` and `everywhere: bool = False`, and a property `watchable -> bool` (`bool(self.reaches)`).
  - `CATEGORIES` order: approvals, reports, wiki, learning, `"initiatives": "Initiatives"`, `"trucks": "Trucks"`, security.
  - `KINDS` gains, after the learning kinds:
    - `"initiative_status_changed": KindInfo("initiatives", "Initiative status changed", reaches=("initiative", "site"), everywhere=True)`
    - `"truck_status_changed": KindInfo("trucks", "Truck status changed", reaches=("truck", "initiative", "site"), everywhere=True)`
- `company.CONFIGURABLE_CATEGORIES = ("approvals", "reports", "wiki", "learning", "initiatives", "trucks")`. Both new defaults are `{"inbox": True, "email": True}`.
- The kind rows of `GET /notifications/settings` and `GET /notifications/kinds` gain `watchable: bool`, `everywhere: bool` and `reaches: list[str]` (in the tuple's order).
- In `events.py`:
  - `@dataclass(frozen=True) class Thing: type: str; id: uuid.UUID`, with `to_json() -> dict` (`{"type", "id": str}`) and `@classmethod from_json(cls, raw: Mapping) -> Thing`.
  - `@dataclass(frozen=True) class EventItem: title: str; line: str = ""; link: str | None = None; initiative_id: uuid.UUID | None = None; at: datetime | None = None`, with `to_json() -> dict`. Ids and times are stored as strings.
  - `def announce(db: AsyncSession, kind: str, *, subject: Thing, item: EventItem, reaches: Iterable[Thing] = (), actor_id: uuid.UUID | None = None, person_ids: Iterable[uuid.UUID] = (), group_ids: Iterable[uuid.UUID] = (), watchers: bool = True, rule_id: uuid.UUID | None = None) -> NotificationEvent`
    - It is synchronous and only calls `db.add`.
    - It raises `ValueError` for a kind not in `KINDS`.
    - `reaches` is de-duplicated in order, with the subject removed.
    - Every call site passes the kind as a positional string literal, so the registration scan can find it.
- `services/initiatives.py`: `async def ancestor_ids(db: AsyncSession, start: uuid.UUID) -> set[uuid.UUID]`. Its behavior is unchanged: transitive, excludes `start`, cycle-safe.
- In `status_changes.py`:
  - `async def announce_initiative_status_changed(db: AsyncSession, initiative: Initiative, *, old: str, new: str, actor_id: uuid.UUID | None) -> NotificationEvent`
    - title `"{name}: {old label} → {new label}"`, using `status.labels.status_labels(db, "initiative")` labels and falling back to the key;
    - link `/initiatives/{id}`, `initiative_id` = the initiative, line `""`;
    - reaches: the ancestors as `Thing("initiative", …)` sorted by id, then the non-null `site_id`, `origin_site_id` and `destination_site_id` as `Thing("site", …)`.
  - `async def announce_truck_status_changed(db: AsyncSession, truck: Truck, *, old: str, new: str, actor_id: uuid.UUID | None, at: datetime | None = None) -> NotificationEvent`
    - title `"{name}: {old label} → {new label}"` (record type `"truck"`);
    - link `/logistics/trucks/{id}`, `initiative_id` = `truck.initiative_id`;
    - line `event_time(at)` when `at` is given, else `""`, and `item.at = at`;
    - reaches: the truck's initiative and its ancestors, then `start_site_id` and `end_site_id`.
  - `def event_time(at: datetime) -> str`: `at` in `services/timezone.DEFAULT_TIMEZONE`, formatted like "Nov 2, 3:04 PM EST".
- The call sites announce only when the status really changed (old != new):
  - **initiative edit:** inside the `try` before the commit, `old`/`new` from `changes["status"]`, actor = the editor;
  - **truck edit:** from the route's `diff`;
  - **bulk import:** for an approved update whose status changed, actor = the route's actor;
  - **MacroPoint:** each status change, with `at=m.recorded_at`.
  - Creating an initiative or a truck announces nothing.

- [ ] **Step 1: Write the failing tests** in `test_notification_events.py`:
  - `test_announce_is_part_of_the_callers_transaction`:
    - announce, then roll back → no `notification_events` row;
    - announce, then commit → one row with the kind, subject, item JSON, `watchers` true and `sent_at` null;
    - `reaches` given `[site A, initiative B, site A, <subject>]` is stored as `[site A, initiative B]`.
  - `test_announce_rejects_unknown_kind` → `ValueError`.
  - `test_initiative_status_patch_announces`:
    - Setup: a global admin PATCHes Initiative A from planned to in_progress. Initiative A has a parent (an `initiative_links` row) and all three site columns set.
    - Result: one event `initiative_status_changed`, subject Initiative A, actor the admin.
    - Its title uses the two status labels.
    - Its reaches are the parent, then the three sites.
  - `test_initiative_patch_without_a_status_change_is_silent`:
    - Setup: one PATCH changes only the name; another sends the current status.
    - Result: no event.
  - `test_creating_is_silent`: POST an initiative and POST a truck → no events.
  - `test_truck_edit_announces`:
    - Setup: truck A is linked to Initiative A, which has a parent, and has a start and an end site.
    - Result: the event's reaches are Initiative A, its parent, then the start and end sites.
  - `test_truck_bulk_import_update_announces`: an approved update that changes status gives one event, actor the importer.
  - `test_macropoint_apply_announces_each_change`:
    - Setup: two messages move one truck twice.
    - Result: two events, oldest first.
    - Each `line == event_time(m.recorded_at)` and each `item.at` is that message's time.
  - In `test_notification_kinds.py`:
    - the table, flags and categories pins gain the two kinds and categories;
    - a new pin `test_reaches_and_everywhere` covers exactly the two kinds above.
    - Add `ANNOUNCE_CALL = re.compile(r"""\bannounce\(\s*[\w.]+\s*,\s*["']([a-z_]+)["']""")` to `_scan` for every file, so `found == set(KINDS)` still holds.
  - In `test_notification_settings_api.py`: the `CONFIGURABLE_CATEGORIES` and defaults pins have six categories, and `kinds["truck_status_changed"]` has `watchable` true, `everywhere` true and `reaches == ["truck", "initiative", "site"]`.
- [ ] **Step 2: Run them to verify they fail.** Expected: import errors for `events` and `status_changes`, and the pins fail.
- [ ] **Step 3: Implement** the kinds, categories, kind-row fields, `events.py`, `ancestor_ids`, `status_changes.py` and the four call sites.
- [ ] **Step 4: Run** the step-1 files plus `tests/test_initiatives_api.py tests/test_initiative_links_api.py tests/test_initiatives_client_scope.py tests/test_trucks_api.py tests/test_trucks_bulk_import_api.py tests/test_trucks_bulk_import_service.py tests/test_macropoint_api.py tests/test_notification_log_api.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): announce initiative and truck status changes`.

### Task 3: Who can see a thing (API)

**Files:**
- Create: `api/src/serversherpa/notifications/access.py`
- Test: `api/tests/test_notification_access.py` (new)

**Interfaces:**
- Consumes: `events.Thing`, `access.resolver.resolve_access_many`, `access.scope.scope_conditions`.
- Produces in `access.py`:
  - `VIEWABLE_THINGS: tuple[str, ...] = ("initiative", "site", "truck")`.
  - `async def active_ids(db: AsyncSession, person_ids: Iterable[uuid.UUID]) -> set[uuid.UUID]`: the people with an account row whose `disabled_at` and `archived_at` are both null.
  - `async def thing_exists(db: AsyncSession, thing: Thing) -> bool`.
  - `async def viewers(db: AsyncSession, thing: Thing, person_ids: Iterable[uuid.UUID], *, access: Mapping[uuid.UUID, AccessInfo] | None = None) -> set[uuid.UUID]`:
    - **Initiative:** `info.can("initiatives", "view")`, and either `scope_conditions("initiatives", info, pid)` is None or a probe `select(Initiative.id).where(Initiative.id == id, cond)` finds the row. This is `_get_initiative`'s decision; archived initiatives stay visible.
    - **Site:** `info.can("sites", "view")`. **Truck:** `info.can("trucks", "view")`.
    - A missing row gives `set()`. A type outside `VIEWABLE_THINGS` raises `ValueError`.
    - When `access` is given it is used as is, with no new resolve.

- [ ] **Step 1: Write the failing tests:**
  - `test_initiative_viewers_match_the_page`:
    - **Setup:** Initiative A belongs to client A. The people are:
      - a global admin;
      - a staff user;
      - a client-anchored user of client A;
      - one of client B;
      - a partner-anchored user;
      - a worker;
      - a staff user with a `PermissionOverride(initiatives, view, allow=False)`.
    - **Expectation:** each person logs in and GETs `/initiatives/{id}`. `viewers(...)` equals exactly the set that got 200.
    - **Second case:** for an initiative with no client, the client users are out.
  - `test_site_and_truck_viewers_match_the_pages`: the same people against `/sites/{id}` and `/trucks/{id}`.
  - `test_missing_thing_has_no_viewers`, and `test_unknown_thing_type_raises`.
  - `test_active_ids`: a disabled account, an archived person and a person with no account are all out.
  - `test_given_access_is_used`: monkeypatch `resolve_access_many` to raise. A call that passes `access=` still answers.
- [ ] **Step 2: Run them to verify they fail** (import error).
- [ ] **Step 3: Implement** `access.py`.
- [ ] **Step 4: Run** `tests/test_notification_access.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): who can see an initiative, site or truck`.

### Task 4: Watches and the /me routes (API)

**Files:**
- Create: `api/src/serversherpa/notifications/watches.py`
- Modify: `api/src/serversherpa/api/routes/me.py` and `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_watches_api.py` (new), `api/tests/test_watch_matching.py` (new)

**Interfaces:**
- Consumes: `events.Thing`, the access module (`viewers`), `kinds.KINDS`.
- Produces in `watches.py`:
  - **Things:**
    - `EVERYTHING = "everything"`.
    - `@dataclass(frozen=True) class ThingSpec: column: str; model: type; label: str; link: Callable[[uuid.UUID], str]`.
    - `THINGS: Mapping[str, ThingSpec]`, with three entries:
      - `initiative` → (`initiative_id`, `Initiative`, "Initiative", `/initiatives/{id}`)
      - `site` → (`site_id`, `Site`, "Site", `/sites/{id}`)
      - `truck` → (`truck_id`, `Truck`, "Truck", `/logistics/trucks/{id}`)
  - **Errors:** `class WatchError(Exception)` with `.status: int` and `.code: str`.
  - **Kinds:**
    - `def kinds_for(thing: str) -> list[str]`: registry order. For `everything` it is the kinds with `everywhere`; for anything else, the kinds whose `reaches` include the thing.
    - `def clean_kinds(thing: str, kinds: Sequence[str]) -> list[str]`:
      - de-duplicates into registry order;
      - a kind outside `kinds_for(thing)` → `WatchError(422, "invalid_kind")`;
      - `everything` with none → `WatchError(422, "kinds_required")`.
  - **`def thing_of(watch: NotificationWatch) -> Thing | None`:** None for Everything.
  - **`async def add_watch(...) -> NotificationWatch`:**
    - Signature: `add_watch(db: AsyncSession, *, thing: str, thing_id: uuid.UUID | None, kinds: Sequence[str], viewer_id: uuid.UUID, viewer_access: AccessInfo, created_by: uuid.UUID | None, person_id: uuid.UUID | None = None, group_id: uuid.UUID | None = None)`.
    - 422 `invalid_thing` for:
      - an unknown thing;
      - `everything` given an id;
      - a thing without an id.
    - 404 `thing_not_found` when the thing is missing or not visible to the viewer.
    - 409 `already_watching` when the row exists; also when the unique index fires in a race.
    - It flushes.
  - **`@dataclass(frozen=True) class WatchView`:**
    - fields `watch: NotificationWatch`, `thing: str`, `thing_id: uuid.UUID | None`, `thing_name: str | None`, `link: str | None`, `group: NotificationGroup | None`;
    - `thing` is `"everything"` for an Everything watch.
  - **`async def person_watches(db: AsyncSession, person_id: uuid.UUID) -> list[WatchView]`:**
    - the person's own watches plus the watches of the enabled groups they belong to;
    - only things they can see now, though Everything is always listed;
    - own watches first, then group watches, each newest first.
  - **`async def group_watches(db: AsyncSession, group_id: uuid.UUID) -> list[WatchView]`:** all of them, newest first.
  - **`async def own_watch_on(db: AsyncSession, person_id: uuid.UUID, thing: str, thing_id: uuid.UUID) -> NotificationWatch | None`.**
  - **`async def matching_routes(db: AsyncSession, event: NotificationEvent) -> dict[uuid.UUID, set[str]]`:**
    - Empty when `event.watchers` is false.
    - A watch matches when its `kinds` is empty or holds `event.kind`, and its thing is either the subject or one of `event.reaches`. An Everything watch also matches when the kind is `everywhere`.
    - A person watch gives that person `{"watch"}`.
    - An enabled group's watch gives each member `{"group:<group id>"}`. A Paused group's watch gives nothing.
- **Schemas:**
  - `WatchIn{thing: str, id: uuid.UUID | None = None, kinds: list[str] = []}`, with `extra="forbid"`.
  - `WatchKindsIn{kinds: list[str]}`, with `extra="forbid"`.
  - `WatchViaOut{type: Literal["you", "group"], id: uuid.UUID | None = None, name: str | None = None}`.
  - `WatchOut{id, thing, thing_id, thing_name, link, kinds, via: WatchViaOut, created_at}`.
  - `WatchStateOut{watching: bool, watch_id: uuid.UUID | None, kinds: list[str]}`.
- **Routes in `me.py`** (all `CurrentUser`; writes commit; `WatchError` maps to `HTTPException(status, {"code": code})`):
  - `GET /auth/me/watches` returns `list[WatchOut]`.
  - `GET /auth/me/watches/state?thing=&id=` returns `WatchStateOut`. An unknown thing → 422 `invalid_thing`. Only the person's own watch counts.
  - `POST /auth/me/watches` returns 201 `WatchOut`.
  - `PATCH /auth/me/watches/{watch_id}` (`WatchKindsIn`) returns `WatchOut`.
  - `DELETE /auth/me/watches/{watch_id}` returns 204.
  - A watch id that isn't the caller's own → 404 `watch_not_found`.

- [ ] **Step 1: Write the failing tests:**
  - **`test_watches_api.py`:**
    - `test_watch_and_unwatch_an_initiative`: POST with `kinds: []` → 201, `via {"type": "you"}`, `thing_name` "Initiative A", link `/initiatives/{id}`. State is `watching` with its id. DELETE → 204, and state is not watching.
    - `test_choose_events`: PATCH `["truck_status_changed"]` on an initiative watch → 200. On a site watch → 200. On a truck watch, `["initiative_status_changed"]` → 422 `invalid_kind`.
    - `test_everything`:
      - POST `{"thing": "everything", "kinds": []}` → 422 `kinds_required`.
      - POST with `["initiative_status_changed"]` → 201, `thing_id` null.
      - A second Everything POST → 409 `already_watching`.
    - `test_errors`:
      - an unknown thing, or `"device"` → 422 `invalid_thing`;
      - `everything` with an id → 422 `invalid_thing`;
      - a missing id → 404 `thing_not_found`;
      - a client B user watching client A's initiative → 404 `thing_not_found`;
      - a second watch on the same thing → 409;
      - PATCH or DELETE of another person's watch → 404 `watch_not_found`.
    - `test_list_includes_enabled_groups_only_and_visible_things`:
      - The person has an own watch, Group A (enabled) watching Site A, and Group B (paused) watching Truck A.
      - They see their own row and Site A with `via {"type": "group", "name": "Group A"}`, and not Truck A.
      - A group watch on an initiative they can't see is not listed.
    - `test_writes_blocked_in_read_only_mode`: POST → the read-only status and code that the other write tests use.
  - **`test_watch_matching.py`** (unit, with events built through `announce` and committed):
    - a watch on the subject matches;
    - a watch on a parent initiative in `reaches` matches;
    - a site watch matches through `reaches`;
    - a watch whose `kinds` excludes the type doesn't match;
    - an Everything watch matches an `everywhere` kind;
    - `watchers=False` gives `{}`;
    - a Paused group gives nothing;
    - a person in two matching groups gets both group routes.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** `watches.py`, the schemas and the five routes.
- [ ] **Step 4: Run** the step-1 files plus `tests/test_notification_access.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): watch initiatives, sites, trucks and events everywhere`.

### Task 5: Group watches (API)

**Files:**
- Modify: `api/src/serversherpa/api/routes/notifications.py`
- Test: `api/tests/test_group_watches_api.py` (new)

**Interfaces:**
- Consumes: `watches.add_watch`, `watches.group_watches`, `watches.clean_kinds`, and the Task 4 schemas.
- Produces:
  - `GET /notifications/groups/{group_id}/watches` (view) returns `list[WatchOut]` with `via {"type": "group", "id", "name"}`.
  - `POST` (change) takes `WatchIn` and returns 201. The viewer is the admin (`actor.person.id`, `actor.access`).
  - `PATCH /notifications/groups/{group_id}/watches/{watch_id}` (change) takes `WatchKindsIn`.
  - `DELETE` (change) returns 204.
  - Errors:
    - 404 `group_not_found`;
    - 404 `watch_not_found` for a watch that isn't this group's;
    - the Task 4 codes otherwise.
  - Audit (`services/audit.audit`) on each write: `entity_type="notification_group"`, `entity_id=str(group_id)`.
    - `watch.add` with `changes={"thing", "thing_id", "kinds"}`;
    - `watch.update` with `changes={"kinds": {"from", "to"}}`;
    - `watch.remove` with `changes={"thing", "thing_id"}`.

- [ ] **Step 1: Write the failing tests:**
  - `test_admin_adds_and_removes_a_group_watch`, each step with its audit row:
    - POST a site watch → 201;
    - GET lists it;
    - PATCH kinds → 200;
    - DELETE → 204.
  - `test_permissions`: staff → 403 on all four routes. A role with view but not change can GET and gets 403 on writes (`PermissionOverride` rows as in `test_notification_settings_api.py:107`).
  - `test_errors`: an unknown group → 404 `group_not_found`; another group's watch id → 404 `watch_not_found`; a duplicate → 409; Everything without kinds → 422 `kinds_required`.
  - `test_read_only_mode_blocks_writes`.
- [ ] **Step 2: Run them to verify they fail** (404 on the routes).
- [ ] **Step 3: Implement** the four routes.
- [ ] **Step 4: Run** `tests/test_group_watches_api.py tests/test_notification_groups_api.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): groups watch things and events`.

### Task 6: The event sweep (worker)

**Files:**
- Create: `api/src/serversherpa/notifications/event_sweep.py`
- Modify: `api/src/serversherpa/notifications/inbox.py` (`notify` gains `log_detail`)
- Modify: `api/src/serversherpa/notifications/worker.py`, `api/src/serversherpa/cli.py` (`--once`), and `api/src/serversherpa/system/log_service.py` (`enforce_retention`)
- Test: `api/tests/test_notification_event_sweep.py` (new). Update `tests/test_notification_worker.py` (its `--once` and idle-log pins) and `tests/test_log_service.py`.

**Interfaces:**
- Consumes:
  - `watches.matching_routes`;
  - `access.active_ids`, `access.viewers`, `access.thing_exists`;
  - `inbox.notify`, `delivery_log.record`;
  - `wiki.notify.MAX_RECIPIENTS`.
- Produces:
  - `notify(db, person_id, kind, title, *, body="", link=None, payload=None, owner_notice=False, log_detail: dict | None = None)`. `log_detail` is merged into the detail of the inbox row it logs.
  - In `event_sweep.py`:
    - `EVENT_BATCH = 200`
    - `LIST_PAGES = {"initiative_status_changed": "/initiatives", "truck_status_changed": "/logistics/trucks"}`
    - `async def run_events_once(maker: async_sessionmaker, *, now: datetime | None = None) -> int`, which returns the notifications written.
  - Worker: `EVENTS_INTERVAL_SECONDS = 60` and a `run_events(maker, state)` wrapper that copies `run_summaries`. The loop runs it before the summaries. `--once` runs status, events, summaries, deliver.
  - Retention: `enforce_retention` also runs `DELETE FROM notification_events WHERE sent_at < :cutoff`, on the same cutoff.
- **One sweep, in one session:**
  1. **Claim:** `select(NotificationEvent).where(sent_at IS NULL).order_by(id).limit(EVENT_BATCH).with_for_update(skip_locked=True)`.
  2. **Per event** (inside `db.begin_nested()`):
     - **Missing subject:** a subject that no longer exists marks the event sent and does nothing else.
     - **Candidates in route order:**
       - the named `person_ids`, with route `direct`, or `rule:<rule_id>` when `rule_id` is set;
       - the members of the named enabled groups, with route `group:<id>`;
       - `matching_routes(event)`.
     - **Cap:** the first `MAX_RECIPIENTS` distinct candidates, with one warning log line naming the event id and the count.
     - **Filters:**
       - Drop the actor unless they are in `person_ids`.
       - Keep `active_ids`.
       - Keep `viewers(subject)`. Each candidate dropped here gets `record("inbox_suppressed", channel="inbox", person_id=…, kind=…, category=…, reason="no_access", detail={"events": [id]})`.
     - **Failure:** an exception leaves the event waiting, logs one warning (exception class only, once per event id per process) and the sweep goes on.
  3. **Group the surviving items** by `(person, kind)`, oldest first.
     - **One item:** title `item.title`, body `item.line`, link `item.link`.
     - **Several items:**
       - title `"{kind label} ({n})"`;
       - body: one line per item, `"{title}"`, or `"{title} · {line}"` when the line is set, joined with `\n`;
       - link: the items' shared `initiative_id` as `/initiatives/{id}` when they all have the same non-null one, else `LIST_PAGES[kind]`.
     - **Write:** `notify(...)`, with:
       - `payload={"events": [ids], "subjects": [thing JSON], "via": sorted(routes)}`;
       - `log_detail={"via": sorted(routes), "events": [ids], "names": {"group:<id>": name, …}}`.
  4. **Finish:** mark every processed event `sent_at = now` and commit once. If any write fails, the whole sweep rolls back and is retried next tick, logged once.

- [ ] **Step 1: Write the failing tests** in `test_notification_event_sweep.py`. Build events through the Task 2 helpers and commit. Drive the sweep with `run_events_once(get_sessionmaker(), now=…)`. Use `test_notification_email.py`'s `_log`-style helpers locally.
  - `test_watcher_gets_one_notification`:
    - a person watching Initiative A gets the item's title and link;
    - `payload.via == ["watch"]`;
    - the `inbox_written` detail has `via`, `events` and `names`;
    - the event has `sent_at`.
  - `test_parent_watch_hears_the_child`, and `test_site_watch_hears_through_reaches`.
  - `test_kinds_filter`: a watch narrowed to `truck_status_changed` hears no initiative change.
  - `test_everything_watch_respects_client_scope` (Review Focus): the client A user hears client A's change, and client B's change logs `no_access` for them.
  - `test_paused_group_hears_nothing` (Review Focus), and `test_enabled_group_members_hear` (`via` has `group:<id>`).
  - `test_actor_never_notified` (Review Focus): the editor watches it directly, through a group and through Everything, and gets nothing.
  - `test_inactive_people_skipped`: a disabled account and an archived person.
  - `test_two_routes_one_notification` (Review Focus): `via == ["group:<id>", "watch"]`.
  - `test_burst_groups_into_one_notification` (Review Focus):
    - Setup: four truck events on one initiative, two of them for the same truck.
    - Result: one notification "Truck status changed (4)" with four body lines, oldest first, and link `/initiatives/{id}`.
    - With mixed initiatives, the link is `/logistics/trucks`.
  - `test_category_off_is_still_respected`: the person's Trucks Inbox switch is off → `inbox_suppressed` `category_off`, and its detail also carries `via`.
  - `test_cap`: monkeypatch `MAX_RECIPIENTS` to 2 with 3 watchers. Two get it, and one warning line names the event.
  - `test_deleted_subject_is_dropped`: delete the initiative after announcing. The event is marked sent, with no notifications and no log rows.
  - `test_concurrent_sweeps_do_not_double_send` (Review Focus): two `run_events_once` calls under `asyncio.gather` → each watcher has exactly one notification.
  - `test_failed_event_stays_waiting`: monkeypatch `matching_routes` to raise for one event id. The other event goes out, and that one keeps `sent_at` null.
  - In `test_log_service.py`, a sent event older than the cutoff is deleted, while a waiting one and a fresh sent one stay.
  - Update the worker pins: `--once` is `["status", "events", "summaries", "deliver"]`, and the idle-log strings change only if the worker reports this pass.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** the sweep, `log_detail`, the worker wiring, `--once` and retention.
- [ ] **Step 4: Run** the step-1 files plus `tests/test_notification_worker.py tests/test_notification_email.py tests/test_notifications_inbox.py tests/test_notification_summary.py tests/test_notification_delivery_log.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): the worker sends watched events, grouped per person and type`.

### Task 7: Re-check and Check delivery (API)

**Files:**
- Modify: `api/src/serversherpa/notifications/email.py` (`recheck_notification`), `api/src/serversherpa/notifications/watches.py`, `api/src/serversherpa/notifications/check.py`, `api/src/serversherpa/api/schemas.py` (`DeliveryCheckOut`)
- Test: `api/tests/test_watch_recheck.py` (new), and the existing Check delivery tests (in `api/tests/test_notification_log_api.py`; confirm with `grep -ln "notifications/check" api/tests/*.py`)

**Interfaces:**
- **Re-check:**
  - In `watches.py`: `async def watch_recheck(db: AsyncSession, notification: Notification) -> str | None`.
    - It returns None unless `payload.events` is set, and None when none of those events exist any more.
    - `"no_access"`: the person can see none of `payload.subjects` now.
    - `"not_watching"`: no event in the payload still reaches them. A route still holds when one of these is true:
      - they are named in `person_ids`;
      - they are a member of a named enabled group;
      - `matching_routes(event)` still has them.
  - `recheck_notification` runs it after `recipient_inactive` and before `category_turned_down`.
- **Check delivery:**
  - `check_delivery(...)` gains `watches`, which is None for a kind that isn't watchable.
  - For a watchable kind, it lists every watch of the person that would hear it, regardless of access:
    - their own watches, and their enabled groups' watches;
    - only watches whose thing type is in the kind's `reaches`, or Everything watches when the kind is `everywhere`;
    - only watches whose kinds are empty or include the kind.
  - Each entry is `{thing, thing_id, thing_name, kinds, via: {"type": "you" | "group", "id", "name"}}`.
  - Schema: `CheckWatchOut` holds those fields, and `DeliveryCheckOut.watches: list[CheckWatchOut] | None = None`.

- [ ] **Step 1: Write the failing tests** in `test_watch_recheck.py`, driven through `recheck_before_send` on a queued email (copy the setup in `tests/test_notification_switches.py:222`):
  - `test_recheck_not_watching_after_unwatch`: the email is queued after a sweep, then the person deletes their watch → `email_skipped` `not_watching`.
  - `test_recheck_not_watching_after_pause` (Review Focus): the route was Group A, and Group A is then paused → `not_watching`.
  - `test_recheck_no_access`: the person loses `initiatives:view` (a deny override) → `no_access`.
  - `test_recheck_keeps_a_still_watched_email` → it sends.
  - `test_recheck_order`: an archived person gets `recipient_inactive`, not `not_watching`.
  - Check delivery:
    - `truck_status_changed` for a person with an own truck watch, a group's site watch and an initiative watch narrowed to `initiative_status_changed` → two entries;
    - `report_ready` → `watches` is null.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** `watch_recheck`, the re-check hook and the Check delivery field.
- [ ] **Step 4: Run** the step-1 files plus `tests/test_notification_switches.py tests/test_mail_delivery.py tests/test_notification_summary.py tests/test_notification_log_api.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): send-time re-check and Check delivery know about watches`.

### Task 8: Portal: the API client, new categories, and the Watch button

**Files:**
- Modify: `portal/src/lib/api.ts`:
  - **Types:**
    - `NotificationCategory` gains `'initiatives' | 'trucks'`;
    - `NotificationKindSetting` and `NotificationKindInfo` gain `watchable: boolean; everywhere: boolean; reaches: string[]`;
    - `DeliveryCheck` gains `watches: CheckWatch[] | null`.
  - **Watch functions:** `listMyWatches(): Promise<Watch[]>`, `getWatchState(thing: WatchThing, id: string): Promise<WatchState>`, `createMyWatch(body: WatchIn): Promise<Watch>`, `updateMyWatch(id: string, kinds: string[]): Promise<Watch>`, `deleteMyWatch(id: string): Promise<void>`.
  - **Group watch functions:** `listGroupWatches(groupId)`, `createGroupWatch(groupId, body)`, `updateGroupWatch(groupId, watchId, kinds)`, `deleteGroupWatch(groupId, watchId)`.
  - **Watch types:**
    - `type WatchThing = 'initiative' | 'site' | 'truck'`
    - `type WatchTarget = WatchThing | 'everything'`
    - `interface Watch {id; thing: WatchTarget; thing_id: string | null; thing_name: string | null; link: string | null; kinds: string[]; via: {type: 'you' | 'group'; id?: string | null; name?: string | null}; created_at}`
    - `interface WatchState {watching: boolean; watch_id: string | null; kinds: string[]}`
    - `interface WatchIn {thing: WatchTarget; id: string | null; kinds: string[]}`
    - `CheckWatch` mirrors the API.
- Modify: `portal/src/lib/notificationKinds.ts`. `NOTIFICATION_CATEGORIES` gains Initiatives and Trucks, after Learning and before Account security.
- Modify: `portal/src/lib/notificationSwitches.ts`. `CONFIGURABLE` and `CATEGORY_DESCRIPTIONS` gain `initiatives: 'Initiative status changes'` and `trucks: 'Truck status changes'`.
- Create: `portal/src/lib/watches.ts`:
  - `THING_LABELS: Record<WatchTarget, string>` (Initiative, Site, Truck, Everything)
  - `kindsFor(thing: WatchTarget, kinds: NotificationKindSetting[]): NotificationKindSetting[]`: the same rule as the API's `kinds_for`
  - `eventsText(kinds: string[], all: NotificationKindSetting[]): string`: "All events" for `[]`, else the labels joined with ", "
  - `watchErrorMessage(err: unknown): string`: the call-12 copy
- Create: `portal/src/components/notifications/WatchButton.tsx`, with `.test.tsx`.
- Modify: `portal/src/styles/notifications.css` (`.watch-btn.on { color: var(--amber); border-color: var(--amber); }`).
- Modify: `portal/src/pages/InitiativeDetail.tsx`, `portal/src/pages/SiteDetail.tsx` and `portal/src/pages/TruckDetail.tsx`, plus those pages' tests.

**Interfaces:**
- **`WatchButton({ thing, id }: { thing: WatchThing; id: string })`** copies the wiki's `WatchButton` (`wiki/web/src/components/WatchButton.tsx`) for an own watch.
  - It renders nothing until `getWatchState` answers. A load failure reads as not watching.
  - The button is `<button type="button" className="btn-ghost watch-btn[ on]" aria-pressed={watching} disabled={busy} title={watching ? 'Stop watching' : 'Get notified about changes here'}>`. Inside are the wiki's eye svg (copied inline; the portal has no icon set) and `Watching` or `Watch`.
  - A click calls `deleteMyWatch(watch_id)` when watching, else `createMyWatch({thing, id, kinds: []})`.
  - On failure it calls `useToast()(watchErrorMessage(err))` and leaves the state unchanged.
- **Placement:** the Watch button renders for everyone who can open the page, so it sits outside the `canChange` / `canWrite` gates.
  - Initiative and site pages: `.idet-header-actions` always renders, with Watch first and the gated buttons after it.
  - Truck page: `.truck-hero-actions` always renders, with Watch first.

- [ ] **Step 1: Write the failing tests:**
  - **`WatchButton.test.tsx`** (mock `../../lib/api` with importActual and hoisted fns; mock `../../lib/notificationsContext`'s `useToast`):
    - it renders nothing before the state loads;
    - "Watch" with `aria-pressed="false"` → click → `createMyWatch` called with `{thing: 'initiative', id, kinds: []}`, then "Watching" with `aria-pressed="true"`;
    - "Watching" → click → `deleteMyWatch(watch_id)`;
    - a rejected create → the toast gets "Couldn't update your watch.", the button still reads "Watch", and it is enabled again;
    - `read_only_mode` → the toast gets the error's message.
  - **`lib/watches.test.ts`:**
    - `kindsFor('truck', …)` is only Truck status changed;
    - `kindsFor('everything', …)` is the `everywhere` kinds;
    - `eventsText([], …)` is "All events";
    - two labels are joined with ", ".
  - **`lib/api.watches.test.ts`** (the `mockFetch` pattern of `api.notificationSettings.test.ts`):
    - each function's method, path and body;
    - a 409 throws `ApiError` with code `already_watching`.
  - Update the static-list pins (`notificationKinds.test.ts`, `notificationSwitches` tests, SwitchGrid tests that count rows) for the two new categories.
  - **Page tests:**
    - `InitiativeDetail.test.tsx` and `TruckDetail.test.tsx` gain `getWatchState` in their hoisted api mocks.
    - With `can` false for change, the Watch button still shows and Edit does not.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/components/notifications src/lib src/pages/InitiativeDetail.test.tsx src/pages/TruckDetail.test.tsx src/styles`, then `npx tsc -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): Watch button on initiative, site and truck pages`.

### Task 9: Portal: "What you watch" on /me

**Files:**
- Create: `portal/src/components/notifications/WatchesTable.tsx`, `WatchEventsEditor.tsx` and `WatchEventsModal.tsx`, each with a `.test.tsx` where it carries behavior
- Create: `portal/src/pages/me/WatchesSection.tsx`, with `.test.tsx`
- Modify: `portal/src/pages/me/MeNotifications.tsx`, `portal/src/styles/notifications.css` (the `.watch-table` wrapper joins the themed-scrollbar list), `portal/src/pages/me/MeNotifications.test.tsx` and `portal/src/pages/Profile.test.tsx` (the hoisted api gains `listMyWatches`)

**Interfaces:**
- **`WatchesTable`:**
  - Props: `{ watches: Watch[]; kinds: NotificationKindSetting[]; showVia: boolean; actionsFor: (w: Watch) => RowAction[]; emptyText: string }`.
  - A `DataTable` inside `div.watch-table`, with columns Watching, Events, Via (when `showVia`) and Actions (`88px`, `RowActionsMenu`).
  - Watching:
    - for a thing, `<Link to={link}>{thing_name}</Link>` with `<span className="chip">{THING_LABELS[thing]}</span>`;
    - for Everything, "Everything".
  - Events: `eventsText`. Via: "You" or the group's name.
- **`WatchEventsEditor`:**
  - Props: `{ thing: WatchTarget; kinds: NotificationKindSetting[]; value: string[]; onChange: (v: string[]) => void }`, where `[]` means all.
  - Unless the thing is `everything`, it shows a `Switch` labeled "All events", with the hint "Every event that applies to this." It is on when `value` is `[]`, and turning it off starts from no picks.
  - When All is off, or for Everything, it shows `kindsFor(thing)` grouped under their category labels in `NOTIFICATION_CATEGORIES` order. Each kind has a `Switch` named by its label.
- **`WatchEventsModal`:**
  - Props: `{ eyebrow: string; title: string; description: string; thing: WatchTarget; kinds: NotificationKindSetting[]; initial: string[]; saveLabel?: string; onSave: (kinds: string[]) => Promise<void>; onClose: () => void }`.
  - A `NotificationModal` around the editor.
  - Footer: Save (`btn-solid`, label `saveLabel ?? 'Save'`), Cancel (`mini-btn`) and `pf-error`.
  - Save is disabled while nothing is picked: All is off with no kinds, or Everything has no kinds.
  - A rejected save shows `watchErrorMessage` in `pf-error`, and the modal stays open.
- **`WatchesSection`:**
  - Props: `{ kinds: NotificationKindSetting[] }`. On mount it calls `listMyWatches()`.
  - Layout: a full-width `section.set-section.me-watch-card` with a `.set-head.set-head-actions`.
    - h3: "What you watch" with `span.badge-count`.
    - p: "Things you watch and the ones your groups watch. What reaches you still follows your switches and schedule."
    - a `mini-btn`: "Watch events everywhere…", or "Edit events everywhere…" once an own Everything watch exists.
  - Then `WatchesTable` with Via shown and the empty text "You aren't watching anything yet. Use Watch on a page to start."
  - **Own rows:** "Choose events…" and "Stop watching" (destructive).
    - "Choose events…" opens `WatchEventsModal` (eyebrow "Watch", title the thing's name or "Everything", description "Pick the events you want to hear about.") and saves with `updateMyWatch`.
    - "Stop watching" calls `deleteMyWatch` and reloads.
  - **Group rows:** no actions.
  - **The everywhere button** opens the same modal for `everything`. It saves with `createMyWatch({thing: 'everything', id: null, kinds})`, or `updateMyWatch` when the watch already exists.
- **MeNotifications:** it renders `<WatchesSection kinds={settings?.kinds ?? []} />` after the `div.set-stack` and before "My groups".

- [ ] **Step 1: Write the failing tests:**
  - **`WatchesSection.test.tsx`:**
    - the head's text, the badge count, and the hint copy exactly;
    - the empty state's copy;
    - an own initiative row: name link to `/initiatives/{id}`, chip "Initiative", "All events", "You";
    - a group row: "Site A", the narrowed events' labels, "Group A", and no Actions button;
    - "Stop watching" → `deleteMyWatch`, then the list reloads;
    - "Choose events…" → modal → turn All off → pick "Truck status changed" → Save → `updateMyWatch(id, ['truck_status_changed'])`;
    - the everywhere button reads "Watch events everywhere…", and Save stays disabled until a kind is picked;
    - Save → `createMyWatch({thing: 'everything', id: null, kinds: […]})`;
    - with an existing own Everything watch, the button reads "Edit events everywhere…".
  - **`WatchEventsModal.test.tsx`:**
    - eyebrow "Watch", the h3, and `p.page-hint` "Pick the events you want to hear about.";
    - the "All events" switch is absent for Everything;
    - kinds are grouped under their category labels;
    - a rejected save shows "You're already watching this." for `already_watching`.
  - **`MeNotifications.test.tsx`:** the section renders between the schedule card and "My groups".
  - **`Profile.test.tsx`:** it still renders (with `listMyWatches` mocked).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/pages/me src/pages/Profile.test.tsx src/components/notifications src/lib src/styles`, then `npx tsc -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): What you watch on /me`.

### Task 10: Portal: "What this group watches"

**Files:**
- Create: `portal/src/components/notifications/GroupWatchesPanel.tsx` and `AddGroupWatchModal.tsx`, each with `.test.tsx`
- Modify: `portal/src/pages/NotificationGroupDetail.tsx` and its test (the hoisted api gains `listGroupWatches` and `getNotificationSettings`)

**Interfaces:**
- **`GroupWatchesPanel`:**
  - Props: `{ group: NotificationGroupDetail; canChange: boolean }`.
  - On mount it calls `listGroupWatches(group.id)` and `getNotificationSettings()` (for `kinds`).
  - Layout: `div.init-panel` (margin-top 18, as in `MembersPanel`), `p.eyebrow-sm` "What this group watches — {n}", then, when `canChange`, a `mini-btn` "Add watch".
  - Then `WatchesTable`, with Via hidden and the empty text "This group isn't watching anything yet."
  - **Row actions** (when `canChange`):
    - "Choose events…" opens `WatchEventsModal` (eyebrow the group's name, title the thing's name or "Everything", description "Pick the events this group hears about.") and saves with `updateGroupWatch`.
    - "Remove" (destructive) calls `deleteGroupWatch`.
- **`AddGroupWatchModal`:**
  - Props: `{ group: NotificationGroupDetail; kinds: NotificationKindSetting[]; onAdded: () => void; onClose: () => void }`.
  - A `NotificationModal` with eyebrow the group's name, title "Add watch", and description "Pick what this group's members hear about."
  - **Body:**
    - `ChoiceField` labeled "Watch": Initiative, Site, Truck, Everything;
    - unless Everything, a field labeled with the thing ("Initiative" / "Site" / "Truck"), holding a `ComboBox` with placeholder "Search initiatives…" / "Search sites…" / "Search trucks…";
      - its options are `listInitiatives()`, `listSites()` or `listTrucks()`, loaded on open;
      - the label is the name;
      - this is the admin's own view, so the options are only what they can see;
    - then `WatchEventsEditor`.
  - **Save** ("Add watch"):
    - It is disabled until a thing is picked (when one is needed) and the events are valid.
    - It calls `createGroupWatch(group.id, {thing, id, kinds})`.
    - A rejected save shows `watchErrorMessage` in `pf-error`.
  - **Switching kinds** clears the picked thing and resets the events to All. For Everything, it resets to no picks.
- **NotificationGroupDetail:** it renders `<GroupWatchesPanel group={group} canChange={canChange} />` under `MembersPanel`.

- [ ] **Step 1: Write the failing tests:**
  - **`GroupWatchesPanel.test.tsx`:**
    - the eyebrow with its count;
    - the empty-state copy;
    - a row's Watching and Events cells;
    - with `canChange` false: no "Add watch" and no Actions button;
    - "Remove" → `deleteGroupWatch(groupId, watchId)`;
    - "Choose events…" → the modal's description is "Pick the events this group hears about."
  - **`AddGroupWatchModal.test.tsx`:**
    - the header copy;
    - the segments are Initiative, Site, Truck and Everything, each with `aria-pressed`;
    - picking Site shows the field "Site" and the placeholder "Search sites…";
    - the options come from `listSites`;
    - Save stays disabled until a site is picked;
    - Save → `createGroupWatch(groupId, {thing: 'site', id, kinds: []})`;
    - picking Everything hides the ComboBox, and Save stays disabled until a kind is picked;
    - `already_watching` → "You're already watching this." in `pf-error`.
  - **`NotificationGroupDetail.test.tsx`:** the panel renders under Members.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/components/notifications src/pages/NotificationGroupDetail.test.tsx src/styles`, then `npx tsc -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): groups watch things from the group page`.

### Task 11: Portal: Delivery log and Check delivery

**Files:**
- Modify: `portal/src/lib/deliveryLog.ts`, `portal/src/lib/deliveryLog.test.ts`
- Modify: `portal/src/components/notifications/CheckDeliveryModal.tsx`, with its test

**Interfaces:**
- **`REASON_LABELS`** gains `no_access: 'No access'` and `not_watching: 'Not watching any more'`.
- **`describeEntry`** for `inbox_written` (and `inbox_suppressed`) with `detail.via` lists the routes, joined with ", ":
  - `watch` → "Watching · their own"
  - `group:<id>` → "Watching · {detail.names[route]}"
  - `rule:<id>` → "Rule · {detail.names[route]}"
  - `direct` → "Named"
  - Without `detail.via`, `inbox_written` still describes as `''`, so the existing pin stands.
- **`CheckDeliveryModal`:** when `check.watches` is non-null, the summary `dl.kv` gains a row "Watching".
  - Value: one line per watch, `"{thing_name or 'Everything'} · {events} · {via}"`, where via is "Their own" or the group's name. With no watches, the value is "Nothing that hears this type".
  - Then a fixed note: "Whether it reaches them for a particular thing also depends on their access to it."

- [ ] **Step 1: Write the failing tests:**
  - `deliveryLog.test.ts`:
    - the reason-label pin gains the two codes;
    - `describeEntry` gives "Watching · their own, Watching · Group A" for `via ["watch", "group:g1"]` with `names {"group:g1": "Group A"}`;
    - an `inbox_written` row without via still gives `''`.
  - `CheckDeliveryModal.test.tsx`:
    - a watchable kind with two watches shows the "Watching" row, both lines and the note;
    - an empty list shows "Nothing that hears this type";
    - `watches: null` shows no Watching row.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib src/components/notifications src/styles`, then `npx tsc -p .` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): Delivery log and Check delivery show watch routes`.
