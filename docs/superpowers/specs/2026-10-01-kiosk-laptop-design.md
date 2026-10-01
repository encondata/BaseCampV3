# Kiosk — Laptop edition (phase 1: the framework)

**Date:** 2026-10-01 · **Branch:** `kiosk-laptop` · **Status:** design approved by Jimmy

## Why

The kiosk already ships as web, Android and iOS clients of one API. The
laptop edition is a fourth, specialized for a station that does **label
printing** and, later, **fixed RFID reading on a Zebra FX9600**. It runs
on a laptop in Docker, keeps its own lightweight database, and keeps
working on a site with spotty or no internet once it has synced a move.

The FX9600 is a network-attached fixed reader (LLRP); a browser cannot
hold that connection, so the laptop edition needs a real local service,
not just static hosting — and that service is where the local database,
offline sign-in and the upstream queue live too.

## Phases

| Phase | Scope |
|---|---|
| **1 (this spec)** | Docker image builds and runs; online sign-in with an offline fallback; Kiosk Setup; move sync into SQLite; existing kiosk screens work against the edge; offline scan queue; heartbeat as `laptop`; WebUSB label printing from edge-served bundles |
| 2 | FX9600 checkpoint scanning (dock door / portal: every unique tag that passes becomes a scan at a configured checkpoint) — an `edge/rfid/` worker over LLRP (`sllurp`) |
| later | Network (port 9100) ZPL printing from the edge; LAN/VPN exposure; offline queuing for packs, truck loads, RFID enroll and punches |

## Decisions (Jimmy, 2026-10-01)

- **Role of the local DB: offline edge cache.** The cloud API stays the
  source of truth. The laptop syncs a move down, works standalone after
  that initial sync, and pushes its work up whenever it is online.
- **FX9600 use: checkpoint scanning** — deferred to phase 2; phase 1
  only leaves a clean slot for it.
