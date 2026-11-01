# Notifications Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each person's own switches (starting from admin-set company defaults) and own schedule decide what email reaches them and when. Email that has to wait goes out as one summary. Admins mark notification types critical. Groups become plain member lists.

**Architecture:**

- **Company settings:** one `system_config` section `notifications` (defaults plus critical kinds) behind `GET` and `PUT /notifications/settings`.
- **Personal settings:** they live in `ui_prefs.notif` (`switches` and `schedule`), saved by the existing `PUT /auth/me/preferences`.
- **The decision:** `decide_email` drops groups. It uses the effective switches, then critical, then a pure schedule module.
- **Held email:** a row in a new `notification_held` table. A 60 s sweep in notification-worker re-checks the held items and sends one `notification_summary` email.
- **Groups:** they lose their delivery columns in a second migration.
- **Portal:** /me gets a switch grid and a schedule card, System › Notifications a Defaults tab, and the group pages lose their delivery settings. Check delivery and the Delivery log explain the new decision.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, PostgreSQL, Jinja mail templates, pytest (real Postgres); React 18 + TypeScript, Vite, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-01-notifications-phase1-design.md`

## Global Constraints

- **American English** everywhere (copy, comments, commit messages). Before committing, grep changed files for `-ise|-isation|colour|enrol\b|enrolment|behaviour|centre|licence`.
- **Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/notif-phase1`, branch `notif-phase1`. Work only there and never `cd` into the main checkout.
- **API tests:** `cd api && SS_TEST_DB=serversherpa_test_notif_phase1 PYTHONPATH=src .venv/bin/pytest <files> -q -p no:cacheprovider`. `PYTHONPATH=src` is required, because the shared venv otherwise imports the main checkout's code.
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
- **Session discipline:** `notify()`, `enqueue()`, `record()` and `hold_email()` add to the caller's session and never commit.
- **Log privacy:** no email address or message body in a `notification_log` row's `detail` or in a log line.
- **Admin and above** = `actor.access.is_global and actor.access.max_rank >= GATE_BYPASS_RANK` (60), through the new `ensure_admin(actor)`, else 403 `{"code": "forbidden"}`. Portal mirror: `maxRank >= ADMIN_RANK && !!scope?.global`.
- **Super admin and above** is unchanged: `ensure_super_admin`, portal `maxRank >= SUPER_ADMIN_RANK && !!scope?.global`.
- **Migrations:** `"0111"` (down_revision `"0110"`) and `"0112"` (down_revision `"0111"`). The unmerged `project-plans` branch rechains when it merges; that is not this plan's job.
- **Reference zone:** `services/timezone.DEFAULT_TIMEZONE` (`"America/New_York"`), mirrored by the portal's `DEFAULT_TIMEZONE` in `lib/notifications.ts`. No new policy numbers: the summary lead is 1 hour and the sweep runs every 60 s.
- **Copy:** UI and email copy is exactly as quoted in the spec. No invented copy, sample names or scenarios in UI, emails or docs. New tests use neutral names ("Group A", "Person A").
- **Portal controls:**
  - Reuse the house controls: `Switch` (named via `label`), `.segmented` (with `aria-pressed`), ComboBox, chips, `DataTable`, `RowActionsMenu`, `.pf-form`.
  - No raw `<select>`, `<input type="time">` or bare checkbox in touched notification UI.
  - Lists follow the list-column-floors recipe and keep their fit tests.
  - Modals use the `NotificationModal` shell.
- **Admin settings sections** copy the `BrandingControls` pattern: one Save (`btn-solid`) per section, disabled until dirty; errors are sentences, and `read_only_mode` shows the server's message.

## Review Focus

- **Weekend hold across a clock change.** A person in America/Chicago works Mon–Fri with quiet hours 9:00 PM–6:00 AM. A report arriving Friday 10:00 PM is held, and its summary goes out Monday 5:00 AM Central. When a DST change falls between the hold and the summary, the summary still lands at the local wall-clock time (Tasks 2, 5).
- **Admin default changes.**
  - An admin turns off the Wiki Email default.
  - People who never touched Wiki stop getting Wiki email.
  - A person who had turned Wiki Email on keeps it.
  - A person whose own "off" now equals the default stays "Your choice". (Tasks 3, 4, 8.)
- **Read before the summary.** An item held overnight and then read in the portal is dropped with reason `read` and is not in the summary. When every item is dropped, no summary is sent (Task 5).
- **Schedule change while held.** If a person removes their quiet hours while email is waiting, the summary goes out at the next sweep, not at the old time (Task 5).
- **Email needs Inbox.** Turning Inbox off for a category disables Email. Turning Inbox back on restores the earlier Email value. The API's effective Email is false whenever Inbox is false (Tasks 3, 8).
- **Legacy preference keys.** A stored blob with legacy keys `{"critical": true, "digest": "daily", "categories": {"reports": "inbox"}}` migrates to `switches: {"reports": {"email": false}}` with the legacy keys gone (Task 3).

---

### Task 1: Company defaults and critical kinds (API)

**Files:**
- Modify: `api/src/serversherpa/system/config_store.py` (`DEFAULTS["notifications"]`)
- Modify: `api/src/serversherpa/api/deps.py` (add `ensure_admin` after `ensure_super_admin`)
- Create: `api/src/serversherpa/notifications/company.py`
- Modify: `api/src/serversherpa/api/routes/notifications.py` (GET/PUT `/settings`)
- Modify: `api/src/serversherpa/api/schemas.py` (settings schemas)
- Test: `api/tests/test_notification_settings_api.py` (new)

**Interfaces:**
- Produces: `DEFAULTS["notifications"] = {"defaults": {c: {"inbox": True, "email": True} for c in ("approvals", "reports", "wiki", "learning")}, "critical_kinds": []}`.
- Produces: `ensure_admin(actor: AuthContext) -> None`. It raises 403 `{"code": "forbidden"}` unless global and `max_rank >= GATE_BYPASS_RANK`. The docstring says it is the Defaults tab's gate and matches `require_bulk_rank`.
- Produces in `notifications/company.py`:
  - `CONFIGURABLE_CATEGORIES: tuple[str, ...] = ("approvals", "reports", "wiki", "learning")`
  - `@dataclass(frozen=True) class Switches: inbox: bool; email: bool`
  - `@dataclass(frozen=True) class CompanySettings: defaults: Mapping[str, Switches]; critical_kinds: frozenset[str]`
  - `async def load_company_settings(db: AsyncSession) -> CompanySettings`. It uses `read_section(db, "notifications")`. A missing or malformed category falls back to on/on, and unknown kinds or categories are ignored.
  - `def critical_eligible(kind: str) -> bool`: registered, `email=True`, category not `security`.
  - `def is_critical(kind: str, company: CompanySettings) -> bool`: security-category kinds are always critical; otherwise the kind must be in `company.critical_kinds` and `critical_eligible`.
- Produces in the schemas:
  - `SwitchPair(BaseModel){inbox: bool, email: bool}`
  - `NotificationKindSettingOut{kind, label, category, email: bool, owner_always: bool, critical: bool, locked: bool}`
  - `NotificationSettingsOut{defaults: dict[str, SwitchPair], critical_kinds: list[str], kinds: list[NotificationKindSettingOut]}`
  - `NotificationSettingsIn{defaults: dict[str, SwitchPair] | None = None, critical_kinds: list[str] | None = None}` with `extra="forbid"`.
