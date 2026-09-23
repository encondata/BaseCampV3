# Two-factor authentication (TOTP) — design

**Date:** 2026-09-23  
**Branch:** `two-factor-auth` (worktree `.claude/worktrees/two-factor`)  
**Status:** approved in conversation; spec pending user review

## Goal

Portal sign-in can require a second factor from an authenticator app (Google
Authenticator, Apple Passwords, 1Password, Authy…). Requirement is set per
user, per access group, per role, or for the whole site. Once enrolled, a user
enters a code at every sign-in unless they checked "Remember this browser",
in which case the code is asked again after `SS_TOTP_TRUST_DAYS` (default 7).
Users who are required but not enrolled are forced through enrollment at their
next sign-in. Recovery is eight one-time backup codes plus an admin reset.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Required but not enrolled | **Forced enrollment** at next portal sign-in (no grace period, no snooze). |
| "Per group" | **Both** access groups and roles carry a `totp_required` flag. |
| Remember me | **2FA trust only.** Session TTL is untouched (absolute 24 h). Trust is a separate httpOnly cookie. |
| Kiosks | **Exempt.** Kiosk password sign-in and phone pairing never challenge. Only `client == "portal"` does. |
| Recovery | **Backup codes + admin reset** (+ a CLI reset as the last resort). |
| Self-service | **Enroll and regenerate backup codes only.** No self-service turn-off. |
| Login flow shape | **Challenge token; no session until the second factor passes** (approach A). |

## What already exists (reuse, do not rebuild)

- `user_accounts.totp_secret_enc` (BYTEA, Fernet) and `totp_confirmed_at`
  (migration 0001, `db/models.py:74-75`).
- `SS_TOTP_ENCRYPTION_KEY: SecretStr` in `config.py:48` + `.env.example`;
  `cryptography` is a dependency; Fernet is not used anywhere yet.
- `services/auth.py:101-104` raises `AuthError("totp_required")` when
  `totp_confirmed_at` is set — this is replaced by the branch logic below.
- `system_config.security` = `{ two_factor_enabled, two_factor_required }`
  with `GET/PUT /system/security` and `SecurityControls.tsx`.
- `audit.SENSITIVE_FIELDS` already redacts `totp_secret_enc`.
- `portal/src/styles/auth-theme.css:110-154` ships the V2 `.otp-card`,
  `.otp-inputs` (six 48×58 boxes), `.otp-error`, `.otp-actions` styling.
- `portal/src/labels/containerLabelAdapters.browser.ts:30` `generateQRCode`
  (bwip-js) renders a QR to a data URL — reuse for the `otpauth://` QR.
- Forced-password-change gate in `deps.py` (`FORCED_CHANGE_EXEMPT_PATHS`) —
  precedent only; 2FA does NOT extend it (see flow).
- `POST /users/{id}/unlock` (`routes/users.py:575`) — template for the admin
  reset endpoint (`require_permission("users","change")` → `_load_target`
  rank check → mutate → `audit` → commit).

## Policy

Site switch `two_factor_enabled` (existing) is the master switch. When it is
off nothing challenges and nothing enrolls; stored secrets are kept.

A user **must use 2FA** when `two_factor_enabled` and any of:

1. site `two_factor_required` is on;
2. `user_accounts.totp_required` is true;
3. any access group they belong to (`access_group_members`) has
   `totp_required`;
4. any role they hold (`person_roles` not revoked) has `totp_required`.

An enrolled user (`totp_confirmed_at` set) is challenged even when not
required, as long as `two_factor_enabled` is on. Resolver:
`services/totp.py: async def required_for(db, person_id) -> bool`.

## Data (migration 0071 `two_factor_auth`)

