"""Project plan PDF: the gathered plan -> Jinja2 HTML -> WeasyPrint.

Landscape Letter or A4. Page one opens with the title block, then the task
table (the chosen sheet columns, its header repeated on every page, names
indented by outline level, summaries bold). The Gantt chart starts on a
page of its own: each page is a names column (ID and Task Name) beside one
tile of the chart under the two-tier timescale, tiled left to right and
then top to bottom (gantt.py's page geometry, the same the options step's
estimate uses). A tile is an SVG whose viewBox is its window onto the full
chart, so a bar or a link that crosses its edge is cut there, not dropped.
Every tile is the chart's full width, so the last one reaches past the
printed range; its timescale and grid run on to its right edge (`_drawn`),
and a deadline past that edge draws nothing.
The footer is Move Scan History's: Page N of M, the generated stamp and
the tracking id, and the PDF417 barcode.

Drawn as the portal draws the Gantt (components/plans/PlanGantt.tsx,
styles/plans.css), in its light theme and default accent: a bar with the
part done filled in, a summary's bracket, a milestone's diamond and date,
a task's own color (lightness capped as the portal caps it), red for a
critical task under Show critical path with its color kept as a stripe
along the top, the baseline in gray, a deadline's green arrow, the today
and status-date lines, nonworking days shaded at the hours, days and weeks
zooms, and the link paths with their arrowheads.

Safety: Jinja autoescapes every text; SVG is built with Markup.format,
which escapes each value; text reaches the CSS margin boxes only through
`cssstr`; WeasyPrint gets a fetcher that refuses everything but data:
URIs (the barcode)."""

import asyncio
import bisect
import dataclasses
import itertools
import multiprocessing
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

from serversherpa.plans import excel
from serversherpa.plans.schemas import PlanTaskOut
from serversherpa.reports.move_report.render import css_string
from serversherpa.reports.move_scan_history.barcode import pdf417_data_uri
from serversherpa.reports.project_plan import gantt
from serversherpa.reports.project_plan.gantt import ROW_PX, TIER_PX
from serversherpa.reports.project_plan.gather import PlanData, printed_range
from serversherpa.services.timezone import report_timezone

_ENV = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"),
                   autoescape=select_autoescape(["html"]), trim_blocks=True,
                   lstrip_blocks=True)
_ENV.filters["cssstr"] = css_string


def data_fetcher():
    """A WeasyPrint URL fetcher that fetches data: URIs and refuses every
    other scheme (http, https, file, ftp...). A fresh one per render: the
    fetcher keeps per-request state."""
    from weasyprint.urls import URLFetcher  # slow import; keep it off module load
    return URLFetcher(allowed_protocols=("data",))


# ── the portal's light theme (styles/portal-theme.css, directory.css) ─

ACCENT = "#ffa12e"
RED = "#c03540"
DARK = "#1b2129"
MUTE = "#667085"
BLUE = "#1668a7"
VIOLET = "#6d4fc4"
GREEN = "#178a4c"
LANE = "#ffffff"
GRID = "#e4e8ee"
ROW_RULE = "#eef0f3"
SCALE_BG = "#f4f6f8"
SCALE_RULE = "#d5dae1"
FONT = "Helvetica, Arial, sans-serif"

INDENT_PX = 12          # per outline level, in the table and the names column
CELL_PAD_PX = 6         # the table's cell padding, left
NAMES_INDENT_PAD = 2
# the chart's labels (resource names, milestone dates, the timescale): 7 pt
# (28/3 px), in the darker muted text so they hold up in print
LABEL_PX = 9.33
LABEL_INK = "#475467"
CHAR_PX = 4.6           # a character of 8px Helvetica (scaled by size), to place labels


# ── a task's own color: lightness as the portal caps it on the light theme ─


def _to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _from_linear(c: float) -> float:
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def _oklab(hex_color: str) -> tuple[float, float, float]:
    r, g, b = (_to_linear(int(hex_color[i:i + 2], 16) / 255) for i in (1, 3, 5))
    lo = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    mi = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    sh = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (0.2104542553 * lo + 0.7936177850 * mi - 0.0040720468 * sh,
            1.9779984951 * lo - 2.4285922050 * mi + 0.4505937099 * sh,
            0.0259040371 * lo + 0.7827717662 * mi - 0.8086757660 * sh)