- Produces in the routes:
  - `GET /notifications/settings`: CurrentUser only. `kinds` lists every registered kind in registry order, with `locked = category == "security"`.
  - `PUT /notifications/settings`: `require_permission("notifications", "change")`, then `ensure_admin(actor)`.
    - `defaults` merges per category; `critical_kinds` replaces the list, de-duplicated and in registry order.
    - 422 `invalid_category` for a key outside `CONFIGURABLE_CATEGORIES`; 422 `invalid_kind` for any kind that fails `critical_eligible`.
    - Follow the `/system/security` PUT pattern: upsert `SystemConfig`, then `audit(entity_type="system", entity_id="notifications", action="notifications_config_update", changes={key: {"from", "to"}})`, then commit.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_notification_settings_api.py`:
  - `test_settings_out_of_the_box`: GET as the staff `seeded_user`.
    - `defaults` has exactly the 4 categories, all `{"inbox": true, "email": true}`, and `critical_kinds == []`.
    - `kinds["password_expiring"]` has `critical` and `locked` both true. `report_ready` has both false. `password_reset_request` has `email: false, critical: false`.
  - `test_put_requires_global_admin`: staff (rank 40) → 403; an admin role anchored to a client (not global) → 403; a global admin → 200.
  - `test_put_merges_defaults_per_category`: PUT `{"defaults": {"wiki": {"inbox": true, "email": false}}}`. GET then shows wiki email false and the other three unchanged. One `audit_log` row has action `notifications_config_update`.
  - `test_put_rejects_bad_categories`: `"security"` → 422 `invalid_category`; `"nope"` → 422 `invalid_category`.
  - `test_put_critical_kinds`:
    - `["report_failed", "report_failed"]` → GET shows `critical_kinds == ["report_failed"]` and `kinds["report_failed"].critical` true.
    - `["password_expiring"]`, `["password_reset_request"]` and `["nope"]` → 422 `invalid_kind`.
  - `test_is_critical_rules` (unit, no HTTP): `is_critical("totp_enrolled", CompanySettings({}, frozenset()))` is True. `is_critical("report_failed", …critical_kinds={"report_failed"})` is True, and False without it.
  - `test_put_blocked_in_read_only_mode`: copy the read-only setup an existing system-settings test uses. The PUT gets that test's read-only status and code.
- [ ] **Step 2: Run them to verify they fail** with `… pytest tests/test_notification_settings_api.py`. Expected: FAIL with 404 on the route and an import error for `company`.
- [ ] **Step 3: Implement** `DEFAULTS["notifications"]`, `ensure_admin`, `notifications/company.py`, the schemas and the two routes.
- [ ] **Step 4: Run the tests** above plus `tests/test_notification_log_api.py tests/test_preferences.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): company notification defaults and critical kinds`.

### Task 2: Personal schedule math (API, pure)

**Files:**
- Create: `api/src/serversherpa/notifications/schedule.py`
- Test: `api/tests/test_notification_schedule.py` (new)

**Interfaces:**
- Produces in `notifications/schedule.py`:
  - **`DAYS`:** `DAYS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")`.
  - **`Schedule`:** `@dataclass(frozen=True) class Schedule: zone: ZoneInfo; days: frozenset[str]; quiet_start: time | None; quiet_end: time | None`.
  - **`schedule_from_prefs(raw: Mapping | None) -> Schedule`.** `raw` is the `notif.schedule` mapping (`timezone`, `days`, `quiet_start`, `quiet_end`; times as "HH:MM" or "HH:MM:SS").
    - None or missing → the reference zone, all 7 days and no quiet hours.
    - A zone that fails `ZoneInfo` → `DEFAULT_TIMEZONE`.
    - An empty or unknown day list → all days.
    - Quiet hours count only when both are set and different.
  - **`state_at(s, at: datetime) -> Literal["open", "quiet_hours", "inactive_day"]`.**
    - `ValueError` on a naive `at`.
    - Local weekday not in `days` → `inactive_day`.
    - Else local time in `[start, end)` → `quiet_hours`. The window wraps past midnight when `start > end` and is compared on the wall clock.
    - Else `open`.
  - **`back_online_after(s, at: datetime) -> datetime | None`.** It returns the first instant at or after `at` when `state_at` is `open` (that is `at` itself when already open), in UTC.
    - It steps local boundaries (the next local midnight and the next `quiet_end`), trying `fold` 0 and 1 the way `email_rule._next_boundary` does. That module is deleted in Task 4, so copy the technique, not the import.
    - Horizon 8 days → None.
  - **`summary_at(s, at) -> datetime | None`** = `back_online_after(s, at) - timedelta(hours=1)`, with None passing through.
  - **`HoldDecision`:** `@dataclass(frozen=True) class HoldDecision: hold: bool; reason: str | None; summary_at: datetime | None; after_summary: bool`.
  - **`hold_decision(s, now) -> HoldDecision`:**
    - open → `(False, None, None, False)`.
    - Otherwise compute `summary_at(s, now)`:
      - None → `(False, None, None, False)`.
      - In the future → `(True, state, summary_at, False)`.
      - Else (the last hour before back online) → `(False, state, None, True)`.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_notification_schedule.py`. Use zone `America/Chicago` and aware datetimes built with `datetime(..., tzinfo=ZoneInfo("America/Chicago"))`, then compare in that zone.
  - `test_open_by_default`: `schedule_from_prefs(None)` is open at Sat 03:00, and `hold_decision` gives `hold False`.
  - `test_overnight_quiet_hours`: with 21:00–06:00 daily, Wed 22:00 is `quiet_hours`, 05:59 is `quiet_hours`, 06:00 is `open`, 20:59 is `open` and 21:00 is `quiet_hours`.
  - `test_day_off_wins`: with Mon–Fri and 21:00–06:00, Sat 10:00 and Sat 23:00 are both `inactive_day`.
  - `test_weekend_hold_summary_monday`: Mon–Fri, 21:00–06:00, now Fri 2026-10-23 22:00 → `hold True`, reason `quiet_hours`, summary at Mon 2026-10-26 05:00 local.
  - `test_days_off_without_quiet_hours`: Mon–Fri with no quiet hours, now Sat 10:00 → reason `inactive_day`, summary Sun 23:00 local.
  - `test_daytime_quiet_hours_with_days_off`: Mon–Fri with 01:00–06:00 → Sat 10:00 gives summary Sun 23:00, and Tue 02:00 gives summary Tue 05:00.
  - `test_last_hour_sends_now`: 21:00–06:00, now Tue 05:30 → `hold False`, `after_summary True`, reason `quiet_hours`.
  - `test_fall_back_keeps_local_wall_clock`: daily 21:00–06:00, now Sat 2026-10-31 22:00 CDT → summary is Sun 2026-11-01 05:00 CST (== 11:00 UTC).
  - `test_spring_forward_keeps_local_wall_clock`: daily 21:00–06:00, now Sat 2027-03-13 22:00 CST → summary is Sun 2027-03-14 05:00 CDT (== 10:00 UTC).
  - `test_bad_zone_falls_back`: `{"timezone": "Not/AZone"}` → `zone.key == "America/New_York"`.
  - `test_half_quiet_pair_is_ignored`: only `quiet_start` set → no quiet hours.
  - `test_naive_datetime_rejected`: `ValueError`.
- [ ] **Step 2: Run them to verify they fail** with `… pytest tests/test_notification_schedule.py`. Expected: FAIL (import error).
- [ ] **Step 3: Implement** `notifications/schedule.py`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): personal schedule math`.

