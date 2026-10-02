# Generated Serials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A From-To import row with no serial gets `gnrtd-xxxxxx` (6 lowercase hex), unique within the file and across all assets; the checkbox defaults to on.

**Architecture:** `parse_row` only flags rows that need a serial; a new async `assign_generated_serials` runs at the top of the shared `run_import` (before `_lookups`) and draws unique serials with one batched DB check per round. Portal defaults the existing checkbox to on.

**Tech Stack:** FastAPI/SQLAlchemy async + pytest (api/), React + Vitest (portal/).

Spec: `docs/superpowers/specs/2026-10-02-generated-serials-design.md`.

## Global Constraints

- Worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/generated-serials`, branch `generated-serials`. Never commit on main.
- Format exactly: `gnrtd-` + 6 lowercase hex (`secrets.token_hex(3)`); regex `^gnrtd-[0-9a-f]{6}$`.
- Uniqueness: against every other serial in the file (lowercased) and every `assets.serial_number` (CITEXT, archived included). Collisions redraw.
- A blank serial with generation on never errors (asset name not required); with generation off it is the existing error `Missing required field: Serial Number`.
- Blank asset name falls back to the generated serial.
- Checkbox stays; defaults to on on the From-To import page and the Create-a-move assets step. Description copy exactly: `Rows with a blank serial number get one generated (gnrtd-xxxxxx), unique across every asset.`
- API tests from `api/`: `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_generated_serials .venv/bin/pytest -q <files>` (foreground). Portal from `portal/`: `npx vitest run <files>`, `npx tsc -b`.
- Never `git stash`; never commit `api/src/serversherpa/_dev_reload.py`. Commit trailer exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. American English.

---

### Task 1: Server — flag in parse, assign unique `gnrtd-` serials in the pipeline

**Files:**
- Modify: `api/src/serversherpa/imports/move_assets.py` (imports; `generate_serial` ~line 61; `parse_row` ~line 74; new `assign_generated_serials`; `run_import` ~line 232)
- Modify: `api/tests/test_move_asset_import_rows.py` (replace the V2-format tests ~lines 32–51)
- Create: `api/tests/test_generated_serials.py`
- Check/adjust any other test asserting the old `name.13digits` format or the "Asset Name is also blank" error: `grep -rn "Asset Name is also blank\|\\\\d{13}\|generate_serial" api/tests`

**Interfaces:**
- Produces: `GENERATED_SERIAL_PREFIX = "gnrtd-"`; `new_generated_serial() -> str`; `async def assign_generated_serials(db: AsyncSession, rows: list[dict], *, draw: Callable[[], str] = new_generated_serial) -> None`.

- [ ] **Step 1: Failing row tests** — in `api/tests/test_move_asset_import_rows.py` change the import line to import `new_generated_serial` instead of `generate_serial`, and replace `test_generate_serial_format`, `test_missing_serial_is_an_error`, `test_serial_generation_path` with:

```python
def test_new_generated_serial_format():
    for _ in range(50):
        assert re.fullmatch(r"gnrtd-[0-9a-f]{6}", new_generated_serial())


def test_missing_serial_is_an_error_when_generation_is_off():
    out = parse_row(2, _canonical(), {}, generate_serials=False)
    assert out["status"] == "error"
    assert out["message"] == "Missing required field: Serial Number"


def test_missing_serial_is_flagged_for_generation_even_without_a_name():
    out = parse_row(2, _canonical(), {}, generate_serials=True)
    assert out["status"] == "ok"
    assert out["serial_generated"] is True
    assert out["serial_number"] == ""
    assert out["asset_name"] == ""


def test_generation_keeps_the_name():
    out = parse_row(2, _canonical(asset_name="Web-01"), {}, generate_serials=True)
    assert out["status"] == "ok" and out["serial_generated"] is True
    assert out["asset_name"] == "web-01"
```

- [ ] **Step 2: Failing DB tests** — create `api/tests/test_generated_serials.py`. Read `api/tests/test_move_asset_import_commit.py` first and reuse its fixtures/helpers for building rows, an initiative and calling `run_import` (use its real helper names). Tests:

```python
"""Generated serials: gnrtd- + 6 hex, unique in the file and across assets."""
import re
from sqlalchemy import select
from serversherpa.db.models import Asset
from serversherpa.imports.move_assets import assign_generated_serials, parse_row

GEN = re.compile(r"gnrtd-[0-9a-f]{6}")

def _rows(*specs):
    """specs: (serial, name) pairs → parsed rows with generation on.
    Build canonical dicts the same way test_move_asset_import_rows._canonical does
    (import or copy that helper)."""
    ...

async def test_assigns_unique_serials_and_name_fallback(db):
    rows = _rows(("", "web-01"), ("", ""), ("SN-1", "db-01"))
    await assign_generated_serials(db, rows)
    a, b, c = rows
    assert GEN.fullmatch(a["serial_number"]) and GEN.fullmatch(b["serial_number"])
    assert a["serial_number"] != b["serial_number"]
    assert a["asset_name"] == "web-01"
    assert b["asset_name"] == b["serial_number"]
    assert c["serial_number"] == "sn-1" and c["serial_generated"] is False

async def test_redraws_when_the_candidate_is_an_existing_asset(db):
    db.add(Asset(serial_number="gnrtd-aaaaaa", name="old"))   # adjust required Asset fields per the model
    await db.commit()
    draws = iter(["gnrtd-aaaaaa", "gnrtd-bbbbbb"])
    rows = _rows(("", "web-01"))
    await assign_generated_serials(db, rows, draw=lambda: next(draws))
    assert rows[0]["serial_number"] == "gnrtd-bbbbbb"

