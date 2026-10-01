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
  (citext, unique), `display_name`, `password_hash`,
  `must_change_password`, `password_updated_at`, `password_expires_at`
  (worked out at import from the portal's password-expiry policy; null =
  never), `totp_secret_enc`, `totp_confirmed_at`, `totp_last_counter`,
  `totp_required`, `failed_login_count`, `locked_until`, `last_login_at`,
  `last_login_ip`, `disabled_at`, `disabled_reason`, `last_imported_at`,
  `ui_prefs` (jsonb), `created_at`, `updated_at`.
- **`roles`**: `name` PK, `label`, `rank`, `color`. Only the portal roles
  with global scope and rank ≥ 60 are copied (today: developer 100,
  founder 100, super_admin 80, admin 60). Roles that disappear from the
  portal stay in place, but nobody is granted them.
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
- **`import_runs`**: started/finished, actor (null for CLI), status
  (`ok` | `failed`), error, counts (added / updated / disabled / skipped),
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
     TOTP fields, `totp_required`, roles and backup codes. Clear
     `disabled_at` if the import had set it. Row result `updated`.
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
- `sirdar create-admin --email --name [--role developer]`: creates a
  `source = local` user and prompts for the password twice. The role must
  be one of the copied roles. If no roles exist yet, the four default
  roles are seeded first.
- `sirdar reset-password --email`: local users only, prompts for the
  password.

Local users have no 2FA in v1. They are meant as break-glass access for
fresh installs.

## Authentication

This follows the portal's flow. The access JWT is held in memory by the
SPA. The refresh token travels only in an httpOnly cookie named
`sirdar_refresh`.

- **`POST /auth/login`** (`email`, `password`). Checks run in this order:
  1. Unknown email: verify against a dummy hash (equal timing), then
     `invalid_credentials`.
  2. `locked_until` in the future: `locked`.
  3. Wrong password: increment `failed_login_count`, lock using the
     portal's threshold and duration, then `invalid_credentials`.
  4. `disabled_at` set: `disabled`.
  5. Portal user with `must_change_password` set or
     `password_expires_at` passed: `password_change_required`, with a
     message telling them to update the password in the portal and then
     re-import.
  6. `totp_required` set without a confirmed secret:
     `totp_enrollment_required`, with a message pointing to the portal.
  7. Confirmed secret: return a challenge token (5 min, purpose
     `verify`).
  8. Otherwise: create a session.
- **`POST /auth/totp/verify`** (challenge, code or backup code). Rejects
  a code at or below `totp_last_counter`. A backup code is single-use.
  Failures count toward lockout.
- **`POST /auth/refresh`**: rotation with reuse detection (reuse revokes
  the family). Every rotation inherits the original absolute deadline.
- **`POST /auth/logout`**.
- **`GET /me`**: person, source, roles, rank, effective permissions,
  `ui_prefs`. **`PATCH /me/preferences`**.

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
- `LoginScene`, `OtpInput`;
- `AppShell`, `NavPanel`, `Topbar` structure (expanded/rail/hidden,
  Ctrl/⌘+B, nav background and text-size prefs);
- `DataTable`, `ComboBox`, `Switch`, the toast host, the modal header
  pattern;
- the bulk-summary pattern (per-row summary + CSV download).

Sirdar supplies its own API client and auth context. Where a portal
component reads portal globals, the portal gets a minimal refactor so the
component takes props or a context with the same interface. The portal's
existing tests must stay green.

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

- Auth errors use stable codes: `invalid_credentials`, `locked`,
  `disabled`, `password_change_required`, `totp_enrollment_required`,
  `totp_invalid`, `challenge_expired`, `session_expired`,
  `missing_refresh`.
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
