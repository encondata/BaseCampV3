"""The project plan PDF's Gantt geometry: a port of only what the PDF draws
with from the portal's lib/plans (ganttGeometry: the zooms' scale, the
fit, the two timescale tiers and their labels, bars, milestones,
baselines, the link paths; ganttView: link stubs and arrowheads, a bar's
place in its row; calendarShade: nonworking days) and of lib/plans/planPdf,
the PDF's own page geometry, which the options step's page estimate uses
too. The portal is the reference; both are held to the shared vectors in
api/tests/fixtures/plans/gantt.json (tests/test_plans_gantt_vectors.py and
the portal's ganttGeometry.vectors.test.ts).

Plan times are floating wall-clock text (`YYYY-MM-DDTHH:MM`, plans/
floating.py) read as UTC-naive epoch milliseconds, exactly as the portal
reads them, and every calendar question (the day, the weekday, the month)
is answered on that clock. The arithmetic is done in the portal's order,
so both sides compute the same IEEE doubles. Lengths are CSS px (1/96 in).
"""

import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

MS_PER_DAY = 86_400_000
MS_PER_HOUR = 3_600_000
MS_PER_WEEK = 7 * MS_PER_DAY

LINK_STUB = 8
MILESTONE_HALF = 6
FIT_MARGIN = 2 * LINK_STUB + MILESTONE_HALF
ARROW_LEN = 5
ARROW_HALF = 3.5

ZOOMS = ("hours", "days", "weeks", "months", "quarters")
ZOOM_PX_PER_DAY = {"hours": 480, "days": 48, "weeks": 18, "months": 5, "quarters": 1.8}

_EPOCH = datetime(1970, 1, 1)
_PLAN_TIME = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2}))?",
                        re.ASCII)


def _js_round(value: float) -> int:
    """JavaScript's Math.round: halves go up (toward +infinity)."""
    floor = math.floor(value)
    return floor + 1 if value - floor >= 0.5 else floor


def fmt_number(value: float) -> str:
    """A number as JavaScript's String() writes it (whole numbers without a
    `.0`, -0 as 0), for the SVG path text both sides must agree on."""
    if float(value).is_integer():
        return str(int(value))
    return repr(float(value))


# ── plan times (lib/plans/floatingTime) ──────────────────────────────


def to_ms(text: str | None) -> int | None:
    """A plan time (or a date alone, at midnight) as epoch ms of the same
    UTC wall clock; None for anything else (the portal's NaN)."""
    if not isinstance(text, str):
        return None
    match = _PLAN_TIME.fullmatch(text)
    if match is None:
        return None
    year, month, day, hour, minute = (int(p) if p is not None else 0 for p in match.groups())
    if hour > 23 or minute > 59:
        return None
    try:
        moment = datetime(year, month, day, hour, minute)
    except ValueError:
        return None
    return (moment - _EPOCH) // timedelta(milliseconds=1)


def moment_of(ms: float) -> datetime:
    """`new Date(ms)` read through the getUTC* getters (ms truncated, as a
    Date's time value is)."""
    return _EPOCH + timedelta(milliseconds=int(ms))


def from_ms(ms: float | None) -> str:
    """Epoch ms back to plan time text, to the minute; '' for none."""
    if ms is None or not math.isfinite(ms):
        return ""
    at = moment_of(ms)
    return f"{at.year:04d}-{at.month:02d}-{at.day:02d}T{at.hour:02d}:{at.minute:02d}"


def _utc(year: int, month0: int, day: int = 1) -> int:
    """`Date.UTC(year, month0, day)`: a month past either end rolls the year."""
    years, month0 = divmod(month0, 12)
    return (datetime(year + years, month0 + 1, day) - _EPOCH) // timedelta(milliseconds=1)


def _weekday(ms: float) -> int:
    """`getUTCDay()`: 0 is Sunday."""
    return moment_of(ms).isoweekday() % 7


# ── calendar units (all UTC) ─────────────────────────────────────────


def _month_floor(ms: float, step: int) -> int:
    at = moment_of(ms)
    month0 = at.month - 1
    return _utc(at.year, month0 - (month0 % step))


def _month_add(ms: float, n: int) -> int:
    at = moment_of(ms)
    return _utc(at.year, at.month - 1 + n)