```
user_accounts
  + totp_required        boolean not null default false
  + totp_last_counter    bigint null      -- last accepted TOTP time-step, replay guard

access_groups
  + totp_required        boolean not null default false
roles
  + totp_required        boolean not null default false

totp_backup_codes
  id          uuid pk default gen_random_uuid()
  person_id   uuid not null references user_accounts(person_id) on delete cascade
  code_hash   text not null        -- Argon2id + pepper, same helper as passwords
  used_at     timestamptz null
  created_at  timestamptz not null default now()
  index (person_id)

trusted_devices
  id           uuid pk default gen_random_uuid()
  person_id    uuid not null references user_accounts(person_id) on delete cascade
  token_hash   text not null unique   -- sha256 of the 256-bit cookie token
  user_agent   text null
  created_at   timestamptz not null default now()
  last_used_at timestamptz null
  expires_at   timestamptz not null
  revoked_at   timestamptz null
  index (person_id)
```

Models: `TotpBackupCode`, `TrustedDevice`; `totp_required` on `UserAccount`,
`AccessGroup`, `Role`.

## Config

- `SS_TOTP_TRUST_DAYS=7` — `Settings.totp_trust_days: int = 7`. Documented in
  `.env.example` ("how long 'Remember this browser' skips the code").
- `SS_TOTP_ENCRYPTION_KEY` — already declared; a startup check in
  `get_settings` consumers must fail fast with a clear message if the value
  is not a valid Fernet key when 2FA is enabled (checked lazily in
  `services/totp.py` on first use, raising `RuntimeError("SS_TOTP_ENCRYPTION_KEY is not a valid Fernet key")`).
- New dependency: `pyotp>=2.9` in `api/pyproject.toml`.

## Service layer (`services/totp.py`)

```python
ISSUER = "ServerSherpa"
CHALLENGE_TTL_SECONDS = 300
BACKUP_CODE_COUNT = 8
BACKUP_CODE_LENGTH = 10          # a-z0-9 without ambiguous chars, shown as XXXXX-XXXXX

def encrypt_secret(secret: str) -> bytes / decrypt_secret(blob: bytes) -> str   # Fernet
async def required_for(db, person_id) -> bool
async def begin_enrollment(db, account) -> tuple[str secret, str otpauth_uri]
    # new pyotp.random_base32() (160-bit), stored encrypted with totp_confirmed_at = None;
    # re-enrolling an unconfirmed account overwrites; an already-confirmed account raises AuthError("totp_already_enrolled")
async def confirm_enrollment(db, account, code, *, actor_id, ip) -> list[str]
    # verify code against pending secret (valid_window=1) → totp_confirmed_at=now, totp_last_counter,
    # revoke trusted devices, generate + store backup codes, return plaintext codes once
async def verify_code(db, account, code, *, ip) -> Literal["totp", "backup"]
    # 6 digits → pyotp verify with valid_window=1, reject counter <= totp_last_counter (replay);
    # otherwise strip dashes/case and try unused backup codes → mark used_at;
    # failure raises AuthError("totp_invalid") and bumps failed_login_count / lockout like a bad password
async def regenerate_backup_codes(db, account, *, actor_id) -> list[str]
async def reset(db, account, *, actor_id, ip)      # secret, confirmed_at, counter, backup codes, trusted devices all cleared
def make_challenge_token(person_id, purpose: Literal["verify","enroll"], *, secret) -> str   # HS256 JWT typ="totp", exp 5 min
def decode_challenge_token(token, *, secret) -> tuple[uuid, purpose]
async def issue_trust(db, account, user_agent) -> str token
async def check_trust(db, account, token) -> bool   # hash match, not revoked, not expired → bump last_used_at
async def revoke_trust(db, person_id)
```

Audit actions (entity_type `user_account`): `totp.enroll`, `totp.confirm`,
`totp.verify_failed`, `totp.backup_used`, `totp.codes_regenerated`,
`totp.reset`, `totp.trust`, `totp.required_set` (user flag). Group/role flag
changes audit as `access_group.update` / `role.update` with a `changes` diff.

