# Kiosk Settings in the Portal — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each kiosk's settings live in the portal as one versioned config document. Web and laptop kiosks sync it on their existing check-ins, with newest-whole-config-wins. Super admins edit it on a new kiosk details page. Uploaded sounds live in Spaces.

**Architecture:**
- **API:** a `kiosk_config` service owns the document (schema, defaults, validation and the merge rule), stored on the `devices` row with migration 0099. The person heartbeat and the station heartbeat carry the sync fields. Portal routes serve the details page, config edit, history, scan type and sounds.
- **Web kiosk:** a `lib/kioskConfig.ts` module builds the document from the kiosk's local stores, applies a received one, and marks local changes.
- **Laptop:** the edge is the device. It holds the config in SQLite, syncs it on both check-ins (proxy and station), applies the `alarm` section itself, and serves it to the laptop's browsers, which read and write through the edge.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic (API), React (portal, kiosk), FastAPI + sqlite3 (edge), Spaces via `services/storage.py`.

**Spec:** `docs/superpowers/specs/2026-10-17-kiosk-config-in-portal-design.md`. Phase 1 covers §7 item 1: everything except Android and iOS.

## Global Constraints

**Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/kiosk-config`, branch `kiosk-config`.

**Setup**, only if something is missing:
- `cd kiosk_laptop/edge && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`
- `npm --prefix kiosk ci && npm --prefix portal ci`
- API tests need two symlinks: `api/.venv` → `/Users/jrh1812/Developer/BaseCampV3/api/.venv`, and `.env` → `/Users/jrh1812/Developer/BaseCampV3/.env`. Remove both after committing and never stage them.

**Git:** stage by explicit path only. Never stage `.superpowers/`, `.venv`, `node_modules` or `.env`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Suites:** run every suite in the FOREGROUND with a 600000 ms timeout, and never background one.
- API: `cd api && SS_TEST_DB=serversherpa_test_kiosk_config PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -p no:cacheprovider <files>`
- Edge: `cd kiosk_laptop/edge && .venv/bin/pytest -q -p no:cacheprovider`
- Kiosk: `npm --prefix kiosk test -- --run`, then `npm --prefix kiosk run build`
- Portal: `npm --prefix portal test -- --run <files>`, then `npm --prefix portal run build`

**Migration:** `0099_kiosk_config.py`, `revision="0099"`, `down_revision="0098"`. 0099 is free in every worktree and on the dev DB.

**Edge:** `SCHEMA_STEPS` is append-only.

**Copy:** American English.

**Portal UI:**
- Reuse the portal idioms: detail-page route pattern (like `/people/users/:personId`), tab strip, cards, the modal header pattern sized to content, ComboBox/segmented/chips. No raw native controls in the portal.
- Lists follow the column-floor rules.

**Permissions:**
- View needs `scanning_hardware:view`.
- Every write on the details page (config edit, reset, scan type, sound upload or delete in the portal) needs `scanning_hardware:change` **and** `actor.access.max_rank >= 80` (super admin). Otherwise the answer is 403 `forbidden_rank`, following the explicit rank check in `devices.py` (`/kiosks/clear-offline`).
- Kiosk-side sync and sound transfer use the kiosk's existing auth: a person session with `kiosk:view`, or the station key.

**Fixed values (spec):**
- `schema: 1`.
- Sections: `appearance`, `sound`, `checkpoints`, `developer`, `alarm`, `android_rfid`, `ios`. Unknown or other-platform sections pass through untouched.
- Defaults equal the kiosk's current defaults:
  - appearance: good h150 s60 l45, not_found h0 s70 l50, duplicate h38 s92 l50, flash_ms 350 (range 100–2000);
  - sound: good chime, not_found buzz, duplicate double_beep, alarm siren, volume 0.8;
  - checkpoints: enroll `pre_stage`, container_pack `in_container`, container_unpack `un_pack`, truck_load `on_truck`, truck_unload `received`;
  - developer: dev_mode false;
  - alarm: `until_dismissed`, 10 s (3–600).
- **Report interval:** a full report at registration (first beat) and every 60 minutes.
- **Clock:** the server time is in every check-in reply, and the kiosk stamps changes with its corrected time.
- **Merge rule:** the whole config is stored when the incoming `changed_at` is later than the stored `changed_at`. Otherwise the stored config stays. A stored version means a portal edit made before the kiosk's first report; that edit beats a kiosk report with no stamp.
- **Sounds:** audio only, 2 MB max, stored in Spaces; configs name them by portal id.
- **Scan type:** portal-editable; limited to the move's scan types, and on an RFID Station only labels containing "RFID".
- **Page:** `/hardware/kiosks/:id` with tabs Overview, Settings, Devices, Setup & move, History.
- **Sync line copy:** "In sync" / "Pending on kiosk" / "Waiting for first report".

## Review Focus

1. **A wrong kiosk clock can't win.** The kiosk stamps changes with portal-corrected time. A report from a kiosk whose clock is days ahead is still judged on corrected time. (Tasks 2, 5, 6.)
2. **First contact never wipes settings silently.** An unstamped first report is stored unless the portal was edited before it. That portal edit is applied to the kiosk and the report is not stored. (Tasks 1, 2.)
3. **The config passes through whole.** A web kiosk never drops the `alarm`, `android_rfid` or `ios` sections it doesn't use. A round trip keeps them byte-for-byte. (Tasks 1, 5, 6.)
4. **A bad value never breaks sync.**
   - An out-of-range value or unknown sound id in a kiosk report is replaced by its default, and the rest is kept.
   - A bad portal edit is refused with a clear 422.
   - A kiosk receiving a value it can't apply keeps its previous value for that field and never crashes. (Tasks 1, 3, 5.)
5. **The rank gate holds on the API,** not only in the UI. Admins (rank 60) get 403 on every write. (Task 3.)

---

### Task 1: API — config document, storage and merge rule

**Files:**
- Create: `api/migrations/versions/0099_kiosk_config.py`
  - On `devices`, add: `config` JSONB null, `config_version` int not null default 0, `config_changed_at` timestamptz null, `config_source` text null (`kiosk`/`portal`), `config_changed_by` uuid null (FK people), `config_reported_at` timestamptz null, `config_applied_version` int null.
  - New table `kiosk_sounds`: id uuid pk, name text, content_type text, size int, storage_key text unique, uploaded_by uuid null FK people, uploaded_from_device uuid null FK devices on delete set null, created_at.
- Modify: `api/src/serversherpa/db/models.py`.
- Create: `api/src/serversherpa/services/kiosk_config.py`
- Test: `api/tests/test_migration_0099_kiosk_config.py`, `api/tests/test_kiosk_config_service.py`
  - Bump the head-revision asserts in any migration test that pins the head.

**Interfaces** (produces, in `services/kiosk_config.py`):
- `DEFAULT_CONFIG: dict`, the full schema-1 document from the Fixed values.
- `normalize(doc: dict | None, *, known_sounds: set[str], strict: bool) -> dict`.
  - It returns a complete document: missing fields are filled with defaults, and unknown sections are kept as they are.
  - With `strict=True` it raises `ConfigError(field, message)` on a bad value (used for portal edits).
  - With `strict=False` it replaces a bad value with its default (used for kiosk reports).
- `async def accept_kiosk_report(db, device, doc, changed_at: datetime | None, *, now) -> bool`. It applies the merge rule (Fixed values / Review Focus 2) and returns whether it stored the report.
  - When it stores one: `config_version += 1`, source `kiosk`, `config_changed_at` set to `changed_at`, or `now` when unstamped on first contact. It also writes a `config_change` audit with a field-level diff.
  - It always sets `config_reported_at = now`.
- `async def apply_portal_edit(db, device, doc, *, actor_id, now) -> None`: strict normalize, `version += 1`, source `portal`, changed_at `now`, changed_by, and a `config_change` audit.
- `def reply_fields(device, applied_version: int | None) -> dict`. It returns `{"config_version": int, "config": doc-or-None}`, with the doc included only when `applied_version` is lower than `config_version`.

- [ ] **Step 1: Write the failing tests.**
  - The migration upgrades and downgrades cleanly.
  - `normalize` fills defaults, keeps unknown sections, refuses in strict mode, and defaults in lenient mode (an out-of-range `flash_ms`, an unknown sound id).
  - Merge rule cases:
    - newer kiosk config stored;
    - older one ignored;
    - unstamped first report stored when there is no portal edit;
    - unstamped first report ignored after a portal edit;
    - every accepted change bumps the version and writes the audit diff.
  - `reply_fields` includes the doc only when the kiosk is behind.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new files and the migration tests. They pass.**
- [ ] **Step 5: Commit** `feat: kiosk config document on devices, kiosk_sounds, merge rule (migration 0099)`.

### Task 2: API — sync on check-ins, kiosk sound transfer, scan type push

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py`
  - `HeartbeatIn` and `KioskStationHeartbeatIn` gain `config: dict | None` (bounded in size, 64 KB), `config_changed_at: datetime | None` and `config_applied_version: int | None`.
  - `HeartbeatOut` and `KioskStationHeartbeatOut` gain `server_time: datetime`, `config_version: int`, `config: dict | None`, `scan_status: str | None` and `scan_status_label: str | None`. The scan fields are always sent when the device has a scan type.
