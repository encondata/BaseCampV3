# RFID Scan Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The laptop matches raw RFID reads to the move's data (plus a client-wide asset list for off-move sightings), queues them in `pending_rfid_scans`, and uploads them in batches of ≤ 50 to the portal under a per-device station key, with Jimmy's retry rules; the portal stores them as the kiosk's scans and flags off-move sightings without changing status.

**Architecture:**
- **Portal (FastAPI/Postgres, `api/`):** migration 0098 adds the station key and the off-move flag. New routes: `POST /kiosk/station-key`, `POST /kiosk/station/scans`, the station sync routes and `GET /kiosk/sync/client-assets`. The scan worker skips status for off-move scans.
- **Laptop edge (FastAPI/SQLite, `kiosk_laptop/edge`):** gains a processor and an uploader in the background loop, encrypted station-key storage, and a syncer fallback.
- **Kiosk UI:** gets one Confirm-step check.
- **Portal UI:** gets an Off move chip and filter.

**Tech Stack:** Python 3.12/3.13, FastAPI, SQLAlchemy async, Alembic, Postgres; sqlite3; React 18 + TS + vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-rfid-scan-processing-design.md`. Read it; every value below comes from it.

## Global Constraints

**Where to work:**
- Worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/rfid-processing`, branch `rfid-processing`.
- First-time setup in this worktree:
  - `cd kiosk_laptop/edge && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'` (needs Python 3.12 or later);
  - `npm --prefix kiosk ci && npm --prefix portal ci`.

**Git rules:**
- Stage files **by explicit path only**. Never use `git add -A`, `git add .` or `git add -f`.
- Commit messages end with a `Co-Authored-By:` line naming your model.

**Suites** (all in the FOREGROUND with a 600000 ms timeout; never run two API test processes at once, they share one test DB):

| Area | Command |
|---|---|
| API | `cd api && SS_TEST_DB=serversherpa_test_rfid_processing PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q <files>` |
| Edge | `cd kiosk_laptop/edge && .venv/bin/pytest -q` |
| Kiosk | `npm --prefix kiosk test -- --run` and `npm --prefix kiosk run build` |
| Portal | `npm --prefix portal test -- --run <files>` and `npm --prefix portal run build` |

- **API test DB:** the harness creates `serversherpa_test_rfid_processing` if it's missing. Read `api/tests/conftest.py`.
- **Full API suite:** run it only in Task 4. It takes about 17+ minutes, so split it by directory into foreground chunks of 600 s or less.

**Migrations:**
- The new migration is **`0098_rfid_station_key.py`**, `revision = "0098"`, `down_revision = "0097"`. 0098 is free in every worktree and on the dev DB, which is at 0097.
- Edge `SCHEMA_STEPS` is append-only.

**Copy:** American English.

**Secrets:**
- The station key is never logged, never in an edge response, and stored on the laptop only encrypted with `edge.key`.
- The portal stores only its sha256 and compares in constant time.

**Fixed values (spec):**
- Batch size: **50**.
- Retry gaps (by attempt): **30, 60, 120, 300, 600 s**, then **1800 s**.
- Internet probe: `GET /system/status` must return 200. It runs before each 30-min retry, and every **30 s** while `waiting_for_internet`.
- Processor: every **2 s**, **500** rows per pass. Uploader: every **5 s**.
- Inactive moves: `HISTORICAL_INITIATIVE_STATUSES` (completed, cancelled) or archived.
- Edge cache keys follow `edge/sync.py` `sync_paths`. Normalize tags with `tagreads.normalize_epc`.

## Review Focus

1. **The internet drops mid-batch and comes back.** The batch is retried with the same `client_scan_id`s and the portal stores nothing twice. (Task 2 `test_station_scans_idempotent`; Task 7 `test_resend_after_timeout_is_idempotent`.)
2. **A station runs with nobody signed in for days.** Sync uses the station key, and uploads continue. (Task 5 `test_sync_falls_back_to_station_key`; Task 7 `test_uploads_with_no_person_session`.)
3. **The laptop is re-set-up for move B with move-A scans still queued.** They still upload while A is active and are rejected `move_inactive` once A is completed. (Task 2 `test_earlier_active_move_accepted_completed_rejected`.)
4. **An asset from another client of the same portal.** It never appears in the client asset list. (Task 3 `test_client_assets_only_the_moves_client`.)
5. **A Clear Setup or de-register on an unattended laptop.** Uploads stop on the next batch, and the laptop drops its key. (Task 1 `test_clear_setup_request_revokes_key`; Task 7 `test_clear_setup_in_reply_drops_key`.)