## Login flow (`services/auth.py::login`, `routes/auth.py`)

After the password verifies and the account passes the existing usability and
lockout checks, and only when `client == "portal"`:

```
enabled = security.two_factor_enabled
if not enabled:                         → session (as today)
elif account.totp_confirmed_at:          
    if check_trust(ss_trust cookie):    → session
    else                                → LoginChallenge("verify")
elif await required_for(account):       → LoginChallenge("enroll")
else                                    → session
```

Kiosk client: unchanged path, never challenged. Phone pairing: unchanged.
The old `raise AuthError("totp_required")` is removed.

`POST /auth/login` response becomes a union:

```json
{ "status": "ok", ...SessionOut }                                   // 200
{ "status": "totp_verify", "challenge_token": "…", "backup_codes_remaining": 6 }   // 200
{ "status": "totp_enroll", "challenge_token": "…" }                 // 200
```

`SessionOut` gains `status: "ok"`. Kiosk and Android clients ignore the field.

## Endpoints

All in `routes/auth.py` unless noted. `ChallengeOrUser` is a dependency that
accepts either `Authorization: Bearer <access token>` (normal session) or a
body/header `challenge_token`; it returns the `UserAccount` and the purpose.

| Method / path | Auth | Body | Returns |
|---|---|---|---|
| `POST /auth/totp/verify` | challenge (`verify`) | `code`, `remember: bool` | `SessionOut`; sets `ss_refresh`; with `remember` also sets `ss_trust` |
| `POST /auth/totp/enroll/start` | challenge (`enroll`) or session | – | `{ secret, otpauth_uri }` |
| `POST /auth/totp/enroll/confirm` | challenge (`enroll`) or session | `code`, `remember?` | `{ backup_codes: [8], session?: SessionOut }` — session (and cookies) only on the challenge path |
| `POST /auth/totp/backup-codes/regenerate` | session | `code` (current TOTP) | `{ backup_codes: [8] }` |
| `GET /auth/me` | session | – | adds `totp: { enrolled, enrolled_at, required, backup_codes_remaining }` |
| `POST /users/{id}/totp/reset` | `users:change` + rank | – | 204; `totp.reset` audit |
| `PUT /users/{id}/totp-required` | `users:change` + rank | `{ required }` | 204 |
| `PATCH /access/groups/{group_id}` | `access:change` | `{ totp_required }` | `GroupOut` |
| `PATCH /access/roles/{name}` | `access:change` + rank | `{ totp_required }` | `RoleOut` |
| `GET /users/{id}` | as today | – | `account.totp_enrolled`, `account.totp_required`, `account.totp_effective_required` |
| `GET /access/summary` | as today | – | groups and roles carry `totp_required` |

Cookies: `ss_trust` — httpOnly, `secure` outside development, `samesite=lax`,
`path=/auth`, `max_age = totp_trust_days * 86400`, same `cookie_domain` as
`ss_refresh`. Logout does NOT clear it (that is the point of "remember").
`totp.reset`, re-enrollment, and `POST /users/{id}/sessions/revoke-all`
revoke every `trusted_devices` row for the person.

Rate limiting: `rate_limit_ip` on verify, enroll/confirm and regenerate.
Failed codes count toward `failed_login_count` and lockout exactly like failed
passwords (`account_locked` → 423).

CLI: `serversherpa reset-totp --email …` calls `services.totp.reset` with
`actor_id=None` and prints a confirmation.

## Portal

### Login page (`pages/Login.tsx`)

State machine: `password` → `verify | enroll` → done. The map layout, brand
scene, `data-reveal` form reveal, and `shakeForm` stay. The password form's
"Keep me signed in" checkbox is removed (it did nothing).

