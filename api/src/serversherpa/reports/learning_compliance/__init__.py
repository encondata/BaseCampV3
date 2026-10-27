"""Learning compliance report: who has signed which learning document, one
row per person and required document, for one initiative or for everyone
(every active initiative plus the general set), as an Excel workbook or a
PDF. Seeded as a system definition by migration 0109.

`gather.py` reads the data (through `learning.stats.evaluate`, the same
judgment the dashboard grid shows); `xlsx.py` / `pdf.py` render it."""

import re
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportDefinition, ReportRun
from serversherpa.reports.learning_compliance import gather as gather_mod
from serversherpa.reports.learning_compliance.pdf import render_html, render_pdf
from serversherpa.reports.learning_compliance.xlsx import build_workbook
from serversherpa.reports.move_scan_history.xlsx import XLSX_MIME
from serversherpa.reports.registry import OptionsError, ReportResult
from serversherpa.services.timezone import report_timezone

report_type = "learning_compliance"

# Same set the other reports strip from their filenames.
_FILENAME_UNSAFE_RE = re.compile(r'[\\/:*?"<>|\r\n\t]+')

FORMATS = ("xlsx", "pdf")
_RUN_KEYS = ("initiative_id", "format")


def default_options() -> dict:
    return {"default_format": "xlsx"}


def validate_options(options: dict) -> dict:
    """Definition-level options: only `default_format`. Unknown keys are
    rejected; a missing key defaults in."""
    if not isinstance(options, dict):
        raise OptionsError(["options must be an object"])
    problems = [f"unknown option {k!r}" for k in options if k != "default_format"]
    if "default_format" in options and options["default_format"] not in FORMATS:
        problems.append(f"option 'default_format' must be one of {FORMATS}")
    if problems:
        raise OptionsError(problems)
    return {**default_options(), **options}


def validate_run_options(options: dict) -> dict:
    """Run-level options: `initiative_id` (a uuid; null or empty means
    everyone) and `format`. Only keys the run gives are returned, so "the
    run didn't say" stays distinct from "the run chose the default"."""
    if not isinstance(options, dict):
        raise OptionsError(["options must be an object"])
    problems = [f"unknown option {k!r}" for k in options if k not in _RUN_KEYS]
    out: dict = {}
    raw = options.get("initiative_id")
    if raw is not None and raw != "":
        try:
            out["initiative_id"] = str(uuid.UUID(str(raw)))
        except ValueError:
            problems.append("option 'initiative_id' must be a uuid")
    if "format" in options:
        if options["format"] not in FORMATS:
            problems.append(f"option 'format' must be one of {FORMATS}")
        else:
            out["format"] = options["format"]
    if problems:
        raise OptionsError(problems)
    return out


def parse_run(run: ReportRun, definition_options: dict) -> tuple[uuid.UUID | None, str]:
    """The run's initiative (its own column first, else the option) and
    format (the run's, then the definition's default, then xlsx)."""
    opts = validate_run_options(run.options or {})
    initiative_id = run.initiative_id or (
        uuid.UUID(opts["initiative_id"]) if "initiative_id" in opts else None)
    fmt = (opts.get("format") or (definition_options or {}).get("default_format")
           or default_options()["default_format"])
    return initiative_id, fmt


def _safe(text: str) -> str:
    return _FILENAME_UNSAFE_RE.sub("-", text).strip()


async def build(db: AsyncSession, run: ReportRun) -> ReportResult:
    definition = await db.get(ReportDefinition, run.definition_id)
    initiative_id, fmt = parse_run(run, (definition.options if definition else None) or {})
    data = await gather_mod.gather(db, initiative_id)   # InitiativeUnavailable propagates
    generated_at = datetime.now(UTC)
    local = generated_at.astimezone(report_timezone())
    stem = " - ".join([
        "Learning compliance", _safe(data.initiative_name or "All initiatives"),
        f"{local:%Y-%m-%d %H%M}"])
    if fmt == "xlsx":
        return ReportResult(content=build_workbook(data, generated_at),
                            filename=f"{stem}.xlsx", content_type=XLSX_MIME)
    html = render_html(data, generated_at=generated_at, tracking_id=str(run.id))
    return ReportResult(content=await render_pdf(html), filename=f"{stem}.pdf",
                        content_type="application/pdf")
