"""The naming-convention rule shared by Create a move in steps' crates and
trucks (and mirrored by portal/src/lib/namingConvention.ts)."""

import pytest

from serversherpa.imports.naming import (
    CRATE_MAX,
    TRUCK_MAX,
    Convention,
    NamingError,
    clash_sentence,
    generate_names,
    parse_convention,
)


def test_parse_splits_prefix_run_and_suffix():
    assert parse_convention("CRT-SJC-DAL-xxx") == Convention("CRT-SJC-DAL-", 3, "")
    assert parse_convention("  A-XX-B ") == Convention("A-", 2, "-B")


@pytest.mark.parametrize(("text", "code", "message"), [
    ("", "convention_required", "Enter a naming convention, like CRT-xxx."),
    ("   ", "convention_required", "Enter a naming convention, like CRT-xxx."),
    ("CRT-001", "no_number", "Mark the number with a run of x's, like CRT-xxx."),
    ("BOX-xxx", "many_numbers", "Use only one run of x's for the number."),
    ("xx-XX", "many_numbers", "Use only one run of x's for the number."),
])
def test_parse_errors_are_sentences(text, code, message):
    with pytest.raises(NamingError) as exc:
        parse_convention(text)
    assert exc.value.code == code
    assert exc.value.message == message


def test_generate_pads_to_the_run_and_never_truncates():
    assert generate_names("CRT-xxx", 3, 1, max_count=CRATE_MAX) == [
        "CRT-001", "CRT-002", "CRT-003"]
    assert generate_names("T-x-B", 3, 9, max_count=TRUCK_MAX) == ["T-9-B", "T-10-B", "T-11-B"]
    assert generate_names("CRT-xx", 1, 1234, max_count=CRATE_MAX) == ["CRT-1234"]
    assert generate_names("CRT-xxx", 0, 1, max_count=CRATE_MAX) == []


@pytest.mark.parametrize(("count", "start", "max_count", "message"), [
    (501, 1, CRATE_MAX, "The count must be between 0 and 500."),
    (-1, 1, CRATE_MAX, "The count must be between 0 and 500."),
    (101, 1, TRUCK_MAX, "The count must be between 0 and 100."),
    (3, -1, CRATE_MAX, "The start number can't be below 0."),
])
def test_generate_range_errors(count, start, max_count, message):
    with pytest.raises(NamingError) as exc:
        generate_names("CRT-xxx", count, start, max_count=max_count)
    assert exc.value.message == message


def test_convention_is_checked_before_the_count():
    with pytest.raises(NamingError) as exc:
        generate_names("CRT", 999, -5, max_count=CRATE_MAX)
    assert exc.value.code == "no_number"


def test_clash_sentence_lists_ten_then_counts_the_rest():
    assert clash_sentence("crate", ["A", "B"]) == "These crate names already exist: A, B."
    names = [f"T-{n}" for n in range(12)]
    assert clash_sentence("truck", names) == (
        "These truck names already exist: T-0, T-1, T-2, T-3, T-4, T-5, T-6, T-7, T-8, T-9, "
        "and 2 more.")
