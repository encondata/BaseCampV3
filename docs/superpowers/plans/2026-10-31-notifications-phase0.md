# Notifications Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the notification settings honest, re-check emails before they send, and log every delivery decision where super admins can troubleshoot it.

**Architecture:** One new table (`notification_log`) written by a small sync helper from the three places decisions happen — `notify()`, `enqueue()` and the outbox delivery loop. The email decision moves into one function (`decide_email`) shared by `maybe_email()` and a read-only Check delivery endpoint. Portal changes are presentational except two new surfaces: a `/notifications` page and a Delivery log tab on System › Notifications.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, PostgreSQL, pytest (real Postgres); React 18 + TypeScript, Vite, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-31-notifications-phase0-design.md`

## Global Constraints

- American English everywhere (copy, comments, commit messages). Before committing UI copy, grep the changed files for `-ise|-isation|colour|enrol\b|enrolment|behaviour|centre|licence`.
- Worktree: `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/notif-phase0`, branch `notif-phase0`. Work only there.
- API tests: `cd api && SS_TEST_DB=serversherpa_test_notif_phase0 PYTHONPATH=src .venv/bin/pytest <files> -q -p no:cacheprovider`. `PYTHONPATH=src` is required (the shared venv otherwise imports the main checkout's code).
- Portal tests: `cd portal && npx vitest run <files>`; typecheck: `cd portal && npx tsc -p .`; guardrails: `cd portal && npx vitest run src/styles`.
- Run every test command in the FOREGROUND in one continuous run with a 600000 ms timeout. Never background a suite and end your turn waiting.
- Never use bare `git stash`. Never commit `api/src/serversherpa/_dev_reload.py` (restore it with `git checkout -- api/src/serversherpa/_dev_reload.py` if a test run touched it).
- Commit trailer, exactly: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `notify()`, `enqueue()` and `record()` add to the caller's session and never commit.
- Neither a `notification_log` row's `detail` nor a log line may contain an email address or a message body.
- Super admin and above = `actor.access.is_global and actor.access.max_rank >= SUPER_ADMIN_RANK` (80); otherwise 403 `{"code": "forbidden"}`. Portal mirror: `maxRank >= SUPER_ADMIN_RANK && !!scope?.global`.
- Live channels in the portal: `LIVE_CHANNELS = ['email']`. The API channel list (`email`, `text`, `push`, `web`) and stored values do not change.
- Log retention: the logging config key `local_max_age_days`. No new numbers.
- Migration: revision `"0110"`, down_revision `"0109"`. (The unmerged `project-plans` branch also uses 0110; whichever merges second rechains — not this plan's job.)
- Portal UI reuses house controls: `.segmented` (with `aria-pressed`), ComboBox, `.org-select`, chips (`.chip`), `RowActionsMenu`, `.pf-form`, `Switch`, `.dir-search`, `DataTable`. No raw `<select>`, `<input type="time">` or bare checkbox in touched notification UI.
- Lists follow the list-column-floors recipe (`ColumnDef` with `min`/`short`, `listGridStyle`, `ColHead`, `list-scroll`, `cell-line` + `titleFor`) and keep a fit test (`minWidth <= LIST_FIT.page`).
- Modals: the shared `NotificationModal` shell (Task 7) for every notification modal; rounded corners and portaled dropdowns are enforced by `src/styles/modalCorners.test.ts` and `modalDropdowns.test.ts`.

## Review Focus

- A deferred email whose inbox row was cleared by the bell's "Mark all read" before the window opened must be dropped with reason `read`, not sent (Task 3).
- An account-security email must send even if the owner read or hid the inbox item the instant it arrived (Task 3).
- Saving group settings or overrides for a group whose stored channels are `["text", "push", "web"]` must keep those values and only change Email (Task 7).
- A person whose saved choice is Inbox + Email but who has no emailing group sees "Inbox only" selected; after joining a group the same page shows "Inbox + Email" with no extra click (Task 8).
- An admin (rank 60) or a super admin without global access gets 403 from both delivery-log endpoints and never sees the Delivery log tab (Tasks 5 and 10).

---

### Task 1: Delivery-log storage and writer

**Files:**
- Create: `api/migrations/versions/0110_notification_delivery_log.py`
- Modify: `api/src/serversherpa/db/models.py` (add `NotificationLog` after `Notification`; add `EmailOutbox.skip_reason`)
- Create: `api/src/serversherpa/notifications/delivery_log.py`
- Modify: `api/src/serversherpa/system/db_logging.py` (add `installed_process`)
- Modify: `api/src/serversherpa/system/log_service.py` (`enforce_retention`)
- Test: `api/tests/test_notification_delivery_log.py` (new), `api/tests/test_log_service.py`

**Interfaces:**
- Produces: table `notification_log` — `id BIGSERIAL PK`, `at TIMESTAMPTZ NOT NULL DEFAULT now()`, `event TEXT NOT NULL` (CHECK in `EVENTS`), `channel TEXT NOT NULL` (CHECK in `inbox, email, text, push`), `person_id UUID NULL → people ON DELETE SET NULL`, `notification_id UUID NULL → notifications ON DELETE SET NULL`, `outbox_id UUID NULL → email_outbox ON DELETE SET NULL`, `kind TEXT NULL`, `category TEXT NULL`, `reason TEXT NULL`, `detail JSONB NOT NULL DEFAULT '{}'`, `process TEXT NULL`; indexes on `(at)`, `(person_id, id)`, `(notification_id)`, `(outbox_id)`. `email_outbox.skip_reason TEXT NULL`.
- Produces: ORM `NotificationLog` (same columns) and `EmailOutbox.skip_reason: Mapped[str | None]`.
- Produces in `notifications/delivery_log.py`:
  - `EVENTS: tuple[str, ...] = ("inbox_written", "inbox_suppressed", "email_queued", "email_not_queued", "email_sent", "email_skipped", "email_retry", "email_failed")`
  - `LOG_CHANNELS: tuple[str, ...] = ("inbox", "email")`
  - `def record(db: AsyncSession, event: str, *, channel: str, person_id: uuid.UUID | None = None, notification_id: uuid.UUID | None = None, outbox_id: uuid.UUID | None = None, kind: str | None = None, category: str | None = None, reason: str | None = None, detail: dict | None = None) -> NotificationLog` — synchronous: `db.add()` only (no flush, no commit); `at=datetime.now(UTC)`; `process=installed_process()`; `ValueError` for an event not in `EVENTS` or a channel not in `LOG_CHANNELS`; also logs one INFO line on logger `serversherpa.notifications.log` carrying the event, channel, kind, person/notification/outbox ids and reason only.
- Produces in `system/db_logging.py`: `def installed_process() -> str | None` — the process name `install()` registered in this process, else None.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_notification_delivery_log.py`:
  - `test_record_adds_a_row` — `record(db, "inbox_written", channel="inbox", person_id=p.id, kind="report_ready", category="reports")`, flush, query `NotificationLog`: one row, `event == "inbox_written"`, `detail == {}`, `at` aware.
  - `test_record_rejects_unknown_event_and_channel` — `pytest.raises(ValueError)` for `event="nope"` and for `channel="fax"`.
  - `test_record_line_carries_ids_not_detail` — with `caplog` at INFO on `serversherpa.notifications.log`, record with `detail={"note": "secret-body"}`: the message contains the event and person id, not `"secret-body"`.
  - `test_record_stamps_the_installed_process` — monkeypatch `serversherpa.system.db_logging._installed` to `{"api": object()}`: row `process == "api"`; empty dict → `None`.
  - `test_deleting_the_notification_keeps_the_log_row` — create a `Notification`, record with its id, delete the notification, commit: the log row remains with `notification_id is None`.
  - In `test_log_service.py`, `test_retention_deletes_old_notification_log_rows` — insert one `NotificationLog` with `at` older than `local_max_age_days` and one fresh; `enforce_retention(db)`; only the fresh row remains and the returned `deleted` count includes the old one.
