# User administration fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the seven user-admin problems found while writing the admin guide: password length, retired roles,
"Manage roles" saving, giving a login back, 2FA switch feedback, the "Add person" hint, and invite and reset emails.

**Architecture:**
- **API:** invite and reset-link endpoints and options reuse `services/password_reset.issue_token` and the
  mail outbox (`mail/outbox.enqueue`), plus a new `user_invite` template and an `invite_ttl_minutes` setting.
  An `invited` account status and `two_factor_enabled` flags are added to existing payloads.
- **Portal:** the portal fixes reuse existing pieces: `useAuth().passwordMinLength`, `GET /access/summary`,
  `rolesPayloadForGlobalChange`, `useSystemStatus().email_enabled` and `generateTempPassword`.

**Tech Stack:** FastAPI, SQLAlchemy async, Jinja mail templates, pytest; React 18, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-15-user-admin-fixes-design.md`. It is binding: every quoted string,
code and default in it is exact.

## Global Constraints

- **Paths:** worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/user-admin-fixes`, branch
  `user-admin-fixes`. `api/.venv` and `portal/node_modules` are symlinks to the main checkout. Never run
  `npm install` here.
- **Password length:** the minimum is always `settings.password_min_length` (portal:
  `useAuth().passwordMinLength`). No other numeric minimum may appear anywhere.
- **Invite link lifetime:** `invite_ttl_minutes: int = 1440` (env `SS_INVITE_TTL_MINUTES`).
- **Reset link lifetime:** reset links use the existing `password_reset_ttl_minutes`. Don't change it.
- **Error codes:**
  - 422 `mail_not_configured` (email off)
  - 409 `not_invited` (resend when the account already has a password)
  - 409 `invited` (reset link for an account that never had a password)
  - existing: `password_too_short` (with `min_length`), `account_exists`, `email_in_use`, `rank_too_low`,
    `cannot_target_self`, `forbidden`
- **Email-off behavior:** when email isn't configured, the portal shows no invite or reset-link option and
  behaves exactly as today.
- **Copy (verbatim from the spec):**
  - "Temporary passwords need at least {n} characters."
  - "Managed from the client's or partner's contacts page."
  - "Give portal login"
  - "Not in effect — two-factor is off in System settings › Security."
  - the three "Add person" hints
  - "Email an invite link" / "Set a temporary password"
  - "Invited"
  - "Resend invite"
  - "Invite sent to {email}."
  - "Email a reset link"
  - "Send link"
  - "Reset link sent to {email}. It works once and expires in {n} minutes." (or "… expires soon.")
  - "Set your password" / "Choose a password to finish setting up your account." / "You're all set" /
    "Sign in with your new password."
- **Language and UI:** American English. Reuse the portal's idioms (segmented control, chip, pf-form, modal
  header pattern); no raw native controls. Every new modal sizes to its content.
- **Test databases:** API tests run with `SS_TEST_DB=serversherpa_test_uaf`. Never write to the dev DB
  (localhost:5433/serversherpa), and never sign in anywhere.
- **Suites that must stay green:**
  - `cd api && SS_TEST_DB=serversherpa_test_uaf PYTHONPATH=src .venv/bin/python -m pytest tests/test_users*.py tests/test_auth*.py tests/test_password*.py tests/test_access*.py tests/test_mail*.py -q -p no:cacheprovider`
    (the full API suite runs only in the last task)
  - `cd portal && npx vitest run && npx tsc -p tsconfig.json --noEmit`
- **Commits:** end every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit
  `api/src/serversherpa/_dev_reload.py`. Stage explicit paths only.

## Review Focus

1. **A reset request kills a live invite.** Self-service "Forgot password" on an invited account issues a reset
   token and retires the invite token. That's acceptable, but the account must stay "invited" and both links
   must lead to the first-password page wording. Test: request a reset for an invited account, then
   `check` → `first_password: true`.
2. **A disabled invited account.** Status must be `disabled`, not `invited`. Resend must be refused with
   `forbidden` or a clear code, not silently send. Test in Task 1.
3. **Grant portal access while the person's contact email is blank.** The invite option must require a login
   email. A blank one gives the existing validation error, not a crash. Test in Task 3.
4. **The server minimum changes to something odd (for example 20).** Generated passwords
   (`max(14, n + 2)`) must still pass, and the Reset button enables. Test in Task 2 with a mocked session
   minimum of 20.
5. **Manage roles for someone who holds only an org role** (`client_admin`, no global role). Saving with no
   global chip selected must not revoke the org role. Test in Task 2, asserting the payload is `[]` and the
   org chip is shown read-only.

---

### Task 1: API — invites, reset links, invited status, 2FA flags

