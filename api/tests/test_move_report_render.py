"""Jinja2 template: each section toggles independently; WeasyPrint smoke
test produces a real PDF."""

import re
import zlib
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

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


def test_collision_section_lists_orphan_nodes():
    html = render_html(_ctx(assets=[_asset(1, destination_ru=20.0),
                                    _asset(2, destination_ru=31.2)]))
    assert "No collisions" in html
    assert "Orphan nodes" in html
    assert "web-02" in html and "31.2" in html
    assert "No device starts at this RU" in html


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
    # `/Type /Pages` is the page *tree* node, not a page — exclude it.
    assert len(re.findall(rb"/Type\s*/Page\b(?!s)", _pdf_objects(pdf))) >= 1


def test_page_margin_strings_are_css_escaped_not_html_escaped():
    """`<style>` is raw text: HTML entities would print literally in the
    running header/footer, so those values take the `cssstr` filter."""
    data = replace(_data(), name='Acme & Co "x"')
    ctx = build_context(data, ALL_ON, source_racks=[], destination_racks=[],
                        generated_by="Sean O'Brien",
                        generated_at=datetime(2026, 9, 9, 14, 30, tzinfo=UTC))
    html = render_html(ctx)
    style = html.split("<style>", 1)[1].split("</style>", 1)[0]
    # `\26 ` — the trailing space terminates the hex escape (C is a hex digit,
    # so `\26C` would be U+026C), which is why the real space needs a second one.
    assert 'Acme \\26  Co \\"x\\"' in style
    assert "Sean O'Brien" in style
    assert "&amp;" not in style and "&#39;" not in style
    assert "Acme &amp; Co" in html.split("<h1>", 1)[1].split("</h1>", 1)[0]


FIXTURE = Path(__file__).parent / "fixtures" / "rack_fragment.html"
RACK_CSS = Path(__file__).resolve().parents[2] / "portal/src/styles/rack-svg.css"


def test_fixture_carries_the_portals_current_rack_css():
    """The fixture is a captured Node render, so it silently goes stale when
    rack-svg.css moves on — and the layout test below would then be proving
    something about last month's stylesheet."""
    # the copy INSIDE the <svg> is the complete stylesheet; the outer copy is
    # filtered to HTML-safe declarations (see renderRack.tsx htmlOnlyCss)
    inlined = re.search(r"<svg[^>]*><style>([\s\S]*?)</style>", FIXTURE.read_text()).group(1)
    stripped = re.sub(r"/\*[\s\S]*?\*/", "", RACK_CSS.read_text())
    assert inlined.strip() == stripped.strip(), (
        "re-capture api/tests/fixtures/rack_fragment.html — "
        "portal/src/styles/rack-svg.css has changed")


def _boxes_by_class(page, name):
    out = []
    for box in page._page_box.descendants():
        element = getattr(box, "element", None)
        if element is None or box.element_tag != "div":
            continue
        if name in (element.get("class") or "").split():
            out.append(box)
    return out


def test_rack_page_layout_keeps_elevations_on_page_and_clear_of_table():
    """The real Node-rendered fragment, laid out by WeasyPrint: both
    elevations inside the .elev column, on the page, left of the asset table."""
    from weasyprint import HTML

    svg = RackSvg("R1", FIXTURE.read_text(), [_asset(1)])
    html = render_html(_ctx(options={**ALL_ON, "destination_racks": False}, racks=[svg]))
    assert re.search(r"<svg[^>]*><style>", html)          # CSS inlined inside the <svg>

    pages = HTML(string=html).render().pages
    elevations = []
    for page in pages:
        elevs = _boxes_by_class(page, "elev")
        if not elevs:
            continue
        elev, = elevs
        lst, = _boxes_by_class(page, "list")
        for box in _boxes_by_class(page, "rack-elevation"):
            assert box.position_x >= 0, "elevation runs off the left edge of the paper"
            assert box.position_x + box.width <= elev.position_x + elev.width + 0.01
            elevations.append((page, box))
        assert elev.position_x + elev.width <= lst.position_x + 0.01

    assert len(elevations) == 2, "FRONT and REAR elevations"
    (page_a, front), (page_b, rear) = elevations
    assert page_a is page_b, "FRONT and REAR must share a page"
    assert front.position_y == rear.position_y, "FRONT and REAR sit side by side"
    assert front.position_x < rear.position_x
