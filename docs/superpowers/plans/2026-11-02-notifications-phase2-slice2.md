# Notifications Phase 2, Slice 2 (Devices) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an RFID Station kiosk, a fixed reader or an approved router stops checking in, the people watching it (or its site, its move, or "Device offline" everywhere) hear once per outage. People can watch those devices from their pages and lists.

**Architecture:**

- **Online rules in one place:** `services/device_online.py` holds the three offline thresholds, the rule for which devices are covered, and each device's link. The portal mirrors the thresholds, with pin tests on both sides.
- **The device check:** `notifications/device_check.run_device_check_once` runs every 60 s in notification-worker, just before the event sweep.
  - It announces `device_offline` for a covered device that has gone offline, and sets `devices.offline_notified_at`.
  - It clears that column once the device is seen again.
  - It stays quiet during read-only maintenance.
- **Watching devices:** `notifications/access.py` and `notifications/watches.py` learn the `device` thing.
- **Send-time re-check:** it drops a Device offline email once every device in it is back (`back_online`).
- **Portal:** a Watch button on an RFID Station's page, and Watch / Stop watching in the fixed reader and router row menus. The readers list can be opened on a row. Groups can watch devices, and the Devices category joins the grid.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, PostgreSQL 16, pytest (real Postgres); React 18 + TypeScript, Vite, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-02-notifications-phase2-design.md` (Build order, slice 2; sections 1, 2, 5 "Device offline", 8 and 9). Slice 1 (watches and events) is built: plan `docs/superpowers/plans/2026-11-02-notifications-phase2-slice1.md`.

## Global Constraints

