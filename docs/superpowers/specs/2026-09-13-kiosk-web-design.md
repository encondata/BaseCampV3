# Kiosk (web mode): framework, sign-in, and shell

The kiosk is the scanning-floor face of ServerSherpa. It will eventually run in four modes (Web only, Laptop Mode, RFID Middleware, Device App). This spec builds the framework and the web mode's sign-in and shell only: a second app in `kiosk/` that mirrors the portal's look, signs in three ways (email and password, link with phone, move password placeholder), registers itself as a kiosk Device, and ships as its own Docker image on its own port. No scanning.

**Date:** 2026-09-13 · **Status:** approved (Jimmy, 2026-09-13: "looks good lets go") · **Branch:** `kiosk-web` (worktree off `reports`)

## Decisions already made

| Question | Decision |
|---|---|
| Code sharing | Own app in `kiosk/`; a Vite alias `@portal` reaches into `portal/src` for **stylesheets and React-free TypeScript only**. No npm workspace, no copied tokens. |
| Session model | Same cookie model as the portal (`ss_refresh` httpOnly cookie on the API host, in-memory access token). No body refresh tokens. |
| Who may sign in | New permission resource `kiosk` with one action `view`. Granted by default to developer, founder, super_admin, admin, staff, worker. |
| Kiosk identity | Each kiosk self-registers as a `Device` row (`device_type='kiosk'`) by serial, using the signed-in user's session. No pre-shared secret, no device token. Signing in registers the kiosk automatically (30 days, renewed when expired or within 7 days of expiring); anyone allowed to use the kiosk can do it. Register/Renew remain available in the portal, for registering ahead of time or renewing a kiosk nobody has signed into. |
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

`startHeartbeat(onState, intervalMs, firstBeatIsSignIn)` posts immediately, then every 60 s, `{serial, name, mode, version}` to `POST /kiosk/heartbeat`; calls `onState(response.registration)` on success; on any failure (network, 423 read-only, 403) it keeps the last known state and retries next tick. Returns a `stop()` that clears the timer. It also re-posts immediately when the kiosk name changes (settings page calls `heartbeatNow()`). When `firstBeatIsSignIn` is true (set by `KioskAuthContext` only for the beat that follows `login()`/`completePair()`, never a cookie restore), that one beat only adds `sign_in: true` to the body — see the API's `### Heartbeat` section below for what the server does with it.

### Shell and screens

`KioskShell` renders `<div class="portal-shell kiosk-shell" data-theme=... >` (attributes set by `applyPreferences`), containing:

