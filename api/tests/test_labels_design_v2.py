"""Design schema v2: the parser keeps v1 as it was and validates the
builder's elements (fields with Split pieces and rules, fonts, inverted)."""

import json
from pathlib import Path

import pytest

import serversherpa.labels as labels_pkg
from serversherpa.labels.model import (
    BarcodeEl, BoxEl, DesignError, FieldEl, Font, LineEl, Pad, QrEl, TextEl,
    parse_design,
)

VEGAS = json.loads((Path(labels_pkg.__file__).parent / "fixtures" / "vegas_v2.json").read_text())

V1 = {"size": {"w": 4, "h": 2}, "elements": [
    {"id": "t1", "type": "text", "x": 0.25, "y": 0.5, "w": 2, "h": 0.3,
     "rotation": 0, "content": "Hello {asset_id}", "fontSizePt": 12,
     "bold": True, "align": "left"},
    {"id": "b1", "type": "barcode", "x": 0.1, "y": 0.6, "w": 3, "h": 0.8,
     "rotation": 0, "symbology": "code128", "data": "{asset_id}", "showText": True},
    {"id": "x1", "type": "box", "x": 0.05, "y": 0.05, "w": 3.9, "h": 1.9,
     "rotation": 0, "strokeIn": 0.02}]}

SPLITS = {"destination_rack": {"pieces": ["NAP", "Sector", "POD", "Row", "Rack"]}}
SWISS = {"family": "swiss721-cond-bold", "weight": "regular"}


def _field(**kw):
    el = {"id": "f1", "type": "field", "field": "destination_rack", "piece": 2,
          "x": 1.3333, "y": 0.0933, "w": 0.5, "h": 0.24, "rotation": 0,
          "locked": False, "hideWhenEmpty": False, "display": "text", "font": SWISS,
          "sizePt": 24, "baselineIn": 0.24, "inverted": False,
          "expectedLength": 3, "align": "left", "maxChars": 3, "trim": "rear",
          "strip": None, "stripWhere": "front"}
    el.update(kw)
    return el


def _v2(*elements, splits=SPLITS):
    return {"schema": 2, "size": {"w": 4, "h": 2}, "splits": splits,
            "elements": list(elements)}


def test_v1_designs_still_parse():
    for raw in (V1, {**V1, "schema": 1}):
        d = parse_design(raw)
        assert d.schema == 1 and d.splits == {}
        t, b, x = d.elements
        assert isinstance(t, TextEl) and t.bold and t.content == "Hello {asset_id}"
        assert (t.font, t.baseline_in, t.inverted, t.invert_pad) == (None, None, False, None)
        assert isinstance(b, BarcodeEl) and b.data == "{asset_id}" and b.field is None
        assert isinstance(x, BoxEl) and x.fill is False
    # the builder's element types stay schema 2 only
    with pytest.raises(DesignError) as exc:
        parse_design({**V1, "elements": [_field()]})
    assert "unknown type 'field'" in str(exc.value)


def test_v2_parses_every_element_type():
    d = parse_design(_v2(
        _field(),
        _field(id="f2", field="asset_id", piece=None, display="barcode",
               symbology="code39", moduleIn=0.01, showText=False, hideWhenEmpty=True),
        _field(id="f3", field="ft:Rack.Loc \"A\"", piece=None, display="qr"),
        {"id": "t1", "type": "text", "content": "Name:", "font": SWISS, "sizePt": 10,
         "baselineIn": 0.1, "inverted": True, "align": "center", "lines": 1,
         "x": 0.1, "y": 0.5, "w": 0.5, "h": 0.1, "rotation": 0},
        {"id": "b1", "type": "barcode", "field": "asset_id", "symbology": "code128",
         "moduleIn": 0.0133, "showText": True, "x": 1.4, "y": 1.6, "w": 1.1,
         "h": 0.17, "rotation": 0},
        {"id": "b2", "type": "barcode", "data": "STATIC", "symbology": "code128",
         "x": 1.4, "y": 1.6, "w": 1.1, "h": 0.17, "rotation": 0},
        {"id": "q1", "type": "qr", "field": "asset_id", "x": 3.3, "y": 0.5,
         "w": 0.49, "h": 0.49, "rotation": 0},
        {"id": "l1", "type": "line", "strokeIn": 0.017, "x": 0.1, "y": 1,
         "w": 3.7, "h": 0, "rotation": 0},
        {"id": "x1", "type": "box", "strokeIn": 0.01, "fill": True, "x": 0.1,
         "y": 1.2, "w": 1, "h": 0.2, "rotation": 0}))
    assert d.schema == 2
    assert d.splits == {"destination_rack": ("NAP", "Sector", "POD", "Row", "Rack")}
    f1, f2, f3, t1, b1, b2, q1, l1, x1 = d.elements

    assert isinstance(f1, FieldEl)
    assert (f1.field, f1.piece, f1.display) == ("destination_rack", 2, "text")
    assert f1.font == Font("swiss721-cond-bold", "regular")
    assert (f1.font_size_pt, f1.baseline_in, f1.inverted) == (24, 0.24, False)
    assert f1.rules == {"display": "text", "expected_length": 3, "max_chars": 3,
                        "trim": "rear", "strip_where": "front"}
    # an element without a pad gets the default: a quarter of the font size
    # along the text, a tenth across it
    assert f1.invert_pad == Pad(x=0.25 * 24 / 72, y=0.10 * 24 / 72)

    assert (f2.display, f2.symbology, f2.module_in, f2.show_text) == ("barcode", "code39", 0.01, False)
    assert f2.hide_when_empty is True and f2.piece is None
    assert (f3.field, f3.display) == ("ft:Rack.Loc \"A\"", "qr")  # keys are opaque

    assert isinstance(t1, TextEl)
    assert (t1.content, t1.font_size_pt, t1.align, t1.baseline_in) == ("Name:", 10, "center", 0.1)
    assert t1.font == Font("swiss721-cond-bold", "regular") and t1.inverted is True
    assert t1.reverse is False and t1.bold is False

    assert isinstance(b1, BarcodeEl) and (b1.field, b1.data, b1.module_in) == ("asset_id", "", 0.0133)
    assert isinstance(b2, BarcodeEl) and (b2.field, b2.data) == (None, "STATIC")
    assert isinstance(q1, QrEl) and q1.field == "asset_id"
    assert isinstance(l1, LineEl) and l1.stroke_in == 0.017
    assert isinstance(x1, BoxEl) and x1.fill is True

    vegas = parse_design(VEGAS)
    assert vegas.schema == 2 and len(vegas.elements) == len(VEGAS["elements"])


