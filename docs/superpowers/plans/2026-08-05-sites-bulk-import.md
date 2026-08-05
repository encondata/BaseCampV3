# Sites Bulk Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bulk create (and developer-approved update) sites from pasted JSON or uploaded CSV/XLSX inside the New-site modal, with template downloads, per spec `docs/superpowers/specs/2026-08-05-sites-bulk-import-design.md`.

**Architecture:** A pure-ish service module `sites/bulk_import.py` owns parsing (csv/xlsx/json → numbered rows), validation, duplicate diffing, and commit; `routes/sites.py` gains three thin endpoints (template/preview/commit) gated on `sites:add` + `max_rank ≥ GATE_BYPASS_RANK`, with the update path additionally gated on `devtools:change`. The portal adds a Bulk tab to `SiteEditModal` (create mode, admin-rank only) rendering preview results and god-mode diff approvals.

**Tech Stack:** FastAPI + SQLAlchemy async + openpyxl (new dep) on the API; React + existing `lib/api.ts` fetch wrapper on the portal.

## Global Constraints

- All-or-nothing: commit imports everything or nothing (422 carries the same per-row payload as preview).
- Duplicates: admin → row error; `devtools:change` actor → `update` action with field diff; every `update` needs explicit approval at commit.
- Blank cell on an update row = "no change", never a clear. Blank `status` → `active`, blank `country` → `US` on create rows.
- Org references by exact case-insensitive name; `clients` semicolon-separated. No match or ambiguous match → row error.
- Limits: 1,000 rows, 5 MB upload.
- Unknown column/key anywhere → whole-payload error listing the names.
- Row numbering: header is row 1 in csv/xlsx so data starts at 2; JSON arrays start at 1.
- Endpoints live under `/sites/bulk-import/…`; audit = per-site rows + one `site_bulk_import` summary row, same transaction.
- Run API tests with `cd api && .venv/bin/pytest tests/<file> -q`; full suite before finishing. Portal: `cd portal && npm run build && npm test`.
- Commit after each task with the message given in the task.

---

### Task 1: Service module — parsing, validation, preview

**Files:**
- Create: `api/src/serversherpa/sites/bulk_import.py`
- Modify: `api/pyproject.toml` (add `"openpyxl>=3.1"` to dependencies)
- Test: `api/tests/test_sites_bulk_import_service.py`

**Interfaces:**
- Produces (used by Tasks 2–4):
  - `COLUMNS: list[str]`, `SAMPLE_ROWS: list[dict]`, `MAX_ROWS = 1000`, `MAX_BYTES = 5 * 1024 * 1024`
  - `class BulkImportError(Exception)` with `.code: str`, `.extra: dict`
  - `parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]` (numbered raw rows)
  - `number_json_rows(rows: list[dict]) -> list[tuple[int, dict]]`
  - `async preview_rows(db, numbered: list[tuple[int, dict]], *, allow_updates: bool) -> dict` returning `{"rows": [RowResult…], "can_commit": bool, "update_allowed": bool}` where RowResult is `{"row": int, "name": str|None, "action": "create"|"update"|"unchanged"|"error", "errors": [str], "diff": dict|None, "site_id": str|None, "data": dict|None}`
  - `build_template_csv() -> str`, `build_template_xlsx() -> bytes`

- [ ] **Step 1: Add openpyxl dependency and install**

In `api/pyproject.toml` dependencies list add `"openpyxl>=3.1",` after the uvicorn line. Run: `cd api && .venv/bin/pip install -q -e ".[dev]"` — expect exit 0.

- [ ] **Step 2: Write failing service tests** (representative set below — write all of them)

