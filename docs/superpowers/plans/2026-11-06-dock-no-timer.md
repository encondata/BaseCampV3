# Dock: No Timer, Fixed Window, No Dry Run or Pause — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Dock station match Jimmy's rule: when a crate tag is read, assets within 5 s before or after it pack into the crate. Nothing counts down on screen. Dry run, the Window setting and Pause are removed.

**Architecture:** The laptop edge loses its Dock settings: the window becomes the constant `WINDOW_S = 5`, dry run is gone, and the control route takes only Start and Stop. The grouper's burst now ends when the reader's clock passes the later of (newest crate's first read + 2W) and (newest new tag's first read + W), instead of 2W after the last new tag. The kiosk's Dock screen drops the countdown bar, the timed result, the settings card and Pause. A decided crate's result, and its device list, hold the screen until the next tag is read.

**Tech Stack:** FastAPI + stdlib sqlite3 (`kiosk_laptop/edge`), React 18 + Vite + vitest (`kiosk/`).

**Spec:** `docs/superpowers/specs/2026-11-05-dock-station-design.md`, section "Changes after the second test (2026-11-06, Jimmy)". Where it disagrees with an earlier section, that section wins.

## Global Constraints

- Work only in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/dock-station` (branch `dock-station`). Never commit `api/src/serversherpa/_dev_reload.py` or `.superpowers/`.
- American English. Times are 24-hour `HH:MM:SS`, never AM/PM.
- Follow the kiosk's light or dark theme, using only theme tokens. Rounded corners. No default browser scrollbars.
- Stop is never disabled.
- Match the surrounding style and comment density. Rewrite docstrings and comments that describe removed behavior (dry run, the Window setting, Pause, the countdown, the 6 s result, "2W after the last new tag"); never leave them stale.
- Keep existing behaviors and their tests unless this plan changes them. Adapt or delete tests of removed behavior; never weaken a test of kept behavior.
- **Legacy dry run:** `raw_tag_reads.dry_run`, `dock_passes.dry_run`, the `dock_settings` table and the `would_pack` status stay in the schema and the code that reads them. Reads stamped `dry_run = 1` before this change still never upload or send, and their passes still show "Would pack". Nothing new is ever stamped.
- Test commands, all FOREGROUND:
  - edge: `cd kiosk_laptop/edge && .venv/bin/python -m pytest tests/<files> -q` (the whole suite with `-q`)
  - kiosk: `npm --prefix kiosk test -- <files relative to kiosk/>`; full suite `npm --prefix kiosk test`; build `npm --prefix kiosk run build`
- Every commit message ends with a `Co-Authored-By:` line naming the model that wrote the commit.

## Review Focus

1. **The usual crate:** the crate is read at A, its devices within ±5 s, then nothing more. It must be decided at A + 10 s on the laptop clock (+1 s slack), not at the old "last new tag + 10 s". → Task 2 `test_quiet_dock_decides_ten_seconds_after_the_crate`.
2. **A straggler after the window:** a device read at A + 7 s with no crate near it extends the burst to A + 12 s. It is "No crate read"; the crate still packs its own devices. → Task 2 `test_straggler_extends_and_is_no_crate`.
3. **The reader clock is hours off:** the idle decision must still come 10 s after the crate arrived, counted on the laptop's clock. → Task 2 `test_idle_decision_follows_arrival_when_reader_clock_is_off`.
4. **Legacy dry-run reads at upgrade** (an open burst holding stamped reads, unsent scans): they never upload, and their pass reads "Would pack". → Task 1 `test_legacy_dry_run_reads_never_upload` and `test_legacy_dry_run_pass_still_would_pack`.
5. **The result holds without a timer:** it stays past 6 s, clears on the next tag, and passes already listed on first load never take the card. → Task 3 `a decided pass holds the card until the next tag`.

---

### Task 1: Edge — remove dry run, the Window setting and Pause

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/dock/state.py`, `dock/grouper.py` (plumbing only, no rule change), `dock/views.py`, `dock/sender.py`, `routes/dock.py`, `rfid/tagreads.py`, `rfid/uploader.py`, `rfid/processing.py` (docstring only)
- Test: `kiosk_laptop/edge/tests/test_dock_state.py`, `test_dock_routes.py`, `test_dock_control.py`, `test_dock_grouper.py`, `test_dock_sender.py`, `test_dock_open_pass.py`, `test_dock_station.py`, plus any uploader/tagreads test that sets the Dock dry-run setting (grep `save_settings\|dry_run\|quiet_gap_s` under `tests/`)

