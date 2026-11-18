# Android Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins (rank 60+) get push notifications on their own Android phone through Firebase, with a Push column in the notification grid, a "This is my phone" switch, an in-app Notifications page, and a server-tracked 5-minute snooze.

**Architecture:** `notify()` gains a push decision (`decide_push`) that queues a `push_outbox` row. The notification worker drains the queue, re-checks every rule at send time, and calls FCM HTTP v1 with a service-account token. Phones register through new `/kiosk/` routes. A per-registration push key covers what must work without a sign-in: token refresh, and the alert's Snooze and Mark read buttons. The Android app adds a `FirebaseMessagingService`, a "This is my phone" switch on the This Kiosk tab, and a Notifications page reached from Home and from a tapped alert.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, Postgres, httpx, pyjwt + cryptography (API). React + TypeScript (portal). Kotlin, Compose, OkHttp, Firebase Cloud Messaging (Android).

**Spec:** `docs/superpowers/specs/2026-11-17-android-push-notifications-design.md`. Executors read it: decisions 1-15 are Jimmy's, and every "Claude's call" in it is also binding here.

## Global Constraints

- Admin means max rank `>= GATE_BYPASS_RANK` (60, `access/defaults.py`). Android uses `AuthState.Authed.isAdmin`.
- Snooze is always 5 minutes (`SNOOZE = timedelta(minutes=5)`). There is no setting.
- The company Push default starts **off** in every category. A stored pair with no `push` key reads as push off, not as malformed.
- Push needs Inbox: effective push = own-or-default push AND effective inbox.
- Account security (`category == "security"`) never pushes.
- No push during quiet hours or days off unless `is_critical(kind, company)`.
- Zebra (`sub_type == "zebra"`) never gets push and can't be claimed from the app.
- Kiosk sessions reach only `/kiosk/*` (`enforce_session_scope`). Every new app route lives under `/kiosk/`.
- The push key and FCM tokens are never logged. The delivery log carries ids and codes only.
- Config: `SS_FCM_SERVICE_ACCOUNT_FILE` (Settings field `fcm_service_account_file: str = ""`). Empty means push is not set up.
- Copy is American English. Times are 24-hour `HH:MM`. Every screen follows light/dark. No action button sits behind a scroll.
- Android: minSdk 30, the SDK-36 dependency pins in `gradle/libs.versions.toml`, and `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`. Run the full Robolectric suite in the background (it takes over 600 s).
- Never `adb shell monkey`. Launch with `adb shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.serversherpa.kiosk/.MainActivity`.
- The migration number is the next free one at execution time (0131 as of 2026-11-17). Check `api/migrations/versions` first, since other branches add migrations.
- API tests: `cd api && .venv/bin/pytest tests/<file> -q`. Portal: `cd portal && npx vitest run <file>`. Android: `./gradlew :app:testDebugUnitTest --tests '<class>'`.

## Review Focus

1. **A notification read or hidden on the portal while a snooze is queued** must not re-alert, and the phone's alert must go away. Tests: Task 6 `test_read_cancels_snooze_and_queues_clear` and `test_raw_resolve_paths_queue_clear`.
2. **A phone reassigned or un-marked between queue and send** must not get the old owner's push. Test: Task 5 `test_owner_changed_after_queue_drops`.
3. **FCM rotating the token while nobody is signed in** must still reach the server. Tests: Task 7 `test_token_refresh_with_push_key`; Task 11 `onNewToken_with_stored_key_sends_token`.
4. **Push not configured** (`SS_FCM_SERVICE_ACCOUNT_FILE` empty) must leave `notify()` and the inbox untouched. The decision says `push_not_set_up`, nothing is queued, and the worker step is a no-op. Tests: Task 3 `test_not_set_up_queues_nothing`; Task 5 `test_worker_idle_when_not_set_up`.
5. **A critical kind during quiet hours** pushes, and a non-critical one is logged `quiet_hours` and never queued. Test: Task 3 `test_quiet_hours_only_critical`.

---

## File map

API (`api/src/serversherpa/`):
- `db/models.py`: `PushRegistration`, `PushOutbox`, and `Notification.push_snoozed_until`.
- `api/migrations/versions/0131_push_notifications.py`.
- `notifications/company.py`, `notifications/email.py` (switches), and `api/schemas.py` (`SwitchOverride`, `SwitchPair`, check and log schemas).
- `notifications/push.py` (new): `decide_push`, `queue_push`, `cancel_push`, `queue_clear`, `snooze`, and the push-hook helpers.
- `notifications/inbox.py`, `delivery_log.py`, `check.py`, `reset_requests.py`, `requests.py`, `address_blocks.py`, and `services/router_agent.py`.
- `push/fcm.py` (new): access token and send. `push/delivery.py` (new): the queue drain.
- `notifications/worker.py`: the `run_push` step.
- `services/push_registrations.py` (new): register, delete, verify key, owner checks.
- `api/routes/kiosk_push.py` (new): `/kiosk/personal`, `/kiosk/push/*` and `/kiosk/notifications*`.
- `api/routes/devices.py`, `services/biometric.py`, and the `revoke_keys` callers (personal writers drop the registration). `api/routes/notifications.py` (read and hide hooks).
- `config.py`: `fcm_service_account_file`.