---

### Task 1: Portal — migration 0098, station key issue and revocation

**Files:**
- Create: `api/migrations/versions/0098_rfid_station_key.py`
- Modify: `api/src/serversherpa/db/models.py`: Device columns, a `DeviceStationMove` model, and `RawScan.off_move` / `ProcessedScan.off_move`.
- Modify: `api/src/serversherpa/api/routes/kiosk.py`: `POST /kiosk/station-key`; the Label setup revocation inside `POST /kiosk/setup`.
- Modify: `api/src/serversherpa/api/routes/devices.py`: revoke on deregister and on the Clear Setup request.
- Create: `api/src/serversherpa/services/station_keys.py`
- Test: `api/tests/test_kiosk_station_key.py` (new)

**Migration:**
- `devices` gets `station_key_hash text NULL UNIQUE`, `station_key_issued_at timestamptz NULL`, `station_key_issued_by uuid NULL REFERENCES people(id)`, and `station_key_issued_via text NULL`.
- `device_station_moves (device_id uuid REFERENCES devices(id) ON DELETE CASCADE, initiative_id uuid REFERENCES initiatives(id) ON DELETE CASCADE, first_issued_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (device_id, initiative_id))`.
- `raw_scans.off_move` and `processed_scans.off_move` are `boolean NOT NULL DEFAULT false`.
- Downgrade drops them all.
- Bump the head assertion in any migration test that pins the head (grep `api/tests` for `"0097"`).

**`services/station_keys.py`:**
- `issue(db, device, *, actor_id, via) -> str`:
  - make a raw key with `secrets.token_urlsafe(32)`;
  - store `sha256(key).hexdigest()`;
  - upsert `DeviceStationMove(device.id, device.current_initiative_id)` when it isn't null;
  - audit `station_key_issue` with `{"initiative_id", "via"}`;
  - return the raw key.
- `revoke(db, device, *, actor_id, reason: str) -> bool`: clears the hash and issued fields (moves are kept), audits `station_key_revoke` with `{"reason"}`, and returns whether a key existed.
- `verify(db, serial, raw_key) -> Device | None`: hash the key, then `hmac.compare_digest` against the device's hash (look the device up by serial first). Return None for no device, a non-kiosk device, or no hash.

**Route `POST /kiosk/station-key`:**
- Body `{serial}`. Requires `kiosk:view`.
- Device not found: 404 `device_not_found`.
- `via` = `"move_password"` when `actor.session.initiative_id` is set, otherwise the session's login method (read how `/kiosk/heartbeat` records `login_method`). Default `"password"`.
- A move-password session whose locked move differs from `device.current_initiative_id` gets 403 `move_locked`.
- Answer: `{"key": raw}`.

**Revocation hooks:**

| Where | Reason |
|---|---|
| `devices.py` deregister | `"deregistered"` |
| `devices.py` Clear Setup request (where `setup_clear_requested_at` is set) | `"clear_setup"` |
| `kiosk.py` `POST /kiosk/setup` with `station_type == "label"` | `"label_station"` |

**Tests in `test_kiosk_station_key.py`:**
- `test_issue_by_password_session_returns_key_and_stores_hash`: the raw key isn't in the DB, `len(hash) == 64`, and the moves table has the current move.
- `test_issue_by_move_password_session_scoped_to_its_move`: `via == "move_password"`. When the device is set up for another move, the answer is 403 `move_locked`.
- `test_reissue_replaces_hash_and_keeps_moves`: two moves end up in `device_station_moves`.
- `test_verify_constant_time_and_unknowns`: the right key returns the device; a wrong key, an unknown serial and a revoked key return None.
- `test_deregister_revokes_key`, `test_clear_setup_request_revokes_key` and `test_label_setup_revokes_key`, each with an audit row carrying its reason.
- `test_audit_rows_never_contain_the_key`.

