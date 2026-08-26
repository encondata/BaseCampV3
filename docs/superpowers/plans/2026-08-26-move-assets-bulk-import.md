# Move Assets Bulk Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port BaseCampV2's move upload-ft bulk import to V3 as a separate worker process fed by a Postgres job queue, with a validate→commit flow and a dedicated portal page.

**Architecture:** The API stores the uploaded CSV/XLSX to MinIO/Spaces and inserts an `import_jobs` row; a new `serversherpa import-worker` process claims queued jobs with `FOR UPDATE SKIP LOCKED` and runs the ported V2 pipeline (make/model fuzzy/force/hybrid, serial generation, RFID skip-and-flag, per-row create/attach/update, collision detection). The portal polls job status. The API never parses files or writes import rows.

**Tech Stack:** Alembic/SQLAlchemy/FastAPI/typer/openpyxl/boto3 (api/), React+TypeScript+vitest (portal/).

**Spec:** `docs/superpowers/specs/2026-08-26-move-assets-bulk-import-design.md` (approved).

## Global Constraints

- Work on branch `feature/initiatives` in the main checkout `/Users/jrh1812/Developer/BaseCampV3`.
- Migration numbering: **0023 revises 0022**. If the branch gains a 0023 first, renumber ours.
- API tests: `cd api && .venv/bin/pytest tests/<file> -q`. The docker dev stack must be up (`docker compose -f docker-compose.dev.yml up -d`) — tests use the dockerized Postgres (port 5433) and REAL MinIO (attachments tests already do).
- Portal tests: `cd portal && npx vitest run <file>`; type check with `npx tsc --noEmit`.
- Spreadsheet headers are V2-verbatim (existing FT files must keep working): `Serial Number`, `Asset Name`, `Asset Make`, `Asset Model`, `RFID Tag`, `Priority`, `Disposition`, `Owner`, `Source Rack`, `Source RU`, `Destination Rack`, `Destination RU`, `Data 1`–`Data 6`, `Mgmt 1`–`Mgmt 2`, `Vendor Involvement` (and v2's misspelling `Vendor Involvment`), all matched case-insensitively.
- Numbers pinned by the spec: file limit **20 MB**; commit batch size **500** rows; worker idle poll **2 s**; stale-`running` requeue threshold **10 min**.
- Per-row commit semantics (good rows land, bad rows reported). Validate mode NEVER writes.
- Roster rows touched by an import get `status='loaded_in_system'` (V2 parity: re-upload resets workflow status) and `raw_ft` = the complete original row.
- Import surfaces gate on `require_permission("initiatives", "change")`; non-move initiatives → 422 `not_a_move`.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration 0023 + ImportJob model + conftest

**Files:**
- Create: `api/migrations/versions/0023_import_jobs.py`
- Modify: `api/src/serversherpa/db/models.py` (InitiativeAsset ~line 645; new ImportJob class after ContainerAsset/InitiativeAsset)
- Modify: `api/tests/conftest.py` (~line 55 TRUNCATE list)
- Test: `api/tests/test_import_jobs_model.py`

**Interfaces:**
- Produces: table `import_jobs` + ORM class `ImportJob` (fields listed below); `InitiativeAsset.raw_ft: Mapped[dict | None]` and `InitiativeAsset.label_info: Mapped[dict | None]` (JSONB). Every later task relies on these exact names.

- [ ] **Step 1: Write the failing model test**

Create `api/tests/test_import_jobs_model.py`:

```python
"""import_jobs table + the two deferred v2 columns on initiative_assets."""

from serversherpa.db.models import (
    Asset, ImportJob, Initiative, InitiativeAsset,
)


async def _move(db):
    ini = Initiative(name="Move X", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    return ini


async def test_import_job_defaults(db):
    ini = await _move(db)
    job = ImportJob(kind="move_assets", initiative_id=ini.id,
                    filename="ft.csv")
    db.add(job)
    await db.commit()
    await db.refresh(job)
    assert job.phase == "validate"
    assert job.status == "queued"
    assert job.file_key == ""
    assert job.options == {}
    assert (job.total_rows, job.processed_rows) == (0, 0)
    assert (job.created_count, job.updated_count, job.error_count) == (0, 0, 0)
    assert job.results is None
    assert job.cancel_requested is False
    assert job.error is None
    assert job.progress_at is None and job.started_at is None
    assert job.finished_at is None
    assert job.created_at is not None


async def test_initiative_asset_raw_ft_and_label_info(db):
    ini = await _move(db)
    asset = Asset(serial_number="sn-raw")
    db.add(asset)
    await db.flush()
    assoc = InitiativeAsset(
        initiative_id=ini.id, asset_id=asset.id,
        raw_ft={"Serial Number": "sn-raw", "Extra Col": "kept"})
    db.add(assoc)
    await db.commit()
    await db.refresh(assoc)
    assert assoc.raw_ft == {"Serial Number": "sn-raw", "Extra Col": "kept"}
    assert assoc.label_info is None
```

- [ ] **Step 2: Run it — must fail (no ImportJob, no migration)**

Run: `cd api && .venv/bin/pytest tests/test_import_jobs_model.py -q`
Expected: FAIL with `ImportError: cannot import name 'ImportJob'`.

- [ ] **Step 3: Write migration 0023**

Create `api/migrations/versions/0023_import_jobs.py`:

```python
"""Move-assets bulk import: the import_jobs queue table (claimed by the
separate import-worker process with FOR UPDATE SKIP LOCKED), plus the two
v2-parity columns deferred to this slice — initiative_assets.raw_ft (the
complete original spreadsheet row; nothing from an upload is dropped) and
label_info (unused until label printing lands).

Revision ID: 0023
Revises: 0022
Create Date: 2026-08-26
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("initiative_assets", sa.Column("raw_ft", JSONB))
    op.add_column("initiative_assets", sa.Column("label_info", JSONB))

    op.create_table(
        "import_jobs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id")),
        sa.Column("filename", sa.Text, nullable=False),
        sa.Column("file_key", sa.Text, nullable=False, server_default=""),
        sa.Column("options", JSONB, nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("phase", sa.Text, nullable=False,
                  server_default="validate"),
        sa.Column("status", sa.Text, nullable=False,
                  server_default="queued"),
        sa.Column("total_rows", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("processed_rows", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("created_count", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("updated_count", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("error_count", sa.Integer, nullable=False,
                  server_default="0"),
        sa.Column("results", JSONB),
        sa.Column("cancel_requested", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("error", sa.Text),
        sa.Column("progress_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("started_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("finished_at", sa.TIMESTAMP(timezone=True)),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("import_jobs_queue_idx", "import_jobs",
                    ["status", "created_at"])


def downgrade() -> None:
    op.drop_table("import_jobs")
    op.drop_column("initiative_assets", "label_info")
    op.drop_column("initiative_assets", "raw_ft")
```

- [ ] **Step 4: Add the ORM pieces**

In `api/src/serversherpa/db/models.py`, inside `class InitiativeAsset`, after the `vendor_involved` line and before `status`, add:

```python
    raw_ft: Mapped[dict | None] = mapped_column(JSONB)
    label_info: Mapped[dict | None] = mapped_column(JSONB)
```

After the full `InitiativeAsset` class, add:

```python
class ImportJob(Base):
    """Queued background import work. The API only creates rows and serves
    status; the separate import-worker process claims queued rows
    (FOR UPDATE SKIP LOCKED) and does all parsing and writing — an import
    can never affect API readiness or response times."""

    __tablename__ = "import_jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    kind: Mapped[str]                       # 'move_assets' (only kind yet)
    initiative_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("initiatives.id", ondelete="CASCADE"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    filename: Mapped[str]
    file_key: Mapped[str] = mapped_column(server_default="")
    options: Mapped[dict] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"))
    phase: Mapped[str] = mapped_column(server_default="validate")
    status: Mapped[str] = mapped_column(server_default="queued")
    total_rows: Mapped[int] = mapped_column(Integer, server_default="0")
    processed_rows: Mapped[int] = mapped_column(Integer, server_default="0")
    created_count: Mapped[int] = mapped_column(Integer, server_default="0")
    updated_count: Mapped[int] = mapped_column(Integer, server_default="0")
    error_count: Mapped[int] = mapped_column(Integer, server_default="0")
    results: Mapped[dict | None] = mapped_column(JSONB)
    cancel_requested: Mapped[bool] = mapped_column(server_default=text("false"))
    error: Mapped[str | None]
    progress_at: Mapped[datetime | None]
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

(`JSONB`, `Integer`, `ForeignKey`, `text`, `uuid`, `datetime` are already imported in models.py.)

In `api/tests/conftest.py`, add `import_jobs` to the TRUNCATE list — change the fragment

```
"initiative_links, initiative_people, initiatives, "
```

to

```
"initiative_links, initiative_people, initiatives, import_jobs, "
```

- [ ] **Step 5: Run the test — must pass**

Run: `cd api && .venv/bin/pytest tests/test_import_jobs_model.py -q`
Expected: 2 passed. (conftest migrates the test DB to head automatically.)

- [ ] **Step 6: Commit**

```bash
git add api/migrations/versions/0023_import_jobs.py api/src/serversherpa/db/models.py api/tests/conftest.py api/tests/test_import_jobs_model.py
git commit -m "feat(api): import_jobs queue table + raw_ft/label_info on initiative_assets (0023)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: imports package — file parsing + templates

**Files:**
- Create: `api/src/serversherpa/imports/__init__.py` (empty)
- Create: `api/src/serversherpa/imports/parsing.py`
- Test: `api/tests/test_move_asset_import_parsing.py`

**Interfaces:**
- Produces:
  - `parse_upload(filename: str, content: bytes) -> list[tuple[int, dict, dict]]` — each item is `(row_number, canonical, raw)`; `canonical` maps every name in `CANONICAL` to trimmed cell text (`""` when absent); `raw` maps the ORIGINAL header text → trimmed cell text (unknown columns included).
  - `CANONICAL: list[str]` = `["serial_number", "asset_name", "asset_make", "asset_model", "rfid_tag", "priority", "disposition", "owner", "source_rack", "source_ru", "destination_rack", "destination_ru", "data_1", "data_2", "data_3", "data_4", "data_5", "data_6", "mgmt_1", "mgmt_2", "vendor_involvement"]`
  - `ImportFileError(code, **extra)` exception with `.code`/`.extra` (mirrors sites `BulkImportError`).
  - `build_template_csv() -> str`, `build_template_xlsx() -> bytes`, `TEMPLATE_HEADERS`, `SAMPLE_ROWS`, `MAX_BYTES = 20 * 1024 * 1024`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_move_asset_import_parsing.py`:

```python
"""Move-asset import file parsing: CSV/XLSX -> numbered rows, V2 headers."""

import io

import openpyxl
import pytest

from serversherpa.imports.parsing import (
    CANONICAL, MAX_BYTES, SAMPLE_ROWS, TEMPLATE_HEADERS, ImportFileError,
    build_template_csv, build_template_xlsx, parse_upload,
)

CSV = (
    "Serial Number,Asset Name,Asset Make,Asset Model,Source RU,Data 1,"
    "Mgmt 1,Vendor Involvment,Extra Col\n"
    "SN-1,web-01,Dell,R740,12,sw1:e1,m1,,note\n"
    ",,,,,,,,\n"
    "SN-2,db-01,HPE,DL380,3.5,,,yes,\n"
).encode()


def _xlsx(rows: list[list]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_csv_parses_to_canonical_and_raw():
    rows = parse_upload("ft.csv", CSV)
    assert [n for n, _, _ in rows] == [2, 4]      # blank line 3 skipped
    n, canonical, raw = rows[0]
    assert canonical["serial_number"] == "SN-1"
    assert canonical["asset_name"] == "web-01"
    assert canonical["asset_make"] == "Dell"
    assert canonical["source_ru"] == "12"
    assert canonical["data_1"] == "sw1:e1"
    assert canonical["mgmt_1"] == "m1"
    assert canonical["vendor_involvement"] == ""
    assert raw["Extra Col"] == "note"             # unknown column preserved
    assert set(canonical) == set(CANONICAL)
    # v2's misspelling maps too
    assert rows[1][1]["vendor_involvement"] == "yes"


def test_headers_case_insensitive():
    content = b"SERIAL NUMBER,asset name\nsn-9,x\n"
    [(_, canonical, _)] = parse_upload("a.csv", content)
    assert canonical["serial_number"] == "sn-9"
    assert canonical["asset_name"] == "x"


def test_xlsx_matches_csv():
    content = _xlsx([["Serial Number", "Asset Name", "Source RU"],
                     ["SN-1", "web-01", 12]])
    [(n, canonical, raw)] = parse_upload("ft.xlsx", content)
    assert n == 2
    assert canonical["serial_number"] == "SN-1"
    assert canonical["source_ru"] == "12"         # 12.0 -> "12"


def test_missing_serial_column_is_a_file_error():
    with pytest.raises(ImportFileError) as e:
        parse_upload("a.csv", b"Asset Name\nweb-01\n")
    assert e.value.code == "missing_serial_column"


def test_unsupported_and_invalid_files():
    with pytest.raises(ImportFileError) as e:
        parse_upload("a.txt", b"x")
    assert e.value.code == "unsupported_file"
    with pytest.raises(ImportFileError) as e:
        parse_upload("a.xlsx", b"not a zip")
    assert e.value.code == "invalid_xlsx"
    with pytest.raises(ImportFileError) as e:
        parse_upload("a.csv", b"x" * (MAX_BYTES + 1))
    assert e.value.code == "file_too_large"


def test_template_csv_headers_and_roundtrip():
    text = build_template_csv()
    assert text.splitlines()[0] == ",".join(TEMPLATE_HEADERS)
    rows = parse_upload("t.csv", text.encode())
    assert len(rows) == len(SAMPLE_ROWS)
    assert rows[0][1]["serial_number"] == SAMPLE_ROWS[0]["Serial Number"]


def test_template_xlsx_has_reference_sheet():
    wb = openpyxl.load_workbook(io.BytesIO(build_template_xlsx()))
    assert wb.sheetnames == ["Move Assets", "Reference"]
    header = [c.value for c in next(wb["Move Assets"].iter_rows(max_row=1))]
    assert header == TEMPLATE_HEADERS
    rows = parse_upload("t.xlsx", build_template_xlsx())
    assert len(rows) == len(SAMPLE_ROWS)
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_move_asset_import_parsing.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'serversherpa.imports'`.

- [ ] **Step 3: Implement**

Create empty `api/src/serversherpa/imports/__init__.py`, then `api/src/serversherpa/imports/parsing.py`:

```python
"""Move-asset import file parsing: CSV/XLSX bytes -> numbered rows.

Headers are V2's upload-ft template verbatim (case-insensitive, including
v2's 'Vendor Involvment' misspelling) so existing facility-tracker
spreadsheets keep working. Unknown columns are NOT errors — they ride
along in the per-row `raw` dict and land in initiative_assets.raw_ft.
"""

import csv
import io
from typing import Any

MAX_BYTES = 20 * 1024 * 1024

CANONICAL = [
    "serial_number", "asset_name", "asset_make", "asset_model", "rfid_tag",
    "priority", "disposition", "owner", "source_rack", "source_ru",
    "destination_rack", "destination_ru",
    "data_1", "data_2", "data_3", "data_4", "data_5", "data_6",
    "mgmt_1", "mgmt_2", "vendor_involvement",
]

HEADER_MAP = {
    "serial number": "serial_number", "asset name": "asset_name",
    "asset make": "asset_make", "asset model": "asset_model",
    "rfid tag": "rfid_tag", "priority": "priority",
    "disposition": "disposition", "owner": "owner",
    "source rack": "source_rack", "source ru": "source_ru",
    "destination rack": "destination_rack",
    "destination ru": "destination_ru",
    "data 1": "data_1", "data 2": "data_2", "data 3": "data_3",
    "data 4": "data_4", "data 5": "data_5", "data 6": "data_6",
    "mgmt 1": "mgmt_1", "mgmt 2": "mgmt_2",
    "vendor involvement": "vendor_involvement",
    "vendor involvment": "vendor_involvement",   # v2 template's spelling
}

TEMPLATE_HEADERS = [
    "Serial Number", "Asset Name", "Asset Make", "Asset Model", "RFID Tag",
    "Priority", "Disposition", "Owner", "Source Rack", "Source RU",
    "Destination Rack", "Destination RU", "Data 1", "Data 2", "Data 3",
    "Data 4", "Data 5", "Data 6", "Mgmt 1", "Mgmt 2", "Vendor Involvement",
]

SAMPLE_ROWS: list[dict] = [
    {"Serial Number": "SN-0001", "Asset Name": "web-01", "Asset Make": "Dell",
     "Asset Model": "PowerEdge R740", "RFID Tag": "", "Priority": "Wave 1",
     "Disposition": "Relocate", "Owner": "Platform",
     "Source Rack": "11.01.01.01A.02", "Source RU": "12",
     "Destination Rack": "BJ08", "Destination RU": "24",
     "Data 1": "sw1:eth1/1", "Data 2": "", "Data 3": "", "Data 4": "",
     "Data 5": "", "Data 6": "", "Mgmt 1": "mgmt-sw:1", "Mgmt 2": "",
     "Vendor Involvement": ""},
    {"Serial Number": "SN-0002", "Asset Name": "san-01", "Asset Make": "HPE",
     "Asset Model": "Nimble HF20", "RFID Tag": "", "Priority": "Wave 2",
     "Disposition": "", "Owner": "", "Source Rack": "BJ01",
     "Source RU": "3.5", "Destination Rack": "", "Destination RU": "",
     "Data 1": "", "Data 2": "", "Data 3": "", "Data 4": "", "Data 5": "",
     "Data 6": "", "Mgmt 1": "", "Mgmt 2": "", "Vendor Involvement": "yes"},
]


class ImportFileError(Exception):
    """Whole-file failure (not a per-row error)."""

    def __init__(self, code: str, **extra: Any) -> None:
        super().__init__(code)
        self.code = code
        self.extra = extra


def _cell(value: Any) -> str:
    """Spreadsheet cells arrive as str/float/int/bool/None — normalize to
    trimmed text. Integral floats (openpyxl's 12.0) drop the .0 so
    numeric-looking text columns round-trip."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _check_serial_header(headers: list[str]) -> None:
    if not any(HEADER_MAP.get(h.lower()) == "serial_number" for h in headers):
        raise ImportFileError("missing_serial_column")


def _numbered(raw_rows: list[dict], first_row: int,
              ) -> list[tuple[int, dict, dict]]:
    out: list[tuple[int, dict, dict]] = []
    for i, raw in enumerate(raw_rows):
        text_row = {(k or "").strip(): _cell(v) for k, v in raw.items()
                    if (k or "").strip()}
        canonical = {c: "" for c in CANONICAL}
        for header, value in text_row.items():
            field = HEADER_MAP.get(header.lower())
            if field:
                canonical[field] = value
        if any(v != "" for v in text_row.values()):   # skip fully blank lines
            out.append((first_row + i, canonical, text_row))
    return out


def parse_upload(filename: str, content: bytes,
                 ) -> list[tuple[int, dict, dict]]:
    if len(content) > MAX_BYTES:
        raise ImportFileError("file_too_large", limit=MAX_BYTES)
    name = filename.lower()
    if name.endswith(".csv"):
        try:
            reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
        except UnicodeDecodeError:
            raise ImportFileError("invalid_csv") from None
        if reader.fieldnames is None:
            raise ImportFileError("invalid_csv")
        _check_serial_header([f.strip() for f in reader.fieldnames if f])
        rows = [{(k or "").strip(): v for k, v in r.items() if k}
                for r in reader]
        return _numbered(rows, first_row=2)
    if name.endswith((".xlsx", ".xls")):
        import openpyxl
        try:
            wb = openpyxl.load_workbook(io.BytesIO(content),
                                        read_only=True, data_only=True)
        except Exception:
            raise ImportFileError("invalid_xlsx") from None
        ws = wb.worksheets[0]
        lines = ws.iter_rows(values_only=True)
        header = [_cell(h) for h in (next(lines, None) or tuple())]
        header = [h for h in header if h]
        if not header:
            raise ImportFileError("invalid_xlsx")
        _check_serial_header(header)
        rows = [dict(zip(header, line)) for line in lines]
        return _numbered(rows, first_row=2)
    raise ImportFileError("unsupported_file")


def build_template_csv() -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=TEMPLATE_HEADERS,
                            lineterminator="\n")
    writer.writeheader()
    writer.writerows(SAMPLE_ROWS)
    return buf.getvalue()


def build_template_xlsx() -> bytes:
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Move Assets"
    ws.append(TEMPLATE_HEADERS)
    for row in SAMPLE_ROWS:
        ws.append([row[c] for c in TEMPLATE_HEADERS])
    ref = wb.create_sheet("Reference")
    ref.append(["Required column"])
    ref.append(["Serial Number (or enable serial generation with a "
                "non-blank Asset Name)"])
    ref.append([])
    ref.append(["Make/model modes"])
    ref.append(["fuzzy — match catalog + aliases; unmatched rows need review"])
    ref.append(["force — always create missing make/models"])
    ref.append(["hybrid — match first, create when unmatched"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
```

- [ ] **Step 4: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_move_asset_import_parsing.py -q`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/imports/ api/tests/test_move_asset_import_parsing.py
git commit -m "feat(api): move-asset import file parsing — V2 headers, templates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Row parsing helpers (V2 upload_helpers port)

**Files:**
- Create: `api/src/serversherpa/imports/move_assets.py`
- Test: `api/tests/test_move_asset_import_rows.py`

**Interfaces:**
- Consumes: `CANONICAL`-shaped dicts from Task 2's `parse_upload`.
- Produces (in `serversherpa.imports.move_assets`):
  - `resolve_make_model_for_creation(asset_make: str, asset_model: str) -> tuple[str, str]` — V2 port.
  - `generate_serial(asset_name: str) -> str` — `<name lowercased>.<13 digits>`.
  - `parse_row(n: int, canonical: dict, raw: dict, *, generate_serials: bool) -> dict` — error entries are `{"row", "serial_number": "", "status": "error", "message"}`; ok entries have `"status": "ok"` plus the typed fields shown below (Tasks 4–5 consume them verbatim): `serial_number` (lowercased), `asset_name` (lowercased, falls back to serial), `asset_make`, `asset_model`, `make_model_str` (`"make model"` / whichever half is present / `None`), `serial_generated: bool`, `rfid_tag: str` (`""` when blank), `priority_wave: str | None` (≤30 chars), `disposition/owner/source_rack/destination_rack: str | None`, `source_ru/destination_ru: float | None`, `vendor_involved: bool`, `cable_info: dict`, `raw_ft: dict`, `notes: list[str]`.
  - `PRIORITY_MAX = 30`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_move_asset_import_rows.py`:

```python
"""Pure row-parsing helpers ported from V2's upload path."""

import re

from serversherpa.imports.move_assets import (
    PRIORITY_MAX, generate_serial, parse_row,
    resolve_make_model_for_creation,
)


def _canonical(**over):
    from serversherpa.imports.parsing import CANONICAL
    row = {c: "" for c in CANONICAL}
    row.update(over)
    return row


def test_resolve_make_model_split_and_dedup():
    # both halves present: unchanged (minus duplicated make prefix)
    assert resolve_make_model_for_creation("Dell", "R640") == ("Dell", "R640")
    assert resolve_make_model_for_creation("Dell", "Dell R640") == ("Dell", "R640")
    assert resolve_make_model_for_creation("Dell", "Dell Dell R640") == ("Dell", "R640")
    # only model: split on first space
    assert resolve_make_model_for_creation("", "Dell R640") == ("Dell", "R640")
    assert resolve_make_model_for_creation("", "R640") == ("R640", "R640")
    # only make: split on first space
    assert resolve_make_model_for_creation("Dell R640", "") == ("Dell", "R640")
    # model exactly equal to make is left alone
    assert resolve_make_model_for_creation("Dell", "Dell") == ("Dell", "Dell")


def test_generate_serial_format():
    serial = generate_serial(" Web-01 ")
    assert re.fullmatch(r"web-01\.\d{13}", serial)


def test_missing_serial_is_an_error():
    out = parse_row(2, _canonical(), {}, generate_serials=False)
    assert out["status"] == "error"
    assert out["message"] == "Missing required field: Serial Number"
    out = parse_row(2, _canonical(), {}, generate_serials=True)
    assert out["status"] == "error"
    assert "Asset Name is also blank" in out["message"]


def test_serial_generation_path():
    out = parse_row(2, _canonical(asset_name="Web-01"), {},
                    generate_serials=True)
    assert out["status"] == "ok"
    assert out["serial_generated"] is True
    assert re.fullmatch(r"web-01\.\d{13}", out["serial_number"])


def test_typed_fields_and_lowering():
    raw = {"Serial Number": "SN-9", "Weird": "kept"}
    out = parse_row(3, _canonical(
        serial_number="SN-9", asset_make="Dell", asset_model="R740",
        source_ru="12", destination_ru="junk", priority="P" * 40,
        data_1="sw1", mgmt_2="m2", vendor_involvement="x",
    ), raw, generate_serials=False)
    assert out["status"] == "ok"
    assert out["serial_number"] == "sn-9"
    assert out["asset_name"] == "sn-9"          # falls back to serial
    assert out["make_model_str"] == "Dell R740"
    assert out["source_ru"] == 12.0
    assert out["destination_ru"] is None        # unparseable -> None
    assert out["priority_wave"] == "P" * PRIORITY_MAX
    assert any("truncated" in n for n in out["notes"])
    assert out["cable_info"] == {"data_1": "sw1", "mgmt_2": "m2"}
    assert out["vendor_involved"] is True
    assert out["raw_ft"] == raw


def test_make_model_str_single_half():
    assert parse_row(2, _canonical(serial_number="s", asset_model="R740"),
                     {}, generate_serials=False)["make_model_str"] == "R740"
    assert parse_row(2, _canonical(serial_number="s", asset_make="Dell"),
                     {}, generate_serials=False)["make_model_str"] == "Dell"
    assert parse_row(2, _canonical(serial_number="s"),
                     {}, generate_serials=False)["make_model_str"] is None
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_move_asset_import_rows.py -q`
Expected: FAIL with `ModuleNotFoundError` / `ImportError` on `move_assets`.

- [ ] **Step 3: Implement**

Create `api/src/serversherpa/imports/move_assets.py`:

```python
"""Move-assets import pipeline (V2 upload-ft parity on the V3 schema).

Pure of HTTP and job-queue concerns: callers hand in parsed rows and
options and get back the report dict that lands in import_jobs.results.
This module grows in three stages: row helpers (this slice), the
validate/commit pipeline, and collision detection.
"""

import random

PRIORITY_MAX = 30


def resolve_make_model_for_creation(asset_make: str,
                                    asset_model: str) -> tuple[str, str]:
    """(make, model) to insert into asset_models — ported from V2's
    upload_helpers: single-populated field splits on first space, then a
    duplicated make prefix is stripped from the model (at most twice) so
    Make='Dell' + Model='Dell R640' stores model='R640'. Model exactly
    equal to make is left alone."""
    make = (asset_make or "").strip()
    model = (asset_model or "").strip()
    if not make and model:
        parts = model.split(" ", 1)
        make = parts[0]
        model = parts[1] if len(parts) > 1 else parts[0]
    elif make and not model:
        parts = make.split(" ", 1)
        make = parts[0]
        model = parts[1] if len(parts) > 1 else ""
    for _ in range(2):
        if make and model.lower().startswith(make.lower() + " "):
            model = model[len(make) + 1:].strip()
    return make, model


def generate_serial(asset_name: str) -> str:
    """V2 format: lowercase_name.13_random_digits."""
    digits = "".join(str(random.randint(0, 9)) for _ in range(13))
    return f"{asset_name.strip().lower()}.{digits}"


def _float(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def parse_row(n: int, canonical: dict, raw: dict, *,
              generate_serials: bool) -> dict:
    """One spreadsheet row -> typed import row, or an error entry."""
    serial = canonical["serial_number"].strip()
    name_raw = canonical["asset_name"].strip()
    serial_generated = False
    if not serial:
        if generate_serials and name_raw:
            serial = generate_serial(name_raw)
            serial_generated = True
        else:
            message = ("Missing required field: Serial Number"
                       if not generate_serials
                       else "Cannot generate serial: Asset Name is also blank")
            return {"row": n, "serial_number": "", "status": "error",
                    "message": message}
    serial = serial.lower()

    make = canonical["asset_make"].strip()
    model = canonical["asset_model"].strip()
    make_model_str = (f"{make} {model}" if make and model
                      else model or make or None)

    cable_info: dict = {}
    for i in range(1, 7):
        if value := canonical[f"data_{i}"].strip():
            cable_info[f"data_{i}"] = value
    for i in range(1, 3):
        if value := canonical[f"mgmt_{i}"].strip():
            cable_info[f"mgmt_{i}"] = value

    notes: list[str] = []
    priority = canonical["priority"].strip() or None
    if priority and len(priority) > PRIORITY_MAX:
        notes.append(f"Priority truncated to {PRIORITY_MAX} characters")
        priority = priority[:PRIORITY_MAX]

    def _ru(field: str) -> float | None:
        text = canonical[field].strip()
        return _float(text) if text else None

    return {
        "row": n, "status": "ok",
        "serial_number": serial,
        "asset_name": (name_raw or serial).lower(),
        "asset_make": make, "asset_model": model,
        "make_model_str": make_model_str,
        "serial_generated": serial_generated,
        "rfid_tag": canonical["rfid_tag"].strip(),
        "priority_wave": priority,
        "disposition": canonical["disposition"].strip() or None,
        "owner": canonical["owner"].strip() or None,
        "source_rack": canonical["source_rack"].strip() or None,
        "source_ru": _ru("source_ru"),
        "destination_rack": canonical["destination_rack"].strip() or None,
        "destination_ru": _ru("destination_ru"),
        "vendor_involved": bool(canonical["vendor_involvement"].strip()),
        "cable_info": cable_info,
        "raw_ft": raw,
        "notes": notes,
    }
```

- [ ] **Step 4: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_move_asset_import_rows.py -q`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/imports/move_assets.py api/tests/test_move_asset_import_rows.py
git commit -m "feat(api): move-asset import row parsing — V2 upload_helpers port

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Pipeline — validate pass (no writes)

**Files:**
- Modify: `api/src/serversherpa/imports/move_assets.py`
- Test: `api/tests/test_move_asset_import_validate.py`

**Interfaces:**
- Consumes: `parse_row` outputs (Task 3); `ImportJob` unused here.
- Produces:
  - `async run_import(db, *, initiative_id: uuid.UUID, added_by: uuid.UUID | None, rows: list[dict], make_model_mode: str = "fuzzy", write: bool, source_label: str = "", progress: ProgressFn | None = None, is_cancelled: CancelledFn | None = None) -> dict` returning `{"summary": {"total_rows", "processed_rows", "created", "updated", "review", "errors", ...}, "details": [...], "cancelled": bool}`. Detail entries: `{"row", "serial_number", "status": "created"|"updated"|"review"|"error", "message", "asset_id": str|None, "asset_created": bool, "serial_generated": bool, "match_method": "exact"|"fuzzy"|"force_created"|"existing_asset"|"none"|"review", "make_model_final": str}` (error/review entries may omit trailing keys).
  - `ProgressFn = Callable[[int, int, int, int], Awaitable[None]]` (processed, created, updated, errors); `CancelledFn = Callable[[], Awaitable[bool]]`; `BATCH_SIZE = 500`.
  - This task implements the FULL shared decision path; `write=True` behavior (actual DB writes, batching, collisions, audit) is completed in Task 5 — here every `if write:` branch is written but only validate-mode tests run.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_move_asset_import_validate.py`:

```python
"""Validate pass: the full decision path with zero writes."""

import uuid

from sqlalchemy import func, select

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, Initiative, InitiativeAsset,
)
from serversherpa.imports.move_assets import parse_row, run_import
from serversherpa.imports.parsing import CANONICAL


async def _move(db):
    ini = Initiative(name="Move V", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    return ini


def _row(n, **over):
    canonical = {c: "" for c in CANONICAL}
    canonical.update(over)
    return parse_row(n, canonical, dict(over), generate_serials=False)


async def _counts(db):
    return (await db.scalar(select(func.count()).select_from(Asset)),
            await db.scalar(select(func.count()).select_from(AssetModel)),
            await db.scalar(select(func.count()).select_from(InitiativeAsset)))


async def test_validate_writes_nothing_and_reports(db):
    ini = await _move(db)
    model = AssetModel(make="Dell", model="R740")
    db.add(model)
    await db.flush()
    db.add(AssetModelAlias(model_id=model.id, alias="Dell PE R740"))
    existing = Asset(serial_number="sn-old", model_id=model.id)
    db.add(existing)
    await db.flush()
    db.add(InitiativeAsset(initiative_id=ini.id, asset_id=existing.id))
    await db.commit()
    before = await _counts(db)

    rows = [
        _row(2, serial_number="SN-OLD"),                       # on move -> updated
        _row(3, serial_number="sn-new1", asset_make="Dell",
             asset_model="R740"),                              # exact -> created
        _row(4, serial_number="sn-new2",
             asset_model="Dell PE R740"),                      # alias -> created
        _row(5, serial_number="sn-new3", asset_make="Ghost",
             asset_model="GX-1"),                              # no match -> review
        _row(6, serial_number="sn-new1"),                      # dup in file -> updated
        _row(7),                                               # parse error entry
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=False)

    assert await _counts(db) == before                         # nothing written
    by_row = {d["row"]: d for d in result["details"]}
    assert by_row[2]["status"] == "updated"
    assert by_row[2]["match_method"] == "existing_asset"
    assert by_row[3]["status"] == "created"
    assert by_row[3]["match_method"] == "exact"
    assert by_row[4]["match_method"] == "fuzzy"
    assert by_row[5]["status"] == "review"
    assert by_row[6]["status"] == "updated"                    # second sight of sn-new1
    assert by_row[7]["status"] == "error"
    assert result["summary"] == {
        "total_rows": 6, "processed_rows": 6, "created": 2, "updated": 2,
        "review": 1, "errors": 1,
    }
    assert result["cancelled"] is False


async def test_validate_force_and_hybrid_simulate_model_creation(db):
    ini = await _move(db)
    before = await _counts(db)
    rows = [_row(2, serial_number="sn-f", asset_make="Ghost",
                 asset_model="GX-1")]
    for mode in ("force", "hybrid"):
        result = await run_import(db, initiative_id=ini.id, added_by=None,
                                  rows=rows, make_model_mode=mode,
                                  write=False)
        [d] = result["details"]
        assert d["status"] == "created"
        assert d["match_method"] == "force_created"
        assert d["make_model_final"] == "Ghost GX-1"
        assert result["summary"]["models_created"] == 1
    assert await _counts(db) == before


async def test_validate_rfid_conflict_notes(db):
    ini = await _move(db)
    holder = Asset(serial_number="sn-holder", rfid_tag="TAG-1")
    db.add(holder)
    await db.commit()
    rows = [
        _row(2, serial_number="sn-a", rfid_tag="TAG-1"),   # taken in DB
        _row(3, serial_number="sn-b", rfid_tag="TAG-2"),
        _row(4, serial_number="sn-c", rfid_tag="TAG-2"),   # taken by row 3
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=False)
    by_row = {d["row"]: d for d in result["details"]}
    assert "TAG-1" in by_row[2]["message"] and "skipped" in by_row[2]["message"]
    assert "skipped" not in by_row[3]["message"]
    assert "TAG-2" in by_row[4]["message"] and "skipped" in by_row[4]["message"]


async def test_no_make_model_at_all_still_creates(db):
    ini = await _move(db)
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=[_row(2, serial_number="sn-bare")],
                              write=False)
    [d] = result["details"]
    assert d["status"] == "created"
    assert d["match_method"] == "none"
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_move_asset_import_validate.py -q`
Expected: FAIL with `ImportError: cannot import name 'run_import'`.

- [ ] **Step 3: Implement the pipeline core**

In `api/src/serversherpa/imports/move_assets.py`, extend the module docstring's stage note if you like, and add below the existing helpers:

```python
import json
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, InitiativeAsset,
)

BATCH_SIZE = 500

ProgressFn = Callable[[int, int, int, int], Awaitable[None]]
CancelledFn = Callable[[], Awaitable[bool]]


class _SimAsset:
    """Stand-in for an Asset that validate mode 'created' — later rows
    with the same serial resolve as existing without any DB write."""

    id = None

    def __init__(self, serial: str) -> None:
        self.serial_number = serial
        self.rfid_tag: str | None = None


_SIM_ASSOC = object()   # roster marker for validate-mode attachments


async def _lookups(db: AsyncSession, initiative_id: uuid.UUID,
                   rows: list[dict]) -> tuple[dict, dict, dict, dict]:
    """Batch lookups for the whole file: assets by serial, RFID holders,
    make/model exact + alias fuzzy, current roster rows by serial."""
    serials = list({r["serial_number"] for r in rows})
    assets: dict[str, Asset] = {}
    if serials:
        for a in await db.scalars(
                select(Asset).where(Asset.serial_number.in_(serials))):
            assets[(a.serial_number or "").lower()] = a

    tags = list({r["rfid_tag"] for r in rows if r["rfid_tag"]})
    rfid: dict[str, Asset] = {}
    if tags:
        for a in await db.scalars(
                select(Asset).where(Asset.rfid_tag.in_(tags))):
            rfid[(a.rfid_tag or "").lower()] = a

    models: dict[str, tuple] = {}
    for m in await db.scalars(select(AssetModel)):
        display = f"{m.make} {m.model}".strip()
        models[display.lower()] = (m, "exact", display)
    alias_rows = (await db.execute(
        select(AssetModelAlias.alias, AssetModel)
        .join(AssetModel, AssetModel.id == AssetModelAlias.model_id))).all()
    for alias, m in alias_rows:                # exact wins over alias
        models.setdefault(
            alias.lower(), (m, "fuzzy", f"{m.make} {m.model}".strip()))

    roster: dict[str, object] = {}
    ids = [a.id for a in assets.values()]
    if ids:
        by_id = {a.id: s for s, a in assets.items()}
        for assoc in await db.scalars(select(InitiativeAsset).where(
                InitiativeAsset.initiative_id == initiative_id,
                InitiativeAsset.asset_id.in_(ids))):
            roster[by_id[assoc.asset_id]] = assoc
    return assets, rfid, models, roster


def _apply_row(assoc: InitiativeAsset, r: dict, now: datetime) -> None:
    assoc.priority_wave = r["priority_wave"]
    assoc.disposition = r["disposition"]
    assoc.owner = r["owner"]
    assoc.source_rack = r["source_rack"]
    assoc.source_ru = (Decimal(str(r["source_ru"]))
                       if r["source_ru"] is not None else None)
    assoc.destination_rack = r["destination_rack"]
    assoc.destination_ru = (Decimal(str(r["destination_ru"]))
                            if r["destination_ru"] is not None else None)
    assoc.cable_info = (json.dumps(r["cable_info"])
                        if r["cable_info"] else None)
    assoc.vendor_involved = r["vendor_involved"]
    assoc.status = "loaded_in_system"   # V2 parity: re-upload resets status
    assoc.raw_ft = r["raw_ft"]
    assoc.updated_at = now


async def run_import(
    db: AsyncSession, *,
    initiative_id: uuid.UUID,
    added_by: uuid.UUID | None,
    rows: list[dict],
    make_model_mode: str = "fuzzy",
    write: bool,
    source_label: str = "",
    progress: ProgressFn | None = None,
    is_cancelled: CancelledFn | None = None,
) -> dict:
    """The shared pipeline. write=False (validate) runs the identical
    decision path with every DB write suppressed — created assets/models
    are simulated in-memory so later rows in the same file resolve exactly
    as they will at commit. write=True commits in BATCH_SIZE batches
    (progress + cancel checks ride the batch boundary), then flags
    destination collisions and writes ONE audit summary row."""
    from serversherpa.services.audit import audit

    ok_rows = [r for r in rows if r["status"] == "ok"]
    assets, rfid_map, model_map, roster = await _lookups(
        db, initiative_id, ok_rows)
    force = make_model_mode in ("force", "hybrid")

    details: list[dict] = []
    created = updated = review = errors = processed = 0
    created_models: list[str] = []
    cancelled = False
    now = datetime.now(UTC)

    for r in rows:
        processed += 1
        if r["status"] == "error":
            errors += 1
            details.append({"row": r["row"],
                            "serial_number": r["serial_number"],
                            "status": "error", "message": r["message"]})
            continue

        serial = r["serial_number"]
        notes = list(r["notes"])

        # RFID skip-and-flag: a tag held by a DIFFERENT asset (DB or an
        # earlier row of this file) is not written; the row still imports.
        rfid_to_write = r["rfid_tag"] or None
        if rfid_to_write:
            holder = rfid_map.get(rfid_to_write.lower())
            if holder is not None and \
                    (holder.serial_number or "").lower() != serial:
                notes.append(
                    f"RFID tag '{rfid_to_write}' skipped: already assigned "
                    f"to serial '{holder.serial_number}'")
                rfid_to_write = None

        asset = assets.get(serial)
        asset_created = False
        match_method = "existing_asset" if asset is not None else "none"
        make_model_final = ""

        if asset is None:
            model_obj = None
            if r["make_model_str"]:
                mm_key = r["make_model_str"].lower()
                matched = model_map.get(mm_key)
                if matched is not None:
                    model_obj, match_method, make_model_final = matched
                elif force:
                    mk, md = resolve_make_model_for_creation(
                        r["asset_make"], r["asset_model"])
                    note = ("FORCED: hybrid mode creation (fuzzy match not "
                            "found) for move F-T"
                            if make_model_mode == "hybrid"
                            else "FORCED: make model creation for move F-T")
                    make_model_final = f"{mk} {md}".strip()
                    if write:
                        model_obj = AssetModel(make=mk, model=md,
                                               knowledge=note)
                        db.add(model_obj)
                        await db.flush()
                    match_method = "force_created"
                    model_map[mm_key] = (model_obj, "force_created",
                                         make_model_final)
                    created_models.append(make_model_final)
                else:
                    review += 1
                    details.append({
                        "row": r["row"], "serial_number": serial,
                        "status": "review",
                        "message": f"Make/Model '{r['make_model_str']}' "
                                   "not found — needs review",
                        "match_method": "review",
                        "serial_generated": r["serial_generated"]})
                    continue
            if write:
                asset = Asset(
                    serial_number=serial, name=r["asset_name"],
                    rfid_tag=rfid_to_write,
                    model_id=model_obj.id if model_obj is not None else None,
                    source="import", source_ref=source_label or None,
                    created_by=added_by)
                db.add(asset)
                await db.flush()
            else:
                asset = _SimAsset(serial)
            asset_created = True
            assets[serial] = asset
            if rfid_to_write:
                rfid_map[rfid_to_write.lower()] = asset
        elif rfid_to_write:
            if write:
                asset.rfid_tag = rfid_to_write
                asset.updated_at = now
            rfid_map[rfid_to_write.lower()] = asset

        if serial in roster:
            assoc = roster[serial]
            if write and isinstance(assoc, InitiativeAsset):
                _apply_row(assoc, r, now)
            updated += 1
            status, message = "updated", "Asset updated in move"
        else:
            if write:
                assoc = InitiativeAsset(initiative_id=initiative_id,
                                        asset_id=asset.id,
                                        added_by=added_by)
                _apply_row(assoc, r, now)
                db.add(assoc)
                roster[serial] = assoc
            else:
                roster[serial] = _SIM_ASSOC
            created += 1
            status, message = "created", "Asset added to move"

        if notes:
            message = f"{message}. " + "; ".join(notes)
        details.append({
            "row": r["row"], "serial_number": serial, "status": status,
            "message": message,
            "asset_id": str(asset.id) if getattr(asset, "id", None) else None,
            "asset_created": asset_created,
            "serial_generated": r["serial_generated"],
            "match_method": match_method,
            "make_model_final": make_model_final})

        if write and processed % BATCH_SIZE == 0:
            if progress is not None:
                await progress(processed, created, updated, errors)
            await db.commit()
            if is_cancelled is not None and await is_cancelled():
                cancelled = True
                break

    summary = {"total_rows": len(rows), "processed_rows": processed,
               "created": created, "updated": updated, "review": review,
               "errors": errors}
    if created_models:
        summary["models_created"] = len(created_models)

    if write and not cancelled:
        summary["collisions_flagged"] = await flag_collisions(
            db, initiative_id)
        audit(db, actor_id=added_by, entity_type="initiative",
              entity_id=str(initiative_id), action="asset_import",
              changes={**summary, "source": source_label})
    if write:
        if progress is not None:
            await progress(processed, created, updated, errors)
        await db.commit()
    return {"summary": summary, "details": details, "cancelled": cancelled}
```

Also add a placeholder so validate tests import cleanly before Task 5 (Task 5 replaces it with the real logic):

```python
async def flag_collisions(db: AsyncSession,
                          initiative_id: uuid.UUID) -> int:
    """Implemented in the commit slice (Task 5)."""
    return 0
```

- [ ] **Step 4: Run — must pass (validate + earlier suites)**

Run: `cd api && .venv/bin/pytest tests/test_move_asset_import_validate.py tests/test_move_asset_import_rows.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/imports/move_assets.py api/tests/test_move_asset_import_validate.py
git commit -m "feat(api): move-asset import pipeline — validate pass, zero writes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Pipeline — commit, collisions, audit, cancel

**Files:**
- Modify: `api/src/serversherpa/imports/move_assets.py` (replace the `flag_collisions` placeholder)
- Test: `api/tests/test_move_asset_import_commit.py`

**Interfaces:**
- Consumes: `run_import(write=True, ...)` from Task 4 (all write branches already exist).
- Produces: real `flag_collisions(db, initiative_id) -> int` — groups this move's roster rows by `destination_rack`, expands each to occupied RUs (`int(float(destination_ru))` .. + model `ru_size`, default 1), sets `status='location_collision'` on overlapping pairs, returns how many rows were flagged. Adds nothing to the session-commit responsibilities (caller commits).

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_move_asset_import_commit.py`:

```python
"""Commit pass: per-row writes, RFID, collisions, audit, batching, cancel."""

import json
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, AuditLog, Initiative,
    InitiativeAsset,
)
from serversherpa.imports import move_assets
from serversherpa.imports.move_assets import (
    flag_collisions, parse_row, run_import,
)
from serversherpa.imports.parsing import CANONICAL


