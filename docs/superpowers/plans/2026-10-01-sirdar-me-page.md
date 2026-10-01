# Sirdar /me Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give Sirdar a full `/me` area like the portal's:
- **Profile:** editable details, a security panel, and active sessions.
- **Preferences:** every portal appearance and navigation option.
- **History:** my own audit activity.

**Architecture:**
- **API:** new `/api/auth/me/*` routes and TOTP enrollment routes in `sirdar_api`, matching the portal's paths and shapes so the portal's own React pieces can be reused (`ChangePasswordForm`, `TotpEnrollModal`, `RegenerateCodesModal`, `MePreferences`).
- **Profile page:** Sirdar forks the portal's `Profile.tsx` layout, because that page is hard-wired to portal routes.
- **Data:** migration 0002 adds the contact and address columns; the import copies them from the portal.

**Spec:** `docs/superpowers/specs/2026-10-01-sirdar-groundwork-design.md`, section "Addendum (2026-10-01): /me". Read it first.

## Global Constraints

### Where to work
- Work only in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`).
- Never cd into the main checkout.
- Never run a bare `git stash`.
- Never run `npm install` in `portal/`; its `node_modules` is a symlink.
- Never touch `serversherpa-dev`, the dev `sirdar-db` data except through migrations, or ports 5434/8097/8098, which may be in use by others.

### How to build and commit
- TDD for every task. Run the suites in the foreground:
  - `cd sirdar/api && .venv/bin/pytest -q`
  - `npm --prefix sirdar/web test`
  - `cd sirdar/web && npx tsc -p tsconfig.json --noEmit`
  - `npm --prefix portal test` (only if portal files change)
- Commit messages end with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Contracts
- Error bodies use `{"detail": {"code": "<code>"}}`.
- Routes live under `/api`.
- Portal-path parity is required: the reused portal client functions call `/auth/me/profile`, `/auth/me/password`, `/auth/me/sessions[/{family_id}]`, `/auth/me/activity`, `/auth/totp/enroll/start`, `/auth/totp/enroll/confirm` and `/auth/totp/backup-codes/regenerate` relative to `apiUrl()` = `/api`.
  - Before writing the API, read the portal's backend for exact request and response shapes: `api/src/serversherpa/api/routes/me.py`, `routes/auth.py` (totp routes) and `api/schemas.py` (`ProfileUpdateIn`, `PersonDetail`/`ProfileOut`, `SessionInfo`/`MySessionOut`, `TotpEnrollStartOut`, `TotpEnrollConfirmIn`/`Out`, `BackupCodesOut`, `TotpRegenerateIn`).
  - Also read the frontend types in `portal/src/lib/api.ts`: `PersonDetail`, `SessionInfo`, `MyActivityItem`, `totpEnrollStart`, `totpEnrollConfirm`, `totpRegenerateBackupCodes`, `changePasswordRequest`, `getProfileRequest`, `updateProfileRequest`, `getSessionsRequest`, `revokeSessionRequest`, `getMyActivityRequest`.
  - Match those shapes field for field. Omit fields Sirdar can't provide (avatar → null, badge_uid → null).
- Local vs portal users: `source == "local"` may change their password and enroll or regenerate 2FA. Portal users get 403 `managed_in_portal` on those endpoints. Every user may edit their profile.

### Copy and process
- American English in all copy.
- Portal UI idioms: `segmented` tabs, `pf-form`, `kv` lists, `mini-btn`, `DataTable`. No raw `<table>`.
- Per-task Minor review findings go into the ledger at `.superpowers/sdd/progress.md` under a "/me" heading.

---

### Task A: API — profile columns, profile/sessions/activity endpoints, import copies contact fields

**Files:**
- Create: `sirdar/api/migrations/versions/0002_user_contact_fields.py`
- Modify:
  - `sirdar/api/src/sirdar_api/db/models.py` (User)
  - `sirdar/api/src/sirdar_api/services/import_users.py` (source select + `_identity_fields`)
  - `sirdar/api/tests/source_schema.sql` (people columns)
  - `sirdar/api/src/sirdar_api/api/app.py` (include router)
- Create: `sirdar/api/src/sirdar_api/api/routes/me.py` (router prefix `/auth/me`; must not clash with `routes/auth.py`'s `/auth/me` GET and `/auth/me/preferences` PUT — use distinct sub-paths only), plus tests `sirdar/api/tests/test_me_api.py`

**Requirements:**
1. **Migration 0002** (down_revision `"0001"`; hand-written SQL like 0001) adds nullable text columns to `users`: `contact_email`, `phone`, `address_line1`, `address_line2`, `city`, `region`, `postal_code`, plus `country text NOT NULL DEFAULT 'US'`. Add a downgrade.
2. **Import:**
   - The source `people` select adds `email AS contact_email, phone, address_line1, address_line2, city, region, postal_code, country`.
   - Check these columns exist on the real portal `Person` model in `api/src/serversherpa/db/models.py`; they do per the portal inventory.
   - `tests/source_schema.sql` `people` gains the same columns (country default 'US').
   - The import overwrites them like the other identity fields, so they count in `changes`.
   - Tests: an imported user has phone, city and contact_email from the portal; changing portal phone → re-import → `updated` with `"phone"` in changes.
3. **`GET /auth/me/profile`** returns the portal `PersonDetail` shape from the current user:
   - `id` = person_id
   - first/last/preferred/display name
   - `badge_uid` null
   - `email` = contact_email (the portal's "Contact email")
   - `phone`, `job_title`, the address fields, `country`
   - `avatar_key` and `avatar_url` null
   - `created_at`, `password_updated_at`
   - Add `login_email` and `source` as extra fields the Sirdar page uses.
4. **`PATCH /auth/me/profile`** with the portal `ProfileUpdateIn` body (extra fields forbidden):
   - Only the fields sent are applied.
   - first_name, last_name and country can't be null or blank → 422 `{field}_required`.
   - `email` maps to contact_email and is validated as EmailStr (not unique in Sirdar).
   - `country` must be 2 letters, uppercased.
   - Audit `profile.update` with the changed field names.
   - Returns the updated profile. Allowed for every user.
5. **`GET /auth/me/sessions`** returns the portal `SessionInfo[]`:
   - One item per live family (not revoked, not expired), taking the newest non-rotated row per family.
   - `started_at` = the family's first row `created_at`.
   - `last_active_at` = the newest row `created_at`.
   - `current` = family of the requesting session.
   - Current first, then newest.
6. **`DELETE /auth/me/sessions/{family_id}`:**
   - Revokes that family only if it belongs to the caller → 204.
   - Unknown or other people's family → 404 `session_not_found`.
   - The current family is allowed too (the portal client hides that button; the API needn't block it).
   - Audit `session.revoke`.
7. **`GET /auth/me/activity`** returns the portal `MyActivityItem[]` shape from `audit_log` where `actor_id == me OR (entity_type in ('user','auth') AND entity_id == str(me))`:
   - newest first;
   - `limit` (default 200, max 500);
   - actor name resolved;
   - fields per the portal type (id, at, action, entity_type, entity_id, entity_name (nullable), actor_id, actor_name, ip, changes).
8. **Tests:** each endpoint's happy path and the error codes above; cross-user isolation for sessions DELETE and activity.

---

### Task B: API — local-user password change and 2FA enrollment

**Files:**
- Modify: `sirdar/api/src/sirdar_api/api/routes/me.py` (password)
- Create: `sirdar/api/src/sirdar_api/services/totp_enroll.py`
- Modify: `sirdar/api/src/sirdar_api/api/routes/auth.py` (totp enroll/confirm/regenerate routes)
- Test: `sirdar/api/tests/test_me_security_api.py`

**Requirements:**
1. **`POST /auth/me/password`** `{current_password, new_password}` (portal shape):
   - Portal users → 403 `managed_in_portal`.
   - Wrong current password → 403 `invalid_current_password`. This is not a lockout strike, matching the portal.
   - Same as current → 422 `same_as_current`.
   - Shorter than `password_min_length` → 422 `{"code": "password_too_short", "min_length": N}` (the portal includes min_length).
   - On success: rehash with the pepper, set `password_updated_at`, revoke every OTHER session family (reason `password_change`), audit `password.change`, return 204.
2. **TOTP enrollment** (local users only; portal users → 403 `managed_in_portal`; all require a signed-in user):
   - **`POST /auth/totp/enroll/start`:**
     - If already enrolled → 409 `totp_already_enrolled`.
     - Otherwise generate `pyotp.random_base32()` and store it encrypted (Fernet, `SS_TOTP_ENCRYPTION_KEY`, via `security/totp.encrypt_secret`) in `totp_secret_enc` with `totp_confirmed_at` null and `totp_last_counter` null.
     - Return `{secret, otpauth_uri}`. The URI is `pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name="Sirdar")`.
   - **`POST /auth/totp/enroll/confirm`** `{code, remember}`:
     - Not started → 409 `totp_not_started`.
     - The code must match through `match_counter` with no last counter; otherwise 401 `totp_invalid`.
     - On success:
       - set `totp_confirmed_at = now`, `totp_last_counter`, `totp_enabled = True`;
       - replace backup codes with 8 new 10-character codes from the portal alphabet `abcdefghjkmnpqrstuvwxyz23456789`, hashed with `hash_password(code, pepper)`, returned formatted as `xxxxx-xxxxx`;
       - audit `totp.enroll`;
       - return `{backup_codes, session: null}`. The portal type allows a session; Sirdar's in-app enroll returns none.
   - **`POST /auth/totp/backup-codes/regenerate`** `{code}`:
     - Requires enrollment, else 409 `totp_not_enrolled`.
     - Verify the 6-digit app code with replay protection (update `totp_last_counter`). Wrong code → 401 `totp_invalid` plus a lockout strike, like login verify; locked → 423 `account_locked`.
     - Replace the backup codes, audit `totp.backup_codes_regenerated`, return `{backup_codes}`.
3. **Login:** after enrollment, a local user's sign-in challenges for a code (existing login logic keys on `totp_enabled` + `totp_confirmed_at` + secret). Add an end-to-end test: enroll → logout → login returns `totp_verify` → verify with a fresh code → session.
4. **`/auth/me`:** the `totp` status in `/api/auth/me` and the session responses reflect the enrollment and the backup-code count. Existing code already reads these; just test it.
5. **Tests:** each code path above, including that portal users get `managed_in_portal` on all four endpoints.

---

### Task C: Portal — app-name prop on MePreferences copy

**Files:**
- Modify: `portal/src/pages/me/MePreferences.tsx`, and `SaveHint` if it carries "portal" wording
- Test: `portal/src/pages/me/MePreferences.appname.test.tsx`

**Requirements:**
- Add an optional `appName?: string` prop, default `'portal'`, used wherever the copy says "the portal" or "portal". For example, the SaveHint lead becomes "…sign in on any device and {the appName} looks the way you left it." and the Appearance subtitle becomes "How {the appName} looks…". Grammar: with `appName="Sirdar"` it should read "Sirdar looks…", not "the Sirdar looks…".
- Implement via a `productLabel` helper: `'portal'` → `'the portal'` / `'The portal'`; any other name stays as given.
- **Do not change portal output:** with no prop, the rendered text must be byte-identical to today. Prove it with a test comparing against the current strings.
- New test: rendering with `appName="Sirdar"` shows "Sirdar looks the way you left it" (match the real sentence).
- Run the full portal suite plus `tsc -b --noEmit`.

---

### Task D: Web — Sirdar /me (Profile, Preferences, History)

**Files:**
- Create:
  - `sirdar/web/src/pages/me/MeLayout.tsx` (hero + tabs; replaces the current `src/pages/Me.tsx`, which is deleted)
  - `sirdar/web/src/pages/me/MeProfile.tsx`
  - `sirdar/web/src/pages/me/MeHistory.tsx`
- Modify:
  - `sirdar/web/src/App.tsx` (routes `/me`, `/me/preferences`, `/me/history`)
  - `sirdar/web/src/layout/sirdarNav.tsx` (PAGE_TITLES for the three paths)
  - `sirdar/web/src/portalImports.test.ts` (allowlist additions)
  - `sirdar/web/src/lib/sirdarApi.ts` (any Sirdar-only calls)
  - `sirdar/web/src/styles/sirdar.css` if needed
- Tests:
  - `sirdar/web/src/pages/me/MeProfile.test.tsx`
  - `sirdar/web/src/pages/me/MeHistory.test.tsx`
  - a MeLayout tabs test

**Requirements:**
1. **Read the portal pieces first:**
   - `portal/src/pages/Profile.tsx` and `profile.css` classes (`profile-hero`, `profile-grid`, `panel`, `kv`, `me-tabs`).
   - `portal/src/pages/me/MePreferences.tsx`, `usePreferenceSave.ts`, `SaveHint.tsx`.
   - `portal/src/components/ChangePasswordForm.tsx`.
   - `portal/src/components/totp/TotpEnrollModal.tsx`, `RegenerateCodesModal.tsx`.
   - The portal API client functions listed in Global Constraints.
2. **MeLayout:**
   - Eyebrow "Account".
   - Hero with an initials avatar. Reuse the same gradient helpers from `@portal/lib/format` (`avatarGradient`, `initials`) if React-free; otherwise build a small local avatar.
   - Display name, `job_title ?? 'No title set'` · roles, and a contact line (contact email, phone, city/region).
   - "Edit details" button on the Profile tab.
   - Segmented tabs: Profile `/me`, Preferences `/me/preferences`, History `/me/history`.
   - Loads the profile via the portal's `getProfileRequest()`.
3. **MeProfile:**
   - **Profile panel:** view as a `kv` list. Edit as a `pf-form` with the 12 portal EDIT_FIELDS: first/last/preferred name, job title, "Contact email", phone, address 1/2, city, "State / region", postal code, "Country (2-letter)".
     - Send only changed fields (blank → null) via the portal's `updateProfileRequest`, then `applyProfile(updated)` so the nav chip updates.
     - Show the sign-in email read-only.
     - For portal users, add the note "The next import from the portal overwrites these until two-way sync exists."
     - Map errors: `{field}_required` → "{Field} is required."; anything else → "Could not save — check the fields and try again."
   - **Security panel:**
     - **Local users:** Password row ("Last changed {date}") with a "Change password" button that toggles the portal's `ChangePasswordForm`. On success: re-fetch sessions and show "changed — other sessions signed out".
     - **Local users, Two-factor row:** when enrolled, chip "On since {date}", "{n} backup codes left" and "Regenerate backup codes" (portal `RegenerateCodesModal`). Otherwise chip "Off" and "Set up 2FA" (portal `TotpEnrollModal`). On done, call `applyTotp(...)` as the portal Profile does.
     - **Portal users:** both rows read-only with the status chips and "Managed in the portal".
   - **Active sessions panel:** "{n} live". Rows show browser (`describeUserAgent` from `@portal/lib/format` if React-free, else a small local helper), IP, "started {relative}" and "expires {relative}". The current session gets a "Current" chip; others get "Sign out" via the portal's `revokeSessionRequest`, then refresh the list.
4. **Preferences tab:** render the portal's `MePreferences` with `appName="Sirdar"` (Task C).
5. **MeHistory:**
   - `DataTable` with columns When, Action, Record, IP from `getMyActivityRequest()` (portal client), newest first.
   - Two ComboBox filters (Action, Record type), client-side.
   - "Download CSV" via `exportCsv`.
   - Empty state "No activity yet."
6. **Allowlist:** add exactly what's needed, for example `'pages/me/MePreferences'`, `'pages/me/SaveHint'`, `'pages/me/usePreferenceSave'`, `'components/ChangePasswordForm'`, `'components/totp/*'` (already listed). If a newly allowlisted module drags in a bare package, add it to `dependencies` + `dedupe.ts`. Never import `pages/Profile` or `components/ActivityHistory`.
7. **Tests (jsdom, mocking `@portal/auth/AuthContext` and the portal API module functions via `vi.mock('@portal/lib/api', …)` partial mocks):**
   - local vs portal user security panel (buttons vs "Managed in the portal");
   - the profile edit sends only changed fields;
   - session sign-out calls the revoke for the non-current row;
   - the tabs route correctly;
   - History renders rows and filters.

---

### Task E: Live verification (controller)
Run Sirdar from the worktree on 8097 + 5178 using the temp `-wt` launch entries in the main checkout's `.claude/launch.json` (remove them afterward), migrate the dev DB, then:
1. Import (contact fields copied).
2. Sign in as claude-dev (portal, 2FA). Check the profile edit, the Security panel read-only, sessions, every Preferences control applying live (accent/theme/density/nav), and History rows.
3. Create a local admin via the CLI and sign in. Check change password, set up 2FA (scan → code from pyotp), sign out, then sign in with a code and the backup codes panel.
4. Run all suites. Then clean up the temporary local admin.