```python
"""Parsing + validation pipeline for sites bulk import (no HTTP)."""
import pytest
from serversherpa.sites import bulk_import as bi


def test_columns_match_canonical_shape():
    assert bi.COLUMNS == [
        "name", "code", "type", "status", "address_line1", "address_line2",
        "city", "region", "postal_code", "country", "latitude", "longitude",
        "timezone", "dc_provider", "partner", "clients", "notes"]


def test_csv_and_json_normalize_identically():
    csv_text = bi.build_template_csv()
    from_csv = bi.parse_upload("t.csv", csv_text.encode())
    from_json = bi.number_json_rows(bi.SAMPLE_ROWS)
    assert [r for _, r in from_csv] == [r for _, r in from_json]
    assert [n for n, _ in from_csv] == [2, 3]      # header is row 1
    assert [n for n, _ in from_json] == [1, 2]


def test_xlsx_template_round_trips():
    blob = bi.build_template_xlsx()
    rows = bi.parse_upload("t.xlsx", blob)
    assert [r for _, r in rows] == [r for _, r in bi.number_json_rows(bi.SAMPLE_ROWS)]


def test_unknown_column_rejected():
    with pytest.raises(bi.BulkImportError) as exc:
        bi.number_json_rows([{"name": "A", "citty": "Reno"}])
    assert exc.value.code == "unknown_columns"
    assert exc.value.extra["columns"] == ["citty"]


def test_too_many_rows_rejected():
    with pytest.raises(bi.BulkImportError) as exc:
        bi.number_json_rows([{"name": str(i)} for i in range(1001)])
    assert exc.value.code == "too_many_rows"


async def test_preview_missing_name_and_payload_dupes(db, seeded_user):
    rows = bi.number_json_rows([
        {"name": ""}, {"name": "Twin"}, {"name": "twin"}])
    out = await bi.preview_rows(db, rows, allow_updates=False)
    by_row = {r["row"]: r for r in out["rows"]}
    assert by_row[1]["action"] == "error" and "name" in by_row[1]["errors"][0]
    assert by_row[2]["action"] == "error"     # in-payload duplicate (both rows)
    assert by_row[3]["action"] == "error"
    assert out["can_commit"] is False


async def test_preview_validates_lookups_coords_orgs(db, seeded_user):
    rows = bi.number_json_rows([
        {"name": "A", "type": "spaceport"},
        {"name": "B", "status": "haunted"},
        {"name": "C", "latitude": "95", "longitude": "0"},
        {"name": "D", "latitude": "40"},
        {"name": "E", "partner": "Nobody"},
        {"name": "F", "clients": "Ghost Co"},
    ])
    out = await bi.preview_rows(db, rows, allow_updates=False)
    assert all(r["action"] == "error" for r in out["rows"])


async def test_preview_good_rows_normalize_defaults(db, seeded_user):
    rows = bi.number_json_rows([{"name": "  Fresh DC  ", "city": "Reno"}])
    out = await bi.preview_rows(db, rows, allow_updates=False)
    row = out["rows"][0]
    assert row["action"] == "create" and out["can_commit"] is True
    assert row["data"]["name"] == "Fresh DC"          # trimmed
    assert row["data"]["status"] == "active"          # default applied
    assert row["data"]["country"] == "US"


async def test_duplicate_admin_error_vs_developer_diff(db, seeded_user):
    from serversherpa.db.models import Site
    db.add(Site(name="Exists", city="Old Town", country="US", status="active"))
    await db.commit()
    rows = bi.number_json_rows([{"name": "exists", "city": "New Town"}])
    admin = await bi.preview_rows(db, rows, allow_updates=False)
    assert admin["rows"][0]["action"] == "error"
    dev = await bi.preview_rows(db, rows, allow_updates=True)
    row = dev["rows"][0]
    assert row["action"] == "update" and row["site_id"]
    assert row["diff"]["city"] == {"old": "Old Town", "new": "New Town"}
    assert "country" not in row["diff"]               # blank = no change


async def test_duplicate_with_no_changes_is_unchanged(db, seeded_user):
    from serversherpa.db.models import Site
    db.add(Site(name="Same", city="Reno", country="US", status="active"))
    await db.commit()
    rows = bi.number_json_rows([{"name": "Same", "city": "Reno"}])
    out = await bi.preview_rows(db, rows, allow_updates=True)
    assert out["rows"][0]["action"] == "unchanged"
    assert out["can_commit"] is True
```

