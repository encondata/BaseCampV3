# Email service + self-service password reset — design

Date: 2026-10-03 · Status: approved in brainstorming, awaiting spec review

## Problem

ServerSherpa sends no email. The API has `SS_SMTP_*` settings
(`config.py`) that nothing reads; the login page's **Forgot password**
button opens a hard-coded "call Jimmy" card; the user `NotifPrefs.email`
preference does nothing.

There are **no real email-provider credentials yet**. Production will run
with `SS_SMTP_HOST` empty for a while; dev (`docker-compose.dev.yml`,
`localhost:1026`) and the uat stack (`mailpit:1025`) route everything to
mailpit. The design must work cleanly in both states.

## Scope

In:

1. A shared email service: templated HTML + text, queued in an outbox
   table, delivered by the existing `notification-worker`. Failures are
   logged and recorded, never raised to users.
2. Self-service password reset by email.
3. When email is **not** configured: a reset request becomes an inbox
   card for admins (`users:change`), who use the existing admin
   **Reset password** action.

Out (decided):

- Notification emails (the `NotifPrefs.email` preference). The outbox is
  built so they can plug in later; no kinds are emailed in this round.
- Quiet hours / DND / digest delivery (`NotificationGroup` columns).
- Outbox purge/retention job.
- An admin UI for the outbox.

## Settings

New env settings in `config.py`, `.env.example`, the dev `.env`, and the
uat stack's `x-ss-env` (`deploy/stack/api/compose.yml`). They appear in
Developer › System config › **Environment** automatically (that tab lists
`.env` keys).

| Key | Default | Meaning |
|---|---|---|
| `SS_PASSWORD_RESET_TTL_MINUTES` | 15 | Reset link lifetime |
| `SS_PASSWORD_RESET_RATE_LIMIT` | 5 | `/password-reset/request` calls per IP per hour |
| `SS_PASSWORD_RESET_CONFIRM_RATE_LIMIT` | 20 | `/password-reset/check` + `/confirm` calls per IP per hour (one shared counter) |

Existing `SS_SMTP_HOST/PORT/USERNAME/PASSWORD/STARTTLS/FROM` are used as is.
**Email is enabled** iff `smtp_host` and `smtp_from` are both non-empty
(`mail.email_enabled()`).

## Part 1 — Email service and outbox

### Table `email_outbox` (migration 0089)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `template` | text | e.g. `password_reset` |
| `to_address` | citext | |
| `person_id` | uuid null → people | for tracing |
| `subject` | text | rendered at enqueue |
| `html_body` | text | rendered at enqueue |
| `text_body` | text | rendered at enqueue |
| `status` | text | `queued` · `sending` · `sent` · `failed` · `skipped` (CHECK) |
| `attempts` | int default 0 | |
| `next_attempt_at` | timestamptz | default now(); index with status for the claim query |
| `last_error` | text null | truncated |
| `worker_id` | text null | |
| `heartbeat_at` | timestamptz null | stale sweep |
| `created_at` | timestamptz | |
| `sent_at` | timestamptz null | |

The row holds the fully rendered message, so it is exactly what was (or
would have been) sent. Rows are kept indefinitely for now. The token
inside a reset email body is single-use and short-lived; `html_body` and
`text_body` are never returned by any API.

### Package `api/src/serversherpa/mail/`

(Named `mail`, not `email`, so it never shadows the stdlib `email` package.)

- `templates/` — Jinja2 (already a dependency), autoescape on for HTML.
  Shared `_base.html` (plain inline-styled layout: ServerSherpa name,
  content block, footer "You're receiving this because…") and per email
  `<name>.html`, `<name>.txt`, `<name>.subject`.
- `render.py` — `render(template, **ctx) -> Rendered(subject, html, text)`.
- `outbox.py` — `enqueue(db, template, to, *, person_id=None, **ctx)`:
  renders and `db.add`s a row in the caller's transaction, **never
  commits** (same contract as `notify()` / `audit()`), so mail goes out
  only if the request commits. Enqueues even when email is disabled; the
  worker records those as `skipped`.
