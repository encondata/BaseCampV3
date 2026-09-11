"""Step 2 of the Move Scan History report: gathered data -> Jinja2 HTML
-> WeasyPrint PDF bytes, with a PDF417 tracking-id barcode in the
footer. Port of V2's `generate_pdf()` (api/reports/scan_history_report.py)
— see docs/superpowers/specs/2026-09-11-move-scan-history-design.md.
"""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, select_autoescape

from serversherpa.reports.move_report.render import css_string, render_pdf_async
from serversherpa.reports.move_scan_history.barcode import pdf417_data_uri
from serversherpa.reports.move_scan_history.timefmt import timezone_label, zone_abbrev
from serversherpa.reports.move_scan_history.gather import ScanHistoryData, StatusCol

_ENV = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"),
                   autoescape=select_autoescape(["html"]), trim_blocks=True, lstrip_blocks=True)
_ENV.filters["cssstr"] = css_string

# `render_pdf_async` (Jinja2 HTML -> WeasyPrint PDF bytes in a thread) is
# generic over the HTML it's given — reused verbatim, not reimplemented.
render_pdf = render_pdf_async

_DATE_FMT = "%m/%d/%Y"
_OVERVIEW_TS_FMT = "%m/%d %H:%M"
_DETAIL_TS_FMT = "%m/%d/%Y %I:%M:%S %p"
_STAMP_FMT = "%m/%d/%Y, %I:%M:%S %p"

# V2's Letter-landscape page geometry (api/reports/scan_history_report.py
# generate_pdf): 11in page width, 14mm margins each side.
_PAGE_WIDTH_MM = 279.4
_MARGIN_MM = 14
_FIXED_COL_WIDTHS_MM = (20, 25, 30)          # Asset ID, Serial #, Asset Name
_MAX_STATUS_COL_MM = 18
_DETAIL_COL_WIDTHS_MM = (25, 35, 50, 40, 45)  # Asset ID, Serial Number, Asset Name, Status, Timestamp


@dataclass
class _Column:
    label: str
    width_mm: float


@dataclass
class _OverviewRow:
    asset_id: int
    serial_number: str
    name: str
    cells: list[str]           # one per status column, "" when not reached


@dataclass
class _DetailRow:
    asset_id: int
    serial_number: str
    name: str
    status_label: str
    at: datetime            # sort key — kept alongside the formatted string so
    timestamp: str          # sorting never operates on the rendered text (a
                             # lexical sort of "%I:%M:%S %p"/"%m/%d/%Y" strings
                             # puts "02:00:00 PM" before "08:00:00 AM" and
                             # "01/01/2026" before "12/31/2025")


# Narrowest status column that still fits "%m/%d %H:%M" on one 6 pt line
# with a little air. V2 let columns shrink without limit (18 mm cap only),
# which made a 20+ status vocabulary unreadable; V3 instead splits the
# Status Overview into column groups, repeating the three identity columns
# in each, so no group has more status columns than fit at this width.
_MIN_STATUS_COL_MM = 14


def _status_col_width_mm(n: int) -> float:
    if n == 0:
        return 0.0
    available = _PAGE_WIDTH_MM - 2 * _MARGIN_MM
    remaining = available - sum(_FIXED_COL_WIDTHS_MM)
    return min(_MAX_STATUS_COL_MM, remaining / n)