**Files:**
- Modify: `api/src/serversherpa/config.py`: add `invite_ttl_minutes: int = 1440` next to the
  `password_reset_*` settings.
- Create: `api/src/serversherpa/mail/templates/user_invite.subject.txt`, `user_invite.txt`, `user_invite.html`.
  Copy the structure of `account_invite.*`, use the spec's wording, and extend `_base.html` like the others.
- Modify: `api/src/serversherpa/api/schemas.py`:
  - `UserCreateIn` and `AccountCreateIn` gain `invite: bool = False`.
  - `temp_password` becomes optional when `invite` is true. Keep the `min_length=1` meaning when it's given.
  - `UserDetailOut.account` and the access summary schema gain `two_factor_enabled: bool`.
  - The password-reset check response gains `first_password: bool`.
- Modify: `api/src/serversherpa/api/routes/users.py`:
  - `_status` returns `"invited"` when `account.password_hash is None` and the account isn't disabled.
  - `create_user` and `create_account`: the invite branch.
  - New `POST /{person_id}/invite` and `POST /{person_id}/reset-link`.
  - `get_user_detail` fills `two_factor_enabled`.
- Modify: `api/src/serversherpa/api/routes/access.py`: the summary fills `two_factor_enabled` from
  `read_section(db, SECURITY_SECTION)`.
- Modify: `api/src/serversherpa/api/routes/auth.py`: the reset `check` returns `first_password`.
- Create: `api/src/serversherpa/services/invites.py`, with the code below.
- Test: `api/tests/test_user_invites.py` (new).

`api/src/serversherpa/services/invites.py`:

```python
"""Account invites and admin-sent reset links (spec 2026-10-15 user-admin fixes):
both are one-time links to /reset-password, issued through the password-reset
token store and sent through the mail outbox. Never commits."""
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import Person, UserAccount
from serversherpa.mail.outbox import enqueue
from serversherpa.services import password_reset
from serversherpa.services.first_admin import ttl_text


async def send_invite(db: AsyncSession, person: Person, account: UserAccount, *, now: datetime) -> None:
    minutes = get_settings().invite_ttl_minutes
    raw = await password_reset.issue_token(db, person.id, minutes=minutes, now=now)
    await enqueue(db, "user_invite", account.email, person_id=person.id,
                  name=person.preferred_name or person.first_name, email=account.email,
                  link=password_reset.portal_url(f"/reset-password#token={raw}"),
                  ttl_text=ttl_text(minutes), login_url=password_reset.portal_url("/login"))


async def send_reset_link(db: AsyncSession, person: Person, account: UserAccount, *, now: datetime) -> None:
    minutes = get_settings().password_reset_ttl_minutes
    raw = await password_reset.issue_token(db, person.id, minutes=minutes, now=now)
    await enqueue(db, "password_reset", account.email, person_id=person.id,
                  name=person.first_name,
                  link=password_reset.portal_url(f"/reset-password#token={raw}"),
                  ttl_minutes=minutes)
```

Match the `issue_token` and `enqueue` keyword names to their real signatures in
`services/password_reset.py` and `mail/outbox.py`. The `password_reset` template's variables must be exactly
what `request_reset` passes today: copy them from there.

**Rules (enforced in the routes):**
- **Invite on create or grant:**
  - `invite=True` requires `email_enabled()`, else 422 `mail_not_configured`. Check this before creating
    anything.
  - The account is created with no password.
  - `must_change_password` is irrelevant: completing the link calls `apply_password(must_change=False)`.
  - Call `send_invite` before the commit, so the account and the email row commit together.
  - The audit `changes` include `"invited": {"from": None, "to": True}`.
  - `temp_password` is still required when `invite` is false (`login_details_required`, as today).
- **`POST /{id}/invite`:**
  - Same guards as `reset_password`: `users` change, `_require_global`, `_load_target` (self and rank).
  - Account missing: 404 `user_not_found`.
  - Account disabled: 409 `account_disabled`.
  - Password set: 409 `not_invited`.
  - Email off: 422 `mail_not_configured`.
  - Then `send_invite`, an audit row `account.invite_resent`, commit, 204.
- **`POST /{id}/reset-link`:**
  - Same guards.
  - Disabled: 409 `account_disabled`.
  - No password: 409 `invited`.
  - Email off: 422 `mail_not_configured`.
  - Then `send_reset_link`, an audit row `password.reset_link_sent`, commit, 204.
  - Sessions and password are untouched.
- **`check`:** `first_password = account.password_hash is None`, computed in the same query that validates the
  token. When the token is invalid, the response is `{valid: false, first_password: false}`.

