"""Excel workbooks (.xlsx) and CSV for project plans: `export_xlsx` writes a
plan's sheet as a workbook, `parse_xlsx` (`parse_workbook`, `parse_csv`)
reads one into a ParsedPlan for plans/importer.py.

Export (GET /plans/{id}/export.xlsx): one sheet, "Project plan", in the
plan's outline order. The header row is MS Project's column names for the
columns asked for (the portal sheet's keys, portal/src/lib/plans/
columns.ts; by default the sheet's default set, never its Indicators
icons; any other key is refused), then `Outline Level`, then `Color`
(`#rrggbb` or blank) whenever a task has a color. Task names are indented
by outline level, summary rows are bold, dates are real Excel dates (the
plan's floating wall clock, no zone; Created and Updated in the plan's
zone), % Complete is a percent. Text never becomes a formula. The house
workbook helpers (reports/timesheet/xlsx.py) write the cells, widths and
header.

Import (an .xlsx's first sheet, or a CSV): the header row is the first
row naming a known column, matched ignoring case: ID, Name / Task Name,
Duration, Start, Finish, Predecessors, Resource Names, % Complete,
Deadline, Outline Level, WBS, Notes, Milestone, plus Mode / Task Mode and
Color (what the export writes). Other columns are ignored.
- Outline from Outline Level, else WBS depth (1.2.3 is level 3), else flat.
- A task's key is its ID; without an ID column, its row order (1, 2, ...).
  Predecessors (`3FS+2d`, plans/predecessors.py) name those keys.
- Durations and lags are read by plans/durations.py against the Standard
  calendar's units; the importer rescales day, week and month counts into
  the plan's. MS Project's estimate mark (`5 days?`) is dropped.
- Start is where the sheet had the task scheduled, not a constraint
  (`ParsedTask.soft_start`): the importer settles it against the plan's
  schedule (Start No Earlier Than only where the task would start earlier;
  a problem only where the links move it). A manual task keeps its Start
  and Finish. A day alone (typed with no time, or an Excel date at
  midnight in a cell whose format shows no time) is flagged in
  `ParsedTask.date_only`: the importer gives it the plan calendar's
  default start (Start) or end (Finish, Deadline) time.
- Resource Names are matched by the importer (by name or email, never
  created); MS Project's units suffix (`Pat Lee[50%]`) is dropped.
- A value that cannot be read is a problem on its row with a fallback,
  never a failure, a formula's error value (#N/A) too; blank rows are
  skipped and counted. Each cell is held to what an Excel cell holds
  (MAX_CELL_TEXT) and its comma-separated entries are read one at a time.

Reading a workbook. An upload is hostile: a 20 MB zip can unpack to
gigabytes, and openpyxl's loader builds objects for every part it reads
(a 35 KB upload of empty style records costs it 2.7 GB of memory), so the
workbook is not loaded with openpyxl. A member compressed any way but
Excel's two (stored, deflated) is refused before anything is read
(zipfile unpacks bzip2 and LZMA a whole chunk at a time, past any size
the directory claims); so is a package whose members' declared sizes add
up past MAX_UNPACKED_BYTES (the 20 MB an import file may be: a workbook is
never more to read than a CSV at the cap). Every byte read after that is
charged to that one budget, however many relationships name a member, and
so is the text of every shared-string reference the sheet hands out (a
string stored once can be named by every row): a workbook yields no more
text than a CSV at the cap.
Only the parts the import needs are streamed, each element dropped once
read: the relationships to find the first worksheet, its shared strings,
the number format of each cell style, and the sheet itself, keeping only
the cells of the named columns. Formulas are never evaluated (a cell
reads as its cached value), a DTD or entity is refused, XML nested deeper
than MAX_DEPTH is refused, and the tasks, links and assignments are held
to MAX_ROWS (the restore op's cap). openpyxl's own helpers decode the
values (number formats, Excel dates)."""

from __future__ import annotations

import csv
import io
import math
import posixpath
import re
import zipfile
import zlib
from collections.abc import Callable, Iterator
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import defusedxml.ElementTree as DET
from defusedxml import DefusedXmlException
from openpyxl import Workbook
from openpyxl.styles import Alignment
from openpyxl.styles.numbers import BUILTIN_FORMATS, is_datetime
from openpyxl.utils.cell import column_index_from_string
from openpyxl.utils.datetime import MAC_EPOCH, WINDOWS_EPOCH, from_excel

from serversherpa.imports.bulk import cell as cell_text
from serversherpa.plans import mspdi
from serversherpa.plans.durations import (
    Duration,
    DurationError,
    Units,
    format_duration,
    parse_duration,
)
from serversherpa.plans.floating import parse_floating
from serversherpa.plans.importer import (
    CONSTRAINT_LABELS,
    MAX_FILE_BYTES,
    ImportFileError,
    ParsedLink,
    ParsedPlan,
    ParsedResource,
    ParsedTask,
    _shown,
)
from serversherpa.plans.limits import MAX_OUTLINE_LEVEL, MAX_RESTORE_ROWS
from serversherpa.plans.predecessors import PredecessorError, parse_predecessors
from serversherpa.plans.schemas import PlanTaskOut
from serversherpa.plans.service import PlanState
from serversherpa.reports.move_scan_history.xlsx import XLSX_MIME
from serversherpa.reports.timesheet.xlsx import _as_text, _autofit, _bold_row, _Sheet

__all__ = ["COLUMNS", "DEFAULT_COLUMNS", "XLSX_MIME", "cell_value", "column_keys", "columns_of",
           "export_xlsx", "parse_csv", "parse_workbook", "parse_xlsx", "unknown_columns"]

# --- export -------------------------------------------------------------------------

SHEET_TITLE = "Project plan"
OUTLINE_LEVEL = "Outline Level"
COLOR = "Color"

