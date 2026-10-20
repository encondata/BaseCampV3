"""Image elements in the shared label core (spec 2026-10-20-badge-templates
§4.3, §4.5, §4.6, §4.10, §4.12): the integer dither (labels/dither.py,
mirrored bit for bit by portal/src/labels/builder/dither.ts through
labels/fixtures/dither.json), Z64 `^GFA` graphics with banding, and the
schema 3 rules. Pure: no database.

Z64 goldens decode the graphic back to bits rather than comparing text,
because zlib's output may vary between builds (zlib-ng)."""

import base64
import binascii
import importlib.util
import json
import re
import zlib
from pathlib import Path
from types import SimpleNamespace

import pytest

import serversherpa.labels as labels_pkg
from serversherpa.labels import dither
from serversherpa.labels.brother_escp import compile_escp
from serversherpa.labels.brother_ptouch import compile_ptouch
from serversherpa.labels.compile import compile_design, compile_parsed_design
from serversherpa.labels.fields import design_field_keys
from serversherpa.labels.model import DesignError, FieldEl, ImageEl, parse_design
from serversherpa.labels.render import render_template
from serversherpa.labels.zpl import compile_zpl, crc16, image_box_dots, z64

FIXTURE = Path(labels_pkg.__file__).parent / "fixtures" / "dither.json"
# the builder canvas's parity fixture and its generator (written by the
# Python core, checked by portal/src/labels/builder/imageParity.test.ts)
IMAGE_PARITY = Path(__file__).resolve().parents[2] / "portal/src/labels/builder/fixtures"
SWISS = {"family": "swiss721-cond-bold", "weight": "regular"}
SPLITS = {"destination_rack": {"pieces": ["NAP", "Sector", "POD", "Row", "Rack"]}}
GFA = re.compile(r"\^FO(\d+),(\d+)\^GFA,(\d+),(\d+),(\d+),:Z64:([A-Za-z0-9+/=]*):([0-9A-F]{4})\^FS")


# ---- the fixture's inputs ----------------------------------------------

def _flat(value: int, width: int, height: int) -> bytes:
    return bytes([value]) * (width * height)


