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

from serversherpa.reports.move_report.render import _css_string, render_pdf_async
from serversherpa.reports.move_scan_history.barcode import pdf417_data_uri
from serversherpa.reports.move_scan_history.gather import ScanHistoryData, StatusCol

_ENV = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"),
                   autoescape=select_autoescape(["html"]), trim_blocks=True, lstrip_blocks=True)
_ENV.filters["cssstr"] = _css_string

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
    timestamp: str


def _status_col_width_mm(n: int) -> float:
    if n == 0:
        return 0.0
    available = _PAGE_WIDTH_MM - 2 * _MARGIN_MM
    remaining = available - sum(_FIXED_COL_WIDTHS_MM)
    return min(_MAX_STATUS_COL_MM, remaining / n)


def render_html(data: ScanHistoryData, columns: list[StatusCol], *, generated_at: datetime,
                tracking_id: str, tz: ZoneInfo) -> str:
    scheduled_start = (data.scheduled_start.astimezone(tz).strftime(_DATE_FMT)
                       if data.scheduled_start else "Not scheduled")
    stamp = generated_at.astimezone(tz).strftime(_STAMP_FMT)

    status_width = _status_col_width_mm(len(columns))
    overview_columns = [_Column(label=c.label, width_mm=status_width) for c in columns]

    overview_rows = []
    for asset in data.assets:
        by_status = {h.status_key: h.at for h in data.scan_progress.get(asset.asset_id, ())}
        cells = []
        for col in columns:
            at = by_status.get(col.key)
            cells.append(at.astimezone(tz).strftime(_OVERVIEW_TS_FMT) if at else "")
        overview_rows.append(_OverviewRow(asset.asset_id, asset.serial_number, asset.name, cells))

    asset_lookup = {a.asset_id: a for a in data.assets}
    detail_rows: list[_DetailRow] = []
    for asset_id, hits in data.scan_progress.items():
        asset = asset_lookup.get(asset_id)
        serial = asset.serial_number if asset else ""
        name = asset.name if asset else ""
        for hit in hits:
            detail_rows.append(_DetailRow(
                asset_id=asset_id, serial_number=serial, name=name,
                status_label=hit.status_label, timestamp=hit.at.astimezone(tz).strftime(_DETAIL_TS_FMT)))
    detail_rows.sort(key=lambda r: (r.asset_id, r.timestamp))

    barcode_data_uri = pdf417_data_uri(tracking_id)

    return _ENV.get_template("move_scan_history.html").render(
        move_name=data.name,
        client_name=data.client_name or "N/A",
        scheduled_start=scheduled_start,
        source_name=data.source_name or "N/A",
        destination_name=data.destination_name or "N/A",
        total_assets=data.total_assets,
        completion_pct=data.completion_pct,
        fixed_col_widths=_FIXED_COL_WIDTHS_MM,
        overview_columns=overview_columns,
        overview_rows=overview_rows,
        detail_col_widths=_DETAIL_COL_WIDTHS_MM,
        detail_rows=detail_rows,
        has_assets=bool(data.assets),
        stamp=stamp,
        tracking_id=tracking_id,
        barcode_data_uri=barcode_data_uri,
    )