- **Printing: WebUSB first** (the kiosk's existing Zebra path), network
  printing later.
- **Offline sign-in: cached credentials** for people who signed in
  online on this laptop, **plus a cached list of active move passwords**.
- **Exposure: localhost now**, designed so LAN/VPN can be switched on
  later.
- **Architecture: an edge API that speaks the kiosk's own contract**
  (chosen over running the full API + Postgres in the container, and
  over keeping all state in the browser).

## 1. Architecture

One image, `serversherpa-kiosk-laptop`, one process: **`edge`**, a
FastAPI + SQLite service listening on port 8090.

- **Serves the web files** — the kiosk front end built with
  `VITE_KIOSK_MODE=laptop` — at `/`, with SPA fallback to `index.html`.
  `window.__KIOSK_CONFIG__.apiUrl` is the edge's own origin, so the
  browser only ever talks to the edge.
- **Answers every path the kiosk calls today**: `/auth/login`,
  `/auth/refresh`, `/auth/logout`, `/auth/me`, `/auth/totp/verify`,
  `/kiosk/move-login`, `/kiosk/pair*`, and the `/kiosk/*` setup, sync,
  write, timeclock, printer-event and label endpoints, plus the label
  bundle / vocab reads the Labels screens use. Any path the edge does not
  implement is proxied to the cloud when online and answered `503
  {"detail": "edge_offline"}` when not.
- **SQLite** at `/data/edge.db` (a host bind mount — see Kiosk identity), WAL mode. Rebuilding
  or upgrading the container keeps the move, the queue and the auth
  cache. Schema is created/upgraded by the edge on start (a small
  ordered list of SQL steps tracked in a `schema_version` table — no
  Alembic).
- **Run** with a one-service compose file:
  `docker compose -f kiosk_laptop/docker-compose.yml up -d`. Default
  bind `127.0.0.1:8090`. `EDGE_BIND` (and, later, `EDGE_TLS_CERT` /
  `EDGE_TLS_KEY`) opens it to a LAN or VPN; nothing in phase 1 depends
  on that.
- **Config** by env: `EDGE_CLOUD_API_URL` (required),
  `EDGE_PORTAL_URL`, `EDGE_DATA_DIR` (default `/data`),
  `EDGE_OFFLINE_LOGIN_DAYS` (default 14), `EDGE_SYNC_INTERVAL_S`
  (default 300).

### Code layout

```
kiosk_laptop/
  Dockerfile            # node stage builds kiosk/ (laptop mode) → python-slim stage
  docker-compose.yml
  README.md             # install + run on a laptop (Docker Desktop)
  edge/
    pyproject.toml
    src/edge/
      app.py            # FastAPI app, static files, router wiring
      config.py
      db.py             # sqlite connection, schema steps
      crypto.py         # volume key, token encryption, argon2 verifiers
      upstream.py       # httpx client to the cloud; online/offline detection
      sessions.py       # edge-issued access tokens + refresh cookie
      routes/auth.py, routes/kiosk.py, routes/proxy.py, routes/edge.py
      sync.py           # pull a move into SQLite; periodic refresh
      outbox.py         # upstream queue worker
    tests/
```

- The front end stays in `kiosk/`: the laptop edition is a **build
  mode** of the same app, as web/Android/iOS are separate clients of the
  same API. Laptop-only UI is gated on `mode === 'laptop'`
  (`kiosk/src/lib/platform.ts` already has the value).
- The edge reuses the cloud's request/response shapes by **copying the
  pydantic models it needs** into `edge/schemas.py` with a contract test
  that diffs their JSON schema against `serversherpa.api.schemas` — the
  image must not depend on the whole API package.
- `upstream.py` treats only **connect errors and timeouts** (default 5 s
  connect / 15 s read) as "offline". Any HTTP answer from the cloud —
  including 401/403/5xx — is the cloud's answer and is passed through.

### Kiosk identity (fixed for the life of the install)

The web kiosk generates its serial and name in the browser (cookie +
`localStorage`, `kiosk/src/lib/identity.ts`). On the laptop the **edge
owns the identity** instead, so a different browser, cleared site data,
or an image update can never turn the laptop into a new kiosk:

- On first start the edge generates the **serial** (UUID) and the
  default **name** (same generator/format as the web kiosk) and writes
  them to `/data/identity.json` together with `created_at`. Every later
  start reads that file; nothing regenerates while it exists.
- `identity.json` is separate from `edge.db` and is **never touched** by
  image updates, schema upgrades, Sync, Clear local data, or Wipe this
  laptop. Losing it is the only way the laptop gets a new identity.
- The edge serves it at `GET /edge/identity`; in laptop mode
  `identity.ts` reads it from there and ignores/overwrites its cookie and
  `localStorage` copies. Every heartbeat the edge forwards carries this
  serial, so the cloud's Device row (upserted by serial) stays the same
  row forever.
- **Renaming:** the name stays editable only by an admin (rank 60+) in
  Settings, the same as the web kiosk; a rename is written to
  `identity.json`. The serial never changes.
- **`/data` is a bind mount, not a named volume** — default
  `~/ServerSherpaKiosk` on the host — so `docker compose down -v`, a
  Docker Desktop reset, or reinstalling Docker cannot delete the identity,
  key, or queued work. The README says to back up that folder.

### First run order

The first sync needs the cloud: **online sign-in** (whose first heartbeat
registers the laptop as a `laptop` kiosk under the fixed serial) →
**Kiosk Setup** (needs the cloud's setup options) → **move sync**. After
that the laptop can run standalone.

## 2. Sign-in, the cloud session and offline auth

### Online sign-in (the normal path)

The browser posts to the edge's `/auth/login` exactly as today. The edge
forwards to the cloud (`client: "kiosk"`). On success it:

1. **Keeps the cloud tokens server-side.** The person's cloud access and
   refresh tokens are stored in SQLite (`cloud_sessions`), encrypted with
   a key generated on first boot and kept at `/data/edge.key` (mode 0600).
   The browser never sees them.
2. **Issues the browser its own local session** — an edge-signed access
   token and an `ss_refresh` cookie on the edge's origin — in the same
   `SessionOut` shape, so the kiosk's auth code is unchanged.
3. **Caches an offline verifier** (`offline_logins`): an argon2id hash of
   the password just typed, the person's `MeOut` (roles, permissions,
   `max_rank`), whether 2FA was completed, and `cached_at`.

The 2FA challenge (`/auth/totp/verify`) and `/kiosk/move-login` pass
through the same way. Cloud error codes (`kiosk_not_allowed`,
`password_expired`, the 2FA challenge, rate-limit 429s) are returned
unchanged. A cloud 401 on login **deletes** that person's cached
verifier (a changed password must not keep working offline).

### Offline sign-in

Only when the cloud is unreachable (see `upstream.py`):

- **Email + password** verify against the argon2id hash, accepted only if
  `cached_at` is within `EDGE_OFFLINE_LOGIN_DAYS` (14).
- **2FA users** may sign in offline only if their last online sign-in on
  this laptop completed 2FA within that window — the laptop acts as a
  trusted device, like `ss_trust`. TOTP secrets are never cached.
- **Move passwords** verify against the cached move-password list; the
  session is locked to that move exactly as the cloud locks it, and its
  identity is the move's hidden `Kiosk · <move>` person (cached with the
  list).