def max_status_columns_per_table() -> int:
    """How many status columns fit beside the identity columns at the
    minimum readable width."""
    remaining = _PAGE_WIDTH_MM - 2 * _MARGIN_MM - sum(_FIXED_COL_WIDTHS_MM)
    return max(1, int(remaining // _MIN_STATUS_COL_MM))


def chunk_columns(columns: list, per_table: int | None = None) -> list[list]:
    """Split the status columns into balanced groups of at most
    `per_table` (default: what fits at the minimum width). 14 pipeline
    columns become two groups of 7; 28 become three of 10/9/9; anything
    that fits stays one group. Order is preserved."""
    if not columns:
        return []
    cap = per_table or max_status_columns_per_table()
    groups = -(-len(columns) // cap)            # ceil
    base, extra = divmod(len(columns), groups)
    out, start = [], 0
    for i in range(groups):
        size = base + (1 if i < extra else 0)
        out.append(columns[start:start + size])
        start += size
    return out


@dataclass
class _OverviewGroup:
    caption: str               # "" for a single group; "Columns 1–7 of 14" otherwise
    columns: list
    rows: list
    table_width_mm: float


def render_html(data: ScanHistoryData, columns: list[StatusCol], *, generated_at: datetime,
                tracking_id: str, tz: ZoneInfo) -> str:
    scheduled_start = (data.scheduled_start.astimezone(tz).strftime(_DATE_FMT)
                       if data.scheduled_start else "Not scheduled")
    stamp = f"{generated_at.astimezone(tz).strftime(_STAMP_FMT)} {zone_abbrev(tz, generated_at)}"
    tz_label = timezone_label(tz, generated_at)
    tz_abbrev = zone_abbrev(tz, generated_at)

    # One overview table per column group (see chunk_columns); every group
    # repeats the identity columns so a row can be read on its own.
    overview_groups: list[_OverviewGroup] = []
    groups = chunk_columns(columns)
    offset = 0
    for gi, group in enumerate(groups):
        status_width = _status_col_width_mm(len(group))
        cols = [_Column(label=c.label, width_mm=status_width) for c in group]
        rows = []
        for asset in data.assets:
            by_status = {h.status_key: h.at for h in data.scan_progress.get(asset.asset_id, ())}
            cells = []
            for col in group:
                at = by_status.get(col.key)
                cells.append(at.astimezone(tz).strftime(_OVERVIEW_TS_FMT) if at else "")
            rows.append(_OverviewRow(asset.asset_id, asset.serial_number, asset.name, cells))
        caption = ("" if len(groups) == 1 else
                   f"Columns {offset + 1}\u2013{offset + len(group)} of {len(columns)}")
        overview_groups.append(_OverviewGroup(
            caption=caption, columns=cols, rows=rows,
            table_width_mm=sum(_FIXED_COL_WIDTHS_MM) + status_width * len(group)))
        offset += len(group)

    asset_lookup = {a.asset_id: a for a in data.assets}
    detail_rows: list[_DetailRow] = []
    for asset_id, hits in data.scan_progress.items():
        asset = asset_lookup.get(asset_id)
        serial = asset.serial_number if asset else ""
        name = asset.name if asset else ""
        for hit in hits:
            detail_rows.append(_DetailRow(
                asset_id=asset_id, serial_number=serial, name=name,
                status_label=hit.status_label, at=hit.at,
                timestamp=hit.at.astimezone(tz).strftime(_DETAIL_TS_FMT)))
    # sort on the real timestamp, THEN format — a lexical sort of the
    # already-formatted string is wrong twice over (12 h clock, and a
    # %m/%d/%Y date string sorts by month before year).
    detail_rows.sort(key=lambda r: (r.asset_id, r.at))

    barcode_data_uri = pdf417_data_uri(tracking_id)

    detail_table_width_mm = sum(_DETAIL_COL_WIDTHS_MM)

    return _ENV.get_template("move_scan_history.html").render(
        move_name=data.name,
        client_name=data.client_name or "N/A",
        scheduled_start=scheduled_start,
        source_name=data.source_name or "N/A",
        destination_name=data.destination_name or "N/A",
        total_assets=data.total_assets,
        completion_pct=data.completion_pct,
        fixed_col_widths=_FIXED_COL_WIDTHS_MM,
        overview_groups=overview_groups,
        detail_col_widths=_DETAIL_COL_WIDTHS_MM,
        detail_rows=detail_rows,
        detail_table_width_mm=detail_table_width_mm,
        has_assets=bool(data.assets),
        stamp=stamp,
        tz_label=tz_label,
        tz_abbrev=tz_abbrev,
        tracking_id=tracking_id,
        barcode_data_uri=barcode_data_uri,
    )
