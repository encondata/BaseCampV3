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
        bulk.parse_upload("x.csv", b"\xff\xfe\x00bad", COLS, "S")   # not utf-8
    assert exc.value.code == "invalid_csv"
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