# The portal sheet's columns (portal/src/lib/plans/columns.ts) by key, with
# MS Project's names, in its order (the sheet's "Mode" is MS Project's Task
# Mode). Its Indicators column is icons, never exported.
COLUMNS: dict[str, str] = {
    "id": "ID", "mode": "Task Mode", "name": "Task Name", "duration": "Duration",
    "start": "Start", "finish": "Finish", "predecessors": "Predecessors",
    "resources": "Resource Names", "percent": "% Complete", "deadline": "Deadline",
    "wbs": "WBS", "successors": "Successors", "slack": "Total Slack", "critical": "Critical",
    "status": "Status", "constraint_type": "Constraint Type",
    "constraint_date": "Constraint Date", "actual_start": "Actual Start",
    "actual_finish": "Actual Finish", "baseline_start": "Baseline Start",
    "baseline_finish": "Baseline Finish", "baseline_duration": "Baseline Duration",
    "start_variance": "Start Variance", "finish_variance": "Finish Variance",
    "notes": "Notes", "color": "Color", "created": "Created", "updated": "Updated",
}
DEFAULT_COLUMNS = ("id", "mode", "name", "duration", "start", "finish", "predecessors",
                   "resources", "percent", "deadline")
REQUIRED_COLUMNS = ("id", "name")          # never hidden on the sheet
ICON_COLUMNS = frozenset({"indicators"})   # the sheet's, skipped by the export
DATE_COLUMNS = frozenset({"start", "finish", "deadline", "constraint_date", "actual_start",
                          "actual_finish", "baseline_start", "baseline_finish", "created",
                          "updated"})
# the sheet's own date text: `Mon 11/2/26`, `Mon 11/2/26 8:00 AM` (Show times)
DATE_FORMAT = "ddd m/d/yy"
DATETIME_FORMAT = "ddd m/d/yy h:mm AM/PM"
PERCENT_FORMAT = "0%"
MAX_CELL_TEXT = 32_767                     # the most characters an Excel cell holds
MODE_LABELS = {"auto": "Auto Scheduled", "manual": "Manually Scheduled"}
STATUS_LABELS = {"complete": "Complete", "late": "Late", "in_progress": "In progress",
                 "not_started": "Not started"}


def column_keys(text: str | None) -> list[str]:
    """The columns `?columns=a,b,...` asks for, as the export writes them:
    the keys in the order given, each once, the sheet's icon column left
    out; ID and Task Name always (first, when not asked for). None or
    blank: the sheet's default set. ValueError for a key the sheet doesn't
    have."""
    if text is None or not text.strip():
        return columns_of(None)
    return columns_of([key for key in (part.strip() for part in text.split(",")) if key])


def unknown_columns(keys: list[str]) -> list[str]:
    """The keys the sheet has no column for (its icon column is one it has)."""
    return [key for key in keys if key not in COLUMNS and key not in ICON_COLUMNS]


def columns_of(keys: list[str] | None) -> list[str]:
    """`column_keys` for a list of keys (the project plan PDF's `columns`
    option): None is the sheet's default set. ValueError for a key the
    sheet doesn't have."""
    if keys is None:
        keys = list(DEFAULT_COLUMNS)
    else:
        if unknown_columns(keys):
            raise ValueError("not a column of the sheet")
        keys = list(dict.fromkeys(key for key in keys if key in COLUMNS))
    return [k for k in REQUIRED_COLUMNS if k not in keys] + keys


def _instant(moment: datetime | None, zone: ZoneInfo) -> datetime | None:
    """A stamp (Created, Updated) as the plan's wall clock."""
    if moment is None:
        return None
    return moment.astimezone(zone).replace(tzinfo=None, microsecond=0)


def _work_days(minutes: int | None, units: Units) -> str | None:
    return None if minutes is None else format_duration(Duration(minutes, "d", False), units)


# key -> the cell's value, from the task as the API serves it (PlanTaskOut),
# its row (the floating datetimes), the plan calendar's units and the zone
_VALUES: dict[str, Callable] = {
    "id": lambda t, r, units, zone: t.display_id,
    "mode": lambda t, r, units, zone: MODE_LABELS.get(t.mode, t.mode),
    "name": lambda t, r, units, zone: t.name,
    "duration": lambda t, r, units, zone: t.duration_text,
    "start": lambda t, r, units, zone: r.start,
    "finish": lambda t, r, units, zone: r.finish,
    "predecessors": lambda t, r, units, zone: t.predecessors or None,
    "resources": lambda t, r, units, zone: ", ".join(a.name for a in t.assignees) or None,
    "percent": lambda t, r, units, zone: t.percent_complete / 100,
    "deadline": lambda t, r, units, zone: r.deadline,
    "wbs": lambda t, r, units, zone: t.wbs,
    "successors": lambda t, r, units, zone: t.successors or None,
    "slack": lambda t, r, units, zone: _work_days(t.total_slack_minutes, units),
    "critical": lambda t, r, units, zone: "Yes" if t.is_critical else "No",
    "status": lambda t, r, units, zone: STATUS_LABELS.get(t.status, t.status),
    "constraint_type": lambda t, r, units, zone: CONSTRAINT_LABELS.get(t.constraint_type),
    "constraint_date": lambda t, r, units, zone: r.constraint_date,
    "actual_start": lambda t, r, units, zone: r.actual_start,
    "actual_finish": lambda t, r, units, zone: r.actual_finish,
    "baseline_start": lambda t, r, units, zone: r.baseline_start,
    "baseline_finish": lambda t, r, units, zone: r.baseline_finish,
    "baseline_duration": lambda t, r, units, zone: (
        None if t.baseline_duration_minutes is None else format_duration(
            Duration(t.baseline_duration_minutes, t.duration_unit, t.elapsed), units)),
    "start_variance": lambda t, r, units, zone: _work_days(t.start_variance_minutes, units),
    "finish_variance": lambda t, r, units, zone: _work_days(t.finish_variance_minutes, units),
    "notes": lambda t, r, units, zone: t.notes or None,
    "color": lambda t, r, units, zone: t.color,
    "created": lambda t, r, units, zone: _instant(t.created_at, zone),
    "updated": lambda t, r, units, zone: _instant(t.updated_at, zone),
}


