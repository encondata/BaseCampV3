"""Move Report — the V2 comprehensive move report, server-side."""

import re
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Person, ReportRun
from serversherpa.reports import rack_renderer
from serversherpa.reports.move_report.gather import gather
from serversherpa.reports.move_report.racks import Renderer, rack_svgs
from serversherpa.reports.move_report.render import (
    build_context, render_html, render_pdf_async,
)
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


async def build(db: AsyncSession, run: ReportRun, *,
                renderer: Renderer = rack_renderer.render) -> ReportResult:
    """gather → compute (inside build_context) → rack SVGs → HTML → PDF."""
    options = validate_options(run.options or {})
    data = await gather(db, run.initiative_id)
    requester = await db.get(Person, run.requested_by)
    generated_by = (f"{requester.first_name} {requester.last_name}".strip()
                    if requester else "ServerSherpa")
    src = await rack_svgs(data.assets, "source", renderer) if options["source_racks"] else []
    dst = (await rack_svgs(data.assets, "destination", renderer)
           if options["destination_racks"] else [])
    now = datetime.now()
    ctx = build_context(data, options, source_racks=src, destination_racks=dst,
                        generated_by=generated_by, generated_at=now)
    pdf = await render_pdf_async(render_html(ctx))
    safe_name = re.sub(r'[\\/:*?"<>|]+', "-", data.name).strip() or "initiative"
    filename = f"Move Report - {safe_name} - {now:%Y-%m-%d %H%M}.pdf"
    return ReportResult(pdf=pdf, filename=filename)