def _from_oklab(lightness: float, a: float, b: float) -> str:
    lo = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    mi = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    sh = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
    rgb = (4.0767416621 * lo - 3.3077115913 * mi + 0.2309699292 * sh,
           -1.2684380046 * lo + 2.6097574011 * mi - 0.3413193965 * sh,
           -0.0041960863 * lo - 0.7034186147 * mi + 1.7076147010 * sh)
    return "#" + "".join(f"{round(min(1, max(0, _from_linear(c))) * 255):02x}" for c in rgb)


def task_hue(color: str) -> str:
    """The portal's --pln-hue on the light theme: the color with its
    oklch lightness capped at 0.60 (a pale pick still shows on a white
    lane); every palette color is under the cap and stays as picked."""
    lightness, a, b = _oklab(color)
    return color if lightness <= 0.60 else _from_oklab(0.60, a, b)


def task_deep(color: str) -> str:
    """--pln-hue-deep: the part done, at 0.72 of the capped lightness."""
    lightness, a, b = _oklab(color)
    return _from_oklab(min(lightness, 0.60) * 0.72, a, b)


# ── text as the sheet shows it ───────────────────────────────────────

_WEEKDAYS = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def sheet_day(moment: datetime | None, show_times: bool = False) -> str:
    """`Mon 11/2/26`, or `Mon 11/2/26 8:00 AM` when the plan shows times."""
    if moment is None:
        return ""
    text = (f"{_WEEKDAYS[moment.isoweekday() % 7]} {moment.month}/{moment.day}/"
            f"{moment.year % 100:02d}")
    if show_times:
        hour = moment.hour
        text += f" {hour % 12 or 12}:{moment.minute:02d} {'AM' if hour < 12 else 'PM'}"
    return text


def _floating(text: str | None) -> datetime | None:
    ms = gantt.to_ms(text) if text else None
    return gantt.moment_of(ms) if ms is not None else None


def _long_day(moment: datetime) -> str:
    return f"{_MONTHS[moment.month - 1]} {moment.day}, {moment.year}"


def day_span(first: datetime, last: datetime) -> str:
    """`Nov 2–16, 2026`, `Nov 30 – Dec 14, 2026`, `Dec 28, 2026 – Jan 11, 2027`."""
    if first.date() == last.date():
        return _long_day(first)
    if first.year != last.year:
        return f"{_long_day(first)} – {_long_day(last)}"
    if first.month != last.month:
        return f"{_MONTHS[first.month - 1]} {first.day} – {_long_day(last)}"
    return f"{_MONTHS[first.month - 1]} {first.day}–{last.day}, {last.year}"


def _instant_day(moment: datetime | None) -> str:
    return _long_day(moment.astimezone(report_timezone())) if moment else ""


# the table: right-aligned columns and their share of the width
_RIGHT = frozenset({"id", "duration", "percent", "slack", "baseline_duration",
                    "start_variance", "finish_variance"})
# short values kept on one line (cut with an ellipsis in a narrow column), so
# a row is one line unless a name, a resource list or a note wraps
_ONE_LINE = frozenset({"id", "mode", "duration", "percent", "wbs", "slack", "critical",
                       "status", "baseline_duration", "start_variance", "finish_variance",
                       "color", *excel.DATE_COLUMNS})
_WEIGHTS = {"id": 0.45, "mode": 1.35, "name": 3.2, "duration": 0.8, "predecessors": 1.1,
            "successors": 1.1, "resources": 1.8, "percent": 1.05, "wbs": 0.6,
            "slack": 0.85, "critical": 0.6, "status": 0.9, "constraint_type": 1.3,
            "baseline_duration": 0.9, "start_variance": 0.85, "finish_variance": 0.85,
            "notes": 3.0, "color": 0.8}
_DATE_WEIGHT = 1.1
_DATETIME_WEIGHT = 1.6


def _cell_text(key: str, task: PlanTaskOut, data: PlanData, zone: ZoneInfo) -> str:
    if key == "percent":
        return f"{task.percent_complete}%"
    value = excel.cell_value(key, task, data.times[task.id], data.units, zone)
    if value is None:
        return ""
    if isinstance(value, datetime):
        return sheet_day(value, data.show_times)
    return str(value)


