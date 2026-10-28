"""Predecessor text (`3`, `3FS+2d`, `5SS`, `7FF-4h`, `2,3SS`): parsed and
formatted from the vectors file the portal's vitest suite reads too, so both
sides agree on every string."""

import json
import time
from pathlib import Path

import pytest

from serversherpa.plans.durations import Duration, DurationError, Units
from serversherpa.plans.engine import LINK_TYPES
from serversherpa.plans.predecessors import (
    MAX_TEXT_LENGTH,
    PredecessorError,
    PredSpec,
    format_predecessors,
    parse_predecessors,
)

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "plans" / "predecessors.json").read_text()
)
UNITS = Units.from_calendar(VECTORS["units"])
UNITS_ALT = Units.from_calendar(VECTORS["units_alt"])
VALID_IDS = set(VECTORS["valid_ids"])
SELF_ID = VECTORS["self_id"]


@pytest.fixture(autouse=True)
def clean_db():
    """These tests are pure and never touch the database: shadow the
    conftest fixture that truncates every table before each test."""
    yield


def _specs(rows):
    return [
        PredSpec(display_id, link_type, Duration(minutes, unit, elapsed))
        for display_id, link_type, minutes, unit, elapsed in rows
    ]


def _parse(text, units=UNITS, valid_ids=VALID_IDS, self_id=SELF_ID):
    return parse_predecessors(text, units, valid_ids=valid_ids, self_id=self_id)


def test_vector_units_are_the_standard_calendar():
    assert UNITS == Units(minutes_per_day=480, minutes_per_week=2400, minutes_per_month=9600)
    assert UNITS_ALT == Units(minutes_per_day=600, minutes_per_week=3000, minutes_per_month=13200)


@pytest.mark.parametrize("text,rows", VECTORS["parse"])
def test_parse_vectors(text, rows):
    assert _parse(text) == _specs(rows)


@pytest.mark.parametrize("text,rows", VECTORS["parse_alt"])
def test_parse_alt_units_vectors(text, rows):
    assert _parse(text, UNITS_ALT) == _specs(rows)


@pytest.mark.parametrize("text", VECTORS["invalid"])
def test_invalid_vectors(text):
    with pytest.raises(PredecessorError) as exc:
        _parse(text)
    assert exc.value.code == "bad_predecessor"
    assert exc.value.detail


@pytest.mark.parametrize("text,valid_ids,self_id,rows", VECTORS["ids"])
def test_ids_vectors(text, valid_ids, self_id, rows):
    if rows is None:
        with pytest.raises(PredecessorError):
            _parse(text, valid_ids=set(valid_ids), self_id=self_id)
    else:
        assert _parse(text, valid_ids=set(valid_ids), self_id=self_id) == _specs(rows)


@pytest.mark.parametrize("outer,head,inner,tail,rows", VECTORS["sized"])
def test_sized_vectors(outer, head, inner, tail, rows):
    text = " " * outer + head + " " * inner + tail + " " * outer
    if rows is None:
        with pytest.raises(PredecessorError):
            _parse(text)
    else:
        assert _parse(text) == _specs(rows)


@pytest.mark.parametrize("text", VECTORS["empty"])
def test_empty_vectors_are_no_links(text):
    assert _parse(text) == []


def test_empty_string_is_no_links():
    assert _parse("") == []
    assert _parse("  ") == []
    # no ids are valid at all, and there is still nothing wrong with no links
    assert _parse("", valid_ids=set(), self_id=None) == []


@pytest.mark.parametrize("rows,text", VECTORS["format"])
def test_format_vectors(rows, text):
    assert format_predecessors(_specs(rows), UNITS) == text


@pytest.mark.parametrize("rows,text", VECTORS["format_alt"])
def test_format_alt_units_vectors(rows, text):
    assert format_predecessors(_specs(rows), UNITS_ALT) == text


def _round_trips(rows, units=UNITS):
    """Lags the two-decimal text holds exactly, and a zero lag only in the
    unit a bare ID parses back to (the text does not keep it)."""
    for _id, _type, minutes, unit, elapsed in rows:
        if minutes == 0:
            if (unit, elapsed) != ("d", False):
                return False
        elif (abs(minutes) * 100) % units.unit_minutes(unit, elapsed) != 0:
            return False
    return True


@pytest.mark.parametrize(
    "rows,text",
    [row for row in VECTORS["format"] if row[0] and _round_trips(row[0])],
)
def test_round_trip(rows, text):
    specs = _specs(rows)
    ids = {spec.display_id for spec in specs}
    parsed = parse_predecessors(text, UNITS, valid_ids=ids, self_id=None)
    assert parsed == specs
    assert format_predecessors(parsed, UNITS) == text


@pytest.mark.parametrize(
    "rows,text",
    [row for row in VECTORS["format_alt"] if _round_trips(row[0], UNITS_ALT)],
)
def test_round_trip_alt_units(rows, text):
    specs = _specs(rows)
    ids = {spec.display_id for spec in specs}
    assert parse_predecessors(text, UNITS_ALT, valid_ids=ids, self_id=None) == specs


def test_every_parse_vector_formats_to_text_that_parses_back():
    for _text, rows in VECTORS["parse"]:
        specs = _specs(rows)
        ids = {spec.display_id for spec in specs}
        text = format_predecessors(specs, UNITS)
        again = parse_predecessors(text, UNITS, valid_ids=ids, self_id=None)
        # a zero lag comes back as a plain day, so compare the parts that last
        assert [(s.display_id, s.link_type, s.lag.minutes) for s in again] == [
            (s.display_id, s.link_type, s.lag.minutes) for s in specs
        ]


