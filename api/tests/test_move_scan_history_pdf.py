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


# ── WeasyPrint end-to-end ──────────────────────────────────────────────

def test_weasyprint_renders_at_least_one_page():
    from weasyprint import HTML

    data = _populated_data()
    html = render_html(data, COLUMNS, generated_at=datetime(2026, 3, 17, 8, 0, tzinfo=UTC),
                       tracking_id=str(uuid4()), tz=TZ)
    pages = HTML(string=html).render().pages
    assert len(pages) >= 1


# ── build() through the registry ────────────────────────────────────

async def test_build_produces_pdf_through_the_registry(db):
    module = get_module("move_scan_history")

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