Portal (`portal/src/`): `components/notifications/SwitchGrid.tsx` (and its lib helpers), `NotificationDefaultsTab.tsx`, `pages/me/MeNotifications.tsx`, `CheckDeliveryModal.tsx`, `DeliveryLogTab.tsx`, `lib/deliveryLog.ts`, `lib/api.ts`, and the kiosk device page.

Android (`Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/`):
- `data/push/`: `PushRegistrar.kt`, `PushKeyStore.kt`, `KioskMessagingService.kt`, `PushNotifier.kt`, `PushActionReceiver.kt`.
- `data/api/KioskApi.kt` and `OkHttpKioskApi.kt` (new calls).
- `ui/screens/settings/ThisKioskPanel.kt` (the switch).
- `ui/screens/notifications/`: `NotificationsScreen.kt`, `NotificationsViewModel.kt`.
- `core/features/Features.kt`, `ui/Routes.kt`, `ui/shell/KioskShell.kt`, `ui/guards/KioskGuard.kt` (pending route).
- `AndroidManifest.xml`, `app/build.gradle.kts`, `gradle/libs.versions.toml`, root `build.gradle.kts`.

---

### Task 1: Tables and the snooze column

**Files:**
- Create: `api/migrations/versions/0131_push_notifications.py`
- Modify: `api/src/serversherpa/db/models.py` (after `NotificationHeld`; `Notification` gains a column)
- Test: `api/tests/test_migration_0131_push_notifications.py`

**Interfaces:**
- Produces:
  - `PushRegistration(id: uuid, device_id: uuid unique FK devices CASCADE, person_id: uuid FK people CASCADE, platform: str, provider: str, token: str unique, secret_hash: str, created_at, updated_at, last_sent_at: datetime|None, last_error: str|None)`. CHECK `platform IN ('android','ios')`, `provider IN ('fcm','apns')`.
  - `PushOutbox(id: uuid, notification_id: uuid FK notifications CASCADE, person_id: uuid FK people CASCADE, send_at: datetime, reason: str, state: str, attempts: int=0, last_error: str|None, message_type: str, created_at, handled_at: datetime|None)`.
    - CHECK `reason IN ('new','snooze','clear')`, `state IN ('queued','sent','dropped','failed')`, `message_type IN ('notification','clear')`.
    - Partial unique index on `(notification_id, message_type) WHERE state = 'queued'`.
    - Index on `(state, send_at)`.
  - `Notification.push_snoozed_until: datetime | None`.

- [ ] **Step 1: Write the failing migration test.** Follow `test_migration_0110_notification_delivery_log.py`. `test_upgrade_creates_push_tables` asserts both tables, the partial unique index and the new column exist. `test_second_queued_row_same_notification_rejected` inserts two `queued` `notification` rows for one notification, expects `IntegrityError`, and checks that a `sent` row plus a `queued` row is accepted. `test_downgrade_removes_them`.
- [ ] **Step 2: Run it.** `.venv/bin/pytest tests/test_migration_0131_push_notifications.py -q`. Expected: FAIL (no migration).
- [ ] **Step 3: Write the migration and the models** with the shapes above. `down_revision` is the current head.
- [ ] **Step 4: Run the test again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(push): push registration and outbox tables`.

### Task 2: The Push switch in the grid (API)

**Files:**
- Modify: `notifications/company.py` (`Switches`, `_switches`), `notifications/email.py` (`EffectiveSwitches`, `effective_switches`), `api/schemas.py` (`SwitchOverride`, `SwitchPair`, `DeliveryCheckSwitchesOut`), the settings PUT in `api/routes/notifications.py`, and `system/config_store.py` `DEFAULTS` if it spells out pairs.
- Test: `api/tests/test_notification_switches.py`, `api/tests/test_notification_settings_api.py`

**Interfaces:**
- Produces:
  - `Switches(inbox: bool, email: bool, push: bool = False)`.
  - `EffectiveSwitches(inbox, email, inbox_source, email_source, push: bool, push_source: str)`. Security is `push=False, push_source="fixed"`.
  - `SwitchOverride.push: bool | None`. `SwitchPair.push: bool = False`.
  - `DeliveryCheckSwitchesOut.push: DeliveryCheckSwitchOut`.

- [ ] **Step 1: Write the failing tests.**
  - `test_missing_push_reads_off`: a stored `{"inbox": true, "email": false}` gives `Switches(True, False, False)`.
  - `test_malformed_pair_still_on_on_push_off`: a stored `"x"` gives `Switches(True, True, False)`.
  - `test_push_needs_inbox`: own push on and inbox off gives `push is False`.
  - `test_own_push_overrides_default`: default off, own on gives `push is True` with `push_source == "own"`.
  - `test_security_push_fixed_off`: gives `(push, push_source) == (False, "fixed")`.
  - `test_put_defaults_saves_push` (API): the PUT round-trips `push` per category; an omitted `push` saves as false.
  - `test_me_switch_override_push` (API): the /me preferences save stores only the `push` the person set.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Thread `push` through the dataclasses and schemas. `_switches` reads `push` separately: a non-bool or missing `push` is `False` and does not make the pair malformed.
- [ ] **Step 4: Run the tests above plus the existing `test_notification_settings_api.py`, `test_notification_email.py` and `test_notification_self_service.py`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat(push): Push switch in company defaults and personal switches`.

