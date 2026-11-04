"""MS Project XML (MSPDI, namespace http://schemas.microsoft.com/project):
`export_xml` writes a plan as a file MS Project opens, `parse_xml` reads
one into a ParsedPlan for plans/importer.py.

Mapping (both ways):
- Times: MSPDI `Start` / `Finish` / dates are local wall-clock
  `YYYY-MM-DDTHH:MM:SS`, as plan times are (plans/floating.py): no zone
  conversion either way.
- `Duration`: ISO 8601 hours, minutes, seconds of working time (`PT16H0M0S`
  is two 8-hour days), wall-clock for an elapsed task; `DurationFormat`
  the unit shown: 3 m, 4 em, 5 h, 6 eh, 7 d, 8 ed, 9 w, 10 ew, 11 mo,
  12 emo (on import the "estimated" codes 35-44 are the same units).
- `PredecessorLink`: `Type` 0 FF, 1 FS, 2 SF, 3 SS; `LinkLag` in tenths of
  a minute; `LagFormat` codes as `DurationFormat`.
- `ConstraintType`: 0 ASAP, 1 ALAP, 2 MSO, 3 MFO, 4 SNET, 5 SNLT, 6 FNET,
  7 FNLT, with `ConstraintDate`.
- The project's base `Calendar` (UID 1): `WeekDays` (`DayType` 1 Sunday
  ... 7 Saturday) and dated `Exceptions`, one per day; a `ToTime` of
  00:00:00 is midnight at the end of the day (24:00).
- `MinutesPerDay` / `MinutesPerWeek` / `DaysPerMonth` are the plan
  calendar's hours a day / week and days a month; `StartDate` and
  `StatusDate` the plan's project start and status date.
- `Resources` are the people and partners the plan assigns, by name (no
  email addresses: a file is often shared outside the company), with one
  `Assignment` per task and resource.
- Task color is never written: MS Project keeps bar styles in the view,
  not on the task. Neither is the timeline flag, the baseline or slack.

Export writes only elements of the schema, each element's children in the
schema's sequence (`*_ORDER`), since MS Project reads the file against it.

Import parses only through defusedxml, streaming: a DTD or any entity is
refused (422 `bad_file`), as is a file over MAX_BYTES (413
`file_too_large`), one nested deeper than MAX_DEPTH, and one holding more
than MAX_ROWS tasks, links, resources or assignments (422 `too_many_rows`).
Every element is dropped from the tree once read, so a large file (MS
Project's timephased data) is never held whole, and a calendar's exception
days are counted before any is built (MAX_EXCEPTION_DAYS in all). A value
that cannot be read is a problem on its task with a fallback, never a
failure. The project summary task (UID 0) is never imported: a link from
it is a problem that says so, and another task at outline level 0 is
imported at the top level."""

from __future__ import annotations

import io
import re
import uuid
from datetime import date, datetime, time, timedelta
from fractions import Fraction
from xml.etree import ElementTree as ET  # builds the export only; uploads use defusedxml

import defusedxml.ElementTree as DET
from defusedxml import DefusedXmlException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Partner
from serversherpa.plans.calendar import DAY_KEYS, MAX_EXCEPTIONS, WorkCalendar
from serversherpa.plans.durations import Duration, Units
from serversherpa.plans.floating import parse_floating
from serversherpa.plans.importer import (
    MAX_FILE_BYTES,
    ImportFileError,
    ParsedLink,
    ParsedPlan,
    ParsedResource,
    ParsedTask,
)
from serversherpa.plans.limits import MAX_RESTORE_ROWS
from serversherpa.plans.service import PlanState, person_names

__all__ = ["Units", "export_xml", "parse_xml", "resource_names"]

NS = "http://schemas.microsoft.com/project"
MAX_BYTES = MAX_FILE_BYTES
MAX_ROWS = MAX_RESTORE_ROWS          # tasks, links, resources, assignments: the restore op's cap
# MSPDI's deepest element is 8 levels down (a calendar exception's working
# time); anything far deeper is not an MS Project file
MAX_DEPTH = 32
# whole-minute intervals that do not overlap: a day cannot hold more
MAX_DAY_INTERVALS = 1440
# ended elements cut off their parent at a time while streaming (a batch
# size, not a limit: each cut is one short list move)
DROP_EVERY = 512
MISSING_RESOURCE = "-65535"           # MS Project's "no resource" placeholder
# a calendar's exception days in all (each one dated exception of the plan's
# calendar): the most a stored calendar holds (calendar.MAX_EXCEPTIONS)
MAX_EXCEPTION_DAYS = MAX_EXCEPTIONS
TOO_MANY_EXCEPTIONS = "it has too many exceptions"
PROJECT_SUMMARY_UID = "0"             # MS Project's project summary task

# DurationFormat / LagFormat <-> (unit, elapsed)
FORMATS = {3: ("m", False), 4: ("m", True), 5: ("h", False), 6: ("h", True),
           7: ("d", False), 8: ("d", True), 9: ("w", False), 10: ("w", True),
           11: ("mo", False), 12: ("mo", True)}
FORMAT_CODES = {value: code for code, value in FORMATS.items()}
ESTIMATED = 32                        # 35-44: the same units, estimated
PERCENT_FORMATS = frozenset({19, 20, 51, 52})
LINK_TYPES = {0: "FF", 1: "FS", 2: "SF", 3: "SS"}
LINK_CODES = {value: code for code, value in LINK_TYPES.items()}
CONSTRAINTS = {0: "asap", 1: "alap", 2: "mso", 3: "mfo", 4: "snet", 5: "snlt", 6: "fnet",
               7: "fnlt"}
