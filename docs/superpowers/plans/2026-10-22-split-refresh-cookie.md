# Split Refresh Cookie Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The portal and the web kiosk can both stay signed in in one browser: portal sessions get their own refresh cookie, refresh/logout name their client, and a session of the wrong client is refused instead of adopted.

**Architecture:** API picks the cookie name from the session's client (`ss_portal_refresh` for portal, `ss_refresh` for kiosk — unchanged for native/edge); `/auth/refresh` and `/auth/logout` take `?client=portal|kiosk` with a legacy fallback and a no-param path identical to today; the services layer refuses a mismatched client before rotation/reuse detection. Portal and web kiosk send their client; the portal ends the session on 403 `kiosk_session`.

**Tech Stack:** FastAPI, pytest; React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-split-refresh-cookie-design.md` — binding.

## Global Constraints

- Cookie names: portal sessions `ss_portal_refresh`; kiosk sessions `ss_refresh` (unchanged). Same attributes as today (httponly, SameSite=Lax, `domain=cookie_domain or None`, `path="/auth"`, `secure` unless development).
- `POST /auth/refresh` and `POST /auth/logout` accept optional query `client` in {`portal`, `kiosk`}; any other value → 422. No parameter = exactly today's behavior on `ss_refresh` (Android, iOS, the laptop edge and old portal bundles depend on it).
- `client=portal`: read `ss_portal_refresh`; if absent, fall back to `ss_refresh` only when its session's client is `portal`; on success set `ss_portal_refresh` and clear `ss_refresh`.
- Mismatch (client given ≠ stored session's client): refresh → 401 `{"code": "wrong_client"}`, no rotation, no revocation, no reuse-detection family kill, and the other app's cookie is NOT cleared; logout → revoke nothing, clear only the caller's own cookie.
- Portal (`portal/src/lib/api.ts`, also used by the wiki): refresh and logout send `?client=portal`; `apiFetch` treats 403 `detail.code === 'kiosk_session'` as a lost session (`notifySessionEnded`) instead of returning it.
- Web kiosk (`kiosk/src/lib/api.ts`): refresh and logout send `?client=kiosk`.
- No migration. No change to native apps (`Android_Kiosk_App`, `IOS_Kiosk_App`) or `kiosk_laptop/`.
- Never commit `api/src/serversherpa/_dev_reload.py`. Never `git stash`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. American English.

## How to run things (worktree `.claude/worktrees/split-refresh-cookie`)

- API tests, foreground only, long timeout: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_splitcookie DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>`. Any alembic command must set `SS_DATABASE_URL` to the test DB.
- Portal: `cd portal && npx vitest run <files>`; before committing: full `npx vitest run`, `npx tsc -b`, `npm run build`. Kiosk: `cd kiosk && npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: API — cookie per client, client-aware refresh/logout, mismatch guard

**Files:** modify `api/src/serversherpa/api/routes/auth.py` (cookie helpers, `session_response`, `/refresh`, `/logout`), `api/src/serversherpa/services/auth.py` (`AuthResult.client`; `refresh(..., expect_client=None)` raising `AuthError("wrong_client")` before rotation/reuse handling; logout helper that can report a session's client without revoking), `api/src/serversherpa/api/routes/kiosk.py` only if `session_response` callers need adjusting; tests: new `api/tests/test_split_refresh_cookie.py`, and update portal-session cookie assertions in `api/tests/test_auth_flow.py`, `api/tests/test_totp_api.py`, `api/tests/test_kiosk_session_scope.py` (and any other test the suite shows asserting `ss_refresh` for a portal session).

- [ ] Step 1: failing tests for every case in the spec's Testing paragraph (API part), incl. 422 on a bad `client` value and that a mismatched `client=portal` refresh leaves the kiosk session refreshable afterwards.
- [ ] Step 2: run; confirm failure. Step 3: implement. Step 4: run the new file plus `tests/test_auth*.py`, `tests/test_totp*.py`, `tests/test_kiosk*.py`, `tests/test_move_password*.py`, `tests/test_password_expiry.py` — pass; ruff clean on touched files. Step 5: commit `fix(auth): separate portal and kiosk refresh cookies; refresh refuses another client's session`.

### Task 2: Portal and web kiosk clients

**Files:** modify `portal/src/lib/api.ts` (refresh + logout URLs, `apiFetch` 403 `kiosk_session` → `notifySessionEnded`), `kiosk/src/lib/api.ts` (refresh + logout URLs); tests in `portal/src/lib/api.test.ts` (or the existing api/auth test file) and the kiosk's api test file.

- [ ] Step 1: failing tests — portal refresh and logout call `/auth/refresh?client=portal` / `/auth/logout?client=portal`; a 403 `{detail:{code:'kiosk_session'}}` from any apiFetch ends the session (onSessionEnded fires, token cleared) while other 403s still return to the caller; kiosk refresh/logout call `?client=kiosk`.
- [ ] Step 2: run; confirm failure. Step 3: implement. Step 4: portal full `npx vitest run`, `npx tsc -b`, `npm run build`; kiosk full `npx vitest run`, `npx tsc -b`, `npm run build`; wiki: `cd wiki && npx vitest run` (it imports portal auth). Step 5: commit `fix(portal,kiosk): name the client on refresh/logout; a kiosk session in the portal signs out`.
