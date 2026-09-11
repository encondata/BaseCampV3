"""Move Scan History — every asset on a move with the first time it
reached each status, plus the full scan history, as an Excel workbook
or (Task 2) a PDF with a document tracking barcode. Port of V2's
api/reports/scan_history_report.py into V3's reports framework; see
docs/superpowers/specs/2026-09-11-move-scan-history-design.md.
"""

import re
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportDefinition, ReportRun
from serversherpa.reports.move_report.gather import InitiativeUnavailable
from serversherpa.reports.move_scan_history.gather import columns_for, gather
from serversherpa.reports.move_scan_history.xlsx import XLSX_MIME, build_workbook
from serversherpa.reports.registry import OptionsError, ReportResult

report_type = "move_scan_history"

# Same set move_report.build strips from its filename (backslash, slash,
# colon, asterisk, question mark, quote, angle brackets, pipe, plus any
# stray newline/tab).
_FILENAME_UNSAFE_RE = re.compile(r'[\\/:*?"<>|\r\n\t]+')

_FORMAT_VALUES = ("xlsx", "pdf")
_STATUS_COLUMNS_VALUES = ("pipeline", "all")

# No system-wide timezone config exists yet (grepped
# serversherpa/notifications/ and serversherpa/system/config_store.py —
# neither defines a DEFAULT_TIMEZONE constant or a system_config section
# key for it). This mirrors NotificationGroup.timezone's own
# server_default (db/models.py) — the closest thing V3 has today to a
# house-default time zone. Swap this for a real system_config read if one
# is added later.
DEFAULT_TIMEZONE = "America/New_York"


def report_timezone() -> ZoneInfo:
    return ZoneInfo(DEFAULT_TIMEZONE)


def default_options() -> dict:
    return {"default_format": "xlsx", "status_columns": "pipeline"}


def _shape_problems(options: dict, *, format_key: str) -> list[str]:
    known = {format_key, "status_columns"}
    problems = [f"unknown option {k!r}" for k in options if k not in known]
    if format_key in options and options[format_key] not in _FORMAT_VALUES:
        problems.append(f"option {format_key!r} must be one of {_FORMAT_VALUES}")
    if "status_columns" in options and options["status_columns"] not in _STATUS_COLUMNS_VALUES:
        problems.append(f"option 'status_columns' must be one of {_STATUS_COLUMNS_VALUES}")
    return problems


def validate_options(options: dict) -> dict:
    """Definition-level options: `default_format` + `status_columns`.
    Unknown keys are rejected; missing keys default in. Returns the
    normalized dict (every key present) — same contract as Move
    Report's `validate_options`."""
    problems = _shape_problems(options, format_key="default_format")
    if problems:
        raise OptionsError(problems)
    return {**default_options(), **options}


def validate_run_options(options: dict) -> dict:
    """Run-level options: `format` + `status_columns`. Unlike
    `validate_options`, this does NOT fill in missing keys with
    defaults — `build()` fills a key missing from the run from the
    definition's own saved option instead, so only the keys actually
    present on the run are shape/domain-checked here and returned
    unchanged."""
    problems = _shape_problems(options, format_key="format")
    if problems:
        raise OptionsError(problems)
    return dict(options)


async def build(db: AsyncSession, run: ReportRun) -> ReportResult:
    """gather -> columns_for(mode) -> xlsx bytes (pdf: Task 2)."""
    if run.initiative_id is None:
        # Every other report type but Site & Move Survey requires an
        # initiative — routes.create_run already enforces this
        # (`initiative_required`), so this is belt-and-braces should
        # `build()` ever be called directly (e.g. a future retry path).
        raise InitiativeUnavailable("move_scan_history requires an initiative")

    definition = await db.get(ReportDefinition, run.definition_id)
    def_options = (definition.options if definition else None) or {}
    run_options = run.options or {}

    fmt = run_options.get("format", def_options.get("default_format", "xlsx"))
    status_columns = run_options.get(
        "status_columns", def_options.get("status_columns", "pipeline"))

    data = await gather(db, run.initiative_id)
    columns = columns_for(data, status_columns)
    generated_at = datetime.now(UTC)
    safe_name = _FILENAME_UNSAFE_RE.sub("-", data.name).strip() or "initiative"

    if fmt == "xlsx":
        content = build_workbook(data, columns, generated_at, report_timezone())
        local = generated_at.astimezone(report_timezone())
        filename = f"Move Scan History - {safe_name} - {local:%Y-%m-%d %H%M}.xlsx"
        return ReportResult(content=content, filename=filename, content_type=XLSX_MIME)
    if fmt == "pdf":
        raise NotImplementedError("pdf: Task 2")
    raise OptionsError([f"option 'format' must be one of {_FORMAT_VALUES}"])