### Task 3: `decide_push`, queuing in `notify()`, delivery log, Check delivery

**Files:**
- Create: `api/src/serversherpa/notifications/push.py`
- Modify: `notifications/inbox.py`, `notifications/delivery_log.py`, `notifications/check.py`, `api/schemas.py` (the check output), `config.py`
- Test: `api/tests/test_notification_push_decide.py`

**Interfaces:**
- Consumes: `effective_switches` (Task 2), `PushOutbox` and `PushRegistration` (Task 1).
- Produces:
  - `push_enabled() -> bool`: `get_settings().fcm_service_account_file != ""`.
  - `@dataclass(frozen=True) PushDecision(queue: bool, reason: str | None, phones: int, critical: bool, switches: EffectiveSwitches)`.
  - `async decide_push(db, person_id, info: KindInfo | None, *, contact: Contact | None, company: CompanySettings, now: datetime) -> PushDecision`. Reads only.
  - `async live_registrations(db, person_id, now) -> list[PushRegistration]`. The registration's device must be: `personal_person_id == person_id`, `registration.person_id == person_id`, `token_expires_at > now`, `sub_type != 'zebra'`, and not `biometric.shared_station(device)`.
  - `async maybe_push(db, row: Notification, *, info, contact, company) -> None`: logs and queues.
  - `async queue_push(db, notification: Notification, *, reason: str, send_at: datetime) -> PushOutbox`: upserts the one `queued` `notification` row.
  - `delivery_log.LOG_CHANNELS` gains `"push"`. `EVENTS` gains `"push_queued", "push_not_queued", "push_sent", "push_dropped", "push_failed", "push_retry", "push_token_removed", "push_snoozed", "push_cleared"`.
  - `check_delivery` output gains `push: {outcome: "now" | "not_sent", reason: str | None, phones: int}` and `push_enabled: bool`.

Reason codes, in this order (the first failure wins): `push_not_set_up`, `unregistered_kind`, `security_category`, `category_off` (inbox off), `category_no_push`, `recipient_inactive`, `not_admin` (`resolve_access(db, person_id).max_rank < GATE_BYPASS_RANK`), `no_phone`, `quiet_hours` (`state_at(contact_schedule(contact), now) != "open"` and not critical).

- [ ] **Step 1: Write the failing tests** in `test_notification_push_decide.py`. Seed an admin with a personal Android device, a valid registration and Push on for `assets`. Use `monkeypatch` to set `fcm_service_account_file`.
  - `test_reasons_in_order`: parametrized; each case breaks exactly one rule and asserts its reason code.
  - `test_not_set_up_queues_nothing`: with the setting empty, `notify()` writes the inbox row, there are 0 `push_outbox` rows, and the log has `push_not_queued` with `push_not_set_up`.
  - `test_quiet_hours_only_critical`: inside quiet hours, a non-critical kind is `quiet_hours` with no row. After the kind is marked critical in company settings, it queues.
  - `test_zebra_and_station_not_a_phone`: a `zebra` device, and a device with a `station_type`, both give `no_phone`.
  - `test_registration_expired_not_a_phone`: `token_expires_at` in the past gives `no_phone`.
  - `test_stale_owner_not_a_phone`: `registration.person_id` differs from `device.personal_person_id`, giving `no_phone`.
  - `test_never_emailed_kind_can_push`: a kind with `email=False` in a category with push on queues.
  - `test_burst_two_notifications_two_rows`: two `notify()` calls in one transaction give 2 queued rows.
  - `test_check_delivery_push_line`: the check output carries `push.reason == "category_no_push"` and `push_enabled`.
  - `test_delivery_log_push_channel`: `record(..., channel="push")` is accepted.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement `push.py`** and call `maybe_push` at the end of `notify()`, after `maybe_email`, with the same `contact` and `company`. Add the `config.py` field.
