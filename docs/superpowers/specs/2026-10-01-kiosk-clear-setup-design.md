# Kiosk "Clear Setup" — design

Date: 2026-10-01. Branch `kiosk-clear-setup`. Approved by Jimmy in chat.

## Goal

An admin picks **Clear Setup** on a kiosk's row in `/hardware/kiosks`. On that
kiosk's next signed-in check-in (heartbeat), the kiosk drops its Kiosk Setup
(move, site, checkpoint), marks setup incomplete, and sends whoever is signed in
to Kiosk Setup — exactly as if the kiosk had never been set up.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| Which apps obey it | Web kiosk and the native Android app now. The iOS app (branch `ios-kiosk`, another session) and the laptop edge follow the heartbeat contract below as follow-ups. |
| "Next check-in" | The next **signed-in** heartbeat (every 60 s while someone is signed in). A signed-out kiosk clears the moment the next person signs in — the sign-in heartbeat carries it. No unauthenticated endpoint. |
| What the person sees | Stays signed in, lands on Kiosk Setup with a banner: "An administrator cleared this kiosk's setup. Run Kiosk Setup to continue." Other tiles grey out until setup completes. Queued offline scans and cached move data are kept. |
| Portal while pending | Amber "Setup clear pending" chip on the row (hover: who and when). Actions shows **Cancel clear setup** instead of **Clear Setup**. |
| Delivery | A pending request on the Device row, repeated on every heartbeat reply until the kiosk acknowledges its id on a later heartbeat. |

## Server

### Migration 0086 (`down_revision = "0085"`)

Three nullable columns on `devices`:

- `setup_clear_id UUID NULL`
- `setup_clear_requested_at TIMESTAMPTZ NULL`
- `setup_clear_requested_by UUID NULL REFERENCES people(id) ON DELETE SET NULL`

All three NULL = nothing pending. No index (looked up per device row).

### Portal endpoints (kiosk rows only)

Permission: `scanning_hardware` `change` — the same as Edit/Register/De-Register.

- `POST /devices/{id}/clear-setup` → `DeviceItem`. 404 `device_not_found`;
  409 `not_a_kiosk` when `device_type != "kiosk"`. Sets a **fresh**
  `setup_clear_id = uuid4()`, `requested_at = now`, `requested_by = actor`.
  Re-requesting while one is pending replaces the id (an old acknowledgment can
  then never close the new request). Audit `clear_setup_requested`
  `{"request_id": …}`.
- `POST /devices/{id}/clear-setup/cancel` → `DeviceItem`. Same 404/409. Clears
  the three columns. Audit `clear_setup_cancelled` `{"request_id": …}` only when
  one was pending (cancelling nothing is a no-op 200, no audit).

### Heartbeat contract (`POST /kiosk/heartbeat`)

- **Request** gains optional `setup_cleared: UUID | null` — the id the kiosk
  has just applied.
- **Reply** (`HeartbeatOut`) gains `clear_setup: UUID | null` — the pending id,
  or null.
- Order inside one beat: after the device upsert, if `setup_cleared` equals the
  device's `setup_clear_id`, clear the three columns and audit `setup_cleared`
  `{"request_id": …, "requested_by": …}` (actor = the signed-in kiosk person).
  A stale/unknown id is ignored. The reply is built after this, so the beat that
  acknowledges gets `clear_setup: null`.
- A brand-new device (first beat creates the row) never has a pending request.
- Older clients that never send `setup_cleared` keep getting `clear_setup`
  every beat — harmless; the chip stays pending and the admin can cancel.

### Device list

`DeviceItem` gains `setup_clear_requested_at: datetime | null` and
`setup_clear_requested_by_name: str | null` (joined from `people`, same
preferred/first + last rule as `session_person_name`). The id itself is not
exposed to the portal.

## Portal (`/hardware/kiosks`)

- Row Actions (only with `scanning_hardware` change):
  - nothing pending → **Clear Setup** (after Edit). `window.confirm`:
    "Clear Setup on "<name>"? The next time it checks in, its move, site and
    checkpoint are cleared and whoever is signed in is sent to Kiosk Setup.
    Queued scans are kept."
  - pending → **Cancel clear setup** (no confirm).
- Pending chip next to the kiosk name in the Name cell: `chip c-amber`
  "Setup clear pending", `title` = "Requested by <name>, <local date time>"
  (name omitted when null).
- After either action the list reloads (same as Register/De-Register). No
  live polling — the existing reload picks up the acknowledgment.
- Errors use the page's existing error notice pattern; `not_a_kiosk` → "Only
  kiosks can have their setup cleared."

## Web kiosk (`kiosk/`)

- `heartbeatRequest` sends `setup_cleared` when set; `HeartbeatResult` gains
  `clear_setup: string | null`.
- `startHeartbeat` gains an `onClearSetup(id)` hook. When a reply carries a
  `clear_setup` id not yet applied this session:
  1. `clearKioskSetup()` and `writeSetupState('incomplete')`;
  2. persist `ss.kiosk.setupClear` = `{"id", "acked": false, "notice": true}`
     (localStorage, try/catch) so a reload doesn't re-apply it and the ack
     survives a reload;
  3. beat again immediately (that beat carries the ack);
  4. call `onClearSetup(id)`.
  Every beat sends `setup_cleared` while `acked` is false; `acked` flips once a
  reply returns `clear_setup` ≠ that id (null or a newer id). A newer id is
  applied normally.
- `KioskAuthContext` exposes `setupClearedSignal` (increments per applied
  clear); `KioskShell` (inside the router) navigates to `/setup` on a new signal.
- Kiosk Setup page shows the banner "An administrator cleared this kiosk's
  setup. Run Kiosk Setup to continue." while `notice` is true; completing setup
  sets `notice` false.
- Not touched: outbox / offline scan queue, IndexedDB move caches, sign-in.

## Android app (`Android_Kiosk_App/`)

- `HeartbeatIn` gains `setup_cleared: String? = null` (`explicitNulls = false`
  omits it when null); `HeartbeatResult` gains `clear_setup: String? = null`
  (`ignoreUnknownKeys` already makes older builds safe).
- `Heartbeat` mirrors the web flow: on a new `clear_setup` id →
  clear the setup and store the same `ss.kiosk.setupClear` record in one
  DataStore write, beat again (carrying the ack), emit the id on a
  `SharedFlow<String>` (`setupCleared`).
- `KioskApp` collects `setupCleared` → navigate to `Routes.SETUP`; the Setup
  screen shows the same banner text until setup completes.

## Tests

- API: request / re-request (new id) / cancel / cancel-nothing / 404 /
  409 non-kiosk / permission (view-only 403); heartbeat returns the id; matching
  ack clears + audits + reply null; stale ack ignored; ack after cancel ignored;
  device list exposes requested_at + requester name.
- Portal: menu shows Clear Setup vs Cancel; confirm text; chip + title; row
  replaced from the response.
- Web kiosk: heartbeat applies once, acks on the next beat, drops the ack once
  the server stops asking, applies a newer id, survives reload (no re-apply);
  context navigates to /setup; banner shows on Setup.
- Android: `HeartbeatTest` cases mirroring the web heartbeat tests.
- Live end-to-end needs a signed-in kiosk — Jimmy's step.

## Follow-ups (out of scope here)

- iOS app: implement the heartbeat contract above (message the iOS session).
- Laptop edge: confirm `proxy.py` passes `setup_cleared` / `clear_setup`
  through unchanged (it mutates the request dict in place and passes the reply
  body, so it should — verify on a laptop install).
