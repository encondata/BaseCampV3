"""Move Report — the V2 comprehensive move report, server-side."""

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportRun
from serversherpa.reports.registry import OptionsError, ReportResult

report_type = "move_report"

SECTION_KEYS = ("summary", "assets_by_source", "assets_by_destination", "size_weight",
                "rail_usage", "collisions", "source_racks", "destination_racks")


def default_options() -> dict:
    return {k: True for k in SECTION_KEYS}


def validate_options(options: dict) -> dict:
    """Unknown keys and non-bool values are problems; missing keys default
    to True. Returns the normalized dict (every key present)."""
    problems = [f"unknown option {k!r}" for k in options if k not in SECTION_KEYS]
    problems += [f"option {k!r} must be true/false" for k, v in options.items()
                 if k in SECTION_KEYS and not isinstance(v, bool)]
    if problems:
        raise OptionsError(problems)
    return {**default_options(), **options}


async def build(db: AsyncSession, run: ReportRun) -> ReportResult:
    raise NotImplementedError("move_report.build lands in Task 6")
