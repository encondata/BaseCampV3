# Bulk Workers Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/bulk/workers` tool that adds or updates workers from a csv/xlsx upload, matching existing people by email, phone, or name, with per-row update-or-skip, a template, an export, and a post-apply review summary. Built on a shared bulk-import core extracted from the sites importer.

**Architecture:** Extract the content-agnostic parse/template half of `sites/bulk_import.py` into `imports/bulk.py` and make sites and containers call it. Add `people/bulk_import.py` (columns, matching, preview, commit, export) and four routes in the workers router, gated like sites. Portal: generalize `BulkApplySummary`, add the workers api client, column guide, upload component, page, launcher card, and Workers toolbar button.

**Tech Stack:** FastAPI + SQLAlchemy async + openpyxl (API); React + TypeScript + vitest + Testing Library (portal). Real Postgres test DB via `SS_TEST_DB`.

Spec: `docs/superpowers/specs/2026-09-22-bulk-workers-import-design.md`.

## Global Constraints

- Work in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers` (branch `bulk-workers-import`). Never `cd` to the main checkout.
- API commands run from `<worktree>/api` with `PYTHONPATH=<worktree>/api/src` and `SS_TEST_DB=serversherpa_test_bulk_workers` set. The venv is a symlink to the main checkout's editable install, so an unset `PYTHONPATH` silently tests the wrong code. Example: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_x.py -q`.
- Portal commands run from `<worktree>/portal`: `npx vitest run <file>`, `npx tsc --noEmit`, `npm run build`. Do not run `npm install` in the worktree (it replaces the `node_modules` symlink).
- Run every test command in the FOREGROUND in one continuous run with an explicit long timeout (600000 ms). Never background a suite and end a turn waiting on it.
- `git checkout -- api/src/serversherpa/_dev_reload.py` before every commit if it shows as modified; never commit it.
- American English in all copy, comments, and docs (color, customize).
- No new `.bulk-*` typography rules (font-size, font-family, letter-spacing, font-weight, text-transform) without a `portal/src/styles/listTypography.allow.json` entry; the moved styles carry none.
- Sites bulk behavior stays byte-identical: `api/tests/test_sites_bulk_import_service.py`, `api/tests/test_sites_bulk_import_api.py`, `api/tests/test_containers_bulk_import.py`, and every portal sites bulk test must pass unchanged in assertions (imports may move).
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

API
- Create `api/src/serversherpa/imports/bulk.py` — shared core: `BulkImportError`, `cell`, `guard_cell`, `FORMULA_LEAD`, `check_columns`, `numbered`, `number_json_rows`, `parse_upload`, `build_rows_csv`, `build_rows_xlsx`, `MAX_ROWS`, `MAX_BYTES`.
- Create `api/src/serversherpa/api/bulk_routes.py` — shared route helpers: `require_bulk_rank`, `bulk_http_error`, `rows_from_request`.
- Create `api/src/serversherpa/people/bulk_import.py` — workers importer: `COLUMNS`, `SAMPLE_ROWS`, `PERSON_ATTR`, `PROFILE_COLUMNS`, `normalize_phone`, `name_keys`, `export_rows`, `preview_rows`, `commit_rows`, `build_template_csv`, `build_template_xlsx`, `build_export_csv`, `build_export_xlsx`.
- Modify `api/src/serversherpa/sites/bulk_import.py` — delegate parsing/templates to the core; keep columns, matching, diff, commit, export.
- Modify `api/src/serversherpa/logistics/bulk_import.py` — delegate `check_columns`, `_cell`, `number_json_rows` to the core.
- Modify `api/src/serversherpa/api/routes/sites.py` — use `bulk_routes` helpers.
- Modify `api/src/serversherpa/api/routes/workers.py` — four bulk endpoints above `GET /{person_id}`.
- Create `api/tests/test_bulk_core.py`, `api/tests/test_workers_bulk_import_service.py`, `api/tests/test_workers_bulk_import_api.py`.

Portal
- Create `portal/src/components/bulk/BulkApplySummary.tsx` (moved from `components/sites/`, generalized) + test.
- Create `portal/src/lib/workerBulk.ts` + test — column guide and error map.
- Modify `portal/src/lib/api.ts` — `downloadAttachment` helper; workers bulk types and four functions.
- Create `portal/src/components/workers/WorkerBulkUpload.tsx` + test.
- Create `portal/src/pages/BulkWorkers.tsx` + test.
- Modify `portal/src/pages/BulkActions.tsx` (card), `portal/src/App.tsx` (route), `portal/src/pages/Workers.tsx` (toolbar button), `portal/src/components/sites/SiteBulkUpload.tsx` (new summary import + props), `portal/src/styles/bulk.css` / `sites.css` (move the preview styles).

---

### Task 1: Extract the shared bulk-import core

**Files:**
- Create: `api/src/serversherpa/imports/bulk.py`
- Modify: `api/src/serversherpa/sites/bulk_import.py:1-207`
- Modify: `api/src/serversherpa/logistics/bulk_import.py:1-68`
- Test: `api/tests/test_bulk_core.py`
- Existing suites: `api/tests/test_sites_bulk_import_service.py`, `api/tests/test_sites_bulk_import_api.py`, `api/tests/test_containers_bulk_import.py`, `api/tests/test_containers_api.py`

**Interfaces:**
- Produces (`serversherpa.imports.bulk`):
  - `class BulkImportError(Exception)` with `.code: str`, `.extra: dict`
  - `FORMULA_LEAD = ("=", "+", "-", "@")`, `MAX_ROWS = 1000`, `MAX_BYTES = 5 * 1024 * 1024`
  - `cell(value: Any) -> str`
  - `guard_cell(text: str) -> str`
  - `check_columns(keys: list[str], columns: list[str]) -> None`
  - `numbered(rows: list[dict], first_row: int, columns: list[str]) -> list[tuple[int, dict]]`
  - `number_json_rows(rows: Any, columns: list[str]) -> list[tuple[int, dict]]`
  - `parse_upload(filename: str, content: bytes, columns: list[str], sheet: str) -> list[tuple[int, dict]]`
  - `build_rows_csv(rows: list[dict], columns: list[str]) -> str`
  - `build_rows_xlsx(rows: list[dict], columns: list[str], sheet: str, reference: list[tuple[str, list[str]]]) -> bytes`
- Sites keeps its public names unchanged: `bi.COLUMNS`, `bi.SAMPLE_ROWS`, `bi.BulkImportError`, `bi.MAX_ROWS`, `bi.MAX_BYTES`, `bi.number_json_rows(rows)`, `bi.parse_upload(filename, content)`, `bi.build_template_csv()`, `bi.build_template_xlsx(type_keys, status_keys)`, `bi.build_rows_csv(rows)`, `bi.build_rows_xlsx(rows, type_keys, status_keys)`.

- [ ] **Step 1: Write the failing core test**

Create `api/tests/test_bulk_core.py`:

```python
"""The shared bulk-import core (imports/bulk.py): parsing, numbering,
templates. Content-agnostic — every importer passes its own column list."""
import io

import openpyxl
import pytest

from serversherpa.imports import bulk

COLS = ["name", "city", "notes"]


def test_cell_normalizes_scalars_and_strips_one_guard_quote():
    assert bulk.cell(None) == ""
    assert bulk.cell(89501.0) == "89501"
    assert bulk.cell(1.5) == "1.5"
    assert bulk.cell("  x  ") == "x"
    assert bulk.cell("'=SUM(A1)") == "=SUM(A1)"
    assert bulk.cell("''=x") == "''=x"         # only a quote right before a formula lead comes off


def test_guard_cell_prefixes_formula_leads_but_not_numbers():
    assert bulk.guard_cell("=HYPERLINK(x)") == "'=HYPERLINK(x)"
    assert bulk.guard_cell("-119.8") == "-119.8"
    assert bulk.guard_cell("+1") == "+1"
    assert bulk.guard_cell("plain") == "plain"


def test_check_columns_reports_unknowns_sorted():
    bulk.check_columns(["name", "city"], COLS)
    with pytest.raises(bulk.BulkImportError) as exc:
        bulk.check_columns(["zip", "name", "aaa"], COLS)
    assert exc.value.code == "unknown_columns"
    assert exc.value.extra["columns"] == ["aaa", "zip"]


def test_number_json_rows_numbers_from_one_and_drops_blank_lines():
    rows = bulk.number_json_rows(
        [{"name": "A"}, {"name": "", "city": ""}, {"city": "Reno"}], COLS)
    assert rows == [(1, {"name": "A", "city": "", "notes": ""}),
                    (3, {"name": "", "city": "Reno", "notes": ""})]
    assert bulk.number_json_rows({"name": "One"}, COLS)[0][0] == 1
    with pytest.raises(bulk.BulkImportError) as exc:
        bulk.number_json_rows("nope", COLS)  # type: ignore[arg-type]
    assert exc.value.code == "invalid_json"
    with pytest.raises(bulk.BulkImportError) as exc:
        bulk.number_json_rows([{"name": str(i)} for i in range(bulk.MAX_ROWS + 1)], COLS)
    assert exc.value.code == "too_many_rows"


def test_parse_upload_csv_numbers_from_two_and_handles_bom():
    rows = bulk.parse_upload("t.csv", "﻿name,city\nA,Reno\n".encode(), COLS, "Sheet")
    assert rows == [(2, {"name": "A", "city": "Reno", "notes": ""})]


def test_parse_upload_xlsx_prefers_named_sheet_and_skips_blank_headers():
    wb = openpyxl.Workbook()
    other = wb.active
    other.title = "Other"
    other.append(["name"])
    other.append(["Wrong"])
    ws = wb.create_sheet("People")
    ws.append(["name", "", "city"])
    ws.append(["Right", "spacer", "Reno"])
    buf = io.BytesIO()
    wb.save(buf)
    rows = bulk.parse_upload("t.xlsx", buf.getvalue(), COLS, "People")
    assert rows == [(2, {"name": "Right", "city": "Reno", "notes": ""})]


def test_parse_upload_error_codes():
    with pytest.raises(bulk.BulkImportError) as exc:
        bulk.parse_upload("x.txt", b"hi", COLS, "S")
    assert exc.value.code == "unsupported_file"
    with pytest.raises(bulk.BulkImportError) as exc:
        bulk.parse_upload("x.json", b"{bad", COLS, "S")
    assert exc.value.code == "invalid_json"
    with pytest.raises(bulk.BulkImportError) as exc:
        bulk.parse_upload("x.xlsx", b"not a workbook", COLS, "S")
    assert exc.value.code == "invalid_xlsx"
    with pytest.raises(bulk.BulkImportError) as exc:
        bulk.parse_upload("big.csv", b"x" * (bulk.MAX_BYTES + 1), COLS, "S")
    assert exc.value.code == "file_too_large"


def test_csv_and_xlsx_builders_guard_formulas_and_round_trip():
    rows = [{"name": "=EVIL()", "city": "Reno", "notes": "-5"}]
    csv_text = bulk.build_rows_csv(rows, COLS)
    assert csv_text.splitlines() == ["name,city,notes", "'=EVIL(),Reno,-5"]
    assert bulk.parse_upload("t.csv", csv_text.encode(), COLS, "S")[0][1]["name"] == "=EVIL()"

    blob = bulk.build_rows_xlsx(rows, COLS, "People",
                                [("Valid levels", ["L1", "L2"]), ("Valid statuses", ["active"])])
    wb = openpyxl.load_workbook(io.BytesIO(blob))
    assert wb.sheetnames == ["People", "Reference"]
    assert wb["People"]["A2"].data_type == "s"           # pinned to text
    ref = [row[0].value for row in wb["Reference"].iter_rows()]
    assert ref == ["Valid levels", "L1", "L2", None, "Valid statuses", "active"]
    assert bulk.parse_upload("t.xlsx", blob, COLS, "People")[0][1]["name"] == "=EVIL()"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_bulk_core.py -q`
Expected: collection error `ModuleNotFoundError: No module named 'serversherpa.imports.bulk'`.

- [ ] **Step 3: Create the core module**

Create `api/src/serversherpa/imports/bulk.py`:

```python
"""Shared bulk-import core: parse (csv/xlsx/json) → numbered rows, plus the
csv/xlsx builders used for templates and exports. Content-agnostic — each
importer (sites, containers, workers) passes its own column list and sheet
name, and keeps its own matching/diff/commit logic.

Row numbering: a file's header is line 1 so data starts at 2; a JSON
payload has no header so rows are numbered from 1.
"""

import csv
import io
import json
import re
from typing import Any

MAX_ROWS = 1000
MAX_BYTES = 5 * 1024 * 1024

FORMULA_LEAD = ("=", "+", "-", "@")
_NUMERIC = re.compile(r"^[+-]?\d+(\.\d+)?$")


class BulkImportError(Exception):
    """Whole-payload failure (not a per-row error)."""

    def __init__(self, code: str, **extra: Any) -> None:
        super().__init__(code)
        self.code = code
        self.extra = extra


def cell(value: Any) -> str:
    """Spreadsheet cells arrive as str/float/int/bool/None — normalize to
    trimmed text. Integral floats (openpyxl's 89501.0) drop the .0 so
    numeric-looking text columns round-trip. One leading apostrophe in front
    of a formula lead character is dropped, so our own guarded CSV export
    (see `guard_cell`) re-uploads as the value it started as."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value).strip()
    if text[:1] == "'" and text[1:2] in FORMULA_LEAD:
        text = text[1:]
    return text


def guard_cell(text: str) -> str:
    """OWASP CSV-injection guard, mirroring the portal's `csvCell`: a cell
    that opens with = + - @ gets a leading apostrophe so Excel/Sheets read it
    as text — unless the whole cell is a number, so -119.8138 stays a
    coordinate."""
    if text[:1] in FORMULA_LEAD and not _NUMERIC.match(text):
        return f"'{text}"
    return text


def check_columns(keys: list[str], columns: list[str]) -> None:
    unknown = sorted({k for k in keys if k not in columns})
    if unknown:
        raise BulkImportError("unknown_columns", columns=unknown)


def numbered(rows: list[dict], first_row: int,
             columns: list[str]) -> list[tuple[int, dict]]:
    if len(rows) > MAX_ROWS:
        raise BulkImportError("too_many_rows", limit=MAX_ROWS)
    out: list[tuple[int, dict]] = []
    for i, raw in enumerate(rows):
        check_columns(list(raw.keys()), columns)
        row = {col: cell(raw.get(col)) for col in columns}
        if any(v != "" for v in row.values()):        # skip fully blank lines
            out.append((first_row + i, row))
    return out


def number_json_rows(rows: Any, columns: list[str]) -> list[tuple[int, dict]]:
    if isinstance(rows, dict):
        rows = [rows]          # a single bare object is a one-row import
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise BulkImportError("invalid_json")
    return numbered(rows, 1, columns)


def parse_upload(filename: str, content: bytes, columns: list[str],
                 sheet: str) -> list[tuple[int, dict]]:
    if len(content) > MAX_BYTES:
        raise BulkImportError("file_too_large", limit=MAX_BYTES)
    name = filename.lower()
    if name.endswith(".json"):
        try:
            return number_json_rows(json.loads(content.decode("utf-8-sig")), columns)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise BulkImportError("invalid_json") from None
    if name.endswith(".csv"):
        try:
            reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
        except UnicodeDecodeError:
            raise BulkImportError("invalid_csv") from None
        if reader.fieldnames is None:
            raise BulkImportError("invalid_csv")
        check_columns([f.strip() for f in reader.fieldnames if f], columns)
        rows = [{(k or "").strip(): v for k, v in r.items() if k}
                for r in reader]
        return numbered(rows, 2, columns)
    if name.endswith(".xlsx"):
        import openpyxl
        try:
            wb = openpyxl.load_workbook(io.BytesIO(content),
                                        read_only=True, data_only=True)
        except Exception:
            raise BulkImportError("invalid_xlsx") from None
        ws = wb[sheet] if sheet in wb.sheetnames else wb.worksheets[0]
        lines = ws.iter_rows(values_only=True)
        header = [cell(h) for h in (next(lines, None) or tuple())]
        if not any(header):
            raise BulkImportError("invalid_xlsx")
        check_columns([h for h in header if h], columns)
        rows = [{h: v for h, v in zip(header, line) if h} for line in lines]
        return numbered(rows, 2, columns)
    raise BulkImportError("unsupported_file")


def build_rows_csv(rows: list[dict], columns: list[str]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows({c: guard_cell(str(row[c])) for c in columns}
                     for row in rows)
    return buf.getvalue()


def build_rows_xlsx(rows: list[dict], columns: list[str], sheet: str,
                    reference: list[tuple[str, list[str]]]) -> bytes:
    """`sheet` + a Reference sheet: each (title, keys) block is a title row,
    one key per row, and a blank row between blocks."""
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append(columns)
    for row in rows:
        ws.append([row[c] for c in columns])
        # a cell openpyxl would otherwise store as a formula is pinned to
        # text, so a name like "=HYPERLINK(…)" can never execute on open
        for c in ws[ws.max_row]:
            if isinstance(c.value, str) and c.value[:1] in FORMULA_LEAD:
                c.data_type = "s"
    ref = wb.create_sheet("Reference")
    for i, (title, keys) in enumerate(reference):
        if i:
            ref.append([])
        ref.append([title])
        for key in keys:
            ref.append([key])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
```