- **American English** everywhere (copy, comments, commit messages). Before committing, grep the changed files for `-ise|-isation|colour|enrol\b|enrolment|behaviour|centre|licence`.
- **Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/notif-phase2`, branch `notif-phase2`. Work only there and never `cd` into the main checkout.
- **API tests:** `cd api && SS_TEST_DB=serversherpa_test_notif2 PYTHONPATH=src .venv/bin/pytest <files> -q -p no:cacheprovider`. `PYTHONPATH=src` is required. Do not run the whole API suite; run the files each task names.
- **Portal checks:** `cd portal && npx vitest run <files>`, `npx tsc -p .`, `npx vitest run src/styles` (guardrails), and `npm run build` (it type-checks test files too).
- **Run every test command in the FOREGROUND,** in one continuous run with a 600000 ms timeout. Never background a suite and end your turn waiting.
- **Git hygiene:**
  - Plain single git commands only, as `git -C <worktree> …`.
  - Never use bare `git stash`, and never commit `api/src/serversherpa/_dev_reload.py`.
  - Commit trailer, exactly: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Session discipline:** `notify()`, `record()` and `announce()` add to the caller's session and never commit. Routes and sweeps commit.
- **Log privacy:** no email address or message body in a `notification_log` row's `detail` or in a log line.
- **Two copies of every worker:** every sweep claims its rows with `FOR UPDATE SKIP LOCKED`.
- **No new policy numbers:** the thresholds are the screens' own (kiosk 3 minutes, router 4 minutes, reader 3 minutes). The check runs on the worker's 60 s tick. The quiet window after maintenance is the longest threshold (4 minutes).
- **Migration:** `"0114"` with down_revision `"0113"`. This slice adds no other migration.
- **Covered devices** (the only ones that are checked and can be watched):
  - RFID Station kiosks: `device_type == "kiosk"`, `sub_type == "laptop"` and `station_type == "rfid"`;
  - every fixed reader;
  - routers with `approval_state == "approved"`.
  - A device whose `last_seen_at` is null has never checked in and is skipped.
- **Offline** means what the screens say:
  - more than 3 minutes since `last_seen_at` for an RFID Station or a reader, and more than 4 minutes for a router (online while the age is at most the threshold);
  - a reader whose `raw_info["reachable"]` is `False` is offline at once.
- **Copy:** exactly as quoted in the spec, in this plan or in "Calls this plan makes". New tests use neutral names ("Device A", "Initiative A", "Group A").
- **Portal controls:** reuse `Switch`, `ChoiceField`, `ComboBox`, `chip tag`, `DataTable`, `RowActionsMenu`, `NotificationModal`, and `WatchButton` from slice 1. No raw `<select>`, time input or bare checkbox in touched UI.

## Calls this plan makes (beyond the spec)

1. **Covered RFID Station kiosks follow the portal's own `isRfidStation` rule** (laptop + rfid), whether or not the station holds a station key. A deliberate Clear Setup therefore reads as one offline notice for that outage.
2. **Quiet during maintenance.** While read-only mode is on, kiosk heartbeats are refused (423), so every station would look offline. The check announces nothing while read-only mode is on, or within the longest threshold (4 minutes) after it last saw read-only mode.
   - The window is kept in the worker process.
   - When the worker loop is paused, it pushes the window forward too.
   - A device that is still offline once the window passes is announced then.
3. **The line's kind label** is "RFID Station" for a kiosk, and the device-type vocabulary label for the others ("Fixed Reader", "Router").
4. **Links:**
   - an RFID Station → `/hardware/kiosks/{id}`;
   - a reader → `/hardware/fixed-readers?focus={id}`;
   - a router → `/hardware/routers?focus={id}`.
   - A grouped notification links to the items' shared initiative. Otherwise it links to their shared device list (`EventItem.list_link`). Items from different lists get no link (`LIST_PAGES["device_offline"] = None`).
5. **The readers list gains `?focus=<id>`,** like the routers list. The notification opens it on that row.
6. **The fixed reader row's bare Delete button moves into a `RowActionsMenu`,** with Watch / Stop watching, as the routers list already does.
7. **Watching a device that isn't covered** (any other kiosk, a pending or revoked router) answers 422 `invalid_thing`.
8. **An always-failing event no longer blocks the queue.** `notification_events.attempts` counts failures, and the sweep claims by `(attempts, id)`, so a stuck event drops behind newer ones. This adds no retry limit. It came from the slice 1 whole-branch review.
9. **Back online** means the device's `offline_notified_at` is null again. That is set by the check when the device is seen again. A deleted device counts as back.
10. **Row-menu failure copy** matches the Watch button: "Couldn't update your watch.", or the read-only message.

## Review Focus

- **Maintenance.** With read-only mode on for ten minutes while stations can't beat, no Device offline notice goes out during maintenance or for 4 minutes after. A station that is really dead afterwards is announced once the window passes (Task 2: `test_quiet_during_and_after_read_only`).
- **Once per outage, on two workers.** Two concurrent checks announce each outage once. A device that comes back and later drops again gets a second notice (Task 2: `test_once_per_outage`, `test_concurrent_checks_announce_once`).
- **A station and its reader die together.** The watchers of their move get one "Device offline (2)" linked to the initiative (Task 2: `test_station_and_reader_group_into_one`).
- **Deploying with old outages.** The migration marks covered devices that are already offline, so the first check after the deploy announces nothing (Task 1: `test_rollout_marks_devices_already_offline`).
- **Back before the email.** A held Device offline email whose devices have all come back is dropped with `back_online`, and the inbox row stays (Task 3: `test_held_email_dropped_when_back_online`).

---

### Task 1: Device online rules and the schema (API)

**Files:**
- Create: `api/src/serversherpa/services/device_online.py`
- Modify: `api/src/serversherpa/api/routes/devices.py`. `READER_STALE_AFTER` moves out, and `reader_status_for` uses the shared offline rule while keeping its results.
- Modify: `api/src/serversherpa/api/routes/kiosk.py`. `is_rfid_station` moves to `device_online.py`, and kiosk.py imports it.
- Create: `api/migrations/versions/0114_device_offline_notices.py`
- Modify: `api/src/serversherpa/db/models.py` (`Device.offline_notified_at`, `NotificationEvent.attempts`)
- Test: `api/tests/test_device_online.py` (new), `api/tests/test_migration_0114_device_offline.py` (new). Keep `tests/test_devices_api.py`, `tests/test_kiosk_station_heartbeat.py` and `tests/test_kiosk_heartbeat_reader.py` green.

**Interfaces:**
- In `device_online.py`:
  - `KIOSK_ONLINE = timedelta(minutes=3)`, `ROUTER_ONLINE = timedelta(minutes=4)`, `READER_STALE_AFTER = timedelta(minutes=3)`, `LONGEST_THRESHOLD = ROUTER_ONLINE`.
  - `def is_rfid_station(device: Device) -> bool` (moved verbatim).
  - `def covered(device: Device) -> bool`, and `def covered_clause() -> ColumnElement[bool]`, the same rule in SQL.
  - `def is_offline(device: Device, now: datetime) -> bool | None`. It returns None when `last_seen_at` is null, and applies the thresholds from the Global Constraints. A naive timestamp reads as UTC, and a reader with `raw_info.get("reachable") is False` is offline at once.
  - `def device_link(device: Device) -> str` and `def device_list_link(device: Device) -> str`, per call 4.
  - `def kind_label(device: Device, vocab: Mapping[str, str]) -> str`, per call 3. `vocab` is the `device_type` labels.
- `Device.offline_notified_at: Mapped[datetime | None]` (timestamptz). `NotificationEvent.attempts: Mapped[int]` (NOT NULL, server default 0).
- Migration 0114:
  - It adds both columns, then marks every covered device that is offline now: `offline_notified_at = now()`, with the thresholds written as SQL intervals and the reader's `raw_info->>'reachable' = 'false'`.
  - The downgrade drops both columns.

- [ ] **Step 1: Write the failing tests:**
  - **`test_device_online.py`:**
    - `test_covered`: a laptop RFID Station, any fixed reader and an approved router are covered. Not covered: an android kiosk, a laptop Label Station, a laptop Time Clock, a pending router, a revoked router, and a router with no approval state.
    - `test_thresholds`:
      - RFID Station: offline at 3 min 1 s, not at exactly 3 min.
      - Router: offline at 4 min 1 s, not at 4 min.
      - Reader: offline at 3 min 1 s; offline at once with `reachable: False`.
      - Never seen → None. A naive `last_seen_at` reads as UTC.
    - `test_thresholds_are_the_screens`: pins the three constants (3, 4 and 3 minutes), mirrored by the portal pins in Task 4.
    - `test_links_and_labels`: per call 4, and "RFID Station" / "Fixed Reader" / "Router" from the vocabulary.
  - **`test_migration_0114_device_offline.py`** (throwaway DB `<SS_TEST_DB>_m0114`, the 0113 test's pattern):
    - `test_rollout_marks_devices_already_offline`:
      - Marked: a station seen 10 minutes ago, a reader marked unreachable, and an approved router seen 5 minutes ago.
      - Not marked: a station seen 1 minute ago, a never-seen reader, a pending router seen 10 minutes ago, and an android kiosk seen 10 minutes ago.
    - `attempts` defaults to 0. The downgrade removes both columns.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step-1 files plus `tests/test_devices_api.py tests/test_kiosk_station_heartbeat.py tests/test_kiosk_heartbeat_reader.py tests/test_migration_0113_watches_events.py`. Then run `cd api && PYTHONPATH=src .venv/bin/alembic heads` → `0114 (head)`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(devices): shared offline rules; devices remember an offline notice`.

