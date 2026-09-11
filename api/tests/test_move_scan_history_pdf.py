"""barcode.py + pdf.py (render_html/render_pdf) + build()'s pdf branch —
port of V2's generate_pdf() (api/reports/scan_history_report.py) and
_pdf_utils.py's create_barcode_image(). See docs/superpowers/specs/
2026-09-11-move-scan-history-design.md."""

from datetime import UTC, datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

from serversherpa.db.models import (
    Asset, Client, Initiative, InitiativeAsset, Person, ProcessedScan, ReportDefinition,
    ReportRun,
)
from serversherpa.reports.move_scan_history.barcode import pdf417_data_uri, pdf417_png
from serversherpa.reports.move_scan_history.gather import (
    AssetRow, ScanHistoryData, ScanHit, StatusCol,
)
from serversherpa.reports.move_scan_history.pdf import render_html
from serversherpa.reports.registry import get_module

TZ = ZoneInfo("America/New_York")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

COLUMNS = [
    StatusCol(key="pre_stage", label="Pre-Stage", color="#caa0a0", in_pipeline=True, scan_count=2),
    StatusCol(key="complete", label="Complete", color="#8e27f5", in_pipeline=True, scan_count=1),
]


def _populated_data() -> ScanHistoryData:
    return ScanHistoryData(
        initiative_id=uuid4(), name="NAP11 Move", client_name="Acme",
        scheduled_start=datetime(2026, 3, 15, 9, 0, tzinfo=UTC),
        source_name="DC-A", destination_name="DC-B",
        assets=[AssetRow(100, "SN-B", "Asset B"), AssetRow(200, "SN-C", "Asset C")],
        statuses=COLUMNS,
        scan_progress={
            200: [ScanHit("pre_stage", "Pre-Stage", datetime(2026, 3, 16, 10, 0, tzinfo=UTC))],
            100: [
                ScanHit("complete", "Complete", datetime(2026, 3, 16, 14, 30, tzinfo=UTC)),
                ScanHit("pre_stage", "Pre-Stage", datetime(2026, 3, 16, 8, 0, tzinfo=UTC)),
            ],
        },
        total_assets=2, scanned_assets=2, completed=1, completion_pct=50,
        last_scan_at=datetime(2026, 3, 16, 14, 30, tzinfo=UTC))


def _empty_data() -> ScanHistoryData:
    return ScanHistoryData(
        initiative_id=uuid4(), name="Empty Move", client_name=None, scheduled_start=None,
        source_name=None, destination_name=None, assets=[], statuses=[], scan_progress={},
        total_assets=0, scanned_assets=0, completed=0, completion_pct=0, last_scan_at=None)


# ── barcode.py ───────────────────────────────────────────────────────

def test_pdf417_png_encodes_a_uuid_at_the_default_column_count():
    png = pdf417_png(str(uuid4()))
    assert png[:8] == PNG_MAGIC


def test_pdf417_png_falls_back_to_fewer_columns_for_short_input():
    # a single character fails at columns=6..5 (too few rows) — the
    # function must retry down to a column count that succeeds instead
    # of propagating pdf417gen's ValueError.
    png = pdf417_png("x")
    assert png[:8] == PNG_MAGIC


def test_pdf417_data_uri_is_a_base64_png():
    uri = pdf417_data_uri(str(uuid4()))
    assert uri.startswith("data:image/png;base64,")


# ── pdf.py render_html ────────────────────────────────────────────────

def test_render_html_contains_title_sections_and_data():
    data = _populated_data()
    tracking_id = str(uuid4())
    html = render_html(data, COLUMNS, generated_at=datetime(2026, 3, 17, 8, 0, tzinfo=UTC),
                       tracking_id=tracking_id, tz=TZ)
    assert "Move Scan History Report" in html
    assert "Status Overview" in html
    assert "Scan History Detail" in html
    assert "NAP11 Move" in html
    assert "SN-B" in html                       # one asset's serial number
    assert "03/16 04:00" in html                # %m/%d %H:%M cell (tz-converted)
    assert tracking_id in html
    assert "data:image/png;base64," in html
    assert "End of Report" in html


