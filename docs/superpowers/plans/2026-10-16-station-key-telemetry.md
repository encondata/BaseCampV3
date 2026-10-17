# Reader Telemetry Under the Station Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only an RFID Station's station key can post reader telemetry. The key stops working (but is kept) while the laptop's kiosk registration has lapsed.

**Architecture:** The portal tightens `station_keys.verify` and `deps.station_device`, adds `POST /kiosk/station/heartbeat`, and makes the person heartbeat ignore `reader`. The edge stops attaching the snapshot to the person heartbeat. Its reader-report loop sends the station heartbeat, and its station requests turn a 403 `kiosk_not_registered` into one paused/resumed System Events pair.

**Tech Stack:** FastAPI + SQLAlchemy async (API, pytest on Postgres); edge FastAPI + sqlite3 (pytest).

**Spec:** `docs/superpowers/specs/2026-10-16-station-key-telemetry-design.md`

## Global Constraints

**Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/station-key-telemetry`, branch `station-key-telemetry`.

**First-time edge setup:** `cd kiosk_laptop/edge && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`.

**Git:** stage files by explicit path only, never `git add -A`, `.` or `-f`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Suites:** run everything in the FOREGROUND with a 600000 ms timeout, and never background a suite.
- API: `cd api && SS_TEST_DB=serversherpa_test_station_telemetry PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q <files>`
- Edge: `cd kiosk_laptop/edge && .venv/bin/pytest -q -p no:cacheprovider`

**Rules:**
- No portal migration.
- Edge `SCHEMA_STEPS` is append-only.
- Copy uses American English.
- The station key is never logged.

**Fixed values:**
- 403 code: `kiosk_not_registered`.
- The key passes when `registration_state` is `ok` or `soon`.
- Paused event title: `Uploads paused`. Detail: `This laptop's kiosk registration has expired. Sign in here or renew it on Kiosk Devices.`
- Resumed event title: `Uploads resumed`.
- Event kind: `station`.
- The reporter loop runs every 60 s (the existing `INTERVAL_S`).

## Review Focus

1. **A lapse must never drop the key.** A 403 `kiosk_not_registered` keeps `station_key`. Renewing on Kiosk Devices brings uploads back with no sign-in. (Tasks 1, 3.)
2. **Wrong-key callers learn nothing new.** Eligibility checks run only after the hash matches; an unknown or wrong key is still the plain 401. (Task 1.)
3. **Telemetry from the person heartbeat is ignored, not rejected.** An old edge posting `reader` on `/kiosk/heartbeat` still gets 200 and the reader row is untouched. (Task 2.)
4. **The paused event is written once per transition,** not once per minute, and not again after an edge restart. (Task 3.)
5. **A failing station heartbeat never kills the reporter loop,** including when the edge is offline. (Task 4.)

---

### Task 1: Portal — eligible-station check and 403 on lapsed registration

**Files:**
- Create: `api/src/serversherpa/services/kiosk_registration.py`. Move `REGISTRATION_SOON` and `registration_state` here from `api/src/serversherpa/api/routes/kiosk.py`; `routes/kiosk.py` imports them back, so every existing caller keeps working.
- Modify: `api/src/serversherpa/services/station_keys.py` (`verify`).
- Modify: `api/src/serversherpa/api/deps.py` (`station_device`).
- Test: `api/tests/test_kiosk_station_scans.py`, or a new `api/tests/test_station_key_eligibility.py`.

**Interfaces:**
- Produces: `registration_state(token_expires_at: datetime | None, now: datetime) -> str`, importable from `serversherpa.services.kiosk_registration`.
- Produces: `station_device` raises 403 `{"code": "kiosk_not_registered"}` for a matching key on a lapsed kiosk.