**Interfaces:**
- Produces:
  - routes `POST /users/{id}/invite` and `POST /users/{id}/reset-link` (both 204)
  - request field `invite` on `POST /users` and `POST /users/{id}/account`
  - status value `"invited"`
  - `UserDetailOut.account.two_factor_enabled` and access summary `two_factor_enabled`
  - check response `first_password`

- [ ] **Step 1: Write failing tests** in `api/tests/test_user_invites.py`. Reuse the fixtures and helpers of
  `tests/test_users_admin*.py` / `tests/test_password_reset*.py`, whichever exist (grep for `email_enabled`
  and the outbox in existing tests to see how email is switched on in tests).
  - Invite on create and on grant:
    - status `invited`
    - no `password_hash`
    - one `user_invite` outbox row to the login email, whose link contains `/reset-password#token=`
    - the audit includes `invited`
  - With email off:
    - 422 `mail_not_configured`
    - no person or account created (create)
    - no account (grant)
  - Sign-in with any password fails while invited.
  - Resend:
    - 204 with a new outbox row, and the old token no longer valid
    - `not_invited` once a password is set
    - `account_disabled` when disabled
    - `rank_too_low` and `cannot_target_self` as for reset
  - Reset link:
    - 204 with a `password_reset` outbox row
    - the account's sessions still exist
    - `invited` for a never-set account
    - `mail_not_configured`
  - `check`: `first_password` true for an invited account's token, false after a normal reset.
  - Review Focus 1: request a self-service reset for an invited account → status still `invited`, and `check`
    on the new token gives `first_password: true`.
  - Review Focus 2: a disabled invited account has status `disabled`.
  - `two_factor_enabled` matches the security section in the user detail and the access summary.
- [ ] **Step 2: Run** `cd api && SS_TEST_DB=serversherpa_test_uaf PYTHONPATH=src .venv/bin/python -m pytest tests/test_user_invites.py -q -p no:cacheprovider`. Expected: failures.
- [ ] **Step 3: Implement** as above, including the three template files.
- [ ] **Step 4: Run the Global Constraints API suite list.** Expected: pass.
- [ ] **Step 5: Commit:** `feat(users): invite links, admin-sent reset links, invited status, 2FA state flags`.

---

### Task 2: Portal — length, roles, Manage roles payload, worker login, 2FA notes, Add person hint

**Files:**
- Modify: `portal/src/pages/Users.tsx`:
  - Add person: `minLength` from `useAuth().passwordMinLength`; generator `generateTempPassword(Math.max(14, n + 2))`.
  - Role chips from the access summary.
  - The hint.
  - After creating without a login, close only.
- Modify: `portal/src/components/UserAdminModals.tsx`:
  - Reset password: `minLength` and button gating from the session; the error message.
  - ManageRolesModal: chips from the summary; org roles read-only; payload via `rolesPayloadForGlobalChange`.
- Modify: `portal/src/lib/format.ts`: `generateTempPassword(length = 14)` takes a length. Keep its crypto source.
- Modify: `portal/src/lib/users.ts`: remove `client`/`vendor` from `ROLE_CLS`.
- Create: `portal/src/components/users/GrantAccessModal.tsx` (moved from `pages/External.tsx`). Props:
  `{ person: { person_id: string; first_name: string; last_name: string; email: string | null }, onClose(): void, onDone(): void }`.
- Modify: `portal/src/pages/External.tsx`: use the shared modal.
- Modify: `portal/src/pages/WorkerDetail.tsx`: the "Give portal login" header button when `!worker.has_account &&
  can('users','add') && hasGlobalAccess`. Copy how Users.tsx checks global access, and reload on success.
- Modify: `portal/src/components/users/UserProfileTab.tsx`, `components/access/RolesTab.tsx` and
  `components/access/GroupsTab.tsx`: show the "Not in effect…" note with a `Link` to `/settings/security` when
  `two_factor_enabled` is false. Add the field to the TS types in `lib/types.ts` / `lib/access.ts`.
- Test: the colocated `*.test.tsx` files for each changed component, plus `components/users/GrantAccessModal.test.tsx`.

**Interfaces:**
- Consumes: Task 1's `two_factor_enabled` fields.
- Produces:
  - `GrantAccessModal` (named export from `components/users/GrantAccessModal.tsx`)
  - `generateTempPassword(length?: number): string`
  - a shared hook or function for the grantable role list: `grantableRoles(summary, actorMaxRank)` in
    `lib/access.ts`, returning the global and self roles you can grant, sorted by rank descending