- `.kiosk-top`: logo mark + wordmark `Server<em>Sherpa</em>` + `.kiosk-mode` chip "Kiosk · Web"; center: kiosk name (mono, click → `/settings`); right: registration chip (`Registered` green / `Expires soon` amber / `Expired` red / `Unregistered` neutral, using the portal's `.chip.c-*` classes and the same `tokenExpiryState` thresholds as the Kiosk Devices page: ok > 7 d, soon ≤ 7 d, expired past, none null), user avatar + display name, `Sign out` button (`.btn-ghost`).
- `.kiosk-main`: the routed page in a `.portal-page`.
- `.kiosk-foot`: a one-line mono status bar, the shell's third grid row (`.portal-shell.kiosk-shell` is `grid-template-rows: auto minmax(0, 1fr) auto`), items separated by a `·` (`.kiosk-foot-sep`): Kiosk name, Mode, Version, and — signed in only — Signed in as, Session ends (local time via `toLocaleString()`), Registration (`Checking…` while `registration` is still null). Signed out (the Settings page when anon) it shows only Kiosk, Mode, and Version.

No side nav, no command palette, no notifications panel. The kiosk is full-width.

**Home (`/`)** is launcher-only: eyebrow, title, and the feature tiles. The kiosk identity facts that once lived on Home now live in the shell's `.kiosk-foot` footer, visible from every screen.

### Home launcher and feature placeholders (2026-09-13)

Home became a launcher: eyebrow "Kiosk", title "What would you like to do?", then a `.kiosk-launcher` grid of `.kiosk-tile` links — one per entry in a new `src/lib/features.ts` registry (`FEATURES: {id, path, title, blurb, placeholder?}[]`) — each with a 40 px inline SVG icon, a title, and a blurb. Kiosk Setup (`/settings`, a gear) is first, ahead of Scanning (`/scan`, a barcode glyph), Label Printing (`/labels`, a tag), and Timeclock (`/timeclock`, a clock). Home is launcher-only now — the identity facts that used to be the whole page, then a compact strip below the tiles, moved again: they live in the shell's `.kiosk-foot` footer (see "Shell and screens").

Scanning, Label Printing, and Timeclock carry `placeholder: true`; Kiosk Setup does not, because it opens a real screen. Each placeholder feature gets a route in `App.tsx` — `/scan`, `/labels`, `/timeclock`, mapped over `FEATURES.filter(f => f.placeholder)` — wrapped in `KioskGuard` + `KioskShell` exactly like `/`. All three render the same `FeaturePage` component (`{feature}` prop): `.portal-page` with eyebrow "Kiosk · {title}", the feature title, hint "Coming soon. {blurb}", and a dashed `.kiosk-placeholder` card reading "This feature is not available yet." with a "Back to home" link. `*` still falls back to `/`. Kiosk Setup instead keeps its own long-standing `/settings` route straight to `KioskSettings` (still inside `KioskShell`, still usable signed out, never behind `KioskGuard`).

`KioskShell`'s top bar gains a `.kiosk-section` label (mono, sits after the mode chip inside `.kiosk-brand`, hidden ≤900px alongside the mode chip) showing the current feature's title via `useLocation` + `FEATURES.find`; it renders nothing on `/` and reads "Kiosk Setup" on `/settings` (Kiosk Setup is a `FEATURES` entry like any other).

Permission gating of tiles is deferred — `scan`, `labels`, and `time` resources already exist in the access system, but every signed-in kiosk user sees all three placeholder tiles for now.

**Kiosk setup (`/setup`, superseded — see "This Kiosk moves off /setup" under "### Settings")**: the kiosk variables (name, serial, mode, API/portal URLs, version) no longer live here — they moved to Settings › This Kiosk, reachable signed in (the kiosk-name button in the top bar, and Settings' own tab strip) and signed out (gear icon at the top-right of the login pane, and This Kiosk's `anon` visibility). `/setup` itself is now a placeholder for the real setup flow.

**Must-change-password**: if the adopted session has `must_change_password`, `KioskGuard` renders a `.portal-page` notice "Your password needs to be changed before you can use a kiosk. Sign in to the portal at {portalUrl} to change it." with a Sign out button, instead of the page. (The security-fixes branch makes this a server-side 403 `password_change_required` on every other route, so the kiosk never relies on client enforcement.)

### Login page (`/login`)

Same two-panel `.login-shell` as the portal, reusing `auth-theme.css` verbatim:

- **Brand panel**: identical structure; headline accent word "Kiosk" instead of "Portal"; sub copy "Sign in to start scanning. Link this kiosk with your phone or use your ServerSherpa credentials."; same terrain animation. `buildBrandScene(brandEl, svgEl, reduceMotion)` moves from `portal/src/pages/Login.tsx` into `portal/src/lib/brandScene.ts` (pure move, exported, no React; the portal Login imports it from there). The kiosk imports it via `@portal/lib/brandScene`.
- **Pane**: eyebrow "ServerSherpa Kiosk" + kiosk name on the same line (`.eyebrow-kiosk` mono, muted); `<SystemBanners>` is **not** reused (it is a React component); instead the kiosk fetches `GET /system/status` itself and renders the same `.portal-banner` markup for read-only mode and broadcast (small `KioskBanners` component, kiosk-local). Title "Sign in". The email & password form is the default, normal view (no segmented control above it). Below the Sign in button: a `.divider` ("or") and a full-width "Other ways to sign in" button. Clicking it swaps that button for two stacked buttons, "Link with phone" and "Move password"; choosing one swaps the pane body to that method (title stays "Sign in", a small `.form-hint` names the method) with a "Back to email & password" control underneath. Nothing is persisted to localStorage.

**Email & password**: same fields, peek toggle, error copy and shake as the portal. Error map: `invalid_credentials`, `account_locked`, `account_disabled`, `totp_required` (portal copy) plus `kiosk_not_allowed` → "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access." and `network` → "Can't reach the server. Check the kiosk's network connection." No Remember me, no SSO, no Forgot password (those are portal concerns; the hint says "Forgot your password? Reset it in the portal.").

**Link with phone** (`PairPanel`):
- On show (and on "Get a new code"): `createPairRequest` → `{code, poll_token, link_url, expires_at}`.
- Renders: QR (`qrcode` package, `toCanvas`, 220 px, error correction M, colors from `--text-dark` on `--paper`) of `link_url`; beneath it the code as `XXXX-XXXX` in `.pair-code` (Fragment Mono, 34 px, letter-spacing .18em); a line "Scan the code, or open **{portal host}/link** on your phone and enter it"; a countdown "Expires in m:ss"; button "Get a new code".
- Polls `pollPair(code, poll_token)` every 2 s (cleared on unmount, on expiry, on tab hidden; resumed on visible). Responses: `pending` → keep polling; `approved` (with session) → `completePair(session)` → navigate `/`; `denied` → replace the QR with "Sign-in was declined on the phone." + Get a new code; `expired` / 404 → "This code expired." + Get a new code.
- If `createPairRequest` fails (429 or network) → inline error "Couldn't get a code ({reason}). Try again." with a retry button.

**Move password**: one `.field` "Move password" (type password, peek toggle) and a "Sign in" button. Submit → inline `.form-notice` "Move passwords aren't available yet. Use email & password or link with your phone." No request is made. The input is cleared.

**Settings gear**: `.pane-gear` button top-right of the pane, `aria-label="Kiosk settings"` → `/settings?tab=this-kiosk`.

### Settings (2026-09-13)

Kiosk Setup renamed its route to `/setup` (still reachable signed in or out, still never behind `KioskGuard`); `/settings` is now a new tabbed **Settings** page, added as the last `FEATURES` tile (a sliders icon) and reachable signed in or out (see "This Kiosk moves off /setup" below) — never behind `KioskGuard` itself, though `Home`'s own `/` route still is.

A tab registry (`src/lib/settingsTabs.ts`) lists six sections in order: Appearance ("Theme, accent, and text size for this kiosk."), Sound ("Scan and alert sounds."), Devices ("Scanners, printers, and readers attached to this kiosk."), This Kiosk ("This kiosk's name, identity, and connection.", `anon: true`), Admin ("Kiosk administration.", `requires: 'admin'`), and Developer ("Diagnostics and developer tools.", `requires: 'developer'`). `visibleTabs(tabs, {isAdmin, isDeveloper, signedIn})` drops a tab whose `requires` the signed-in person lacks; signed out, only tabs carrying `anon` survive, which today means This Kiosk alone — **gating is by visibility only: a hidden tab is never rendered, never shown disabled**, and it carries no trace in the DOM (no "Admin"/"Developer" text for a worker, no "Appearance"/"Sound"/"Devices"/"Admin"/"Developer" text signed out). Gating rule: Admin needs `max_rank >= ADMIN_RANK` (60, from `@portal/lib/access`); Developer needs `'developer'` in the session's `roles`. `KioskAuthContext` derives both (`isAdmin`, `isDeveloper`) from `SessionData.max_rank` / `.roles` (`0` / `[]` when anon, so both are `false` signed out); `Settings.tsx` itself reads `status` to compute `signedIn`.

The page renders a `.segmented.settings-tabs` tab strip (the same `role="tablist"` pattern as the portal's directory pills) built only from the visible tabs. The active tab lives in the `tab` search param (`useSearchParams`) so it survives a reload and can be deep-linked; an unknown or currently-hidden `tab` value (e.g. a worker hitting `?tab=admin`, or anyone signed out) falls back to the first visible tab — Appearance signed in, This Kiosk signed out. Every tab body but This Kiosk's is a placeholder for now: the tab's label as an `h2.settings-tab-title`, its blurb as `.page-hint`, and a `.kiosk-placeholder` card reading "This section is not available yet." This Kiosk instead renders `<ThisKioskPanel />` and no placeholder card.

**This Kiosk moves off /setup (2026-09-13):** the kiosk variables that used to be the whole `/setup` screen — Kiosk name (text, required), Serial (read-only mono), Mode, API URL and Portal URL (read-only, resolved values), Version, the "can't remember kiosk settings" warning, Save (→ `setKioskName` + `heartbeatNow()` if authed + inline "Kiosk name saved.") — moved verbatim into `src/components/ThisKioskPanel.tsx`, a chrome-free component (no eyebrow/title of its own) rendered as the Settings page's This Kiosk tab body. It works signed in or out, same as before; only its Back button was dropped (the Settings tabs replace it). `/setup` (`KioskSettings.tsx`, deleted) is now a placeholder like `/scan`/`/labels`/`/timeclock`: `setup` carries `placeholder: true` in `features.ts` (still `alwaysAvailable`) with blurb "Set up this kiosk for a move.", and `App.tsx` renders it as `<KioskShell><FeaturePage feature={setup} /></KioskShell>` — outside `KioskGuard` and `SetupGate` (unlike the other placeholders) so it stays reachable signed out, matching its old behavior. The kiosk-name button in `KioskShell`'s top bar and the login pane's settings gear both now open `/settings?tab=this-kiosk` instead of `/setup`.

Developer tab: the first control is a Developer mode toggle (kiosk-local, localStorage `ss.kiosk.devMode`, footer shows "Dev mode On"); what it reveals is defined per feature as they land — today it only flips the flag.

### Kiosk setup state (2026-09-13)

A global kiosk-local flag, `kiosk_setup_complete`, gates every launcher tile except Kiosk Setup and Settings until the kiosk has been set up. `src/lib/setupState.ts` mirrors `devMode.ts`'s store/hook shape: `KioskSetupState = 'incomplete' | 'complete' | 'failed'`, `SETUP_STATES` (the three values in that order), `readSetupState`/`writeSetupState`/`subscribeSetupState`/`useKioskSetupState` (localStorage key `ss.kiosk.setupState`, same try/catch idiom — a blocked or full store, or a garbage stored value, reads as `'incomplete'`), plus `isSetupComplete(state)` and `setupStateLabel(state)` ("Incomplete"/"Complete"/"Failed"). Storage is kiosk-local for now; a server-side Device field is deferred so the portal can show a kiosk's setup state too.

`KioskFeature` gained `alwaysAvailable?: boolean`, set on `setup` and `settings` — the two tiles that work no matter the state. `featureAvailable(feature, setupState, devMode = false)` (`features.ts`) is `devMode || feature.alwaysAvailable || isSetupComplete(setupState)` — **Jimmy: developer mode overrides the setup gate** ("developer mode overrides this to always allow all options"), so every tile and route is available while dev mode is on regardless of setup state. `Home` and `SetupGate` both pass `useDevMode()[0]` through.

**Greying rule (Home)**: any tile that isn't available renders as a disabled `<a>` (`kiosk-tile is-disabled`, `aria-disabled="true"`, `role="link"`, `tabIndex={-1}`, click prevented) instead of a `Link`, with a `.kiosk-tile-lock` line under its blurb ("Finish Kiosk Setup first." or, when the state is `failed`, "Kiosk setup failed — open Kiosk Setup."). Above the grid, a `.portal-banner.kiosk-setup-banner` repeats the same message at the page level ("Kiosk setup is incomplete. Only Kiosk Setup and Settings are available." / "Kiosk setup failed. Open Kiosk Setup to try again.") whenever the state isn't `complete`. When developer mode is on and the state isn't `complete`, nothing is greyed and this banner is replaced by a slimmer `.kiosk-setup-banner.is-dev` note: "Developer mode: all features are available while kiosk setup is incomplete." (or "...failed.").

**Route gate**: a new `src/components/SetupGate.tsx` wraps every placeholder feature's route element in `App.tsx` (inside `KioskGuard`, outside `KioskShell`) — it renders its children when `featureAvailable` is true and otherwise `<Navigate to="/" replace />`, so typing a feature path directly (e.g. `/scan`) while setup is incomplete or failed lands back on the launcher instead of the placeholder.

**Footer**: `KioskShell` appends a `Setup` item after `Registration` showing `setupStateLabel(state)`, colored via `--c-*` tokens through classes `.kiosk-foot-setup.is-complete` (`--c-green`), `.is-incomplete` (`--c-amber`), and `.is-failed` (`--c-red`).

**Developer-tab testing aid**: while Developer mode is on, the Developer tab (`Settings.tsx`) shows a second `.settings-row` below the Developer mode row — label "Kiosk setup state", hint "Testing aid until real setup logic sets this. Stored on this kiosk only.", and a `.segmented[role="radiogroup"]` of three `role="radio"` buttons (Incomplete/Complete/Failed) bound to `useKioskSetupState()`. It exists only so the greying and gating can be exercised on a real kiosk before any setup flow sets the flag for real.

### Styles (`src/styles/kiosk.css`)

Only kiosk-specific rules: `.kiosk-shell` (grid rows auto/1fr, `min-height:100vh`, `background: var(--paper-2)`), `.kiosk-top` (height 56 px, `background: var(--ink)`, `color: var(--snow)`, border-bottom `var(--ink-line)`), `.kiosk-mode`, `.pair-code`, `.pair-qr`, `.form-notice`, `.pane-gear`, `.eyebrow-kiosk`, `.settings-tabs`, `.settings-tab-title`. Everything else comes from the portal sheets. The kiosk never redefines a `--` token. List-typography guardrail selectors are not used (no lists in this pass).

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

Index on `(ip_address, created_at)` for the rate limit and on `(serial)` for lookups (codes for the same serial are independent — see Implementation notes).

Endpoints:

- `POST /kiosk/pair` — **unauthenticated**. Body `PairCreateIn {serial: str (1–120), name: str (1–80)}`. Rules, in order: delete rows older than 24 h (cheap opportunistic cleanup); if `count(*) where ip_address = :ip and created_at > now() - 5 min >= 30` → 429 `pair_rate_limited`; insert; return `PairCreateOut {code, poll_token, link_url, expires_at}` where `link_url = f"{settings.portal_origin.rstrip('/')}/link/{code}"`. Read-only exempt (see below).
- `POST /kiosk/pair/{code}/poll` — **unauthenticated**. Body `{poll_token}`. 404 `pair_not_found` if no row; 403 `pair_forbidden` if the token hash mismatches (constant-time compare). Then: past `expires_at` → `{status: "expired"}`; `pending`/`denied`/`claimed` → `{status}` (`claimed` reported as `expired`, a one-shot code is spent); `approved` → mint a session for `approved_by` via `start_session(audit_action="login_pair")` with the kiosk's IP and user agent, set the refresh cookie, set status `claimed`, return `PairPollOut {status: "approved", session: SessionOut}`. If `approved_by`'s account is now disabled or has no `kiosk:view` → status `denied`. Read-only exempt.
- `GET /kiosk/pair/{code}` — requires `kiosk:view`. Returns `PairInfoOut {code, kiosk_name, serial, status, expires_at}` with `status` computed (`expired` when past). 404 when unknown.
- `POST /kiosk/pair/{code}/approve` — requires `kiosk:view`. 404 unknown; 409 `pair_not_pending` unless `pending` and unexpired. Sets `approved`, `approved_by = actor.person.id`, audits `kiosk_pair_approved` (entity `kiosk_pair`, changes `{serial, kiosk_name}`). 204. Read-only exempt (it is a sign-in).
- `POST /kiosk/pair/{code}/deny` — same gate; 409 unless pending; sets `denied`; audits `kiosk_pair_denied`; 204. Read-only exempt.

`deps.READ_ONLY_EXEMPT_PREFIXES` gains `"/kiosk/pair"`; `/kiosk/heartbeat` is **not** exempt (it writes a Device row and the kiosk tolerates failure).

Security notes, recorded so the review does not re-derive them: 40-bit codes with a 5-minute life and a per-IP creation cap; the code alone cannot claim a session because the poll token is required; approve is an authenticated action gated on the approver's own kiosk permission; the phone page names the kiosk and its serial so a user is not tricked into signing in a stranger's kiosk without seeing it; the session minted at claim time is a fresh family for the kiosk, so revoking it never touches the approver's phone session.

### Heartbeat

`POST /kiosk/heartbeat` — requires `kiosk:view`. Body `HeartbeatIn {serial: str, name: str, mode: Literal["web","laptop","pi","android","ios"], version: str | None, raw_info: dict = {}, sign_in: bool = False, login_method: Literal["password","link"] | None = None}`.

- Look up `Device` by `serial` (the existing partial unique index `devices_serial_uniq` covers this). None → insert `Device(device_type="kiosk", name, serial, sub_type=mode, version, raw_info, last_seen_at=now)`. Found with `device_type != "kiosk"` → 409 `serial_conflict`. Found kiosk → update `name`, `sub_type`, `version`, `raw_info` (merged, kiosk keys win), `last_seen_at`, `updated_at`.
- Returns `HeartbeatOut {device_id, name, registration: "ok"|"soon"|"expired"|"none", token_expires_at}` using the Kiosk Devices thresholds (7 days).
- Not audited (a heartbeat is telemetry); creation is audited once (`action="self_register"`, actor = signed-in person).
- **Sign-in auto-registers the kiosk and records who's on it.** `sign_in` is true only on the one heartbeat the kiosk sends right after a person signs in (password login or a completed pairing) — never on a cookie restore, never on a periodic tick. That beat carries `login_method` ("password" or "link") and the handler stamps `device.session_person_id = actor.person.id`, `device.session_login_method = login_method`, `device.session_started_at = now` — this is what the Kiosk Devices "Signed in"/"Login" columns read. Independently, when the kiosk's registration is not `"ok"` (i.e. `"none"`, `"expired"`, or `"soon"` — within 7 days of expiring), the same beat stamps `registered_at = now` and `token_expires_at = now + 30 days` (`KIOSK_AUTO_REGISTER_DAYS`, matching the portal's Register default) and writes an audit row exactly like the portal's Register action (`action="register"`, `entity_type="device"`) but `changes` carries an extra `source: "kiosk_sign_in"` key and the actor is the signed-in kiosk user. A sign-in on a kiosk that is already `"ok"` (more than 7 days left) changes nothing about the registration and audits nothing, but still records the new session.
- **`POST /kiosk/sign-out`** — requires `kiosk:view`. Body `{serial: str}`. Finds the kiosk `Device` by serial; if found and `session_person_id` is null or equal to the caller's person, clears `session_person_id`/`session_login_method`/`session_started_at` and stamps `updated_at`. Always 204 — an unknown serial or someone else's session is not an error, since the kiosk is about to drop its own token either way. Not read-only exempt (it writes; the kiosk ignores failures — see `signOutRequest`).
- **`DeviceItem` session fields**: `session_person_id`, `session_person_name` (built the same way as `Person.display_name`, via an outer join so a kiosk with no session reads null), `session_login_method`, `session_started_at`.
- **Kiosk Devices columns**: "Signed in" (the session person's name, or "—") and "Login" (a chip: "Password" / "Phone link" / "—"), both default-on, placed after Registration. A kiosk that vanishes without signing out (crash, unplugged, closed tab) keeps showing its last signed-in user until the next sign-in — there's no server-side timeout on the session fields. Stale detection is deferred; `last_seen_at` (already on the row) is the tell that the "Signed in" name may be stale.

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
- **Retire-on-create dropped:** an unauthenticated caller who knew a kiosk's serial could keep denying its code; several live codes per serial are harmless because codes are one-shot and expire in 5 minutes.
- **Heartbeat has no serial ownership proof:** any `kiosk:view` holder can rename any kiosk by posting its serial in a heartbeat, and by the same token can also claim another kiosk's "Signed in" cell for themselves by posting its serial with `sign_in: true` (never a third party — the audit names the real, signed-in actor). Accepted for this pass — device tokens/enrollment secrets are out of scope (see "Out of scope").
- **De-register in the portal is undone by the next kiosk sign-in.** Registration is a lifecycle marker, not a gate — it doesn't block anything — so a kiosk someone de-registered in the portal re-registers itself the moment the next person signs in there; the re-registration is audited with `source: "kiosk_sign_in"` like any other auto-registration.
- **`.dockerignore` lives at the repo root** (the Docker build context for `kiosk/Dockerfile -f .. .`), not under `kiosk/`.
- **Jimmy: kiosk_setup_complete (incomplete|complete|failed) gates every tile except Kiosk Setup and Settings.**
- 2026-09-13 (Jimmy): the segmented method switch was replaced — email & password is the normal form; alternates sit behind a button below it.
- 2026-09-13 (Jimmy): "Register automatically at sign-in — first sign-in on a kiosk stamps a 30-day registration (same as clicking Register); later sign-ins renew it only when it has expired or is within 7 days of expiring. Anyone allowed to use the kiosk can do it."
- 2026-09-13 (Jimmy): Kiosk Devices shows the signed-in user and login type (migration 0062).
- 2026-09-13 (Jimmy): first features as placeholders — Scanning, Label Printing, Timeclock.
- 2026-09-13 (Jimmy): kiosk facts moved from Home cards to a footer status line.
- 2026-09-13 (Jimmy): Kiosk Setup is the first launcher tile (opens the settings screen).
- 2026-09-13 (Jimmy): Settings page with Appearance/Sound/Devices/Admin/Developer tabs; Admin and Developer hidden unless the person holds the level.
- 2026-09-13 (Jimmy): Developer tab starts with a Developer mode toggle.
- Jimmy: developer mode overrides the setup gate.
- Jimmy: kiosk variables moved from /setup to Settings › This Kiosk; /setup is a placeholder.

Live-verified 2026-09-13 against the worktree API (dev DB at 0061): email/password sign-in, heartbeat creating "Kiosk 4716 · Web" on Kiosk Devices and the chip flipping to Registered after Register from the portal, link-with-phone approve (kiosk on Home within one poll) and deny ("Sign-in was declined on the phone."), the move-password placeholder (no request), and the Docker/compose build on 8090 signing in with the same-site cookie. Not live-verified: the `kiosk_not_allowed` refusal in the UI (covered by `tests/test_auth_kiosk_login.py`), a real phone camera scanning the QR, and prod cross-subdomain cookies (`SS_COOKIE_DOMAIN`).

Fixed in the 2026-09-13 final review: the top bar's sub-900px overlap (the mode chip now hides at ≤900px and the person name at ≤600px), the unstyled Kiosk Settings page (missing `profile.css` import), rightmost-`X-Forwarded-For` validation, and the retire-on-create pairing rule (dropped, see above).