def cell_value(key: str, task: PlanTaskOut, row, units: Units, zone: ZoneInfo):
    """One column's value for a task, as the export writes it: text, a
    number, a floating datetime (dates and stamps, on the plan's clock) or
    None; % Complete as a fraction (0.5 is 50%). The project plan PDF
    formats these as the sheet shows them."""
    return _VALUES[key](task, row, units, zone)


def _fit(value):
    """Text past what an Excel cell holds is cut there."""
    return value[:MAX_CELL_TEXT] if isinstance(value, str) else value


def export_xlsx(state: PlanState, outline: list[PlanTaskOut], units: Units,
                columns: list[str], *, show_times: bool = False) -> bytes:
    """The plan's sheet as an .xlsx: `outline` is its tasks as the API
    serves them (service.tasks_out, outline order), `columns` the keys to
    write (column_keys), `units` the plan calendar's. Dates show their
    time when the plan shows times."""
    zone = ZoneInfo(state.plan.timezone)
    keys = [key for key in columns if key in COLUMNS]
    add_color = "color" not in keys and any(task.color for task in outline)
    headers = [COLUMNS[key] for key in keys] + [OUTLINE_LEVEL] + ([COLOR] if add_color else [])
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET_TITLE
    sheet = _Sheet(ws)
    _bold_row(ws, sheet.append(headers), len(headers))
    when = DATETIME_FORMAT if show_times else DATE_FORMAT
    formats = {i: when if key in DATE_COLUMNS else PERCENT_FORMAT
               for i, key in enumerate(keys, 1) if key in DATE_COLUMNS or key == "percent"}
    name_column = keys.index("name") + 1 if "name" in keys else None
    for task in outline:
        row = state.tasks[task.id]
        values = [_VALUES[key](task, row, units, zone) for key in keys] + [task.outline_level]
        if add_color:
            values.append(task.color)
        r = sheet.append([_fit(value) for value in values])
        for column, number_format in formats.items():
            ws.cell(r, column).number_format = number_format
        if name_column is not None:
            indent = min(max(task.outline_level, 1), MAX_OUTLINE_LEVEL) - 1
            ws.cell(r, name_column).alignment = Alignment(indent=indent)
        if task.is_summary:
            _bold_row(ws, r, len(headers))
    ws.freeze_panes = "A2"
    _as_text(ws)
    _autofit(ws)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# --- import: the file ---------------------------------------------------------------

MAX_ROWS = MAX_RESTORE_ROWS        # tasks, links, assignments: the restore op's cap
# the most a workbook's members may unpack to, all together: no more than an
# import file may be (importer.MAX_FILE_BYTES)
MAX_UNPACKED_BYTES = MAX_FILE_BYTES
# a workbook's deepest element is about 10 levels down (an extension's
# conditional format); far deeper is not an Excel file (the MSPDI reader's
# bound)
MAX_DEPTH = mspdi.MAX_DEPTH

# Excel stores or deflates a member, nothing else; zipfile unpacks bzip2
# and LZMA a whole chunk at a time, past any size the zip's directory claims
COMPRESSIONS = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})

NOT_A_WORKBOOK = "This file isn't an Excel workbook (.xlsx), or it's password-protected."
ODD_COMPRESSION = ("This workbook is compressed in a way Excel doesn't use, so open it in "
                   "Excel and save it again.")
UNREADABLE = "This workbook isn't readable."
DTD_REFUSED = "This workbook declares a DTD or entities, which aren't allowed."
TOO_DEEP = "This workbook's XML is nested too deeply to be an Excel file."
NO_WORKSHEET = "This workbook has no worksheet."
NOT_UTF8 = ("This CSV file isn't UTF-8 text, so save it from Excel as "
            "CSV UTF-8 (Comma delimited).")
NOT_COMMAS = "This CSV file isn't comma-separated, so save it as a comma-separated CSV."
CSV_UNREADABLE = "This CSV file isn't readable."

STANDARD = Units()                  # what the file's durations and lags count in

_DROP_EVERY = mspdi.DROP_EVERY      # ended children cut from their parent at a time
_OTHER_SEPARATORS = re.compile(r"[;\t]")
_READ_SIZE = 64 * 1024              # what a member read asks for when given no size
_INT = re.compile(r"[+-]?[0-9]{1,9}")
_CELL_REF = re.compile(r"([A-Za-z]{1,3})[0-9]{1,9}")
_WANTED_RELS = frozenset({"officeDocument", "worksheet", "sharedStrings", "styles"})


def _bad_file(message: str) -> ImportFileError:
    return ImportFileError(422, "bad_file", message=message)


def _too_many() -> ImportFileError:
    return ImportFileError(422, "too_many_rows", limit=MAX_ROWS)


def _check_size(content: bytes) -> None:
    if len(content) > MAX_FILE_BYTES:
        raise ImportFileError(413, "file_too_large", limit=MAX_FILE_BYTES)
    if not content.strip():
        raise _bad_file("The file is empty.")


def _int(text: str | None) -> int | None:
    """A whole number of at most 9 digits, else None."""
    if text is None:
        return None
    text = text.strip()
    return int(text) if _INT.fullmatch(text) else None


def _local(tag) -> str:
    return tag.rpartition("}")[2] if isinstance(tag, str) else ""


class _Percent(float):
    """A number the workbook shows as a percent: 0.5 is 50%."""


