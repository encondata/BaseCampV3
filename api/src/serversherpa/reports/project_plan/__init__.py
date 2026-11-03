"""Project plan PDF: an initiative's plan as a landscape PDF, a title block,
the task table (the chosen sheet columns) and then the Gantt chart on pages
of its own, tiled across and down. Asked for from the plan's More › Export
▸ PDF… or the Reports page; seeded as a system definition by migration
0110. Every task is printed (or every unfinished one); the sheet's filter
and Group by are not applied.

`gather.py` reads the plan the way the GET plan route does; `gantt.py` is
the portal's Gantt geometry ported (held to shared vectors); `pdf.py`
renders the HTML WeasyPrint prints.

Bounds: the printed range is the plan's own span (custom days are cut to
it) and at most MAX_PRINT_YEARS (the plan's duration bound), checked when
the run is queued (`check_against_plan`, on the days cut to the plan) and again
when it is built. There is no page cap: the HTML and the PDF are made in a
child process killed at the worker's RUN_TIMEOUT_SECONDS, and the options
step shows the page estimate before Generate."""

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportRun
from serversherpa.plans import excel, service
from serversherpa.plans.models import ProjectPlan
from serversherpa.reports.project_plan import gather as gather_mod
from serversherpa.reports.project_plan.gantt import PAPERS, ZOOMS
from serversherpa.reports.project_plan.gather import PrintRangeError
from serversherpa.reports.project_plan.pdf import render_html, render_pdf_in_child
from serversherpa.reports.registry import OptionsError, ReportResult
from serversherpa.services.timezone import report_timezone

__all__ = ["Choices", "PrintRangeError", "build", "check_against_plan", "default_options",
           "parse_options", "render_html", "report_type", "validate_options",
           "validate_run_options"]

report_type = "project_plan"

# Same set the other reports strip from their filenames.
_FILENAME_UNSAFE_RE = re.compile(r'[\\/:*?"<>|\r\n\t]+')
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)

FIT = "fit"
_BOOLEANS = ("include_completed", "show_critical", "show_baseline")
_RUN_KEYS = ("columns", "from", "to", "zoom", "paper", *_BOOLEANS)


def default_options() -> dict:
    """No definition-level options: every choice is the run's."""
    return {}


def validate_options(options: dict) -> dict:
    if not isinstance(options, dict):
        raise OptionsError(["options must be an object"])
    if options:
        raise OptionsError([f"unknown option {k!r}" for k in options])
    return {}