def _week_floor(ms: float) -> int:
    days = math.floor(ms / MS_PER_DAY)
    return (days - (days + 3) % 7) * MS_PER_DAY


_FLOOR: dict[str, Callable[[float], int]] = {
    "hour": lambda ms: math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR,
    "day": lambda ms: math.floor(ms / MS_PER_DAY) * MS_PER_DAY,
    "week": _week_floor,
    "month": lambda ms: _month_floor(ms, 1),
    "quarter": lambda ms: _month_floor(ms, 3),
    "year": lambda ms: _month_floor(ms, 12),
}

_ADD: dict[str, Callable[[float, int], float]] = {
    "hour": lambda ms, n: ms + n * MS_PER_HOUR,
    "day": lambda ms, n: ms + n * MS_PER_DAY,
    "week": lambda ms, n: ms + n * MS_PER_WEEK,
    "month": lambda ms, n: _month_add(ms, n),
    "quarter": lambda ms, n: _month_add(ms, 3 * n),
    "year": lambda ms, n: _month_add(ms, 12 * n),
}


def _ceil(unit: str, ms: float) -> float:
    floor = _FLOOR[unit](ms)
    return ms if floor == ms else _ADD[unit](floor, 1)


BOTTOM_UNIT = {"hours": "hour", "days": "day", "weeks": "week", "months": "month",
               "quarters": "quarter"}
TOP_UNIT = {"hours": "day", "days": "week", "weeks": "month", "months": "quarter",
            "quarters": "year"}

# ── scale ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Scale:
    start_ms: float
    end_ms: float
    px_per_ms: float
    width: float


PAD_BEFORE = 2
PAD_AFTER = 4


def _project_span(caller: str, start_text: str, finish_text: str | None) -> tuple[int, int]:
    start = to_ms(start_text)
    if start is None:
        raise ValueError(f"{caller}: not a plan time: {start_text}")
    finish = to_ms(finish_text) if finish_text else None
    return start, start if finish is None else max(start, finish)


def make_scale(project_start: str, project_finish: str | None, zoom: str) -> Scale:
    """The portal's own axis: two bottom-tier units before the start and
    four after the finish, snapped to the unit's edge."""
    start, finish = _project_span("make_scale", project_start, project_finish)
    unit = BOTTOM_UNIT[zoom]
    start_ms = _ADD[unit](_FLOOR[unit](start), -PAD_BEFORE)
    end_ms = _ADD[unit](_ceil(unit, finish), PAD_AFTER)
    per_day = ZOOM_PX_PER_DAY[zoom]
    return Scale(start_ms, end_ms, per_day / MS_PER_DAY,
                 ((end_ms - start_ms) * per_day) / MS_PER_DAY)


def fit_zoom(project_start: str, project_finish: str | None, width_px: float) -> str:
    """The finest zoom at which the span (unsnapped, unpadded) is no wider
    than `width_px` less FIT_MARGIN; quarters when none is; days for no span."""
    start, finish = _project_span("fit_zoom", project_start, project_finish)
    if finish <= start:
        return "days"
    room = width_px - FIT_MARGIN
    for zoom in ZOOMS:
        if ((finish - start) * ZOOM_PX_PER_DAY[zoom]) / MS_PER_DAY <= room:
            return zoom
    return "quarters"


def px_per_day(scale: Scale) -> float:
    return scale.px_per_ms * MS_PER_DAY


def width_of_ms(scale: Scale, span_ms: float) -> float:
    return (span_ms * px_per_day(scale)) / MS_PER_DAY


def x_of_ms(scale: Scale, ms: float) -> float:
    return width_of_ms(scale, ms - scale.start_ms)


def ms_of(scale: Scale, x: float) -> float:
    return scale.start_ms + (x * MS_PER_DAY) / px_per_day(scale)


# ── timescale ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Tick:
    x: float
    width: float
    label: str


@dataclass(frozen=True)
class Tiers:
    top: list[Tick]
    bottom: list[Tick]


WEEKDAYS = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
WEEKDAY_LETTERS = "SMTWTFS"
MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December")
MONTHS_SHORT = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov",
                "Dec")


