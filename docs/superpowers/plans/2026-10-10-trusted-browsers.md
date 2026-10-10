# Remembered Browsers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List and forget remembered (two-factor-trusted) browsers — self-service on /me and for admins on the user page.

**Architecture:** `services/totp.py` gains list/forget helpers over `trusted_devices`; `routes/me.py` and `routes/users.py` expose them; the portal adds a panel to `pages/Profile.tsx` and a block to `pages/UserDetail.tsx`.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest; React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-trusted-browsers-design.md` — binding.

## Global Constraints

- "Remembered" = `revoked_at IS NULL AND expires_at > now()`. Forget = set `revoked_at`; never delete rows.
- Routes exactly: `GET/DELETE /auth/me/trusted-browsers`, `DELETE /auth/me/trusted-browsers/{id}`, `GET/DELETE /users/{person_id}/trusted-browsers`, `DELETE /users/{person_id}/trusted-browsers/{id}`.
- List response `{trust_days, browsers: [{id, user_agent, created_at, last_used_at, expires_at, current?}]}` (`current` only on the self-service route), newest first.
- 404 code `trusted_browser_not_found`. Forgetting the current browser (or all) clears the `ss_trust` cookie with the same attributes the auth route sets it with.
- Admin: GET needs `users:view` with the same visibility as `GET /users/{person_id}`; DELETEs need `users:change` and `_load_target` (as `sessions/revoke-all`).
- Audit `totp.trust_forget` (`{"trusted_browser_id"}`) and `totp.trust_forget_all` (`{"count"}`), `entity_type="user_account"`, `entity_id=<person_id>`.
- Never expose `token_hash`.
- Portal copy exactly: panel title "Remembered browsers"; chip "This browser"; buttons "Forget", "Forget all"; empty "No remembered browsers. When you tick Remember this browser at the code step, it shows up here."; hint "A remembered browser skips the two-factor code for {N} days. Forget one to ask for the code again."
- House idioms only; American English. Never commit `api/src/serversherpa/_dev_reload.py`. Never `git stash`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to run things (worktree `.claude/worktrees/trusted-browsers`)

- API tests (foreground, one at a time): `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_trust DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>` (the `.venv` is an editable install of the main checkout, so `PYTHONPATH=$PWD/src` is required). Never the dev DB.
- Portal: `cd portal && npx vitest run <files>`; before committing portal work run the full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: API — list and forget remembered browsers

**Files:** Modify `api/src/serversherpa/services/totp.py`, `api/src/serversherpa/api/routes/me.py`, `api/src/serversherpa/api/routes/users.py`, `api/src/serversherpa/api/schemas.py`; Test `api/tests/test_trusted_browsers_api.py`.

**Produces:** `async def list_trust(db, person_id) -> list[TrustedDevice]`; `def trust_token_hash(token: str | None) -> str | None` (public wrapper of `_hash_trust`); `async def forget_trust(db, person_id, trusted_id) -> bool` (False when not a remembered row of that person; does not commit); existing `revoke_trust(db, person_id)` returns the count (does not commit). The six routes above.

- [ ] **Step 1: Failing tests** covering every item in the spec's API testing paragraph, including the end-to-end sign-in check (find the existing TOTP login helpers in `tests/test_totp_api.py` / `tests/test_totp_admin_api.py` and reuse them: enroll, sign in with "remember", sign in again without the code → OK; forget; sign in again → code required).
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement.** Read the cookie the way `routes/auth.py` does (`ss_trust` via `Cookie()`); clear it with `response.delete_cookie` using the same path/domain/samesite/secure as `_set_trust_cookie`.
- [ ] **Step 4: Run** the new file + `tests/test_totp_api.py tests/test_totp_admin_api.py tests/test_users_detail_api.py tests/test_me_*` — pass. Ruff clean on changed code.
- [ ] **Step 5: Commit** — `feat(auth): list and forget remembered browsers (self-service and admin)`.

---

### Task 2: Portal — Remembered browsers on /me and the user page

**Files:** Modify `portal/src/lib/api.ts` (types + 6 calls), `portal/src/pages/Profile.tsx` (+ tests), `portal/src/pages/UserDetail.tsx` (+ tests); CSS only if needed.

- [ ] **Step 1: Failing tests** covering the spec's Portal testing paragraph (mock the API calls; mock `window.confirm`).
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement** with the Active sessions panel's markup on /me and the user page's existing confirm-modal pattern for Forget all there.
- [ ] **Step 4: Run** the full `npx vitest run`, `npx tsc -b`, `npm run build` — pass (guardrails included).
- [ ] **Step 5: Commit** — `feat(portal): Remembered browsers on /me and the user page`.