- Modify: `api/src/serversherpa/api/routes/kiosk.py`
  - Both heartbeats call `accept_kiosk_report` when `config` is present. They record `config_applied_version`, return `reply_fields`, and return `server_time`.
  - Add kiosk sound routes.
- Test: `api/tests/test_kiosk_config_sync.py`, `api/tests/test_kiosk_sounds_api.py`

**Interfaces:**
- `POST /kiosk/sounds` (multipart `file`, kiosk:view or station key): audio only, 2 MB max. It stores the file in Spaces under `kiosk-sounds/<uuid>`, creates a `kiosk_sounds` row, and returns `{id, name, content_type, size}`.
- `GET /kiosk/sounds/{id}` (kiosk:view or station key): streams the file, or 302s to a presigned URL. 404 for an unknown id.

- [ ] **Step 1: Write the failing tests.**
  - A heartbeat with a newer config stores it and the reply carries the new version.
  - A kiosk behind gets the doc.
  - A kiosk in sync gets `config: null`.
  - `server_time` is present.
  - A station heartbeat syncs the same way.
  - An oversized config gets 422.
  - Sound upload rejects non-audio and >2 MB, and a stored sound downloads.
  - The scan type is echoed on the heartbeat reply.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** Reuse `services/storage.py`, and match how other routes upload to Spaces.