### Task 3: Switches and schedule in preferences; migration 0111 (API)

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (`NotifPrefs`, new `SwitchOverride`, `NotifSchedule`)
- Create: `api/migrations/versions/0111_notifications_phase1.py`
- Modify: `api/src/serversherpa/db/models.py` (add `NotificationHeld` after `NotificationLog`)
- Modify: `api/src/serversherpa/notifications/delivery_log.py` (`EVENTS` adds `email_held`, `email_summarized`)
- Modify: `api/src/serversherpa/notifications/email.py` (`EffectiveSwitches`, `effective_switches`; `personal_choice` derived from them)
- Modify: `api/src/serversherpa/notifications/inbox.py` (load company settings once and pass them to `personal_choice`)
- Modify: `api/tests/conftest.py` (add `notification_held` to the TRUNCATE list)
- Test:
  - `api/tests/test_preferences.py`, `api/tests/test_notification_delivery_log.py` and `api/tests/test_notification_email.py` (`_prefs` helper only)
  - `api/tests/test_notification_switches.py` (new)
  - `api/tests/test_migration_0111_notifications_phase1.py` (new)

**Interfaces:**
- Consumes: Task 1 `CompanySettings`, `load_company_settings`; Task 2 `DAYS`.
- Produces in the schemas (every model with `extra="ignore"`):
  - **`SwitchOverride`:** `{inbox: bool | None = None, email: bool | None = None}`.
  - **`NotifSchedule`:** `{timezone: str | None = None, days: list[str] = list(DAYS), quiet_start: str | None = None, quiet_end: str | None = None}`.
    - Validators raise `ValueError` with the message used as the code:
      - `invalid_timezone`: a zone that `ZoneInfo` can't load;
      - `invalid_days`: empty, an unknown day, or a duplicate;
      - `invalid_quiet_hours`: only one time set, a bad clock value, or start == end.
    - Days are normalized to `DAYS` order. "HH:MM:SS" is normalized to "HH:MM".
  - **`NotifPrefs`:** `{sound, switches: dict[str, SwitchOverride] = {}, schedule: NotifSchedule = NotifSchedule()}`. `categories` is removed. A validator drops unknown categories, `security`, and entries whose two values are both None.
- Produces in `notifications/email.py`:
  - `@dataclass(frozen=True) class EffectiveSwitches: inbox: bool; email: bool; inbox_source: str; email_source: str`, where a source is `"default"`, `"own"` or `"fixed"`.
  - `def effective_switches(info: KindInfo | None, contact: Contact | None, company: CompanySettings) -> EffectiveSwitches`:
    - `info` None or the security category → `(True, True, "fixed", "fixed")`.
    - Otherwise `inbox = own.inbox ?? default.inbox` and `email = (own.email ?? default.email) and inbox`. Each source is `"own"` when the person's value is set, else `"default"`. A missing contact counts as no own values.
  - `personal_choice(info, contact, company) -> 'email' | 'inbox' | 'off'`, derived as follows. It exists only until Task 4 rewrites its callers.
    - Inbox off → `off`.
    - Email off → `inbox`.
    - Otherwise `email`.
- Produces in the ORM, `NotificationHeld` (table `notification_held`):

  | Column | Type |
  |---|---|
  | `id` | UUID PK, `gen_random_uuid()` |
  | `person_id` | UUID NOT NULL, FK people ON DELETE CASCADE |
  | `notification_id` | UUID NULL, FK notifications ON DELETE SET NULL |
  | `kind` | TEXT NOT NULL |
  | `category` | TEXT NOT NULL |
  | `reason` | TEXT NOT NULL, CHECK `ck_notification_held_reason` IN (`quiet_hours`, `inactive_day`) |
  | `held_at` | TIMESTAMPTZ NOT NULL |

  Index `notification_held_person_idx(person_id, held_at)`.
- Produces in migration 0111:
  - **Upgrade:**
    - Create the table.
    - Drop and recreate `ck_notification_log_event` with the 10 events.
    - Data step, in Python, over `user_accounts.ui_prefs`. It moves `notif.categories` into `notif.switches`: `inbox` → `{"email": false}`, `off` → `{"inbox": false, "email": false}`, and `email` or anything else adds nothing. Only the 4 configurable categories are kept. The step merges into any existing `switches`, removes `categories`, and strips `critical`, `email`, `maint` and `digest` from `notif`.
  - **Downgrade:**
    - Restore `categories` from `switches`: inbox false → `off`, email false → `inbox`, else `email`, for all five keys. Drop `switches` and `schedule`.
    - Restore the 8-event CHECK, after deleting `email_held` and `email_summarized` log rows.
    - Drop the table.

- [ ] **Step 1: Write the failing tests:**
  - **`test_preferences.py`:**
    - The pinned default prefs JSON becomes `"notif": {"sound": "chime", "switches": {}, "schedule": {"timezone": null, "days": ["mon","tue","wed","thu","fri","sat","sun"], "quiet_start": null, "quiet_end": null}}`.
    - PUT with schedule `{"timezone": "Not/AZone"}` → 422.
    - `{"days": []}` → 422.
    - Quiet start equal to end → 422.
    - Only `quiet_start` → 422.
    - `"21:00:00"` round-trips as `"21:00"`.
    - `switches` with `security` or `"nope"` keys round-trips without them.
    - A legacy blob containing `categories`, `critical` and `digest` parses with none of them.
  - **`test_notification_switches.py`:**
    - `test_defaults_apply_without_prefs`: no account → `(True, True, "default", "default")` for `report_ready`.
    - `test_own_inbox_off_turns_email_off`: own `{inbox: false}` → `inbox False, email False`, with `email_source == "default"`.
    - `test_company_default_email_off`: company `wiki` email false; a person without values → email False from `default`; a person with own `email: true` → True from `own`.
    - `test_security_is_fixed`: `totp_enrolled` → `fixed`.
    - `test_own_value_equal_to_default_stays_own`: own wiki `email: false` with a company default that is also false → email False from `own`, not `default`.
    - `test_personal_choice_mapping`: the three cases.
    - `test_notify_suppresses_inbox_when_inbox_off`: own `{reports: {inbox: false}}` → `notify()` returns None and logs `inbox_suppressed` with `category_off`.
  - **`test_notification_delivery_log.py`:** the pinned `EVENTS` gains `email_held` and `email_summarized`. Its insert-every-event test covers them.
  - **`test_migration_0111_notifications_phase1.py`:** copy the throwaway-DB pattern of `test_migration_0110_notification_delivery_log.py` (DB `<SS_TEST_DB>_m0111`).
    - Seed accounts with `{"notif": {"categories": {"approvals": "email", "reports": "inbox", "wiki": "off", "security": "inbox"}, "critical": true, "digest": "daily", "sound": "ping"}}` and one without `notif`. Upgrade to 0111. The first becomes `{"sound": "ping", "switches": {"reports": {"email": false}, "wiki": {"inbox": false, "email": false}}}`; the second is unchanged.
    - `notification_held` exists, and an `email_held` log row inserts.
    - Downgrade to 0110: `categories` comes back as `{approvals: email, reports: inbox, wiki: off, learning: email, security: email}` and `notification_held` is gone.
  - **`test_notification_email.py`:** rewrite only the `_prefs(**cats)` helper so a choice maps to the override above (`email` → no entry). Every existing test keeps passing.
