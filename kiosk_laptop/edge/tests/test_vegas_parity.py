"""The rebuilt Vegas Destination tag (spec §4.11, §6): a Label Station
prints the portal's bytes. Three sync-shaped assets with different values
go through the edge's own plan and render (`generate.render_job`), and each
label must equal `render_template` over `field_values(item, label_context)`,
the portal's path from the same sync row (api/tests/test_builtin_templates.py
pins the portal's database path to that one)."""

from types import SimpleNamespace

import pytest
from serversherpa.labels.fields import field_values
from serversherpa.labels.render import render_template
from tests.test_label_generate import VEGAS, VEGAS_CONTEXT, _seed, _sync_item, _template

from edge.labels import generate

ITEMS = [
    # the portal's mock values: a five-piece location, RU 12
    _sync_item(),
    # a sixth piece (ignored), no destination RU, a name longer than its box
    _sync_item(id="a-2", asset_id="100417", legacy_id=100417,
               name="vegas-db-primary-0417.prod.example.internal",
               serial_number="CZ2041-0417-XL", destination_rack="09.02.11A.04.17.41",
               destination_ru=None, destination_ru_raw=None),
    # a two-piece location (the rest blank) and a half RU
    _sync_item(id="a-3", asset_id="100418", legacy_id=100418, name="sw-3",
               make_model="Arista 7050X", destination_rack="14.3",
               destination_ru="3.5", destination_ru_raw="3.50"),
]


def _vegas_child(dpi: str) -> dict:
    """The Vegas fixture as the template sync sends a builder child."""
    return {**_template(f"vegas-{dpi}", family="Vegas Destination", dpi=dpi, design=VEGAS),
            "name": f"Vegas Destination · {dpi}", "schema_version": 2}


@pytest.mark.parametrize("dpi", ["203", "300", "600"])
def test_three_assets_print_the_portal_bytes(app, dpi):
    store = _seed(app, dpi=int(dpi), assets=ITEMS, templates=[_vegas_child(dpi)],
                  context=VEGAS_CONTEXT)
    plan = generate.build_plan(store)
    assert plan.template.id == f"vegas-{dpi}"
    jobs = {job.asset_id: job for job in plan.assets}
    assert sorted(jobs) == ["a-1", "a-2", "a-3"]
    source = SimpleNamespace(kind="design", code=None, design=VEGAS, language_key="zpl")
    for item in ITEMS:
        expected, unknown = render_template(source, field_values(item, VEGAS_CONTEXT),
                                            width_in=4.0, height_in=2.0, dots=int(dpi))
        zpl, error = generate.render_job(plan.template_json, jobs[item["id"]])
        assert error is None and unknown == set(), item["id"]
        assert zpl == expected, item["id"]


def test_what_each_asset_prints_at_300(app):
    store = _seed(app, dpi=300, assets=ITEMS, templates=[_vegas_child("300")],
                  context=VEGAS_CONTEXT)
    plan = generate.build_plan(store)
    zpl = {job.asset_id: generate.render_job(plan.template_json, job)[0] for job in plan.assets}

    # five pieces, NAP to rack, and the RU boxed
    for anchor in ("^FT10,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD14^FS",
                   "^FT400,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS",
                   "^FO1030,18^GB165,92,92^FS",
                   "^FT1050,100^A@N,100,100,E:TT0003M_.TTF^FR^FH_^FD12^FS",
                   "^FO1000,148^BQN,2,7^FH_^FDMA,100000^FS"):
        assert anchor in zpl["a-1"], anchor

    # the sixth piece is ignored; a blank RU prints no box; the long name
    # prints whole (it spills past its box, which the builder shows in red)
    two = zpl["a-2"]
    assert "^FD41^FS" not in two
    assert "^FT850,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD17^FS" in two
    assert "^GB165,92,92" in two and "^FO1030,18^" not in two and "^FT1050,100^" not in two
    assert "^FDvegas-db-primary-0417.prod.example.internal^FS" in two
    assert "^FO1000,148^BQN,2,7^FH_^FDMA,100417^FS" in two

    # two pieces: NAP and Sector print, the rest are blank (an inverted
    # blank prints nothing); the half RU pads its integer part
    three = zpl["a-3"]
    assert "^FT10,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD14^FS" in three
    assert "^FT210,100^A@N,100,100,E:TT0003M_.TTF^FR^FH_^FD3^FS" in three
    assert "^FT400,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD^FS" in three
    assert "^FO630,18^" not in three and "^FT650,100^" not in three
    assert "^FT1050,100^A@N,100,100,E:TT0003M_.TTF^FR^FH_^FD03.5^FS" in three
