# Live Portal Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New notifications reach every signed-in portal tab of their recipient within about a second (bell, inbox list, toasts), with the poll kept as a slower fallback.

**Architecture:** `notify()` and the inbox mutation routes send `pg_notify('ss_inbox', '<person_id>')` in the caller's transaction. Each API process holds one asyncpg `LISTEN ss_inbox` connection (an `InboxHub`) that fans signals out to that person's open WebSockets on `/notifications/inbox/stream`. The socket sends only `{"inbox": true}` and the portal re-reads `GET /notifications/inbox` as it does today.

**Tech Stack:** FastAPI WebSockets, asyncpg `add_listener`, SQLAlchemy async, React 18 + vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-11-10-live-portal-notifications-design.md`

## Global Constraints

- American English in all copy, comments and docs. 24-hour times.
- The access token rides the subprotocol list `["ss-bearer", <token>]`, never the URL. The server accepts subprotocol `ss-bearer`.
- Close codes: 4401 no/invalid token or the session ended; 4403 kiosk session (`actor.session.client == "kiosk"`) or a password change owed (`password_change_owed`).
- Socket messages: `{"inbox": true}` (inbox changed) and `{"ping": true}` (every 30 s). Nothing else, never notification content.
- Channel name `ss_inbox`, payload = the person id as a string.
- Fallback poll: 30 s (`INBOX_POLL_MS`) while the stream is down, 120 s (`INBOX_POLL_LIVE_MS = 120_000`) while live. The visibility re-read stays.
- The listener runs only in API processes, never in workers.
- Tests run in the foreground with a 600000 ms timeout. API tests: `cd api && SS_TEST_DB=serversherpa_test_livenotif .venv/bin/pytest <path> -q` (conftest creates and migrates that DB). Never background a suite.. Portal tests: `cd portal && npx vitest run <path>`.
- SS-487 (branch `claude/sign-in-blocking-build-c3c0d0`) also edits `notificationsContext.tsx` and the toasts. Keep edits there to a few lines.

## Review Focus

1. A rolled-back mutation that called `notify()` must not signal: covered by Task 1's rollback test.
2. A person must never receive a signal for someone else's notification, including when two people have sockets on the same process: Task 2's own-only test.
3. The listen connection dropping (Postgres restart) must not leave tabs stale forever: Task 1's reconnect test (the hub pokes everyone after reconnecting).
4. Each `TestClient`/app start runs on a new event loop. The hub singleton must be torn down at lifespan shutdown and rebuilt lazily, or the second app in a test run reuses a connection from a dead loop: Task 2's two-apps test.
5. A burst of signals (read-all while three notifications land) must not stack parallel inbox reads or show duplicate toasts: Task 4's coalescing test.

---

### Task 1: Signal + hub (API)

**Files:**
- Create: `api/src/serversherpa/notifications/live.py`
- Modify: `api/src/serversherpa/notifications/inbox.py` (in `notify()`, after the row is flushed)
- Modify: `api/src/serversherpa/api/routes/notifications.py` (5 inbox mutation routes, ~lines 566-621)
- Test: `api/tests/test_notification_live.py`

**Interfaces:**
- Produces:
  - `INBOX_CHANNEL = "ss_inbox"`
  - `async def signal_inbox(db: AsyncSession, person_id: uuid.UUID) -> None`: runs `SELECT pg_notify(:ch, :pid)` on `db`. Never commits.
  - `class InboxHub` with `async def start() -> None`, `async def stop() -> None`, `def subscribe(person_id: uuid.UUID) -> asyncio.Queue[None]`, `def unsubscribe(person_id: uuid.UUID, q: asyncio.Queue[None]) -> None`. Each signal for a person does `q.put_nowait(None)` on that person's queues. Use bounded queues (`maxsize=1`) and ignore `QueueFull`, since one pending poke is as good as ten.
  - `async def get_hub() -> InboxHub`: lazily creates and starts the process singleton. `async def stop_hub() -> None`: stops it and resets the singleton to None.
- Connection: `asyncpg.connect` with the URL from `get_settings().database_url` (strip `+asyncpg`, as in `devtools/testing/runner.py:158`), `**tls.asyncpg_kwargs(settings)`, and `server_settings={"application_name": get_application_name("-inbox")}`. Then `add_listener(INBOX_CHANNEL, cb)`. Use a supervisor task that reconnects with backoff (1 s doubling to 30 s) when the connection is lost (`conn.add_termination_listener`, or a periodic `is_closed()` check). After every *re*connect, poke every subscribed queue once. Ignore payloads that are not a UUID.

- [ ] **Step 1: Write failing tests** in `api/tests/test_notification_live.py`:
  - `test_notify_signals_on_commit`: open a raw asyncpg connection that LISTENs on `ss_inbox`, call `notify()` for person P in a session and commit. Assert one payload `== str(P)` arrives within 2 s.
  - `test_notify_does_not_signal_on_rollback`: same, but roll back. Assert nothing arrives within 0.5 s.
  - `test_notify_suppressed_row_does_not_signal`: the person's Inbox switch is off for an emailable kind (see the existing suppression tests in `test_notification_*`). `notify()` returns None, and assert no signal.
  - `test_hub_fans_out_to_that_person_only`: start a hub, subscribe P twice and Q once, then commit `signal_inbox(db, P)`. Both of P's queues get an item within 2 s; Q's stays empty.
  - `test_hub_reconnects_and_pokes_everyone`: subscribe P, then terminate the hub's backend with `pg_terminate_backend` (find it by `application_name` ending `-inbox`). Assert P's queue gets an item within 5 s, and a later `signal_inbox` still arrives.
  - `test_mutation_routes_signal_only_on_change`: through the HTTP client, `POST /notifications/inbox/{id}/read` on an unread item signals, and a second identical call does not. `POST /notifications/inbox/read-all` with nothing unread does not signal.
- [ ] **Step 2: Run them, expect failures** (ImportError / no payload).
- [ ] **Step 3: Implement** `live.py`. Call `signal_inbox(db, person_id)` in `notify()` only when a row was written (after `db.flush()`). In the five routes, call `signal_inbox(db, user.person.id)` before `db.commit()`, only when the route changed a row (read/unread/hide already branch on it; read-all and clear-read when `rows` is non-empty, and skip their commit too when empty).
- [ ] **Step 4: Run the new tests, plus `api/tests/test_notification_*.py`**, and expect them all to pass.
- [ ] **Step 5: Commit** `feat(api): pg_notify inbox signal + per-process InboxHub (SS-500)`.

### Task 2: The WebSocket route (API)

**Files:**
- Create: `api/src/serversherpa/api/ws_auth.py`
- Modify: `api/src/serversherpa/api/routes/system.py` (move `WS_AUTH_SUBPROTOCOL`, `_token_from_subprotocols` and the kiosk/password-owed checks into `ws_auth.py` and import them; behavior unchanged)
- Modify: `api/src/serversherpa/api/routes/notifications.py` (new websocket route)
- Modify: `api/src/serversherpa/api/app.py` (`_lifespan` finally: `await stop_hub()`)
- Test: `api/tests/test_notification_stream.py`

**Interfaces:**
- Consumes: `get_hub`, `stop_hub`, `signal_inbox` from Task 1.
- Produces:
  - `WS_AUTH_SUBPROTOCOL = "ss-bearer"`, `def token_from_subprotocols(header: str | None) -> str | None`
  - `async def authenticate_portal_ws(db: AsyncSession, ws: WebSocket) -> Actor | int`: returns the actor, or the close code to use (4401/4403). Covers no token, invalid token, kiosk session, password owed. The log tail then adds its own `devtools:change` check.
  - Route `@router.websocket("/inbox/stream")` on the notifications router (so the path is `/notifications/inbox/stream`). After auth it does `ws.accept(subprotocol="ss-bearer")`, subscribes to the hub for `actor.person.id`, and loops `await asyncio.wait_for(q.get(), 30)`. On an item it sends `{"inbox": true}`. On a timeout it re-checks the `AuthSession` (revoked or expired → close 4401, same check as `system.py` ~line 697) and sends `{"ping": true}`. On exit it unsubscribes in `finally`. Make the 30 s a module constant (`INBOX_STREAM_PING_SECONDS`) so tests can monkeypatch it.

- [ ] **Step 1: Write failing tests** in `api/tests/test_notification_stream.py`, using `TestClient(create_app())` and `websocket_connect(..., subprotocols=["ss-bearer", token])` as `api/tests/test_system_api.py:150-195` does:
  - `test_stream_requires_token`: no subprotocol → 4401; `["ss-bearer", "junk"]` → 4401; `?token=` only → 4401.
  - `test_stream_refuses_kiosk_and_password_owed`: both → 4403.
  - `test_stream_signals_own_notifications_only`: P and Q both connected. `notify()` for P is committed from a separate session (a sync engine or `asyncio.run` in the test thread, like `insert_row` in the log-tail test). P receives `{"inbox": true}` within 2 s; Q receives a ping (monkeypatch the ping interval to 0.5 s) and no inbox message.
  - `test_stream_closes_when_session_revoked`: ping interval 0.5 s. Revoke P's `AuthSession` and assert the socket closes with 4401.
  - `test_stream_works_across_two_app_starts`: two sequential `with TestClient(create_app())` blocks each receive a signal (proves `stop_hub` resets the singleton).
  - Keep `api/tests/test_system_api.py`'s log-tail tests passing unchanged.
- [ ] **Step 2: Run them, expect failures** (403/404 handshake, no route).
- [ ] **Step 3: Implement** `ws_auth.py`, refactor `system.py` onto it, add the route and the lifespan `stop_hub()`.
- [ ] **Step 4: Run** `api/tests/test_notification_stream.py api/tests/test_notification_live.py api/tests/test_system_api.py api/tests/test_password_expiry.py` and expect them to pass.
- [ ] **Step 5: Commit** `feat(api): /notifications/inbox/stream websocket (SS-500)`.

### Task 3: Portal stream hook

**Files:**
- Create: `portal/src/lib/inboxStream.ts`
- Modify: `portal/src/lib/api.ts` (add `inboxStreamUrl()` beside `logStreamUrl`)
- Test: `portal/src/lib/inboxStream.test.ts`

**Interfaces:**
- Consumes: `getAccessTokenForStream()`, `logStreamProtocols(token)`, `refreshSession()` from `api.ts`; `nextBackoff` from `lib/logViewer.ts`.
- Produces:
  - `export function inboxStreamUrl(): string` returns `${apiUrl().replace(/^http/, 'ws')}/notifications/inbox/stream`.
  - `export function useInboxStream(personId: string | null | undefined, onChange: () => void): boolean`. The return value is true while the socket is open. It calls `onChange` on every `{"inbox": true}` and once after every successful open (the first open included; the provider's mount refresh can coalesce with it). Pings are ignored. On close or error it reconnects after `nextBackoff`. On close code 4401 it first `await refreshSession()`, then reconnects (an unauthenticated result also backs off). With no token it waits for backoff and retries. When `personId` changes or the component unmounts, it closes the socket and cancels timers. `onChange` is held in a ref so a new callback does not reconnect.

- [ ] **Step 1: Write failing tests** with a fake `WebSocket` class on `globalThis` and fake timers (see how `ProcessLogs` tests or `logViewer.test.ts` mock; write a minimal fake if none exists):
  - `opens with ss-bearer protocols and no token in the URL`
  - `calls onChange on open and on each inbox message, not on ping`
  - `returns true while open and false after close`
  - `reconnects with backoff 1 s then 2 s`
  - `on 4401 calls refreshSession before reconnecting`
  - `closes and stops reconnecting on unmount and when personId changes`
- [ ] **Step 2: Run** `npx vitest run src/lib/inboxStream.test.ts` and expect failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it again and expect a pass.**
- [ ] **Step 5: Commit** `feat(portal): useInboxStream websocket hook (SS-500)`.

### Task 4: Provider integration

**Files:**
- Modify: `portal/src/lib/notificationsContext.tsx`
- Test: `portal/src/lib/notificationsContext.test.tsx` (extend)

**Interfaces:**
- Consumes: `useInboxStream` (Task 3).
- Produces: `export const INBOX_POLL_LIVE_MS = 120_000`. The context `Value` shape is unchanged.

- [ ] **Step 1: Write failing tests** (mock `./inboxStream` to capture `onChange` and control `live`):
  - `a stream signal re-reads the inbox and toasts a new item`
  - `coalesces a burst: three signals while a read is in flight cause one more read, not three`
  - `polls every 120 s while live and every 30 s while not`
  - The existing tests still pass (sign-out reset, no spurious toasts).
- [ ] **Step 2: Run them, expect failures.**
- [ ] **Step 3: Implement:**
  - Wrap `refresh` in a coalescer: an `inFlight` ref plus a `queued` flag. A call during an in-flight read sets `queued` and returns that same promise. When the read finishes, run once more if `queued` is set. Mutations keep awaiting `refresh()`.
  - Call `const live = useInboxStream(person?.id, () => { void refresh(); })`.
  - The interval uses `live ? INBOX_POLL_LIVE_MS : INBOX_POLL_MS`.
  - Update the file's doc comment and the "30 s poll" comment above the mutations.
- [ ] **Step 4: Run** `npx vitest run src/lib/notificationsContext.test.tsx src/lib/inboxStream.test.ts`, then `npx tsc -b --noEmit` (or the repo's typecheck script in `portal/package.json`) and the full portal `npx vitest run`. Expect all to pass.
- [ ] **Step 5: Commit** `feat(portal): live inbox via stream, poll as fallback (SS-500)`.

### After the tasks (controller)

- Whole-branch review.
- Full API suite in the background: `SS_TEST_DB=serversherpa_test_livenotif`, judged by its summary line.
- Live verification on the dev stack: two signed-in people. Trigger a notification for the second and see the bell and toast land in about a second. Restart the API and watch the tab reconnect and catch up.