- [ ] **Step 2: Run them to verify they fail** with `… pytest tests/test_preferences.py tests/test_notification_switches.py tests/test_notification_delivery_log.py tests/test_migration_0111_notifications_phase1.py`. Expected: FAIL.
- [ ] **Step 3: Implement** the schemas, the model, the migration, `EVENTS`, `effective_switches`, the derived `personal_choice`, and the conftest TRUNCATE entry. The API's decision still checks groups after this task; Task 4 removes that.
- [ ] **Step 4: Run** the step-2 files plus `tests/test_notification_email.py tests/test_notifications_inbox.py tests/test_mail_delivery.py tests/test_notification_log_api.py`. Expected: PASS. Then run `cd api && PYTHONPATH=src .venv/bin/alembic heads` → `0111 (head)`.
- [ ] **Step 5: Commit** `feat(notifications): per-person switches and schedule in preferences`.

### Task 4: Switches, critical and schedule decide email; groups stop gating (API)

**Files:**
- Modify: `api/src/serversherpa/notifications/email.py`:
  - rewrite `EmailDecision`, `decide_email`, `maybe_email` and `recheck_before_send`;
  - add `recheck_notification`;
  - delete `GroupVerdict`, `_group_settings`, `personal_choice` and `_safe_timezone` if unused.
- Create: `api/src/serversherpa/notifications/held.py` (`hold_email`)
- Modify: `api/src/serversherpa/notifications/inbox.py` (inbox suppression from `effective_switches`)
- Modify: `api/src/serversherpa/notifications/check.py` (rewrite; delete `_groups`)
- Modify: `api/src/serversherpa/notifications/kinds.py` (drop `KindInfo.urgent` and `CATEGORY_EMAIL_SOURCE`)
- Delete: `api/src/serversherpa/notifications/email_rule.py`, `api/tests/test_notification_email_rule.py`
- Modify: `api/src/serversherpa/api/routes/notifications.py` (`/check` and `/kinds` responses)
- Modify: `api/src/serversherpa/api/schemas.py` (`DeliveryCheckOut` and `NotificationKindOut` new fields; delete `DeliveryCheckGroupOut`)
- Modify: `api/src/serversherpa/mail/templates/notification.txt` and `notification.html` (footer copy)
- Test: `api/tests/test_notification_email.py`, `test_mail_delivery.py`, `test_notification_log_api.py`, `test_notification_kinds.py`, `test_password_expiry.py`, `test_totp_api.py`, plus any other failures from removing the group gate

**Interfaces:**
- Consumes: Task 1 `load_company_settings`, `is_critical`; Task 2 `schedule_from_prefs`, `hold_decision`, `state_at`; Task 3 `effective_switches`, `NotificationHeld`.
- Produces in `email.py`:
  - **`EmailDecision`:**

    ```python
    EmailDecision(
        queue: bool, hold: bool, send_at: datetime | None, summary_at: datetime | None,
        reason: str | None, address: str | None, address_source: str | None,
        owner_copy: bool, critical: bool, after_summary: bool,
        switches: EffectiveSwitches | None, schedule_state: str | None)
    ```

  - **`decide_email`:** `async def decide_email(db, person_id, info, *, owner_notice: bool, contact: Contact | None, company: CompanySettings, now: datetime) -> EmailDecision`. It writes nothing. The first failing check decides:
    1. `email_not_set_up`
    2. `unregistered_kind`
    3. `kind_not_emailed`
    4. `admin_copy`: an account-security kind that is not the owner's own copy, which stays in the inbox only
    5. `category_off` (effective Inbox off)
    6. `category_inbox_only` (effective Email off)
    7. `recipient_inactive`
    8. `no_address`
    9. Owner copy → queue now (owner_copy).
    10. `is_critical` → queue now (critical).
    11. `hold_decision(schedule_from_prefs(<the person's notif.schedule>), now)`: hold → `hold=True` with reason and `summary_at`; else queue now, with `after_summary` from the decision.
  - **`maybe_email(db, notification, *, info, owner_notice, contact, company)`:**
    - Not queued and not held → `record("email_not_queued", reason=…, detail={"source": <inbox_source or email_source>})` for `category_off` / `category_inbox_only`, else no detail.
    - Held → `hold_email(...)`.
    - Queued → `enqueue(... send_at=None, log_detail={"via": address_source, "critical": True?, "owner_copy": True?, "after_summary": True?})`, with falsy keys dropped and no `groups` key.
  - **`recheck_notification`:** `async def recheck_notification(db, notification: Notification | None, info: KindInfo, contact: Contact | None, company: CompanySettings) -> str | None` returns the first of `notification_gone`, `resolved`, `hidden`, `read`, `recipient_inactive`, `category_turned_down` (effective Email off). `recheck_before_send` keeps its early returns (template mail, unregistered kinds, security) and then calls it.
- Produces in `held.py`: `def hold_email(db, notification: Notification, *, info: KindInfo, reason: str, summary_at: datetime) -> NotificationHeld`. It adds the row (`held_at=datetime.now(UTC)`), then `record(db, "email_held", channel="email", person_id=…, notification_id=…, kind=…, category=…, reason=reason, detail={"summary_at": summary_at.isoformat()})`. It never flushes or commits.
- Produces in `inbox.py`: `notify()` loads the contact and company settings once. When the effective Inbox is off and `info.email` is set, it logs `inbox_suppressed` (`category_off`, `detail={"source": …}`) and returns None. Otherwise it writes the row and calls `maybe_email`.
- Produces in `check.py`: `check_delivery(db, person_id, kind, *, owner_copy: bool | None = None, now) -> dict` with these keys:
  - `person_id, person_name, kind, kind_label, category, owner_copy, active, has_account`
  - `inbox ("written"|"suppressed"), inbox_source, email_enabled, critical`
  - `switches: {"inbox": {"on", "source"}, "email": {"on", "source"}}`
  - `schedule: {"timezone", "days", "quiet_start", "quiet_end", "state"}`
  - `outcome ("now"|"held"|"not_sent"), send_at, summary_at, reason, address, address_source`

  `DeliveryCheckOut` matches these keys.
- Produces in `kinds.py`: `KindInfo(category, label, brief=False, email=True, owner_always=False)`. `/notifications/kinds` returns `NotificationKindOut{kind, label, category, email, owner_always, critical, locked}`.
- Produces in the footer (both templates, the non-security branch): "You get these emails from your notification settings. Change what you receive: {{ prefs_url }}".

