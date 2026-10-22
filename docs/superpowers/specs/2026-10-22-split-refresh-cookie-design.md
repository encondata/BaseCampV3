# Separate portal and kiosk refresh cookies — design

**Date:** 2026-10-22
**Branch:** `split-refresh-cookie`

## Problem

The API keeps one refresh cookie, `ss_refresh` (path `/auth`, on the API
host), for every app. In one browser, signing into the web kiosk replaces the
portal's cookie; the portal's next `/auth/refresh` then rotates the *kiosk*
session (refresh keeps a session's `client` forever) and every portal call
fails with 403 `kiosk_session`. The mirror case — a web kiosk tab adopting a
portal session — is possible too. Seen on dev 2026-10-22 (Jimmy's Chrome:
kiosk sign-in 16:26 UTC, portal refreshed into it at 16:28).

## Constraints found

- The Android and iOS apps and the laptop edge read the cloud cookie **by
  name** (`ss_refresh`): Android `RefreshCookieJar.kt`, iOS
  `RefreshCookie.swift`, edge `upstream.py` (`refresh_cookie_from`, and
  `adopt()` 502s without it). Renaming the kiosk cookie would sign out every
  deployed kiosk and break laptop sign-in.
- The portal and the wiki (which reuses portal auth via `@portal`) never read
  the cookie name; the browser carries it (`credentials: 'include'`).
- Native apps and the edge never share a cookie jar with the portal.

## Design

- **Cookie per client.** Kiosk sessions keep `ss_refresh` (unchanged — no
  native, edge or kiosk-cookie change). Portal sessions (the portal and the
  wiki) use a new cookie, **`ss_portal_refresh`**, same attributes (httponly,
  SameSite=Lax, `cookie_domain`, path `/auth`). `session_response` picks the
  name from the issued session's `client` (`AuthResult` carries it).
- **Refresh and logout say who is asking.** `POST /auth/refresh` and
  `POST /auth/logout` take an optional query parameter `client` (`portal` |
  `kiosk`).
  - `client=portal`: read `ss_portal_refresh`. If it is absent, fall back to
    `ss_refresh` **only when that session's client is `portal`** (a portal
    signed in before this change); on success the new token goes to
    `ss_portal_refresh` and the legacy `ss_refresh` is cleared.
  - `client=kiosk`: read `ss_refresh`.
  - No parameter (Android, iOS, the edge, and portal bundles from before the
    change): read `ss_refresh` and behave exactly as today.
- **Client guard.** When `client` is given and the stored session's client
  differs, refresh answers 401 `wrong_client` and touches nothing — no
  rotation, no revocation, no reuse-detection family kill, no cookie cleared
  (the cookie belongs to the other app). The check runs before reuse
  detection. Logout with a mismatched client only clears the caller's own
  cookie and revokes nothing.
- **Portal** (`portal/src/lib/api.ts`, shared by the wiki): refresh and
  logout send `?client=portal`. Safety net: `apiFetch` treats a 403 with
  `detail.code === 'kiosk_session'` as a lost session — it ends the session
  (`notifySessionEnded`, which shows sign-in) instead of returning the 403.
- **Web kiosk** (`kiosk/src/lib/api.ts`): refresh and logout send
  `?client=kiosk`, so a kiosk tab never adopts a portal session.
- No migration; no change to the trust cookie, password reset, the kiosk
  route surface, or the native/edge apps.

## Testing

API: portal login sets `ss_portal_refresh` and not `ss_refresh`; kiosk login
(and pair poll, move login) sets `ss_refresh`; 2FA-completed portal sessions
set `ss_portal_refresh`; with both cookies present, `refresh?client=portal`
returns the portal session and `refresh?client=kiosk` the kiosk one;
`refresh?client=portal` with only a kiosk cookie → 401 `wrong_client` and the
kiosk session still refreshes afterwards (not revoked); legacy fallback (a
portal session in `ss_refresh`) refreshes under `client=portal`, sets
`ss_portal_refresh` and clears `ss_refresh`; no-parameter refresh unchanged;
logout per client clears only its own cookie. Existing tests that asserted
`ss_refresh` for portal sessions move to `ss_portal_refresh`.

Portal: refresh/logout URLs carry `client=portal`; a 403 `kiosk_session`
ends the session. Web kiosk: refresh/logout carry `client=kiosk`.

Native apps and the edge: unchanged; their existing suites (edge at least)
still pass.