Check `api/src/serversherpa/imports/__init__.py` exists (the package already holds `parsing.py`, `worker.py`, `jobs.py`); if not, create it empty.

- [ ] **Step 4: Run the core test to verify it passes**

Run: same command as Step 2.
Expected: `8 passed`.

- [ ] **Step 5: Make the sites module delegate to the core**

In `api/src/serversherpa/sites/bulk_import.py`, replace everything from the `import csv` line through the end of `build_template_xlsx` (lines 15–207 in the current file: imports, `COLUMNS`, `SITE_ATTR`, `MAX_ROWS`, `MAX_BYTES`, `SAMPLE_ROWS`, `BulkImportError`, the `# ── parsing` section, and the `# ── templates / export` section up to and including `build_template_xlsx`) with:

```python
import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Client, Partner, Site, SiteClient, SiteType, StatusValue,
)
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import (      # re-exported for the container
    MAX_BYTES, MAX_ROWS, BulkImportError,    # importer and the route tests
)

COLUMNS = [
    "name", "code", "type", "status", "address_line1", "address_line2",
    "city", "region", "postal_code", "country", "latitude", "longitude",
    "timezone", "dc_provider", "partner", "clients", "notes",
]
SHEET = "Sites"
# template column → Site attribute (identity except type; partner/clients are
# relations, handled separately)
SITE_ATTR = {c: ("site_type" if c == "type" else c) for c in COLUMNS
             if c not in ("partner", "clients")}

SAMPLE_ROWS: list[dict] = [
    {"name": "Example DC West", "code": "DCW", "type": "datacenter",
     "status": "active", "address_line1": "100 Server Way", "address_line2": "",
     "city": "Reno", "region": "NV", "postal_code": "89501", "country": "US",
     "latitude": "39.5296", "longitude": "-119.8138",
     "timezone": "America/Los_Angeles", "dc_provider": "Switch",
     "partner": "", "clients": "Acme Co; Globex", "notes": "Sample row — replace me"},
    {"name": "Example Office", "code": "", "type": "office", "status": "planned",
     "address_line1": "", "address_line2": "", "city": "Zurich", "region": "",
     "postal_code": "", "country": "CH", "latitude": "", "longitude": "",
     "timezone": "Europe/Zurich", "dc_provider": "", "partner": "",
     "clients": "", "notes": ""},
]

__all__ = ["BulkImportError", "MAX_BYTES", "MAX_ROWS"]


# ── parsing / templates (thin wrappers over the shared core) ────────

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET)


def build_rows_csv(rows: list[dict]) -> str:
    return core.build_rows_csv(rows, COLUMNS)


def build_rows_xlsx(rows: list[dict], type_keys: list[str],
                    status_keys: list[str]) -> bytes:
    return core.build_rows_xlsx(rows, COLUMNS, SHEET, [
        ("Valid type keys", type_keys), ("Valid status keys", status_keys)])


def build_template_csv() -> str:
    return build_rows_csv(SAMPLE_ROWS)


def build_template_xlsx(type_keys: list[str], status_keys: list[str]) -> bytes:
    return build_rows_xlsx(SAMPLE_ROWS, type_keys, status_keys)
```

Keep everything from `_coord_text` onward unchanged. Then `grep -n "_cell\|_guard_cell\|_check_columns\|_numbered\|FORMULA_LEAD\|csv\.\|io\.\|json\." api/src/serversherpa/sites/bulk_import.py` — the remaining code must not reference any of them (the `csv`, `io`, `json` imports were only used by the moved code; `re` stays for `_NON_ALNUM`).

- [ ] **Step 6: Make the container module delegate to the core**

In `api/src/serversherpa/logistics/bulk_import.py`, replace the module docstring's second paragraph (the "Only `BulkImportError` is imported…" paragraph) with:

```
Parsing/numbering comes from the shared core (imports/bulk.py); only the
resolution and commit logic is container-specific.
```

Replace the import line `from serversherpa.sites.bulk_import import BulkImportError  # content-agnostic` with:

```python
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import MAX_ROWS, BulkImportError
```

Delete the local `MAX_ROWS = 1000`, `check_columns`, `_cell`, and `number_json_rows` definitions (lines 35–66) and add in their place:

```python
def check_columns(keys: list[str]) -> None:
    core.check_columns(keys, TEMPLATE_COLUMNS)


def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    """A bare JSON payload has no header line, so rows are numbered from 1
    (unlike CSV parsing, which would start data at row 2)."""
    return core.number_json_rows(rows, TEMPLATE_COLUMNS)
```

Keep `from typing import Any`. The two `check_columns(list(numbered[0][1].keys()))` calls in `preview_rows`/`commit_rows` keep working. Note one behavior difference to verify: the core's `check_columns` sorts unknown columns; the container version did not. `grep -n "unknown_columns" api/tests/test_containers*.py` — if a test asserts unsorted order, sort the expected list in that test.

- [ ] **Step 7: Run the sites, container, and core suites**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_bulk_core.py tests/test_sites_bulk_import_service.py tests/test_sites_bulk_import_api.py tests/test_containers_bulk_import.py tests/test_containers_api.py -q` (timeout 600000).
Expected: all pass, no assertion edits in the sites or container tests (except a possible sorted-order fix noted in Step 6).

- [ ] **Step 8: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers
git checkout -- api/src/serversherpa/_dev_reload.py 2>/dev/null
git add api/src/serversherpa/imports/bulk.py api/src/serversherpa/sites/bulk_import.py api/src/serversherpa/logistics/bulk_import.py api/tests/test_bulk_core.py api/tests/test_containers_bulk_import.py
git commit -m "refactor(imports): shared bulk-import core; sites and containers delegate parsing and templates

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Workers importer — columns, phone/name keys, template, export

**Files:**
- Create: `api/src/serversherpa/people/bulk_import.py`
- Test: `api/tests/test_workers_bulk_import_service.py`

**Interfaces:**
- Consumes: `serversherpa.imports.bulk` (Task 1).
- Produces (`serversherpa.people.bulk_import`):
  - `COLUMNS: list[str]` (20), `SHEET = "Workers"`, `SAMPLE_ROWS`, `PERSON_ATTR: dict[str, str]`, `PROFILE_COLUMNS = ("trade", "level", "status", "status_note")`
  - `normalize_phone(text: str) -> str`
  - `name_keys(first: str, last: str, preferred: str) -> set[str]`
  - `number_json_rows(rows)`, `parse_upload(filename, content)`, `build_rows_csv(rows)`, `build_rows_xlsx(rows, levels, statuses, partners)`, `build_template_csv()`, `build_template_xlsx(levels, statuses, partners)`
  - `async export_rows(db) -> list[dict]`
  - `async reference_lists(db) -> tuple[list[str], list[str], list[str]]` (levels by rank, worker status keys by sort order, partner names)
  - Re-exports `BulkImportError`, `MAX_ROWS`, `MAX_BYTES`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_workers_bulk_import_service.py`:

```python
"""Workers bulk import pipeline (no HTTP): keys, template, export, preview,
commit. Actor for preview/commit is an admin (rank 60) unless a test says
otherwise."""
import io
import uuid

import openpyxl
import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, Partner, Person, PersonRole, UserAccount, WorkerProfile,
)
from serversherpa.people import bulk_import as bi

ADMIN_RANK = 60


@pytest.fixture
async def admin(db):
    person = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return person


async def preview(db, admin, rows):
    return await bi.preview_rows(db, bi.number_json_rows(rows),
                                 actor_id=admin.id, actor_rank=ADMIN_RANK)


async def commit(db, admin, rows, approved=(), source="test.csv"):
    return await bi.commit_rows(db, bi.number_json_rows(rows), actor_id=admin.id,
                                actor_rank=ADMIN_RANK,
                                approved_updates=set(approved), source_label=source)


async def mk_worker(db, first="Robert", last="Smith", *, preferred=None,
                    email=None, phone=None, rfid=None, role=True, profile=None,
                    archived=False, account=False):
    from datetime import UTC, datetime
    person = Person(first_name=first, last_name=last, preferred_name=preferred,
                    email=email, phone=phone, rfid_tag=rfid,
                    archived_at=datetime.now(UTC) if archived else None)
    db.add(person)
    await db.flush()
    if role:
        db.add(PersonRole(person_id=person.id, role="worker"))
    if profile is not None:
        db.add(WorkerProfile(person_id=person.id, **profile))
    if account:
        db.add(UserAccount(person_id=person.id, email=email or f"{first}@test.example.com",
                           password_hash="x"))
    await db.commit()
    return person


# ── shape / keys / template ─────────────────────────────────────────

def test_columns_match_canonical_shape():
    assert bi.COLUMNS == [
        "first_name", "last_name", "preferred_name", "email", "phone",
        "job_title", "employee_number", "rfid_tag", "address_line1",
        "address_line2", "city", "region", "postal_code", "country",
        "partner", "trade", "level", "status", "status_note", "notes"]


def test_normalize_phone():
    assert bi.normalize_phone("(555) 123-4567") == "5551234567"
    assert bi.normalize_phone("1-555-123-4567") == "5551234567"
    assert bi.normalize_phone("+44 20 7946 0958") == "442079460958"   # not a US 1
    assert bi.normalize_phone("12345") == ""                            # too short
    assert bi.normalize_phone("") == ""


def test_name_keys_cover_first_and_preferred():
    assert bi.name_keys("Robert", "Smith", "Bob") == {"robert smith", "bob smith"}
    assert bi.name_keys("  Robert ", "SMITH", "") == {"robert smith"}
    assert bi.name_keys("", "Smith", "Bob") == {"bob smith"}
    assert bi.name_keys("", "", "") == set()


def test_csv_and_json_normalize_identically():
    from_csv = bi.parse_upload("t.csv", bi.build_template_csv().encode())
    from_json = bi.number_json_rows(bi.SAMPLE_ROWS)
    assert [r for _, r in from_csv] == [r for _, r in from_json]
    assert [n for n, _ in from_csv] == [2, 3]


def test_xlsx_template_round_trips_with_reference_blocks():
    blob = bi.build_template_xlsx(["L1", "L2"], ["active", "standby"], ["Haul It"])
    wb = openpyxl.load_workbook(io.BytesIO(blob))
    assert wb.sheetnames == ["Workers", "Reference"]
    ref = [row[0].value for row in wb["Reference"].iter_rows()]
    assert ref == ["Valid levels", "L1", "L2", None,
                   "Valid statuses", "active", "standby", None,
                   "Partner names", "Haul It"]
    rows = bi.parse_upload("t.xlsx", blob)
    assert [r for _, r in rows] == [r for _, r in bi.number_json_rows(bi.SAMPLE_ROWS)]


# ── export ──────────────────────────────────────────────────────────

async def test_export_rows_shape_and_round_trip(db, admin):
    pt = Partner(name="Haul It")
    db.add(pt)
    await db.flush()
    await mk_worker(db, "Zed", "Zulu", email="zed@test.example.com", phone="555-000-1111",
                    profile={"partner_id": pt.id, "trade": "Cable", "level": "L2",
                             "status": "standby"})
    await mk_worker(db, "Amy", "Alpha")                         # no profile
    await mk_worker(db, "Not", "Worker", role=False)            # no worker role
    await mk_worker(db, "Old", "Gone", archived=True)
    rows = await bi.export_rows(db)
    assert [r["last_name"] for r in rows] == ["Alpha", "Zulu"]
    assert set(rows[0]) == set(bi.COLUMNS)
    assert rows[0]["status"] == "active"                # profile-less default
    assert rows[1]["partner"] == "Haul It" and rows[1]["level"] == "L2"
    assert rows[1]["phone"] == "555-000-1111"

    csv_text = bi.build_rows_csv(rows)
    out = await preview(db, admin, [r for _, r in bi.parse_upload("e.csv", csv_text.encode())])
    assert [r["action"] for r in out["rows"]] == ["unchanged", "unchanged"]


async def test_reference_lists(db, admin):
    db.add(Partner(name="Bee Co"))
    db.add(Partner(name="Ant Co"))
    await db.commit()
    levels, statuses, partners = await bi.reference_lists(db)
    assert levels == ["L1", "L2", "L3", "L4", "L5", "L6"]
    assert statuses == ["active", "standby", "blacklist"]
    assert partners == ["Ant Co", "Bee Co"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_workers_bulk_import_service.py -q`
Expected: `ModuleNotFoundError: No module named 'serversherpa.people.bulk_import'`.

- [ ] **Step 3: Create the module with columns, keys, template, export**

Create `api/src/serversherpa/people/bulk_import.py`:

