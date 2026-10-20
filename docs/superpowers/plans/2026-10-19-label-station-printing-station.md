# Label Station: generation, Printing Station and Printer Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A laptop Label Station pre-generates every asset's label on the edge with the portal's own label code, prints an asset's label the moment it is scanned (saved printer, offsets, peel mode), uploads Labeled scans with RFID-style retries, and its Printer Setup page works with the saved printer (USB or network).

**Architecture:** The pure label code (values, render, DPI-aware template pick) lives once in `api/src/serversherpa/labels/` with no DB imports; the edge image and edge tests import that same source. The edge stores one finished label per asset in SQLite, regenerating only labels whose input fingerprint changed. The kiosk talks to the edge for labels, the regeneration state and Labeled-scan queueing, and to the printer through `StationPrinter`.

**Tech Stack:** FastAPI + SQLAlchemy (API), FastAPI + SQLite (edge, `kiosk_laptop/edge`), React + Vite + Vitest (kiosk), WebUSB / raw 9100 ZPL.

**Spec:** `docs/superpowers/specs/2026-10-19-label-station-printing-station-design.md` (phase 1: `docs/superpowers/specs/2026-10-19-label-station-printing-design.md`).

## Global Constraints

- Template order — Top: destination-linked → source-linked → global (no site links, not the Generic Rack and RU family) → Generic Rack and RU family. Front: destination-linked → global. Each step only counts templates whose `dpi_key` equals the printer's DPI; a step with none at that DPI falls through. Ties in a step: highest `version`, then newest `updated_at`.
- A label must equal, byte for byte, what the portal's generator makes for the same asset, template and DPI.
- Regeneration is targeted: only label inputs (placeholder values, template id/version, DPI, kind) count; status changes never do. Offsets and peel are applied at send time and never regenerate.
- Yellow takeover copy: "Label regeneration in progress — updates were detected" (sync/printer changes); first run after setup: "Preparing labels for this move". Shows progress n of N; no dismiss.
- Labeled scans: queued on the laptop once the label is sent; repeat scans queue again; Reprint and Retry never queue; a failed print queues nothing. Upload: same table, batch (50) and retry schedule as RFID scans (`rfid/uploader.py`: GAPS 30,60,120,300,600,1800 s), under the station key.
- Repeat scans print again with no duplicate notice.
- Only finished ZPL is sent to a printer; nothing writes printer settings except Full Printer Setup / Factory Reset; print mode stays per label (`withPrintMode`).
- Edge query allowlist stays exact-match; new entries are read-only queries with a test pinned to a real printer reply.
- Old saved `label_station` settings and old sync payloads keep working (new fields optional on read).
- Web kiosk /labels unchanged. Bulk Print stays a placeholder. RFID Station laptops: no Label Printing tile, /labels routes redirect to Home.
- American English. Kiosk idioms (setup cards, `CheckList`, `mini-btn`); modals use the report-generate header, size to content, rounded corners.
- Never stage `.env`, `.venv`, `node_modules`, `.superpowers/`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never contact a real printer.

## Review Focus

1. Fractional, missing or text RU ("14.5", "", null) and a missing legacy asset id — edge values must equal the portal's (Task 2 round-trip test covers both).
2. One template that fails to compile, or an asset whose template has no version at the printer DPI — that asset gets an error row; every other label still generates (Task 4).
3. A sync or settings change arriving while a run is in progress — the request coalesces into one more run after the current one; nothing is lost (Task 5).
4. Peel mode where the label is never taken, and scans arriving meanwhile — the page keeps waiting with "Take the label", later scans queue in order and print after (Task 8).
5. Printer unplugged / unreachable / paper out at print time — clear message, Retry resends the same label without queueing a second Labeled scan (Task 8).

---

### Task 1: Pure label core in the API (values, render, pick)

**Files:**
- Create: `api/src/serversherpa/labels/label_values.py`, `api/src/serversherpa/labels/render.py`, `api/src/serversherpa/labels/pick.py`
- Modify: `api/src/serversherpa/labels/generate/values.py` (placeholder_values / container_placeholder_values delegate to label_values), `api/src/serversherpa/labels/generate/engine.py` (render_label delegates to render)
- Test: `api/tests/test_label_core.py`

