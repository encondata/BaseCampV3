# Sirdar — groundwork design

Date: 2026-10-01 · Branch: `sirdar` (worktree `.claude/worktrees/sirdar`)

## Purpose

Sirdar is a standalone app for building, installing, and managing
ServerSherpa environments (portal, kiosk, wiki, API, database). It is one
central instance that manages many environments. This first piece is the
groundwork only: a Dockerized web app with its own database, sign-in for
portal users ranked admin or higher, the portal's permission model, and
the portal's login page and navigation structure. Environment building is
designed separately later.

## Decisions

- **Separate backend (approach A).** `sirdar/api` is its own FastAPI
  package (`sirdar_api`) with its own models and Alembic chain. It does not
  import the main `serversherpa` package at runtime, so Sirdar can install
  or upgrade the API without being tied to its code version. The few
  security pieces it needs (Argon2 + pepper, TOTP encrypt/verify, tokens,
  rank rule, permission resolver) are copied, and compatibility tests pin
  them to the portal's.
- **Shared frontend through `@portal`.** `sirdar/web` imports portal
  stylesheets and an allowlisted set of portal React modules, the same way
  the wiki does (alias, `dedupe`, allowlist test).
- **Portal owns identity.** Sirdar copies users from the portal and keeps
  its own mirror. Identity fields are overwritten on every import. Sirdar
  never changes a portal user's password or 2FA enrollment.
- **2FA follows the portal policy.** The import works out each person's
  portal 2FA requirement and stores the result.
- **Local bootstrap admins.** A CLI creates Sirdar-only users so Sirdar
  can start with no portal at all.
- **Later sync.** The import is one service function, which is where
  scheduled sync will go.

## Layout

```
sirdar/
  api/                 FastAPI package sirdar_api, Alembic migrations (own chain from 0001), CLI
  web/                 Vite/React SPA (@portal alias + allowlist test)
  Dockerfile           multi-stage: build web, then a Python image serving the API and the static SPA
  docker-compose.yml   sirdar (internal port 8080) + sirdar-db (postgres:16, own volume)
  install.sh           sparse checkout (sirdar, portal/src, portal/public), status/wiki precedent
  .env.example
```

Environment:

| Variable | Meaning |
|---|---|
| `SIRDAR_DATABASE_URL` | Sirdar's own Postgres |
| `SIRDAR_SOURCE_DATABASE_URL` | Portal Postgres, read-only. Optional; unset disables import |
| `SIRDAR_JWT_SECRET` | Signs Sirdar access and challenge tokens. Never the portal's |
| `SS_PASSWORD_PEPPER` | Must equal the portal's, so copied hashes verify |
| `SS_TOTP_ENCRYPTION_KEY` | Must equal the portal's, so copied TOTP secrets decrypt |
| `SIRDAR_SESSION_TTL_SECONDS` | Absolute session lifetime |

The container runs `alembic upgrade head` and then serves. `GET /healthz`
returns 200, or 503 when its database is unreachable.

## Data model (Sirdar database)

