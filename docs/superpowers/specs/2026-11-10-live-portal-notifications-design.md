# Live portal notifications (SS-500, To-Do #48)

## Why

The portal's bell, inbox and toasts learn about new notifications by
polling `/notifications/inbox` every 30 s (`INBOX_POLL_MS` in
`portal/src/lib/notificationsContext.tsx`) and when the tab becomes visible.
A notification that someone else or a worker triggers can take up to 30 s to
show up. Jimmy assumed they were instant and wants them to be.

## Goal

A new notification reaches every signed-in portal tab of its recipient
within about a second: bell count, inbox list and toast (with its sound).

**Non-goals:** system status, dashboards, the kiosk, the native apps, phone
push. No new transport: the Process Logs live tail already uses WebSockets
through NPM (dev) and Caddy (production), so this uses them too.

**Anti-goals:** a stream that can deliver anyone else's notifications; a
dropped stream that leaves the bell stale; toasts firing twice.

## Design

### Signal, not data

The stream carries no notification content. It sends `{"inbox": true}`
whenever the recipient's inbox changed, and the tab re-reads
`GET /notifications/inbox` exactly as the poll does today. All of the
existing "new item → toast + sound" logic (`seen` set, sign-out reset)
stays as it is, nothing about a notification travels over the socket, and
the authoritative read is the same authorized HTTP call as now.

### Cross-process fan-out: Postgres LISTEN/NOTIFY

- `notify()` in `api/src/serversherpa/notifications/inbox.py` is the only
  code path that creates `Notification` rows, for the API and for every
  worker (notification-worker, event sweep, …). After the row is flushed it
  runs `SELECT pg_notify('ss_inbox', '<person_id>')` on the same session.
  Postgres delivers a NOTIFY only when the transaction commits, so a
  rolled-back mutation never signals, and a listener's re-read always sees
  the committed row.
- Each API process holds **one** dedicated asyncpg connection that runs
  `LISTEN ss_inbox` (started lazily by the first stream socket, kept for the
  life of the process, same connect args/TLS as the engine). It keeps an
  in-memory map `person_id → set of open sockets` and pokes each matching
  socket. If the listen connection drops it reconnects with backoff, and on
  reconnect pokes **every** open socket once, since NOTIFYs sent while it
  was down are lost.
- No pgbouncer sits in front of Postgres in dev or production, so LISTEN
  works on a plain connection.

### The socket: `GET /notifications/inbox/stream` (WebSocket)

- Auth exactly like the log tail: the access token rides the subprotocol
  list `["ss-bearer", <token>]`, never the URL. The shared
  `_token_from_subprotocols` / validation steps move into a small helper so
  both routes use one copy. Closes 4401 (no/invalid token), 4403 (kiosk
  session, password change owed). No permission beyond being a signed-in
  portal user: everyone has an inbox.
- The person id comes **only** from the authenticated session; the socket
  takes no parameters. That is the whole "own notifications only" rule.
- Every 30 s the socket sends `{"ping": true}` and re-checks the session
  (revoked or expired → close 4401), mirroring the log tail.
- Read-only maintenance mode does not apply (it is a read).

### Portal

- A small `useInboxStream(personId, onChange)` hook (new file, e.g.
  `portal/src/lib/inboxStream.ts`) opens the socket, calls `onChange` on
  each `{"inbox": true}`, and reconnects with the same backoff the log tail
  uses (`nextBackoff`). After every successful (re)connect it calls
  `onChange` once, so anything missed while disconnected is picked up.
  Closing with 4401 waits for a fresh access token (the existing refresh
  flow) rather than hammering.
- `NotificationsProvider` calls the hook with `refresh`. Bursts of signals
  are coalesced: at most one inbox read in flight, with one more queued if
  a signal arrives meanwhile. The change inside the provider is a few lines
  so it rebases cleanly against SS-487 (sign-in blocking), which also edits
  this file and the toasts.
- The poll stays as a fallback: 30 s while the socket is down, 120 s while
  it is live. The visibility re-read stays.

### Details settled during review (builder's calls)

- `pg_notify` only when `notify()` actually wrote a row (it returns None
  when the person's Inbox switch is off).
- Mutation routes signal only when they changed at least one row. The
  originating tab's echo is not suppressed: it re-reads once more, which the
  coalescing absorbs, and `seen` makes a double read harmless.
- On close 4401 the hook calls the existing `refreshSession()` once and
  then reconnects; if that fails it falls back to backoff. As with the log
  tail, an open socket may outlive its access token; the 30 s session
  re-check is what ends it.
- The listener runs only in API processes (never workers), starts with the
  first stream socket and is closed in the app's lifespan shutdown. Its
  tests run against the real test Postgres.

## Calls I made (Jimmy to check)

1. Signal-then-re-read rather than pushing the item itself: one extra
   HTTP GET per notification, but no second code path for building inbox
   items and nothing sensitive on the socket.
2. Read/hide/mark-all changes also signal, so a second tab's bell count
   drops when you read in the first tab. It is the same mechanism and
   costs a `pg_notify` in each inbox mutation route.
3. Fallback poll 120 s while live, 30 s while the stream is down.
4. The stream lives in the API process (no new service or container).

## Testing

- API: `notify()` emits `pg_notify` on commit and not on rollback; the
  listener fans out to the right person's sockets only; the socket's auth
  close codes (4401, 4403 kiosk, 4403 password owed); a revoked session is
  closed on the next check; listener reconnect pokes everyone.
- Portal (vitest/jsdom): the hook re-reads on a signal, re-reads after a
  reconnect, backs off, and the provider coalesces bursts and slows its
  poll while live.
- Live on the dev stack: two browsers signed in as two people; trigger a
  notification for the second and see bell + toast land in about a second;
  kill the API's listen connection (or restart the API) and see the tab
  reconnect and catch up.