def _blank(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _too_big() -> ImportFileError:
    return _bad_file(f"This workbook unpacks to more than "
                     f"{MAX_UNPACKED_BYTES // (1024 * 1024)} MB, the most an import reads.")


class _Package:
    """An .xlsx upload's zip, checked before any member is read: a zip,
    every member stored or deflated (COMPRESSIONS), and no more than
    MAX_UNPACKED_BYTES unpacked by the directory's own count. Then every
    byte any read unpacks is charged to that one budget (_Metered), so no
    member, however many relationships name it, reads past it."""

    def __init__(self, content: bytes):
        try:
            self.zip = zipfile.ZipFile(io.BytesIO(content))
            infos = self.zip.infolist()
        except (zipfile.BadZipFile, zipfile.LargeZipFile, ValueError, EOFError, OSError):
            raise _bad_file(NOT_A_WORKBOOK) from None
        if any(info.compress_type not in COMPRESSIONS for info in infos):
            raise _bad_file(ODD_COMPRESSION)
        if sum(info.file_size for info in infos) > MAX_UNPACKED_BYTES:
            raise _too_big()
        self.left = MAX_UNPACKED_BYTES      # what reads may still unpack
        self.names: dict[str, str] = {}
        for info in infos:
            self.names.setdefault(info.filename.casefold(), info.filename)

    def charge(self, count: int) -> None:
        self.left -= count
        if self.left < 0:
            raise _too_big()

    def find(self, name: str | None) -> str | None:
        """The member called `name` (ignoring case, as Excel does), or None."""
        return self.names.get(name.casefold()) if name else None

    def walk(self, name: str) -> Iterator[tuple[str, list[str], DET.Element]]:
        """(event, path, element) through one XML member, streamed: `path`
        is the local names from the root down to the element (shared: read
        it before the next step). Attributes are there at "start", text at
        "end"; once an element ends it is cleared and soon dropped from its
        parent, so memory stays flat however many elements the member has.

        Events arrive in batches (the parser reads ahead), so when a child
        ends its parent may already hold later siblings: the ended children
        are always the first ones, and are cut off together every
        _DROP_EVERY ends (each cut is one short list move)."""
        path: list[str] = []
        opened: list = []
        ended: list[int] = []               # per open element: its children that ended
        with self.zip.open(name) as member:
            src = _Metered(member, self)
            for event, element in DET.iterparse(src, events=("start", "end"), forbid_dtd=True):
                if event == "start":
                    if len(path) >= MAX_DEPTH:
                        raise _bad_file(TOO_DEEP)
                    path.append(_local(element.tag))
                    opened.append(element)
                    ended.append(0)
                    yield event, path, element
                    continue
                yield event, path, element
                path.pop()
                opened.pop()
                ended.pop()
                element.clear()
                if opened:
                    ended[-1] += 1
                    if ended[-1] >= _DROP_EVERY:
                        del opened[-1][:ended[-1]]
                        ended[-1] = 0


class _Metered:
    """A member being read, each read charged to its package's budget."""

    def __init__(self, member, pkg: _Package):
        self.member, self.pkg = member, pkg

    def read(self, size: int | None = -1) -> bytes:
        data = self.member.read(size if size is not None and size > 0 else _READ_SIZE)
        self.pkg.charge(len(data))
        return data


def _resolve(folder: str, target: str) -> str:
    """A relationship's target as a member name: absolute (`/xl/...`) or
    relative to the folder of the part the relationships belong to."""
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(folder, target))


def _rels(pkg: _Package, name: str, folder: str) -> dict[str, tuple[str, str]]:
    """{Id: (kind, member)} of a .rels part's internal relationships the
    import uses (the officeDocument, worksheets, shared strings, styles);
    empty when the part isn't there."""
    member = pkg.find(name)
    out: dict[str, tuple[str, str]] = {}
    if member is None:
        return out
    for event, path, element in pkg.walk(member):
        if event != "start" or len(path) != 2 or path[1] != "Relationship":
            continue
        if (element.get("TargetMode") or "").strip().lower() == "external":
            continue
        rid = element.get("Id")
        kind = (element.get("Type") or "").rpartition("/")[2]
        if rid and kind in _WANTED_RELS:
            out.setdefault(rid, (kind, _resolve(folder, element.get("Target") or "")))
    return out


def _parts(pkg: _Package) -> tuple[str, str | None, str | None, datetime]:
    """The first worksheet's member, the shared strings' and the styles'
    (None when the workbook has none), and the workbook's date epoch."""
    book = next((part for kind, part in _rels(pkg, "_rels/.rels", "").values()
                 if kind == "officeDocument"), "xl/workbook.xml")
    book = pkg.find(book) or book
    folder = posixpath.dirname(book)
    rels = _rels(pkg, posixpath.join(folder, "_rels", posixpath.basename(book) + ".rels"),
                 folder)
    epoch, sheet = WINDOWS_EPOCH, None
    for event, path, element in pkg.walk(book):
        if event != "start":
            continue
        if len(path) == 2 and path[1] == "workbookPr":
            if (element.get("date1904") or "").strip().lower() in ("1", "true"):
                epoch = MAC_EPOCH
        elif len(path) == 3 and path[1:] == ["sheets", "sheet"]:
            rid = next((value for key, value in element.attrib.items()
                        if key.endswith("}id")), None)
            found = rels.get(rid)
            if found is not None and found[0] == "worksheet":
                sheet = pkg.find(found[1])
                break
    if sheet is None:
        raise _bad_file(NO_WORKSHEET)
    strings = next((part for kind, part in rels.values() if kind == "sharedStrings"), None)
    styles = next((part for kind, part in rels.values() if kind == "styles"), None)
    return sheet, pkg.find(strings), pkg.find(styles), epoch


class _Runs:
    """A cell's text gathered from its runs, kept to what an Excel cell
    holds (MAX_CELL_TEXT): runs past it are dropped unread."""

    def __init__(self) -> None:
        self.parts: list[str] = []
        self.size = 0

    def add(self, text: str | None) -> None:
        if text and self.size < MAX_CELL_TEXT:
            self.parts.append(text)
            self.size += len(text)

    def text(self) -> str:
        return "".join(self.parts)[:MAX_CELL_TEXT]


def _cut(text: str) -> str:
    """Text as an Excel cell holds it: at most MAX_CELL_TEXT characters."""
    return text[:MAX_CELL_TEXT]


def _shared_strings(pkg: _Package, member: str | None) -> list[str]:
    """The shared strings table: each entry's text (its runs joined, its
    phonetic hints left out, cut where an Excel cell ends). A blank entry
    is held as "": a blank cell is skipped, never charged, so each cell
    naming it must cost nothing to tell blank, not a scan of its spaces."""
    out: list[str] = []
    if member is None:
        return out
    runs: _Runs | None = None
    for event, path, element in pkg.walk(member):
        depth = len(path)
        if depth == 2 and path[1] == "si":
            if event == "start":
                runs = _Runs()
            elif runs is not None:
                text = runs.text()
                out.append(text if text.strip() else "")
                runs = None
        elif (event == "end" and runs is not None and path[-1] == "t"
              and (depth == 3 or (depth == 4 and path[2] == "r"))):
            runs.add(element.text)
    return out


