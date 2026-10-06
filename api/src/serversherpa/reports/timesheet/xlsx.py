"""Timesheet workbook: Summary, By day, Punches (per the chosen views)."""

from datetime import datetime
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Font

from serversherpa.reports.timesheet import fmt
from serversherpa.reports.timesheet.gather import TimesheetData

_BOLD = Font(bold=True)
_TITLE = Font(bold=True, size=14)
_HOURS_FMT = "0.00"
_DATE_FMT = "yyyy-mm-dd"
_MAX_WIDTH = 40

DAY_HEADERS = ["Date", "Person", "Entries", "First in", "Last out", "Worked",
               "Hours", "Status", "Flags"]
PUNCH_HEADERS = ["Date", "Person", "Job", "Site", "Clock in", "Clock out",
                 "Break (min)", "Worked", "Hours", "Status", "Source",
                 "Approved by", "Flags", "Adjust reason", "Notes"]


def _as_text(ws) -> None:
    """Store every string cell as text. openpyxl turns a string starting
    with `=` into a formula, so a note or a name typed as `=HYPERLINK(...)`
    would run when the workbook is opened; forcing the cell type to string
    keeps it inert (and `+`, `-`, `@` openers too)."""
    for row in ws.iter_rows():
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"


def _autofit(ws) -> None:
    for col in ws.columns:
        longest = max((len(str(c.value)) for c in col if c.value is not None),
                      default=0)
        ws.column_dimensions[col[0].column_letter].width = min(longest + 2, _MAX_WIDTH)


def _bold_row(ws, row: int, count: int) -> None:
    for c in range(1, count + 1):
        ws.cell(row=row, column=c).font = _BOLD


def _hours_cells(ws, row: int, columns: list[int]) -> None:
    for c in columns:
        ws.cell(row=row, column=c).number_format = _HOURS_FMT


def _summary(wb: Workbook, data: TimesheetData, generated_at: datetime) -> None:
    ws = wb.active
    ws.title = "Summary"
    f = data.filters
    ws.append([f"Timesheet: {f.from_day.isoformat()} to {f.to_day.isoformat()}"])
    ws["A1"].font = _TITLE
    ws.append([])
    for label, value in (
            ("Person", data.person_label), ("Job", data.job_label),
            ("Site", data.site_label),
            ("Statuses", fmt.status_names(f.statuses)),
            ("Generated", fmt.generated_stamp(generated_at, data.default_tz)),
            ("Time zone", fmt.zone_note(data.default_tz))):
        ws.append([label, value])
        ws.cell(row=ws.max_row, column=1).font = _BOLD
    ws.append([])
    for label, value, is_hours in (
            ("Entries", len(data.entries), False), ("People", data.people, False),
            ("Days", data.day_count, False),
            ("Approved hours", fmt.hours(data.approved_minutes), True),
            ("Pending hours", fmt.hours(data.pending_minutes), True),
            ("Flagged entries", data.flagged_entries, False)):
        ws.append([label, value])
        ws.cell(row=ws.max_row, column=1).font = _BOLD
        if is_hours:
            ws.cell(row=ws.max_row, column=2).number_format = _HOURS_FMT

    ws.append([])
    ws.append(["By person"])
    ws.cell(row=ws.max_row, column=1).font = _TITLE
    ws.append(["Person", "Days", "Entries", "Approved", "Pending", "Total", "Flagged"])
    _bold_row(ws, ws.max_row, 7)
    for p in data.by_person:
        ws.append([p.person_name, p.days, p.entries,
                   fmt.hours(p.approved_minutes), fmt.hours(p.pending_minutes),
                   fmt.hours(p.total_minutes), p.flagged])
        _hours_cells(ws, ws.max_row, [4, 5, 6])

    ws.append([])
    ws.append(["By job"])
    ws.cell(row=ws.max_row, column=1).font = _TITLE
    ws.append(["Job", "People", "Entries", "Approved", "Pending", "Total"])
    _bold_row(ws, ws.max_row, 6)
    for j in data.by_job:
        ws.append([j.job_name, j.people, j.entries, fmt.hours(j.approved_minutes),
                   fmt.hours(j.pending_minutes), fmt.hours(j.total_minutes)])
        _hours_cells(ws, ws.max_row, [4, 5, 6])
    _as_text(ws)
    _autofit(ws)


def _by_day(wb: Workbook, data: TimesheetData) -> None:
    ws = wb.create_sheet("By day")
    ws.append(DAY_HEADERS)
    _bold_row(ws, 1, len(DAY_HEADERS))
    for d in data.days:
        ws.append([d.day, d.person_name, d.entries, fmt.clock(d.first_in),
                   fmt.clock(d.last_out), fmt.worked(d.worked_minutes),
                   fmt.hours(d.worked_minutes), d.status_label, ", ".join(d.flags)])
        ws.cell(row=ws.max_row, column=1).number_format = _DATE_FMT
        _hours_cells(ws, ws.max_row, [7])
    ws.freeze_panes = "A2"
    _as_text(ws)
    _autofit(ws)


def _punches(wb: Workbook, data: TimesheetData) -> None:
    ws = wb.create_sheet("Punches")
    ws.append(PUNCH_HEADERS)
    _bold_row(ws, 1, len(PUNCH_HEADERS))
    for e in data.entries:
        ws.append([e.local_day, e.person_name, e.job_name or "",
                   e.site_name or "", fmt.clock(e.clock_in),
                   fmt.clock(e.clock_out), e.break_minutes,
                   fmt.worked(e.worked_minutes), fmt.hours(e.worked_minutes),
                   fmt.STATUS_LABELS.get(e.status, e.status_label), e.source,
                   e.approved_by_name or "", ", ".join(e.flags),
                   e.adjust_reason or "", e.notes or ""])
        ws.cell(row=ws.max_row, column=1).number_format = _DATE_FMT
        _hours_cells(ws, ws.max_row, [9])
    ws.freeze_panes = "A2"
    _as_text(ws)
    _autofit(ws)


def build_workbook(data: TimesheetData, views: list[str],
                   generated_at: datetime) -> bytes:
    wb = Workbook()
    _summary(wb, data, generated_at)
    if "day" in views:
        _by_day(wb, data)
    if "punch" in views:
        _punches(wb, data)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()
