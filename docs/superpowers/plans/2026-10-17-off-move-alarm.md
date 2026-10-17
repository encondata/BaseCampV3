# Asset Not Part Of Move Alarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A laptop RFID Station flashes the whole screen red and sounds a siren when a fresh read matches one of the move's client's assets that isn't on the move. The alarm runs until it is dismissed (tap or space bar), or for X seconds in timed mode.

**Architecture:**
- **Portal:** the client-wide asset download gains make/model and the client's assets that are on no move.
- **Edge:** the processor raises alarms from fresh off-move matches into an edge-held open-alarm table, applying the 1-hour rule. A small `/edge/rfid/alarm` API serves the open alarm, dismissal and the station's alarm settings.
- **Kiosk:** an overlay mounted in `KioskShell` (every page) polls that API every second, shows the red takeover and plays a synthesized siren. The Sound tab gets the mode, X and a Test alarm button.

**Tech Stack:** FastAPI + SQLAlchemy (API), FastAPI + sqlite3 (edge), React + Vitest (kiosk).

**Spec:** `docs/superpowers/specs/2026-10-17-off-move-alarm-design.md`

## Global Constraints

**Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/off-move-alarm`, branch `off-move-alarm`.

**First-time setup:**
- `cd kiosk_laptop/edge && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`
- `npm --prefix kiosk ci && npm --prefix portal ci`
- The API tests need two symlinks, removed after committing and never staged:
  - `ln -s /Users/jrh1812/Developer/BaseCampV3/api/.venv api/.venv`
  - `ln -s /Users/jrh1812/Developer/BaseCampV3/.env .env`

**Git:** stage by explicit path only; never `git add -A`, `.` or `-f`, and never stage `.superpowers/`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Suites:** run every suite in the FOREGROUND with a 600000 ms timeout; never background one.
- API: `cd api && SS_TEST_DB=serversherpa_test_off_move_alarm PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -p no:cacheprovider <files>`
- Edge: `cd kiosk_laptop/edge && .venv/bin/pytest -q -p no:cacheprovider`
- Kiosk: `npm --prefix kiosk test -- --run` and `npm --prefix kiosk run build`

**Rules:**
- No portal migration.
- Edge `SCHEMA_STEPS` is append-only.
- Copy uses American English.
- Kiosk UI reuses existing kiosk idioms: `settings-row`, `segmented`, `Switch`, and the existing `kiosk.css` tokens. No raw unstyled controls.

**Fixed values (spec):**
- Title: `Asset Not Part Of Move`.
- Table columns, in order: `Make / Model`, `Name`, `Serial`, `RFID`. A missing value shows `—`. Make / Model is `"<make> <model>"` trimmed, or whichever one exists.
- Modes: `until_dismissed` (the default) and `timed`.
- `timed_seconds` defaults to 10 and is valid from 3 to 600.
- Repeat window: 3600 s from the asset's last alarm. A re-read inside the window doesn't extend it.
- Fresh read: `received_at` at most 30 s before the processor matches it.
- The dismiss key is the space bar.
- The alarm reaches the screen within about 2 s: the kiosk polls every 1000 ms.
- System Events: kind `alarm`, title `Asset Not Part Of Move`, detail naming up to 5 assets (each by Name, else Serial, else RFID) plus `and N more`.
- The alarm and its settings exist only on a laptop set up as an RFID Station.

## Review Focus

1. **Old reads must not alarm.** A backlog matched after a client-assets sync, or by the `recheck_unmatched` re-check, uploads but never alarms, and doesn't start the 1-hour clock. (Task 2.)
2. **A dismiss must not swallow an asset the worker never saw.** An asset added between the screen's last poll and the dismiss tap stays open. Dismiss clears only up to the alarm id the screen showed. (Tasks 2, 3.)
3. **Timed mode across several screens.** Expiry is decided on the edge from the last raise time, so a reloaded page or a second page agrees. (Tasks 2, 3.)
4. **Sound never breaks the page.** A blocked or failed `AudioContext` means silence plus the "Tap to enable sound" notice, never an exception. Dismissing always stops the siren. (Task 3.)
5. **Old portal, new edge.** Client-assets items without `make`, `model` or `initiative_id` still match and alarm, showing `—`. (Tasks 1, 2.)

---

### Task 1: Portal — client-assets carries make/model and the client's assets on no move

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py`
  - `KioskClientAssetOut` gains `make: str | None` and `model: str | None`.
  - `initiative_id: uuid.UUID | None` and `initiative_name: str | None` become optional.
  - Update the docstring.
