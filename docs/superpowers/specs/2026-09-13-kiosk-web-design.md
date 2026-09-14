# Kiosk (web mode): framework, sign-in, and shell

The kiosk is the scanning-floor face of ServerSherpa. It will eventually run in four modes (Web only, Laptop Mode, RFID Middleware, Device App). This spec builds the framework and the web mode's sign-in and shell only: a second app in `kiosk/` that mirrors the portal's look, signs in three ways (email and password, link with phone, move password placeholder), registers itself as a kiosk Device, and ships as its own Docker image on its own port. No scanning.

**Date:** 2026-09-13 · **Status:** approved (Jimmy, 2026-09-13: "looks good lets go") · **Branch:** `kiosk-web` (worktree off `reports`)

## Decisions already made

| Question | Decision |
|---|---|
| Code sharing | Own app in `kiosk/`; a Vite alias `@portal` reaches into `portal/src` for **stylesheets and React-free TypeScript only**. No npm workspace, no copied tokens. |
| Session model | Same cookie model as the portal (`ss_refresh` httpOnly cookie on the API host, in-memory access token). No body refresh tokens. |
| Who may sign in | New permission resource `kiosk` with one action `view`. Granted by default to developer, founder, super_admin, admin, staff, worker. |
| Kiosk identity | Each kiosk self-registers as a `Device` row (`device_type='kiosk'`) by serial, using the signed-in user's session. No pre-shared secret, no device token. Register/Renew (`token_expires_at`) stays an admin action in the portal. |
| Pairing transport | Kiosk polls every 2 s while a code is showing. No WebSocket or SSE. |

## App shape

### Folder layout

```
kiosk/
  package.json            serversherpa-kiosk; react 18, react-dom, react-router-dom 6, gsap, qrcode; dev: vite 5, typescript 5, vitest, jsdom, @testing-library/*
  index.html              title "ServerSherpa Kiosk"; same Google Fonts links as the portal; <script src="/config.js"> before the module entry
  vite.config.ts          server.port 5174, server.host true; resolve.alias '@portal' -> ../portal/src; server.fs.allow ['..']; resolve.dedupe ['react','react-dom']; vitest block (jsdom)
  tsconfig.json           paths { "@portal/*": ["../portal/src/*"] }; include src only (imported portal files join the program automatically)
  public/config.js        dev default: window.__KIOSK_CONFIG__ = {}  (empty: fall back to hostname defaults)
  public/images/          serversherpa-logo.png copied from the portal
  src/main.tsx            imports portal base.css, portal-theme.css, auth-theme.css, directory.css, chrome.css via @portal, then ./styles/kiosk.css; renders <App/>
  src/App.tsx             BrowserRouter; routes /login, /settings, / (protected Home); unknown -> /
  src/lib/config.ts       apiUrl(), portalUrl(), kioskVersion()
  src/lib/api.ts          transport: ApiError, access-token store, single-flight refresh, apiFetch, loginRequest, logoutRequest, pair*, heartbeatRequest
  src/lib/identity.ts     getIdentity(), setKioskName()
  src/lib/platform.ts     platform(): { mode: 'web' }
  src/lib/heartbeat.ts    startHeartbeat(onState) -> stop()
  src/auth/KioskAuthContext.tsx
  src/components/KioskGuard.tsx      (the kiosk's ProtectedRoute)
  src/components/PairPanel.tsx
  src/components/MethodSwitch.tsx    (segmented control for the three methods)
  src/layout/KioskShell.tsx
  src/pages/Login.tsx
  src/pages/Home.tsx
  src/pages/KioskSettings.tsx
  src/styles/kiosk.css
  src/portalImports.test.ts          guardrail (see Testing)
  Dockerfile, .dockerignore, docker-compose.yml, docker/Caddyfile, docker/entrypoint.sh, README.md
```

### Runtime config (`src/lib/config.ts`)