- [ ] **Step 4: Run the new file plus `test_notifications_inbox.py`, `test_notification_email.py` and `test_notification_delivery_log.py`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(push): decide and queue push from notify()`.

### Task 4: FCM client

**Files:**
- Create: `api/src/serversherpa/push/__init__.py`, `api/src/serversherpa/push/fcm.py`
- Modify: `api/pyproject.toml` only if `httpx` is not already a runtime dependency (it is today; check).
- Test: `api/tests/test_push_fcm.py`

**Interfaces:**
- Produces:
  - `class FcmClient: def __init__(self, service_account: dict, *, transport: httpx.AsyncBaseTransport | None = None, clock=time.time)`.
  - `FcmClient.from_settings() -> FcmClient | None`: returns None when not set up. It reads the JSON file and raises a clear error if it is unreadable.
  - `async FcmClient.send(token: str, data: dict[str, str], *, high_priority: bool) -> SendResult`.
  - `@dataclass SendResult(outcome: Literal["sent", "token_dead", "retry", "fatal"], error: str | None)`.
- Behavior the tests pin:
  - The access token is an RS256 JWT: `iss` and `sub` are `client_email`, `aud` is `https://oauth2.googleapis.com/token`, `scope` is `https://www.googleapis.com/auth/firebase.messaging`, and it expires 3600 s after `iat`. It is exchanged at `token_uri`, cached, and refreshed 300 s before expiry.
  - It POSTs to `https://fcm.googleapis.com/v1/projects/{project_id}/messages:send` with `{"message": {"token", "data", "android": {"priority": "HIGH" | "NORMAL"}}}`. Data values are strings.
  - Responses:
    - 200 → `sent`.
    - 404 with `UNREGISTERED`, or 400 `INVALID_ARGUMENT` mentioning the token → `token_dead`.
    - 429 or 5xx → `retry`.
    - 401 → refresh the token once and resend; still 401 → `fatal`.
    - Anything else → `fatal`.

- [ ] **Step 1: Write the failing tests** with `httpx.MockTransport` and a throwaway RSA key generated in the test: `test_token_claims_and_cache`, `test_send_payload_shape`, `test_unregistered_is_token_dead`, `test_429_is_retry`, `test_401_refreshes_once`, `test_from_settings_none_when_unset`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement `fcm.py`.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(push): FCM HTTP v1 client`.

### Task 5: Draining the queue in the notification worker

**Files:**
- Create: `api/src/serversherpa/push/delivery.py`
- Modify: `notifications/worker.py` (`run_push(maker, state)`, called every loop like the email outbox)
- Test: `api/tests/test_push_delivery.py`

**Interfaces:**
- Consumes: `FcmClient` (Task 4), `live_registrations`, `decide_push` (Task 3).
- Produces: `async drain_push(db, client: FcmClient, *, now: datetime, batch: int = 50) -> int` (rows handled).
  - It claims `queued` rows with `send_at <= now` (`FOR UPDATE SKIP LOCKED`).
  - `notification` rows are re-checked: the notification still exists, is unread and not hidden; `decide_push(...)` still queues (snooze rows get the same rules, so a snooze that ends inside quiet hours is dropped unless the kind is critical); and there is at least one live registration. A failed re-check marks the row `dropped` with reason `read`, `hidden`, `deleted` or the decision's reason, logs `push_dropped`, and is never retried.
  - It sends to each live registration. The data is `{type: "notification", notification_id, person_id, kind, title[:120], body[:400], critical: "true"|"false", created_at}`, high priority.
  - `clear` rows send `{type: "clear", notification_id}` to the person's live registrations at normal priority. No re-check.
  - Outcomes:
    - `token_dead` → delete the registration and log `push_token_removed`.
    - `retry` → `attempts += 1`, `send_at = now + 30 s * 2**attempts`. After `attempts == 5` the row is `failed` and logs `push_failed`.
    - At least one `sent` → `sent`, `handled_at`, and `registration.last_sent_at`. A sent snooze clears `push_snoozed_until`.
  - The step is a no-op when `FcmClient.from_settings()` is None.

- [ ] **Step 1: Write the failing tests** with a fake client that records calls:
  - `test_sends_and_marks_sent`.
  - `test_owner_changed_after_queue_drops`: re-point `personal_person_id` after queuing gives `dropped` and no send.
  - `test_read_before_send_drops`.
  - `test_token_dead_deletes_registration`.
  - `test_retry_backoff_then_failed`.
  - `test_two_phones_both_sent`.
  - `test_clear_message_normal_priority`.
  - `test_worker_idle_when_not_set_up`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement `drain_push` and `run_push`.** Wire it into `run_forever` next to the email outbox call, with its own `{"failed": False}` state and the same log-once-on-failure idiom.
- [ ] **Step 4: Run the new tests plus `test_notification_worker.py`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(push): notification worker sends queued pushes`.

### Task 6: Snooze, clear on read or hide, and bump re-push

**Files:**
- Modify: `notifications/push.py`, `api/routes/notifications.py` (read, unread, hide, read-all, clear-read), `notifications/requests.py` (`resolve_copies`), `notifications/reset_requests.py` (`resolve`, `open_or_bump`), `notifications/address_blocks.py` (`resolve_block`), `services/router_agent.py` (the resolve SQL near line 290)
- Test: `api/tests/test_push_snooze_clear.py`

**Interfaces:**
- Produces:
  - `SNOOZE = timedelta(minutes=5)`.
  - `async snooze(db, notification: Notification, *, now) -> datetime`: raises `ValueError("not_live")` on a read or hidden notification. Sets `push_snoozed_until`, upserts the queued `notification` row to `reason="snooze", send_at=now+SNOOZE`, logs `push_snoozed`, and returns the until time.
  - `async on_read_or_hidden(db, notification_ids: list[uuid.UUID], person_id) -> None`: cancels queued `notification` rows (state `dropped`, reason `read`), clears `push_snoozed_until`, and queues one `clear` row each if the person has a live registration.
  - The raw-SQL resolve paths add `RETURNING id, person_id` (or select the ids first) and call `on_read_or_hidden`.
  - `open_or_bump`, when it bumps an existing card, calls `maybe_push` for that card.