def _table(data: PlanData, tasks: list[PlanTaskOut], columns: list[str]) -> dict:
    zone = ZoneInfo(data.timezone)

    def weight(key: str) -> float:
        if key in excel.DATE_COLUMNS:
            return _DATETIME_WEIGHT if data.show_times else _DATE_WEIGHT
        return _WEIGHTS.get(key, 1.0)

    total = sum(weight(k) for k in columns)
    heads = [{"label": excel.COLUMNS[k], "cls": "num" if k in _RIGHT else "",
              "width": round(100 * weight(k) / total, 2)} for k in columns]
    rows = []
    for task in tasks:
        cells = []
        for key in columns:
            text = _cell_text(key, task, data, zone)
            cls = " ".join(c for c, on in (("num", key in _RIGHT), ("nw", key in _ONE_LINE)) if on)
            cells.append({"key": key, "text": text, "cls": cls,
                          "swatch": text if key == "color" and text else None})
        rows.append({"id": task.display_id, "summary": task.is_summary, "cells": cells,
                     "indent": CELL_PAD_PX + INDENT_PX * (max(task.outline_level, 1) - 1)})
    return {"heads": heads, "rows": rows}


# ── SVG pieces (every value through Markup.format: escaped) ───────────


def _n(value: float) -> str:
    return gantt.fmt_number(round(value, 2))


def _rect(cls: str, task_id: str | None, x: float, y: float, w: float, h: float, fill: str,
          *, opacity: float | None = None, stroke: str | None = None, rx: float = 0) -> Markup:
    attrs = Markup(' data-task="{}"').format(task_id) if task_id else Markup("")
    extra = Markup("")
    if opacity is not None:
        extra += Markup(' fill-opacity="{}"').format(opacity)
    if stroke:
        extra += Markup(' stroke="{}" stroke-width="1"').format(stroke)
    if rx:
        extra += Markup(' rx="{}"').format(_n(rx))
    return Markup('<rect class="{}"{} x="{}" y="{}" width="{}" height="{}" fill="{}"{}/>').format(
        cls, attrs, _n(x), _n(y), _n(w), _n(h), fill, extra)


def _polygon(cls: str, task_id: str | None, points: list[tuple[float, float]], fill: str,
             *, opacity: float | None = None) -> Markup:
    attrs = Markup(' data-task="{}"').format(task_id) if task_id else Markup("")
    pts = " ".join(f"{_n(x)},{_n(y)}" for x, y in points)
    extra = Markup(' fill-opacity="{}"').format(opacity) if opacity is not None else Markup("")
    return Markup('<polygon class="{}"{} points="{}" fill="{}"{}/>').format(
        cls, attrs, pts, fill, extra)


def _text(x: float, y: float, text: str, *, size: float = LABEL_PX, fill: str = LABEL_INK,
          anchor: str = "start", weight: str = "normal") -> Markup:
    return Markup('<text x="{}" y="{}" font-family="{}" font-size="{}" font-weight="{}" '
                  'fill="{}" text-anchor="{}">{}</text>').format(
        _n(x), _n(y), FONT, size, weight, fill, anchor, text)


def _diamond(cx: float, cy: float, half: float) -> list[tuple[float, float]]:
    return [(cx, cy - half), (cx + half, cy), (cx, cy + half), (cx - half, cy)]


@dataclass
class _Marks:
    """One row's marks in full-chart coordinates and how far they reach."""
    row: int
    markup: Markup
    x_lo: float
    x_hi: float


@dataclass
class _Link:
    markup: Markup
    x_lo: float
    x_hi: float
    y_lo: float
    y_hi: float


DEADLINE_HALF = 5
BASE_MARK_HALF = 4
NAMES_GAP = 6
SUMMARY_CAP = 5
STRIPE_PX = 3


def _short_day(text: str | None) -> str:
    moment = _floating(text)
    return f"{moment.month}/{moment.day}" if moment else ""