def test_v2_rejects_unknown_piece_and_bad_rules():
    cases = [
        (_field(piece=5), "piece"),                        # 5 pieces: 0..4
        (_field(field="asset_name"), "piece"),             # no Split for the field
        (_field(maxChars=0), "maxChars"),
        (_field(expectedLength=0), "expectedLength"),
        (_field(trim="middle"), "trim"),
        (_field(stripWhere="inside"), "stripWhere"),
        (_field(display="date"), "display"),
        (_field(font={"family": "comic-sans", "weight": "regular"}), "font"),
        (_field(font={"family": "roboto", "weight": "light"}), "font"),
        (_field(sizePt=0), "sizePt"),
        (_field(baselineIn=None), "baselineIn"),
        (_field(field=""), "field"),
        (_field(invertPad={"x": -1, "y": 0}), "invertPad"),
        ({"id": "b1", "type": "barcode", "symbology": "code128", "x": 0, "y": 0,
          "w": 1, "h": 0.2, "rotation": 0}, "field or data"),
        ({"id": "q1", "type": "qr", "field": "asset_id", "data": "X", "x": 0, "y": 0,
          "w": 0.5, "h": 0.5, "rotation": 0}, "field or data"),
    ]
    for el, fragment in cases:
        with pytest.raises(DesignError) as exc:
            parse_design(_v2(el))
        assert fragment in str(exc.value), (el, str(exc.value))

    with pytest.raises(DesignError) as exc:
        parse_design(_v2(_field(), splits={"destination_rack": {"pieces": []}}))
    assert "splits" in str(exc.value)


def test_schema_defaults_to_1():
    assert parse_design({"size": {"w": 1, "h": 1}, "elements": []}).schema == 1
    for bad in (3, 0, "2", True):
        with pytest.raises(DesignError) as exc:
            parse_design({"schema": bad, "size": {"w": 1, "h": 1}, "elements": []})
        assert "schema" in str(exc.value)


def test_counts_and_lines_are_bounded():
    """F1: expectedLength/maxChars pad and trim a value to that many
    characters, so an unbounded one makes every compile allocate it. Both
    stop at 64 and a text's lines at 50, on schema 1 as on schema 2."""
    for key, big in (("expectedLength", 10**9), ("maxChars", 65)):
        with pytest.raises(DesignError) as exc:
            parse_design(_v2(_field(**{key: big})))
        assert exc.value.problems == [f"f1: {key} must be at most 64"]
    text = {"id": "t1", "type": "text", "content": "a", "font": SWISS, "sizePt": 10,
            "baselineIn": 0.1, "x": 0, "y": 0, "w": 1, "h": 0.2, "rotation": 0}
    with pytest.raises(DesignError) as exc:
        parse_design(_v2({**text, "lines": 51}))
    assert exc.value.problems == ["t1: lines must be at most 50"]
    v1_text = {**V1["elements"][0], "lines": 10**6}
    with pytest.raises(DesignError) as exc:
        parse_design({**V1, "elements": [v1_text]})
    assert exc.value.problems == ["t1: lines must be at most 50"]
    # the bounds themselves are fine
    d = parse_design(_v2(_field(expectedLength=64, maxChars=64), {**text, "lines": 50}))
    assert (d.elements[0].expected_length, d.elements[0].max_chars) == (64, 64)
    assert d.elements[1].lines == 50