def _quarter(at: datetime) -> int:
    return (at.month - 1) // 3 + 1


def _label(fn: Callable[[datetime, float], str]) -> Callable[[float], str]:
    return lambda ms: fn(moment_of(ms), ms)


_LABELS: dict[str, tuple[Callable[[float], str], Callable[[float], str]]] = {
    # Mon 11/2 over 8
    "hours": (_label(lambda at, ms: f"{WEEKDAYS[_weekday(ms)]} {at.month}/{at.day}"),
              _label(lambda at, ms: str(at.hour))),
    # Nov 2, '26 (the week's Monday) over M T W ...
    "days": (_label(lambda at, ms: f"{MONTHS_SHORT[at.month - 1]} {at.day}, '{at.year % 100:02d}"),
             _label(lambda at, ms: WEEKDAY_LETTERS[_weekday(ms)])),
    # November 2026 over 11/2 (the week's Monday)
    "weeks": (_label(lambda at, ms: f"{MONTHS[at.month - 1]} {at.year}"),
              _label(lambda at, ms: f"{at.month}/{at.day}")),
    # Q4 2026 over Nov
    "months": (_label(lambda at, ms: f"Q{_quarter(at)} {at.year}"),
               _label(lambda at, ms: MONTHS_SHORT[at.month - 1])),
    # 2026 over Q4
    "quarters": (_label(lambda at, ms: str(at.year)),
                 _label(lambda at, ms: f"Q{_quarter(at)}")),
}


def _ticks(scale: Scale, unit: str, label: Callable[[float], str], from_x: float,
           to_x: float) -> list[Tick]:
    ticks: list[Tick] = []
    at = _FLOOR[unit](max(scale.start_ms, ms_of(scale, from_x)))
    while at < scale.end_ms:
        nxt = _ADD[unit](at, 1)
        start = max(at, scale.start_ms)
        x = x_of_ms(scale, start)
        if x >= to_x:
            break
        width = width_of_ms(scale, min(nxt, scale.end_ms) - start)
        if x + width > from_x:
            ticks.append(Tick(x, width, label(at)))
        at = nxt
    return ticks


def tiers(scale: Scale, zoom: str, window: tuple[float, float] | list[float] | None = None
          ) -> Tiers:
    """The two header tiers; with a `window` [from_x, to_x] only the ticks
    that overlap it, whole (a tile's timescale)."""
    from_x = window[0] if window is not None else -math.inf
    to_x = window[1] if window is not None else math.inf
    if to_x <= from_x:
        return Tiers([], [])
    top, bottom = _LABELS[zoom]
    return Tiers(_ticks(scale, TOP_UNIT[zoom], top, from_x, to_x),
                 _ticks(scale, BOTTOM_UNIT[zoom], bottom, from_x, to_x))


# ── bars ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Bar:
    x: float
    width: float


def bar_of(scale: Scale, start: str | None, finish: str | None, is_milestone: bool
           ) -> Bar | None:
    """A task's bar; a milestone is a point (width 0). None without the
    dates to draw. A finish before the start is width 0."""
    s = to_ms(start) if start else None
    f = to_ms(finish) if finish else None
    if is_milestone:
        at = f if s is None else s
        return None if at is None else Bar(x_of_ms(scale, at), 0)
    if s is None or f is None:
        return None
    return Bar(x_of_ms(scale, s), max(0, width_of_ms(scale, f - s)))


def progress_width(width: float, percent: float) -> float:
    if not math.isfinite(percent):
        return 0
    return (width * min(100, max(0, percent))) / 100


def baseline_of(scale: Scale, start: str | None, finish: str | None) -> Bar | None:
    s = to_ms(start) if start else None
    f = to_ms(finish) if finish else None
    if s is None or f is None:
        return None
    return Bar(x_of_ms(scale, s), max(0, width_of_ms(scale, f - s)))


@dataclass(frozen=True)
class BarBox:
    top: float
    height: float
    mid: float
    summary_height: float
    base_top: float
    base_height: float


BASELINE_GAP = 2