- [ ] **Step 1: Write the failing tests:**
  - `test_snooze_requeues_five_minutes`: `send_at == now + 5 min`, and `push_snoozed_until` is set.
  - `test_resnooze_restarts`: snoozing twice leaves one queued row, dated from the second call.
  - `test_snooze_read_rejected`.
  - `test_read_cancels_snooze_and_queues_clear`.
  - `test_hide_cancels_and_clears`.
  - `test_read_all_clears_each`.
  - `test_raw_resolve_paths_queue_clear`: parametrized over requests, reset requests, address blocks and router agent.
  - `test_bumped_reset_request_pushes_again`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the functions and hooks.
- [ ] **Step 4: Run the new tests plus `test_notifications_inbox.py`, `test_notification_requests_service.py`, `test_address_block_notifications.py` and the router-agent tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(push): snooze, clear on read or hide, bump re-push`.

### Task 7: "This is my phone", registration, and the push key

**Files:**
- Create: `services/push_registrations.py`, `api/routes/kiosk_push.py` (mounted under `/kiosk`)
- Modify: `api/routes/devices.py` (`put_device_personal`), `services/biometric.py` (`clear_personal_on_platform_change`), the `revoke_keys` call sites with reasons `demoted`, `account_disabled` and `blacklist` (`users.py`, `worker_edits.py`, `people/bulk_import.py`), and the router include list
- Test: `api/tests/test_kiosk_push_registration.py`

**Interfaces:**
- Consumes: `_refusal_for` and `_personal_refusal` from `devices.py` (move them into `services/push_registrations.py` or a shared module if importing a route module is awkward), `biometric.shared_station`, `biometric.platform_family`, `biometric.revoke_keys`, `_bind_kiosk_session` (to get the caller's device). Factor out a `async own_device(db, actor) -> Device`. A session that isn't a kiosk session bound to a serial gets 403 `not_this_kiosk`.
- Produces:
  - `async register(db, device, person_id, *, token: str, platform: str = "android") -> tuple[PushRegistration, str]`: returns the raw key, `secrets.token_urlsafe(32)`, with sha256 stored.
  - `async drop_for_device(db, device_id, *, reason: str) -> bool` and `async drop_for_person(db, person_id, *, reason: str) -> int`.
  - `async verify_key(db, header: str) -> PushRegistration | None`: parses `PushKey <registration_id>.<key>`, compares with `hmac.compare_digest`, and requires the registration to be live (same rules as `live_registrations`).
  - A dependency `push_registration(request, db) -> PushRegistration`: a flat 401 `push_key_invalid`, rate-limited per `rate_limit_ip` like the station-key routes.
  - Routes:
    - `PUT /kiosk/personal` with `{on: bool}`. Returns `{on: bool, owner_name: str | None}`. Refusals are 422 with `reason` in `not_admin | shared_station | zebra | platform_unknown | owned_by_other | not_owner | <_refusal_for codes>`. On is audited `personal_set`, off `personal_cleared`, both with `source: "kiosk"`. Off revokes keys (`reassigned`) and drops the registration.
    - `GET /kiosk/personal`: `{on, owner_name, push_registered}` for the Settings screen.
    - `POST /kiosk/push/registration` with `{token}`: returns `{registration_id, push_key}`. Requires the device to be personal to the caller and rank 60+.
    - `DELETE /kiosk/push/registration`: 204.
    - `PUT /kiosk/push/registration/token` with `{token}`: push-key auth.
  - Every personal writer calls `drop_for_device`. The demoted, disabled and blacklist sites call `drop_for_person`.
  - `enforce_session_scope` needs no change, since the routes are under `/kiosk/`. The push-key routes take no session at all.

- [ ] **Step 1: Write the failing tests:**
  - `test_admin_claims_unowned_phone`.
  - `test_staff_refused_not_admin`.
  - `test_zebra_refused`.
  - `test_station_refused`.
  - `test_platform_unknown_refused`.
  - `test_owned_by_other_refused`.
  - `test_only_owner_turns_off`.
  - `test_off_revokes_biometric_and_drops_registration`.
  - `test_register_returns_key_once_and_hashes_it`.
  - `test_token_refresh_with_push_key`.
  - `test_wrong_key_flat_401`.
  - `test_key_dead_after_portal_reassign`.
  - `test_demote_drops_registrations`.
  - `test_session_from_other_device_refused`.
  - `test_audit_source_kiosk`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new tests plus `test_kiosk_biometric_api.py`, `test_biometric_admin_api.py`, `test_biometric_revocation.py` and `test_kiosk_session_scope.py`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(push): This is my phone, push registration and push key`.

### Task 8: The app's notification routes

**Files:**
- Modify: `api/routes/kiosk_push.py`, and `api/routes/notifications.py` (extract the inbox query and the read/unread/hide bodies into shared helpers in `notifications/inbox_ops.py`, so both route sets call the same code)
- Test: `api/tests/test_kiosk_notifications_api.py`