- `transport.py` — `send(msg)`: stdlib `smtplib` + `email.message`
  (`multipart/alternative`, text then HTML), run via `asyncio.to_thread`;
  STARTTLS when `smtp_starttls`; `login()` only when `smtp_username` is
  set; 20 s timeout. No new dependency.
- `delivery.py` — `deliver_once(maker) -> int`:
  - `requeue_stale` first: rows `sending` with `heartbeat_at` older than 15
    min go back to `queued`.
  - Claim up to 20 rows `status='queued' AND next_attempt_at <= now()`
    with `FOR UPDATE SKIP LOCKED`, mark `sending`, commit.
  - Email disabled → `skipped`, one INFO log per row.
  - Send OK → `sent`, `sent_at`.
  - Send raises → `attempts += 1`, `last_error`; if `attempts < 5`,
    `queued` with `next_attempt_at = now() + [1, 5, 15, 60] min[attempts-1]`;
    otherwise `failed` with an ERROR log. Exceptions never escape the loop.

### Worker

`notifications/worker.py` loop calls `deliver_once` every poll (default
5 s) besides the hourly reminders, skips both while `poll_workers_paused`;
its 15-minute idle line reports whether email delivery is on. No new process, Procfile
line, or compose service.

## Part 2 — Password-reset API

### Table `password_reset_tokens` (migration 0089)

`id` uuid pk · `person_id` → people (cascade) · `token_hash` text unique
(hex SHA-256 of the raw token) · `created_at` · `expires_at` · `used_at`
null · `requested_ip` text null. The raw token is
`secrets.token_urlsafe(32)` and exists only inside the email.

### Shared refactor

`_revoke_all_sessions` moves from `api/routes/users.py` to
`services/sessions.py` as `revoke_all_sessions(db, person_id, reason)`;
the admin routes and the reset flow both call it.

### Endpoints (in `api/routes/auth.py`, all public)

**`GET /system/status`** (already public, already read by the login
page) gains `email_enabled`, `password_reset_ttl_minutes` and
`password_min_length`. No new options endpoint.

**`POST /auth/password-reset/request {email}`** → always `202 {"status":
"accepted"}` (429 `rate_limited` when the IP is over
`SS_PASSWORD_RESET_RATE_LIMIT`). Behind it:

1. Load `user_accounts` by email (CITEXT). Missing, `disabled_at` set, or
   person archived → do nothing more.
2. Email enabled:
   - set `used_at = now()` on that person's unused tokens (newest link
     wins);
   - insert a token, `enqueue(..., "password_reset", link=
     f"{portal_origin}/reset-password#token={raw}", ttl_minutes=…,
     name=first_name)`;
   - `audit(entity_type="auth", entity_id=<email>, actor_id=None,
     action="password.reset_requested", ip=…)`.
3. Email disabled → admin request card (below) and
   `audit(action="password.reset_requested", changes={"via": "admin"})`.

Locked-out accounts (`locked_until` in the future) are treated like
active ones; a completed reset clears the lock. Known residual: a request
for a real account does a few more DB writes than one for an unknown
email, so response *timing* differs by milliseconds; the body and status
never do.

**`POST /auth/password-reset/check {token}`** → `{valid: bool}`. Counts
against the confirm limiter.

**`POST /auth/password-reset/confirm {token, new_password}`** → 204.
Counts against the confirm limiter. A token is **valid** when it exists,
`used_at` is null, `expires_at > now()`, the account is active, and
`account.password_updated_at` is not later than `token.created_at`.
Invalid → 400 `reset_token_invalid` (one code for every reason). Then:

1. `require_password_length`, `raise_if_reused` (422
   `password_recently_used`), `apply_password(must_change=False, now=…)`.
2. Token `used_at = now()`.
3. `failed_login_count = 0`, `locked_until = None`.
4. `revoke_all_sessions(db, person_id, "password_reset")`.
5. `totp_service.revoke_trust(db, person_id)`, so the next sign-in
   requires 2FA.
