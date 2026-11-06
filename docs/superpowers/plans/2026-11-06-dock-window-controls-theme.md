# Dock Station: Crate Window, Start / Pause / Stop, Follow the Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Dock's "closes after a quiet gap" grouping with the crate-anchored window, add Start / Pause / Stop to the Dock screen, and let the Dock screen and the RFID Reader dashboard follow the kiosk's light or dark theme.

**Architecture:** The edge grouper keeps its open-row machinery but the open row is now a *burst* that ends 2W after its last new tag; when it ends, its reads are split into one pass per crate group plus one leftover pass, each with an anchor (the crate's first read) the sender takes the pass time from. A new session-gated `POST /edge/dock/control` drives the reader through the same code as `/edge/rfid/start|stop`, remembers the last button, and on Stop decides the open burst at once. The kiosk drops the forced dark theme and adds the reader group to the Dock screen's control strip.

**Tech Stack:** FastAPI + stdlib sqlite3 (`kiosk_laptop/edge`), React 18 + Vite + vitest (`kiosk/`). No API or portal change.

**Spec:** `docs/superpowers/specs/2026-11-05-dock-station-design.md`, section "Changes after the first test (2026-11-06, Jimmy)" (it replaces the earlier pass rules, the quiet-gap setting and the dark-only screen). The code as built: the same spec's Implementation notes and `docs/superpowers/plans/2026-11-05-dock-station.md`.

## Global Constraints

- Work only in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/dock-station` (branch `dock-station`). Never commit `api/src/serversherpa/_dev_reload.py` or `.superpowers/`.
- American English in all copy, comments and docs. Times on screen are 24-hour `HH:MM` / `HH:MM:SS`, never AM/PM.
- Every action has a visible on-screen control. Modals keep rounded corners. No default browser scrollbars.
- Always follow the kiosk's light or dark theme (the person's `preferences.theme`, applied by `applyPreferences`); never force one. Colors come from the portal tokens (`--paper`, `--paper-2`, `--paper-line`, `--surface`, `--text-dark`, `--text-mute`, `--c-green`, `--c-amber`, `--c-red`, `--accent`).
- Match the surrounding style and comment density. Reuse kiosk idioms: `rfid-dash-*` panels, states and buttons, `Switch`, `mini-btn`, `alarm-seconds`, `settings-row-*`, `readerState`, `readerErrorText` / `codeOf`.
- The window **W** is the existing setting: whole seconds **1–60**, default **5**, stored and sent as `quiet_gap_s` (column, settings key and JSON field all keep that name). On screen it is **Window**, hint `Seconds before and after the crate tag`.
- Rule values (spec): an asset packs into a crate when any of its reads is within W (inclusive) of the crate's **first** read; crates whose first reads are within **2W** are flagged together `More than one crate`; a burst ends **2W** after its last new tag; the pass time sent is the crate's first read + W on the reader's clock, or the laptop clock when they disagree by more than **60 s** (`sender.READER_SKEW_MAX_S`).
- Copy pinned: `No crate read`, `More than one crate`, `Start`, `Pause`, `Stop`, `Reading`, `Paused`, `Stopped`.
- Edge `SCHEMA_STEPS` stay additive; no `;` inside SQL comments.
- Every test command runs in the FOREGROUND with a 600000 ms timeout. Edge: `cd kiosk_laptop/edge && .venv/bin/python -m pytest tests/<files> -q` (whole suite: `-q`, no files). Kiosk: `npm --prefix kiosk test -- <files relative to kiosk/>`, full `npm --prefix kiosk test`, build `npm --prefix kiosk run build` (`tsc -b` type-checks the test files too). DOM test files start with `// @vitest-environment jsdom`.
- Every commit message ends with a `Co-Authored-By:` line naming the model that wrote the commit, e.g. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions this plan makes (the spec left them open)

1. A crate conflict is one pass: every crate in a chain of first reads each ≤ 2W from the next, with every asset within W of any of them, is one `many_crates` pass.
2. An asset with reads in the windows of two groups that are further apart than 2W merges them into one `many_crates` pass. "Decided separately" would otherwise pack it into whichever crate goes last, and the anti-goal says flag, never guess.
3. Bounds are inclusive: an asset exactly W from the crate packs; first reads exactly 2W apart conflict. A burst ends on a new read more than 2W after its last new tag (as before, strictly).
4. People, off-move and unknown tags join the earliest-anchored group whose window holds one of their reads, otherwise the leftover pass. They never pack and never merge groups.
5. A crate with no asset in its window is its own `nothing` pass ("Nothing to pack") and keeps its crate name, so Recent passes shows which crate passed empty.
6. A pass is dry run when any of **its own** reads was taken in dry run, or dry run is on when the burst is decided.
7. Each decided pass gets an anchor in two new columns (`anchor_at`, `anchor_received_at`). The burst's `last_new_*` / `last_received_at` keep their burst meaning on every pass of that burst.
8. The Open pass panel keeps its copy (`Open pass`, `Closes in N s`, `Closing…`). Its countdown is now 2W from the last new tag, the time until the burst is decided.
9. The last Dock button lives in memory (`app.state.dock_control`): null after an edge restart. The RFID Reader dashboard's START / STOP don't change it. Dock Start needs an online sign-in, as `/edge/rfid/start` does.
10. Stop stops the reader first, then decides the burst whatever the reader answered, then returns the reader's error if there was one.
11. The reader's running state comes from `GET /edge/rfid/status`, polled by the Dock screen on its own 5 s loop. The 1 s overview carries only `control`, because it must never wait on the reader. Besides Reading / Paused / Stopped, the screen shows the dashboard's `Checking…` and `Unreachable`, and `Starting…` / `Pausing…` / `Stopping…` while a call runs.
12. The buttons are a compact `rfid-dash-btn` trio: green Start, amber Pause, red Stop. Start is enabled under the RFID dashboard's rule, and Pause only while Reading. Stop is never disabled; a press while its own call is still running does nothing.
13. An invalid Window shows `1–60 seconds` in red on the hint line, in place of the hint.

## Review Focus

1. **An asset re-read in two crates' windows within one burst** (a crate lingers near the curtain while the next one arrives): both crates are flagged together and the asset is packed into neither. → Task 1 `test_an_asset_read_in_two_crate_windows_flags_both`.
2. **Dry run switched while a burst is open:** each pass is dry run when any of its own reads was. A live crate decided in the same burst still sends, and nothing read in dry run ever does. → Task 1 `test_dry_run_is_decided_per_pass`.
3. **Reads that arrive after Stop decided the burst** (the reader's last in-flight post): they open a new burst. A decided pass never gains a tag. → Task 2 `test_late_reads_after_stop_open_a_new_burst`.
4. **Stop on a stuck, unreachable or unpaired reader:** the burst is decided anyway, `control` is `stop`, and the reader's error comes back and shows on screen. → Task 2 `test_stop_decides_even_when_the_reader_does_not_answer`; Task 4 `a failed Stop says what went wrong`.
5. **Stop with a backlog larger than one batch, or with the move cache missing:** every stored read is grouped before the decision. While the grouper waits on the cache, nothing is decided. → Task 2 `test_decide_now_groups_the_backlog_first`.

---

### Task 1: Edge — the crate window and the pass time

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/db.py` (one new `SCHEMA_STEPS` entry at the end, after the Dock step ending ~line 254)
- Modify: `kiosk_laptop/edge/src/edge/dock/grouper.py` (module docstring, `_LATEST`, the burst rule in `group`, `_close` becomes the burst decision)
- Modify: `kiosk_laptop/edge/src/edge/dock/sender.py:17-25,73-83` (`_closed_at` from the anchor; docstring)
- Modify: `kiosk_laptop/edge/src/edge/dock/views.py:52-66` (countdown 2W; docstrings)
- Modify: `kiosk_laptop/edge/src/edge/dock/state.py:8` (docstring: `quiet_gap_s` is the Window W)
- Test: rewrite the rule tests in `kiosk_laptop/edge/tests/test_dock_grouper.py`; modify `tests/test_dock_sender.py`, `tests/test_dock_routes.py`, `tests/test_dock_state.py`

**Interfaces:**
- Schema step (exact; the comment above it in db.py's style says decided passes take their anchor, older ones their last new read):

```sql
ALTER TABLE dock_passes ADD COLUMN anchor_at TEXT;
ALTER TABLE dock_passes ADD COLUMN anchor_received_at TEXT;
UPDATE dock_passes SET anchor_at = last_new_at, anchor_received_at = last_new_received_at
    WHERE closed_at IS NOT NULL
```

- Produces: `grouper.group(store, now=None) -> GroupResult` with the same signature and fields. `closed` now counts **passes decided** (one burst can decide several), and `to_send` counts live packs among them. `grouper._LATEST = datetime.max(UTC) - 2 × GAP_RANGE[1] s - 1 s`. Every helper the other test files import from `test_dock_grouper.py` keeps its name and shape (`at, reader_time, dock, post, batch, read, group, passes`).
- The rules `group` follows (W = `quiet_gap_s` from the settings at that tick). Each one is pinned by a test below:
  1. Unchanged: the cursor jump off a Dock setup or without a move (and so on RFID→Dock re-setup), another move's reads skipped, `waiting` without the move's cache, `read_time` with the `received_at` fallback, `BATCH`, one transaction per tick.
  2. **Burst.** The open `dock_passes` row (`closed_at IS NULL`) is the burst. A tag new to it moves `last_new_at` (max) and `last_new_received_at`. A re-read only links its read and raises `last_received_at`. A read more than 2W after `last_new_at` decides the burst, then opens the next burst with that read. Once a tick has read everything available (`len(rows) < BATCH` and not waiting), the burst is decided when `now >= last_received_at + 2W + 1 s`.
  3. **Deciding** uses every read linked to the burst, each at its `read_time`. (a) Each crate tag (`container`) is anchored at its earliest read, and that read's `received_at` is kept. Re-reads never move it. (b) Crates whose anchors chain ≤ 2W apart, in anchor order, form one group. (c) An asset belongs to every group holding a crate within W of any of its reads. An asset in two or more groups merges them, repeated until no asset does. An asset in no group goes to the leftover. (d) Other tags are placed by Decision 4. (e) Outcomes: a group with ≥ 2 distinct crate `matched_id`s is `many_crates`. A group with one crate is `pack` when it has ≥ 1 asset, otherwise `nothing`. The leftover is `no_crate` when it holds an asset, otherwise `nothing`. When nothing is left over, there is no leftover pass.
  4. **Each pass.** `opened_at` is its earliest read. A crate group's `anchor_at` / `anchor_received_at` are its earliest crate anchor (stamped as `_stamp` does) and that read's `received_at`, and its `closed_at = anchor_at + W`. The leftover's anchor is NULL and its `closed_at = last_new_at + 2W`. The other columns:
     - `quiet_gap_s = W`.
     - `container_id` / `container_name` are set for a one-crate group.
     - `asset_count` counts distinct assets.
     - `dry_run` follows Decision 6.
     - `send_state = 'pending'` only for a live `pack`, else `'none'`.
     - Burst columns are copied as they are.
  5. **Rows.** Passes are written in `opened_at` order, with crate groups before the leftover on a tie. The burst's row (and its `pass_id`) becomes the first pass. The rest are inserted with new `uuid4` pass ids before the next burst opens, so the open burst is always the newest row. Each tag, and every read of that tag, moves to its pass.
- `sender._closed_at(p, offset_ms)` sends the stored `closed_at` while `|anchor_at - anchor_received_at| <= READER_SKEW_MAX_S`. Otherwise it sends `anchor_received_at + quiet_gap_s`. The offset is added as before.
- `views.overview`'s open burst: `seconds_left = max(0, 2 × W - (now - last_new_received_at))`.

- [ ] **Step 1: Write the failing tests.** In `test_dock_grouper.py`, add the helper `decided(store) -> list[tuple[str, str | None, list[str]]]`: (outcome, container_id, sorted asset `matched_id`s) per pass in id order. Keep the other helpers. W = 5 throughout, so an idle decision needs `group(store, last received + 11)`. The spec's example, verbatim:

```python
def test_spec_example_packs_the_crate_window(store):
    dock(store)
    ids = [read(store, epc, s) for epc, s in (("AA01", 0), ("CC01", 2), ("AA02", 6), ("AA03", 8))]
    group(store, 8)
    [burst] = passes(store)
    assert group(store, 18).closed == 0                      # 8 + 2W + 1 s not yet
    assert group(store, 19) == grouper.GroupResult(scanned=0, closed=2, to_send=1, waiting=False)
    pack, left = passes(store)
    assert decided(store) == [("pack", "c-1", ["a-1", "a-2"]), ("no_crate", None, ["a-3"])]
    assert pack["id"] == burst["id"] and pack["pass_id"] == burst["pass_id"] != left["pass_id"]
    assert when(pack["anchor_at"]) == at(2) and pack["anchor_received_at"] == iso(at(2))
    assert when(pack["closed_at"]) == at(7) and when(pack["opened_at"]) == at(0)
    assert (pack["container_name"], pack["asset_count"], pack["send_state"], pack["quiet_gap_s"]) \
        == ("Crate 1", 2, "pending", 5)
    assert tags(store, pack) == [("AA01", "asset", "a-1", "Server 1"),
                                 ("CC01", "container", "c-1", "Crate 1"), ("AA02", "asset", "a-2", "SN2")]
    assert tags(store, left) == [("AA03", "asset", "a-3", "A-3")]
    assert read_ids(store, pack) == ids[:3] and read_ids(store, left) == ids[3:]
    assert left["anchor_at"] is None and when(left["closed_at"]) == at(18)
    assert (left["send_state"], when(left["opened_at"])) == ("none", at(8))
```

  The other rule tests (one burst each unless stated; `(epc, s)` reads):
  - `test_one_burst_packs_each_crate_on_its_own` (crates 13 s apart): AA01 0, CC01 2, AA02 8, CC02 15, AA03 16, decided at `group(27)`. `decided == [("pack","c-1",["a-1"]), ("no_crate",None,["a-2"]), ("pack","c-2",["a-3"])]`. `closed_at`s are `at(7)`, `at(26)`, `at(20)`. `to_send == 2`, and c-1's id < c-2's.
  - `test_window_reaches_w_before_and_after_the_crate`: AA01 0, CC01 5, AA02 10, AA03 10.2 → `[("pack","c-1",["a-1","a-2"]), ("no_crate",None,["a-3"])]`.
  - `test_crate_rereads_do_not_move_its_window`: CC01 0, 4 and 8, AA01 9 → `[("nothing","c-1",[]), ("no_crate",None,["a-1"])]`. The `nothing` pass has `container_name == "Crate 1"`, `anchor_at == at(0)` and all three CC01 reads.
  - `test_crates_within_two_windows_are_flagged_together` (7 s apart): CC01 0, AA01 1, CC02 7, AA02 8, AA03 13.5 → `[("many_crates",None,["a-1","a-2"]), ("no_crate",None,["a-3"])]`. The first pass's tags include CC01 and CC02, its container is null, and `to_send == 0`.
  - `test_crates_exactly_two_windows_apart_are_flagged`: CC01 0, AA01 5, CC02 10 → `[("many_crates",None,["a-1"])]`.
  - `test_an_asset_read_in_two_crate_windows_flags_both`: CC01 0, AA01 1, AA02 6, AA01 again 10, CC02 11, AA03 12 → `[("many_crates",None,["a-1","a-2","a-3"])]`. Nothing is pending.
  - `test_burst_ends_two_windows_after_its_last_new_tag`: AA01 0, AA02 10 (exactly 2W: same burst), AA01 again at 15 and 19, AA03 20.5. Grouping them decides one burst (`closed == 1`): a `no_crate` pass with a-1, a-2 and all four reads, `last_new_at == at(10)`. AA03's burst is open with `opened_at == at(20.5)`.
  - `test_people_off_move_and_unknown_never_pack_or_merge`: `dock(store, people=[BB01 Jane Doe], client=[client_asset(1, name="Stray server")])`.
    - Burst 1: CC01 0, AA01 0.2, BB01 0.4, EE01 0.6, FF06 1. Its pass holds kinds `container, asset, person, off_move, unknown` with the labels of today's test.
    - Burst 2: CC02 100, BB01 101 and 111, AA02 106, CC03 111, AA03 112.
    - Burst 3: BB01 200, EE01 200.5, FF06 201.
    - `decided == [("pack","c-1",["a-1"]), ("nothing","c-2",[]), ("pack","c-3",["a-2","a-3"]), ("nothing",None,[])]`. BB01 is a tag of the c-2 pass.
  - `test_other_move_crate_reads_as_unknown`: today's reads → `[("no_crate", None, ["a-1"])]`, with CC09 `unknown`.
  - `test_dry_run_pass_is_never_pending`, `test_switch_during_open_burst_keeps_its_reads_dry` (today's `..._open_pass_...`) and `test_closed_while_dry_run_on_is_dry`: today's assertions at the new decision times.
  - `test_dry_run_is_decided_per_pass`: in dry run, CC01 0 and AA01 1 are read, grouped, then dry run is switched off. AA02 8 and CC02 12 follow → c-1 `pack` with `dry_run 1` and `none`; c-2 `pack` [a-2] with `dry_run 0`, `pending`, and `to_send == 1`.
  - `test_backlog_batch_splits_like_live`: the reads CC01 0, AA01 1, AA02 8, CC02 30, AA03 31, CC03 60.
    - Store A is live: one `read` per read, grouped at each read's time, then `group(71)`.
    - Store B (a second `Store` under `tmp_path`) gets one `batch(..., received=70)`. `group(70) == GroupResult(scanned=6, closed=3, to_send=2, waiting=False)`, `group(80).closed == 0`, `group(81).closed == 1`.
    - Both end with `[("pack","c-1",["a-1"]), ("no_crate",None,["a-2"]), ("pack","c-2",["a-3"]), ("nothing","c-3",[])]`, and with equal `(opened_at, closed_at, anchor_at)` per pass.
  - `test_read_time_parsing_and_fallback`: today's, decided at `group(13)` → `pack`, `closed_at == at(7)`, `anchor_at == at(2)`.
  - `test_read_time_too_late_to_close_falls_back`: `9999-12-31T23:57:58+0000` parses as is, and `9999-12-31T23:58:00+0000` now falls back. This replaces today's assertion that `23:58:00` parses, since the guard leaves room for 2 × 60 s + 1 s. The rest of the test stays, at the new decision times.
  - `test_idle_decision_waits_two_windows_plus_one_second`: AA01 0, CC01 1.5 received at 1. The burst is still open at `group(11)` and decided at `group(12)`, with `closed_at == at(6.5)`.
  - `test_idle_close_waits_for_the_backlog`, `test_waits_for_move_cache`, `test_not_dock_setup_skips_reads`: today's assertions, with decision times moved past the new idle rule.

  Updates in the other test files:
  - `test_dock_sender.py`:
    - `add_pass` also writes `anchor_at = CLOSED` and `anchor_received_at = at(T0 - 60)`.
    - `test_close_time_follows_the_laptop_clock_when_the_reader_is_off` puts its skew on `anchor_at`, with the same five cases and expected values.
    - New `test_close_time_comes_from_the_crate_anchor`: the burst's `last_new_at` is 2 hours off its `last_new_received_at`, while the anchor agrees → the stored `closed_at` is sent.
  - `test_dock_routes.py`: `test_open_pass_counts_down_to_its_close` expects `seconds_left` 10.0 at `at(1)`, 8.0 at `at(3)`, 6.5 at `at(4.5)`, and 0 at `at(11)` and `at(500)`. `test_seconds_left_follows_the_quiet_gap_setting` becomes `..._window_setting`: W 20 → 35.0 at `at(5)`.
  - `test_dock_state.py::test_upgrade_gives_decided_passes_their_anchor`: on the image before the new step, write a closed pass and an open one, then upgrade. The closed pass's `anchor_at` / `anchor_received_at` equal its `last_new_at` / `last_new_received_at`, and the open pass's are NULL.
- [ ] **Step 2: Run `tests/test_dock_grouper.py tests/test_dock_sender.py tests/test_dock_routes.py tests/test_dock_state.py`; expect FAIL** (no `anchor_at` column, passes not split, 5 s countdown).
- [ ] **Step 3: Implement** the schema step and the rules above. Update the docstrings that describe the quiet gap or the pass rules (grouper, sender, views, state) to the window rule.
- [ ] **Step 4: Run the same four files plus `tests/test_background.py tests/test_db.py`, then the whole edge suite; expect PASS.**
- [ ] **Step 5: Commit** `feat(edge): dock passes anchored on the crate's first read, decided when the burst ends`

### Task 2: Edge — Start, Pause and Stop

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/routes/rfid.py:103-139` (bodies of `/start` and `/stop` become helpers)
- Modify: `kiosk_laptop/edge/src/edge/routes/dock.py` (control route; overview carries `control`; docstring)
- Modify: `kiosk_laptop/edge/src/edge/dock/grouper.py` (`decide`, `decide_now`)
- Modify: `kiosk_laptop/edge/src/edge/app.py:113` (`app.state.dock_control = None`, commented like its neighbors)
- Test: create `kiosk_laptop/edge/tests/test_dock_control.py`; extend `tests/test_dock_grouper.py`; modify `tests/test_dock_routes.py` (`test_overview_with_nothing_yet`, `test_overview_route_serves_the_open_pass`: the body gains `control`)

**Interfaces:**
- Consumes: Task 1 `grouper.group`, `GroupResult`.
- Produces:
  - `async def start_reader(st, session: EdgeSession) -> dict` and `async def stop_reader(st, session: EdgeSession) -> dict` in `routes/rfid.py`. They are today's bodies, events included, and answer `{"reading": True}` / `{"reading": False}`, raising the same `HTTPException`s (redacted reader errors, 409 `reader_required`). `/start` keeps its `online` dependency, and both routes call the helpers.
  - `grouper.group(store, now=None, *, decide: bool = False) -> GroupResult`: with `decide`, a tick that read everything available decides the open burst at once, ignoring the idle timer.
  - `grouper.decide_now(store, now=None) -> GroupResult` runs `group(..., decide=True)` until a tick is not a full batch or is waiting. It returns the summed counts, with `waiting` from the last tick, and each tick stays its own transaction.
  - `POST /edge/dock/control` (router session gate), body `{"action": "start" | "pause" | "stop"}`, anything else 422 `bad_request`. It sets `app.state.dock_control = action` first, then:
    - `start`: `deps.online(session)` (503 `edge_offline`), then `start_reader`.
    - `pause`: `stop_reader`.
    - `stop`: `stop_reader` with its `HTTPException` caught, then `decide_now`, which sets `dock_send_wake` when `to_send > 0`, then re-raises the caught exception.
    - Answers `{"reading": bool, "control": action, "decided": int}`, where `decided` is the passes decided (0 unless `stop`).
  - `GET /edge/dock` adds `"control": app.state.dock_control` (`"start" | "pause" | "stop" | null`). The route adds it; `views.overview` is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `test_dock_control.py`, using `paired` from `test_rfid_reader_control.py`, then `dock(store)` and `batch` / `group` from `test_dock_grouper.py`:
    - `test_control_needs_a_session`: 401, and the reader is untouched.
    - `test_bad_action_is_422`: `{"action": "jump"}`, `{}` and `[1]` → 422 `bad_request`; no reader call; overview `control` stays null.
    - `test_start_and_pause_drive_the_reader_and_are_remembered`:
      - The overview's `control` is null at first.
      - Start → `{"reading": True, "control": "start", "decided": 0}`, `reader.starts` has one entry, and a `reader_started` event is recorded.
      - Pause → `{"reading": False, "control": "pause", "decided": 0}`, `reader.stops` + 1, and an open burst stays open.
      - The overview's `control` is `"pause"`.
    - `test_start_needs_an_online_session`: an offline session's start → 503 `edge_offline`, `reader.starts == []`, `control == "start"`. Pause and stop answer 200 offline.
    - `test_stop_decides_the_open_burst_at_once`: AA01 0 and CC01 1 grouped (open), then AA02 1.5 stored but not grouped. Stop → 200 `{"reading": False, "control": "stop", "decided": 1}`. The one pass is `pack` c-1 with a-1 and a-2, `pending`, and `app.state.dock_send_wake.is_set()`.
    - `test_stop_decides_even_when_the_reader_does_not_answer`: with `reader.mode = "unreachable"` and an open burst, stop → 502 `reader_unreachable`, the burst is decided, and `control == "stop"`. With no pairing at all → 409 `reader_required`, and the open burst is decided too.
  - `test_dock_grouper.py`:
    - `test_decide_now_groups_the_backlog_first`: with `grouper.BATCH = 2`, store CC01 0, AA01 0.5, AA02 1, AA03 1.5 and AA01 2, none grouped. `decide_now` → `scanned == 5`, `closed == 1`, and one `pack` c-1 [a-1, a-2, a-3]. On a Dock setup with no cached move data (as in `test_waits_for_move_cache`), it returns `waiting` and creates no pass.
    - `test_late_reads_after_stop_open_a_new_burst`: after `decide_now`, a read whose `read_at` is before the decision opens a new burst. The decided passes' tags and reads are unchanged.
- [ ] **Step 2: Run `tests/test_dock_control.py tests/test_dock_grouper.py tests/test_dock_routes.py`; expect FAIL** (404 route, no `decide_now`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run those three files plus `tests/test_rfid_reader_control.py tests/test_rfid_events.py`, then the whole edge suite; expect PASS.**
- [ ] **Step 5: Commit** `feat(edge): Dock Start, Pause and Stop; Stop decides the open burst at once`

### Task 3: Kiosk — the RFID dashboard and the Dock screen follow the theme

**Files:**
- Modify: `kiosk/src/layout/KioskShell.tsx:80-103` (drop `forceDark` and its comment; the effect is `applyPreferences(preferences ?? DEFAULT_PREFERENCES)` on `[preferences]`)
- Modify: `kiosk/src/styles/kiosk.css:1089-1096` (the "Always dark" block becomes the dark-theme refinements), `:1098-1106` (Dock section comment), `:1073` (`.rfid-dash-btn:disabled`)
- Modify: `kiosk/src/pages/DockStation.tsx:1-14` (docstring: fills the screen like the RFID dashboard, in the kiosk's theme)
- Test: `kiosk/src/layout/KioskShell.test.tsx:500-547`

**Interfaces:**
- Produces: no new names. The base rules already use tokens; the `.portal-shell[data-theme='dark']` rules stay as the dark refinements (`--surface` cards, `--paper-2` button text). The disabled reader button's `opacity: .5; filter: saturate(.6)` moves from the dark-only rule to the base `.rfid-dash-btn:disabled`, so a dimmed START stays readable in light too.

- [ ] **Step 1: Write the failing tests.** Replace `'/rfid_status renders dark even when ...'` with `'/rfid_status and /dock follow the person's theme'`: for `theme` in `'light'` and `'dark'`, render at `/rfid_status` and at `/dock`; each time the `.portal-shell`'s `data-theme` equals `theme`. Rename `'a Dock laptop mounts the off-move alarm, and /dock renders dark like /rfid_status'` to `'a Dock laptop mounts the off-move alarm'`. With a light preference it asserts `data-theme === 'light'` on `/dock`, and keeps its alarm assertions. `'other routes keep the person's theme'` stays.
- [ ] **Step 2: Run `src/layout/KioskShell.test.tsx`; expect FAIL** (`dark` where `light` is expected).
- [ ] **Step 3: Implement.** Then read through the RFID dashboard and Dock sections of `kiosk.css`, and `DockPassModal`'s classes. Every color is a token that both themes define, and no rule outside a `[data-theme='dark']` refinement assumes a dark page.
- [ ] **Step 4: Run `src/layout/KioskShell.test.tsx src/pages/RfidStatus.test.tsx src/pages/DockStation.test.tsx`, the full kiosk suite, and `npm --prefix kiosk run build`; expect PASS.**
- [ ] **Step 5: Commit** `fix(kiosk): the RFID dashboard and the Dock screen follow the kiosk theme`

### Task 4: Kiosk — Start / Pause / Stop on the Dock screen, and Window

**Files:**
- Modify: `kiosk/src/lib/api.ts:1340-1445` (`DockControl`, `DockControlResult`, `controlDock`, `DockOverview.control`; the `DockSettings` / `DockOpenPass` docs describe W and the burst)
- Modify: `kiosk/src/pages/RfidStatus.tsx:62-77` (export `ICON`, add `pause`)
- Modify: `kiosk/src/pages/DockStation.tsx` (the reader group, the reader-status loop, Window copy, docstring)
- Modify: `kiosk/src/components/DockPassModal.tsx:4` (docstring: "so the window and the antennas can be tuned")
- Modify: `kiosk/src/styles/kiosk.css` Dock section (~1098-1153)
- Test: `kiosk/src/pages/DockStation.test.tsx`, `kiosk/src/lib/api.dock.test.ts`

**Interfaces:**
- Consumes: Task 2's `POST /edge/dock/control` and `GET /edge/dock`'s `control`; `getReaderStatus`, `readerState`, `readerErrorText`, `codeOf`.
- Produces:
  - `export type DockControl = 'start' | 'pause' | 'stop'`; `DockOverview.control: DockControl | null` (the last Dock button since the edge started); `export interface DockControlResult { reading: boolean; control: DockControl; decided: number }`; `controlDock(action: DockControl): Promise<DockControlResult>` (`POST /edge/dock/control`, JSON `{ action }`, `apiFetch` + `jsonFrom` as `saveDockSettings` does).
  - `RfidStatus.tsx` exports `ICON`, with `pause` added: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>`.
  - In `DockStation.tsx`, `function readerText(state: ReaderState, control: DockControl | null, busy: DockControl | null): { text: string; tone: 'reading' | 'paused' | 'stopped' | 'unreachable' | 'loading' }`:
    - A running call → `Starting…` / `Pausing…` / `Stopping…` (tone `loading`).
    - Otherwise `loading` → `Checking…`, `unreachable` → `Unreachable`, `reading` → `Reading`.
    - `stopped` → `Paused` when `control === 'pause'`, else `Stopped`.
  - Reader status: `getReaderStatus()` 5 s after the previous call settles, and right after each control call. A `busy` answer keeps what's shown, as on the RFID dashboard. The loop has its own `live` flag, so StrictMode runs only one.
  - Layout: `.dock-dash-controls` becomes a `div` holding, first, `div.dock-dash-reader` (`role="group"`, `aria-label="Reader"`). The group holds the state as `rfid-dash-state is-{tone}` with its dot, then three `rfid-dash-btn` buttons: `is-start` / `is-pause` / `is-stop`, each an icon plus a `rfid-dash-btn-title` reading `Start` / `Pause` / `Stop` (accessible name = that word). After the group comes `fieldset.dock-dash-settings` (still `disabled` until settings load) with Dry run and Window, then the error lines, each on a full row.
  - Buttons:
    - Start is disabled while a call runs, while loading, while unreachable or while reading.
    - Pause is disabled while a call runs or when the state isn't `reading`.
    - Stop is never disabled; a press while a Stop call runs does nothing.
    - A failed call shows `readerErrorText(err, status?.reader?.ip ?? '') ?? \`Couldn't ${action} the reader (${codeOf(err)}).\`` in a `form-error` with `role="alert"`, until the next press.
  - Window: label `Window`, `id="dock-window"`, hint `Seconds before and after the crate tag`. When invalid, the hint line reads `1–60 seconds` with `form-error`, and `aria-invalid` is set. Saving is unchanged (`saveDockSettings({ quiet_gap_s })`).
  - CSS:
    - `.dock-dash-reader`: flex, centered, gap 10px.
    - Its `.rfid-dash-btn`: compact, `min-height: 52px; padding: 10px 18px; gap: 10px; border-radius: 12px`, icon 22px, title 18px.
    - `.rfid-dash-btn.is-pause { background: var(--c-amber); }`.
    - Its `.rfid-dash-state`: 16px, weight 600. `.is-paused { color: var(--c-amber); }`.
    - `.dock-dash-settings` is a borderless, paddingless flex row with the strip's gaps. The `:disabled .kiosk-switch` and `.form-error` rules move onto it.
    - The dark refinement covers the strip as today.

- [ ] **Step 1: Write the failing tests.**
  - `api.dock.test.ts`: `controlDock('stop')` posts `{ action: 'stop' }` to `/edge/dock/control` and returns the result. `OVERVIEW` gains `control: null`.
  - `DockStation.test.tsx` mock setup: mock `controlDock` and `getReaderStatus`. By default the status is a reachable reader not reading, at `10.10.48.119`, and `controlDock` resolves `{ reading: action === 'start', control: action, decided: 0 }`. `overview()` gains `control: null`. The `Quiet gap` tests become `Window` tests, with the same assertions and the new error copy.
  - `DockStation.test.tsx` new tests:
    - `shows the reader as Reading, Paused or Stopped`: `Checking…` before the first status, then `Reading` while reading. Not reading reads `Paused` with control `'pause'`, and `Stopped` with `'stop'` or null. A rejected status reads `Unreachable`.
    - `Start, Pause and Stop send their action and check the reader again`: each click calls `controlDock` with its action and calls `getReaderStatus` again.
    - `Start and Pause follow the reader; Stop is always enabled`: while reading, Start is disabled and Pause and Stop are enabled. While stopped, Start and Stop are enabled and Pause is disabled. While unreachable, Start and Pause are disabled and Stop is enabled.
    - `Stop stays enabled while another call runs`: with Start's call pending, Start and Pause are disabled and the state reads `Starting…`. Clicking Stop calls `controlDock('stop')`. A second Stop click while that call is pending makes no further call.
    - `a failed Stop says what went wrong`: a rejection with `ApiError(502, 'reader_unreachable')` shows `Can't reach 10.10.48.119.`, and one with `ApiError(500, 'boom')` shows `Couldn't stop the reader (boom).`
    - `the reader is checked again 5 s after the previous check settles`.
    - `Window: the label, the hint, and 1–60 seconds as the error`.
- [ ] **Step 2: Run `src/pages/DockStation.test.tsx src/lib/api.dock.test.ts`; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run those files plus `src/pages/RfidStatus.test.tsx`, the full kiosk suite, and `npm --prefix kiosk run build`; expect PASS.**
- [ ] **Step 5: Commit** `feat(kiosk): Start, Pause and Stop on the Dock screen; the quiet gap becomes Window`

---

## After the tasks (controller)

1. Whole-branch review (subagent-driven-development's final review) and fix rounds.
2. Gates (foreground): the whole edge suite; the kiosk suite and `npm --prefix kiosk run build`. No API or portal file changes, so their suites don't run.
3. Live verify on the branch stack, using the kiosk-laptop recipe and the fake FX9600 from the first live verify, with dry run on:
   - Script the spec's example (A 0 s, crate 2 s, B 6 s, C 8 s), crates 7 s apart, and crates 13 s apart with an asset between them. Check each pass on `/dock` and in its modal.
   - Start, then Pause: the open pass is decided about 11 s after the last read. Start, then Stop: it is decided at once. Stop with the fake reader unreachable: the error shows and the pass is still decided.
   - Take screenshots of `/dock`, the pass modal (check the rounded corners) and `/rfid_status`, in light and in dark. To switch theme, change the signed-in person's Theme in the portal's `/me` › Preferences and sign in on the kiosk again. Check that the dimmed START and the amber Pause read clearly in both themes.
4. Append a "2026-11-06 changes" paragraph to the spec's Implementation notes: the decisions list above, the `anchor_at` / `anchor_received_at` step, `POST /edge/dock/control` and the overview's `control`.
5. Stop and tell Jimmy it is ready for the next dock test. Merge, push, the parity sheet, Harbor Master and the Features wiki still wait for his trial.
