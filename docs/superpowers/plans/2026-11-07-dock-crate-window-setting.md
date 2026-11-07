# Dock Crate Window Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Dock's crate window (W, fixed at 5 s today) a laptop setting. Admins can set it from 1 to 10 s and developers can set any value, on a new laptop-only RFID tab in kiosk Settings.

**Architecture:**
- The edge stores W in a new one-row table. It serves W at `GET/PUT /edge/dock/window`, with the role rules enforced there.
- Each burst records the W it opened with, and the grouper and the open-burst view use that burst's own W. A change therefore applies from the next burst.
- The kiosk adds an `rfid` Settings tab with one "Crate window" row, built like the Sound tab's off-move alarm seconds.

**Tech Stack:** Edge: FastAPI + stdlib sqlite3 (`kiosk_laptop/edge`, pytest). Kiosk: React 18 + Vite + vitest (`kiosk/`).

**Spec:** `docs/superpowers/specs/2026-11-05-dock-station-design.md`, section "Crate window setting (2026-11-07, Jimmy)". Also read "Pass rules" and "Changes after the second test" for what W does.

## Global Constraints

- Defaults and ranges, as constants in `edge/dock/state.py`: `DEFAULT_WINDOW_S = 5`, `ADMIN_MIN_S = 1`, `ADMIN_MAX_S = 10`, `MAX_WINDOW_S = 3600`.
- Admins (edge `session.max_rank >= ADMIN_RANK` (60); kiosk `isAdmin`) may set a **whole number from 1 to 10**.
- Developers (`"developer"` in the session's `roles`; kiosk `isDeveloper`) may set **any number above 0, up to 3600**, decimals allowed.
- Everyone else: GET only. PUT answers 403 `forbidden`.
- An invalid value answers 422 `invalid_window`. That covers a bool, a string, null, NaN/inf, 0, a negative, over the role's range, or a non-whole number from a non-developer.
- The two-crate rule stays 2W, and a burst is decided at max(newest crate + 2W, newest new tag + W), using the burst's own W.
- A burst keeps the W it opened with. A change applies from the next burst.
- Clear Setup (`state.reset`) and Wipe put W back to 5 by deleting the row. `clear_passes` (move or station-type change) keeps it.
- The legacy `dock_settings` table is never read.
- Never call W a timer in copy, comments or docs. It's the window around the crate scan.
- American English. Copy strings below are exact.
- The edge's `edge/dock/state.py` imports nothing from `edge` (`laptop_setup` imports it).

## Review Focus

1. **A setting change while a burst is open.** The open burst must keep its W through `settle`, the decision and the open-burst view. Nothing already read regroups. Test: `test_window_change_applies_from_the_next_burst`.
2. **An admin who isn't a developer sending a developer value** (0.5, 30), and bad JSON (`true`, `"5"`, `null`, 0, -1, 3601, NaN). Each must answer 422. A developer's 0.5 and 3600 are saved. Test: `test_window_put_rules_by_role`.
3. **A laptop upgraded mid-burst**: an open row with `quiet_gap_s` NULL must use the current setting, with no crash. Test: `test_open_burst_without_a_window_uses_the_setting`.
4. **An admin looking at a developer's 30.** The field shows 30. Blur or Enter without a change sends nothing and shows no invalid message. Test: `an admin sees a developer's value and leaving it saves nothing`.
5. **Clear Setup and Wipe reset W; a move change doesn't.** A row in the old `dock_settings` table never sets W. Tests: `test_window_reset_by_clear_setup_not_by_move_change`, `test_legacy_dock_settings_row_is_ignored`.

---

### Task 1: Edge — the stored window, its route, and per-burst W

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/db.py`: append one migration step creating `dock_window (id INTEGER PRIMARY KEY CHECK (id = 1), window_s REAL NOT NULL)`.
- Modify: `kiosk_laptop/edge/src/edge/dock/state.py`: constants, `window_s`, `parse_window`, `save_window`, `reset` deletes `dock_window`, and a module docstring that no longer says the window is fixed.
- Modify: `kiosk_laptop/edge/src/edge/routes/edge.py`: add `"dock_window"` to `MOVE_TABLES` (Wipe empties it).
- Modify: `kiosk_laptop/edge/src/edge/routes/dock.py`: `GET` and `PUT /edge/dock/window`, plus its docstring.
- Modify: `kiosk_laptop/edge/src/edge/dock/grouper.py`:
  - `_Burst` carries its W.
  - `_open` records `quiet_gap_s`.
  - `_open_burst` loads it (NULL → `state.window_s(c)`).
  - `settle` and `_decide` use the burst's W.
  - `group` reads the setting once per tick for new bursts.
  - `_EDGE` uses `2 * state.MAX_WINDOW_S`.
  - The module docstring says W is the setting, kept per burst.
- Modify: `kiosk_laptop/edge/src/edge/dock/views.py`: `_open_pass` uses the open row's `quiet_gap_s` (NULL → `state.window_s`). `overview` no longer reads `state.WINDOW_S`.
- Remove `state.WINDOW_S` once nothing uses it.
- Tests: `kiosk_laptop/edge/tests/test_dock_state.py`, `test_dock_routes.py`, `test_dock_grouper.py`, `test_dock_open_pass.py`. Update any test that pins the window as fixed: `test_window_is_fixed_at_five` becomes `test_window_defaults_to_five`.

**Interfaces:**
- Produces, in `edge.dock.state`:
  - `window_s(c) -> float`: the saved W, or `DEFAULT_WINDOW_S`. `c` is a sqlite3 connection, as for `clear_passes`.
  - `parse_window(value, *, developer: bool) -> float`: raises `ValueError`.
  - `save_window(c, value: float) -> None`.
- Produces the HTTP contract the kiosk consumes:
  - `GET /edge/dock/window` → `200 {"window_s": <number>}`, for any edge session, online or offline.
  - `PUT /edge/dock/window` with body `{"window_s": <number>}` → `200 {"window_s": <saved number>}`.
  - `403 {"detail": {"code": "forbidden"}}` below admin rank.
  - `422 {"detail": {"code": "invalid_window"}}` on a value the caller's role may not set. A body that isn't a JSON object stays the existing 422 `bad_request` from `json_object`.

- [ ] **Step 1: Write the failing tests**
  - `test_window_defaults_to_five`: a fresh store; `state.window_s(c) == 5`.
  - `test_window_put_rules_by_role` (`test_dock_routes.py`). Use the existing session helpers to make three sessions: worker (rank below 60), admin (rank 60, roles without `developer`) and developer (`roles` containing `"developer"`, rank 100).
    - Worker: PUT 3 → 403 `forbidden`.
    - Admin: PUT 1, 10 and 7 → 200 with `window_s` echoed.
    - Admin: 0.5, 30, 11, 0, -1, 7.5, `true`, `"5"` and `null` → 422 `invalid_window`.
    - Developer: 0.5, 30 and 3600 → 200.
    - Developer: 0, -2, 3601, `true` and `"5"` → 422.
    - Any session's GET returns the last saved value.
  - `test_window_reset_by_clear_setup_not_by_move_change`: save 3. A move change (the path that calls `clear_passes`) keeps 3. `state.reset` (Clear Setup) gives 5.
  - `test_wipe_resets_the_window`: save 3, Wipe → GET answers 5.
  - `test_legacy_dock_settings_row_is_ignored`: insert `dock_settings (1, 1, 2)`; `window_s` is 5.
  - `test_window_change_applies_from_the_next_burst` (grouper):
    - Save 2, then open a burst with a crate at t0 and an asset at t0+1.5 s.
    - Save 8 while the burst is open, then read an asset at t0+3 s.
    - With W=2, settle is t0+4 s, so that asset is still in the burst but outside the crate's 2 s window.
    - The decision uses W=2: the t0+1.5 s asset packs and the t0+3 s asset is `no_crate`. Both passes have `quiet_gap_s == 2`.
    - The next burst's row has `quiet_gap_s == 8`.
  - `test_open_burst_without_a_window_uses_the_setting`: an open row with `quiet_gap_s` NULL. Save 3; its settle follows W=3, with no exception.
  - `test_open_pass_uses_its_burst_window` (`test_dock_open_pass.py`): an asset 4 s from the crate reads `in_window: false` in a burst opened with W=3, even after the setting changes to 10.
  - `test_developer_fractional_window_groups`: W=0.5. An asset 0.4 s from the crate packs, and one 0.6 s away is `no_crate`.

- [ ] **Step 2: Run them to see them fail**
  Run: `cd kiosk_laptop/edge && .venv/bin/pytest tests/test_dock_state.py tests/test_dock_routes.py tests/test_dock_grouper.py tests/test_dock_open_pass.py -q`
  Expected: the new tests fail (no `window_s`, no route).

- [ ] **Step 3: Implement** the files above.
  - `parse_window` rejects `bool` before the number check, because `True` is an `int`, and rejects non-finite values.
  - A non-developer's value must be integral: `value == int(value)`.
  - `quiet_gap_s` stores the float as it is (SQLite keeps 0.5 in the INTEGER-affinity column).
  - The route decides `developer` from `session.session.get("roles") or []`.

- [ ] **Step 4: Run the whole edge suite**
  Run: `cd kiosk_laptop/edge && .venv/bin/pytest -q`
  Expected: all pass.

- [ ] **Step 5: Commit**: `feat(edge): the Dock's crate window is a laptop setting (admins 1–10 s, developers any), kept per burst`

### Task 2: Kiosk — the RFID tab and its Crate window row

**Files:**
- Modify: `kiosk/src/lib/settingsTabs.ts`: add `{ id: 'rfid', label: 'RFID', blurb: 'How the Dock groups RFID reads into crates on this laptop.', laptopOnly: true }` right after `devices`, and `'rfid'` in `SettingsTabId`.
- Modify: `kiosk/src/lib/api.ts`, in the Dock section:
  - `export interface DockWindow { window_s: number }`
  - `getDockWindow(): Promise<DockWindow>` (GET `/edge/dock/window`)
  - `saveDockWindow(window_s: number): Promise<DockWindow>` (PUT, JSON body `{ window_s }`)
- Create: `kiosk/src/components/RfidPanel.tsx`.
- Modify: `kiosk/src/pages/Settings.tsx`: `{active.id === 'rfid' && <RfidPanel />}`.
- Tests: `kiosk/src/components/RfidPanel.test.tsx`, plus additions to `kiosk/src/lib/settingsTabs.test.ts`, `kiosk/src/lib/api.dock.test.ts` and `kiosk/src/pages/Settings.test.tsx` (the tab shows on a laptop, not in web mode).

**Interfaces:**
- Consumes Task 1's HTTP contract.
- Consumes `useKioskAuth()` → `{ status, isAdmin, isDeveloper }`.

**The row:** follow `OffMoveAlarmSettings.tsx`'s idioms: `settings-row`, load once, controls disabled until loaded, save on blur or Enter, only the newest save applies, and a failed save restores the last saved value. Exact copy:
- Label: `Crate window`
- Hint: `Devices read within this many seconds before or after a crate tag go into that crate. Two crates read within twice this time are both flagged, and nothing in them packs. A change applies from the next crate.`
- Input: `type="text"` with `inputMode="decimal"`, `aria-label="Crate window in seconds"`, followed by the unit `seconds`.
- Locked line (not admin, not developer): `Only an admin can change this.`
- Invalid (admin): `Enter a whole number of seconds from 1 to 10.`
- Invalid (developer): `Enter a number of seconds above 0, up to 3600.`
- Load failure: `Couldn't read the crate window from this laptop.`
- Save failure: `Couldn't save the crate window. The last saved value is still in use.`
- Save answered 403: `Only an admin can change this.`
- Who may edit: `isDeveloper` → the developer rule; else `isAdmin` → the admin rule; else the field is disabled with the locked line. The field shows the saved value as `String(n)`, so 5 shows as "5" and 0.5 as "0.5".

- [ ] **Step 1: Write the failing tests** (`RfidPanel.test.tsx`, mocking `../lib/api` and the auth hook the way `OffMoveAlarmSettings`' tests do):
  - `shows the saved window and its hint`: GET returns 5; the field reads "5" and the hint text is exact.
  - `an admin saves a whole number from 1 to 10 on blur and on Enter`: 7 on blur and 3 on Enter each call `saveDockWindow` once.
  - `an admin can't save 0.5, 11 or text, and sees why`: no save call; the admin invalid line shows.
  - `a developer can save 0.5 and 30 but not 0 or 3601`.
  - `an admin sees a developer's value and leaving it saves nothing`: GET returns 30; focus then blur, and Enter, make no save call and show no invalid line.
  - `a worker sees the value locked`: the field is disabled and shows the locked line.
  - `a failed save restores the last saved value and says so`, and `a 403 says only an admin can change this`.
  - `a failed read leaves the field disabled and says so`.
  - In `settingsTabs.test.ts`: `RFID is laptop only, after Devices`.
  - In `api.dock.test.ts`: `getDockWindow` and `saveDockWindow` hit `/edge/dock/window` with GET and PUT `{"window_s":7}`.
- [ ] **Step 2: Run them to see them fail**
  Run: `cd kiosk && npx vitest run src/components/RfidPanel.test.tsx src/lib/settingsTabs.test.ts src/lib/api.dock.test.ts src/pages/Settings.test.tsx`
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run the whole kiosk suite, the type check and the build**
  Run: `cd kiosk && npx tsc --noEmit -p . && npx vitest run && npm run build`
  Expected: all pass.
- [ ] **Step 5: Commit**: `feat(kiosk): Settings › RFID with the Dock's Crate window (admins 1–10 s, developers any)`