- [ ] **Step 2: Run them to verify they fail** — `… pytest tests/test_notification_delivery_log.py tests/test_log_service.py` → FAIL (import error / missing table).
- [ ] **Step 3: Write the migration** (upgrade creates the table, indexes and the outbox column; downgrade drops them), the ORM model and column, `installed_process()`, `record()`, and the retention delete (`DELETE FROM notification_log WHERE at < :cutoff`, same cutoff as `log_entries`, added to `deleted`).
- [ ] **Step 4: Run the tests to verify they pass**, plus `tests/test_mail_outbox.py tests/test_mail_delivery.py` (unchanged behavior) → PASS.
- [ ] **Step 5: Upgrade the test DB path is exercised by conftest; also confirm `alembic heads` shows one head** — `cd api && PYTHONPATH=src .venv/bin/alembic heads` → `0110 (head)`.
- [ ] **Step 6: Commit** — `feat(notifications): notification_log table and delivery-log writer`.

### Task 2: One email decision, logged at notify time

**Files:**
- Modify: `api/src/serversherpa/notifications/email_rule.py` (add `group_verdict`)
- Modify: `api/src/serversherpa/notifications/email.py` (`GroupVerdict`, `EmailDecision`, `decide_email`, `_group_settings`, `maybe_email`)
- Modify: `api/src/serversherpa/notifications/inbox.py` (`notify` records inbox events)
- Modify: `api/src/serversherpa/mail/outbox.py` (`enqueue` records `email_queued`)
- Test: `api/tests/test_notification_email_rule.py`, `api/tests/test_notification_email.py`, `api/tests/test_mail_outbox.py`

**Interfaces:**
- Consumes: `record()` from Task 1.
- Produces in `email_rule.py`: `def group_verdict(s: dict, now: datetime, *, urgent: bool) -> tuple[str, datetime | None]` — returns `("no_email_channel", None)` when `"email"` is not in `s["channels"]`; `("urgent_bypass", now_utc)` when urgent and `urgent_bypass`; `("open", now_utc)` when open; otherwise `("inactive_day" | "quiet_hours", allowed_at(s, now, urgent=urgent))` — `inactive_day` when today is not an active day, else `quiet_hours`; the second item is None when the group skips or nothing opens within the horizon. `email_send_time` keeps its behavior.
- Produces in `email.py`:
  - `_group_settings(db, person_id, category) -> list[dict]` — each dict also carries `"group_id"` and `"group_name"`.
  - `@dataclass(frozen=True) class GroupVerdict: group_id: uuid.UUID; name: str; verdict: str; allowed_at: datetime | None`
  - `@dataclass(frozen=True) class EmailDecision: queue: bool; send_at: datetime | None; reason: str | None; address: str | None; address_source: str | None; owner_copy: bool; groups: tuple[GroupVerdict, ...]` — `address_source` is `"contact"` or `"login"`; `reason` is the not-queued code when `queue` is False, else the deferral reason (`quiet_hours` / `inactive_day`) when `send_at > now`, else None.
  - `async def decide_email(db: AsyncSession, person_id: uuid.UUID, info: KindInfo | None, *, owner_notice: bool, choice: str, contact: Contact | None, now: datetime) -> EmailDecision` — checks in this order, first match wins: not `email_enabled()` → `email_not_set_up`; `info is None` → `unregistered_kind`; `not info.email` → `kind_not_emailed`; `choice == "off"` → `category_off`; `choice == "inbox"` → `category_inbox_only`; contact missing or inactive → `recipient_inactive`; no address (owner copy: login email then contact; otherwise contact address) → `no_address`; owner copy → queue now (no groups); no enabled subscribed group with Email in its effective channels → `no_email_group`; no group allows it within the horizon → `blocked_by_schedule`; else queue at the earliest `allowed_at`. Loads the contact when None is passed.
  - `maybe_email(...)` keeps its signature; it calls `decide_email(now=_now())`, then either `enqueue(..., log_detail={"reason": …, "groups": [names of groups whose verdict allowed it], "via": decision.address_source})` (omit keys whose value is None/empty) or `record(db, "email_not_queued", channel="email", person_id=…, notification_id=…, kind=…, category=…, reason=decision.reason)`.
- Produces in `inbox.py`: `notify()` records `inbox_written` (with `notification_id`, `kind`, `category` when registered) after the row is flushed, and `inbox_suppressed` with reason `category_off` when it returns None.
- Produces in `mail/outbox.py`: `enqueue(..., log_detail: dict | None = None, **ctx)` records `email_queued` after the flush with `outbox_id=row.id`, `person_id`, `notification_id`, `kind=kind or template`, `category` (registered kinds only, via `kind_info`), `detail={"template": template, "send_at": <iso>, "deferred": send_at > now, **log_detail}`.