def bar_box(row_h: float, baseline: bool) -> BarBox:
    """The bar's box in a row `row_h` tall: centered, or lifted with the
    baseline bar under it when the baseline shows."""
    height = max(6, _js_round(row_h * 0.4))
    base_height = max(3, _js_round(row_h * 0.14))
    block = height + BASELINE_GAP + base_height if baseline else height
    top = max(0, math.floor((row_h - block) / 2))
    return BarBox(top=top, height=height, mid=top + height / 2,
                  summary_height=max(4, _js_round(height / 2)),
                  base_top=top + height + BASELINE_GAP, base_height=base_height)


# ── links ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LinkEnd:
    x0: float
    x1: float
    y: float


def link_end(bar: Bar, milestone: bool, y: float) -> LinkEnd:
    """A bar's link ends; a milestone's are its diamond's tips."""
    if milestone:
        return LinkEnd(bar.x - MILESTONE_HALF, bar.x + MILESTONE_HALF, y)
    return LinkEnd(bar.x, bar.x + bar.width, y)


def link_stub(zoom: str) -> float:
    if zoom == "weeks":
        return 6
    if zoom in ("months", "quarters"):
        return 4
    return LINK_STUB


def _hundredth(value: float) -> float:
    return _js_round(value * 100) / 100


def _trace(points: list[tuple[float, float]]) -> str:
    pts = [(_hundredth(x), _hundredth(y)) for x, y in points]
    first, rest = pts[0], pts[1:]
    runs: list[list] = []                  # [axis, to, sign]
    cx, cy = first
    for x, y in rest:
        axis = "H" if x != cx else "V"
        delta = x - cx if axis == "H" else y - cy
        if delta != 0:
            to = x if axis == "H" else y
            sign = 1 if delta > 0 else -1
            if runs and runs[-1][0] == axis and runs[-1][2] == sign:
                runs[-1][1] = to
            else:
                runs.append([axis, to, sign])
        cx, cy = x, y
    return (f"M {fmt_number(first[0])} {fmt_number(first[1])}"
            + "".join(f" {axis} {fmt_number(to)}" for axis, to, _ in runs))


def link_path(a: LinkEnd, b: LinkEnd, kind: str, row_h: float, stub: float = LINK_STUB) -> str:
    """The portal's right-angle path for a link from the predecessor's end
    (FS, FF) or start (SS, SF) to the successor's start (FS, SS) or end
    (FF, SF), with the five-run detour when the successor's edge lies
    behind (ganttGeometry.ts linkPath). '' when an input is not finite."""
    if not all(math.isfinite(v) for v in (a.x0, a.x1, a.y, b.x0, b.x1, b.y, row_h, stub)):
        return ""
    out = 1 if kind in ("FS", "FF") else -1
    into = 1 if kind in ("FS", "SS") else -1
    x = a.x1 if out > 0 else a.x0
    edge = b.x0 if into > 0 else b.x1
    turn = x + out * stub
    if out == into:
        ahead = (edge - x) * out
        drop = x + out * min(stub, ahead) if ahead >= 0 else None
    else:
        drop = turn if (edge - turn) * into >= 0 else edge + out * stub
    if drop is not None:
        return _trace([(x, a.y), (drop, a.y), (drop, b.y), (edge, b.y)])
    between = a.y + (-row_h if b.y < a.y else row_h) / 2
    lead = edge - into * stub
    return _trace([(x, a.y), (turn, a.y), (turn, between), (lead, between), (lead, b.y),
                   (edge, b.y)])


@dataclass(frozen=True)
class LinkShape:
    d: str
    head: str
    dir: str
    tip: tuple[float, float]


_TOKENS = re.compile(r"[MHV]|-?\d+(?:\.\d+)?")


def points_of(d: str) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    cmd = ""
    x = y = 0.0
    tokens = _TOKENS.findall(d)
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in ("M", "H", "V"):
            cmd = t
            i += 1
            continue
        if cmd == "M":
            x, y = float(t), float(tokens[i + 1])
            i += 1
        elif cmd == "H":
            x = float(t)
        elif cmd == "V":
            y = float(t)
        points.append((x, y))
        i += 1
    return points