def test_render_html_empty_move_shows_both_empty_state_messages():
    data = _empty_data()
    html = render_html(data, [], generated_at=datetime(2026, 3, 17, 8, 0, tzinfo=UTC),
                       tracking_id=str(uuid4()), tz=TZ)
    assert "No assets found in this move." in html
    assert "No scan history found." in html
    assert "Not scheduled" in html


def test_render_html_overview_cell_uses_a_24_hour_clock():
    """Every hit in `_populated_data()` happens to land in the AM, so
    `"03/16 04:00" in html` alone can't tell `%H:%M` (24 h) apart from a
    12-hour-clock mutation (`%I:%M %p`) — both print "04:00" for 4 AM. A
    PM hit makes the two formats diverge: `%H:%M` prints "15:00", a
    12-hour mutation prints "03:00 PM"."""
    columns = [StatusCol(key="in_transit", label="In Transit", color="#123456",
                         in_pipeline=True, scan_count=1)]
    data = ScanHistoryData(
        initiative_id=uuid4(), name="PM Move", client_name="Acme", scheduled_start=None,
        source_name=None, destination_name=None,
        assets=[AssetRow(300, "SN-300", "Asset D")], statuses=columns,
        scan_progress={300: [
            ScanHit("in_transit", "In Transit", datetime(2026, 3, 16, 19, 0, tzinfo=UTC))]},
        total_assets=1, scanned_assets=1, completed=0, completion_pct=0,
        last_scan_at=datetime(2026, 3, 16, 19, 0, tzinfo=UTC))
    html = render_html(data, columns, generated_at=datetime(2026, 3, 17, 8, 0, tzinfo=UTC),
                       tracking_id=str(uuid4()), tz=TZ)
    assert "03/16 15:00" in html


def test_render_html_detail_rows_sort_chronologically_not_by_formatted_string():
    """`_DetailRow` used to sort on the already-formatted
    `%m/%d/%Y %I:%M:%S %p` string, which is a lexical sort: "02:00:00 PM"
    sorts before "08:00:00 AM", and "01/01/2026" sorts before
    "12/31/2025". One asset, three hits spanning a year boundary and an
    AM/PM crossing, all with the SAME asset_id so only the timestamp
    breaks the tie — chronological order must survive rendering."""
    data = ScanHistoryData(
        initiative_id=uuid4(), name="Order Move", client_name="Acme", scheduled_start=None,
        source_name=None, destination_name=None,
        assets=[AssetRow(500, "SN-500", "Asset Z")], statuses=[],
        scan_progress={500: [
            # 1/1/2026 19:00 UTC -> 1/1/2026 02:00 PM ET (latest)
            ScanHit("complete", "Complete", datetime(2026, 1, 1, 19, 0, tzinfo=UTC)),
            # 12/31/2025 08:00 UTC -> 12/31/2025 03:00 AM ET (earliest)
            ScanHit("pre_stage", "Pre-Stage", datetime(2025, 12, 31, 8, 0, tzinfo=UTC)),
            # 1/1/2026 08:00 UTC -> 1/1/2026 03:00 AM ET (middle)
            ScanHit("labeled", "Labeled", datetime(2026, 1, 1, 8, 0, tzinfo=UTC)),
        ]},
        total_assets=1, scanned_assets=1, completed=0, completion_pct=0,
        last_scan_at=datetime(2026, 1, 1, 19, 0, tzinfo=UTC))
    html = render_html(data, [], generated_at=datetime(2026, 1, 2, 8, 0, tzinfo=UTC),
                       tracking_id=str(uuid4()), tz=TZ)
    pre_idx = html.index(">Pre-Stage<")
    labeled_idx = html.index(">Labeled<")
    complete_idx = html.index(">Complete<")
    # a lexical sort of the formatted strings would put Complete (PM) FIRST
    # and Pre-Stage (12/31) LAST — the opposite of chronological order
    assert pre_idx < labeled_idx < complete_idx


# ── WeasyPrint end-to-end ──────────────────────────────────────────────