**Interfaces:**
- Consumes: `snooze`, `on_read_or_hidden` (Task 6), `push_registration` (Task 7).
- Produces:
  - Session routes (rank 60+ only, otherwise 403 `not_admin`):
    - `GET /kiosk/notifications`: same query parameters and response as `/notifications/inbox`, and each item adds `push_snoozed_until`.
    - `POST /kiosk/notifications/{id}/read`, `/unread`, `/snooze` (returns `{snoozed_until}`), and `DELETE /kiosk/notifications/{id}`.
  - Push-key routes: `POST /kiosk/push/notifications/{id}/read` and `/snooze`. They act only on the registration's `person_id`; anything else is 404 `notification_not_found`.
  - Snooze on a read or hidden notification is 409 `not_live`.

- [ ] **Step 1: Write the failing tests:**
  - `test_list_matches_portal_inbox`.
  - `test_read_unread_hide_via_kiosk`.
  - `test_snooze_via_session`.
  - `test_snooze_and_read_via_push_key`.
  - `test_push_key_cannot_touch_other_person`.
  - `test_push_key_cannot_hide_or_list` (405 or 401 on those paths).
  - `test_non_admin_session_refused`.
  - `test_portal_inbox_unchanged` (the existing inbox tests still pass).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the helpers and routes.
- [ ] **Step 4: Run the new tests plus `test_notifications_inbox.py`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(push): kiosk notification routes for the app`.

### Task 9: Portal

**Files:**
- Modify: `portal/src/lib/api.ts` (types: `SwitchPair.push`, `SwitchOverride.push`, check `push`, the device detail field `push_registered`), `components/notifications/SwitchGrid.tsx` and its lib helpers (`effective`, `flip`, `isChanged`), `NotificationDefaultsTab.tsx`, `pages/me/MeNotifications.tsx`, `CheckDeliveryModal.tsx`, `DeliveryLogTab.tsx`, `lib/deliveryLog.ts`, the kiosk device detail page (where "Personal device of" renders), and the API `_detail_for` in `devices.py` (adds `push_registered: bool`)
- Test: the existing `*.test.tsx` next to each file, plus `api/tests/test_devices_*` for the detail field

**Interfaces:**
- Consumes: the API shapes from Tasks 2, 3 and 7.
- Produces, in the UI:
  - SwitchGrid gets a third column, **Push**. With Inbox off, Push reads off and is disabled with "Turn on Inbox to get push", mirroring Email. With push not set up, it is disabled with "Push isn't set up on the server". Security shows "Never" in the Push column.
  - The /me grid shows Push only when the signed-in person's max rank is 60+ (use the same rank source as the other admin-only bits on /me). Defaults always shows it.
  - Check delivery shows a "Push" line. The copy per reason: `push_not_set_up` "Push isn't set up on the server", `security_category` "Account security notices don't push", `category_off` "Inbox is off for this category", `category_no_push` "Push is off for this category", `recipient_inactive` "Account is disabled or archived", `not_admin` "Push is for admins only", `no_phone` "No phone set up for push", `quiet_hours` "Quiet hours: no push unless critical". When it would send: "Sends now to N phone(s)".
  - The Delivery log's channel filter offers Push, and the push events get labels in `deliveryLog.ts`.
  - The device page: "Push: on" or "Push: off" under "Personal device of" when it is set.

- [ ] **Step 1: Write the failing tests:**
  - `SwitchGrid.test.tsx`: `renders Push column`, `push disabled when inbox off`, `push disabled when not set up`.
  - `MeNotifications.test.tsx`: `push column hidden below rank 60`.
  - `CheckDeliveryModal.test.tsx`: `shows push reason copy`.
  - `deliveryLog.test.ts`: `labels push events`.
  - API: `test_device_detail_push_registered`.
- [ ] **Step 2: Run them.** `npx vitest run src/components/notifications src/pages/me src/lib/deliveryLog.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, plus `npx tsc --noEmit` and the whole notifications folder.** Expected: PASS.
- [ ] **Step 5: Check it in the browser.** On the dev portal, look at System › Notifications › Defaults and /me in light and dark, and take a screenshot. A preview should listen on 0.0.0.0.
- [ ] **Step 6: Commit** `feat(push): Push column, Check delivery and Delivery log in the portal`.

### Task 10: Android, part 1: Firebase, registration and "This is my phone"

**Prerequisite:** Jimmy has created the Firebase project, and `Android_Kiosk_App/app/google-services.json` exists. If it doesn't, stop and ask: the build and tests below must still pass without it, but the device check can't run.

