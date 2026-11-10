# Matching Rules (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Developer › Matching rules page in the portal (`/dev/matching-rules`) where a developer edits, checks, test-runs, versions and deploys one matching flow per place (Printing, Scanning), with v1 of each flow reproducing today's web kiosk matching exactly.

**Architecture:** Flows are JSON (nodes, edges, settings) stored one row per version in `matching_rule_versions`, with a small separate test set (`matching_test_assets`, `matching_test_rows`). A pure-Python package `serversherpa.matching_rules` holds the flow schema, the structure validator, the reference engine (read-only) and the seed. A `devtools`-gated router serves versions, state changes, check, test-run and test-set CRUD. The portal gets a management page and a React Flow (`@xyflow/react`) editor whose live warnings and test bar both call the server, so there is exactly one engine and one validator.

**Tech Stack:** API: FastAPI, async SQLAlchemy, Alembic, Pydantic v2, pytest. Portal: React 18, TypeScript, Vite 5, vitest (`// @vitest-environment jsdom`), `@xyflow/react` 12.12.0.

**Spec:** `docs/superpowers/specs/2026-11-10-matching-rules-design.md` (approved, binding, including Jimmy's decisions). Executors read both documents.

## Global Constraints

- **Worktree:** work only in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/matching-rules` (branch `matching-rules`). Never edit tracked files in the main checkout. Never run bare `git stash`. Never commit `api/src/serversherpa/_dev_reload.py`; if it shows as modified, run `git checkout -- api/src/serversherpa/_dev_reload.py` in this worktree only.
- **Commits:** every message ends with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Worktree links (Task 1 Step 0, skip any that exist):** `ln -s /Users/jrh1812/Developer/BaseCampV3/api/.venv api/.venv`, `ln -s /Users/jrh1812/Developer/BaseCampV3/.env .env`, `ln -s /Users/jrh1812/Developer/BaseCampV3/portal/node_modules portal/node_modules`. Never commit them (`node_modules` is gitignored; check `git status` shows no `.env` or `api/.venv`).
- **API tests:** from `api/`, run `SS_TEST_DB=serversherpa_test_matching_rules PYTHONPATH=$PWD/src .venv/bin/python -m pytest <files> -q -p no:cacheprovider`. `PYTHONPATH` is required, or the shared venv imports the main checkout's code. Lint with `.venv/bin/ruff check <files>`.
- **Portal:** from `portal/`, run `npx vitest run <files>`, `npx tsc -b`, and `npm run build`.
- **Dependency rule:** never run a plain `npm install` in this worktree (it replaces the `portal/node_modules` symlink with a real folder, and the main checkout never gets the package). Task 8 Step 1 has the exact commands.
- **Scope (phase 1):** no changes under `kiosk/`, `kiosk_laptop/`, `android/`, `ios/` or `api/src/serversherpa/scans/`, and no edits to `api/src/serversherpa/api/routes/kiosk.py`. Task 5 only imports from it. Deploy marks a version Live, and nothing reads it yet.
- **v1 = today's web kiosk (`kiosk/src/lib/scanMatch.ts`), quirks included:** Printing is Trim → Upper-case → Match asset tag (Ignore case) → Match serial (Ignore case) → Not found "This asset isn't on this move.". Scanning is Trim → Upper-case → Match RFID (Strip leading zeros on both sides) → Match asset tag (Ignore case) → Match serial (Ignore case) → Not found "No match". Search in is This move. RFID is never tried for Printing, and "007" never finds asset 7.
- **Two or more hits:** take the first by asset tag order: ascending, a missing tag last, then the target key.
- **Access:** the `devtools` resource only (the developer role). Reads, `/check` and `/test-run` need `devtools:view`. Every write needs `devtools:change`. Founders and super admins get 403. Portal routes use `ProtectedRoute resource="devtools"`, and the nav item is `godOnly: true` like the other Developer items.
- **At most one Live version per place, ever:** a partial unique index, plus a per-place row lock in every state change.
- **Test runs are read-only:** they never write a scan, an asset, a version or an audit row.
- **Migration:** `api/migrations/versions/0126_matching_rules.py`, revision `"0126"`, down_revision `"0125"`.
- **`seed.py` is the record of 0126's rows.** After merge, never change it. A later change goes in a new migration.
- **Copy:** American English. 24-hour times (`formatSavedAt`). Sample content is placeholders only ("Test asset 1"). UI strings are fixed in the tasks below.
- **Look:** portal theme tokens only (`--surface`, `--surface-2`, `--paper-line`, `--ink`, `--text-mute`, `--accent`, `--ok`, `--c-red`, `--amber`), never a hard-coded color or a forced theme. No default scrollbars: every rounded scroll box joins the `:is(...)` list in `portal/src/styles/chrome.css`. Modals use `modal-scrim` › `modal-card reports-modal-card rgm-card` › `modal-head` › `rgm-head-text` (eyebrow `Matching rules`, `h3`, `page-hint`) + `modal-foot`, with rounded corners. Row actions use `RowActionsMenu` ("Actions ▾"). Tables use `DataTable`. Every gesture (drag, Delete key, wheel zoom) also has a visible button.
- **Guardrails that must stay green:** `src/styles/listTypography.test.ts`, `src/styles/roundedScrollbars.test.ts`, `src/styles/modalCorners.test.ts`, `src/styles/modalDropdowns.test.ts`.

## Review Focus

1. **The test bar runs a broken draft** (an unwired output, a loop, no Scan input, missing settings). The engine must stop and say where and why, never hang or answer 500 (Task 2, `test_run_stops_on_unwired_output`, `test_run_stops_on_loop`, `test_run_stops_without_scan_input`).
2. **A blank value, or one that cleans to empty.** It must never match a blank stored field, and Contains with an empty value must not match everything (Task 2, `test_empty_value_never_matches`). The API refuses a whitespace-only value with 422 `value_required` (Task 7, `test_test_run_blank_value_422`).
3. **A place with no test rows.** "0 of 0" must not pass the check vacuously, or standby and deploy would need no proof (Task 5, `test_check_fails_with_no_rows_for_place`).
4. **The same value entered twice for one place**, with different expected results. That contradiction would make one row always fail. The API refuses it with 409 `duplicate_value` (Task 7, `test_row_value_unique_per_place`).
5. **Leaving the editor with unsaved changes** through a nav link, or by reloading. The page asks first (Task 10, `asks before leaving with unsaved changes`).

---

## File structure

API (`api/src/serversherpa/`):
- `matching_rules/__init__.py`: empty package marker.
- `matching_rules/flow.py`: vocabulary constants, Pydantic `Flow`/`FlowNode`/`FlowEdge`, `outputs_for`, `node_title`.
- `matching_rules/validate.py`: `structure_checks(flow)`.
- `matching_rules/engine.py`: `Target`, `clean`, `compare`, `run_flow`.
- `matching_rules/seed.py`: `V1_FLOWS`, `TEST_ASSETS`, `TEST_ROWS`, `seed_statements()`, `reset_matching_seed()`.
- `matching_rules/models.py`: ORM for the three tables (imported at the bottom of `db/models.py`).
- `matching_rules/check.py`: test-set loading, `run_test_set`, `check_flow`, `move_targets`.
- `matching_rules/versions.py`: version service and state transitions.
- `matching_rules/schemas.py`: API bodies and responses.
- `api/routes/matching_rules.py`: the router.
- Modify: `db/models.py` (import), `api/app.py` (include router), `api/deps.py` (read-only exemptions), `api/tests/conftest.py` (reseed), plus migration `0126`.

Portal (`portal/src/`):
- `lib/matchingRules.ts`: flow types, vocab labels, pure edit helpers, `litPath`, `formatSavedAt`.
- `lib/api.ts`: matching-rules calls and types (appended section).
- `pages/MatchingRules.tsx`: management page.
- `pages/MatchingRuleEditor.tsx`: editor page (lazy-loaded).
- `components/matching/`: `VersionsTable.tsx`, `CheckPanel.tsx`, `TestAssetsPanel.tsx`, `TestAssetModal.tsx`, `StateChangeModal.tsx`, `FlowCanvas.tsx`, `FlowNodeView.tsx`, `NodePalette.tsx`, `NodeSettings.tsx`, `TestBar.tsx`.
- `styles/matching-rules.css`.
- Modify: `pages/Dev.tsx`, `App.tsx`, `layout/navSections.tsx`, `lib/access.ts`, `components/Topbar.tsx`, `components/CommandPalette.tsx`, `styles/chrome.css`, `package.json`, `package-lock.json`.

---

### Task 1: Flow schema and structure validator

**Files:**
- Create: `api/src/serversherpa/matching_rules/__init__.py`, `api/src/serversherpa/matching_rules/flow.py`, `api/src/serversherpa/matching_rules/validate.py`
- Test: `api/tests/test_matching_flow.py`

**Interfaces:**
- Produces (`flow.py`):
  - `Place = Literal["printing", "scanning"]`, `PLACES: tuple[Place, ...] = ("printing", "scanning")`.
  - `NodeKind = Literal["scan_input", "clean_up", "match", "found", "not_found"]`.
  - Vocab dicts mapping key to label: `KIND_LABELS` (`Scan input`, `Clean up`, `Match`, `Found`, `Not found`). `CLEAN_OPS` (`trim` Trim, `upper` Upper-case, `lower` Lower-case, `strip_zeros` Strip leading zeros, `pad_24` Pad to 24, `number` Read as a number). `FIELDS` (`asset_tag` asset tag, `serial` serial, `rfid` RFID, `name` name). `COMPARES` (`exact` Exact, `ignore_case` Ignore case, `strip_zeros` Strip leading zeros on both sides, `contains` Contains). `SEARCH_IN` (`move` This move, `move_and_client` This move plus the client's other devices). `FOUND_ACTIONS` (`print_label` Print the label, `record_scan` Record the scan). `TABLES` (`assets` Assets). `MULTIPLE` (`first` Take the first, by asset tag order). `EXPECTED = ("asset_tag", "serial", "rfid", "name", "not_found")`.
  - `class FlowNode(BaseModel)`: `id: str` (1–64 chars), `kind: NodeKind`, `settings: dict[str, str] = {}`, `position: Position` (`x: float`, `y: float`), `extra="forbid"`.
  - `class FlowEdge(BaseModel)`: `id: str`, `source: str`, `output: str`, `target: str`.
  - `class Flow(BaseModel)`: `format: Literal[1] = 1`, `nodes: list[FlowNode]` (max 100), `edges: list[FlowEdge]` (max 200). A `model_validator(mode="after")` rejects duplicate node ids, duplicate edge ids, and edges whose `source` or `target` is not a node id.
  - `outputs_for(node: FlowNode) -> tuple[str, ...]`: `scan_input` gives `("out",)`. `clean_up` gives `("out", "invalid")` when op is `pad_24` or `number`, else `("out",)`. `match` gives `("found", "none")`. `found` and `not_found` give `()`.
  - `node_title(node: FlowNode) -> str`: `"Scan input"`, `"Clean up (Trim)"` (just `"Clean up"` when op is unset or unknown), `"Match (asset tag)"` (just `"Match"` when field is unset), `"Found"`, `"Not found"`.
- Produces (`validate.py`):
  - `@dataclass(frozen=True) class Problem: message: str; node_ids: tuple[str, ...]`
  - `@dataclass(frozen=True) class CheckItem: code: str; label: str; problems: tuple[Problem, ...]`, with property `ok -> bool` (no problems).
  - `CHECKS: tuple[tuple[str, str], ...]`, in this order: `("one_scan_input", "Exactly one Scan input")`, `("outputs_wired", "Every output is wired to one step")`, `("all_reachable", "Every step is reachable from the Scan input")`, `("paths_end", "Every path ends in Found or Not found")`, `("no_loops", "No loops")`, `("settings_filled", "Every step's settings are filled in")`, `("found_after_match", "Found follows a Match's found output")`.
  - `settings_problems(node: FlowNode) -> list[str]`: the "choose …" messages (below). `run_flow` reuses it.
  - `structure_checks(flow: Flow) -> list[CheckItem]`: one item per `CHECKS` entry, in order.

Problem messages (exact; `{t}` is `node_title`, quotes are straight `"`):
- one_scan_input: `The flow has no Scan input.` / `The flow has {n} Scan inputs; it needs exactly one.`
- outputs_wired: `{t}: the "{o}" output isn't wired.` / `{t}: the "{o}" output is wired to {n} steps.` / `{t}: wired from "{o}", an output this step doesn't have.` Plus `{t}: nothing can be wired into a Scan input.` for an edge whose target is the scan input.
- all_reachable: `{t} can't be reached from the Scan input.` (Skipped when there isn't exactly one Scan input.)
- paths_end: `A path through {t} doesn't end in Found or Not found.` This flags each reachable non-terminal node with an unwired output.
- no_loops: `{t} is part of a loop.` (every node on a cycle).
- settings_filled: `{t}: choose a clean-up.` (op), `choose a table.`, `choose a field.`, `choose how to compare.`, `choose where to search.`, `choose what happens when two or more match.` (multiple), `choose what happens.` (found action), `{t}: enter the message.` (a not_found message that is blank after trimming). A value outside its vocabulary counts as unfilled.
- found_after_match: `{t} is wired from {source t}; only a Match's "found" output can lead to Found.` / `{t}: the "found" output must lead to Found.`

- [ ] **Step 0: Prepare the worktree.** Create the links from Global Constraints. Run `SS_TEST_DB=serversherpa_test_matching_rules PYTHONPATH=$PWD/src .venv/bin/python -m pytest tests/test_migration_0125_scan_match_trace.py -q -p no:cacheprovider` from `api/` once. Expected: PASS, which confirms the harness and the test DB.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_matching_flow.py`. A helper `_flow(nodes, edges)` builds a `Flow` from tuples. `GOOD` is scan `n1` →out→ clean `n2` (trim) →out→ match `n3` (asset_tag, ignore_case, move, assets, first) →found→ `n4` found (print_label), →none→ `n5` not_found ("Nope").

```python
def test_good_flow_passes_every_check():
    items = structure_checks(GOOD)
    assert [i.code for i in items] == [c for c, _ in CHECKS]
    assert all(i.ok for i in items)

def test_parse_rejects_duplicate_ids_and_dangling_edges():
    with pytest.raises(ValidationError): _flow([scan("n1"), found("n1")], [])
    with pytest.raises(ValidationError): _flow([scan("n1")], [("e1", "n1", "out", "n9")])

def test_scan_input_count():
    assert _problems(no_scan, "one_scan_input") == ["The flow has no Scan input."]
    assert _problems(two_scans, "one_scan_input") == ["The flow has 2 Scan inputs; it needs exactly one."]

def test_unwired_output_flags_wiring_and_path():
    f = GOOD_without_edge("n3", "none")
    assert _problems(f, "outputs_wired") == ['Match (asset tag): the "none" output isn\'t wired.']
    assert _problems(f, "paths_end") == ["A path through Match (asset tag) doesn't end in Found or Not found."]
    assert _problem_nodes(f, "outputs_wired") == [("n3",)]

def test_output_wired_twice(): ...  # == ['Clean up (Trim): the "out" output is wired to 2 steps.']

def test_wire_from_an_output_the_step_lacks():
    f = GOOD_plus_edge("n2", "invalid", "n5")   # trim has no "invalid"
    assert 'Clean up (Trim): wired from "invalid", an output this step doesn\'t have.' in _problems(f, "outputs_wired")

def test_unreachable_step(): ...  # extra not_found n6 → ["Not found can't be reached from the Scan input."]

def test_loop_flags_each_node_on_it():
    # n2 trim → n6 upper → n2
    assert sorted(_problem_nodes(f, "no_loops")) == [("n2",), ("n6",)]

def test_missing_and_unknown_settings():
    assert _problems(match_without_field, "settings_filled") == ["Match: choose a field."]
    assert _problems(match_search_all, "settings_filled") == ["Match (asset tag): choose where to search."]
    assert _problems(blank_message, "settings_filled") == ["Not found: enter the message."]

def test_found_must_follow_match_found():
    # n2 trim →out→ n4 found
    assert _problems(f, "found_after_match") == [
        "Found is wired from Clean up (Trim); only a Match's \"found\" output can lead to Found."]

def test_outputs_for():
    assert outputs_for(clean("a", "number")) == ("out", "invalid")
    assert outputs_for(clean("a", "trim")) == ("out",)
    assert outputs_for(match_node("a")) == ("found", "none")
    assert outputs_for(found("a")) == ()
```

- [ ] **Step 2: Run** `... -m pytest tests/test_matching_flow.py -q -p no:cacheprovider`. Expected: FAIL (`ModuleNotFoundError: serversherpa.matching_rules`).
- [ ] **Step 3: Implement** `flow.py` and `validate.py` with the interfaces above. Cycle detection is a DFS over edges with white/gray/black colors, and every node on a back-edge cycle is flagged. Reachability is a BFS from the single Scan input.
- [ ] **Step 4: Run** the Step 2 command and `.venv/bin/ruff check src/serversherpa/matching_rules tests/test_matching_flow.py`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(api): matching rules flow schema and structure checks`.

---

### Task 2: Reference engine

**Files:**
- Create: `api/src/serversherpa/matching_rules/engine.py`
- Test: `api/tests/test_matching_engine.py`

**Interfaces:**
- Consumes: Task 1's `Flow`, `FlowNode`, `outputs_for`, `settings_problems`.
- Produces:
  - `JS_WHITESPACE: str`: exactly the characters JavaScript's `String.prototype.trim` removes: `" \t\n\v\f\r                 　﻿"`.
  - `@dataclass(frozen=True) class Target: key: str; asset_tag: int | None; name: str | None; rfid: str | None; serial: str | None; sits: Literal["move", "client"] = "move"`. The asset tag field compares as `str(asset_tag)`, which is the kiosk's `asset_id`, `""` when there is none.
  - `clean(op: str, value: str) -> tuple[str, str]`, which returns `(output, value_out)`. `trim` strips `JS_WHITESPACE`. `upper` and `lower` are `str.upper()` and `str.lower()`. `strip_zeros` is `re.sub(r"^0+(?=.)", "", v, flags=re.S)` (portal `displayRfid`: `"000"` gives `"0"`). `pad_24` left-pads with `"0"` to 24 characters, and gives `("invalid", v)` when longer than 24. `number` gives `("out", str(int(v)))` when `v` is 1+ ASCII digits, else `("invalid", v)`.
  - `compare(mode: str, stored: str | None, value: str) -> bool`. The stored side is always stripped of `JS_WHITESPACE` first, and a blank stored side or an empty `value` never matches. `exact`: `s == value`. `ignore_case`: `s.upper() == value.upper()`. `strip_zeros`: `strip0(s).upper() == strip0(value).upper()`, which also ignores case, as the kiosk's RFID key does. `contains`: `value.upper() in s.upper()`.
  - `@dataclass class TraceStep: node_id: str; kind: str; value_in: str; value_out: str | None; output: str | None; hits: list[Target] | None`
  - `@dataclass class RunResult: outcome: Literal["found", "not_found", "stopped"]; stop_reason: str | None; end_node_id: str | None; asset: Target | None; field: str | None; action: str | None; message: str | None; trace: list[TraceStep]`
  - `STOP_REASONS = ("no_scan_input", "unwired", "two_wires", "loop", "bad_settings", "found_without_match")`
  - `run_flow(flow: Flow, value: str, targets: Sequence[Target]) -> RunResult`

`run_flow` algorithm (the decisions the tests don't fully pin):
```
need exactly one scan_input, else stopped("no_scan_input", end_node_id=None, trace=[])
node = scan input; cur = value (as given, untrimmed); visited = set(); last = None  # (match node, hits) when the previous step took "found"
loop:
  node.id in visited -> stopped("loop", end_node_id=node.id)
  settings_problems(node) -> stopped("bad_settings", end_node_id=node.id)
  scan_input: out="out", v=cur | clean_up: out, v = clean(op, cur)
  match: scope = move targets, or all targets for move_and_client;
         hits = dedup-by-key(sorted(t in scope if compare(compare, field_of(t), cur), key=(asset_tag is None, asset_tag or 0, key)));
         out = "found" if hits else "none"; v = cur
  found: last is set -> found(asset=last.hits[0], field=last.field, action) ; else stopped("found_without_match")
  not_found: not_found(message)
  append TraceStep (terminals too, with output=None, value_out=None)
  edges from (node.id, out): 0 -> stopped("unwired"), 2+ -> stopped("two_wires"), end_node_id=node.id
  last = (node, hits) if match took "found" else None; node = target; cur = v
```

- [ ] **Step 1: Write the failing tests** in `api/tests/test_matching_engine.py`:

```python
@pytest.mark.parametrize("op,value,expected", [
    ("trim", "  a b  ﻿", ("out", "a b")), ("trim", "\x1cA", ("out", "\x1cA")),
    ("upper", "ab", ("out", "AB")), ("lower", "AB", ("out", "ab")),
    ("strip_zeros", "000A1B", ("out", "A1B")), ("strip_zeros", "000", ("out", "0")),
    ("pad_24", "A1B", ("out", "0" * 21 + "A1B")), ("pad_24", "X" * 25, ("invalid", "X" * 25)),
    ("number", "007", ("out", "7")), ("number", "7a", ("invalid", "7a")), ("number", "", ("invalid", "")),
])
def test_clean(op, value, expected): assert clean(op, value) == expected

def test_compare():
    assert compare("exact", " AbC ", "AbC") and not compare("exact", "abc", "ABC")
    assert compare("ignore_case", "AbC-104x", "ABC-104X")
    assert compare("strip_zeros", "000000000000000000000A1B", "a1b")
    assert compare("contains", "Test asset 6B", "test asset 6")

def test_empty_value_never_matches():
    for mode in ("exact", "ignore_case", "strip_zeros", "contains"):
        assert not compare(mode, "abc", "") and not compare(mode, None, "") and not compare(mode, "  ", "")

def test_take_first_by_asset_tag():
    t107, t106 = T("b", 107, serial="DUP"), T("a", 106, serial="DUP")
    r = run_flow(SERIAL_FLOW, "DUP", [t107, t106])
    assert (r.outcome, r.asset.asset_tag, r.field) == ("found", 106, "serial")
    assert [h.asset_tag for h in r.trace[-2].hits] == [106, 107]

def test_search_in_scopes_client_targets():
    c = T("c", 108, serial="CLT", sits="client")
    assert run_flow(SERIAL_FLOW, "CLT", [c]).outcome == "not_found"
    assert run_flow(SERIAL_FLOW_MOVE_AND_CLIENT, "CLT", [c]).asset == c

def test_trace_records_each_step():
    r = run_flow(TRIM_UPPER_TAG_FLOW, " 7 ", [T("a", 7)])
    assert [(s.kind, s.value_in, s.value_out, s.output) for s in r.trace] == [
        ("scan_input", " 7 ", " 7 ", "out"), ("clean_up", " 7 ", "7", "out"),
        ("clean_up", "7", "7", "out"), ("match", "7", "7", "found"), ("found", "7", None, None)]

def test_invalid_output_is_followed():  # number on "x" →invalid→ not_found
    assert run_flow(NUMBER_FLOW, "x", []).outcome == "not_found"

def test_run_stops_on_unwired_output():
    r = run_flow(GOOD_without_none_edge, "zzz", [])
    assert (r.outcome, r.stop_reason, r.end_node_id) == ("stopped", "unwired", "n3")

def test_run_stops_on_loop(): ...           # stop_reason "loop", end_node_id "n2"
def test_run_stops_without_scan_input(): ... # "no_scan_input", trace == []
def test_run_stops_on_bad_settings(): ...    # match without field → "bad_settings"
def test_found_without_match_stops(): ...    # trim →out→ found → "found_without_match"
```
(Tests build flows with the same tuple helpers as Task 1. Put the helpers in `api/tests/matching_helpers.py` and import them in both files.)

- [ ] **Step 2: Run** `... -m pytest tests/test_matching_engine.py -q -p no:cacheprovider`. Expected: FAIL (no `engine`).
- [ ] **Step 3: Implement** `engine.py` per the interfaces and algorithm. Move the Task 1 helpers into `tests/matching_helpers.py`.
- [ ] **Step 4: Run** the Step 2 command, `tests/test_matching_flow.py`, and ruff. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(api): matching rules reference engine`.

---

### Task 3: v1 flows and the starting test set (seed module)

**Files:**
- Create: `api/src/serversherpa/matching_rules/seed.py`
- Test: `api/tests/test_matching_seed.py`

**Interfaces:**
- Consumes: Task 1 `Flow`, `structure_checks`. Task 2 `run_flow`, `Target`, `JS_WHITESPACE` (tests only; `seed.py` imports nothing but `json`, so the migration stays light).
- Produces:
  - `V1_FLOWS: dict[str, dict]`: flow JSON (`format: 1`) keyed `"printing"` and `"scanning"`. Node ids are `n1…`, edge ids `e1…`, laid out left to right 240 px apart with Found below the Matches. Every Match has settings `{"table": "assets", "field": …, "compare": …, "search_in": "move", "multiple": "first"}`. Printing chain: scan → clean `trim` → clean `upper` → match `asset_tag`/`ignore_case` → (none) match `serial`/`ignore_case` → (none) not_found `"This asset isn't on this move."`. Both Matches' `found` lead to one Found (`print_label`). Scanning chain: scan → `trim` → `upper` → match `rfid`/`strip_zeros` → match `asset_tag`/`ignore_case` → match `serial`/`ignore_case` → not_found `"No match"`. All three `found` outputs lead to one Found (`record_scan`).
  - `TEST_ASSETS: list[dict]` (keys `asset_tag, name, rfid, serial, sits`), exactly:

| asset_tag | name | rfid | serial | sits | case it covers |
|---|---|---|---|---|---|
| 101 | Test asset 1 | `000000000000000000000A1B` | SER-101 | move | RFID stored padded, scanned without zeros |
| 102 | Test asset 2 | `00000000000000000000B002` | SER-102 | move | asset tag that is another asset's RFID |
| 103 | Test asset 3 | `000000000000000000000102` | SER-103 | move | (the RFID that equals 102) |
| 104 | Test asset 4 | None | AbC-104x | move | mixed-case serial |
| 7 | Test asset 5 | `000000000000000000000C05` | SER-007 | move | "007" for asset 7 |
| 106 | Test asset 6 | `000000000000000000000C06` | DUP-200 | move | name part of another name; first of two |
| 107 | Test asset 6B | `000000000000000000000C07` | DUP-200 | move | second of two |
| 108 | Test asset 8 | `000000000000000000000C08` | CLT-108 | client | client's other device |

  - `TEST_ROWS: list[dict]` (keys `asset_tag, place, value, expected`). Printing: `101`→asset_tag(101), `A1B`→not_found(101), `102`→asset_tag(102), `abc-104X`→serial(104), `007`→not_found(7), `7`→asset_tag(7), `dup-200`→serial(106), `Test asset 6`→not_found(106), `CLT-108`→not_found(108). Scanning: `A1B`→rfid(101), `102`→rfid(103), `SER-103`→serial(103), `abc-104X`→serial(104), `007`→not_found(7), `7`→asset_tag(7), `DUP-200`→serial(106), `Test asset 6`→not_found(106), `CLT-108`→not_found(108). That is 9 rows per place.
  - `seed_statements() -> list[tuple[str, dict]]`: plain-SQL inserts with bind params. Both migration 0126 and the test reset run them. Version rows: `place, version=1, state='live', flow=CAST(:flow AS jsonb), state_changed_at=now()`, with `created_by` NULL. Test assets: one insert each. Rows: `INSERT INTO matching_test_rows (test_asset_id, place, value, expected) SELECT id, :place, :value, :expected FROM matching_test_assets WHERE asset_tag = :asset_tag`.
  - `async def reset_matching_seed(session: AsyncSession) -> None`: `TRUNCATE matching_test_rows, matching_test_assets, matching_rule_versions`, then runs `seed_statements()`. Import `AsyncSession` under `TYPE_CHECKING` only.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_matching_seed.py`. `_targets()` turns `TEST_ASSETS` into `Target(key=str(tag), …)`, and `_chain(flow)` walks from the Scan input along `out`/`none` edges, returning `(kind, settings)` pairs.

```python
def test_v1_flows_pass_structure():
    for place in PLACES:
        assert all(i.ok for i in structure_checks(Flow.model_validate(V1_FLOWS[place])))

def test_v1_printing_is_todays_matchAssetOrSerial():
    assert [(k, s.get("op") or s.get("field") or s.get("message")) for k, s in _chain("printing")] == [
        ("scan_input", None), ("clean_up", "trim"), ("clean_up", "upper"),
        ("match", "asset_tag"), ("match", "serial"), ("not_found", "This asset isn't on this move.")]
    # every match: ignore_case, move, first; the Found: print_label

def test_v1_scanning_is_todays_matchScan():
    # trim, upper, rfid/strip_zeros, asset_tag/ignore_case, serial/ignore_case, not_found "No match"; Found record_scan

def test_test_set_covers_the_tricky_cases():
    by = {a["asset_tag"]: a for a in TEST_ASSETS}
    assert len(TEST_ASSETS) == 8 and len(TEST_ROWS) == 18
    assert re.sub(r"^0+(?=.)", "", by[103]["rfid"]) == str(by[102]["asset_tag"])
    assert by[106]["serial"] == by[107]["serial"] and by[108]["sits"] == "client"
    assert by[106]["name"] in by[107]["name"] and by[104]["serial"] not in (by[104]["serial"].upper(), by[104]["serial"].lower())

@pytest.mark.parametrize("row", TEST_ROWS, ids=lambda r: f'{r["place"]}:{r["value"]}')
def test_every_seed_row_passes_v1(row):
    r = run_flow(Flow.model_validate(V1_FLOWS[row["place"]]), row["value"], _targets())
    if row["expected"] == "not_found":
        assert r.outcome == "not_found"
    else:
        assert (r.outcome, r.field, r.asset.asset_tag) == ("found", row["expected"], row["asset_tag"])
```

Add a parity test against a literal Python port of `kiosk/src/lib/scanMatch.ts`, kept in the test file. This is the reference, so its body is given:

```python
def _key(v):
    t = (v or "").strip(JS_WHITESPACE).upper()
    return t or None

def _rfid_key(v):
    if not v or not v.strip(JS_WHITESPACE):
        return None
    return _key(re.sub(r"^0+(?=.)", "", v.strip(JS_WHITESPACE), flags=re.S))

def _index(targets):                      # roster in asset-tag order; first row wins per key
    by = {"rfid": {}, "asset_tag": {}, "serial": {}}
    for t in sorted(targets, key=lambda t: t.asset_tag):
        for field, k in (("rfid", _rfid_key(t.rfid)), ("asset_tag", _key(str(t.asset_tag))),
                         ("serial", _key(t.serial))):
            if k and k not in by[field]:
                by[field][k] = t
    return by

def _kiosk(by, raw, order):               # the page trims, then the matcher runs
    raw = raw.strip(JS_WHITESPACE)
    plain = _key(raw)
    if not plain:
        return None
    for field in order:
        k = _rfid_key(raw) if field == "rfid" else plain
        if k and k in by[field]:
            return field, by[field][k].asset_tag
    return None

VALUES = sorted({v for a in TEST_ASSETS for f in ("rfid", "serial", "name") if (s := a[f])
                 for v in (s, s.lower(), f" {s} ", "00" + s, re.sub(r"^0+(?=.)", "", s))}
                | {str(a["asset_tag"]) for a in TEST_ASSETS}
                | {"007", "07", "0", "000", "0C05", "c05", "nothing", "Test asset 6"})

@pytest.mark.parametrize("place,order", [("printing", ("asset_tag", "serial")),
                                         ("scanning", ("rfid", "asset_tag", "serial"))])
def test_v1_matches_the_kiosk_port_on_every_value(place, order):
    move = [t for t in _targets() if t.sits == "move"]
    by, flow = _index(move), Flow.model_validate(V1_FLOWS[place])
    for v in VALUES:
        r = run_flow(flow, v, move)
        got = (r.field, r.asset.asset_tag) if r.outcome == "found" else None
        assert got == _kiosk(by, v, order), v
```

- [ ] **Step 2: Run** `... -m pytest tests/test_matching_seed.py -q -p no:cacheprovider`. Expected: FAIL (no `seed`).
- [ ] **Step 3: Implement** `seed.py` with the constants and functions above.
- [ ] **Step 4: Run** the Step 2 command and ruff. Expected: PASS (18 row cases, 2 parity cases), clean. If a parity value disagrees, the engine is wrong, not the port: fix `engine.py`.
- [ ] **Step 5: Commit** `feat(api): matching rules v1 flows and starting test set`.

---

### Task 4: Migration 0126, ORM models and the test-DB reseed

**Files:**
- Create: `api/migrations/versions/0126_matching_rules.py`, `api/src/serversherpa/matching_rules/models.py`
- Modify: `api/src/serversherpa/db/models.py` (bottom, after `import serversherpa.plans.models`), `api/tests/conftest.py` (`clean_db`)
- Test: `api/tests/test_migration_0126_matching_rules.py`

**Interfaces:**
- Consumes: Task 3 `seed_statements`, `reset_matching_seed`, `V1_FLOWS`.
- Produces (tables and ORM classes):
  - `matching_rule_versions` / `MatchingRuleVersion`: `id uuid pk gen_random_uuid()`, `place text` CHECK in (`printing`,`scanning`), `version int`, `state text` default `'draft'` CHECK in (`draft`,`standby`,`live`,`retired`), `flow jsonb not null`, `based_on_id uuid null` FK self ON DELETE SET NULL, `checked jsonb null` (`{"passed","total","ok","checked_at"}`), `created_by`/`updated_by`/`state_changed_by uuid null` FK `people.id` ON DELETE SET NULL, `created_at`/`updated_at timestamptz default now()`, `state_changed_at timestamptz null`. UNIQUE (`place`,`version`). Partial unique index `matching_rule_versions_one_live` ON (`place`) WHERE `state = 'live'`.
  - `matching_test_assets` / `MatchingTestAsset`: `id`, `asset_tag bigint not null unique` CHECK `> 0`, `name text not null`, `rfid text null`, `serial text null`, `sits text not null default 'move'` CHECK in (`move`,`client`), `created_at`, `updated_at`. Relationship `rows` (order by place, value; `cascade="all, delete-orphan"`, `lazy="selectin"`).
  - `matching_test_rows` / `MatchingTestRow`: `id`, `test_asset_id uuid` FK ON DELETE CASCADE, `place text` CHECK, `value text not null` CHECK `btrim(value) <> ''`, `expected text` CHECK in (`asset_tag`,`serial`,`rfid`,`name`,`not_found`), `created_at`. UNIQUE (`place`,`value`) named `matching_test_rows_place_value_key`.
  - The migration's `upgrade()` creates the tables, then runs each `seed_statements()` entry via `op.get_bind().execute(sa.text(sql), params)`. `downgrade()` drops the three tables (rows, assets, versions).
  - conftest: in `clean_db`, after the existing `TRUNCATE … CASCADE` and the labels seeds, `await reset_matching_seed(session)`. This must come after the people TRUNCATE, because `TRUNCATE people … CASCADE` also empties `matching_rule_versions`.

- [ ] **Step 1: Write the failing tests:**

```python
async def test_seed_has_live_v1_per_place(db):
    rows = (await db.execute(text("SELECT place, version, state, flow FROM matching_rule_versions ORDER BY place"))).all()
    assert [(p, v, s) for p, v, s, _ in rows] == [("printing", 1, "live"), ("scanning", 1, "live")]
    assert {p: f for p, _, _, f in rows} == V1_FLOWS

async def test_seed_test_set(db):
    assert await db.scalar(text("SELECT count(*) FROM matching_test_assets")) == 8
    assert await db.scalar(text("SELECT count(*) FROM matching_test_rows")) == 18

async def test_second_live_version_is_refused(db):
    with pytest.raises(IntegrityError):
        await db.execute(text("INSERT INTO matching_rule_versions (place, version, state, flow) "
                              "VALUES ('printing', 2, 'live', '{}')"))
        await db.flush()

async def test_bad_state_and_place_are_refused(db): ...   # state 'deployed' / place 'containers' → IntegrityError

async def test_reset_restores_the_seed(db):
    await db.execute(text("DELETE FROM matching_test_assets")); await db.commit()
    await reset_matching_seed(db); await db.commit()
    assert await db.scalar(text("SELECT count(*) FROM matching_test_rows")) == 18

def test_downgrade_drops_every_table():   # load the module as test_migration_0094 does; patch op
    assert dropped == {"matching_test_rows", "matching_test_assets", "matching_rule_versions"}
```

- [ ] **Step 2: Run** `... -m pytest tests/test_migration_0126_matching_rules.py -q -p no:cacheprovider`. Expected: FAIL (tables missing; the harness migrates the test DB to head on start).
- [ ] **Step 3: Implement** the migration, `models.py`, the `db/models.py` import line, and the conftest reseed.
- [ ] **Step 4: Run** the Step 2 command plus `tests/test_migration_0125_scan_match_trace.py tests/test_devtools.py`, and ruff on the new files. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(api): migration 0126 matching rules tables, seeded with v1 and the test set`.

---

### Task 5: Check service and run targets

**Files:**
- Create: `api/src/serversherpa/matching_rules/check.py`
- Test: `api/tests/test_matching_check.py`

**Interfaces:**
- Consumes: Tasks 1–4, plus `_assets_body` and `_client_assets_body` from `serversherpa.api.routes.kiosk` (imported, not changed). Using the sync bodies themselves makes "this move" exactly what the kiosk downloads: no archived filter, `legacy_id` order, client rows deduped by asset id.
- Produces:
  - `async def load_test_set(db: AsyncSession) -> list[MatchingTestAsset]`, ordered by `asset_tag`.
  - `def test_set_targets(assets: Sequence[MatchingTestAsset]) -> list[Target]`, with `key=str(asset.id)`.
  - `@dataclass class RowResult: row: MatchingTestRow; asset: MatchingTestAsset; result: RunResult; passed: bool`. A row passes when expected is `not_found` and the outcome is `not_found`, or when the outcome is `found`, `result.field == row.expected` and `result.asset.key == str(asset.id)`.
  - `def run_test_set(flow: Flow, place: str, assets: Sequence[MatchingTestAsset]) -> list[RowResult]`: only that place's rows, ordered by asset tag then value.
  - `@dataclass class CheckResult: structure: list[CheckItem]; rows: list[RowResult]`, with properties `structure_ok`, `passed`, `total`, `tests_ok` (`total > 0 and passed == total`) and `ok` (`structure_ok and tests_ok`), and `summary(now: datetime) -> dict` (`{"passed", "total", "ok", "checked_at": now.isoformat()}`).
  - `async def check_flow(db: AsyncSession, place: str, flow: Flow) -> CheckResult`. The test set always runs, even when the structure fails.
  - `async def move_targets(db: AsyncSession, initiative_id: uuid.UUID, *, with_client: bool) -> list[Target]`. Move rows come from `_assets_body` (`key=str(a.id)`, `asset_tag=int(a.asset_id) if a.asset_id else None`, `sits="move"`). With `with_client`, rows from `_client_assets_body` are added with `sits="client"`, first row per asset id. It propagates the body's HTTPException (404 `initiative_not_found`, 422 `bad_initiative`).
  - `def uses_client(flow: Flow) -> bool`: True when any Match's `search_in` is `move_and_client`.

- [ ] **Step 1: Write the failing tests:**

```python
async def test_v1_passes_the_seeded_test_set(db):
    for place in PLACES:
        res = await check_flow(db, place, Flow.model_validate(V1_FLOWS[place]))
        assert (res.ok, res.passed, res.total) == (True, 9, 9)

async def test_a_failing_row_is_reported(db):
    f = printing_v1_without_serial_match()          # asset tag → Not found
    res = await check_flow(db, "printing", f)
    failed = {r.row.value: r.result.outcome for r in res.rows if not r.passed}
    assert failed == {"abc-104X": "not_found", "dup-200": "not_found"} and (res.passed, res.ok) == (7, False)

async def test_check_fails_with_no_rows_for_place(db):
    await db.execute(text("DELETE FROM matching_test_rows WHERE place = 'scanning'")); await db.commit()
    res = await check_flow(db, "scanning", Flow.model_validate(V1_FLOWS["scanning"]))
    assert (res.total, res.tests_ok, res.ok) == (0, False, False) and res.structure_ok

async def test_broken_structure_still_runs_tests(db): ...   # unwired → structure_ok False, rows all stopped, ok False

async def test_move_targets_are_the_kiosk_sync(db):
    s = await seed_move(db)        # 3 roster assets created out of legacy_id order, one archived; client X other-move assets
    body = await _assets_body(db, s["move"])
    assert [t.key for t in await move_targets(db, s["move"], with_client=False)] == [str(a.id) for a in body.assets]
    assert s["archived"] in {t.key for t in await move_targets(db, s["move"], with_client=False)}

async def test_move_targets_with_client_dedupes(db):
    ts = await move_targets(db, s["move"], with_client=True)
    client = [t for t in ts if t.sits == "client"]
    assert [t.key for t in client].count(s["on_two_moves"]) == 1

async def test_move_targets_errors(db):
    with pytest.raises(HTTPException) as e: await move_targets(db, uuid.uuid4(), with_client=False)
    assert e.value.status_code == 404 and e.value.detail["code"] == "initiative_not_found"
    # a project initiative → 422 bad_initiative
```
(`seed_move` follows `_seed` in `tests/test_kiosk_client_assets.py`: `Initiative(initiative_type="move", status="in_progress", client_id=…)`, `Asset(...)`, `InitiativeAsset(...)`. Set `legacy_id` explicitly to 300, 100 and 200 so order matters.)

- [ ] **Step 2: Run** `... -m pytest tests/test_matching_check.py -q -p no:cacheprovider`. Expected: FAIL (no `check`).
- [ ] **Step 3: Implement** `check.py`.
- [ ] **Step 4: Run** the Step 2 command, `tests/test_kiosk_client_assets.py`, and ruff. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(api): matching rules check against the test set, and move targets from the kiosk sync`.

---

### Task 6: Versions API (drafts, standby, deploy, rollback, audit)

**Files:**
- Create: `api/src/serversherpa/matching_rules/schemas.py`, `api/src/serversherpa/matching_rules/versions.py`, `api/src/serversherpa/api/routes/matching_rules.py`
- Modify: `api/src/serversherpa/api/app.py` (`app.include_router(matching_rules.router)` after `health.router`, plus the import)
- Test: `api/tests/test_matching_versions_api.py`

**Interfaces:**
- Consumes: Task 5 `check_flow`, `CheckResult`. Task 4 models. `audit` from `serversherpa.services.audit`. `client_ip` from `api.deps`.
- Produces (`schemas.py`, Pydantic, `extra="forbid"` on inputs):
  - `CheckSummaryOut{passed: int, total: int, ok: bool, checked_at: datetime | None}`
  - `ProblemOut{message: str, node_ids: list[str]}`, `CheckItemOut{code, label, ok: bool, problems: list[ProblemOut]}`
  - `HitOut{id: str, asset_tag: int | None, name, rfid, serial: str | None, sits: Literal["move","client"]}`
  - `TestRowResultOut{row_id, test_asset_id: uuid, asset_tag: int, asset_name: str, value: str, expected: str, outcome: Literal["found","not_found","stopped"], found_asset_tag: int | None, found_field: str | None, passed: bool}`
  - `CheckOut{ok, structure_ok, tests_ok: bool, passed, total: int, structure: list[CheckItemOut], tests: list[TestRowResultOut]}` and `check_out(res: CheckResult) -> CheckOut`.
  - `VersionOut{id, place, version, state, based_on_version: int | None, saved_by_name: str | None, saved_at: datetime, state_changed_at: datetime | None, checked: CheckSummaryOut | None, current: CheckSummaryOut}`. `current` comes from re-running against today's test set, with `checked_at=None`.
  - `VersionDetailOut(VersionOut){flow: Flow, check: CheckOut}`
  - `VersionCreateIn{place: Place, flow: Flow, based_on_id: uuid | None = None}`, `VersionUpdateIn{flow: Flow}`
- Produces (`versions.py`):
  - `class MatchingError(Exception)`: `__init__(self, status: int, code: str, **extra)`. The route turns it into `HTTPException(status, {"code": code, **extra})`.
  - `async def get_version(db, version_id) -> MatchingRuleVersion` (404 `version_not_found`)
  - `async def list_versions(db, place) -> list[MatchingRuleVersion]` (version desc)
  - `async def create_draft(db, *, place, flow: Flow, based_on_id, actor_id) -> MatchingRuleVersion`. The version number is max+1 for the place, and an IntegrityError on (place, version) is retried once, then 409 `version_conflict`. A `based_on_id` from another place gives 422 `wrong_place`.
  - `async def update_draft(db, version, flow, actor_id) -> MatchingRuleVersion` (409 `not_draft` unless the state is draft)
  - `async def make_standby(db, version_id, actor_id) -> MatchingRuleVersion`: draft only.
  - `async def deploy(db, version_id, actor_id) -> tuple[MatchingRuleVersion, int | None]`: from draft or standby. Returns the retired version number.
  - `async def rollback(db, version_id, actor_id) -> tuple[MatchingRuleVersion, int | None]`: from retired only.
  - All three state changes first lock the place's rows (`SELECT … WHERE place = :p FOR UPDATE`), re-read the state, give 409 `bad_state` (with `state`) for a wrong state, then run `check_flow` and give 422 `check_failed` (with `check` = `check_out(...)` dumped) when not ok. They retire the current live row before setting the new one (the index is checked per statement), store `checked = res.summary(now)`, and set `state_changed_by`/`state_changed_at`.
- Routes (`router = APIRouter(prefix="/devtools/matching-rules", tags=["devtools"])`, `_CAN_VIEW`/`_CAN_CHANGE` module-level as in `routes/health.py`):
  - `GET /versions?place=` gives `list[VersionOut]` (view; a bad place is 422)
  - `GET /versions/{version_id}` gives `VersionDetailOut` (view)
  - `POST /versions` (201), `PUT /versions/{version_id}`, `POST /versions/{version_id}/standby`, `/deploy`, `/rollback` give `VersionDetailOut` (change)
  - Audit (`entity_type="matching_rule_version"`, `entity_id=str(id)`, `ip=client_ip(request)`): `matching_rules.save` `{"place","version","created": bool}`, `matching_rules.standby` `{"place","version"}`, `matching_rules.deploy` and `matching_rules.rollback` `{"place","version","retired_version"}`. Commit after the audit.

- [ ] **Step 1: Write the failing tests.** The helper `dev(client, db, seeded_user, role="developer")` calls `set_role` and `login` from `tests/test_devtools.py`. `_v1(client, h, place)` returns the live v1 row.

```python
async def test_list_shows_live_v1(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    r = await client.get("/devtools/matching-rules/versions?place=printing", headers=h)
    [v] = r.json()
    assert (v["version"], v["state"], v["saved_by_name"]) == (1, "live", None)
    assert v["current"] == {"passed": 9, "total": 9, "ok": True, "checked_at": None}

@pytest.mark.parametrize("role", ["founder", "super_admin", "admin", "staff"])
async def test_only_developers(client, db, seeded_user, role):
    h = await dev(client, db, seeded_user, role)
    assert (await client.get("/devtools/matching-rules/versions?place=printing", headers=h)).status_code == 403

async def test_create_draft_numbers_next_version_and_audits(client, db, seeded_user):
    r = await client.post(URL + "/versions", headers=h, json={"place": "printing", "flow": V1_FLOWS["printing"], "based_on_id": v1["id"]})
    assert r.status_code == 201 and (r.json()["version"], r.json()["state"], r.json()["based_on_version"]) == (2, "draft", 1)
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "matching_rules.save"))
    assert row.changes == {"place": "printing", "version": 2, "created": True} and row.actor_person_id == seeded_user.id

async def test_draft_may_fail_the_check(...):   # unwired flow → 201, detail check.ok False
async def test_only_drafts_are_edited(...):     # PUT v1 → 409 not_draft; PUT draft → 200, flow replaced, audit created False
async def test_standby_needs_the_check(...):    # failing draft → 422 check_failed, detail.check.structure_ok False; passing → standby, checked passed 9
async def test_deploy_retires_the_old_live(...):
    # deploy v2 → v2 live, v1 retired; audit deploy changes == {"place": "printing", "version": 2, "retired_version": 1}
async def test_deploy_from_standby(...)
async def test_deploying_a_live_version_is_409(...)   # bad_state, detail.state == "live"
async def test_rollback_to_retired(...)               # v1 live again, v2 retired; audit rollback
async def test_rollback_only_from_retired(...)        # draft → 409 bad_state
async def test_rollback_must_pass_todays_test_set(...)
    # deploy a v2 copy of v1 (v1 retired); then insert row (Test asset 1, printing, "Test asset 1", "name"), which v1 fails; rollback v1 → 422 check_failed
async def test_live_failing_today_is_flagged_not_retired(...)
    # insert row (printing, "Test asset 1", expected "name") → list: v1 live, current.ok False, passed 9 of 10
async def test_concurrent_deploys_leave_one_live(client, db, seeded_user):
    a, b = await draft(...), await draft(...)
    await asyncio.gather(client.post(f"{URL}/versions/{a}/deploy", headers=h), client.post(f"{URL}/versions/{b}/deploy", headers=h))
    assert await db.scalar(text("SELECT count(*) FROM matching_rule_versions WHERE place='printing' AND state='live'")) == 1
async def test_detail_has_flow_and_full_check(...)    # flow == V1, len(check.tests) == 9, len(check.structure) == 7
async def test_other_place_is_422(...)                # ?place=containers → 422
```

- [ ] **Step 2: Run** `... -m pytest tests/test_matching_versions_api.py -q -p no:cacheprovider`. Expected: FAIL (404s, no router).
- [ ] **Step 3: Implement** `schemas.py`, `versions.py`, the routes and the `app.py` wiring. `saved_by_name` is `Person.display_name` of `updated_by`, loaded in one query per list.
- [ ] **Step 4: Run** the Step 2 command plus Tasks 1–5's tests and ruff. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(api): matching rules versions API (draft, standby, deploy, rollback, audit)`.

---

### Task 7: Check, test-run and test-set API

**Files:**
- Modify: `api/src/serversherpa/api/routes/matching_rules.py`, `api/src/serversherpa/matching_rules/schemas.py`, `api/src/serversherpa/api/deps.py` (`READ_ONLY_EXEMPT_PATHS`)
- Test: `api/tests/test_matching_run_api.py`, `api/tests/test_matching_test_set_api.py`

**Interfaces:**
- Consumes: Tasks 2, 5, 6.
- Produces (schemas):
  - `CheckIn{place: Place, flow: Flow}`
  - `TestRunIn{place: Place, flow: Flow, value: str (max 256), against: Literal["test_set","move"], initiative_id: uuid | None = None}`
  - `TraceStepOut{node_id, kind, value_in: str, value_out: str | None, output: str | None, hits: list[HitOut] | None}`
  - `RunOut{outcome, stop_reason: str | None, end_node_id: str | None, asset: HitOut | None, field, action, message: str | None, trace: list[TraceStepOut]}`
  - `TestRowIn{place: Place, value: str (1–256), expected: Literal[...EXPECTED]}`. `TestRowOut(TestRowIn){id, test_asset_id}`.
  - `TestAssetIn{asset_tag: int (≥1), name: str (1–200, stripped), rfid: str | None (≤128), serial: str | None (≤128), sits: Literal["move","client"] = "move"}`. Blank rfid or serial is stored as NULL. `TestAssetOut(TestAssetIn){id, rows: list[TestRowOut]}`.
- Routes:
  - `POST /check` (view) gives `CheckOut`, for an unsaved flow.
  - `POST /test-run` (view) gives `RunOut`. A value blank after `JS_WHITESPACE` trimming is 422 `value_required`. `against="move"` without `initiative_id` is 422 `initiative_required`. Targets are `test_set_targets(load_test_set)` or `move_targets(db, id, with_client=uses_client(flow))`. It writes nothing and does not commit.
  - `GET /test-assets` (view) gives `list[TestAssetOut]` (asset-tag order).
  - `POST /test-assets` (201), `PATCH /test-assets/{id}`, `DELETE /test-assets/{id}` (204; rows cascade) (change). The 11th asset is 409 `test_set_full` (cap `MAX_TEST_ASSETS = 10`). A duplicate tag is 409 `duplicate_asset_tag`. An unknown id is 404 `test_asset_not_found`.
  - `POST /test-assets/{id}/rows` (201), `PATCH /test-rows/{id}`, `DELETE /test-rows/{id}` (204) (change). A duplicate (place, value) is 409 `duplicate_value`. An unknown id is 404 `test_row_not_found`.
  - Audit (`entity_type` `matching_test_asset` / `matching_test_row`): `matching_rules.test_asset.create|update|delete` with `{"asset_tag"}`, and `matching_rules.test_row.create|update|delete` with `{"place","value","expected"}`.
  - `deps.py`: add `"/devtools/matching-rules/check"` and `"/devtools/matching-rules/test-run"` to `READ_ONLY_EXEMPT_PATHS`, with the comment `# matching rules: a check or a test run reads a flow and the test set and stores nothing`.

- [ ] **Step 1: Write the failing tests.** In `test_matching_run_api.py`:

```python
async def test_check_an_unsaved_flow(...):  # POST /check v1 printing → ok True, passed 9, len(structure) 7

async def test_test_run_against_the_test_set(...):
    r = await client.post(URL + "/test-run", headers=h, json={"place": "scanning", "flow": V1_FLOWS["scanning"], "value": "102", "against": "test_set"})
    b = r.json()
    assert (b["outcome"], b["field"], b["asset"]["asset_tag"], b["action"]) == ("found", "rfid", 103, "record_scan")
    assert [s["kind"] for s in b["trace"]] == ["scan_input", "clean_up", "clean_up", "match", "found"]

async def test_test_run_writes_nothing(...):
    before = await counts(db)  # raw_scans, processed_scans, assets, matching_rule_versions, matching_test_rows, audit_log
    ... run against test set and against a move ...
    assert await counts(db) == before

async def test_test_run_against_a_move(...):   # seed a move (as Task 5); value = an asset's serial lower-cased (printing v1) → asset.id == str(asset.id)
async def test_move_run_needs_a_move(...):     # against move, no initiative_id → 422 initiative_required
async def test_move_run_unknown_or_not_a_move(...):  # 404 initiative_not_found; project → 422 bad_initiative
async def test_test_run_blank_value_422(...):  # value "   " → 422 value_required
async def test_stopped_run_is_200(...):        # unwired flow → 200, outcome stopped, stop_reason unwired
async def test_runs_work_in_read_only_mode(...):
    # PUT /system/admin {"read_only": true} as a super admin (make one as tests/test_asset_watches_api.py `_make` does)
    # /check and /test-run → 200; POST /versions → (423, "read_only_mode")
async def test_runs_need_devtools(...):        # founder → 403 on both
```

In `test_matching_test_set_api.py`:

```python
async def test_list_in_asset_tag_order_with_rows(...):
    tags = [a["asset_tag"] for a in (await client.get(URL + "/test-assets", headers=h)).json()]
    assert tags == [7, 101, 102, 103, 104, 106, 107, 108]

async def test_create_until_full(...):
    for tag in (201, 202): assert (await post_asset(tag)).status_code == 201
    r = await post_asset(203)
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "test_set_full")

async def test_asset_tag_unique(...)          # 409 duplicate_asset_tag (after deleting one so the cap isn't hit)
async def test_blank_rfid_and_serial_store_null(...)
async def test_delete_cascades_rows(...)      # delete tag 7 → its 4 rows gone (2 per place), row count 14
async def test_row_value_unique_per_place(...):
    r = await client.post(f"{URL}/test-assets/{a7}/rows", headers=h, json={"place": "printing", "value": "102", "expected": "not_found"})
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "duplicate_value")
    ok = await client.post(..., json={"place": "scanning", "value": "101", "expected": "not_found"})
    assert ok.status_code == 201
async def test_edits_are_audited(...)         # create/update/delete each write one audit row with the action names above
async def test_test_set_needs_devtools(...)   # super_admin → 403
```

- [ ] **Step 2: Run** `... -m pytest tests/test_matching_run_api.py tests/test_matching_test_set_api.py -q -p no:cacheprovider`. Expected: FAIL.
- [ ] **Step 3: Implement** the schemas, the routes and the `deps.py` entries. Turn IntegrityErrors on the two unique constraints into the 409 codes by constraint name, after `await db.rollback()`.
- [ ] **Step 4: Run** the Step 2 command plus every `tests/test_matching_*.py` file, `tests/test_migration_0126_matching_rules.py`, and ruff. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(api): matching rules check, test run and test set API`.

---

### Task 8: Portal dependency, API client and flow helpers

**Files:**
- Modify: `portal/package.json`, `portal/package-lock.json`, `portal/src/lib/api.ts` (new section at the end: `// ── matching rules (/devtools/matching-rules) ──`)
- Create: `portal/src/lib/matchingRules.ts`
- Test: `portal/src/lib/matchingRules.test.ts`, `portal/src/lib/api.matchingRules.test.ts`

**Interfaces:**
- Consumes: the Task 6 and 7 routes and schemas, with field names unchanged.
- Produces (`api.ts`): TS types `MatchingPlace`, `MatchingState`, `MatchingCheckSummary`, `MatchingProblem`, `MatchingCheckItem`, `MatchingTestRowResult`, `MatchingCheck`, `MatchingVersion`, `MatchingVersionDetail`, `MatchingHit`, `MatchingTraceStep`, `MatchingRun`, `MatchingTestRow`, `MatchingTestAsset`, `MatchingTestAssetIn`, `MatchingTestRowIn`, mirroring the Pydantic models. Functions, each one `apiFetch` call, throwing `await errorFrom(resp)` when not ok:
  - `listMatchingVersions(place): Promise<MatchingVersion[]>`, `getMatchingVersion(id): Promise<MatchingVersionDetail>`
  - `createMatchingDraft(body: {place; flow: Flow; based_on_id?: string | null}): Promise<MatchingVersionDetail>`, `updateMatchingDraft(id, flow)`
  - `standbyMatchingVersion(id)`, `deployMatchingVersion(id)`, `rollbackMatchingVersion(id)`: `Promise<MatchingVersionDetail>`
  - `checkMatchingFlow(place, flow): Promise<MatchingCheck>`, `testRunMatchingFlow(body: {place; flow; value; against: 'test_set' | 'move'; initiative_id?: string}): Promise<MatchingRun>`
  - `listMatchingTestAssets()`, `createMatchingTestAsset(body)`, `updateMatchingTestAsset(id, body)`, `deleteMatchingTestAsset(id): Promise<void>`, `createMatchingTestRow(assetId, body)`, `updateMatchingTestRow(id, body)`, `deleteMatchingTestRow(id): Promise<void>`
- Produces (`matchingRules.ts`):
  - Types `NodeKind`, `FlowNode {id; kind; settings: Record<string, string>; position: {x: number; y: number}}`, `FlowEdge {id; source; output; target}`, `Flow {format: 1; nodes; edges}`.
  - Label tables as `{key, label}[]`, with the same keys and labels as Task 1: `PLACES` (Printing, Scanning), `KINDS`, `CLEAN_OPS`, `FIELDS`, `COMPARES`, `SEARCH_IN`, `FOUND_ACTIONS`, `EXPECTED_LABELS` (`asset_tag` "Found by asset tag", `serial` "Found by serial", `rfid` "Found by RFID", `name` "Found by name", `not_found` "Not found"), `STATE_LABELS` (Draft, Standby, Live, Retired).
  - `outputsFor(node): string[]` and `nodeTitle(node): string`: the same rules as Task 1.
  - `defaultSettings(kind): Record<string, string>`: match gives `{table: 'assets', search_in: 'move', multiple: 'first'}`, not_found gives `{message: ''}`, the rest `{}`.
  - `addNode(flow, kind, position): {flow; id}`: the id is `n{max numeric suffix + 1}`.
  - `connect(flow, source, output, target): Flow`. It replaces any edge already on `(source, output)`, with edge id `e{max + 1}`. It returns `flow` unchanged for a self-wire, a target that is a `scan_input`, a terminal source, or an `output` not in `outputsFor(source)`.
  - `setSettings(flow, id, settings): Flow`: also drops the node's edges from outputs it no longer has.
  - `moveNode(flow, id, position): Flow`, `removeNode(flow, id): Flow` (drops its edges), `removeEdge(flow, id): Flow`.
  - `litPath(trace: MatchingTraceStep[], flow: Flow): {nodes: Set<string>; edges: Set<string>}`. The nodes are every `node_id` in the trace. The edges are those whose `(source, output)` equals a step's `(node_id, output)` and whose target is the next step's node.
  - `formatSavedAt(iso: string | null): string`: `'—'` for null, else `${longDate(iso)}, HH:MM` (local, 24-hour, zero-padded).
  - `sameFlow(a, b): boolean` (JSON equality, for the dirty check).

- [ ] **Step 1: Add the dependency without breaking the symlink.** `@xyflow/react` 12.12.0 was published 2026-09-24, more than two weeks before 2026-11-10 (12.12.1 is from 2026-11-02, too new). It is MIT licensed, has a 1.2 MB unpacked size, and depends on `zustand ^4.4.0`, `classcat` and `@xyflow/system 0.0.83`.
  1. `ls -la portal/node_modules`: it must show `-> /Users/jrh1812/Developer/BaseCampV3/portal/node_modules`.
  2. From the worktree's `portal/`: `npm install --package-lock-only --save-exact @xyflow/react@12.12.0`. This changes only `package.json` (`"@xyflow/react": "12.12.0"`) and `package-lock.json`.
  3. From `/Users/jrh1812/Developer/BaseCampV3/portal`: first run `npm install --no-save @xyflow/react@12.12.0 --dry-run`. If it plans to remove or change any package other than adding `@xyflow/react`, `@xyflow/system`, `classcat`, `zustand` and their d3 dependencies, stop and report. Otherwise run it without `--dry-run`.
  4. Verify: `ls -la portal/node_modules` (still a symlink). `node -p "require('./portal/node_modules/@xyflow/react/package.json').version"` gives `12.12.0`. `git -C /Users/jrh1812/Developer/BaseCampV3 status --short` shows no tracked change. In the worktree, `git status --short` lists only `portal/package.json` and `portal/package-lock.json`.
- [ ] **Step 2: Write the failing tests.** `matchingRules.test.ts`:

```ts
it('connect replaces the wire on an output and refuses bad wires', () => {
  const f1 = connect(base, 'n3', 'none', 'n5');
  const f2 = connect(f1, 'n3', 'none', 'n4');
  expect(f2.edges.filter((e) => e.source === 'n3' && e.output === 'none').map((e) => e.target)).toEqual(['n4']);
  expect(connect(base, 'n3', 'none', 'n3')).toBe(base);   // self
  expect(connect(base, 'n2', 'out', 'n1')).toBe(base);    // into Scan input
  expect(connect(base, 'n4', 'out', 'n5')).toBe(base);    // from a terminal
  expect(connect(base, 'n2', 'invalid', 'n5')).toBe(base); // trim has no "invalid"
});
it('changing a clean-up from number to trim drops its invalid wire', () => { ... });
it('removeNode drops its wires; addNode numbers after the highest id', () => { ... });  // ids n1..n5 → 'n6'
it('litPath lights the visited steps and the wires taken', () => {
  const lit = litPath(traceOf(['n1', 'out'], ['n2', 'out'], ['n3', 'none'], ['n5', null]), base);
  expect([...lit.nodes]).toEqual(['n1', 'n2', 'n3', 'n5']);
  expect([...lit.edges].sort()).toEqual(['e1', 'e2', 'e4']);
});
it('nodeTitle and outputsFor match the server', () => {
  expect(nodeTitle({ ...clean, settings: { op: 'trim' } })).toBe('Clean up (Trim)');
  expect(nodeTitle({ ...match, settings: {} })).toBe('Match');
  expect(outputsFor({ ...clean, settings: { op: 'pad_24' } })).toEqual(['out', 'invalid']);
});
it('formatSavedAt is 24-hour', () => {
  expect(formatSavedAt(new Date(2026, 10, 10, 14, 2).toISOString())).toMatch(/, 14:02$/);
  expect(formatSavedAt(null)).toBe('—');
});
```
`api.matchingRules.test.ts`, using the `mockFetch` pattern from `lib/api.assetWatches.test.ts`: each call's method, path and JSON body. `deployMatchingVersion` on a 422 rejects with an `ApiError` whose `code` is `check_failed` and whose `detail.check.ok` is `false`. `listMatchingVersions('scanning')` hits `/devtools/matching-rules/versions?place=scanning`.
- [ ] **Step 3: Run** `npx vitest run src/lib/matchingRules.test.ts src/lib/api.matchingRules.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `matchingRules.ts` and the `api.ts` section.
- [ ] **Step 5: Run** the Step 3 command and `npx tsc -b`. Expected: PASS, clean.
- [ ] **Step 6: Commit** `feat(portal): matching rules API client and flow helpers; pin @xyflow/react 12.12.0`.

---

### Task 9: Management page, Developer card, route and nav

**Files:**
- Create: `portal/src/pages/MatchingRules.tsx`, `portal/src/components/matching/VersionsTable.tsx`, `CheckPanel.tsx`, `TestAssetsPanel.tsx`, `TestAssetModal.tsx`, `StateChangeModal.tsx`, `portal/src/styles/matching-rules.css`
- Modify: `portal/src/pages/Dev.tsx`, `portal/src/App.tsx`, `portal/src/layout/navSections.tsx` (Developer section, after Variables: `to: '/dev/matching-rules'`, label `Matching rules`, `resource: 'devtools'`, `godOnly: true`, a branching-arrows icon in the section's stroke style), `portal/src/lib/access.ts` (`'/dev/matching-rules': 'devtools'`), `portal/src/components/Topbar.tsx` (`'/dev/matching-rules': ['Portal', 'Developer tools', 'Matching rules']`), `portal/src/components/CommandPalette.tsx` (`...navGated('Matching rules', '/dev/matching-rules', 'devtools', true)`), `portal/src/styles/chrome.css` (add `.mr-scroll` to the rounded-scrollbar `:is(...)` list)
- Test: `portal/src/pages/MatchingRules.test.tsx`, `portal/src/pages/Dev.test.tsx`, `portal/src/lib/godmode.test.ts` (one case), `portal/src/App.matchingRoutes.test.ts`

**Interfaces:**
- Consumes: Task 8 API functions and helpers.
- Produces:
  - Route `/dev/matching-rules` → `<ProtectedRoute resource="devtools"><MatchingRules /></ProtectedRoute>`. Task 10 adds `/dev/matching-rules/versions/:id`.
  - `VersionsTable({versions, selectedId, onSelect, onOpen, onDeploy, onRollback})`
  - `CheckPanel({version: MatchingVersion | null, check: MatchingCheck | null})`
  - `TestAssetsPanel({place, assets, results: MatchingTestRowResult[], onAdd, onEdit, onDelete})`
  - `TestAssetModal({asset: MatchingTestAsset | null, onClose, onSaved})`
  - `StateChangeModal({kind: 'deploy' | 'rollback' | 'standby', version, liveVersion: number | null, placeLabel, onClose, onDone})`

Page behavior and copy (exact):
- Header: eyebrow `Developer`, h1 `Matching rules`, hint `One flow per place for how a scanned or typed value finds its asset. Deploying marks a version live; the kiosks and apps don't follow it yet.`
- Place switch: `.segmented` with `role="tablist"` and `aria-label="Place"`: `Printing` | `Scanning`, kept in `?place=` (default printing).
- Toolbar (`dir-toolbar`): `Edit flow` (opens `/dev/matching-rules/versions/{selected id}`), `Run tests` (re-fetches the selected version's detail, whose `check` is today's), `Save as standby` (enabled only for a draft), `Deploy` (enabled for a draft or standby). The selection defaults to the live row, and clicking a row selects it.
- Versions `DataTable` columns: Version (`v{n}`), State (chip with the `STATE_LABELS` label), Saved by (`saved_by_name ?? 'System'`), Saved (`formatSavedAt(saved_at)`), Tests (`{passed} of {total}`, plus a chip `Fails today's test set` when the state is live and `!current.ok`), Actions (`RowActionsMenu`: `Open`; `Deploy` for draft/standby; `Roll back to` for retired).
- Check panel: title `Check · v{n}`; one line per structure item, `✓`/`✗` plus its label, with problems listed under ✗; a line `Test set: {passed} of {total}` (or `Test set: no rows for this place yet` when total is 0); when `checked` is set, `Checked {formatSavedAt(checked_at)}: {passed} of {total}`.
- Test assets panel: title `Test assets`, button `Add test asset` (disabled at 10 assets, with hint `The test set holds at most 10 assets.`), and hint `The test set should have 5 to 10 assets.` when there are fewer than 5. `DataTable` columns: Asset tag, Name, Value tried, Should find (`EXPECTED_LABELS`), Result (`Pass`, `Fail: found by {field label} on {tag}` or `Fail: not found` or `Fail: stopped`), Actions (`Edit`, `Delete`). There is one table row per row of this place, plus one row with `—` cells for an asset with no rows for this place.
- `TestAssetModal`: eyebrow `Matching rules`, h3 `Add test asset` / `Edit test asset`. Fields: `Asset tag` (number), `Name`, `RFID`, `Serial`, `Where it sits` (`.segmented`: `On the move` | `Client's other device`), and an `Expected results` list, each with Place (ComboBox), `Value to try`, Should find (ComboBox) and `Remove`, plus `Add expected result`. Footer: `Save` / `Cancel`. Save creates or updates the asset, then creates, updates and deletes rows to match. Error copy: `duplicate_asset_tag` gives `Another test asset has asset tag {n}.`; `duplicate_value` gives `{Place} already has an expected result for "{value}".`; `test_set_full` gives `The test set holds at most 10 assets.`
- `StateChangeModal`, deploy: h3 `Deploy v{n}`, hint `v{n} becomes the live {Place} flow, and v{m} is retired.` (without the clause when there is no live version), button `Deploy`. Roll back: h3 `Roll back to v{n}`, hint `v{n} becomes the live {Place} flow again, and v{m} is retired.`, button `Roll back`. Standby: h3 `Save v{n} as standby`, hint `v{n} is checked and kept ready, but not live.`, button `Save as standby`. On `check_failed`, the modal shows `v{n} doesn't pass the check. The check panel shows what's wrong.`, the page sets the check panel from `detail.check`, and the modal stays open. Success closes it and reloads the list.
- Delete test asset: a confirm modal, h3 `Delete test asset {tag}`, hint `Its expected results are deleted with it.`, button `Delete` (class `btn-danger`, `styles/directory.css`).
- `Dev.tsx`: keep the existing header and add a `bulk-grid` with one `bulk-card` (import `../styles/bulk.css`): title `Matching rules`, text `Edit, test and deploy how a scanned or typed value finds its asset.`, button `Open` (navigates to `/dev/matching-rules`).
- CSS: `mr-` prefix, theme tokens only. Panels use `.mr-scroll` with `overflow:auto` and a radius (hence the chrome.css list). No list typography outside `directory.css`.

- [ ] **Step 1: Write the failing tests.** `MatchingRules.test.tsx` mocks `../lib/api` (the `vi.hoisted` pattern from `DevDatabase.test.tsx`) and wraps the page in `MemoryRouter`:
  - `shows live v1 with today's result`: row `v1`, `Live`, `System`, `9 of 9`.
  - `switching to Scanning loads its versions`: `listMatchingVersions` last called with `'scanning'`.
  - `Deploy asks first, then deploys and reloads`: Actions ▾ › Deploy on a draft `v2`. The dialog has class `rgm-card`, its text is `v2 becomes the live Printing flow, and v1 is retired.`, and confirming calls `deployMatchingVersion('v2id')` and reloads the list.
  - `a failing deploy keeps the dialog and fills the check panel`: a 422 `check_failed` with `detail.check` that has a ✗ `Every output is wired to one step`.
  - `flags a live version that fails today`: shows the `Fails today's test set` chip.
  - `Roll back to is offered only on retired rows`.
  - `test assets: Add is disabled at 10; the under-5 hint shows`.
  - `TestAssetModal saves the asset then its rows; a duplicate value shows the message`.
  - `Edit flow opens the editor for the selected version`.

  `Dev.test.tsx`: the card `Matching rules` and `Open` navigate to `/dev/matching-rules`. `godmode.test.ts`: the `/dev/matching-rules` nav item exists and is hidden without god mode (copy the Variables case). `App.matchingRoutes.test.ts` reads `App.tsx` as text and asserts every `path="/dev/matching-rules…"` route element contains `ProtectedRoute resource="devtools"`, and that `ROUTE_RESOURCE['/dev/matching-rules']` (`lib/access.ts`) is `'devtools'`.
- [ ] **Step 2: Run** `npx vitest run src/pages/MatchingRules.test.tsx src/pages/Dev.test.tsx src/lib/godmode.test.ts src/App.matchingRoutes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the page, components, CSS and wiring.
- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run src/styles` and `npx tsc -b`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(portal): Developer › Matching rules management page`.

---

### Task 10: Flow editor (palette, canvas, settings, save)

**Files:**
- Create: `portal/src/pages/MatchingRuleEditor.tsx`, `portal/src/components/matching/FlowCanvas.tsx`, `FlowNodeView.tsx`, `NodePalette.tsx`, `NodeSettings.tsx`
- Modify: `portal/src/App.tsx` (lazy route), `portal/src/styles/matching-rules.css` (Topbar `CRUMBS` matches exact paths only, so the editor's id path keeps the default trail, like every other id page)
- Test: `portal/src/components/matching/FlowCanvas.test.tsx`, `portal/src/pages/MatchingRuleEditor.test.tsx`

**Interfaces:**
- Consumes: Task 8 helpers and API functions. `useLeaveGuard` (`lib/useLeaveGuard.ts`). `ComboBox`.
- Produces:
  - Route `/dev/matching-rules/versions/:id`: `const MatchingRuleEditor = lazy(() => import('./pages/MatchingRuleEditor'))`, rendered as `<ProtectedRoute resource="devtools"><Suspense fallback={<div className="dir-empty">Loading…</div>}><MatchingRuleEditor /></Suspense></ProtectedRoute>`. The lazy import keeps React Flow out of the main bundle.
  - `FlowCanvas({flow, selected: {kind: 'node' | 'edge'; id} | null, warnings: Set<string>, lit: {nodes: Set<string>; edges: Set<string>} | null, onChange(flow: Flow), onSelect(sel | null), onDropKind(kind, position)})`. This is the only file that imports `@xyflow/react` and `@xyflow/react/dist/style.css`. It maps `flow` to React Flow nodes (`type: 'mr'`, data = node) and edges (`sourceHandle = output`, `targetHandle = 'in'`). `onConnect` calls `connect()`, `isValidConnection` mirrors `connect`'s refusals, a node drag end calls `moveNode()`, and `onNodesDelete`/`onEdgesDelete` call `removeNode()`/`removeEdge()`. It renders `<Controls showInteractive={false} />` (visible zoom in, zoom out and fit buttons) and `<Background />`. Drop uses `screenToFlowPosition` with `dataTransfer` type `application/x-matching-node`.
  - `FlowNodeView`: the title (`nodeTitle`), a target handle `in` (none on Scan input), and one labeled source handle per `outputsFor(node)` (labels `out`, `invalid`, `found`, `none`). Classes: `mr-node`, `mr-node-{kind}`, plus `mr-warn` when in `warnings`, `mr-lit` when in `lit.nodes`, and `mr-dim` when `lit` is set and the node isn't in it. Lit edges get class `mr-lit-edge`.
  - `NodePalette({hasScanInput, onAdd(kind)})`: one button per kind, draggable, with click to add at the viewport center. `Scan input` is disabled when one exists.
  - `NodeSettings({node, edge, onChange(settings), onDeleteNode(), onDeleteEdge()})`. Scan input shows `No settings.` Clean up shows a ComboBox `Clean up` (CLEAN_OPS). Match shows ComboBoxes `Table` (Assets), `Field`, `Compare`, `Search in`, and the fixed line `When two or more match: Take the first, by asset tag order`. Found shows ComboBox `What happens` (FOUND_ACTIONS). Not found shows a text input `Message`. Every node gets the button `Delete step` (not on Scan input), and a selected wire gets `Delete wire`.
- Page:
  - Loads `getMatchingVersion(id)`.
  - Top bar: eyebrow `Matching rules · {Place}`, h1 `v{n}` plus a state chip, buttons `Discard` (enabled when dirty; restores the loaded flow) and `Save`. A draft saves with `updateMatchingDraft`. Any other state shows the note `Saving makes a new draft from v{n}.`, and Save calls `createMatchingDraft({place, flow, based_on_id: id})`, then `navigate('/dev/matching-rules/versions/{new id}', {replace: true})`. On success the page shows `Saved v{n}.`
  - Live warnings: 400 ms after the last change, `checkMatchingFlow(place, flow)`. The node ids from failing structure items become `warnings`, and a strip above the canvas lists their messages plus `Test set: {passed} of {total}`. A late response for an older flow is dropped.
  - Leave guard: `useLeaveGuard(dirty, (to) => setLeaveTo(to))` opens a modal (h3 `Leave without saving?`, hint `Your changes to v{n} aren't saved.`, buttons `Leave` / `Stay`).
  - Layout: palette left, canvas middle, settings right (`.mr-editor` grid). The test bar slot sits at the bottom (Task 11). At widths under 900 px the side panels stack under the canvas.
  - React Flow theming: in `matching-rules.css`, set React Flow's `--xy-*` variables on `.mr-canvas` (background, node background/border/text, edge stroke, selected stroke, handle, controls button background/hover/color) to the portal tokens from Global Constraints, so light and dark both follow `.portal-shell[data-theme]`.

- [ ] **Step 1: Write the failing tests.** `FlowCanvas.test.tsx` renders the real React Flow. At the top, stub `ResizeObserver` and `DOMMatrixReadOnly` on `globalThis`, and give `HTMLElement.prototype` `offsetWidth`/`offsetHeight` 500 (the React Flow testing recipe).
  - `renders each step with its title and output labels`: `Clean up (Trim)`, `Match (asset tag)`, and handle labels `found`, `none`.
  - `marks warned and lit steps`: `mr-warn` on a warned id. With `lit`, the lit id has `mr-lit` and another id has `mr-dim`.
  - `shows visible zoom buttons`: `getByRole('button', { name: /zoom in/i })`.

  `MatchingRuleEditor.test.tsx` mocks `../components/matching/FlowCanvas` with a stub that renders one button per node (`onSelect`) and a button `stub-connect` (`onChange(connect(flow, 'n3', 'none', 'n6'))`; the fixture flow has a spare Not found `n6`), and mocks `../lib/api`:
  - `loads the version and shows the palette and top bar`: `v2`, `Draft`.
  - `editing a Match field and saving a draft`: select the node, choose Field `serial`, Save calls `updateMatchingDraft('v2id', flowWith n3.settings.field === 'serial')`.
  - `saving a live version makes a new draft`: the note text is shown; `createMatchingDraft` gets `based_on_id: 'v1id'`; navigation goes to the new id.
  - `Discard restores the loaded flow`.
  - `live check runs after edits and marks warnings` (fake timers): `checkMatchingFlow` is called once 400 ms after two quick edits; the warning strip shows the problem message.
  - `asks before leaving with unsaved changes`: after an edit, clicking an in-app `<a href="/dev">` shows `Leave without saving?`.
  - `Delete step removes the node and its wires`.
  - `Scan input is disabled in the palette when the flow has one`.
- [ ] **Step 2: Run** `npx vitest run src/components/matching/FlowCanvas.test.tsx src/pages/MatchingRuleEditor.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the page and components.
- [ ] **Step 4: Run** the Step 2 command, `npx vitest run src/styles src/pages/MatchingRules.test.tsx`, `npx tsc -b` and `npm run build`. Expected: PASS, clean, and the build output has a separate chunk for `MatchingRuleEditor`.
- [ ] **Step 5: Commit** `feat(portal): matching rules flow editor`.

---

### Task 11: Test bar with path highlighting, then the full suites

**Files:**
- Create: `portal/src/components/matching/TestBar.tsx`
- Modify: `portal/src/pages/MatchingRuleEditor.tsx` (render `TestBar`, feed `litPath` into `FlowCanvas`), `portal/src/styles/matching-rules.css`
- Test: `portal/src/components/matching/TestBar.test.tsx`, plus one case in `portal/src/pages/MatchingRuleEditor.test.tsx`

**Interfaces:**
- Consumes: `testRunMatchingFlow`, `listInitiatives` (filtered to `initiative_type === 'move'`, sorted with `naturalCompare` by name), `litPath`, `nodeTitle`, `ComboBox`.
- Produces: `TestBar({place, flow, onRun(run: MatchingRun | null)})`.
  - Controls: input `Value to test`, `.segmented` `Test against`: `Test set` | `A move`. When it's `A move`, a ComboBox `Move` appears. `Run` is disabled while the value is blank, or while `A move` has no move picked.
  - Result line: found gives `Found by {field label}: {name} (asset tag {tag}) · {action label}`. Not found gives `Not found · {message}`. Stopped gives `Stopped at {nodeTitle}: {reason}`, with reasons `no_scan_input` "the flow needs exactly one Scan input", `unwired` "the output it took isn't wired", `two_wires` "an output is wired to two steps", `loop` "the flow loops back to a step it already ran", `bad_settings` "this step's settings aren't filled in", `found_without_match` "Found was reached without a Match".
  - Trace list (`.mr-scroll`): one line per step, `{i}. {nodeTitle}  "{value_in}" → "{value_out}"  {output}`. For a Match, add `{n} hits: {tags joined ", "}`, plus `· took {first tag}` when there are two or more.
  - Error copy: `initiative_not_found` gives `That move no longer exists.`, `bad_initiative` gives `Pick a move, not a project or event.`, `value_required` gives `Enter a value to test.`, anything else gives `The test run failed. Try again.`
  - Editing the flow clears the result and the highlight (`onRun(null)`), so a stale path is never lit on a changed flow.

- [ ] **Step 1: Write the failing tests** in `TestBar.test.tsx` (mock `../../lib/api`):
  - `runs against the test set`: type `102`, Run, and `testRunMatchingFlow` gets `{place: 'scanning', flow, value: '102', against: 'test_set'}`. The result reads `Found by RFID: Test asset 3 (asset tag 103) · Record the scan`, and `onRun` receives the run.
  - `against a move needs a move`: choose `A move`; Run is disabled; pick `Move A`, Run, and the call carries `initiative_id`.
  - `shows the trace with hits and the first taken`: a Match step with hits 106 and 107 renders `2 hits: 106, 107 · took 106`.
  - `a stopped run names the step and the reason`.
  - `error codes map to copy`: `initiative_not_found`.

  In `MatchingRuleEditor.test.tsx`: `a run lights its path and an edit clears it`. The FlowCanvas stub renders the `lit` node ids; after a run they're `n1,n2,n3,n5`, and after an edit they're empty.
- [ ] **Step 2: Run** `npx vitest run src/components/matching/TestBar.test.tsx src/pages/MatchingRuleEditor.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** `TestBar` and the page wiring.
- [ ] **Step 4: Run** the Step 2 command and `npx tsc -b`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(portal): matching rules test bar with path highlighting`.
- [ ] **Step 6: Full suites, all in the foreground.**
  1. Portal: from `portal/`, run `npx vitest run` (all pass; note the count), `npx tsc -b` (clean) and `npm run build` (clean).
  2. API: from `api/`, run `SS_TEST_DB=serversherpa_test_matching_rules PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider` in the foreground (the conftest reseed touches every test), then `.venv/bin/ruff check src tests migrations`. Expected: 0 failed and lint clean. If a test outside `test_matching_*` fails, rerun that file on its own. If it still fails, check out the same file on `main` in a scratch worktree and run it there, to tell a pre-existing failure from a new one. Fix new ones, and report pre-existing ones.
  3. `git status --short` is clean (no `.env`, `api/.venv`, `node_modules`, or `_dev_reload.py`). `git -C /Users/jrh1812/Developer/BaseCampV3 status --short` shows no tracked change in the main checkout.
  4. Commit any fixes as `fix: …`. The dev-DB upgrade to 0126, a live browser check of `/dev/matching-rules` in light and dark at phone width, and the parity sheet, Harbor Master and Features wiki updates happen at merge time from the main checkout, not in this plan.
