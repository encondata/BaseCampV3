"""Excel and CSV: GET /plans/{id}/export.xlsx, and the imports POST
/plans/{id}/import and POST /initiatives/{id}/plan/import with an .xlsx or
.csv file (plans/excel.py, through plans/importer.py). Every import is a
dry run, a per-row summary, then an apply; a dry run writes nothing.

Workbooks are hostile input: the reader streams the first sheet, never
evaluates a formula, and refuses a package that unpacks past the cap."""

import csv
import io
import re
import zipfile
from datetime import datetime
from pathlib import Path

import openpyxl
import pytest
from openpyxl import Workbook
from sqlalchemy import func, select

from serversherpa.db.models import InitiativePerson
from serversherpa.plans import excel
from serversherpa.plans.models import PlanTask, ProjectPlan
from tests.test_plans_api import _admin, _create, _initiative
from tests.test_plans_links import _assign, _resources
from tests.test_plans_mspdi import _pat, _sample
from tests.test_plans_ops import _add, _get, _ok, _update

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
COLUMNS_TS = (Path(__file__).resolve().parents[2] / "portal" / "src" / "lib" / "plans"
              / "columns.ts")
START_IGNORED = "Start ignored — set by links."

# ── helpers ──────────────────────────────────────────────────────────


def _xlsx(rows: list[list], formats: dict[tuple[int, int], str] | None = None) -> bytes:
    """A workbook whose first sheet holds `rows` (row 1 the header);
    `formats` sets a number format on (row, column) cells."""
    wb = Workbook()
    ws = wb.active
    for row in rows:
        ws.append(row)
    for (r, c), fmt in (formats or {}).items():
        ws.cell(r, c).number_format = fmt
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _csv(rows: list[list]) -> bytes:
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\r\n").writerows(rows)
    return buf.getvalue().encode("utf-8-sig")


def _replace(content: bytes, name: str, data: bytes) -> bytes:
    """`content` (a zip) with member `name` replaced by `data`."""
    src = zipfile.ZipFile(io.BytesIO(content))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for info in src.infolist():
            z.writestr(info.filename, data if info.filename == name else src.read(info))
    return out.getvalue()


SHEET = "xl/worksheets/sheet1.xml"
MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'


def _with_sheet(body: str, *, prolog: str = "") -> bytes:
    """A real workbook whose first sheet's XML is replaced by `body` (the
    sheetData's rows) after an optional `prolog` (a DOCTYPE)."""
    xml = (f'<?xml version="1.0" encoding="UTF-8"?>{prolog}<worksheet {MAIN}>'
           f"<sheetData>{body}</sheetData></worksheet>")
    return _replace(_xlsx([["Name"]]), SHEET, xml.encode())


def _inline(ref: str, text: str) -> str:
    return f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>'


async def _setup(client, db):
    """An empty plan on an initiative whose team has Pat Lee."""
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    pat = await _pat(db, move)
    plan = await _create(client, hdrs, move)
    return hdrs, move, plan, pat


async def _post(client, hdrs, url, content, *, filename="plan.xlsx", content_type=XLSX,
                **params):
    params = {k: ("1" if v is True else "0" if v is False else v) for k, v in params.items()}
    return await client.post(url, headers=hdrs, params=params,
                             files={"file": (filename, content, content_type)})


async def _import(client, hdrs, plan, content, **kwargs):
    return await _post(client, hdrs, f"/plans/{plan['id']}/import", content, **kwargs)


async def _ok_import(client, hdrs, plan, content, **kwargs) -> dict:
    resp = await _import(client, hdrs, plan, content, **kwargs)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _rows(body) -> dict[str, dict]:
    return {row["name"]: row for row in body["rows"]}


def _tasks(body) -> dict[str, dict]:
    return {t["name"]: t for t in body["tasks"]}


def _bad_file(resp, status=422, code="bad_file") -> dict:
    assert resp.status_code == status, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == code, detail
    return detail


async def _task_count(db, plan_id) -> int:
    return await db.scalar(select(func.count()).select_from(PlanTask)
                           .where(PlanTask.plan_id == plan_id))


def _sheet(content: bytes):
    """The exported workbook's first sheet (our own file: a full load)."""
    wb = openpyxl.load_workbook(io.BytesIO(content))
    return wb.worksheets[0]


def _header(ws) -> list:
    return [c.value for c in ws[1]]


def _by_name(ws) -> dict[str, dict]:
    """Each data row's cells by header, keyed by Task Name."""
    header = _header(ws)
    col = header.index("Task Name")
    out = {}
    for row in ws.iter_rows(min_row=2):
        out[row[col].value] = dict(zip(header, row, strict=True))
    return out


# ── export ──────────────────────────────────────────────────────────