- [ ] Write the tests; run them; they fail.
- [ ] Implement the migration, models, service and routes.
- [ ] Run the new test file plus `tests/test_kiosk_setup_api.py tests/test_kiosk_station_setup.py` plus the device/deregister and clear-setup test files (grep `deregister` and `clear` in `api/tests`) plus the migration head test; all pass.
- [ ] Commit: `feat(api): kiosk station keys (migration 0098) — issue at RFID setup, revoke on de-register / Clear Setup / Label setup`

---

### Task 2: Portal — `POST /kiosk/station/scans` and off-move storage

**Files:**
- Modify: `api/src/serversherpa/api/routes/kiosk.py`: extract the body of `ingest_scans` into `_store_scan_batch(...)`, used by both routes.
- Modify: `api/src/serversherpa/api/schemas.py`:
  - `KioskScanIn.off_move: bool = False`;
  - `KioskStationScanBatchIn` (same as `KioskScanBatchIn` but `max_length=50`);
  - `KioskStationScanBatchOut(KioskScanBatchOut)` plus `clear_setup: uuid.UUID | None`;
  - `KioskScanRejected.code` gains `"move_inactive"`.
- Modify: `api/src/serversherpa/api/deps.py` (or a new `api/station_auth.py`): `station_device` dependency.
- Test: `api/tests/test_kiosk_station_scans.py` (new)

**Interfaces:**
- **Consumes (Task 1):** `station_keys.verify` and `DeviceStationMove`.
- **Produces `station_device(request, db) -> Device`:**
  - reads `Authorization: Station <key>` and the body's `serial`, or the `serial` query param for GET routes;
  - a bad or missing key gets 401 `station_key_invalid`;
  - a device whose hash was cleared after a key had been issued (an audit `station_key_revoke` exists for it) gets 401 `station_key_revoked`. Simpler alternative: return `station_key_invalid` for both. Pick one and test it.

**`_store_scan_batch(db, device, scans, *, operator_id: uuid.UUID | None, allowed_moves: set[uuid.UUID] | None, locked: uuid.UUID | None, inactive_moves: set[uuid.UUID]) -> KioskScanBatchOut`:**
- Keeps every existing behavior of `ingest_scans`: per-row codes, idempotency on `client_scan_id`, read-only 423, and the field mapping.
- Writes `off_move` onto `raw_scans`.
- The station route passes `operator_id=None`, `allowed_moves` = the device's `device_station_moves`, and `inactive_moves` = those whose initiative is historical or archived.
- **Per scan,** using the scan's `initiative_id`, or else `device.current_initiative_id`:
  - not in `allowed_moves`: `move_locked`;
  - in `inactive_moves`: `move_inactive`.
- **Existing route:** `/kiosk/scans` behavior is unchanged. Its existing tests must still pass.

**Route `POST /kiosk/station/scans`:**
- Depends on `station_device`; it needs no person session or permission.
- `device_id` = the device's name, and source `"kiosk"`.
- It stamps `device.last_seen_at`.
- Reply: `clear_setup` = the device's pending Clear Setup id (the same field and logic `/kiosk/heartbeat` uses), or null.
- More than 50 scans gets a 422.

**Tests in `test_kiosk_station_scans.py`:**
- `test_station_scans_store_kiosk_name_and_no_operator`: `raw_scans.device_id == device.name`, `operator_id is None`, `scan_type == "rfid"`.
- `test_station_scans_idempotent`: posting the same `client_scan_id` twice gives both accepted and one row.
- `test_earlier_active_move_accepted_completed_rejected`:
  - issue the key for move A, then re-setup for B and re-issue;
  - an A scan is accepted;
  - after A's status is set to `completed`, an A scan is rejected with `move_inactive`;
  - a scan for move C (never set up) is rejected with `move_locked`.
- `test_bad_missing_revoked_key_401`.
- `test_more_than_50_is_422`.
- `test_off_move_flag_stored`.
- `test_reply_carries_clear_setup`.
- `test_person_scans_route_unchanged`: one existing-style call to `/kiosk/scans` still sets the operator to the person.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run the new file plus `tests/test_kiosk_scans_api.py tests/test_kiosk_session_scope.py`; all pass.
- [ ] Commit: `feat(api): POST /kiosk/station/scans — kiosk-attributed RFID scans under the station key`

---

### Task 3: Portal — client asset list, station sync routes, worker off-move rule

