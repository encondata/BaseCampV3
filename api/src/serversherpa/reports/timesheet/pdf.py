"""Timesheet PDF: gathered data -> Jinja2 HTML -> WeasyPrint, with the Move
Scan History footer (Page N of M, generated stamp + tracking id, PDF417)."""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from serversherpa.reports.move_report.render import css_string, render_pdf_async
from serversherpa.reports.move_scan_history.barcode import pdf417_data_uri
from serversherpa.reports.timesheet import fmt
from serversherpa.reports.timesheet.gather import TimesheetData

_ENV = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"),
                   autoescape=select_autoescape(["html"]), trim_blocks=True,
                   lstrip_blocks=True)
_ENV.filters["cssstr"] = css_string

# Generic over the HTML it is given — reused as Move Scan History does.
render_pdf = render_pdf_async

# Status chip colors keyed by the label gather puts on a day/entry.
_CHIP = {"Approved": "approved", "Pending": "pending", "Rejected": "rejected",
         "On the clock": "open", "Mixed": "mixed"}


@dataclass
class _Chip:
    label: str
    css: str


def _status(label: str) -> _Chip:
    return _Chip(label, _CHIP.get(label, "mixed"))


def render_html(data: TimesheetData, views: list[str], *, generated_at: datetime,
                tracking_id: str) -> str:
    f = data.filters
    person_rows = [{
        "name": p.person_name, "days": p.days, "entries": p.entries,
        "approved": fmt.worked(p.approved_minutes),
        "pending": fmt.worked(p.pending_minutes),
        "total": fmt.worked(p.total_minutes), "flagged": p.flagged,
    } for p in data.by_person]
    job_rows = [{
        "name": j.job_name, "people": j.people, "entries": j.entries,
        "approved": fmt.worked(j.approved_minutes),
        "pending": fmt.worked(j.pending_minutes),
        "total": fmt.worked(j.total_minutes),
    } for j in data.by_job]
    day_rows = [{
        "date": d.day.isoformat(), "person": d.person_name, "entries": d.entries,
        "first_in": fmt.clock(d.first_in), "last_out": fmt.clock(d.last_out),
        "worked": fmt.worked(d.worked_minutes), "status": _status(d.status_label),
        "flags": d.flags,
    } for d in data.days]
    punch_rows = []
    for e in data.entries:
        notes = []
        if e.adjust_reason:
            notes.append(f"Adjusted: {e.adjust_reason}")
        if e.notes:
            notes.append(e.notes)
        punch_rows.append({
            "date": e.local_day.isoformat(), "person": e.person_name,
            "job": e.job_name or "", "site": e.site_name or "",
            "clock_in": fmt.clock(e.clock_in), "clock_out": fmt.clock(e.clock_out),
            "break_minutes": e.break_minutes, "worked": fmt.worked(e.worked_minutes),
            "status": _status(fmt.STATUS_LABELS.get(e.status, e.status_label)),
            "source": e.source, "approved_by": e.approved_by_name or "",
            "flags": e.flags, "notes": notes,
        })
    tiles = [
        ("Entries", str(len(data.entries))), ("People", str(data.people)),
        ("Days", str(data.day_count)),
        ("Approved", fmt.worked(data.approved_minutes)),
        ("Pending", fmt.worked(data.pending_minutes)),
        ("Flagged", str(data.flagged_entries)),
    ]
    return _ENV.get_template("timesheet.html").render(
        title=f"Timesheet: {f.from_day.isoformat()} to {f.to_day.isoformat()}",
        person_label=data.person_label, job_label=data.job_label,
        site_label=data.site_label, statuses=fmt.status_names(f.statuses),
        zone_note=fmt.zone_note(data.default_tz), tiles=tiles,
        by_person=person_rows, by_job=job_rows,
        show_by_job=f.initiative_id is None,
        show_day="day" in views, show_punch="punch" in views,
        days=day_rows, punches=punch_rows,
        stamp=fmt.generated_stamp(generated_at, data.default_tz),
        tracking_id=tracking_id, barcode_data_uri=pdf417_data_uri(tracking_id))