def _gradient(width: int, height: int) -> bytes:
    """Dark top-left to light bottom-right."""
    return bytes(((x * 255) // (width - 1) + (y * 255) // (height - 1)) // 2
                 for y in range(height) for x in range(width))


def _noise(width: int, height: int, seed: int) -> bytes:
    out = bytearray()
    for _ in range(width * height):
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        out.append((seed >> 16) & 0xFF)
    return bytes(out)


def _params(**kw) -> dict:
    return {"brightness": 0, "contrast": 100, "threshold": 128, "mode": "dither",
            "invert": False, **kw}


def fixture_inputs() -> list[dict]:
    """Every case's input. Odd widths leave pad bits; contrast 133 and
    brightness -55 or 37 make the LUT floor a negative or fractional
    quotient (Python `//`, never truncation); noise sends negative error."""
    g13, g64 = _gradient(13, 7), _gradient(64, 9)
    n31 = _noise(31, 11, 20261020)
    cases = []

    def add(name, width, height, gray, **params):
        cases.append({"name": name, "width": width, "height": height,
                      "params": _params(**params), "gray": gray.hex()})

    for value in (0, 128, 255):
        add(f"flat {value} dither", 10, 4, _flat(value, 10, 4))
        add(f"flat {value} threshold", 10, 4, _flat(value, 10, 4), mode="threshold")
    add("gradient 13x7 dither", 13, 7, g13)
    add("gradient 13x7 threshold", 13, 7, g13, mode="threshold")
    add("gradient 64x9 dither", 64, 9, g64)
    add("gradient 64x9 threshold", 64, 9, g64, mode="threshold")
    add("contrast 0", 13, 7, g13, contrast=0)
    add("contrast 300", 13, 7, g13, contrast=300)
    add("contrast 300 threshold", 64, 9, g64, contrast=300, mode="threshold")
    add("brightness 100", 13, 7, g13, brightness=100)
    add("brightness -100", 13, 7, g13, brightness=-100)
    add("brightness 37", 64, 9, g64, brightness=37)
    add("brightness -55 threshold", 64, 9, g64, brightness=-55, mode="threshold")
    add("invert dither", 13, 7, g13, invert=True)
    add("invert threshold", 64, 9, g64, invert=True, mode="threshold")
    add("threshold 1", 13, 7, g13, mode="threshold", threshold=1)
    add("threshold 254", 13, 7, g13, mode="threshold", threshold=254)
    add("noise 31x11 dither", 31, 11, n31)
    add("noise 31x11 contrast 133 brightness -55", 31, 11, n31, contrast=133, brightness=-55)
    add("noise 31x11 threshold 77 invert", 31, 11, n31, mode="threshold", threshold=77,
        invert=True)
    ramp = bytes(range(256))
    add("ramp threshold 60 brightness -55", 256, 1, ramp, mode="threshold", threshold=60,
        brightness=-55)
    add("ramp threshold 90 contrast 133", 256, 1, ramp, mode="threshold", threshold=90,
        contrast=133)
    add("ramp 256x3 dither contrast 77 brightness -13", 256, 3, ramp * 3, contrast=77,
        brightness=-13)
    add("one dot", 1, 1, bytes([127]))
    add("one column", 1, 9, _gradient(2, 9)[::2])
    add("empty", 0, 0, b"")
    return cases


# (brightness, contrast) tables pinned whole: the fixture's "luts"
LUT_INPUTS = [(0, 100), (0, 0), (0, 300), (0, 133), (0, 77), (-55, 100), (37, 100),
              (100, 100), (-100, 100), (-13, 77), (-55, 133), (61, 250), (-1, 1)]


def _p(params: dict) -> dither.Params:
    return dither.Params(**params)


def _fixture() -> list[dict]:
    return json.loads(FIXTURE.read_text())["cases"]


# ---- dither ------------------------------------------------------------

def test_dither_fixture():
    """Every case in dither.json (dither.test.ts reads the same file); the
    cases built here are all in it, unchanged. Later work may add cases."""
    cases = _fixture()
    by_name = {c["name"]: c for c in cases}
    assert len(by_name) == len(cases)
    for inputs in fixture_inputs():
        case = by_name[inputs["name"]]
        assert {k: case[k] for k in inputs} == inputs, inputs["name"]
    for case in cases:
        bits = dither.bitmap(bytes.fromhex(case["gray"]), case["width"], case["height"],
                             _p(case["params"]))
        assert bits.hex() == case["bits"], case["name"]
        assert len(bits) == dither.bytes_per_row(case["width"]) * case["height"]


def test_lut_fixture():
    """Every table in dither.json, whole (dither.test.ts checks ditherLut
    against the same rows)."""
    luts = json.loads(FIXTURE.read_text())["luts"]
    assert set(LUT_INPUTS) <= {(t["brightness"], t["contrast"]) for t in luts}
    for t in luts:
        assert dither.lut(t["brightness"], t["contrast"]).hex() == t["table"], t


def test_dither_hand_checked():
    """Worked by hand, so the fixture isn't only dither.py checking itself."""
    flat = dither.Params(brightness=0, contrast=100, threshold=128, mode="dither", invert=False)
    assert dither.bitmap(_flat(0, 13, 2), 13, 2, flat).hex() == "fff8" * 2   # pad bits stay 0
    assert dither.bitmap(_flat(255, 13, 2), 13, 2, flat).hex() == "0000" * 2
    inverted = dither.Params(0, 100, 128, "dither", True)
    assert dither.bitmap(_flat(255, 13, 1), 13, 1, inverted).hex() == "fff8"
    assert dither.bitmap(_flat(0, 13, 1), 13, 1, inverted).hex() == "0000"
    # Atkinson along one row of 100s: errors 12, 14, 15 carry right until
    # x3 reaches 129 (white, error (129 - 255) >> 3 = -16), then x4 is 99
    assert dither.bitmap(_flat(100, 5, 1), 5, 1, flat).hex() == "e8"
    # threshold: black below it, white at it
    logo = dither.Params(0, 100, 128, "threshold", False)
    assert dither.bitmap(bytes([127, 128, 0, 255]), 4, 1, logo).hex() == "a0"
    # brightness +100 whitens everything; contrast 0 is flat mid-gray
    assert dither.bitmap(_flat(0, 8, 1), 8, 1, dither.Params(100, 100, 128, "dither", False)) == b"\0"
    assert dither.bitmap(_gradient(13, 7), 13, 7, dither.Params(0, 0, 128, "dither", False)) \
        == dither.bitmap(_flat(128, 13, 7), 13, 7, flat)


def _reference_bits(gray: bytes, width: int, height: int, params: dict) -> bytes:
    """The pinned algorithm written out again from the plan, sharing nothing
    with dither.py: a grid of rows, every neighbor bounds-checked."""
    b, c = params["brightness"], params["contrast"]
    grid = [[min(255, max(0, ((gray[y * width + x] - 128) * c) // 100 + 128 + b * 255 // 100))
             for x in range(width)] for y in range(height)]
    black = [[False] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            if params["mode"] == "threshold":
                black[y][x] = grid[y][x] < params["threshold"]
                continue
            acc = grid[y][x]
            black[y][x] = acc < 128
            err = (acc - (0 if black[y][x] else 255)) >> 3
            for dx, dy in ((1, 0), (2, 0), (-1, 1), (0, 1), (1, 1), (0, 2)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height:
                    grid[ny][nx] += err
    out = bytearray()
    for row in black:
        bits = "".join("1" if dot != params["invert"] else "0" for dot in row)
        bits += "0" * (-len(bits) % 8)
        out += bytes(int(bits[i:i + 8], 2) for i in range(0, len(bits), 8))
    return bytes(out)


def test_dither_matches_a_naive_reference():
    """Every fixture input, through an independent reading of the algorithm."""
    for case in fixture_inputs():
        gray = bytes.fromhex(case["gray"])
        assert dither.bitmap(gray, case["width"], case["height"], _p(case["params"])) \
            == _reference_bits(gray, case["width"], case["height"], case["params"]), case["name"]


def test_dither_hand_worked_3x3():
    """Nine dots of level 100, worked by hand through the next-row
    neighbors. Row 0: 100 (err 12), 112 (err 14), 126 (err 15), all black.
    Row 1 starts at 126, 141 and 129 (each picked up error from row 0's
    (-1,+1), (0,+1) and (+1,+1)); 126 is black (err 15, so 156 and 144),
    156 is white (err -99 >> 3 = -13), 131 is white (err -124 >> 3 = -16).
    Row 2 starts 112, 114, 115 (row 0's (0,+2)), becomes 114, 100, 86 with
    row 1's errors, then 114, 114, 114 along the row: all black."""
    flat = _params()
    assert dither.bitmap(_flat(100, 3, 3), 3, 3, _p(flat)).hex() == "e080e0"
    assert _reference_bits(_flat(100, 3, 3), 3, 3, flat).hex() == "e080e0"


def test_lut_floors_like_python():
    """((v-128)*contrast)//100 + 128 + brightness*255//100, clamped: the
    quotients floor (a truncating mirror would be one level off)."""
    assert dither.lut(0, 133)[100] == 90         # -3724 // 100 = -38, not -37
    assert dither.lut(-55, 100)[200] == 59       # -14025 // 100 = -141, not -140
    assert dither.lut(37, 100)[0] == 94          # 9435 // 100 = 94
    assert dither.lut(0, 100) == bytes(range(256))
    assert set(dither.lut(100, 100)) == {255} and set(dither.lut(-100, 100)) == {0}
    assert set(dither.lut(0, 0)) == {128}
    assert dither.lut(0, 300)[127] == 125 and dither.lut(0, 300)[200] == 255


def test_dither_refuses_bad_input():
    p = dither.Params(0, 100, 128, "dither", False)
    with pytest.raises(ValueError):
        dither.bitmap(b"\0" * 5, 2, 2, p)
    with pytest.raises(ValueError):
        dither.bitmap(b"", -1, 0, p)
    for bad in ({"brightness": 101}, {"brightness": -101}, {"contrast": -1},
                {"contrast": 301}, {"threshold": 0}, {"threshold": 255},
                {"mode": "halftone"}, {"brightness": 1.5}, {"contrast": True}):
        with pytest.raises(ValueError):
            dither.Params(**_params(**bad))


# ---- Z64 ---------------------------------------------------------------

def _decode(b64: str) -> bytes:
    return zlib.decompress(base64.b64decode(b64))


def test_z64_crc_and_roundtrip():
    # CRC-16/XMODEM's published check value, worked out independently
    assert crc16(b"123456789") == "31C3"
    assert crc16(b"") == "0000"                  # always four digits
    for raw in (b"", b"\x00" * 100, bytes(range(256)) * 9, _noise(97, 13, 7)):
        out = z64(raw)
        m = re.fullmatch(r":Z64:([A-Za-z0-9+/=]*):([0-9A-F]{4})", out)
        assert m, out
        assert _decode(m.group(1)) == raw
        assert base64.b64decode(m.group(1))[0] == 0x78      # a zlib stream, not raw deflate
        assert m.group(2) == f"{binascii.crc_hqx(m.group(1).encode('ascii'), 0):04X}"


# ---- ^GFA --------------------------------------------------------------

def _image(**kw) -> dict:
    el = {"id": "img", "type": "image", "source": "photo", "x": 0.5, "y": 0.25,
          "w": 0.4, "h": 0.3, "rotation": 0}
    el.update(kw)
    return el


def _field(**kw) -> dict:
    el = {"id": "f1", "type": "field", "field": "person_name", "x": 1.2, "y": 0.2,
          "w": 2, "h": 0.3, "rotation": 0, "display": "text", "font": SWISS,
          "sizePt": 14, "baselineIn": 0.2, "align": "left"}
    el.update(kw)
    return el


def _design(*elements, schema=3, splits=None) -> dict:
    raw = {"schema": schema, "size": {"w": 3.375, "h": 2.125}, "elements": list(elements)}
    if splits is not None:
        raw["splits"] = splits
    return raw


def _body(zpl: str) -> list[str]:
    lines = zpl.split("\n")
    assert lines[:4] == ["^XA", f"^PW{lines[1][3:]}", f"^LL{lines[2][3:]}", "^CI28"]
    assert lines[-1] == "^XZ"
    return lines[4:-1]


def _pattern(width: int, height: int) -> dither.Bitmap:
    """A bitmap whose every row differs, so a misplaced band shows."""
    d = dither.bytes_per_row(width)
    bits = bytearray()
    for y in range(height):
        row = bytearray(((y * 7 + x * 13) & 0xFF) for x in range(d))
        if width % 8:
            row[-1] &= (0xFF << (8 - width % 8)) & 0xFF
        bits += row
    return dither.Bitmap(width, height, bytes(bits))


def _graphics(zpl: str) -> list[tuple[int, int, int, int, int, bytes]]:
    """Each ^GFA as (x, y, b, c, d, decoded bits), its CRC checked."""
    out = []
    for m in GFA.finditer(zpl):
        x, y, b, c, d, b64, crc = m.groups()
        assert crc == f"{binascii.crc_hqx(b64.encode('ascii'), 0):04X}"
        raw = _decode(b64)
        assert len(raw) == int(c)
        out.append((int(x), int(y), int(b), int(c), int(d), raw))
    return out


def _sized(width: int, height: int, dpi: int = 300) -> dict:
    """An image element whose box is exactly width x height dots at dpi."""
    return _image(w=width / dpi, h=height / dpi)


def test_gfa_placement_and_banding():
    bm = _pattern(120, 90)                       # 0.4 x 0.3 in at 300 dpi
    out = compile_zpl(parse_design(_design(_image())), 300, {}, images={"img": bm})
    body = _body(out)
    assert len(body) == 1 and body[0].startswith("^FO150,75^GFA,1350,1350,15,:Z64:")
    assert "^FH" not in body[0] and "^FR" not in body[0]
    assert _graphics(out) == [(150, 75, 1350, 1350, 15, bm.bits)]

    # 800 dots wide: 100 bytes a row, so a band holds 99999 // 100 = 999 rows
    tall = _pattern(800, 2500)
    out = compile_zpl(parse_design(_design(_sized(800, 2500))), 300, {}, images={"img": tall})
    bands = _graphics(out)
    assert [(x, y, c, d) for x, y, _b, c, d, _r in bands] == [
        (150, 75, 99_900, 100), (150, 75 + 999, 99_900, 100), (150, 75 + 1998, 50_200, 100)]
    assert b"".join(r for *_rest, r in bands) == tall.bits
    assert len(_body(out)) == 3

    # c may be exactly 99,999; one more row starts a band
    one = _pattern(8, 99_999)
    assert [(y, c) for _x, y, _b, c, _d, _r in _graphics(
        compile_zpl(parse_design(_design(_sized(8, 99_999))), 300, {}, images={"img": one}))] \
        == [(75, 99_999)]
    two = _pattern(8, 100_000)
    assert [(y, c) for _x, y, _b, c, _d, _r in _graphics(
        compile_zpl(parse_design(_design(_sized(8, 100_000))), 300, {}, images={"img": two}))] \
        == [(75, 99_999), (75 + 99_999, 1)]


def test_gfa_keeps_the_element_order():
    """White is transparent and later elements print on top: the graphic
    sits between the elements before and after it."""
    raw = _design(_field(id="under"), _image(), _field(id="over"))
    body = _body(compile_zpl(parse_design(raw), 300, {"person_name": "Jo"},
                             images={"img": _pattern(120, 90)}))
    assert [line[:3] for line in body] == ["^FT", "^FO", "^FT"]
    assert "^GFA" in body[1]


def test_image_hidden_when_empty():
    design = parse_design(_design(_image()))
    assert _body(compile_zpl(design, 300, {})) == []
    assert _body(compile_zpl(design, 300, {}, images={})) == []
    assert _body(compile_zpl(design, 300, {}, images={"other": _pattern(8, 8)})) == []
    # an empty bitmap is no image either
    assert _body(compile_zpl(design, 300, {}, images={"img": dither.Bitmap(0, 0, b"")})) == []
    # off: a 2-dot outline of the footprint shows the gap on a test print
    shown = parse_design(_design(_image(hideWhenEmpty=False)))
    assert _body(compile_zpl(shown, 300, {})) == ["^FO150,75^GB120,90,2^FS"]
    assert _body(compile_zpl(shown, 203, {})) == ["^FO102,51^GB81,61,2^FS"]
    # a bitmap prints whatever hideWhenEmpty says
    assert "^GFA" in compile_zpl(shown, 300, {}, images={"img": _pattern(120, 90)})


def test_rotation_swaps_footprint():
    for rotation, footprint in ((0, (120, 90)), (90, (90, 120)), (180, (120, 90)),
                                (270, (90, 120))):
        el = _image(rotation=rotation, hideWhenEmpty=False)
        design = parse_design(_design(el))
        assert image_box_dots(design.elements[0], 300) == (120, 90)   # unrotated w x h
        assert _body(compile_zpl(design, 300, {})) \
            == [f"^FO150,75^GB{footprint[0]},{footprint[1]},2^FS"]
        # the caller rotates the bitmap; it goes at the footprint's top-left
        bm = _pattern(*footprint)
        d = dither.bytes_per_row(footprint[0])
        assert _graphics(compile_zpl(design, 300, {}, images={"img": bm})) \
            == [(150, 75, d * footprint[1], d * footprint[1], d, bm.bits)]


def test_bitmap_must_match_its_size():
    design = parse_design(_design(_image()))
    with pytest.raises(ValueError):
        compile_zpl(design, 300, {}, images={"img": dither.Bitmap(120, 90, b"\0" * 10)})
    # a plain (width, height, bits) tuple is a Bitmap too
    small = parse_design(_design(_sized(8, 2)))
    out = compile_zpl(small, 300, {}, images={"img": (8, 2, b"\x80\x01")})
    assert _graphics(out) == [(150, 75, 2, 2, 1, b"\x80\x01")]


def test_bitmap_must_fill_the_footprint():
    """A bitmap is the element's footprint at the DPI exactly (w x h, or
    h x w at 90 and 270): any other size was prepped for another box."""
    for rotation, good, bad in ((0, (120, 90), (90, 120)), (90, (90, 120), (120, 90)),
                                (180, (120, 90), (121, 90)), (270, (90, 120), (90, 119))):
        design = parse_design(_design(_image(rotation=rotation)))
        assert "^GFA" in compile_zpl(design, 300, {}, images={"img": _pattern(*good)})
        with pytest.raises(ValueError, match="footprint"):
            compile_zpl(design, 300, {}, images={"img": _pattern(*bad)})
    # the footprint at another DPI is another size
    with pytest.raises(ValueError, match="footprint"):
        compile_zpl(parse_design(_design(_image())), 203, {}, images={"img": _pattern(120, 90)})


def test_the_canvas_parity_fixture_is_what_the_python_core_writes(tmp_path):
    """image_parity.json pins the dots the canvas draws for image elements
    (imageParity.test.ts). Its generator runs the real model.py, zpl.py and
    dither.py: re-run it here, so a core change that moves a printed dot
    fails on this side too, not only when the portal suite next runs."""
    spec = importlib.util.spec_from_file_location("image_parity", IMAGE_PARITY / "image_parity.py")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    generator.OUT = tmp_path / "image_parity.json"
    generator.main()
    assert generator.OUT.read_text() == (IMAGE_PARITY / "image_parity.json").read_text(), (
        "the core moved: rerun `PYTHONPATH=api/src python3 "
        "portal/src/labels/builder/fixtures/image_parity.py` and check the canvas still matches")


# ---- schema 3 ----------------------------------------------------------

def test_a_design_holds_at_most_eight_images():
    """Each image is a storage read and a decode at compile time: a badge
    needs a photo, a logo and a few static pictures, never hundreds."""
    eight = [_image(id=f"i{n}") for n in range(8)]
    assert len(parse_design(_design(*eight, _field())).elements) == 9
    with pytest.raises(DesignError) as exc:
        parse_design(_design(*eight, _image(id="i8"), _field()))
    assert exc.value.problems == ["a design holds at most 8 images"]


def test_schema_3_refuses_duplicate_element_ids():
    """Images are resolved by element id: two elements sharing one would
    share one picture (or fail the compile), so schema 3 refuses them, with
    the builder's message."""
    with pytest.raises(DesignError) as exc:
        parse_design(_design(_image(), _image(x=1.5), _field(), _field(id="img")))
    assert exc.value.problems == ["img: id is used by another element",
                                  "img: id is used by another element"]
    assert len(parse_design(_design(_image(), _image(id="img2"), _field())).elements) == 3
    # schema 2 designs keep parsing as they always have
    assert len(parse_design(_design(_field(), _field(), schema=2)).elements) == 2


def test_schema_rules():
    with pytest.raises(DesignError) as exc:
        parse_design(_design(_image(), schema=2))
    assert exc.value.problems == ["img: an image element needs schema 3"]
    with pytest.raises(DesignError) as exc:
        parse_design(_design(_field(), schema=3))
    assert exc.value.problems == ["a schema 3 design needs an image element"]
    with pytest.raises(DesignError) as exc:
        parse_design(_design(_image(), schema=1))
    assert "unknown type 'image'" in str(exc.value)
    with pytest.raises(DesignError) as exc:
        parse_design(_design(_image(), schema=4))
    assert "schema must be 1, 2 or 3" in str(exc.value)
    # Splits are kept for schema 3 (and still checked)
    piece = _field(field="destination_rack", piece=2)
    design = parse_design(_design(_image(), piece, splits=SPLITS))
    assert design.schema == 3 and design.splits == {
        "destination_rack": ("NAP", "Sector", "POD", "Row", "Rack")}
    assert "^FD07C^FS" in compile_zpl(design, 300, {"destination_rack": "14.01.07C.02.03"})
    with pytest.raises(DesignError) as exc:
        parse_design(_design(_image(), piece))
    assert "piece 2 needs a Split defined for 'destination_rack'" in str(exc.value)


def test_image_element_defaults():
    photo, logo, static = parse_design(_design(
        _image(id="p"), _image(id="l", source="logo", imageId="ignored"),
        _image(id="s", source="static", imageId="0b8e3c4e-0000-4000-8000-000000000001"))).elements
    assert isinstance(photo, ImageEl)
    assert (photo.source, photo.image_id, photo.fit, photo.mode) == ("photo", None, "cover", "dither")
    assert (photo.brightness, photo.contrast, photo.threshold, photo.invert,
            photo.hide_when_empty) == (0, 100, 128, False, True)
    assert (logo.fit, logo.mode, logo.image_id) == ("contain", "threshold", None)
    assert (static.fit, static.mode) == ("contain", "threshold")
    assert static.image_id == "0b8e3c4e-0000-4000-8000-000000000001"
    # a static image not picked yet prints as no image
    assert parse_design(_design(_image(source="static"))).elements[0].image_id is None
    tuned = parse_design(_design(_image(fit="contain", mode="threshold", brightness=-20,
                                        contrast=150, threshold=90, invert=True,
                                        hideWhenEmpty=False, locked=True))).elements[0]
    assert tuned.params == dither.Params(brightness=-20, contrast=150, threshold=90,
                                         mode="threshold", invert=True)
    assert tuned.fit == "contain" and tuned.hide_when_empty is False


def test_image_element_problems():
    with pytest.raises(DesignError) as exc:
        parse_design(_design(_image(source="video", fit="stretch", mode="halftone",
                                    brightness=101, contrast=-1, threshold=255, w=0)))
    assert exc.value.problems == [
        "img: source must be one of photo/logo/static",
        "img: fit must be cover or contain",
        "img: mode must be dither or threshold",
        "img: brightness must be a whole number from -100 to 100",
        "img: contrast must be a whole number from 0 to 300",
        "img: threshold must be a whole number from 1 to 254",
        "img: an image needs a positive w and h",
    ]
    with pytest.raises(DesignError) as exc:
        parse_design(_design(_image(source="static", imageId="", brightness=1.5,
                                    threshold=0, fit=None)))
    assert exc.value.problems == [
        "img: imageId must be a non-empty string",
        "img: fit must be cover or contain",
        "img: brightness must be a whole number from -100 to 100",
        "img: threshold must be a whole number from 1 to 254",
    ]


# ---- compile.py / render.py ---------------------------------------------

def test_compile_and_render_pass_images_through():
    raw = _design(_image(), _field())
    bm = _pattern(120, 90)
    code = compile_design(raw, width_in=3.375, height_in=2.125, dots=300, language_key="zpl",
                          subs={"person_name": "Jo"}, images={"img": bm})
    assert _graphics(code) == [(150, 75, 1350, 1350, 15, bm.bits)]
    parsed = parse_design(raw)
    assert compile_parsed_design(parsed, dots=300, language_key="zpl", subs={},
                                 images={"img": bm}) == compile_zpl(parsed, 300, {},
                                                                    images={"img": bm})
    template = SimpleNamespace(kind="design", code=None, design=raw, language_key="zpl")
    code, unknown = render_template(template, {}, width_in=3.375, height_in=2.125, dots=300,
                                    images={"img": bm})
    assert "^GFA" in code
    # an image's source is never a field key: only the text field is unknown
    assert unknown == {"person_name"}
    assert render_template(template, {"person_name": "Jo"}, width_in=3.375, height_in=2.125,
                           dots=300)[1] == set()
    assert isinstance(parsed.elements[1], FieldEl)


def test_an_image_is_never_a_field_key():
    """An image's source is `source`, never `field`: even a stray `field` on
    an image element is no placed key (no mock value, no unknown key)."""
    raw = _design(_image(field="person_name"), _image(id="i2", field="ft:Photo"), _field())
    assert design_field_keys(raw) == {"person_name"}
    assert design_field_keys(_design(_image(field="badge_id"))) == set()


def test_brother_compilers_skip_images():
    design = parse_design(_design(_image(), _field()))
    assert "Jo" in compile_escp(design, {"person_name": "Jo"})
    assert "Jo" in compile_ptouch(design, {"person_name": "Jo"})


if __name__ == "__main__":  # rewrite the fixture: PYTHONPATH=src python tests/test_label_dither.py
    cases = []
    for case in fixture_inputs():
        bits = dither.bitmap(bytes.fromhex(case["gray"]), case["width"], case["height"],
                             _p(case["params"]))
        cases.append({**case, "bits": bits.hex()})
    FIXTURE.write_text(json.dumps({
        "about": ("Pins labels/dither.py and portal/src/labels/builder/dither.ts bit for bit. "
                  "gray: row-major 8-bit levels, hex. bits: packed rows, MSB = leftmost dot, "
                  "1 = black, ceil(width/8) bytes a row, pad bits 0, hex. luts: the "
                  "brightness/contrast table, 256 levels, hex. Inputs come from "
                  "api/tests/test_label_dither.py (fixture_inputs, LUT_INPUTS); rewrite with "
                  "`PYTHONPATH=src python tests/test_label_dither.py` from api/."),
        "luts": [{"brightness": b, "contrast": c, "table": dither.lut(b, c).hex()}
                 for b, c in LUT_INPUTS],
        "cases": cases}, indent=1) + "\n")