- [ ] **Step 1: Write the failing tests:**
  - **`test_notification_email.py`.** Replace the group-gating tests; keep the owner, footer, log and address tests. Use `fixed_now` / `email._now` and a schedule zone of `America/Chicago`.
    - `test_emails_without_any_group`: a person with an account and no groups gets `report_ready` → one queued outbox row to the contact email, sent now; the `email_queued` detail is `{"template": "notification", "send_at": …, "deferred": false, "via": "contact"}`.
    - `test_company_default_email_off_blocks`: company wiki email off → `wiki_comment` is not queued, reason `category_inbox_only`, `detail.source == "default"`. With own `email: true` it is queued.
    - `test_held_during_quiet_hours`: schedule 21:00–06:00 and now 22:00 local → no outbox row; one `NotificationHeld` with reason `quiet_hours`; an `email_held` log whose `detail.summary_at` is the next day's 05:00 local in ISO form.
    - `test_held_on_day_off`: Mon–Fri on a Saturday → `inactive_day`.
    - `test_last_hour_sends_now`: 05:30 local → queued now; the log detail has `after_summary: true`.
    - `test_critical_skips_holding`: company `critical_kinds=["report_failed"]` during quiet hours → queued now with `critical: true`.
    - `test_critical_still_obeys_switches`: the same, but own reports `email: false` → `category_inbox_only`.
    - `test_owner_security_copy_ignores_schedule`: `password_expiring` with `owner_notice=True` during quiet hours → queued now to the sign-in email, `owner_copy: true`.
    - `test_admin_security_copy_inbox_only`: `totp_enrolled` with `owner_notice=False` → the inbox row is written, no outbox row, and `email_not_queued` has reason `admin_copy`.
    - `test_decide_email_matches_maybe_email`: adapt the existing test to the new signature.
  - **`test_mail_delivery.py`:**
    - Delete the `no_email_group` and group-update tests and helpers.
    - `test_recheck_drops_when_email_switched_off`: a queued row, then own reports `email: false` → skipped `category_turned_down`.
  - **`test_notification_log_api.py`.** Replace the group-verdict tests:
    - `test_check_held_shows_summary_time`: outcome `held`, `summary_at` set, `schedule.state == "quiet_hours"`.
    - `test_check_switch_sources`: `switches.email.source` is `"default"`, then `"own"`.
    - `test_check_owner_copy_now`.
    - `test_check_admin_copy_not_sent`: `owner_copy=false` for `totp_enrolled` → `not_sent` with `admin_copy`.
    - `test_check_critical_flag`.
    - `test_kinds_report_critical_and_locked`: an exact JSON list with `critical` and `locked` in place of `urgent`.
  - **`test_notification_kinds.py`:** drop the `CATEGORY_EMAIL_SOURCE` pin and `urgent` from the flag tuples.
  - **Footer test:** assert both new footer sentences and the security footer unchanged.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** everything listed. Delete `email_rule.py` and its test. Remove every import of `GroupVerdict`, `group_verdict`, `CATEGORY_EMAIL_SOURCE` and `KindInfo.urgent`. Update `/kinds` and `/check`.
- [ ] **Step 4: Run** `… pytest tests/test_notification_email.py tests/test_mail_delivery.py tests/test_mail_outbox.py tests/test_notification_log_api.py tests/test_notification_kinds.py tests/test_notifications_inbox.py tests/test_notification_switches.py tests/test_password_expiry.py tests/test_totp_api.py tests/test_wiki_notify.py tests/test_reset_request_cards.py tests/test_notification_requests_service.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): personal switches and schedule decide email; groups no longer gate`.

### Task 5: One summary email for held notifications (API)

**Files:**
- Create: `api/src/serversherpa/notifications/summary.py`
- Create: `api/src/serversherpa/mail/templates/notification_summary.subject.txt`, `notification_summary.txt` and `notification_summary.html` (the html extends `_base.html` like `notification.html`)
- Modify: `api/src/serversherpa/notifications/worker.py` (`SUMMARY_INTERVAL_SECONDS = 60`, a call in `run_forever`, `--once`)
- Test: `api/tests/test_notification_summary.py` (new), `api/tests/test_notification_worker.py`

**Interfaces:**
- Consumes: Task 4 `recheck_notification`, `_address`, `load_contact`, `portal_link`, `INBOX_PATH`; Task 2 `schedule_from_prefs`, `summary_at`; Task 1 `load_company_settings`; `mail.outbox.enqueue`; `delivery_log.record`.
- Produces: `async def run_summaries_once(maker: async_sessionmaker, *, now: datetime | None = None) -> int`, which returns how many summary emails were queued. Per person with held rows, in one session per person, committed per person:
  - **Claim and test whether it is due.** Lock their rows (`SELECT … FOR UPDATE SKIP LOCKED`, ordered by `held_at`). Due when `summary_at(schedule, oldest.held_at) <= now`, using the person's current schedule; None counts as due. Not due → roll back and continue.
  - **Server can't send email** (`email_enabled()` false): log `email_skipped`, reason `email_not_set_up`, for every row and delete them.
  - **Re-check each row.** Fetch the notification (`notification_id` may be NULL → `notification_gone`), then run `recheck_notification`, then the `no_address` check. A failure logs `email_skipped` (channel `email`, the ids, kind, category, reason) and deletes the row.
  - **Send what remains.** If anything remains, `enqueue(db, "notification_summary", address, person_id=…, log_detail={"summary": True, "count": n}, name=contact.first_name, count=n, items=[{"category": category_label, "title": n.title, "link": _absolute(n.link)}...], prefs_url=portal_link(INBOX_PATH))`, with items oldest first. Then for each item `record(db, "email_summarized", channel="email", person_id, notification_id, outbox_id=summary.id, kind, category)`, and delete the rows.
- Produces the templates:
  - **Subject:** `Your notification summary ({{ count }})`.
  - **Text:**

    ```
    Hi {{ name }},

    Here's what arrived during your quiet hours or day off:

    {% for i in items %}{{ i.category }} · {{ i.title }}
    {{ i.link }}

    {% endfor %}Change what you receive and when: {{ prefs_url }}
    ```

  - **HTML:** the same content as a list, with each title linked.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_notification_summary.py`. Build held rows through `notify()` with a Chicago schedule of Mon–Fri, 21:00–06:00, and patch `email._now` / `outbox._now`.
  - `test_summary_sends_one_email`:
    - Two items are held on Friday 22:00 and 23:00.
    - `run_summaries_once(maker, now=Mon 05:00 CT)` → 1. Exactly one outbox row: template `notification_summary`, to the contact email, subject `Your notification summary (2)`.
    - The text has both titles oldest first, both links, and "Change what you receive and when".
    - No `NotificationHeld` rows remain. Two `email_summarized` logs carry the summary's `outbox_id`.
  - `test_summary_waits_until_due`: `now=Mon 04:59 CT` → 0, nothing changes.
  - `test_summary_drops_read_items`: one item read first → `email_skipped` `read`; subject `(1)`.
  - `test_nothing_left_sends_nothing`: both read → 0 outbox rows, and the held rows are deleted.
  - `test_schedule_change_releases_held_mail`: after holding, set quiet hours off and all days → due at `now=Sat 10:00`.
  - `test_email_turned_off_drops`: own reports `email: false` → `category_turned_down`.
  - `test_archived_person_drops`: `recipient_inactive`.
  - `test_deleted_notification_drops`: delete the notification row → `notification_gone`.
  - `test_server_email_off_drops`: without `email_on` → `email_not_set_up`.
  - `test_summary_logs_carry_no_address_or_body`: no log `detail` contains the address or a body.
- [ ] **Step 2: In `test_notification_worker.py`,** add `test_run_forever_runs_the_summary_sweep`. Copy how that file counts the learning sweep.
- [ ] **Step 3: Run them to verify they fail.**
- [ ] **Step 4: Implement** the module, the templates and the worker wiring.
- [ ] **Step 5: Run** `… pytest tests/test_notification_summary.py tests/test_notification_worker.py tests/test_mail_outbox.py tests/test_mail_delivery.py`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(notifications): one summary email for held notifications`.

### Task 6: Groups keep members only; migration 0112 (API)

**Files:**
- Create: `api/migrations/versions/0112_drop_group_delivery_settings.py`
- Modify: `api/src/serversherpa/db/models.py` (remove the delivery columns from `NotificationGroup` and `NotificationGroupMember`)
- Delete: `api/src/serversherpa/notifications/settings.py`
- Modify: `api/src/serversherpa/api/routes/notifications.py`:
  - group create, patch and out keep `name`, `description`, `enabled`, `categories`;
  - delete `PATCH /groups/{id}/members/{pid}` and `apply_member_overrides`;
  - `validate_settings` keeps only the categories check;
  - `GROUP_FIELDS` and `NON_NULLABLE_GROUP_FIELDS` shrink to match.
