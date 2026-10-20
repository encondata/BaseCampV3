"""The v2 ZPL compiler: ^FT baselines, named TrueType fonts, inverted
boxes, faux bold, Split pieces and per-field rules. Numbers assume
round(v * dpi) with Python rounding."""

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

import serversherpa.labels as labels_pkg
from serversherpa.labels.brother_escp import compile_escp
from serversherpa.labels.brother_ptouch import compile_ptouch
from serversherpa.labels.fields import MOCK_VALUES
from serversherpa.labels.fonts import font_object
from serversherpa.labels.model import parse_design
from serversherpa.labels.qr import qr_modules
from serversherpa.labels.render import render_template
from serversherpa.labels.zpl import compile_zpl

FIXTURES = Path(labels_pkg.__file__).parent / "fixtures"
VEGAS = json.loads((FIXTURES / "vegas_v2.json").read_text())
RACK = {"destination_rack": "14.01.07C.02.03"}
SPLITS = {"destination_rack": {"pieces": ["NAP", "Sector", "POD", "Row", "Rack"]}}
SWISS = {"family": "swiss721-cond-bold", "weight": "regular"}
HEAD = ["^XA", "^PW1200", "^LL600", "^CI28"]
PAD_20_10 = {"x": 0.0667, "y": 0.0333}  # 20 / 10 dots at 300


def _field(**kw):
    """The Vegas POD cell: x 400, top 28, 150 wide, baseline 100 (300 dpi)."""
    el = {"id": "f1", "type": "field", "field": "destination_rack", "piece": 2,
          "x": 1.3333, "y": 0.0933, "w": 0.5, "h": 0.24, "rotation": 0,
          "display": "text", "font": SWISS, "sizePt": 24, "baselineIn": 0.24,
          "align": "left"}
    el.update(kw)
    return el


def _zpl(*elements, values=RACK, dpi=300, splits=SPLITS, **kw):
    design = parse_design({"schema": 2, "size": {"w": 4, "h": 2}, "splits": splits,
                           "elements": list(elements)})
    return compile_zpl(design, dpi, values, **kw)


def _body(out: str) -> list[str]:
    lines = out.split("\n")
    assert lines[:4] == ["^XA", f"^PW{lines[1][3:]}", f"^LL{lines[2][3:]}", "^CI28"]
    assert lines[-1] == "^XZ"
    return lines[4:-1]


def _data(out: str) -> list[str]:
    return re.findall(r"\^FD(.*?)\^FS", out)


def test_field_text_uses_ft_baseline_and_named_font():
    out = _zpl(_field())
    assert out.split("\n") == [
        *HEAD, "^FT400,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS", "^XZ"]


def test_center_alignment_uses_fb():
    assert _body(_zpl(_field(align="center"))) == [
        "^FT400,100^FB150,1,0,C,0^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS"]
    assert "^FB150,1,0,R,0^A@" in _zpl(_field(align="right"))
    assert "^FB" not in _zpl(_field(align="left"))


def test_inverted_emits_box_then_reverse():
    body = _body(_zpl(_field(inverted=True, invertPad=PAD_20_10)))
    # the box is the reserved box (400..550 x 28..100) plus 20 / 10 dots
    assert body == [
        "^FO380,18^GB190,92,92^FS",
        "^FT400,100^A@N,100,100,E:TT0003M_.TTF^FR^FH_^FD07C^FS"]


def test_inverted_blank_prints_nothing():
    for values in ({}, {"destination_rack": "ORD1-F01"}, {"destination_rack": "14.01..02"}):
        assert _body(_zpl(_field(inverted=True), values=values)) == []
    # a static caption with no text is blank too
    caption = {"id": "t1", "type": "text", "content": "", "font": SWISS, "sizePt": 24,
               "baselineIn": 0.24, "inverted": True, "x": 0, "y": 0, "w": 1, "h": 0.24,
               "rotation": 0}
    assert _body(_zpl(caption)) == []