def link_shape(a: LinkEnd, b: LinkEnd, kind: str, row_h: float, *, stub: float,
               to_half: float) -> LinkShape | None:
    """A link's line and arrowhead (ganttView.ts linkShape): the head points
    the way the last run goes; a drop onto the successor stops `to_half`
    short of its middle; the line ends under the head."""
    d = link_path(a, b, kind, row_h, stub)
    if not d:
        return None
    points = points_of(d)
    if len(points) < 2:
        return None
    px, py = points[-2]
    ex, ey = points[-1]
    vertical = ex == px
    if vertical:
        way = "down" if ey > py else "up"
        ey = max(py, ey - to_half) if way == "down" else min(py, ey + to_half)
    else:
        way = "right" if ex > px else "left"
    tx, ty = _hundredth(ex), _hundredth(ey)

    back = ARROW_LEN - 1
    if vertical:
        line_end = max(py, ey - back) if way == "down" else min(py, ey + back)
    else:
        line_end = max(px, ex - back) if way == "right" else min(px, ex + back)
    runs = [f"H {fmt_number(_hundredth(p[0]))}" if p[0] != points[i][0]
            else f"V {fmt_number(_hundredth(p[1]))}"
            for i, p in enumerate(points[1:-1])]
    if vertical:
        last = f"V {fmt_number(_hundredth(line_end))}" if line_end != py else ""
    else:
        last = f"H {fmt_number(_hundredth(line_end))}" if line_end != px else ""
    start = f"M {fmt_number(_hundredth(points[0][0]))} {fmt_number(_hundredth(points[0][1]))}"
    line = " ".join(part for part in (start, *runs, last) if part)

    def corner(x: float, y: float) -> str:
        return f"{fmt_number(_hundredth(x))},{fmt_number(_hundredth(y))}"

    if way == "right":
        head = (f"{corner(tx, ty)} {corner(tx - ARROW_LEN, ty - ARROW_HALF)} "
                f"{corner(tx - ARROW_LEN, ty + ARROW_HALF)}")
    elif way == "left":
        head = (f"{corner(tx, ty)} {corner(tx + ARROW_LEN, ty - ARROW_HALF)} "
                f"{corner(tx + ARROW_LEN, ty + ARROW_HALF)}")
    elif way == "down":
        head = (f"{corner(tx, ty)} {corner(tx - ARROW_HALF, ty - ARROW_LEN)} "
                f"{corner(tx + ARROW_HALF, ty - ARROW_LEN)}")
    else:
        head = (f"{corner(tx, ty)} {corner(tx - ARROW_HALF, ty + ARROW_LEN)} "
                f"{corner(tx + ARROW_HALF, ty + ARROW_LEN)}")
    return LinkShape(d=line, head=head, dir=way, tip=(tx, ty))


# ── nonworking days (lib/plans/calendarShade) ────────────────────────

_DAY_KEYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")


@dataclass(frozen=True)
class Band:
    x: float
    width: float


def nonworking_bands(calendar: dict, scale: Scale) -> list[Band]:
    """Each run of whole nonworking days (a weekday with no working hours,
    or a dated exception listing none) as one band, cut to the scale. A
    dated exception replaces its weekday's pattern. The portal draws them at
    the days and hours zooms; the PDF at weeks too, where a weekend is still
    36px wide."""
    holidays = {item["date"]: len(item.get("hours") or []) == 0
                for item in (calendar.get("exceptions") or [])}
    week = calendar.get("week") or {}

    def off(day_ms: float) -> bool:
        exception = holidays.get(from_ms(day_ms)[:10])
        if exception is not None:
            return exception
        return len(week.get(_DAY_KEYS[_weekday(day_ms)]) or []) == 0

    bands: list[Band] = []

    def close(start: float, end: float) -> None:
        a = max(start, scale.start_ms)
        b = min(end, scale.end_ms)
        if b > a:
            bands.append(Band(x_of_ms(scale, a), width_of_ms(scale, b - a)))

    run: float | None = None
    day: float = math.floor(scale.start_ms / MS_PER_DAY) * MS_PER_DAY
    while day < scale.end_ms:
        if off(day):
            if run is None:
                run = day
        elif run is not None:
            close(run, day)
            run = None
        day += MS_PER_DAY
    if run is not None:
        close(run, day)
    return bands


# ── the PDF's pages (lib/plans/planPdf) ──────────────────────────────