- [ ] **Step 1: Write the failing tests.**
  - `test_notification_email_rule.py`: `test_group_verdict_open`, `test_group_verdict_quiet_hours_with_its_open_time`, `test_group_verdict_inactive_day`, `test_group_verdict_urgent_bypass`, `test_group_verdict_no_email_channel`, `test_group_verdict_skip_is_never` (`dnd_behavior="skip"` in quiet hours → `("quiet_hours", None)`), using the file's existing settings-dict helpers and a fixed Wednesday 15:00 UTC.
  - `test_notification_email.py` (reuse `_person`, `_group`, `_prefs`, `fixed_now`, `email_on`):
    - `test_notify_logs_inbox_written` — one `inbox_written` row with the notification id, kind and category.
    - `test_off_logs_inbox_suppressed` — `_prefs(reports="off")`: `notify` returns None and one `inbox_suppressed` row with reason `category_off`, `notification_id is None`.
    - `test_not_emailed_reasons_are_logged` — parametrized over: SMTP off (no `email_on`) → `email_not_set_up`; no group → `no_email_group`; `_prefs(reports="inbox")` → `category_inbox_only`; no address → `no_address`; skip in quiet hours → `blocked_by_schedule`. Each writes exactly one `email_not_queued` row with that reason.
    - `test_queued_now_logs_email_queued` — subscribed group: one `email_queued` row with `outbox_id` of the outbox row, `detail["deferred"] is False`, `detail["via"] == "contact"`, and no key whose value contains the address.
    - `test_deferred_logs_the_reason_and_group` — quiet hours defer: `detail["deferred"] is True`, `detail["reason"] == "quiet_hours"`, the group's name in `detail["groups"]`, `detail["send_at"]` equals the outbox row's `next_attempt_at` (ISO).
    - `test_decide_email_matches_maybe_email` — for the queued-now and deferred cases, `decide_email(...)` returns `queue=True` with the same `send_at` the outbox row got.
  - `test_mail_outbox.py`: `test_enqueue_logs_template_mail` — `enqueue(db, "password_reset", "x@test.example.com", person_id=p.id, …)`: one `email_queued` row, `kind == "password_reset"`, `category is None`, `detail["template"] == "password_reset"`.