def test_faux_bold_overprints_one_dot():
    bold = {"family": "swiss721-cond-bold", "weight": "bold"}
    assert _body(_zpl(_field(font=bold))) == [
        "^FT400,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS",
        "^FT401,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS"]
    # a family with a Bold file uses it: one pass, the bold object
    assert _body(_zpl(_field(font={"family": "roboto-condensed", "weight": "bold"}))) == [
        "^FT400,100^A@N,100,100,E:ROBOCO_B.TTF^FH_^FD07C^FS"]
    assert "E:ROBOCO_R.TTF" in _zpl(_field(font={"family": "roboto-condensed",
                                                 "weight": "regular"}))
    # the library can lack a family's Bold file: then Bold is faux there too
    out = _zpl(_field(font={"family": "roboto-condensed", "weight": "bold"}),
               font_objects={"roboto-condensed": {"regular": "ROBOCO_R.TTF", "bold": None}})
    assert _body(out) == [
        "^FT400,100^A@N,100,100,E:ROBOCO_R.TTF^FH_^FD07C^FS",
        "^FT401,100^A@N,100,100,E:ROBOCO_R.TTF^FH_^FD07C^FS"]


def test_faux_bold_on_inverted_widens():
    bold = {"family": "swiss721-cond-bold", "weight": "bold"}
    body = _body(_zpl(_field(font=bold, inverted=True, invertPad=PAD_20_10)))
    # two reversed passes would cancel, so one pass with 15% wider glyphs
    assert body == [
        "^FO380,18^GB190,92,92^FS",
        "^FT400,100^A@N,100,115,E:TT0003M_.TTF^FR^FH_^FD07C^FS"]


def test_number_padding_and_split_pieces():
    pieces = [_field(id=f"p{i}", piece=i, maxChars=None, expectedLength=None)
              for i in range(5)]
    ru = _field(id="ru", field="destination_ru", piece=None, display="number",
                expectedLength=2)
    out = _zpl(*pieces, ru, values={**RACK, "destination_ru": "3.5"})
    assert _data(out) == ["14", "01", "07C", "02", "03", "03.5"]
    # the rules' JSON keys reach the pipeline: strip 0s, keep the last 3
    rules = _field(id="r", field="asset_id", piece=None, strip="0", stripWhere=None,
                   maxChars=3, trim="front")
    assert _data(_zpl(rules, values={"asset_id": "000123456"})) == ["456"]
    # extra pieces are ignored; missing pieces print blank
    assert _data(_zpl(*pieces, values={"destination_rack": "A.B.C.D.E.F"})) == [
        "A", "B", "C", "D", "E"]
    assert _data(_zpl(*pieces, values={"destination_rack": "ORD1-F01"})) == [
        "ORD1-F01", "", "", "", ""]


def test_hide_when_empty():
    hidden = _field(hideWhenEmpty=True)
    assert _body(_zpl(hidden, values={"destination_rack": "ORD1-F01"})) == []
    assert _data(_zpl(hidden)) == ["07C"]
    # blank after Strip counts as empty
    stripped = _field(field="asset_id", piece=None, strip="0", hideWhenEmpty=True,
                      maxChars=None)
    assert _body(_zpl(stripped, values={"asset_id": "000"})) == []
    # without the flag a blank value still emits its (empty) field
    assert _data(_zpl(_field(), values={})) == [""]
    # data elements bound to a field hide too
    code = {"id": "b1", "type": "barcode", "field": "asset_id", "symbology": "code128",
            "hideWhenEmpty": True, "x": 0, "y": 0, "w": 1, "h": 0.2, "rotation": 0}
    qr = {"id": "q1", "type": "qr", "field": "asset_id", "hideWhenEmpty": True,
          "x": 0, "y": 0, "w": 0.5, "h": 0.5, "rotation": 0}
    assert _body(_zpl(code, qr, values={"asset_id": ""})) == []
    assert len(_body(_zpl(code, qr, values={"asset_id": "1"}))) == 2