- **verify**: `.auth-scrim` / `.otp-card`: heading "Enter your code", six
  `.otp-inputs` boxes (auto-advance, paste of six digits fills all, Backspace
  moves back), "Remember this browser for {N} days" checkbox (N from
  `GET /system/status` — see below), "Use a backup code" link that swaps the
  boxes for one text field (`XXXXX-XXXXX`), "Back to sign in". Wrong code:
  `.otp-error` message + `shakeForm`. `account_locked` shows the existing
  locked message. Auto-submits when the sixth digit lands.
- **enroll**: three steps inside the same card. 1) QR (data URL from the
  bwip-js helper, extracted to `lib/qr.ts` so both the login page and the
  profile modal import it) + "Can't scan? enter this key" showing the base32
  secret in groups of four + a six-box confirm input. 2) Backup codes in a
  two-column mono grid with Copy and Download (.txt) buttons and an "I've
  saved my codes" button (disabled until Copy or Download was clicked, or
  after 5 s). 3) navigate to `from ?? '/'`.
- Tab order test extended: on the verify card, Tab goes box 1 → … → box 6 →
  Remember checkbox → Verify. Secondary links stay `tabIndex={-1}`.

The trust window is public: add a `totp_trust_days` field to the existing
unauthenticated `GET /system/status` (`SystemStatusOut`, already used by the login page
for banners) rather than a new endpoint.

### `AuthContext` / `lib/api.ts`

`loginRequest` returns `LoginResult = SessionData | TotpChallenge`. `login()`
in the context returns the challenge to the caller instead of setting state;
`completeTotp(sessionData)` sets state. New api helpers: `totpVerify`,
`totpEnrollStart`, `totpEnrollConfirm`, `totpRegenerateBackupCodes`,
`resetUserTotp`, `setUserTotpRequired`, `patchAccessGroup`, `patchRole`.
`SessionData.user.totp` typed as above.

### My Profile (`pages/Profile.tsx`, Profile tab)

The "Two-factor auth" row becomes:
- not enrolled: "Off" + `Set up 2FA` button → `TotpEnrollModal` (report-generate
  header pattern: eyebrow "Security", title "Set up two-factor authentication",
  steps Scan → Confirm → Save codes; same three-step body as the login enroll
  card, without navigation at the end). When policy requires 2FA the row says
  "Required by policy".
- enrolled: "On since {date} · {n} backup codes left" + `Regenerate backup
  codes` button → small modal asking for a current code, then shows the new
  codes with Copy/Download.
- No turn-off control.

### User detail (`pages/UserDetail.tsx`, Account card)