def _task_marks(task: PlanTaskOut, row: int, scale: gantt.Scale, box: gantt.BarBox,
                show_critical: bool, show_baseline: bool) -> _Marks | None:
    """A task's marks on `scale`, the drawn chart (`_drawn`): a deadline
    off either end of it draws nothing, like a task outside the range."""
    y = row * ROW_PX
    tid = str(task.id)
    parts: list[Markup] = []
    xs: list[float] = []
    critical = show_critical and task.is_critical and not task.is_summary
    hue = task_hue(task.color) if task.color else None
    tinted = hue is not None and not critical
    label_x: float | None = None
    label = ", ".join(a.name for a in task.assignees)

    if show_baseline:
        base = gantt.baseline_of(scale, task.baseline_start, task.baseline_finish)
        if base and task.is_milestone:
            cy = y + box.base_top + box.base_height / 2
            parts.append(_polygon("baseline", tid, _diamond(base.x, cy, BASE_MARK_HALF), MUTE,
                                  opacity=0.65))
            xs += [base.x - BASE_MARK_HALF, base.x + BASE_MARK_HALF]
        elif base:
            parts.append(_rect("baseline", tid, base.x, y + box.base_top, max(base.width, 1),
                               box.base_height, MUTE, opacity=0.65, rx=1.5))
            xs += [base.x, base.x + base.width]

    bar = gantt.bar_of(scale, task.start, task.finish, task.is_milestone)
    if bar and task.is_milestone:
        cy = y + box.mid
        fill = RED if critical else (hue if tinted else DARK)
        cls = "milestone" + (" critical" if critical else "") + (" tinted" if tinted else "")
        parts.append(_polygon(cls, tid, _diamond(bar.x, cy, gantt.MILESTONE_HALF), fill))
        if hue and critical:
            top = cy - gantt.MILESTONE_HALF
            parts.append(_polygon("hue", tid, [(bar.x, top), (bar.x + 5, top + 5),
                                               (bar.x - 5, top + 5)], hue))
        xs += [bar.x - gantt.MILESTONE_HALF, bar.x + gantt.MILESTONE_HALF]
        label_x = bar.x + gantt.MILESTONE_HALF + NAMES_GAP
        label = " ".join(p for p in (_short_day(task.start or task.finish), label) if p)
    elif bar:
        width = max(bar.width, 2)
        done = min(gantt.progress_width(bar.width, task.percent_complete), width)
        if task.is_summary:
            fill = hue if tinted else DARK
            top, height = y + box.top, box.summary_height
            parts.append(_rect("summary" + (" tinted" if tinted else ""), tid, bar.x, top,
                               width, height, fill))
            cap = top + height
            parts.append(_polygon("cap", None, [(bar.x, cap), (bar.x + SUMMARY_CAP, cap),
                                                (bar.x, cap + SUMMARY_CAP)], fill))
            parts.append(_polygon("cap", None, [(bar.x + width - SUMMARY_CAP, cap),
                                                (bar.x + width, cap),
                                                (bar.x + width, cap + SUMMARY_CAP)], fill))
            if done > 0:
                parts.append(_rect("done", None, bar.x, top, done, height, ACCENT, opacity=0.9))
        else:
            edge = RED if critical else (hue if tinted else ACCENT)
            top, height = y + box.top, box.height
            cls = "bar" + (" critical" if critical else "") + (" tinted" if tinted else "")
            parts.append(_rect(cls, tid, bar.x, top, width, height, edge,
                               opacity=0.38 if critical else 0.42, stroke=edge, rx=3))
            if done > 0:
                full = RED if critical else (task_deep(task.color) if tinted else ACCENT)
                parts.append(_rect("done", None, bar.x, top, done, height, full, rx=3))
            if hue and critical:
                parts.append(_rect("hue", tid, bar.x, top, width, STRIPE_PX, hue))
                parts.append(_rect("hue-rule", None, bar.x, top + STRIPE_PX, width, 1, LANE))
        xs += [bar.x, bar.x + width]
        label_x = bar.x + width + NAMES_GAP

    if task.deadline:
        at = gantt.to_ms(task.deadline)
        x = gantt.x_of_ms(scale, at) if at is not None else None
        if x is not None and 0 <= x <= scale.width:
            height = box.height + 4
            parts.append(Markup(
                '<path class="deadline" d="M3.5 0h3v7.5H10L5 14 0 7.5h3.5z" fill="{}" '
                'transform="translate({} {}) scale(1 {})"/>').format(
                GREEN, _n(x - DEADLINE_HALF), _n(y + box.top - 2), _n(height / 14)))
            xs += [x - DEADLINE_HALF, x + DEADLINE_HALF]

    if label and label_x is not None:
        parts.append(_text(label_x, y + box.mid + 3.3, label))
        xs += [label_x, label_x + len(label) * CHAR_PX * LABEL_PX / 8]
    if not parts:
        return None
    return _Marks(row=row, markup=Markup("").join(parts), x_lo=min(xs), x_hi=max(xs))


def _runs(d: str) -> int:
    return d.count("H") + d.count("V")


def _shape_into(a: gantt.LinkEnd, to: gantt.Bar, milestone: bool, y: float, kind: str,
                stub: float, bar_half: float) -> gantt.LinkShape | None:
    """PlanGantt's shapeInto: a milestone is met at its tip, or from above
    or below when that saves a detour; a bar at its edge."""
    edge = gantt.link_shape(a, gantt.link_end(to, milestone, y), kind, ROW_PX, stub=stub,
                            to_half=0 if milestone else bar_half)
    if not milestone:
        return edge
    center = gantt.link_shape(a, gantt.LinkEnd(to.x, to.x, y), kind, ROW_PX, stub=stub,
                              to_half=gantt.MILESTONE_HALF)
    if edge is None:
        return center
    if center is None or center.dir not in ("up", "down"):
        return edge
    return center if _runs(center.d) < _runs(edge.d) else edge


