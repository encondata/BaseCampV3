# Read-only maintenance mode + broadcast banner

**Date:** 2026-09-03
**Branch:** working branch off `main`
**Status:** Approved design

## Purpose

Make the two placeholder rows on the Settings page's Administration card
real: a **read-only maintenance mode** that freezes user-facing writes
across the portal (with an optional pause of the background workers and a
resume control), and a **broadcast banner** that shows a message to
everyone — on the login page and inside the portal.

## Background facts (as-built)

- `portal/src/pages/Settings.tsx` renders the Administration section only
  for `can('settings','change')`; both rows are disabled `Switch`es with
  "Coming soon" copy.
- `SystemConfig` (`system_config`: `section` PK, `data` JSONB,
  `updated_at`, `updated_by`) already stores the audited `logging`
  section via `GET/PUT /system/config/logging` in
  `api/src/serversherpa/api/routes/system.py` (pattern: read row, write
  `data`, `audit(... entity_type="system", entity_id=<section> ...)`).
- Every protected route depends on `get_current_user`
  (`api/src/serversherpa/api/deps.py`) which builds `AuthContext(person,
  account, roles, session, access)`; roles include `developer`.
- Workers share one loop shape (`run_forever` → heartbeat task +
  `while True: worked = await run_once(maker); if not worked: sleep`):
  `scans/worker.py` (scan-matching-worker), `imports/worker.py`
  (import-worker), `notifications/worker.py` (notification-worker,
  placeholder). Heartbeats upsert `processes` rows via
  `system/registry.py` (`start_heartbeat(name, kind)`); the Dev →
  Processes page derives status from `heartbeat_at`.
- Portal session state lives in `portal/src/auth/AuthContext.tsx`
  (`useAuth()`); the shell is `portal/src/layout/AppShell.tsx`
  (`.portal-main-col` = `<Topbar/>` + `<main>`); login is
  `portal/src/pages/Login.tsx` (form panel, `data-reveal` animations).
- `ApiError(status, code, detail)` from `errorFrom` in
  `portal/src/lib/api.ts`; pages map codes to copy locally.

## Storage

`SystemConfig` section **`admin`** (created on first write; absent row =
all defaults):

```json
{
  "read_only": false,
  "read_only_message": "",
  "pause_workers": false,
  "banner_enabled": false,
  "banner_message": ""
}
```

No migration (JSONB section, same as `logging`).

## API

### `GET /system/status` — public

No auth. Returns:

```json
{ "read_only": false, "read_only_message": "", "workers_paused": false,
  "banner": null }
```

`banner` = `banner_message` when `banner_enabled` and the message is
non-blank, else `null`. `workers_paused` = `read_only and pause_workers`.
One PK lookup; no caching layer.

### `PUT /system/admin` — gate `settings:change`

Body (all optional, `extra="forbid"`): `read_only: bool`,
`read_only_message: str` (max 300), `pause_workers: bool`,
`banner_enabled: bool`, `banner_message: str` (max 300). Merges into the
stored section; trims messages. Validation: `banner_enabled=True` with a
blank resulting `banner_message` → 422 `banner_message_required`.
Returns the full stored section (`AdminConfigOut`). Audit:
`entity_type="system"`, `entity_id="admin"`, `action="admin_config_update"`,
`changes={field: {from, to}}` for changed fields only. `GET /system/admin`
(same gate) returns the section for the Settings card.

### Write freeze (in `get_current_user`)

After building the `AuthContext`, when the request method is one of
`POST/PUT/PATCH/DELETE` **and** the `admin` section has `read_only=True`
**and** `"developer" not in roles` **and** the path is not allowlisted →
raise **423** `{"detail": {"code": "read_only_mode", "message": <read_only_message>}}`.

Allowlist (prefix match on `request.url.path`): `/auth/` (login, logout,
refresh, password change, preferences) and exactly `/system/admin` — so
any `settings:change` user who can turn the mode on can always turn it
off. The lookup runs only for mutating methods (GET/WebSocket routes pay
nothing). Login itself never uses `get_current_user`, so the login page
keeps working.

### Worker pause

New helper `serversherpa/system/admin_config.py`:

```python
async def read_admin_config(db) -> dict          # section with defaults applied
async def workers_paused(sessionmaker) -> bool   # read_only and pause_workers
```