- Modify: `api/src/serversherpa/api/routes/me.py` (delete `PATCH /notification-groups/{id}/overrides`; `_my_group_out` drops the delivery fields)
- Modify: `api/src/serversherpa/api/routes/users.py` (`UserNotificationGroup` drops `channels`)
- Modify: `api/src/serversherpa/api/schemas.py`:
  - `NotificationGroupSettings` keeps only `categories`;
  - delete `NotificationMemberOverrides` and `NotificationEffectiveSettings`;
  - `NotificationMemberOut` and `MyNotificationGroupOut` drop `overrides`, `effective`, `effective_channels` and the delivery fields;
  - keep `can_*` only where `GET /recipients` still returns it.
- Modify: `api/src/serversherpa/notifications/worker.py` (the idle status line counts held emails instead of groups; its test follows)
- Test:
  - `api/tests/test_notification_groups_api.py`, `test_notification_self_service.py`, `test_users_detail_api.py`, `test_notification_worker.py`: delete the settings and override tests, keep CRUD, members, categories and requests;
  - `api/tests/test_migration_0112_drop_group_delivery_settings.py` (new).

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - **Migration 0112 upgrade:** drops the group columns `channels, quiet_start, quiet_end, timezone, active_days, dnd_behavior, urgent_bypass` and the member columns `channels, quiet_mode, quiet_start, quiet_end, timezone, active_days, dnd_behavior, urgent_bypass`, together with their CHECKs:
    - `notification_groups_channels_check`, `_active_days_check`, `_dnd_behavior_check`, `_quiet_pair_check`
    - `notification_group_members_channels_check`, `_active_days_check`, `_quiet_mode_check`, `_dnd_behavior_check`, `_quiet_custom_check`

    Confirm the exact names against migration 0033.
  - **Migration 0112 downgrade:** re-adds them with the 0033/0034 server defaults (`channels '{email,web}'`, `timezone 'America/New_York'`, all days, `dnd_behavior 'defer'`, `urgent_bypass true`; member columns NULL) and the CHECKs.
  - **API responses** no longer carry any group or member delivery field.
  - **The overrides endpoints** are gone: the admin one returns 405 or 404, and the self-service one 404.

- [ ] **Step 1: Write the failing tests:**
  - `test_migration_0112…` (throwaway DB `<SS_TEST_DB>_m0112`): after the upgrade the columns are gone and a group with categories survives; after the downgrade they are back with their defaults.
  - In `test_notification_groups_api.py`:
    - `test_group_out_has_no_delivery_fields`: none of `channels`, `quiet_start`, `timezone`, `active_days`, `dnd_behavior` or `urgent_bypass` appears on GET or POST.
    - `test_create_rejects_delivery_fields`: `extra=forbid` → 422.
    - `test_member_override_route_is_gone`.
  - In `test_notification_self_service.py`: `test_override_route_is_gone`, plus `MyNotificationGroupOut` keys.
  - In `test_users_detail_api.py`: `notification_groups[*]` keys are `id, name, added_at`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** the migration and the code removal. Grep `api/src` for every removed name until none is left.
- [ ] **Step 4: Run** `… pytest tests/test_notification_groups_api.py tests/test_notification_self_service.py tests/test_users_detail_api.py tests/test_account_mgmt.py tests/test_devtools_cascade.py tests/test_notification_worker.py tests/test_migration_0112_drop_group_delivery_settings.py tests/test_notification_requests_service.py`. Expected: PASS. Then `alembic heads` → `0112 (head)`.
- [ ] **Step 5: Commit** `feat(notifications): groups keep members only; delivery settings and overrides removed`.

### Task 7: Switch grid and schedule building blocks (portal, additive)

**Files:**
- Modify: `portal/src/lib/api.ts`. Add these types and helpers and change nothing existing:
  - types `SwitchPair`, `NotifSwitches` (`Partial<Record<NotificationCategory, {inbox?: boolean; email?: boolean}>>`), `NotifSchedule`, `NotificationKindSetting`, `NotificationSettings`;
  - `getNotificationSettings()` (GET `/notifications/settings`);
  - `updateNotificationSettings(body: {defaults?: Record<string, SwitchPair>; critical_kinds?: string[]})` (PUT).
- Create: `portal/src/lib/notificationSwitches.ts`
- Create: `portal/src/lib/notificationSchedule.ts`
- Create: `portal/src/components/notifications/SwitchGrid.tsx`
- Create: `portal/src/components/notifications/ScheduleCard.tsx`
- Move: `.day-pills` CSS from `styles/notifications.css` to `styles/settings.css`. It is shared now.
- Test: `portal/src/lib/notificationSwitches.test.ts`, `portal/src/lib/notificationSchedule.test.ts`, `portal/src/components/notifications/SwitchGrid.test.tsx`, `portal/src/components/notifications/ScheduleCard.test.tsx`, `portal/src/lib/api.notificationSettings.test.ts` (all new)

**Interfaces:**
- Produces in `lib/notificationSwitches.ts`:
  - `CONFIGURABLE: NotificationCategory[] = ['approvals','reports','wiki','learning']`
  - `effective(own: {inbox?: boolean; email?: boolean} | undefined, def: SwitchPair): {inbox: boolean; email: boolean}`, where Email needs Inbox.
  - `isChanged(own): boolean` (any value set)
  - `flip(own, def, channel: 'inbox'|'email', next: boolean): {inbox?: boolean; email?: boolean} | undefined`. It sets the value, drops it when it equals the default, and returns `undefined` when both are unset.
- Produces in `lib/notificationSchedule.ts`:
  - `DEFAULT_SCHEDULE: NotifSchedule` (null zone, all `DAYS`, no quiet hours)
  - `DAY_LABELS: Record<Day, string>`
  - `summaryLine(s: NotifSchedule): {text: string; warn: boolean}`. It returns the spec §3 sentences exactly (all five cases), with the zone abbreviation from the same rule as `formatQuietHours`. Export the private `tzAbbrev` from `lib/notifications.ts` for this.
    - The quiet hours "cover midnight" when `start > end` or start is `"00:00"`.
    - With no days it returns `"Pick at least one day."` with `warn: true`.
    - With quiet hours switched on but a time missing (`ScheduleCard` passes its local draft), it returns `"Pick a start and end time."` with `warn: true`.
- Produces `SwitchGrid`:
  - **Props:** `{mode: 'person' | 'defaults'; defaults: Record<string, SwitchPair> | null; own?: NotifSwitches; emailEnabled: boolean | null; disabled?: boolean; onChange(category, next): void}`.
  - **Table:** a `DataTable` with Category (label, description, and in person mode the state "Company default" / "Your choice · Use company default"), Inbox and Email columns.
  - **Rows:**
    - Each switch is a `Switch` labeled `"{Channel} for {Category}"`.
    - Account security shows "Always" pills.
    - When Inbox is off, Email is off and disabled with the title "Turn on Inbox to get email".
    - When `emailEnabled === false`, Email is disabled with the title "Email isn't set up on this server".
    - While `defaults` is null, the switches are disabled.
    - The descriptions are the spec §1 strings.