### Task 2: The device check and the Device offline type (API, worker)

**Files:**
- Create: `api/src/serversherpa/notifications/device_check.py`
- Modify: `api/src/serversherpa/notifications/kinds.py`, `company.py`, `system/config_store.py` (defaults)
- Modify: `api/src/serversherpa/notifications/events.py` (`EventItem.list_link`)
- Modify: `api/src/serversherpa/notifications/event_sweep.py` (compose link, `LIST_PAGES`, the claim order and the `attempts` count)
- Modify: `api/src/serversherpa/notifications/worker.py`, `api/src/serversherpa/cli.py` (`--once`)
- Test: `api/tests/test_device_check.py` (new). Update `test_notification_kinds.py`, `test_notification_settings_api.py`, `test_notification_log_api.py` (kind rows), `test_notification_worker.py` (loop and `--once` order) and `test_notification_event_sweep.py`.

**Interfaces:**
- **Kinds:**
  - `CATEGORIES` gains `"devices": "Devices"` after trucks.
  - `KINDS` gains `"device_offline": KindInfo("devices", "Device offline", reaches=("device", "site", "initiative"), everywhere=True)` after `truck_status_changed`.
  - `CONFIGURABLE_CATEGORIES` gains `"devices"`, with default on/on.
- **`EventItem`** gains `list_link: str | None = None`, written to `item` JSON as `"list_link"`.
- **`event_sweep`:**
  - `LIST_PAGES["device_offline"] = None`.
  - For several items: the shared initiative when they all have the same non-null one; else their shared non-null `list_link`; else `LIST_PAGES.get(kind)`.
  - The claim orders by `(NotificationEvent.attempts, NotificationEvent.id)`.
  - An event whose resolution raises gets `attempts += 1` in the sweep's transaction, after its savepoint rolls back.