def _format_kind(code: str) -> str | None:
    """A number format as the import reads its cells: "day" (a date shown
    without a time), "datetime" (one shown with a time, or a time),
    "percent", or None."""
    shown = is_datetime(code)
    if shown is not None:
        return "day" if shown == "date" else "datetime"
    return "percent" if "%" in code else None


_BUILTIN_KINDS = {fid: _format_kind(code) for fid, code in BUILTIN_FORMATS.items()}


def _style_kinds(pkg: _Package, member: str | None) -> list[str | None]:
    """Each cell style's (cellXfs entry's) number format as what the import
    cares about (_format_kind)."""
    if member is None:
        return []
    custom: dict[int, str | None] = {}
    kinds: list[str | None] = []
    for event, path, element in pkg.walk(member):
        if event != "start" or len(path) != 3:
            continue
        if path[1:] == ["numFmts", "numFmt"]:
            fid = _int(element.get("numFmtId"))
            if fid is not None and fid not in custom:
                custom[fid] = _format_kind(element.get("formatCode") or "")
        elif path[1:] == ["cellXfs", "xf"]:
            fid = _int(element.get("numFmtId")) or 0
            # numFmts come first in the part: a later one can't change these
            kinds.append(custom[fid] if fid in custom else _BUILTIN_KINDS.get(fid))
    return kinds


def _row_number(text: str | None, previous: int) -> int:
    number = _int(text)
    return number if number is not None and number > previous else previous + 1


def _column(ref: str | None, previous: int) -> int:
    match = _CELL_REF.fullmatch(ref.strip()) if ref else None
    return column_index_from_string(match[1].upper()) if match else previous + 1


class _ErrorCell(str):
    """A formula's error value (#N/A, #REF!): a problem, never text."""


class _DayCell(datetime):
    """An Excel date in a cell whose format shows no time: at midnight it
    is a day alone."""


class _SheetReader:
    """The first worksheet's rows, streamed: (row number, {column: value})
    for each row, holding only the cells `keep` takes. A value is text
    (cut where an Excel cell ends), a number, a bool, a datetime, a
    _Percent or an _ErrorCell; a formula reads as its cached value and is
    never evaluated."""

    EMPTY = "The first sheet is empty."

    def __init__(self, pkg: _Package, member: str, strings: list[str],
                 kinds: list[str | None], epoch: datetime):
        self.pkg, self.member, self.strings, self.kinds, self.epoch = (
            pkg, member, strings, kinds, epoch)
        self.any_value = False

    def no_header(self) -> str:
        return "The first sheet needs a header row with a Task Name (or Name) column."

    def rows(self, keep: _Keep) -> Iterator[tuple[int, dict[int, object]]]:
        number = column = 0
        cells: dict[int, object] = {}
        kind = style = value = None
        inline: _Runs | None = None
        for event, path, element in self.pkg.walk(self.member):
            depth = len(path)
            if depth < 3 or path[1] != "sheetData":
                continue
            tag = path[-1]
            if event == "start":
                if depth == 3 and tag == "row":
                    number, column, cells = _row_number(element.get("r"), number), 0, {}
                elif depth == 4 and tag == "c":
                    column = _column(element.get("r"), column)
                    kind, style, value = element.get("t") or "n", element.get("s"), None
                    inline = _Runs()
                continue
            if depth == 5 and tag == "v" and path[3] == "c":
                value = element.text or ""
            elif (tag == "t" and inline is not None and depth >= 6 and path[4] == "is"
                  and (depth == 6 or (depth == 7 and path[5] == "r"))):
                inline.add(element.text)
            elif depth == 4 and tag == "c":
                decoded = self._decode(kind, style, value, inline)
                # the shared table holds a blank entry as "", so a shared
                # cell is told blank in one step: stripping it would scan a
                # long entry's spaces again for every cell naming it
                # (blank entries as "": pinned by tests/test_plans_excel.py's
                # test_shared_strings_before_the_header_count_against_the_budget)
                blank = (decoded is None or decoded == "") if kind == "s" else _blank(decoded)
                if not blank:
                    self.any_value = True
                    # a shared string is stored once but is a whole cell of
                    # text each time it is named: charged when a cell keeps
                    # it, and before that while the header row is looked
                    # for, when every cell is read as a possible column name
                    charged = kind == "s" and keep.looking
                    if charged:
                        self.pkg.charge(len(decoded))
                    if keep(column, decoded):
                        if kind == "s" and not charged:
                            self.pkg.charge(len(decoded))
                        cells[column] = decoded
                inline = None
            elif depth == 3 and tag == "row":
                yield number, cells

    def _decode(self, kind: str, style: str | None, value: str | None, inline: _Runs | None):
        if kind == "inlineStr":
            return inline.text() if inline is not None else None
        if value is None:
            return None
        if kind == "s":
            index = _int(value)
            return self.strings[index] if index is not None and 0 <= index < len(
                self.strings) else None
        if kind == "e":
            return _ErrorCell(_cut(value.strip()))
        if kind in ("str", "d"):                # formula text, an ISO date
            return _cut(value)
        if kind == "b":
            return value.strip().lower() in ("1", "true")
        try:
            number = float(value)
        except ValueError:
            return _cut(value)
        if not math.isfinite(number):
            return _cut(value)
        index = _int(style)
        fmt = self.kinds[index] if index is not None and 0 <= index < len(self.kinds) else None
        if fmt in ("day", "datetime"):
            try:
                moment = from_excel(number, self.epoch)
            except (OverflowError, ValueError):
                return number
            if not isinstance(moment, datetime):
                return number
            return _DayCell.combine(moment.date(), moment.time()) if fmt == "day" else moment
        return _Percent(number) if fmt == "percent" else number