Also write: `test_csv_bom_and_numeric_cells` (utf-8-sig header; xlsx numeric postal_code coerces to `"89501"`), `test_ambiguous_existing_name_is_error` (two Sites named "Dup" → developer preview errors), `test_clients_diff_add_remove` (existing site with one linked client; row adds one and drops one → `diff["clients"] == {"add": ["New Co"], "remove": ["Old Co"]}`), `test_bad_file_extension_and_broken_payloads` (`.txt` → `unsupported_file`; invalid JSON text → `invalid_json`; non-list JSON → `invalid_json`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd api && .venv/bin/pytest tests/test_sites_bulk_import_service.py -q`
Expected: import error / attribute errors — module doesn't exist.

- [ ] **Step 4: Implement `sites/bulk_import.py`**

```python
"""Sites bulk import: parse (csv/xlsx/json) → validate → preview/commit.
Pure row pipeline; routes stay thin. All-or-nothing semantics live here."""

import csv
import io
import json
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Client, Partner, Site, SiteClient, SiteType, StatusValue,
)

COLUMNS = [
    "name", "code", "type", "status", "address_line1", "address_line2",
    "city", "region", "postal_code", "country", "latitude", "longitude",
    "timezone", "dc_provider", "partner", "clients", "notes",
]
# template column → Site attribute (identity except type)
SITE_ATTR = {c: ("site_type" if c == "type" else c) for c in COLUMNS
             if c not in ("partner", "clients")}
MAX_ROWS = 1000
MAX_BYTES = 5 * 1024 * 1024

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


class BulkImportError(Exception):
    """Whole-payload failure (not a per-row error)."""

    def __init__(self, code: str, **extra: Any) -> None:
        super().__init__(code)
        self.code = code
        self.extra = extra


# ── parsing ─────────────────────────────────────────────────────────