def _links(data: PlanData, tasks: list[PlanTaskOut], scale: gantt.Scale, box: gantt.BarBox,
           zoom: str, show_critical: bool) -> list[_Link]:
    rows = {t.id: i for i, t in enumerate(tasks)}
    by_id = {t.id: t for t in tasks}
    stub = gantt.link_stub(zoom)
    out = []
    for link in data.links:
        pred, succ = by_id.get(link.predecessor_id), by_id.get(link.successor_id)
        if pred is None or succ is None:
            continue                       # an end not printed (a finished task left out)
        a = gantt.bar_of(scale, pred.start, pred.finish, pred.is_milestone)
        b = gantt.bar_of(scale, succ.start, succ.finish, succ.is_milestone)
        if a is None or b is None:
            continue
        ya = rows[pred.id] * ROW_PX + box.mid
        yb = rows[succ.id] * ROW_PX + box.mid
        shape = _shape_into(gantt.link_end(a, pred.is_milestone, ya), b, succ.is_milestone, yb,
                            link.link_type, stub, box.height / 2)
        if shape is None:
            continue
        critical = show_critical and pred.is_critical and succ.is_critical
        color = RED if critical else MUTE
        cls = "link critical" if critical else "link"
        markup = Markup(
            '<path class="{}" d="{}" fill="none" stroke="{}" stroke-opacity="0.9" '
            'stroke-width="1.25"/><polygon class="{}-head" points="{}" fill="{}"/>').format(
            cls, shape.d, color, cls, shape.head, color)
        points = gantt.points_of(shape.d) + [shape.tip]
        out.append(_Link(markup, min(p[0] for p in points) - 4, max(p[0] for p in points) + 4,
                         min(p[1] for p in points) - 4, max(p[1] for p in points) + 4))
    return out


def _scale_svg(scale: gantt.Scale, zoom: str, x0: float, width: float) -> Markup:
    """A tile's two-tier timescale: its window onto the full scale."""
    ticks = gantt.tiers(scale, zoom, (x0, x0 + width))
    x1 = x0 + width
    parts = [_rect("scale-bg", None, x0, 0, width, 2 * TIER_PX, SCALE_BG)]
    for tier, (top, size, weight, fill, centered) in enumerate((
            (0, LABEL_PX, "bold", DARK, False), (TIER_PX, LABEL_PX, "normal", LABEL_INK, True))):
        for t in (ticks.top if tier == 0 else ticks.bottom):
            parts.append(Markup('<path d="M {} {} V {}" stroke="{}" stroke-width="0.75"/>').format(
                _n(t.x), _n(top), _n(top + TIER_PX), SCALE_RULE))
            left, right = max(t.x, x0), min(t.x + t.width, x1)
            need = len(t.label) * CHAR_PX * size / 8 + 6
            if right - left < need:
                continue                   # too little of the unit on this tile for its label
            if centered:
                parts.append(_text((left + right) / 2, top + 12.5, t.label, size=size,
                                   fill=fill, anchor="middle", weight=weight))
            else:
                parts.append(_text(left + 4, top + 12.5, t.label, size=size, fill=fill,
                                   weight=weight))
    for y in (TIER_PX, 2 * TIER_PX - 0.5):
        parts.append(Markup('<path d="M {} {} H {}" stroke="{}" stroke-width="0.75"/>').format(
            _n(x0), _n(y), _n(x1), SCALE_RULE))
    svg = Markup('<svg class="gscale" width="{}" height="{}" viewBox="{} 0 {} {}">{}</svg>')
    return svg.format(_n(width), 2 * TIER_PX, _n(x0), _n(width), 2 * TIER_PX,
                      Markup("").join(parts))


@dataclass
class _Chart:
    """Everything drawn once over the full chart, then cut into tiles."""
    scale: gantt.Scale
    zoom: str
    marks: list[_Marks]
    links: list[_Link]
    bands: list[gantt.Band]             # in x order
    top_ticks: list[gantt.Tick]         # in x order
    today: float | None
    status: float | None

    def __post_init__(self) -> None:
        self.band_ends = [b.x + b.width for b in self.bands]
        self.tick_xs = [t.x for t in self.top_ticks]