async def _move(db):
    ini = Initiative(name="Move C", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    return ini


def _row(n, **over):
    canonical = {c: "" for c in CANONICAL}
    canonical.update(over)
    return parse_row(n, canonical, dict(over), generate_serials=False)


async def test_commit_creates_models_assets_and_roster(db):
    ini = await _move(db)
    model = AssetModel(make="Dell", model="R740", ru_size=2)
    db.add(model)
    await db.commit()

    rows = [
        _row(2, serial_number="SN-1", asset_make="Dell", asset_model="R740",
             priority="Wave 1", source_rack="A1", source_ru="10",
             destination_rack="B1", destination_ru="20", data_1="sw1",
             vendor_involvement="y"),
        _row(3, serial_number="SN-2", asset_make="Ghost", asset_model="GX-1"),
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, make_model_mode="hybrid",
                              write=True, source_label="test-file.csv")
    assert result["summary"]["created"] == 2
    assert result["summary"]["models_created"] == 1
    assert result["summary"]["collisions_flagged"] == 0

    a1 = await db.scalar(select(Asset).where(Asset.serial_number == "sn-1"))
    assert a1.model_id == model.id
    assert a1.source == "import"
    ghost = await db.scalar(select(AssetModel).where(
        AssetModel.make == "Ghost"))
    assert ghost is not None and "FORCED" in ghost.knowledge

    assoc = await db.scalar(select(InitiativeAsset).where(
        InitiativeAsset.asset_id == a1.id))
    assert assoc.priority_wave == "Wave 1"
    assert assoc.source_ru == Decimal("10")
    assert assoc.status == "loaded_in_system"
    assert assoc.vendor_involved is True
    assert json.loads(assoc.cable_info) == {"data_1": "sw1"}
    assert assoc.raw_ft["serial_number"] == "SN-1"

    # ONE summary audit row, not one per asset
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "asset_import"))).all()
    assert len(audits) == 1
    assert audits[0].changes["created"] == 2
    assert audits[0].changes["source"] == "test-file.csv"


