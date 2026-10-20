# Kiosk Time Clock Station, Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the new guided time clock flow (web and laptop kiosk) and the laptop-only Time Clock station type that runs signed out under a station key, plus worker QR codes in the portal.

**Architecture:** The API gains a `timeclock` station type, station-key time clock routes, a "today's hours" computation and richer people/status payloads. The laptop edge holds the key, syncs people only, and exposes `/edge/timeclock/*` to one "armed" display browser. The kiosk gets a new `src/timeclock/` flow (pure reducer + screens + two backends: session and station) that replaces `pages/Timeclock.tsx`. The portal shows a QR of `badge_uid`.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + Postgres (api/), FastAPI + stdlib sqlite3 (kiosk_laptop/edge), React 18 + Vite 5 + vitest 3 (kiosk/), React + vitest (portal/), bwip-js (QR).

**Spec:** `docs/superpowers/specs/2026-10-20-kiosk-timeclock-station-design.md` (read it; this plan argues from it).

## Global Constraints

- American English in all copy, comments and docs.
- Time clock screens are always **light**; no orange dashed route line anywhere.
- Landscape = layout A (spec §5); orientation via CSS media queries only.
- No `at` / back-dating on any punch route; every punch is stamped `datetime.now(UTC)`.
- Lunch Out / Lunch In do not exist. Only Clock In and Clock Out.
- Idle reset 20 s on every step after the start screen; All Set auto-returns after 8 s; Printing placeholder advances after 3 s.
- Station keys never reach a browser or a log line.
- Migration number **0105**, `down_revision = "0103"` (0104 is taken by the unmerged `badge-templates` branch; at merge time re-point `down_revision` to whatever main's head is).
- Never commit `api/src/serversherpa/_dev_reload.py`.
- Subagents run every test suite in the FOREGROUND with a 600000 ms timeout; never background a suite.
- API tests in this worktree: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_tcstation .venv/bin/python -m pytest <files> -q`.
- Kiosk tests: `npm --prefix kiosk test -- <files>`; build gate `npm --prefix kiosk run build`. Every DOM test file starts with `// @vitest-environment jsdom`.
- Portal tests: `npm --prefix portal test -- <files>`; build gate `npm --prefix portal run build`.
- Edge tests: create the venv once with `python3 -m venv kiosk_laptop/edge/.venv && kiosk_laptop/edge/.venv/bin/pip install -e 'kiosk_laptop/edge[dev]'`, then `cd kiosk_laptop/edge && .venv/bin/python -m pytest <files> -q`.

## Plan-time adjustment to the spec (record in the spec's Implementation notes, Task 11)

Spec §6 says the signed-out edge routes answer "loopback requests" only. Behind Docker's published port the edge cannot see a reliable client address (Docker Desktop shows every connection from its gateway), and the `Host` header is client-controlled. Instead, the signed-out routes require a **display cookie** (`ss_tc_display`, HttpOnly, SameSite=Strict, path `/edge/timeclock`) that the edge issues only to a browser where a signed-in person pressed **Start Time Clock**. LAN devices without it get 403 `not_timeclock_display`. Same intent: only the station's own screen runs the signed-out flow.

## Review Focus

1. **A punch that races another kiosk** (person clocked in elsewhere between status read and tap): the API answers 409; the flow must refresh status and land back on the action step with a message, never on All Set. → test in Task 8 (reducer) and Task 4 (API 409 on station routes).
2. **Network drop at the moment of the punch:** the flow must show "Can't reach the portal. Your punch was not recorded." with Try again, and must not advance. → test in Task 9.
3. **A barcode reader typing a QR value fast, ending in Enter, while Welcome or Enter Your Name is showing:** selects the badge's owner; an unknown code flashes not-found and says "We couldn't find that code". → tests in Task 9.
4. **A shift that started yesterday and is still open, and a kiosk with no site:** today's minutes count only time since local midnight in the site's zone (UTC with no site). → tests in Task 3.
5. **The station key revoked (Clear Setup) or the registration lapsed while Welcome sits idle:** Welcome shows the paused/not-ready notice instead of letting someone walk through to a failed punch. → tests in Task 5 (edge `/station`) and Task 9 (Welcome notice).

---

### Task 1: API — `timeclock` station type and key scoping

**Files:**
- Create: `api/migrations/versions/0105_timeclock_station_type.py`
- Modify: `api/src/serversherpa/services/station_keys.py` (constants, `verify`)
- Modify: `api/src/serversherpa/api/deps.py:437` (`station_device`)
- Modify: `api/src/serversherpa/api/routes/kiosk.py:665-674` (`is_station`), `:1420-1426` (`_station_sync_device`)
- Modify: `api/src/serversherpa/api/schemas.py` (every `Literal["label", "rfid"]` station type, incl. `:3181`, `:4836`)
- Test: `api/tests/test_kiosk_timeclock_station_key.py`

**Interfaces:**
- Produces: `station_keys.STATION_TYPES = ("rfid", "label", "timeclock")`, `station_keys.UPLOAD_STATION_TYPES = ("rfid", "label")`, `station_keys.TIMECLOCK = "timeclock"`; `deps.station_device(request, db, serial, *, types: tuple[str, ...] = UPLOAD_STATION_TYPES) -> Device` (a valid key whose device type is not in `types` → 403 `wrong_station_type`, key kept); `routes.kiosk.is_station(device)` true for any `STATION_TYPES` laptop; `schemas.StationType = Literal["label", "rfid", "timeclock"]`.

- [ ] **Step 1: Write the failing tests**
  - `test_migration_allows_timeclock_station_type`: set `devices.station_type = 'timeclock'` on a kiosk row and flush — no IntegrityError; `'bogus'` still raises.
  - `test_verify_accepts_timeclock_laptop_key`: issue a key for a laptop kiosk with `station_type='timeclock'`; `station_keys.verify(db, serial, raw)` returns the device.
  - `test_timeclock_key_refused_on_upload_routes`: with a timeclock key, `GET /kiosk/station/sync/assets?serial=&initiative_id=` → 403 `{"code": "wrong_station_type"}`; same for `/kiosk/station/sync/containers`, `/kiosk/station/sync/label-templates`, `POST /kiosk/station/scans`, `POST /kiosk/station/heartbeat`; the key still verifies afterwards (not revoked).
  - `test_rfid_and_label_keys_unchanged`: existing RFID/Label key on `/kiosk/station/sync/assets` still 200.
- [ ] **Step 2: Run them; expect FAIL** (CHECK violation / 401).
- [ ] **Step 3: Implement.** Migration 0105 drops and re-creates `ck_devices_station_type` as `station_type IS NULL OR station_type IN ('label', 'rfid', 'timeclock')`; downgrade restores the two-value check (after `UPDATE devices SET station_type = NULL WHERE station_type = 'timeclock'`). `verify` checks `device.station_type in STATION_TYPES`. `station_device` gains the `types` kwarg (checked after the registration check). Routes that already post-check `station_type` (heartbeat, client-assets, sounds) keep their checks. Update the docstrings that say "RFID or Label".
- [ ] **Step 4: Run the new file plus `test_kiosk_station_key.py test_station_key_eligibility.py test_kiosk_station_scans.py test_kiosk_station_heartbeat.py`; expect PASS.**
- [ ] **Step 5: Commit** `feat(api): timeclock station type; station keys scoped by type`

### Task 2: API — Kiosk Setup for a Time Clock station (optional move and site)

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (`KioskSetupIn`, `KioskSetupOut`, `SetupOptionsOut`)
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (`setup_options`, `kiosk_setup` `:731-830`, `issue_station_key` `:833-861`, `kiosk_setup_read`)
- Test: `api/tests/test_kiosk_timeclock_setup.py`

**Interfaces:**
- Consumes: Task 1 constants.
- Produces:
  - `KioskSetupIn`: `initiative_id: uuid.UUID | None = None`, `site_id: uuid.UUID | None = None`, `scan_status: str | None = None`, `station_type: StationType | None = None`.
  - `KioskSetupOut`: `initiative_id`, `initiative_name`, `site_id`, `site_name` all `| None`; `site_role: Literal["source", "destination", "other"] | None`; `scan_status`, `scan_status_label`: `str | None`.
  - `SetupOptionsOut.sites: list[SetupOptionSite]` — every non-archived site, natural name order (for the no-move Site step).

- [ ] **Step 1: Write the failing tests**
  - `test_timeclock_setup_with_move`: `station_type="timeclock"`, move + its destination site, no scan_status → 200, `site_role == "destination"`, `scan_status is None`; device row `station_type == "timeclock"`, `scan_status is None`, reader columns null.
  - `test_timeclock_setup_with_move_rejects_foreign_site`: a site that is not the move's → 422 `bad_site`.
  - `test_timeclock_setup_no_move_any_site`: `initiative_id=None`, any active site → 200, `initiative_id is None`, `site_role == "other"`; device `current_initiative_id is None`.
  - `test_timeclock_setup_no_move_no_site`: both None → 200, `site_role is None`, device `site_id is None`.
  - `test_non_timeclock_still_requires_move_site_scan`: web (`station_type=None`) with `initiative_id=None` → 422 `bad_initiative`; missing `site_id` → 422 `bad_site`; missing `scan_status` → 422 `bad_scan_status`.
  - `test_move_password_session_cannot_set_up_no_move`: move-password session, timeclock, `initiative_id=None` → 403 `move_locked`.
  - `test_station_key_issue_without_move_for_timeclock`: after a no-move timeclock setup, `POST /kiosk/station-key` as the signed-in person → 200 with a key; a label station with no move still 409 `not_rfid_station`.
  - `test_change_move_none_to_some_revokes_key`: issue key with no move, re-setup timeclock with a move → key hash cleared (audit `station_key_revoke` reason `move_change`).
  - `test_setup_options_lists_sites`: `sites` holds every non-archived site, archived ones absent.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** in `kiosk_setup`: branch on `body.station_type == TIMECLOCK` before the move checks. Timeclock: validate the move only when given (same validity rules); with a move, the site must be its origin/destination (`source`/`destination`), with no move the site (if given) must exist and be non-archived (`other`); `device.scan_status = None`; clear reader columns and `rfid_paired_at` like the label branch; `_stamp("station_type", "timeclock")`. Non-timeclock: missing ids/scan → the existing 422 codes. The existing revoke rule compares `current_initiative_id` to the new move (None counts). `issue_station_key` allows `current_initiative_id is None` only for timeclock. Audit `kiosk_setup` changes carry `None` for absent ids. `kiosk_setup_read` returns the new type unchanged.
- [ ] **Step 4: Run the new file plus `test_kiosk_setup_api.py test_kiosk_station_setup.py test_kiosk_station_key.py`; expect PASS.**
- [ ] **Step 5: Commit** `feat(api): Kiosk Setup for a Time Clock station, move and site optional`

### Task 3: API — today's hours, richer status and people payloads

**Files:**
- Modify: `api/src/serversherpa/services/timeclock.py`
- Modify: `api/src/serversherpa/api/schemas.py` (`KioskPersonOut`, `KioskTimeclockPerson`, `KioskTimeclockStatusOut`, new `KioskTimeclockTodayEntry`)
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (`_people_body`, `_person_out`, `_status_out`, `timeclock_status`, `timeclock_clock_in`, `timeclock_clock_out`)
- Test: `api/tests/test_timeclock_today.py`, extend `api/tests/test_kiosk_timeclock_api.py`

**Interfaces:**
- Produces:
  - `timeclock.TodaySpan` (dataclass: `clock_in_at: datetime`, `clock_out_at: datetime | None`, `minutes: int`).
  - `async def timeclock.today_summary(db, person_id: uuid.UUID, *, tz: ZoneInfo, now: datetime) -> tuple[int, list[TodaySpan]]` — entries overlapping `[local midnight, now]`, oldest first; each span's minutes = overlap of `[clock_in_at, clock_out_at or now]` with today, minus `break_minutes` only when `clock_in_at` falls today, floored at 0; total = sum.
  - `async def timeclock.site_zone(db, site_id: uuid.UUID | None) -> ZoneInfo` — the site's `timezone`, UTC when no site or an unknown zone name.
  - `KioskTimeclockTodayEntry {clock_in_at: datetime, clock_out_at: datetime | None, minutes: int}`; `KioskTimeclockStatusOut` gains `today_minutes: int = 0`, `today_entries: list[KioskTimeclockTodayEntry] = []`.
  - `KioskTimeclockPerson` gains `job_title: str | None = None`, `external_id: str | None = None`.
  - `KioskPersonOut` gains `badge_uid: uuid.UUID`, `job_title: str | None = None`, `external_id: str | None = None`.
  - `_status_out(db, person, entry, *, last_entry=None, tz: ZoneInfo)` (now required tz).
  - `GET /kiosk/timeclock/{person_id}` takes optional `serial: str | None = Query(None)`; tz = that kiosk's site zone (unknown serial → UTC, never 404). Clock-in/out compute tz from the body's device.

- [ ] **Step 1: Write the failing tests** (`test_timeclock_today.py`, pure service tests with a fixed `now`):
  - `test_today_counts_open_entry_to_now`: in 08:02 local, now 15:26 → 444 minutes, one span with `clock_out_at None`.
  - `test_today_clips_shift_from_yesterday`: in 22:00 yesterday, out 02:00 today → 120 minutes (break of 30 on that entry NOT subtracted).
  - `test_today_subtracts_break_for_shift_started_today`: 08:00–12:00 with `break_minutes=30` → 210.
  - `test_today_uses_site_zone`: same UTC instants, `America/Los_Angeles` vs `America/New_York` give different totals around midnight.
  - `test_site_zone_falls_back_to_utc`: `site_id=None` → UTC; site with `timezone='Not/AZone'` → UTC.
  - In `test_kiosk_timeclock_api.py`: `test_status_includes_today_and_person_fields` (status with `serial` → `today_minutes`, `today_entries`, `person.job_title`, `person.external_id`); `test_sync_people_includes_badge_uid` (`badge_uid`, `job_title`, `external_id` present).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** the service functions (query: `person_id == p AND clock_in_at < now AND (clock_out_at IS NULL OR clock_out_at > day_start)`, order by `clock_in_at`); wire the schemas and routes.
- [ ] **Step 4: Run `test_timeclock_today.py test_kiosk_timeclock_api.py test_time*.py`; expect PASS.**
- [ ] **Step 5: Commit** `feat(api): today's hours and badge/job fields for the kiosk time clock`

### Task 4: API — station-key time clock routes

**Files:**
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (new routes beside the timeclock section; `station_sync_people`)
- Modify: `api/src/serversherpa/api/schemas.py` (new `KioskStationClockIn`)
- Test: `api/tests/test_kiosk_station_timeclock.py`

**Interfaces:**
- Consumes: Task 1 `station_device(..., types=)`, Task 3 `_status_out`, `site_zone`.
- Produces:
  - `KioskStationClockIn {serial: str (1..120), person_id: uuid.UUID}` (used by both POSTs).
  - `GET /kiosk/station/timeclock/{person_id}?serial=` → `KioskTimeclockStatusOut`.
  - `POST /kiosk/station/timeclock/clock-in` / `clock-out` → `KioskTimeclockStatusOut`; 409 `already_clocked_in` / `not_clocked_in` as the session routes.
  - `GET /kiosk/station/sync/people?serial=[&initiative_id=]` — `initiative_id` now optional: a timeclock key accepts it absent or equal to its key move; rfid/label keys still require it equal to the key move (absent → 403 `move_locked`).
  - Shared private helpers extracted from the session routes: `async def _open_shift(db, device, person, *, actor_id, initiative_id, site_id, via) -> TimeEntry` and `async def _close_shift(db, device, person, *, actor_id, via) -> TimeEntry` (raise the same `_err` 409s; write the audit row with `changes["via"] = via`, `"session"` or `"station_key"`).

- [ ] **Step 1: Write the failing tests**
  - `test_station_clock_in_uses_device_setup`: timeclock key, device with move M and site S → entry has `initiative_id=M`, `site_id=S`, `source='kiosk'`, `device_id`, `created_by IS NULL`; audit `kiosk_clock_in` with `actor_person_id IS NULL` and `changes.via == "station_key"`.
  - `test_station_clock_in_no_move`: device with no move → entry `initiative_id IS NULL`.
  - `test_station_clock_out_closes_any_open_shift`: an open shift opened by another move's kiosk is closed (no `move_locked`).
  - `test_station_clock_in_twice_409`: second clock-in → 409 `already_clocked_in` with `entry_id`.
  - `test_station_timeclock_refuses_upload_keys`: an RFID key on these routes → 403 `wrong_station_type`.
  - `test_station_timeclock_read_only_mode`: read-only freeze → the POSTs refuse like `/kiosk/station/scans` does.
  - `test_station_sync_people_timeclock_without_move`: timeclock key, no `initiative_id` → 200 people; RFID key with no `initiative_id` → 403 `move_locked`.
  - `test_session_routes_unchanged`: existing `test_kiosk_timeclock_api.py` stays green (run it).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement**; station POSTs call `enforce_read_only_config(db, request)` exactly as `station_scans` does; the session routes switch to the shared helpers with `actor_id=actor.person.id, via="session"` (their audits gain `via`).
- [ ] **Step 4: Run the new file plus `test_kiosk_timeclock_api.py test_kiosk_station_*.py`; expect PASS.**
- [ ] **Step 5: Commit** `feat(api): station-key time clock routes; people sync for a Time Clock key`

### Task 5: Edge — Time Clock station support and `/edge/timeclock/*`

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/rfid/station_key.py` (`STATION_TYPES`, `apply_clear_setup`)
- Modify: `kiosk_laptop/edge/src/edge/laptop_setup.py` (`save` accepts `timeclock`)
- Modify: `kiosk_laptop/edge/src/edge/sync.py` (`Syncer.run` timeclock branch)
- Modify: `kiosk_laptop/edge/src/edge/routes/kiosk.py` (`setup`: null move, event text, display cleanup)
- Modify: `kiosk_laptop/edge/src/edge/db.py` (new SCHEMA_STEPS entry), `kiosk_laptop/edge/src/edge/routes/edge.py` (`MOVE_TABLES` gains `timeclock_displays`)
- Create: `kiosk_laptop/edge/src/edge/timeclock.py`, `kiosk_laptop/edge/src/edge/routes/timeclock.py`
- Modify: `kiosk_laptop/edge/src/edge/app.py` (include router)
- Test: `kiosk_laptop/edge/tests/test_timeclock_station.py`

**Interfaces:**
- Consumes: Task 2 setup reply shape (nullable move/site), Task 4 station routes.
- Produces:
  - `station_key.STATION_TYPES = ("rfid", "label", "timeclock")`; `station_key.is_timeclock_setup(store) -> bool`.
  - `edge.timeclock`: `DISPLAY_COOKIE = "ss_tc_display"`, `issue_display(store) -> str` (raw token; stores sha256 + created_at), `is_display(store, token: str | None) -> bool`, `clear_displays(store) -> None`.
  - SQLite: `CREATE TABLE timeclock_displays (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL)`.
  - Router `/edge/timeclock`:
    - `GET /station` (public) → `{"timeclock": bool, "ready": bool, "paused": bool, "armed": bool, "initiative_name": str | None, "site_name": str | None}`; `ready` = timeclock setup and a key held and not paused; `armed` = the request's cookie is a known display.
    - `POST /arm` (`require_session`) → 204 + `Set-Cookie ss_tc_display` (HttpOnly, SameSite=Strict, path `/edge/timeclock`, max-age 400 days, `secure=settings.secure_cookies`); 409 `not_timeclock_station` unless a timeclock setup holds a key.
    - `GET /people` (display) → the cached `/kiosk/sync/people` body (200, `X-Edge-Cache: hit`) or 503 `people_not_synced`.
    - `GET /status/{person_id}`, `POST /clock-in`, `POST /clock-out` (display; body `{"person_id": "<uuid>"}`) → forwarded with `station_key.station_request` to `/kiosk/station/timeclock/...` with the edge's serial; upstream status and JSON body passed through; no key → 409 `station_not_ready`; `CloudOffline` → 503 `edge_offline`; non-UUID person → 422 `bad_person`.
    - Missing/unknown display cookie → 403 `not_timeclock_display`.
  - `Syncer.run`: when the setup is a timeclock station, pull only people — under the station key (`/kiosk/station/sync/people?serial=[&initiative_id=]`) when a key is held, else as the actor person (`/kiosk/sync/people`), else `needs_sign_in` — stored under cache key `/kiosk/sync/people`; runs even with no move. All other station types unchanged.
  - Displays are cleared by `station_key.apply_clear_setup`, by a Wipe, and by `POST /kiosk/setup` saving any station type other than `timeclock`.

- [ ] **Step 1: Create the edge venv (Global Constraints) and write the failing tests**
  - `test_station_info_public_and_flags`: no setup → `timeclock False, ready False`; timeclock setup + key → `ready True, armed False`; paused flag → `ready False, paused True`.
  - `test_arm_requires_session_and_timeclock_key`: anonymous → 401; signed-in on a label station → 409 `not_timeclock_station`; on a timeclock station with key → 204 and the cookie attributes above.
  - `test_display_routes_refuse_without_cookie`: `/people`, `/status/x`, `/clock-in` → 403 `not_timeclock_display`.
  - `test_clock_in_forwards_under_station_key`: with the fake upstream, `POST /edge/timeclock/clock-in` sends `Authorization: Station <key>` to `/kiosk/station/timeclock/clock-in` with `{"serial": <edge serial>, "person_id": ...}` and passes a 409 body through unchanged.
  - `test_clock_in_offline_503`: upstream offline → 503 `edge_offline`.
  - `test_timeclock_sync_people_only_without_move`: timeclock setup with `initiative_id None` → syncer calls only the station people route (no `initiative_id` param) and writes cache key `/kiosk/sync/people`.
  - `test_setup_with_null_move_saves_and_issues_key`: edge `POST /kiosk/setup` with a reply carrying `initiative_id: null, station_type: "timeclock"` → `laptop_setup.load()["station_type"] == "timeclock"`, issue called, event detail mentions "Time Clock".
  - `test_clear_setup_and_wipe_drop_displays`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Keep `station_key`'s rule that keys never appear in responses or logs.
- [ ] **Step 4: Run the new file plus the whole edge suite (`.venv/bin/python -m pytest -q`); expect PASS.**
- [ ] **Step 5: Commit** `feat(edge): Time Clock station: people-only sync, display cookie, /edge/timeclock routes`

### Task 6: Kiosk — data layer for the Time Clock station

**Files:**
- Modify: `kiosk/src/lib/kioskSetup.ts`, `kiosk/src/lib/laptopSetup.ts`, `kiosk/src/lib/features.ts`, `kiosk/src/lib/api.ts`, `kiosk/src/lib/peopleMatch.ts`, `kiosk/src/lib/sync.ts`
- Test: extend `kiosk/src/lib/kioskSetup.test.ts`, `laptopSetup.test.ts`, `features.test.ts`, `peopleMatch.test.ts` (create if absent), `api.timeclock.test.ts`, `sync` tests as present

**Interfaces:**
- Consumes: Tasks 2–4 payloads.
- Produces:
  - `StationType = 'label' | 'rfid' | 'timeclock'`; `KioskSetupSelection.siteRole: 'source' | 'destination' | 'other' | 'none'`; a no-move selection uses `initiativeId: ''`, `initiativeName: 'No move'`, and with no site `siteId: ''`, `siteName: 'No site'`, `siteRole: 'none'`; `scanStatus: ''`, `scanLabel: ''` for a Time Clock station. `stationLabel('timeclock', m)` → `Time Clock · ${m}`.
  - `selectionFromEdge` accepts a `timeclock` edge setup with null move/site/scan and maps it to the above.
  - `features.ts`: `KioskFeature['id']` gains `'clock'`; `TIMECLOCK_STATION_FEATURE = { id: 'clock', path: '/timeclock/station', title: 'Time Clock', blurb: 'Start the time clock for workers.' }`; `STATION_TILES.timeclock = ['clock', 'setup', 'settings']`; `homeFeatures(laptop, stationType: StationType | undefined)`.
  - `api.ts`: `KioskPersonRow` gains `badge_uid?: string`, `job_title?: string | null`, `external_id?: string | null`; `KioskTimeclockPerson` gains `job_title`, `external_id`; `KioskTimeclockStatus` gains `today_minutes: number`, `today_entries: { clock_in_at: string; clock_out_at: string | null; minutes: number }[]`; `fetchTimeclockStatus(personId: string, serial?: string)`; `SetupOptions.sites: SetupOptionSite[]`; `submitKioskSetup` params `initiative_id: string | null`, `site_id: string | null`, `scan_status?: string`; its result type has the nullable fields of Task 2.
  - `peopleMatch.ts`: `MatchPerson.badge_uid?: string | null`; `PeopleIndex.byBadge: Map<string, P>` (lower-cased UUID); `matchPersonExact` tries RFID, then badge, then id.
  - `runSync(initiativeId, name)` returns without fetching when `initiativeId === ''`.

- [ ] **Step 1: Write the failing tests**: selection round-trip of a no-move timeclock selection (stored, read back, `normalize` keeps `stationType: 'timeclock'`); `selectionFromEdge` for timeclock with nulls; `homeFeatures(true, 'timeclock')` ids `['clock','setup','settings']`; `matchPersonExact(index, '<badge uuid upper-case>')` returns the person; `fetchTimeclockStatus('p', 'SER')` calls `/kiosk/timeclock/p?serial=SER`; `runSync('', 'No move')` makes no fetch.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run those files plus the full kiosk suite and `npm --prefix kiosk run build`; expect PASS** (fix any type fallout from the nullable setup result in `KioskSetup.tsx` minimally — the wizard itself changes in Task 7).
- [ ] **Step 5: Commit** `feat(kiosk): Time Clock station type, badge matching, today fields in the data layer`

### Task 7: Kiosk — Kiosk Setup's Time Clock path and Start Time Clock

**Files:**
- Modify: `kiosk/src/components/setup/StationTypeStep.tsx` (third card)
- Modify: `kiosk/src/pages/KioskSetup.tsx` (`pathFor`, move/site steps, `finish`, summary)
- Create: `kiosk/src/pages/StartTimeclock.tsx`
- Create: `kiosk/src/timeclock/stationApi.ts` (edge client used here and by Task 8)
- Modify: `kiosk/src/pages/Home.tsx` (station tiles via `homeFeatures`), `kiosk/src/App.tsx` (route `/timeclock/station` inside `KioskGuard` + `KioskShell`)
- Test: `kiosk/src/pages/KioskSetup.timeclock.test.tsx`, `kiosk/src/pages/StartTimeclock.test.tsx`, `kiosk/src/timeclock/stationApi.test.ts`

**Interfaces:**
- Consumes: Task 6 selection/features/api types; Task 5 edge routes.
- Produces (`timeclock/stationApi.ts`):
  - `interface StationInfo { timeclock: boolean; ready: boolean; paused: boolean; armed: boolean; initiative_name: string | null; site_name: string | null }`
  - `getStationInfo(): Promise<StationInfo | null>` (null on any failure), `armDisplay(): Promise<void>` (uses `apiFetch` so the session bearer rides along), `stationPeople(): Promise<KioskPersonRow[]>`, `stationStatus(personId)`, `stationClockIn(personId)`, `stationClockOut(personId)` (all `fetch` with `credentials: 'same-origin'`, throwing `ApiError(code, status)` from the edge's `{detail: {code}}`).
  - `useStationInfo(): { loading: boolean; info: StationInfo | null; refresh(): void }` — laptop only (`isLaptop()`), web returns `{loading:false, info:null}`.
- Behavior:
  - Card copy: title **Time Clock**, meta `Workers clock in and out here. Next: Move (optional) → Site.`
  - `pathFor(true, 'timeclock')` = `['type', 'move', 'site']`.
  - Move step (timeclock only) adds a first card **No move** (`Punches are filed under no move and sorted out later in the portal.`). Choosing a move → Site shows that move's source/destination as today; **No move** → Site lists `options.sites` plus a first card **No site**.
  - Picking a site (or No site) finishes: `submitKioskSetup({serial, initiative_id: id || null, site_id: id || null, station_type: 'timeclock'})`, writes the selection (Task 6 shape), `writeSetupState('complete')`, no `runSync`, then navigates to `/timeclock/station`.
  - Summary for a timeclock selection reads `This kiosk is a Time Clock station for <b>{move or "no move"}</b> at <b>{site or "no site"}</b>.` and has no local-data line.
  - `StartTimeclock` page: heading `Start the time clock`, text `This signs you out and shows the Welcome screen for workers.`, button **Start Time Clock** → `armDisplay()` → `logout()` → `navigate('/', { replace: true })`. Errors: `not_timeclock_station` → `This kiosk isn't set up as a Time Clock station yet. Run Kiosk Setup first.`; anything else → `Couldn't start the time clock. Try again.`
- [ ] **Step 1: Write the failing tests** for: the third card and its path; No move → site list from `options.sites` with No site first; finish posts nulls and navigates to `/timeclock/station`; summary text; StartTimeclock arms, logs out, navigates; its two error messages; `getStationInfo` returns null on a 500.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the files plus the full kiosk suite and build; expect PASS.**
- [ ] **Step 5: Commit** `feat(kiosk): Kiosk Setup's Time Clock path and Start Time Clock`

### Task 8: Kiosk — time clock flow core (reducer, backends, timers)

**Files:**
- Create: `kiosk/src/timeclock/flow.ts`, `kiosk/src/timeclock/backend.ts`, `kiosk/src/timeclock/format.ts`, `kiosk/src/timeclock/useIdle.ts`
- Test: `kiosk/src/timeclock/flow.test.ts`, `backend.test.ts`, `format.test.ts`, `useIdle.test.tsx`

**Interfaces:**
- Consumes: Task 6 `api.ts` types and `fetchTimeclockStatus/clockIn/clockOut` (existing names in `lib/api.ts:810-845`), Task 7 `stationApi.ts`.
- Produces:
  - `type FlowMode = 'station' | 'kiosk'`
  - `type Step = 'welcome' | 'name' | 'confirm' | 'action' | 'clockOut' | 'badge' | 'printing' | 'verify' | 'done'`
  - `interface FlowState { mode: FlowMode; step: Step; status: KioskTimeclockStatus | null; busy: boolean; error: string | null; notice: string | null; punched: 'in' | 'out' | null }`
  - `type FlowAction = { type: 'identified'; status: KioskTimeclockStatus } | { type: 'confirmYes' } | { type: 'confirmNo' } | { type: 'chooseIn' } | { type: 'chooseOut' } | { type: 'punchStarted' } | { type: 'punchSucceeded'; status: KioskTimeclockStatus; punched: 'in' | 'out' } | { type: 'punchFailed'; code: string } | { type: 'statusRefreshed'; status: KioskTimeclockStatus } | { type: 'badgeNew' } | { type: 'badgeExisting' } | { type: 'printingDone' } | { type: 'verifyContinue' } | { type: 'back' } | { type: 'reset' }`
  - `initialState(mode: FlowMode): FlowState` (step `welcome` for station, `name` for kiosk); `reducer(state, action): FlowState`.
  - `START_STEP(mode)`; `IDLE_MS = 20_000`; `DONE_MS = 8_000`; `PRINTING_MS = 3_000`.
  - `interface TimeclockBackend { people(): Promise<KioskPersonRow[]>; status(personId: string): Promise<KioskTimeclockStatus>; clockIn(personId: string): Promise<KioskTimeclockStatus>; clockOut(personId: string): Promise<KioskTimeclockStatus> }`; `sessionBackend(serial: string): TimeclockBackend` (people from IndexedDB `people` via the existing localDb reader the old `Timeclock.tsx` uses; status with `serial`); `stationBackend(): TimeclockBackend` (stationApi).
  - `formatWorked(minutes: number): string` — `'5m'` under an hour, otherwise hours plus two-digit minutes. Pins: `formatWorked(0) === '0m'`, `formatWorked(5) === '5m'`, `formatWorked(444) === '7h 24m'`, `formatWorked(480) === '8h 00m'`. `formatClock(iso: string): string` → locale short time (`8:02 AM`).
  - `useIdle(active: boolean, ms: number, onIdle: () => void): void` — resets on `pointerdown`/`keydown` on `window`.
- Transition rules (the tests pin each):
  - `identified` → `confirm` (stores status, clears error).
  - `confirmNo` / `back` from `confirm` → `name`. `back` from `name` → `welcome` in station mode; in kiosk mode `back` from `name` is handled by the component (exit), the reducer returns the state unchanged.
  - `confirmYes` → `action`.
  - `chooseOut` → `clockOut` (only when `status.clocked_in`); `chooseIn` when not clocked in → stays on `action` with `busy` (the component punches immediately; spec §4.6).
  - `punchSucceeded` punched `in` → `badge`; punched `out` → `done`.
  - `punchFailed` `already_clocked_in` | `not_clocked_in` → `action`, `notice = 'Your status changed. Please choose again.'`, busy false (component then dispatches `statusRefreshed`). Any other code → same step, `error = "Can't reach the portal. Your punch was not recorded. Try again."` for `network`/`edge_offline`, otherwise `'Something went wrong. Your punch was not recorded. Try again.'`.
  - `badgeNew` → `printing`; `printingDone` → `verify`; `verifyContinue` → `done`; `badgeExisting` → `done`.
  - `back` from `action` → `confirm`; from `clockOut` → `action`; from `badge` → `badge` (the punch already happened: Back is hidden there); `reset` → `initialState(mode)`.
- [ ] **Step 1: Write the failing tests** — one per transition rule above (including both 409 codes and the network message), `formatWorked` pins, `useIdle` fires after 20 s with fake timers and is pushed back by a `keydown`, `sessionBackend.status` passes the serial, `stationBackend` maps a `{detail:{code:'edge_offline'}}` 503 to `ApiError('edge_offline')`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Commit** `feat(kiosk): time clock flow reducer, backends and timers`

### Task 9: Kiosk — screens, layout, routes; retire the old Timeclock page

**Files:**
- Create: `kiosk/src/timeclock/TimeclockFlow.tsx`, `kiosk/src/timeclock/screens/{Welcome,EnterName,ConfirmPerson,ChooseAction,ClockOutSummary,BadgeQuestion,PrintingBadge,VerifyBadge,AllSet}.tsx`, `kiosk/src/timeclock/OnScreenKeyboard.tsx`, `kiosk/src/timeclock/TcShell.tsx` (header + mountain footer), `kiosk/src/timeclock/icons.tsx` (inline SVG icons), `kiosk/src/styles/timeclock.css`
- Create: `kiosk/src/pages/TimeclockKiosk.tsx` (regular kiosk), `kiosk/src/components/StationRoot.tsx` (the `/` route)
- Modify: `kiosk/src/App.tsx`, `kiosk/src/main.tsx` (import `timeclock.css`)
- Delete: `kiosk/src/pages/Timeclock.tsx` and its tests (their still-relevant assertions move to the new tests)
- Test: `kiosk/src/timeclock/TimeclockFlow.test.tsx`, `OnScreenKeyboard.test.tsx`, `kiosk/src/components/StationRoot.test.tsx`, `kiosk/src/timeclock/timeclockCss.test.ts`

**Interfaces:**
- Consumes: Task 8 everything; Task 7 `useStationInfo`; existing `flash`, `playScanSound`, appearance helpers exactly as `pages/Timeclock.tsx` uses them (`lib/flash.ts`, `lib/sound.ts`, `lib/appearance.ts`).
- Produces:
  - `TimeclockFlow` props `{ mode: FlowMode; backend: TimeclockBackend; onExit?: () => void; paused?: boolean }`.
  - Routes: `/timeclock` → `<KioskGuard><SetupGate feature=TIMECLOCK><TimeclockKiosk/></SetupGate></KioskGuard>` with **no `KioskShell`** (full screen); `TimeclockKiosk` = `TimeclockFlow mode="kiosk" backend={sessionBackend(getIdentity().serial)} onExit={() => navigate('/')}`.
  - `/` → `StationRoot`: when `useStationInfo().info?.timeclock && info.armed` and auth status is `anon` → `TimeclockFlow mode="station" backend={stationBackend()} paused={!info.ready}`; otherwise the existing `<KioskGuard><KioskShell><Home/></KioskShell></KioskGuard>`. While station info loads, render nothing (as `KioskGuard` does while loading).
- Screen content (copy is pinned by tests; layout per spec §4–5 and the mockups `Sample Data/kiosk timeclock/light_screen_0*.png`, landscape `.superpowers/brainstorm/16241-1792526939/content/landscape-v1.html` layout A):
  - Header everywhere: `serversherpa-logo.png` + `Server` `Sherpa` wordmark + `DATACENTER RELOCATION TOOLS`, live date and time at right; station Welcome adds a small gear button (aria-label `Settings`) → `navigate('/login')`.
  - Footer: `login-mountains-light.webp` (already in `kiosk/public/images`), masked fade, `TRACK | MONITOR | VERIFY | COMPLETE`.
  - Welcome: `Welcome!` / `Please identify yourself to continue.`; cards **Scan Your QR Code** (`Scan your code with the reader` on the laptop) and **Enter Your Name** (`Type your name on screen`). A hidden, always-focused input takes reader keystrokes on Welcome and Enter Your Name; Enter or an exact match selects (reuse `matchPersonExact` + `isAmbiguousPrefix` timing from the old page). Unknown value → not-found flash + sound + `We couldn't find that code.` `paused` → Welcome shows `This time clock is paused. Ask an administrator to sign in here or renew this kiosk on Kiosk Devices.` and both cards are disabled.
  - Enter Your Name: `Enter Your Name` / `Type your name below to find your account.`, search box `Start typing your name…`, up to 8 results (`searchPeople`), `OnScreenKeyboard` (rows `QWERTYUIOP`, `ASDFGHJKL`, `⇧ ZXCVBNM ⌫`, bottom `123` · `Space` · `Search`); physical keys also type.
  - Confirm: photo (`avatar_url`) or initials, `Is this you?`, name, job title, `Employee ID {external_id}` when set; **Yes, that's me** / **No, search again**.
  - Action: `What would you like to do?`; tiles **Clock In** (`Start your work day`, green) and **Clock Out** (`End your work day`, red); the one that doesn't fit is `disabled` and dimmed; a `notice` shows above.
  - Clock Out: `Clock Out`, `You've been working for`, big `formatWorked(today_minutes)`, `today`, a table of `today_entries` (`Clock In {time}` / `Clock Out {time or "now"}` rows, then `Total`), **Confirm Clock Out**.
  - Badge: `Do you need a new badge?` with **Print a new badge** / **My badge works**.
  - Printing (placeholder): `Printing Your Badge`, `Please wait while we print your badge…`, spinner; advances after `PRINTING_MS`.
  - Verify (placeholder): `Verify Your Badge`, `Place your badge against the reader to check it's working.`, **Continue**.
  - Done: check icon, `You're All Set!`, `Have a great day, {first or preferred name}!`, **Done**; auto exits after `DONE_MS`.
  - Back (`← Back`, bottom-left) on every step after the start step except Badge, Printing, Verify, Done.
  - Exit = `reset` to Welcome in station mode; `onExit()` in kiosk mode (from Done, idle, or Back on Enter Your Name).
  - Busy: buttons disabled while a punch is in flight.
  - Punch error: error text + **Try again** (re-sends the same punch).
- CSS (`timeclock.css`, all selectors under `.tcx`): light tokens from `portal/src/styles/login-light.css` (ink `#0F172A`, amber `#FF6A00`, paper `#FFF9F2`); `.tcx` is `position: fixed; inset: 0` and forces light (`color-scheme: light`); portrait is the default; `@media (orientation: landscape)` applies layout A (Welcome cards side by side, Confirm photo left / text right, Clock Out total left / table right, action tiles one row, name results beside the keyboard); touch targets ≥ 56 px; no dashed route line.
- [ ] **Step 1: Write the failing tests** (`TimeclockFlow.test.tsx`, with a fake backend):
  - station: Welcome → type a badge UUID + Enter into the hidden input → Confirm shows name, job title, `Employee ID 1042`.
  - unknown code → `We couldn't find that code.`, still on Welcome.
  - Enter Your Name via on-screen keys `T`,`I`,`N` → result row → Confirm.
  - Clocked-out person: Clock Out tile disabled; Clock In punches once → Badge → **My badge works** → `You're All Set!` → after 8 s back to Welcome.
  - Clock In → **Print a new badge** → Printing → (3 s) Verify → **Continue** → Done.
  - Clocked-in person: Clock Out → shows `7h 24m` from `today_minutes: 444` and the entry rows → Confirm → Done.
  - backend `clockIn` rejects `ApiError('already_clocked_in')` → back on action with `Your status changed. Please choose again.` and status re-fetched.
  - backend rejects `ApiError('network')` → `Can't reach the portal. Your punch was not recorded. Try again.`, **Try again** re-sends.
  - 20 s idle on Confirm → Welcome (station) / `onExit` called (kiosk).
  - kiosk mode starts on Enter Your Name; Back there calls `onExit`.
  - `paused` → paused notice, cards disabled.
  - `StationRoot`: anon + armed timeclock → Welcome; anon + not armed → redirect to `/login`; signed in → Home.
  - `timeclockCss.test.ts`: the stylesheet has an `orientation: landscape` block, sets `color-scheme: light`, and contains no `stroke-dasharray`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement**; delete `pages/Timeclock.tsx` (+ its tests) once the new tests cover its behavior; the `timeclock` feature tile keeps path `/timeclock`.
- [ ] **Step 4: Run the full kiosk suite and `npm --prefix kiosk run build`; expect PASS.**
- [ ] **Step 5: Commit** `feat(kiosk): the new time clock flow, portrait and landscape; station Welcome at /`

### Task 10: Portal — worker QR codes

**Files:**
- Create: `portal/src/components/people/BadgeQr.tsx`
- Modify: `portal/src/pages/Profile.tsx` (My QR code card), `portal/src/pages/WorkerDetail.tsx` (Print QR)
- Test: `portal/src/components/people/BadgeQr.test.tsx`, extend the Profile and WorkerDetail tests

**Interfaces:**
- Consumes: `qrDataUrl(text)` from `portal/src/lib/qr.ts`; `badge_uid` already on both payloads.
- Produces: `BadgeQr({ badgeUid, size?: number })` renders `<img alt="Your time clock QR code" src={qrDataUrl(badgeUid)}>`; `printBadgeQr({ name, badgeUid })` opens a print window with the name and QR (reuse the portal's existing print-window helper used by the rack diagram print, if one exists; otherwise a minimal `window.open` + `print()`).
- Behavior: /me profile gets a panel **My QR code** with `Show this at the kiosk to clock in and out.` and the QR at ≥ 220 px. Worker page shows **Print QR** in the person panel actions only when `worker.badge_uid` is non-null (the API already hides it from non-global viewers).
- [ ] **Step 1: Failing tests**: QR image renders with the badge uid passed to `qrDataUrl` (mock it); Profile shows the panel; WorkerDetail shows Print QR only with a badge uid and calls `printBadgeQr` with name + uid.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** using the portal's panel/button idioms (see the Portal UI consistency rules: reuse existing components, no raw native controls).
- [ ] **Step 4: Run the files, the full portal suite and `npm --prefix portal run build`; expect PASS.**
- [ ] **Step 5: Commit** `feat(portal): worker QR codes for the kiosk time clock`

### Task 11: Spec notes

**Files:**
- Modify: `docs/superpowers/specs/2026-10-20-kiosk-timeclock-station-design.md` (append `## Implementation notes (phase 1)`)

- [ ] **Step 1:** Record the display-cookie adjustment (top of this plan), the `wrong_station_type` code, migration 0105 numbering, the edge routes list, and that `pages/Timeclock.tsx` was retired.
- [ ] **Step 2: Commit** `docs(kiosk): Time Clock station phase 1 implementation notes`

---

## After the tasks (controller)

1. Whole-branch review (subagent-driven-development's final review), fix rounds.
2. Full gates: API suite (`SS_TEST_DB=serversherpa_test_tcstation`), edge suite, kiosk suite + build, portal suite + build.
3. Live verify on the dev stack: migrate the dev DB to 0105, run the branch API on :8001 and the laptop container against it (recipe in the kiosk-laptop memory), set up a Time Clock station, Start Time Clock, clock a test worker in and out by name and by badge UUID, portrait and landscape screenshots; regular kiosk flow at `/timeclock`; portal /me QR.
4. Stop and tell Jimmy it is ready to test (he asked for no interruptions until then). Merge, push, parity sheet, Harbor Master and the Features wiki page wait for his test.