async def test_export_xlsx(client, db):
    """One sheet "Project plan": MS Project's column names for the sheet's
    default columns plus Outline Level, names indented by level, summary
    rows bold, dates as real Excel dates (wall clock), % Complete a
    percent."""
    hdrs, move, plan, _pat_row = await _setup(client, db)
    resp = await client.post(f"/plans/{plan['id']}/import", headers=hdrs,
                             params={"dry_run": "0", "mode": "fill"},
                             files={"file": ("plan.xml", _sample(), "application/xml")})
    assert resp.status_code == 200, resp.text
    move.code = "NAP11"
    await db.commit()

    resp = await client.get(f"/plans/{plan['id']}/export.xlsx", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == XLSX
    disposition = resp.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="NAP11 - Project plan.xlsx"'), disposition

    wb = openpyxl.load_workbook(io.BytesIO(resp.content))
    assert wb.sheetnames == ["Project plan"]
    ws = wb.worksheets[0]
    assert _header(ws) == ["ID", "Mode", "Task Name", "Duration", "Start", "Finish",
                           "Predecessors", "Resource Names", "% Complete", "Deadline",
                           "Outline Level"]
    assert all(c.font.bold for c in ws[1])
    rows = _by_name(ws)
    assert list(rows) == ["Phase 1 - Prep", "Site survey", "Pack equipment", "Label racks",
                          "Phase 2 - Move", "Truck loading", "Rack install", "Go live"]

    phase, survey, pack = rows["Phase 1 - Prep"], rows["Site survey"], rows["Pack equipment"]
    assert phase["ID"].value == 1 and survey["ID"].value == 2
    assert phase["Outline Level"].value == 1 and survey["Outline Level"].value == 2
    assert phase["Task Name"].alignment.indent == 0
    assert survey["Task Name"].alignment.indent == 1
    assert phase["Task Name"].font.bold and phase["Duration"].font.bold
    assert not survey["Task Name"].font.bold
    assert survey["Mode"].value == "Auto Scheduled"
    assert survey["Duration"].value == "2 days"
    assert survey["Start"].value == datetime(2026, 11, 2, 8, 0)
    assert survey["Finish"].value == datetime(2026, 11, 3, 17, 0)
    assert survey["Start"].is_date
    assert survey["Resource Names"].value == "Pat Lee"
    assert survey["% Complete"].value == 0 and survey["% Complete"].number_format == "0%"
    assert pack["Predecessors"].value == "2SS+2 days"
    assert pack["Deadline"].value == datetime(2026, 11, 6, 17, 0)
    assert rows["Go live"]["Duration"].value == "0 days"
    assert ws.freeze_panes == "A2"


async def test_export_columns_and_color(client, db):
    """`columns` picks the sheet's columns by key (unknown keys and the
    Indicators icons are skipped; ID and Task Name are always there); a
    Color column (#rrggbb) joins whenever a task has a color."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "Plain", "Painted")
    await _ok(client, hdrs, plan, [
        _update(ids["Painted"], color="#3B82F6", notes="Line one\nLine two & more"),
    ])
    url = f"/plans/{plan['id']}/export.xlsx"

    ws = _sheet((await client.get(url, headers=hdrs,
                                  params={"columns": "indicators,id,name,wbs,notes,bogus,id"})
                 ).content)
    assert _header(ws) == ["ID", "Task Name", "WBS", "Notes", "Outline Level", "Color"]
    rows = _by_name(ws)
    assert rows["Painted"]["Color"].value == "#3b82f6"
    assert rows["Plain"]["Color"].value is None
    assert rows["Painted"]["Notes"].value == "Line one\nLine two & more"
    assert rows["Painted"]["WBS"].value == "2"

    ws = _sheet((await client.get(url, headers=hdrs, params={"columns": "color,duration"})
                 ).content)
    assert _header(ws) == ["ID", "Task Name", "Color", "Duration", "Outline Level"]

    await _ok(client, hdrs, plan, [_update(ids["Painted"], color=None)])
    ws = _sheet((await client.get(url, headers=hdrs)).content)
    assert "Color" not in _header(ws)


async def test_export_never_writes_a_formula(client, db):
    """A name typed as a formula stays text in the workbook."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    await _add(client, hdrs, plan, '=HYPERLINK("http://example.com","x")')
    resp = await client.get(f"/plans/{plan['id']}/export.xlsx", headers=hdrs)
    with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
        assert b"<f>" not in z.read(SHEET)
    ws = _sheet(resp.content)
    assert ws.cell(2, _header(ws).index("Task Name") + 1).data_type == "s"


def test_columns_mirror_the_portal_sheet():
    """The export's column keys and names are the portal sheet's
    (portal/src/lib/plans/columns.ts), in its order."""
    text = COLUMNS_TS.read_text()
    portal = {}
    for m in re.finditer(r"key: '([a-z_]+)', label: '([^']+)'"
                         r"|dateColumn\('([a-z_]+)', '([^']+)'", text):
        key, label = (m[1], m[2]) if m[1] else (m[3], m[4])
        portal[key] = label
    assert len(portal) == 29
    assert {k: v for k, v in portal.items() if k != "indicators"} == excel.COLUMNS
    assert list(excel.COLUMNS) == [k for k in portal if k != "indicators"]
    assert excel.DEFAULT_COLUMNS == ("id", "mode", "name", "duration", "start", "finish",
                                     "predecessors", "resources", "percent", "deadline")


# ── import ──────────────────────────────────────────────────────────

OUTLINE_SHEET = [
    ["Name", "Duration", "Predecessors", "Outline Level"],
    ["Prep", None, None, 1],
    ["Survey", "2d", None, 2],
    ["Pack", "3 days", "2SS+1d", 2],
    ["Move", None, "1", 1],
    ["Load", 1, "3FF", 2],
    ["Go live", "0", "5", 2],
]


async def test_import_builds_the_outline_and_links(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _xlsx(OUTLINE_SHEET)
    body = await _ok_import(client, hdrs, plan, content, dry_run=True, mode="fill")
    assert [row["name"] for row in body["rows"]] == ["Prep", "Survey", "Pack", "Move", "Load",
                                                      "Go live"]
    assert all(row["problems"] == [] for row in body["rows"]), body["rows"]
    assert body["problems"] == [] and body["summary"] == {"created": 6, "problems": 0}
    assert body["version"] == plan["version"]
    assert await _task_count(db, plan["id"]) == 0          # the dry run wrote nothing

    body = await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill",
                            base_version=body["version"])
    got = await _get(client, hdrs, plan)
    assert body["version"] == got["version"] == plan["version"] + 1
    assert [t["wbs"] for t in got["tasks"]] == ["1", "1.1", "1.2", "2", "2.1", "2.2"]
    tasks = _tasks(got)
    assert tasks["Prep"]["is_summary"] and tasks["Move"]["is_summary"]
    assert tasks["Survey"]["duration_text"] == "2 days"
    assert tasks["Load"]["duration_text"] == "1 day"
    assert tasks["Pack"]["predecessors"] == "2SS+1 day"
    assert tasks["Pack"]["start"] == "2026-11-03T08:00"
    assert tasks["Move"]["predecessors"] == "1"
    assert tasks["Load"]["predecessors"] == "3FF"
    assert tasks["Go live"]["predecessors"] == "5"
    assert tasks["Go live"]["is_milestone"] is True            # a 0 duration
    assert len(got["links"]) == 4


async def test_wbs_only_sheet_nests(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _xlsx([
        ["WBS", "Task Name", "Duration"],
        ["1", "Phase A", None],
        ["1.1", "A1", "2d"],
        ["1.2", "A2", "1d"],
        ["1.2.1", "A21", "1d"],
        ["2", "Phase B", None],
        ["2.1", "B1", "4h"],
    ])
    await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    got = await _get(client, hdrs, plan)
    assert [(t["name"], t["outline_level"]) for t in got["tasks"]] == [
        ("Phase A", 1), ("A1", 2), ("A2", 2), ("A21", 3), ("Phase B", 1), ("B1", 2)]
    tasks = _tasks(got)
    assert tasks["A21"]["parent_id"] == tasks["A2"]["id"]
    assert tasks["B1"]["duration_text"] == "4 hrs"


async def test_flat_sheet_without_levels(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _xlsx([["Task Name"], ["One"], ["Two"]])
    await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    got = await _get(client, hdrs, plan)
    assert [(t["name"], t["outline_level"]) for t in got["tasks"]] == [("One", 1), ("Two", 1)]


async def test_bad_duration_is_a_problem_row(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _xlsx([["Name", "Duration"], ["Good", "2d"], ["Bad", "soon-ish"],
                     ["Estimated", "3 days?"]])
    body = await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    rows = _rows(body)
    (problem,) = rows["Bad"]["problems"]
    assert "Duration" in problem and "soon-ish" in problem and "default duration" in problem
    assert rows["Good"]["problems"] == [] and rows["Estimated"]["problems"] == []
    assert body["summary"] == {"created": 3, "problems": 1}
    tasks = _tasks(await _get(client, hdrs, plan))
    assert tasks["Bad"]["duration_text"] == "1 day"             # the plan's default
    assert tasks["Estimated"]["duration_text"] == "3 days"


async def test_csv_import(client, db):
    """A CSV (UTF-8, with Excel's BOM): text dates (MS Project's own and
    ISO), % Complete as text, IDs as the predecessors' numbers, resources
    matched by name, a Start on an unlinked task kept as Start No Earlier
    Than and dropped on a linked one, a bad color a problem."""
    hdrs, _move, plan, pat = await _setup(client, db)
    content = _csv([
        ["ID", "Task Name", "Duration", "Start", "Predecessors", "Resource Names",
         "% Complete", "Deadline", "Milestone", "Color"],
        ["10", "Survey", "2 days", "Mon 11/2/26 8:00 AM", "", "Pat Lee[50%]", "50%",
         "11/6/2026", "No", "#3B82F6"],
        ["20", "Pack", "3d", "2026-11-04T08:00", "10FS+1d", "Dana Unknown", "", "", "",
         "nope"],
        ["30", "Done", "0 days", "", "20", "", "", "", "Yes", ""],
    ])
    body = await _ok_import(client, hdrs, plan, content, filename="plan.csv",
                            content_type="text/csv", dry_run=False, mode="fill")
    rows = _rows(body)
    assert rows["Survey"]["problems"] == []
    pack = rows["Pack"]["problems"]
    assert START_IGNORED in pack
    assert any("Dana Unknown" in p for p in pack), pack
    assert any("Color" in p for p in pack), pack
    assert len(pack) == 3
    assert rows["Done"]["problems"] == []

    tasks = _tasks(await _get(client, hdrs, plan))
    survey, pack_t, done = tasks["Survey"], tasks["Pack"], tasks["Done"]
    assert (survey["constraint_type"], survey["constraint_date"]) == ("snet", "2026-11-02T08:00")
    assert survey["percent_complete"] == 50
    assert survey["deadline"] == "2026-11-06T17:00"           # a date alone: the day's end
    assert survey["color"] == "#3b82f6"
    assert [a["id"] for a in survey["assignees"]] == [str(pat.id)]
    assert pack_t["constraint_type"] == "asap" and pack_t["color"] is None
    assert pack_t["predecessors"] == "1FS+1 day"              # renumbered: Survey is 1
    assert pack_t["start"] == "2026-11-05T08:00"
    assert done["is_milestone"] is True and done["predecessors"] == "2"


async def test_text_dates_without_a_time(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _xlsx([["Name", "Start", "Deadline"],
                     ["A", datetime(2026, 11, 3), datetime(2026, 11, 6)],
                     ["B", "2026-11-04", "12/31/26 5:30 PM"]])
    await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    tasks = _tasks(await _get(client, hdrs, plan))
    assert tasks["A"]["constraint_date"] == "2026-11-03T08:00"
    assert tasks["A"]["deadline"] == "2026-11-06T17:00"
    assert tasks["B"]["constraint_date"] == "2026-11-04T08:00"
    assert tasks["B"]["deadline"] == "2026-12-31T17:30"


async def test_percent_cells(client, db):
    """% Complete as a percent-formatted number (0.5 is 50%), a plain
    number (50) or text ("50%"); past 100 is a problem."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _xlsx([["Name", "% Complete"], ["Fraction", 0.5], ["Number", 25],
                     ["Text", "75%"], ["Over", 1.5], ["Words", "most"]],
                    formats={(2, 2): "0%", (5, 2): "0%"})
    body = await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    rows = _rows(body)
    assert any("150" in p for p in rows["Over"]["problems"]), rows["Over"]
    assert any("most" in p for p in rows["Words"]["problems"]), rows["Words"]
    tasks = _tasks(await _get(client, hdrs, plan))
    assert {n: tasks[n]["percent_complete"] for n in tasks} == {
        "Fraction": 50, "Number": 25, "Text": 75, "Over": 100, "Words": 0}


async def test_manual_mode_keeps_its_dates(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _xlsx([["Task Name", "Mode", "Duration", "Start", "Finish"],
                     ["Walk", "Manually Scheduled", "5 hrs", datetime(2026, 11, 4, 10),
                      datetime(2026, 11, 4, 15)],
                     ["Auto", "Auto Scheduled", "1d", None, None]])
    await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    tasks = _tasks(await _get(client, hdrs, plan))
    walk = tasks["Walk"]
    assert (walk["mode"], walk["start"], walk["finish"]) == (
        "manual", "2026-11-04T10:00", "2026-11-04T15:00")
    assert walk["constraint_type"] == "asap"
    assert tasks["Auto"]["mode"] == "auto"


async def test_odd_rows(client, db):
    """Blank rows are skipped (said once), a row without a name says so, a
    repeated ID and an unreadable predecessor or level are problems."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _xlsx([
        ["ID", "Task Name", "Duration", "Predecessors", "Outline Level", "Milestone"],
        [1, "A", "1d", None, 1, None],
        [None, None, None, None, None, None],
        [2, "B", "1d", "1, 1XX+2d", "deep", "maybe"],
        [2, "C", "1d", "2", 1, None],
        [4, None, "2d", None, None, None],
        [5, None, None, None, 1, None],
    ])
    body = await _ok_import(client, hdrs, plan, content, dry_run=True, mode="fill")
    assert body["problems"] == ["Skipped 2 blank rows."]
    assert [row["name"] for row in body["rows"]] == ["A", "B", "C", ""]
    b, c, unnamed = body["rows"][1:]
    assert any("1XX" in p for p in b["problems"]), b
    assert any("deep" in p for p in b["problems"]), b
    assert any("maybe" in p for p in b["problems"]), b
    assert any("ID 2" in p for p in c["problems"]), c
    assert any("no name" in p for p in unnamed["problems"]), unnamed

    await _ok_import(client, hdrs, plan, content, dry_run=False, mode="fill")
    tasks = _tasks(await _get(client, hdrs, plan))
    assert tasks["B"]["predecessors"] == "1"
    assert tasks["C"]["predecessors"] == "2"              # the first task with ID 2


async def test_formulas_are_never_evaluated(client, db):
    """A formula cell reads as its cached value; one with none is blank."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    body = ('<row r="1">' + _inline("A1", "Name") + _inline("B1", "Duration") + "</row>"
            '<row r="2"><c r="A2" t="str"><f>CONCAT("Pa","ck")</f><v>Cached name</v></c>'
            '<c r="B2"><f>NOW()</f></c></row>')
    await _ok_import(client, hdrs, plan, _with_sheet(body), dry_run=False, mode="fill")
    (task,) = (await _get(client, hdrs, plan))["tasks"]
    assert (task["name"], task["duration_text"]) == ("Cached name", "1 day")


def _excel_style_package(rows: str, strings: list[str], *, date1904: bool) -> bytes:
    """A workbook laid out as Excel saves one (openpyxl writes inline
    strings): shared strings, relative relationship targets, a custom date
    format (164), builtin percent (9) and date (14) formats, and optionally
    the 1904 date system."""
    ns_r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    ct = ("application/vnd.openxmlformats-officedocument.spreadsheetml")
    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/'
            '2006/content-types"><Default Extension="rels" ContentType="application/vnd.'
            'openxmlformats-package.relationships+xml"/><Default Extension="xml" '
            'ContentType="application/xml"/>'
            f'<Override PartName="/xl/workbook.xml" ContentType="{ct}.sheet.main+xml"/>'
            f'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="{ct}.worksheet+xml"/>'
            '</Types>'),
        "_rels/.rels": (
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/'
            f'package/2006/relationships"><Relationship Id="rId1" Type="{ns_r}/officeDocument"'
            ' Target="xl/workbook.xml"/></Relationships>'),
        "xl/workbook.xml": (
            f'<?xml version="1.0"?><workbook {MAIN} xmlns:r="{ns_r}">'
            f'<workbookPr{" date1904=\"1\"" if date1904 else ""}/>'
            '<sheets><sheet name="Task_Table" sheetId="1" r:id="rId7"/></sheets></workbook>'),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/'
            'package/2006/relationships">'
            f'<Relationship Id="rId7" Type="{ns_r}/worksheet" Target="worksheets/sheet1.xml"/>'
            f'<Relationship Id="rId8" Type="{ns_r}/sharedStrings" Target="sharedStrings.xml"/>'
            f'<Relationship Id="rId9" Type="{ns_r}/styles" Target="styles.xml"/>'
            '</Relationships>'),
        "xl/sharedStrings.xml": (
            f'<?xml version="1.0"?><sst {MAIN} count="{len(strings)}">'
            + "".join(strings) + "</sst>"),
        "xl/styles.xml": (
            f'<?xml version="1.0"?><styleSheet {MAIN}><numFmts count="1">'
            '<numFmt numFmtId="164" formatCode="m/d/yyyy h:mm"/></numFmts>'
            '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/>'
            '<xf numFmtId="9" applyNumberFormat="1"/><xf numFmtId="14"/></cellXfs>'
            "</styleSheet>"),
        "xl/worksheets/sheet1.xml": (
            f'<?xml version="1.0"?><worksheet {MAIN}><dimension ref="A1:G2"/>'
            f"<sheetData>{rows}</sheetData></worksheet>"),
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text.encode())
    return out.getvalue()


@pytest.mark.parametrize("date1904", [False, True], ids=["1900", "1904"])
def test_excel_saved_workbook(date1904):
    """Shared strings (rich text runs joined, phonetic hints left out), a
    custom date format, Excel's date systems, a percent style, a boolean
    and an error cell."""
    from openpyxl.utils.datetime import MAC_EPOCH, to_excel

    def serial(moment: datetime) -> float:
        return to_excel(moment, MAC_EPOCH) if date1904 else to_excel(moment)

    strings = ["<si><t>Task Name</t></si>", "<si><t>Start</t></si>",
               "<si><t>% Complete</t></si>", "<si><t>Deadline</t></si>",
               "<si><t>Milestone</t></si>", "<si><t>Duration</t></si>",
               '<si><r><t xml:space="preserve">Pack </t></r><r><rPr><b/></rPr><t>crates</t>'
               "</r><rPh><t>PHONETIC</t></rPh></si>"]
    rows = ('<row r="1">' + "".join(f'<c r="{col}1" t="s"><v>{i}</v></c>'
                                    for i, col in enumerate("ABCDEF")) + "</row>"
            '<row r="2"><c r="A2" t="s"><v>6</v></c>'
            f'<c r="B2" s="1"><v>{serial(datetime(2026, 11, 2, 9, 30))}</v></c>'
            '<c r="C2" s="2"><v>0.25</v></c>'
            f'<c r="D2" s="3"><v>{serial(datetime(2026, 11, 6))}</v></c>'
            '<c r="E2" t="b"><v>1</v></c>'
            '<c r="F2" t="e"><v>#N/A</v></c></row>')
    parsed = excel.parse_workbook(_excel_style_package(rows, strings, date1904=date1904))
    (task,) = parsed.tasks
    assert task.name == "Pack crates"
    assert task.start == datetime(2026, 11, 2, 9, 30)
    assert task.constraint_type == "snet"
    assert task.deadline == datetime(2026, 11, 6, 17, 0)      # a date alone: the day's end
    assert task.percent_complete == 25
    assert task.is_milestone is True
    assert task.duration is None
    (problem,) = task.problems
    assert "#N/A" in problem and "Duration" in problem


async def test_first_sheet_only(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    wb = Workbook()
    wb.active.append(["Task Name"])
    wb.active.append(["From the first sheet"])
    other = wb.create_sheet("Other")
    other.append(["Task Name"])
    other.append(["From the second sheet"])
    buf = io.BytesIO()
    wb.save(buf)
    body = await _ok_import(client, hdrs, plan, buf.getvalue(), dry_run=True, mode="fill")
    assert [row["name"] for row in body["rows"]] == ["From the first sheet"]


async def test_import_into_a_new_plan(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    content = _xlsx([["Task Name", "Start", "Duration"],
                     ["First", datetime(2026, 11, 9, 8), "1d"]])
    url = f"/initiatives/{move.id}/plan/import"
    resp = await _post(client, hdrs, url, content, dry_run=True)
    assert resp.status_code == 200, resp.text
    assert resp.json()["version"] is None
    assert await db.scalar(select(ProjectPlan.id).where(
        ProjectPlan.initiative_id == move.id)) is None

    resp = await _post(client, hdrs, url, content, dry_run=False)
    assert resp.status_code == 200, resp.text
    got = (await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)).json()
    assert resp.json()["version"] == got["version"]
    assert got["project_start"] == "2026-11-09T08:00"
    assert [t["name"] for t in got["tasks"]] == ["First"]


# ── round trip ──────────────────────────────────────────────────────


async def _round_trip_plan(client, db):
    """Summaries, a manual task, working and elapsed durations in hours,
    days and weeks, a milestone, FS/SS/FF/SF links with a lag, a lead, an
    elapsed lag and week and month lags (into and out of summaries),
    progress, a deadline, a color, a person and a partner."""
    hdrs = await _admin(db, client)
    move = await _initiative(db, name="Source move")
    worker, shipper = await _resources(db, move)
    plan = await _create(client, hdrs, move)
    ids = await _add(client, hdrs, plan, "Phase 1")
    ids.update(await _add(client, hdrs, plan, "Survey", duration="2d"))
    ids.update(await _add(client, hdrs, plan, "Pack <crates> & tape", duration="3d"))
    ids.update(await _add(client, hdrs, plan, "Freight", duration="3ed"))
    ids.update(await _add(client, hdrs, plan, "Walkthrough", mode="manual",
                          start="2026-11-04T10:00", finish="2026-11-04T15:00"))
    ids.update(await _add(client, hdrs, plan, "Phase 2"))
    ids.update(await _add(client, hdrs, plan, "Call", duration="4h"))
    ids.update(await _add(client, hdrs, plan, "Build", duration="1w"))
    ids.update(await _add(client, hdrs, plan, "Go live", duration="0"))
    ids.update(await _add(client, hdrs, plan, "Wrap up", duration="2d"))
    pack = ids["Pack <crates> & tape"]
    await _ok(client, hdrs, plan, [
        {"op": "indent", "ids": [ids["Survey"], pack, ids["Freight"], ids["Walkthrough"]]},
        {"op": "indent", "ids": [ids["Call"], ids["Build"], ids["Go live"]]},
    ])
    await _ok(client, hdrs, plan, [
        {"op": "set_percent", "ids": [ids["Survey"]], "percent": 50},
    ])
    await _ok(client, hdrs, plan, [
        _update(ids["Survey"], color="#3b82f6", deadline="2026-11-06T17:00"),
        _update(pack, predecessors="2SS-4h"),
        _update(ids["Freight"], predecessors="3FS+2d"),
        _update(ids["Call"], predecessors="4FF+1ed"),
        _update(ids["Build"], predecessors="7SF"),
        _update(ids["Go live"], predecessors="8"),
        _update(ids["Phase 2"], predecessors="1FS+1w"),
        _update(ids["Wrap up"], predecessors="6SS+1mo"),
        _assign(ids["Survey"], ("person", worker.id), ("partner", shipper.id)),
    ])
    return hdrs, plan, worker, shipper


ROUND_TRIP_FIELDS = (
    "display_id", "wbs", "outline_level", "is_summary", "name", "is_milestone", "mode",
    "duration_minutes", "duration_unit", "elapsed", "duration_text", "start", "finish",
    "deadline", "percent_complete", "actual_start", "color", "predecessors", "successors",
    "status")


def _comparable(body) -> list[dict]:
    position = {t["id"]: t["display_id"] for t in body["tasks"]}
    out = []
    for task in body["tasks"]:
        row = {key: task[key] for key in ROUND_TRIP_FIELDS}
        row["parent"] = position.get(task["parent_id"])
        row["assignees"] = [(a["kind"], a["name"]) for a in task["assignees"]]
        out.append(row)
    return out


def _links(body) -> list[tuple]:
    display = {t["id"]: t["display_id"] for t in body["tasks"]}
    return sorted((display[lk["predecessor_id"]], display[lk["successor_id"]], lk["link_type"],
                   lk["lag_minutes"], lk["lag_unit"], lk["lag_elapsed"], lk["lag_text"])
                  for lk in body["links"])


async def test_round_trip(client, db):
    """Export a plan built through ops, import the workbook into a new
    initiative (with the same people and partner): names, the outline,
    durations, links, modes, progress, deadlines, colors and assignees come
    back as they were. A linked task's Start is set by its links (a
    problem says so); an unlinked one's becomes Start No Earlier Than."""
    hdrs, plan, worker, shipper = await _round_trip_plan(client, db)
    source = await _get(client, hdrs, plan)
    resp = await client.get(f"/plans/{plan['id']}/export.xlsx", headers=hdrs)
    assert resp.status_code == 200, resp.text

    other = await _initiative(db, name="Next move")
    db.add(InitiativePerson(initiative_id=other.id, person_id=worker.id))
    other.shipping_partner_id = shipper.id
    await db.commit()
    resp = await _post(client, hdrs, f"/initiatives/{other.id}/plan/import", resp.content,
                       dry_run=False)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["problems"] == []
    assert all(row["moved_days"] is None for row in body["rows"]), body["rows"]
    flagged = {row["name"] for row in body["rows"] if row["problems"]}
    assert flagged == {"Pack <crates> & tape", "Freight", "Call", "Build", "Go live",
                       "Wrap up"}
    assert all(row["problems"] == [START_IGNORED] for row in body["rows"] if row["problems"])

    got = (await client.get(f"/initiatives/{other.id}/plan", headers=hdrs)).json()
    assert got["project_start"] == source["project_start"]
    assert _comparable(got) == _comparable(source)
    assert _links(got) == _links(source)
    assert len(got["links"]) == 7
    survey = _tasks(got)["Survey"]
    assert (survey["constraint_type"], survey["constraint_date"]) == ("snet", "2026-11-02T08:00")


# ── the file: kinds, limits, hostile workbooks ──────────────────────


@pytest.mark.parametrize(("filename", "content_type", "kind"), [
    ("plan.xlsx", "application/octet-stream", "xlsx"),
    ("PLAN.XLSX", XLSX, "xlsx"),
    ("upload", XLSX, "xlsx"),
    ("plan.csv", "application/vnd.ms-excel", "csv"),
    ("upload", "text/csv; charset=utf-8", "csv"),
])
async def test_file_kind_by_extension_or_type(client, db, filename, content_type, kind):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    rows = [["Task Name"], ["Only"]]
    content = _xlsx(rows) if kind == "xlsx" else _csv(rows)
    body = await _ok_import(client, hdrs, plan, content, filename=filename,
                            content_type=content_type, dry_run=True)
    assert [row["name"] for row in body["rows"]] == ["Only"]


@pytest.mark.parametrize(("filename", "content_type", "words"), [
    ("plan.xls", "application/vnd.ms-excel", ".xlsx"),
    ("plan.mpp", "application/vnd.ms-project", "XML"),
    ("plan.pdf", "application/pdf", ".csv"),
])
async def test_unsupported_files(client, db, filename, content_type, words):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    detail = _bad_file(await _import(client, hdrs, plan, b"\xd0\xcf\x11\xe0 binary",
                                     filename=filename, content_type=content_type,
                                     dry_run=True))
    assert words in detail["message"], detail


@pytest.mark.parametrize("content", [
    b"",
    b"not a workbook",
    b"PK\x03\x04 truncated zip",
], ids=["empty", "text", "truncated"])
async def test_not_a_workbook(client, db, content):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    detail = _bad_file(await _import(client, hdrs, plan, content, dry_run=True))
    assert detail["message"]


async def test_sheet_needs_a_name_column(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    detail = _bad_file(await _import(client, hdrs, plan, _xlsx([["Duration"], ["2d"]]),
                                     dry_run=True))
    assert "Name" in detail["message"]
    detail = _bad_file(await _import(client, hdrs, plan, _xlsx([]), dry_run=True))
    assert "empty" in detail["message"]
    detail = _bad_file(await _import(client, hdrs, plan, b"\xff\xfeN\x00a\x00",
                                     filename="plan.csv", content_type="text/csv",
                                     dry_run=True))
    assert "UTF-8" in detail["message"]


async def test_zip_bomb_refused(client, db):
    """The members' unpacked sizes are added up before anything is read: a
    small upload that unpacks past the cap is refused."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    big = b'<?xml version="1.0"?><worksheet>' + b" " * (excel.MAX_UNPACKED_BYTES + 1)
    content = _replace(_xlsx([["Name"], ["A"]]), SHEET, big + b"</worksheet>")
    assert len(content) < 100_000
    detail = _bad_file(await _import(client, hdrs, plan, content, dry_run=True))
    assert "20 MB" in detail["message"]
    assert await _task_count(db, plan["id"]) == 0


@pytest.mark.parametrize("prolog", [
    '<!DOCTYPE worksheet [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>',
    '<!DOCTYPE worksheet [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
    "<!DOCTYPE worksheet>",
], ids=["entity-expansion", "external-entity", "dtd"])
async def test_entities_refused(client, db, prolog):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _with_sheet('<row r="1">' + _inline("A1", "Name") + "</row>", prolog=prolog)
    detail = _bad_file(await _import(client, hdrs, plan, content, dry_run=True))
    assert "DTD" in detail["message"]
    assert "passwd" not in str(detail)


async def test_deep_nesting_refused(client, db):
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _with_sheet('<row r="1">' + "<x>" * 5000 + "</x>" * 5000 + "</row>")
    _bad_file(await _import(client, hdrs, plan, content, dry_run=True))


async def test_wide_rows_keep_only_the_named_columns(client, db):
    """Cells past the header's known columns are read and dropped, so a
    row of a hundred thousand cells costs nothing to keep."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    filler = "<c/>" * 100_000
    body = ('<row r="1">' + _inline("A1", "Name") + filler + "</row>"
            '<row r="2">' + _inline("A2", "Only") + filler + "</row>")
    body = await _ok_import(client, hdrs, plan, _with_sheet(body), dry_run=True)
    assert [row["name"] for row in body["rows"]] == ["Only"]


def test_reading_holds_no_element_once_read():
    """Every element is dropped once read, though the parser hands over its
    events in batches (when a cell ends, the row already holds the cells
    after it): reading a row of 300,000 cells stays under 8 MB."""
    import tracemalloc

    content = _with_sheet('<row r="1">' + _inline("A1", "Name") + "</row>"
                          '<row r="2">' + _inline("A2", "Only") + "<c/>" * 300_000 + "</row>")
    tracemalloc.start()
    try:
        parsed = excel.parse_workbook(content)
        _size, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert [t.name for t in parsed.tasks] == ["Only"]
    assert peak < 8 * 1024 * 1024, peak


async def test_too_many_rows(client, db, monkeypatch):
    monkeypatch.setattr(excel, "MAX_ROWS", 3)
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _xlsx([["Name"], ["A"], ["B"], ["C"], ["D"]])
    detail = _bad_file(await _import(client, hdrs, plan, content, dry_run=True),
                       422, "too_many_rows")
    assert detail["limit"] == 3
    content = _csv([["Name", "Predecessors"], ["A", ""], ["B", "1"], ["C", "1,2,1SS"]])
    _bad_file(await _import(client, hdrs, plan, content, filename="p.csv",
                            content_type="text/csv", dry_run=True), 422, "too_many_rows")


async def test_parse_runs_off_the_event_loop(client, db, monkeypatch):
    import threading

    hdrs, _move, plan, _pat_row = await _setup(client, db)
    seen = []
    for name in ("parse_workbook", "parse_csv"):
        real = getattr(excel, name)

        def spy(content, real=real):
            seen.append(threading.get_ident())
            return real(content)

        monkeypatch.setattr(excel, name, spy)
    await _ok_import(client, hdrs, plan, _xlsx([["Name"], ["A"]]), dry_run=True)
    await _ok_import(client, hdrs, plan, _csv([["Name"], ["A"]]), filename="p.csv",
                     content_type="text/csv", dry_run=True)
    assert len(seen) == 2 and threading.get_ident() not in seen


async def test_existing_plan_preview_returns_its_version(client, db):
    """The preview says which version it saw, for the apply's base_version;
    a stale one is 409 `plan_changed`."""
    hdrs, _move, plan, _pat_row = await _setup(client, db)
    content = _xlsx([["Name"], ["A"]])
    preview = await _ok_import(client, hdrs, plan, content, dry_run=True)
    assert preview["version"] == plan["version"]
    await _add(client, hdrs, plan, "Someone else's task")
    resp = await _import(client, hdrs, plan, content, dry_run=False,
                         base_version=preview["version"])
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "plan_changed"


# ── the parser alone ────────────────────────────────────────────────


def test_parse_xlsx_by_name():
    parsed = excel.parse_xlsx(_csv([["Task Name", "Duration"], ["A", "2d"]]), "x.CSV")
    assert [(t.name, t.duration.minutes) for t in parsed.tasks] == [("A", 960)]
    parsed = excel.parse_xlsx(_xlsx([["Task Name", "Duration"], ["A", "2d"]]), "x.xlsx")
    assert [(t.name, t.duration.minutes) for t in parsed.tasks] == [("A", 960)]


@pytest.mark.parametrize(("text", "expected"), [
    ("2026-11-02", datetime(2026, 11, 2, 8, 0)),
    ("2026-11-02T13:30", datetime(2026, 11, 2, 13, 30)),
    ("2026-11-02 13:30", datetime(2026, 11, 2, 13, 30)),
    ("11/2/2026", datetime(2026, 11, 2, 8, 0)),
    ("11/2/26 1:05 PM", datetime(2026, 11, 2, 13, 5)),
    ("Mon 11/2/26 12:00 AM", datetime(2026, 11, 2, 0, 0)),
    ("Mon 11/2/26 12:30 PM", datetime(2026, 11, 2, 12, 30)),
    ("11/2/2026 17:00", datetime(2026, 11, 2, 17, 0)),
])
def test_text_start_dates(text, expected):
    parsed = excel.parse_csv(_csv([["Name", "Start"], ["A", text]]))
    (task,) = parsed.tasks
    assert task.start == expected and task.problems == []


@pytest.mark.parametrize("text", ["2/30/2026", "13/1/2026", "11/2/2026 25:00", "next week",
                                  "11/2/2026 13:00 PM"])
def test_bad_text_dates_are_problems(text):
    parsed = excel.parse_csv(_csv([["Name", "Start"], ["A", text]]))
    (task,) = parsed.tasks
    assert task.start is None
    (problem,) = task.problems
    assert problem.startswith("Start ") and "isn't a date" in problem