Resolution order, read per call (never at module scope, same reason as the portal's `apiUrl()`):

1. `window.__KIOSK_CONFIG__.apiUrl` / `.portalUrl` (written by the Docker entrypoint, empty object in dev)
2. `import.meta.env.VITE_API_URL` / `VITE_PORTAL_URL`
3. `http://${window.location.hostname}:8000` / `http://${window.location.hostname}:5173`

`kioskVersion()` returns `import.meta.env.VITE_KIOSK_VERSION ?? package.json version` (Vite `define`).

### Identity (`src/lib/identity.ts`)

- `serial`: localStorage `ss.kiosk.serial`; generated once as `kiosk-web-<uuid4>`.
- `name`: localStorage `ss.kiosk.name`; default `Kiosk <last 4 hex of serial, uppercase>`; editable in Kiosk settings (trimmed, 1–80 chars, required).
- `getIdentity()` returns `{ serial, name }`. Both reads are wrapped in try/catch; if storage is unavailable the serial is regenerated per page load and settings shows a warning "This browser can't remember kiosk settings".

### Transport (`src/lib/api.ts`)

A compact re-implementation of the portal's session behavior, not an import of `portal/src/lib/api.ts` (that file drags in 500 lines of portal endpoints and its `apiUrl()` ignores runtime config). Same rules, stated once here so tests can pin them:

- Access token in a module variable only. Never in storage.
- `refreshSession()` is single-flight; `POST {api}/auth/refresh` with `credentials: 'include'`, no Authorization header; null on failure.
- `apiFetch(path, init)` pre-refreshes when the token is within 30 s of expiry, attaches `Authorization: Bearer`, and on 401 performs exactly one refresh and retry, then calls `notifySessionEnded()`.
- `loginRequest(email, password)` → `POST /auth/login` with body `{email, password, client: "kiosk"}`.
- `logoutRequest()` → `POST /auth/logout`, never throws.
- `createPairRequest({serial, name})`, `pollPair(code, pollToken)`, `heartbeatRequest(body)` — see API.
- `ApiError { status, code }` mirrors the portal's; `code` comes from `detail.code`, falling back to `'network'`.
- Types `SessionData`, `PersonOut`, `UiPreferences` are imported (type-only) from `@portal/lib/api`; `computeCan` from `@portal/lib/access`; `applyPreferences` from `@portal/lib/settings`.

### Auth context (`src/auth/KioskAuthContext.tsx`)

State: `status: 'loading' | 'authed' | 'anon'`, `person`, `perms`, `mustChangePassword`, `registration: RegistrationState | null` (from heartbeat), `sessionExpiresAt`.

- On mount: `refreshSession()`; if it returns a session → `adopt(session)`; else `anon`.
- `adopt(session)`: store token, `applyPreferences(session.preferences)`, set state, start the heartbeat.
- `login(email, password)` → `loginRequest` → `adopt`. `completePair(session)` → `adopt` (called by PairPanel).
- `logout()` → stop heartbeat, `logoutRequest`, clear state, `anon`.
- Subscribes to `onSessionEnded` → same as logout without the request.
- Subscribes to `installVisibilityRefresh` (refresh on tab focus), same as the portal.

### Heartbeat (`src/lib/heartbeat.ts`)

`startHeartbeat(onState)` posts immediately, then every 60 s, `{serial, name, mode, version}` to `POST /kiosk/heartbeat`; calls `onState(response.registration)` on success; on any failure (network, 423 read-only, 403) it keeps the last known state and retries next tick. Returns a `stop()` that clears the timer. It also re-posts immediately when the kiosk name changes (settings page calls `heartbeatNow()`).

### Shell and screens

`KioskShell` renders `<div class="portal-shell kiosk-shell" data-theme=... >` (attributes set by `applyPreferences`), containing:

- `.kiosk-top`: logo mark + wordmark `Server<em>Sherpa</em>` + `.kiosk-mode` chip "Kiosk · Web"; center: kiosk name (mono, click → `/settings`); right: registration chip (`Registered` green / `Expires soon` amber / `Expired` red / `Unregistered` neutral, using the portal's `.chip.c-*` classes and the same `tokenExpiryState` thresholds as the Kiosk Devices page: ok > 7 d, soon ≤ 7 d, expired past, none null), user avatar + display name, `Sign out` button (`.btn-ghost`).
- `.kiosk-main`: the routed page in a `.portal-page`.

No side nav, no command palette, no notifications panel. The kiosk is full-width.

**Home (`/`)**: eyebrow "Kiosk", title "Ready", hint "Scanning arrives in a later update." One card with kiosk name, mode, signed-in person, session ends at (local time), registration state. Placeholder only.

**Kiosk settings (`/settings`)**: reachable signed in (top bar) and signed out (gear icon at the top-right of the login pane). It always renders inside `KioskShell`; when signed out the top bar shows only the logo, mode chip, and kiosk name (no user, no sign out, no registration chip). `.pf-form`: Kiosk name (text, required), Serial (read-only mono), API URL and Portal URL (read-only, resolved values), Version, Mode. Save → `setKioskName` + `heartbeatNow()` if authed + toast "Kiosk name saved". Back returns to where it came from.

**Must-change-password**: if the adopted session has `must_change_password`, `KioskGuard` renders a `.portal-page` notice "Your password needs to be changed before you can use a kiosk. Sign in to the portal at {portalUrl} to change it." with a Sign out button, instead of the page. (The security-fixes branch makes this a server-side 403 `password_change_required` on every other route, so the kiosk never relies on client enforcement.)

### Login page (`/login`)

Same two-panel `.login-shell` as the portal, reusing `auth-theme.css` verbatim:

- **Brand panel**: identical structure; headline accent word "Kiosk" instead of "Portal"; sub copy "Sign in to start scanning. Link this kiosk with your phone or use your ServerSherpa credentials."; same terrain animation. `buildBrandScene(brandEl, svgEl, reduceMotion)` moves from `portal/src/pages/Login.tsx` into `portal/src/lib/brandScene.ts` (pure move, exported, no React; the portal Login imports it from there). The kiosk imports it via `@portal/lib/brandScene`.
- **Pane**: eyebrow "ServerSherpa Kiosk" + kiosk name on the same line (`.eyebrow-kiosk` mono, muted); `<SystemBanners>` is **not** reused (it is a React component); instead the kiosk fetches `GET /system/status` itself and renders the same `.portal-banner` markup for read-only mode and broadcast (small `KioskBanners` component, kiosk-local). Title "Sign in". Then `MethodSwitch` (a `.segmented` control with three pills: **Email & password**, **Link with phone**, **Move password**) and the selected method's form below. The choice persists in localStorage `ss.kiosk.method` (default `link`) so a kiosk left on the floor opens on the QR.

**Email & password**: same fields, peek toggle, error copy and shake as the portal. Error map: `invalid_credentials`, `account_locked`, `account_disabled`, `totp_required` (portal copy) plus `kiosk_not_allowed` → "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access." and `network` → "Can't reach the server. Check the kiosk's network connection." No Remember me, no SSO, no Forgot password (those are portal concerns; the hint says "Forgot your password? Reset it in the portal.").

**Link with phone** (`PairPanel`):
- On show (and on "Get a new code"): `createPairRequest` → `{code, poll_token, link_url, expires_at}`.
- Renders: QR (`qrcode` package, `toCanvas`, 220 px, error correction M, colors from `--text-dark` on `--paper`) of `link_url`; beneath it the code as `XXXX-XXXX` in `.pair-code` (Fragment Mono, 34 px, letter-spacing .18em); a line "Scan the code, or open **{portal host}/link** on your phone and enter it"; a countdown "Expires in m:ss"; button "Get a new code".
- Polls `pollPair(code, poll_token)` every 2 s (cleared on unmount, on expiry, on tab hidden; resumed on visible). Responses: `pending` → keep polling; `approved` (with session) → `completePair(session)` → navigate `/`; `denied` → replace the QR with "Sign-in was declined on the phone." + Get a new code; `expired` / 404 → "This code expired." + Get a new code.
- If `createPairRequest` fails (429 or network) → inline error "Couldn't get a code ({reason}). Try again." with a retry button.

**Move password**: one `.field` "Move password" (type password, peek toggle) and a "Sign in" button. Submit → inline `.form-notice` "Move passwords aren't available yet. Use email & password or link with your phone." No request is made. The input is cleared.

**Settings gear**: `.pane-gear` button top-right of the pane, `aria-label="Kiosk settings"` → `/settings`.

### Styles (`src/styles/kiosk.css`)

Only kiosk-specific rules: `.kiosk-shell` (grid rows auto/1fr, `min-height:100vh`, `background: var(--paper-2)`), `.kiosk-top` (height 56 px, `background: var(--ink)`, `color: var(--snow)`, border-bottom `var(--ink-line)`), `.kiosk-mode`, `.pair-code`, `.pair-qr`, `.form-notice`, `.pane-gear`, `.eyebrow-kiosk`. Everything else comes from the portal sheets. The kiosk never redefines a `--` token. List-typography guardrail selectors are not used (no lists in this pass).

## API

New router `api/src/serversherpa/api/routes/kiosk.py` (`prefix="/kiosk"`, tag `kiosk`), service `api/src/serversherpa/services/kiosk_pairing.py`, schemas in `api/schemas.py`. Registered in `app.py` after `devices`.

### Permission resource

- `access/resources.py`: `Resource("kiosk", "Kiosk", visible_to=frozenset({"global", "self"}))`. No routes (the kiosk is not a portal page).
- `access/defaults.py`: add `"kiosk"` to `_ALL`; grants `("view",)` for developer, founder, super_admin, admin, staff, worker. (developer/founder/super_admin derive from `_ALL`, so only the FULL-vs-view exception matters: `kiosk` is `("view",)` for everyone, like `ai`.)
- Migration `0061_kiosk.py` (`down_revision="0060"`): inserts `role_permissions (role,'kiosk','view')` for those six roles `ON CONFLICT DO NOTHING` (pattern: 0045) and creates `kiosk_pair_requests`. Downgrade drops the table and deletes the grants.
- Portal `lib/access.ts` needs no change (perms come from the session payload). The Access page lists the new resource automatically.

### Login gate (`client: "kiosk"`)

- `LoginIn` gains `client: Literal["portal", "kiosk"] = "portal"`.
- `services/auth.login(..., client="portal")`: after the password verifies and before a session is minted, when `client == "kiosk"`: `access = await resolve_access(db, account.person_id)`; if not `access.can("kiosk", "view")` → audit `login_failed` (no lockout increment) and raise `AuthError("kiosk_not_allowed")`. `_STATUS["kiosk_not_allowed"] = 403`.
- The success half of `login` (reset lockout, mint `AuthSession`, audit `login`, build `AuthResult`) is extracted into `async def start_session(db, account, *, ip, user_agent, audit_action="login") -> AuthResult` so the pair claim mints sessions through the same code. `login` calls it; behavior is unchanged.

### Pairing

Table `kiosk_pair_requests`:

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| code | text unique | 8 chars, Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, `secrets.choice` |
| poll_token_hash | text | sha256 of the 32-byte urlsafe token returned once to the kiosk |
| serial | citext | kiosk serial |
| kiosk_name | text | |
| status | text | `pending` / `approved` / `denied` / `claimed`; expiry is derived from `expires_at`, never stored |
| approved_by | uuid null fk people | |
| ip_address | text null | creator IP |
| expires_at | timestamptz | created + 300 s |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Index on `(ip_address, created_at)` for the rate limit and on `(serial)` for the one-pending rule.

Endpoints:

- `POST /kiosk/pair` — **unauthenticated**. Body `PairCreateIn {serial: str (1–120), name: str (1–80)}`. Rules, in order: delete rows older than 24 h (cheap opportunistic cleanup); if `count(*) where ip_address = :ip and created_at > now() - 5 min >= 30` → 429 `pair_rate_limited`; mark every `pending` row for this serial `denied` (one live code per kiosk); insert; return `PairCreateOut {code, poll_token, link_url, expires_at}` where `link_url = f"{settings.portal_origin.rstrip('/')}/link/{code}"`. Read-only exempt (see below).
- `POST /kiosk/pair/{code}/poll` — **unauthenticated**. Body `{poll_token}`. 404 `pair_not_found` if no row; 403 `pair_forbidden` if the token hash mismatches (constant-time compare). Then: past `expires_at` → `{status: "expired"}`; `pending`/`denied`/`claimed` → `{status}` (`claimed` reported as `expired`, a one-shot code is spent); `approved` → mint a session for `approved_by` via `start_session(audit_action="login_pair")` with the kiosk's IP and user agent, set the refresh cookie, set status `claimed`, return `PairPollOut {status: "approved", session: SessionOut}`. If `approved_by`'s account is now disabled or has no `kiosk:view` → status `denied`. Read-only exempt.
- `GET /kiosk/pair/{code}` — requires `kiosk:view`. Returns `PairInfoOut {code, kiosk_name, serial, status, expires_at}` with `status` computed (`expired` when past). 404 when unknown.
- `POST /kiosk/pair/{code}/approve` — requires `kiosk:view`. 404 unknown; 409 `pair_not_pending` unless `pending` and unexpired. Sets `approved`, `approved_by = actor.person.id`, audits `kiosk_pair_approved` (entity `kiosk_pair`, changes `{serial, kiosk_name}`). 204. Read-only exempt (it is a sign-in).
- `POST /kiosk/pair/{code}/deny` — same gate; 409 unless pending; sets `denied`; audits `kiosk_pair_denied`; 204. Read-only exempt.

`deps.READ_ONLY_EXEMPT_PREFIXES` gains `"/kiosk/pair"`; `/kiosk/heartbeat` is **not** exempt (it writes a Device row and the kiosk tolerates failure).

Security notes, recorded so the review does not re-derive them: 40-bit codes with a 5-minute life and a per-IP creation cap; the code alone cannot claim a session because the poll token is required; approve is an authenticated action gated on the approver's own kiosk permission; the phone page names the kiosk and its serial so a user is not tricked into signing in a stranger's kiosk without seeing it; the session minted at claim time is a fresh family for the kiosk, so revoking it never touches the approver's phone session.

### Heartbeat

`POST /kiosk/heartbeat` — requires `kiosk:view`. Body `HeartbeatIn {serial: str, name: str, mode: Literal["web","laptop","pi","android","ios"], version: str | None, raw_info: dict = {}}`.

- Look up `Device` by `serial` (the existing partial unique index `devices_serial_uniq` covers this). None → insert `Device(device_type="kiosk", name, serial, sub_type=mode, version, raw_info, last_seen_at=now)`. Found with `device_type != "kiosk"` → 409 `serial_conflict`. Found kiosk → update `name`, `sub_type`, `version`, `raw_info` (merged, kiosk keys win), `last_seen_at`, `updated_at`.
- Returns `HeartbeatOut {device_id, name, registration: "ok"|"soon"|"expired"|"none", token_expires_at}` using the Kiosk Devices thresholds (7 days).
- Not audited (a heartbeat is telemetry); creation is audited once (`action="self_register"`, actor = signed-in person).

### Portal

- `portal/src/pages/Link.tsx` at `/link` and `/link/:code`, inside `ProtectedRoute` (no `resource` prop; login redirects back with `from`). If `!can('kiosk','view')` → `.portal-page` "Your account isn't allowed to sign in to kiosks." Otherwise:
  - `/link` with no code: eyebrow "Kiosk", title "Link a kiosk", one `.field` for the code (uppercased, hyphen stripped, 8 chars) + "Continue" → `/link/{code}`.
  - `/link/:code`: loads `GET /kiosk/pair/{code}`. Pending → card: "Sign in to **{kiosk_name}**?", mono serial, "This signs the kiosk in as {display_name}. Anyone at that kiosk will act as you until they sign out." Buttons **Approve** (`.btn`) and **Deny** (`.btn-ghost`). Approved → "Done. {kiosk_name} is signing in — you can put your phone away." Denied → "Declined." Expired/404 → "This code has expired or was already used. Ask the kiosk for a new one." with a link back to `/link`.
- `portal/src/lib/api.ts`: `getPairInfo(code)`, `approvePair(code)`, `denyPair(code)`; `LoginIn` untouched (portal keeps `client` default).
- `portal/src/lib/brandScene.ts`: the extracted animation (pure move; `Login.tsx` shrinks to the form).
- `portal/src/lib/devices.ts`: kiosk sub-type label `web: 'Web'`.
- `portal/src/lib/access.ts`: nothing.

## Docker and dev

- `kiosk/Dockerfile` (build context = repo root; `docker build -f kiosk/Dockerfile .`): stage `build` from `node:20-alpine`: copy `portal/package*.json` and `kiosk/package*.json`, `npm ci` in both (shared portal source resolves `gsap` from `portal/node_modules`), copy `portal/src`, `portal/public/images`, `kiosk/`, run `npm --prefix kiosk run build` with `VITE_KIOSK_VERSION` from a build arg. Stage `serve` from `caddy:2-alpine`: copy `kiosk/dist` → `/srv`, `docker/Caddyfile` → `/etc/caddy/Caddyfile`, `docker/entrypoint.sh`; expose 8080.
- `docker/Caddyfile`: `:8080 { root * /srv; encode gzip; try_files {path} /index.html; file_server }`.
- `docker/entrypoint.sh`: writes `/srv/config.js` as `window.__KIOSK_CONFIG__ = {apiUrl: "$KIOSK_API_URL", portalUrl: "$KIOSK_PORTAL_URL"};` (both required; exits 1 with a message if either is empty), then `exec caddy run --config /etc/caddy/Caddyfile`.
- `kiosk/docker-compose.yml`: service `kiosk`, `build: { context: .., dockerfile: kiosk/Dockerfile }`, `ports: "${KIOSK_PORT:-8090}:8080"`, `environment: KIOSK_API_URL, KIOSK_PORTAL_URL` (from the shell or a `kiosk/.env`), `restart: unless-stopped`. `kiosk/.env.example` documents the two variables with localhost defaults.
- `kiosk/.dockerignore`: node_modules, dist.
- `Procfile.dev` gains `kiosk: npm --prefix kiosk run dev`. `.claude/launch.json` gains a `kiosk` entry on 5174. `README.md` architecture table: "Kiosk / mobile" row becomes "Kiosk (web mode) · React 18 · Vite · own Docker image · [`kiosk/`](kiosk/)" and the dev setup gets a `kiosk` step.
- Cookie and CORS: on `localhost` the kiosk (5174 or 8090) and the API (8000) are the same site, so `ss_refresh` flows with no config. In prod the kiosk origin must be in `SS_ALLOWED_ORIGINS` and `SS_COOKIE_DOMAIN` must be the shared parent domain; both are already in `.env.example`.

## Testing

**API** (`api/tests/`, real Postgres, `SS_TEST_DB=serversherpa_test_kiosk`):
- `test_kiosk_pairing_api.py`: create returns 8-char Crockford code + token + link_url built from `SS_PORTAL_ORIGIN`; second create for the same serial denies the first; 31st create from one IP in 5 min → 429; poll with wrong token → 403; poll pending → pending; info/approve/deny require `kiosk:view` (client_viewer → 403); approve then poll → `approved` with a `SessionOut` and an `ss_refresh` cookie, and the new `auth_sessions` row belongs to the approver with its own `family_id`; second poll after claim → `expired`; approve on a claimed/denied/expired row → 409; expired row info → `expired`; approver disabled between approve and poll → `denied`.
- `test_kiosk_heartbeat_api.py`: first heartbeat creates a kiosk Device (type, sub_type, serial, last_seen_at) and audits `self_register`; second updates name/version/last_seen_at without a new row; serial owned by a `router` device → 409; `registration` derivation for null / +30 d / +3 d / −1 d; worker persona allowed, client_viewer 403.
- `test_auth_kiosk_login.py`: `client: "kiosk"` for a client_viewer → 403 `kiosk_not_allowed` and no `auth_sessions` row; for a worker → 200; `client` omitted for client_viewer → 200 (portal unchanged). Existing `test_auth*.py` stay green (the `start_session` extraction is behavior-preserving).
- `test_access_defaults.py` (or the existing matrix test): `kiosk` present in `_ALL`, six roles hold `view`, `worker` gains nothing else.

**Kiosk** (`kiosk/`, `npx vitest run`):
- `lib/api.test.ts`: login body carries `client: "kiosk"`; one refresh-and-retry on 401 then `onSessionEnded`; single-flight refresh.
- `lib/identity.test.ts`: serial generated once and stable; default name from serial; storage failure path.
- `lib/config.test.ts`: resolution order (window config → env → hostname default).
- `components/PairPanel.test.tsx` (fake timers): requests a code on mount, renders code as `XXXX-XXXX`, polls every 2 s, stops on approved and calls `completePair`, shows denied/expired copy, "Get a new code" re-requests.
- `pages/Login.test.tsx`: three pills; default method `link`; move password submit shows the notice and makes no request; password error copy for `kiosk_not_allowed`.
- `auth/KioskAuthContext.test.tsx`: mount refresh → authed; must-change-password renders the notice through `KioskGuard`.
- `portalImports.test.ts`: every `@portal/` import in `kiosk/src` resolves to a `.css` file or a `.ts` file (never `.tsx`) whose source does not import `react`. This is the two-Reacts guardrail.
- `npx tsc -b` clean.

**Portal**: `pages/Link.test.tsx` (code entry → navigate; pending → approve → done copy; 404 → expired copy; no permission → not-allowed copy); `lib/brandScene` covered by the existing `Login` render path; `npx tsc -b`.

**Live verification** (recorded in the plan): `./dev-up.sh` with the new Procfile line; open `http://localhost:5174`; sign in as a worker with email/password and confirm the Kiosk Devices page shows the new kiosk with Web type and a last-seen stamp; sign out; pick Link with phone; open the QR's URL in a second browser profile signed in to the portal; Approve; the kiosk lands on Home within 2 s; `docker compose -f kiosk/docker-compose.yml up --build` with `KIOSK_API_URL=http://localhost:8000 KIOSK_PORTAL_URL=http://localhost:5173` serves the same flow on `http://localhost:8090`.

## Out of scope (deliberately)

Scanning and any scan ingest endpoint; the move-password backend; device tokens or pre-shared enrollment secrets; blocking an unregistered or expired kiosk; SSE/WebSocket push for pairing; Laptop, RFID Middleware, and Device App modes (only the `platform()` seam exists); native iOS/Android or Electron builds; Docker images for the API and portal; a prod Caddy for the whole stack; a kiosk-hosted change-password form; TOTP.

## Implementation notes (2026-09-13)

Built on branch `kiosk-web` via `docs/superpowers/plans/2026-09-13-kiosk-web.md`. Migration head is **0061**. Deliberate deviations from the text above, all reviewed:

- **Pairing rate limit keys on the proxy-written address.** `deps.rate_limit_ip()` honors `X-Forwarded-For` only when the direct peer is loopback or private (Caddy on the same box) and then takes the RIGHTMOST entry, which the proxy appends; a public peer's header is ignored. The stored `ip_address` is the same value. The spec's "per IP" wording did not say which IP; the leftmost entry is attacker-controlled.
- **One-shot claim and approve/deny are conditional UPDATEs** (`WHERE status = 'approved'` / `'pending'`, rowcount-gated) so a retried poll or two approvers cannot mint two sessions. A claim denied at poll time (approver disabled or lost `kiosk:view`) is audited as `kiosk_pair_claim_denied`.
- **`client_viewer` test persona** needs a client anchor (`person_roles_client_scope_check`); `tests/test_auth_kiosk_login.py::_client_viewer` builds it.
- **Kiosk toolchain:** vitest is pinned `^3.2.4` (vitest 4 requires vite 6+; the portal only gets away with vitest 4 because npm nested a second vite under it). `test.environment` is `node` by default and every DOM test carries `// @vitest-environment jsdom`. `main.tsx` uses StrictMode; `PairPanel` guards its mount request with a generation counter so dev mode mints one code.
- **Docker image installs only the kiosk's packages.** `npm ci --prefix portal` inside the image fails on the portal lockfile's peer conflict, and nothing in the image needs it: `vite.config.ts` dedupes `gsap` to the kiosk's copy and portal type imports are erased. The image runs `npm run build:bundle` (`vite build`); type-checking stays in `npm run build` outside the image.
- **Shell CSS:** `.portal-shell.kiosk-shell` (doubled selector) overrides the portal shell's nav+main grid, `height: 100vh` and `overflow: hidden`; the kiosk lays out as one column with a scrolling `.kiosk-main`. The login pane is light (paper), so the method switch and text code use the pane's dark-text tokens with the active pill inverted.
- **Class names:** inside the shell the kiosk uses the portal's `btn-solid` / `mini-btn` (there is no `.btn`/`.btn-ghost` outside the login theme). Settings shows an inline "Kiosk name saved." notice rather than a toast (the portal's ToastHost is a React component). `KioskBanners` fetches `/system/status` itself for the same reason.
- **`/link/:code` load errors:** 404 / `pair_not_found` / `pair_not_pending` show the expired copy; any other failure shows "Something went wrong. Try again." with a Retry that reloads.

Live-verified 2026-09-13 against the worktree API (dev DB at 0061): email/password sign-in, heartbeat creating "Kiosk 4716 · Web" on Kiosk Devices and the chip flipping to Registered after Register from the portal, link-with-phone approve (kiosk on Home within one poll) and deny ("Sign-in was declined on the phone."), the move-password placeholder (no request), and the Docker/compose build on 8090 signing in with the same-site cookie. Not live-verified: the `kiosk_not_allowed` refusal in the UI (covered by `tests/test_auth_kiosk_login.py`), a real phone camera scanning the QR, and prod cross-subdomain cookies (`SS_COOKIE_DOMAIN`).

Known cosmetic follow-up: at viewport widths under ~900 px the top bar's mode chip overlaps the kiosk-name button and the person name is hidden.