- Modify: `api/src/serversherpa/api/routes/kiosk.py`, `_client_assets_body`.
- Test: `api/tests/test_kiosk_client_assets.py`

**Interfaces:**
- Produces: each item in `GET /kiosk/sync/client-assets` and `/kiosk/station/sync/client-assets` carries `make`, `model` (from the asset's `AssetModel`, i.e. its make and model names) and `initiative_id`/`initiative_name`, which are null for an asset on no move.

- [ ] **Step 1: Write the failing tests.**
  - `test_client_assets_include_make_and_model`
  - `test_client_assets_include_unassigned_client_assets`: an asset with `client_id` set to the client and on no move is listed once, with null move fields.
  - `test_unassigned_asset_of_another_client_is_not_listed`
  - `test_archived_unassigned_asset_is_not_listed`
  - `test_asset_on_the_selected_move_is_never_listed_even_if_also_unassigned_shaped`: an asset on the selected move whose `client_id` is the client is excluded.
  - Also check that existing tests still pass: assets on other non-archived moves (including Completed ones) are still listed.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** Keep the existing other-moves query, adding an outer join to the model for make/model. Add a second query for client assets that are not archived and are on no move at all (no `InitiativeAsset` row). Exclude any asset on the selected move from both. Order by `legacy_id`. Read how `AssetModel` stores make and model before writing the join.
- [ ] **Step 4: Run `test_kiosk_client_assets.py`, `test_kiosk_station_scans.py` and `test_kiosk_sync_api.py`. All pass.**
- [ ] **Step 5: Commit** `feat: client-assets download carries make/model and unassigned client assets`.

### Task 2: Edge — raise, hold and dismiss alarms; the station's alarm settings

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/db.py`. Append one SCHEMA_STEP with three tables:
  - `alarm_settings (id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL, timed_seconds INTEGER NOT NULL)`;
  - `alarm_last (asset_id TEXT PRIMARY KEY, alarmed_at TEXT NOT NULL)`;
  - `alarm_open (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL UNIQUE, make_model TEXT, name TEXT, serial TEXT, rfid TEXT, raised_at TEXT NOT NULL)`.
- Create: `kiosk_laptop/edge/src/edge/rfid/alarm.py`
- Modify: `kiosk_laptop/edge/src/edge/rfid/processing.py`. `process()` hands its fresh off-move matches to `alarm.raise_for` inside the same transaction. It needs the client-assets item, so `_match` returns it, or the item is looked up from the index.
- Modify: `kiosk_laptop/edge/src/edge/routes/rfid.py`. Add the alarm routes.
- Test: `kiosk_laptop/edge/tests/test_rfid_alarm.py` (new), plus additions to `tests/test_rfid_processing.py`.

**Interfaces:**
- Produces in `edge.rfid.alarm`:
  - `DEFAULTS = {"mode": "until_dismissed", "timed_seconds": 10}`, `REPEAT_S = 3600`, `FRESH_S = 30`.
  - `raise_for(c, items: list[dict], now: datetime) -> list[dict]`. `c` is a sqlite cursor or connection inside the caller's transaction. Each item is `{asset_id, make, model, name, serial, rfid}`. It skips an asset alarmed less than `REPEAT_S` ago, otherwise upserts `alarm_last` and adds or refreshes the `alarm_open` row (refreshing `raised_at`). It returns the newly alarmed items.
  - `record_event(store, raised: list[dict]) -> None`: one System Events entry per non-empty raise. Call it after the transaction commits.
  - `settings(store) -> dict` and `save_settings(store, mode: str, timed_seconds: int) -> dict`. `save_settings` raises `ValueError` on a bad mode, or on seconds outside 3–600.
  - `open_alarm(store, now: datetime) -> dict`, returning `{"mode", "timed_seconds", "alarms": [{"id","make_model","name","serial","rfid","raised_at"}], "latest_id": int | None, "expires_at": str | None}`.
    - Timed mode: `expires_at` = the newest `raised_at` + `timed_seconds`.
    - Once `now` is past `expires_at`, the open rows are deleted and `alarms` is empty.
  - `dismiss(store, up_to_id: int) -> int`: deletes `alarm_open` rows with `id <= up_to_id`.
- Produces these routes on the existing `/edge/rfid` router, with the same auth as `/edge/rfid/events` (read) and `/edge/rfid/stop` (write):
  - `GET /edge/rfid/alarm` → `open_alarm`. It returns empty alarms when the laptop isn't an RFID Station.
  - `POST /edge/rfid/alarm/dismiss` with `{"up_to_id": int}` → `{"dismissed": n}`.
  - `GET /edge/rfid/alarm/settings`.
  - `PUT /edge/rfid/alarm/settings` with `{"mode","timed_seconds"}` → 200 with the saved settings; 422 on invalid input.
  - Dismissing must work with nobody signed in only if `/edge/rfid/stop` does; match whatever `/edge/rfid/stop` requires and say which in the report.

- [ ] **Step 1: Write the failing tests.**
  - `test_fresh_off_move_read_raises_alarm`: an open row with make_model, name, serial and rfid, plus one `alarm` event.
  - `test_stale_off_move_read_uploads_but_never_alarms`: `received_at` 31 s old → the pending scan exists, no open row, no `alarm_last`.
  - `test_recheck_matches_never_alarm`
  - `test_repeat_inside_an_hour_is_silent`
  - `test_repeat_after_an_hour_alarms_again`
  - `test_reread_inside_the_hour_does_not_extend_the_window`
  - `test_two_assets_one_pass_one_event_listing_both`
  - `test_event_detail_caps_at_five_and_n_more`
  - `test_dismiss_up_to_keeps_newer_rows`
  - `test_timed_mode_expires_on_the_edge`
  - `test_settings_defaults_save_and_validation` (422 at 2 and 601, and on a bad mode)
  - `test_alarm_route_empty_on_label_station`
  - `test_unassigned_client_asset_alarms_and_missing_make_model_is_null`
  - `test_alarm_state_survives_a_restart` (a new app over the same data dir)
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
  - The make_model string is `" ".join(x for x in (make, model) if x)`, or None.
  - Event detail: `", ".join(first five labels)`, then `" and N more"` when there are more.
  - Timestamps use the edge's `now_iso()` / `iso()` helpers.
- [ ] **Step 4: Run the full edge suite. It passes.**
- [ ] **Step 5: Commit** `feat(edge): off-move alarms raised from fresh reads, held and dismissed on the edge`.

### Task 3: Kiosk — the red takeover on every page, the siren, Space to dismiss

**Files:**
- Modify: `kiosk/src/lib/api.ts`. Add `getOffMoveAlarm()`, `dismissOffMoveAlarm(upToId)`, `getAlarmSettings()` and `saveAlarmSettings(s)`, with types mirroring Task 2.
- Modify: `kiosk/src/lib/sound.ts`. Add `startSiren(volume: number): () => void`, a looping two-tone Web Audio siren using the existing lazily created context. Calling the returned function stops it. It never throws. It also exports `soundBlocked(): boolean`, true when the context is suspended after `resume()`.
- Create: `kiosk/src/components/OffMoveAlarm.tsx`. Mount it in `kiosk/src/layout/KioskShell.tsx` only when `isLaptop()` and `useKioskSetup()` stationType is `rfid`. Styles go in `kiosk/src/styles/kiosk.css`.
- Test: `kiosk/src/components/OffMoveAlarm.test.tsx`

**Interfaces:**
- Consumes: the Task 2 routes.
- Consumes: `startSiren`, plus the Sound tab's saved volume (`SoundSettings.volume`) from `sound.ts`'s existing store.
- Produces: `<OffMoveAlarm preview?: AlarmPreview>`, used by Task 4's Test alarm with a sample row and no polling or dismiss call.

- [ ] **Step 1: Write the failing tests** (fake timers, mocked api).
  - `shows_takeover_with_title_move_and_table_columns`: the title, the move name (from kiosk setup), and the column headers in order.
  - `missing_values_show_dash`
  - `space_dismisses_with_latest_id`
  - `tap_dismisses`
  - `siren_starts_with_alarm_and_stops_on_dismiss`
  - `timed_mode_shows_countdown_and_hides_after_expires_at`
  - `new_asset_while_open_is_added`
  - `blocked_sound_shows_tap_to_enable_notice`
  - `poll_failure_keeps_last_state_and_never_throws`
  - `not_mounted_on_label_station_or_web`
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
  - Poll `getOffMoveAlarm` every 1000 ms.
  - When `alarms` is non-empty, render a fixed full-screen overlay above everything, flashing red like mockup A: an uppercase "⚠ Asset Not Part Of Move" title, a subline with the asset count and the move name, the table, and a footer button "Tap or press Space to dismiss". In timed mode the button reads "Dismiss (Ns)", counting down to `expires_at`.
  - The Space key handler ignores repeats and prevents page scroll.
  - Dismiss calls `dismissOffMoveAlarm(latest_id)` and hides the overlay at once.
  - The siren starts when the alarm opens, and stops on dismiss, expiry or unmount.
  - The overlay is `role="alertdialog"`, labeled by its title.
- [ ] **Step 4: Run the full kiosk tests and the kiosk build. Both pass.**
- [ ] **Step 5: Commit** `feat(kiosk): Asset Not Part Of Move takeover with siren on every RFID Station page`.

### Task 4: Kiosk — alarm settings and Test alarm on the Sound tab

**Files:**
- Modify: `kiosk/src/components/SoundPanel.tsx`, or add `kiosk/src/components/OffMoveAlarmSettings.tsx` rendered from it. Show an "Off-move alarm" section only on a laptop RFID Station.
- Test: the matching `*.test.tsx`.

**Interfaces:**
- Consumes: `getAlarmSettings`/`saveAlarmSettings` (Task 3's api), and `<OffMoveAlarm preview>` (Task 3).

- [ ] **Step 1: Write the failing tests.**
  - `section_hidden_off_rfid_station`
  - `loads_and_shows_defaults`: Until dismissed is selected and X is 10.
  - `switching_to_timed_saves_and_enables_seconds`
  - `seconds_outside_3_to_600_are_refused_with_a_hint`
  - `test_alarm_shows_preview_with_sample_row_and_writes_nothing`: no dismiss or save call.
  - `save_failure_keeps_previous_value_and_shows_error`
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
  - A `settings-row` with a `segmented` control: "Until dismissed" / "Timed".
  - A seconds number input, enabled only when Timed is selected, with the hint "3–600 seconds".
  - A "Test alarm" button that opens the preview (sample row: `Dell PowerEdge R740 / sample-server / SAMPLE123 / 100000`).
  - The preview is dismissed by tap or Space; in Timed mode it ends after X seconds.
  - Hint copy: "Plays at the volume set above and the laptop's own volume."
- [ ] **Step 4: Run the full kiosk tests and the kiosk build. Both pass.**
- [ ] **Step 5: Commit** `feat(kiosk): off-move alarm settings and Test alarm`.
