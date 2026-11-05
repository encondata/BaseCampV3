# Dock Station (proof of concept) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `dock` laptop station type that groups RFID curtain reads into passes on the laptop and packs each one-crate pass into that crate in the portal, with a Dock screen and a dry run that keeps everything on the laptop.

**Architecture:** The API gains the `dock` station type (it gets the RFID Station's treatment everywhere) and one station-key route, `POST /kiosk/station/dock/passes`, that packs a pass in one transaction using pack logic extracted from the Containers route. The laptop edge stamps each raw read with dry run at ingest, groups reads into passes by the reader's `read_at` in its own 1 s loop, and sends closed passes in order under the station key with the scan uploader's retry rules. The kiosk gets the Dock setup card, Home tiles, the off-move alarm, and a dark `/dock` screen backed by session-gated `/edge/dock` routes. The portal labels Dock everywhere it labels the other station types.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + Postgres (`api/`), FastAPI + stdlib sqlite3 (`kiosk_laptop/edge`), React 18 + Vite + vitest (`kiosk/`, `portal/`).

**Spec:** `docs/superpowers/specs/2026-11-05-dock-station-design.md` (read it; this plan argues from it). Precedent: `docs/superpowers/plans/2026-10-20-kiosk-timeclock-station.md`, migration `api/migrations/versions/0105_timeclock_station_type.py`.

## Global Constraints

- Work only in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/dock-station` (branch `dock-station`). Never commit `api/src/serversherpa/_dev_reload.py`.
- American English in all copy, comments and docs.
- Time labels are 24-hour `HH:MM` or `HH:MM:SS`, never AM/PM.
- Modals: `modal-scrim` > `modal-card reports-modal-card rgm-card` > `modal-head` holding `rgm-head-text` (`.eyebrow`, `h3`, `p.page-hint`) and a `modal-close` button (copy `kiosk/src/components/printers/FactoryResetModal.tsx`). Corners stay rounded; check a screenshot.
- No default browser scrollbars. Prefer rows fitted to the panel (`useFitRows`, as Live Tag Reads does) over a scroll box; a scroll box that can't be avoided gets the themed slim bar.
- Every action has a visible on-screen control (no Enter-only or gesture-only actions).
- Match the surrounding code style and comment density; reuse kiosk/portal idioms (`rfid-dash-*` tiles and panels, `Switch`, `mini-btn`, `chip`, the alarm seconds field) instead of new looks.
- Station keys never appear in a log line, an edge response, `last_error` or an event.
- Migration **0120**, `down_revision = "0119"` (re-point at merge if main has moved).
- Edge `SCHEMA_STEPS` stay additive; no `;` inside SQL comments (the migrator splits on `;`).
- Station type value `dock`. Pass defaults: dry run **on**, quiet gap **5** seconds.
- Copy pinned by the spec: `No crate read`, `More than one crate`, `Would pack {N} into {crate}`, `Changed since this pass`, `Waiting to send`, `Packed`.
- Every test command runs in the FOREGROUND with a 600000 ms timeout. Never run the full API suite inside a task (over 2 hours).
- API tests: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_dock .venv/bin/python -m pytest tests/<files> -q` (`PYTHONPATH` is required: the symlinked venv's editable install points at the main checkout).
- Edge tests: `cd kiosk_laptop/edge && .venv/bin/python -m pytest tests/<files> -q`; whole suite: `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q`.
- Kiosk tests: `npm --prefix kiosk test -- <files relative to kiosk/>`; build gate `npm --prefix kiosk run build`. DOM test files start with `// @vitest-environment jsdom`.
- Portal tests: `npm --prefix portal test -- <files relative to portal/>`; build gate `npm --prefix portal run build`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions this plan makes (the spec left them open)

1. Labels: portal full name **Dock Station**, short **Dock** (Type column `Dock · Laptop`, like `RFID · Laptop`); kiosk `stationLabel` → `Dock · {mode}`; setup card **Dock Station**; Home tile **Dock**; notifications call it **Dock Station**.
2. The API keeps each answered pass in a new table `dock_passes` (same migration 0120) so a replay returns the stored reply.
3. Memberships a pass creates get `added_at` = the pass's close time (clamped to the server's now), not the request time, so passes sent late after an outage order correctly against each other and against later Containers-screen edits.
4. Per asset, "already in this crate" is checked before "Changed since this pass" (a newer membership in the same crate is `already_there`).
5. The close time sent is the reader-clock `last_new_at + gap` plus the laptop's `server_offset_ms` (0 when unknown). This assumes the reader's clock is close to the laptop's.
6. A pass is dry run when any of its reads was taken in dry run or dry run was on when it closed. While dry run is on (on a Dock setup), neither the pass sender nor the scan uploader sends anything; work decided live before it was switched on goes once it is off.
7. A pass with no asset of the move and at most one crate closes as `nothing` ("Nothing to pack"), not flagged.
8. An open pass with no further reads closes on the laptop clock at `last_received_at + gap + 1 s` (the extra second covers `received_at`'s one-second resolution, so it never closes early).
9. The grouper runs in its own 1 s loop, not the 2 s processing tick.
10. Quiet gap accepts whole seconds 1–60.
11. Dock settings survive a move change; Clear Setup and Wipe reset them to the defaults. Pass data is cleared on a move change, on a re-setup as any type other than Dock, on Clear Setup and on Wipe.
12. Kiosk Setup's Confirm step lands on `/dock` for a Dock station. Recent passes show the time of the pass's first read.

## Review Focus

1. **A backlog flush:** the reader buffered while the laptop was down and posts several crates' reads in one batch with one `received_at`. Passes must split by `read_at` gaps exactly as they would live, and none may merge. → Task 6 `test_backlog_batch_splits_by_read_time`.
2. **A read with no or unparseable `read_at`, and the reader's `+0000` offset form:** the grouper falls back to `received_at` and never stalls its cursor or raises. → Task 6 `test_read_time_parsing_and_fallback`.
3. **Dry run flipped mid-stream:** a pass open across the switch stays dry run; passes and scans decided live wait while dry run is on and go once it is off; dry-run reads' scans never go. → Task 5 `test_dry_run_reads_never_queue_scans`, `test_uploader_holds_while_dry_run_on`; Task 6 `test_switch_during_open_pass_keeps_dry_run`; Task 7 `test_idle_while_dry_run_on`.
4. **The setup changes under queued work** (new move, re-setup as RFID, Clear Setup, Wipe): pass data goes, the grouper never groups the old reads, nothing from the old setup is sent, and Wipe counts waiting passes as unsent data. → Task 5 `test_pass_data_cleared_on_setup_changes`.
5. **One pass refused for good while later ones wait, and one that keeps failing:** a refused pass is skipped and later ones go in order; a failing pass holds the line (later passes never jump ahead of it). → Task 7 `test_refused_for_good_skips_to_next`, `test_failure_holds_order`.

---

### Task 1: API — `dock` station type with the RFID Station's treatment

**Files:**
- Create: `api/migrations/versions/0120_dock_station.py`
- Modify: `api/src/serversherpa/db/models.py:1209` (comment), new `DockPass` model after `ContainerAsset` (~line 975)
- Modify: `api/src/serversherpa/services/station_keys.py:21-25` (constants, docstrings)
- Modify: `api/src/serversherpa/api/deps.py:486-500` (docstring only)
- Modify: `api/src/serversherpa/services/device_online.py:39-60,110-115`
- Modify: `api/src/serversherpa/services/fixed_readers.py:1,58`
- Modify: `api/src/serversherpa/api/routes/kiosk.py:536-538` (person heartbeat), `:686-711` (`is_station`, `allowed_scan_types`), `:819-856` (`kiosk_setup` reader branch), `:1501-1512` (client-assets), `:1721-1745` (station heartbeat), `:2866-2885` (`_kiosk_caller`)
- Modify: `api/src/serversherpa/api/schemas.py:3708-3709` (`StationType`)
- Test: create `api/tests/test_kiosk_dock_station.py`; modify `api/tests/test_kiosk_timeclock_station_key.py::test_station_type_constants`, `api/tests/test_device_online.py`

**Interfaces:**
- Produces:
  - `station_keys.DOCK = "dock"`; `STATION_TYPES = ("rfid", "label", TIMECLOCK, DOCK)`; `UPLOAD_STATION_TYPES = ("rfid", "label", DOCK)`; `READER_STATION_TYPES = ("rfid", DOCK)` (laptop stations with a paired reader: telemetry heartbeat, client assets, sounds, off-move alarm).
  - `device_online.is_reader_station(device) -> bool` (laptop kiosk with `station_type in READER_STATION_TYPES`); `covered()` and `covered_clause()` use it; `kind_label` → `"RFID Station"` for rfid, `"Dock Station"` for dock. `is_rfid_station` stays rfid-only.
  - `schemas.StationType = Literal["label", "rfid", "timeclock", "dock"]`.
  - `models.DockPass` (`__tablename__ = "dock_passes"`): `id: uuid.UUID` PK (the laptop's pass id, no default), `device_id` FK `devices.id` `ondelete="CASCADE"` NOT NULL, `container_id` FK `containers.id` `ondelete="SET NULL"` nullable, `closed_at: datetime` NOT NULL, `reply: dict` JSONB NOT NULL, `created_at` `server_default now()`.
- Migration 0120: `ck_devices_station_type` → `station_type IS NULL OR station_type IN ('label', 'rfid', 'timeclock', 'dock')`; create `dock_passes`. Downgrade: drop `dock_passes`, `UPDATE devices SET station_type = NULL WHERE station_type = 'dock'`, restore the three-value check. Docstring in 0105's style, `Design:` line pointing at the spec.

- [ ] **Step 0: Prepare the worktree** (skip any link that exists): `ln -s /Users/jrh1812/Developer/BaseCampV3/portal/node_modules portal/node_modules`, same for `kiosk/node_modules`, `api/.venv`, `.env`; `python3 -m venv kiosk_laptop/edge/.venv && kiosk_laptop/edge/.venv/bin/pip install -e 'kiosk_laptop/edge[dev]'` (the main checkout has no edge venv). Run `test_kiosk_station_key.py` once to confirm the API harness works.
- [ ] **Step 1: Write the failing tests** (`test_kiosk_dock_station.py`, reusing `_station`, `_auth`, `_scan` from `test_kiosk_station_scans.py` and `_device`/`SERIAL` from `test_kiosk_station_key.py`; a `_dock_station(db)` helper sets `station_type="dock"` and reader columns before issuing the key):
  - `test_migration_allows_dock_station_type`: `station_type='dock'` flushes; `'bogus'` still raises IntegrityError.
  - `test_dock_setup_needs_reader_and_laptop`: `POST /kiosk/setup` with `station_type="dock"` and no reader → 422 `reader_required`; an android kiosk with a reader → 422 `rfid_needs_laptop`.
  - `test_dock_setup_stamps_reader_and_key_issues`: setup with a reader → 200; device `station_type == "dock"`, `rfid_reader_serial`/`ip`/`model` stamped, `rfid_paired_at` set; `POST /kiosk/station-key` → 200; re-setup as `rfid` on the same move revokes the key (`station_type_change`).
  - `test_dock_key_syncs_and_uploads`: `/kiosk/station/sync/assets`, `/containers`, `/client-assets` → 200; `POST /kiosk/station/scans` with `off_move: true` → accepted and `off_move` stored.
  - `test_dock_station_heartbeat_keeps_key_and_applies_reader`: `POST /kiosk/station/heartbeat` with a reader snapshot → 200, `last_seen_at` set, a `fixed_reader` Device upserted for the snapshot serial, `station_keys.verify` still returns the device.
  - `test_dock_key_reaches_sounds`: a dock key on `GET /kiosk/sounds/{random uuid}?serial=` → 404 `sound_not_found` (not 403 `not_rfid_station`; see `test_kiosk_sounds_api.py` for the station-key call).
  - `test_dock_scan_type_options_are_rfid_only`: `GET /devices/{id}` for a dock laptop lists only scan types whose label contains "RFID".
  - `test_person_heartbeat_skips_config_on_keyed_dock`: `/kiosk/heartbeat` from the keyed dock laptop's own session answers `config: null`.
  - `test_station_type_constants` (existing, timeclock file): new tuples above and `DOCK == "dock"`.
  - `test_device_online.py::test_dock_station_is_covered_and_named`: `is_reader_station` true for a dock laptop, false for a dock android; `covered` true; the `covered_clause()` query returns it; `kind_label(dock, {}) == "Dock Station"`; rfid still `"RFID Station"`.
- [ ] **Step 2: Run them; expect FAIL** (CHECK violation, 401 on the heartbeat, 403 `not_rfid_station`).
- [ ] **Step 3: Implement.** Every `station_type == "rfid"` / `!= "rfid"` in the files listed becomes `in` / `not in station_keys.READER_STATION_TYPES` (heartbeat recheck, client-assets, `_kiosk_caller`, `fixed_readers.apply_reader_report`); `kiosk_setup`'s reader branch runs for any reader type and stamps `body.station_type`; the person heartbeat and `allowed_scan_types` use `is_reader_station`. Docstrings that say "RFID Station" for these paths say "RFID or Dock Station".
- [ ] **Step 4: Run the new file plus `test_kiosk_timeclock_station_key.py test_kiosk_station_key.py test_kiosk_station_scans.py test_kiosk_station_heartbeat.py test_kiosk_station_setup.py test_kiosk_heartbeat_reader.py test_kiosk_sounds_api.py test_device_online.py test_device_watches.py`; expect PASS.**
- [ ] **Step 5: Commit** `feat(api): dock station type with the RFID Station's key, telemetry and alarm scope (migration 0120)`

### Task 2: API — `POST /kiosk/station/dock/passes`

**Files:**
- Modify: `api/src/serversherpa/api/routes/kiosk.py:1890-2020` (extract helpers from `pack_container_asset`; new route right after it)
- Modify: `api/src/serversherpa/api/schemas.py` (after `KioskContainerAssetOut`, ~line 4285)
- Test: create `api/tests/test_kiosk_dock_passes.py`

**Interfaces:**
- Consumes: Task 1 `station_keys.DOCK`, `models.DockPass`; `deps.station_device(..., types=)`; `enforce_read_only_config`.
- Produces:
  - `async def _current_membership(db, asset_id: uuid.UUID) -> tuple[ContainerAsset | None, Container | None]`
  - `async def _pack_asset(db, container: Container, asset: Asset, membership: ContainerAsset | None, holder: Container | None, *, actor_id: uuid.UUID | None, device: Device, now: datetime, added_at: datetime | None = None, audit_extra: dict | None = None) -> KioskContainerRef | None` — precondition: the asset is not already in `container`. Deletes and flushes the old membership (a move), inserts the new one (`added_at` only when given, else the server default), stamps `updated_at` on both containers, writes the `kiosk_container_pack` audit row (`changes`: `asset_id`, `asset_name`, `from_container`, `device: device.name`, plus `audit_extra`), returns the container it came from. `pack_container_asset` calls both; its behavior and tests are unchanged.
  - `KioskDockPassIn {serial: str (1..120), pass_id: uuid.UUID, container_id: uuid.UUID, closed_at: datetime, asset_ids: list[uuid.UUID] (1..500)}`
  - `KioskDockPassAssetOut {asset_id: uuid.UUID, result: Literal["packed", "moved", "already_there", "refused"], moved_from: KioskContainerRef | None = None, reason: Literal["asset_not_found", "not_on_move", "changed_since_pass"] | None = None}`
  - `KioskDockPassOut {pass_id: uuid.UUID, container: KioskContainerRef, assets: list[KioskDockPassAssetOut], replayed: bool = False, clear_setup: uuid.UUID | None = None}`
  - `POST /kiosk/station/dock/passes` → `KioskDockPassOut`. Order: `station_device(types=(DOCK,))` (403 `wrong_station_type` for other keys) → `enforce_read_only_config` (423) → an existing `dock_passes` row for `pass_id`: another device's → 409 `pass_conflict`; this device's → its stored `reply` with `replayed: true` → container missing or archived → 404 `container_not_found` → container not on the key's move → 403 `move_locked` → key move completed, cancelled or archived → 409 `move_inactive` → insert the `dock_passes` row with `ON CONFLICT (id) DO NOTHING` (nothing inserted: a racing twin; re-read and replay) → per asset, deduped in request order: missing/archived → refused `asset_not_found`; not on the key move's roster (`InitiativeAsset`) → refused `not_on_move`; already in this crate → `already_there`; current membership `added_at` later than the pass time → refused `changed_since_pass`; else `_pack_asset(..., actor_id=None, added_at=pass_at, audit_extra={"via": "dock_pass", "pass_id": str(pass_id)})` → `packed` or `moved` → store the reply on the row, stamp `device.last_seen_at`, commit.
  - `pass_at = min(closed_at (naive read as UTC), now)`. The route writes no `raw_scans`.

- [ ] **Step 1: Write the failing tests** (seed like `_seed` in `test_kiosk_containers_api.py`: a key move with two crates and three roster assets; a `_dock(db)` key helper as in Task 1):
  - `test_pass_packs_assets_into_crate`: two assets → both `packed`; `ContainerAsset` rows in the crate with `added_at == closed_at`; one `kiosk_container_pack` audit per asset with `actor_person_id IS NULL`, `changes.device == device.name`, `changes.via == "dock_pass"`; no new `RawScan` rows.
  - `test_pass_moves_asset_from_other_crate`: asset in crate B, pass for crate A → `moved`, `moved_from == {id: B, name: B.name}`, membership now A.
  - `test_pass_already_there_is_noop`: second pass (new `pass_id`) for the same crate → `already_there`, no new audit rows.
  - `test_pass_replay_returns_stored_reply`: same body twice → identical `assets`, second `replayed: true`, audit count unchanged.
  - `test_pass_refuses_newer_membership`: asset in crate B with `added_at = closed_at + 1 min` → refused `changed_since_pass`, still in B; asset in crate A with a newer `added_at` → `already_there`.
  - `test_pass_asset_refusals`: an off-roster asset → `not_on_move`; an archived asset → `asset_not_found`; an id listed twice appears once.
  - `test_pass_future_closed_at_is_clamped`: `closed_at` one hour ahead → new memberships' `added_at <= now`.
  - `test_pass_container_checks`: archived crate → 404 `container_not_found`; another move's crate → 403 `move_locked`; key move completed → 409 `move_inactive`; nothing written in each case.
  - `test_pass_needs_a_dock_key`: an RFID key → 403 `wrong_station_type`, and the key still verifies.
  - `test_pass_blocked_in_read_only_mode`: 423 `read_only_mode`, no `dock_passes` row, no membership change.
  - `test_pass_id_from_another_device_is_409`.
  - `test_pass_reply_carries_clear_setup`: with a pending Clear Setup id on the device, `clear_setup` equals it.
- [ ] **Step 2: Run; expect FAIL** (404 route).
- [ ] **Step 3: Implement** (extract the helpers first and rerun `test_kiosk_containers_api.py` green before adding the route).
- [ ] **Step 4: Run the new file plus `test_kiosk_containers_api.py test_container_assets_api.py test_kiosk_dock_station.py`; expect PASS.**
- [ ] **Step 5: Commit** `feat(api): station-key Dock pass route packs one pass per transaction, idempotent on the pass id`

### Task 3: Portal — Dock labels, watch and alarm

**Files:**
- Modify: `portal/src/lib/devices.ts:86-90` (`STATION_LABELS`, `STATION_SHORT_LABELS`)
- Modify: `portal/src/lib/kioskConfig.ts:187-197`
- Modify: `portal/src/pages/hardware/KioskDetail.tsx:10,30,189` (watch button)
- Modify: `portal/src/components/notifications/AddGroupWatchModal.tsx:130-139`
- Modify: `portal/src/components/hardware/kiosk/KioskSetupTab.tsx:98-101`
- Modify: `portal/src/lib/api.ts:5139,5306` (station type unions), comments at `:5330,6860,6868`; `portal/src/components/hardware/kiosk/AlarmCard.tsx:1` (comment)
- Test: `portal/src/lib/devices.test.ts`, `portal/src/lib/kioskConfig.test.ts`, `portal/src/pages/hardware/KioskDetail.test.tsx`, `portal/src/components/notifications/AddGroupWatchModal.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`covered` admits a dock laptop, so the API accepts its watch).
- Produces: `STATION_LABELS.dock = 'Dock Station'`, `STATION_SHORT_LABELS.dock = 'Dock'`; `kioskConfig.isReaderStation(d: PlatformBits): boolean` (laptop and rfid or dock); `isRfidStation` stays; `applicableSections` adds `'alarm'` for any reader station; KioskDetail's Watch button and the watch picker use `isReaderStation`, the picker's sub text is `stationLabel(d.station_type)`.

- [ ] **Step 1: Write the failing tests:** `stationLabel('dock') === 'Dock Station'`; `stationTypeLabel({ station_type: 'dock', sub_type: 'laptop' }) === 'Dock · Laptop'`; `isReaderStation` true for a dock laptop, false for a dock android; `applicableSections` of a dock laptop includes `'alarm'`; KioskDetail shows the Watch button for a dock laptop; the watch picker offers a dock laptop with sub `Dock Station`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** The KioskSetupTab note reads `An RFID or Dock Station offers only scan types whose name includes RFID.` and shows for either type.
- [ ] **Step 4: Run the four files, then `npm --prefix portal run build`; expect PASS.**
- [ ] **Step 5: Commit** `feat(portal): Dock Station label, watch button and alarm settings`

### Task 4: Edge — Dock station plumbing (setup, key, telemetry, alarm)

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/laptop_setup.py:36-41` (types, reader)
- Modify: `kiosk_laptop/edge/src/edge/rfid/station_key.py:1-25,134-165`
- Modify: `kiosk_laptop/edge/src/edge/routes/kiosk.py:68-95` (`with_station`, `_station_name`), `:98-112` (docstring)
- Modify: `kiosk_laptop/edge/src/edge/rfid/reader_report.py:118-125,145-153,165-183`
- Modify: `kiosk_laptop/edge/src/edge/routes/proxy.py:128-134`
- Modify: `kiosk_laptop/edge/src/edge/routes/rfid.py:196-209` (alarm gate)
- Modify: `kiosk_laptop/edge/src/edge/rfid/processing.py:14-18,180` (`alarms_on`)
- Modify: `kiosk_laptop/edge/src/edge/sync.py:51-61` (docstring only: a Dock key syncs client assets like RFID)
- Test: create `kiosk_laptop/edge/tests/test_dock_station.py`

**Interfaces:**
- Produces:
  - `laptop_setup.STATION_TYPES = ("label", "rfid", "timeclock", "dock")`, `laptop_setup.READER_TYPES = ("rfid", "dock")`; `save()` accepts `dock` and keeps the paired reader's summary for any `READER_TYPES`.
  - `station_key.STATION_TYPES` gains `"dock"`; `station_key.is_reader_setup(store) -> bool` (type in `laptop_setup.READER_TYPES`), `station_key.is_dock_setup(store) -> bool`. `is_rfid_setup` stays rfid-only (no caller left needs it to be).
  - Reader-specific paths switch to the reader types: `reader_report.build_snapshot`, `current_snapshot`, `send_station_heartbeat` (`is_reader_setup`), `proxy._person_heartbeat`'s `station_beats` (`is_reader_setup`), `routes/rfid.py` `_is_rfid_station` → `_is_reader_station`, `processing.alarms_on`.
  - `with_station` adds the paired reader for any reader type (422 `reader_required` without one); `_station_name("dock") == "Dock Station"`. Dock keeps the reader pairing and its pending scans on setup (it is not in the label/timeclock branch).

- [ ] **Step 1: Write the failing tests** (`test_dock_station.py`, using the fixtures in `conftest.py` and the patterns in `test_station_key.py`, `test_reader_report.py`, `test_rfid_alarm.py`):
  - `test_setup_saves_dock_with_reader`: paired reader + edge `POST /kiosk/setup` with `station_type: "dock"` → the cloud sees the reader in the body; `laptop_setup.load()` has `station_type == "dock"` and the reader; the event detail ends `· Dock Station`; a key is issued.
  - `test_dock_setup_without_pairing_is_422`: `reader_required`.
  - `test_station_heartbeat_sent_for_dock`: dock setup + key → `send_station_heartbeat` posts `/kiosk/station/heartbeat` with the snapshot; `current_snapshot` returns a fresh one.
  - `test_person_heartbeat_carries_no_config_on_keyed_dock`.
  - `test_alarm_route_serves_dock`: an open alarm row → `GET /edge/rfid/alarm` lists it on a dock setup (empty on a label setup).
  - `test_processing_raises_alarm_on_dock`: a fresh off-move read on a dock setup raises the alarm.
  - `test_station_sync_paths_for_dock_include_client_assets`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new file, then the whole edge suite; expect PASS.**
- [ ] **Step 5: Commit** `feat(edge): dock station type gets the RFID Station's reader, heartbeat and alarm paths`

### Task 5: Edge — Dock store, settings and dry run decided at read time

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/db.py` (one new `SCHEMA_STEPS` entry at the end)
- Create: `kiosk_laptop/edge/src/edge/dock/__init__.py` (empty), `kiosk_laptop/edge/src/edge/dock/state.py`
- Modify: `kiosk_laptop/edge/src/edge/rfid/tagreads.py:100-130` (`_INSERT`, `store_batch`)
- Modify: `kiosk_laptop/edge/src/edge/rfid/processing.py:155-230` (dry-run reads)
- Modify: `kiosk_laptop/edge/src/edge/rfid/uploader.py:136-150` (`_drain` holds in dry run)
- Modify: `kiosk_laptop/edge/src/edge/laptop_setup.py:36-60,82-90` (`save`, `clear`)
- Modify: `kiosk_laptop/edge/src/edge/routes/edge.py:20-23,113-135` (`MOVE_TABLES`, `wipe`)
- Test: create `kiosk_laptop/edge/tests/test_dock_state.py`

**Interfaces:**
- Schema step (exact):

```sql
ALTER TABLE raw_tag_reads ADD COLUMN dry_run INTEGER;
CREATE TABLE dock_settings (id INTEGER PRIMARY KEY CHECK (id = 1),
    dry_run INTEGER NOT NULL, quiet_gap_s INTEGER NOT NULL);
CREATE TABLE dock_passes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pass_id TEXT NOT NULL UNIQUE,
    initiative_id TEXT NOT NULL,
    opened_at TEXT NOT NULL, last_new_at TEXT NOT NULL,
    last_new_received_at TEXT NOT NULL, last_received_at TEXT NOT NULL,
    closed_at TEXT, quiet_gap_s INTEGER,
    dry_run INTEGER NOT NULL DEFAULT 0,
    outcome TEXT, container_id TEXT, container_name TEXT,
    asset_count INTEGER NOT NULL DEFAULT 0,
    send_state TEXT NOT NULL DEFAULT 'none',
    packed_count INTEGER NOT NULL DEFAULT 0, moved_count INTEGER NOT NULL DEFAULT 0,
    refused_count INTEGER NOT NULL DEFAULT 0, refuse_code TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
    waiting_for_internet INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    sent_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX dock_passes_send ON dock_passes (send_state, id);
CREATE TABLE dock_pass_tags (pass_id INTEGER NOT NULL, epc TEXT NOT NULL,
    kind TEXT NOT NULL, matched_id TEXT, label TEXT, first_read_at TEXT NOT NULL,
    result TEXT, moved_from TEXT, reason TEXT, PRIMARY KEY (pass_id, epc));
CREATE TABLE dock_pass_reads (pass_id INTEGER NOT NULL, raw_read_id INTEGER NOT NULL,
    PRIMARY KEY (pass_id, raw_read_id));
CREATE TABLE dock_meta (id INTEGER PRIMARY KEY CHECK (id = 1), last_raw_id INTEGER NOT NULL);
INSERT INTO dock_meta (id, last_raw_id) SELECT 1, COALESCE(MAX(id), 0) FROM raw_tag_reads
```

  Times are UTC ISO strings with milliseconds (`read_at`-derived) or `db.iso` seconds (`*_received_at`, `created_at`). `outcome`: NULL while open, then `pack | no_crate | many_crates | nothing`. `send_state`: `none | pending | sent | refused`. `kind`: `asset | container | person | off_move | unknown`. `result`: the API's per-asset `result`.
- `edge.dock.state` (imports only `edge.db`, so `laptop_setup` and `tagreads` can import it):
  - `DEFAULTS = {"dry_run": True, "quiet_gap_s": 5}`, `GAP_RANGE = (1, 60)`
  - `settings(store) -> dict`, `settings_in(c) -> dict` (on an open transaction), `dry_run_on(store) -> bool`
  - `save_settings(store, *, dry_run: bool | None = None, quiet_gap_s: int | None = None) -> dict` — raises `ValueError("dry_run")` / `ValueError("quiet_gap_s")` for a non-bool, a bool posing as an int, or a gap outside `GAP_RANGE`.
  - `clear_passes(c) -> None` — deletes `dock_passes`, `dock_pass_tags`, `dock_pass_reads`; sets the `dock_meta` cursor to `MAX(raw_tag_reads.id)`.
  - `reset(c) -> None` — `clear_passes` plus deleting `dock_settings`.
- `tagreads.store_batch` stamps `dry_run = 1` on every row when `setup["station_type"] == "dock"` and `state.settings_in(c)["dry_run"]`, else NULL.
- `processing.process`: a read with `dry_run = 1` still matches and still raises a fresh off-move alarm, but its pending scan is inserted with `upload_state = 'dry_run'` (the uploader never selects it) and a miss is not added to `rfid_unmatched`.
- `Uploader._drain` returns 0 before anything else while `station_key.is_dock_setup(store) and state.dry_run_on(store)` (no request, no attempt spent).
- Clearing: `laptop_setup.save` calls `state.clear_passes(c)` when the move changes or the new type is not `dock`; `laptop_setup.clear` calls `state.reset(c)`; Wipe adds the four dock tables to `MOVE_TABLES`, resets the `dock_meta` cursor as it does `rfid_processing_meta`, and counts `dock_passes` with `send_state = 'pending'` in its unsent total.

- [ ] **Step 1: Write the failing tests** (`test_dock_state.py`; reuse `seed`/`read` patterns from `test_rfid_processing.py`, with a dock setup):
  - `test_settings_defaults_and_save`: defaults `{dry_run: True, quiet_gap_s: 5}`; saving each field alone keeps the other; `quiet_gap_s` 0, 61, `True`, `"5"` and `dry_run` `1` raise ValueError.
  - `test_reads_stamped_dry_run_only_on_dock`: dock + dry run on → `raw_tag_reads.dry_run == 1`; dock + off → NULL; rfid setup with the dock setting on → NULL.
  - `test_dry_run_reads_never_queue_scans`: a matched dry-run read → pending row `upload_state == 'dry_run'`; a fresh off-move dry-run read raises the alarm; a dry-run miss is not in `rfid_unmatched`; after `save_settings(dry_run=False)` the row is still `dry_run` and `Uploader.due_rows()` is empty.
  - `test_uploader_holds_while_dry_run_on`: dock + key + a live pending row + dry run on → `drain_once()` returns 0 and no request reaches the fake cloud, `attempts` unchanged; dry run off → it sends.
  - `test_pass_data_cleared_on_setup_changes`: with a pass row, its tag and read rows: `laptop_setup.save` to the same move as dock keeps them; to a new move clears them and moves the cursor to the newest raw read; to the same move as rfid clears them; `laptop_setup.clear` clears them and resets settings to defaults; `POST /edge/wipe` with a `pending` pass and no confirm → 409 `outbox_not_empty` whose `pending` counts it, and with `confirm: "WIPE"` clears every dock table.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new file plus `test_db.py test_rfid_processing.py test_rfid_uploader.py test_tagreads.py test_laptop_setup.py test_edge_routes.py`, then the whole edge suite; expect PASS.**
- [ ] **Step 5: Commit** `feat(edge): dock tables and settings; dry run stamped on each read, its scans never uploaded`

### Task 6: Edge — the pass grouper

**Files:**
- Create: `kiosk_laptop/edge/src/edge/dock/grouper.py`
- Modify: `kiosk_laptop/edge/src/edge/rfid/processing.py:76-127` (make the index and match public)
- Modify: `kiosk_laptop/edge/src/edge/background.py` (`_dock_loop`), `kiosk_laptop/edge/src/edge/app.py:110-115` (`app.state.dock_send_wake = asyncio.Event()`)
- Test: create `kiosk_laptop/edge/tests/test_dock_grouper.py`; extend `kiosk_laptop/edge/tests/test_background.py`

**Interfaces:**
- Consumes: Task 5 tables and `state.settings_in`; Task 4 `station_key.is_dock_setup`.
- Produces:
  - `processing.indexes(store, move_id) -> dict | None` and `processing.match(indexes, epc) -> Match | None` (renamed from `_indexes`/`_match`; internal callers updated).
  - `grouper.INTERVAL_S = 1.0`, `grouper.BATCH = 500`
  - `class GroupResult(NamedTuple): scanned: int; closed: int; to_send: int; waiting: bool`
  - `grouper.read_time(raw) -> datetime` — `read_at` parsed with `datetime.fromisoformat` (the reader's `2026-10-16T14:03:22.512+0000` form included), UTC; missing or unparseable → `received_at`.
  - `grouper.classify(indexes, epc) -> tuple[str, str | None, str | None]` — `(kind, matched_id, label)`: `asset` (label: name, else serial number, else asset id), `container` (name), `person` (display name), `off_move` (a client-assets match; name), `unknown`.
  - `grouper.group(store, now: datetime | None = None) -> GroupResult`
  - `Background._dock_loop`: `group()` every `INTERVAL_S`; sets `state.dock_send_wake` when `to_send > 0`; a failure is logged, never fatal; started and stopped with the other loops.
- The rules `group` follows (each pinned by a test below):
  1. Not a Dock setup, or no move: move the `dock_meta` cursor to the newest raw read and return (old reads are never grouped later).
  2. Read up to `BATCH` raw reads after the cursor in id order. A read for another move is skipped (cursor advances). The move's indexes not cached yet → stop without advancing (`waiting`).
  3. For each read, with `t = read_time(raw)` and `gap = quiet_gap_s` from the settings now: if a pass is open and `t - last_new_at > gap`, close it. If none is open, open one (`pass_id = uuid4`, `opened_at = last_new_at = t`). A tag new to the pass gets a `dock_pass_tags` row (from `classify`) and moves `last_new_at` to `max(last_new_at, t)` and `last_new_received_at` to its `received_at`; a re-read only links the read. Every read gets a `dock_pass_reads` row, raises `last_received_at`, and a dry-run read sets the pass's `dry_run`.
  4. When this tick read everything available and a pass is still open, close it once `now >= last_received_at + gap + 1 s`.
  5. Closing: `closed_at = last_new_at + gap`; `quiet_gap_s = gap`; crates = distinct `container` matches, assets = distinct `asset` matches; two or more crates → `many_crates`; one crate and at least one asset → `pack` (with `container_id`, `container_name`, `asset_count`); no crate and at least one asset → `no_crate`; otherwise `nothing`. `dry_run` also becomes 1 if dry run is on now. `send_state = 'pending'` only for a `pack` that is not dry run, else `none`.
  6. Each tick's writes and the cursor move happen in one transaction.

- [ ] **Step 1: Write the failing tests** (`test_dock_grouper.py`; helpers write raw reads with explicit `read_at` and `received_at` through `tagreads.store_batch` and `fake_reader.tag_event(..., timestamp=...)`; dry run off unless stated):
  - `test_one_crate_pass_packs`: three asset tags then the crate tag within 2 s, then idle → one pass `pack`, crate set, `asset_count == 3`, `send_state == 'pending'`, `closed_at == last_new_at + 5 s`, `to_send == 1`.
  - `test_read_order_does_not_matter`: crate tag first gives the same outcome.
  - `test_quiet_gap_closes_and_new_tag_opens_next_pass`: tags at +0 s and +3 s share a pass; a tag at +9 s opens a second.
  - `test_rereads_do_not_extend_pass`: A at 0, B at 1, A again at 4 and 5.5, A at 6.2 → the first pass closes with `closed_at` = 1 + 5 s and A at 6.2 opens a new pass.
  - `test_no_crate_is_flagged` → `no_crate`; `test_two_crates_are_flagged` → `many_crates`, nothing pending.
  - `test_other_move_crate_reads_as_unknown`: the only crate tag belongs to another move → tag `unknown`, outcome `no_crate`.
  - `test_people_off_move_and_unknown_are_ignored_for_packing`: kinds stored as `person`, `off_move`, `unknown`; outcome from assets and crates only; a pass of only those → `nothing`; one crate with no assets → `nothing`.
  - `test_dry_run_pass_is_never_pending`: dry run on → `pack`, `dry_run == 1`, `send_state == 'none'`.
  - `test_switch_during_open_pass_keeps_dry_run`: first read in dry run, later reads after switching off → the pass is dry run; the next pass is live.
  - `test_closed_while_dry_run_on_is_dry`: live reads, dry run switched on before the close → dry run.
  - `test_backlog_batch_splits_by_read_time`: one `store_batch` call (one `received_at`) carrying three crates' reads 8 s apart in `read_at` → three passes, the first two closed in the same tick, the third closed only by the idle rule.
  - `test_read_time_parsing_and_fallback`: `+0000` parses to UTC; a missing `timestamp` and `"garbage"` both use `received_at`; the cursor still advances.
  - `test_idle_close_waits_gap_plus_one_second`: `now = last_received_at + 5 s` → still open; `+ 6 s` → closed.
  - `test_waits_for_move_cache`: no cached sync body → cursor unchanged, `waiting`.
  - `test_not_dock_setup_skips_reads`: reads under an rfid setup, then a switch to dock on the same move → none of them is grouped.
  - `test_background.py`: a `Background` tick with a closable pending pass sets `dock_send_wake`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new file plus `test_rfid_processing.py test_background.py`, then the whole edge suite; expect PASS.**
- [ ] **Step 5: Commit** `feat(edge): group curtain reads into dock passes by the reader's read time`

### Task 7: Edge — the pass sender

**Files:**
- Create: `kiosk_laptop/edge/src/edge/dock/sender.py`
- Modify: `kiosk_laptop/edge/src/edge/config_sync.py` (`server_offset_ms(store) -> int | None`)
- Modify: `kiosk_laptop/edge/src/edge/background.py` (`_dock_send_loop`)
- Test: create `kiosk_laptop/edge/tests/test_dock_sender.py`

**Interfaces:**
- Consumes: Task 2 route and reply shape; Task 5 tables and `state.dry_run_on`; Task 6 `dock_send_wake`; `uploader.GAPS`, `PROBE_AFTER`, `WAIT_S`, `PAUSE_S`, `_code`, `probe_200`; `station_key.station_request`, `station_key.apply_clear_setup`.
- Produces:
  - `sender.PATH = "/kiosk/station/dock/passes"`, `sender.INTERVAL_S = 5.0`
  - `class DockSender: __init__(self, store, st, *, clock=time.time, probe=None)`; `async def send_once(self) -> bool` (True when a pass got a final answer, so the loop may go straight on to the next).
  - Each call looks only at the oldest `pending` pass (`ORDER BY id`); if it is not due yet nothing is sent (later passes wait behind it). Nothing is sent when the setup is not Dock, there is no key, or dry run is on.
  - Body: `{"serial", "pass_id", "container_id", "closed_at": closed_at + server_offset_ms (ISO, ms), "asset_ids": distinct asset `matched_id`s in first-read order}`.
  - Answers: 200 → each asset tag row gets `result`, `moved_from` (the name), `reason`; the pass gets `packed_count` (packed + moved), `moved_count`, `refused_count`, `send_state = 'sent'`, `sent_at`; a `clear_setup` in the reply applies Clear Setup. 401, 423 and 403 `kiosk_not_registered` → `last_error = code`, due again after `PAUSE_S`, no attempt spent. No key mid-send (`None`) → nothing changes. `CloudOffline`, any exception, 5xx, 429 → a failed attempt with `GAPS` and the probe gate after `PROBE_AFTER` attempts, as `Uploader._failed` does. Any other 4xx → `send_state = 'refused'`, `refuse_code = code`; the next pass is due at once.
  - `config_sync.server_offset_ms(store)` reads `device_config.server_offset_ms` (None when unknown; the sender then adds 0).
  - `Background._dock_send_loop`: `send_once()` every `INTERVAL_S` or on `dock_send_wake`; straight on while it returns True.

- [ ] **Step 1: Write the failing tests** (`test_dock_sender.py`; fake cloud with `respx`, a `Clock` like `test_rfid_uploader.py`, pass rows inserted directly):
  - `test_sends_pass_under_station_key`: `Authorization: Station <key>`; body fields as above with `closed_at` shifted by a stored `server_offset_ms` of 1500; a reply with one `packed`, one `moved` (from `Crate B`), one refused `changed_since_pass` → tag rows hold them; counts 2/1/1; `send_state == 'sent'`.
  - `test_one_at_a_time_in_order`: two pending passes → the first call sends the older only.
  - `test_failure_holds_order`: a 500 → `attempts == 1`, due after `GAPS[0]`; the next call before then sends nothing (the newer pass waits).
  - `test_refused_for_good_skips_to_next`: 404 `container_not_found` → `refused` with that code; the next call sends the newer pass.
  - `test_pause_codes_spend_no_attempt`: 401, 423 and 403 `kiosk_not_registered` → `attempts == 0`, due after `PAUSE_S`.
  - `test_probe_gate_after_five_failures`: `attempts == 5` and a failing probe → `waiting_for_internet == 1`, no send.
  - `test_idle_while_dry_run_on`, `test_idle_without_key`, `test_idle_when_not_dock`: no request.
  - `test_clear_setup_in_reply_applies`: the shared setup and key are gone afterwards.
  - `test_unknown_offset_sends_reader_close_time`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new file plus `test_rfid_uploader.py test_config_sync.py test_background.py`, then the whole edge suite; expect PASS.**
- [ ] **Step 5: Commit** `feat(edge): send closed dock passes in order under the station key`

### Task 8: Edge — `/edge/dock` routes

**Files:**
- Create: `kiosk_laptop/edge/src/edge/dock/views.py`, `kiosk_laptop/edge/src/edge/routes/dock.py`
- Modify: `kiosk_laptop/edge/src/edge/app.py` (include the router)
- Test: create `kiosk_laptop/edge/tests/test_dock_routes.py`

**Interfaces:**
- Consumes: Tasks 5–7 tables and `state.save_settings`.
- Produces (router `APIRouter(prefix="/edge/dock", dependencies=[Depends(require_session)])`):
  - `GET /edge/dock` → `{"settings": {"dry_run": bool, "quiet_gap_s": int}, "open": OpenPass | null, "passes": [PassRow, ...]}` (the newest 50 closed passes, newest first).
    - `OpenPass = {"id": int, "opened_at": str, "seconds_left": float, "crate_count": int, "asset_count": int, "tags": [{"epc", "kind", "label"}]}`; `seconds_left = max(0, gap - (now - last_new_received_at))`.
    - `PassRow = {"id": int, "opened_at": str, "closed_at": str, "status": str, "flag": "no_crate" | "many_crates" | null, "dry_run": bool, "container_name": str | null, "asset_count": int, "moved_count": int, "refused_count": int, "refuse_code": str | null}`; `status` is the first that applies: `flagged` (outcome `no_crate`/`many_crates`, which is also `flag`), `nothing`, `would_pack` (dry run), `waiting` (pending), `packed` (sent), `refused`.
  - `GET /edge/dock/passes/{id}` → `{"pass": PassRow, "tags": [{"epc", "kind", "label", "result", "moved_from", "reason"}], "reads": [{"id", "read_at", "epc", "kind", "antenna", "peak_rssi"}]}` (reads in id order; `read_at` is `grouper.read_time` as ISO); unknown id → 404 `pass_not_found`.
  - `PUT /edge/dock/settings` body `{"dry_run"?: bool, "quiet_gap_s"?: int}` → the saved settings; bad values → 422 `invalid_dock_settings`.

- [ ] **Step 1: Write the failing tests:** all three routes 401 without an edge session; the overview's open pass (`seconds_left` with a pinned clock, tags) and one closed pass per `status` value; the detail's tags with results and reads with antenna and signal; 404 `pass_not_found`; settings saved and 422 `invalid_dock_settings`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** (views take `now` for testability; routes call them with `datetime.now(UTC)`).
- [ ] **Step 4: Run the new file, then the whole edge suite; expect PASS.**
- [ ] **Step 5: Commit** `feat(edge): /edge/dock overview, pass detail and settings`

### Task 9: Kiosk — Dock station type, setup path, Home tiles, alarm and edge client

**Files:**
- Modify: `kiosk/src/lib/kioskSetup.ts:35-66` (type, label, `normalize`, `isReaderStation`)
- Modify: `kiosk/src/lib/laptopSetup.ts:52-68` (`selectionFromEdge`)
- Modify: `kiosk/src/lib/features.ts` (`'dock'` id, `DOCK_FEATURE`, `STATION_TILES.dock`, `homeFeatures`)
- Modify: `kiosk/src/lib/api.ts:366-372,1133` (unions), new Dock types and functions near the alarm calls (~line 1290)
- Modify: `kiosk/src/components/setup/StationTypeStep.tsx` (fourth card)
- Modify: `kiosk/src/pages/KioskSetup.tsx:90-95,155-160,405-440,491,603,761`
- Modify: `kiosk/src/layout/KioskShell.tsx:84,226`, `kiosk/src/components/ThisKioskPanel.tsx:99`
- Test: `kiosk/src/lib/kioskSetup.test.ts`, `kiosk/src/lib/laptopSetup.test.ts`, `kiosk/src/lib/features.test.ts`, create `kiosk/src/lib/api.dock.test.ts`, create `kiosk/src/pages/KioskSetup.dock.test.tsx`, `kiosk/src/layout/KioskShell.test.tsx`, `kiosk/src/components/ThisKioskPanel.test.tsx`

**Interfaces:**
- Consumes: Task 4 (edge setup accepts `dock`), Task 8 routes.
- Produces:
  - `StationType = 'label' | 'rfid' | 'timeclock' | 'dock'`; `isReaderStation(t: StationType | '' | undefined): boolean` (rfid or dock); `stationLabel('dock', m)` → `` `Dock · ${m}` ``; `normalize` and `selectionFromEdge` keep `dock` and its reader.
  - `DOCK_FEATURE = { id: 'dock', path: '/dock', title: 'Dock', blurb: 'Watch crates pass the curtain and what each one packed.' }`; `STATION_TILES.dock = ['dock', 'rfid', 'setup', 'settings']`.
  - `api.ts`: `type DockTagKind = 'asset' | 'container' | 'person' | 'off_move' | 'unknown'`; `type DockPassStatus = 'would_pack' | 'waiting' | 'packed' | 'refused' | 'flagged' | 'nothing'`; `interface DockSettings`, `DockOpenPass`, `DockPassRow`, `DockOverview`, `DockPassDetail` mirroring Task 8 field for field; `getDock(): Promise<DockOverview>`, `getDockPass(id: number): Promise<DockPassDetail>`, `saveDockSettings(s: Partial<DockSettings>): Promise<DockSettings>` (`apiFetch` + `jsonFrom`, as `getOffMoveAlarm` does).
  - Card: title **Dock Station**, meta `Packs crates read at an RFID curtain. Next: Select reader → Connect → Pair, then the move.`
  - Every reader-specific `=== 'rfid'` in `KioskSetup.tsx`, `ThisKioskPanel.tsx` and `KioskShell.tsx` (`OffMoveAlarm` mount) uses `isReaderStation`; `pathFor(true, 'dock')` equals the RFID path; the RFID-only scan type filter and its empty hint apply to Dock; ConfirmStep's `onStarted` navigates to `/dock` for Dock, `/rfid_status` for RFID.
  - `KioskShell` forces the dark theme on `/dock` as on `/rfid_status`.

- [ ] **Step 1: Write the failing tests:** `stationLabel('dock', 'Laptop') === 'Dock · Laptop'`; a stored dock selection with a reader round-trips; `selectionFromEdge` maps a dock edge setup with its reader; `homeFeatures(true, 'dock')` ids `['dock', 'rfid', 'setup', 'settings']`; `getDock`, `getDockPass(7)`, `saveDockSettings({ dry_run: false })` hit `/edge/dock`, `/edge/dock/passes/7` and `PUT /edge/dock/settings` with that body; Kiosk Setup shows the **Dock Station** card and choosing it walks Select reader first, offers only RFID scan types, and Confirm's start lands on `/dock`; KioskShell mounts the off-move alarm and the dark theme for a dock laptop on `/dock`; ThisKioskPanel shows the reader row for a dock setup.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run those files plus `src/pages/KioskSetup.test.tsx src/pages/Home.test.tsx`, then the full kiosk suite (`npm --prefix kiosk test`) and `npm --prefix kiosk run build`; expect PASS.**
- [ ] **Step 5: Commit** `feat(kiosk): Dock station type in Kiosk Setup, Home tiles, alarm and edge client`

### Task 10: Kiosk — the Dock screen (`/dock`)

**Files:**
- Create: `kiosk/src/pages/DockStation.tsx`, `kiosk/src/components/DockPassModal.tsx`
- Modify: `kiosk/src/App.tsx` (route), `kiosk/src/pages/RfidStatus.tsx:45` (export `clockText`), `kiosk/src/styles/kiosk.css` (a `/* ── Dock screen ── */` section after the RFID dashboard's)
- Test: create `kiosk/src/pages/DockStation.test.tsx`

**Interfaces:**
- Consumes: Task 9 `getDock`, `getDockPass`, `saveDockSettings`, `isReaderStation`, `useKioskSetup`; `displayEpc` and `clockText` from `pages/RfidStatus`; `Switch`; `useFitRows`.
- Produces:
  - Route `/dock` → `<KioskGuard><KioskShell><DockStation /></KioskShell></KioskGuard>` beside `/rfid_status`. Web mode, or a setup that isn't Dock, → `<Navigate to="/" replace />`.
  - `DockStation`: polls `getDock()` 1 s after the previous poll settles (never overlapping). Layout inside `portal-page rfid-dash dock-dash`:
    - Controls row: **Dry run** `Switch` (hint `Passes are shown here and nothing is sent to the portal.`); **Quiet gap** number field (`1–60 seconds`, the alarm-seconds field's look) with a **Save** `mini-btn`, enabled when the value differs; an invalid value shows the hint as an error and saves nothing. A failed save shows `Couldn't save. Try again.`
    - While dry run is on, a banner: `Dry run · nothing is sent to the portal.`
    - **Open pass** panel: `Waiting for tags…` when none; else `Closes in {ceil(seconds_left)} s` (`Closing…` at 0), crate and asset counts, and its tags (kind chip, label or `Unknown tag`, `displayEpc(epc)`), filling in live.
    - **Recent passes** panel: rows fitted with `useFitRows` (no scroll box); columns Time (`clockText` of `opened_at`), Crate, Assets, Outcome, Moved, and a **Details** `mini-btn` per row. Outcome copy: `would_pack` → `Would pack {asset_count} into {container_name}`; `waiting` → `Waiting to send`; `packed` → `Packed`, plus ` · {refused_count} not packed` when any were refused; `refused` → `Not packed: {reason}` (`container_not_found` → `crate not found in the portal`, `move_locked` → `crate is on another move`, `move_inactive` → `the move is closed`, otherwise the code); `flagged` → `Flagged: No crate read` / `Flagged: More than one crate`; `nothing` → `Nothing to pack`. Flagged and refused rows carry `is-flagged` (red left edge and outcome text).
  - `DockPassModal({ passId, onClose })`: the Global Constraints modal shell with eyebrow `Dock pass`, title `Pass at {HH:MM:SS}`, hint = the row's outcome text; a **Packing** table (Asset, Result: `Packed` / `Moved from {crate}` / `Already there` / `Not packed: Changed since this pass` / `Not packed: not on this move` / `Not packed: not found in the portal` / `Would pack` in dry run / `Waiting to send` while pending / `Not sent` for a flagged or refused pass) and a **Reads** table (Time `HH:MM:SS`, Tag via `displayEpc`, Matched (`Asset {label}` / `Crate {label}` / `Person` / `Off-move asset` / `Unknown`), Antenna, Signal `{peak_rssi} dBm`). Escape and the close button close it; the card scrolls inside `.modal-card` (chrome.css's themed bar).

- [ ] **Step 1: Write the failing tests** (`DockStation.test.tsx`, mocked api, fake timers):
  - web mode and a non-Dock setup both navigate home.
  - an open pass renders `Closes in 3 s` from `seconds_left: 2.4` and its tag labels; none renders `Waiting for tags…`.
  - one recent row per status renders the copy above; the time cell reads `14:03:22` for a local 14:03:22 (no AM/PM); flagged and refused rows have `is-flagged`.
  - toggling **Dry run** calls `saveDockSettings({ dry_run: false })`; the banner shows only while on.
  - typing 8 and pressing **Save** calls `saveDockSettings({ quiet_gap_s: 8 })`; 0 shows the hint as an error and calls nothing.
  - **Details** opens the modal with eyebrow `Dock pass`, a read row with the trimmed tag and `-52 dBm`, and `Moved from Crate B`; the close button closes it.
  - a second poll starts 1 s after the first settles.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new file plus `src/pages/RfidStatus.test.tsx`, then the full kiosk suite and `npm --prefix kiosk run build`; expect PASS.**
- [ ] **Step 5: Commit** `feat(kiosk): Dock screen with the open pass, recent passes, pass detail, dry run and quiet gap`

---

## After the tasks (controller)

1. Whole-branch review (subagent-driven-development's final review) and fix rounds.
2. Gates: the edge suite; kiosk suite and build; portal suite and build; every API test file the tasks touched plus `test_kiosk_*.py test_device*.py`, foreground. The full API suite (over 2 hours, foreground) runs once before merge, not during the tasks.
3. Live verify on the branch stack (the kiosk-laptop recipe in memory): migrate a dev database to 0120, run the branch API and the laptop container against it, set up a Dock station on the move Jimmy tagged, post scripted tag batches to the edge's 8091 ingest with `fake_reader.tag_event` (a crate with assets, a no-crate pass, a two-crate pass, an off-move asset), watch `/dock` in dark mode, open a pass, then turn dry run off and confirm the crate's contents in the portal. Screenshot the screen and the modal (check the corners). Then the real FX9600 at 10.10.48.119 with Jimmy.
4. Append `## Implementation notes` to the spec: the decisions list above, migration 0120 (`dock_passes`), the route and `/edge/dock` shapes, and anything the review changed.
5. Stop and tell Jimmy it is ready to try on a dock. Merge, push, the parity sheet, Harbor Master and the Features wiki page wait for his trial (the spec merges only after it).
