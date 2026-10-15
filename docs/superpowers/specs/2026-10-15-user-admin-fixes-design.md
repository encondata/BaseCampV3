# User administration fixes — design

Status: approved by Jimmy on 2026-10-15 ("fix them all"). Invite links last **24 hours**.
Branch `user-admin-fixes`.

These seven fixes came out of writing the wiki's "Managing users: an admin guide".

## 1. Temporary password length follows the server setting

- **The only rule** is the server's `SS_PASSWORD_MIN_LENGTH` (`settings.password_min_length`, default 8).
- **Where the portal reads it:** `useAuth().passwordMinLength`, which the session already provides.
- **Dialogs that change:** "Add person" (`Users.tsx`, hard-coded 10), "Grant portal access" (`External.tsx`, 10) and
  "Reset password" (`UserAdminModals.tsx`, 12 and a disabled button below 12) all use that value for
  `minLength` and for disabling their submit buttons.
- **Error messages:** every `password_too_short` message says the real minimum: "Temporary passwords need at least
  {n} characters.", where n is the server's `min_length`, or the session value if the server didn't send one.
- **Generated temporary passwords:** at least `max(14, n + 2)` characters. Use the existing crypto generator
  (`generateTempPassword` in `lib/format.ts`) in all three places. `Math.random` is not used.

## 2. Role choices come from the server

- **Where the list comes from:** "Add person" and "Manage roles" build their role chips from
  `GET /access/summary` instead of the hard-coded `['admin','staff','worker','client','vendor','external']`.
- **What's offered:** roles whose `scope_anchor` is `global` or `self` and that the signed-in person can grant
  (`canTouchRank`). Sort them by rank, highest first, and label them with the role's `label`.
- **Client and vendor roles** (anchor `client`/`partner`) are never offered. In "Manage roles", any the person
  already holds appear as read-only chips with the hint "Managed from the client's or partner's contacts page."
- **The retired names `client` and `vendor`** disappear from both dialogs and from `ROLE_CLS` in `lib/users.ts`.
  There are no such role rows any more; migration 0009 deleted them.

## 3. "Manage roles" keeps client and vendor roles

- The dialog sends only the global and self roles it edits, built with `rolesPayloadForGlobalChange` from
  `lib/access.ts`, the same helper Access control › Members uses.
- The server already keeps org-scoped grants that are missing from the payload, so saving no longer fails
  with `role_requires_org` for people who hold client or vendor roles.

## 4. Give a login to someone who doesn't have one

- **Shared dialog:** move `GrantAccessModal` out of `pages/External.tsx` into
  `components/users/GrantAccessModal.tsx`, taking a minimal `{person_id, first_name, last_name, email}`.
  External keeps using it.
- **Worker page button:** the worker detail page (`pages/WorkerDetail.tsx`) shows **"Give portal login"** in its
  header when `worker.has_account` is false and the signed-in person has `users` add with global access. It
  opens the shared dialog, and the page reloads on success.
- **Demote dialog wording:** "can be given a login again later" stays, because it's now true: People ›
  Workers › the person › Give portal login.

## 5. "Require 2FA" switches say when they have no effect