**Files:**
- Modify: `gradle/libs.versions.toml` (Firebase BoM, `firebase-messaging`, the `google-services` plugin, picking versions that build on compileSdk 36 / AGP in use), root `build.gradle.kts`, and `app/build.gradle.kts`. Apply `com.google.gms.google-services` **only when `app/google-services.json` exists**, so tests and CI build without it.
- Modify: `data/api/KioskApi.kt` and `OkHttpKioskApi.kt`. Push-key calls send `Authorization: PushKey <id>.<key>` and skip the bearer and refresh flow.
- Create: `data/push/PushKeyStore.kt` (over `SecretStore`, keys `push.registration_id` and `push.key`), `data/push/PushRegistrar.kt`, and an interface `FcmTokens { suspend fun token(): String; suspend fun delete() }` with a Firebase implementation and a fake for tests.
- Modify: `ui/screens/settings/ThisKioskPanel.kt` (the switch block, admins only), `AppContainer.kt` (wiring), `AndroidManifest.xml` (`POST_NOTIFICATIONS`).
- Test: `app/src/test/.../data/push/PushRegistrarTest.kt`, `ui/screens/settings/ThisKioskPushTest.kt`

**Interfaces:**
- Consumes: the Task 7 routes.
- Produces:
  - `KioskApi.getPersonal(): PersonalState(on: Boolean, ownerName: String?, pushRegistered: Boolean)`.
  - `KioskApi.setPersonal(on: Boolean): PersonalState`.
  - `KioskApi.registerPush(token: String): PushRegistration(registrationId: String, pushKey: String)`.
  - `KioskApi.deletePush()`, `KioskApi.updatePushToken(token, key: PushKey)`.
  - `PushRegistrar.turnOn(): Result<PersonalState>`, which runs `setPersonal(true)`, then `registerPush(fcm.token())`, then `store.save`.
  - `PushRegistrar.turnOff()`, `PushRegistrar.onNewToken(token)`.
  - The Settings UI states:
    - Not admin: the block is hidden.
    - Zebra (`sub_type`): hidden.
    - Owned by someone else: "This phone belongs to <owner>", with no switch.
    - Off.
    - On, with notifications allowed.
    - On, but notifications blocked: "Notifications are blocked for this app." with an **Open notification settings** button (`Settings.ACTION_APP_NOTIFICATION_SETTINGS`).
    - A server refusal shows its reason in plain words.

- [ ] **Step 1: Write the failing tests:**
  - `PushRegistrarTest`: `turnOn_registers_and_stores_key`, `turnOn_refused_keeps_nothing`, `turnOff_clears_store_and_deletes_token`, `onNewToken_with_stored_key_sends_token`, `onNewToken_without_key_does_nothing`.
  - `ThisKioskPushTest`: `hidden_for_non_admin`, `shows_owner_when_owned_by_other`, `blocked_shows_settings_button`. Run these at `w360dp-h800dp` and at the compact default.
- [ ] **Step 2: Run them.** `./gradlew :app:testDebugUnitTest --tests '*PushRegistrarTest' --tests '*ThisKioskPushTest'`. Expected: FAIL.
- [ ] **Step 3: Implement.** On Android 13+, request `POST_NOTIFICATIONS` from the switch's turn-on path with the activity-result API.
- [ ] **Step 4: Run them.** Expected: PASS. Then `./gradlew :app:assembleDebug`, which is expected to succeed with and without `google-services.json`.
- [ ] **Step 5: Commit** `feat(android): This is my phone and push registration`.

### Task 11: Android, part 2: receiving and showing pushes

**Files:**
- Create: `data/push/KioskMessagingService.kt` (a `FirebaseMessagingService`, declared in the manifest with the `com.google.firebase.MESSAGING_EVENT` intent filter), `data/push/PushNotifier.kt`, `data/push/PushActionReceiver.kt` (declared in the manifest, `exported=false`)
- Test: `app/src/test/.../data/push/PushNotifierTest.kt`, `PushActionReceiverTest.kt`

**Interfaces:**
- Consumes: `PushRegistrar.onNewToken` (Task 10), and `KioskApi` push-key read and snooze (Task 8 routes; add `KioskApi.pushRead(id, key)` and `KioskApi.pushSnooze(id, key)`).
- Produces:
  - `PushNotifier.show(msg: PushMessage)` and `PushNotifier.clear(notificationId: String)`.
  - `PushMessage.parse(data: Map<String, String>): PushMessage?`, which is `Notification(...)` or `Clear(id)`. Unknown types return null.
  - Channels:
    - `notifications`, named "Notifications", IMPORTANCE_DEFAULT.
    - `critical`, named "Critical alerts", IMPORTANCE_HIGH.
    - Both are created at app start.
  - Each notification:
    - Android id = `notificationId.hashCode()`.
    - `VISIBILITY_PRIVATE`, with a public version titled "ServerSherpa" and text "New notification".
    - 24-hour `setWhen` from `created_at`.
    - Actions **Snooze** and **Mark read** (PendingIntents to the receiver with the id).
    - Content intent → `MainActivity` with extras `open_notification_id` and `owner_person_id`.
  - The receiver uses `goAsync()`, calls the push-key route, and cancels the alert on success. On failure the alert stays.

