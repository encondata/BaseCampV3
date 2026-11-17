# Sign-in Address Blocking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block an address after 10 failed sign-ins in an hour, with escalating block times, and let admins (rank 60+) clear it or make it permanent from a toast, the inbox, or System › Blocked addresses.

**Architecture:** One service module (`security/address_blocks.py`) owns the failure log, the block rows, the ladder and the decisions. Each counted sign-in route calls two of its helpers, `raise_if_blocked` before any credential check and `record_failure` after a counted failure. A trip notifies every admin with a new `address_blocked` kind. A decision rewrites every admin's copy of that notification in the same transaction. The portal reads those copies for the toast and the inbox row, and an admin route backs the list page.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + Postgres (API), Typer (CLI), React + Vite + Vitest (portal and web kiosk).

**Spec:** `docs/superpowers/specs/2026-11-10-sign-in-address-blocking-design.md` (binding; read it before your task).

## Global Constraints

- Trip: 10 failures from one address within a rolling 1 hour. Only failures count.
- Ladder: level 1 = 1 h, 2 = 6 h, 3 = 12 h, 4 = 24 h, 5 = permanent (until an admin clears it).
- Escalation resets to level 1 when 7 days pass after the last block started with no new block. Clear block also resets it.
- Admin = global access and highest role rank ≥ `GATE_BYPASS_RANK` (60), the same rule as `ensure_admin` in `api/deps.py`. Portal: `ADMIN_RANK`.
- Address = `bucket_for(rate_limit_ip(request))`: IPv4 as itself, IPv6 by its /64, IPv4-mapped IPv6 as the IPv4. Use `bucket_for` from `wiki/share_links.py`.
- Never blocked or counted: loopback addresses (127.0.0.0/8, ::1) and the `unknown` bucket. Private LAN addresses can be blocked.
- Blocked response: HTTP 429 `{"detail": {"code": "address_blocked", "retry_after": <int seconds | null>}}`, with a `Retry-After: <seconds>` header only when timed. Identical whether the account exists or the credential is right.
- Sign-in copy, exact: timed: `Too many failed sign-in attempts from this network. Try again in N minutes.` (N = ceil(retry_after / 60), minimum 1; "1 minute" when N is 1). Permanent: `This network is blocked from signing in. Contact your administrator.`
- Toast/notification title, exact: `Sign-ins blocked from 203.0.113.7 for 1 hour (10 failed attempts)`. Durations: `1 hour`, `6 hours`, `12 hours`, `24 hours`. Permanent level: `Sign-ins blocked from 203.0.113.7 permanently (10 failed attempts)`.
- Actions, exact labels: `Clear block`, `Block permanently`, `Leave as is`. Outcome lines: `Cleared by <name>`, `Blocked permanently by <name>`.
- New notification kind `address_blocked` in category `security`, label `Sign-ins blocked`, `email=False` (in-app only; `email=False` also keeps the inbox row when the category's Inbox switch is off).
- Page: System › Blocked addresses, `/system/blocked-addresses`, admin and above. Nav item directly after Access control.
- Repo rules: American English; the standard `RowActionsMenu` "Actions ▾"; 24-hour times (HH:MM); modals with rounded corners; follow light/dark theme; no unrequested page widgets.
- Native Android/iOS apps are out of scope (SS-524).
- Every test command runs in the FOREGROUND with a 600000 ms timeout. Never background a suite. API tests: `cd api && SS_TEST_DB=serversherpa_test_signinblock .venv/bin/pytest <files> -q`. Portal: `cd portal && npx vitest run <files>`. Kiosk: `cd kiosk && npx vitest run <files>`.

## Review Focus

1. **Venue lockout.** Station-key heartbeats, scan uploads, `/auth/refresh` and `/kiosk/pair` must never write a failure row. Task 3 tests prove it.
2. **Already signed-in sessions from a blocked address keep working.** A bearer call such as `GET /auth/me` succeeds while the address is blocked (Task 3).
3. **Concurrent failures from one address.** Twelve failures fired at once must create exactly one block at level 1 and one notification per admin. A per-address advisory lock in `record_failure` handles this (Task 1 test with `asyncio.gather` on separate sessions).
4. **Clear, then one more wrong password.** The trip's failures must not stay in the window and re-trip at once. A trip deletes that address's failure rows (Task 1 test).
5. **Two admins act on one block.** The second admin's Clear gets 409 `block_not_active`. Both admins' inbox rows show `Cleared by <first admin>`. Neither shows buttons any more (Task 2 + Task 7 tests).

---

### Task 1: Schema, models and the blocking service core

**Files:**
- Create: `api/migrations/versions/0126_sign_in_address_blocks.py` (revision `"0126"`, down_revision `"0125"`, same docstring style as 0125)
- Modify: `api/src/serversherpa/db/models.py` (add `SignInFailure`, `AddressBlock`)
- Create: `api/src/serversherpa/security/address_blocks.py`
- Modify: `api/tests/conftest.py` (add `sign_in_failures, address_blocks` to the TRUNCATE list)
- Test: `api/tests/test_address_blocks.py`

**Schema:**
- `sign_in_failures`: `id` bigint identity PK; `address` text not null; `route` text not null; `at` timestamptz not null default now(). Index `(address, at)` and index on `at`.
- `address_blocks`: `address` text PK; `level` smallint not null (0 after a clear, else 1–5); `permanent` bool not null default false; `blocked_at` timestamptz not null (start of the current or last block); `ends_at` timestamptz null (null when permanent); `first_blocked_at` timestamptz not null; `times_blocked` int not null; `failure_count` int not null (failures in the trip); `last_route` text not null; `cleared_at` timestamptz null; `cleared_by` uuid FK people SET NULL null; `made_permanent_at` timestamptz null; `made_permanent_by` uuid FK people SET NULL null. Add column comments.

**Interfaces (Produces), all in `security/address_blocks.py`:**
- Constants: `TRIP_FAILURES = 10`, `TRIP_WINDOW = timedelta(hours=1)`, `RESET_AFTER = timedelta(days=7)`, `ENDED_WINDOW = timedelta(days=30)`, `LADDER: dict[int, timedelta | None] = {1: 1h, 2: 6h, 3: 12h, 4: 24h, 5: None}`.
- Route keys (the only values `route` takes): `LOGIN = "login"`, `TOTP_VERIFY = "totp_verify"`, `MOVE_LOGIN = "move_login"`, `BIOMETRIC_SIGN_IN = "biometric_sign_in"`, `RESET_CHECK = "password_reset_check"`, `RESET_CONFIRM = "password_reset_confirm"`.
- `def is_exempt(address: str) -> bool`: True for `unknown`, anything unparseable, and loopback.
- `def address_for(request: Request) -> str | None`: `bucket_for(rate_limit_ip(request))`, or None when exempt.
- `BlockState = Literal["blocked", "permanent", "ended"]`. `def block_state(block: AddressBlock, now: datetime) -> BlockState`: `ended` if `cleared_at` is set; `permanent` if `permanent`; `blocked` if `ends_at > now`; else `ended`.
- `def ended_at(block, now) -> datetime | None`: `cleared_at`, or `ends_at` when timed and past.
- `def next_level(block: AddressBlock | None, now: datetime) -> int`: 1 if None, level 0, or `now - blocked_at >= RESET_AFTER`; else `min(level + 1, 5)`.
- `async def active_block(db, address: str, now: datetime | None = None) -> AddressBlock | None`
- `def blocked_error(block, now) -> HTTPException`: the 429 from Global Constraints. `retry_after = ceil((ends_at - now).total_seconds())`, at least 1.
- `async def raise_if_blocked(db, request: Request) -> None`: no-op for exempt addresses.
- `async def record_failure(db, request: Request, route: str, now: datetime | None = None) -> AddressBlock | None`: no-op (None) when exempt. In one transaction: `SELECT pg_advisory_xact_lock(hashtext(:address))`; delete every `sign_in_failures` row older than `TRIP_WINDOW` (global prune); insert the failure; count this address's rows within `TRIP_WINDOW`; when the count ≥ `TRIP_FAILURES` and no block is active, upsert the block row (level = `next_level`, `blocked_at` = now, `ends_at` = now + LADDER[level] or None, `permanent` = level 5, `times_blocked` += 1 (1 on insert), `first_blocked_at` kept, `failure_count` = count, `last_route` = route, `cleared_*` and `made_permanent_*` reset to null), delete this address's failure rows, and call the trip hook (Task 2; leave a clearly named `await _on_trip(db, block)` that does nothing yet). Commits. Returns the block when this call tripped it.
- `class BlockNotFound(Exception)`, `class BlockNotActive(Exception)`.
- `async def clear(db, address: str, *, actor_id: uuid.UUID | None, now=None) -> AddressBlock`: raises `BlockNotFound` / `BlockNotActive`. Sets `cleared_at`, `cleared_by`, `level = 0`, deletes the address's failure rows. Does not commit.
- `async def make_permanent(db, address: str, *, actor_id, now=None) -> AddressBlock`: active timed block only (`BlockNotActive` when ended or already permanent). Sets `permanent = True`, `ends_at = None`, `made_permanent_at/by`. Does not commit.
- `async def list_blocks(db, show: Literal["active", "ended"], now=None) -> list[AddressBlock]`: active = state blocked or permanent; ended = state ended with `ended_at >= now - ENDED_WINDOW`. Newest `blocked_at` first.

- [ ] **Step 1: Write failing tests in `api/tests/test_address_blocks.py`.** Build a fake request with `starlette.requests.Request({"type": "http", "client": ("127.0.0.1", 1), "headers": [(b"x-forwarded-for", b"203.0.113.7")]})` (rate_limit_ip honors XFF from a loopback peer). Pass `now=` to step through time.
  - `test_nine_failures_do_not_block` / `test_tenth_failure_blocks_for_one_hour`: level 1, `ends_at == now + 1h`, `failure_count == 10`, `last_route == "login"`.
  - `test_failures_older_than_an_hour_do_not_count`: 9 at t0, 1 at t0+61 min: no block.
  - `test_ladder`: trip, let it expire, trip again, and so on. Levels 1, 2, 3, 4, then 5 with `permanent` True and `ends_at` None. Durations 1 h, 6 h, 12 h, 24 h. `times_blocked == 5`.
  - `test_seven_days_without_a_block_resets_to_level_one`: a trip 7 days after the previous `blocked_at` is level 1. At 6 days 23 h it is level 2.
  - `test_clear_resets_level_and_failures`: trip, clear, then one failure gives no block. Ten more give level 1.
  - `test_make_permanent`: a timed block becomes permanent. `make_permanent` on an ended block raises `BlockNotActive`. `clear` on an unknown address raises `BlockNotFound`.
  - `test_exempt_addresses_never_count`: loopback with no XFF, `::1`, and `unknown` write no rows.
  - `test_ipv6_counts_by_64`: failures from `2001:db8::1` … `2001:db8::a` trip one block keyed `2001:db8::/64`.
  - `test_concurrent_failures_block_once`: 9 failures, then 3 concurrent `record_failure` calls on 3 separate sessions (`asyncio.gather`). Exactly one call returns a block. `times_blocked == 1`.
  - `test_raise_if_blocked`: 429 detail `{"code": "address_blocked", "retry_after": 3600}` and header `Retry-After: 3600` right after a trip. Permanent: `retry_after` None and no header.
  - `test_list_blocks`: active vs ended filters, and an ended block 31 days old is left out.
- [ ] **Step 2: Run, expect failures** (`ModuleNotFoundError` / missing table).
- [ ] **Step 3: Write the migration and models, add the tables to conftest's TRUNCATE, and implement the service.**
- [ ] **Step 4: Run `test_address_blocks.py`. Expect all to pass.**
- [ ] **Step 5: Commit** `feat(api): sign-in address blocks: schema and service (SS-487)`.

### Task 2: The `address_blocked` notification

**Files:**
- Modify: `api/src/serversherpa/notifications/kinds.py` (add `"address_blocked": KindInfo("security", "Sign-ins blocked", email=False)`)
- Modify: `api/tests/test_notification_kinds.py` (expected table gains `"address_blocked": "security"`)
- Create: `api/src/serversherpa/notifications/address_blocks.py` (like `notifications/reset_requests.py`)
- Modify: `api/src/serversherpa/security/address_blocks.py` (`_on_trip` calls `announce_block`; `clear` / `make_permanent` call `resolve_block`)
- Modify: `portal/src/lib/notificationKinds.ts` (mirror the kind, if that file lists kinds)
- Test: `api/tests/test_address_block_notifications.py`

**Interfaces:**
- Consumes: `AddressBlock`, `LADDER` from Task 1.
- Produces:
  - `KIND = "address_blocked"`.
  - `async def admin_person_ids(db) -> list[uuid.UUID]`: people with a non-revoked role, a UserAccount with `disabled_at` null, and a non-archived Person, where any role has `scope_anchor == "global"` and the max `Role.rank` is ≥ `GATE_BYPASS_RANK`. This matches `ensure_admin`.
  - `def block_title(block) -> str`: the exact title from Global Constraints.
  - `async def announce_block(db, block) -> int`: `notify()` to each admin. Title from `block_title`, body `""`, link `/system/blocked-addresses`. Payload `{"address", "level", "ends_at": iso | None, "failure_count", "state": "open"}`. Returns the count. Does not commit (record_failure commits).
  - `async def resolve_block(db, address: str, state: Literal["cleared", "permanent"], decided_by: str) -> None`: one UPDATE like `reset_requests.resolve`. Every `address_blocked` row for `address` whose payload state is `open` gets `state` and `decided_by` merged in, and `read_at = COALESCE(read_at, now())`.
  - `decided_by` is the actor's `Person.display_name`, or `"Server command line"` when `actor_id` is None (CLI).

- [ ] **Step 1: Write failing tests.**
  - `test_trip_notifies_every_admin_and_nobody_else`: seed an Administrator (60), a Super admin (80), a staff user, and a rank-60 role anchored to a client. Only the first two get one `address_blocked` row each. Title `Sign-ins blocked from 203.0.113.7 for 1 hour (10 failed attempts)`. Payload state `open`.
  - `test_notification_survives_security_category_off`: an admin with the security Inbox switch off still gets the row.
  - `test_permanent_title`: level 5 title ends `permanently (10 failed attempts)`.
  - `test_clear_resolves_every_admins_copy`: after `clear(actor_id=admin_a)` and a commit, both admins' rows have state `cleared`, `decided_by` = admin A's display name, and `read_at` set.
  - `test_make_permanent_resolves`: state `permanent`.
  - Kind registry test updated.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `test_address_block_notifications.py test_notification_kinds.py test_address_blocks.py`. Expect all to pass.**
- [ ] **Step 5: Commit** `feat(api): notify admins when an address is blocked (SS-487)`.

### Task 3: Guard the counted sign-in routes

**Files:**
- Modify: `api/src/serversherpa/api/routes/auth.py` (login, totp_verify, password_reset_check, password_reset_confirm)
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (move_login)
- Modify: `api/src/serversherpa/api/routes/kiosk_biometric.py` (sign_in)
- Modify: existing tests that send ≥ 10 failures with `X-Forwarded-For`, e.g. `api/tests/test_move_password_api.py` cap tests and the biometric cap tests. Keep them proving the old cap (30 / 5 min per bucket plus 300 site-wide): use the loopback peer with no XFF, which the new block ignores, or seed the audit rows. Do not weaken what they assert.
- Test: `api/tests/test_address_blocks_routes.py`

**Interfaces:**
- Consumes: `raise_if_blocked`, `record_failure` and the route keys (Task 1).

**Rules (from the spec):**
- `raise_if_blocked(db, request)` is the first thing each guarded route does. It comes before `move_login_capped`, before the in-memory reset limiter `_limit`, and before any credential lookup. For `totp_verify`, put the check in a dependency declared before `actor` so it runs ahead of the challenge check: `_guard: None = Depends(guard_sign_in)`, with `async def guard_sign_in(request: Request, db: DbSession) -> None` in `security/address_blocks.py`.
- Call `record_failure(db, request, <key>)` and then re-raise for only these outcomes:
  - login: AuthError `invalid_credentials` or `account_locked`
  - totp_verify: `totp_invalid` or `account_locked`
  - move_login: `invalid_move_password`
  - biometric sign_in: `bad_challenge`, `no_biometric`, `bad_signature`
  - reset check: the token is too long or not found (`valid=False`)
  - reset confirm: `reset_token_invalid`
- Never counted: `account_disabled`, `kiosk_not_allowed`, `move_not_active`, `invalid_challenge`, `password_change_required`, `biometric_expired`, 422s, `/auth/refresh`, station/device-key routes, `/kiosk/pair`.
- `record_failure` commits on its own. Call it after the service's own commit or rollback (for reset check, after its `db.rollback()`).

- [ ] **Step 1: Write failing tests.** Use the `client` fixture with header `X-Forwarded-For: 203.0.113.7`, plus `seeded_user`.
  - `test_login_ten_wrong_passwords_blocks`: the 11th call (right password) gets 429 `address_blocked` with `retry_after` 3600 and header `Retry-After: 3600`.
  - `test_unknown_account_failures_count`.
  - `test_blocked_response_identical_for_existing_and_unknown_account`: while blocked, the right password for alice and a made-up email give byte-identical status, body and Retry-After.
  - `test_other_address_unaffected`: `203.0.113.8` still signs in.
  - `test_successful_sign_ins_never_count`: 20 successful logins, then no block.
  - `test_totp_wrong_codes_count`: an alice with confirmed 2FA (copy the setup from the existing totp tests). Ten wrong codes on challenges, then the next verify is 429 even with a valid challenge.
  - `test_move_login_wrong_password_counts_and_block_precedes_cap`: ten wrong move passwords, then `address_blocked` (not `move_login_rate_limited`).
  - `test_biometric_bad_signature_counts`: reuse the existing biometric test helpers.
  - `test_reset_check_and_confirm_invalid_tokens_count`.
  - `test_refresh_and_station_heartbeat_never_count`: 15 bad `/auth/refresh` calls and 15 heartbeats with a revoked station key (copy from `test_kiosk_heartbeat_api.py`) leave `sign_in_failures` empty.
  - `test_blocked_address_keeps_existing_session`: sign in, trip the block with wrong passwords, then `GET /auth/me` with the earlier bearer token returns 200.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement the guards. Adapt the existing cap tests.**
- [ ] **Step 4: Run the new file plus `test_move_password_api.py test_kiosk_biometric_api.py test_kiosk_biometric_ios_api.py test_auth_kiosk_login.py`, every `test_*totp*`, `test_*password_reset*`, `test_*login*` and `test_kiosk_heartbeat_api.py`. Expect all to pass.**
- [ ] **Step 5: Commit** `feat(api): block addresses after failed sign-ins (SS-487)`.

### Task 4: Admin routes and the CLI recovery command

**Files:**
- Create: `api/src/serversherpa/api/routes/blocked_addresses.py` (router prefix `/system/blocked-addresses`, tag `system`)
- Modify: `api/src/serversherpa/api/app.py` (include the router)
- Modify: `api/src/serversherpa/api/schemas.py` (`BlockedAddressOut`, `BlockedAddressActionIn`)
- Modify: `api/src/serversherpa/cli.py` (`unblock-address`)
- Test: `api/tests/test_blocked_addresses_api.py`, `api/tests/test_cli_unblock_address.py`

**Interfaces:**
- `BlockedAddressOut`: `address: str`, `status: Literal["blocked","permanent","ended"]`, `level: int`, `blocked_at`, `ends_at: datetime | None`, `ended_at: datetime | None`, `times_blocked: int`, `failure_count: int`, `last_route: str`, `first_blocked_at`, `cleared_at`, `cleared_by_name: str | None`, `made_permanent_at`, `made_permanent_by_name: str | None`.
- `BlockedAddressActionIn`: `address: str` (max 64). The address goes in the body because an IPv6 key holds a `/`.
- `GET /system/blocked-addresses?show=active|ended` (default active) → `list[BlockedAddressOut]`.
- `POST /system/blocked-addresses/clear` and `POST /system/blocked-addresses/permanent` → `BlockedAddressOut`. 404 `block_not_found`, 409 `block_not_active`. Audit `entity_type="address_block"`, `entity_id=address`, actions `address_block_cleared` / `address_block_made_permanent`, changes `{"address", "level"}`, `ip=client_ip(request)`. Commit.
- Gate on every route: `require_permission("dashboard", "view")` plus `ensure_admin(actor)`, the same pattern as `system.py`'s routes.
- CLI: `serversherpa unblock-address [ADDRESS] [--all]`. Exactly one of the two is required, otherwise exit 2 with a message. ADDRESS is normalized with `bucket_for`. `--all` clears every active block. Uses `clear(actor_id=None)`. Each clear writes the audit row `address_block_cleared` with `changes={"address", "level", "via": "cli"}`. Prints `Cleared <address>.` or `No active block for <address>.` (exit 1). Follow `reset_totp`'s structure.

- [ ] **Step 1: Write failing tests.**
  - `test_list_requires_admin`: staff gets 403 `forbidden`. A rank-60 role anchored to a client gets 403. An Administrator gets 200.
  - `test_actions_require_admin`: 403 for staff on both POSTs.
  - `test_list_active_and_ended`: rows carry `status`, `level`, `ends_at`, `failure_count`, `last_route`.
  - `test_clear`: 200, status `ended`, `cleared_by_name` set. An audit row exists. A second clear gets 409 `block_not_active`. An unknown address gets 404.
  - `test_make_permanent`: status `permanent`, `ends_at` null. The admin's notification state is `permanent`.
  - `test_ipv6_key_in_body`: clear `2001:db8::/64` works.
  - CLI (Typer `CliRunner`, following existing CLI tests if any): clears one address and writes the audit row with `via: cli`; `--all` clears two; no args exits 2.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both files plus Tasks 1–2 tests. Expect all to pass.**
- [ ] **Step 5: Commit** `feat(api): blocked-address admin routes and unblock-address CLI (SS-487)`.

### Task 5: Sign-in messages (portal, password reset, web kiosk)

**Files:**
- Create: `portal/src/lib/addressBlocked.ts` (React-free, so the kiosk can import it as `@portal/lib/addressBlocked`)
- Modify: `portal/src/pages/Login.tsx` (password form and the 2FA code step; on the code step, `address_blocked` carries back to the password form like `account_locked` does)
- Modify: `portal/src/pages/ResetPassword.tsx` (check and confirm)
- Modify: `kiosk/src/pages/Login.tsx` (password form and move form)
- Test: `portal/src/lib/addressBlocked.test.ts`, additions to `portal/src/pages/Login.test.tsx`, `portal/src/pages/ResetPassword.test.tsx`, and the kiosk's Login test file

**Interfaces:**
- `export function addressBlockedMessage(detail: unknown): string`: the exact copy from Global Constraints. `retry_after` null or missing gives the permanent text.
- `export function isAddressBlocked(err: unknown): boolean`: an `ApiError`-like object with `code === 'address_blocked'`. Duck-typed on `code`, because the kiosk has its own `ApiError` class.

- [ ] **Step 1: Write failing tests.** Unit: `retry_after: 3600` gives `…Try again in 60 minutes.`; `61` gives `2 minutes`; `30` gives `1 minute`; `null` gives the permanent text. Page tests: a mocked 429 `address_blocked` on login, on totp verify, on reset check, and on the kiosk password and move forms shows the message.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.** The kiosk's laptop edge already passes the 429 body through (`kiosk_laptop/edge/src/edge/routes/auth.py` `passthrough`). No edge change.
- [ ] **Step 4: Run the touched test files in portal and kiosk. Expect all to pass.**
- [ ] **Step 5: Commit** `feat(portal,kiosk): address-blocked sign-in message (SS-487)`.

### Task 6: System › Blocked addresses page

**Files:**
- Modify: `portal/src/lib/api.ts` (`BlockedAddress` type, `listBlockedAddresses(show: 'active' | 'ended')`, `clearAddressBlock(address)`, `blockAddressPermanently(address)`)
- Create: `portal/src/pages/BlockedAddresses.tsx`, `portal/src/pages/BlockedAddresses.test.tsx`
- Modify: `portal/src/App.tsx` (route `/system/blocked-addresses`, guarded like `/system/processes`)
- Modify: `portal/src/layout/navSections.tsx` (System item after Access control: `to: '/system/blocked-addresses'`, `label: 'Blocked addresses'`, `resource: 'dashboard'`, `minRank: ADMIN_RANK`, a simple stroke icon in the same style)

**Page rules:**
- Model it on an existing System/Admin standard list such as `pages/FixedReaders.tsx`. Use the same list primitives, column floors, typography tokens, header and `RowActionsMenu` (Actions ▾). The list typography guardrail tests must pass.
- Columns in order: Address, Status, Ends, Times blocked, Failures, Last route tried, First blocked, Last blocked.
  - Status labels: `Blocked 1 h` / `Blocked 6 h` / `Blocked 12 h` / `Blocked 24 h` (by level), `Permanent`, `Ended`.
  - Ends: 24-hour `YYYY-MM-DD HH:MM` local time. Reuse the existing 24-hour formatter (see `lib/importReport.ts`) or add one to `lib/format.ts`. Show `—` when permanent; for ended rows show the time it ended.
  - Last route tried labels: login → `Password sign-in`, totp_verify → `2FA code`, move_login → `Move password`, biometric_sign_in → `Biometric sign-in`, password_reset_check / password_reset_confirm → `Password reset link`.
- A segmented filter: `Active` (default) | `Ended (last 30 days)`, using the portal's existing segmented idiom.
- Actions ▾: `Clear block` (blocked or permanent) and `Block permanently` (blocked only). Ended rows have no menu items, so render no menu. After an action, refetch. A 409 shows the existing error/toast idiom and refetches.
- Empty state: `No addresses are blocked.` (active) / `No blocks ended in the last 30 days.` (ended).

- [ ] **Step 1: Write failing tests.** Renders the rows and labels from mocked API data. The filter switches to `show=ended`. Clear block calls `clearAddressBlock` and refetches. Block permanently is offered only on a timed block. Both empty states show. The nav shows the item to rank 60 and hides it from rank 40.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the page test, nav tests and list-typography guardrail tests. Expect all to pass.**
- [ ] **Step 5: Commit** `feat(portal): System › Blocked addresses page (SS-487)`.

### Task 7: Toast and inbox actions

**Files:**
- Create: `portal/src/components/notifications/AddressBlockedActions.tsx` (shared by toast and inbox row)
- Modify: `portal/src/components/ToastHost.tsx`, `portal/src/components/notifications/InboxRow.tsx`, `portal/src/lib/notificationsContext.tsx`
- Test: `portal/src/components/ToastHost.test.tsx`, `portal/src/components/NotificationsPanel.test.tsx` (or an InboxRow test), `portal/src/lib/notificationsContext` test if one exists

**Interfaces:**
- Consumes: `clearAddressBlock`, `blockAddressPermanently` (Task 6).
- `export function addressBlockOpen(item: InboxItem, now = Date.now()): boolean`: kind `address_blocked`, `payload.state === 'open'`, and `payload.ends_at` null or in the future.
- `AddressBlockedActions({ item, onDone })`:
  - While `addressBlockOpen`, show three buttons: `Clear block`, `Block permanently` (only when `payload.ends_at` is not null) and `Leave as is`.
  - Clear and Block permanently call the API, then `markRead(item.id)` and refresh the inbox. A 409 refreshes, and the outcome line appears from the refreshed payload.
  - Leave as is only calls `markRead(item.id)` and dismisses the toast.
  - Otherwise show the outcome line: `Cleared by <decided_by>` / `Blocked permanently by <decided_by>`, or `Ended` when it expired undecided.
- Toast rules:
  - `address_blocked` toasts don't auto-fade: skip the `INBOX_TOAST_MS` timer for them.
  - They show the actions instead of Open.
  - On the first poll after sign-in, an unread `addressBlockOpen` item becomes a toast too. Today the first poll only seeds `seen`.
  - On every poll, drop from `newItems` any `address_blocked` item that is no longer `addressBlockOpen`, so another admin's decision clears this admin's toast.
- Inbox row: the same component, matching the `membership_request` card pattern in `InboxRow.tsx`.

- [ ] **Step 1: Write failing tests.**
  - A new `address_blocked` item toasts with the three buttons and is still there after `INBOX_TOAST_MS`.
  - `Clear block` calls `clearAddressBlock('203.0.113.7')`.
  - `Leave as is` marks it read and calls no block API.
  - A timed-out (`ends_at` past) item shows no buttons.
  - The first poll toasts an unread open item and doesn't toast a read one.
  - After a poll returns the item with state `cleared` and `decided_by: 'Ada Admin'`, the toast is gone and the inbox row reads `Cleared by Ada Admin`.
  - Other kinds still auto-fade and still show Open.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the touched test files, then the full portal suite (`cd portal && npx vitest run`) and `npm run build`. Expect 0 failures and a clean build.**
- [ ] **Step 5: Commit** `feat(portal): address-blocked toast and inbox actions (SS-487)`.

---

## After the tasks (controller)

- Whole-branch review (superpowers:requesting-code-review).
- Full API suite in the background: `cd api && SS_TEST_DB=serversherpa_test_signinblock .venv/bin/pytest -q -p no:cacheprovider > <scratch>/api-suite.log 2>&1`. Judge it by the summary line.
- Live check on the dev stack: apply 0126 to the dev DB, run this branch's API, and trip a block from `203.0.113.7` (via `X-Forwarded-For` from loopback). Confirm the admin toast, clear the block from the page, and check the kiosk and portal sign-in messages.
- Stop and ask Jimmy before merging or pushing.