- **New server field:** `two_factor_enabled: bool` (the site's two-factor master switch) is added to
  `UserDetailOut.account` and to the `GET /access/summary` response.
- **While it's false:**
  - The user page's "Require 2FA" switch and the role and group switches in Access control stay usable, so
    they can be set in advance.
  - Next to each switch, show "Not in effect — two-factor is off in System settings › Security." The
    "System settings › Security" part links to `/settings/security`.

## 6. Accurate "Add person" hint without a login

Replace "Without an account this person won't appear in the Users list — they'll show in the People directory
when it lands." with a hint that depends on the chosen roles:

| Roles chosen | Hint |
|---|---|
| Include Worker | "Without a login they won't be in the Users list; you'll find them under People › Workers." |
| Include External but not Worker | "Without a login they won't be in the Users list; you'll find them under People › External." |
| Anything else | "Without a login or the Worker role they won't appear in any list. Add the Worker role, or create a login." |

After creating someone without a login, close the dialog. Don't try to open a row that isn't in the list.

## 7. Invite and reset emails

Everything here only appears when email is configured (`email_enabled()` on the server, `email_enabled` in
`/system/status` for the portal). Without email, the portal behaves exactly as it does today.

### Invites

- **New setting:** `invite_ttl_minutes: int = 1440` in `config.py`. `SS_INVITE_TTL_MINUTES` overrides it.
- **New email template:** `user_invite` (`.subject.txt`, `.txt`, `.html`), with no reference to an
  administrator role.
  - Subject: "You've been invited to ServerSherpa".
  - Body: greets `{{ name }}`, says an account was set up for `{{ email }}`, gives `{{ link }}` with "works once
    and expires in {{ ttl_text }}", says to sign in at `{{ login_url }}` afterwards, and ends with "If you
    weren't expecting this, you can ignore this email."
- **`POST /users` (Add person)** gains `invite: bool = false`. When `create_account` and `invite` are both true:
  - `temp_password` isn't required and is ignored.
  - The account is created with no password.
  - A token is issued with `password_reset.issue_token(minutes=settings.invite_ttl_minutes)`.
  - `user_invite` is queued with `link=portal_url("/reset-password#token=…")`, `ttl_text` from
    `first_admin.ttl_text`, and `login_url`.
  - The audit row includes `"invited": true`.
  - If `invite` is true and email isn't configured, the answer is 422 `mail_not_configured`.
- **`POST /users/{id}/account` (Grant portal access)** gains the same `invite` option, with the same rules.
- **`POST /users/{id}/invite` (Resend invite)**:
  - Allowed only while the account has no password. If it already has one, the answer is 409 `not_invited`.
  - Issues a new token, which retires the old link, and queues `user_invite` again.
  - Needs `users` change, global access and the usual rank rule. Returns 204. 422 `mail_not_configured` if
    email is off.
- **Account status:** an account with no password, and not disabled, has status **`invited`** in `UserItem` and
  `UserDetailOut`. `_status` in `users.py` returns it before `locked`/`active`.
- **Portal:**
  - **Add person** and **Grant portal access** get a "Sign-in" choice (segmented): **"Email an invite link"**,
    the default when email is on, or **"Set a temporary password"**. The invite option hides the
    temporary-password field and "Must change password".
  - **Status chip:** the Users list and the user page show an "Invited" chip (amber), and "Invited" is a status
    filter alongside Active, Locked and Disabled.
  - **Resend invite:** invited accounts get **"Resend invite"** in the row's Actions menu and in the user page
    header. The toast says "Invite sent to {email}."
  - **Hidden for invited accounts:** "Reset password" and "Require 2FA" make no sense until a password exists.
    Hide "Reset password"; leave the 2FA switch as it is.

### Admin-sent reset links

- **`POST /users/{id}/reset-link`**:
  - Needs `users` change, global access and the rank rule, and can't target yourself.
  - Issues a token with the **existing** `settings.password_reset_ttl_minutes` and queues the existing
    `password_reset` template, exactly as the self-service request does.
  - Audits `password.reset_link_sent`. Returns 204.
  - 422 `mail_not_configured` if email is off. 409 `invited` if the account has never had a password; resend
    the invite instead.
  - It does **not** sign the person out or change their password until they use the link. Completing the link
    already revokes their sessions.
- **Portal:** the "Reset password" dialog gets a choice:
  - **"Email a reset link"** (default when email is on) with a "Send link" button.
  - **"Set a temporary password"**, which is today's flow.
  - The success state says "Reset link sent to {email}. It works once and expires in {n} minutes." The n comes
    from `/system/status` if it's there; otherwise the line is just "It works once and expires soon."

### The set-password page

- **`POST /auth/password-reset/check`** returns `{valid, first_password}`. `first_password` is true when the
  token's account has never had a password.
- **`/reset-password`, when `first_password` is true:**
  - Title "Set your password", lead "Choose a password to finish setting up your account.".
  - Success card "You're all set", "Sign in with your new password."
- Otherwise the page is unchanged.

## Out of scope

- Changing a person's own notification category choices.
- Bulk invites.
- Invite reminders.
- Org-contact (client or vendor) invites from the org pages. The same API option exists if they're wanted later.

## Testing

- **API:**
  - Invite create and grant, with and without email (422).
  - The invited status.
  - Sign-in refused while invited (already the case; pin it).
  - Resend rules (204, `not_invited`, rank, global).
  - The reset link (204, sessions untouched, `mail_not_configured`, `invited`, self, rank).
  - `check` returns `first_password`.
  - `two_factor_enabled` in both payloads.
  - The outbox rows hold the right template and link.
- **Portal (vitest):**
  - Minimum length from the session in all three dialogs.
  - Role chips from the summary, with no client or vendor.
  - The Manage roles payload drops org roles.
  - The worker page button, and the shared grant dialog.
  - The 2FA "Not in effect" notes.
  - The Add person hints.
  - The invite and reset-link choices hidden without email.
  - The Invited chip and filter, and Resend invite.
  - The /reset-password first-password wording.
