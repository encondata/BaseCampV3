# Remembered browsers — design

**Date:** 2026-10-10
**Tracker:** Security and sign-in › "Trusted device remembering" (Feature Parity 347, Gaps line 80, Partial): missing a per-device review/revoke list. To-Do #3 leftover.
**Branch:** `trusted-browsers`

## Goal

People can see and forget the browsers they told to skip the two-factor
code ("Remember this browser", `trusted_devices`, cookie `ss_trust`,
`SS_TOTP_TRUST_DAYS` = 7). Admins can do the same for a user from the user
page. Today these can only be cleared all at once (admin Reset 2FA, Sign
out everywhere, End all sessions).

Jimmy's decision (2026-10-10): self-service on /me plus an admin list on
`/people/users/:personId`.

## Data

No migration. `trusted_devices` has `id, person_id, token_hash,
user_agent, created_at, last_used_at, expires_at, revoked_at`.
"Remembered" = `revoked_at IS NULL AND expires_at > now()`. Forgetting sets
`revoked_at = now()` (rows are later purged by /dev/database › Cleanup).

## API

Self-service (signed-in user, in `api/routes/me.py`, prefix `/auth/me`):

- `GET /auth/me/trusted-browsers` → `[{id, user_agent, created_at,
  last_used_at, expires_at, current}]`, newest first, remembered rows only.
  `current` is true when the request's `ss_trust` cookie hashes to the row's
  `token_hash`.
- `DELETE /auth/me/trusted-browsers/{id}` → 204; 404 `trusted_browser_not_found`
  when it isn't the caller's remembered row. When it is the current browser,
  the response also clears the `ss_trust` cookie (same attributes the auth
  route uses to set it).
- `DELETE /auth/me/trusted-browsers` → 204; forgets all of the caller's
  remembered rows and clears the cookie.

Admin (in `api/routes/users.py`):

- `GET /users/{person_id}/trusted-browsers` → same shape without `current`.
  User agents are as sensitive as the sessions block on `GET
  /users/{person_id}`, so the gate is the same: `users:change`, a global
  actor, and either the person themself or a target whose rank the actor
  can touch (`can_touch_rank`); otherwise 403 `forbidden`. A person not
  visible to the actor is still 404 `user_not_found`.
- `DELETE /users/{person_id}/trusted-browsers/{id}` and
  `DELETE /users/{person_id}/trusted-browsers` (`users:change`, gated by
  `_load_target` exactly like `sessions/revoke-all` and `totp/reset`).

Audit: `totp.trust_forget` (one row; `changes={"trusted_browser_id": id}`)
and `totp.trust_forget_all` (`changes={"count": n}`), `entity_type=
"user_account"`, `entity_id=<person_id>`, actor = the caller. Reuse
`services/totp.py` helpers (add `list_trust`, `forget_trust(db, person_id,
id)`, keep `revoke_trust` for "all"); token hashing stays in that module.

## Portal

**/me (`pages/Profile.tsx`, Account tab):** a **Remembered browsers**
panel directly under **Active sessions**, same markup idioms
(`panel`/`panel-head`/`result-count`, `session-item`, `session-icon`,
`describeUserAgent`, `relativeTime`, `mini-btn`, `chip c-green`):

- Each row: browser name (bold), then "remembered {rel} · last used {rel} ·
  expires {rel}". The current browser shows a **This browser** chip *and*
  a **Forget** button (forgetting it is allowed).
- Header: "{n} remembered" and a **Forget all** `mini-btn` (shown when
  n ≥ 1) with `window.confirm`.
- Empty: "No remembered browsers. When you tick Remember this browser at
  the code step, it shows up here." (set-note idiom)
- Help line (page-hint): "A remembered browser skips the two-factor code
  for {N} days. Forget one to ask for the code again." where N comes from
  the API (`trust_days` field on the list response — so the list response is
  `{trust_days, browsers: [...]}`; same for the admin route).
- Only shown when the person has two-factor enrolled or has any rows.

**User page (`pages/UserDetail.tsx`):** a **Remembered browsers** block in
the same area as the existing Sessions/2FA actions, listing rows (browser,
remembered, last used, expires) with **Forget** per row and **Forget all**,
both only with `users:change`; reuse the page's existing confirm modal
pattern (header pattern: eyebrow "Two-factor", title, description) for
Forget all.

## Testing

API: list shows only remembered rows of the caller (expired, revoked and
other people's rows excluded), newest first, `current` flag from the cookie;
forget one (own → 204 + revoked; other's / revoked / expired / unknown →
404); forgetting the current one clears the cookie; forget all; audit rows;
admin GET follows the sessions-block gate (403 without `users:change`, 403 for a higher-rank target, 200 for self); admin DELETE gated by
`users:change` + `_load_target` (rank rule) — 403 for a peer of higher rank,
404 for unknown; `trust_days` value. Sign-in still skips the code for a
remembered browser and asks again after it's forgotten (one end-to-end test
through the login + code flow, reusing the existing TOTP test helpers).

Portal: /me panel rows, This browser chip, forget one / forget all (confirm),
empty state, hidden when not enrolled and no rows; user page block with and
without `users:change`.

## Out of scope

Storing the IP a browser was remembered from (would need a migration),
renaming browsers, changing the 7-day setting from the UI.