**Files:**
- Modify: `api/src/serversherpa/api/routes/kiosk.py`:
  - `GET /kiosk/sync/client-assets?initiative_id=` (person, `kiosk:view`, the same move-lock rule as the other sync routes);
  - `GET /kiosk/station/sync/{assets|containers|people|client-assets}` (`station_device`, `?serial=&initiative_id=`, which must equal `device.current_initiative_id` or the answer is 403 `move_locked`).
  - Reuse the existing sync functions. Factor out the bodies so person and station routes share them.
- Modify: `api/src/serversherpa/api/schemas.py`: `KioskClientAssetOut {id, asset_id, name, rfid, serial_number, initiative_id, initiative_name}` and `KioskClientAssetsSyncOut {initiative_id, client_id, generated_at, assets: list[KioskClientAssetOut]}`.
- Modify: `api/src/serversherpa/scans/worker.py`: copy `off_move` onto the processed scan; for an off-move scan, **skip** applying the checkpoint status and running status rules, but still store the processed scan.
- Test: `api/tests/test_kiosk_client_assets.py` (new), plus additions to the scans worker tests (find them with `grep -ln run_once api/tests`).

**Client asset list:**
- Every asset on any initiative whose `client_id` equals the move's `client_id`, **excluding** assets on the move itself, plus the initiative's id and name.
- A move with no client gives `[]`.
- An asset on several other moves appears once per move (one row per pair).
- Order by `asset_id`, then initiative name.

**Tests:**
- `test_client_assets_only_the_moves_client`: assets of client X's other move appear; client Y's assets and the selected move's assets don't.
- `test_client_assets_no_client_is_empty`.
- `test_client_assets_move_password_scope`: a session locked to another move gets 403.
- `test_station_sync_current_move_only` (also check that a station sync for another move is 403), and `test_station_sync_needs_key`.
- `test_worker_off_move_scan_is_a_sighting`:
  - an off-move rfid scan for an asset produces a processed scan with `off_move == True`;
  - the asset's status is unchanged;
  - no status rule runs (assert through the existing rule-engine test hooks used by the worker tests);
  - a normal scan still changes status.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run the new and touched test files plus `tests/test_kiosk_sync_api.py`; all pass.
- [ ] Commit: `feat(api): client asset list, station sync routes, off-move scans are sightings`

---

### Task 4: Portal UI — Off move in scan history; full API suite

**Files:**
- Modify: the processed scans list API in `api/src/serversherpa/api/routes/scans.py`: return `off_move`, and accept an `off_move=true` filter param, following that route's existing filter pattern.
- Modify: `portal/src/components/scans/ProcessedScansTab.tsx` and any other list that renders processed scans (grep `ProcessedScan` in `portal/src`): an `Off move` chip using the existing chip classes (`chip c-amber` or the nearest existing warning chip), plus an "Off move" filter option using the list's existing filter idiom.
- Tests: the API route test file for scans, `ProcessedScansTab.test.tsx` or the nearest existing test.

**Tests:**
- The API returns `off_move` and filters by it.
- The portal shows the chip on a flagged row only, and the filter narrows the list to flagged rows.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run the touched portal tests, `npm --prefix portal run build`, and the **full API suite** in foreground chunks; all pass.
- [ ] Commit: `feat(portal): Off move chip and filter in scan history`

---

### Task 5: Edge — station key storage, issue and retry, syncer, Confirm check

**Files:**
- Create: `kiosk_laptop/edge/src/edge/rfid/station_key.py`
- Modify: `kiosk_laptop/edge/src/edge/db.py`: an appended SCHEMA_STEP with `station_key (id INTEGER PRIMARY KEY CHECK (id = 1), key_enc TEXT NOT NULL, stored_at TEXT NOT NULL)`.
- Modify: `kiosk_laptop/edge/src/edge/routes/kiosk.py`: after a successful RFID `/kiosk/setup`, call `station_key.issue(...)`. On a Label setup, `station_key.clear(store)`.
- Modify: `kiosk_laptop/edge/src/edge/routes/proxy.py`: when the heartbeat reply has `clear_setup`, also `station_key.clear(store)`.
- Modify: `kiosk_laptop/edge/src/edge/routes/edge.py`: Wipe clears `station_key`.
- Modify: `kiosk_laptop/edge/src/edge/sync.py`:
  - add `/kiosk/sync/client-assets?initiative_id=` to `sync_paths`;
  - when `_actor()` finds no usable person session, fetch the same paths through `station_key.get_json(...)` from `/kiosk/station/sync/<name>?serial=&initiative_id=`, and store them under the **same cache keys** as the person paths.