def test_qr_uses_mode_m_and_caps_magnification_at_10():
    qr = {"id": "q1", "type": "qr", "field": "asset_id", "x": 1, "y": 0.5,
          "w": 0.49, "h": 0.49, "rotation": 0}
    values = {"asset_id": "100000"}
    # 147 dots / 21 modules = 7 at 300
    assert _body(_zpl(qr, values=values)) == ["^FO300,150^BQN,2,7^FH_^FDMA,100000^FS"]
    # 294 / 21 = 14 at 600: capped at 10 (210 dots), centered in the 294-dot box
    assert _body(_zpl(qr, values=values, dpi=600)) == [
        "^FO642,342^BQN,2,10^FH_^FDMA,100000^FS"]
    # 26 alphanumerics need version 2 (25 modules): 147 / 25 -> 6,
    # 150 dots, centered over the 147-dot box
    long = "X" * 26
    assert _body(_zpl(qr, values={"asset_id": long})) == [
        f"^FO298,148^BQN,2,6^FH_^FDMA,{long}^FS"]
    # 14 x é is 28 UTF-8 bytes: version 3 (29 modules): 147 / 29 -> 5,
    # 145 dots, one dot in from each side; ^FH_ hex-escapes every byte
    accents = "é" * 14
    assert _body(_zpl(qr, values={"asset_id": accents})) == [
        "^FO301,151^BQN,2,5^FH_^FDMA," + "_c3_a9" * 14 + "^FS"]
    # static data works the same way
    static = {k: v for k, v in qr.items() if k != "field"} | {"data": "HELLO"}
    assert _body(_zpl(static, values={})) == ["^FO300,150^BQN,2,7^FH_^FDMA,HELLO^FS"]


def test_qr_modules_pick_the_smallest_version_at_level_m():
    assert qr_modules("10482") == 21                 # numeric, v1 holds 34
    assert qr_modules("0" * 34) == 21
    assert qr_modules("0" * 35) == 25                # v2 holds 63
    assert qr_modules("RACK-14 $%*+./:") == 21       # alphanumeric, v1 holds 20
    assert qr_modules("A" * 21) == 25
    assert qr_modules("sample-server-1") == 25       # 15 lowercase: byte, v1 holds 14
    assert qr_modules("s" * 14) == 21
    assert qr_modules("é" * 7) == 21                 # 14 bytes
    assert qr_modules("é" * 14) == 29                # 28 bytes: v3 holds 42
    assert qr_modules("") == 21
    assert qr_modules("0" * 513) == 57               # v10 (17 + 4 x 10)
    assert qr_modules("٣" * 20) == 29                # non-ASCII digits are bytes (40), not numeric
    with pytest.raises(ValueError):
        qr_modules("x" * 214)                        # beyond v10's 213 bytes


def test_qr_always_prints_upright():
    """^BQ has one orientation (N); the rotation stays in the model for the
    canvas, and a square symbol looks the same either way."""
    for rotation in (90, 180, 270):
        qr = {"id": "q1", "type": "qr", "field": "asset_id", "x": 1, "y": 0.5,
              "w": 0.49, "h": 0.49, "rotation": rotation}
        assert _body(_zpl(qr, values={"asset_id": "100000"})) == [
            "^FO300,150^BQN,2,7^FH_^FDMA,100000^FS"]
        as_field = _field(display="qr", w=0.49, h=0.49, rotation=rotation)
        assert "^BQN,2,7^" in _zpl(as_field)


def test_font_object_names_are_checked_before_they_are_emitted():
    for bad in ("../x.TTF", "TOOLONGNAME.TTF", "rob_r.ttf", "X^XZ.TTF", "ROBO.OTF", ".TTF"):
        with pytest.raises(ValueError, match="font object"):
            _zpl(_field(font={"family": "roboto", "weight": "regular"}),
                 font_objects={"roboto": {"regular": bad, "bold": None}})
        with pytest.raises(ValueError, match="font object"):
            font_object("roboto", "bold", objects={"regular": "ROBOTO_R.TTF", "bold": bad})
    with pytest.raises(ValueError, match="regular"):
        _zpl(_field(font={"family": "roboto", "weight": "bold"}),
             font_objects={"roboto": {"bold": "ROBOTO_B.TTF"}})
    # every built-in family's objects pass
    assert font_object("swiss721-cond-bold", "regular") == ("TT0003M_.TTF", False)