async def test_reimport_updates_and_resets_status(db):
    ini = await _move(db)
    rows = [_row(2, serial_number="SN-R", destination_rack="B1",
                 destination_ru="5")]
    await run_import(db, initiative_id=ini.id, added_by=None, rows=rows,
                     write=True)
    assoc = await db.scalar(select(InitiativeAsset).where(
        InitiativeAsset.initiative_id == ini.id))
    assoc.status = "complete"
    assoc.destination_rack = "OLD"
    await db.commit()

    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    assert result["summary"] == {
        "total_rows": 1, "processed_rows": 1, "created": 0, "updated": 1,
        "review": 0, "errors": 0, "collisions_flagged": 0}
    await db.refresh(assoc)
    assert assoc.status == "loaded_in_system"       # v2 parity reset
    assert assoc.destination_rack == "B1"
    # no duplicate asset or roster row
    assert await db.scalar(select(func.count()).select_from(Asset)) == 1
    assert await db.scalar(
        select(func.count()).select_from(InitiativeAsset)) == 1


async def test_per_row_semantics_bad_rows_do_not_block(db):
    ini = await _move(db)
    rows = [
        _row(2, serial_number="SN-OK"),
        _row(3),                                            # error row
        _row(4, serial_number="SN-REV", asset_make="Nope",
             asset_model="NX"),                             # review (fuzzy)
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    assert result["summary"]["created"] == 1
    assert result["summary"]["errors"] == 1
    assert result["summary"]["review"] == 1
    assert await db.scalar(
        select(func.count()).select_from(InitiativeAsset)) == 1


async def test_rfid_written_and_conflicts_skipped(db):
    ini = await _move(db)
    holder = Asset(serial_number="sn-holder", rfid_tag="TAG-1")
    bare = Asset(serial_number="sn-bare")
    db.add_all([holder, bare])
    await db.commit()
    rows = [
        _row(2, serial_number="SN-NEW", rfid_tag="TAG-1"),   # conflict: skip
        _row(3, serial_number="SN-BARE", rfid_tag="TAG-9"),  # existing asset: write
    ]
    await run_import(db, initiative_id=ini.id, added_by=None, rows=rows,
                     write=True)
    created = await db.scalar(select(Asset).where(
        Asset.serial_number == "sn-new"))
    assert created.rfid_tag is None
    await db.refresh(bare)
    assert bare.rfid_tag == "TAG-9"


async def test_collision_detection_flags_overlaps(db):
    ini = await _move(db)
    model = AssetModel(make="Big", model="4U", ru_size=4)
    db.add(model)
    await db.commit()
    rows = [
        _row(2, serial_number="SN-A", asset_make="Big", asset_model="4U",
             destination_rack="R1", destination_ru="10"),    # RUs 10-13
        _row(3, serial_number="SN-B",
             destination_rack="R1", destination_ru="12"),    # RU 12 (size 1)
        _row(4, serial_number="SN-C",
             destination_rack="R1", destination_ru="30"),    # clear
        _row(5, serial_number="SN-D",
             destination_rack="R2", destination_ru="12"),    # other rack
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    assert result["summary"]["collisions_flagged"] == 2
    statuses = dict((await db.execute(
        select(Asset.serial_number, InitiativeAsset.status)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id))).all())
    assert statuses["sn-a"] == "location_collision"
    assert statuses["sn-b"] == "location_collision"
    assert statuses["sn-c"] == "loaded_in_system"
    assert statuses["sn-d"] == "loaded_in_system"


async def test_batching_progress_and_cancel(db, monkeypatch):
    monkeypatch.setattr(move_assets, "BATCH_SIZE", 2)
    ini = await _move(db)
    rows = [_row(n, serial_number=f"SN-{n}") for n in range(2, 8)]  # 6 rows
    seen = []

    async def progress(processed, created, updated, errors):
        seen.append(processed)

    async def cancel_after_first_batch() -> bool:
        return len(seen) >= 1

    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True, progress=progress,
                              is_cancelled=cancel_after_first_batch)
    assert result["cancelled"] is True
    assert result["summary"]["processed_rows"] == 2
    # first batch is durably committed
    assert await db.scalar(
        select(func.count()).select_from(InitiativeAsset)) == 2
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_move_asset_import_commit.py -q`
Expected: `test_collision_detection_flags_overlaps` FAILS (`collisions_flagged` is 0 from the placeholder); the write-path tests may pass — that's fine, the placeholder is the missing piece.

- [ ] **Step 3: Implement flag_collisions (replace the placeholder)**

In `api/src/serversherpa/imports/move_assets.py`, replace the placeholder `flag_collisions` with:

```python
async def flag_collisions(db: AsyncSession,
                          initiative_id: uuid.UUID) -> int:
    """Destination rack/RU collision detection (V2 parity, run after a
    commit pass): expand every roster row with a destination to its
    occupied RU range (start = int(destination_ru), height = model
    ru_size, default 1) and flag every member of an overlapping pair
    with status 'location_collision'. Returns rows flagged. The caller
    owns the commit."""
    from collections import defaultdict

    rows = (await db.execute(
        select(InitiativeAsset, AssetModel.ru_size)
        .join(Asset, Asset.id == InitiativeAsset.asset_id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .where(InitiativeAsset.initiative_id == initiative_id,
               InitiativeAsset.destination_rack.is_not(None),
               InitiativeAsset.destination_ru.is_not(None)))).all()

    racks: dict[str, list[tuple[InitiativeAsset, set[int]]]] = defaultdict(list)
    for assoc, ru_size in rows:
        try:
            start = int(float(assoc.destination_ru))
            size = int(ru_size) if ru_size else 1
        except (TypeError, ValueError):
            continue
        racks[assoc.destination_rack].append(
            (assoc, set(range(start, start + size))))

    colliding: set[uuid.UUID] = set()
    by_id: dict[uuid.UUID, InitiativeAsset] = {}
    for entries in racks.values():
        for i in range(len(entries)):
            for j in range(i + 1, len(entries)):
                if entries[i][1] & entries[j][1]:
                    for assoc, _ in (entries[i], entries[j]):
                        colliding.add(assoc.id)
                        by_id[assoc.id] = assoc
    for assoc in by_id.values():
        assoc.status = "location_collision"
    return len(colliding)
```

(`flag_collisions` is now defined AFTER `run_import` references it by name at call time — Python resolves it at runtime, order in the module doesn't matter.)

- [ ] **Step 4: Run — must pass (whole import suite)**

Run: `cd api && .venv/bin/pytest tests/test_move_asset_import_commit.py tests/test_move_asset_import_validate.py tests/test_move_asset_import_rows.py tests/test_move_asset_import_parsing.py -q`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/imports/move_assets.py api/tests/test_move_asset_import_commit.py
git commit -m "feat(api): move-asset import commit path — collisions, audit, batching, cancel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Job queue + worker process + CLI

**Files:**
- Modify: `api/src/serversherpa/services/storage.py` (add `get_object`)
- Create: `api/src/serversherpa/imports/jobs.py`
- Create: `api/src/serversherpa/imports/worker.py`
- Modify: `api/src/serversherpa/cli.py` (new `import-worker` command)
- Test: `api/tests/test_import_worker.py`

**Interfaces:**
- Consumes: `ImportJob` (Task 1), `parse_upload`/`ImportFileError` (Task 2), `parse_row`/`run_import` (Tasks 3–5), `put_object` (existing).
- Produces:
  - `storage.get_object(key: str) -> bytes` (async).
  - `jobs.claim_next(db) -> ImportJob | None` — oldest queued, SKIP LOCKED, marks it running (started_at/progress_at) and commits.
  - `jobs.requeue_stale(db) -> int` — running jobs with `progress_at` older than `STALE_MINUTES = 10` go back to queued.
  - `worker.process_job(db, job) -> None` — runs one claimed job to a terminal status.
  - `worker.run_once(sessionmaker) -> bool` — claim+process at most one job; False when queue empty.
  - `worker.run_forever(poll_seconds: float = 2.0) -> None`.
  - CLI: `serversherpa import-worker [--poll-seconds 2.0] [--once]`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_import_worker.py`:

```python
"""Worker loop: claim -> process -> terminal status, against real MinIO."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, ImportJob, Initiative, InitiativeAsset,
)
from serversherpa.imports.jobs import claim_next, requeue_stale
from serversherpa.imports.worker import run_once
from serversherpa.services.storage import get_object, put_object

CSV = b"Serial Number,Asset Name\nSN-W1,web-01\nSN-W2,web-02\n"


async def _job(db, *, phase="validate", content=CSV, filename="ft.csv",
               status="queued", options=None):
    ini = Initiative(name=f"Move {uuid.uuid4().hex[:6]}",
                     initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    job = ImportJob(kind="move_assets", initiative_id=ini.id,
                    filename=filename, phase=phase, status=status,
                    options=options or {})
    db.add(job)
    await db.flush()
    key = f"import-jobs/{ini.id}/{job.id}/{filename}"
    await put_object(key, content, "text/csv")
    job.file_key = key
    await db.commit()
    return job.id, ini.id


async def test_storage_get_object_roundtrip(db):
    await put_object("import-jobs/test/roundtrip.bin", b"hello", "text/plain")
    assert await get_object("import-jobs/test/roundtrip.bin") == b"hello"


async def test_claim_next_marks_running_oldest_first(db):
    job1, _ = await _job(db)
    job2, _ = await _job(db)
    claimed = await claim_next(db)
    assert claimed.id == job1
    assert claimed.status == "running"
    assert claimed.started_at is not None and claimed.progress_at is not None
    claimed2 = await claim_next(db)
    assert claimed2.id == job2
    assert await claim_next(db) is None


async def test_run_once_validate_job(db):
    job_id, _ = await _job(db)
    assert await run_once(get_sessionmaker()) is True
    job = await db.get(ImportJob, job_id)
    assert job.status == "completed"
    assert job.phase == "validate"
    assert job.total_rows == 2
    assert job.results["summary"]["created"] == 2
    assert len(job.results["details"]) == 2
    # validate never writes
    assert await db.scalar(select(func.count()).select_from(Asset)) == 0


async def test_run_once_commit_job_writes(db):
    job_id, ini_id = await _job(db, phase="commit")
    assert await run_once(get_sessionmaker()) is True
    job = await db.get(ImportJob, job_id)
    assert job.status == "completed"
    assert (job.created_count, job.updated_count) == (2, 0)
    assert await db.scalar(select(func.count()).select_from(Asset)) == 2
    assert await db.scalar(select(func.count()).where(
        InitiativeAsset.initiative_id == ini_id)
        .select_from(InitiativeAsset)) == 2


async def test_run_once_bad_file_fails_job(db):
    job_id, _ = await _job(db, content=b"Asset Name\nx\n")  # no serial column
    await run_once(get_sessionmaker())
    job = await db.get(ImportJob, job_id)
    assert job.status == "failed"
    assert job.error == "missing_serial_column"
    assert job.finished_at is not None


async def test_run_once_respects_pre_cancel(db):
    job_id, _ = await _job(db)
    job = await db.get(ImportJob, job_id)
    job.cancel_requested = True
    await db.commit()
    await run_once(get_sessionmaker())
    await db.refresh(job)
    assert job.status == "cancelled"


async def test_run_once_empty_queue(db):
    assert await run_once(get_sessionmaker()) is False


async def test_requeue_stale(db):
    job_id, _ = await _job(db, status="running")
    job = await db.get(ImportJob, job_id)
    job.progress_at = datetime.now(UTC) - timedelta(minutes=11)
    await db.commit()
    assert await requeue_stale(db) == 1
    await db.refresh(job)
    assert job.status == "queued"
    # fresh running jobs are left alone
    job.status = "running"
    job.progress_at = datetime.now(UTC)
    await db.commit()
    assert await requeue_stale(db) == 0
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_import_worker.py -q`
Expected: FAIL with `ImportError` (no `get_object` / no `serversherpa.imports.jobs`).

- [ ] **Step 3: Implement storage.get_object**

Append to `api/src/serversherpa/services/storage.py`:

```python
async def get_object(key: str) -> bytes:
    """Read a private object's bytes (blocking boto3 moved off the loop).
    Used by the import worker to fetch uploaded files."""
    s = get_settings()
    resp = await asyncio.to_thread(partial(
        _client().get_object,
        Bucket=s.spaces_bucket,
        Key=key,
    ))
    return await asyncio.to_thread(resp["Body"].read)
```

- [ ] **Step 4: Implement jobs.py**

Create `api/src/serversherpa/imports/jobs.py`:

```python
"""Import job queue helpers. The queue is the import_jobs table itself:
the API inserts queued rows; worker processes claim them with
FOR UPDATE SKIP LOCKED so any number of workers can run without a broker."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ImportJob

STALE_MINUTES = 10


async def claim_next(db: AsyncSession) -> ImportJob | None:
    """Claim the oldest queued job (SKIP LOCKED) and mark it running.
    Commits the claim so the row is visible as running immediately."""
    job = await db.scalar(
        select(ImportJob)
        .where(ImportJob.status == "queued")
        .order_by(ImportJob.created_at)
        .limit(1)
        .with_for_update(skip_locked=True))
    if job is None:
        return None
    now = datetime.now(UTC)
    job.status = "running"
    job.started_at = now
    job.progress_at = now
    await db.commit()
    return job


async def requeue_stale(db: AsyncSession) -> int:
    """Re-queue running jobs whose progress_at is older than STALE_MINUTES
    (a worker crashed mid-job). Batched writes make re-running safe: work
    already committed stays, and the pipeline's update path is idempotent."""
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    jobs = (await db.scalars(
        select(ImportJob)
        .where(ImportJob.status == "running",
               ImportJob.progress_at < cutoff)
        .with_for_update(skip_locked=True))).all()
    for job in jobs:
        job.status = "queued"
        job.started_at = None
    await db.commit()
    return len(jobs)
```

- [ ] **Step 5: Implement worker.py**

Create `api/src/serversherpa/imports/worker.py`:

```python
"""The import worker loop — a separate process from the API
(`serversherpa import-worker`). Claims queued import_jobs rows and runs
the pipeline; the API process never parses files or writes import rows.

Shutdown story: no signal handling on purpose. Commit-phase work is
committed every BATCH_SIZE rows and the update path is idempotent, so
killing the worker mid-job loses at most one uncommitted batch; the job
sits 'running' until the next worker start re-queues it via
requeue_stale, and the re-run converges on the same result."""

import asyncio
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ImportJob
from serversherpa.imports.jobs import claim_next, requeue_stale
from serversherpa.imports.move_assets import parse_row, run_import
from serversherpa.imports.parsing import ImportFileError, parse_upload
from serversherpa.services.storage import get_object


def _finish(job: ImportJob, status: str, error: str | None = None) -> None:
    job.status = status
    job.error = error
    job.finished_at = datetime.now(UTC)


async def process_job(db: AsyncSession, job: ImportJob) -> None:
    """Run one claimed (status='running') job to a terminal status."""
    if job.cancel_requested:
        _finish(job, "cancelled")
        await db.commit()
        return
    try:
        content = await get_object(job.file_key)
    except Exception:
        _finish(job, "failed", "file_unreadable")
        await db.commit()
        return
    try:
        numbered = parse_upload(job.filename, content)
    except ImportFileError as exc:
        _finish(job, "failed", exc.code)
        await db.commit()
        return

    opts = job.options or {}
    parsed = [parse_row(n, canonical, raw,
                        generate_serials=bool(opts.get("generate_serials")))
              for n, canonical, raw in numbered]
    job.total_rows = len(parsed)

    async def _progress(processed: int, created: int, updated: int,
                        errors: int) -> None:
        job.processed_rows = processed
        job.created_count = created
        job.updated_count = updated
        job.error_count = errors
        job.progress_at = datetime.now(UTC)
        # the pipeline commits right after each progress call

    async def _cancelled() -> bool:
        await db.refresh(job, ["cancel_requested"])
        return job.cancel_requested

    write = job.phase == "commit"
    result = await run_import(
        db, initiative_id=job.initiative_id, added_by=job.created_by,
        rows=parsed,
        make_model_mode=str(opts.get("make_model_mode") or "fuzzy"),
        write=write,
        source_label=f"import-job {job.id} ({job.filename})",
        progress=_progress if write else None,
        is_cancelled=_cancelled if write else None)

    summary = result["summary"]
    job.processed_rows = summary["processed_rows"]
    job.created_count = summary["created"]
    job.updated_count = summary["updated"]
    job.error_count = summary["errors"]
    job.results = {"summary": summary, "details": result["details"]}
    job.progress_at = datetime.now(UTC)
    _finish(job, "cancelled" if result["cancelled"] else "completed")
    await db.commit()


async def run_once(sessionmaker) -> bool:
    """Claim and process at most one job. False when the queue is empty."""
    async with sessionmaker() as db:
        job = await claim_next(db)
        if job is None:
            return False
        try:
            await process_job(db, job)
        except Exception as exc:                       # job must terminate
            await db.rollback()
            _finish(job, "failed", f"worker_error: {exc}")
            await db.commit()
        return True


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker

    maker = get_sessionmaker()
    async with maker() as db:
        requeued = await requeue_stale(db)
        if requeued:
            print(f"[import-worker] re-queued {requeued} stale job(s)",
                  flush=True)
    print("[import-worker] watching the queue", flush=True)
    while True:
        worked = await run_once(maker)
        if not worked:
            await asyncio.sleep(poll_seconds)
```

- [ ] **Step 6: Add the CLI command**

In `api/src/serversherpa/cli.py`, add after `set_password`:

```python
@app.command()
def import_worker(
    poll_seconds: float = typer.Option(
        2.0, help="Idle sleep between queue polls"),
    once: bool = typer.Option(
        False, help="Process at most one job, then exit"),
) -> None:
    """Run the bulk-import worker loop — a separate process from the API,
    so imports never affect API readiness or response times."""

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.imports import worker

        if once:
            worked = await worker.run_once(get_sessionmaker())
            typer.secho("processed 1 job" if worked else "queue empty",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())
```

- [ ] **Step 7: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_import_worker.py -q`
Expected: 8 passed. Also sanity-check the CLI wiring:

```bash
cd api && .venv/bin/serversherpa import-worker --help
```

Expected: help text shows `--poll-seconds` and `--once`.

- [ ] **Step 8: Commit**

```bash
git add api/src/serversherpa/services/storage.py api/src/serversherpa/imports/jobs.py api/src/serversherpa/imports/worker.py api/src/serversherpa/cli.py api/tests/test_import_worker.py
git commit -m "feat(api): import job queue + separate import-worker process

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: API routes + ImportJobOut schema

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (after `InitiativeAssetUpdateIn`, ~line 1245)
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (imports; new section after the move-assets block)
- Test: `api/tests/test_move_asset_import_api.py`

**Interfaces:**
- Consumes: `ImportJob` (Task 1), templates + `put_object`.
- Produces endpoints (all `require_permission("initiatives", "change")`):
  - `POST /initiatives/{initiative_id}/assets/import-jobs` — multipart `file` + form `make_model_mode` (`fuzzy|force|hybrid`, default fuzzy) + `generate_serials` (bool, default false) → 201 `ImportJobOut` (phase `validate`, status `queued`). Errors: 422 `not_a_move` / `invalid_make_model_mode` / `unsupported_file` / `file_too_large` / `empty_file`.
  - `GET /initiatives/assets/import-jobs/{job_id}` → `ImportJobOut`; 404 `import_job_not_found`.
  - `POST /initiatives/assets/import-jobs/{job_id}/commit` → flips validated job to commit/queued; 409 `job_not_ready` unless `phase='validate' and status='completed'`.
  - `POST /initiatives/assets/import-jobs/{job_id}/cancel` → sets `cancel_requested` (queued jobs go straight to cancelled); 409 `job_already_finished` on terminal jobs.
  - `GET /initiatives/assets/import-template?format=csv|xlsx` → template download; 422 `unknown_format`.
  - Schema `ImportJobOut` (from_attributes) with exactly the ImportJob fields: id, initiative_id, kind, filename, options, phase, status, total_rows, processed_rows, created_count, updated_count, error_count, results, error, created_at, started_at, finished_at.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_move_asset_import_api.py`:

```python
"""Import-job routes: creation, gating, lifecycle transitions, template."""

import uuid

from serversherpa.db.models import ImportJob
from serversherpa.services.storage import get_object

from .test_assets_api import login
from .test_initiative_assets_api import _move, _project, _view_only_headers

CSV = b"Serial Number,Asset Name\nSN-1,web-01\n"


def _upload(client, headers, iid, content=CSV, filename="ft.csv", **form):
    data = {"make_model_mode": "fuzzy", "generate_serials": "false", **form}
    return client.post(f"/initiatives/{iid}/assets/import-jobs",
                       headers=headers, data=data,
                       files={"file": (filename, content, "text/csv")})


async def test_create_job_stores_file_and_queues(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    resp = await _upload(client, headers, iid,
                         make_model_mode="hybrid", generate_serials="true")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["phase"] == "validate"
    assert body["status"] == "queued"
    assert body["filename"] == "ft.csv"
    assert body["options"] == {"make_model_mode": "hybrid",
                               "generate_serials": True}
    job = await db.get(ImportJob, uuid.UUID(body["id"]))
    assert job.kind == "move_assets"
    assert await get_object(job.file_key) == CSV

    status = await client.get(
        f"/initiatives/assets/import-jobs/{body['id']}", headers=headers)
    assert status.status_code == 200
    assert status.json()["id"] == body["id"]


async def test_create_job_validation_errors(client, db, seeded_user):
    headers = await login(client)
    pid = await _project(client, headers)
    resp = await _upload(client, headers, pid)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "not_a_move"

    iid = await _move(client, headers)
    resp = await _upload(client, headers, iid, filename="ft.txt")
    assert resp.json()["detail"]["code"] == "unsupported_file"
    resp = await _upload(client, headers, iid, content=b"")
    assert resp.json()["detail"]["code"] == "empty_file"
    resp = await _upload(client, headers, iid, make_model_mode="yolo")
    assert resp.json()["detail"]["code"] == "invalid_make_model_mode"


async def test_permission_gate(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    viewer = await _view_only_headers(db, client)
    resp = await _upload(client, viewer, iid)
    assert resp.status_code == 403
    resp = await client.get("/initiatives/assets/import-template",
                            headers=viewer)
    assert resp.status_code == 403


async def test_commit_requires_completed_validate(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    job_id = (await _upload(client, headers, iid)).json()["id"]

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/commit", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "job_not_ready"

    job = await db.get(ImportJob, uuid.UUID(job_id))
    job.status = "completed"
    job.results = {"summary": {}, "details": []}
    job.processed_rows = 1
    await db.commit()

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/commit", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["phase"] == "commit"
    assert body["status"] == "queued"
    assert body["processed_rows"] == 0
    assert body["results"] is None


async def test_cancel_lifecycle(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    job_id = (await _upload(client, headers, iid)).json()["id"]

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/cancel", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"   # queued -> cancelled directly

    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/cancel", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "job_already_finished"


async def test_job_not_found(client, seeded_user):
    headers = await login(client)
    resp = await client.get(
        f"/initiatives/assets/import-jobs/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "import_job_not_found"


async def test_template_downloads(client, seeded_user):
    headers = await login(client)
    resp = await client.get(
        "/initiatives/assets/import-template?format=csv", headers=headers)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert resp.text.splitlines()[0].startswith("Serial Number,Asset Name")

    resp = await client.get(
        "/initiatives/assets/import-template?format=xlsx", headers=headers)
    assert resp.status_code == 200
    assert "spreadsheetml" in resp.headers["content-type"]

    resp = await client.get(
        "/initiatives/assets/import-template?format=pdf", headers=headers)
    assert resp.status_code == 422
```

- [ ] **Step 2: Run — must fail**

Run: `cd api && .venv/bin/pytest tests/test_move_asset_import_api.py -q`
Expected: FAIL (404s / missing routes).

- [ ] **Step 3: Add the schema**

In `api/src/serversherpa/api/schemas.py`, after `InitiativeAssetUpdateIn`, add:

```python
class ImportJobOut(BaseModel):
    """import_jobs row as served to the portal's polling loop."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    initiative_id: uuid.UUID
    kind: str
    filename: str
    options: dict
    phase: str
    status: str
    total_rows: int
    processed_rows: int
    created_count: int
    updated_count: int
    error_count: int
    results: dict | None = None
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
```

- [ ] **Step 4: Add the routes**

In `api/src/serversherpa/api/routes/initiatives.py`:

1. Extend the fastapi import to `from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile`.
2. Add `ImportJobOut` to the schemas import and `ImportJob` to the models import.
3. Add `from serversherpa.imports.parsing import MAX_BYTES, build_template_csv, build_template_xlsx` and `from serversherpa.services.storage import put_object` to the imports.
4. Append this section at the end of the file:

```python
# ── move-assets bulk import jobs ───────────────────────────────────
# The API only creates job rows and serves status; the separate
# import-worker process (serversherpa import-worker) claims queued rows
# and does all parsing and writing — imports never affect API readiness.

IMPORT_EXTENSIONS = (".csv", ".xlsx", ".xls")
MAKE_MODEL_MODES = ("fuzzy", "force", "hybrid")


async def _get_import_job(db: DbSession, job_id: uuid.UUID) -> ImportJob:
    job = await db.get(ImportJob, job_id)
    if job is None or job.kind != "move_assets":
        raise _err(404, "import_job_not_found")
    return job


@router.post("/{initiative_id}/assets/import-jobs",
             response_model=ImportJobOut, status_code=201)
async def create_move_asset_import_job(
    initiative_id: uuid.UUID,
    db: DbSession,
    file: UploadFile = File(...),
    make_model_mode: str = Form("fuzzy"),
    generate_serials: bool = Form(False),
    actor: AuthContext = require_permission("initiatives", "change"),
) -> ImportJob:
    initiative = await _get_initiative(db, initiative_id)
    if initiative.initiative_type != "move":
        raise _err(422, "not_a_move")
    if make_model_mode not in MAKE_MODEL_MODES:
        raise _err(422, "invalid_make_model_mode")
    filename = file.filename or "upload.csv"
    if not filename.lower().endswith(IMPORT_EXTENSIONS):
        raise _err(422, "unsupported_file")
    content = await file.read()
    if len(content) > MAX_BYTES:
        raise _err(422, "file_too_large", limit=MAX_BYTES)
    if not content:
        raise _err(422, "empty_file")

    job = ImportJob(
        kind="move_assets", initiative_id=initiative_id,
        created_by=actor.person.id, filename=filename,
        options={"make_model_mode": make_model_mode,
                 "generate_serials": generate_serials})
    db.add(job)
    await db.flush()
    key = f"import-jobs/{initiative_id}/{job.id}/{filename}"
    await put_object(key, content,
                     file.content_type or "application/octet-stream")
    job.file_key = key
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="asset_import_job_create",
          changes={"job_id": {"from": None, "to": str(job.id)},
                   "filename": {"from": None, "to": filename}})
    await db.commit()
    return job


@router.get("/assets/import-jobs/{job_id}", response_model=ImportJobOut)
async def get_move_asset_import_job(
    job_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> ImportJob:
    return await _get_import_job(db, job_id)


@router.post("/assets/import-jobs/{job_id}/commit",
             response_model=ImportJobOut)
async def commit_move_asset_import_job(
    job_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> ImportJob:
    job = await _get_import_job(db, job_id)
    if job.phase != "validate" or job.status != "completed":
        raise _err(409, "job_not_ready")
    job.phase = "commit"
    job.status = "queued"
    job.processed_rows = 0
    job.created_count = 0
    job.updated_count = 0
    job.error_count = 0
    job.results = None
    job.cancel_requested = False
    job.started_at = None
    job.finished_at = None
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(job.initiative_id), action="asset_import_commit",
          changes={"job_id": {"from": None, "to": str(job.id)}})
    await db.commit()
    return job


@router.post("/assets/import-jobs/{job_id}/cancel",
             response_model=ImportJobOut)
async def cancel_move_asset_import_job(
    job_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> ImportJob:
    job = await _get_import_job(db, job_id)
    if job.status in ("completed", "failed", "cancelled"):
        raise _err(409, "job_already_finished")
    job.cancel_requested = True
    if job.status == "queued":       # never claimed — cancel immediately
        job.status = "cancelled"
        job.finished_at = datetime.now(UTC)
    await db.commit()
    return job


@router.get("/assets/import-template")
async def move_asset_import_template(
    format: str = "csv",
    actor: AuthContext = require_permission("initiatives", "change"),
):
    if format == "csv":
        return Response(
            build_template_csv(), media_type="text/csv",
            headers={"Content-Disposition":
                     'attachment; filename="move-assets-template.csv"'})
    if format == "xlsx":
        return Response(
            build_template_xlsx(),
            media_type="application/vnd.openxmlformats-officedocument"
                       ".spreadsheetml.sheet",
            headers={"Content-Disposition":
                     'attachment; filename="move-assets-template.xlsx"'})
    raise _err(422, "unknown_format")
```

- [ ] **Step 5: Run — must pass**

Run: `cd api && .venv/bin/pytest tests/test_move_asset_import_api.py tests/test_initiative_assets_api.py -q`
Expected: all passed (existing initiative-assets suite proves no route collision).

- [ ] **Step 6: Run the full API suite**

Run: `cd api && .venv/bin/pytest -q`
Expected: all passed.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/initiatives.py api/tests/test_move_asset_import_api.py
git commit -m "feat(api): move-asset import job routes — create/status/commit/cancel/template

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Portal API client + helpers

**Files:**
- Modify: `portal/src/lib/api.ts` (after `removeInitiativeAsset`, ~line 1600)
- Create: `portal/src/lib/moveAssetImport.ts`
- Test: `portal/src/lib/moveAssetImport.test.ts`

**Interfaces:**
- Produces (in `api.ts`): types `ImportRowDetail`, `ImportJobResults`, `ImportJobOut`; functions `createMoveAssetImportJob(initiativeId, file, opts)`, `getImportJob(jobId)`, `commitImportJob(jobId)`, `cancelImportJob(jobId)`, `downloadMoveAssetTemplate(format)`.
- Produces (in `moveAssetImport.ts`): `countDetails`, `jobIsActive`, `jobProgressPct`, `rowsPerSecond`, `etaSeconds`, `importErrorMessage` (exact signatures in the code below). Task 9's page consumes these.

- [ ] **Step 1: Write the failing tests**

Create `portal/src/lib/moveAssetImport.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { ApiError, type ImportJobOut, type ImportRowDetail } from './api';
import {
  countDetails, etaSeconds, importErrorMessage, jobIsActive,
  jobProgressPct, rowsPerSecond,
} from './moveAssetImport';

const detail = (status: ImportRowDetail['status']): ImportRowDetail => ({
  row: 2, serial_number: 'sn', status, message: '',
});

const job = (over: Partial<ImportJobOut>): ImportJobOut => ({
  id: 'j1', initiative_id: 'i1', kind: 'move_assets', filename: 'ft.csv',
  options: {}, phase: 'validate', status: 'queued',
  total_rows: 0, processed_rows: 0, created_count: 0, updated_count: 0,
  error_count: 0, results: null, error: null,
  created_at: '2026-08-26T00:00:00Z', started_at: null, finished_at: null,
  ...over,
});

describe('countDetails', () => {
  it('tallies by status', () => {
    const details = [detail('created'), detail('created'), detail('updated'),
                     detail('review'), detail('error')];
    expect(countDetails(details)).toEqual(
      { created: 2, updated: 1, review: 1, error: 1 });
  });
  it('handles empty', () => {
    expect(countDetails([])).toEqual(
      { created: 0, updated: 0, review: 0, error: 0 });
  });
});

describe('job state helpers', () => {
  it('active for queued/running only', () => {
    expect(jobIsActive(job({ status: 'queued' }))).toBe(true);
    expect(jobIsActive(job({ status: 'running' }))).toBe(true);
    expect(jobIsActive(job({ status: 'completed' }))).toBe(false);
    expect(jobIsActive(job({ status: 'failed' }))).toBe(false);
    expect(jobIsActive(job({ status: 'cancelled' }))).toBe(false);
  });
  it('progress pct clamps and survives zero totals', () => {
    expect(jobProgressPct(job({ total_rows: 0 }))).toBe(0);
    expect(jobProgressPct(job({ total_rows: 200, processed_rows: 50 })))
      .toBe(25);
    expect(jobProgressPct(job({ total_rows: 10, processed_rows: 20 })))
      .toBe(100);
  });
});

describe('speed + eta', () => {
  it('averages recent samples', () => {
    const speed = rowsPerSecond([
      { at: 0, processed: 0 },
      { at: 2000, processed: 100 },
      { at: 4000, processed: 300 },
    ]);
    expect(speed).toBe(75);   // (50 + 100) / 2
  });
  it('needs two samples', () => {
    expect(rowsPerSecond([{ at: 0, processed: 0 }])).toBe(0);
  });
  it('eta from remaining rows', () => {
    const j = job({ total_rows: 1000, processed_rows: 250 });
    expect(etaSeconds(j, 75)).toBe(10);
    expect(etaSeconds(j, 0)).toBeNull();
  });
});

describe('importErrorMessage', () => {
  it('maps known codes', () => {
    const err = new ApiError(422, { code: 'not_a_move' });
    expect(importErrorMessage(err)).toMatch(/move/i);
  });
  it('falls back for unknown input', () => {
    expect(importErrorMessage(new Error('boom'))).toMatch(/wrong/i);
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `cd portal && npx vitest run src/lib/moveAssetImport.test.ts`
Expected: FAIL (module missing). Check `ApiError`'s constructor in `api.ts` first — if its signature differs from `new ApiError(422, { code })`, adapt the test to the real signature, not the class to the test.

- [ ] **Step 3: Add the api.ts client pieces**

In `portal/src/lib/api.ts`, after `removeInitiativeAsset`, add:

```typescript
// ── move-assets bulk import jobs ─────────────────────────────────────
// The API queues the job; a separate worker process runs it. The portal
// polls getImportJob until the job reaches a terminal status.

export type ImportJobPhase = 'validate' | 'commit';
export type ImportJobStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ImportRowDetail {
  row: number;
  serial_number: string;
  status: 'created' | 'updated' | 'review' | 'error';
  message: string;
  asset_id?: string | null;
  asset_created?: boolean;
  serial_generated?: boolean;
  match_method?: string;
  make_model_final?: string;
}

export interface ImportJobResults {
  summary: Record<string, number>;
  details: ImportRowDetail[];
}

export interface ImportJobOut {
  id: string;
  initiative_id: string;
  kind: string;
  filename: string;
  options: { make_model_mode?: string; generate_serials?: boolean };
  phase: ImportJobPhase;
  status: ImportJobStatus;
  total_rows: number;
  processed_rows: number;
  created_count: number;
  updated_count: number;
  error_count: number;
  results: ImportJobResults | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export async function createMoveAssetImportJob(
  initiativeId: string, file: File,
  opts: { makeModelMode: string; generateSerials: boolean },
): Promise<ImportJobOut> {
  const form = new FormData();
  form.append('file', file);
  form.append('make_model_mode', opts.makeModelMode);
  form.append('generate_serials', String(opts.generateSerials));
  const resp = await apiFetch(
    `/initiatives/${initiativeId}/assets/import-jobs`,
    { method: 'POST', body: form });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getImportJob(jobId: string): Promise<ImportJobOut> {
  const resp = await apiFetch(`/initiatives/assets/import-jobs/${jobId}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function commitImportJob(jobId: string): Promise<ImportJobOut> {
  const resp = await apiFetch(
    `/initiatives/assets/import-jobs/${jobId}/commit`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function cancelImportJob(jobId: string): Promise<ImportJobOut> {
  const resp = await apiFetch(
    `/initiatives/assets/import-jobs/${jobId}/cancel`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function downloadMoveAssetTemplate(
  format: 'csv' | 'xlsx',
): Promise<void> {
  const resp = await apiFetch(
    `/initiatives/assets/import-template?format=${format}`);
  if (!resp.ok) throw await errorFrom(resp);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `move-assets-template.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Implement moveAssetImport.ts**

Create `portal/src/lib/moveAssetImport.ts`:

```typescript
/** Pure helpers for the move-assets import page: report shaping, progress
 *  math, and API error mapping. The page stays thin per repo convention. */

import { ApiError, type ImportJobOut, type ImportRowDetail } from './api';

export interface ImportCounts {
  created: number;
  updated: number;
  review: number;
  error: number;
}

export function countDetails(details: ImportRowDetail[]): ImportCounts {
  const counts: ImportCounts = { created: 0, updated: 0, review: 0, error: 0 };
  for (const d of details) counts[d.status] += 1;
  return counts;
}

export function jobIsActive(job: ImportJobOut): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export function jobProgressPct(job: ImportJobOut): number {
  if (job.total_rows <= 0) return 0;
  return Math.min(100,
    Math.round((job.processed_rows / job.total_rows) * 100));
}

export interface SpeedSample {
  at: number;         // Date.now() when sampled
  processed: number;  // job.processed_rows at that moment
}

/** Average rows/second over consecutive sample deltas (v2-style). */
export function rowsPerSecond(samples: SpeedSample[]): number {
  if (samples.length < 2) return 0;
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = (samples[i].at - samples[i - 1].at) / 1000;
    if (dt > 0) rates.push((samples[i].processed - samples[i - 1].processed) / dt);
  }
  if (rates.length === 0) return 0;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

export function etaSeconds(job: ImportJobOut, speed: number): number | null {
  if (speed <= 0) return null;
  const remaining = Math.max(0, job.total_rows - job.processed_rows);
  return Math.ceil(remaining / speed);
}

export const IMPORT_ERRORS: Record<string, string> = {
  not_a_move: 'This initiative is not a move — imports only apply to moves.',
  invalid_make_model_mode: 'Unknown make/model mode.',
  unsupported_file: 'Unsupported file type — upload a .csv or .xlsx file.',
  file_too_large: 'File is too large (20 MB max).',
  empty_file: 'The uploaded file is empty.',
  missing_serial_column: 'The file has no Serial Number column.',
  invalid_csv: 'The file could not be read as CSV.',
  invalid_xlsx: 'The file could not be read as a spreadsheet.',
  file_unreadable: 'The stored file could not be read back — upload again.',
  import_job_not_found: 'Import job not found.',
  job_not_ready: 'Validation must finish before the import can run.',
  job_already_finished: 'This import has already finished.',
  unknown_format: 'Unknown template format.',
};

export function importErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const code = (e.body as { code?: string } | null)?.code;
    if (code && IMPORT_ERRORS[code]) return IMPORT_ERRORS[code];
  }
  return 'Something went wrong — try again.';
}
```

NOTE: `importErrorMessage` reads the error code the way the repo's other
error maps do — before writing it, open `portal/src/lib/api.ts`, find how
`ApiError` stores the response detail (e.g. `.body`, `.detail`, or `.data`),
and read the code from the real field. Mirror an existing map consumer
(grep for `MOVE_ASSET_ERRORS` or similar in `InitiativeDetail.tsx`) rather
than inventing a new access pattern; adjust the test from Step 1 to match.

- [ ] **Step 5: Run — must pass**

Run: `cd portal && npx vitest run src/lib/moveAssetImport.test.ts`
Expected: all passed. Then `cd portal && npx tsc --noEmit` — no errors.

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/moveAssetImport.ts portal/src/lib/moveAssetImport.test.ts
git commit -m "feat(portal): import-job API client + report/progress helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Portal page, route, and Assets-section button

**Files:**
- Create: `portal/src/pages/ImportMoveAssets.tsx`
- Modify: `portal/src/App.tsx` (import + route)
- Modify: `portal/src/pages/InitiativeDetail.tsx` (~line 677, Assets panel header)

**Interfaces:**
- Consumes: everything from Task 8; existing `getInitiative` from `api.ts`.
- Produces: route `/initiatives/:id/import-assets`; an **Import assets** link on the move's Assets panel (`canChange` + move only).

- [ ] **Step 1: Build the page**

Create `portal/src/pages/ImportMoveAssets.tsx`. Before writing, skim an existing page (e.g. the top of `InitiativeDetail.tsx`) for the shared page-shell class names (`page-hint`, `mini-btn`, `btn-solid`, `dir-empty`, chips) and reuse them — do not invent new CSS unless a needed pattern truly doesn't exist. Structure:

```tsx
/** Move-assets bulk import: upload -> validate report -> commit -> results.
 *  All state renders from the polled import job, so a refresh mid-import
 *  loses nothing. The heavy lifting happens in the separate API worker. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  cancelImportJob, commitImportJob, createMoveAssetImportJob,
  downloadMoveAssetTemplate, getImportJob, getInitiative,
  type ImportJobOut, type InitiativeDetail,
} from '../lib/api';
import {
  countDetails, etaSeconds, importErrorMessage, jobIsActive,
  jobProgressPct, rowsPerSecond, type SpeedSample,
} from '../lib/moveAssetImport';

const POLL_MS = 2000;
const PAGE_SIZE = 500;

export default function ImportMoveAssets() {
  const { id } = useParams<{ id: string }>();
  const [initiative, setInitiative] = useState<InitiativeDetail | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState('fuzzy');
  const [generateSerials, setGenerateSerials] = useState(false);
  const [job, setJob] = useState<ImportJobOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const samplesRef = useRef<SpeedSample[]>([]);
  const [speed, setSpeed] = useState(0);

  useEffect(() => {
    if (!id) return;
    void getInitiative(id).then(setInitiative)
      .catch((e) => setError(importErrorMessage(e)));
  }, [id]);

  // poll while the job is active
  useEffect(() => {
    if (!job || !jobIsActive(job)) return undefined;
    const timer = setInterval(() => {
      void getImportJob(job.id).then((next) => {
        setJob(next);
        samplesRef.current = [...samplesRef.current.slice(-5),
          { at: Date.now(), processed: next.processed_rows }];
        setSpeed(rowsPerSecond(samplesRef.current));
      }).catch(() => undefined);   // transient poll failures: keep polling
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job]);

  const run = useCallback(async (fn: () => Promise<ImportJobOut>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      samplesRef.current = [];
      setSpeed(0);
      setPage(0);
      setJob(next);
    } catch (e) {
      setError(importErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /* render sections (in order):
     1. Header: eyebrow "Bulk import" + initiative name + Link back to
        `/initiatives/${id}` ("Back to move").
     2. Guard: initiative loaded and initiative.initiative_type !== 'move'
        -> a dir-empty panel "Imports only apply to moves." and stop.
     3. Setup panel (hidden while job is active): file input
        (accept=".csv,.xlsx,.xls"), make/model mode radio group
        (fuzzy default / force / hybrid, one-line description each from
        the template Reference wording), serial-generation checkbox,
        template buttons (Template (.xlsx) / Template (.csv) calling
        downloadMoveAssetTemplate), and the primary button:
        - no job or terminal job: "Validate" -> run(() =>
          createMoveAssetImportJob(id!, file!, { makeModelMode: mode,
          generateSerials })) — disabled unless file chosen.
     4. Progress panel (job && jobIsActive(job)): phase label
        ("Validating…" / "Importing…"), progress bar from
        jobProgressPct(job), "{processed_rows} of {total_rows} rows",
        speed ("{Math.round(speed)} rows/s") and ETA from
        etaSeconds(job, speed) when > 0, and a Cancel button ->
        run(() => cancelImportJob(job.id)).
     5. Report panel (job terminal):
        - failed: dir-empty with IMPORT_ERRORS-mapped job.error.
        - cancelled: note "Import cancelled — {processed_rows} rows were
          already committed." (commit phase) or "Validation cancelled."
        - completed + results: summary chips from
          countDetails(job.results.details) labelled for the phase
          (validate: "will create/will update/needs review/errors";
          commit: "created/updated/review skipped/errors") plus
          "collisions flagged" when results.summary.collisions_flagged > 0;
          details table (Row / Serial / Status chip / Message) paginated
          by PAGE_SIZE with Prev/Next buttons and "showing X–Y of Z";
          and the actions:
          - validate phase: "Import N rows" button (disabled when
            countDetails(...).created + updated === 0) ->
            run(() => commitImportJob(job.id)); note when review/error
            rows exist: "review and error rows will be skipped".
          - commit phase: "Back to move" Link + "Import another file"
            button that resets job/file state.
  */
}
```

Flesh the render out fully — every section above must exist in JSX (the comment block is the section spec, not something to leave as a comment). Status chips reuse the pattern used for status chips elsewhere (span with a class + inline background) — copy the idiom from the report table in `SiteBulkImport.tsx`.

- [ ] **Step 2: Wire the route**

In `portal/src/App.tsx`:
- Add `import ImportMoveAssets from './pages/ImportMoveAssets';` with the other page imports (alphabetical position: after `Home`).
- After the `/initiatives/:id` route, add:

```tsx
            <Route path="/initiatives/:id/import-assets" element={
              <ProtectedRoute resource="initiatives"><ImportMoveAssets /></ProtectedRoute>
            } />
```

- [ ] **Step 3: Add the Assets-section button**

In `portal/src/pages/InitiativeDetail.tsx`, replace:

```tsx
          <p className="eyebrow-sm">Assets{isMove ? ` — ${assets.length}` : ''}</p>
```

with:

```tsx
          <div style={{ display: 'flex', alignItems: 'center',
                        justifyContent: 'space-between' }}>
            <p className="eyebrow-sm">Assets{isMove ? ` — ${assets.length}` : ''}</p>
            {isMove && canChange && (
              <Link className="mini-btn"
                    to={`/initiatives/${initiative.id}/import-assets`}>
                Import assets
              </Link>
            )}
          </div>
```

(`Link` is already imported in this file.)

- [ ] **Step 4: Type check + full portal suite**

Run: `cd portal && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass (nav/search suites untouched — no new nav surface).

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/ImportMoveAssets.tsx portal/src/App.tsx portal/src/pages/InitiativeDetail.tsx
git commit -m "feat(portal): move-assets bulk import page + Assets-section entry point

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Live end-to-end verification

**Files:** none (verification only; fix-forward anything found, then re-run the relevant suite).

- [ ] **Step 1: Migrate the dev DB and start the stack**

```bash
cd /Users/jrh1812/Developer/BaseCampV3 && docker compose -f docker-compose.dev.yml up -d
```

```bash
cd /Users/jrh1812/Developer/BaseCampV3/api && .venv/bin/alembic upgrade head
```

Expected: `Running upgrade 0022 -> 0023`.

- [ ] **Step 2: Start the import worker (background)**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/api && .venv/bin/serversherpa import-worker
```

Run it in the background; expected first line: `[import-worker] watching the queue`.

- [ ] **Step 3: Browser verification**

Start the API + portal dev servers via the Browser pane (use `.claude/launch.json` configs if present; otherwise create them per that file's format). Then, in the browser:

1. Log in, open a move initiative (create one if none exists).
2. The Assets panel shows the **Import assets** button; click it.
3. Download the CSV template; verify the headers.
4. Upload the template file itself, mode `hybrid` → Validate. The report should appear within a few seconds (worker poll is 2 s): 2 rows "will create", make/models `force_created` (template models won't exist in dev).
5. Click Import → progress → completed report with `created: 2`.
6. Back on the move: both assets in the roster, wave/racks/RUs populated, status "Loaded In System".
7. Re-upload the same file → Validate shows 2 "will update"; Import → `updated: 2`.
8. Cancel path: upload again, click Validate then Cancel while queued — job shows cancelled.
9. Screenshot the completed report and the roster for the final summary.

- [ ] **Step 4: Full test suites one last time**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/api && .venv/bin/pytest -q
```

```bash
cd /Users/jrh1812/Developer/BaseCampV3/portal && npx tsc --noEmit && npx vitest run
```

Expected: everything green. Stop the background worker afterwards.

- [ ] **Step 5: Commit any verification fixes**

If fixes were needed, commit them with a descriptive message; otherwise nothing to commit.