PAPERS = ("letter", "a4")
PAGE_PX = {"letter": (1056, 816), "a4": (1122, 793)}     # landscape, whole px
MARGIN_PX = 38                                            # 10 mm: top and sides
FOOTER_PX = 76                                            # the bottom margin, for the footer
GANTT_HEAD_PX = 26
TIER_PX = 18
ROW_PX = 18
NAMES_PX = 240
_GANTT_SLACK_PX = 2
TITLE_PX = 160
TABLE_HEAD_PX = 24
TABLE_ROW_PX = 20


@dataclass(frozen=True)
class Box:
    width: float
    height: float


@dataclass(frozen=True)
class TableRows:
    first: int
    rest: int


@dataclass(frozen=True)
class PageLayout:
    content: Box
    chart: float
    gantt_rows: int
    table_rows: TableRows


def content_box(paper: str) -> Box:
    width, height = PAGE_PX[paper]
    return Box(width - 2 * MARGIN_PX, height - MARGIN_PX - FOOTER_PX)


def chart_width(paper: str) -> float:
    return content_box(paper).width - NAMES_PX


def gantt_rows(paper: str) -> int:
    room = content_box(paper).height - GANTT_HEAD_PX - 2 * TIER_PX - _GANTT_SLACK_PX
    return max(1, math.floor(room / ROW_PX))


def table_rows(paper: str) -> TableRows:
    height = content_box(paper).height
    return TableRows(first=max(1, math.floor((height - TITLE_PX - TABLE_HEAD_PX) / TABLE_ROW_PX)),
                     rest=max(1, math.floor((height - TABLE_HEAD_PX) / TABLE_ROW_PX)))


def page_layout(paper: str) -> PageLayout:
    return PageLayout(content=content_box(paper), chart=chart_width(paper),
                      gantt_rows=gantt_rows(paper), table_rows=table_rows(paper))


@dataclass(frozen=True)
class PrintRange:
    start: str
    finish: str


def print_range(project_start: str, project_finish: str | None, first: str | None = None,
                last: str | None = None) -> PrintRange:
    """The whole project, or the days `first` through `last` whole."""
    if first and last:
        return PrintRange(f"{first}T00:00", from_ms(to_ms(last) + MS_PER_DAY))
    return PrintRange(project_start, project_finish or project_start)


def _lead_ms(zoom: str) -> int:
    return _js_round(((FIT_MARGIN / 2) * MS_PER_DAY) / ZOOM_PX_PER_DAY[zoom] / 60_000) * 60_000


def print_scale(start: str, finish: str, zoom: str) -> Scale:
    """The range with half of FIT_MARGIN either side, unsnapped."""
    s = to_ms(start)
    if s is None:
        raise ValueError(f"print_scale: not a plan time: {start}")
    f = to_ms(finish)
    end = s if f is None else max(s, f)
    lead = _lead_ms(zoom)
    per_day = ZOOM_PX_PER_DAY[zoom]
    start_ms = s - lead
    end_ms = end + lead
    return Scale(start_ms, end_ms, per_day / MS_PER_DAY,
                 ((end_ms - start_ms) * per_day) / MS_PER_DAY)


def print_fit(start: str, finish: str, paper: str) -> str:
    return fit_zoom(start, finish, chart_width(paper))


def tiles_across(width: float, paper: str) -> int:
    return max(1, math.ceil(width / chart_width(paper) - 1e-6))


def tiles_down(rows: int, paper: str) -> int:
    return max(1, math.ceil(rows / gantt_rows(paper)))


def table_pages(rows: int, paper: str) -> int:
    layout = table_rows(paper)
    return 1 if rows <= layout.first else 1 + math.ceil((rows - layout.first) / layout.rest)


@dataclass(frozen=True)
class Estimate:
    zoom: str
    table: int
    gantt: int
    across: int
    down: int
    total: int


def estimate_pages(rows: int, start: str, finish: str, zoom: str, paper: str) -> Estimate:
    drawn = print_fit(start, finish, paper) if zoom == "fit" else zoom
    across = tiles_across(print_scale(start, finish, drawn).width, paper)
    down = tiles_down(rows, paper)
    table = table_pages(rows, paper)
    return Estimate(zoom=drawn, table=table, gantt=across * down, across=across, down=down,
                    total=table + across * down)