def test_weasyprint_renders_at_least_one_page_with_the_barcode_image():
    from weasyprint import HTML

    data = _populated_data()
    html = render_html(data, COLUMNS, generated_at=datetime(2026, 3, 17, 8, 0, tzinfo=UTC),
                       tracking_id=str(uuid4()), tz=TZ)
    doc = HTML(string=html).render()
    assert len(doc.pages) >= 1
    pdf_bytes = HTML(string=html).write_pdf()
    # the PDF417 barcode is the only image on the page — a malformed
    # `content: url(...)` in the @bottom-right margin box is dropped
    # silently by WeasyPrint (a log warning, not an exception), so this
    # is the only way to prove it actually made it into the PDF.
    assert pdf_bytes.count(b"/Subtype /Image") == 1


# ── build() through the registry ────────────────────────────────────

async def test_build_produces_pdf_through_the_registry(db, monkeypatch):
    module = get_module("move_scan_history")

    captured: dict = {}
    original_render_html = module.render_html

    def spy_render_html(data, columns, *, generated_at, tracking_id, tz):
        captured["tracking_id"] = tracking_id
        return original_render_html(data, columns, generated_at=generated_at,
                                    tracking_id=tracking_id, tz=tz)

    monkeypatch.setattr(module, "render_html", spy_render_html)

    person = Person(first_name="Rae", last_name="Requester")
    client = Client(name="Acme")
    db.add_all([person, client])
    await db.flush()
    ini = Initiative(name="NAP11 / Move #1", initiative_type="move", status="planned",
                     client_id=client.id)
    definition = ReportDefinition(name="Move Scan History PDF Test",
                                  report_type="move_scan_history",
                                  options={"default_format": "pdf", "status_columns": "pipeline"},
                                  is_system=True)
    db.add_all([ini, definition])
    await db.flush()

    asset = Asset(legacy_id=9002, serial_number="SN-9002", name="Gadget")
    db.add(asset)
    await db.flush()
    db.add(InitiativeAsset(initiative_id=ini.id, asset_id=asset.id))
    db.add(ProcessedScan(
        scanned_value="EPC-9002", scan_type="rfid", scanned_at=datetime.now(UTC),
        processed_at=datetime.now(UTC), match_type="asset", asset_id=asset.id, status="complete"))
    await db.flush()

    run = ReportRun(definition_id=definition.id, report_type="move_scan_history",
                    initiative_id=ini.id, options={"format": "pdf"},
                    requested_by=person.id, requested_rank=0)
    db.add(run)
    await db.commit()

    result = await module.build(db, run)
    assert result.content_type == "application/pdf"
    assert result.content[:4] == b"%PDF"
    assert result.filename.startswith("Move Scan History - NAP11 - Move #1 - ")
    assert result.filename.endswith(".pdf")
    # the spec's headline "deliberate difference" — V2 minted a random
    # uuid; V3's Document Tracking ID is the run id, traceable back to it.
    assert captured["tracking_id"] == str(run.id)


def test_chunk_columns_balances_groups_at_the_readable_width():
    from serversherpa.reports.move_scan_history.pdf import chunk_columns, max_status_columns_per_table

    assert max_status_columns_per_table() == 12
    assert chunk_columns([]) == []
    assert [len(g) for g in chunk_columns(list(range(5)))] == [5]
    assert [len(g) for g in chunk_columns(list(range(14)))] == [7, 7]
    assert [len(g) for g in chunk_columns(list(range(28)))] == [10, 9, 9]
    assert [x for g in chunk_columns(list(range(28))) for x in g] == list(range(28))  # order kept


def test_render_html_splits_wide_overviews_into_captioned_groups():
    from serversherpa.reports.move_scan_history.gather import StatusCol
    from serversherpa.reports.move_scan_history.pdf import render_html

    data = _populated_data()
    columns = [StatusCol(key=f"s{i}", label=f"Status {i}", color="#000", in_pipeline=True, scan_count=0)
               for i in range(14)]
    html = render_html(data, columns, generated_at=datetime(2026, 3, 17, 8, 0, tzinfo=UTC),
                       tracking_id="t", tz=TZ)
    assert html.count('<table class="overview"') == 2
    assert "Columns 1–7 of 14" in html and "Columns 8–14 of 14" in html
    # every group repeats the identity headers
    assert html.count("<th>Serial #</th>") == 2   # the detail table says "Serial Number"