**Interfaces:**
- Produces (all stdlib + `serversherpa.labels.{model,tokens,zpl,compile,brother_escp,brother_ptouch,tags}` only — no `serversherpa.db`, no sqlalchemy, no `serversherpa.services`):
  - `label_values.LabelAsset(NamedTuple)`: `legacy_id: int|None, name, serial_number, make, model, source_rack, source_ru: Decimal|None, source_position, destination_rack, destination_ru: Decimal|None, destination_position` (str|None for text fields).
  - `label_values.LabelMove(NamedTuple)`: `name: str|None, day: datetime.date|None, source_site: str|None, destination_site: str|None`.
  - `label_values.asset_label_values(asset: LabelAsset, move: LabelMove, catalog_keys: list[str], *, generation_rules: dict|None = None) -> dict[str, str]` — the body of today's `placeholder_values`, with `_format_ru`, `make_model_text`, position rules, length limits and the move-date formatting moved here.
  - `label_values.container_label_values(...)` likewise for `ContainerRow` inputs (plain fields).
  - `render.TemplateSource(Protocol)`: attributes `kind: str, code: str|None, design: dict|None, language_key: str`.
  - `render.render_template(template: TemplateSource, values: dict[str,str], *, width_in: float, height_in: float, dots: int) -> tuple[str, set[str]]` — today's `render_label` body.
  - `pick.TemplateChoice(NamedTuple)`: `id: str, family: str, label_type: str, dpi_key: str, version: int, updated_at: str (ISO), scope: Literal['destination','source','both','global','other']`.
  - `pick.pick_template(templates: list[TemplateChoice], kind: Literal['top','front'], dpi_key: str) -> tuple[TemplateChoice|None, list[str]]` — returns the pick and the skip notes, one per earlier step that had templates only at another DPI, e.g. `'The destination site\'s Top template "X" isn\'t available at 203 DPI.'`. `scope='both'` counts as destination. Generic family = `family.lower() == "generic rack and ru"`.
- `generate/values.placeholder_values(asset_row, initiative, sites, catalog_keys, *, generation_rules=None)` keeps its signature and output (builds `LabelAsset`/`LabelMove` with `stored_day(initiative.scheduled_start)`); `engine.render_label` keeps its signature and output.

- [ ] **Step 1: Write failing tests** in `api/tests/test_label_core.py`:
  - `test_core_modules_import_without_db`: a subprocess runs `python -c` with `sys.modules['sqlalchemy']=None; sys.modules['serversherpa.db']=None` then imports `serversherpa.labels.label_values, .render, .pick` — exit code 0.
  - `test_asset_label_values_matches_placeholder_values`: for the fixtures used in `tests/test_label_generate_values.py` (RU 14, 14.5, None; legacy id None; position rules `{"source": {"1": "src_room"}}`; length limit `{"asset_name": 5}`), `asset_label_values(...) == placeholder_values(...)`.
  - `test_render_template_matches_render_label`: a code template and a design template (text with `{asset_name}` containing `_^~`, barcode) at dots 203 and 300 — identical strings and unknown sets.
  - `test_pick_order_and_fallthrough`: destination(300 only) + source(203) + global(203) + GRRU(203), kind top, dpi '203' → source pick, notes == [destination note]; dpi '300' → destination; no destination/source → global beats GRRU; only GRRU → GRRU; front ignores source and GRRU; tie → higher version, then newer updated_at; none at DPI → (None, notes).
- [ ] **Step 2:** Run `cd api && SS_TEST_DB=serversherpa_test_lsp PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider tests/test_label_core.py` — FAIL (modules missing).
- [ ] **Step 3:** Implement the three modules and make `generate/values.py` and `generate/engine.py` delegate (no behavior change).
- [ ] **Step 4:** Run the new file plus `tests/test_label_generate_values.py tests/test_label_generate_runner.py tests/test_label_generate_api.py tests/test_labels_compile_api.py tests/test_kiosk_labels_api.py tests/test_kiosk_label_templates_sync.py` — all PASS.
- [ ] **Step 5:** Commit `feat: pure label core (values, render, DPI-aware pick) shared by portal and edge`.