def _chart_svg(chart: _Chart, x0: float, width: float, r0: int, r1: int) -> Markup:
    """One tile: the rows r0..r1 (chart.marks and chart.links already cut
    to that band) seen through the window x0..x0+width."""
    x1 = x0 + width
    rows = max(1, r1 - r0)
    y0, height = r0 * ROW_PX, rows * ROW_PX
    y1 = y0 + height
    parts = [_rect("lane", None, x0, y0, width, height, LANE)]
    # the bands and ticks are in x order: start at the first one reaching the
    # tile and stop past it, so a tile looks at its own few, not all of them
    for band in itertools.takewhile(lambda b: b.x < x1, chart.bands[
            bisect.bisect_right(chart.band_ends, x0):]):
        parts.append(_rect("offday", None, band.x, y0, band.width, height, MUTE, opacity=0.10))
    for t in itertools.takewhile(lambda t: t.x < x1, chart.top_ticks[
            bisect.bisect_right(chart.tick_xs, x0):]):
        parts.append(Markup('<path d="M {} {} V {}" stroke="{}" stroke-width="0.75"/>').format(
            _n(t.x), _n(y0), _n(y1), GRID))
    rules = " ".join(f"M {_n(x0)} {_n((i + 1) * ROW_PX - 0.5)} H {_n(x1)}" for i in range(r0, r1))
    if rules:
        parts.append(Markup('<path d="{}" stroke="{}" stroke-width="1"/>').format(rules, ROW_RULE))
    if chart.today is not None and x0 <= chart.today <= x1:
        parts.append(Markup('<path class="today" d="M {} {} V {}" stroke="{}" '
                            'stroke-width="1.5"/>').format(_n(chart.today), _n(y0), _n(y1), BLUE))
    if chart.status is not None and x0 <= chart.status <= x1:
        parts.append(Markup('<path class="status-date" d="M {} {} V {}" stroke="{}" '
                            'stroke-width="1.5" stroke-dasharray="4 3"/>').format(
            _n(chart.status), _n(y0), _n(y1), VIOLET))
    for link in chart.links:
        if link.x_lo < x1 and link.x_hi > x0 and link.y_lo < y1 and link.y_hi > y0:
            parts.append(link.markup)
    for marks in chart.marks:
        if r0 <= marks.row < r1 and marks.x_lo < x1 and marks.x_hi > x0:
            parts.append(marks.markup)
    svg = Markup('<svg class="gchart" width="{}" height="{}" viewBox="{} {} {} {}">{}</svg>')
    return svg.format(_n(width), _n(height), _n(x0), _n(y0), _n(width), _n(height),
                      Markup("").join(parts))


def _tile_span(scale: gantt.Scale, x0: float, x1: float, first_ms: int, last_ms: int) -> str:
    """The days a tile shows, inside the printed range."""
    a = max(gantt.ms_of(scale, x0), first_ms)
    b = min(gantt.ms_of(scale, min(x1, scale.width)), last_ms)
    if b <= a:
        return ""
    return day_span(gantt.moment_of(a), gantt.moment_of(max(a, b - 60_000)))


def _drawn(scale: gantt.Scale, width: float) -> gantt.Scale:
    """The chart the tiles draw: `scale`'s own axis (its start and px per
    ms, so every x is the same) with its end moved to `width`, the last
    tile's right edge. Every tile is the chart's full width, so the last one
    reaches past the printed range: the timescale, the grid and the
    nonworking days run on to its edge, and nothing on the page is
    unlabeled. The printed range, its scale and the page estimate don't
    move."""
    return dataclasses.replace(scale, end_ms=gantt.ms_of(scale, width), width=width)