- **`users`**: `person_id` (uuid PK; the portal person id for portal users,
  a new uuid for local users), `source` (`portal` | `local`), `email`
  (citext, unique), `first_name`, `last_name`, `preferred_name`,
  `job_title` (display name = preferred-or-first + last, as in the
  portal), `password_hash`,
  `must_change_password`, `password_updated_at`, `password_expires_at`
  (worked out at import from the portal's password-expiry policy; null =
  never), `totp_secret_enc`, `totp_confirmed_at`, `totp_last_counter`,
  `totp_enabled` (the portal's site-wide 2FA switch was on at import),
  `totp_required`, `failed_login_count`, `locked_until`, `last_login_at`,
  `last_login_ip`, `disabled_at`, `disabled_reason`, `last_imported_at`,
  `ui_prefs` (jsonb), `created_at`, `updated_at`.
- **`roles`**: `name` PK, `label`, `rank`, `color`. Migration 0001 seeds
  the four portal roles with global scope and rank ≥ 60 (developer 100,
  founder 100, super_admin 80, admin 60) and their default permissions.
  The import updates label, rank and color from the portal and adds any
  new global rank ≥ 60 role (with no permissions until someone grants
  them). Roles that disappear from the portal stay in place, but nobody
  is granted them.
- **`user_roles`**: (`person_id`, `role`) PK.
- **`role_permissions`**: (`role`, `resource`, `action`) PK. Seeded
  defaults below, then edited on the Roles & access page.
- **`permission_overrides`**: (`person_id`, `resource`, `action`) PK,
  `allow`, `set_by`, `set_at`.
- **`totp_backup_codes`**: copied hashes. `used_at` tracks use in Sirdar.
- **`auth_sessions`**: Sirdar refresh sessions (hashed refresh token,
  family id for reuse detection, `expires_at` absolute, `revoked_at`, ip,
  user agent).
- **`audit_log`**: actor, action, target, details (jsonb), at.
- **`import_runs`**: started/finished, actor (null for CLI), trigger
  (`cli` | `web`), status (`ok` | `failed`), error, counts (added /
  updated / unchanged / disabled / skipped),
  and per-row results (jsonb) for the summary and CSV.

## Import from portal

`import_users(actor)` is one service function used by the CLI
(`sirdar import-users`) and by `POST /users/import`.

1. Read from the source database in a read-only transaction:
   - `user_accounts` joined to `people`;
   - active `person_roles` (where `revoked_at` is null) joined to `roles`;
   - TOTP backup codes;
   - whatever the portal's 2FA policy and password-expiry policy need to
     work out `totp_required` and `password_expires_at`. That logic is a
     port of `services/totp.policy_for` and the password-policy expiry
     rule, and it reads the same tables and settings.
2. A person is eligible when the account has a password hash, is not
   disabled, and holds an active role with `scope_anchor = 'global'` and
   `rank >= 60`.
3. Write everything in one Sirdar transaction:
   - **Eligible and new:** insert the user and their roles and backup
     codes. Row result `added`.
   - **Eligible and existing:** overwrite email, name, password fields,
     TOTP fields, `totp_enabled`, `totp_required`, roles and backup
     codes. `totp_last_counter` keeps the higher of the two values, and a
     backup code used in Sirdar stays used. Clear `disabled_at` if the
     import had set it. Row result `updated`, or `unchanged` when nothing
     differed.
   - **No longer eligible:** set `disabled_at` with reason
     `not_eligible` and revoke all sessions. Never delete. Row result
     `disabled`.
   - **Email belongs to a `local` user:** leave it untouched. Row result
     `skipped` with reason `email_collision_local`.
   - Local users are never read or changed by the import.
   - Sirdar-only data (overrides, sessions, audit, lockout counters, last
     login) is preserved.
4. Record the `import_runs` row and an audit entry. If the source
   database is missing or unreachable, nothing changes and the run is
   recorded as `failed` with the reason.

## CLI

- `sirdar import-users`: runs the import and prints the summary.
- `sirdar create-admin --email --first-name --last-name [--role developer]`:
  creates a `source = local` user and prompts for the password twice.
  The role must exist in `roles` (the four defaults are always seeded by
  migration 0001).
- `sirdar reset-password --email`: local users only, prompts for the
  password.

Local users have no 2FA in v1. They are meant as break-glass access for
fresh installs.

## Authentication

Sirdar's API follows the portal's auth contract (same paths, request and
response shapes, error codes) so the SPA can reuse the portal's `Login`
page, `AuthProvider` and API client unchanged. Every API route lives
under `/api` (the SPA sets `VITE_API_URL=/api`). The access JWT is held
in memory by the SPA; the refresh token travels only in an httpOnly
cookie named `sirdar_refresh` with path `/api/auth`. Tokens are signed
with `SIRDAR_JWT_SECRET` and issuer `sirdar`, so portal tokens never
verify here.

- **`POST /api/auth/login`** (`email`, `password`). Checks run in this
  order (the lock check comes right after the user is loaded, before the
  password result is revealed; the disabled and later checks run only after
  a correct password, so disabled and similar states are not probeable):
  1. Unknown email or no password hash: verify against a dummy hash
     (equal timing), then 401 `invalid_credentials`.
  2. `locked_until` in the future: still verify the password (equal
     timing), add no strike, audit `login_failed` (reason
     `account_locked`), and return 423 `account_locked` for ANY password,
     so a lock is never a password oracle. Accepted trade-off: while an
     account is locked every password answers `account_locked`, so a locked
     account is distinguishable from an unknown email (which answers 401
     `invalid_credentials`).
  3. Wrong password: increment `failed_login_count`; at 10 failures lock
     for 900 s and reset the count (`SIRDAR_MAX_FAILED_LOGINS`,
     `SIRDAR_LOCKOUT_SECONDS`). 401 `invalid_credentials`.
  4. `disabled_at` set: 401 `account_disabled`.
  5. Portal user with `must_change_password` set or
     `password_expires_at` passed: 403 `password_change_required`.
  6. `totp_required` set without a confirmed secret: 403
     `totp_enrollment_required`.
  7. `totp_enabled` and a confirmed secret: return
     `{status: "totp_verify", challenge_token, backup_codes_remaining}`
     (challenge JWT, 5 min, `typ: totp`).
  8. Otherwise: create a session and return `SessionOut` (the portal's
     shape: access_token, expires_in, session_expires_at, person, roles,
     must_change_password (always false), preferences, perms, max_rank,
     scope `{global: true}`, password_min_length, totp status).
- **`POST /api/auth/totp/verify`** (header `X-Totp-Challenge`, body
  `{code, remember}`; `remember` is ignored). A 6-digit code is matched
  ±1 step and rejected at or below `totp_last_counter`. A 10-character
  backup code is single-use. Failures count toward lockout (401
  `totp_invalid`); a bad or expired challenge is 401 `invalid_challenge`.
- **`POST /api/auth/refresh`**: rotation with reuse detection (reuse
  revokes the family, 401 `session_reuse_detected`). Every rotation
  inherits the original absolute deadline. No cookie: 401
  `missing_refresh`.
- **`POST /api/auth/logout`** (204, never fails).
- **`GET /api/auth/me`**, **`PUT /api/auth/me/preferences`** (the
  portal's `UiPreferences` shape and defaults).
- **`GET /api/system/status`** (public): the portal's shape with
  `totp_trust_days: 0` (hides "Remember this browser") plus
  `needs_setup: true` when Sirdar has no users.

There are no trusted devices in v1. Each sign-in that owes 2FA asks for a
code.

## Permissions

The model and resolver match the portal:

- A user's effective grant for a resource and action is the union of
  their roles' `role_permissions`, then per-person overrides
  (allow/deny) on top.
- Everyone signed in to Sirdar is rank ≥ 60, so the portal's group-gate
  layer does not exist here.
- `devtools` is a hard gate. Only `developer` can hold it, and no
  override can grant it.
- `can_touch_rank(actor, target)`: you manage strictly below your own
  rank, and rank 100 also manages peers. This applies to editing a user's
  overrides and revoking their sessions. Nobody can grant a permission
  they do not hold themselves.
- Only developers can edit the `developer` role (403
  `developer_role_locked` for anyone else, founders included). It is the
  one exception to `cannot_edit_own_role` and the rank rule: a developer
  may edit it. Its core grants can never be removed: every `devtools`
  action plus `access:view` and `access:change` (422
  `developer_role_core`). Every other role keeps the own-role and rank
  rules; `grant_exceeds_own` applies everywhere.
- Per-user overrides protect the same core cells on anyone who holds the
  `developer` role: setting any override (allow or deny) on a core cell
  requires the actor to hold `developer` (403 `developer_role_locked`,
  founders included), and denying a core cell is rejected even for
  developers (422 `developer_role_core`). Other cells follow the normal
  rank/peer, `grant_exceeds_own` and `developer_only_resource` rules.
  Precedence: person_not_found, cannot_target_self, developer_role_locked,
  developer_role_core, rank_too_low, developer_only_resource,
  grant_exceeds_own.
- Session details (IPs, browsers, times) are visible only for people you
  can manage (yourself, or strictly below your rank; rank 100 also
  peers). For anyone else `GET /users/{id}` returns `sessions: []`
  without querying them, and the page says "Session details are hidden
  for people who outrank you."
- API routes declare `require(resource, action)`. The SPA gates nav
  items, pages and buttons using the map from `/me`.

Day-one resources (actions: view / add / change / delete):

| Resource | developer | founder | super_admin | admin |
|---|---|---|---|---|
| `dashboard` | view | view | view | view |
| `users` (add = import) | full | full | full | view |
| `access` | full | full | view, change | view |
| `audit` | view | view | view | view |
| `settings` | full | full | view, change | view |
| `devtools` | full | — | — | — |

## Web UI

Shared from the portal through `@portal` (enforced by an allowlist test,
with `dedupe` for react, react-dom, react-router-dom and gsap):

- the portal stylesheets (tokens, list typography, forms, modals);
- `pages/Login` (whole page) with `AuthProvider` and
  `SystemStatusProvider`, `LoginScene`, `OtpInput`;
- `AppShell`, `NavPanel`, `Topbar` structure (expanded/rail/hidden,
  Ctrl/⌘+B, nav background and text-size prefs);
- `DataTable`, `ComboBox`, `Switch`, `access/MatrixTable`, the modal
  header pattern, `lib/listTools` `exportCsv`.

The portal's API client (`lib/api` `apiFetch`, refresh, session events)
is reused as-is against Sirdar's `/api`. Sirdar has its own shell built
from `NavPanel` (the portal's `AppShell`/`Topbar` are tied to portal
data). Minimal, backward-compatible portal props: `Login` gains optional
`eyebrow`, `notice` and `extraErrors`, and hides "Remember this browser"
when `totp_trust_days` is 0; `LoginScene` gains optional `tag`;
`NavPanel` gains optional `tag`. Portal defaults stay unchanged and the
portal's existing tests must stay green. No notifications or toast host
in v1.

Branding: "Sirdar" in the topbar and on the sign-in page, the ServerSherpa
mark, "A Cumulus Solutions Group product", and an accent color distinct
from the portal's. All copy uses American English.

Routes:

| Route | Gate | Content |
|---|---|---|
| `/login` | — | Password, then the 2FA step when owed. Error codes map to friendly text. With zero users: "No users yet. Run `sirdar create-admin` or `sirdar import-users`." |
| `/` | dashboard:view | Placeholder cards: signed-in user, last import, user count |
| `/admin/users` | users:view | List: name, email, roles, source, 2FA, last sign-in, status. "Import from portal" (users:add) opens the summary modal with per-row results and a CSV download. Shows "Portal database not configured" when the source is unset |
| `/admin/users/:id` | users:view | Roles, effective permissions, overrides editor (access:change + rank rule), sessions with revoke |
| `/admin/access` | access:view | Role × resource matrix in the portal's Roles & access style; editable with access:change |
| `/admin/audit` | audit:view | Audit log list |
| `/settings` | settings:view | Source database status, session lifetime (placeholder) |
| `/me` | signed in | Profile and preferences (nav prefs, list size) |

Nav sections: Dashboard; Administration (Users, Roles & access, Audit
log); Settings. The account menu in the topbar opens `/me` and Sign out.

## Errors

- Auth errors use the portal's stable codes: `invalid_credentials`,
  `account_locked`, `account_disabled`, `password_change_required`,
  `totp_enrollment_required`, `totp_invalid`, `invalid_challenge`,
  `invalid_session`, `session_expired`, `session_reuse_detected`,
  `missing_refresh`, `invalid_token`, `session_ended`.
- Permission failures return 403 `forbidden`. A failed import returns
  502 `source_unavailable` (unreachable) or 409 `source_not_configured`
  (unset).

## Testing

- **API (pytest, own `sirdar_test` database):**
  - every login refusal path and its order;
  - the timing dummy for unknown emails;
  - lockout;
  - 2FA verify, including a replayed code being rejected and a backup
    code working only once;
  - refresh rotation, reuse detection and the absolute deadline;
  - import rules: eligible and not eligible, demotion disables and
    revokes sessions, local users untouched, email-collision skip,
    idempotent re-run, failed source leaves no changes;
  - the resolver, overrides, the devtools hard gate, `can_touch_rank`,
    and route guards.
- **Compatibility pins (test environment only):** a hash made by the
  portal's `hash_password` verifies in Sirdar, a secret from the portal's
  `encrypt_secret` decrypts in Sirdar, and the 2FA and expiry policy
  ports agree with the portal's on shared fixtures.
- **Web (vitest + jsdom):**
  - the `@portal` allowlist guardrail plus a dedupe check;
  - the login flow including the 2FA step and the error-code text;
  - nav gating by permissions;
  - the users list and import summary.
- **Live check:** a browser check against the dev stack.

## Dev setup

- `sirdar-db` service in `docker-compose.dev.yml` on 127.0.0.1:5434.
- API on 8097, web on 5178 (both strictPort). Vite proxies `/api` to
  8097.
- `SIRDAR_SOURCE_DATABASE_URL` points at the dev ServerSherpa Postgres
  (5433), with a read-only role.
- `sirdar.dev.serversherpa.com` through Nginx Proxy Manager, like the
  other apps.

## Out of scope

Building or installing environments, scheduled sync, access groups,
trusted devices, 2FA enrollment for local users, and app/environment
pages.

## Addendum (2026-10-01): /me — profile, preferences, history

Decided with the product owner after the first real install.

- **Tabs** (segmented, like the portal): Profile `/me`, Preferences `/me/preferences`, History `/me/history`. The user menu's single item stays "My profile & preferences" → `/me`.
- **Profile tab** (fork of portal `pages/Profile.tsx`; same layout and copy, Sirdar wording):
  - **Hero:** initials avatar (Sirdar has no file storage), display name, job title, roles, contact line.
  - **Profile panel:** editable by **every** user: first_name*, last_name*, preferred_name, job_title, contact_email (EmailStr, not unique), phone, address_line1, address_line2, city, region, postal_code, country* (2 letters, default US). Sign-in email is shown, not editable.
    - For portal users, a note says "The next import from the portal overwrites these until two-way sync exists."
    - New `users` columns come from migration 0002. The import copies them from portal `people` (`email`→contact_email, phone, address_*, city, region, postal_code, country).
  - **Security panel:**
    - **Local users:**
      - Change password, using the portal `ChangePasswordForm`: current + new + confirm, min length = `SIRDAR_PASSWORD_MIN_LENGTH`. Errors: wrong current → 403 `invalid_current_password`; same as current → 422 `same_as_current`; too short → 422 `password_too_short`. Success revokes every other session family.
      - 2FA enroll / regenerate backup codes, using the portal `TotpEnrollModal` / `RegenerateCodesModal`. Enrolling sets `totp_confirmed_at` and `totp_enabled = true`, so later sign-ins challenge.
    - **Portal users:** password and 2FA status shown read-only with "Managed in the portal". The password and TOTP endpoints answer 403 `managed_in_portal` for them.
  - **Active sessions:** every live session family (current marked) with "Sign out" on others.
- **Preferences tab:** the portal `pages/me/MePreferences` component reused as-is. Its "portal" wording takes an optional app-name prop: accent (swatches + custom), theme, density, list size, sidebar mode / background (swatches + custom) / text size, motion.
- **History tab:** Sirdar's own list of audit rows where the actor or the target is me, newest first, with action and record-type filters and CSV export.
- **API** (portal paths and shapes):

  | Method + path | Who | Returns |
  |---|---|---|
  | GET /api/auth/me/profile | any signed-in user | PersonDetail-like |
  | PATCH /api/auth/me/profile | any signed-in user | updated profile |
  | POST /api/auth/me/password | local users only | 204 |
  | GET /api/auth/me/sessions | any signed-in user | `[{family_id, started_at, last_active_at, expires_at, ip_address, user_agent, current}]` |
  | DELETE /api/auth/me/sessions/{family_id} | own sessions only | 204 |
  | GET /api/auth/me/activity | any signed-in user | audit items |
  | POST /api/auth/totp/enroll/start | local users only | `{secret, otpauth_uri}` |
  | POST /api/auth/totp/enroll/confirm | local users only | body `{code, remember}`; returns `{backup_codes}` (8 codes, portal format) |
  | POST /api/auth/totp/backup-codes/regenerate | local users only | body `{code}`; returns `{backup_codes}` |

  The issuer name in the otpauth URI is "Sirdar".

## Addendum (2026-10-01): Deploy page, step 1 — targets and connection

Sirdar will deploy the ServerSherpa apps (api, portal, kiosk, wiki, spaces, db) from GitHub to a target. This step builds only the Deploy page, the target settings and a **connection test**. Actual deployment comes next.

Decided with the product owner:

- **Targets:** AWS, GCP, DigitalOcean and Custom (direct SSH). Only DigitalOcean and Custom are built now. AWS and GCP appear as "Coming soon" cards, and their settings already exist in `.env`. Target cards show only the icon, label and a status chip (Ready, Not configured, Coming soon), never connection details such as host, user, port or region (product owner decision 2026-10-01).
- **Deployment types:** Blue (prod), Green (prod), Dev (development), Beta (external testing) and Custom (your own named environment, added at the product owner's request 2026-10-01). For now the type is a label carried with the connection test and recorded in the audit log. All types use the same per-provider credentials.
- **Credentials (one set per provider, all in the "Target deployment" section of `.env`):**

  | Provider | Settings |
  |---|---|
  | DigitalOcean | `SIRDAR_DEPLOY_DO_TOKEN`, `SIRDAR_DEPLOY_DO_REGION` (optional, e.g. `nyc3`) |
  | AWS | `SIRDAR_DEPLOY_AWS_ACCESS_KEY_ID`, `SIRDAR_DEPLOY_AWS_SECRET_ACCESS_KEY`, `SIRDAR_DEPLOY_AWS_REGION` |
  | GCP | `SIRDAR_DEPLOY_GCP_PROJECT_ID`, `SIRDAR_DEPLOY_GCP_CREDENTIALS_FILE` (path inside the container), `SIRDAR_DEPLOY_GCP_REGION` |
  | Custom SSH | `SIRDAR_DEPLOY_SSH_HOST`, `SIRDAR_DEPLOY_SSH_PORT` (default 22), `SIRDAR_DEPLOY_SSH_USER`, `SIRDAR_DEPLOY_SSH_PASSWORD`, `SIRDAR_DEPLOY_SSH_KEY_PATH`, `SIRDAR_DEPLOY_SSH_KEY_PASSPHRASE` |

  - **SSH auth:** password and/or private key. The key wins when both are set.
  - **Key files:** live in `sirdar/deploy-keys/` on the host (mode 700), mounted read-only into the container at `/app/deploy-keys`. `SIRDAR_DEPLOY_SSH_KEY_PATH` may be a bare file name in that folder or an absolute container path.
  - Secrets are never returned by the API or shown in the UI.
- **Permissions:** a new resource `deploy` ("Deploy"):

  | Action | Allows |
  |---|---|
  | view | see the page and targets |
  | add | run a connection test |
  | change | trust or forget SSH host keys |

  Defaults: developer, founder and super_admin get view, add and change; admin gets view only. It is seeded by migration 0003 and editable on Roles & access.
- **SSH host keys (trust on first use):**
  - **First connection** to an unknown host:port answers 409 `host_key_unknown` with the key type and SHA256 fingerprint. The page shows them, and **Trust this host** (deploy:change) stores the key. The server re-reads the key and confirms the fingerprint still matches before storing.
  - **Later connections** require the stored key. A different key answers 409 `host_key_mismatch` with both fingerprints and the connection is refused.
  - **Forgetting a host** (deploy:change) lets a legitimately rebuilt server be trusted again.
- **Connection test results:**
  - **DigitalOcean:** account email and status, droplet limit and count, and whether the configured region is available.
  - **SSH:** OS (`/etc/os-release` PRETTY_NAME), kernel (`uname -srm`), Docker version, Docker Compose version, free disk on `/`, and memory. Each check is shown as pass, warn or fail. Missing Docker is a warning, because a later step can install it.
- **Audit:** `deploy.connect` (target, type, ok or error), `deploy.host_trust` and `deploy.host_forget`.
- **Installer:** the first install asks "Configure deployment targets now? [y/N]". Answering yes prompts for DigitalOcean (token hidden) and then Custom SSH (host, port, user, password hidden, key file name). AWS and GCP stay blank for now. On re-runs, the deploy keys are asked once as a group through the same yes/no; a "no" writes them blank so the question isn't repeated.
- **Region picker (DigitalOcean):** `GET /api/deploy/digitalocean/regions` (deploy:view) lists the account's `available` regions from DigitalOcean's live `/v2/regions`, sorted by name, as `{regions: [{slug, name}], default}`. `default` is `SIRDAR_DEPLOY_DO_REGION` when that region is in the list, else null. `POST /api/deploy/connect` takes an optional `region` slug (`^[a-z0-9-]{2,20}$`, else 422); for DigitalOcean it replaces the env default in the region check, and it is ignored for SSH. The audit entry includes `region` when given. The Deploy page shows a Region ComboBox once DigitalOcean is selected and configured, preselects `default`, and shows the chosen region in the result header. The installer no longer asks for a region: `SIRDAR_DEPLOY_DO_REGION` stays in `.env` (written blank) as an optional default.
- **Custom type and its name:** Custom is the fifth type. It needs an environment name: `POST /api/deploy/connect` takes an optional `name`, required when `type` is `custom` and ignored otherwise. The name must match `^[a-z][a-z0-9-]{1,31}$` (lowercase letters, numbers and hyphens; starts with a letter; 2-32 characters), must not end with a hyphen, and must not be `blue`, `green`, `dev`, `beta` or `custom`. Failures answer 422 `custom_name_required`, `custom_name_invalid` or `custom_name_reserved`. The 200 result includes `name` (null unless custom) and the `deploy.connect` audit entry records it for custom. The Deploy page reveals a required "Environment name" field when Custom is selected, validates it with the same rules, keeps the test button disabled until it is valid, and shows the name in the result header (for example "Custom (SSH) · Custom: demo-acme").

## Addendum (2026-10-01): saved Custom (SSH) targets

Product owner request: add Custom (SSH) targets on the fly from the Deploy page, store them in an env file, and recall them later.

- **Store:** `sirdar/config/deploy-targets.env` on the host, mounted read-write at `/app/config` (`SIRDAR_DEPLOY_TARGETS_FILE`, default `/app/config/deploy-targets.env`; the compose file pins it).
  - The directory and the file are owned by the container uid 10001, with modes 700 and 600.
  - Sirdar reads the file on every use, so changes apply immediately with no restart.
  - The main `sirdar/.env` stays read-only to the app.
- **File format** (dotenv; values single-quoted; newlines and NUL rejected):
  - `SIRDAR_SSH_TARGETS=<slug>,<slug>,…` lists the targets in order.
  - Each target has its own block: `SIRDAR_SSH_<KEY>_NAME`, `_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_KEY_PATH`, `_KEY_PASSPHRASE`.
  - `<KEY>` is the slug uppercased with `-` → `_`. The slug is derived from the name (`a-z0-9-`, ≤32) and made unique with `-2`, `-3`, and so on.
- **Writes:** every write takes an exclusive file lock, writes a temp file in the same directory and renames it into place.
- **Targets on the Deploy page:** AWS and GCP (coming soon), DigitalOcean, the existing installer SSH target (read-only, label "Custom (SSH) · Installer", id `ssh`, still configured in `.env`), each saved target (id `ssh:<slug>`, label = its name), and an **Add SSH target** card. Cards still show no connection details.
- **Add/edit form** (modal), deploy:change:

  | Field | Required? | Rules |
  |---|---|---|
  | Name | required | 2–40 characters |
  | Host | required | hostname, IPv4 or IPv6 |
  | Port | default 22 | 1–65535 |
  | User | required | |
  | Password | optional, write-only | shows "set"; Replace / Clear |
  | Key file | optional | picked from the files in `deploy-keys/` (names only) |
  | Key passphrase | optional, write-only | |

  At least a password or a key file is required. The installer target can't be edited or removed here.
- **API** (deploy:change unless noted):

  | Route | Notes |
  |---|---|
  | `GET /api/deploy/ssh-targets/{slug}` | editable fields; booleans `password_set` / `passphrase_set`; never secrets |
  | `POST /api/deploy/ssh-targets` | 201 |
  | `PUT /api/deploy/ssh-targets/{slug}` | secret fields: omitted = keep, `""` = clear, value = set |
  | `DELETE /api/deploy/ssh-targets/{slug}` | 204 |
  | `GET /api/deploy/key-files` | file names only |
  | `GET /api/deploy/targets` (deploy:view) | now lists every SSH target |

  - `POST /api/deploy/connect` accepts `ssh` or `ssh:<slug>`.
  - Trusting a host key is allowed for the host:port of any configured SSH target.
  - Audit actions: `deploy.target_add`, `deploy.target_update`, `deploy.target_remove`. They record non-secret fields only (name, host, port, user, key file name, password_set, passphrase_set).