- [ ] **Step 1: Write the failing tests.** Use the fixtures that test_kiosk_station_scans.py already uses.
  - `test_key_refused_when_station_is_no_longer_rfid_laptop`: set `station_type="label"` directly on the device (no revoke). `POST /kiosk/station/scans` → 401 with code `station_key_invalid`.
  - `test_lapsed_registration_is_403_and_keeps_key`: set `token_expires_at = now - 1 day`. → 403 with code `kiosk_not_registered`; `device.station_key_hash` is still set.
  - `test_renewed_registration_restores_the_key`: after the lapse, set `token_expires_at = now + 30 days`; the same key → 200.
  - `test_wrong_key_on_lapsed_kiosk_is_plain_401`: a wrong key on a lapsed kiosk → 401 `station_key_invalid`, never 403.
  - `test_station_sync_also_403s_when_lapsed`: `GET /kiosk/station/sync/assets` → 403 `kiosk_not_registered`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
  - `verify` returns None unless `sub_type == "laptop"` and `station_type == "rfid"`, in addition to today's checks.
  - `station_device` raises the 403 after a successful verify, when `registration_state(device.token_expires_at, datetime.now(UTC))` is not in `("ok", "soon")`. Update both docstrings.
- [ ] **Step 4: Run the new tests, `test_kiosk_station_scans.py`, and every test file that imports `registration_state`, plus the kiosk heartbeat and devices tests (grep `api/tests` for `registration`). All pass.**
- [ ] **Step 5: Commit** `feat: station key needs an eligible, registered RFID laptop`.

### Task 2: Portal — `POST /kiosk/station/heartbeat`; person heartbeat ignores `reader`

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py`. Add `KioskStationHeartbeatIn(serial: str [same limits as HeartbeatIn.serial], version: str | None [same limits as HeartbeatIn.version], reader: dict[str, Any] | None = None)` and `KioskStationHeartbeatOut(registration: str, token_expires_at: datetime | None, clear_setup: uuid.UUID | None)`. Change the comment on `HeartbeatIn.reader` to say it is accepted and ignored (for older edges).
- Modify: `api/src/serversherpa/api/routes/kiosk.py`. Add the new route next to `station_ingest_scans`. Remove the `apply_reader_report` call from `heartbeat`.
- Modify: `api/src/serversherpa/api/deps.py`. No change: like `/kiosk/heartbeat` (not exempt), the route calls `enforce_read_only_config` and returns 423 during a freeze.
- Test: `api/tests/test_kiosk_station_heartbeat.py` (new). Also update the existing fixed-reader heartbeat tests (grep `api/tests` for `"reader"`) so they post through the station route. The person-route tests now assert the reader row is not created or updated.

**Interfaces:**
- Consumes: `station_device` (Task 1); `apply_reader_report(db, *, kiosk, report, actor_id)` from `services/fixed_readers.py`.
- Produces: `POST /kiosk/station/heartbeat`, which returns `KioskStationHeartbeatOut`.

- [ ] **Step 1: Write the failing tests.**
  - `test_station_heartbeat_stamps_last_seen_and_version`: 200; `last_seen_at` moves; `version` is updated. `session_*`, `token_expires_at` and `raw_info` are unchanged.
  - `test_station_heartbeat_applies_reader`: the reader with the paired serial appears as a fixed reader, same fields as the existing heartbeat test; no person actor (audit `actor_id` is None).
  - `test_station_heartbeat_bad_reader_still_200`
  - `test_station_heartbeat_needs_key`: no header → 401 `station_key_invalid`.
  - `test_station_heartbeat_lapsed_is_403`
  - `test_station_heartbeat_never_renews_registration`: the kiosk has 3 days left (`soon`); after the beat, `token_expires_at` is unchanged.
  - `test_station_heartbeat_blocked_in_read_only_mode` (423)
  - `test_person_heartbeat_ignores_reader`: `POST /kiosk/heartbeat` with a valid `reader` → 200; no reader Device row is created.
  - `test_station_heartbeat_returns_clear_setup`: the pending id is echoed while the key is valid. (The Clear Setup request itself revokes the key, so set `setup_clear_id` directly in the test.)
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement the route.** `device = await station_device(request, db, body.serial)`. Stamp `last_seen_at`/`updated_at` (and `version` when it is not None). When `body.reader` is not None, call `apply_reader_report(db, kiosk=device, report=body.reader, actor_id=None)`. Commit, then reply.
- [ ] **Step 4: Run the new file, the updated fixed-reader tests, and the kiosk heartbeat tests. All pass.**
- [ ] **Step 5: Commit** `feat: reader telemetry arrives only on the station heartbeat`.

### Task 3: Edge — 403 `kiosk_not_registered` pauses and resumes once

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/db.py`. Append one SCHEMA_STEP: `CREATE TABLE station_status (id INTEGER PRIMARY KEY CHECK (id = 1), paused TEXT)`.
- Modify: `kiosk_laptop/edge/src/edge/rfid/station_key.py` (`request_as_station`).
- Modify: `kiosk_laptop/edge/src/edge/rfid/uploader.py` (the pause branch).
- Test: `kiosk_laptop/edge/tests/test_station_key.py`, `tests/test_rfid_uploader.py`.