def _gantt_pages(data: PlanData, tasks: list[PlanTaskOut], choices, start: str, finish: str,
                 zoom: str) -> list[dict]:
    paper = choices.paper
    scale = gantt.print_scale(start, finish, zoom)
    width = gantt.chart_width(paper)
    per = gantt.gantt_rows(paper)
    across = gantt.tiles_across(scale.width, paper)
    down = gantt.tiles_down(len(tasks), paper)
    drawn = _drawn(scale, across * width)
    box = gantt.bar_box(ROW_PX, choices.show_baseline)
    marks = [m for i, t in enumerate(tasks)
             if (m := _task_marks(t, i, drawn, box, choices.show_critical,
                                  choices.show_baseline)) is not None]
    now = gantt.to_ms(data.now)
    status = gantt.to_ms(data.status_date) if data.status_date else None
    chart = _Chart(
        scale=drawn, zoom=zoom, marks=marks,
        links=_links(data, tasks, drawn, box, zoom, choices.show_critical),
        bands=(gantt.nonworking_bands(data.calendar, drawn)
               if zoom in ("hours", "days", "weeks") else []),
        top_ticks=gantt.tiers(drawn, zoom).top,
        today=gantt.x_of_ms(drawn, now) if now is not None else None,
        status=gantt.x_of_ms(drawn, status) if status is not None else None)
    first_ms, last_ms = gantt.to_ms(start), max(gantt.to_ms(start), gantt.to_ms(finish))
    names = [{"id": t.display_id, "name": t.name, "summary": t.is_summary,
              "indent": NAMES_INDENT_PAD + INDENT_PX * (max(t.outline_level, 1) - 1)}
             for t in tasks]
    pages = []
    for d in range(down):                  # top to bottom ...
        r0, r1 = d * per, min(len(tasks), (d + 1) * per)
        rows = f"Rows {r0 + 1}–{r1} of {len(tasks)}" if tasks else "No tasks to print"
        y0, y1 = r0 * ROW_PX, max(r1, r0 + 1) * ROW_PX
        band = dataclasses.replace(
            chart, marks=[m for m in chart.marks if r0 <= m.row < r1],
            links=[k for k in chart.links if k.y_lo < y1 and k.y_hi > y0])
        for a in range(across):            # ... each band left to right
            x0 = a * width
            pages.append({
                "span": _tile_span(scale, x0, x0 + width, first_ms, last_ms),
                "rows": rows, "across": f"{a + 1} of {across}" if across > 1 else "",
                "names": names[r0:r1],
                "scale": _scale_svg(drawn, zoom, x0, width),
                "chart": _chart_svg(band, x0, width, r0, r1),
            })
    return pages


_ZOOM_LABELS = {"hours": "Hours", "days": "Days", "weeks": "Weeks", "months": "Months",
                "quarters": "Quarters"}


def render_html(data: PlanData, choices, *, generated_at: datetime, tracking_id: str) -> str:
    """The PDF's HTML. `choices` is the run's options with the defaults in
    (project_plan.Choices)."""
    tasks = [t for t in data.tasks if choices.include_completed or t.percent_complete < 100]
    # bounded: cut to the plan's span, at most MAX_PRINT_YEARS (PrintRangeError)
    span = printed_range(data.span, choices.first, choices.last)
    zoom = (gantt.print_fit(span.start, span.finish, choices.paper)
            if choices.zoom == "fit" else choices.zoom)
    zone = report_timezone()
    local = generated_at.astimezone(zone)
    stamp = f"{local:%Y-%m-%d %H:%M} {local:%Z}"
    start = _floating(data.project_start)
    finish = _floating(data.project_finish)
    status = _floating(data.status_date)
    if choices.first and choices.last:
        # the days printed: the asked-for ones cut to the plan
        a, b = gantt.to_ms(span.start), gantt.to_ms(span.finish)
        range_text = day_span(gantt.moment_of(a), gantt.moment_of(max(a, b - 60_000)))
    else:
        range_text = "Whole project"
    lock = ((f"Locked {_instant_day(data.locked_at)}"
             + (f" by {data.locked_by_name}" if data.locked_by_name else ""))
            if data.locked_at else "Not locked")
    baseline = (f"Baseline saved {_instant_day(data.baseline_set_at)}"
                if data.baseline_set_at else "No baseline")
    # read across in pairs; the last one takes the whole row
    facts = [
        ("Initiative", data.initiative_name),
        ("Project", f"{sheet_day(start, data.show_times)} → "
                    f"{sheet_day(finish, data.show_times) or '—'}"),
        ("Client", data.client_name or "—"),
        ("Status date", sheet_day(status, data.show_times) if status
         else f"Not set (today, {sheet_day(_floating(data.now))})"),
        ("Code", data.initiative_code or "—"),
        ("Schedule", f"{lock} · {baseline}"),
        ("Owner", data.owner_name or "—"),
        ("Generated", stamp + (f" by {data.requested_by_name}" if data.requested_by_name else "")),
        ("Printed", " · ".join([
            range_text,
            f"{_ZOOM_LABELS[zoom]}{' (fit)' if choices.zoom == 'fit' else ''}",
            "Letter" if choices.paper == "letter" else "A4",
            f"{len(tasks)} of {len(data.tasks)} tasks"
            + ("" if choices.include_completed else ", completed left out"),
            *(["Critical path shown"] if choices.show_critical else []),
            *(["Baseline shown"] if choices.show_baseline else []),
        ])),
    ]
    return _ENV.get_template("project_plan.html").render(
        title=data.initiative_name, page_size="Letter" if choices.paper == "letter" else "A4",
        facts=facts, table=_table(data, tasks, choices.columns),
        pages=_gantt_pages(data, tasks, choices, span.start, span.finish, zoom),
        names_px=gantt.NAMES_PX, chart_px=gantt.chart_width(choices.paper),
        head_px=gantt.GANTT_HEAD_PX, tier_px=TIER_PX, row_px=ROW_PX,
        margin_px=gantt.MARGIN_PX, footer_px=gantt.FOOTER_PX,
        stamp=stamp, tracking_id=tracking_id, barcode_data_uri=pdf417_data_uri(tracking_id))