- [ ] **Step 2: Run them to verify they fail** — `… pytest tests/test_notification_email_rule.py tests/test_notification_email.py tests/test_mail_outbox.py`.
- [ ] **Step 3: Implement** `group_verdict`, the dataclasses, `decide_email`, the `_group_settings` keys, `maybe_email`, the `notify()` events and the `enqueue()` event. Keep every existing `test_notification_email.py` case passing unchanged (the decision order above matches today's `maybe_email`).
- [ ] **Step 4: Run the tests to verify they pass**, plus `tests/test_notification_*.py tests/test_wiki_notify.py tests/test_learning_emails.py tests/test_reset_request_cards.py tests/test_password_reset_service.py` → PASS.
- [ ] **Step 5: Commit** — `feat(notifications): one email decision, logged when a notification is created`.

### Task 3: Re-check before sending, and delivery logging

**Files:**
- Modify: `api/src/serversherpa/notifications/email.py` (add `recheck_before_send`)
- Modify: `api/src/serversherpa/mail/delivery.py` (`_deliver`, `deliver_once`)
- Test: `api/tests/test_mail_delivery.py`

**Interfaces:**
- Consumes: `record()` (Task 1); `load_contact`, `personal_choice`, `_group_settings` (Task 2).
- Produces: `async def recheck_before_send(db: AsyncSession, row: EmailOutbox) -> str | None` — None when the email should still go. Returns None at once for `row.kind is None` (not notification mail), an unregistered kind, or a `security`-category kind. Otherwise, in order: `notification_gone` (no `notification_id`, or the row is missing), `hidden` (`dismissed_at`), `read` (`read_at`), `resolved` (payload `state` present and not in `pending`/`open`), `recipient_inactive`, `category_turned_down` (`personal_choice != "email"`), `no_email_group` (no enabled subscribed group with Email in effective channels).
- Produces: `_deliver(db: AsyncSession, row: EmailOutbox, send) -> None` (now takes the session). SMTP off → `status="skipped"`, `skip_reason="email_not_set_up"`, record `email_skipped`. Re-check reason → `status="skipped"`, `skip_reason=<reason>`, record `email_skipped`. Success → record `email_sent` with `detail={"attempt": n}`. Failure → record `email_retry` (`detail={"attempt", "error": <exception class name>, "smtp_code", "next_attempt_at"}`) or, on the last attempt, `email_failed` (`detail={"attempts", "error", "smtp_code"}`). Every record carries `person_id`, `notification_id`, `outbox_id=row.id`, `kind=row.kind or row.template`, `category` for registered kinds. Error text never goes into `detail` (it can embed addresses); `last_error` keeps it as today.

- [ ] **Step 1: Write the failing tests** in `test_mail_delivery.py` (queue rows through `notify()` with a subscribed group so they are real notification mail; `email_on`; `deliver_once(get_sessionmaker(), send=FakeSend())`):
  - `test_read_before_send_is_dropped` — mark the notification read, deliver: send not called, row `status == "skipped"`, `skip_reason == "read"`, one `email_skipped` log row with reason `read`.
  - `test_hidden_before_send_is_dropped` → `hidden`.
  - `test_decided_approval_is_dropped` — payload `state="approved"` → `resolved`; payload `state="pending"` still sends.
  - `test_category_turned_down_since_is_dropped` — set `ui_prefs` category to `inbox` after queueing → `category_turned_down`.
  - `test_left_the_group_since_is_dropped` — delete the membership after queueing → `no_email_group`.
  - `test_disabled_recipient_is_dropped` — set `UserAccount.disabled_at` → `recipient_inactive`.
  - `test_security_mail_sends_even_when_read_or_hidden` — `password_expiring` owner notice, then read and hide it: sent.
  - `test_template_mail_is_not_rechecked` — a `password_reset` row: sent.
  - `test_smtp_off_records_email_not_set_up` — without `email_on`: `skip_reason == "email_not_set_up"`.
  - `test_delivery_outcomes_are_logged` — success → `email_sent` with `detail["attempt"] == 1`; `FakeSend(OSError("x"))` → `email_retry` with `detail["error"] == "OSError"`; after `MAX_ATTEMPTS` → `email_failed`; no row's `detail` contains the to-address.
- [ ] **Step 2: Run them to verify they fail** — `… pytest tests/test_mail_delivery.py`.
- [ ] **Step 3: Implement** `recheck_before_send` and the `_deliver` changes (import `recheck_before_send` inside `_deliver` if a module-level import cycles).
- [ ] **Step 4: Run** `tests/test_mail_delivery.py tests/test_mail_outbox.py tests/test_notification_*.py tests/test_learning_emails.py tests/test_password_reset_service.py` → PASS.
- [ ] **Step 5: Commit** — `feat(notifications): re-check notification email before sending; log delivery outcomes`.

### Task 4: Inbox paging, categories, and decided approvals marked read

**Files:**
- Modify: `api/src/serversherpa/api/routes/notifications.py` (`inbox`)
- Modify: `api/src/serversherpa/api/schemas.py` (`NotificationInboxItemOut`, `NotificationInboxOut`)
- Modify: `api/src/serversherpa/notifications/requests.py` (`resolve_copies`), `api/src/serversherpa/services/router_agent.py` (`resolve_router_copies`), `api/src/serversherpa/notifications/reset_requests.py` (`resolve`)
- Test: `api/tests/test_notifications_inbox.py`, `api/tests/test_notification_requests_service.py`, `api/tests/test_devices_router_approval_api.py`, `api/tests/test_reset_request_cards.py`

**Interfaces:**
- Produces: `GET /notifications/inbox?cursor=&limit=&category=&unread_only=` — `limit` default 50, clamped to 1..100; `category` must be a `CATEGORY_KEYS` value (422 `invalid_category`); order `created_at DESC, id DESC`; keyset on `(created_at, id)`; cursor = base64url of `"<created_at ISO>|<uuid>"` (422 `invalid_cursor` when it does not decode). Response adds `next_cursor: str | None` and `total: int` (rows matching the filters); `unread_count` stays the person's overall unread count; each item adds `category: str | None` (from `KINDS`, None when unregistered). Calls with no new params behave exactly as today.
- Produces: the three resolve functions also set `read_at = COALESCE(read_at, now())` when the new state is not `pending`/`open`; payload merging is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `test_notifications_inbox.py`: `test_inbox_pages_without_gaps_or_repeats` (five rows, three sharing one `created_at`; `limit=2` pages until `next_cursor` is None; ids collected equal all five in order); `test_inbox_category_filter_and_item_category` (a `wiki_comment` and a `report_ready` row; `?category=wiki` returns only the wiki row with `category == "wiki"`; an unregistered kind has `category is None`); `test_inbox_total_counts_the_filter`; `test_inbox_rejects_bad_category_and_cursor` (422 with the two codes); `test_inbox_default_call_unchanged` (no params → at most 50, newest first, `unread_count` overall).
  - `test_notification_requests_service.py`: `test_decided_request_marks_every_copy_read` — two approvers' copies, approve: both have `read_at` set and payload `state == "approved"`.
  - `test_devices_router_approval_api.py`: `test_approving_marks_router_copies_read`.
  - `test_reset_request_cards.py`: `test_resolving_marks_cards_read`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** the inbox params, cursor helpers (`_encode_inbox_cursor(created_at: datetime, id: uuid.UUID) -> str`, `_decode_inbox_cursor(cursor: str) -> tuple[datetime, uuid.UUID]` in `routes/notifications.py`), schema fields, and the three `read_at` updates.
- [ ] **Step 4: Run** the four test files plus `tests/test_notification_*.py tests/test_router_agent_api.py` → PASS.
- [ ] **Step 5: Commit** — `feat(notifications): page and filter the inbox; decided approvals read for everyone`.

### Task 5: Delivery log and Check delivery endpoints; "can email" fix

**Files:**
- Modify: `api/src/serversherpa/api/deps.py` (add `ensure_super_admin`), `api/src/serversherpa/api/routes/system.py` (use it instead of `_require_super_admin`)
- Create: `api/src/serversherpa/notifications/check.py`
- Modify: `api/src/serversherpa/notifications/kinds.py` (add `CATEGORY_EMAIL_SOURCE`)
- Modify: `api/src/serversherpa/api/routes/notifications.py` (`delivery_log`, `check_delivery`, `list_kinds`, `capabilities` and its callers), `api/src/serversherpa/api/routes/me.py` (`update_my_overrides` passes the account email)
- Modify: `api/src/serversherpa/api/schemas.py` (`DeliveryLogEntryOut`, `DeliveryLogPageOut`, `DeliveryCheckGroupOut`, `DeliveryCheckOut`)
- Test: `api/tests/test_notification_log_api.py` (new), `api/tests/test_notification_groups_api.py`

**Interfaces:**
- Consumes: `NotificationLog` (Task 1); `decide_email`, `GroupVerdict`, `group_verdict`, `load_contact`, `personal_choice` (Task 2).
- Produces: `def ensure_super_admin(actor: AuthContext) -> None` in `deps.py` (403 `{"code": "forbidden"}` unless global and `max_rank >= SUPER_ADMIN_RANK`).
- Produces: `GET /notifications/log` (`require_permission("notifications", "view")` + `ensure_super_admin`) with params `cursor` (stringified id), `limit` (default 100, 1..500), `q` (ILIKE on person display name, notification title, or `kind`), `event` (repeatable; each must be in `EVENTS`, else 422 `invalid_event`), `channel`, `category`, `since` (aware datetime), `person_id`, `notification_id`, `outbox_id`. Order `id DESC`. Returns `DeliveryLogPageOut(rows, next_cursor, total)`; `DeliveryLogEntryOut` = `id, at, event, channel, reason, kind, kind_label` (`KINDS[kind].label`, else the kind/template string), `category, detail, process, person_id, person_name, notification_id, notification_title, notification_link, outbox_id, to_address, outbox_status` (the last two from the joined `email_outbox` row).
- Produces in `kinds.py`: `CATEGORY_EMAIL_SOURCE: dict[str, str] = {"approvals": "groups", "reports": "groups", "wiki": "groups", "learning": "groups", "security": "always"}` — where a category's email permission comes from (`"direct"` is reserved for a later category whose email follows the /me choice alone).
- Produces in `notifications/check.py`: `async def check_delivery(db: AsyncSession, person_id: uuid.UUID, kind: str, *, owner_copy: bool | None = None, now: datetime) -> dict` — writes nothing. `info = KINDS[kind]`; `owner_notice = info.owner_always and (owner_copy is not False)` (an owner-always kind models the owner's own copy unless `owner_copy=False` asks for an admin's copy). Calls `decide_email(db, person_id, info, owner_notice=…, choice=personal_choice(info, contact), contact=contact, now=now)`. Returns the `DeliveryCheckOut` fields: `person_id, person_name, kind, kind_label, category, email_source, owner_copy` (the value used), `active, has_account, choice, inbox` (`"suppressed"` when the choice is `off` and `info.email`, else `"written"` — the same rule as `notify()`), `email_enabled, outcome` (`"now"` | `"held"` | `"not_sent"`), `send_at, reason, address, address_source, groups` — one entry per group the person belongs to (paused or not): `group_id, name, enabled, subscribed, email_channel, verdict` (`group_verdict` result for enabled+subscribed groups, else `"paused"` or `"not_subscribed"`), `allowed_at, quiet_start, quiet_end, timezone, active_days` (effective values).
- Produces: `GET /notifications/check?person_id=&kind=&owner_copy=` (same gate) → `DeliveryCheckOut`; 404 `person_not_found`; 422 `invalid_kind` for an unregistered kind.
- Produces: `GET /notifications/kinds` (same gate) → `list[NotificationKindOut]` with `kind, label, category, email, owner_always, urgent`, in `KINDS` order.
- Produces: `capabilities(person: Person, has_account: bool, account_email: str | None = None) -> dict[str, bool]` with `can_email = bool(person.email or account_email)`; every caller passes the account email (select `UserAccount.email` where the query selects `UserAccount.person_id` today).

- [ ] **Step 1: Write the failing tests** in `test_notification_log_api.py` (sign in with `tests.test_status_values_write._make(db, client, role, email)`, which returns auth headers for a user holding `role`; a non-global super admin is a `PersonRole(role="super_admin", client_id=<a Client>)` like `tests/test_access_resolver.py` builds; seed log rows with `record()`):
  - `test_log_requires_super_admin` — admin (60) → 403; super admin without global scope → 403; super admin (80, global) → 200; developer → 200. Same three for `/notifications/check`.
  - `test_log_pages_newest_first` — 5 rows, `limit=2`: three pages, ids descending, `total == 5`.
  - `test_log_filters` — `event` (two values), `channel`, `category`, `person_id`, `notification_id`, `outbox_id`, `since`, `q` (person name) each narrow correctly; unknown event → 422 `invalid_event`.
  - `test_log_entry_joins_names_and_address` — a queued notification email: entry has `person_name`, `notification_title`, `to_address`, `outbox_status == "queued"`, `kind_label == "Report ready"`.
  - `test_check_explains_without_writing` — counts of `notifications`, `email_outbox`, `notification_log` unchanged after a call.
  - `test_check_outcomes` (kind `report_ready` unless noted) — subscribed open group → `outcome == "now"`; quiet hours defer → `"held"` with `reason == "quiet_hours"` and `send_at`; no group → `"not_sent"` / `no_email_group`; choice off → `inbox == "suppressed"`, `reason == "category_off"`; paused and unsubscribed groups listed with `"paused"` / `"not_subscribed"`; `password_expiring` → `"now"`, `owner_copy is True`, `address_source == "login"`; `totp_enrolled` with `owner_copy=false`, a security-subscribed group in quiet hours with urgent bypass → `"now"` and that group's verdict `"urgent_bypass"`; `password_reset_request` with choice off → `inbox == "written"`, `"not_sent"` / `kind_not_emailed`; unknown kind → 422 `invalid_kind`.
  - `test_kinds_lists_the_registry` — `GET /notifications/kinds` returns every `KINDS` key in order with its label, category and flags; admin (60) → 403.
  - In `test_notification_kinds.py`: `test_every_category_has_an_email_source` — `set(CATEGORY_EMAIL_SOURCE) == set(CATEGORY_KEYS)` and every value is in `{"groups", "always", "direct"}`.
  - In `test_notification_groups_api.py`: `test_member_with_only_a_login_email_can_email` — person without `Person.email` but with an account email: `can_email` True in the group detail and recipients list, and an Email channel override is accepted (no `channel_unavailable`).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** `ensure_super_admin` (system.py keeps behavior), the schemas, both routes, `check.py`, and the `capabilities` change.
- [ ] **Step 4: Run** `tests/test_notification_log_api.py tests/test_notification_groups_api.py tests/test_notification_self_service.py tests/test_system*.py` → PASS.
- [ ] **Step 5: Commit** — `feat(notifications): delivery log and check-delivery endpoints for super admins`.

### Task 6: Portal lists show live channels and categories, in one format

**Files:**
- Modify: `portal/src/lib/notifications.ts` (add `LIVE_CHANNELS`, `liveChannels`; keep the `CHANNEL_NOTES` export for now — EditSettingsModal still imports it until Task 7 removes both)
- Modify: `portal/src/lib/notificationGroups.ts` (remove `quietHoursText`, `daysText`)
- Create: `portal/src/components/notifications/ChannelChips.tsx`, `portal/src/components/notifications/CategoryChips.tsx`
- Modify: `portal/src/pages/Notifications.tsx`, `portal/src/pages/NotificationGroupDetail.tsx`, `portal/src/components/notifications/MembersPanel.tsx`, `portal/src/pages/me/GroupsList.tsx`
- Test: `portal/src/lib/notifications.test.ts`, `portal/src/lib/notificationGroups.test.ts`, `portal/src/pages/Notifications.test.tsx`, `portal/src/pages/NotificationGroupDetail.test.tsx`, `portal/src/pages/me/MeNotifications.test.tsx`

**Interfaces:**
- Produces: `export const LIVE_CHANNELS: readonly Channel[] = ['email'];` and `export function liveChannels(channels: readonly string[]): Channel[]` (live only, `CHANNELS` order).
- Produces: `ChannelChips({ channels }: { channels: readonly string[] })` — a chip per live channel (`c-blue` for Email), or a `c-slate` "No email" chip when none. `CategoryChips({ categories }: { categories: readonly string[] })` — `chip tag` per label in registry order (`categoryLabels`), or a `c-slate` "None — inbox only" chip.
- Behavior: System › Notifications list gets a default-on `categories` column (CategoryChips; search text, sort key, CSV column "Categories" = labels joined by `; ` or `None`), a Categories facet (each category + `none` "None"), and the Channels column/facet/export/search use `liveChannels` (facet options: live channels + `none` "No email"). Group detail: header chips and Delivery defaults › Channels use live channels (no "not available yet" note). MembersPanel: member channel cells show live effective channels or "No email"; the recipients picker's reachability text uses live channels; the email-unavailable text is "No email address". GroupsList: a `categories` column after Group; member rows show their effective channels, quiet hours and days (`g.effective`), joinable rows the group's; quiet hours via `formatQuietHours`, days via `formatDays`, both `cell-nowrap cell-line`.

- [ ] **Step 1: Write the failing tests.**
  - `notifications.test.ts`: `liveChannels(['web','text','email','push'])` → `['email']`; `liveChannels(['text'])` → `[]`.
  - `Notifications.test.tsx`: a group with `categories: ['wiki','approvals']` renders "Approvals & requests" then "Wiki" chips; empty → "None — inbox only"; channels `['email','web','text']` render only "Email"; `['text','push']` render "No email"; the existing fit assertion still holds with the new default column.
  - `NotificationGroupDetail.test.tsx`: header shows "Email" only for `['email','web']`; no "not available yet" text anywhere.
  - `MeNotifications.test.tsx`: GroupsList shows the Categories column; a member whose `effective.channels` is `['text']` shows "No email"; quiet hours render `9:00 PM – 7:00 AM CT` for `21:00:00`/`07:00:00`/`America/Chicago` and days `Mon–Fri`; the fit assertion still holds.
  - Remove the `quietHoursText`/`daysText` cases from `notificationGroups.test.ts`.
- [ ] **Step 2: Run them to verify they fail** — `npx vitest run src/lib/notifications.test.ts src/pages/Notifications.test.tsx src/pages/NotificationGroupDetail.test.tsx src/pages/me/MeNotifications.test.tsx`.
- [ ] **Step 3: Implement.** If the new default column breaks a fit test, raise a column's `short` label or narrow a `min` first; only if that cannot fit, make `created` (admin list) or `members` (GroupsList) non-default.
- [ ] **Step 4: Run** the notification portal tests, `npx vitest run src/styles`, and `npx tsc -p .` → PASS.
- [ ] **Step 5: Commit** — `feat(portal): group lists show live channels and categories in one format`.

### Task 7: Notification modals use house controls and the standard header

**Files:**
- Create: `portal/src/components/notifications/NotificationModal.tsx`
- Create: `portal/src/lib/timeChoices.ts` (move `TIME_CHOICES` and `timeLabel` from `portal/src/components/learning/initiativeLearning.ts`; that file re-exports them so learning imports keep working)
- Modify: `portal/src/components/notifications/EditSettingsModal.tsx`, `OverrideEditorModal.tsx`, `EditGroupModal.tsx`, `MembershipRequestModal.tsx`; the `NewGroupModal` in `portal/src/pages/Notifications.tsx`
- Test: `portal/src/components/notifications/EditSettingsModal.test.tsx` (new), `OverrideEditorModal.test.tsx` (new), existing page tests that open these modals

**Interfaces:**
- Produces: `NotificationModal({ eyebrow, title, description, label, onClose, busy = false, wide = false, className = '', children, footer }: { eyebrow: string; title: string; description?: ReactNode; label?: string; onClose: () => void; busy?: boolean; wide?: boolean; className?: string; children: ReactNode; footer?: ReactNode })` — the same markup and behavior as `components/learning/LearningModal.tsx` (scrim close unless busy, Escape, `modal-card rgm-card`, header `rgm-head-text` with `.eyebrow`, `h3`, `p.page-hint`, close button) without the learning classes; imports `styles/reports.css`.
- Produces: `lib/timeChoices.ts` exports `TIME_CHOICES: string[]` (96 `HH:MM` quarter hours) and `timeLabel(hhmm: string): string` (12-hour label), plus `function timeOptions(current: string | null): { value: string; label: string }[]` — the grid, with `current` (normalized to `HH:MM`) inserted in order when off-grid.
- Copy (eyebrow · title · description):
  - New group: "Notifications" · "New notification group" · "Name the group. Delivery settings and members come next."
  - Edit group: "Notification group" · "Edit group" · "Rename the group or change its description."
  - Group settings: "Notification group" · "Delivery settings" · "Defaults every member inherits unless they set their own."
  - Overrides (admin): "Notification group" · "Overrides — {name}" · "{first name}'s own settings for this group. Anything on Group default follows the group." Self-service (`onSave` passed): "Your settings" · "My settings — {group}" · "Anything on Group default follows the group."
  - Membership request: "Notification groups" · "Ask to join {group}" / "Ask to leave {group}" · "An admin approves the request. Add a note if it helps."
- Behavior: Group settings — Channels shows a Switch for each live channel only; Quiet hours `.segmented` Off | Custom; Start/End ComboBoxes from `timeOptions`; When blocked `.segmented` "Defer until window opens" | "Skip entirely"; on save `channels` = live selections plus any stored non-live channels (unchanged order per `CHANNELS`), and the patch omits `channels` when that equals the stored list. Overrides — each dropdown becomes `.segmented`: Channels Group default | Custom; Active days Group default | Custom; Quiet hours Group default | None | Custom; Timezone Group default | Custom; When blocked Group default | Defer | Skip; Urgent bypass Group default | On | Off; the group's value appears as a `cell-sub` hint under each control ("Group default: 9:00 PM – 7:00 AM CT"); custom channels list only live channels and the saved override keeps stored non-live ones.

- [ ] **Step 1: Write the failing tests.**
  - `EditSettingsModal.test.tsx`: renders no `select` and no `input[type="time"]`; shows the eyebrow and description; for a group with `channels: ['email','text','push','web']`, turning Email off saves `channels: ['text','push','web']`; changing only the quiet window saves no `channels` key; picking "Custom" and Start "9:00 PM" saves `quiet_start: '21:00'`; an off-grid stored `21:10:00` appears as "9:10 PM".
  - `OverrideEditorModal.test.tsx`: no `select`; choosing Quiet hours "None" saves `quiet_mode: 'none'`; "Group default" saves `quiet_mode: null`; Urgent bypass "Off" saves `urgent_bypass: false`; a member override `['text']` switched to Custom with Email on saves `['email','text']`; the hint shows the group's formatted quiet hours.
  - `src/lib/timeChoices.test.ts`: `TIME_CHOICES.length === 96`; `timeLabel('21:00') === '9:00 PM'`; `timeOptions('21:10:00')` contains `{ value: '21:10', label: '9:10 PM' }` between 21:00 and 21:15.
  - `src/lib/notifications.test.ts`: `CHANNEL_NOTES` is no longer exported (`'CHANNEL_NOTES' in module` is false) — remove the export in this task, once EditSettingsModal no longer imports it.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** the shell, the move, and the five modals.
- [ ] **Step 4: Run** `npx vitest run src/components/notifications src/pages/Notifications.test.tsx src/pages/NotificationGroupDetail.test.tsx src/pages/me src/components/learning src/styles` and `npx tsc -p .` → PASS.
- [ ] **Step 5: Commit** — `feat(portal): notification modals use house controls and the standard header`.

### Task 8: /me tells the truth

**Files:**
- Modify: `portal/src/lib/notificationKinds.ts` (each `NOTIFICATION_CATEGORIES` entry gains `emailSource`), `portal/src/pages/me/CategoryDelivery.tsx`, `portal/src/pages/me/MeNotifications.tsx`
- Test: `portal/src/pages/me/MeNotifications.test.tsx`, `portal/src/lib/notificationKinds.test.ts`

**Interfaces:**
- Consumes: `useSystemStatus().status.email_enabled` (exists); `emailGroupsFor` (exists); the API's `CATEGORY_EMAIL_SOURCE` (Task 5), mirrored here.
- Produces: `export type EmailSource = 'groups' | 'always' | 'direct'`; `NOTIFICATION_CATEGORIES: { key; label; emailSource: EmailSource }[]` — approvals, reports, wiki, learning `'groups'`; security `'always'`.
- Produces: `CategoryDelivery({ categories, groups, emailEnabled, onChange })` — new prop `emailEnabled: boolean`. The row with `emailSource === 'always'` (account security) keeps its fixed text. Per other category, once `groups` has loaded: `emailPossible = emailEnabled && (emailSource === 'direct' || emailGroupsFor(key, groups).length > 0)`; the shown choice is `'inbox'` when the saved choice is `'email'` and `!emailPossible`, else the saved choice; the "Inbox + Email" button is `disabled` with `title` set to the reason ("Email isn't set up on this server" or "None of your groups email this category"). While `groups === null` the saved choice shows and nothing is disabled. "Email from" cell: chips; "No group — inbox only"; or "Email isn't set up" when `!emailEnabled`. Security delivery cell: "Always emailed" or, when `!emailEnabled`, "Inbox only — email isn't set up".
- Copy: section paragraph exactly "Emails go to your contact email; account security notices go to your sign-in email. Your groups decide which categories can email you and when — here you can turn them down." Add a `mini-btn` link "View all notifications" (to `/notifications`) in that section's head.

- [ ] **Step 1: Write the failing tests** in `MeNotifications.test.tsx`:
  - `shows inbox only when no group emails the category` — saved `reports: 'email'`, no groups: the Reports "Inbox + Email" button is disabled with the title "None of your groups email this category" and "Inbox only" has `aria-pressed="true"`; no preference save fires.
  - `turns email back on once a group emails it` — rerender with a member group subscribed to reports with effective Email: "Inbox + Email" pressed, enabled.
  - `server without email` — `email_enabled: false`: every Inbox + Email disabled with "Email isn't set up on this server"; security reads "Inbox only — email isn't set up".
  - `keeps the saved choice` — clicking "Inbox only" while it is already shown as selected sends no update.
  - `links to all notifications` — a link to `/notifications` named "View all notifications"; the new paragraph text is present.
  - `direct categories need no group` — render `CategoryDelivery` with a test category list containing `{ key: 'reports', label: 'Reports & labels', emailSource: 'direct' }` (inject the list through an optional `categoryList` prop defaulting to `NOTIFICATION_CATEGORIES`): with no groups, "Inbox + Email" stays enabled and pressed.
  - `notificationKinds.test.ts`: every category has an `emailSource`; only `security` is `'always'`.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/pages/me/MeNotifications.test.tsx`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/pages/me src/styles` and `npx tsc -p .` → PASS.
- [ ] **Step 5: Commit** — `feat(portal): /me notification settings only offer email that can happen`.

### Task 9: The bell links out, and a full notifications page

**Files:**
- Create: `portal/src/components/notifications/InboxRow.tsx` (row, `KindIcon`, the three strips, `relativeTime`, moved from `NotificationsPanel.tsx`)
- Modify: `portal/src/components/NotificationsPanel.tsx` (uses `InboxRow`; gear + footer; re-exports `relativeTime` and `INBOX_CAP`)
- Create: `portal/src/pages/NotificationsInbox.tsx`; `portal/src/styles/notifications.css` additions
- Modify: `portal/src/lib/api.ts` (`InboxItem.category`, `Inbox` fields, `InboxPageQuery`, `listInboxPage`), `portal/src/App.tsx` (route), `portal/src/components/Topbar.tsx` (crumbs), `portal/src/components/CommandPalette.tsx`
- Test: `portal/src/components/NotificationsPanel.test.tsx`, `portal/src/pages/NotificationsInbox.test.tsx` (new)

**Interfaces:**
- Consumes: `GET /notifications/inbox` params from Task 4; `usePagedList` (`lib/usePagedList.ts`); `useNotifications()` actions.
- Produces in `api.ts`: `InboxItem.category: NotificationCategory | null`; `Inbox` adds `next_cursor: string | null; total: number`; `export interface InboxPageQuery { category: NotificationCategory | null; unreadOnly: boolean }`; `export async function listInboxPage(params: PagedFetchParams<InboxPageQuery>, signal?: AbortSignal): Promise<PagedResponse<InboxItem>>` (maps `items` to `rows`; `limit` 50).
- Produces: `InboxRow({ item, onOpen, onMarkRead, onMarkUnread, onHide, onChanged, onKeyDown }: { item: InboxItem; onOpen: (item: InboxItem) => void; onMarkRead: (id: string) => void; onMarkUnread: (id: string) => void; onHide: (id: string) => void; onChanged: () => void; onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void })` — today's row markup; the strips call `onChanged` where they call `refresh` today.
- Behavior — bell: an `icon-btn` gear (`aria-label="Notification settings"`, `data-tip="Settings"`) in `.notif-head-actions` closes the panel and opens `/me/notifications`; a footer button "View all notifications" closes it and opens `/notifications` (always shown; when capped it reads "View all notifications · showing the 50 most recent").
- Behavior — page `/notifications` (no resource gate): eyebrow "Account", title "Notifications", hint "Everything sent to you, newest first."; toolbar: `.segmented` All | Unread, a category picker (house dropdown, "All categories" + the five categories), Mark all read, Clear read, and a Settings `mini-btn` to `/me/notifications`; rows grouped under "Today", "Yesterday", "Earlier" headings by local date of `created_at`; "Load more" while `hasMore`; empty copy "You're all caught up." (Unread) / "No notifications yet." (All). Row actions call the context's `markRead`/`markUnread`/`hide` (keeps the bell in sync) and update the page through a local overlay (`read_at` / hidden by id); Mark all read and Clear read call the context and then `reload()`. Opening a row behaves like the bell (mark read, app link navigates, other links leave).
- Route `/notifications` in `App.tsx` beside the `/me` routes; Topbar crumbs `'/notifications': ['Account', 'Notifications']`; palette: add "All notifications" → `/notifications`, rename "My notifications" to "Notification settings".

- [ ] **Step 1: Write the failing tests.**
  - `NotificationsPanel.test.tsx`: the gear navigates to `/me/notifications` and closes; "View all notifications" navigates to `/notifications`; existing row tests still pass through `InboxRow`.
  - `NotificationsInbox.test.tsx` (mock `listInboxPage` and the context): groups rows under Today/Yesterday/Earlier; Unread sends `unreadOnly: true`; the category picker sends `category: 'wiki'`; "Load more" requests the `next_cursor`; marking a row read updates it without a reload and calls the context's `markRead`; Hide removes it; empty states show the two copies; the Settings button links to `/me/notifications`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** Add `listTypography.allow.json` entries for any new `.notif-*` rule that sets font-size or min-height.
- [ ] **Step 4: Run** `npx vitest run src/components/NotificationsPanel.test.tsx src/pages/NotificationsInbox.test.tsx src/lib/notificationsContext.test.tsx src/styles` and `npx tsc -p .` → PASS.
- [ ] **Step 5: Commit** — `feat(portal): bell links to settings and a full notifications page`.

### Task 10: Delivery log tab and Check delivery (portal)

**Files:**
- Create: `portal/src/lib/deliveryLog.ts` (labels, `describeEntry`, `outcomeOf`, `DELIVERY_LOG_COLUMNS`), `portal/src/lib/deliveryLog.test.ts`, `portal/src/lib/deliveryLog.columns.test.ts`
- Create: `portal/src/components/notifications/DeliveryLogTab.tsx`, `DeliveryLogTrail.tsx`, `CheckDeliveryModal.tsx`
- Modify: `portal/src/pages/Notifications.tsx` (Groups | Delivery log tabs), `portal/src/lib/api.ts`, `portal/src/styles/notifications.css`
- Test: `portal/src/components/notifications/DeliveryLogTab.test.tsx`, `CheckDeliveryModal.test.tsx`, `portal/src/pages/Notifications.test.tsx`

**Interfaces:**
- Consumes: `GET /notifications/log`, `GET /notifications/check` (Task 5); `NotificationModal` (Task 7); `usePagedList`; `listNotificationRecipients()` for the person picker.
- Produces in `api.ts`: `DeliveryLogEvent` (the eight event codes), `DeliveryLogEntry` (fields of `DeliveryLogEntryOut`), `DeliveryLogQuery { events: DeliveryLogEvent[]; channel: 'inbox' | 'email' | null; category: NotificationCategory | null; since: string | null; notificationId?: string; outboxId?: string }`, `getDeliveryLogPage(params: PagedFetchParams<DeliveryLogQuery>, signal?: AbortSignal): Promise<PagedResponse<DeliveryLogEntry>>`, `DeliveryCheckGroup`, `DeliveryCheck` (fields of the API outs), `NotificationKindInfo { kind: string; label: string; category: NotificationCategory; email: boolean; owner_always: boolean; urgent: boolean }`, `listNotificationKinds(): Promise<NotificationKindInfo[]>`, `checkDelivery(personId: string, kind: string, ownerCopy?: boolean): Promise<DeliveryCheck>` (`owner_copy` is sent only when `ownerCopy` is given).
- Produces in `deliveryLog.ts`: `EVENT_LABELS: Record<DeliveryLogEvent, string>` = inbox_written "In inbox", inbox_suppressed "Not in inbox", email_queued "Queued", email_not_queued "Not emailed", email_sent "Sent", email_skipped "Dropped", email_retry "Retrying", email_failed "Failed"; `REASON_LABELS: Record<string, string>` for every reason code in the spec (e.g. `read` "Already read in the portal", `resolved` "Already decided", `no_email_group` "No group emails this category", `quiet_hours` "Quiet hours", `inactive_day` "Not an active day", `email_not_set_up` "Email isn't set up"); `outcomeOf(e: DeliveryLogEntry): { label: string; chip: string }` ("Held" `c-amber` for a deferred `email_queued`, `Sent` `c-green`, `Failed` `c-red`, `Retrying` `c-amber`, others `c-blue`/`c-slate`); `describeEntry(e: DeliveryLogEntry): string` (e.g. "Held until Mon 7:00 AM · Quiet hours · Destination Side Ops Team", "Attempt 2 failed (OSError) — retrying", "Already read in the portal"; unknown reason codes fall back to the code).
- Behavior: `Notifications.tsx` shows a `.subs-tabs` strip (Groups | Delivery log) only for super admin and above, selected by `?tab=log`; others never see the strip and `?tab=log` falls back to Groups. `DeliveryLogTab`: hint "Every notification and email decision — who, what and why."; toolbar with the `.dir-search` box (server `q`), facet filters for Outcome (maps to `events`), Channel and Category, a `.segmented` time range 24 h | 7 days | 30 days | All (default 7 days → `since`), and a "Check delivery" button; list columns When (relative, exact time on hover), Person, Notification (title, or kind label for template mail), Category, Channel, Outcome (chip), Detail (`describeEntry`); a chevron expands a row into `DeliveryLogTrail` — a `DataTable` (Time, Event, Detail, Process) of every entry with the same `notification_id` (or `outbox_id`), plus links "Open user page" (`/people/users/:id`) and "Open notification link" when present; "Load more" while `hasMore`. `CheckDeliveryModal` (eyebrow "Delivery log", title "Check delivery", description "What would happen right now if this person got a notification in this category. Nothing is sent."): Person ComboBox, a Notification type ComboBox over `listNotificationKinds()` (label "Report ready", sub-label the category's label), and — only when the chosen kind is `owner_always` — a `.segmented` "The account owner" | "An admin copy" (the second sends `ownerCopy: false`); a result card (Inbox line, Email line with outcome, time or reason, "to <address> (contact email|sign-in email)"), and a groups `DataTable` (Group, Subscribed, Email, Now, Earliest send).

- [ ] **Step 1: Write the failing tests.**
  - `deliveryLog.test.ts`: every event has a label; `outcomeOf` for deferred queued → "Held"/`c-amber`; `describeEntry` for a retry, a deferral and a drop; an unknown reason returns the code.
  - `deliveryLog.columns.test.ts`: `listGridStyle(default DELIVERY_LOG_COLUMNS, trailing).minWidth <= LIST_FIT.page`.
  - `Notifications.test.tsx`: no tab strip at rank 60; strip at rank 80 with global scope; none at rank 80 without global scope; `?tab=log` at rank 60 shows the groups list.
  - `DeliveryLogTab.test.tsx` (mock `getDeliveryLogPage`): renders rows with outcome chips; choosing "30 days" changes `since`; the Outcome filter sends `events`; expanding a row requests its trail by `notificationId`; "Check delivery" opens the modal.
  - `CheckDeliveryModal.test.tsx` (mock `checkDelivery`, `listNotificationKinds`, `listNotificationRecipients`): picking a person and "Report ready" calls `checkDelivery(personId, 'report_ready')`; the owner/admin toggle appears only for an `owner_always` kind and "An admin copy" calls it with `false`; shows "Held until …" and the quiet-hours reason for a held result; shows the not-sent reason; renders the groups table; header carries the eyebrow and description.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib/deliveryLog.test.ts src/lib/deliveryLog.columns.test.ts src/components/notifications src/pages/Notifications.test.tsx src/styles` and `npx tsc -p .` → PASS.
- [ ] **Step 5: Commit** — `feat(portal): delivery log tab and check-delivery tool for super admins`.

### Task 11 (controller): full suites, live check, merge

- [ ] Full API suite: `cd api && SS_TEST_DB=serversherpa_test_notif_phase0 PYTHONPATH=src .venv/bin/pytest -q -p no:cacheprovider` (foreground, 600000 ms timeout per call; split by directory/file globs if one call would exceed it). Expected: all pass except known environment-only failures, each named in the report.
- [ ] Full portal suite and build: `cd portal && npx vitest run && npm run build` → PASS.
- [ ] Live check in the browser against a worktree API (port 8001) and portal (port 5175) on a scratch copy of the dev DB upgraded to 0110: /me truth, live channels, categories, modals (screenshot corners and controls), bell gear + View all, `/notifications`, Delivery log + Check delivery as a super admin, a deferred email dropped after Mark all read (Mailpit at localhost:8025 shows nothing sent; the log shows `email_skipped` / `read`).
- [ ] Merge `notif-phase0` into `main` with `--no-ff`; upgrade the dev DB to 0110; restart the API and the workers that import the changed modules (notification-worker, log-service, report/label/wiki workers).