async def test_redraws_when_the_candidate_is_another_rows_serial_or_a_sibling_draw(db):
    draws = iter(["gnrtd-cccccc", "gnrtd-cccccc", "gnrtd-dddddd", "gnrtd-eeeeee"])
    rows = _rows(("GNRTD-CCCCCC", "given"), ("", "x"), ("", "y"))
    await assign_generated_serials(db, rows, draw=lambda: next(draws))
    got = {r["serial_number"] for r in rows[1:]}
    assert "gnrtd-cccccc" not in got and len(got) == 2

async def test_run_import_writes_generated_serials(db, ...):
    # use the commit test's helpers to run run_import(write=True) on rows with blank
    # serials (generation on); assert the created Asset rows have serials matching GEN
    # and the details mark serial_generated True. Also run write=False once and assert
    # it succeeds with gnrtd- serials in its details.
    ...
```

Every `...` must become real code using the existing helpers; no placeholders remain. Adjust the `Asset(...)` constructor to the model's required fields.

- [ ] **Step 3: Run to verify failure**

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_generated_serials .venv/bin/pytest -q tests/test_move_asset_import_rows.py tests/test_generated_serials.py`
Expected: FAIL (import errors / old behavior).

- [ ] **Step 4: Implement** in `move_assets.py`:

```python
import secrets
from collections.abc import Callable

GENERATED_SERIAL_PREFIX = "gnrtd-"


def new_generated_serial() -> str:
    """gnrtd- + 6 random lowercase hex characters (16.7 million values)."""
    return GENERATED_SERIAL_PREFIX + secrets.token_hex(3)
```

Delete `generate_serial`. In `parse_row` replace the blank-serial block with:

```python
    if not serial:
        if not generate_serials:
            return {"row": n, "serial_number": "", "status": "error",
                    "message": "Missing required field: Serial Number"}
        serial_generated = True     # assigned by assign_generated_serials
```

and make the returned `asset_name` `(name_raw or serial).lower()` keep working (serial is "" here, so a blank name yields ""). Keep `serial = serial.lower()`.

Add:

```python
async def assign_generated_serials(
    db: AsyncSession, rows: list[dict], *,
    draw: Callable[[], str] = new_generated_serial,
) -> None:
    """Give every ok row flagged serial_generated (and still blank) a serial
    unique among the file's serials and every assets.serial_number
    (archived included). One batched lookup per round; collisions redraw."""
    pending = [r for r in rows
               if r["status"] == "ok" and r.get("serial_generated") and not r["serial_number"]]
    if not pending:
        return
    taken = {r["serial_number"].lower() for r in rows
             if r["status"] == "ok" and r["serial_number"]}
    while pending:
        candidates: dict[str, dict] = {}
        for r in pending:
            s = draw().lower()
            while s in taken or s in candidates:
                s = draw().lower()
            candidates[s] = r
        existing = {(v or "").lower() for v in await db.scalars(
            select(Asset.serial_number).where(Asset.serial_number.in_(list(candidates))))}
        pending = []
        for s, r in candidates.items():
            if s in existing:
                taken.add(s)
                pending.append(r)
                continue
            taken.add(s)
            r["serial_number"] = s
            if not r["asset_name"]:
                r["asset_name"] = s
```

In `run_import`, as the first statement after the docstring/imports (before `ok_rows = …`):

```python
    await assign_generated_serials(db, rows)
```

- [ ] **Step 5: Run tests** — the two files above, then the other import tests:

Run: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_generated_serials .venv/bin/pytest -q tests/test_move_asset_import_rows.py tests/test_generated_serials.py tests/test_move_asset_import_commit.py tests/test_move_asset_import_api.py tests/test_move_asset_import_validate.py tests/test_move_setup_api.py tests/test_import_reprocess_api.py tests/test_import_reprocess_pipeline.py`
Expected: all PASS (update any test that asserted the removed V2 format or the "Asset Name is also blank" error to the new behavior, and say which in the report).

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/imports/move_assets.py api/tests
git commit -m "feat(imports): blank serials get unique gnrtd-xxxxxx serials (file + every asset)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Portal — checkbox on by default, new copy

**Files:**
- Modify: `portal/src/pages/ImportMoveAssets.tsx` (~line 87), `portal/src/components/moveSetup/AssetsStep.tsx` (~line 36), `portal/src/components/imports/ImportUploadFields.tsx` (~line 148)
- Test: `portal/src/pages/ImportMoveAssets.test.tsx`, `portal/src/components/moveSetup/AssetsStep.test.tsx`

- [ ] **Step 1: Failing tests** — in each test file add a test that renders the screen (reuse the file's render helper) and asserts the "Generate serial numbers" checkbox is checked by default, the description reads exactly `Rows with a blank serial number get one generated (gnrtd-xxxxxx), unique across every asset.`, and that uploading/checking sends `generateSerials: true` (assert on the mocked API call the file already spies on). Update any existing assertion that expected `generate_serials: false` / `generateSerials: false` by default.

- [ ] **Step 2: Run to verify failure**: `cd portal && npx vitest run src/pages/ImportMoveAssets.test.tsx src/components/moveSetup/AssetsStep.test.tsx` — FAIL.

- [ ] **Step 3: Implement** — `useState(false)` → `useState(true)` for `generateSerials` in both files; in `ImportUploadFields.tsx` replace the description text with the exact copy above.

- [ ] **Step 4: Run tests**: the two files, `src/components/imports`, `src/styles`, then `npx tsc -b` and the full `npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add portal/src
git commit -m "feat(portal): Generate serial numbers is on by default (gnrtd-xxxxxx)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