```python
"""Workers bulk import: parse (via imports/bulk) → match → preview/commit.

A worker is three records — a people row, an active `worker` role grant,
and a worker_profiles row — and every create writes all three. Rows match
an existing (non-archived) person by email, phone (digits only) or name
(first + last, or preferred + last); keys that disagree are a row error.

Blank-cell rule: on create rows a blank status/country takes the default
(active/US); on update rows a blank cell means "no change", never a clear.
The original blankness is tracked out-of-band (`blank`) because `data` has
already had defaults applied by diff time. Each preview row also carries
`cells` (the uploaded cells before defaults) — the commit replays those.
"""

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import can_touch_rank
from serversherpa.db.models import (
    AuthSession, Partner, Person, PersonRole, Role, StatusValue, UserAccount,
    WorkerLevel, WorkerProfile,
)
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import MAX_BYTES, MAX_ROWS, BulkImportError
from serversherpa.services.audit import audit

__all__ = ["BulkImportError", "MAX_BYTES", "MAX_ROWS"]

COLUMNS = [
    "first_name", "last_name", "preferred_name", "email", "phone",
    "job_title", "employee_number", "rfid_tag", "address_line1",
    "address_line2", "city", "region", "postal_code", "country",
    "partner", "trade", "level", "status", "status_note", "notes",
]
SHEET = "Workers"
# template column → Person attribute
PERSON_ATTR = {
    "first_name": "first_name", "last_name": "last_name",
    "preferred_name": "preferred_name", "email": "email", "phone": "phone",
    "job_title": "job_title", "employee_number": "external_id",
    "rfid_tag": "rfid_tag", "address_line1": "address_line1",
    "address_line2": "address_line2", "city": "city", "region": "region",
    "postal_code": "postal_code", "country": "country", "notes": "notes",
}
PROFILE_COLUMNS = ("trade", "level", "status", "status_note")

SAMPLE_ROWS: list[dict] = [
    {"first_name": "Robert", "last_name": "Smith", "preferred_name": "Bob",
     "email": "bob.smith@example.com", "phone": "555-123-4567",
     "job_title": "Lead Technician", "employee_number": "E1042",
     "rfid_tag": "", "address_line1": "12 Rack Row", "address_line2": "",
     "city": "Reno", "region": "NV", "postal_code": "89501", "country": "US",
     "partner": "", "trade": "Cable, Rack & Stack", "level": "L4",
     "status": "active", "status_note": "", "notes": "Sample row — replace me"},
    {"first_name": "Maria", "last_name": "Lopez", "preferred_name": "",
     "email": "", "phone": "(555) 987-6543", "job_title": "",
     "employee_number": "", "rfid_tag": "", "address_line1": "",
     "address_line2": "", "city": "", "region": "", "postal_code": "",
     "country": "", "partner": "Example Staffing", "trade": "Cable",
     "level": "L2", "status": "standby", "status_note": "", "notes": ""},
]

_EMAIL = TypeAdapter(EmailStr)
_COUNTRY = re.compile(r"^[A-Za-z]{2}$")


# ── keys ────────────────────────────────────────────────────────────

def normalize_phone(text: str) -> str:
    """Match key for phone: digits only; an 11-digit number starting with 1
    drops the US country code. Fewer than 7 digits is no key at all."""
    digits = re.sub(r"\D", "", text or "")
    if len(digits) == 11 and digits[0] == "1":
        digits = digits[1:]
    return digits if len(digits) >= 7 else ""


def _squash(text: str) -> str:
    return " ".join((text or "").split()).casefold()


def name_keys(first: str, last: str, preferred: str) -> set[str]:
    """Both spellings a person may go by: first + last and preferred + last."""
    keys: set[str] = set()
    last_k = _squash(last)
    if not last_k:
        return keys
    for given in (first, preferred):
        given_k = _squash(given)
        if given_k:
            keys.add(f"{given_k} {last_k}")
    return keys


# ── parsing / templates (thin wrappers over the shared core) ────────

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET)


def build_rows_csv(rows: list[dict]) -> str:
    return core.build_rows_csv(rows, COLUMNS)


def build_rows_xlsx(rows: list[dict], levels: list[str], statuses: list[str],
                    partners: list[str]) -> bytes:
    return core.build_rows_xlsx(rows, COLUMNS, SHEET, [
        ("Valid levels", levels), ("Valid statuses", statuses),
        ("Partner names", partners)])


def build_template_csv() -> str:
    return build_rows_csv(SAMPLE_ROWS)


def build_template_xlsx(levels: list[str], statuses: list[str],
                        partners: list[str]) -> bytes:
    return build_rows_xlsx(SAMPLE_ROWS, levels, statuses, partners)


async def reference_lists(db: AsyncSession) -> tuple[list[str], list[str], list[str]]:
    """What the xlsx Reference sheet lists: levels by rank, worker status
    keys by sort order, partner names alphabetically."""
    levels = list(await db.scalars(
        select(WorkerLevel.level).order_by(WorkerLevel.rank)))
    statuses = list(await db.scalars(
        select(StatusValue.key).where(StatusValue.record_type == "worker")
        .order_by(StatusValue.sort_order)))
    partners = list(await db.scalars(
        select(Partner.name).where(Partner.archived_at.is_(None))
        .order_by(Partner.name)))
    return levels, statuses, partners


# ── export ──────────────────────────────────────────────────────────

def _worker_query():
    return (
        select(Person, WorkerProfile)
        .join(PersonRole, (PersonRole.person_id == Person.id)
              & (PersonRole.role == "worker")
              & (PersonRole.revoked_at.is_(None)))
        .outerjoin(WorkerProfile, WorkerProfile.person_id == Person.id)
        .where(Person.archived_at.is_(None))
        .order_by(Person.last_name, Person.first_name)
    )


async def export_rows(db: AsyncSession) -> list[dict]:
    """Every live worker in template shape, so an export re-uploads clean."""
    partner_names = dict((await db.execute(select(Partner.id, Partner.name))).all())
    out = []
    for person, profile in (await db.execute(_worker_query())).all():
        row = {col: (getattr(person, attr) or "") for col, attr in PERSON_ATTR.items()}
        row["partner"] = (partner_names.get(profile.partner_id, "")
                          if profile and profile.partner_id else "")
        row["trade"] = (profile.trade if profile else None) or ""
        row["level"] = (profile.level if profile else None) or ""
        row["status"] = (profile.status if profile else None) or "active"
        row["status_note"] = (profile.status_note if profile else None) or ""
        out.append(row)
    return out
```

(`preview_rows` and `commit_rows` are added in Task 3; the export round-trip test and `reference_lists` test above will fail on the missing `preview_rows` until then — that's expected.)

- [ ] **Step 4: Run the tests that don't need preview**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_workers_bulk_import_service.py -q -k "columns or normalize_phone or name_keys or normalize_identically or round_trips_with_reference or reference_lists"`
Expected: `6 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers
git checkout -- api/src/serversherpa/_dev_reload.py 2>/dev/null
git add api/src/serversherpa/people/bulk_import.py api/tests/test_workers_bulk_import_service.py
git commit -m "feat(people): workers bulk import columns, keys, template, export

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Workers importer — matching, validation, preview, diff

**Files:**
- Modify: `api/src/serversherpa/people/bulk_import.py` (append)
- Test: `api/tests/test_workers_bulk_import_service.py` (append)

**Interfaces:**
- Produces: `async preview_rows(db, numbered, *, actor_id: uuid.UUID, actor_rank: int) -> dict` returning `{"rows": [...], "can_commit": bool}`; each row `{row, name, action, matched_by, matched_name, errors, diff, person_id, cells, data}` where `action ∈ create|update|unchanged|error`, `matched_by` is a comma-joined subset of `email, phone, name` or `None`, `diff` is `{col: {"old", "new"}}` including `worker_role: {"old": None, "new": "granted"}` when the grant is missing.

- [ ] **Step 1: Append the failing preview tests**

Append to `api/tests/test_workers_bulk_import_service.py`:

```python
# ── preview: validation ─────────────────────────────────────────────

async def test_required_names_and_field_validation(db, admin):
    out = await preview(db, admin, [
        {"first_name": "", "last_name": "Solo"},
        {"first_name": "No", "last_name": ""},
        {"first_name": "Bad", "last_name": "Email", "email": "not-an-email"},
        {"first_name": "Short", "last_name": "Phone", "phone": "12345"},
        {"first_name": "Long", "last_name": "Country", "country": "USA"},
        {"first_name": "No", "last_name": "Partner", "partner": "Nobody"},
        {"first_name": "No", "last_name": "Level", "level": "L9"},
        {"first_name": "No", "last_name": "Status", "status": "haunted"},
        {"first_name": "No", "last_name": "Note", "status": "blacklist"},
    ])
    errs = {r["row"]: r["errors"] for r in out["rows"]}
    assert errs[1] == ["first_name is required"]
    assert errs[2] == ["last_name is required"]
    assert errs[3] == ["email 'not-an-email' is not valid"]
    assert errs[4] == ["phone needs at least 7 digits"]
    assert errs[5] == ["country must be a two-letter code"]
    assert errs[6] == ["unknown partner 'Nobody'"]
    assert errs[7] == ["unknown level 'L9'"]
    assert errs[8] == ["unknown status 'haunted'"]
    assert errs[9] == ["blacklist requires a status_note"]
    assert out["can_commit"] is False


async def test_create_row_normalizes_and_defaults(db, admin):
    db.add(Partner(name="Haul It"))
    await db.commit()
    out = await preview(db, admin, [{
        "first_name": " Robert ", "last_name": "Smith", "country": "us",
        "partner": "haul it", "level": "L3"}])
    row = out["rows"][0]
    assert row["action"] == "create" and row["matched_by"] is None
    assert row["name"] == "Robert Smith"
    assert row["data"]["first_name"] == "Robert"
    assert row["data"]["country"] == "US" and row["data"]["status"] == "active"
    assert row["data"]["partner"] == "Haul It"       # canonical partner name
    assert row["cells"]["country"] == "us" and row["cells"]["status"] == ""
    assert out["can_commit"] is True


async def test_duplicate_keys_within_the_upload(db, admin):
    out = await preview(db, admin, [
        {"first_name": "A", "last_name": "One", "email": "Dup@Example.com"},
        {"first_name": "B", "last_name": "Two", "email": "dup@example.com"},
        {"first_name": "C", "last_name": "Three", "phone": "555-111-2222"},
        {"first_name": "D", "last_name": "Four", "phone": "(555) 111 2222"},
        {"first_name": "Bob", "last_name": "Smith"},
        {"first_name": "Robert", "last_name": "Smith", "preferred_name": "Bob"},
        {"first_name": "E", "last_name": "Five", "rfid_tag": "TAG1"},
        {"first_name": "F", "last_name": "Six", "rfid_tag": "tag1"},
    ])
    errs = {r["row"]: r["errors"] for r in out["rows"]}
    assert errs[1] == errs[2] == ["duplicate email 'dup@example.com' within the import"]
    assert errs[3] == errs[4] == ["duplicate phone within the import"]
    assert errs[5] == ["duplicate name 'Bob Smith' within the import"]
    assert errs[6] == ["duplicate name 'Bob Smith' within the import"]
    assert errs[7] == errs[8] == ["duplicate rfid_tag 'tag1' within the import"]


# ── preview: matching ───────────────────────────────────────────────

async def test_match_by_each_key_alone(db, admin):
    await mk_worker(db, "Robert", "Smith", preferred="Bob",
                    email="bob@test.example.com", phone="555-123-4567")
    out = await preview(db, admin, [
        {"first_name": "X", "last_name": "Y", "email": "BOB@test.example.com"},
        {"first_name": "X", "last_name": "Y", "phone": "1 (555) 123-4567"},
        {"first_name": "Robert", "last_name": "Smith"},
        {"first_name": "Bob", "last_name": "Smith"},
    ])
    rows = out["rows"]
    assert [r["matched_by"] for r in rows] == ["email", "phone", "name", "name"]
    assert all(r["matched_name"] == "Bob Smith" for r in rows)
    assert rows[0]["action"] == "update"      # first/last differ → diff
    assert rows[2]["action"] == "unchanged"   # exact spelling → nothing to change
    assert rows[3]["diff"]["first_name"] == {"old": "Robert", "new": "Bob"}


async def test_keys_that_agree_are_listed_and_keys_that_disagree_are_errors(db, admin):
    a = await mk_worker(db, "Robert", "Smith", email="a@test.example.com", phone="555-000-0001")
    await mk_worker(db, "Roberta", "Smith", email="b@test.example.com", phone="555-000-0002")
    out = await preview(db, admin, [
        {"first_name": "Robert", "last_name": "Smith", "email": "a@test.example.com",
         "phone": "555-000-0001"},
        {"first_name": "Zed", "last_name": "Zulu", "email": "a@test.example.com",
         "phone": "555-000-0002"},
    ])
    good, bad = out["rows"]
    assert good["action"] == "unchanged" and good["matched_by"] == "email, phone, name"
    assert good["person_id"] == str(a.id)
    assert bad["action"] == "error"
    assert bad["errors"] == ["email matches Robert Smith, phone matches Roberta Smith"]


async def test_ambiguous_name_without_another_key_is_error(db, admin):
    await mk_worker(db, "Chris", "Lee", email="c1@test.example.com")
    await mk_worker(db, "Chris", "Lee", email="c2@test.example.com")
    out = await preview(db, admin, [
        {"first_name": "Chris", "last_name": "Lee"},
        {"first_name": "Chris", "last_name": "Lee", "email": "c2@test.example.com"},
    ])
    assert out["rows"][0]["errors"] == ["two people share the name 'Chris Lee'"]
    # an email that points at one of them does not rescue the row: any key
    # hitting two people is an error, so the file must carry a unique key only
    assert out["rows"][1]["errors"] == ["two people share the name 'Chris Lee'"]


async def test_two_rows_on_one_person_and_archived_never_match(db, admin):
    await mk_worker(db, "Robert", "Smith", email="bob@test.example.com")
    await mk_worker(db, "Old", "Timer", email="old@test.example.com", archived=True)
    out = await preview(db, admin, [
        {"first_name": "Robert", "last_name": "Smith"},
        {"first_name": "Zed", "last_name": "Zulu", "email": "bob@test.example.com"},
        {"first_name": "Old", "last_name": "Timer"},
        {"first_name": "New", "last_name": "Person", "email": "old@test.example.com"},
    ])
    rows = out["rows"]
    assert rows[0]["errors"] == ["two rows match the same existing person 'Robert Smith'"]
    assert rows[1]["errors"] == ["two rows match the same existing person 'Robert Smith'"]
    assert rows[2]["action"] == "create"
    assert rows[3]["errors"] == ["email 'old@test.example.com' belongs to an archived person"]


async def test_rfid_tag_collisions(db, admin):
    holder = await mk_worker(db, "Tag", "Holder", email="tag@test.example.com", rfid="ABC123")
    await mk_worker(db, "Gone", "Tag", rfid="OLD1", archived=True)
    out = await preview(db, admin, [
        {"first_name": "Other", "last_name": "Person", "rfid_tag": "abc123"},
        {"first_name": "Tag", "last_name": "Holder", "email": "tag@test.example.com",
         "rfid_tag": "ABC123"},
        {"first_name": "Third", "last_name": "Person", "rfid_tag": "old1"},
    ])
    rows = out["rows"]
    assert rows[0]["errors"] == ["rfid_tag 'abc123' belongs to Tag Holder"]
    assert rows[1]["action"] == "unchanged" and rows[1]["person_id"] == str(holder.id)
    assert rows[2]["errors"] == ["rfid_tag 'old1' belongs to an archived person"]


async def test_non_worker_user_matches_and_gets_the_role_in_the_diff(db, admin):
    user = await mk_worker(db, "Office", "User", email="ou@test.example.com", role=False)
    out = await preview(db, admin, [
        {"first_name": "Office", "last_name": "User", "trade": "Cable"}])
    row = out["rows"][0]
    assert row["action"] == "update" and row["person_id"] == str(user.id)
    assert row["diff"]["worker_role"] == {"old": None, "new": "granted"}
    assert row["diff"]["trade"] == {"old": None, "new": "Cable"}


async def test_update_diff_blank_means_no_change_and_phone_email_normalize(db, admin):
    pt = Partner(name="Haul It")
    db.add(pt)
    await db.flush()
    await mk_worker(db, "Robert", "Smith", email="Bob@test.example.com", phone="(555) 123-4567",
                    profile={"trade": "Cable", "level": "L2", "status": "standby",
                             "partner_id": pt.id})
    out = await preview(db, admin, [{
        "first_name": "Robert", "last_name": "Smith", "email": "bob@test.example.com",
        "phone": "555.123.4567", "status": "", "country": "", "city": "Reno",
        "level": "L3", "partner": ""}])
    row = out["rows"][0]
    assert row["action"] == "update"
    assert row["diff"] == {"city": {"old": None, "new": "Reno"},
                           "level": {"old": "L2", "new": "L3"}}


async def test_status_change_guards_rank_and_self(db, admin):
    boss = await mk_worker(db, "Big", "Boss", email="boss@test.example.com")
    db.add(PersonRole(person_id=boss.id, role="developer"))     # rank 80 > admin 60
    await db.commit()
    out = await preview(db, admin, [
        {"first_name": "Big", "last_name": "Boss", "status": "standby"},
        {"first_name": "Ada", "last_name": "Admin", "status": "standby"},
        {"first_name": "Big", "last_name": "Boss", "city": "Reno"},
    ])
    rows = out["rows"]
    # rows 1 and 3 both hit Big Boss → the same-person error joins the rank error
    assert "rank too low to change status" in rows[0]["errors"]
    assert rows[1]["errors"] == ["cannot change your own status"]
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_workers_bulk_import_service.py -q`
Expected: the preview tests fail with `AttributeError: module ... has no attribute 'preview_rows'`.

- [ ] **Step 3: Append the reference loader, preview, and diff**

Append to `api/src/serversherpa/people/bulk_import.py`:

```python
# ── validation + preview ────────────────────────────────────────────

async def _reference_data(db: AsyncSession) -> dict:
    levels = set(await db.scalars(select(WorkerLevel.level)))
    statuses = set(await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "worker")))
    partners: dict[str, list[Partner]] = {}
    partner_names: dict[uuid.UUID, str] = {}
    for p in await db.scalars(select(Partner)):
        partners.setdefault(p.name.lower(), []).append(p)
        partner_names[p.id] = p.name

    people = list(await db.scalars(select(Person).where(Person.archived_at.is_(None))))
    by_email: dict[str, list[Person]] = {}
    by_phone: dict[str, list[Person]] = {}
    by_name: dict[str, list[Person]] = {}
    by_rfid: dict[str, Person] = {}
    for p in people:
        if p.email:
            by_email.setdefault(p.email.casefold(), []).append(p)
        phone_key = normalize_phone(p.phone or "")
        if phone_key:
            by_phone.setdefault(phone_key, []).append(p)
        for key in name_keys(p.first_name, p.last_name, p.preferred_name or ""):
            by_name.setdefault(key, []).append(p)
        if p.rfid_tag:
            by_rfid[p.rfid_tag.lower()] = p

    archived = list(await db.scalars(select(Person).where(Person.archived_at.is_not(None))))
    archived_emails = {p.email.casefold() for p in archived if p.email}
    archived_rfids = {p.rfid_tag.lower() for p in archived if p.rfid_tag}

    profiles = {pr.person_id: pr for pr in await db.scalars(select(WorkerProfile))}
    worker_ids = set(await db.scalars(select(PersonRole.person_id).where(
        PersonRole.role == "worker", PersonRole.revoked_at.is_(None))))
    max_rank = dict((await db.execute(
        select(PersonRole.person_id, func.max(Role.rank))
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.revoked_at.is_(None))
        .group_by(PersonRole.person_id))).all())
    return {"levels": levels, "statuses": statuses, "partners": partners,
            "partner_names": partner_names, "by_email": by_email,
            "by_phone": by_phone, "by_name": by_name, "by_rfid": by_rfid,
            "archived_emails": archived_emails, "archived_rfids": archived_rfids,
            "profiles": profiles, "worker_ids": worker_ids, "max_rank": max_rank}


