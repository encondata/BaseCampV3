# Notification Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-app notifications also go out by email through the existing mail outbox, governed by the notification-group settings (now applied) and a per-category personal choice on /me › Notifications.

**Architecture:** A kind registry (`notifications/kinds.py`) maps every `notify()` kind to a category and flags. Groups gain `categories` (migration 0092). `notify()` writes the inbox row, then asks a pure rule (`notifications/email_rule.py`) when email may go out, and enqueues the new `notification` template with `send_at`. The portal replaces /me's four dead switches with a per-category table and adds a Categories editor to the group settings modal.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, Jinja (mail templates), pytest; React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-notification-email-design.md` — read it; it is binding.

## Global Constraints

- Categories, exactly: `approvals` "Approvals & requests", `reports` "Reports & labels", `wiki` "Wiki", `security` "Account security" — in that order.
- Personal choices, exactly: `email` "Inbox + Email", `inbox` "Inbox only", `off` "Off"; default `email` for every category; `security` is fixed (always email; stored value ignored).
- Kind → category and flags exactly as the spec's table (brief: router_approval, totp_enrolled; email=False: password_reset_request; owner_always + urgent: password_expiring, totp_enrolled).
- No subscribed group → inbox only. Groups ship with `categories = '{}'`.
- SMTP off (`email_enabled()` false) → never enqueue notification email.
- Address: `Person.email`, else the person's `UserAccount.email`, else no email.
- Multiple subscribed groups → earliest allowed send time (most permissive). defer → next allowed minute within 8 days; skip → never.
- Migration **0092** (`api/migrations/versions/0092_notification_email.py`, `down_revision = "0091"`).
- Error code for a bad category: 422 `invalid_category`.
- No Approve/Reject buttons in email. Brief kinds never include the body.
- American English. Reuse portal idioms (`segmented`, `chip`, `mini-btn`, `page-hint`, `set-row`/`set-section`), never raw native checkboxes/selects.
- Never commit `api/src/serversherpa/_dev_reload.py`. Never `git stash`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to run things (worktree `.claude/worktrees/notification-email`)

- API tests (foreground, one run at a time): `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_notifmail DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>`. Never the dev DB.
- Lint changed files: `cd api && .venv/bin/ruff check <files>` (don't `--fix` files you didn't change).
- Portal: `cd portal && npx vitest run <files>`; before committing portal work run the full `npx vitest run`, `npx tsc -b`, `npm run build`.
- Sirdar API tests (Task 1 only): see `sirdar/api` README/pyproject for its test command; run only the schema/preferences tests you touch.

---

### Task 1: Registry, migration 0092, models, preferences and enqueue plumbing

**Files:**
- Create: `api/src/serversherpa/notifications/kinds.py`
- Create: `api/src/serversherpa/notifications/settings.py` (move `effective_settings` here from `api/routes/notifications.py`; the route imports it from the new module)
- Create: `api/migrations/versions/0092_notification_email.py`
- Modify: `api/src/serversherpa/db/models.py` (`NotificationGroup.categories`, `EmailOutbox.kind`, `EmailOutbox.notification_id`)
- Modify: `api/src/serversherpa/api/schemas.py` (`NotifPrefs`)
- Modify: `api/src/serversherpa/mail/outbox.py` (`enqueue` gains `kind`, `notification_id`, `send_at`)
- Modify: `sirdar/api/src/sirdar_api/api/schemas.py` (`NotifPrefs` mirror) and any Sirdar test asserting its shape
- Test: `api/tests/test_notification_kinds.py`, `api/tests/test_migration_0092_notification_email.py`, extend `api/tests/test_mail_outbox.py`

**Interfaces — Produces:**
- `KindInfo` dataclass and `CATEGORIES: dict[str, str]` (ordered), `KINDS: dict[str, KindInfo]`, `kind_info(kind: str) -> KindInfo | None`, `CATEGORY_KEYS: tuple[str, ...]` in `notifications/kinds.py`.
- `effective_settings(group, member) -> dict` in `notifications/settings.py` (same behavior as today).
- `NotificationGroup.categories: Mapped[list[str]]`; `EmailOutbox.kind: Mapped[str | None]`; `EmailOutbox.notification_id: Mapped[uuid.UUID | None]`.
- `NotifPrefs.categories: dict[str, Literal["email","inbox","off"]]` defaulting to every category `"email"`; `NotifPrefs.sound` unchanged; `critical/email/maint/digest` removed.
- `enqueue(db, template, to, *, person_id=None, kind=None, notification_id=None, send_at=None, **ctx)` — `send_at` (aware datetime) sets `next_attempt_at`, default now.