Each of the three `run_forever` loops checks `workers_paused` at the top
of every cycle; when paused it sleeps `poll_seconds` and `continue`s
(no `run_once`). The heartbeat keeps beating; `_beat` gains an optional
`meta` so a paused worker writes `meta={"paused": true}` (cleared when it
resumes) and `system/registry.derive_status` reports **`paused`** when the
row is fresh and `meta.paused` is true — the Dev → Processes page shows
"Paused" (chip `c-amber`) instead of "Running". **Resume** = the Settings
button that sends `PUT /system/admin {pause_workers: false}`; loops pick
it up within one poll interval. The API cannot relaunch OS processes (no
supervisor) — pause/resume is the honest form of stop/restart and no
queued work is lost.

## Portal

### Public status (`portal/src/lib/systemStatus.ts` + `SystemStatusProvider`)

`getSystemStatus(): Promise<SystemStatus>` (plain `fetch`, no bearer —
via `apiUrl()`), `SystemStatusProvider` mounted in `App.tsx` above the
router (outside auth), polling every 60s, on `visibilitychange` →
visible, and on demand via `refreshSystemStatus()` (exported event bus,
same idiom as `onSessionEnded`). `useSystemStatus()` returns
`{ status, refresh }`; a failed fetch keeps the last value (quiet
catch).

### Banners (`portal/src/components/SystemBanners.tsx`)

Renders zero, one, or two slim bars, read-only first:

- Read-only: class `sys-banner sys-banner-readonly` (amber), text
  `Read-only maintenance mode — {read_only_message}` (just
  `Read-only maintenance mode` when the message is blank), role="status".
- Broadcast: class `sys-banner sys-banner-broadcast` (neutral blue),
  text = `banner`.

Placed at the top of `.portal-main-col` in `AppShell.tsx` (above
`<Topbar/>`) and at the top of the login form panel in `Login.tsx` (above
the "Sign in" title; NOT animated with `data-reveal`, so it is visible in
the browser pane too). Styles in `portal/src/styles/chrome.css`.

### Read-only rejection UX

`errorFrom` in `lib/api.ts`: when `code === 'read_only_mode'`, set the
`ApiError.message` to
`The portal is in read-only maintenance mode — changes are disabled until it's lifted.`
and call `refreshSystemStatus()` so the banner appears immediately. Pages
keep their own code maps; those rendering `err.message` get the friendly
copy for free.

### Settings card (`Settings.tsx`)

Loads `GET /system/admin` on mount (admins only). Rows:

- **Read-only maintenance mode** — `Switch` (immediate `PUT
  {read_only}`), a message `input` (placeholder "Shown to everyone in the
  banner, e.g. 'Cutover in progress until 14:00 ET'") with a `mini-btn`
  **Save** appearing when dirty; sub-row **Also pause background
  services** `Switch` (immediate `PUT {pause_workers}`, disabled while
  read-only is off); when `read_only && pause_workers`, a `mini-btn`
  **Resume workers** (`PUT {pause_workers: false}`) with hint text
  "Workers idle while paused; resume lifts the pause within a few
  seconds."
- **Broadcast banner** — `Switch` (immediate `PUT {banner_enabled}`;
  turning on with a blank message shows the inline error "Enter a message
  first." and leaves it off), message `input` + Save when dirty.

Errors from PUT show in a `set-note`-styled error line under the row.
The card's copy drops "Coming soon".

## Error handling

- Status endpoint failure → provider keeps last value; banners just don't
  update (no UI error).
- Missing `admin` section anywhere → defaults (everything off).
- 423 for mutating calls during read-only; allowlist keeps auth + the
  toggle working; developers unaffected.
- `banner_message_required` → 422 shown inline on the Settings card.

## Testing

- API: `test_system_admin_api.py` — status public + shapes; PUT gate
  (403 for `settings:view`-only), merge + trim + audit, 422 on enabling
  blank banner; read-only enforcement: non-developer POST → 423 with
  code + message, developer POST passes, GET unaffected, `/auth/*` and
  `/system/admin` allowlisted, mode off → passes; `workers_paused`
  helper; `derive_status` paused branch; one worker loop test (paused
  cycle runs no `run_once`).
- Portal: `systemStatus.test.ts` (fetch + refresh bus), `SystemBanners`
  render states, `Settings` admin card (switch PUTs, dirty Save, blank
  banner guard, Resume button visibility), `errorFrom` read-only message
  + refresh trigger, `Login` shows the banner, `AppShell` shows it above
  the topbar.
- Live: toggle read-only as admin, confirm a non-developer write gets the
  banner + friendly error and a developer write succeeds; broadcast
  banner visible on login page and in-shell; pause → Processes page shows
  Paused → Resume clears it.

## Out of scope

Scheduled banners, per-user dismiss, OS-level process restart, pausing
the log service, per-role read-only exemptions beyond `developer`.