- Produces `ScheduleCard`:
  - **Props:** `{value: NotifSchedule; onChange(next: NotifSchedule): void}`.
  - **Rows:**
    - Timezone: ComboBox over `timezoneOptions()`; unset shows `DEFAULT_TIMEZONE`.
    - Days you work: `.day-pills` mini-buttons with `aria-pressed`.
    - Quiet hours: a `Switch` plus Start/End ComboBoxes over `timeOptions()` from `lib/timeChoices.ts`. The times are disabled while the switch is off. Turning it on shows Start and End empty, with no times proposed. The schedule saves only once both are set and differ; until then the hint "Pick a start and end time." shows.
  - **Summary line** below.
  - **Change rules:** `onChange` fires only with a valid schedule. Removing the last day keeps it and shows the warning.

- [ ] **Step 1: Write the failing tests:**
  - **`notificationSwitches.test.ts`:**
    - `effective` covers the four combinations, including own inbox false with default email true → email false.
    - `flip` drops a value that equals the default, and returns `undefined` when both are cleared.
  - **`notificationSchedule.test.ts`:**
    - quiet 21:00–06:00 in `America/Chicago` → "Email that waits arrives as one summary at 5:00 AM CT, an hour before quiet hours end on a day you work. Critical notifications never wait.";
    - Mon–Fri with 21:00–06:00 (covers midnight) → the single 5:00 AM sentence;
    - Mon–Fri with 01:00–06:00 (doesn't cover midnight) → both sentences, 5:00 AM and 11:00 PM;
    - Mon–Fri with 00:00–06:00 → the single sentence;
    - Mon–Fri without quiet hours → the 11:00 PM sentence;
    - all days and no quiet hours → the "always goes out right away" sentence;
    - no days → the warning;
    - quiet on with only a start → "Pick a start and end time.".
  - **`SwitchGrid.test.tsx`:**
    - Person mode shows "Company default", and flipping Reports Email calls `onChange('reports', {email: false})`.
    - With own `{email: false}` the row shows "Your choice", and "Use company default" calls `onChange('reports', undefined)`.
    - Inbox off disables Email.
    - Security shows two "Always".
    - Defaults mode has no state line.
    - `emailEnabled=false` disables Email.
    - There are no bare checkboxes outside `.switch`.
  - **`ScheduleCard.test.tsx`:**
    - Toggling Sat calls `onChange` with the days in order.
    - Removing every day shows "Pick at least one day." and does not call `onChange`.
    - Quiet hours on shows two ComboBoxes, with no `<select>`.
    - The summary line updates.
  - **`api.notificationSettings.test.ts`:** method, path and body for both calls.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** the new tests plus `npx vitest run src/styles` and `npx tsc -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): switch grid and schedule card for notification settings`.

### Task 8: /me uses switches and the schedule (portal)

**Files:**
- Modify: `portal/src/lib/api.ts` (`NotifPrefs = {sound; switches: NotifSwitches; schedule: NotifSchedule}`; delete `DeliveryChoice`)
- Modify: `portal/src/lib/settings.ts` (`DEFAULT_PREFERENCES.notif = {sound: 'chime', switches: {}, schedule: DEFAULT_SCHEDULE}`)
- Modify: `portal/src/pages/me/MeNotifications.tsx`. It loads `getNotificationSettings()` on mount and renders `SwitchGrid` (person mode), the critical note, the Sound row and `ScheduleCard`, all saved through `usePreferenceSave`, then the trimmed groups lists. The section copy follows spec §1.
- Delete: `portal/src/pages/me/CategoryDelivery.tsx`; in `lib/notificationKinds.ts`, `DELIVERY_CHOICES`, `emailGroupsFor` and `EmailSource` (the categories keep `key` and `label`); in `lib/notificationGroups.ts`, `toGroupDetail` and `toMember`
- Modify: `portal/src/pages/me/GroupsList.tsx`. Its columns are Group, Members, Status (request state), plus Actions. Remove the overrides action, the "Customized" chip, and the Categories, Channels, Quiet hours and Days columns. The hints follow spec §6.
- Modify: every test fixture with `notif: { sound, categories }`. Replace `categories: {…}` with `switches: {}, schedule: { timezone: null, days: ['mon','tue','wed','thu','fri','sat','sun'], quiet_start: null, quiet_end: null }`. About 30 files; find them with `grep -rln "categories:" portal/src --include='*.test.ts*'`, then check each hit is a notif fixture.
- Test: `portal/src/pages/me/MeNotifications.test.tsx` (rewrite), `portal/src/pages/Profile.test.tsx`, `portal/src/lib/notificationKinds.test.ts`, `portal/src/lib/notificationGroups.test.ts`

**Interfaces:**
- Consumes: Task 7 `SwitchGrid`, `ScheduleCard`, `getNotificationSettings`, `flip`, `DEFAULT_SCHEDULE`.
- Produces: what /me saves: `update({notif: {...preferences.notif, switches: next}})` and `update({notif: {...preferences.notif, schedule: next}})`. Only overrides are saved; absent keys follow the defaults.

- [ ] **Step 1: Write the failing tests** in `MeNotifications.test.tsx`:
  - the head copy (spec §1);
  - the grid follows the mocked defaults;
  - flipping Wiki Email off saves `switches.wiki = {email: false}`;
  - "Use company default" removes the key;
  - the critical note lists the mocked critical kinds' labels;
  - the email-off hint and the disabled Email column when `email_enabled` is false;
  - a schedule change saves `notif.schedule`;
  - the group lists show Group/Members/Status, with no Categories/Channels and no "Edit overrides";
  - the hints follow spec §6.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.** Update the fixture files, then `npx tsc -p .` until clean.
- [ ] **Step 4: Run** `npx vitest run src/pages/me src/pages/Profile.test.tsx src/lib src/components/notifications src/styles`, then `npx tsc -p .` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): /me notification switches and schedule`.

### Task 9: Defaults tab and a slimmer groups list (portal)

**Files:**
- Create: `portal/src/components/notifications/NotificationDefaultsTab.tsx`
- Modify: `portal/src/pages/Notifications.tsx`. The tabs are `groups | defaults | log`, with the strip as follows:
  - admin and above see Groups and Defaults;
  - super admin and above also see Delivery log;
  - everyone else sees no strip.

  `?tab=defaults` selects the Defaults tab, and a disallowed value falls back to groups. The header hint follows the tab. Remove the Categories, Channels, Quiet hours and Days columns, facets, search text, sort and CSV. `GROUPS_HINT = "Notification groups and who's in them."`, and the NewGroupModal description is "Name the group. Members come next."
- Test: `portal/src/components/notifications/NotificationDefaultsTab.test.tsx` (new), `portal/src/pages/Notifications.test.tsx`

**Interfaces:**
- Consumes: Task 7 `SwitchGrid` (defaults mode), `getNotificationSettings`, `updateNotificationSettings`.
- Produces: `NotificationDefaultsTab` (no props). It is a `.set-stack` with two `set-section` cards:
  1. **"What people get by default"**: `SwitchGrid mode="defaults"` on a draft, with Save sending `{defaults: draft}`.
  2. **"Critical notifications"**: a `DataTable` (Notification, Category chip, Critical `Switch`; locked kinds show the "Always" pill; only kinds with `email: true` are listed), the foot note, and Save sending `{critical_kinds}`.

  Each section has its own Save (`btn-solid`), disabled until it differs from the last loaded settings. On success the draft resets from the response. Errors are sentences: `invalid_category`/`invalid_kind` → "That change isn't allowed."; `read_only_mode` → the server message; anything else → "Couldn't save. Try again." The tab's hint is "What everyone gets until they change it, and which notifications can't wait."

- [ ] **Step 1: Write the failing tests:**
  - **`Notifications.test.tsx`:**
    - The old "no tab strip at rank 60" becomes `test admin (60, global) sees Groups and Defaults`.
    - Super admin sees `[Groups, Defaults, Delivery log]`.
    - Rank 60 without global sees no strip.
    - `?tab=defaults` for a non-admin falls back to Groups.
    - The column labels contain no Categories/Channels/Quiet hours/Days.
    - The CSV header matches.
    - The fit test stays.
  - **`NotificationDefaultsTab.test.tsx`:**
    - It loads and renders both sections.
    - Save is disabled until a switch changes.
    - Saving sends only `defaults`.
    - Critical Save sends `critical_kinds`.
    - The locked kinds show "Always".
    - Never-emailed kinds are absent and the foot note shows.
    - A `read_only_mode` error shows the server message.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/pages/Notifications.test.tsx src/components/notifications src/styles`, then `npx tsc -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): notification defaults tab; groups list loses delivery columns`.