def _day(options: dict, key: str, problems: list[str]) -> date | None:
    value = options.get(key)
    if isinstance(value, str) and _DAY.fullmatch(value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    problems.append(f"option {key!r} must be a date as YYYY-MM-DD")
    return None


def validate_run_options(options: dict) -> dict:
    """A run's choices; any other key is a problem. Only what the run gives
    is returned (normalized), so the defaults stay the module's:

    - `columns`: the sheet's column keys (plans/excel.py, the portal's
      lib/plans/columns.ts); left out, the sheet's default set. ID and Task
      Name are always printed.
    - `from` / `to`: `YYYY-MM-DD`, both or neither; neither is the whole project.
    - `zoom`: one of the portal's zoom ids; left out (or `fit`), the fit for
      the range at one page's chart width.
    - `paper`: `letter` (the default) or `a4`.
    - `include_completed` (default true), `show_critical` and
      `show_baseline` (default false)."""
    if not isinstance(options, dict):
        raise OptionsError(["options must be an object"])
    problems = [f"unknown option {k!r}" for k in options if k not in _RUN_KEYS]
    out: dict = {}

    if "columns" in options:
        columns = options["columns"]
        if (not isinstance(columns, list) or not columns
                or not all(isinstance(c, str) for c in columns)):
            problems.append("option 'columns' must be a non-empty list of column keys")
        elif bad := excel.unknown_columns(columns):
            problems.append(f"option 'columns' has unknown keys {bad}")
        else:
            out["columns"] = list(dict.fromkeys(columns))

    has_from, has_to = options.get("from") is not None, options.get("to") is not None
    if has_from != has_to:
        problems.append("options 'from' and 'to' go together: give both or neither")
    elif has_from:
        first, last = _day(options, "from", problems), _day(options, "to", problems)
        if first and last:
            # the 10-year bound is on what prints, the days cut to the plan
            # (check_against_plan, build), not on the days as asked
            if first > last:
                problems.append("option 'from' must be on or before 'to'")
            else:
                out["from"], out["to"] = first.isoformat(), last.isoformat()

    zoom = options.get("zoom")
    if zoom is not None and zoom != FIT:
        if zoom not in ZOOMS:
            problems.append(f"option 'zoom' must be one of {[FIT, *ZOOMS]}")
        else:
            out["zoom"] = zoom
    if "paper" in options:
        if options["paper"] not in PAPERS:
            problems.append(f"option 'paper' must be one of {list(PAPERS)}")
        else:
            out["paper"] = options["paper"]
    for key in _BOOLEANS:
        if key in options:
            if not isinstance(options[key], bool):
                problems.append(f"option {key!r} must be true or false")
            else:
                out[key] = options[key]
    if problems:
        raise OptionsError(problems)
    return out


@dataclass(frozen=True)
class Choices:
    """A run's options with the defaults in."""
    columns: list[str]                  # the keys printed, ID and Task Name first
    first: str | None                   # YYYY-MM-DD, or None for the whole project
    last: str | None
    zoom: str                           # a zoom id, or "fit"
    paper: str
    include_completed: bool
    show_critical: bool
    show_baseline: bool


def parse_options(options: dict) -> Choices:
    """Validated run options (validate_run_options) with the defaults in."""
    return Choices(
        columns=excel.columns_of(options.get("columns")),
        first=options.get("from"), last=options.get("to"),
        zoom=options.get("zoom", FIT), paper=options.get("paper", "letter"),
        include_completed=options.get("include_completed", True),
        show_critical=options.get("show_critical", False),
        show_baseline=options.get("show_baseline", False))


def _safe(text: str) -> str:
    return _FILENAME_UNSAFE_RE.sub("-", text).strip()


async def check_against_plan(db: AsyncSession, plan: ProjectPlan, options: dict) -> None:
    """create_run's check of validated run options against the plan itself:
    OptionsError when the custom days lie wholly outside the plan's span, or
    what would print (the whole span, or the days cut to it) is over
    MAX_PRINT_YEARS. `build` checks the same again, the plan having perhaps
    changed since."""
    span = gather_mod.span_of(plan, await service.load_state(db, plan))
    try:
        gather_mod.printed_range(span, options.get("from"), options.get("to"))
    except PrintRangeError as exc:
        raise OptionsError([exc.message]) from None


async def build(db: AsyncSession, run: ReportRun) -> ReportResult:
    # read lazily: the worker imports this package (through the registry)
    from serversherpa.reports.worker import RUN_TIMEOUT_SECONDS

    choices = parse_options(validate_run_options(run.options or {}))
    # InitiativeUnavailable / ProjectPlanUnavailable propagate to the worker
    data = await gather_mod.gather(db, run.initiative_id, run.requested_by)
    # PrintRangeError (range_outside_plan / range_too_long) too, before any work
    gather_mod.printed_range(data.span, choices.first, choices.last)
    generated_at = datetime.now(UTC)
    content = await render_pdf_in_child(data, choices, generated_at=generated_at,
                                        tracking_id=str(run.id), timeout=RUN_TIMEOUT_SECONDS)
    local = generated_at.astimezone(report_timezone())
    label = _safe(data.initiative_code or data.initiative_name or "") or "Project"
    return ReportResult(content=content,
                        filename=f"{label} - Project plan - {local:%Y-%m-%d %H%M}.pdf",
                        content_type="application/pdf")