def test_values_are_hex_escaped():
    nasty = "X^XZ~JR"
    out = _zpl(_field(field="asset_name", piece=None, maxChars=None),
               {"id": "q1", "type": "qr", "field": "asset_name", "x": 1, "y": 0.5,
                "w": 0.49, "h": 0.49, "rotation": 0},
               {"id": "b1", "type": "barcode", "field": "asset_name",
                "symbology": "code128", "x": 0, "y": 1, "w": 2, "h": 0.2, "rotation": 0},
               {"id": "t1", "type": "text", "content": "a_b\\c", "font": SWISS,
                "sizePt": 10, "baselineIn": 0.1, "x": 0, "y": 1.5, "w": 1, "h": 0.1,
                "rotation": 0},
               values={"asset_name": nasty})
    assert _data(out) == ["X_5eXZ_7eJR", "MA,X_5eXZ_7eJR", "X_5eXZ_7eJR", "a_5fb_5cc"]
    assert out.count("^XZ") == 1 and "~JR" not in out
    # v2 values are never token-expanded: `{asset_id}` prints as itself
    # (its `_` hex-escaped), never as asset_id's value
    assert _data(_zpl(_field(field="asset_name", piece=None, maxChars=None),
                      values={"asset_name": "{asset_id}", "asset_id": "1"})) == ["{asset_5fid}"]


def test_field_keys_are_opaque():
    key = 'ft:Rack.Loc "A"'
    splits = {key: {"pieces": ["Rack", "Loc"]}}
    out = _zpl(_field(field=key, piece=None, maxChars=None),
               _field(id="f2", field=key, piece=1, maxChars=None),
               values={key: "R1.L2"}, splits=splits)
    assert _data(out) == ["R1.L2", "L2"]


def test_rotated_text_anchors_on_its_baseline():
    """x, y is the top-left of the element's footprint on the label; w runs
    along the text and h across it, so a 90/270 element is h wide, w tall."""
    side = _field(field="move_date", piece=None, maxChars=None, expectedLength=None,
                  rotation=270, x=3.7587, y=1.1, w=0.8333, h=0.108, sizePt=10.8,
                  baselineIn=0.108)
    values = {"move_date": "09/01/2026"}
    # 270 reads upward from the bottom: baseline x + b, start y + w
    assert _body(_zpl(side, values=values)) == [
        "^FT1160,580^A@B,45,45,E:TT0003M_.TTF^FH_^FD09/01/2026^FS"]
    # faux bold overprints along the reading direction (up, for 270)
    bold = {**side, "font": {"family": "swiss721-cond-bold", "weight": "bold"}}
    assert [line[:12] for line in _body(_zpl(bold, values=values))] == [
        "^FT1160,580^", "^FT1160,579^"]
    # the inverted box turns with the element: 32 + 2 x 10 wide, 250 + 2 x 20 tall
    inv = {**side, "inverted": True, "invertPad": PAD_20_10}
    assert _body(_zpl(inv, values=values))[0] == "^FO1118,310^GB52,290,52^FS"
    # 90 reads downward with the glyph tops to the right: x + h - b, y
    down = _field(rotation=90, x=1, y=0.5, w=1, h=0.3, baselineIn=0.2)
    assert "^FT330,150^A@R,100,100," in _zpl(down)
    # 180 is upside down, starting at the right: x + w, y + h - b
    upside = _field(rotation=180, x=1, y=0.5, w=1, h=0.3, baselineIn=0.2)
    assert "^FT600,180^A@I,100,100," in _zpl(upside)


