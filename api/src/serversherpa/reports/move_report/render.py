"""Step 4 of the Move Report: Jinja2 → HTML → WeasyPrint → PDF bytes."""

import asyncio
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

from serversherpa.reports.move_report.compute import (
    CollisionReport, LoadSummary, RailSummary, collisions, load_summary, rail_summary,
    sorted_by_side,
)
from serversherpa.reports.move_report.gather import MoveAsset, MoveData
from serversherpa.reports.move_report.racks import RackSvg

_ENV = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"),
                   autoescape=select_autoescape(["html"]), trim_blocks=True, lstrip_blocks=True)


def _css_string(value: str) -> Markup:
    """Escape a value for a CSS string literal (`@page` margin-box `content`).

    `<style>` is raw text, so HTML autoescaping there is wrong twice over: the
    entities print literally (`Acme &amp; Co`) and `&`/`<` never needed escaping
    in the first place. Escape for CSS instead, and mark the result safe so
    autoescape leaves it alone. `<` and `>` still get CSS escapes so the value
    can never close the `<style>` element.
    """
    out = str(value).replace("\r\n", "\n").replace("\\", "\\\\").replace('"', '\\"')
    for char, esc in (("<", "\\3C "), (">", "\\3E "), ("&", "\\26 "),
                      ("\n", "\\A "), ("\r", "\\A ")):
        out = out.replace(char, esc)
    return Markup(out)


# Public alias — other report modules (move_scan_history/pdf.py) reuse this
# filter for their own `@page` margin-box content and shouldn't have to
# reach across packages for an underscore-prefixed name.
css_string = _css_string

_ENV.filters["cssstr"] = _css_string

COLLISION_LABELS = {"ru_overlap": "RU overlap", "slot_conflict": "Slot conflict"}
ORPHAN_LABELS = {"no_chassis": "No device starts at this RU",
                 "form_factor_mismatch": "Model form factor does not match its position"}


@dataclass
class ReportContext:
    data: MoveData
    options: dict
    load: LoadSummary
    rails: RailSummary
    collisions: CollisionReport
    by_source: list[MoveAsset]
    by_destination: list[MoveAsset]
    source_racks: list[RackSvg]
    destination_racks: list[RackSvg]
    generated_by: str
    generated_at: datetime

    @property
    def title(self) -> str:
        return f"Move Report — {self.data.name}"

    @property
    def generated_stamp(self) -> str:
        return self.generated_at.strftime("%Y-%m-%d %H:%M")

    @property
    def scheduled(self) -> str:
        fmt = lambda d: d.strftime("%Y-%m-%d") if d else None            # noqa: E731
        start, end = fmt(self.data.scheduled_start), fmt(self.data.scheduled_end)
        return f"{start} → {end}" if start and end else (start or end or "—")

    @staticmethod
    def ru(value: float | None) -> str:
        if value is None:
            return "—"
        return str(int(value)) if float(value).is_integer() else f"{value:g}"

    @staticmethod
    def collision_label(kind: str) -> str:
        return COLLISION_LABELS.get(kind, kind)

    def orphan_label(self, reason: str) -> str:
        return ORPHAN_LABELS.get(reason, reason)


def build_context(data: MoveData, options: dict, *, source_racks: list[RackSvg],
                  destination_racks: list[RackSvg], generated_by: str,
                  generated_at: datetime) -> ReportContext:
    """Sections that are off are skipped at compute time (empty results),
    not merely hidden in the template."""
    empty_load = LoadSummary(0, 0, 0.0, 0.0, [])
    need_load = options.get("summary") or options.get("size_weight")
    need_coll = options.get("summary") or options.get("collisions")
    return ReportContext(
        data=data, options=options,
        load=load_summary(data.assets) if need_load else empty_load,
        rails=rail_summary(data.assets) if options.get("rail_usage") else RailSummary(0, [], []),
        collisions=collisions(data.assets) if need_coll else CollisionReport(),
        by_source=sorted_by_side(data.assets, "source") if options.get("assets_by_source") else [],
        by_destination=(sorted_by_side(data.assets, "destination")
                        if options.get("assets_by_destination") else []),
        source_racks=source_racks if options.get("source_racks") else [],
        destination_racks=destination_racks if options.get("destination_racks") else [],
        generated_by=generated_by, generated_at=generated_at)


def render_html(ctx: ReportContext) -> str:
    return _ENV.get_template("move_report.html").render(ctx=ctx)


def _pdf(html: str) -> bytes:
    from weasyprint import HTML            # slow import; keep it off module load
    return HTML(string=html).write_pdf()


async def render_pdf_async(html: str) -> bytes:
    return await asyncio.to_thread(_pdf, html)


def render_pdf(html: str) -> bytes:
    return _pdf(html)
