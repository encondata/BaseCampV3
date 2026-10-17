# Reader telemetry under the station key — design

Date: 2026-10-16. Follows `2026-10-16-rfid-scan-processing-design.md` (station
key) and `2026-10-16-fixed-reader-report-design.md` (reader on Fixed Readers).

## 1. Why

The RFID Station's reader snapshot rides the person heartbeat
(`POST /kiosk/heartbeat`). That route finds the kiosk by the serial in the
body, so any `kiosk:view` session can post reader telemetry for any kiosk's
paired reader. It also means the reader goes Offline whenever nobody is
signed in at the station. The station key now exists, so it should be the
only authority for reader telemetry.

The push security review of the station key also asked for the key to stop
working once the laptop is no longer an eligible station.

## 2. Decisions (Jimmy, 2026-10-16)

- Reader telemetry is accepted **only** under the station key.
- The key stops working while the laptop's **kiosk registration** has lapsed
  (the existing 30-day window that renews when someone signs in at the kiosk,
  or when an admin registers or renews it on Kiosk Devices). The key is **kept**
  during a lapse, so a renewal on Kiosk Devices brings uploads back with no one
  at the station.
- The key belongs to the station, not to its issuer: losing the issuer's
  access does **not** revoke it. Revocation stays on the device (de-register,
  Clear Setup, Label setup).

## 3. Portal

1. **`station_keys.verify`** also requires `sub_type == "laptop"` and
   `station_type == "rfid"`. Anything else is the existing 401
   `station_key_invalid` (the edge drops the key).
2. **`deps.station_device`**, after a key matches: when
   `registration_state(token_expires_at, now)` is not `ok` or `soon`, it raises
   **403 `kiosk_not_registered`**. The key is not revoked. Every station route
   gets this, because they all go through `station_device`.
   `registration_state` and `REGISTRATION_SOON` move out of `routes/kiosk.py`
   into a service module so `deps` can use them; `routes/kiosk.py` re-imports
   them.
3. **New `POST /kiosk/station/heartbeat`** (station key, no person session).
   Body: `serial`, optional `version`, optional `reader` (same loose dict as
   today). It stamps `last_seen_at` (and `version` when sent), then applies the
   reader through `apply_reader_report(..., actor_id=None)`. It never renews
   registration, never touches session fields or `raw_info`, and never fails
   because of a bad reader. Read-only mode is treated the same way as on
   `/kiosk/heartbeat`. Reply: `registration`, `token_expires_at`, `clear_setup`.
4. **`POST /kiosk/heartbeat`** still accepts a `reader` field so older edges
   don't get a 422, but ignores it.

## 4. Edge

1. The proxy no longer attaches the snapshot to the person heartbeat. It
   still strips any `reader` the browser sends.
2. `ReaderReporter`'s 60 s loop, after building the snapshot: when a station
   key is stored, it sends `POST /kiosk/station/heartbeat` with the edge's
   serial, version and the snapshot (omitted when there is none) through
   `station_key.request_as_station`. It does this even when nobody is signed
   in. `CloudOffline` or any error is logged and never stops the loop.
3. `request_as_station` treats **403 `kiosk_not_registered`** as "paused".
   It keeps the key and records one System Events entry on the transition
   ("Uploads paused: this laptop's kiosk registration has expired. Sign in
   here or renew it on Kiosk Devices."). It records one "Uploads resumed"
   entry on the next 200 from any station route. The flag lives in the edge
   store, so a restart doesn't repeat the entry.
4. The uploader treats that 403 like 401 and 423: no attempt is spent, and it
   pauses for 60 s.

## 5. Not in scope

- A device-held secret to bind key issuance to the laptop itself. Issuance
  still trusts the kiosk's signed-in person; a caller who can do that can
  already post scans for that move under their own session.
- Any new dashboard widget. The System Events panel carries the paused and
  resumed states.

## 6. Docs

Update the fixed-reader-report spec's known-limit line: telemetry is now
station-key only.