**Interfaces:**
- Consumes: `events.record(store, kind, title, detail)`.
- Produces:
  - `station_key.is_paused(store) -> bool`;
  - on a 403 with code `kiosk_not_registered`, `request_as_station` returns the response, keeps the key, and sets `paused = 'kiosk_not_registered'`, recording the paused event only when it was not already paused;
  - on a 200, when paused, it clears the flag and records `Uploads resumed`.

- [ ] **Step 1: Write the failing tests.**
  - `test_not_registered_403_keeps_key_and_records_one_event`: two 403s → the key is still loadable, exactly one `Uploads paused` event with the fixed detail, `is_paused` is True.
  - `test_200_after_pause_records_resumed_once`: then two 200s → one `Uploads resumed`; `is_paused` is False.
  - `test_pause_survives_restart`: the flag is in the store; a fresh `Upstream`/app over the same data dir plus another 403 → still one paused event.
  - `test_other_403_is_not_a_pause`: a 403 `move_locked` → no flag, no event.
  - `test_uploader_spends_no_attempt_on_not_registered`: the row's `attempts` is unchanged, it stays pending, and the uploader pauses `PAUSE_S`, like 423.
  - `test_schema_step_adds_station_status` (or extend the existing db schema test).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** In the uploader, treat `resp.status_code == 403 and _code(resp) == "kiosk_not_registered"` like the 401/423 branch, and update the module docstring.
- [ ] **Step 4: Run the full edge suite. It passes.**
- [ ] **Step 5: Commit** `feat(edge): a lapsed registration pauses station uploads without dropping the key`.

### Task 4: Edge — the station heartbeat carries the reader; the person heartbeat stops

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/routes/proxy.py`. `forward` no longer builds a snapshot, and `rewrite_body` loses its `reader` parameter but still pops any browser-sent `reader`.
- Modify: `kiosk_laptop/edge/src/edge/rfid/reader_report.py`. Add `async def send_station_heartbeat(state, snap: dict | None) -> None`, called from `ReaderReporter._loop` after each snapshot. Update the module docstring.
- Modify: `docs/superpowers/specs/2026-10-16-fixed-reader-report-design.md`. Change the known-limit line: telemetry now arrives only under the station key (this spec).
- Test: `kiosk_laptop/edge/tests/test_reader_report.py` (replace the "rides the heartbeat" section), `tests/test_proxy.py`.

**Interfaces:**
- Consumes: `station_key.request_as_station(upstream, "POST", "/kiosk/station/heartbeat", json=...)`, `current_snapshot`, `state.identity.serial`, and the edge version (use whatever the person heartbeat path already sends, e.g. the setting `rewrite_body` or the identity uses; grep for `version`).
- Produces: a `POST /kiosk/station/heartbeat` with body `{"serial", "version", "reader"?}` every loop, only when a key is stored. `reader` is included only when `current_snapshot` returns one.

- [ ] **Step 1: Write the failing tests.**
  - `test_person_heartbeat_never_carries_reader`: a fresh snapshot exists; a proxied `/kiosk/heartbeat` body has no `reader`, and a browser-sent `reader` is stripped.
  - `test_station_heartbeat_sent_with_key_and_snapshot`: the fake cloud records the request; `Authorization: Station …`; the body has serial, version and reader.
  - `test_station_heartbeat_without_snapshot_omits_reader`
  - `test_no_station_heartbeat_without_key`
  - `test_station_heartbeat_sent_with_nobody_signed_in`
  - `test_loop_survives_offline_and_errors`: `CloudOffline`, then an exception, then success → the loop is still running.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full edge suite and `npm --prefix kiosk test -- --run`. Both pass.**
- [ ] **Step 5: Commit** `feat(edge): the reader snapshot rides the station heartbeat`.
