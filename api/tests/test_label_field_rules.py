"""labels/field_rules.py: the per-field value pipeline (Split → Strip →
Max/Trim → Number padding). Pure unit tests — no DB.

The cases live in labels/fixtures/field_rules.json, which the portal's
fieldRules.test.ts reads too, so the canvas and the compiler agree."""

import json
from pathlib import Path

import pytest

import serversherpa.labels
from serversherpa.labels.field_rules import apply_rules, is_blank, piece, split_value

FIXTURE = Path(serversherpa.labels.__file__).parent / "fixtures" / "field_rules.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_fixture_cases(case):
    assert apply_rules(case["value"], case["rules"]) == case["expected"]
    assert is_blank(case["value"], case["rules"]) is case["blank"]


def test_fixture_names_are_unique():
    names = [c["name"] for c in CASES]
    assert len(names) == len(set(names))


def test_split_and_piece():
    assert split_value("14.01.07C.02.03") == ["14", "01", "07C", "02", "03"]
    assert split_value("") == [""]
    assert piece("14.01.07C.02.03", 2) == "07C"
    # a value with fewer pieces than the sample prints the missing ones blank
    assert piece("ORD1-F01", 0) == "ORD1-F01"
    assert piece("ORD1-F01", 1) == ""
    assert piece("", 0) == ""
    assert piece("14.01", -1) == ""