6. Resolve open admin request cards for the person (`resolved_by` = the
   person's own name).
7. `audit(entity_type="user_account", entity_id=person_id, actor_id=person_id,
   action="password.reset_self", ip=…)`.
8. `enqueue(..., "password_changed", ...)`: "Your ServerSherpa password
   was changed. If this wasn't you, contact your administrator."
9. Commit. No sign-in; the user goes to `/login`.

### Rate limiting

Two module-level `IpRateLimiter` instances (`wiki/share_links.py`,
window 3600 s, limits from settings), keyed by `rate_limit_ip(request)`.
They are per process and in memory, the same as the existing users.

### Admin request card (email disabled)

- Kind `password_reset_request`, title "{First Last} asked for a password
  reset", link `/people/users/{person_id}`, payload `{target_person_id,
  state: "open", count, last_requested_at}`.
- Recipients: `approver_ids(db, resource="users", action="change")`.
- Shows the person's name, never the typed email. Requests for unknown
  emails create nothing. The requester's response is identical in every
  case.
- **Bump:** if that person already has open cards, update `count` and
  `last_requested_at` and clear `read_at` / `dismissed_at` on the
  existing copies instead of inserting.
- **Resolve:** when the password is reset (admin `reset-password` route or
  self-service confirm), set `state: "resolved", resolved_by` on every
  copy (the `resolve_copies` pattern from `notifications/requests.py`).

## Part 3 — Portal

- **`Login.tsx`** reads the new fields from `/system/status` (it already
  fetches it on mount). **Forgot password**
  opens a modal (modal-header pattern: eyebrow, title, description; login
  `.auth-scrim` styling; sized to content) with one email field,
  pre-filled from the sign-in email box. After submit, one fixed message
  per mode:
  - email on: "If an account exists for that email, a reset link is on its
    way. It expires in {ttl} minutes."
  - email off: "If an account exists for that email, your administrators
    have been asked to reset it. They'll be in touch."
  - 429: "Too many requests. Try again later."
- **`/reset-password`** (public route beside `/login` in `App.tsx`):
  reads `#token=`, strips the fragment with `history.replaceState`, calls
  `/check`.
  - Invalid: "This link has expired or was already used" plus a
    **Request a new link** button (→ `/login?forgot=1`, which opens the
    modal).
  - Valid: a card styled like `ForceChangePassword` with **New
    password** and **Confirm password**. `ChangePasswordForm` gets a reset
    variant (no current-password field, submits to `/confirm`) sharing its
    error map.
  - Success: "Password changed" plus a **Sign in** button.
- **Inbox:** `password_reset_request` renders with the standard
  title/link; a resolved card shows "Resolved by {name}" the way resolved
  membership requests do.
- Copy is American English.

## Testing

TDD per task.

- **API pytest:**
  - render (HTML escaping, text part);
  - enqueue is transactional (rollback → no row);
  - delivery against a fake transport: sent, retry with backoff, `failed`
    after 5, `skipped` with no SMTP, stale requeue;
  - **enumeration parity**: an existing, a missing, and a disabled account
    get byte-identical status and body;
  - newest-link-wins, expiry, single use, invalid after an admin reset;
  - confirm effects: history refusal, sessions revoked, trust revoked (the
    next login returns a TOTP challenge for a 2FA user), lockout cleared,
    cards resolved, confirmation email enqueued;
  - both rate limiters;
  - admin cards fan out, bump, and resolve; the card never contains the
    typed email.
- **Portal vitest:** forgot modal (both modes, 429); reset page (invalid,
  valid, mismatch, recently used, success; fragment stripped).

## Live verification (dev)

1. Dev mailpit at `localhost:1026`, UI `:8025`; the dev `.env` already
   points there.
2. Request a reset in the browser pane, find the mail in mailpit, check the
   HTML and text parts, follow the link, set a password, and confirm the
   old sessions are revoked and sign-in asks for 2FA again.
3. Reuse the link and confirm it's rejected; the "password changed" mail
   arrives.
4. With `SS_SMTP_HOST` cleared and the API restarted: request again, see
   the admin card, reset from the user page, and see the card resolve.

uat-stack mailpit verification follows the normal deploy after merge.

## Docs

`.env.example` (three keys plus comments), uat compose env, and a
Features wiki page row plus Change log entry at ship time.