def test_static_text_and_shapes():
    caption = {"id": "t1", "type": "text", "content": "Name:", "font": SWISS,
               "sizePt": 10.08, "baselineIn": 0.1008, "x": 0.1267, "y": 0.4759,
               "w": 0.4667, "h": 0.1008, "rotation": 0}
    wrapped = {**caption, "id": "t2", "lines": 2, "content": "Two lines"}
    line = {"id": "l1", "type": "line", "strokeIn": 0.017, "x": 0.1, "y": 1,
            "w": 3.7, "h": 0, "rotation": 0}
    upright = {**line, "id": "l2", "w": 1, "rotation": 90}
    box = {"id": "x1", "type": "box", "strokeIn": 0.01, "x": 0.1, "y": 1.2,
           "w": 1, "h": 0.2, "rotation": 0}
    filled = {**box, "id": "x2", "fill": True}
    assert _body(_zpl(caption, wrapped, line, upright, box, filled, values={})) == [
        "^FT38,173^A@N,42,42,E:TT0003M_.TTF^FH_^FDName:^FS",
        # multi-line static text wraps in a ^FB; ^FT then marks the last
        # line's baseline, one font height per line further down
        "^FT38,215^FB140,2,0,L,0^A@N,42,42,E:TT0003M_.TTF^FH_^FDTwo lines^FS",
        "^FO30,300^GB1110,5,5^FS",
        "^FO30,300^GB5,300,5^FS",
        "^FO30,360^GB300,60,3^FS",
        "^FO30,360^GB300,60,60^FS"]


def test_field_displayed_as_barcode_or_qr_applies_its_rules():
    code = _field(display="barcode", symbology="code128", moduleIn=0.0133, showText=False,
                  h=0.1667)
    qr = _field(id="f2", display="qr", w=0.49, h=0.49)
    assert _body(_zpl(code, qr)) == [
        "^FO400,28^BY4^BCN,50,N,N,N^FH_^FD07C^FS",
        "^FO400,28^BQN,2,7^FH_^FDMA,07C^FS"]


def test_v2_needs_values():
    with pytest.raises(ValueError, match="v2 designs render with values"):
        _zpl(_field(), values=None)


def test_render_template_passes_values_for_v2():
    design = {"schema": 2, "size": {"w": 1, "h": 1}, "splits": SPLITS, "elements": [
        _field(),
        {"id": "b1", "type": "barcode", "field": "asset_id", "symbology": "code128",
         "x": 0, "y": 1, "w": 2, "h": 0.2, "rotation": 0}]}
    template = SimpleNamespace(kind="design", code=None, design=design, language_key="zpl")
    code, unknown = render_template(template, RACK, width_in=4, height_in=2, dots=300)
    assert code == compile_zpl(parse_design({**design, "size": {"w": 4, "h": 2}}), 300, RACK)
    assert "^FD07C^FS" in code
    assert unknown == {"asset_id"}


def test_vegas_fixture_renders_to_golden():
    out = compile_zpl(parse_design(VEGAS), 300, MOCK_VALUES)
    # every anchor lands where the recon's layout puts it
    for anchor in ("^FT10,100^", "^FO190,18^GB165,92,92^FS", "^FT210,100^", "^FT400,100^",
                   "^FO630,18^GB165,92,92^FS", "^FT650,100^", "^FT850,100^",
                   "^FO1030,18^GB165,92,92^FS", "^FT1050,100^",
                   "^FT38,173^", "^FT185,173^", "^FT38,220^", "^FT185,220^",
                   "^FT38,270^", "^FT185,270^", "^FO38,295^GB1120,5,5^FS",
                   "^FT38,351^", "^FT185,351^", "^FT627,351^", "^FT790,351^",
                   "^FT38,420^", "^FT185,420^", "^FT627,420^", "^FT790,420^",
                   "^FT38,489^", "^FT185,489^", "^FT627,489^", "^FT790,489^",
                   "^FO440,500^BY4^BCN,50,Y,N,N^", "^FO1000,148^BQN,2,7^",
                   "^FT1120,580^A@B,45,45,", "^FT1160,580^A@B,45,45,"):
        assert anchor in out, anchor
    assert out + "\n" == (FIXTURES / "vegas_v2_300.zpl").read_text()


def test_brother_compilers_accept_v2():
    design = parse_design(VEGAS)
    escp = compile_escp(design, MOCK_VALUES)
    ptouch = compile_ptouch(design, MOCK_VALUES)
    for out in (escp, ptouch):
        for text in ("07C", "SAMPLE-SERVER-01", "Name:", "100000", "SITE-A"):
            assert text in out, text
    with pytest.raises(ValueError):
        compile_escp(design)
    with pytest.raises(ValueError):
        compile_ptouch(design)