def _row_display_name(row: dict) -> str:
    return f"{row['preferred_name'] or row['first_name']} {row['last_name']}".strip()


def _valid_email(text: str) -> bool:
    try:
        _EMAIL.validate_python(text)
        return True
    except ValidationError:
        return False


async def preview_rows(db: AsyncSession, numbered: list[tuple[int, dict]], *,
                       actor_id: uuid.UUID, actor_rank: int) -> dict:
    ref = await _reference_data(db)

    # in-upload duplicate keys → both rows are errors
    emails_seen: dict[str, list[int]] = {}
    phones_seen: dict[str, list[int]] = {}
    names_seen: dict[str, list[int]] = {}
    rfids_seen: dict[str, list[int]] = {}
    for n, row in numbered:
        if row["email"]:
            emails_seen.setdefault(row["email"].casefold(), []).append(n)
        phone_key = normalize_phone(row["phone"])
        if phone_key:
            phones_seen.setdefault(phone_key, []).append(n)
        for key in name_keys(row["first_name"], row["last_name"], row["preferred_name"]):
            names_seen.setdefault(key, []).append(n)
        if row["rfid_tag"]:
            rfids_seen.setdefault(row["rfid_tag"].lower(), []).append(n)

    pending: list[dict] = []
    for n, row in numbered:
        errors: list[str] = []
        if not row["first_name"]:
            errors.append("first_name is required")
        if not row["last_name"]:
            errors.append("last_name is required")

        email_key = row["email"].casefold()
        if row["email"] and not _valid_email(row["email"]):
            errors.append(f"email '{row['email']}' is not valid")
        elif row["email"] and len(emails_seen[email_key]) > 1:
            errors.append(f"duplicate email '{email_key}' within the import")
        elif email_key in ref["archived_emails"]:
            errors.append(f"email '{row['email']}' belongs to an archived person")

        phone_key = normalize_phone(row["phone"])
        if row["phone"] and not phone_key:
            errors.append("phone needs at least 7 digits")
        elif phone_key and len(phones_seen[phone_key]) > 1:
            errors.append("duplicate phone within the import")

        row_names = name_keys(row["first_name"], row["last_name"], row["preferred_name"])
        dup_name = any(len(names_seen[k]) > 1 for k in row_names)
        if dup_name:
            errors.append(f"duplicate name '{_row_display_name(row)}' within the import")

        rfid_key = row["rfid_tag"].lower()
        if rfid_key and len(rfids_seen[rfid_key]) > 1:
            errors.append(f"duplicate rfid_tag '{rfid_key}' within the import")
        elif rfid_key in ref["archived_rfids"]:
            errors.append(f"rfid_tag '{row['rfid_tag']}' belongs to an archived person")

        if row["country"] and not _COUNTRY.match(row["country"]):
            errors.append("country must be a two-letter code")

        partner_obj: Partner | None = None
        if row["partner"]:
            matches = ref["partners"].get(row["partner"].lower(), [])
            if len(matches) == 0:
                errors.append(f"unknown partner '{row['partner']}'")
            elif len(matches) > 1:
                errors.append(f"ambiguous partner '{row['partner']}'")
            else:
                partner_obj = matches[0]
        if row["level"] and row["level"] not in ref["levels"]:
            errors.append(f"unknown level '{row['level']}'")
        if row["status"] and row["status"] not in ref["statuses"]:
            errors.append(f"unknown status '{row['status']}'")

        blank = {"status": row["status"] == "", "country": row["country"] == ""}
        data = dict(row)
        if blank["status"]:
            data["status"] = "active"
        data["country"] = "US" if blank["country"] else row["country"].upper()
        if partner_obj is not None:
            data["partner"] = partner_obj.name

        # resolve the target — only for rows that are otherwise clean
        target: Person | None = None
        matched_by: str | None = None
        if not errors:
            hits: dict[str, list[Person]] = {}
            if row["email"]:
                hits["email"] = ref["by_email"].get(email_key, [])
            if phone_key:
                hits["phone"] = ref["by_phone"].get(phone_key, [])
            if row_names:
                seen: dict[uuid.UUID, Person] = {}
                for k in row_names:
                    for p in ref["by_name"].get(k, []):
                        seen[p.id] = p
                hits["name"] = list(seen.values())
            shown = {"email": email_key, "phone": row["phone"],
                     "name": _row_display_name(row)}
            for key, people in hits.items():
                if len(people) > 1:
                    errors.append(f"two people share the {key} '{shown[key]}'")
            if not errors:
                distinct = {p.id: p for people in hits.values() for p in people}
                if len(distinct) > 1:
                    errors.append(", ".join(
                        f"{key} matches {people[0].display_name}"
                        for key, people in hits.items() if people))
                elif distinct:
                    target = next(iter(distinct.values()))
                    matched_by = ", ".join(k for k in ("email", "phone", "name")
                                           if hits.get(k))

        if not errors and rfid_key:
            holder = ref["by_rfid"].get(rfid_key)
            if holder is not None and (target is None or holder.id != target.id):
                errors.append(f"rfid_tag '{row['rfid_tag']}' belongs to {holder.display_name}")

        if not errors:
            profile = ref["profiles"].get(target.id) if target is not None else None
            if data["status"] == "blacklist" and not (
                    row["status_note"] or (profile.status_note if profile else None)):
                errors.append("blacklist requires a status_note")
            if target is not None and not blank["status"]:
                old_status = profile.status if profile else "active"
                if data["status"] != old_status:
                    if target.id == actor_id:
                        errors.append("cannot change your own status")
                    elif not can_touch_rank(actor_rank, ref["max_rank"].get(target.id, 0)):
                        errors.append("rank too low to change status")

        pending.append({"row": n, "cells": dict(row), "name": _row_display_name(row),
                        "errors": errors, "data": data, "blank": blank,
                        "target": target, "matched_by": matched_by,
                        "partner_obj": partner_obj})

    # two upload rows resolving to the same person would apply twice, last
    # write winning silently — both rows are errors instead
    same_target: dict[uuid.UUID, list[dict]] = {}
    for p in pending:
        if p["target"] is not None:
            same_target.setdefault(p["target"].id, []).append(p)
    for group in same_target.values():
        if len(group) > 1:
            for p in group:
                p["errors"].append("two rows match the same existing person "
                                   f"'{p['target'].display_name}'")

    results = []
    for p in pending:
        errors, target = p["errors"], p["target"]
        action, diff_out, person_id = "create", None, None
        if errors:
            action = "error"
        elif target is not None:
            person_id = str(target.id)
            changes = _diff_row(
                target, ref["profiles"].get(target.id),
                target.id in ref["worker_ids"], p["data"], p["blank"],
                p["partner_obj"], ref["partner_names"])
            action = "update" if changes else "unchanged"
            diff_out = changes or None
        results.append({"row": p["row"], "name": p["name"] or None,
                        "action": action,
                        "matched_by": p["matched_by"] if action != "error" else None,
                        "matched_name": (target.display_name
                                         if target is not None and action != "error" else None),
                        "errors": errors, "diff": diff_out, "person_id": person_id,
                        "cells": p["cells"],
                        "data": p["data"] if action != "error" else None})

    can_commit = bool(results) and all(r["action"] != "error" for r in results)
    return {"rows": results, "can_commit": can_commit}


def _diff_row(person: Person, profile: WorkerProfile | None, is_worker: bool,
              data: dict, blank: dict, partner_obj: Partner | None,
              partner_names: dict) -> dict:
    """Changed fields only; blank in the row = no change. `blank` remembers
    the create-only status/country defaults so they never read as edits."""
    out: dict = {}
    for col, attr in PERSON_ATTR.items():
        raw = data[col]
        if col == "country" and blank["country"]:
            continue
        if raw == "":
            continue
        old = getattr(person, attr)
        if col == "email" and (old or "").casefold() == raw.casefold():
            continue
        if col == "phone" and old and normalize_phone(old) == normalize_phone(raw):
            continue
        if (old or "") != raw:
            out[col] = {"old": old, "new": raw}
    for col in PROFILE_COLUMNS:
        raw = data[col]
        if col == "status" and blank["status"]:
            continue
        if raw == "":
            continue
        if profile is not None:
            old = getattr(profile, col)
        else:
            old = "active" if col == "status" else None
        if (old or "") != raw:
            out[col] = {"old": old, "new": raw}
    if data["partner"] and partner_obj is not None:
        old_pid = profile.partner_id if profile is not None else None
        if old_pid != partner_obj.id:
            out["partner"] = {"old": partner_names.get(old_pid) if old_pid else None,
                              "new": partner_obj.name}
    if not is_worker:
        out["worker_role"] = {"old": None, "new": "granted"}
    return out
```

- [ ] **Step 4: Run the whole service file**

Run: same command as Step 2.
Expected: everything passes except nothing — all tests written so far pass (the export round-trip test now has `preview_rows`). If `test_status_change_guards_rank_and_self` fails because the developer role's rank is not above 60, check `select name, rank from roles` in the test DB via a quick `db.execute(text(...))` print and pick a role whose rank is `>= 60` (founder is 100).

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers
git checkout -- api/src/serversherpa/_dev_reload.py 2>/dev/null
git add api/src/serversherpa/people/bulk_import.py api/tests/test_workers_bulk_import_service.py
git commit -m "feat(people): workers bulk preview — email/phone/name matching, validation, diff

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Workers importer — commit (create, approved update, skip)

**Files:**
- Modify: `api/src/serversherpa/people/bulk_import.py` (append)
- Test: `api/tests/test_workers_bulk_import_service.py` (append)

**Interfaces:**
- Produces: `async commit_rows(db, numbered, *, actor_id, actor_rank, approved_updates: set[str], source_label: str) -> dict` returning `{"created", "updated", "skipped", "unchanged", "rows": [{row, name, person_id, action ∈ created|updated|skipped|unchanged, diff}]}`. Raises `BulkImportError("rows_invalid", rows=preview_rows)` when any row errors or the payload is empty.

- [ ] **Step 1: Append the failing commit tests**

Append to `api/tests/test_workers_bulk_import_service.py`:

```python
# ── commit ──────────────────────────────────────────────────────────

async def test_commit_creates_person_role_and_profile(db, admin):
    pt = Partner(name="Haul It")
    db.add(pt)
    await db.commit()
    out = await commit(db, admin, [{
        "first_name": "Maria", "last_name": "Lopez", "phone": "(555) 987-6543",
        "employee_number": "E7", "rfid_tag": "RF1", "partner": "haul it",
        "trade": "Cable", "level": "L2", "status": "standby", "city": "Reno"}],
        source="crew.xlsx")
    assert out["created"] == 1 and out["updated"] == out["skipped"] == out["unchanged"] == 0
    row = out["rows"][0]
    assert row["action"] == "created" and row["name"] == "Maria Lopez" and row["diff"] is None
    person = await db.get(Person, uuid.UUID(row["person_id"]))
    assert person.phone == "(555) 987-6543" and person.external_id == "E7"
    assert person.rfid_tag == "RF1" and person.country == "US"
    assert person.source == "import" and person.source_ref == "crew.xlsx"
    assert person.created_by == admin.id
    profile = await db.get(WorkerProfile, person.id)
    assert profile.partner_id == pt.id and profile.trade == "Cable"
    assert profile.level == "L2" and profile.status == "standby"
    assert await db.scalar(select(PersonRole.id).where(
        PersonRole.person_id == person.id, PersonRole.role == "worker",
        PersonRole.revoked_at.is_(None))) is not None
    actions = list(await db.scalars(select(AuditLog.action).where(
        AuditLog.entity_type == "worker")))
    assert sorted(actions) == ["bulk_import", "create"]


async def test_commit_updates_approved_skips_unapproved_counts_unchanged(db, admin):
    a = await mk_worker(db, "Robert", "Smith", email="a@test.example.com")
    b = await mk_worker(db, "Sara", "Jones", email="b@test.example.com")
    await mk_worker(db, "Same", "Person", email="s@test.example.com")
    out = await commit(db, admin, [
        {"first_name": "Robert", "last_name": "Smith", "city": "Reno"},
        {"first_name": "Sara", "last_name": "Jones", "city": "Austin"},
        {"first_name": "Same", "last_name": "Person"},
        {"first_name": "Brand", "last_name": "New"},
    ], approved=[str(a.id)])
    assert (out["created"], out["updated"], out["skipped"], out["unchanged"]) == (1, 1, 1, 1)
    by_name = {r["name"]: r for r in out["rows"]}
    assert by_name["Robert Smith"]["action"] == "updated"
    assert by_name["Robert Smith"]["diff"] == {"city": {"old": None, "new": "Reno"}}
    assert by_name["Sara Jones"]["action"] == "skipped"
    assert by_name["Sara Jones"]["diff"] == {"city": {"old": None, "new": "Austin"}}
    assert by_name["Same Person"]["action"] == "unchanged"
    assert by_name["Brand New"]["action"] == "created"
    await db.refresh(a)
    await db.refresh(b)
    assert a.city == "Reno" and b.city is None            # skipped row untouched
    bulk_row = await db.scalar(select(AuditLog).where(AuditLog.action == "bulk_import"))
    assert bulk_row.changes == {"created": 1, "updated": 1, "skipped": 1,
                                "unchanged": 1, "source": "test.csv"}


async def test_commit_grants_role_and_creates_profile_on_matched_non_worker(db, admin):
    user = await mk_worker(db, "Office", "User", email="ou@test.example.com", role=False)
    out = await commit(db, admin, [
        {"first_name": "Office", "last_name": "User", "trade": "Cable"}],
        approved=[str(user.id)])
    assert out["updated"] == 1
    assert await db.scalar(select(PersonRole.id).where(
        PersonRole.person_id == user.id, PersonRole.role == "worker",
        PersonRole.revoked_at.is_(None))) is not None
    profile = await db.get(WorkerProfile, user.id)
    assert profile.trade == "Cable" and profile.status == "active"


async def test_commit_blank_status_country_never_written_on_update(db, admin):
    w = await mk_worker(db, "Keep", "Country", email="k@test.example.com",
                        profile={"status": "standby"})
    w.country = "CH"
    await db.commit()
    out = await commit(db, admin, [
        {"first_name": "Keep", "last_name": "Country", "status": "", "country": "",
         "city": "Zurich"}], approved=[str(w.id)])
    assert out["updated"] == 1
    await db.refresh(w)
    assert w.country == "CH" and w.city == "Zurich"
    assert (await db.get(WorkerProfile, w.id)).status == "standby"


async def test_commit_blacklist_disables_account_and_unblacklist_restores(db, admin):
    w = await mk_worker(db, "Bad", "Actor", email="bad@test.example.com", account=True)
    out = await commit(db, admin, [
        {"first_name": "Bad", "last_name": "Actor", "status": "blacklist",
         "status_note": "no-show x3"}], approved=[str(w.id)])
    assert out["updated"] == 1
    account = await db.get(UserAccount, w.id)
    assert account.disabled_at is not None
    out = await commit(db, admin, [
        {"first_name": "Bad", "last_name": "Actor", "status": "active"}],
        approved=[str(w.id)])
    assert out["updated"] == 1
    await db.refresh(account)
    assert account.disabled_at is None