- The local session carries `offline: true`; the footer shows
  "Offline sign-in" and the next online heartbeat reports it.
- Offline failures are rate-limited locally (10 failures / 5 min per
  account).

### Move-password cache — the one new cloud endpoint

`GET /kiosk/edge/move-passwords` (needs `kiosk:view`, refuses move
sessions): returns `{initiative_id, name, kiosk_person, argon2_hash,
updated_at}` for every **active** move with a password (not completed,
cancelled, historical or archived) within the caller's scope. The cloud
argon2-hashes the Fernet-decrypted password on demand; the plaintext and
the HMAC fingerprint key never leave the server. Audited. The edge
replaces its list wholesale on every sync, so a rotated or closed move
drops out.

### Who uploads queued work

Every queued row records the person whose session created it. On
reconnect the edge sends it with **that person's** stored cloud refresh
token. If that token has expired, the row waits as `needs_sign_in` and
Settings › Edge lists, e.g., "3 scans waiting for Jane Doe to sign in
online". Attribution is never forged, so the cloud needs no new trust
model for uploads.

### Security posture

- Cloud tokens and offline verifiers live only in `/data`; localhost
  binding keeps the endpoints off the network.
- Sign-out clears the local session and the cloud session; it keeps the
  offline verifier (the person may need to sign back in offline). A cloud
  answer showing the account disabled, demoted (no `kiosk:view`) or its
  password changed deletes the verifier.
- **Settings › Edge › Wipe this laptop** (admin rank 60+): clears the auth
  cache, the cloud tokens and the move-password list; clears move data
  only when the outbox is empty, otherwise it says how many rows would be
  lost and needs a typed confirmation.

## 3. Move sync

- **Kiosk Setup** (online only — it needs the cloud's setup options) goes
  through the edge. After the cloud accepts `/kiosk/setup`, the edge pulls
  the move: `/kiosk/sync/assets`, `/sync/people`, `/sync/containers`,
  `/sync/trucks`, `/kiosk/labels/vocab`, the move's label bundles, and the
  move-password list.
- **Storage:** one table per kind (`assets`, `people`, `containers`,
  `trucks`, `label_bundles`, `label_vocab`) holding the cloud row as JSON
  plus the indexed lookup columns the kiosk needs (`rfid`, `asset_id`,
  `serial_number`, `rfid_tag`, `name`, `load_number`), and a `sync_meta`
  row (move, counts, `synced_at`).
- **Refresh** every `EDGE_SYNC_INTERVAL_S` while online, on reconnect, and
  on demand (Settings › Edge › Sync now). A refresh is a full replace
  inside one transaction, so a half-finished pull never leaves mixed data.
- **The browser keeps its IndexedDB** and its own download step,
  unchanged — it now downloads from the edge over localhost, so it works
  offline too. The edge's `/kiosk/sync/*` answer from SQLite always (no
  cloud round trip), so the browser and the edge see the same snapshot.
- **Label printing:** the Labels screens read bundles and vocab from the
  edge, so WebUSB printing works offline. Printer events queue in the
  outbox.

## 4. Writes and the upstream outbox

