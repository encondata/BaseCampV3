"""Element-model parser: happy path, per-element problems, token helpers."""

import pytest

from serversherpa.labels.model import DesignError, Design, TextEl, parse_design
from serversherpa.labels.tokens import apply_placeholders, resolve_tokens

GOOD = {
    "size": {"w": 4, "h": 2},
    "elements": [
        {"id": "t1", "type": "text", "x": 0.25, "y": 0.5, "w": 2, "h": 0.3,
         "rotation": 0, "content": "Hello", "fontSizePt": 12,
         "bold": False, "align": "left"},
        {"id": "b1", "type": "barcode", "x": 0.1, "y": 0.6, "w": 3, "h": 0.8,
         "rotation": 0, "symbology": "code128", "data": "{asset_id}",
         "showText": True},
        {"id": "q1", "type": "qr", "x": 3.2, "y": 0.2, "w": 0.7, "h": 0.7,
         "rotation": 0, "data": "{asset_id}"},
        {"id": "l1", "type": "line", "x": 0, "y": 0.5, "w": 4, "h": 0,
         "rotation": 0, "strokeIn": 0.01},
        {"id": "x1", "type": "box", "x": 0.05, "y": 0.05, "w": 3.9, "h": 1.9,
         "rotation": 0, "strokeIn": 0.02},
    ],
}


def test_parse_happy_path():
    d = parse_design(GOOD)
    assert isinstance(d, Design)
    assert (d.width_in, d.height_in) == (4, 2)
    assert len(d.elements) == 5
    t = d.elements[0]
    assert isinstance(t, TextEl)
    assert (t.font_size_pt, t.align, t.rotation) == (12, "left", 0)


def test_parse_collects_per_element_problems():
    bad = {"size": {"w": 4, "h": 2}, "elements": [
        {"id": "t1", "type": "text", "x": -1, "y": 0, "w": 1, "h": 0.3,
         "rotation": 45, "content": "x", "fontSizePt": 0,
         "bold": False, "align": "middle"},
        {"id": "b1", "type": "barcode", "x": 0, "y": 0, "w": 1, "h": 0.5,
         "rotation": 0, "symbology": "upc", "data": "1", "showText": True},
        {"id": "z1", "type": "sticker", "x": 0, "y": 0, "w": 1, "h": 1},
    ]}
    with pytest.raises(DesignError) as exc:
        parse_design(bad)
    joined = "\n".join(exc.value.problems)
    for frag in ("t1", "x must be", "rotation", "fontSizePt", "align",
                 "b1", "symbology", "z1", "unknown type"):
        assert frag in joined, frag


def test_parse_rejects_bad_shell():
    with pytest.raises(DesignError):
        parse_design({"elements": []})
    with pytest.raises(DesignError):
        parse_design({"size": {"w": 0, "h": 2}, "elements": []})
    with pytest.raises(DesignError):
        parse_design({"size": {"w": 4, "h": 2}, "elements": "no"})


def test_token_helpers():
    assert resolve_tokens("SN {serial_number}", None) == "SN {serial_number}"
    assert resolve_tokens("SN {serial_number}",
                          {"serial_number": "C7X"}) == "SN C7X"
    assert resolve_tokens("SN {unknown}", {}) == "SN "
    assert apply_placeholders("^FD{a}-{b}^FS", {"a": "1"}) == "^FD1-^FS"


def test_new_text_properties_default_off():
    d = parse_design({"size": {"w": 4, "h": 2}, "elements": [
        {"id": "t1", "type": "text", "x": 0, "y": 0, "w": 2, "h": 0.3,
         "rotation": 0, "content": "x", "fontSizePt": 10,
         "bold": False, "align": "left"}]})
    assert d.elements[0].reverse is False
    assert d.elements[0].lines == 1


def test_lines_must_be_a_positive_integer():
    with pytest.raises(DesignError) as err:
        parse_design({"size": {"w": 4, "h": 2}, "elements": [
            {"id": "t1", "type": "text", "x": 0, "y": 0, "w": 2, "h": 0.3,
             "rotation": 0, "content": "x", "fontSizePt": 10, "bold": False,
             "align": "left", "lines": 0}]})
    assert any("lines" in p for p in err.value.problems)


def test_module_in_must_be_positive_when_present():
    with pytest.raises(DesignError) as err:
        parse_design({"size": {"w": 4, "h": 2}, "elements": [
            {"id": "b1", "type": "barcode", "x": 0, "y": 0, "w": 2, "h": 0.5,
             "rotation": 0, "symbology": "code128", "data": "A",
             "showText": True, "moduleIn": 0}]})
    assert any("moduleIn" in p for p in err.value.problems)


def test_module_in_defaults_to_none():
    d = parse_design({"size": {"w": 4, "h": 2}, "elements": [
        {"id": "b1", "type": "barcode", "x": 0, "y": 0, "w": 2, "h": 0.5,
         "rotation": 0, "symbology": "code128", "data": "A",
         "showText": True}]})
    assert d.elements[0].module_in is None