- [ ] **Step 4: Run the new tests and the kiosk heartbeat, station heartbeat and storage tests. They pass.**
- [ ] **Step 5: Commit** `feat: kiosk config sync on check-ins; kiosk sound upload and download`.

### Task 3: API — details page routes for the portal

**Files:**
- Modify: `api/src/serversherpa/api/routes/devices.py` and `schemas.py`.
- Test: `api/tests/test_devices_config_api.py`

**Interfaces:**
- `GET /devices/{id}` (view): the `DeviceItem` plus `config`, `config_version`, `config_changed_at`, `config_source`, `config_changed_by_name`, `config_reported_at`, `config_applied_version`, and `sync_state` (`in_sync` / `pending` / `waiting_first_report`). It also returns `setup` (move, site and station type names) and `scan_type_options` (the allowed scan types, by the same rule as Kiosk Setup).
- `PUT /devices/{id}/config` (change + rank 80): takes the full document, applies strict normalize, and returns the detail. A bad value gets 422 `{code:"bad_config", field, message}`.
- `POST /devices/{id}/config/reset` (change + rank 80): stores `DEFAULT_CONFIG` as a portal edit.
- `PATCH /devices/{id}/scan-type` with `{scan_status}` (change + rank 80): 422 when the scan type isn't in the allowed options. It writes an audit.
- `GET /devices/{id}/config/history` (view): the `config_change` audits, newest first, as `{at, source, by_name, changes}`.
- `GET /kiosk-sounds` (view): the sound list. `POST /kiosk-sounds` (change + rank 80): upload. `DELETE /kiosk-sounds/{id}` (change + rank 80): 409 `in_use` while any device config names the sound.

- [ ] **Step 1: Write the failing tests.**
  - Each route's happy path.
  - Admin (rank 60) gets 403 `forbidden_rank` on every write; super admin succeeds.
  - Staff can view.
  - A bad config gets 422 with the field.
  - A bad scan type gets 422.
  - Deleting a sound in use gets 409.
  - History shows both portal and kiosk changes.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new tests and the devices test files. They pass.**
- [ ] **Step 5: Commit** `feat: kiosk details, config edit, scan type, history and sound routes`.

### Task 4: Portal — the kiosk details page

**Files:**
- Create: `portal/src/pages/hardware/KioskDetail.tsx`, plus one component per tab and section card under `portal/src/components/hardware/kiosk/`, with tests.
- Modify:
  - `portal/src/App.tsx`: the route `/hardware/kiosks/:id`, under `ProtectedRoute resource="scanning_hardware"`.
  - `KioskDevices.tsx`: the kiosk name links to the page.
  - The portal api client.

**Interfaces:**
- **Tabs:**
  - **Overview:** status, type, station, version, registration, signed-in person, last check-in, last full report, and the sync line.
  - **Settings:** one card per applicable section (`alarm` only on laptop RFID Stations; `android_rfid`/`ios` only on those platforms, read-only in phase 1 with "Settings not reported by this app version yet" when absent).
    - Each card shows its values (color swatches, sound names with Play, checkpoints by label) and its source line ("changed on the portal by X · age" / "changed on the kiosk · age").
    - For rank 80+, each card has an Edit button that opens a modal with the matching controls.
    - Reset to defaults asks for confirmation first.
    - Sounds can also be uploaded from the sound card.
  - **Devices:** the reader and printer details from `raw_info` and the device row. Read-only.
  - **Setup & move:** move, site and station read-only, plus a scan type picker for rank 80+.
  - **History:** a table with columns At / Source / By / Changes.