### Task 2: Sync payloads carry what the edge needs to generate

**Files:**
- Modify: `api/src/serversherpa/labels/kiosk_templates.py`, `api/src/serversherpa/api/routes/kiosk.py` (`_assets_body`, `_label_templates_body`), `api/src/serversherpa/api/schemas.py` (`KioskAssetsSyncOut`, `KioskLabelTemplateOut`)
- Test: `api/tests/test_kiosk_label_templates_sync.py`, `api/tests/test_kiosk_label_inputs_sync.py` (new)

**Interfaces:**
- `KioskAssetsSyncOut` gains `label_context: KioskLabelContextOut | None` = `{move_name: str|None, move_day: date|None, source_site: str|None, destination_site: str|None, catalog_keys: list[str]}` (catalog keys exactly as `_label_catalog_keys` returns them). `KioskAssetOut` gains `legacy_id: int|None` and `source_ru_raw`/`destination_ru_raw: str|None` (the Decimal as a plain string, e.g. "14.50", so the edge rebuilds the exact Decimal).
- `KioskLabelTemplateOut` gains `kind: str`, `design: dict|None` (design JSON for `kind == "design"`, else None), `scope: Literal['destination','source','both','global','other']`.
- `move_template_set` additionally includes every active **global** Top and Front template (reason `"global"`) and always includes the Generic Rack and RU family (reason `"fallback"` regardless of destination links). Existing reasons stay.
- Edge-side rebuild contract (used by Task 4): `LabelAsset(legacy_id, name, serial_number, make, model, source_rack, Decimal(source_ru_raw) if source_ru_raw else None, source_position, destination_rack, Decimal(destination_ru_raw) if ... else None, destination_position)` and `LabelMove(move_name, move_day, source_site, destination_site)`.

- [ ] **Step 1: Write failing tests:**
  - `test_label_inputs_rebuild_the_portal_values` (new file): seed a move with assets (RU 14, 14.5, None; one without legacy id), GET `/kiosk/sync/assets`, rebuild `asset_label_values` from each item + `label_context` per the contract above; assert it equals the item's `label` dict.
  - `test_station_twin_has_label_context`: same via `/kiosk/station/sync/assets` (use the existing station-key helpers in `tests/test_kiosk_station_key.py`).
  - In `test_kiosk_label_templates_sync.py`: `test_global_top_and_front_are_sent` (a global Top named "Asset Top" → reasons contain "global", scope "global"); `test_generic_family_always_sent_even_with_destination_template`; `test_design_and_kind_and_scope` (design template → `kind == "design"`, `design` equals stored JSON; code template → `design is None`; linked to both sites → scope "both"); update the exact-keys assertion in `test_code_template_is_returned_verbatim` with `kind`, `design`, `scope`.