- **`device_check.py`:**
  - Signature: `async def run_device_check_once(maker: async_sessionmaker, *, now: datetime | None = None, state: dict | None = None) -> int`. It returns the number announced, and rejects a naive `now`.
  - In one session:
    1. Read the admin config. If read-only is on, set `state["quiet_until"] = now + LONGEST_THRESHOLD`.
    2. Clear: every device with `offline_notified_at` set that is no longer offline (or no longer covered) gets null.
    3. Unless `now < state.get("quiet_until")`:
       - Claim covered devices with `offline_notified_at IS NULL AND last_seen_at IS NOT NULL` using `FOR UPDATE SKIP LOCKED`.
       - For each one `is_offline`, announce and set `offline_notified_at = now`.
    4. Commit once.
  - **The announcement:**
    - `announce(db, "device_offline", subject=Thing("device", id), item=EventItem(...), reaches=[…])`;
    - title `"{name} is offline"`;
    - line `"{kind label} · last seen {event_time(last_seen_at)}"`;
    - link `device_link`, `initiative_id = current_initiative_id`, `list_link = device_list_link`;
    - reaches: the site, then the current initiative and its ancestors;
    - no actor.
- **Worker:**
  - `DEVICE_CHECK_INTERVAL_SECONDS = 60` and `devices_state = {"failed": False}`.
  - A `run_device_check(maker, state)` wrapper logs once per outage.
  - The loop runs it just before the event sweep.
  - When the loop finds the workers paused, it sets `devices_state["quiet_until"]` the same way.
  - `--once` runs status, devices, events, summaries, deliver.

- [ ] **Step 1: Write the failing tests** in `test_device_check.py`. Pass `now=` explicitly, and build devices as `tests/test_devices_api.py` does.
  - `test_an_offline_station_is_announced`: title, line, link, reaches, `offline_notified_at` set, and no actor.
  - `test_once_per_outage` (Review Focus):
    - a second run → no new event;
    - seen again → cleared;
    - offline again → a second event.
  - `test_boundaries_and_kinds`:
    - exactly 3 min → nothing;
    - a router at 4 min → nothing, at 4 min 1 s → an event with "Router" and the `?focus=` link;
    - an unreachable reader → an event at once;
    - a never-seen reader → nothing;
    - uncovered devices → nothing.
  - `test_quiet_during_and_after_read_only` (Review Focus):
    - read-only on → nothing;
    - turned off → nothing until 4 minutes after the last run that saw it;
    - then the still-offline station is announced.
  - `test_concurrent_checks_announce_once` (Review Focus): two runs under `asyncio.gather`.
  - `test_station_and_reader_group_into_one` (Review Focus): a station and its reader share an initiative watched by Person A. After the check and `run_events_once`, Person A has one "Device offline (2)" linked to `/initiatives/{id}`.
  - `test_mixed_devices_link`:
    - two readers with no shared initiative link to `/hardware/fixed-readers`;
    - a reader and a router link to nothing.
  - In `test_notification_event_sweep.py`: `test_a_stuck_event_drops_behind`. With `EVENT_BATCH` patched to 1, a failing event gets `attempts` 1, and on the next sweep a newer event goes out first.
  - Update the kind, category, default and worker-order pins.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step-1 files plus `tests/test_notification_kinds.py tests/test_notification_settings_api.py tests/test_notification_log_api.py tests/test_notification_worker.py tests/test_notification_event_sweep.py tests/test_watch_recheck.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): announce devices that stop checking in`.