async def test_commit_is_all_or_nothing(db, admin):
    with pytest.raises(bi.BulkImportError) as exc:
        await commit(db, admin, [
            {"first_name": "Good", "last_name": "Row"},
            {"first_name": "", "last_name": "Bad"},
        ])
    assert exc.value.code == "rows_invalid"
    assert [r["action"] for r in exc.value.extra["rows"]] == ["create", "error"]
    assert await db.scalar(select(func.count()).select_from(Person).where(
        Person.last_name == "Row")) == 0
    with pytest.raises(bi.BulkImportError):
        await commit(db, admin, [])
```

Add `from sqlalchemy import func, select` at the top of the test file (replacing the existing `from sqlalchemy import select`).

- [ ] **Step 2: Run to verify the commit tests fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_workers_bulk_import_service.py -q -k commit`
Expected: `AttributeError: ... has no attribute 'commit_rows'`.

- [ ] **Step 3: Append the commit code**

Append to `api/src/serversherpa/people/bulk_import.py`:

```python
# ── commit ──────────────────────────────────────────────────────────

async def commit_rows(db: AsyncSession, numbered: list[tuple[int, dict]], *,
                      actor_id: uuid.UUID, actor_rank: int,
                      approved_updates: set[str], source_label: str) -> dict:
    """All-or-nothing: re-validates everything, then writes creates plus
    APPROVED updates in one transaction; unapproved updates are skipped.
    Raises rows_invalid (carrying the full preview payload) if any row
    errors — nothing is written.

    `numbered` must be the ORIGINAL uploaded cells (the preview's `cells`),
    never its normalized `data`."""
    preview = await preview_rows(db, numbered, actor_id=actor_id, actor_rank=actor_rank)
    if not preview["rows"] or any(r["action"] == "error" for r in preview["rows"]):
        raise BulkImportError("rows_invalid", rows=preview["rows"])

    ref = await _reference_data(db)
    counts = {"created": 0, "updated": 0, "skipped": 0, "unchanged": 0}
    applied: list[dict] = []
    for r in preview["rows"]:
        if r["action"] == "unchanged":
            action = "unchanged"
        elif r["action"] == "create":
            person = await _create_worker(db, actor_id, r["data"], ref, source_label)
            r["person_id"] = str(person.id)
            action = "created"
        elif r["person_id"] in approved_updates:
            await _apply_update(db, actor_id, r, ref)
            action = "updated"
        else:
            action = "skipped"
        counts[action] += 1
        applied.append({"row": r["row"], "name": r["name"],
                        "person_id": r["person_id"], "action": action,
                        "diff": r["diff"] if action in ("updated", "skipped") else None})
    audit(db, actor_id=actor_id, entity_type="worker", entity_id=None,
          action="bulk_import", changes={**counts, "source": source_label})
    await db.commit()
    return {**counts, "rows": applied}


def _resolve_partner(ref: dict, name: str) -> Partner | None:
    matches = ref["partners"].get(name.lower(), []) if name else []
    return matches[0] if len(matches) == 1 else None


def _audit_value(value: Any) -> Any:
    return str(value) if isinstance(value, uuid.UUID) else value


async def _create_worker(db: AsyncSession, actor_id: uuid.UUID, data: dict,
                         ref: dict, source_label: str) -> Person:
    fields = {attr: data[col] for col, attr in PERSON_ATTR.items()
              if data[col] not in ("", None)}
    person = Person(**fields, source="import", source_ref=source_label,
                    created_by=actor_id)
    db.add(person)
    await db.flush()
    partner = _resolve_partner(ref, data["partner"])
    profile = WorkerProfile(
        person_id=person.id, created_by=actor_id,
        partner_id=partner.id if partner else None,
        trade=data["trade"] or None, level=data["level"] or None,
        status=data["status"], status_note=data["status_note"] or None)
    db.add(profile)
    db.add(PersonRole(person_id=person.id, role="worker", granted_by=actor_id))
    changes = {key: {"from": None, "to": _audit_value(value)}
               for key, value in fields.items()}
    for col in PROFILE_COLUMNS:
        if data[col]:
            changes[col] = {"from": None, "to": data[col]}
    if partner is not None:
        changes["partner"] = {"from": None, "to": partner.name}
    changes["worker_role"] = {"from": None, "to": "granted"}
    audit(db, actor_id=actor_id, entity_type="worker",
          entity_id=str(person.id), action="create", changes=changes)
    return person


async def _apply_update(db: AsyncSession, actor_id: uuid.UUID, r: dict,
                        ref: dict) -> None:
    person = await db.get(Person, uuid.UUID(r["person_id"]))
    profile = await db.get(WorkerProfile, person.id)
    had_profile = profile is not None
    if profile is None:
        # the kiosk sync keys "is a worker" off the profile row, so every
        # matched worker leaves the import with one
        profile = WorkerProfile(person_id=person.id, created_by=actor_id)
        db.add(profile)
    now = datetime.now(UTC)
    old_status = profile.status if had_profile else "active"
    changes: dict = {}
    for col, change in (r["diff"] or {}).items():
        if col in PERSON_ATTR:
            setattr(person, PERSON_ATTR[col], change["new"])
        elif col == "partner":
            partner = _resolve_partner(ref, change["new"])
            profile.partner_id = partner.id if partner else profile.partner_id
        elif col == "worker_role":
            db.add(PersonRole(person_id=person.id, role="worker", granted_by=actor_id))
        else:
            setattr(profile, col, change["new"])
        changes[col] = {"from": change["old"], "to": change["new"]}
    new_status = profile.status or "active"
    if profile.status != "blacklist" and "status" in changes:
        profile.status_note = (r["diff"].get("status_note") or {}).get("new", profile.status_note)

    # blacklist ⇄ login access coupling, exactly as PUT /workers/{id}/profile
    account = await db.get(UserAccount, person.id)
    if account is not None:
        if new_status == "blacklist" and old_status != "blacklist":
            account.disabled_at = now
            account.updated_at = now
            await db.execute(
                update(AuthSession)
                .where(AuthSession.person_id == person.id,
                       AuthSession.revoked_at.is_(None))
                .values(revoked_at=now, revoke_reason="account_disabled"))
        elif old_status == "blacklist" and new_status != "blacklist":
            account.disabled_at = None
            account.failed_login_count = 0
            account.locked_until = None
            account.updated_at = now
    person.updated_at = now
    profile.updated_at = now
    audit(db, actor_id=actor_id, entity_type="worker",
          entity_id=str(person.id), action="update", changes=changes)
```

Note on `Person(**fields, …)` when `fields` contains `country`: `data["country"]` is never blank on a create, so `country` is always in `fields`.

- [ ] **Step 4: Run the whole service file**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_workers_bulk_import_service.py -q`
Expected: all pass. If `test_commit_blacklist_disables_account_and_unblacklist_restores` fails on `UserAccount(password_hash="x")`, check `api/tests/test_workers.py::_mk_worker` for the exact columns a `UserAccount` needs and copy them into the test's `mk_worker`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers
git checkout -- api/src/serversherpa/_dev_reload.py 2>/dev/null
git add api/src/serversherpa/people/bulk_import.py api/tests/test_workers_bulk_import_service.py
git commit -m "feat(people): workers bulk commit — create, approved update, skip, blacklist coupling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Shared route helpers + workers bulk endpoints

**Files:**
- Create: `api/src/serversherpa/api/bulk_routes.py`
- Modify: `api/src/serversherpa/api/routes/sites.py:132-216` (use the shared helpers)
- Modify: `api/src/serversherpa/api/routes/workers.py` (add the bulk block above `GET /{person_id}` at line 154)
- Test: `api/tests/test_workers_bulk_import_api.py`

**Interfaces:**
- Produces (`serversherpa.api.bulk_routes`):
  - `require_bulk_rank(actor: AuthContext) -> None` — 403 `forbidden` unless global and `max_rank >= GATE_BYPASS_RANK`
  - `bulk_http_error(exc: BulkImportError) -> HTTPException` — 422 `{code, **extra}`
  - `async rows_from_request(request: Request, *, parse_upload, number_json_rows) -> list[tuple[int, dict]]` — multipart `file` or JSON `{rows}`; the two callables are the importer's own wrappers
- Endpoints: `GET /workers/bulk-import/template?format=csv|xlsx`, `GET /workers/bulk-import/export?format=csv|xlsx`, `POST /workers/bulk-import/preview`, `POST /workers/bulk-import/commit` (`{rows, approved_updates, source}`).

- [ ] **Step 1: Write the failing API tests**

Create `api/tests/test_workers_bulk_import_api.py`:

```python
"""Workers bulk-import endpoints: rank gating, template/export formats,
preview and commit through HTTP. seeded_user (staff, rank 40) holds
workers:add but is below the bulk bar; admin (60) clears it."""
import io

import openpyxl
import pytest
from sqlalchemy import select

from serversherpa.db.models import Person, PersonRole, WorkerProfile
from serversherpa.people import bulk_import as bi
from tests.test_sites_api import login, make_login


@pytest.fixture
async def admin_hdrs(db, client):
    person = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return await make_login(db, client, person, "ada@test.example.com")


async def test_staff_rank_forbidden_on_all_four(client, seeded_user):
    hdrs = await login(client)
    assert (await client.get("/workers/bulk-import/template?format=csv",
                             headers=hdrs)).status_code == 403
    assert (await client.get("/workers/bulk-import/export?format=csv",
                             headers=hdrs)).status_code == 403
    assert (await client.post("/workers/bulk-import/preview", headers=hdrs,
                              json={"rows": [{"first_name": "X"}]})).status_code == 403
    assert (await client.post("/workers/bulk-import/commit", headers=hdrs,
                              json={"rows": [{"first_name": "X"}]})).status_code == 403


async def test_template_formats(client, db, seeded_user, admin_hdrs):
    csv_resp = await client.get("/workers/bulk-import/template?format=csv", headers=admin_hdrs)
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert csv_resp.headers["content-disposition"] == 'attachment; filename="workers-template.csv"'
    assert csv_resp.text.splitlines()[0] == ",".join(bi.COLUMNS)

    xlsx_resp = await client.get("/workers/bulk-import/template?format=xlsx", headers=admin_hdrs)
    assert xlsx_resp.status_code == 200
    assert xlsx_resp.headers["content-disposition"] == 'attachment; filename="workers-template.xlsx"'
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_resp.content))
    assert wb.sheetnames == ["Workers", "Reference"]
    ref_cells = [row[0].value for row in wb["Reference"].iter_rows()]
    assert "L1" in ref_cells and "blacklist" in ref_cells and "Partner names" in ref_cells

    assert (await client.get("/workers/bulk-import/template?format=doc",
                             headers=admin_hdrs)).status_code == 422


async def test_export_formats(client, db, seeded_user, admin_hdrs):
    person = Person(first_name="Exported", last_name="Worker", phone="555-000-9999")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="worker"))
    await db.commit()
    csv_resp = await client.get("/workers/bulk-import/export?format=csv", headers=admin_hdrs)
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-disposition"] == 'attachment; filename="workers-export.csv"'
    lines = csv_resp.text.splitlines()
    assert lines[0] == ",".join(bi.COLUMNS)
    assert lines[1].startswith("Exported,Worker,,,555-000-9999")
    xlsx_resp = await client.get("/workers/bulk-import/export?format=xlsx", headers=admin_hdrs)
    assert xlsx_resp.status_code == 200
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_resp.content))
    assert wb["Workers"]["A2"].value == "Exported"
    assert (await client.get("/workers/bulk-import/export?format=doc",
                             headers=admin_hdrs)).status_code == 422


async def test_preview_json_and_file_paths(client, db, seeded_user, admin_hdrs):
    json_resp = await client.post("/workers/bulk-import/preview", headers=admin_hdrs,
                                  json={"rows": [{"first_name": "Jay", "last_name": "Son"}]})
    assert json_resp.status_code == 200
    assert json_resp.json()["rows"][0]["action"] == "create"
    assert json_resp.json()["rows"][0]["row"] == 1

    csv_bytes = b"first_name,last_name,level\nCee,Ess,L9\n"
    file_resp = await client.post("/workers/bulk-import/preview", headers=admin_hdrs,
                                  files={"file": ("crew.csv", csv_bytes, "text/csv")})
    assert file_resp.status_code == 200
    row = file_resp.json()["rows"][0]
    assert row["row"] == 2 and row["errors"] == ["unknown level 'L9'"]

    bad = await client.post("/workers/bulk-import/preview", headers=admin_hdrs,
                            json={"rows": [{"nope": 1}]})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "unknown_columns"
    missing = await client.post("/workers/bulk-import/preview", headers=admin_hdrs,
                                files={"other": ("x.csv", b"a", "text/csv")})
    assert missing.status_code == 422 and missing.json()["detail"]["code"] == "missing_file"


async def test_commit_end_to_end_with_approved_and_skipped(client, db, seeded_user, admin_hdrs):
    existing = Person(first_name="Robert", last_name="Smith", email="bob@test.example.com")
    other = Person(first_name="Sara", last_name="Jones", email="sara@test.example.com")
    db.add_all([existing, other])
    await db.flush()
    db.add(PersonRole(person_id=existing.id, role="worker"))
    db.add(PersonRole(person_id=other.id, role="worker"))
    await db.commit()

    rows = [
        {"first_name": "Robert", "last_name": "Smith", "email": "bob@test.example.com",
         "trade": "Cable"},
        {"first_name": "Sara", "last_name": "Jones", "city": "Austin"},
        {"first_name": "Maria", "last_name": "Lopez", "phone": "555-987-6543"},
    ]
    preview = (await client.post("/workers/bulk-import/preview", headers=admin_hdrs,
                                 json={"rows": rows})).json()
    assert [r["action"] for r in preview["rows"]] == ["update", "update", "create"]
    assert preview["rows"][0]["matched_by"] == "email, name"

    resp = await client.post("/workers/bulk-import/commit", headers=admin_hdrs, json={
        "rows": [r["cells"] for r in preview["rows"]],
        "approved_updates": [str(existing.id)], "source": "crew.csv"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["created"], body["updated"], body["skipped"], body["unchanged"]) == (1, 1, 1, 0)
    assert [r["action"] for r in body["rows"]] == ["updated", "skipped", "created"]
    assert body["rows"][0]["diff"] == {"trade": {"old": None, "new": "Cable"}}
    assert (await db.get(WorkerProfile, existing.id)).trade == "Cable"
    await db.refresh(other)
    assert other.city is None
    created = await db.scalar(select(Person).where(Person.last_name == "Lopez"))
    assert created.source_ref == "crew.csv"

    # a row error blocks the whole commit
    bad = await client.post("/workers/bulk-import/commit", headers=admin_hdrs, json={
        "rows": [{"first_name": "", "last_name": "Nope"}], "approved_updates": []})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "rows_invalid"
    assert bad.json()["detail"]["rows"][0]["errors"] == ["first_name is required"]
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_workers_bulk_import_api.py -q`
Expected: failures — the template route 404s (or 422 from the UUID path) and the preview/commit posts 404.

- [ ] **Step 3: Create the shared route helpers**

Create `api/src/serversherpa/api/bulk_routes.py`:

```python
"""Shared pieces of every bulk-import router (sites, workers, …): the rank
gate, the BulkImportError → 422 mapping, and the multipart-or-JSON row
reader. Each router keeps its own four endpoints because the template
reference lists and the commit signature are importer-specific."""

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException, Request

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.api.deps import AuthContext
from serversherpa.imports.bulk import BulkImportError


def require_bulk_rank(actor: AuthContext) -> None:
    """Bulk import is admin-and-up: the resource's `add` alone (staff hold
    it) is not enough — the blast radius of a thousand-row write warrants
    the same bar as the other rank-gated admin tooling."""
    if not actor.access.is_global or actor.access.max_rank < GATE_BYPASS_RANK:
        raise HTTPException(status_code=403, detail={"code": "forbidden"})


def bulk_http_error(exc: BulkImportError) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": exc.code, **exc.extra})


async def rows_from_request(
    request: Request, *,
    parse_upload: Callable[[str, bytes], list[tuple[int, dict]]],
    number_json_rows: Callable[[Any], list[tuple[int, dict]]],
) -> list[tuple[int, dict]]:
    """Multipart `file` → the importer's parse_upload; otherwise a JSON body
    `{"rows": [...]}` → its number_json_rows."""
    ctype = request.headers.get("content-type", "")
    try:
        if ctype.startswith("multipart/"):
            form = await request.form()
            upload = form.get("file")
            if upload is None or isinstance(upload, str):
                raise BulkImportError("missing_file")
            return parse_upload(upload.filename or "", await upload.read())
        body = await request.json()
        return number_json_rows(body.get("rows"))
    except BulkImportError as exc:
        raise bulk_http_error(exc) from None
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail={"code": "invalid_json"}) from None
```

- [ ] **Step 4: Switch the sites router to the shared helpers**

In `api/src/serversherpa/api/routes/sites.py`:
- Add `from serversherpa.api.bulk_routes import bulk_http_error, require_bulk_rank, rows_from_request`.
- Delete `_require_bulk_rank`, `_bulk_err`, and `_rows_from_request` (lines 136–145 and 202–216).
- Replace every `_require_bulk_rank(actor)` with `require_bulk_rank(actor)`, every `_bulk_err(exc)` with `bulk_http_error(exc)`, and `await _rows_from_request(request)` with `await rows_from_request(request, parse_upload=bulk.parse_upload, number_json_rows=bulk.number_json_rows)`.
- Remove the now-unused `GATE_BYPASS_RANK` import if nothing else in the file uses it (`grep -n GATE_BYPASS_RANK api/src/serversherpa/api/routes/sites.py`).

Run: `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_sites_bulk_import_api.py -q` → all pass.

- [ ] **Step 5: Add the workers bulk block**

In `api/src/serversherpa/api/routes/workers.py`:

Add imports:

```python
from fastapi import APIRouter, HTTPException, Request, Response