CONSTRAINT_CODES = {value: code for code, value in CONSTRAINTS.items()}
DAY_TYPES = {"sun": 1, "mon": 2, "tue": 3, "wed": 4, "thu": 5, "fri": 6, "sat": 7}
DAY_OF_TYPE = {code: key for key, code in DAY_TYPES.items()}

# The schema's sequence for every element the export writes (mspdi_pj14.xsd;
# only the elements used, in order)
PROJECT_ORDER = ["SaveVersion", "Name", "Title", "ScheduleFromStart", "StartDate",
                 "FinishDate", "CalendarUID", "DefaultStartTime", "DefaultFinishTime",
                 "MinutesPerDay", "MinutesPerWeek", "DaysPerMonth", "StatusDate",
                 "Calendars", "Tasks", "Resources", "Assignments"]
CALENDAR_ORDER = ["UID", "Name", "IsBaseCalendar", "BaseCalendarUID", "WeekDays",
                  "Exceptions"]
WEEKDAY_ORDER = ["DayType", "DayWorking", "WorkingTimes"]
EXCEPTION_ORDER = ["EnteredByOccurrences", "TimePeriod", "Occurrences", "Name", "Type",
                   "DayWorking", "WorkingTimes"]
TASK_ORDER = ["UID", "ID", "Name", "Manual", "WBS", "OutlineNumber", "OutlineLevel", "Start",
              "Finish", "Duration", "ManualStart", "ManualFinish", "ManualDuration",
              "DurationFormat", "Estimated", "Milestone", "Summary", "Critical",
              "PercentComplete", "ActualStart", "ActualFinish", "ConstraintType",
              "ConstraintDate", "Deadline", "Notes", "PredecessorLink"]
LINK_ORDER = ["PredecessorUID", "Type", "CrossProject", "LinkLag", "LagFormat"]
RESOURCE_ORDER = ["UID", "ID", "Name", "Type", "Group"]
ASSIGNMENT_ORDER = ["UID", "TaskUID", "ResourceUID", "Units"]

# characters XML 1.0 cannot hold (control characters but tab, LF, CR)
_NOT_XML = re.compile("[^\t\n\r\x20-퟿-�\U00010000-\U0010ffff]")
_INT = re.compile(r"[+-]?[0-9]{1,9}")
_CLOCK = re.compile(r"([01][0-9]|2[0-3]):([0-5][0-9])(?::[0-5][0-9](?:\.[0-9]+)?)?")
_NUMBER = r"([0-9]{1,9}(?:\.[0-9]{1,9})?)"
_ISO = re.compile(rf"P(?:{_NUMBER}Y)?(?:{_NUMBER}M)?(?:{_NUMBER}W)?(?:{_NUMBER}D)?"
                  rf"(?:T(?:{_NUMBER}H)?(?:{_NUMBER}M)?(?:{_NUMBER}S)?)?", re.ASCII)
_MAX_ISO = 64
_STANDARD_DAY = [["08:00", "12:00"], ["13:00", "17:00"]]
_ONE_DAY = timedelta(days=1)


# --- times and durations ------------------------------------------------------------


def format_time(moment: datetime) -> str:
    """A plan time as MSPDI writes it: `YYYY-MM-DDTHH:MM:SS`, no zone."""
    if moment.tzinfo is not None:
        raise ValueError("a plan time must be a naive wall-clock time")
    return moment.isoformat(timespec="seconds")


def parse_time(text: str) -> datetime:
    """An MSPDI date-time (a date alone is that day's midnight) as a
    floating plan time; ValueError when it is not one."""
    return parse_floating(text, date_only_time=time(0, 0))


def iso_duration(minutes: int) -> str:
    """`PT16H0M0S`: whole minutes as MS Project writes a duration."""
    return f"PT{minutes // 60}H{minutes % 60}M0S"


def parse_iso_duration(text: str, units: Units, *, elapsed: bool) -> int:
    """An ISO 8601 duration as whole minutes, halves up. Hours, minutes and
    seconds are absolute; days, weeks, months and years count in `units`
    (working time) or wall-clock time when `elapsed`. No sign: ValueError
    for a negative or unreadable one."""
    text = text.strip() if isinstance(text, str) else ""
    match = _ISO.fullmatch(text) if len(text) <= _MAX_ISO else None
    if match is None or not any(match.groups()) or text.endswith("T"):
        raise ValueError("not an ISO 8601 duration")
    if elapsed:
        day, week, month = 1440, 10080, 43200
    else:
        day, week, month = units.minutes_per_day, units.minutes_per_week, units.minutes_per_month
    scale = (12 * month, month, week, day, 60, 1, Fraction(1, 60))
    total = sum((Fraction(value) * per for value, per in zip(match.groups(), scale, strict=True)
                 if value is not None), Fraction(0))
    return int((total * 2 + 1) // 2)


def _format_code(unit: str, elapsed: bool) -> str:
    return str(FORMAT_CODES.get((unit, elapsed), 7))


# --- export -------------------------------------------------------------------------


def _text(value: str) -> str:
    return _NOT_XML.sub("", value)


def _el(tag: str) -> ET.Element:
    return ET.Element(f"{{{NS}}}{tag}")


def _fill(parent: ET.Element, order: list[str], values: dict) -> ET.Element:
    """Append `values` ({tag: text, element or a list of elements; None is
    left out}) to `parent` in the schema's `order`."""
    for tag in order:
        value = values.get(tag)
        if value is None:
            continue
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, ET.Element):
                parent.append(item)
            else:
                child = _el(tag)
                child.text = _text(str(item))
                parent.append(child)
    return parent


