# Dock Screen Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the kiosk's Dock screen (`/dock`) to match Jimmy's approved mockup `docs/mockups/dock-station-kiosk.html` (in the main checkout, served at http://127.0.0.1:8790/dock-station-kiosk.html), which follows the Truck Packing kiosk mockup's layout.

**Architecture:** The edge's `/edge/dock` overview gains the details the new screen needs about the open burst: the crate (or crates) read so far, each asset's serial number and first read time, and whether each asset is inside a crate's window. These are computed with the grouper's own window test, so the screen always agrees with what will be packed. The kiosk's `DockStation.tsx` is re-laid out as two cards along the top, the crate's running device list beside Recent passes, and the settings plus big Start / Pause / Stop buttons along the bottom.

**Tech Stack:** FastAPI + stdlib sqlite3 (`kiosk_laptop/edge`), React 18 + Vite + vitest (`kiosk/`).

**Spec:** `docs/superpowers/specs/2026-11-05-dock-station-design.md`; its "Changes after the first test (2026-11-06, Jimmy)" section and implementation notes describe the rules. The mockup is the binding design for layout and copy.

## Global Constraints

- Work only in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/dock-station` (branch `dock-station`). Never commit `api/src/serversherpa/_dev_reload.py` or `.superpowers/`.
- American English. Times are 24-hour `HH:MM:SS`, never AM/PM.
- Always follow the kiosk's light or dark theme; never force one. Colors come only from the portal tokens (`--paper`, `--paper-2`, `--paper-line`, `--surface`, `--surface-2`, `--text-dark`, `--text-mute`, `--c-green*`, `--c-amber*`, `--c-red*`, `--c-slate*`, `--accent`, `--accent-rgb`), as the mockup does.
- Every action has a visible on-screen control. Stop is never disabled. Rounded corners on cards and the modal. No default browser scrollbars: lists that can grow scroll inside their card with the themed slim scrollbar (`chrome.css`'s themed-scrollbar rule, as the mockup's `.tp-list-wrap.scroll` does).
- Match the surrounding style and comment density. Reuse kiosk idioms (`rfid-dash-btn` for the big buttons, `Switch`, `mini-btn`, `chip`, `displayEpc`, `clockText`, `readerState` / `readerErrorText`). Keep existing behaviors and their tests unless this plan changes them.
- Pinned copy (from the mockup): card labels `Crate` and `Assets added to crate`; `Scanning` (with an animated ellipsis) and `Waiting for a crate tag`; `Finishing in` + `{N} s`; `Paused` / `Stopped` with `Press Start to read again`; panel titles `In this crate` (hint `Devices read at the curtain, newest first.`) and `Recent passes` (hint `Newest first.`); list columns `Device`, `Serial`, `Tag`, `Read`, `Status`; status chips `Waiting for crate`, `Would add` (dry run) / `Adding`, `Outside window`; empty states `Devices appear here as they pass the curtain.` and `No passes yet.`; count sub-lines `no crate yet`, `waiting for a crate tag`, `would go into {crate}` (dry run) / `in {crate}`; bottom settings `Dry run` (hint `Nothing is sent to the portal.`) and `Window` (hint `Seconds before and after the crate tag`); buttons `Start` (sub `Start reading tags`, or `Reading` while reading), `Pause` (sub `Stop reading, keep this crate`), `Stop` (sub `Stop reading, finish this crate now`); a `Dry run` chip on the crate card while dry run is on. Existing copy stays where the mockup doesn't replace it (Recent passes outcomes, the pass modal, `Can't reach the station. Retrying…`, `Checking…`, the Window `1–60 seconds` error).
- Test commands, all FOREGROUND: edge `cd kiosk_laptop/edge && .venv/bin/python -m pytest tests/<files> -q` (whole suite `-q`); kiosk `npm --prefix kiosk test -- <files relative to kiosk/>`, full `npm --prefix kiosk test`, build `npm --prefix kiosk run build`. DOM test files start with `// @vitest-environment jsdom`.
- Every commit message ends with a `Co-Authored-By:` line naming the model that wrote the commit.

## Decisions this plan makes

1. The crate card shows the **newest** crate read in the open burst. When another crate's first read is within 2W of it, the card turns red with `More than one crate` and names both (the burst will be flagged at the end).
2. An asset's status is relative to every crate in the burst: inside any crate's window → `Adding` / `Would add` (and the row names that crate if there is more than one); crates read but the asset is in none of their windows → `Outside window`; no crate yet → `Waiting for crate`. The edge computes this with the grouper's own window test (any read within W of a crate's first read, inclusive).
3. `Assets added to crate` counts the assets inside the newest crate's window.
4. After a burst is decided, the crate card shows the newest decided pass's result for 6 s (green `Packed`, amber `Would pack {N} into {crate}`, red `No crate read` / `More than one crate`, neutral `Nothing to pack`), then returns to Scanning. The kiosk detects a newly decided pass by its id appearing at the top of `passes`, not by clocks.
5. The Light/Dark switch in the mockup's header is mockup-only; the real screen follows the person's theme.

## Review Focus

1. **The screen and the decision disagree:** an asset shown `Adding` must be packed when the burst is decided, and one shown `Outside window` must not. → Task 1 `test_open_pass_window_status_matches_the_decision`.
2. **Two crates in one burst**, within 2W and further apart. → Task 1 `test_open_pass_reports_crates_and_conflict`; Task 2 `two crates within 2W turn the card red`.
3. **A long burst** (a crate parked in the curtain, 100+ reads): the overview stays one cheap query set per poll, not per read. → Task 1 `test_open_pass_with_many_reads`.
4. **The result flash after a decision** shows once per new pass and never for passes that were already listed when the page opened. → Task 2 `a pass decided while watching flashes once`.
5. **The edge unreachable or Checking…** with the new layout: the cards and lists still say so, and Stop stays enabled. → Task 2 `unreachable keeps Stop enabled`.