- [ ] **Step 1: Failing tests.**
  - `test_notification_kinds.py`: categories order/labels; every flag in the spec table; `kind_info("nope") is None`; and a coverage test that greps `api/src/serversherpa` for `notify(` call sites whose third positional argument is a string literal (and the wiki `kind="..."` / `KIND = "..."` constants in `wiki/notify.py`, `notifications/reset_requests.py`) and asserts every literal is in `KINDS`. Keep the scan simple (regex over source files) and assert the found set is non-empty.
  - Migration test (follow `tests/test_migration_0091_visibility.py`): `notification_groups.categories` defaults to `{}` and rejects `{'bogus'}`; `email_outbox.kind`/`notification_id` exist, nullable; deleting a notification nulls `notification_id`.
  - `test_mail_outbox.py`: `enqueue(..., kind="report_ready", notification_id=<id>, send_at=<future>)` stores all three (`next_attempt_at == send_at`); default still now.
  - Preferences: `UiPreferences().notif.categories == {"approvals": "email", "reports": "email", "wiki": "email", "security": "email"}`; an old blob with `critical` etc. still parses; an invalid choice is rejected (422 through `PUT /auth/me/preferences` — find the existing preferences test file and add there).
- [ ] **Step 2: Run them; confirm they fail.**
- [ ] **Step 3: Implement.** Registry per the spec (copy the `KindInfo` definition from the spec). Migration:

```python
revision = "0092"; down_revision = "0091"
CATEGORIES_CHECK = "categories <@ ARRAY['approvals','reports','wiki','security']::text[]"

def upgrade() -> None:
    op.add_column("notification_groups", sa.Column(
        "categories", postgresql.ARRAY(sa.Text()), nullable=False,
        server_default=sa.text("'{}'::text[]")))
    op.create_check_constraint("ck_notification_groups_categories",
                               "notification_groups", CATEGORIES_CHECK)
    op.add_column("email_outbox", sa.Column("kind", sa.Text(), nullable=True))
    op.add_column("email_outbox", sa.Column(
        "notification_id", postgresql.UUID(as_uuid=True),
        sa.ForeignKey("notifications.id", ondelete="SET NULL"), nullable=True))

def downgrade() -> None:
    op.drop_column("email_outbox", "notification_id")
    op.drop_column("email_outbox", "kind")
    op.drop_constraint("ck_notification_groups_categories", "notification_groups", type_="check")
    op.drop_column("notification_groups", "categories")
```

  Check the `notifications.id` column type/name in models before writing the FK. Move `effective_settings` verbatim and re-import it in the route module (all existing imports keep working). Update the Sirdar `NotifPrefs` mirror identically (Sirdar's portal reuses the portal's preferences UI, so its shape must match).
- [ ] **Step 4: Run the new tests plus** `tests/test_notification_groups_api.py tests/test_notification_self_service.py tests/test_mail_outbox.py tests/test_mail_delivery.py` and the preferences test file — all pass. Run Sirdar's preferences/schema tests.
- [ ] **Step 5: Commit** — `feat(notifications): kind registry, group categories + outbox tracing (migration 0092), per-category prefs`.

---

### Task 2: The email send-time rule (pure)

**Files:**
- Create: `api/src/serversherpa/notifications/email_rule.py`
- Test: `api/tests/test_notification_email_rule.py`

**Interfaces — Consumes:** effective-settings dicts shaped like `effective_settings()` output (`channels`, `quiet_start`, `quiet_end`, `timezone`, `active_days`, `dnd_behavior`, `urgent_bypass`).
**Produces:** `email_send_time(settings: list[dict], now: datetime, *, urgent: bool) -> datetime | None` and `allowed_at(s: dict, now: datetime, *, urgent: bool) -> datetime | None`.

- [ ] **Step 1: Failing tests** (all with fixed aware `now` values; use `zoneinfo`):
  1. Empty list → `None`.
  2. Group without `"email"` in channels → `None`.
  3. No quiet hours, all days → `now`.
  4. Quiet 22:00–07:00 America/New_York, now 23:30 local, defer → 07:00 next day local (as UTC-aware datetime); skip → `None`.
  5. Same window, now 12:00 → now.
  6. Overnight boundary: now 06:59 → 07:00 same day; now 07:00 → now.
  7. Equal start and end → treated as no quiet hours.
  8. Inactive day: active mon–fri, now Saturday 10:00 → Monday 00:00 local (defer) / `None` (skip).
  9. Inactive day + quiet hours: Friday 23:00 with quiet 22–07 and mon–fri → Monday 07:00.
  10. Urgent with `urgent_bypass` true inside quiet hours → now; with false → deferred time.
  11. Two groups: one deferred to 07:00, one allowed now → now; one deferred 07:00, one 06:00 → 06:00; one skip-quiet + one deferred → the deferred time.
  12. Timezone matters: same UTC instant, Europe/London vs America/Los_Angeles give different results.
  13. Nothing allowed within 8 days (e.g. `active_days=[]`) → `None`.
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement.** Convert `now` to the setting's timezone; a moment is allowed when its weekday (`mon`…`sun`) is in `active_days` and it is outside `[quiet_start, quiet_end)` (overnight when start > end; none when either is null or start == end). If allowed now (or urgent and `urgent_bypass`) return `now`. Else if `dnd_behavior == "defer"`, step forward to the next candidate boundary — the next `quiet_end` time or the next local midnight, whichever comes first — and re-check, up to 8 days; return the first allowed moment (as an aware datetime in UTC). `skip` → `None`. `email_send_time` filters to settings whose channels include `"email"` and returns the minimum non-None `allowed_at`, else `None`. Keep it free of DB and settings imports.
- [ ] **Step 4: Run; all pass. Ruff clean.**
- [ ] **Step 5: Commit** — `feat(notifications): email send-time rule (quiet hours, active days, defer/skip, urgent bypass)`.