def _flag(value: bool) -> str:
    return "1" if value else "0"


def _clock(text: str) -> str:
    """A calendar HH:MM as MSPDI's HH:MM:SS; 24:00 (the end of the day) is
    00:00:00."""
    return "00:00:00" if text == "24:00" else f"{text}:00"


def _working_times(hours: list) -> ET.Element | None:
    if not hours:
        return None
    times = _el("WorkingTimes")
    for start, end in hours:
        _fill(times, ["WorkingTime"], {"WorkingTime": _fill(
            _el("WorkingTime"), ["FromTime", "ToTime"],
            {"FromTime": _clock(start), "ToTime": _clock(end)})})
    return times


def _calendar(calendar: dict) -> ET.Element:
    week = _el("WeekDays")
    for key in sorted(DAY_KEYS, key=DAY_TYPES.__getitem__):
        hours = calendar["week"][key]
        week.append(_fill(_el("WeekDay"), WEEKDAY_ORDER, {
            "DayType": DAY_TYPES[key], "DayWorking": _flag(bool(hours)),
            "WorkingTimes": _working_times(hours)}))
    exceptions = _el("Exceptions")
    for item in calendar.get("exceptions") or []:
        period = _fill(_el("TimePeriod"), ["FromDate", "ToDate"], {
            "FromDate": f"{item['date']}T00:00:00", "ToDate": f"{item['date']}T23:59:00"})
        exceptions.append(_fill(_el("Exception"), EXCEPTION_ORDER, {
            "EnteredByOccurrences": "0", "TimePeriod": period, "Occurrences": "1",
            "Name": item.get("name") or None, "Type": "1",
            "DayWorking": _flag(bool(item["hours"])),
            "WorkingTimes": _working_times(item["hours"])}))
    return _fill(_el("Calendar"), CALENDAR_ORDER, {
        "UID": "1", "Name": "Project plan", "IsBaseCalendar": "1", "BaseCalendarUID": "-1",
        "WeekDays": week, "Exceptions": exceptions if len(exceptions) else None})


def _outline(state: PlanState, order: list[uuid.UUID]
             ) -> tuple[dict[uuid.UUID, int], dict[uuid.UUID, str]]:
    """Each task's outline level and WBS (`order` is outline order: each
    parent before its subtasks)."""
    level: dict[uuid.UUID, int] = {}
    wbs: dict[uuid.UUID, str] = {}
    count: dict[uuid.UUID | None, int] = {}
    for tid in order:
        parent = state.tasks[tid].parent_id
        parent = parent if parent in level else None
        count[parent] = count.get(parent, 0) + 1
        level[tid] = 1 if parent is None else level[parent] + 1
        wbs[tid] = str(count[parent]) if parent is None else f"{wbs[parent]}.{count[parent]}"
    return level, wbs


async def resource_names(db: AsyncSession, state: PlanState
                         ) -> dict[tuple[str, uuid.UUID], str]:
    """The name of every person and partner the plan assigns."""
    rows = [row for rows in state.assignments.values() for row in rows]
    people = await person_names(db, [row.person_id for row in rows])
    partner_ids = {row.partner_id for row in rows if row.partner_id is not None}
    partners = dict((await db.execute(
        select(Partner.id, Partner.name).where(Partner.id.in_(partner_ids))
    )).all()) if partner_ids else {}
    out = {("person", pid): name for pid, name in people.items()}
    out.update({("partner", pid): name for pid, name in partners.items()})
    return out


