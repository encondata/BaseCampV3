"""Timesheet report: hours worked by person and job over a date range, as an
Excel workbook or a PDF, with a day view, every punch and verification flags.
See docs/superpowers/specs/2026-10-06-timesheet-report-design.md.

`gather.py` reads and rolls up the data; `xlsx.py` / `pdf.py` render it."""

import re
import uuid
from datetime import UTC, date, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportDefinition, ReportRun
from serversherpa.reports.move_scan_history.xlsx import XLSX_MIME
from serversherpa.reports.registry import OptionsError, ReportResult

# `gather` stays the submodule on the package (tests and callers import it
# as such); the function is called as gather_mod.gather.
from serversherpa.reports.timesheet import gather as gather_mod
from serversherpa.reports.timesheet.gather import TimesheetFilters
from serversherpa.reports.timesheet.pdf import render_html, render_pdf
from serversherpa.reports.timesheet.xlsx import build_workbook
from serversherpa.services.timezone import report_timezone

report_type = "timesheet"

# Same set Move Report / Move Scan History strip from their filenames.
_FILENAME_UNSAFE_RE = re.compile(r'[\\/:*?"<>|\r\n\t]+')

FORMATS = ("xlsx", "pdf")
VIEWS = ("day", "punch")
STATUSES = ("approved", "pending", "rejected", "open")
MAX_SPAN_DAYS = 366

_DEFINITION_KEYS = ("default_format", "default_views", "default_statuses")
_RUN_KEYS = ("from", "to", "person_id", "site_id", "statuses", "views", "format")


def default_options() -> dict:
    return {"default_format": "xlsx", "default_views": ["day", "punch"],
            "default_statuses": ["approved", "pending"]}


def _subset_problem(options: dict, key: str, allowed: tuple[str, ...]) -> str | None:
    """None when `options[key]` is a non-empty list drawn from `allowed`."""
    value = options[key]
    if not isinstance(value, list) or not value:
        return f"option {key!r} must be a non-empty list"
    if not all(isinstance(v, str) for v in value):
        return f"option {key!r} must be a list of strings"
    bad = [v for v in value if v not in allowed]
    if bad:
        return f"option {key!r} has unknown values {bad}; allowed: {list(allowed)}"
    return None


def _dedupe(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def validate_options(options: dict) -> dict:
    """Definition-level options. Unknown keys are rejected; missing keys
    default in. Returns the normalized dict (every key present)."""
    if not isinstance(options, dict):
        raise OptionsError(["options must be an object"])
    problems = [f"unknown option {k!r}" for k in options if k not in _DEFINITION_KEYS]
    if "default_format" in options and options["default_format"] not in FORMATS:
        problems.append(f"option 'default_format' must be one of {FORMATS}")
    for key, allowed in (("default_views", VIEWS), ("default_statuses", STATUSES)):
        if key in options:
            problem = _subset_problem(options, key, allowed)
            if problem:
                problems.append(problem)
    if problems:
        raise OptionsError(problems)
    out = {**default_options(), **options}
    out["default_views"] = _dedupe(out["default_views"])
    out["default_statuses"] = _dedupe(out["default_statuses"])
    return out


def _parse_day(options: dict, key: str, problems: list[str]) -> date | None:
    value = options.get(key)
    if value is None or value == "":
        problems.append(f"option {key!r} is required (YYYY-MM-DD)")
        return None
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    problems.append(f"option {key!r} must be a date as YYYY-MM-DD")
    return None


def _uuid_option(options: dict, key: str, problems: list[str]) -> str | None:
    value = options.get(key)
    if value is None or value == "":
        return None
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        problems.append(f"option {key!r} must be a uuid")
        return None


def validate_run_options(options: dict) -> dict:
    """Run-level options: `from`, `to` (required), `person_id`, `site_id`,
    `statuses`, `views`, `format`; any other key is a problem. Only keys the
    run actually gives are returned (null / empty filters are dropped);
    nothing is defaulted in — `parse_run` merges the definition's defaults,
    so "the run didn't say" stays distinct from "the run chose the default"."""
    if not isinstance(options, dict):
        raise OptionsError(["options must be an object"])
    problems = [f"unknown option {k!r}" for k in options if k not in _RUN_KEYS]
    from_day = _parse_day(options, "from", problems)
    to_day = _parse_day(options, "to", problems)
    if from_day and to_day:
        if from_day > to_day:
            problems.append("option 'from' must be on or before 'to'")
        elif (to_day - from_day).days + 1 > MAX_SPAN_DAYS:
            problems.append(f"the date range may span at most {MAX_SPAN_DAYS} days")
    out: dict = {}
    if from_day:
        out["from"] = from_day.isoformat()
    if to_day:
        out["to"] = to_day.isoformat()
    for key in ("person_id", "site_id"):
        value = _uuid_option(options, key, problems)
        if value is not None:
            out[key] = value
    for key, allowed in (("statuses", STATUSES), ("views", VIEWS)):
        if key in options:
            problem = _subset_problem(options, key, allowed)
            if problem:
                problems.append(problem)
            else:
                out[key] = _dedupe(options[key])
    if "format" in options and options["format"] not in FORMATS:
        problems.append(f"option 'format' must be one of {FORMATS}")
    elif "format" in options:
        out["format"] = options["format"]
    if problems:
        raise OptionsError(problems)
    return out


def parse_run(run: ReportRun, definition_options: dict
              ) -> tuple[TimesheetFilters, list[str], str]:
    """The run's filters, views and format. A key the run gives wins, then
    the definition's `default_*`, then the module defaults. The job filter is
    the run's own `initiative_id`."""
    opts = validate_run_options(run.options or {})
    base = default_options()
    definition = definition_options or {}
    statuses = opts.get("statuses") or definition.get(
        "default_statuses") or base["default_statuses"]
    views = opts.get("views") or definition.get("default_views") or base["default_views"]
    fmt = opts.get("format") or definition.get("default_format") or base["default_format"]
    filters = TimesheetFilters(
        from_day=date.fromisoformat(opts["from"]),
        to_day=date.fromisoformat(opts["to"]),
        person_id=uuid.UUID(opts["person_id"]) if "person_id" in opts else None,
        initiative_id=run.initiative_id,
        site_id=uuid.UUID(opts["site_id"]) if "site_id" in opts else None,
        statuses=tuple(statuses))
    return filters, list(views), fmt


def _safe(text: str) -> str:
    return _FILENAME_UNSAFE_RE.sub("-", text).strip()


async def build(db: AsyncSession, run: ReportRun) -> ReportResult:
    definition = await db.get(ReportDefinition, run.definition_id)
    filters, views, fmt = parse_run(run, (definition.options if definition else None) or {})
    data = await gather_mod.gather(db, filters, fmt=fmt)   # TimesheetTooLarge propagates to the worker
    generated_at = datetime.now(UTC)

    parts = [f"Timesheet - {filters.from_day.isoformat()} to {filters.to_day.isoformat()}"]
    if filters.person_id is not None:
        parts.append(_safe(data.person_label))
    if filters.initiative_id is not None:
        parts.append(_safe(data.job_label))
    local = generated_at.astimezone(report_timezone())
    parts.append(f"{local:%Y-%m-%d %H%M}")
    stem = " - ".join(p for p in parts if p)

    if fmt == "xlsx":
        return ReportResult(content=build_workbook(data, views, generated_at),
                            filename=f"{stem}.xlsx", content_type=XLSX_MIME)
    html = render_html(data, views, generated_at=generated_at, tracking_id=str(run.id))
    return ReportResult(content=await render_pdf(html), filename=f"{stem}.pdf",
                        content_type="application/pdf")