from serversherpa.api.bulk_routes import bulk_http_error, require_bulk_rank, rows_from_request
from serversherpa.people import bulk_import as bulk
```

(keep the existing `from fastapi import APIRouter, HTTPException` line merged into the one above.)

Insert immediately before `@router.get("/{person_id}", response_model=WorkerDetailOut)` (line 154):

```python
# ── bulk import ────────────────────────────────────────────────────
# Declared ABOVE get_worker: /workers/bulk-import/* must never be swallowed
# by GET /workers/{person_id} (which would 422 on the non-UUID segment).

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _attachment(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


@router.get("/bulk-import/template")
async def bulk_import_template(
    db: DbSession,
    format: str = "csv",
    actor: AuthContext = require_permission("workers", "add"),
):
    require_bulk_rank(actor)
    if format == "csv":
        return Response(bulk.build_template_csv(), media_type="text/csv",
                        headers=_attachment("workers-template.csv"))
    if format == "xlsx":
        levels, statuses, partners = await bulk.reference_lists(db)
        return Response(bulk.build_template_xlsx(levels, statuses, partners),
                        media_type=_XLSX, headers=_attachment("workers-template.xlsx"))
    raise _err(422, "unknown_format")


@router.get("/bulk-import/export")
async def bulk_import_export(
    db: DbSession,
    format: str = "xlsx",
    actor: AuthContext = require_permission("workers", "add"),
):
    """The current workers in the template's layout — fill in, re-upload."""
    require_bulk_rank(actor)
    if format not in ("csv", "xlsx"):
        raise _err(422, "unknown_format")
    rows = await bulk.export_rows(db)
    if format == "csv":
        return Response(bulk.build_rows_csv(rows), media_type="text/csv",
                        headers=_attachment("workers-export.csv"))
    levels, statuses, partners = await bulk.reference_lists(db)
    return Response(bulk.build_rows_xlsx(rows, levels, statuses, partners),
                    media_type=_XLSX, headers=_attachment("workers-export.xlsx"))


@router.post("/bulk-import/preview")
async def bulk_import_preview(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "add"),
) -> dict:
    require_bulk_rank(actor)
    numbered = await rows_from_request(
        request, parse_upload=bulk.parse_upload, number_json_rows=bulk.number_json_rows)
    return await bulk.preview_rows(db, numbered, actor_id=actor.person.id,
                                   actor_rank=actor.access.max_rank)


@router.post("/bulk-import/commit")
async def bulk_import_commit(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "add"),
) -> dict:
    require_bulk_rank(actor)
    try:
        body = await request.json()
    except ValueError:
        raise _err(422, "invalid_json") from None
    try:
        numbered = bulk.number_json_rows(body.get("rows"))
    except bulk.BulkImportError as exc:
        raise bulk_http_error(exc) from None
    approved = {str(s) for s in body.get("approved_updates") or []}
    try:
        return await bulk.commit_rows(
            db, numbered, actor_id=actor.person.id, actor_rank=actor.access.max_rank,
            approved_updates=approved, source_label=str(body.get("source") or "upload"))
    except bulk.BulkImportError as exc:
        raise bulk_http_error(exc) from None
```

`_err` in workers.py takes `(status, code)` only; the `unknown_format` calls above match that.

- [ ] **Step 6: Run the workers API tests, then the neighbors**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest tests/test_workers_bulk_import_api.py tests/test_workers.py tests/test_workers_detail_api.py tests/test_sites_bulk_import_api.py tests/test_containers_api.py -q` (timeout 600000).
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers
git checkout -- api/src/serversherpa/_dev_reload.py 2>/dev/null
git add api/src/serversherpa/api/bulk_routes.py api/src/serversherpa/api/routes/sites.py api/src/serversherpa/api/routes/workers.py api/tests/test_workers_bulk_import_api.py
git commit -m "feat(api): workers bulk-import endpoints; shared bulk route gate and row reader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Portal — shared BulkApplySummary, bulk styles, api client, column guide

**Files:**
- Create: `portal/src/components/bulk/BulkApplySummary.tsx` (move + generalize from `portal/src/components/sites/BulkApplySummary.tsx`)
- Create: `portal/src/components/bulk/BulkApplySummary.test.tsx`
- Delete: `portal/src/components/sites/BulkApplySummary.tsx`
- Modify: `portal/src/components/sites/SiteBulkUpload.tsx:19,148`
- Modify: `portal/src/styles/sites.css:72-103` → move to `portal/src/styles/bulk.css`
- Modify: `portal/src/lib/api.ts:1093-1186`
- Create: `portal/src/lib/workerBulk.ts`, `portal/src/lib/workerBulk.test.ts`
- Existing tests: `portal/src/components/sites/SiteBulkUpload.test.tsx`, `portal/src/pages/BulkSites.test.tsx`, `portal/src/lib/siteBulk.test.ts`, `portal/src/styles/listTypography.test.ts`

**Interfaces:**
- Produces (`components/bulk/BulkApplySummary.tsx`):
  ```ts
  export type BulkDiff = Record<string, { old?: unknown; new?: unknown; add?: string[]; remove?: string[] }>;
  export interface BulkSummaryRow { row: number; name: string; action: 'created' | 'updated' | 'skipped' | 'unchanged'; diff: BulkDiff | null }
  export interface BulkSummaryResult<R extends BulkSummaryRow> { created: number; updated: number; unchanged: number; skipped?: number; rows: R[] }
  export function changesText(diff: BulkDiff | null): string
  export default function BulkApplySummary<R extends BulkSummaryRow>(props: { result: BulkSummaryResult<R>; entityLabel: string; linkFor: (row: R) => string; filename: string; openTo: string; openLabel: string }): JSX.Element
  ```
- Produces (`lib/api.ts`): `WorkerBulkRowResult`, `WorkerBulkPreview`, `WorkerBulkAppliedRow`, `WorkerBulkCommitResult`, `previewWorkerBulk(file, filename)`, `commitWorkerBulk(rows, approved, source)`, `downloadWorkerTemplate(format)`, `downloadWorkerExport(format)`.
- Produces (`lib/workerBulk.ts`): `WORKER_COLUMN_GUIDE: { key, required, accepts, example }[]` (20 entries), `WORKER_BULK_ERRORS: Record<string, string>`.

- [ ] **Step 1: Write the failing summary test**

Create `portal/src/components/bulk/BulkApplySummary.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const listTools = vi.hoisted(() => ({ exportCsv: vi.fn() }));
vi.mock('../../lib/listTools', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/listTools')>()), ...listTools,
}));
const { default: BulkApplySummary, changesText } = await import('./BulkApplySummary');

beforeEach(() => listTools.exportCsv.mockReset());
afterEach(cleanup);

const result = {
  created: 1, updated: 1, skipped: 1, unchanged: 0,
  rows: [
    { row: 2, name: 'Bob Smith', person_id: 'p1', action: 'updated' as const,
      diff: { trade: { old: null, new: 'Cable' } } },
    { row: 3, name: 'Sara Jones', person_id: 'p2', action: 'skipped' as const,
      diff: { city: { old: null, new: 'Austin' } } },
    { row: 4, name: 'Maria Lopez', person_id: 'p3', action: 'created' as const, diff: null },
  ],
};

it('renders counts with skipped, entity links, result labels, and downloads the csv', () => {
  render(<MemoryRouter>
    <BulkApplySummary result={result} entityLabel="Worker" filename="workers-bulk-summary"
      linkFor={(r) => `/people/workers/${r.person_id}`} openTo="/people/workers" openLabel="Open Workers" />
  </MemoryRouter>);
  expect(screen.getByText('Applied: 1 added · 1 updated · 1 skipped · 0 unchanged')).toBeTruthy();
  expect(screen.getByText('Worker')).toBeTruthy();                       // column header
  expect((screen.getByRole('link', { name: 'Bob Smith' }) as HTMLAnchorElement).getAttribute('href'))
    .toMatch(/\/people\/workers\/p1$/);
  expect(screen.getByText('Skipped')).toBeTruthy();
  expect(screen.getByText('city: — → Austin')).toBeTruthy();
  expect((screen.getByRole('link', { name: 'Open Workers' }) as HTMLAnchorElement).getAttribute('href'))
    .toMatch(/\/people\/workers$/);
  fireEvent.click(screen.getByRole('button', { name: 'Download summary (.csv)' }));
  expect(listTools.exportCsv).toHaveBeenCalledWith('workers-bulk-summary', expect.any(Array), result.rows);
  const [, columns] = listTools.exportCsv.mock.calls[0];
  expect(columns.map(([h]: [string]) => h)).toEqual(['Row', 'Worker', 'Result', 'Changes']);
});

it('omits the skipped count when the result has none (sites shape)', () => {
  render(<MemoryRouter>
    <BulkApplySummary result={{ created: 2, updated: 0, unchanged: 1, rows: [] }} entityLabel="Site"
      filename="sites-bulk-summary" linkFor={() => '/sites'} openTo="/sites" openLabel="Open Sites" />
  </MemoryRouter>);
  expect(screen.getByText('Applied: 2 added · 0 updated · 1 unchanged')).toBeTruthy();
});

it('changesText flattens diffs including client add/remove', () => {
  expect(changesText({ name: { old: 'A', new: 'B' }, clients: { add: ['X'], remove: ['Y'] } }))
    .toBe('name: A → B; clients: +X, −Y');
  expect(changesText(null)).toBe('');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/portal && npx vitest run src/components/bulk/BulkApplySummary.test.tsx`
Expected: fails to resolve `./BulkApplySummary`.

- [ ] **Step 3: Create the generalized summary and delete the sites copy**

Create `portal/src/components/bulk/BulkApplySummary.tsx`:

```tsx
/**
 * BulkApplySummary — what a bulk apply actually did, one row per record,
 * with a CSV download so the run can be attached to a ticket. Server truth:
 * it renders the commit response, never the pre-apply preview. Shared by
 * every Bulk Actions tool; the caller names the entity and builds links.
 */
import { Link } from 'react-router-dom';

import { exportCsv } from '../../lib/listTools';
import DataTable from '../DataTable';

export type BulkDiff = Record<
  string,
  { old?: unknown; new?: unknown; add?: string[]; remove?: string[] }
>;

export interface BulkSummaryRow {
  row: number;
  name: string;
  action: 'created' | 'updated' | 'skipped' | 'unchanged';
  diff: BulkDiff | null;
}

export interface BulkSummaryResult<R extends BulkSummaryRow> {
  created: number;
  updated: number;
  unchanged: number;
  /** Present for tools with per-row skip (workers); absent for sites. */
  skipped?: number;
  rows: R[];
}

const RESULT_LABEL = {
  created: 'Added', updated: 'Updated', skipped: 'Skipped', unchanged: 'No change',
} as const;
const ROW_CLASS = {
  created: 'create', updated: 'update', skipped: 'skipped', unchanged: 'unchanged',
} as const;

export function changesText(diff: BulkDiff | null): string {
  if (!diff) return '';
  return Object.entries(diff).map(([field, change]) => {
    if (field === 'clients') {
      const add = (change.add ?? []).map((n) => `+${n}`);
      const remove = (change.remove ?? []).map((n) => `−${n}`);
      return `clients: ${[...add, ...remove].join(', ')}`;
    }
    const from = change.old === null || change.old === undefined ? '—' : String(change.old);
    return `${field}: ${from} → ${String(change.new)}`;
  }).join('; ');
}

interface Props<R extends BulkSummaryRow> {
  result: BulkSummaryResult<R>;
  /** Column header and CSV header for the record name ("Site", "Worker"). */
  entityLabel: string;
  linkFor: (row: R) => string;
  /** exportCsv base name, e.g. "sites-bulk-summary". */
  filename: string;
  openTo: string;
  openLabel: string;
}

export default function BulkApplySummary<R extends BulkSummaryRow>({
  result, entityLabel, linkFor, filename, openTo, openLabel,
}: Props<R>) {
  const download = () => exportCsv<R>(filename, [
    ['Row', (r) => String(r.row)],
    [entityLabel, (r) => r.name],
    ['Result', (r) => RESULT_LABEL[r.action]],
    ['Changes', (r) => changesText(r.diff)],
  ], result.rows);

  const counts = [
    `${result.created} added`,
    `${result.updated} updated`,
    ...(result.skipped !== undefined ? [`${result.skipped} skipped`] : []),
    `${result.unchanged} unchanged`,
  ].join(' · ');

  return (
    <div className="bulk-summary">
      <div className="bulk-actions">
        <b>Applied: {counts}</b>
        <button className="mini-btn" type="button" onClick={download}>Download summary (.csv)</button>
        <Link className="mini-btn" to={openTo}>{openLabel}</Link>
      </div>
      <DataTable
        ariaLabel="Apply summary"
        className="bulk-preview"
        columns={[
          { key: 'row', label: 'Row', width: '64px', mono: true },
          { key: 'name', label: entityLabel },
          { key: 'result', label: 'Result' },
          { key: 'changes', label: 'Changes' },
        ]}
        rows={result.rows.map((r) => ({
          key: String(r.row),
          className: `bulk-row-${ROW_CLASS[r.action]}`,
          cells: [
            r.row,
            <Link key="name" to={linkFor(r)}>{r.name}</Link>,
            RESULT_LABEL[r.action],
            changesText(r.diff) || '—',
          ],
        }))}
      />
    </div>
  );
}
```

Delete `portal/src/components/sites/BulkApplySummary.tsx` (`git rm`).

In `portal/src/components/sites/SiteBulkUpload.tsx`, change the import to `import BulkApplySummary from '../bulk/BulkApplySummary';` and the usage to:

```tsx
      {result && (
        <BulkApplySummary
          result={result}
          entityLabel="Site"
          linkFor={(r) => `/sites?open=${r.site_id}`}
          filename="sites-bulk-summary"
          openTo="/sites"
          openLabel="Open Sites"
        />
      )}
```

`grep -rn "sites/BulkApplySummary\|changesText" portal/src` — update any other importer of `changesText` to the new path.

- [ ] **Step 4: Move the preview/summary styles into bulk.css**

Cut lines 72–103 of `portal/src/styles/sites.css` (from the `/* ── bulk import pane` comment through the `.bulk-summary … { color: inherit; }` rule) and append them to `portal/src/styles/bulk.css`, adding a skipped tint after the `.bulk-row-unchanged` lines:

```css
.bulk-row-skipped td:nth-child(4) { color: var(--muted, #51606f); }
```

and in the summary block:

```css
.bulk-summary .bulk-row-skipped td:nth-child(3) { color: var(--muted, #51606f); }
```

and add `.bulk-summary .bulk-row-skipped td:nth-child(4),` to the `color: inherit` selector list. `SiteBulkUpload.tsx` does not import any css itself; `BulkSites.tsx` already imports `bulk.css`, and `Sites.tsx` (which hosts no bulk pane anymore) does not need the moved rules. Confirm with `grep -rn "bulk-import\|bulk-preview" portal/src --include=*.tsx -l`.

