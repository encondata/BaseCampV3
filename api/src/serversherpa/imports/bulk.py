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