class _CsvReader:
    """A CSV's rows (UTF-8, Excel's BOM allowed, commas): (row number,
    {column: text}), each cell cut where an Excel cell ends."""

    EMPTY = "This CSV file has no rows."

    def __init__(self, content: bytes):
        try:
            self.text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise _bad_file(NOT_UTF8) from None
        self.any_value = False
        # a cell like "ID;Task Name": the file is separated by something else
        self.other_separator = False

    def no_header(self) -> str:
        if self.other_separator:
            return NOT_COMMAS
        return "This CSV file needs a header row with a Task Name (or Name) column."

    def rows(self, keep: _Keep) -> Iterator[tuple[int, dict[int, object]]]:
        reader = csv.reader(io.StringIO(self.text, newline=""))
        try:
            for number, record in enumerate(reader, 1):
                cells: dict[int, object] = {}
                for column, raw in enumerate(record, 1):
                    if not raw.strip():
                        continue
                    raw = _cut(raw)
                    self.any_value = True
                    if keep(column, raw):
                        cells[column] = raw
                    elif not self.other_separator and ("\t" in raw or ";" in raw):
                        self.other_separator = any(
                            _field(part) for part in _OTHER_SEPARATORS.split(raw))
                yield number, cells
        except csv.Error:
            raise _bad_file(CSV_UNREADABLE) from None


def parse_xlsx(content: bytes, filename: str) -> ParsedPlan:
    """An .xlsx's first sheet, or a CSV when `filename` ends in .csv, as a
    ParsedPlan (plans/importer.py)."""
    if filename.strip().lower().endswith(".csv"):
        return parse_csv(content)
    return parse_workbook(content)


def parse_workbook(content: bytes) -> ParsedPlan:
    """An .xlsx's first sheet as a ParsedPlan. Raises ImportFileError: 413
    `file_too_large`, 422 `bad_file` {message} (not a workbook, one that
    unpacks past the cap, a DTD or entity, nested too deeply, no worksheet,
    no header), 422 `too_many_rows` {limit}."""
    _check_size(content)
    pkg = _Package(content)
    try:
        sheet, strings, styles, epoch = _parts(pkg)
        reader = _SheetReader(pkg, sheet, _shared_strings(pkg, strings),
                              _style_kinds(pkg, styles), epoch)
        return _Table.parse(reader)
    except ImportFileError:
        raise
    except DefusedXmlException:
        raise _bad_file(DTD_REFUSED) from None
    except (DET.ParseError, zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError,
            RuntimeError, OSError, LookupError, ValueError):
        # a corrupt or encrypted member, a missing part, malformed XML
        raise _bad_file(UNREADABLE) from None


def parse_csv(content: bytes) -> ParsedPlan:
    """A CSV file as a ParsedPlan; errors as parse_workbook's."""
    _check_size(content)
    return _Table.parse(_CsvReader(content))


# --- import: the rows ---------------------------------------------------------------

# the header names read (ignoring case and spacing) -> the field
HEADERS = {
    "id": "id", "name": "name", "task name": "name", "duration": "duration",
    "start": "start", "finish": "finish", "predecessors": "predecessors",
    "resource names": "resources", "% complete": "percent", "deadline": "deadline",
    "outline level": "outline_level", "wbs": "wbs", "notes": "notes",
    "milestone": "milestone", "color": "color", "mode": "mode", "task mode": "mode",
}
# each field's MS Project column name, for the problems that name one
LABELS = {
    "id": "ID", "name": "Task Name", "duration": "Duration", "start": "Start",
    "finish": "Finish", "predecessors": "Predecessors", "resources": "Resource Names",
    "percent": "% Complete", "deadline": "Deadline", "outline_level": "Outline Level",
    "wbs": "WBS", "notes": "Notes", "milestone": "Milestone", "color": "Color",
    "mode": "Task Mode",
}
# a row with only these is a blank row (MS Project numbers its blank rows)
_PLACE_FIELDS = frozenset({"id", "outline_level", "wbs"})
_MODES = {"auto scheduled": "auto", "auto": "auto", "manually scheduled": "manual",
          "manual": "manual"}
_YES = frozenset({"yes", "y", "true", "1"})
_NO = frozenset({"no", "n", "false", "0"})
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+")
_ASCII_WHITESPACE = " \t\n\r\f\v"           # what predecessor entries are trimmed of
_WBS = re.compile(r"[^.\s]+(?:\.[^.\s]+)*")
_WHOLE = re.compile(r"[0-9]{1,9}")
_DECIMAL = re.compile(r"[+-]?[0-9]{1,9}(?:\.[0-9]{0,9})?")
_ISO_SPACE = re.compile(r"([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}(?::[0-9]{2})?)",
                        re.ASCII)
_US_DATE = re.compile(
    r"(?:[A-Za-z]{2,9}\.?,?\s+)?([0-9]{1,2})/([0-9]{1,2})/([0-9]{4}|[0-9]{2})"
    r"(?:\s+([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?)?", re.ASCII)


def _field(value) -> str | None:
    if not isinstance(value, str):
        return None
    return HEADERS.get(" ".join(value.split()).casefold())


class _Keep:
    """Which cells a reader holds on to: in the header row the ones naming
    a known column, after it the header's columns."""

    def __init__(self) -> None:
        self.columns: set[int] | None = None

    @property
    def looking(self) -> bool:
        """Still looking for the header row: each cell is read as a
        possible column name (`_field`)."""
        return self.columns is None

    def __call__(self, column: int, value) -> bool:
        if self.columns is None:
            return _field(value) is not None
        return column in self.columns


class _AnyId:
    """Every number is a task ID here: the importer checks the links."""

    def __contains__(self, _item) -> bool:
        return True


def _text(value) -> str:
    """A cell as text (bulk import's rule: 2.0 reads 2); "" for blank."""
    return cell_text(value)


def _entries(text: str, trim: str | None = None) -> Iterator[str]:
    """A cell's comma-separated entries, each trimmed (of `trim`, else of
    any whitespace), one at a time: a cell is never split into a list."""
    start = 0
    while True:
        end = text.find(",", start)
        yield (text[start:] if end < 0 else text[start:end]).strip(trim)
        if end < 0:
            return
        start = end + 1