def _cell(value: Any) -> str:
    """Spreadsheet cells arrive as str/float/int/bool/None — normalize to
    trimmed text. Integral floats (openpyxl's 89501.0) drop the .0 so
    numeric-looking text columns round-trip."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _check_columns(keys: list[str]) -> None:
    unknown = sorted({k for k in keys if k not in COLUMNS})
    if unknown:
        raise BulkImportError("unknown_columns", columns=unknown)


def _numbered(rows: list[dict], first_row: int) -> list[tuple[int, dict]]:
    if len(rows) > MAX_ROWS:
        raise BulkImportError("too_many_rows", limit=MAX_ROWS)
    out: list[tuple[int, dict]] = []
    for i, raw in enumerate(rows):
        _check_columns(list(raw.keys()))
        row = {col: _cell(raw.get(col)) for col in COLUMNS}
        if any(v != "" for v in row.values()):        # skip fully blank lines
            out.append((first_row + i, row))
    return out


def number_json_rows(rows: list[dict]) -> list[tuple[int, dict]]:
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise BulkImportError("invalid_json")
    return _numbered(rows, first_row=1)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    if len(content) > MAX_BYTES:
        raise BulkImportError("file_too_large", limit=MAX_BYTES)
    name = filename.lower()
    if name.endswith(".json"):
        try:
            return number_json_rows(json.loads(content.decode("utf-8-sig")))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise BulkImportError("invalid_json") from None
    if name.endswith(".csv"):
        try:
            reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
        except UnicodeDecodeError:
            raise BulkImportError("invalid_csv") from None
        if reader.fieldnames is None:
            raise BulkImportError("invalid_csv")
        _check_columns([f for f in reader.fieldnames if f])
        rows = [{k: v for k, v in r.items() if k} for r in reader]
        return _numbered(rows, first_row=2)
    if name.endswith(".xlsx"):
        import openpyxl
        try:
            wb = openpyxl.load_workbook(io.BytesIO(content),
                                        read_only=True, data_only=True)
        except Exception:
            raise BulkImportError("invalid_xlsx") from None
        ws = wb["Sites"] if "Sites" in wb.sheetnames else wb.worksheets[0]
        lines = ws.iter_rows(values_only=True)
        header = [_cell(h) for h in next(lines, tuple()) or tuple()]
        header = [h for h in header if h]
        if not header:
            raise BulkImportError("invalid_xlsx")
        _check_columns(header)
        rows = [dict(zip(header, line)) for line in lines]
        return _numbered(rows, first_row=2)
    raise BulkImportError("unsupported_file")


# ── templates ───────────────────────────────────────────────────────

def build_template_csv() -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(SAMPLE_ROWS)
    return buf.getvalue()


def build_template_xlsx() -> bytes:
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sites"
    ws.append(COLUMNS)
    for row in SAMPLE_ROWS:
        ws.append([row[c] for c in COLUMNS])
    return b""  # replaced below — see Step 4 note


# ── validation + preview ────────────────────────────────────────────

async def _reference_data(db: AsyncSession) -> dict:
    type_keys = {t.key for t in await db.scalars(select(SiteType))}
    status_keys = set(await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "site")))
    partners = {}
    for p in await db.scalars(select(Partner)):
        partners.setdefault(p.name.lower(), []).append(p)
    clients = {}
    for c in await db.scalars(select(Client)):
        clients.setdefault(c.name.lower(), []).append(c)
    return {"types": type_keys, "statuses": status_keys,
            "partners": partners, "clients": clients}


def _split_clients(cell: str) -> list[str]:
    return [part.strip() for part in cell.split(";") if part.strip()]


def _coord(value: str, lo: float, hi: float, errors: list[str], label: str):
    if value == "":
        return None
    try:
        num = float(value)
    except ValueError:
        errors.append(f"{label} is not a number")
        return None
    if not (lo <= num <= hi):
        errors.append(f"{label} out of range")
        return None
    return num
```

(continued — same file)

```python
async def preview_rows(db: AsyncSession, numbered: list[tuple[int, dict]],
                       *, allow_updates: bool) -> dict:
    ref = await _reference_data(db)
    names_seen: dict[str, list[int]] = {}
    for n, row in numbered:
        if row["name"]:
            names_seen.setdefault(row["name"].lower(), []).append(n)

    existing: dict[str, list[Site]] = {}
    if numbered:
        wanted = [row["name"] for _, row in numbered if row["name"]]
        for site in await db.scalars(select(Site).where(Site.name.in_(wanted))):
            existing.setdefault(site.name.lower(), []).append(site)

    current_clients: dict[uuid.UUID, dict[uuid.UUID, str]] = {}
    dup_ids = [s.id for sites in existing.values() for s in sites]
    if dup_ids:
        links = (await db.execute(
            select(SiteClient.site_id, Client.id, Client.name)
            .join(Client, Client.id == SiteClient.client_id)
            .where(SiteClient.site_id.in_(dup_ids)))).all()
        for site_id, client_id, cname in links:
            current_clients.setdefault(site_id, {})[client_id] = cname

    results = []
    for n, row in numbered:
        errors: list[str] = []
        name = row["name"]
        if not name:
            errors.append("name is required")
        elif len(names_seen[name.lower()]) > 1:
            errors.append(f"duplicate name '{name}' within the import")

        if row["type"] and row["type"] not in ref["types"]:
            errors.append(f"unknown type '{row['type']}'")
        if row["status"] and row["status"] not in ref["statuses"]:
            errors.append(f"unknown status '{row['status']}'")

        lat = _coord(row["latitude"], -90, 90, errors, "latitude")
        lon = _coord(row["longitude"], -180, 180, errors, "longitude")
        if (row["latitude"] == "") != (row["longitude"] == ""):
            errors.append("latitude and longitude must both be set")

        partner_obj = None
        if row["partner"]:
            matches = ref["partners"].get(row["partner"].lower(), [])
            if len(matches) == 0:
                errors.append(f"unknown partner '{row['partner']}'")
            elif len(matches) > 1:
                errors.append(f"ambiguous partner '{row['partner']}'")
            else:
                partner_obj = matches[0]

        client_objs: list[Client] = []
        for cname in _split_clients(row["clients"]):
            matches = ref["clients"].get(cname.lower(), [])
            if len(matches) == 0:
                errors.append(f"unknown client '{cname}'")
            elif len(matches) > 1:
                errors.append(f"ambiguous client '{cname}'")
            else:
                client_objs.append(matches[0])

        data = dict(row)
        data["name"] = name
        data["latitude"], data["longitude"] = lat, lon
        data["clients"] = _split_clients(row["clients"])
        if not data["status"]:
            data["status"] = "active"
        if not data["country"]:
            data["country"] = "US"

        dupes = existing.get(name.lower(), []) if name else []
        action, diff_out, site_id = "create", None, None
        if errors:
            action = "error"
        elif dupes:
            if len(dupes) > 1:
                action = "error"
                errors.append(f"multiple existing sites named '{name}'")
            elif not allow_updates:
                action = "error"
                errors.append(f"site '{name}' already exists")
            else:
                site = dupes[0]
                site_id = str(site.id)
                diff_out = _diff_row(site, data, partner_obj, client_objs,
                                     current_clients.get(site.id, {}))
                action = "update" if diff_out else "unchanged"
                diff_out = diff_out or None

        results.append({"row": n, "name": name or None, "action": action,
                        "errors": errors, "diff": diff_out, "site_id": site_id,
                        "data": data if action != "error" else None})

    can_commit = bool(results) and all(r["action"] != "error" for r in results)
    return {"rows": results, "can_commit": can_commit,
            "update_allowed": allow_updates}


def _diff_row(site: Site, data: dict, partner_obj, client_objs,
              linked: dict) -> dict:
    """Changed fields only; blank in data = no change (create-only defaults
    for status/country do NOT apply to update rows — the raw cell decides)."""
    out: dict = {}
    for col, attr in SITE_ATTR.items():
        raw = data[col]
        if col in ("status", "country") and not _raw_present(data, col):
            continue
        if col in ("latitude", "longitude"):
            if raw is None:
                continue
            old = getattr(site, attr)
            old = float(old) if old is not None else None
            if old != raw:
                out[col] = {"old": old, "new": raw}
            continue
        if raw == "" or raw is None:
            continue
        old = getattr(site, attr)
        if (old or "") != raw:
            out[col] = {"old": old, "new": raw}
    if data["partner"]:
        if partner_obj and site.partner_id != partner_obj.id:
            out["partner"] = {"old": None, "new": partner_obj.name}
    if data["clients"]:
        want = {c.id: c.name for c in client_objs}
        add = sorted(n for i, n in want.items() if i not in linked)
        remove = sorted(n for i, n in linked.items() if i not in want)
        if add or remove:
            out["clients"] = {"add": add, "remove": remove}
    return out
```

Notes for the implementer resolving the two deliberate gaps above:
- `build_template_xlsx` returns real bytes: after building `wb`, add the Reference sheet (`ref = wb.create_sheet("Reference")`, write `["Valid type keys"]` header then one key per row, blank row, `["Valid status keys"]` then keys — pass valid keys IN: change signature to `build_template_xlsx(type_keys: list[str], status_keys: list[str]) -> bytes` and update the template test to pass `["datacenter"], ["active"]`), then `buf = io.BytesIO(); wb.save(buf); return buf.getvalue()`. `build_template_csv` needs no keys.
- `_raw_present(data, col)`: blank status/country were overwritten by defaults in `data` before diffing, so keep the ORIGINAL cell around: store `data["_blank"] = {"status": row["status"] == "", "country": row["country"] == ""}` before defaulting, have `_raw_present` read it, and strip the `_blank` key from the `data` dict placed in the result payload. The partner diff `old` value: look up the site's current partner name (fetch names for all `site.partner_id`s of duplicate sites in `preview_rows`, pass into `_diff_row`) rather than `None`.

- [ ] **Step 5: Run tests until green**

Run: `cd api && .venv/bin/pytest tests/test_sites_bulk_import_service.py -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add api/pyproject.toml api/src/serversherpa/sites/bulk_import.py api/tests/test_sites_bulk_import_service.py
git commit -m "feat(api): sites bulk-import service — parse csv/xlsx/json, validate, preview diff"
```

---

### Task 2: Commit logic in the service

**Files:**
- Modify: `api/src/serversherpa/sites/bulk_import.py`
- Test: `api/tests/test_sites_bulk_import_service.py` (append)

**Interfaces:**
- Produces: `async commit_rows(db, actor_person_id: uuid.UUID, numbered, *, allow_updates: bool, approved_updates: set[str], source_label: str) -> dict` returning `{"created": n, "updated": n, "unchanged": n}`; raises `BulkImportError("rows_invalid", rows=[…preview rows…])` when anything blocks. Adds all Site/SiteClient/audit rows to the session and COMMITS.

- [ ] **Step 1: Write failing tests** — `test_commit_creates_sites_links_and_audit` (two create rows, one with clients + partner; assert Site rows exist with trimmed name/status default, SiteClient links, per-site `audit_log` action `create` rows plus one `site_bulk_import` summary row whose changes carry the counts); `test_commit_all_or_nothing` (one good + one bad row → `BulkImportError`, site count unchanged, zero audit rows); `test_commit_update_requires_approval` (developer path, update row, empty `approved_updates` → error; with approval → city changed, `update` audit row, `updated == 1`); `test_commit_unchanged_rows_skipped` (unchanged row commits fine, counts `unchanged == 1`, no update audit row).

- [ ] **Step 2: Run to verify failure** — `cd api && .venv/bin/pytest tests/test_sites_bulk_import_service.py -q` → AttributeError: no `commit_rows`.

- [ ] **Step 3: Implement**

```python
async def commit_rows(db: AsyncSession, actor_person_id: uuid.UUID,
                      numbered: list[tuple[int, dict]], *, allow_updates: bool,
                      approved_updates: set[str], source_label: str) -> dict:
    from serversherpa.services.audit import audit, diff, snapshot
    from serversherpa.api.routes.sites import SITE_FIELDS  # circular-safe: routes import us lazily

    preview = await preview_rows(db, numbered, allow_updates=allow_updates)
    blocked = [r for r in preview["rows"] if r["action"] == "error"]
    unapproved = [r for r in preview["rows"]
                  if r["action"] == "update" and r["site_id"] not in approved_updates]
    if blocked or unapproved or not preview["rows"]:
        for r in unapproved:
            r["errors"] = [*r["errors"], "update not approved"]
        raise BulkImportError("rows_invalid", rows=preview["rows"])

    created = updated = unchanged = 0
    for r in preview["rows"]:
        data = r["data"]
        if r["action"] == "unchanged":
            unchanged += 1
            continue
        if r["action"] == "create":
            site = await _create_site(db, actor_person_id, data)
            created += 1
        else:
            site = await _apply_update(db, actor_person_id, r, data)
            updated += 1
    audit(db, actor_id=actor_person_id, entity_type="site_bulk_import",
          entity_id=None, action="bulk_import",
          changes={"created": created, "updated": updated,
                   "unchanged": unchanged, "source": source_label})
    await db.commit()
    return {"created": created, "updated": updated, "unchanged": unchanged}
```

with `_create_site` building `Site(**{SITE_ATTR[c]: v for c, v in … if v not in ("", None)}, created_by=…)`, resolving partner name → `partner_id`, adding `SiteClient` links, and writing the same create-audit shape as `create_site` in routes; `_apply_update` re-resolving the diff (call `_diff_row` output already in `r["diff"]`), applying scalar fields via `SITE_ATTR`, partner by name, client add/remove by name→id, and auditing with the routes' update shape (`diff(before, after)` over the touched fields plus a `clients.set`-style entry when links changed). Re-fetch each duplicate `Site` by `r["site_id"]` with `await db.get(Site, uuid.UUID(r["site_id"]))`.

- [ ] **Step 4: Run until green** — same command, all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): sites bulk-import commit — atomic create/update with audit"`

---

### Task 3: HTTP endpoints

**Files:**
- Modify: `api/src/serversherpa/api/routes/sites.py`
- Test: `api/tests/test_sites_bulk_import_api.py`

**Interfaces:**
- Produces: `GET /sites/bulk-import/template?format=csv|xlsx|json`, `POST /sites/bulk-import/preview` (JSON `{"rows": […]}` or multipart `file`), `POST /sites/bulk-import/commit` (JSON `{"rows": […], "approved_updates": […]}`). All: `sites:add` + `actor.access.max_rank >= GATE_BYPASS_RANK` else 403 `{"code": "forbidden"}`. Payload-level `BulkImportError` → 422 `{"code": <err.code>, **extra}`; `rows_invalid` → 422 `{"code": "rows_invalid", "rows": […]}`.

- [ ] **Step 1: Write failing tests.** Fixtures: `admin_user` (Person+account role `admin`, via `make_login`), `dev_user` (role `developer`), reuse `seeded_user` (staff) for the 403 case. Tests: `test_staff_rank_forbidden` (staff → 403 on all three), `test_template_formats` (csv content-type + header row matches COLUMNS; xlsx loads via openpyxl with sheets `Sites`+`Reference`; json body == SAMPLE_ROWS), `test_preview_json_and_file_paths` (JSON body previews; same rows uploaded as `files={"file": ("x.csv", csv_bytes, "text/csv")}` give identical row results), `test_preview_admin_sees_duplicate_error_developer_sees_update`, `test_commit_end_to_end` (admin commits two creates → 200 counts, sites exist), `test_commit_atomicity_via_api` (one bad row → 422 `rows_invalid`, no sites created), `test_commit_approval_flow` (dev: unapproved 422; approved 200, field changed), `test_admin_cannot_smuggle_approved_updates` (admin sends `approved_updates` for an existing site → 422, nothing changes).

- [ ] **Step 2: Run to verify failure** — 404s (routes missing).

- [ ] **Step 3: Implement routes** (in `routes/sites.py`, below the survey endpoint):

```python
from fastapi import Request, Response
from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.sites import bulk_import as bulk


def _require_bulk_rank(actor: AuthContext) -> None:
    _require_global(actor)
    if actor.access.max_rank < GATE_BYPASS_RANK:
        raise _err(403, "forbidden")


@router.get("/bulk-import/template")
async def bulk_import_template(
    db: DbSession,
    format: str = "csv",
    actor: AuthContext = require_permission("sites", "add"),
):
    _require_bulk_rank(actor)
    if format == "json":
        return bulk.SAMPLE_ROWS
    if format == "csv":
        return Response(bulk.build_template_csv(), media_type="text/csv",
                        headers={"Content-Disposition":
                                 'attachment; filename="sites-template.csv"'})
    if format == "xlsx":
        types = [t.key for t in await db.scalars(select(SiteType))]
        statuses = list(await db.scalars(select(StatusValue.key).where(
            StatusValue.record_type == "site")))
        blob = bulk.build_template_xlsx(types, statuses)
        return Response(
            blob,
            media_type="application/vnd.openxmlformats-officedocument"
                       ".spreadsheetml.sheet",
            headers={"Content-Disposition":
                     'attachment; filename="sites-template.xlsx"'})
    raise _err(422, "unknown_format")


async def _rows_from_request(request: Request) -> list[tuple[int, dict]]:
    ctype = request.headers.get("content-type", "")
    try:
        if ctype.startswith("multipart/"):
            form = await request.form()
            upload = form.get("file")
            if upload is None or isinstance(upload, str):
                raise bulk.BulkImportError("missing_file")
            return bulk.parse_upload(upload.filename or "",
                                     await upload.read())
        body = await request.json()
        return bulk.number_json_rows(body.get("rows"))
    except bulk.BulkImportError as exc:
        raise _err(422, exc.code, **{k: v for k, v in exc.extra.items()
                                     if k != "rows"}) from None
    except (ValueError, AttributeError):
        raise _err(422, "invalid_json") from None


@router.post("/bulk-import/preview")
async def bulk_import_preview(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "add"),
) -> dict:
    _require_bulk_rank(actor)
    numbered = await _rows_from_request(request)
    return await bulk.preview_rows(
        db, numbered, allow_updates=actor.access.can("devtools", "change"))


@router.post("/bulk-import/commit")
async def bulk_import_commit(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("sites", "add"),
) -> dict:
    _require_bulk_rank(actor)
    body = await request.json()
    numbered = bulk.number_json_rows(body.get("rows"))
    approved = set(body.get("approved_updates") or [])
    allow = actor.access.can("devtools", "change")
    if approved and not allow:
        raise _err(422, "updates_not_allowed")
    try:
        return await bulk.commit_rows(
            db, actor.person.id, numbered, allow_updates=allow,
            approved_updates=approved,
            source_label=body.get("source") or "paste")
    except bulk.BulkImportError as exc:
        raise _err(422, exc.code, **exc.extra) from None
```

Route-order caveat: these paths must be registered BEFORE `GET /sites/{site_id}` matches them — FastAPI matches in declaration order, and `/{site_id}` is declared above. `bulk-import` is not a valid UUID so `/{site_id}` rejects it with a 422 instead of falling through. Therefore declare the three bulk endpoints ABOVE `get_site` in the file (directly under `get_survey_schema`, which exists for the same reason).

- [ ] **Step 4: Run until green** — `cd api && .venv/bin/pytest tests/test_sites_bulk_import_api.py -q`, then the whole suite `cd api && .venv/bin/pytest tests/ -q` (expect no regressions).
- [ ] **Step 5: Commit** — `git commit -m "feat(api): sites bulk-import endpoints — template/preview/commit, admin-rank gated"`

---

### Task 4: Portal API client + Bulk pane component

**Files:**
- Modify: `portal/src/lib/api.ts` (bulk types + 3 functions)
- Create: `portal/src/components/sites/SiteBulkImport.tsx`
- Modify: `portal/src/components/sites/SiteEditModal.tsx` (mode toggle)
- Test: `portal/src/components/sites/SiteBulkImport.test.tsx`

**Interfaces:**
- Consumes: Task 3's endpoints.
- Produces in `api.ts`:

```typescript
export interface BulkRowResult {
  row: number; name: string | null;
  action: 'create' | 'update' | 'unchanged' | 'error';
  errors: string[];
  diff: Record<string, { old?: unknown; new?: unknown; add?: string[]; remove?: string[] }> | null;
  site_id: string | null;
  data: Record<string, unknown> | null;
}
export interface BulkPreview { rows: BulkRowResult[]; can_commit: boolean; update_allowed: boolean }
export async function getSiteBulkSample(): Promise<Record<string, string>[]>      // GET …?format=json
export async function previewSiteBulk(file: File | Blob, filename: string): Promise<BulkPreview>  // multipart
export async function commitSiteBulk(rows: Record<string, unknown>[], approved: string[], source: string): Promise<{created: number; updated: number; unchanged: number}>
export async function downloadSiteTemplate(format: 'csv' | 'xlsx'): Promise<void> // apiFetch → blob → object URL → a.click()
```

- [ ] **Step 1: Write the component test first** (`SiteBulkImport.test.tsx`, following `SiteEditModal.test.tsx`'s mocking style — mock `../../lib/api`): renders template buttons + prefilled textarea from mocked `getSiteBulkSample`; clicking Preview with mocked `previewSiteBulk` returning one `create` + one `error` row renders both chips and keeps Import disabled; with `update_allowed` and an `update` row, Import stays disabled until its Approve checkbox is checked; approved commit calls `commitSiteBulk` with the row `data`s and the approved id.
- [ ] **Step 2: Run to verify failure** — `cd portal && npm test` → new test file fails (module missing).
- [ ] **Step 3: Implement `api.ts` additions.** `previewSiteBulk` builds `FormData` with `fd.append('file', file, filename)` and calls `apiFetch('/sites/bulk-import/preview', {method: 'POST', body: fd})` (apiFetch must NOT set a JSON content-type when body is FormData — check and branch if needed). Pasted JSON is sent as `new Blob([text], {type: 'application/json'})` named `paste.json`, so the API's one multipart path serves both.
- [ ] **Step 4: Implement `SiteBulkImport.tsx`.** Props: `{ onDone: () => Promise<void> | void }`. State: sample text, file, preview, approvals (Set of site_id), busy, error. Layout per spec §3 (template buttons row, textarea, file input, preview table with action chips, god-diff rows with Approve checkboxes + approve-all, Import gated on `can_commit && every update approved`). On success: toast-equivalent inline notice with counts, then `onDone()`.
- [ ] **Step 5: Wire the toggle into `SiteEditModal.tsx`.** In create mode only, when `useAuth().maxRank >= 60`, render two tab buttons under `modal-head` (`Single site` / `Bulk import`); bulk tab renders `<SiteBulkImport onDone={async () => { await onSaved(); onClose(); }} />` instead of the form. Edit mode untouched.
- [ ] **Step 6: Run until green** — `cd portal && npm test`, then `npm run build` (tsc must pass).
- [ ] **Step 7: Commit** — `git commit -m "feat(portal): bulk-import tab in New-site modal with preview + god-mode diffs"`

---

### Task 5: End-to-end verification

- [ ] **Step 1:** Full API suite: `cd api && .venv/bin/pytest tests/ -q` — all pass, count noted.
- [ ] **Step 2:** Portal: `cd portal && npm run build && npm test` — clean.
- [ ] **Step 3:** Live check against the dev stack (API on :8000): authenticate is NOT possible for agents — instead verify route registration via OpenAPI: `curl -s http://127.0.0.1:8000/openapi.json | python3 -c "import json,sys; paths=json.load(sys.stdin)['paths']; print([p for p in paths if 'bulk-import' in p])"` → the three paths print. Browser-side verification of the modal is Jimmy's (login-gated).
- [ ] **Step 4:** Commit any stragglers; report counts + what was verified.