# ── the render, in a child process the timeout can kill ───────────────
#
# Making the HTML and printing it are synchronous CPU work: under the
# worker's asyncio.wait_for they could not be interrupted, so a huge PDF
# would hold the worker long past RUN_TIMEOUT_SECONDS. Both run in a
# spawned child instead; the parent only waits (an awaitable poll), so the
# worker's timeout cancels the wait, and the child is killed either way.
# The child also has a deadline of its own (SIGALRM at the timeout plus a
# grace), so it can't outlive a SIGKILLed worker by long. Its memory has no
# cap of its own (an RLIMIT_AS would need a memory number nobody has set).

_POLL_SECONDS = 0.05
# what the child's own deadline allows past the parent's timeout
CHILD_GRACE_SECONDS = 5


class RenderFailed(RuntimeError):
    """The child stopped without a PDF: it raised, or it died."""


def _child_main(conn, deadline_seconds: int, target, args: tuple) -> None:
    """The child: arm its own deadline (SIGALRM's default action ends the
    process), then do `target`'s work."""
    import signal
    if hasattr(signal, "alarm"):
        signal.alarm(max(1, deadline_seconds))
    target(conn, *args)


def _render_child(conn, data: PlanData, choices, generated_at: datetime,
                  tracking_id: str) -> None:
    """The child's whole job: HTML, then PDF, sent back over `conn`."""
    from weasyprint import HTML
    try:
        html = render_html(data, choices, generated_at=generated_at, tracking_id=tracking_id)
        conn.send(("ok", HTML(string=html, url_fetcher=data_fetcher()).write_pdf()))
    except BaseException as exc:                      # the parent reports it
        conn.send(("error", f"{type(exc).__name__}: {exc}"))
    finally:
        conn.close()


async def render_pdf_in_child(data: PlanData, choices, *, generated_at: datetime,
                              tracking_id: str, timeout: float,
                              target=_render_child) -> bytes:
    """The PDF, made in a spawned child process that is killed after
    `timeout` seconds (TimeoutError) or when this wait is cancelled (the
    worker's own timeout). RenderFailed when the child raises or dies.
    `target` is what the child runs (the tests swap in ones that misbehave)."""
    ctx = multiprocessing.get_context("spawn")
    receive, send = ctx.Pipe(duplex=False)
    child = ctx.Process(target=_child_main, name="project-plan-pdf", daemon=True,
                        args=(send, int(timeout) + CHILD_GRACE_SECONDS, target,
                              (data, choices, generated_at, tracking_id)))
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    try:
        # off the event loop: start() writes the pickled arguments into the
        # child's pipe, which blocks until the child reads them
        await asyncio.to_thread(child.start)
        send.close()
        while not receive.poll():
            if not child.is_alive() and not receive.poll():
                raise _stopped(child)
            left = deadline - loop.time()
            if left <= 0:
                raise TimeoutError(f"the PDF took longer than {timeout:g}s")
            await asyncio.sleep(min(_POLL_SECONDS, left))
        try:
            kind, payload = receive.recv()
        except EOFError:                   # the pipe ends with nothing in it: it died
            raise _stopped(child) from None
    finally:
        # (cancelled mid-start, the child isn't ours to kill yet: its own
        # deadline ends it)
        if child.pid is not None:
            if child.is_alive():
                child.kill()
            child.join(5)
        send.close()
        receive.close()
    if kind != "ok":
        raise RenderFailed(payload)
    return payload


def _stopped(child) -> RenderFailed:
    child.join(5)
    return RenderFailed(f"the PDF renderer stopped (exit code {child.exitcode})")


__all__ = ["CHILD_GRACE_SECONDS", "RenderFailed", "data_fetcher", "day_span", "render_html",
           "render_pdf_in_child", "sheet_day", "task_deep", "task_hue"]