### Task 3: Watching devices, and back online (API)

**Files:**
- Modify:
  - `api/src/serversherpa/notifications/access.py` (`_PAGES["device"]`);
  - `api/src/serversherpa/notifications/watches.py` (the `device` thing; links per row; covered only);
  - `api/src/serversherpa/notifications/email.py` (`back_online`).
- Test:
  - `api/tests/test_device_watches.py` (new);
  - `api/tests/test_notification_access.py`, `api/tests/test_watch_recheck.py` (add cases).

**Interfaces:**
- `access._PAGES["device"] = _Page(Device, "scanning_hardware")`. `VIEWABLE_THINGS` gains `"device"`. This is the device lists' and kiosk page's rule: `scanning_hardware` view, global only.
- `watches.THINGS["device"]` has column `device_id`, model `Device`, label "Device", and link `device_online.device_link(row)`.
  - `ThingSpec.link` now takes the loaded row. The three existing things pass theirs.
  - `add_watch` answers 422 `invalid_thing` for a device that exists and is visible but isn't `covered` (call 7).
  - `kinds_for("device") == ["device_offline"]`.
- In `recheck_notification`, right after the `resolved` check: for a `device_offline` notification whose payload subjects are all devices with `offline_notified_at IS NULL` (or deleted), return `"back_online"` (call 9).

- [ ] **Step 1: Write the failing tests:**
  - **`test_device_watches.py`:**
    - **`test_watch_covered_devices`:**
      - An RFID Station, a reader and an approved router → 201. Each has the right link and thing name.
      - An android kiosk, a Label Station and a pending router → 422 `invalid_thing`.
      - Staff (`scanning_hardware` view) can watch; a client-anchored user gets 404 `thing_not_found`.
    - **`test_group_watches_a_device`:** POST through the group route, then the audit row.
    - **`test_device_watch_hears_its_offline_notice`:** after the check and the sweep, a device watcher gets it. A watcher of the device's site gets it too.
  - **`test_notification_access.py`:** `test_device_viewers_match_the_page`. `viewers` equals who gets 200 from `GET /devices/{id}`.
  - **`test_watch_recheck.py`:**
    - `test_held_email_dropped_when_back_online` (Review Focus): `email_skipped` `back_online`, and the inbox row is untouched.
    - `test_one_device_still_offline_keeps_the_email`.
    - `test_back_online_runs_before_category_turned_down`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step-1 files plus `tests/test_watches_api.py tests/test_group_watches_api.py tests/test_watch_matching.py tests/test_mail_delivery.py tests/test_notification_summary.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): watch devices; drop a Device offline email once they're back`.

### Task 4: Portal: device watching on the hardware pages

**Files:**
- Modify: `portal/src/lib/api.ts` (`WatchThing` gains `'device'`) and `portal/src/lib/watches.ts` (`THING_LABELS.device = 'Device'`)
- Modify: `portal/src/lib/notificationKinds.ts` and `portal/src/lib/notificationSwitches.ts` (Devices, with the description "Devices going offline")
- Modify: `portal/src/lib/deliveryLog.ts` (`REASON_LABELS.back_online = 'Device back online'`)
- Modify: `portal/src/lib/kioskConfig.ts` and `portal/src/lib/devices.ts`. The threshold comments name the API constants; add pins in `kioskConfig.test.ts` (`KIOSK_ONLINE_MS === 3 * 60 * 1000`) and `devices.test.ts` (`ROUTER_ONLINE_MS === 4 * 60 * 1000`).
- Create: `portal/src/components/hardware/useDeviceWatches.ts`, with tests
- Modify: `portal/src/pages/hardware/KioskDetail.tsx`, `portal/src/pages/Routers.tsx`, `portal/src/pages/FixedReaders.tsx`, and their tests