---

### Task 3: notify() sends email, the notification template, owner notices, worker --once

**Files:**
- Modify: `api/src/serversherpa/notifications/inbox.py`
- Create: `api/src/serversherpa/notifications/email.py` (the decision + enqueue, so `inbox.py` stays small)
- Create: `api/src/serversherpa/mail/templates/notification.subject.txt`, `notification.html`, `notification.txt`
- Modify: `api/src/serversherpa/services/totp.py` (owner copy passes `owner_notice=True`), `api/src/serversherpa/notifications/password_reminders.py` (`owner_notice=True`)
- Modify: `api/src/serversherpa/cli.py` (worker docstring; `--once` also runs `deliver_once`) and `notifications/worker.py` docstring
- Test: new `api/tests/test_notification_email.py`; extend `tests/test_notifications_inbox.py`, `tests/test_notification_worker.py`, `tests/test_totp_api.py` (owner copy), password reminder tests

**Interfaces — Consumes:** Task 1 registry, `effective_settings`, `enqueue(..., kind, notification_id, send_at)`, `email_enabled`, `portal_url` (in `services/password_reset.py`; prefer moving it to a small shared helper only if an import cycle appears), Task 2 `email_send_time`.
**Produces:** `notify(db, person_id, kind, title, *, body="", link=None, payload=None, owner_notice=False) -> Notification | None` (None when the person's category choice is `off`).

- [ ] **Step 1: Failing tests** (`email_on` fixture from `conftest.py` turns SMTP on; assert on `EmailOutbox` rows, never send):
  1. SMTP off → inbox row, no outbox row.
  2. No subscribed group → inbox only.
  3. Person in a group with `categories=['reports']`, channels incl. email, no quiet hours → `report_ready` enqueues `template="notification"`, `kind`, `notification_id == row.id`, `to_address == Person.email`, `next_attempt_at ≈ now`, subject == title, html contains body and an absolute portal link.
  4. Group not subscribed to the category, or channels without email, or group `enabled=False` → no email.
  5. Personal `inbox` → inbox row, no email. Personal `off` → no inbox row, no email, returns None.
  6. Security kind with stored `off` → still treated as email.
  7. Quiet hours defer → `next_attempt_at` = deferred time; skip → no email.
  8. Member override (e.g. `quiet_mode='none'`) beats the group.
  9. Address fallback: no `Person.email` → `UserAccount.email`; neither → no email.
  10. `owner_notice=True` + `password_expiring` with no groups → emailed now; same with quiet hours → still now; admin copy of `totp_enrolled` (owner_notice False) follows groups and urgent bypass.
  11. Brief kind (`router_approval`) → email has no body text (assert a distinctive body string is absent) but has the link.
  12. `password_reset_request` never emailed even with a subscribed group.
  13. Unregistered kind → inbox only.
  14. Absolute wiki link kept as is; no link → `<portal>/me/notifications`.
  15. Footer: security email has the security notice line; others have the "Change what you receive" link.
  16. `notification-worker --once` also delivers due mail (follow the existing worker tests' style).
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement.**
  - `notifications/email.py::maybe_email(db, notification, *, owner_notice: bool, choice: str) -> None` does spec steps 3–6. Load memberships in one query: `NotificationGroupMember` join `NotificationGroup` where `person_id`, `enabled`, and `categories @> ARRAY[category]`. Load `Person` and `UserAccount` (email, `ui_prefs`) once.
  - `notify()`: resolve kind info and the personal choice from `UserAccount.ui_prefs` (parse through `UiPreferences` so defaults apply; no account → `"email"`), return `None` for `off` (non-security), else write the row exactly as today, then `await maybe_email(...)`.
  - Template context: `name` (first name), `title`, `body` (empty for brief), `link` (absolute), `security` (bool), `prefs_url`. Plain `.txt` mirrors the HTML. Follow `password_changed.*` for style; the HTML extends `_base.html`.
  - CLI/worker: fix the stale docstrings; `--once` runs one `deliver_once` pass after the status pass.
- [ ] **Step 4: Run** the new file + `tests/test_notifications_inbox.py tests/test_notification_worker.py tests/test_mail_outbox.py tests/test_mail_delivery.py tests/test_totp_api.py tests/test_totp_admin_api.py tests/test_wiki_notify.py tests/test_report_worker.py tests/test_reset_request_cards.py tests/test_notification_requests_service.py` and the password reminder tests — all pass. Ruff clean on changed files.
- [ ] **Step 5: Commit** — `feat(notifications): email delivery from notify() with group rules, personal choices and owner security notices`.

---

### Task 4: Group categories and my-groups payload in the API

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (`NotificationGroupSettings`, `NotificationGroupOut`, the my-groups out schema used by `GET /auth/me/notification-groups`)
- Modify: `api/src/serversherpa/api/routes/notifications.py` (create/patch validate and save `categories`; out includes it), `api/src/serversherpa/api/routes/me.py` (my groups include `categories` and `effective_channels`)
- Test: `api/tests/test_notification_groups_api.py`, `api/tests/test_notification_self_service.py`

**Interfaces — Produces:** `categories: list[str]` on group create/patch (optional; unknown → 422 `invalid_category`; stored de-duplicated in `CATEGORIES` order) and on `NotificationGroupOut`; `MyNotificationGroup` gains `categories: list[str]` and `effective_channels: list[str]` (the member's effective channels when a member, else the group's).

- [ ] **Step 1: Failing tests:** create with `["wiki","reports"]` → out `["reports","wiki"]`; patch to `[]`; `["bogus"]` → 422 `invalid_category`; audit row of a patch includes the categories change (follow how other settings are audited there); my-groups includes both new fields, with a member override of channels reflected in `effective_channels`.
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement** following the existing settings fields' validation style in that route (look at how `channels`/`active_days` are validated and mirror it).
- [ ] **Step 4: Run** both test files — pass. Ruff clean.
- [ ] **Step 5: Commit** — `feat(notifications): group categories in the API; my groups show categories and effective channels`.

---

### Task 5: Portal — /me per-category table, group Categories editor

**Files:**
- Create: `portal/src/lib/notificationKinds.ts` (+ test)
- Modify: `portal/src/lib/api.ts` (`NotifPrefs`, group types, `MyNotificationGroup`), `portal/src/lib/settings.ts` (defaults)
- Modify: `portal/src/pages/me/MeNotifications.tsx` (+ test)
- Modify: `portal/src/components/notifications/EditSettingsModal.tsx`, `portal/src/pages/NotificationGroupDetail.tsx` (+ tests), and wherever channel options are listed (`portal/src/lib/notifications.ts`) for the "not available yet" note on text/push
- Fix any other test fixtures that build `UiPreferences`/groups so `tsc -b` passes

**Interfaces — Consumes:** Task 1 `notif.categories`; Task 4 `categories`, `effective_channels`; `/system/status` `email_enabled` (see `portal/src/lib/systemStatus.ts`).
**Produces:** `NOTIFICATION_CATEGORIES: { key: 'approvals'|'reports'|'wiki'|'security'; label: string }[]` (spec order), `DELIVERY_CHOICES` (`email`/`inbox`/`off` with the exact labels), `type NotificationCategory`, `type DeliveryChoice`.

- [ ] **Step 1: Failing tests:**
  - /me: the four old switches are gone; a table row per category; each non-security row has a `segmented` group (aria-label `"<Category> delivery"`) with Inbox + Email / Inbox only / Off and saves `notif.categories` via the existing preference save; Account security shows "Always emailed" and no control; "Email from" lists the member groups subscribed to that category whose `effective_channels` include `email`, else "No group — inbox only"; the email-off hint appears when `email_enabled` is false; Sound row still works.
  - EditSettingsModal: a Categories control (toggle chips or a multi-select `segmented`-style group — reuse an existing multi-toggle idiom such as the active-days picker in the same modal) shows the four categories, toggling and Save sends `categories`; existing settings still save.
  - Group detail: shows the categories by label, or "None — members get inbox only".
  - Channels text/push show "not available yet".
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement** with house idioms only (look at how the active-days picker is built in EditSettingsModal and reuse it for categories). Section copy from the spec: "Emails go to your contact email. Your groups decide which categories can email you and when; here you can turn them down." Email-off hint: "Email isn't set up on this server yet — notifications stay in the inbox."
- [ ] **Step 4: Run** the full `npx vitest run`, `npx tsc -b`, `npm run build` — all pass (guardrails included).
- [ ] **Step 5: Commit** — `feat(portal): per-category notification delivery on /me and group Categories setting`.