def test_all_four_link_types_are_covered_by_the_vectors():
    parsed = {spec[1] for _text, rows in VECTORS["parse"] for spec in rows}
    formatted = {spec[1] for rows, _text in VECTORS["format"] for spec in rows}
    assert parsed == set(LINK_TYPES) == formatted


def test_the_cap_matches_the_vectors():
    # the sized rows put "2" + 509 spaces + "SS" exactly on the cap and one
    # more space over it
    assert MAX_TEXT_LENGTH == 512 == 1 + 509 + 2
    assert "at most 512 characters" in VECTORS["notes"]


def test_error_carries_a_code_and_a_detail():
    assert PredecessorError.code == "bad_predecessor"
    assert issubclass(PredecessorError, ValueError)
    err = PredecessorError("nope")
    assert err.detail == "nope"
    assert str(err) == "nope"


def test_details_say_what_is_wrong_with_which_part():
    with pytest.raises(PredecessorError) as exc:
        _parse("2,3XX")
    assert "3XX" in exc.value.detail
    with pytest.raises(PredecessorError) as exc:
        _parse("1")
    assert "itself" in exc.value.detail
    with pytest.raises(PredecessorError) as exc:
        _parse("12")
    assert "12" in exc.value.detail and "does not exist" in exc.value.detail
    with pytest.raises(PredecessorError) as exc:
        _parse("2,3,2")
    assert "more than once" in exc.value.detail and "2" in exc.value.detail
    with pytest.raises(PredecessorError) as exc:
        _parse("2,,3")
    assert "empty" in exc.value.detail


def test_a_bad_lag_is_a_predecessor_error_naming_the_part():
    with pytest.raises(PredecessorError) as exc:
        _parse("2,3FS+2x")
    assert exc.value.code == "bad_predecessor"
    assert "3FS+2x" in exc.value.detail
    assert not isinstance(exc.value, DurationError)
    assert isinstance(exc.value.__cause__, DurationError)


def test_the_order_of_checks_is_self_then_unknown_then_duplicate():
    # id 1 is both valid and self: reported as self
    with pytest.raises(PredecessorError) as exc:
        _parse("1")
    assert "itself" in exc.value.detail
    # an unknown id before a bad part in a later entry
    with pytest.raises(PredecessorError) as exc:
        _parse("12,3XX")
    assert "12" in exc.value.detail
    # the first bad entry wins even when a later one repeats
    with pytest.raises(PredecessorError) as exc:
        _parse("3,3,x")
    assert "more than once" in exc.value.detail


def test_the_cap_counts_the_trimmed_text():
    padded = " " * 2000 + "3SS" + " " * 2000
    assert _parse(padded) == _specs([[3, "SS", 0, "d", False]])
    with pytest.raises(PredecessorError):
        _parse("3" + " " * MAX_TEXT_LENGTH + "SS")


def test_error_details_do_not_echo_unbounded_input():
    texts = [
        "x" * 100_000,
        "3FS+" + "x" * 400,
        "3" + "9" * 500,
        "2,3," + "7" * 400 + "XX",
        "2," * 400,
    ]
    for text in texts:
        with pytest.raises(PredecessorError) as exc:
            _parse(text)
        assert len(exc.value.detail) < 250, text[:20]
    # an ID of 500 digits is unknown and the message does not print it all
    with pytest.raises(PredecessorError) as exc:
        _parse("9" * 500)
    assert len(exc.value.detail) < 250


@pytest.mark.parametrize(
    "text",
    [
        "1" + " " * 100_000 + "x",
        "1,2" + " " * 100_000 + "x",
        "1 " * 50_000,
        "1," * 50_000,
        "," * 100_000,
        "1" + "e" * 100_000,
        "3FS+" + "1" * 100_000,
        "3 " + "S" * 100_000,
        # inside the cap, the worst shapes for a backtracking matcher
        "1" + " " * 500 + "x",
        "1 " * 250 + "x",
        "3SS+1" + " " * 450 + "x",
        "1," * 255 + "x",
    ],
)
def test_long_input_fails_fast(text):
    started = time.perf_counter()
    with pytest.raises(PredecessorError):
        _parse(text, valid_ids=set(range(1, 300)), self_id=None)
    assert time.perf_counter() - started < 0.1


def test_whitespace_only_input_of_any_size_is_fast_and_empty():
    started = time.perf_counter()
    assert _parse(" " * 1_000_000) == []
    assert time.perf_counter() - started < 0.1


def test_non_string_input_is_a_predecessor_error():
    for value in (None, 5, 2.5, b"3", ["3"], {3}):
        with pytest.raises(PredecessorError):
            _parse(value)  # type: ignore[arg-type]


def test_a_missing_self_id_allows_every_valid_id():
    assert _parse("1", self_id=None) == _specs([[1, "FS", 0, "d", False]])


def test_valid_ids_is_not_modified():
    ids = {2, 3}
    parse_predecessors("2,3", UNITS, valid_ids=ids, self_id=None)
    assert ids == {2, 3}


def test_format_rejects_an_unknown_link_type():
    spec = PredSpec(3, "XX", Duration(0, "d", False))
    with pytest.raises(ValueError) as exc:
        format_predecessors([spec], UNITS)
    assert not isinstance(exc.value, PredecessorError)
    # a lower-case type is not one of the stored four either
    with pytest.raises(ValueError):
        format_predecessors([PredSpec(3, "fs", Duration(0, "d", False))], UNITS)


def test_pred_spec_is_frozen_and_hashable():
    spec = PredSpec(3, "FS", Duration(0, "d", False))
    with pytest.raises(AttributeError):
        spec.display_id = 4  # type: ignore[misc]
    assert {spec, PredSpec(3, "FS", Duration(0, "d", False))} == {spec}