- [ ] **Step 1: Write the failing tests.**
  - The page renders all tabs from a mocked detail.
  - Edit is hidden below rank 80.
  - An edit saves the full document with only that section changed.
  - A 422 shows the field error.
  - The sync line shows each of the three states.
  - The Kiosk Devices name links to the page.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** Match the portal's existing detail pages and modal header pattern, and use ages with the full time on hover (`ageText`/`fullDateTime`).
- [ ] **Step 4: Run the new portal tests and the portal build. Both pass.**
- [ ] **Step 5: Commit** `feat(portal): kiosk details page with settings editing for super admins`.

### Task 5: Web kiosk — build, apply and sync the config

**Files:**
- Create: `kiosk/src/lib/kioskConfig.ts` and its test.
- Modify: `kiosk/src/lib/heartbeat.ts`, `sound.ts` (portal-backed uploads and a download cache), and the setup store, so the scan type updates.

**Interfaces:**
- `collectConfig(): ConfigDoc` builds the document from appearance, sound, checkpoints and devMode, plus the last received unknown sections, kept verbatim.
- `applyConfig(doc, version)` writes each store. A field it can't apply keeps its old value. It records the applied version and never fires a "local change".
- Local change tracking: subscribing to the stores marks the config dirty with `changed_at = Date.now() + serverOffset`.
- Heartbeat integration. The beat sends `config` + `config_changed_at` when:
  - the config is dirty;
  - on the first beat after sign-in, when there is no report yet;
  - or every 60 minutes.

  It always sends `config_applied_version`. On the reply it stores `server_time`'s offset, applies `config` when present, and updates the setup's scan type and label when they differ.
- **Sounds:**
  - An upload on the kiosk goes to `POST /kiosk/sounds` first, and the choice stores the portal id.
  - Before the first report, existing local uploads are uploaded and their choices remapped.
  - A choice naming a portal sound not in the IndexedDB cache is downloaded from `GET /kiosk/sounds/{id}` and cached. Until then the slot plays its default.
- **Laptop mode:** this module does nothing on a laptop. Task 6 owns the laptop.

- [ ] **Step 1: Write the failing tests.**
  - Collecting and applying round-trip, including unknown sections.
  - Applying never marks the config dirty.
  - A local edit marks it dirty with the corrected time.
  - The heartbeat sends the config when dirty, at the first report and after 60 min, and not otherwise.
  - A received config is applied and acknowledged by version.
  - A bad field keeps its old value.
  - A scan type change updates the setup.
  - The sound upload remap and the download cache work, with the default playing until the download finishes.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full kiosk suite and the build. Both pass.**
- [ ] **Step 5: Commit** `feat(kiosk): settings sync with the portal for web kiosks`.

### Task 6: Laptop — the edge holds and syncs the device config

**Files:**
- Modify:
  - Edge: a new SCHEMA_STEP, the table `device_config(id=1, doc TEXT, version INT, changed_at TEXT, dirty INT, applied_version INT, server_offset_ms INT, reported_at TEXT)`.
  - `edge/routes/proxy.py`: on `/kiosk/heartbeat`, add the edge's config sync fields to the outgoing body and handle the reply's config, `server_time` and scan type.
  - `edge/rfid/reader_report.py` `send_station_heartbeat`: the same, on the station check-in.
  - New `edge/config_sync.py`.
  - New routes `GET/PUT /edge/config` (session).
- Kiosk: in laptop mode, `kioskConfig.ts` reads and writes through `/edge/config` instead of the heartbeat path, and applies what it reads to the browser stores. Each browser polls `/edge/config` every 60 s, and applies when the version changes.
- Test: the new edge tests, plus kiosk tests for laptop mode.

**Interfaces:**
- `/edge/config` GET returns `{doc, version, changed_at}`. PUT `{doc}` stores the doc, marks it dirty with `changed_at` set to the edge's corrected now, and applies the `alarm` section to `alarm_settings`.
- An edit on the Sound tab's alarm settings (the existing `PUT /edge/rfid/alarm/settings`) also updates `device_config.alarm` and marks it dirty.
- The edge applies a received config's `alarm` section to `alarm_settings`.
- The sound upload and download proxy through the edge (`/kiosk/sounds…`) using the person session, or the station key when nobody is signed in.

- [ ] **Step 1: Write the failing tests.**
  - The proxy adds the config fields only when the config is dirty, on the first report, or after 60 min, and always sends the applied version.
  - A reply's config is stored and its alarm applied.
  - The station heartbeat syncs the same way with nobody signed in.
  - An alarm-settings edit marks the config dirty.
  - `/edge/config` round-trips.
  - Laptop-mode kiosk browsers apply a new version, and their edits go through `PUT /edge/config`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full edge suite, the full kiosk suite and the kiosk build. All pass.**
- [ ] **Step 5: Commit** `feat(edge): laptop holds and syncs its kiosk config on both check-ins`.