- [ ] **Step 2:** Run both files — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/test_kiosk_label_templates_sync.py tests/test_kiosk_label_inputs_sync.py tests/test_kiosk_station_key.py tests/test_kiosk_station_setup.py` plus any kiosk sync test touching `KioskAssetOut` keys (`grep -l "source_pod" api/tests`) — PASS.
- [ ] **Step 5:** Commit `feat: kiosk sync carries label inputs, design JSON, template scope and globals`.

### Task 3: Station key and station scans for Label Stations (API)

**Files:**
- Modify: `api/src/serversherpa/api/routes/kiosk.py` (`issue_station_key` L809-836, `kiosk_setup` L780-788, `station_ingest_scans` L1618-1649), `api/src/serversherpa/services/station_keys.py` (`verify` L73)
- Test: `api/tests/test_kiosk_station_key.py`, `api/tests/test_kiosk_station_scans.py`

**Interfaces:**
- A laptop whose `station_type` is `"rfid"` **or** `"label"` (with a current move) can be issued a station key; `verify` accepts both. `kiosk_setup` no longer revokes the key for a Label Station (it still revokes on station-type change and move change as today). The 409 code stays `not_rfid_station` for non-station devices (kept for old edges).
- `station_ingest_scans`: an RFID station keeps `rfid_only=True, off_move_allowed=True`. A Label Station accepts `scan_type == "barcode"` only, with `scan_status` forced to `"labeled"` (LABEL_STATION_SCAN_STATUS); an `"rfid"` scan from it is rejected `bad_scan_type`; `off_move_allowed=False`; audit_via stays `"station_key"`.
- Station heartbeat (reader telemetry) stays RFID-only.

- [ ] **Step 1: Write failing tests:** `test_label_station_can_get_a_station_key`, `test_label_station_setup_keeps_its_key`, `test_verify_accepts_label_station`, `test_label_station_scans_record_labeled_barcodes` (accepted; RawScan.scan_status == "labeled", scan_type barcode), `test_label_station_rfid_scan_rejected` (bad_scan_type), `test_non_station_laptop_still_refused` (409 not_rfid_station).
- [ ] **Step 2:** Run the two files — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `tests/test_kiosk_station_key.py tests/test_kiosk_station_scans.py tests/test_kiosk_station_setup.py tests/test_kiosk_station_heartbeat.py tests/test_kiosk_label_station_api.py` — PASS.
- [ ] **Step 5:** Commit `feat: Label Stations get a station key and upload Labeled scans with it`.

### Task 4: Edge — shared label code and the label generator

**Files:**
- Modify: `kiosk_laptop/Dockerfile` (COPY `api/src/serversherpa/__init__.py` and `api/src/serversherpa/labels/` into the image and put that root on `PYTHONPATH`), `kiosk_laptop/edge/pyproject.toml` (`pythonpath = [".", "../../api/src"]`), `.github/workflows/kiosk-laptop-image.yml` (add `api/src/serversherpa/labels/**` to both path filters), `kiosk_laptop/edge/src/edge/db.py` (append schema steps)
- Create: `kiosk_laptop/edge/src/edge/labels/__init__.py`, `kiosk_laptop/edge/src/edge/labels/generate.py`
- Test: `kiosk_laptop/edge/tests/test_label_generate.py`

**Interfaces:**
- Schema (append to `SCHEMA_STEPS`): `station_labels(asset_id TEXT PRIMARY KEY, label_kind TEXT, dpi INTEGER, template_id TEXT, template_version INTEGER, template_name TEXT, fingerprint TEXT, zpl TEXT, error TEXT, generated_at TEXT)`; `label_run(id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL DEFAULT 'idle', reason TEXT, total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT)`. Add both tables to `routes/edge.py` `MOVE_TABLES`.
- `generate.Plan(NamedTuple)`: `template: TemplateChoice|None, notes: list[str], assets: list[AssetJob]` where `AssetJob = (asset_id: str, values: dict[str,str], fingerprint: str)`.
- `generate.build_plan(store) -> Plan | None` — None when the laptop isn't a Label Station with `label_station` saved. Reads the cached `/kiosk/sync/assets?initiative_id=…` and `/kiosk/sync/label-templates?initiative_id=…` bodies (the cache keys `sync.py` writes), picks with `pick_template(choices, label_kind, str(dpi))`, builds values with `asset_label_values(..., generation_rules=template.generation_rules)`. `fingerprint = sha256(json.dumps([values, template.id, template.version, dpi, label_kind], sort_keys=True))`; with no template it is `sha256(["no_template", dpi, label_kind])`.
- `generate.changed_jobs(store, plan) -> list[AssetJob]` — jobs whose fingerprint differs from `station_labels` (or missing).
- `generate.render_job(template_json: dict, job) -> tuple[str|None, str|None]` — `(zpl, None)` or `(None, error)`; error codes: `no_template_at_dpi`, `template_failed` (compile raised), and unknown placeholders are not errors (portal parity).
- `generate.apply(store, plan, job, zpl, error)` — upserts one row (row replaced only when its new version is ready); `generate.prune(store, plan)` deletes rows for assets no longer on the move.

- [ ] **Step 1: Write failing tests** in `test_label_generate.py` (fixtures: cache bodies shaped like the Task 2 payloads):
  - `test_shared_label_code_imports_from_api_source` — `import serversherpa.labels.render` resolves under `api/src`.
  - `test_plan_picks_by_dpi_and_builds_portal_values` — values equal the asset's synced `label` dict for keys in catalog; fallthrough note present.
  - `test_render_matches_render_template` — `render_job` output == `render_template(...)` from the shared module for the same inputs.
  - `test_only_changed_assets_are_rerendered` — after apply, changing one asset's name → `changed_jobs` returns that one; changing a status-only field (no label input) → none; changing template version → all; changing dpi → all.
  - `test_bad_template_gives_error_rows_not_a_crash` — design that raises → every job error `template_failed`; `no template at dpi` → `no_template_at_dpi` rows.
  - `test_prune_removes_assets_off_the_move`.
- [ ] **Step 2:** Run `cd kiosk_laptop/edge && .venv/bin/pytest -q -p no:cacheprovider tests/test_label_generate.py` — FAIL.
- [ ] **Step 3:** Implement schema, module, Dockerfile/pyproject/CI changes.
- [ ] **Step 4:** Run the full edge suite `.venv/bin/pytest -q -p no:cacheprovider` — PASS; `docker build -f kiosk_laptop/Dockerfile .` from the repo root succeeds and `docker run --rm <image> python -c "import serversherpa.labels.render"` exits 0.
- [ ] **Step 5:** Commit `feat(edge): generate Label Station labels with the portal's label code`.

### Task 5: Edge — runs, triggers and label routes

**Files:**
- Create: `kiosk_laptop/edge/src/edge/labels/runner.py`, `kiosk_laptop/edge/src/edge/routes/labels.py`
- Modify: `kiosk_laptop/edge/src/edge/app.py` (state `label_wake`, router), `background.py` (a label loop task), `sync.py` (wake after a successful run), `laptop_setup.py` (`save_label_station` wakes when dpi / label_kind / printer changed), `routes/kiosk.py` (`POST /kiosk/setup` wakes)
- Test: `kiosk_laptop/edge/tests/test_label_runner.py`, `kiosk_laptop/edge/tests/test_label_routes.py`

**Interfaces:**
- `runner.LabelRunner(store, *, render=generate.render_job)`: `request(reason: Literal['setup','updates'])` sets a pending flag (coalesces); `async run_pending()` — builds the plan, computes changed jobs; if none, prunes and returns without touching `state` (no yellow screen); otherwise sets `label_run` state `running`, `reason`, `total=len(changed)`, `done` increments per job (render via `asyncio.to_thread`), then prune, state `idle`, `finished_at`; if another request arrived meanwhile, runs again. On start-up, a `label_run.state == 'running'` row means an interrupted run: request again with the same reason.
- Reason: `'setup'` when `station_labels` is empty for this move, else `'updates'`.
- Routes (all `require_session`):
  - `GET /edge/labels/status` → `{state: 'idle'|'running', reason: 'setup'|'updates'|null, total, done, ready: int, errors: int}`.
  - `GET /edge/labels/plan?dpi=<int>&kind=<top|front>` → `{template: {id, name, family, dpi_key, version}|null, notes: [str]}`. `dpi`/`kind` are optional and override the saved station's (setup asks before saving); without them the saved settings are used; 404 `not_label_station` when the laptop isn't set up as a Label Station.
  - `GET /edge/labels/asset/{asset_id}` → `{asset_id, zpl: str|null, error: str|null, template_name, dpi, label_kind}`; 404 `label_not_found` when no row; 409 `labels_regenerating` while a run is in progress.
- Triggers: after `Syncer.run` succeeds for a Label Station → `request('updates')`; `save_label_station` with a changed `dpi`, `label_kind` or `printer` → `request('updates')` (or `'setup'` when empty); `POST /kiosk/setup` for a label station → `request('setup')`.

- [ ] **Step 1: Write failing tests:** `test_run_marks_running_then_idle_with_progress`, `test_no_changes_never_shows_running`, `test_request_during_run_runs_once_more` (Review Focus 3), `test_interrupted_run_resumes_on_start`, `test_status_and_asset_routes` (incl. 409 while running, 404 unknown), `test_plan_route_reports_fallthrough_note`, `test_sync_and_settings_changes_request_a_run` (offset-only change does NOT request), `test_wipe_clears_label_tables`.
- [ ] **Step 2:** Run the two files — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full edge suite — PASS.
- [ ] **Step 5:** Commit `feat(edge): label runs, triggers and /edge/labels routes`.

### Task 6: Edge — Label Station key, unattended sync, Labeled-scan queue, ^HH query

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/rfid/station_key.py` (`is_rfid_setup`/`_rfid_initiative` → station setups of type rfid or label), `routes/kiosk.py` (`POST /kiosk/setup` issues the key for label too), `sync.py` (`_run_as_station` for any station with a key), `db.py` (append: `ALTER TABLE pending_rfid_scans ADD COLUMN scan_type TEXT`), `rfid/uploader.py` (`_scan(row)` uses `row["scan_type"] or "rfid"`), `routes/labels.py` (new route), `routes/printers.py` (`ALLOWED_QUERIES` adds `"^XA^HH^XZ"`)
- Test: `kiosk_laptop/edge/tests/test_station_key.py`, `test_rfid_uploader.py`, `test_label_routes.py`, `test_printers.py`, `test_sync.py`

**Interfaces:**
- `POST /edge/labels/printed` body `{asset_id: str, scanned_value: str, scanned_at: ISO}` → `{queued: true, client_scan_id}`: inserts a `pending_rfid_scans` row with `scan_type='barcode'`, `matched_kind='asset'`, `matched_id=asset_id`, `epc=scanned_value` (the column carries the scanned value), `scan_status='labeled'`, initiative/site from the saved setup, `client_scan_id=uuid4`, `raw_read_id NULL`, `upload_state='pending'`; wakes `rfid_upload_wake`. 409 `not_label_station` otherwise.
- The uploader and its retry schedule are unchanged apart from `scan_type`.
- `^XA^HH^XZ` allowed exactly; the test's fake printer answers with the real ZT220 `^HH` reply captured 2026-10-19 — copy it from `/private/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/97f12195-f5cd-488e-abb6-b25f059d8083/scratchpad/hh_before.txt` (the block under `=== '^XA^HH^XZ'`) into `kiosk_laptop/edge/tests/fixtures/zt220_hh.txt`.

- [ ] **Step 1: Write failing tests:** `test_label_station_gets_a_key_on_setup`, `test_label_station_syncs_as_station_without_a_person`, `test_printed_queues_a_labeled_barcode_scan`, `test_uploader_sends_barcode_scan_type` (body scan_type "barcode", scan_status "labeled"), `test_hh_query_allowed_and_variants_refused` (`^XA^HH^XZ\r\n`, `^xa^hh^xz`, `^XA^HH^XZ^XA^JUS^XZ` refused).
- [ ] **Step 2:** Run those files — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full edge suite — PASS.
- [ ] **Step 5:** Commit `feat(edge): Label Station key, unattended sync, Labeled-scan queue, ^HH query`.

### Task 7: Kiosk — edge client, saved-printer hook, yellow takeover, gating, setup DPI check

**Files:**
- Modify: `kiosk/src/lib/api.ts` (`getLabelRunStatus`, `getLabelPlan`, `getStationLabel`, `postLabelPrinted`, types), `kiosk/src/layout/KioskShell.tsx` (mount takeover for label stations), `kiosk/src/App.tsx` (RFID Station → `/labels*` redirects to `/`), `kiosk/src/components/setup/PrinterStep.tsx` (DPI check from `getLabelPlan`, notes shown as non-blocking warnings), `kiosk/src/styles/kiosk.css`
- Create: `kiosk/src/lib/useStationPrinter.ts`, `kiosk/src/components/LabelRegenScreen.tsx`
- Test: `kiosk/src/lib/useStationPrinter.test.ts`, `kiosk/src/components/LabelRegenScreen.test.tsx`, `kiosk/src/App.test.tsx` or the existing routing test, `kiosk/src/components/setup/PrinterStep.test.tsx`

**Interfaces:**
- `api.ts`: `getLabelRunStatus(): Promise<LabelRunStatus>` (`{state, reason, total, done, ready, errors}`), `getLabelPlan(): Promise<{template: {id,name,family,dpi_key,version}|null; notes: string[]}>`, `getStationLabel(assetId): Promise<StationLabel>` (`{asset_id, zpl, error, template_name, dpi, label_kind}`; throws ApiError with code `label_not_found` / `labels_regenerating`), `postLabelPrinted({asset_id, scanned_value, scanned_at}): Promise<void>`.
- `useStationPrinter(): { settings: LabelStationSettings|null; printer: StationPrinter|null; zebra: ZebraPrinter; state: 'loading'|'ready'|'needs_usb'|'no_settings'; connectUsb(): Promise<void>; reload(): Promise<void> }` — loads `getLabelStation()`; network → `networkStationPrinter(ip, initiativeId)`; USB → auto-`connectTo` the known device whose `serialNumber` equals `settings.printer.serial` (else the only known Zebra), else `needs_usb`.
- `LabelRegenScreen` — polls `getLabelRunStatus` every 1000 ms; when `state === 'running'` renders `<div className="label-regen" role="alertdialog" aria-modal="true">` with title per reason (Global Constraints copy) and "n of N"; uses the same inert/takeover stack as `OffMoveAlarm` (`openTakeovers`/`syncInert` — export them from `OffMoveAlarm.tsx` into a small `lib/takeover.ts` and use from both). Yellow palette tokens in kiosk.css with a `prefers-reduced-motion` rule.
- PrinterStep (laptop only): the "DPI" row calls `getLabelPlan({dpi: ident.dpi, kind: labelKind})`; it passes when `template` is non-null (detail: the template's name), fails with "No <Top|Front> template at <dpi> DPI" when null; each note renders under the row as a muted, non-blocking warning. `getLabelPlan(opts?: {dpi?: number; kind?: LabelKind})`.

- [ ] **Step 1: Write failing tests:** hook picks network / USB-by-serial / needs_usb / no_settings; takeover shows "Preparing labels for this move" for reason setup and "Label regeneration in progress — updates were detected" for updates with "3 of 10", hidden when idle, page inert while shown; RFID station `/labels/station` → Home; PrinterStep DPI row green with a warning note when plan has notes, red "No Top template at 203 DPI" when template null.
- [ ] **Step 2:** `npm --prefix kiosk test -- --run <files>` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm --prefix kiosk test -- --run` and `npm --prefix kiosk run build` — PASS.
- [ ] **Step 5:** Commit `feat(kiosk): saved-printer hook, label regeneration takeover, station gating`.

### Task 8: Kiosk — Printing Station page

**Files:**
- Create: `kiosk/src/pages/PrintingStation.tsx`, `kiosk/src/lib/printQueue.ts`
- Modify: `kiosk/src/App.tsx` (`/labels/station` → `PrintingStation` on a laptop Label Station; placeholder elsewhere), `kiosk/src/styles/kiosk.css`
- Test: `kiosk/src/pages/PrintingStation.test.tsx`, `kiosk/src/lib/printQueue.test.ts`

**Interfaces:**
- `printQueue.createPrintQueue(deps: { printer: () => StationPrinter|null; settings: () => LabelStationSettings|null; getLabel: (assetId) => Promise<StationLabel>; recordPrinted: (job) => Promise<void>; sleep?: (ms) => Promise<void>; onChange: (s: QueueState) => void })` → `{ enqueue(job: {asset, scannedValue}): void; reprint(entryId): void; retry(entryId): void }`. Per job: getLabel → `printer.status()` → `statusProblems` (any → entry `failed` with the problem text, nothing sent) → `send(withPrintMode(applyPrintSettings(zpl, {...DEFAULT_PRINT_SETTINGS, horizontalOffset: offset_x, verticalOffset: offset_y}, {singleCopy: true}), peel))` → `recordPrinted` (enqueue/repeat only; never for reprint/retry) → if `peel`, poll `status()` every 500 ms while `labelWaiting` (entry state `take_label`) → `printed`. Jobs run strictly one at a time in arrival order.
- Entry states: `queued | printing | take_label | printed | failed`; failures carry `message` (not on move: "This asset isn't on this move."; label error: "No label for this asset: <reason text>" with reason texts for `no_template_at_dpi`, `template_failed`; printer: statusProblems text or "The printer didn't answer. Check that it's on and connected.").
- Page: scan input (same pattern as `Scan.tsx`: autoFocus, focus reclaim, Enter submits; match with `matchAssetOrSerial` over `getAll('assets')`), current asset card (name, make/model, serial, source and destination rack/RU), big "Printed" / "Take the label" / error state, Reprint and Retry buttons, session list newest first; flash + sound on success/failure like Scan.

- [ ] **Step 1: Write failing tests** (`printQueue.test.ts` with a fake printer): prints with offsets and `^MMP` when peel; records once per scan incl. repeat scans; reprint and retry never record; failed status sends nothing and records nothing; peel waits while `labelWaiting` and the next job waits (Review Focus 4); printer throw → failed + retry resends same ZPL (Review Focus 5); jobs in order. `PrintingStation.test.tsx`: scan by asset id and by serial prints and shows the asset card; unknown value shows "This asset isn't on this move." and sends nothing; `labels_regenerating` shows a waiting message.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full kiosk suite + build — PASS.
- [ ] **Step 5:** Commit `feat(kiosk): Printing Station prints a scanned asset's label`.

### Task 9: Kiosk — Printer Setup / Troubleshooting on a Label Station

**Files:**
- Create: `kiosk/src/pages/StationPrinterTools.tsx`, `kiosk/src/lib/networkZebra.ts`
- Modify: `kiosk/src/pages/PrinterTools.tsx` (Label Station laptop → render `StationPrinterTools`), `kiosk/src/components/printers/AlignmentTestModal.tsx` (optional props `offsets?: {x,y}`, `onSaveOffsets?: (o) => Promise<void>`, `transform?: (zpl) => string`; default behavior unchanged), `kiosk/src/components/setup/PrinterStep.tsx` (optional `finishLabel?: string`, `onBack?` optional; used as the Change printer / Check printer & fonts modal body)
- Test: `kiosk/src/pages/StationPrinterTools.test.tsx`, `kiosk/src/lib/networkZebra.test.ts`, `AlignmentTestModal.test.tsx`

**Interfaces:**
- `networkZebra.networkZebraPrinter(ip: string): Pick<ZebraPrinter, 'query'|'send'|'identify'|'status'|'log'|'clearLog'|'productName'|'waitForIdle'|'ensureOpen'>` over `/edge/printers/query|send`; `waitForIdle(labels)` polls `~HS` `formatsQueued` until 0 (1 s interval, 60 s cap); `ensureOpen` resolves when `~HI` answers; `log` records commands like the USB hook.
- `StationPrinterTools`: printer card (model, firmware, DPI, health chips via `PrinterHealth`, Peeler row text from phase 1, offsets "Horizontal N dots · Vertical N dots"), tool rows: Test Label Alignment (AlignmentTestModal with station offsets, `onSaveOffsets` → `putLabelStation({...settings, offset_x, offset_y})`, `transform` → `withPrintMode(zpl, peel)`), Full Printer Setup and Factory Reset (USB hook or `networkZebraPrinter`), Change printer (modal with `PrinterStep`, `finishLabel="Save printer"`), Check printer & fonts (same modal, current printer preselected) replacing "Managed from the portal".

- [ ] **Step 1: Write failing tests:** network adapter maps calls to the edge and waitForIdle polls; Label Station renders the saved network printer with health and offsets; alignment saves offsets to the station (putLabelStation called with new offsets, localStorage untouched) and prints with `^MMP` when peel; Full Printer Setup over network issues `^XA^HH^XZ` via `/edge/printers/query`; non-station kiosk still renders the USB-only tools (existing PrinterTools tests unchanged).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full kiosk suite + build — PASS.
- [ ] **Step 5:** Commit `feat(kiosk): Printer Setup uses the Label Station's saved printer and offsets`.