### Task 10: Group page, members and user page lose delivery settings (portal)

**Files:**
- Modify: `portal/src/pages/NotificationGroupDetail.tsx`. Remove the Delivery defaults panel, the hero `ChannelChips`, `EditSettingsModal` and `DND_LABELS`. Keep the hero name, Status chip, member count, description, Pause/Resume, Edit (`EditGroupModal`) and Delete.
- Modify: `portal/src/components/notifications/MembersPanel.tsx`. Columns are Person, Contact and Actions; the menu keeps Remove only. Remove the channels/quiet/days columns, Override markers, the Edit action, `OverrideEditorModal`, `CHANNEL_WARNING_TITLE`, and the channel parts of the add-picker sub-line. The empty-state copy is "No members yet."
- Modify: `portal/src/components/users/UserProfileTab.tsx` (the notification groups table drops Channels)
- Modify: `portal/src/lib/api.ts`:
  - delete `NotificationMemberOverrides`, `NotificationEffectiveSettings`, `NotificationGroupSettingsIn`, `updateNotificationMember` and `updateMyGroupOverrides`;
  - remove the delivery fields from `NotificationGroup`, `NotificationMember`, `MyNotificationGroup` and `UserNotificationGroup`.
- Delete: `EditSettingsModal.tsx` (+test), `OverrideEditorModal.tsx` (+test), `CategoryChips.tsx`, `ChannelChips.tsx`; in `lib/notificationGroups.ts`, `hasOverrides` and `EMPTY_OVERRIDES` (keep `GROUP_ERRORS`)
- Modify: `portal/src/styles/notifications.css` and `styles/settings.css`. Remove `.ngd-panel-head`, `.ngd-section`, `.ngd-switch-row`, `.ngd-cell-marker`, `.ov-body` and `.delivery-seg`, and any `.pf-form select` rule with no other user. Also remove the matching entries in `src/styles/listTypography.allow.json`.
- Test: `portal/src/pages/NotificationGroupDetail.test.tsx`, `portal/src/components/users/UserProfileTab.test.tsx`, `portal/src/pages/UserDetail.test.tsx`, `portal/src/lib/notificationGroups.test.ts`

**Interfaces:**
- Consumes: the Task 6 API shapes.

- [ ] **Step 1: Update the tests:**
  - **Delete:** the delivery-settings and override tests.
  - **Add:**
    - `test group page has no delivery settings`: no "Delivery defaults" and no "Edit settings".
    - `test members table columns`: Person, Contact and Actions.
    - `test member menu offers Remove only`.
    - `test user page groups table has no Channels column`.
- [ ] **Step 2: Run them to verify the new ones fail.**
- [ ] **Step 3: Implement.** Grep `portal/src` for every deleted name until none is left.
- [ ] **Step 4: Run** `npx vitest run src/pages src/components src/lib src/styles`, then `npx tsc -p .` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): group pages keep members only`.

### Task 11: Delivery log and Check delivery explain the new decision (portal)

**Files:**
- Modify: `portal/src/lib/deliveryLog.ts`:
  - `DELIVERY_LOG_EVENTS` adds `email_held` and `email_summarized`;
  - `EVENT_LABELS` adds "Held for summary" and "In summary";
  - `REASON_LABELS` keeps the retired codes for old rows and adds `admin_copy` "Admin copy — inbox only";
  - `outcomeOf`: `email_held` is amber and `email_summarized` blue;
  - `describeEntry`: `email_held` reads "Until {shortWhen(summary_at)} · {reason label}". `email_queued` reads "Due now", plus " · critical", " · owner's copy" or " · after the summary" from detail. Old rows keep "Held until …" (`detail.deferred`);
  - delete `VERDICTS` and `verdictOf`.
- Modify: `portal/src/lib/api.ts` (`DeliveryCheck` matches the Task 4 keys; delete `DeliveryCheckGroup`; `NotificationKindInfo` has `critical` and `locked` in place of `urgent`)
- Modify: `portal/src/components/notifications/CheckDeliveryModal.tsx`. Remove the Groups table and its notes. The result `dl.kv` shows:
  - **Inbox:** "In inbox", or "Not in inbox · {reason}", plus " · Company default" or " · Their choice".
  - **Email:** the outcome chip, then "until {summary time}" when held, the reason, and the address and its source.
  - **Their switches:** "Inbox on/off ({source}) · Email on/off ({source})", with Always for security.
  - **Their schedule:** "{zone} · {formatDays} · {formatQuietHours or 'No quiet hours'} · now {Open | In quiet hours | Day off}".
  - **Critical:** Yes or No.
- Test: `portal/src/lib/deliveryLog.test.ts`, `portal/src/components/notifications/CheckDeliveryModal.test.tsx`, `portal/src/components/notifications/DeliveryLogTab.test.tsx`, `portal/src/lib/api.deliveryLog.test.ts`

**Interfaces:**
- Consumes: the Task 4 `/check` and `/kinds` shapes.

- [ ] **Step 1: Write the failing tests:**
  - `EVENT_LABELS` pin with the two new events;
  - `describeEntry` for `email_held` and the `email_queued` variants;
  - old `deferred` rows still read "Held until";
  - Check delivery renders a held answer with its summary time, the switch sources and the schedule line;
  - Check delivery has no Groups table;
  - the "no select, no bare checkbox" assertion stays.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib src/components/notifications src/styles`, then `npx tsc -p .` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): delivery log and check delivery explain holding and the summary`.

### Final verification (controller)

- [ ] **Full API suite:** `cd api && SS_TEST_DB=serversherpa_test_notif_phase1 PYTHONPATH=src .venv/bin/pytest -q -p no:cacheprovider`, in the background with a log file. It takes about 90 minutes. Known full-run-only failures: the 3 corrupt-image label tests, which pass alone.
- [ ] **Full portal suite and build:** `cd portal && npx vitest run && npm run build`.
- [ ] **Live check** on a scratch copy of the dev DB: the worktree API on 0.0.0.0 and the portal with `VITE_API_URL` at the LAN IP. Do not run the notification-worker loop against the copy; call `run_summaries_once` and `deliver_once` on demand. Check:
  - /me grid and schedule;
  - the Defaults tab as admin, and no strip as staff;
  - a held email showing in the Delivery log and Check delivery;
  - the summary email in Mailpit.