- Modify: `kiosk_laptop/edge/src/edge/background.py`: retry a missing key each minute while a person session is online and the setup is RFID.
- Modify: `kiosk_laptop/edge/src/edge/rfid/checks.py`: a new check name `uploads`, ok when a key is stored; fail detail "Uploads aren't authorized yet — try again". It triggers one issue attempt when a person session exists.
- Modify: the kiosk `kiosk/src/lib/api.ts` `CheckName` (add `'uploads'`), and `kiosk/src/components/setup/ConfirmStep.tsx`: a fourth row `{ name: 'uploads', label: 'Scan uploads ready' }`. Start Reader stays gated on all rows.
- Tests:
  - `kiosk_laptop/edge/tests/test_station_key.py` (new);
  - additions in `test_sync.py`, `test_rfid_checks.py`, `test_proxy.py` and `test_edge_routes.py`;
  - `kiosk/src/components/setup/ConfirmStep.test.tsx`.

**Interfaces (`station_key.py`):**
- `store_key(store, keys, raw: str) -> None`
- `load_key(store, keys) -> str | None`
- `clear(store) -> None`
- `async issue(st, person_id: str) -> bool` calls `upstream.as_person(person_id, "POST", "/kiosk/station-key", json={"serial": identity.serial})` and stores the key on 200. It never raises; failures are logged by status only.
- `async station_request(st, method, path, **kw) -> httpx.Response | None` adds `Authorization: Station <key>`, and returns None when there's no key. Task 7 uses it.

**Tests:**
- `test_key_stored_encrypted`: the raw key is not in `station_key.key_enc`, and `load_key` round-trips.
- `test_rfid_setup_issues_key` (`respx` mock of `/kiosk/station-key`) and `test_label_setup_clears_key`.
- `test_issue_failure_retried_by_background`.
- `test_key_never_logged`.
- `test_sync_falls_back_to_station_key`: no person sessions plus a stored key means the station sync routes are called, and the cache holds the same keys.
- `test_client_assets_cached`.
- `test_heartbeat_clear_setup_clears_key`.
- `test_wipe_clears_key`.
- `test_uploads_check`.
- Kiosk: ConfirmStep shows four rows, and Start Reader stays disabled until `uploads` is ok.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run the edge suite, the kiosk tests and the kiosk build; all pass.
- [ ] Commit: `feat(edge): station key — issued at RFID setup, encrypted, retried; station-key sync fallback; Scan uploads ready check`

---

### Task 6: Edge — processor and `pending_rfid_scans`

**Files:**
- Create: `kiosk_laptop/edge/src/edge/rfid/processing.py`
- Modify: `kiosk_laptop/edge/src/edge/db.py`: an appended SCHEMA_STEP with `pending_rfid_scans` (all columns in spec §2.3; `raw_read_id INTEGER NOT NULL UNIQUE`, `client_scan_id TEXT NOT NULL UNIQUE`, an index on `(upload_state, next_attempt_at)`) and `rfid_processing_meta (id INTEGER PRIMARY KEY CHECK (id = 1), last_raw_id INTEGER NOT NULL)`.
- Modify: `kiosk_laptop/edge/src/edge/background.py`: run `processing.run_once` every 2 s.
- Modify: `kiosk_laptop/edge/src/edge/rfid/ingest.py`: wake the processor after a stored batch (an `asyncio.Event` on `app.state`, set by ingest and awaited with a timeout by the loop).
- Modify: `kiosk_laptop/edge/src/edge/routes/edge.py`:
  - Wipe clears `pending_rfid_scans` and sets the cursor to `(SELECT COALESCE(MAX(id), 0) FROM raw_tag_reads)` after the raw tables are cleared;
  - the Wipe guard counts `pending_rfid_scans` rows with `upload_state = 'pending'` together with the outbox.
- Test: `kiosk_laptop/edge/tests/test_rfid_processing.py` (new), plus Wipe additions.