---

### Task 1: Edge — open-burst details for the new screen

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/dock/views.py` (`_open_pass`)
- Modify: `kiosk_laptop/edge/src/edge/dock/grouper.py` (expose the window test for views; no behavior change)
- Test: `kiosk_laptop/edge/tests/test_dock_routes.py` (or a new `tests/test_dock_open_pass.py`)

**Interfaces:**
- Produces: `GET /edge/dock`'s `open` gains, keeping every existing field:
  - `window_s: int`
  - `crates: [{"epc": str, "label": str | None, "first_read_at": str}]` in first-read order (ISO with ms, the grouper's `read_time`)
  - `conflict: bool`: any two crates' first reads within 2W of each other
  - `added_count: int`: assets inside the newest crate's window
  - each `tags[]` item gains `first_read_at: str`, `serial: str | None` (assets only, from the move cache; null otherwise), `in_window: bool | None` (assets only: null when no crate has been read yet, else whether any of its reads is within W of any crate's first read), `crate_label: str | None` (assets inside a window: the newest crate whose window holds it)
- Consumes: `grouper.read_time`, the grouper's window test (refactor `_near` or equivalent into a function views can call), `processing.indexes` for serials.

- [ ] **Step 1: Write the failing tests:** an open burst of asset A at 0 s, crate C at 2 s, asset B at 6 s, asset D at 8 s (W = 5) gives `crates == [C]`, `conflict is False`, `added_count == 2`, A and B `in_window True` with `crate_label` C, D `in_window False`; before the crate is read, assets have `in_window None` and `crates == []`; asset serials come from the cache; `test_open_pass_window_status_matches_the_decision`: for the same reads, decide the burst and assert every `in_window True` asset is in the pack and every `False` one is not; `test_open_pass_reports_crates_and_conflict`: crates 7 s apart → `conflict True`, 13 s apart → `False`; `test_open_pass_with_many_reads`: 200 re-reads of 3 tags produce the same answer as 3 reads.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement** (read the burst's reads once per call, grouped by epc, and reuse the grouper's window test).
- [ ] **Step 4: Run the new tests, `tests/test_dock_routes.py tests/test_dock_grouper.py`, then the whole edge suite; expect PASS.**
- [ ] **Step 5: Commit** `feat(edge): the Dock overview reports the open burst's crates, serials and window status`

### Task 2: Kiosk — the Dock screen laid out like the mockup

**Files:**
- Modify: `kiosk/src/pages/DockStation.tsx`, `kiosk/src/lib/api.ts` (`DockOpenPass` and `DockTag` gain Task 1's fields), `kiosk/src/styles/kiosk.css` (the Dock section)
- Test: `kiosk/src/pages/DockStation.test.tsx`, `kiosk/src/lib/api.dock.test.ts` if types are pinned there

**Interfaces:**
- Consumes: Task 1's `open` fields; the existing `getDock`, `getDockPass`, `saveDockSettings`, `controlDock`, `getReaderStatus`, `DockPassModal`.
- Produces: the layout in the mockup, inside the existing page shell, as one grid filling the main area:
  1. **Top row:** the crate card (states per Decisions 1 and 4 and Paused / Stopped; the `Finishing in {N} s` bar from `seconds_left` over 2W; the `Dry run` chip) and the `Assets added to crate` card (the big count with the bump animation, and its sub-line).
  2. **Middle row:** `In this crate`, the open burst's assets newest first (device label, serial, `displayEpc(tag)`, read time `HH:MM:SS`, status chip per Decision 2, a short highlight on the newest row), with a device-count chip and the empty state; and `Recent passes`, today's table moved here with its existing outcome copy and `Details` opening `DockPassModal`, and a pass-count chip.
  3. **Bottom row:** the settings card (Dry run switch row and Window field row with Save, stacked) and the big Start / Pause / Stop buttons, with today's control behavior and states unchanged.
  - The unreachable line, `Checking…` and the reader-state handling from today stay, placed so they're visible in the new layout.

- [ ] **Step 1: Write the failing tests:** the crate card shows `Scanning` and `Waiting for a crate tag` with no crate; the crate's name and `Finishing in 3 s` once `open.crates` has one and `seconds_left` is 2.4; `two crates within 2W turn the card red` (`conflict: true` → `More than one crate`); the count card shows `added_count` and `would go into Crate A` in dry run / `in Crate A` otherwise; the list shows a row per asset newest first with serial, trimmed tag, `HH:MM:SS` and the right chip for `in_window` null / true / false; `a pass decided while watching flashes once` (a new top pass id shows its result on the crate card for 6 s with fake timers, then Scanning; passes already present on first load never flash); Paused / Stopped show on the crate card with `Press Start to read again`; `unreachable keeps Stop enabled`; existing control, settings, Window, modal and poll tests still pass (move or adapt their selectors, don't weaken them).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Visual check in light AND dark against the mockup in a real browser (throwaway harness on a worktree kiosk dev server with headless Chrome; delete the harness and stop the server before committing). Save screenshots to `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/dock-station/.devlogs/theme-shots/redesign-*.png` (scanning, crate found, result flash, paused; light and dark).
- [ ] **Step 4: Run the Dock tests, then the full kiosk suite and `npm --prefix kiosk run build`; expect PASS.**
- [ ] **Step 5: Commit** `feat(kiosk): Dock screen laid out like the truck-packing kiosk: crate and count cards, the crate's running device list, buttons along the bottom`

## After the tasks (controller)

1. Whole-change review, fixes.
2. Merge locally into main and rebuild the 8090 laptop container (no API change, no migration).
3. Append a short implementation note to the spec.