def export_xml(state: PlanState, initiative_name: str, units: Units,
               resource_names: dict[tuple[str, uuid.UUID], str] | None = None) -> bytes:
    """The plan as an MSPDI file (UTF-8). `resource_names` names each
    assigned (kind, id) (`resource_names`); one missing is "(unknown)"."""
    plan = state.plan
    calendar = WorkCalendar.from_json(plan.calendar)
    order = [tid for tid in state.order if tid in state.tasks]
    uid = {tid: i + 1 for i, tid in enumerate(order)}
    level, wbs = _outline(state, order)
    summaries = {t.parent_id for t in state.tasks.values() if t.parent_id in state.tasks}
    finishes = [t.finish for t in state.tasks.values() if t.finish is not None]
    starts = [t.start for t in state.tasks.values() if t.start is not None]
    names = resource_names or {}

    into: dict[uuid.UUID, list] = {}
    for link in state.links.values():
        if link.predecessor_id in uid and link.successor_id in uid:
            into.setdefault(link.successor_id, []).append(link)

    tasks = _el("Tasks")
    if order:
        # the project summary task MS Project keeps as UID 0
        first, last = min(starts, default=plan.project_start), max(finishes, default=None)
        tasks.append(_fill(_el("Task"), TASK_ORDER, {
            "UID": "0", "ID": "0", "Name": initiative_name, "OutlineNumber": "0",
            "OutlineLevel": "0", "Start": format_time(first),
            "Finish": format_time(last) if last is not None else None,
            "Duration": iso_duration(calendar.work_between(first, last)
                                     if last is not None and last > first else 0),
            "DurationFormat": "7", "Summary": "1"}))
    for tid in order:
        task = state.tasks[tid]
        summary = tid in summaries
        manual = task.mode == "manual" and not summary
        links = sorted(into.get(tid, []), key=lambda lk: uid[lk.predecessor_id])
        tasks.append(_fill(_el("Task"), TASK_ORDER, {
            "UID": uid[tid], "ID": uid[tid], "Name": task.name, "Manual": _flag(manual),
            "WBS": wbs[tid], "OutlineNumber": wbs[tid], "OutlineLevel": level[tid],
            "Start": format_time(task.start) if task.start else None,
            "Finish": format_time(task.finish) if task.finish else None,
            "Duration": iso_duration(task.duration_minutes),
            "ManualStart": format_time(task.start) if manual and task.start else None,
            "ManualFinish": format_time(task.finish) if manual and task.finish else None,
            "ManualDuration": iso_duration(task.duration_minutes) if manual else None,
            "DurationFormat": _format_code(task.duration_unit, task.elapsed),
            "Estimated": "0", "Milestone": _flag(task.is_milestone), "Summary": _flag(summary),
            "Critical": _flag(task.is_critical), "PercentComplete": task.percent_complete,
            "ActualStart": format_time(task.actual_start) if task.actual_start else None,
            "ActualFinish": format_time(task.actual_finish) if task.actual_finish else None,
            "ConstraintType": CONSTRAINT_CODES.get(task.constraint_type, 0),
            "ConstraintDate": (format_time(task.constraint_date)
                               if task.constraint_date and task.constraint_type != "asap"
                               else None),
            "Deadline": format_time(task.deadline) if task.deadline else None,
            "Notes": task.notes or None,
            "PredecessorLink": [_fill(_el("PredecessorLink"), LINK_ORDER, {
                "PredecessorUID": uid[lk.predecessor_id], "Type": LINK_CODES[lk.link_type],
                "CrossProject": "0", "LinkLag": lk.lag_minutes * 10,
                "LagFormat": _format_code(lk.lag_unit, lk.lag_elapsed)}) for lk in links],
        }))

    used: dict[tuple[str, uuid.UUID], int] = {}
    assignments = _el("Assignments")
    for tid in order:
        rows = sorted(state.assignments.get(tid, []),
                      key=lambda r: (r.person_id is None, names.get(_key(r), ""), str(_key(r))))
        for row in rows:
            key = _key(row)
            resource_uid = used.setdefault(key, len(used) + 1)
            assignments.append(_fill(_el("Assignment"), ASSIGNMENT_ORDER, {
                "UID": len(assignments) + 1, "TaskUID": uid[tid], "ResourceUID": resource_uid,
                "Units": "1"}))
    resources = _el("Resources")
    for (kind, rid), resource_uid in used.items():
        resources.append(_fill(_el("Resource"), RESOURCE_ORDER, {
            "UID": resource_uid, "ID": resource_uid, "Name": names.get((kind, rid), "(unknown)"),
            "Type": "1", "Group": "Partner" if kind == "partner" else None}))

    root = _fill(_el("Project"), PROJECT_ORDER, {
        "SaveVersion": "14", "Name": initiative_name, "Title": initiative_name,
        "ScheduleFromStart": "1", "StartDate": format_time(plan.project_start),
        "FinishDate": format_time(max(finishes)) if finishes else None,
        "CalendarUID": "1",
        "DefaultStartTime": f"{calendar.default_start:%H:%M}:00",
        "DefaultFinishTime": f"{calendar.default_end:%H:%M}:00",
        "MinutesPerDay": units.minutes_per_day, "MinutesPerWeek": units.minutes_per_week,
        "DaysPerMonth": round(Fraction(units.minutes_per_month, units.minutes_per_day)),
        "StatusDate": format_time(plan.status_date) if plan.status_date else None,
        "Calendars": _fill(_el("Calendars"), ["Calendar"], {"Calendar": _calendar(plan.calendar)}),
        "Tasks": tasks,
        "Resources": resources if len(resources) else None,
        "Assignments": assignments if len(assignments) else None,
    })
    ET.indent(root)
    return ET.tostring(root, encoding="UTF-8", xml_declaration=True, default_namespace=NS)


def _key(row) -> tuple[str, uuid.UUID]:
    return ("person", row.person_id) if row.person_id is not None else ("partner", row.partner_id)


# --- import: reading the file -------------------------------------------------------


def _bad_file(message: str) -> ImportFileError:
    return ImportFileError(422, "bad_file", message=message)


def _too_many() -> ImportFileError:
    return ImportFileError(422, "too_many_rows", limit=MAX_ROWS)


_ROOT = ("Project",)
_TASK = (*_ROOT, "Tasks", "Task")
_LINK = (*_TASK, "PredecessorLink")
_RESOURCE = (*_ROOT, "Resources", "Resource")
_ASSIGNMENT = (*_ROOT, "Assignments", "Assignment")
_CALENDAR = (*_ROOT, "Calendars", "Calendar")
_DAY = (*_CALENDAR, "WeekDays", "WeekDay")
_DAY_TIME = (*_DAY, "WorkingTimes", "WorkingTime")
_EXCEPTION = (*_CALENDAR, "Exceptions", "Exception")
_EXCEPTION_TIME = (*_EXCEPTION, "WorkingTimes", "WorkingTime")
_WORK_WEEK = (*_CALENDAR, "WorkWeeks", "WorkWeek")
_PERIODS = ((*_DAY, "TimePeriod"), (*_EXCEPTION, "TimePeriod"))