**Interfaces:**
- Produces:
  - `edge.dock.state.WINDOW_S = 5`, replacing `DEFAULTS` and `GAP_RANGE`.
  - `settings`, `settings_in`, `save_settings` and `dry_run_on` are removed.
  - `clear_passes(c)` is kept as is. `reset(c)` stays and keeps deleting any legacy `dock_settings` row.
  - `GET /edge/dock` returns `{"open", "passes", "control"}`, with no `settings`.
  - `PUT /edge/dock/settings` is gone (a request to it is a 404 or 405).
  - `POST /edge/dock/control` accepts `start` and `stop` only; `pause` is a 422 `bad_request`.
  - The grouper uses `state.WINDOW_S` for W, and its `_EDGE` margin uses `2 * state.WINDOW_S`.
  - `_decide(c, b, w_s)` no longer takes `dry_run_now`. A pass is dry run only when one of its own reads is stamped. Passes still store `quiet_gap_s = WINDOW_S`, which the sender's laptop-clock fallback reads.
  - `tagreads` never stamps `dry_run` (it writes NULL).
  - The uploader drops its Dock dry-run gate, and the sender's `_may_send` drops `dry_run_on`.
  - `processing` still files a stamped read as `upload_state = 'dry_run'`.

- [ ] **Step 1: Write the failing tests**
  - `test_window_is_fixed_at_five`: `state.WINDOW_S == 5`, and no `save_settings` attribute.
  - `test_overview_has_no_settings`: the `GET /edge/dock` body keys are exactly `{"open", "passes", "control"}`.
  - `test_settings_route_is_gone`: `PUT /edge/dock/settings` → 404 or 405.
  - `test_pause_is_refused`: `POST /edge/dock/control {"action":"pause"}` → 422, the reader is not called and `control` is unchanged.
  - `test_reads_are_never_stamped_dry_run`: a Dock setup with a legacy `dock_settings` row `dry_run = 1` → an ingested read has `dry_run` NULL, and its pending scan is `pending`.
  - `test_legacy_dry_run_reads_never_upload`: a read stamped `dry_run = 1` → its scan is `dry_run` and the uploader never sends it.
  - `test_legacy_dry_run_pass_still_would_pack`: a burst holding one stamped read → the pass is `dry_run`, `send_state = 'none'`, overview status `would_pack`.
  - `test_live_pack_is_sent_with_legacy_settings_row`: with a `dock_settings` row `dry_run = 1` present, a fresh pack is `pending` and the sender sends it.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement.** Update the remaining tests that relied on the setting (save it, toggle it, or set W) to use the fixed window and always-live behavior.
- [ ] **Step 4: Run the Dock and RFID test files, then the whole edge suite; expect PASS.**
- [ ] **Step 5: Commit** `refactor(edge): Dock dry run, Window setting and Pause removed; the window is a fixed 5 s`

