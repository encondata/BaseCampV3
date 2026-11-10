# Sign-in address blocking — design

Harbor Master SS-487, sheet To-Do #33 ("Extend rate limiting beyond sign-in"). Agreed with Jimmy in chat on 2026-11-10.

## Why

In production the portal is open to the internet. Today V3 protects sign-in only per account: 10 failed passwords lock that account for 15 minutes. One address can still try a few passwords against every account without ever tripping anything. V3 also has small in-memory per-address caps on password-reset requests and public wiki share links. The kiosk move-password and biometric sign-ins have a per-address cap of their own (`move_login_capped`), but portal password sign-in and the 2FA step have none. This adds a per-address block on failed sign-ins, with escalating block times, and puts admins in charge of what happens next.

## Goals

- Block an address after too many failed sign-ins, with longer blocks each time it happens again.
- Tell admins the moment an address is blocked, and let them clear it, make it permanent, or leave it.
- Give admins a page listing blocked addresses where they can clear or permanently block them later.

## Non-goals

- No limit on normal portal or API use after sign-in (at most 25 users).
- No allow list, no manual "block this address" entry form, no country or range blocking.
- No change to the existing per-account lockout (10 failures / 15 min). It stays as it is, alongside this.
- No change to the existing in-memory password-reset and wiki share-link caps.
- **No native Android or iOS app changes** (Jimmy, 2026-11-10). Until their next updates, the apps show their generic sign-in error when an address is blocked. Showing the `address_blocked` message there is a follow-up card in Harbor Master. The web kiosk (browser and laptop) is in scope.

## Anti-goals (would make this a failure even if it works)

- A busy site gets locked out by its own crews. Every kiosk, phone and laptop at a venue usually shares one public address, so successful sign-ins must never count, and devices running normally must never trip it.
- A kiosk or station that keeps retrying with a revoked key blocks its whole venue.
- An attacker learns whether an account exists or a password was right from the block response.

## Rules (Jimmy's)