# the fields read from each record (any other element is dropped unread)
_FIELDS = {
    _ROOT: {"Name", "Title", "StartDate", "CalendarUID", "MinutesPerDay", "MinutesPerWeek",
            "DaysPerMonth", "DefaultStartTime", "DefaultFinishTime", "StatusDate"},
    _TASK: {"UID", "Name", "Manual", "IsNull", "OutlineNumber", "OutlineLevel", "Start",
            "Finish", "Duration", "ManualStart", "ManualFinish", "DurationFormat",
            "Milestone", "PercentComplete", "ActualStart", "ActualFinish", "ConstraintType",
            "ConstraintDate", "Deadline", "Notes"},
    _LINK: {"PredecessorUID", "Type", "CrossProject", "LinkLag", "LagFormat"},
    _RESOURCE: {"UID", "Name", "EmailAddress", "IsNull"},
    _ASSIGNMENT: {"TaskUID", "ResourceUID"},
    _CALENDAR: {"UID", "Name", "IsBaseCalendar", "BaseCalendarUID"},
    _DAY: {"DayType", "DayWorking"},
    (*_DAY, "TimePeriod"): {"FromDate", "ToDate"},
    _DAY_TIME: {"FromTime", "ToTime"},
    _EXCEPTION: {"EnteredByOccurrences", "Occurrences", "Name", "Type", "Period",
                 "DayWorking"},
    (*_EXCEPTION, "TimePeriod"): {"FromDate", "ToDate"},
    _EXCEPTION_TIME: {"FromTime", "ToTime"},
}


class _Reader:
    """The file's records as plain dicts, built from the parse events: a
    record opens at its element's start, a field is stored at its end (the
    first of a repeated field wins), and every element is dropped from the
    tree once it ends."""

    def __init__(self) -> None:
        self.project: dict = {}
        self.tasks: list[dict] = []
        self.resources: list[dict] = []
        self.assignments: list[dict] = []
        self.calendars: list[dict] = []
        self.links = 0
        self.open: dict[tuple, dict] = {_ROOT: self.project}    # path -> its open record

    def start(self, path: tuple) -> None:
        record: dict | None = None
        if path == _TASK:
            record = self._add(self.tasks, {"links": []})
        elif path == _LINK:
            self.links += 1
            if self.links > MAX_ROWS:
                raise _too_many()
            record = {}
            self.open[_TASK]["links"].append(record)
        elif path == _RESOURCE:
            record = self._add(self.resources, {})
        elif path == _ASSIGNMENT:
            record = self._add(self.assignments, {})
        elif path == _CALENDAR:
            record = {"days": [], "exceptions": [], "broken": None}
        elif path in (_DAY, _EXCEPTION):
            calendar = self.open[_CALENDAR]
            record = {"times": []}
            entries = calendar["days" if path == _DAY else "exceptions"]
            if len(calendar["days"]) + len(calendar["exceptions"]) >= MAX_RESTORE_ROWS:
                calendar["broken"] = "it has too many exceptions"
            else:
                entries.append(record)
        elif path in (_DAY_TIME, _EXCEPTION_TIME):
            owner = self.open[path[:-2]]
            record = {}
            if len(owner["times"]) >= MAX_DAY_INTERVALS:
                self.open[_CALENDAR]["broken"] = "a day has too many working times"
            else:
                owner["times"].append(record)
        elif path == _WORK_WEEK:
            self.open[_CALENDAR]["broken"] = "it has alternate work weeks"
        elif path in _PERIODS:
            record = self.open[path[:-1]]       # its dates are the day's / exception's fields
        if record is not None:
            self.open[path] = record

    def _add(self, rows: list[dict], record: dict) -> dict:
        if len(rows) >= MAX_ROWS:
            raise _too_many()
        rows.append(record)
        return record

    def end(self, path: tuple, text: str | None) -> None:
        owner = path[:-1]
        if owner in _FIELDS and path[-1] in _FIELDS[owner] and owner in self.open:
            self.open[owner].setdefault(path[-1], text or "")
        if path == _CALENDAR:
            self._keep(self.open[path])
        if path in self.open and path != _ROOT:
            del self.open[path]

    def _keep(self, calendar: dict) -> None:
        """Keep only the project's calendar (`CalendarUID`, which the schema
        puts before `Calendars`), or without one the first base calendar:
        resource calendars, often one per resource, are never held."""
        wanted = (self.project.get("CalendarUID") or "").strip()
        uid = (calendar.get("UID") or "").strip()
        if wanted:
            keep = uid == wanted
        else:
            keep = _flag_of(calendar.get("IsBaseCalendar"))
        if keep and not self.calendars:
            self.calendars.append(calendar)


def _local(tag) -> str:
    return tag.rpartition("}")[2] if isinstance(tag, str) else ""