**Interfaces:**
- **`useDeviceWatches(): { watching: (deviceId: string) => boolean; toggle: (deviceId: string) => Promise<void>; busy: (deviceId: string) => boolean }`:**
  - It loads `listMyWatches()` once and keeps the person's own device watches.
  - `toggle` calls `createMyWatch({thing: 'device', id, kinds: []})` or `deleteMyWatch(watchId)`, then re-reads.
  - A failure toasts "Couldn't update your watch.", or the read-only message (call 10).
  - A 409 `already_watching` or 404 `watch_not_found` re-reads instead.
- **KioskDetail:** an `.idet-header-actions` with `<WatchButton thing="device" id={detail.id} />`, only when `isRfidStation(detail)`.
- **Routers:** an approved router's `actionsFor` starts with "Watch" or "Stop watching" (by `watching(d.id)`). The other actions are unchanged.
- **FixedReaders:**
  - Each row gets a `RowActionsMenu` holding "Watch" / "Stop watching", then "Delete" (destructive, `canDelete`, the same delete flow as today), in place of the bare button.
  - The trailing track becomes the routers list's actions width.
  - `?focus=<id>` opens and scrolls to that row like Routers (`useSearchParams`, `data-device-id`, once per load).

- [ ] **Step 1: Write the failing tests:**
  - **`useDeviceWatches.test.ts`:**
    - `toggle` creates and deletes;
    - a failure toasts "Couldn't update your watch.";
    - 409 / 404 re-read.
  - **`KioskDetail.test.tsx`:** the Watch button shows for an RFID Station, and not for an android kiosk or a Label Station.
  - **`Routers.test.tsx`:**
    - an approved router's menu has "Watch", and "Stop watching" once watched;
    - a pending router's menu has no watch action.
  - **`FixedReaders.test.tsx`** (wrap in `MemoryRouter`):
    - the menu holds "Watch" and "Delete";
    - "Delete" still deletes;
    - `?focus=<id>` marks that row.
  - Update the category and description pins, and add the threshold pins and the `back_online` label to the reason pin.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/components/hardware src/pages/hardware src/pages/Routers.test.tsx src/pages/FixedReaders.test.tsx src/lib src/components/notifications src/styles`, then `npx tsc -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): watch RFID Stations, fixed readers and routers`.

### Task 5: Portal: groups watch devices

**Files:**
- Modify: `portal/src/components/notifications/AddGroupWatchModal.tsx`, with its test

**Interfaces:**
- **Segments:** the "Watch" `ChoiceField` options become Initiative, Site, Truck, Device, Everything.
- **Device field:** for Device, a field labeled "Device" with the placeholder "Search devices…". Its options come from `listDevices()`, filtered to covered devices:
  - laptop kiosks whose `station_type` is `'rfid'`;
  - fixed readers;
  - routers whose `approval_state` is `'approved'`.
  - Each option's label is the device name; its `sub` is the kind label ("RFID Station", "Fixed Reader", "Router").
- **Load failure:** "Could not load the device list."
- **Events:** the editor offers "Device offline".

- [ ] **Step 1: Write the failing tests:**
  - Segments in that order.
  - Device shows the field and the placeholder.
  - Only covered devices are offered.
  - Save → `createGroupWatch(groupId, {thing: 'device', id, kinds: []})`.
  - A failed load shows "Could not load the device list."
- [ ] **Step 2: Run it to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/components/notifications src/pages/NotificationGroupDetail.test.tsx src/pages/me src/styles`, then `npx tsc -p .` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): groups watch devices`.
