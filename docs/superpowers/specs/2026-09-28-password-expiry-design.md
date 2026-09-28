# Password expiry policy (To-Do #32) — design

**Date:** 2026-09-28 · **Branch:** `password-expiry` · **Closes:** Feature Parity row 357 / Gaps row 50 "Password expiry policy"

## Goal

A global, admin-controlled password policy: passwords expire after a set number of days (default 90) and the last N passwords (default 3) can't be reused. Expired passwords are handled with the existing forced-change gate. People get in-app reminders 7, 3 and 1 day before expiry; the same reminders will go out by email once outbound email exists (To-Do #4, deferred).

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Existing passwords when the policy is turned on | The clock starts on the day the switch is turned on, not from each password's last change. Off then on again restarts the clock. |
| Mid-session expiry | Nothing until the next sign-in (sessions end within 24 h anyway). |
| Kiosk | Same as a temporary password today: the kiosk shows "Password change required — sign in to the portal to change it." |
| Reminders | In-app inbox now, at 7, 3 and 1 day before expiry. Email fans out from the same inbox later. |
| Reuse check scope | Only while the switch is on. Applies to self-service changes, admin resets, admin-created temporary passwords and the CLI. |

## Settings (System settings › Security)

Stored in the existing `system_config` row, section `security`, alongside the two-factor flags. New keys and defaults (`api/src/serversherpa/system/config_store.py` `DEFAULTS["security"]`):

| Key | Default | Rule |
|---|---|---|
| `password_expiry_enabled` | `false` | The global switch. |
| `password_expiry_days` | `90` | 1–365. |
| `password_history_count` | `3` | 0–24. `0` turns reuse checking off. |
| `password_expiry_since` | `null` | ISO timestamp. Set to now when `enabled` flips false → true; cleared when it flips true → false; unchanged otherwise. Not settable by the client. |

`GET/PUT /system/security` gain the first three as optional inputs (`SecurityConfigIn`) and all four as outputs (`SecurityConfigOut`). Out-of-range values → 422 `password_expiry_days_out_of_range` / `password_history_count_out_of_range`. Changes are audited as today (`security_config_update`, including `password_expiry_since`).

The numbers can be edited while the switch is off.

**UI** (`portal/src/components/settings/SecurityControls.tsx`), three new rows under the two-factor rows and above "End all sessions":

- **Password expiry** — "Everyone must choose a new password after a set number of days, and can't reuse recent ones. The clock starts today." — Switch.
- **Expires after** — "Days a password stays valid." — number input (1–365), suffix "days".
- **Prevent reuse of the last** — "Passwords that can't be chosen again. 0 turns this off." — number input (0–24), suffix "passwords".

Number inputs save on blur or Enter via the same `patch()`; an API range error shows in the existing error line. Inputs are disabled with `canChange={false}`, like the switches.

## Expiry math and enforcement

New module `api/src/serversherpa/services/password_policy.py`:

- `PasswordPolicy` dataclass: `enabled`, `days`, `history_count`, `since: datetime | None`.
- `async load_policy(db) -> PasswordPolicy` (reads the `security` section).
- `expires_at(policy, account) -> datetime | None`: `None` when the policy is off or the account has no password. Otherwise `max(account.password_updated_at or since, since) + timedelta(days=policy.days)`.
- `change_reason(policy, account, now) -> "temporary" | "expired" | None`: `"temporary"` when `account.must_change_password` is set (wins), `"expired"` when `expires_at <= now`, else `None`.

**Session payloads** (`SessionOut` and `MeOut` in `api/src/serversherpa/api/schemas.py`):