- [ ] **Step 5: Add the api client functions**

In `portal/src/lib/api.ts`, replace `downloadSiteTemplate` and `downloadSiteExport` (lines 1160–1186) with:

```ts
/** GET an attachment and hand it to the browser as a download. */
async function downloadAttachment(path: string, filename: string): Promise<void> {
  const resp = await apiFetch(path);
  if (!resp.ok) throw await errorFrom(resp);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadSiteTemplate(format: 'csv' | 'xlsx'): Promise<void> {
  return downloadAttachment(`/sites/bulk-import/template?format=${format}`, `sites-template.${format}`);
}

export function downloadSiteExport(format: 'csv' | 'xlsx'): Promise<void> {
  return downloadAttachment(`/sites/bulk-import/export?format=${format}`, `sites-export.${format}`);
}

// ── workers bulk import ─────────────────────────────────────────────

export interface WorkerBulkRowResult {
  row: number;
  name: string | null;
  action: 'create' | 'update' | 'unchanged' | 'error';
  /** Comma-joined keys that agreed: "email", "phone", "name", "email, name" … */
  matched_by: string | null;
  matched_name: string | null;
  errors: string[];
  diff: BulkRowResult['diff'];
  person_id: string | null;
  /** The uploaded cells, no defaults — what the commit replays. */
  cells: Record<string, string>;
  data: Record<string, unknown> | null;
}

export interface WorkerBulkPreview {
  rows: WorkerBulkRowResult[];
  can_commit: boolean;
}

export interface WorkerBulkAppliedRow {
  row: number;
  name: string;
  person_id: string;
  action: 'created' | 'updated' | 'skipped' | 'unchanged';
  diff: BulkRowResult['diff'];
}

export interface WorkerBulkCommitResult {
  created: number;
  updated: number;
  skipped: number;
  unchanged: number;
  rows: WorkerBulkAppliedRow[];
}

export async function previewWorkerBulk(
  file: File | Blob, filename: string,
): Promise<WorkerBulkPreview> {
  const fd = new FormData();
  fd.append('file', file, filename);
  const resp = await apiFetch('/workers/bulk-import/preview', { method: 'POST', body: fd });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function commitWorkerBulk(
  rows: Record<string, unknown>[], approved: string[], source: string,
): Promise<WorkerBulkCommitResult> {
  const resp = await apiFetch('/workers/bulk-import/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, approved_updates: approved, source }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export function downloadWorkerTemplate(format: 'csv' | 'xlsx'): Promise<void> {
  return downloadAttachment(`/workers/bulk-import/template?format=${format}`, `workers-template.${format}`);
}

export function downloadWorkerExport(format: 'csv' | 'xlsx'): Promise<void> {
  return downloadAttachment(`/workers/bulk-import/export?format=${format}`, `workers-export.${format}`);
}
```

- [ ] **Step 6: Write the failing column-guide test, then the guide**

Create `portal/src/lib/workerBulk.test.ts`:

```ts
import { expect, it } from 'vitest';

import { WORKER_BULK_ERRORS, WORKER_COLUMN_GUIDE } from './workerBulk';

it('describes exactly the template columns, names first and required', () => {
  expect(WORKER_COLUMN_GUIDE.map((c) => c.key)).toEqual([
    'first_name', 'last_name', 'preferred_name', 'email', 'phone', 'job_title',
    'employee_number', 'rfid_tag', 'address_line1', 'address_line2', 'city', 'region',
    'postal_code', 'country', 'partner', 'trade', 'level', 'status', 'status_note', 'notes',
  ]);
  expect(WORKER_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key))
    .toEqual(['first_name', 'last_name']);
});

it('maps every error code the bulk endpoints can raise', () => {
  // mirrors BulkImportError codes in api/src/serversherpa/imports/bulk.py and
  // people/bulk_import.py plus the route-level invalid_json/missing_file and the gate's forbidden
  expect(Object.keys(WORKER_BULK_ERRORS).sort()).toEqual([
    'file_too_large', 'forbidden', 'invalid_csv', 'invalid_json', 'invalid_xlsx',
    'missing_file', 'rows_invalid', 'too_many_rows', 'unknown_columns',
    'unsupported_file',
  ]);
});
```

Create `portal/src/lib/workerBulk.ts`:

```ts
/** What each workers bulk-import column accepts. Keys mirror the API's
 *  people/bulk_import.py COLUMNS — the service test pins that list, the
 *  test beside this file pins this one, and the two must agree. */
export interface WorkerColumnGuide { key: string; required: boolean; accepts: string; example: string }

export const WORKER_COLUMN_GUIDE: WorkerColumnGuide[] = [
  { key: 'first_name', required: true, accepts: 'Given name. With last_name, matches an existing person by name.', example: 'Robert' },
  { key: 'last_name', required: true, accepts: 'Family name.', example: 'Smith' },
  { key: 'preferred_name', required: false, accepts: 'What the person goes by. With last_name, also matches by name.', example: 'Bob' },
  { key: 'email', required: false, accepts: 'An email address. Matches an existing person by email (case does not matter).', example: 'bob.smith@example.com' },
  { key: 'phone', required: false, accepts: 'Any format with at least 7 digits. Matches an existing person by the digits.', example: '555-123-4567' },
  { key: 'job_title', required: false, accepts: 'Free text.', example: 'Lead Technician' },
  { key: 'employee_number', required: false, accepts: 'Badge or employee number, free text.', example: 'E1042' },
  { key: 'rfid_tag', required: false, accepts: 'Tap-in badge tag. Must not belong to another person.', example: '' },
  { key: 'address_line1', required: false, accepts: 'Street address.', example: '12 Rack Row' },
  { key: 'address_line2', required: false, accepts: 'Suite, floor, building.', example: '' },
  { key: 'city', required: false, accepts: 'Free text.', example: 'Reno' },
  { key: 'region', required: false, accepts: 'State or province.', example: 'NV' },
  { key: 'postal_code', required: false, accepts: 'Free text.', example: '89501' },
  { key: 'country', required: false, accepts: 'Two-letter code. Blank means US for new workers.', example: 'US' },
  { key: 'partner', required: false, accepts: 'An existing partner name from the Reference sheet. Blank means direct hire.', example: '' },
  { key: 'trade', required: false, accepts: 'Free text.', example: 'Cable, Rack & Stack' },
  { key: 'level', required: false, accepts: 'A level key from the Reference sheet (L1 to L6).', example: 'L4' },
  { key: 'status', required: false, accepts: 'A worker status from the Reference sheet. Blank means active for new workers.', example: 'active' },
  { key: 'status_note', required: false, accepts: 'Free text. Required when status is blacklist.', example: '' },
  { key: 'notes', required: false, accepts: 'Free text.', example: '' },
];

export const WORKER_BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The file has columns that are not in the template.',
  too_many_rows: 'Too many rows — the limit is 1,000 per upload.',
  file_too_large: 'File too large — the limit is 5 MB.',
  invalid_json: 'The server could not read the rows — preview again.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type — use .csv or .xlsx.',
  missing_file: 'Choose a file first.',
  rows_invalid: 'Some rows have problems — fix them and preview again.',
  forbidden: 'You do not have permission to bulk import.',
};
```

- [ ] **Step 7: Run the affected portal tests and the type check**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/portal && npx vitest run src/components/bulk src/components/sites src/pages/BulkSites.test.tsx src/lib/siteBulk.test.ts src/lib/workerBulk.test.ts src/styles/listTypography.test.ts && npx tsc --noEmit`
Expected: all pass; `tsc` clean. The sites upload test's assertions (`Applied: 1 added · 1 updated · 0 unchanged`, the `/sites?open=s1` link, the `sites-bulk-summary` filename, four CSV columns) must pass unchanged.

- [ ] **Step 8: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers
git add -A portal/src/components/bulk portal/src/components/sites portal/src/styles/bulk.css portal/src/styles/sites.css portal/src/lib/api.ts portal/src/lib/workerBulk.ts portal/src/lib/workerBulk.test.ts
git commit -m "feat(portal): shared BulkApplySummary, bulk styles, workers bulk api client and column guide

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Portal — WorkerBulkUpload component

**Files:**
- Create: `portal/src/components/workers/WorkerBulkUpload.tsx`
- Test: `portal/src/components/workers/WorkerBulkUpload.test.tsx`

**Interfaces:**
- Consumes: `previewWorkerBulk`, `commitWorkerBulk`, `WorkerBulkPreview`, `WorkerBulkCommitResult`, `WorkerBulkRowResult` from `lib/api`; `WORKER_BULK_ERRORS` from `lib/workerBulk`; `BulkApplySummary` from `components/bulk/BulkApplySummary`.
- Produces: `export default function WorkerBulkUpload({ onDone }: { onDone(result: WorkerBulkCommitResult): void })`. File input labeled `Upload a file (.csv or .xlsx)` with id `worker-bulk-file`; buttons `Preview`, `Add N workers and update M workers`, `Update all`, `Skip all`; per-row checkbox `aria-label="Update ${name}"`; count line `N to add · M to update · S to skip · K unchanged · E errors`.

- [ ] **Step 1: Write the failing component tests**

Create `portal/src/components/workers/WorkerBulkUpload.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ previewWorkerBulk: vi.fn(), commitWorkerBulk: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const listTools = vi.hoisted(() => ({ exportCsv: vi.fn() }));
vi.mock('../../lib/listTools', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/listTools')>()), ...listTools,
}));
const { ApiError } = await import('../../lib/api');
const { default: WorkerBulkUpload } = await import('./WorkerBulkUpload');

function renderUpload(onDone: (result: unknown) => void = () => {}) {
  return render(<MemoryRouter><WorkerBulkUpload onDone={onDone} /></MemoryRouter>);
}

const row = (over: Record<string, unknown>) => ({
  row: 2, name: 'Bob Smith', action: 'create', matched_by: null, matched_name: null,
  errors: [], diff: null, person_id: null,
  cells: { first_name: 'Bob', last_name: 'Smith', status: '', country: '' },
  data: { first_name: 'Bob', last_name: 'Smith', status: 'active', country: 'US' },
  ...over,
});

beforeEach(() => {
  api.previewWorkerBulk.mockReset();
  api.commitWorkerBulk.mockReset();
  listTools.exportCsv.mockReset();
});
afterEach(cleanup);

function pickFile() {
  const input = screen.getByLabelText('Upload a file (.csv or .xlsx)') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['first_name\nX'], 'crew.csv', { type: 'text/csv' })] } });
}

it('previews and keeps Apply disabled while errors exist', async () => {
  api.previewWorkerBulk.mockResolvedValue({ can_commit: false, rows: [
    row({ row: 2, name: 'Bad Row', action: 'error', errors: ["unknown level 'L9'"], data: null }),
    row({ row: 3, name: 'Good Row' }),
  ] });
  renderUpload();
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText("unknown level 'L9'")).toBeTruthy();
  expect(screen.getAllByText('new worker')).toHaveLength(2);
  expect(screen.getByText('1 to add · 0 to update · 0 to skip · 0 unchanged · 1 error')).toBeTruthy();
  expect((screen.getByRole('button', { name: /Add 1 worker/ }) as HTMLButtonElement).disabled).toBe(true);
});

const commitResult = {
  created: 1, updated: 1, skipped: 1, unchanged: 0,
  rows: [
    { row: 1, name: 'Bob Smith', person_id: 'p1', action: 'updated' as const,
      diff: { trade: { old: null, new: 'Cable' } } },
    { row: 2, name: 'Sara Jones', person_id: 'p2', action: 'skipped' as const,
      diff: { city: { old: null, new: 'Austin' } } },
    { row: 3, name: 'Maria Lopez', person_id: 'p3', action: 'created' as const, diff: null },
  ],
};

it('skips updates by default, Update all / Skip all toggle them, commits approved ids, renders the summary', async () => {
  api.previewWorkerBulk.mockResolvedValue({ can_commit: true, rows: [
    row({ row: 2, name: 'Bob Smith', action: 'update', matched_by: 'email, name', matched_name: 'Bob Smith',
          person_id: 'p1', diff: { trade: { old: null, new: 'Cable' } } }),
    row({ row: 3, name: 'Sara Jones', action: 'update', matched_by: 'phone', matched_name: 'Sara Jones',
          person_id: 'p2', diff: { city: { old: null, new: 'Austin' } },
          cells: { first_name: 'Sara', last_name: 'Jones', city: 'Austin' } }),
    row({ row: 4, name: 'Maria Lopez', cells: { first_name: 'Maria', last_name: 'Lopez' } }),
  ] });
  api.commitWorkerBulk.mockResolvedValue(commitResult);
  const onDone = vi.fn();
  renderUpload(onDone);
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('email, name')).toBeTruthy();
  expect(screen.getByText('phone')).toBeTruthy();
  // default: both updates skipped, adds alone make Apply available
  expect(screen.getByText('1 to add · 0 to update · 2 to skip · 0 unchanged · 0 errors')).toBeTruthy();
  const apply = () => screen.getByRole('button', { name: /^Add 1 worker and update \d workers?$/ }) as HTMLButtonElement;
  expect(apply().textContent).toBe('Add 1 worker and update 0 workers');
  expect(apply().disabled).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: 'Update all' }));
  expect(screen.getByText('1 to add · 2 to update · 0 to skip · 0 unchanged · 0 errors')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Skip all' }));
  expect(screen.getByText('1 to add · 0 to update · 2 to skip · 0 unchanged · 0 errors')).toBeTruthy();

  fireEvent.click(screen.getByLabelText('Update Bob Smith'));
  expect(apply().textContent).toBe('Add 1 worker and update 1 worker');
  fireEvent.click(apply());
  await waitFor(() => expect(api.commitWorkerBulk).toHaveBeenCalledWith(
    [{ first_name: 'Bob', last_name: 'Smith', status: '', country: '' },
     { first_name: 'Sara', last_name: 'Jones', city: 'Austin' },
     { first_name: 'Maria', last_name: 'Lopez' }],
    ['p1'], 'crew.csv'));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith({
    ...commitResult,
    rows: [{ ...commitResult.rows[0], row: 2 }, { ...commitResult.rows[1], row: 3 },
           { ...commitResult.rows[2], row: 4 }],
  }));
  expect(await screen.findByText('Applied: 1 added · 1 updated · 1 skipped · 0 unchanged')).toBeTruthy();
  const link = screen.getByRole('link', { name: 'Bob Smith' }) as HTMLAnchorElement;
  expect(link.getAttribute('href')).toMatch(/\/people\/workers\/p1$/);
  expect(screen.getByText('Skipped')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Download summary (.csv)' }));
  expect(listTools.exportCsv.mock.calls[0][0]).toBe('workers-bulk-summary');
});