New row "Two-factor": status (`Enrolled {date}` / `Not enrolled`), an
"effective" note when required by group/role/site ("Required by policy"), a
`Require 2FA` Switch (writes `PUT /users/{id}/totp-required`, disabled when
already required by policy since it would be a no-op), and `Reset 2FA`
(only when enrolled; confirm modal "This signs {name} out of trusted
browsers and they will enroll again at their next sign-in").

### Admin › Access

- Group card (`GroupsTab.tsx`): a `Require 2FA` Switch next to the member
  count, `canEdit` gated, PATCHes the group.
- Role card (`RolesTab.tsx`): the same Switch in the role header, gated by
  `canEdit` and rank like the matrix save.

### Settings › Security (`SecurityControls.tsx`)

Copy: "Enable two-factor authentication — lets users enroll and challenges
enrolled users at sign-in" and "Require for everyone — every user must enroll
at their next sign-in". A read-only line: "Remembered browsers skip the code
for {N} days (SS_TOTP_TRUST_DAYS)".

## Security details

- Secret: `pyotp.random_base32()` (32 chars = 160 bits), encrypted at rest.
  Decrypted only inside `services/totp.py`; never returned after
  `enroll/start` (the profile modal re-runs start if the user closes it).
- `otpauth://totp/ServerSherpa:{email}?secret=…&issuer=ServerSherpa&algorithm=SHA1&digits=6&period=30`
  (label prefix and issuer both `ServerSherpa`).
- Verify: `valid_window=1`; the accepted 30-second counter is stored in
  `totp_last_counter` and any code with counter ≤ stored is rejected (replay).
- Backup codes: 10 chars from `abcdefghjkmnpqrstuvwxyz23456789`, displayed
  `xxxxx-xxxxx`, compared case-insensitively with dashes stripped; hashed with
  the existing Argon2id + pepper helper; each usable once; `backup_codes_remaining`
  is exposed so the UI can nudge regeneration when ≤ 2.
- Challenge token: HS256 JWT signed with `SS_JWT_SECRET`, claims
  `sub`, `typ="totp"`, `purpose`, `iat`, `exp` (+300 s). It grants nothing but
  the 2FA endpoints. The account is re-checked (not disabled, not locked,
  still requires / still unenrolled) on every use.
- Trust cookie: 256-bit `secrets.token_urlsafe`, stored SHA-256; checked only
  on portal login; per-browser; not bound to IP.
- Timing: bad codes take the same path as bad passwords (counter + lockout);
  the unknown-account dummy hash path is untouched.
- The refresh cookie is never set before the second factor passes.

## Out of scope (deferred)

Kiosk challenges (web + Android), grace/snooze, email or SMS delivery,
WebAuthn/passkeys, listing/revoking individual trusted browsers, importing
V2 `totp_*` columns through the workers import, trusted-device binding to
sessions list.

## Testing

**API (pytest, real Postgres):**
- `test_totp_service.py`: encrypt/decrypt round trip; invalid key error;
  `required_for` for each OR branch and the master-switch-off case; verify
  accepts current and ±1 step, rejects replay, rejects garbage; backup code
  accepted once then rejected; regenerate invalidates old codes; reset clears
  everything including trusted devices.
- `test_totp_api.py`: login → `totp_verify` when enrolled; login → `totp_enroll`
  when required and unenrolled; login → session when not required and
  unenrolled; `client=kiosk` never challenged; verify wrong code → 401
  `totp_invalid`, counts toward lockout → 423; verify right code → session +
  `ss_refresh`; `remember` sets `ss_trust` and the next login skips the code;
  expired/forged/wrong-purpose challenge token → 401; enroll start/confirm via
  challenge mints a session and returns 8 codes; enroll via session (profile)
  does not mint a session; confirm with wrong code → 401 and stays unenrolled;
  `two_factor_enabled=false` → never challenged even when enrolled;
  `/auth/me.totp` shape; regenerate needs a valid code; admin reset needs
  `users:change` and respects rank (`_load_target`); trusted devices revoked
  by reset and by revoke-all; group PATCH and role PATCH flags flow into
  `required_for`; `GET /users/{id}` reports `totp_effective_required`;
  challenge token cannot call `/auth/me`.
- `test_env_api.py` / `test_system_api.py`: `totp_trust_days` on
  `/system/status`.
- CLI: `reset-totp` clears the account (invoke the typer command in-process).

**Portal (vitest + RTL):**
- `Login.test.tsx`: password → verify card; six boxes auto-advance and
  auto-submit; backup code toggle; remember checkbox sent; error shake path;
  enroll flow renders QR, confirms, shows codes, "I've saved" enabled after
  Copy; extended tab order.
- `TotpEnrollModal.test.tsx`, `UserDetail.test.tsx` (2FA row, reset confirm),
  `GroupsTab` / `RolesTab` switch PATCH calls, `SecurityControls.test.tsx`
  copy + trust line, `Profile.test.tsx` enrolled / not enrolled rows.

**Live verify:** worktree API 8001 + portal 5175, `SS_TOTP_ENCRYPTION_KEY`
generated for the worktree `.env`, enroll `alice`-style dev account with a
real authenticator app (or `pyotp` in a shell to mint codes), check the
remember cookie skips the code, reset from the admin page, confirm the kiosk
web login still works for the same account.