| Kiosk write | Online | Offline (phase 1) |
|---|---|---|
| `POST /kiosk/scans` | queued, sent at once | **queued** (idempotent on `client_scan_id`, carries `scanned_at`) |
| `POST /kiosk/printer-events` | queued, sent at once | **queued** |
| `POST /kiosk/heartbeat` | forwarded with `mode: "laptop"` | latest kept, sent on reconnect |
| RFID enroll, container pack/unpack, truck load/unload, clock-in/out | passed through; on success the local copy is patched | **refused**: `503 edge_offline` |

Why those four stay online-only: RFID enroll, packs and loads depend on
the cloud's live uniqueness checks (`rfid_in_use`, one container per
asset, one truck per container), and kiosk punches deliberately carry no
client timestamp (`KioskClockInIn` — back-dating stays a portal action).
Queuing them offline needs cloud-side policy changes; that is a later
phase. The kiosk maps `edge_offline` to its existing offline message.

**Outbox** (`outbox` table): `id, kind, person_id, payload, status
(queued|sending|sent|rejected|failed|needs_sign_in), attempts,
next_attempt_at, last_error, created_at`. One worker drains it in order,
batching scans up to the cloud's 100-per-request limit, with the same
backoff ladder as the browser outbox. A row left `sending` at startup
goes back to `queued` (the scan POST is idempotent). Cloud
`rejected` codes mark the row `rejected` and are shown, never retried.

The browser's own outbox still exists and now sends to the edge, which
accepts immediately — so from the browser's view the network is always
up, and real connectivity is the edge's concern.

## 5. Laptop UI (front end changes)

Small and gated on `mode === 'laptop'`:

- **Settings › Edge** tab (laptop only): cloud status (online/offline,
  last contact), last sync and counts, **Sync now**, outbox counts by
  status with the waiting-for-sign-in list, **Retry failed**, and (admin)
  **Wipe this laptop**. Follows the existing Settings tab and modal
  header patterns.
- **Footer**: a cloud indicator (Online / Offline · queued N) and
  "Offline sign-in" when that session is offline.
- **Login**: "Link with phone" is hidden when the cloud is unreachable
  (pairing needs the cloud); email/password and Move password remain.
- No other screen changes in phase 1.

## 6. Error handling

- Cloud unreachable mid-request → the endpoint's offline behavior from
  §4; never a hung request (upstream timeouts).
- SQLite busy/locked → WAL + a 5 s busy timeout; a failed write returns
  500 with `edge_storage`, and the kiosk shows its existing storage error.
- Corrupt or missing `/data/edge.key` → the edge refuses to start with a
  clear log line rather than silently minting a new key (which would
  orphan the encrypted tokens). `edge reset-key` (CLI) wipes the tokens
  and verifiers and makes a new key.
- Cloud schema drift → the contract test (§1) fails in CI before an image
  ships.

## 7. Testing

- **Edge (pytest):** auth flows against a fake cloud (`respx`): online
  login caches tokens + verifier; offline login accepts within the
  window, refuses after it, refuses 2FA users without a cached 2FA
  sign-in, refuses after a cloud 401; move-password offline login locks
  the session; outbox ordering, batching, idempotent restart,
  `needs_sign_in`, rejected codes; sync full-replace atomicity;
  `edge_offline` for the online-only writes; static file + SPA fallback;
  the schema contract test.
- **Cloud (pytest):** `GET /kiosk/edge/move-passwords` — active moves
  only, scope-limited, refuses move sessions, hash verifies against the
  real password, audited.
- **Kiosk (vitest):** the Edge tab and footer indicator render only in
  laptop mode; `edge_offline` maps to the offline message; Link with phone
  hidden when the cloud is down.
- **Image:** a CI-style script builds the image, starts it against a fake
  cloud, and checks `/` serves the app and `/auth/login` answers.
- **Live verify:** run the image on the Mac against the dev API, sign in,
  run Kiosk Setup on a move, scan, print-preview a label; stop the dev
  API, sign out and back in offline, scan; restart the API and watch the
  outbox drain into the portal.

## Out of scope for phase 1

FX9600 / LLRP, network printing, LAN/VPN binding with TLS, offline
queuing for enroll/packs/loads/punches, auto-update of the image,
multiple moves per laptop at once, Windows-native (non-Docker) install.