it('disables Apply when nothing would be written (only skipped and unchanged rows)', async () => {
  api.previewWorkerBulk.mockResolvedValue({ can_commit: true, rows: [
    row({ row: 2, name: 'Bob Smith', action: 'update', matched_by: 'name', matched_name: 'Bob Smith',
          person_id: 'p1', diff: { trade: { old: null, new: 'Cable' } } }),
    row({ row: 3, name: 'Same Person', action: 'unchanged', matched_by: 'email', matched_name: 'Same Person',
          person_id: 'p9' }),
  ] });
  renderUpload();
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText('name');
  const apply = screen.getByRole('button', { name: 'Add 0 workers and update 0 workers' }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Update Bob Smith'));
  expect((screen.getByRole('button', { name: 'Add 0 workers and update 1 worker' }) as HTMLButtonElement).disabled).toBe(false);
});

it('shows the mapped error and clears the preview when the commit fails; a new file clears everything', async () => {
  api.previewWorkerBulk.mockResolvedValue({ can_commit: true, rows: [row({ row: 2 })] });
  api.commitWorkerBulk.mockRejectedValue(new ApiError(422, 'rows_invalid'));
  renderUpload();
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText('new worker');
  fireEvent.click(screen.getByRole('button', { name: /Add 1 worker/ }));
  expect(await screen.findByText('Some rows have problems — fix them and preview again.')).toBeTruthy();
  expect(screen.queryByText('new worker')).toBeNull();
  pickFile();
  expect(screen.queryByText('Some rows have problems — fix them and preview again.')).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/portal && npx vitest run src/components/workers/WorkerBulkUpload.test.tsx`
Expected: fails to resolve `./WorkerBulkUpload`.

- [ ] **Step 3: Create the component**

Create `portal/src/components/workers/WorkerBulkUpload.tsx`:

```tsx
/**
 * WorkerBulkUpload — the /bulk/workers page's upload pane. Pick a csv/xlsx
 * file, Preview renders per-row results (add / update / no change / error,
 * and which keys matched an existing person), matched rows are skipped
 * unless their Update box is ticked, and Apply posts the uploaded cells
 * plus the approved person ids.
 */

import { useRef, useState } from 'react';

import {
  ApiError,
  commitWorkerBulk,
  previewWorkerBulk,
  type WorkerBulkCommitResult,
  type WorkerBulkPreview,
  type WorkerBulkRowResult,
} from '../../lib/api';
import { WORKER_BULK_ERRORS } from '../../lib/workerBulk';
import BulkApplySummary from '../bulk/BulkApplySummary';
import DataTable from '../DataTable';

interface Props {
  onDone(result: WorkerBulkCommitResult): void;
}

const ACTION_LABEL: Record<WorkerBulkRowResult['action'], string> = {
  create: 'Add',
  update: 'Update',
  unchanged: 'No change',
  error: 'Error',
};

function describeDiff(
  diff: NonNullable<WorkerBulkRowResult['diff']>,
): { field: string; from: string; to: string }[] {
  return Object.entries(diff).map(([field, change]) => ({
    field,
    from: change.old === null || change.old === undefined ? '—' : String(change.old),
    to: String(change.new),
  }));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function WorkerBulkUpload({ onDone }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<WorkerBulkPreview | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<WorkerBulkCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mapError = (err: unknown): string =>
    err instanceof ApiError
      ? (WORKER_BULK_ERRORS[err.code] ?? 'Import failed — try again.')
      : 'Network error.';

  const runPreview = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setPreview(await previewWorkerBulk(file, file.name));
      setApproved(new Set());          // every matched row starts as a skip
    } catch (err) {
      setPreview(null);
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  const rows = preview?.rows ?? [];
  const adds = rows.filter((r) => r.action === 'create').length;
  const matched = rows.filter((r) => r.action === 'update');
  const updating = matched.filter((r) => r.person_id !== null && approved.has(r.person_id)).length;
  const skipping = matched.length - updating;
  const unchanged = rows.filter((r) => r.action === 'unchanged').length;
  const errors = rows.filter((r) => r.action === 'error').length;
  const canApply = !!preview && preview.can_commit && (adds > 0 || updating > 0);

  const runImport = async () => {
    if (!preview || !file) return;
    setBusy(true);
    setError('');
    try {
      // the ORIGINAL cells, never the preview's normalized `data` — replaying
      // `data` would write its create-only status/country defaults
      const posted = preview.rows.filter((r) => r.action !== 'error');
      const counts = await commitWorkerBulk(posted.map((r) => r.cells), [...approved], file.name);
      // The commit numbers rows from 1 (JSON path); the preview numbered the
      // spreadsheet lines from 2. Relabel so the summary ties back to the file.
      const applied = {
        ...counts,
        rows: counts.rows.map((r, i) => ({ ...r, row: posted[i]?.row ?? r.row })),
      };
      setPreview(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setResult(applied);
      onDone(applied);
    } catch (err) {
      setError(mapError(err));
      setPreview(null);   // stale after a failed commit — force re-preview
    } finally {
      setBusy(false);
    }
  };

  const toggle = (personId: string) =>
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });

  return (
    <div className="bulk-import">
      <div className="bulk-file-row">
        <label htmlFor="worker-bulk-file">Upload a file (.csv or .xlsx)</label>
        <input
          id="worker-bulk-file"
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setResult(null);
            setError('');
          }}
        />
      </div>

      <div className="bulk-actions">
        <button className="btn-solid" type="button" disabled={busy || !file}
                onClick={() => void runPreview()}>
          {busy ? 'Working…' : 'Preview'}
        </button>
        <button className="btn-solid" type="button" disabled={busy || !canApply}
                onClick={() => void runImport()}>
          {`Add ${plural(adds, 'worker')} and update ${plural(updating, 'worker')}`}
        </button>
        {matched.length > 0 && (
          <>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setApproved(new Set(matched.map((r) => r.person_id as string)))}>
              Update all
            </button>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setApproved(new Set())}>
              Skip all
            </button>
          </>
        )}
      </div>

      {error && <p className="pf-error">{error}</p>}

      {result && (
        <BulkApplySummary
          result={result}
          entityLabel="Worker"
          linkFor={(r) => `/people/workers/${r.person_id}`}
          filename="workers-bulk-summary"
          openTo="/people/workers"
          openLabel="Open Workers"
        />
      )}

      {preview && (
        <>
          <p className="set-note">
            {`${adds} to add · ${updating} to update · ${skipping} to skip · ${unchanged} unchanged · ${plural(errors, 'error')}`}
          </p>
          <DataTable
            ariaLabel="Import preview"
            className="bulk-preview"
            columns={[
              { key: 'row', label: 'Row', width: '64px', mono: true },
              { key: 'name', label: 'Name' },
              { key: 'matched_by', label: 'Matched by' },
              { key: 'action', label: 'Action' },
              { key: 'details', label: 'Details' },
            ]}
            rows={preview.rows.map((r) => {
              const willUpdate = r.person_id !== null && approved.has(r.person_id);
              return {
                key: String(r.row),
                className: `bulk-row-${r.action === 'update' && !willUpdate ? 'skipped' : r.action}`,
                cells: [
                  r.row,
                  r.name ?? '—',
                  r.matched_by ?? 'new worker',
                  r.action === 'update' ? (willUpdate ? 'Update' : 'Skip') : ACTION_LABEL[r.action],
                  <>
                    {r.action === 'error' && r.errors.map((e) => (
                      <span key={e} className="pf-error">{e}</span>
                    ))}
                    {r.action === 'update' && r.diff && (
                      <div className="bulk-diff">
                        {describeDiff(r.diff).map((d) => (
                          <span key={d.field}>{d.field}: {d.from} → {d.to}</span>
                        ))}
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`Update ${r.name}`}
                            checked={willUpdate}
                            disabled={busy}
                            onChange={() => r.person_id && toggle(r.person_id)}
                          />
                          {' '}Update
                        </label>
                      </div>
                    )}
                  </>,
                ],
              };
            })}
          />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the component test and the type check**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/portal && npx vitest run src/components/workers/WorkerBulkUpload.test.tsx && npx tsc --noEmit`
Expected: `4 passed`, `tsc` clean. If the `findByText('name')` in the third test collides with the "Name" column header, `getByText` is case-sensitive so `'name'` (lowercase, the matched_by cell) is unambiguous; if it still collides, change the test to `findByText('Bob Smith')`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers
git add portal/src/components/workers/WorkerBulkUpload.tsx portal/src/components/workers/WorkerBulkUpload.test.tsx
git commit -m "feat(portal): WorkerBulkUpload — preview with per-row update-or-skip, apply, summary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Portal — /bulk/workers page, launcher card, route, Workers toolbar button

**Files:**
- Create: `portal/src/pages/BulkWorkers.tsx`, `portal/src/pages/BulkWorkers.test.tsx`
- Modify: `portal/src/pages/BulkActions.tsx:25-32`, `portal/src/pages/BulkActions.test.tsx`
- Modify: `portal/src/App.tsx:15,204-206`
- Modify: `portal/src/pages/Workers.tsx:119,241,318-323`

**Interfaces:**
- Consumes: `WorkerBulkUpload` (Task 7), `WORKER_COLUMN_GUIDE`, `downloadWorkerTemplate`, `downloadWorkerExport` (Task 6).
- Produces: route `/bulk/workers`; `BULK_TOOLS` entry `key: 'workers'`.

- [ ] **Step 1: Write the failing page test**

Create `portal/src/pages/BulkWorkers.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({
  downloadWorkerTemplate: vi.fn(async () => {}), downloadWorkerExport: vi.fn(async () => {}),
  previewWorkerBulk: vi.fn(), commitWorkerBulk: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
afterEach(cleanup);
const { default: BulkWorkers } = await import('./BulkWorkers');

it('shows the column guide and the four downloads', async () => {
  render(<MemoryRouter><BulkWorkers /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Add or update workers in bulk' })).toBeTruthy();
  expect(screen.getByText('employee_number')).toBeTruthy();
  expect(screen.getByText('rfid_tag')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Current workers (.xlsx)' }));
  await waitFor(() => expect(api.downloadWorkerExport).toHaveBeenCalledWith('xlsx'));
  fireEvent.click(screen.getByRole('button', { name: 'Template (.csv)' }));
  await waitFor(() => expect(api.downloadWorkerTemplate).toHaveBeenCalledWith('csv'));
  expect(screen.getByText(
    'Uploads are limited to 1,000 rows and 5 MB. Larger exports need to be split before re-uploading.',
  )).toBeTruthy();
  expect(screen.getByLabelText('Upload a file (.csv or .xlsx)')).toBeTruthy();
});
```

Append to `portal/src/pages/BulkActions.test.tsx` (and extend the auth mock so `can` consults a `canWorkers` flag too):

Replace the `authMock` and `useAuth` mock with:

```tsx
const authMock = vi.hoisted(() => ({ canSites: true, canWorkers: true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: (resource: string) =>
      (resource === 'sites' ? authMock.canSites : resource === 'workers' ? authMock.canWorkers : true),
    preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
afterEach(() => {
  cleanup();
  authMock.canSites = true;
  authMock.canWorkers = true;
});
```

In `'renders the empty state until tools are added'`, also set `authMock.canWorkers = false;`. In the sites-card test, change `getByRole('button', { name: 'Open' })` to `getAllByRole('button', { name: 'Open' })` and assert length 2. Add:

```tsx
it('lists the workers card only when the viewer can add workers', () => {
  authMock.canWorkers = false;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.queryByText('Add or update workers in bulk')).toBeNull();
  cleanup();
  authMock.canWorkers = true;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByText('Add or update workers in bulk')).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/portal && npx vitest run src/pages/BulkWorkers.test.tsx src/pages/BulkActions.test.tsx`
Expected: page test fails to resolve; the workers-card test fails.

- [ ] **Step 3: Create the page**

Create `portal/src/pages/BulkWorkers.tsx`:

```tsx
/**
 * BulkWorkers — /bulk/workers: the column guide, template and export
 * downloads, then WorkerBulkUpload (upload → preview → apply).
 */
import { useState } from 'react';

import WorkerBulkUpload from '../components/workers/WorkerBulkUpload';
import DataTable from '../components/DataTable';
import { downloadWorkerExport, downloadWorkerTemplate } from '../lib/api';
import { WORKER_COLUMN_GUIDE } from '../lib/workerBulk';
import '../styles/bulk.css';

export default function BulkWorkers() {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const download = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try { await fn(); } catch { setError('Download failed — try again.'); } finally { setBusy(''); }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Bulk Actions</div>
      <h1 className="page-title">Add or update workers in bulk</h1>
      <p className="page-hint">
        Download the template or the current list, fill it in, upload it, and review every add before applying.
        Rows match existing people by email, phone, or name; matched rows are skipped unless you tick Update.
        Every imported person gets the worker role. Login accounts are not created here.
      </p>

      <section className="bulk-section">
        <p className="eyebrow-sm">Columns</p>
        <DataTable
          ariaLabel="Template columns"
          columns={[
            { key: 'key', label: 'Column', mono: true },
            { key: 'required', label: 'Required' },
            { key: 'accepts', label: 'Accepts' },
            { key: 'example', label: 'Example', mono: true },
          ]}
          rows={WORKER_COLUMN_GUIDE.map((c) => ({
            key: c.key, cells: [c.key, c.required ? 'Yes' : '', c.accepts, c.example || '—'],
          }))}
        />
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Download</p>
        <div className="bulk-actions">
          <button className="mini-btn" disabled={!!busy} onClick={() => void download('t-xlsx', () => downloadWorkerTemplate('xlsx'))}>Template (.xlsx)</button>
          <button className="mini-btn" disabled={!!busy} onClick={() => void download('t-csv', () => downloadWorkerTemplate('csv'))}>Template (.csv)</button>
          <button className="mini-btn accent" disabled={!!busy} onClick={() => void download('e-xlsx', () => downloadWorkerExport('xlsx'))}>Current workers (.xlsx)</button>
          <button className="mini-btn accent" disabled={!!busy} onClick={() => void download('e-csv', () => downloadWorkerExport('csv'))}>Current workers (.csv)</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
        <p className="set-note">
          Uploads are limited to 1,000 rows and 5 MB. Larger exports need to be split before re-uploading.
        </p>
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Upload</p>
        <WorkerBulkUpload onDone={() => {}} />
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Register the card, the route, and the toolbar button**

In `portal/src/pages/BulkActions.tsx`, append to `BULK_TOOLS`:

```ts
  {
    key: 'workers', title: 'Add or update workers in bulk',
    description: 'Load a crew list from a spreadsheet. Existing people match by email, phone, or name; update or skip each one.',
    resource: 'workers', action: 'add', to: '/bulk/workers', button: 'Open',
  },
```

In `portal/src/App.tsx`, add `import BulkWorkers from './pages/BulkWorkers';` after the `BulkSites` import, and after the `/bulk/sites` route add:

```tsx
                <Route path="/bulk/workers" element={
                  <ProtectedRoute resource="workers" minRank={ADMIN_RANK}><BulkWorkers /></ProtectedRoute>
                } />
```

In `portal/src/pages/Workers.tsx`: change `const { can, godMode } = useAuth();` (line 119) to `const { can, godMode, maxRank } = useAuth();`, after `const canManage = can('workers', 'change');` (line 241) add `const canBulk = can('workers', 'add') && maxRank >= 60;   // mirrors the API's GATE_BYPASS_RANK bar`, and after the `+ Add worker` button block (line 323) add:

```tsx
          {canBulk && (
            <button className="mini-btn accent" onClick={() => navigate('/bulk/workers')}>
              Bulk import…
            </button>
          )}
```

- [ ] **Step 5: Run the page, launcher, and Workers tests plus the type check**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/portal && npx vitest run src/pages/BulkWorkers.test.tsx src/pages/BulkActions.test.tsx src/pages/Workers && npx tsc --noEmit`
Expected: all pass, `tsc` clean. If a Workers page test mocks `useAuth` without `maxRank`, `maxRank >= 60` is `false` and the button simply doesn't render; no test change needed.

- [ ] **Step 6: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers
git add portal/src/pages/BulkWorkers.tsx portal/src/pages/BulkWorkers.test.tsx portal/src/pages/BulkActions.tsx portal/src/pages/BulkActions.test.tsx portal/src/App.tsx portal/src/pages/Workers.tsx
git commit -m "feat(portal): /bulk/workers page, Bulk Actions card, Workers toolbar button

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Full suites, build, and parity workbook note

**Files:**
- Modify: `docs/feature-parity-v2-v3.md` (only if it lists the team-member importer as not built; `grep -n "team members" docs/feature-parity-v2-v3.md`)

- [ ] **Step 1: Run the full API suite**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_workers .venv/bin/pytest -q -x --timeout=1200 2>&1 | tail -20` (foreground, timeout 600000; if pytest-timeout is not installed drop the `--timeout` flag).
Expected: all pass except the two known WeasyPrint environment failures if the host lacks the dylib symlinks (they are not related to this work; report them by name).

- [ ] **Step 2: Run the full portal suite and build**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers/portal && npx vitest run 2>&1 | tail -15 && npx tsc --noEmit && npm run build 2>&1 | tail -5` (foreground, timeout 600000).
Expected: all pass, clean build.

- [ ] **Step 3: Record the outcome**

If `docs/feature-parity-v2-v3.md` lists "Import team members in bulk" with a status, update that status to `Built` with a one-line note `(/bulk/workers, 2026-09-22)`. Do not edit the xlsx.

- [ ] **Step 4: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-workers
git checkout -- api/src/serversherpa/_dev_reload.py 2>/dev/null
git add -A docs/feature-parity-v2-v3.md
git commit -m "docs: parity note for the workers bulk importer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" || echo "nothing to commit"
```

Live verification against the dev stack is done by the orchestrator after this task (see the spec's Testing section), not by the implementer.