**Interfaces:**
- `run_once(store) -> int` returns the number of pending scans inserted.
- It reads `laptop_setup.load(store)["initiative_id"]` for the current setup move.
- Indexes come from the cache bodies for `/kiosk/sync/assets`, `/containers` and `/client-assets` (keyed by the move) and `/kiosk/sync/people`, memoized on `(cache key, stored_at, tagreads cache-write counter)`.
- Match order and `off_move` follow spec §2.2. The `off_move_initiative_*` fields come from the client-asset row.

**Tests:**
- `test_matches_asset_container_person_in_order`: when the same tag is on a container and a person, the container wins.
- `test_off_move_asset_from_client_list`: `off_move = 1`, with the move name recorded.
- `test_unmatched_read_skipped_cursor_advances`.
- `test_read_without_move_and_old_move_skipped`.
- `test_waits_for_missing_current_move_cache_then_resumes`.
- `test_cursor_survives_restart`.
- `test_scanned_at_is_received_at`.
- `test_500_row_pass_limit`.
- `test_wipe_resets_cursor_and_clears_pending`.
- `test_wipe_guard_counts_pending_rfid_scans`.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run the edge suite; all pass.
- [ ] Commit: `feat(edge): match raw tag reads into pending_rfid_scans (move data + client list, off-move)`

---

### Task 7: Edge — uploader with retries and the internet gate

**Files:**
- Create: `kiosk_laptop/edge/src/edge/rfid/uploader.py`
- Modify: `kiosk_laptop/edge/src/edge/background.py`: run the uploader every 5 s, and wake it after the processor inserts.
- Modify: `kiosk_laptop/edge/src/edge/routes/edge.py`: `/edge/status` gains `rfid_uploads {pending, waiting_for_internet, accepted, rejected}`.
- Test: `kiosk_laptop/edge/tests/test_rfid_uploader.py` (new)

**Interfaces:** `class Uploader(store, st, *, clock=time.time, probe=None)`, where `probe` defaults to `upstream.probe`. Its methods:
- `async drain_once() -> int` sends at most one batch and returns the number sent.
- `due_rows(limit=50)`.

**Behavior** (spec §4):
- **Lock:** an `asyncio.Lock` means batches never overlap.
- **Due rows:** `upload_state = 'pending'` AND (`next_attempt_at` IS NULL OR `<= now`), oldest first, limit 50.
- **No key:** `station_request` returns None, so nothing happens and no attempt is counted.
- **Probe gate:** before sending rows whose `attempts >= 5`, call the probe.
  - If it fails, set `waiting_for_internet = 1` and `next_attempt_at = now + 30 s`, without incrementing attempts.
  - If it succeeds, send and clear the flag.
- **200:**
  - accepted ids get `upload_state='accepted'`, `was_accepted=1`, `accepted_at=now_iso()`;
  - rejected ids get `upload_state='rejected'` and `reject_code`;
  - `clear_setup` in the reply makes the edge apply Clear Setup exactly as `proxy._apply_clear_setup` does (refactor it into a shared function), call `station_key.clear`, and stop.
- **401:** set `last_error`, don't count an attempt, and set `next_attempt_at = now + 60 s`.
- **Network error, 5xx, 429 or another 4xx:** `attempts += 1` and `next_attempt_at = now + GAPS[min(attempts, 6) - 1]`, where `GAPS = (30, 60, 120, 300, 600, 1800)`. Set `last_error` to the code or exception type, never the key.

**Tests:**
- `test_accepted_rows_marked_with_time`.
- `test_rejected_rows_never_retried`.
- `test_batch_is_at_most_50`.
- `test_backoff_sequence`: an injected clock gives 30, 60, 120, 300, 600, then 1800, 1800.
- `test_probe_gate_waits_for_internet_without_spending_attempts`.
- `test_waiting_rows_send_as_soon_as_probe_succeeds`.
- `test_401_pauses_without_attempts`.
- `test_clear_setup_in_reply_drops_key`.
- `test_resend_after_timeout_is_idempotent`: the same `client_scan_id`s are resent.
- `test_no_overlapping_batches`.
- `test_uploads_with_no_person_session`.
- `test_edge_status_rfid_uploads_counts`.
- `test_key_not_in_last_error_or_logs`.

- [ ] Write the tests; run them; they fail.
- [ ] Implement.
- [ ] Run the edge suite; all pass.
- [ ] Commit: `feat(edge): upload pending RFID scans in batches of 50 with retries and an internet gate`