- [ ] **Step 1: Write the failing tests** (Robolectric, with a shadow NotificationManager):
  - `parse_notification_and_clear`.
  - `parse_unknown_type_null`.
  - `critical_goes_to_critical_channel`.
  - `private_visibility_with_public_version`.
  - `has_snooze_and_mark_read_actions`.
  - `clear_cancels_by_id`.
  - `snooze_action_calls_api_and_cancels`.
  - `failed_action_keeps_alert`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(android): show pushes with Snooze and Mark read`.

### Task 12: Android, part 3: Notifications page, Home button, and tap routing

**Files:**
- Create: `ui/screens/notifications/NotificationsScreen.kt`, `NotificationsViewModel.kt` (uses `viewModelScope`, with the `scopeOverride` constructor parameter like the others)
- Modify: `core/features/Features.kt` (a `NOTIFICATIONS_FEATURE`; `homeFeatures` puts it before Settings for admins, after the Rolodex), `ui/Routes.kt` (`NOTIFICATIONS = "notifications"`), `ui/shell/KioskShell.kt` (route and back label), `ui/guards/KioskGuard.kt` plus `MainActivity` (a one-shot pending route: an `open_notification_id` intent extra is held across sign-in and consumed by the shell after sign-in)
- Test: `app/src/test/.../ui/screens/notifications/NotificationsScreenTest.kt`, `core/features/FeaturesTest.kt`, and a shell routing test

**Interfaces:**
- Consumes: the Task 8 session routes (`KioskApi.listNotifications(cursor)`, `markRead`, `markUnread`, `hide`, `snooze`).
- Produces, in the UI (the spec's sketch):
  - Newest first. Title, body, 24-hour time, and an unread dot.
  - "Snoozed until HH:MM" when `push_snoozed_until` is in the future.
  - Buttons:
    - Unread rows: **Mark read**, **Snooze**, **Hide**.
    - Read rows: **Mark unread**, **Hide**.
  - A visible **Refresh** button, and **Load more** when `next_cursor` is set.
  - Empty state: "No notifications."
  - The highlighted item (from a tap) is scrolled to and outlined, not marked read.
  - Owner mismatch: when the signed-in person isn't `owner_person_id`, the page shows "This alert is for another person. Sign in as them to see it." with a **Sign out** button. Keep it generic if the owner's name isn't in the payload.

- [ ] **Step 1: Write the failing tests:**
  - `FeaturesTest`: `admin_home_has_notifications_before_settings`, `non_admin_home_has_no_notifications`, `timeclock_station_home_unchanged`.
  - `NotificationsScreenTest` (standard and compact):
    - `lists_items_newest_first`.
    - `unread_row_has_mark_read_snooze_hide`.
    - `read_row_has_mark_unread_hide`.
    - `snoozed_label_24h`.
    - `empty_state`.
    - `refresh_button_visible`.
    - `highlighted_item_not_marked_read`.
    - `assertNothingClippedHorizontally` in compact.
  - Routing:
    - `tap_signed_out_routes_after_sign_in`.
    - `tap_signed_in_as_owner_opens_page`.
    - `tap_signed_in_as_other_shows_mismatch`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new tests**, then the full suite in the background: `./gradlew :app:testDebugUnitTest`. Expected: PASS. Known flakes are listed in the memory notes on Robolectric flakes.
- [ ] **Step 5: Commit** `feat(android): Notifications page, Home button, tap routing`.

### Task 13: Device pass and implementation notes

**Files:**
- Modify: the spec (add an "Implementation notes" section listing what changed from the design), and `.env.example` (`SS_FCM_SERVICE_ACCOUNT_FILE=`)

- [ ] **Step 1:** With Jimmy's service-account JSON on the dev host and `SS_FCM_SERVICE_ACCOUNT_FILE` set in the dev `.env`, restart the API and the notification worker. Don't swap running workers for a branch; ask Jimmy when to restart.
- [ ] **Step 2:** Install the debug APK on Jimmy's Pixel (Kiosk F4E1) with `adb install -r`, and launch it with the launcher intent from Global Constraints.
- [ ] **Step 3:** Run the spec's device pass and record each result:
  1. App closed: the alert arrives.
  2. Phone locked: the alert arrives and its text is hidden when the phone is set to hide sensitive content.
  3. Signed out after the session expired: the alert arrives, and a tap goes to sign-in and then the page.
  4. Quiet hours: a non-critical kind doesn't arrive; a critical kind does.
  5. Snooze from the lock screen: the alert comes back about 5 minutes later.
  6. Mark read on the portal: the alert disappears from the phone.
  7. Switch off: no more alerts.
- [ ] **Step 4:** Write the implementation notes, then commit `docs(push): implementation notes and env example`.

---

## Self-review notes

- Spec coverage: decisions 1-15 map to Tasks 2, 3, 5, 6, 7, 8, 10, 11 and 12. Check delivery and the Delivery log are in Tasks 3 and 9. "Push: on/off" on the device page is in Task 9. Firebase setup is a prerequisite of Tasks 10 and 13. iOS is out of scope.
- Types used across tasks: `PushDecision`, `live_registrations`, `queue_push`, `snooze`, `on_read_or_hidden`, `verify_key`, `drop_for_device`, `drop_for_person`, `FcmClient.send` → `SendResult`, `PushRegistrar.turnOn`/`turnOff`/`onNewToken`, `PushMessage.parse`.