- **Trip:** 10 failed sign-in attempts from one address within a rolling **1 hour**. Only failures count.
- **Block lengths:** first block **1 h**, second **6 h**, third **12 h**, fourth **24 h**. A fifth trip makes the block **permanent until an admin clears it**.
- **Who is told and can act:** admin and above, meaning users whose global access has a highest role rank of at least 60 (Administrator 60, Super admin 80, Founder and Developer 100). Use the existing `GATE_BYPASS_RANK` constant (60) in `access/defaults.py`; the portal's `ADMIN_RANK`.
- **On a block:** a notification goes to those admins, and an admin signed in to the portal sees a **toast**. The toast and the notification both offer **Clear block**, **Block permanently** and **Leave as is**.
- **Page:** **System › Blocked addresses** in the portal nav, next to Access control (Claude's recommendation; Jimmy asked whether Admin or System and did not object).

## Rules (Claude's calls; Jimmy accepted "your choices")

- **Escalation reset:** an address's next block starts over at 1 h once **7 days** pass with no new block. **Clear block** also resets it to the start.
- **What counts as a failure:** a wrong credential on an interactive sign-in:
  - `POST /auth/login` (portal and kiosk password sign-in): wrong password or unknown account. A sign-in refused because the account is locked also counts.
  - `POST /auth/totp/verify`: wrong 2FA or backup code.
  - `POST /kiosk/move-login`: wrong move password.
  - `POST /kiosk/biometric/sign-in`: a signature that doesn't verify or an unknown key.
  - `POST /auth/password-reset/confirm` and `/check`: an invalid or expired token.
- **What never counts:** station-key and device-key checks (heartbeats, scan uploads, sound downloads), refresh-token refreshes, and any validation error that isn't a wrong credential. Devices retry these automatically, so counting them would block a venue (anti-goal).
- **What a block stops:** only the routes in the list above. A blocked address can't sign in, but sessions already signed in from it keep working. People and kiosks at a shared venue address stay working while an admin decides.
- **Blocked response:** HTTP 429 with `{"code": "address_blocked", "retry_after": <seconds or null when permanent>}` and a `Retry-After` header when the block is timed. It is the same whether or not the account exists or the password would have been right. The portal and kiosk sign-in screens show: "Too many failed sign-in attempts from this network. Try again in N minutes." For a permanent block: "This network is blocked from signing in. Contact your administrator."
- **"Leave as is"** marks the notification handled and does nothing to the block. The block runs its course.
- **"Block permanently"** on a timed block makes it permanent now. **"Clear block"** ends it now and resets the escalation.
- **The address** is the one `api.deps.rate_limit_ip` already picks (the proxy-appended rightmost `X-Forwarded-For` behind Caddy, else the peer). IPv6 addresses are keyed by their /64, as the reset limiter does.
- **Storage:** in the database, not in memory, so blocks survive restarts and every API process agrees. Failure records older than 1 hour can be pruned.
- **Audit:** Clear block and Block permanently write audit log entries naming the admin and the address. Blocks the system makes on its own are recorded on the block row itself (see below).
- **Email:** none. The new kind goes in the existing `security` ("Account security") category as in-app only, with a toast. (Claude's call. Admins hear about it the next time they're signed in. Email could be added later.)
- **Existing kiosk caps stay.** `move-login` and biometric sign-in already have a database-backed cap in `kiosk.py` (`move_login_capped`, counted from `login_failed` audit rows, per address plus a site-wide limit, answering 429 `move_login_rate_limited` / `biometric_rate_limited`). That cap stays as it is. The new address block is checked **first** on those routes, so a blocked address always gets `address_blocked`. Their failures also count toward the new block. (Claude's call.)
- **One decision settles it for everyone.** The block row is the only source of truth. Each admin's notification and toast read the block's current state. Once any admin clears it or blocks it permanently, every admin's notification shows "Cleared by <name>" or "Blocked permanently by <name>", and the action buttons disappear. **Leave as is** only dismisses that admin's own toast and notification. An admin who signs in while a block is active and nobody has decided yet gets the toast then, too. (Claude's call.)
- **Never blocked:** loopback addresses and the shared `unknown` bucket. If the proxy stops sending `X-Forwarded-For`, every caller looks like loopback, and a block there would shut out everyone. Private (LAN) addresses **can** be blocked, as they are on any internet-facing install. (Claude's call.)
- **Recovery if every admin is shut out:** a CLI command, `serversherpa unblock-address <address>` (and `--all`), in `cli.py`, run on the server. It writes an audit entry. (Claude's call.)

## What the admin sees

**Toast:** shown to signed-in admins when the notification arrives through the portal's existing notification polling. It reads "Sign-ins blocked from 203.0.113.7 for 1 hour (10 failed attempts)", with the three actions. It uses the existing `ToastHost`.

**Notification:** a new notification kind (registered like the others; `test_notification_kinds` checks registration) in the inbox with the same text and actions. Acting from either place updates both.

**System › Blocked addresses** (`/system/blocked-addresses`, admin and above):
- A standard list, using the same list primitives, column floors and Actions ▾ menu as the other System and Admin lists. Columns:
  - Address
  - Status (Blocked 1 h / 6 h / 12 h / 24 h, Permanent, Ended)
  - Ends (24-hour HH:MM with date; "—" when permanent)
  - Times blocked
  - Failures (count in the trip)
  - Last route tried
  - First blocked
  - Last blocked
- The Actions ▾ menu has Clear block and Block permanently (whichever applies).
- By default it shows active blocks (timed and permanent). A filter shows ended ones from the last 30 days, so a repeat offender is visible.
- An empty state says no addresses are blocked.

## Data (builder decides the exact schema)

- A failure log: address, route, time. Enough to count failures in the rolling hour.
- One block row per address: current status, level (1–5), started and ends times (null for permanent), times blocked, last block time (for the 7-day reset), who cleared or made it permanent and when, and the failure count and last route of the trip.
- A new migration after 0125.

## Builder's to decide

- The exact schema, indexes and pruning job (the log-service or an existing worker is fine).
- How the check sits in the sign-in routes: a shared dependency or helper called before credential checks and after a failure. Keep it in one place.
- How concurrent failures from one address are counted without double-blocking (a single upsert or a row lock).
- How the toast learns about the notification (existing polling is fine; no websockets).

## Testing

- API tests for each counted route and for the routes that must not count (station keys, refresh).
- The 1/6/12/24 h/permanent ladder, the 7-day reset, and Clear block resetting the level.
- A blocked address still uses an existing session.
- The responses are identical for existing and unknown accounts.
- The 403 for non-admins on the list and actions.
- Portal tests for the page, the toast actions and the sign-in message. Kiosk tests for its sign-in message.
- Run the full API suite in the background against a dedicated `SS_TEST_DB` and judge it by its summary line.