### Task 2: Edge — a burst ends on the crate's window, not a quiet gap

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/dock/grouper.py`, `dock/views.py`
- Test: `kiosk_laptop/edge/tests/test_dock_grouper.py`, `test_dock_open_pass.py`

**Interfaces:**
- Consumes: Task 1's `state.WINDOW_S` (W) and `_decide(c, b, w_s)`.
- Produces:
  - `_Burst` gains `last_crate_at: datetime | None`: the newest first read of a `container` tag in the burst. It is loaded in `_open_burst` from `dock_pass_tags.first_read_at` and kept up to date in `_add` when a new container tag joins.
  - `settle(b, w) -> datetime`: `max(b.last_crate_at + 2*w, b.last_new_at + w)`, or `b.last_new_at + w` with no crate.
  - The active path decides the open burst before adding a read whose read time `t > settle(current, w)`, replacing `t - last_new_at > 2W`.
  - The idle path decides once `now >= last_new_received_at + (settle - last_new_at) + _IDLE_SLACK`, replacing `last_received_at + 2W + 1 s`.
  - The leftover (no-crate) pass's `closed_at` becomes `last_new_at + W`. A crate group's stays at `anchor + W`.
  - `_decide`, `_split`, `crate_windows` and `crate_groups` are unchanged.
  - `views._open_pass` drops `seconds_left` and `window_s` and keeps every other field. `overview` passes `state.WINDOW_S` to it.
  - The module docstring describes the new end rule.

- [ ] **Step 1: Write the failing tests.** Use W = 5 throughout. Every read below has `received_at = read_at` unless the test says otherwise.
  - `test_quiet_dock_decides_ten_seconds_after_the_crate`: asset 0 s, crate 2 s, asset 6 s, then idle.
    - The burst is open at laptop now = 2 + 10 + 1 − 0.001 s.
    - It is decided at 2 + 10 + 1 s.
    - Both assets pack into the crate.
  - `test_crate_last_decides_ten_after_it`: assets 0 and 1 s, crate 3 s → decided by idle at 3 + 10 + 1 s.
  - `test_no_crate_decides_five_after_last_device`: assets 0 and 2 s → decided at 2 + 5 + 1 s as `no_crate`, with `closed_at` = 7 s.
  - `test_straggler_extends_and_is_no_crate`: asset 0 s, crate 1 s, asset 7 s.
    - The burst stays open past 1 + 10 + 1 s.
    - It is decided at 7 + 5 + 1 s.
    - The crate packs the 0 s asset; the 7 s asset is a `no_crate` pass.
  - `test_read_after_settle_opens_new_burst`: crate 0 s, asset 2 s, then asset 10.5 s (> settle = 10) arrives live.
    - The first burst is decided (packs the 2 s asset).
    - The 10.5 s asset opens a new burst.
  - `test_read_at_settle_joins`: crate 0 s, then crate B at exactly 10 s → same burst, both crates flagged `many_crates` (2W chaining, inclusive).
  - `test_idle_decision_follows_arrival_when_reader_clock_is_off`: the same reads as the first test with `read_at` 3 h behind `received_at` → decided at the crate's `received_at` + 10 + 1 s, not before.
  - `test_reread_never_extends`: crate 0 s, asset 1 s, then re-reads of both every 0.5 s up to 9.5 s → decided at 0 + 10 + 1 s.
  - `test_open_pass_has_no_countdown`: the open pass has no `seconds_left` or `window_s` keys, and keeps `crates`, `conflict`, `added_count` and `tags`.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement.** Re-time the existing grouper tests that encoded "2W after the last new tag" to the new rule. Keep their membership assertions unchanged.
- [ ] **Step 4: Run `tests/test_dock_grouper.py tests/test_dock_open_pass.py tests/test_dock_routes.py tests/test_dock_control.py`, then the whole edge suite; expect PASS.**
- [ ] **Step 5: Commit** `feat(edge): a Dock burst is decided 2W after its newest crate (W after a later straggler), not 2W after its last new tag`

### Task 3: Kiosk — no countdown, no dry run, Window or Pause; the result holds until the next tag

**Files:**
- Modify: `kiosk/src/pages/DockStation.tsx`, `kiosk/src/lib/api.ts`, `kiosk/src/styles/kiosk.css` (Dock section)
- Test: `kiosk/src/pages/DockStation.test.tsx` and any test that imports `saveDockSettings` or `DockSettings` (grep)

**Interfaces:**
- Consumes: Tasks 1–2. The overview is `{open, passes, control}`; `open` has no `seconds_left` or `window_s`; `DockControl` is `'start' | 'stop'`.
- Produces:
  - **`api.ts`:**
    - Remove `DockSettings`, `saveDockSettings`, `DockOverview.settings`, `DockOpenPass.seconds_left` and `DockOpenPass.window_s`.
    - `DockControl = 'start' | 'stop'`.
    - `DockPassStatus` keeps `would_pack` (legacy passes).
  - **`DockStation.tsx`:**
    - Removed: the settings card (Dry run, Window), the Pause button, the "Finishing in" bar, the `Dry run` chip, `RESULT_MS` and its timer, `parseWindow`, `WINDOW_MIN`/`WINDOW_MAX`, the settings state and the `Paused` reader text.
    - **The result holds without a timer.** When a poll finds a newly decided pass (same `newlyDecided` rule) and that poll's `open` has no tags, the card shows its result. It stays until a poll's `open` has any tag, then the open burst takes the card.
    - **While the result holds, the list keeps that burst's asset rows** as the last poll before the decision showed them (`before.open.tags` and `before.open.crates`). A row's chip reads `Added` instead of `Adding` once that pass is `packed`.
    - **The result card:**
      - `waiting` uses the `found` look (accent, not green), with the crate name and `Waiting to send`.
      - `packed` stays green with `Packed N devices`.
      - The flagged, refused and nothing cards are unchanged.
      - The legacy `would_pack` card stays as is.
    - The live chip for an in-window asset is always `Adding`. The count sub-line is `in {crate}`; `would go into {crate}` is used only for a legacy `would_pack` result.
    - **Bottom row:** Start and Stop, each half the width. Start sub-copy is unchanged. Stop's sub-copy is `Stop reading, finish this crate now` and it is never disabled.
    - Rewrite the file's header comment for the new behavior.
  - **`kiosk.css`:** remove the now-unused Dock rules (`.dock-window*`, `.dock-settings*`, `.dock-set-*`, `.dock-win*`, `.dock-label-chip`, the Dock `.is-pause` rule and their dark-mode lines), and make `.dock-bottom` and `.dock-reader` lay out two buttons.

- [ ] **Step 1: Write the failing tests:**
  - **`no settings, no Pause, no bar`:** no Dry run switch, Window field, Pause button or `Finishing in` text in any state.
  - **`a decided pass holds the card until the next tag`:**
    - Fake timers. A crate's open burst, then a poll with that pass newly decided and `open: null`: the card shows its crate and `Waiting to send`, and the list still shows the burst's devices.
    - After 30 s of polls with the pass still on top, the card still shows it. When the pass turns `packed` it reads `Packed 2 devices`, the chips read `Added`, and the look is green.
    - Then a poll whose `open` has one asset tag: the card shows `Scanning` and the list shows that asset.
  - **`passes listed on first load never take the card`.**
  - **`Stop and Start only`:**
    - Exactly two reader buttons, Start and Stop.
    - Stop is enabled while unreachable, loading and busy.
    - Pressing Stop calls `controlDock('stop')`.
  - **`a legacy would_pack pass still reads Would pack`** in Recent passes.
  - Adapt the existing card, list, modal, poll, unreachable and control tests to the new layout, keeping what each one asserts.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Visual check in light AND dark in a real browser: a throwaway harness on a worktree kiosk dev server with headless Chrome; delete the harness and stop the server before committing. Save screenshots of scanning, crate found, waiting to send, packed and stopped (light and dark) to `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/dock-station/.devlogs/theme-shots/no-timer-*.png`.
- [ ] **Step 4: Run the Dock tests, then the full kiosk suite and `npm --prefix kiosk run build`; expect PASS.**
- [ ] **Step 5: Commit** `feat(kiosk): Dock screen without a countdown, dry run, Window or Pause; a decided crate holds the card until the next tag`

## After the tasks (controller)

1. Whole-change review, then fixes.
2. Merge locally into main. Rebuild the 8090 laptop container (no API change, no migration) with the env vars inline and `--force-recreate`, then verify the mount and URLs.
3. Append a short implementation note to the spec.
