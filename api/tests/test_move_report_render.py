"""Jinja2 template: each section toggles independently; WeasyPrint smoke
test produces a real PDF."""

import zlib
from datetime import UTC, datetime
from decimal import Decimal

from serversherpa.reports.move_report.gather import MoveAsset, MoveData, SiteInfo
from serversherpa.reports.move_report.racks import RackSvg
from serversherpa.reports.move_report.render import (
    build_context, render_html, render_pdf,
)

ALL_ON = {"summary": True, "assets_by_source": True, "assets_by_destination": True,
          "size_weight": True, "rail_usage": True, "collisions": True,
          "source_racks": True, "destination_racks": True}
HEADINGS = {"summary": "Summary", "assets_by_source": "Asset List - By Source",
            "assets_by_destination": "Asset List - By Destination",
            "size_weight": "Size and Weight Report", "rail_usage": "Rail Usage Report",
            "collisions": "Collision Report", "source_racks": "Source Rack Elevations",
            "destination_racks": "Destination Rack Elevations"}


def _asset(i, **kw):
    base = dict(row_id=f"r{i}", asset_id=f"a{i}", name=f"web-0{i}", serial=f"SN{i}",
                make="Dell", model="R740", ru_size=2, weight_lbs=Decimal("50"), weight_kg=None,
                length_in=None, width_in=None, height_in=None, rail_type="Sliding",
                priority_wave="W1", source_rack="R1", source_ru=float(10 + 2 * i),
                source_verified=True, source_position=None, destination_rack="D1",
                destination_ru=20.0, destination_verified=False, destination_position=None)
    base.update(kw)
    return MoveAsset(**base)


def _data(assets=None):
    return MoveData(id="i1", name="NAP11 move", initiative_type="move", type_label="Move",
                    status="planned", status_label="Planned", client_name="Acme",
                    scheduled_start=datetime(2026, 10, 1, tzinfo=UTC), scheduled_end=None,
                    origin_site=SiteInfo("DC-A", "1 Main St\nAustin, TX 78701"),
                    destination_site=SiteInfo("DC-B", ""),
                    assets=assets if assets is not None else [_asset(1), _asset(2)])


def _ctx(options=ALL_ON, assets=None, racks=None):
    racks = racks or []
    return build_context(_data(assets), options, source_racks=racks, destination_racks=racks,
                         generated_by="Alice Anderson",
                         generated_at=datetime(2026, 9, 9, 14, 30, tzinfo=UTC))


def test_all_sections_render_with_data():
    svg = RackSvg("R1", "<svg><text>web-01</text></svg>", [_asset(1)])
    html = render_html(_ctx(racks=[svg]))
    for heading in HEADINGS.values():
        assert heading in html
    assert "NAP11 move" in html and "Acme" in html and "1 Main St" in html
    assert "web-01" in html and "Sliding" in html
    assert "ru_overlap" in html or "RU overlap" in html          # both at D1 RU 20 collide
    assert html.count("<svg>") == 2                              # source + destination rack
    assert "Generated 2026-09-09" in html and "Alice Anderson" in html


def test_each_section_can_be_turned_off_independently():
    for key, heading in HEADINGS.items():
        html = render_html(_ctx({**ALL_ON, key: False}))
        assert heading not in html, key
        others = [h for k, h in HEADINGS.items() if k != key and k not in ("source_racks", "destination_racks")]
        for h in others:
            assert h in html


def test_no_assets_still_renders_summary_note():
    html = render_html(_ctx(assets=[]))
    assert "No assets on this move" in html


def test_collision_section_says_none_when_clean():
    html = render_html(_ctx(assets=[_asset(1, destination_ru=20.0), _asset(2, destination_ru=30.0)]))
    assert "No collisions" in html


def _pdf_objects(pdf: bytes) -> bytes:
    """WeasyPrint writes the page objects into compressed object streams, so
    the object dictionaries only show up once the streams are inflated."""
    parts = [pdf]
    for chunk in pdf.split(b"stream\n")[1:]:
        try:
            parts.append(zlib.decompress(chunk.split(b"\nendstream")[0]))
        except zlib.error:
            pass
    return b"".join(parts)


def test_render_pdf_smoke():
    pdf = render_pdf(render_html(_ctx()))
    assert pdf[:5] == b"%PDF-"
    assert _pdf_objects(pdf).count(b"/Type /Page") >= 1