def _without_units(part: str) -> str:
    """A Resource Names entry without MS Project's units (`Pat Lee[50%]`)."""
    head, bracket, tail = part.rpartition("[")
    return head if bracket and tail.rstrip().endswith("]") else part


def _year(text: str) -> int:
    """A 2-digit year as Excel reads one: 00-29 in the 2000s, 30-99 the 1900s."""
    year = int(text)
    if len(text) == 2:
        year += 2000 if year < 30 else 1900
    return year


def _text_date(text: str) -> tuple[datetime, bool]:
    """A typed date: `2026-11-02`, `2026-11-02T08:00` (or a space for the
    T), or the sheet's US order `11/2/2026`, `Mon 11/2/26 8:00 AM`, `11/2/26
    17:00`; and whether it was a day alone (held at midnight: the importer
    gives it the plan calendar's default time). ValueError when it isn't
    one."""
    text = " ".join(text.split())
    if len(text) > 40:
        raise ValueError("too long for a date")
    iso = _ISO_SPACE.fullmatch(text)
    typed = f"{iso[1]}T{iso[2]}" if iso else text
    try:
        return parse_floating(typed, date_only_time=time(0, 0)), "T" not in typed
    except ValueError:
        pass
    match = _US_DATE.fullmatch(text)
    if match is None:
        raise ValueError("not a date")
    month, day, year = int(match[1]), int(match[2]), _year(match[3])
    if match[4] is None:
        return datetime.combine(date(year, month, day), time(0, 0)), True
    hour, minute, second = int(match[4]), int(match[5]), int(match[6] or 0)
    if match[7]:
        if not 1 <= hour <= 12:
            raise ValueError("not a 12-hour time")
        hour = hour % 12 + (12 if match[7] in "Pp" else 0)
    # built with the seconds so 13:30:99 is refused, then dropped (plan times are minutes)
    return (datetime.combine(date(year, month, day), time(hour, minute, second))
            .replace(second=0), False)


def _to_minute(moment: datetime) -> datetime:
    """An Excel date to the nearest minute (plan times are whole minutes;
    a serial date can land a millisecond short)."""
    moment = moment.replace(tzinfo=None)
    rounded = moment.replace(second=0, microsecond=0)
    return rounded + timedelta(minutes=1) if moment - rounded >= timedelta(seconds=30) else rounded