def _read(content: bytes) -> _Reader:
    """The file's records, streamed. Each element is cleared once it ends
    and cut off its parent soon after: the parser hands its events over in
    batches, so when an element ends its parent may already hold the
    siblings after it. The ended children are always the parent's first
    ones, and are cut off together every DROP_EVERY ends."""
    reader = _Reader()
    path: list[str] = []
    elements: list[ET.Element] = []
    ended: list[int] = []                   # per open element: its children that ended
    try:
        for event, element in DET.iterparse(io.BytesIO(content), events=("start", "end"),
                                            forbid_dtd=True):
            if event == "start":
                if not elements and element.tag not in (f"{{{NS}}}Project", "Project"):
                    raise _bad_file("This isn't an MS Project XML file.")
                if len(path) >= MAX_DEPTH:
                    raise _bad_file("This file is nested too deeply to be an MS Project file.")
                path.append(_local(element.tag))
                elements.append(element)
                ended.append(0)
                reader.start(tuple(path))
                continue
            reader.end(tuple(path), element.text)
            path.pop()
            elements.pop()
            ended.pop()
            element.clear()
            if elements:
                ended[-1] += 1
                if ended[-1] >= DROP_EVERY:
                    del elements[-1][:ended[-1]]
                    ended[-1] = 0
    except ImportFileError:
        raise
    except DefusedXmlException:
        raise _bad_file("This file declares a DTD or entities, which aren't allowed.") from None
    except (DET.ParseError, ValueError, LookupError):
        raise _bad_file("This file isn't readable XML.") from None
    return reader


def parse_xml(content: bytes) -> ParsedPlan:
    """An MSPDI file as a ParsedPlan (plans/importer.py): keys are task
    UIDs, durations and lags in the file's own units. Raises
    ImportFileError: 413 `file_too_large`, 422 `bad_file` {message} (not XML,
    a DTD or entity, not MS Project, nested too deeply), 422
    `too_many_rows` {limit}."""
    if len(content) > MAX_BYTES:
        raise ImportFileError(413, "file_too_large", limit=MAX_BYTES)
    if not content.strip():
        raise _bad_file("The file is empty.")
    reader = _read(content)
    return _Build(reader).plan()


# --- import: building the ParsedPlan ------------------------------------------------


def _int(text: str | None) -> int | None:
    """A whole number of at most 9 digits, else None."""
    if text is None:
        return None
    text = text.strip()
    return int(text) if _INT.fullmatch(text) else None


def _flag_of(text: str | None) -> bool:
    return (text or "").strip().lower() in ("1", "true")


def _shown(text: str) -> str:
    text = text.strip()
    return text if len(text) <= 24 else text[:24] + "..."


def _number(value: Fraction) -> int | float:
    return int(value) if value.denominator == 1 else float(value)