- [ ] **Step 1: Write failing tests:**
  - **Minimum length:** with a mocked session minimum of 20 (Review Focus 4), the Add person and Grant inputs
    have `minLength` 20; the generated value is at least 22 characters; the Reset password button is enabled
    with a generated value and disabled with a 19-character one; a server `password_too_short` with
    `min_length` 20 shows "Temporary passwords need at least 20 characters."
  - **Role chips:**
    - Add person and Manage roles show the summary's grantable roles by label.
    - No "client" or "vendor" chip exists.
    - A role at or above the actor's rank isn't offered.
  - **Manage roles payload:**
    - For a person with `client_admin` and `staff`, unticking staff sends `[]`, and the org chip renders
      read-only with "Managed from the client's or partner's contacts page." (Review Focus 5).
    - Ticking admin sends `['admin','staff']`.
  - **Worker page:**
    - "Give portal login" shows only with no account and the right permission.
    - It opens the shared dialog, and success reloads the page.
  - **External:** still grants through the shared dialog (existing tests keep passing).
  - **2FA notes:**
    - With `two_factor_enabled: false`, the user page switch and the role and group switches show the
      "Not in effect…" note with a link to `/settings/security`.
    - With true, no note.
  - **Add person hint:**
    - All three hints for worker, external and staff with the account box unticked.
    - Creating without a login closes the dialog.
- [ ] **Step 2: Run** `cd portal && npx vitest run src/pages/Users.test.tsx src/components/UserAdminModals.test.tsx src/pages/WorkerDetail.test.tsx src/pages/External.test.tsx src/components/users src/components/access`. Expected: failures (create any missing test files).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd portal && npx vitest run && npx tsc -p tsconfig.json --noEmit`. Expected: pass.
- [ ] **Step 5: Commit:** `fix(portal): password length from the server, real role list, Manage roles keeps org roles, worker login, 2FA notes`.

---

### Task 3: Portal — invite and reset-link UI, Invited status, set-password page wording

**Files:**
- Modify: `portal/src/lib/api.ts`:
  - `adminCreateUserRequest` and `adminCreateAccountRequest` accept `invite`.
  - New `adminResendInviteRequest(personId)` and `adminSendResetLinkRequest(personId)`.
  - The reset `check` returns `{ valid, first_password }`.
- Modify: `portal/src/pages/Users.tsx`:
  - The Add person "Sign-in" choice when `useSystemStatus().email_enabled` (segmented "Email an invite link" /
    "Set a temporary password", invite as the default). The invite option hides the password and
    "Must change" fields.
  - The "Invited" status filter and chip (amber).
  - "Resend invite" in Actions for invited rows.
  - Hide "Reset password" for invited rows.
- Modify: `portal/src/components/users/GrantAccessModal.tsx`: the same Sign-in choice.
- Modify: `portal/src/components/UserAdminModals.tsx`: the Reset password dialog choice ("Email a reset link"
  as the default when email is on: "Send link", then the sent state) and a small "Resend invite" confirm or
  action helper.
- Modify: `portal/src/pages/UserDetail.tsx`: the header shows the "Invited" chip and "Resend invite", and hides
  "Reset password" for invited accounts.
- Modify: `portal/src/pages/ResetPassword.tsx`: the first-password wording when `first_password`.
- Modify: `portal/src/lib/users.ts` (status labels and classes) and `lib/types.ts` (status union includes
  `invited`).
- Test: the colocated tests, plus `pages/ResetPassword.test.tsx`.

**Interfaces:**
- Consumes: Task 1's API, and Task 2's `GrantAccessModal` and `generateTempPassword`.

- [ ] **Step 1: Write failing tests:**
  - **Email off:** Add person, Grant and Reset password show no choice and work as today.
  - **Email on, Add person:**
    - the default is invite
    - the submit body has `invite: true` and no `temp_password`
    - switching to "Set a temporary password" shows the fields and sends `temp_password`
  - **Grant:** with a blank login email and invite chosen, the existing validation applies and nothing crashes
    (Review Focus 3).
  - **Invited:** the chip and filter count, "Resend invite" calls the API and toasts "Invite sent to {email}.",
    and "Reset password" is hidden for invited rows and on the user page.
  - **Reset link:** the default when email is on; "Send link" calls `adminSendResetLinkRequest`; the success text
    is exact, including "expires soon." when no minutes are known.
  - **/reset-password:** first-password wording for both the form and the success card, and the reset wording
    otherwise.
- [ ] **Step 2: Run** the colocated tests. Expected: failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd portal && npx vitest run && npx tsc -p tsconfig.json --noEmit`, then the full API
  suite: `cd api && SS_TEST_DB=serversherpa_test_uaf PYTHONPATH=src .venv/bin/python -m pytest -q -p no:cacheprovider`.
  Run it in the foreground; it takes about 40 minutes.
- [ ] **Step 5: Commit:** `feat(portal): invite links and emailed reset links, Invited status, set-your-password page`.