- `must_change_password` becomes `change_reason is not None` (so every existing consumer keeps working).
- New `must_change_reason: Literal["temporary", "expired"] | None`.
- New `password_expires_at: datetime | None` (the policy's date for this account, `None` when off).

`session_response()` in `routes/auth.py` takes the loaded policy; its callers (`/auth/login`, `/auth/refresh`, the 2FA session path at `auth.py:206`, and `routes/kiosk.py:122`) load it with `await load_policy(db)`. `/auth/me` does the same. Kiosk password logins go through the same `login` service and `session_response`, so an expired password blocks the kiosk the same way a temporary one does.

Nothing is written to the account when it expires; turning the policy off makes everyone current at once.

## Password history and reuse

**Migration `0080_password_history.py`** (`down_revision = "0073"`; 0074–0079 are taken by the unmerged `wiki` branch, so a distinct number avoids a file clash):

- Table `password_history`: `id uuid pk default gen_random_uuid()`, `person_id uuid not null references user_accounts(person_id) on delete cascade`, `password_hash text not null`, `created_at timestamptz not null default now()`. Index `(person_id, created_at desc)`.
- Backfill: one row per `user_accounts` row with a non-null `password_hash`, `created_at = coalesce(password_updated_at, now())`, so the current password counts as the most recent of the "last N" from day one.
- Downgrade drops the table.

Model `PasswordHistory` in `db/models.py`.

**Setting a password** goes through one helper, `password_policy.apply_password(db, account, new_password, *, must_change: bool, now: datetime) -> None`: hashes with the pepper, sets `password_hash`, `password_updated_at = now`, `must_change_password = must_change`, `updated_at = now`, adds a `PasswordHistory` row, and deletes rows beyond the newest 24 for that account (the maximum `history_count`). Callers:

| Path | Reuse check | Notes |
|---|---|---|
| `POST /auth/me/password` (`routes/me.py`) | yes | Keeps the current-password check and `same_as_current` (409) as today. |
| `POST /users/{id}/reset-password` (`routes/users.py`) | yes | |
| `POST /users/{id}/account` (`routes/users.py`, promote a contact) | no (new account, empty history) | Records history. |
| `POST /users` with `create_account` (`routes/users.py`) | no (new account) | Records history. |
| `serversherpa set-password` (`cli.py`) | yes | Prints the refusal and exits 1. |
| `serversherpa bootstrap-admin` (`cli.py`) | no (new account) | Records history. |

**Reuse check** `password_policy.assert_not_reused(db, policy, account, new_password)`: no-op when `policy.enabled` is false or `history_count == 0`. Otherwise loads the newest `history_count` rows and `verify_password`s each; on a match raises `PasswordReused`. Routes map it to 422 `{"code": "password_recently_used", "count": N}`. The check runs after `require_password_length` and before anything is written.

Portal copy for `password_recently_used`: "That password was used recently. Choose one you haven't used before." (`ChangePasswordForm.tsx` `ERRORS`, and the admin reset dialog's error map in `UserAdminModals.tsx` if it has one — otherwise its generic error is acceptable).

## Reminders

New module `api/src/serversherpa/notifications/password_reminders.py`:

- `REMINDER_STAGES = (7, 3, 1)`; `KIND = "password_expiring"`.
- `async run_password_reminders(db, now) -> int` (returns how many were sent):
  - Loads the policy; returns 0 when off.
  - Selects accounts with a `password_hash`, `disabled_at IS NULL`, and person `archived_at IS NULL`.
  - For each: `days_left = ceil((expires_at - now) / 1 day)`. Skip when `days_left < 1` (already expired: the sign-in gate handles it). `due = [s for s in STAGES if days_left <= s]`; if empty skip; `stage = min(due)`.
  - Dedup: skip if a `Notification` exists for that person with `kind = KIND`, `payload->>'expires_at' == expires_at.isoformat()` and `payload->>'stage' == str(stage)`. So each stage fires once per expiry date, and a person who is already inside a later window gets only the most urgent stage.
  - `notify(db, person_id, KIND, title, body=…, link="/me", payload={"expires_at": iso, "stage": stage, "days_left": days_left})` then one `db.commit()` at the end.
  - Title: `Your password expires in {days_left} day` / `days`. Body: `Change it under My Profile › Security before {Month D, YYYY} to avoid being asked at sign-in.` (date formatted in UTC).
- The notification worker (`notifications/worker.py` `run_forever`) calls it every `REMINDER_INTERVAL_SECONDS = 3600` (and on its first loop), through its own session, inside `try/except Exception: logger.exception(...)` so a failure never stops the loop. The existing pause-flag behavior already skips it while workers are paused. The module docstring's "PLACEHOLDER ONLY" wording is updated to say the worker now runs the password-expiry reminder sweep.

Portal: `NotificationsPanel.tsx` gets a key icon for `kind === 'password_expiring'`. Clicking follows `link` to `/me` as any notification does.

Email: none now. When outbound email lands, it fans out from `notify()`; nothing here needs to change.

## Portal and kiosk copy

- `AuthContext` gains `mustChangeReason: 'temporary' | 'expired' | null` and `passwordExpiresAt: string | null` from the session payload; `clearMustChange` also clears the reason.
- `ForceChangePassword.tsx`: heading and text depend on the reason.
  - temporary (today's copy): "Set your password" / "…your password was set by an administrator. Choose your own before continuing…"
  - expired: "Your password has expired" / "{name}, passwords expire every so often here. Choose a new one to continue. It can't be one you've used recently."
- `KioskGuard.tsx`: expired → "Your password has expired. Sign in to the portal at {url} to choose a new one, then sign in here again." Temporary keeps today's text.
- `Profile.tsx` › Security › Password line: append ` · expires {longDate(passwordExpiresAt)}` when the policy is on.
- American English throughout.

## Testing

**API** (`api/tests/test_password_expiry.py`, new; fixtures from `conftest.py`, `_make` from `test_status_values_write.py`, `login`/`make_login` from `test_sites_api.py`; run with `SS_TEST_DB=serversherpa_test_pwexp`):

1. Security config: defaults include the new keys; `PUT` range errors (0 days, 366 days, −1 count, 25 count); enabling stamps `password_expiry_since`, disabling clears it, re-enabling restamps; the audit row includes the change.
2. Expiry math (unit): off → `None`; since after last change → since + days; last change after since → change + days; `change_reason` precedence (temporary wins).
3. Sign-in: with the policy on, an account whose `password_updated_at` and `since` are both older than `days` gets `must_change_password: true`, `must_change_reason: "expired"` from `/auth/login`, `/auth/refresh` and `/auth/me`; with the policy off the same account signs in clean; a fresh `since` protects an old password (the "clock starts today" rule).
4. Kiosk login (`client: "kiosk"`) returns the same flags.
5. Reuse: after changing to A then B with `history_count = 3`, changing back to A → 422 `password_recently_used`; with the policy off it succeeds; with `history_count = 0` it succeeds; admin reset to a recent password → 422; a brand-new account (promote a contact) succeeds and gets a history row; history is trimmed to 24 rows.
6. History: `apply_password` on an account records a row; the test DB is built by running every migration, so 0080 (table + backfill) is exercised by the suite itself.
7. Reminders: policy off → 0; 10 days left → 0; 6 days → one stage-7 notification; run again → 0 (dedup); 2 days → stage 3; 1 day (12 hours) → stage 1; expired → 0; a disabled account → 0; payload carries `expires_at`, `stage`, `days_left`; title/body wording.
8. Worker: `run_forever` smoke test still passes; a unit test that the reminder pass is invoked through `run_reminders_once(maker)` (a small wrapper the loop calls) and swallows an injected exception.

**Portal** (Vitest):

- `SecurityControls.test.tsx`: the three new rows render from the config; toggling the switch calls `updateSecurityConfig({ password_expiry_enabled: true })`; editing "Expires after" and blurring calls `updateSecurityConfig({ password_expiry_days: 60 })`; a 422 range error shows the error line; `canChange={false}` disables the inputs.
- `ForceChangePassword.test.tsx`: expired reason shows "Your password has expired"; temporary shows "Set your password".
- `AuthContext` test: `must_change_reason` and `password_expires_at` flow into state; `clearMustChange` clears both flags.
- `ChangePasswordForm.test.tsx` (new or existing): `password_recently_used` shows the reuse message.
- `NotificationsPanel`: the `password_expiring` kind renders (icon branch).

**Kiosk** (Vitest): `KioskGuard.test.tsx`: expired reason shows the expired text; temporary keeps the existing text.

**Final checks:** full API suite (`SS_TEST_DB=serversherpa_test_pwexp_full`), portal and kiosk suites, `tsc`, portal build. Live check on the dev stack: turn the policy on under Settings › Security, set 1 day, back-date a test account's `password_updated_at` and `password_expiry_since` in the dev DB, sign in as that account → forced-change screen; run the reminder sweep by hand and see the inbox item. (Signing in with a real password is Jimmy's step; the reminder and settings parts can be checked without it.)

## Out of scope

- Complexity rules beyond the existing minimum length.
- Per-user or per-role expiry exemptions.
- Email delivery (To-Do #4).
- Forcing active sessions out at the moment of expiry.
- A kiosk change-password screen.
