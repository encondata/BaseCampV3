"""labels/barcode.py: how many narrow modules a barcode value prints as,
and the Code 128 subset the v2 compiler starts it in. Pure unit tests — no
DB.

The cases live in labels/fixtures/barcode_modules.json, which the portal's
labels/builder/barcode.test.ts reads too, so the canvas draws the width the
printer prints."""

import json
import re
from pathlib import Path

import pytest

import serversherpa.labels
from serversherpa.labels.barcode import barcode_modules, code128_data, code128_subset
from serversherpa.labels.model import parse_design
from serversherpa.labels.zpl import compile_zpl

FIXTURE = Path(serversherpa.labels.__file__).parent / "fixtures" / "barcode_modules.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_fixture_cases(case):
    assert barcode_modules(case["symbology"], case["value"]) == case["modules"]
    if case["symbology"] == "code128":
        assert code128_subset(case["value"]) == case["subset"]
    if "data" in case:
        assert code128_data(case["value"]) == case["data"]


def test_fixture_names_are_unique():
    names = [c["name"] for c in CASES]
    assert len(names) == len(set(names))


def test_counts_follow_the_symbologies():
    # Code 128: start, check (11 each) and stop (13) around 11 a character;
    # subset C packs two digits into one
    for n in range(1, 12):
        digits = "7" * n
        chars = n // 2 if n % 2 == 0 else n
        assert barcode_modules("code128", digits) == 11 * (chars + 2) + 13, n
        assert barcode_modules("code128", "x" * n) == 11 * (n + 2) + 13, n
        assert barcode_modules("code39", "X" * n) == 16 * (n + 2) - 1, n


def _barcode_zpl(value: str, symbology: str = "code128") -> str:
    design = parse_design({"schema": 2, "size": {"w": 4, "h": 2}, "elements": [
        {"id": "b1", "type": "barcode", "field": "asset_id", "symbology": symbology,
         "moduleIn": 0.01, "x": 0.1, "y": 0.1, "w": 1, "h": 0.2, "rotation": 0}]})
    return compile_zpl(design, 300, {"asset_id": value})


def _fd(out: str) -> str:
    (fd,) = re.findall(r"\^BY.*\^FD(.*?)\^FS", out)
    return fd


def test_the_compiler_starts_code128_in_the_subset_it_counted():
    assert _fd(_barcode_zpl("100000")) == ">;100000"
    assert _fd(_barcode_zpl("1000001")) == ">:1000001"
    assert _fd(_barcode_zpl("ORD1-F01")) == ">:ORD1-F01"
    # a literal > still goes as >0, behind the start code
    assert _fd(_barcode_zpl("A>B")) == ">:A>0B"
    # hex-escaped bytes ride behind the start code too
    assert _fd(_barcode_zpl("é1")) == ">:_c3_a91"
    assert _fd(_barcode_zpl("^1")) == ">:_5e1"
    # a blank value prints an empty field, as before
    assert _fd(_barcode_zpl("")) == ""
    # Code 39 has no start codes
    assert _fd(_barcode_zpl("100000", "code39")) == "100000"
    assert _fd(_barcode_zpl("A>B", "code39")) == "A>B"


def test_schema_1_barcodes_are_unchanged():
    """A schema 1 design may keep its {tokens} in the ZPL, so its data can't
    be counted: it compiles as it always has, with no start code."""
    design = parse_design({"size": {"w": 4, "h": 2}, "elements": [
        {"id": "b1", "type": "barcode", "symbology": "code128", "data": "{asset_id}",
         "x": 0.1, "y": 0.1, "w": 1, "h": 0.2}]})
    assert "^FH_^FD{asset_id}^FS" in compile_zpl(design, 300)
    assert "^FH_^FD100000^FS" in compile_zpl(design, 300, {"asset_id": "100000"})