class _Build:
    def __init__(self, reader: _Reader):
        self.r = reader
        self.problems: list[str] = []

    def plan(self) -> ParsedPlan:
        project = self.r.project
        units = self.units()
        start = self._time(project.get("StartDate"), None, "The project start date")
        plan = ParsedPlan(problems=self.problems, units=units, key_label="UID",
                          name=(project.get("Title") or project.get("Name") or "").strip()
                          or None,
                          project_start=start,
                          status_date=self._time(project.get("StatusDate"), None,
                                                 "The status date"))
        resources = self.resources(plan)
        tasks = self.tasks(plan, units)
        self.assignments(tasks, resources)
        plan.calendar, plan.calendar_note = self.calendar(units)
        return plan

    # --- units ---

    def units(self) -> Units:
        project = self.r.project
        per_day = _int(project.get("MinutesPerDay"))
        per_week = _int(project.get("MinutesPerWeek"))
        per_month = _int(project.get("DaysPerMonth"))
        self.unit_keys: dict = {}
        if per_day is not None:
            self.unit_keys["hours_per_day"] = _number(Fraction(per_day, 60))
        if per_week is not None:
            self.unit_keys["hours_per_week"] = _number(Fraction(per_week, 60))
        if per_month is not None:
            self.unit_keys["days_per_month"] = per_month
        valid = ((per_day is None or 1 <= per_day <= 1440)
                 and (per_week is None or 1 <= per_week <= 10080)
                 and (per_month is None or 1 <= per_month <= 31))
        if not valid:
            self.problems.append("The file's minutes per day, minutes per week or days per "
                                 "month aren't valid; used the Standard ones.")
            self.unit_keys = {}
        return Units.from_calendar(self.unit_keys)

    # --- values ---

    def _time(self, text: str | None, problems: list[str] | None, what: str
              ) -> datetime | None:
        if text is None or not text.strip():
            return None
        try:
            return parse_time(text)
        except ValueError:
            (self.problems if problems is None else problems).append(
                f"{what} {_shown(text)!r} isn't a date; ignored.")
            return None

    # --- resources ---

    def resources(self, plan: ParsedPlan) -> dict[str, ParsedResource]:
        out: dict[str, ParsedResource] = {}
        for raw in self.r.resources:
            uid, name = (raw.get("UID") or "").strip(), (raw.get("Name") or "").strip()
            if not uid or not name or _flag_of(raw.get("IsNull")) or uid in out:
                continue
            email = (raw.get("EmailAddress") or "").strip() or None
            out[uid] = ParsedResource(key=uid, name=name, email=email)
        plan.resources = list(out.values())
        return out

    def assignments(self, tasks: dict[str, ParsedTask],
                    resources: dict[str, ParsedResource]) -> None:
        assigned: set[tuple[int, str]] = set()      # (task, resource): no list scans
        for raw in self.r.assignments:
            task = tasks.get((raw.get("TaskUID") or "").strip())
            resource_uid = (raw.get("ResourceUID") or "").strip()
            if task is None or resource_uid in ("", MISSING_RESOURCE):
                continue
            if resource_uid not in resources:
                task.problems.append(f"An assignment names resource UID {_shown(resource_uid)}, "
                                     "which isn't in the file; skipped.")
            elif (id(task), resource_uid) not in assigned:
                assigned.add((id(task), resource_uid))
                task.resources.append(resource_uid)

    # --- tasks ---

    def tasks(self, plan: ParsedPlan, units: Units) -> dict[str, ParsedTask]:
        keys: dict[str, ParsedTask] = {}
        blank = 0
        previous = 1
        for n, raw in enumerate(self.r.tasks):
            if _flag_of(raw.get("IsNull")):
                blank += 1
                continue
            uid = (raw.get("UID") or "").strip()
            level_text = raw.get("OutlineLevel")
            level = _int(level_text)
            blank_level = level_text is None or not level_text.strip()
            if uid == PROJECT_SUMMARY_UID and (level == 0 or blank_level):
                continue                    # the project summary task: never imported
            problems: list[str] = []
            if level == 0:
                problems.append("Outline level 0 is the project summary task's; "
                                "placed at the top level.")
                level = 1
            elif level is None or level < 0:
                if level_text is not None and level_text.strip():
                    problems.append(f"Outline level {_shown(level_text)!r} isn't a number; "
                                    "kept at the level of the task above.")
                    level = previous
                else:
                    number = (raw.get("OutlineNumber") or "").strip()
                    level = (number.count(".") + 1
                             if re.fullmatch(r"[0-9]{1,9}(\.[0-9]{1,9}){0,99}", number) else 1)
            previous = level
            key = uid or f"#{n}"
            if uid and uid in keys:
                problems.append(f"UID {_shown(uid)} is also an earlier task's; links and "
                                "assignments naming it go to that task.")
                key = f"#{n}"
            task = self.task(raw, key, level, units, problems)
            keys.setdefault(key, task)
            plan.tasks.append(task)
            plan.links.extend(self.links(raw, key, units, problems))
        if blank:
            self.problems.append(f"Skipped {blank} blank row{'s' if blank != 1 else ''}.")
        if PROJECT_SUMMARY_UID not in keys:
            plan.links = self._without_summary_links(plan.links, keys)
        return keys

    @staticmethod
    def _without_summary_links(links: list[ParsedLink], keys: dict[str, ParsedTask]
                               ) -> list[ParsedLink]:
        """The links but those from the project summary task (UID 0), which
        is never imported: each is a problem on its task that says so."""
        kept = []
        for link in links:
            if link.predecessor == PROJECT_SUMMARY_UID:
                keys[link.successor].problems.append(
                    "The link from UID 0 is from the project summary task, which isn't "
                    "imported; skipped.")
            else:
                kept.append(link)
        return kept

    def task(self, raw: dict, key: str, level: int, units: Units,
             problems: list[str]) -> ParsedTask:
        manual = _flag_of(raw.get("Manual"))
        code = _int(raw.get("DurationFormat"))
        if code is not None and code > ESTIMATED:
            code -= ESTIMATED
        unit, elapsed = FORMATS.get(code, ("d", False))
        duration = None
        text = raw.get("Duration")
        if text is not None and text.strip():
            try:
                duration = Duration(parse_iso_duration(text, units, elapsed=elapsed), unit,
                                    elapsed)
            except ValueError:
                problems.append(f"Duration {_shown(text)!r} isn't readable; "
                                "used the default duration.")
        start = self._time(raw.get("Start"), problems, "Start")
        finish = self._time(raw.get("Finish"), problems, "Finish")
        if manual:
            start = self._time(raw.get("ManualStart"), problems, "Manual Start") or start
            finish = self._time(raw.get("ManualFinish"), problems, "Manual Finish") or finish
        constraint = "asap"
        text = raw.get("ConstraintType")
        if text is not None and text.strip():
            constraint = CONSTRAINTS.get(_int(text))
            if constraint is None:
                problems.append(f"Constraint type {_shown(text)!r} isn't known; "
                                "scheduled As Soon As Possible.")
                constraint = "asap"
        percent = 0
        text = raw.get("PercentComplete")
        if text is not None and text.strip():
            value = _int(text)
            if value is None:
                problems.append(f"% Complete {_shown(text)!r} isn't a number; used 0%.")
            else:
                percent = min(max(value, 0), 100)
                if percent != value:
                    problems.append(f"% Complete {value} isn't 0-100; used {percent}%.")
        return ParsedTask(
            key=key, name=raw.get("Name") or "", outline_level=level, duration=duration,
            mode="manual" if manual else "auto", is_milestone=_flag_of(raw.get("Milestone")),
            start=start, finish=finish, constraint_type=constraint,
            constraint_date=self._time(raw.get("ConstraintDate"), problems, "Constraint Date"),
            deadline=self._time(raw.get("Deadline"), problems, "Deadline"),
            percent_complete=percent,
            actual_start=self._time(raw.get("ActualStart"), problems, "Actual Start"),
            actual_finish=self._time(raw.get("ActualFinish"), problems, "Actual Finish"),
            notes=raw.get("Notes") or None, problems=problems)

    def links(self, raw: dict, key: str, units: Units, problems: list[str]
              ) -> list[ParsedLink]:
        out = []
        for link in raw["links"]:
            pred = (link.get("PredecessorUID") or "").strip()
            name = f"UID {_shown(pred)}"
            if _flag_of(link.get("CrossProject")):
                problems.append(f"The link from {name} is to another project; skipped.")
                continue
            if not pred:
                problems.append("A predecessor link names no task; skipped.")
                continue
            text = link.get("Type")
            link_type = "FS"
            if text is not None and text.strip():
                link_type = LINK_TYPES.get(_int(text))
                if link_type is None:
                    problems.append(f"Link type {_shown(text)!r} from {name} isn't known; "
                                    "used Finish-to-Start (FS).")
                    link_type = "FS"
            code = _int(link.get("LagFormat"))
            if code is not None and code > ESTIMATED and code not in PERCENT_FORMATS:
                code -= ESTIMATED
            unit, elapsed = FORMATS.get(code, ("d", False))
            tenths = 0
            text = link.get("LinkLag")
            if code in PERCENT_FORMATS:
                if _int(text):
                    problems.append(f"The percent lag from {name} isn't supported; "
                                    "used no lag.")
            elif text is not None and text.strip():
                value = _int(text)
                if value is None:
                    problems.append(f"The lag from {name} isn't readable; used no lag.")
                else:
                    tenths = value
            minutes = int((Fraction(abs(tenths), 10) * 2 + 1) // 2)
            out.append(ParsedLink(predecessor=pred, successor=key, link_type=link_type,
                                  lag=Duration(-minutes if tenths < 0 else minutes, unit,
                                               elapsed)))
        return out

    # --- the calendar ---

    def calendar(self, units: Units) -> tuple[dict | None, str | None]:
        """The project calendar as a plan calendar, or None with why it does
        not fit the week + dated exceptions model (None, None when the file
        has no calendar)."""
        calendars = self.r.calendars
        if not calendars:
            return None, None
        wanted = (self.r.project.get("CalendarUID") or "").strip()
        found = None
        if wanted:
            found = next((c for c in calendars if (c.get("UID") or "").strip() == wanted), None)
        else:
            found = next((c for c in calendars if _flag_of(c.get("IsBaseCalendar"))), None)
        if found is None:
            return None, "the file's project calendar wasn't found"
        if found["broken"]:
            return None, found["broken"]
        week: dict[str, list] = {}
        exceptions: list[dict] = []
        try:
            for day in found["days"]:
                code = _int(day.get("DayType"))
                if code == 0:               # Project 2003's dated exception
                    if not self._add_days(exceptions, day):
                        return None, TOO_MANY_EXCEPTIONS
                elif code in DAY_OF_TYPE:
                    if DAY_OF_TYPE[code] in week:
                        return None, "a weekday is listed twice"
                    week[DAY_OF_TYPE[code]] = self._hours(day)
                else:
                    return None, "a weekday isn't one MS Project writes"
            for item in found["exceptions"]:
                if _int(item.get("Type")) not in (None, 1) or \
                        _int(item.get("Period")) not in (None, 1):
                    return None, "it has recurring exceptions"
                if not self._add_days(exceptions, item):
                    return None, TOO_MANY_EXCEPTIONS
        except ValueError as exc:
            return None, str(exc)
        if len(week) != len(DAY_KEYS):
            base = _int(found.get("BaseCalendarUID"))
            if base is not None and base >= 0:
                return None, "its week comes from another calendar"
            return None, "its week doesn't list every day"
        out = {"week": week, "exceptions": exceptions, **self.unit_keys}
        for key, name in (("default_start", "DefaultStartTime"),
                          ("default_end", "DefaultFinishTime")):
            match = _CLOCK.fullmatch((self.r.project.get(name) or "").strip())
            if match:
                out[key] = f"{match[1]}:{match[2]}"
        return out, None

    @staticmethod
    def _clock(text: str | None, *, end: bool) -> str:
        match = _CLOCK.fullmatch((text or "").strip())
        if match is None:
            raise ValueError("a working time isn't an HH:MM:SS time")
        clock = f"{match[1]}:{match[2]}"
        return "24:00" if end and clock == "00:00" else clock

    def _hours(self, day: dict) -> list[list[str]]:
        if not _flag_of(day.get("DayWorking")):
            return []
        times = [[self._clock(t.get("FromTime"), end=False), self._clock(t.get("ToTime"), end=True)]
                 for t in day["times"]]
        return times or [list(pair) for pair in _STANDARD_DAY]

    def _add_days(self, exceptions: list[dict], item: dict) -> bool:
        """Add one exception per day of the item's time period; False,
        adding nothing, when that would take the calendar past
        MAX_EXCEPTION_DAYS. The total is checked before a day is built, so
        periods each under the cap never build a list past it together."""
        first, days = self._span(item)
        if len(exceptions) + days > MAX_EXCEPTION_DAYS:
            return False
        name = " ".join((item.get("Name") or "").split()) or None
        exceptions.extend(self._expand(first, days, self._hours(item), name))
        return True

    @staticmethod
    def _span(item: dict) -> tuple[date, int]:
        """The first day of the item's time period, and how many days."""
        try:
            first = parse_time(item.get("FromDate") or "")
            last = parse_time(item.get("ToDate") or "")
        except ValueError:
            raise ValueError("an exception's dates aren't readable") from None
        end = last.date()
        if last.time() == time(0, 0) and last > first:
            end -= _ONE_DAY                 # a period ending at midnight ends the day before
        days = (end - first.date()).days + 1
        if days < 1:
            raise ValueError("an exception ends before it starts")
        return first.date(), days

    @staticmethod
    def _expand(first: date, days: int, hours: list, name: str | None) -> list[dict]:
        return [{"date": (first + timedelta(days=n)).isoformat(), "name": name, "hours": hours}
                for n in range(days)]