class _Table:
    """The rows after the header, as ParsedTasks and links."""

    def __init__(self, fields: dict[str, int], header: int):
        self.fields = fields                 # field -> its column
        self.last = header                   # the row number last seen
        self.tasks: list[ParsedTask] = []
        self.preds: list[list[tuple[str, str, Duration]]] = []
        self.keys: set[str] = set()
        self.resources: dict[str, ParsedResource] = {}
        self.blank = self.pending = self.links = self.assigned = 0

    @classmethod
    def parse(cls, reader) -> ParsedPlan:
        keep = _Keep()
        rows = reader.rows(keep)
        header = next(((number, cells) for number, cells in rows if cells), None)
        if header is None:
            raise _bad_file(reader.no_header() if reader.any_value else reader.EMPTY)
        fields: dict[str, int] = {}
        for column in sorted(header[1]):
            fields.setdefault(_field(header[1][column]), column)
        if "name" not in fields:
            raise _bad_file(reader.no_header())
        keep.columns = set(fields.values())
        table = cls(fields, header[0])
        for number, cells in rows:
            table.row(number, cells)
        return table.plan()

    # --- rows ---

    def row(self, number: int, cells: dict[int, object]) -> None:
        self.pending += max(number - self.last - 1, 0)       # rows the file leaves out
        self.last = number
        values = {field: cells[column] for field, column in self.fields.items()
                  if column in cells}
        if not values:
            self.pending += 1
            return
        self.blank += self.pending
        self.pending = 0
        if values.keys() <= _PLACE_FIELDS:
            self.blank += 1
            return
        if len(self.tasks) >= MAX_ROWS:
            raise _too_many()
        self.tasks.append(self.task(values))

    def task(self, values: dict[str, object]) -> ParsedTask:
        problems: list[str] = []
        for field, value in list(values.items()):
            if isinstance(value, _ErrorCell):
                problems.append(f"{LABELS[field]} is the error {_shown(value)}; ignored.")
                del values[field]
        name = _text(values.get("name"))
        if not name:
            problems.append("This task has no name.")
        key = self.key(values.get("id"), len(self.tasks) + 1, problems)
        duration = self.duration(values.get("duration"), problems)
        milestone = self.milestone(values.get("milestone"), problems)
        if milestone is None:
            milestone = duration is not None and duration.minutes == 0
        date_only: set[str] = set()
        dates = {name: self.when(values.get(name), name, date_only, problems)
                 for name in ("start", "finish", "deadline")}
        task = ParsedTask(
            key=key, name=name, outline_level=self.level(values, problems), duration=duration,
            mode=self.mode(values.get("mode"), problems), is_milestone=milestone,
            **dates, percent_complete=self.percent(values.get("percent"), problems),
            notes=_text(values.get("notes")) or None, color=_text(values.get("color")) or None,
            resources=self.resource_keys(values.get("resources")), problems=problems,
            soft_start=True, date_only=date_only)
        self.preds.append(self.predecessors(values.get("predecessors"), problems))
        return task

    def key(self, raw, order: int, problems: list[str]) -> str:
        """The ID column's value (whole numbers without leading zeros), else
        the row order. A blank or repeated ID can't be named by a link."""
        if "id" not in self.fields:
            return str(order)
        text = _text(raw)
        if _WHOLE.fullmatch(text):
            text = str(int(text))
        if not text:
            return f"#{order}"
        if text in self.keys:
            problems.append(f"ID {_shown(text)} is also an earlier task's; links naming it "
                            "go to that task.")
            return f"#{order}"
        self.keys.add(text)
        return text

    def level(self, values: dict[str, object], problems: list[str]) -> int:
        """Outline Level, else the WBS's depth, else flat; a blank or bad
        cell keeps the level of the task above."""
        previous = self.tasks[-1].outline_level if self.tasks else 1
        text = _text(values.get("outline_level"))
        if text:
            if _WHOLE.fullmatch(text) and int(text) >= 1:
                return int(text)
            problems.append(f"Outline Level {_shown(text)!r} isn't a number of 1 or more; "
                            "kept at the level of the task above.")
            return previous
        text = _text(values.get("wbs"))
        if text and "outline_level" not in self.fields:
            if _WBS.fullmatch(text):
                return text.count(".") + 1
            problems.append(f"WBS {_shown(text)!r} isn't an outline number like 1.2.3; "
                            "kept at the level of the task above.")
            return previous
        return previous if {"outline_level", "wbs"} & self.fields.keys() else 1

    @staticmethod
    def duration(raw, problems: list[str]) -> Duration | None:
        text = _text(raw)
        if not text:
            return None
        typed = text[:-1].rstrip() if text.endswith("?") else text   # an estimate
        try:
            return parse_duration(typed, STANDARD)
        except DurationError:
            problems.append(f"Duration {_shown(text)!r} isn't readable; "
                            "used the default duration.")
            return None

    @staticmethod
    def mode(raw, problems: list[str]) -> str | None:
        text = _text(raw)
        if not text:
            return None
        mode = _MODES.get(" ".join(text.split()).casefold())
        if mode is None:
            problems.append(f"Task Mode {_shown(text)!r} isn't Auto Scheduled or Manually "
                            "Scheduled; used the plan's default.")
        return mode

    @staticmethod
    def when(raw, field: str, date_only: set[str], problems: list[str]) -> datetime | None:
        """A date cell (an Excel date, or text: _text_date). A day alone
        (text with no time, or an Excel date at midnight) is held at
        midnight and its field added to `date_only`: the importer gives it
        the plan calendar's default time."""
        if _blank(raw):
            return None
        if isinstance(raw, datetime):
            moment = _to_minute(raw)
            if isinstance(raw, _DayCell) and moment.time() == time(0, 0):
                date_only.add(field)
            return moment
        if isinstance(raw, str):
            try:
                moment, day_alone = _text_date(raw)
            except ValueError:
                pass
            else:
                if day_alone:
                    date_only.add(field)
                return moment
        problems.append(f"{LABELS[field]} {_shown(_text(raw))!r} isn't a date; ignored.")
        return None

    @staticmethod
    def percent(raw, problems: list[str]) -> int:
        if _blank(raw):
            return 0
        if isinstance(raw, _Percent):
            value = float(raw) * 100
        elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
            value = float(raw)
        else:
            text = _text(raw)
            number = text[:-1].rstrip() if text.endswith("%") else text
            if not _DECIMAL.fullmatch(number):
                problems.append(f"% Complete {_shown(text)!r} isn't a number; used 0%.")
                return 0
            value = float(number)
        if math.isfinite(value) and -0.5 <= value < 100.5:   # 0-100 once rounded, halves up
            return math.floor(value + 0.5)
        percent = 0 if value < 0 else 100
        problems.append(f"% Complete {_shown(f'{value:g}')} isn't 0-100; used {percent}%.")
        return percent

    @staticmethod
    def milestone(raw, problems: list[str]) -> bool | None:
        if _blank(raw):
            return None
        if isinstance(raw, bool):
            return raw
        text = _text(raw).casefold()
        if text in _YES:
            return True
        if text not in _NO:
            problems.append(f"Milestone {_shown(_text(raw))!r} isn't Yes or No; used No.")
        return False

    def resource_keys(self, raw) -> list[str]:
        """The Resource Names cell's people and partners (comma-separated,
        units dropped), as keys into the file's resources; each new one
        counts toward MAX_ROWS assignments."""
        keys: list[str] = []
        seen: set[str] = set()
        for part in _entries(_text(raw)):
            name = _without_units(part).strip()
            key = name.casefold()
            if not name or key in seen:
                continue
            self.assigned += 1
            if self.assigned > MAX_ROWS:
                raise _too_many()
            self.resources.setdefault(key, ParsedResource(
                key=key, name=name,
                email=name if "@" in name and _EMAIL.fullmatch(name) else None))
            seen.add(key)
            keys.append(key)
        return keys

    def predecessors(self, raw, problems: list[str]) -> list[tuple[str, str, Duration]]:
        """The Predecessors cell (`2,3SS+1d`), entry by entry: (the
        predecessor's key, link type, lag). The entries that can't be read
        are skipped, with one problem for the cell."""
        out = []
        bad, first = 0, ""
        for part in _entries(_text(raw), _ASCII_WHITESPACE):
            if not part:
                continue
            try:
                (spec,) = parse_predecessors(part, STANDARD, valid_ids=_AnyId(), self_id=None)
            except PredecessorError:
                bad, first = bad + 1, first or part
                continue
            self.links += 1
            if self.links > MAX_ROWS:
                raise _too_many()
            out.append((str(spec.display_id), spec.link_type, spec.lag))
        if bad == 1:
            problems.append(f"Predecessor {_shown(first)!r} isn't readable; link skipped.")
        elif bad:
            problems.append(f"Predecessors {_shown(first)!r} and {bad - 1} more aren't "
                            "readable; links skipped.")
        return out

    # --- the plan ---

    def plan(self) -> ParsedPlan:
        """The tasks (their Start soft: the importer settles it against the
        schedule) and the links."""
        links = [ParsedLink(predecessor=pred, successor=task.key, link_type=link_type, lag=lag)
                 for task, preds in zip(self.tasks, self.preds, strict=True)
                 for pred, link_type, lag in preds]
        problems = []
        if self.blank:
            problems.append(f"Skipped {self.blank} blank row{'s' if self.blank != 1 else ''}.")
        return ParsedPlan(tasks=self.tasks, links=links, resources=list(self.resources.values()),
                          problems=problems, units=STANDARD, key_label="ID")
