"""Reference engine for matching-rule flows (pure Python, no database)."""

import pytest

from serversherpa.matching_rules.engine import (
    JS_WHITESPACE,
    STOP_REASONS,
    Target,
    clean,
    compare,
    run_flow,
)
from tests import matching_helpers as h


def T(key, asset_tag=None, name=None, rfid=None, serial=None, sits="move"):
    return Target(key=key, asset_tag=asset_tag, name=name, rfid=rfid, serial=serial, sits=sits)


def _match_flow(**match):
    """Scan input -> Match -> Found / Not found."""
    return h.make_flow(
        [h.scan("n1"), h.match_node("n3", **match), h.found("n4"), h.not_found("n5", "No match")],
        [("e1", "n1", "out", "n3"), ("e3", "n3", "found", "n4"), ("e4", "n3", "none", "n5")],
    )


SERIAL_FLOW = _match_flow(field="serial")
SERIAL_FLOW_MOVE_AND_CLIENT = _match_flow(field="serial", search_in="move_and_client")

TRIM_UPPER_TAG_FLOW = h.make_flow(
    [
        h.scan("n1"),
        h.clean("n2", "trim"),
        h.clean("n6", "upper"),
        h.match_node("n3"),
        h.found("n4"),
        h.not_found("n5"),
    ],
    [
        ("e1", "n1", "out", "n2"),
        ("e2", "n2", "out", "n6"),
        ("e5", "n6", "out", "n3"),
        ("e3", "n3", "found", "n4"),
        ("e4", "n3", "none", "n5"),
    ],
)

# Read as a number: "out" goes on to the Match, "invalid" goes straight to Not found.
NUMBER_FLOW = h.make_flow(
    [h.scan("n1"), h.clean("n2", "number"), h.match_node("n3"), h.found("n4"), h.not_found("n5")],
    [
        ("e1", "n1", "out", "n2"),
        ("e2", "n2", "out", "n3"),
        ("e6", "n2", "invalid", "n5"),
        ("e3", "n3", "found", "n4"),
        ("e4", "n3", "none", "n5"),
    ],
)

GOOD_without_none_edge = h.GOOD_without_edge("n3", "none")


def test_js_whitespace_is_what_js_trim_removes():
    assert JS_WHITESPACE == (
        " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
        "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
    )
    assert STOP_REASONS == (
        "no_scan_input",
        "unwired",
        "two_wires",
        "loop",
        "bad_settings",
        "found_without_match",
    )


@pytest.mark.parametrize(
    "op,value,expected",
    [
        ("trim", "  a b \u00a0\ufeff", ("out", "a b")),
        ("trim", "\x1cA", ("out", "\x1cA")),
        ("upper", "ab", ("out", "AB")),
        ("lower", "AB", ("out", "ab")),
        ("strip_zeros", "000A1B", ("out", "A1B")),
        ("strip_zeros", "000", ("out", "0")),
        ("pad_24", "A1B", ("out", "0" * 21 + "A1B")),
        ("pad_24", "X" * 25, ("invalid", "X" * 25)),
        ("number", "007", ("out", "7")),
        ("number", "7a", ("invalid", "7a")),
        ("number", "", ("invalid", "")),
    ],
)
def test_clean(op, value, expected):
    assert clean(op, value) == expected


def test_number_is_ascii_digits_only():
    assert clean("number", "\u0663") == ("invalid", "\u0663")  # Arabic-Indic 3
    assert clean("number", " 7") == ("invalid", " 7")
    assert clean("number", "-7") == ("invalid", "-7")


def test_compare():
    assert compare("exact", " AbC ", "AbC") and not compare("exact", "abc", "ABC")
    assert compare("ignore_case", "AbC-104x", "ABC-104X")
    assert compare("strip_zeros", "000000000000000000000A1B", "a1b")
    assert compare("contains", "Test asset 6B", "test asset 6")
    assert not compare("contains", "Test asset 6", "test asset 6B")


def test_empty_value_never_matches():
    for mode in ("exact", "ignore_case", "strip_zeros", "contains"):
        assert not compare(mode, "abc", "")
        assert not compare(mode, None, "")
        assert not compare(mode, "  ", "")
        assert not compare(mode, "", "")


def test_blank_stored_field_never_matches():
    for mode in ("exact", "ignore_case", "strip_zeros", "contains"):
        assert not compare(mode, None, "a")
        assert not compare(mode, " \u3000", " ")


def test_value_that_cleans_to_empty_never_matches():
    targets = [T("a", 1, name="Test asset 1", serial="S1"), T("b", None, name=None, serial=None)]
    flow = h.make_flow(
        [
            h.scan("n1"),
            h.clean("n2", "trim"),
            h.match_node("n3", field="name", compare="contains"),
            h.found("n4"),
            h.not_found("n5"),
        ],
        h.GOOD_EDGES,
    )
    r = run_flow(flow, " \t\ufeff ", targets)
    assert r.outcome == "not_found"
    assert r.trace[2].hits == []


def test_asset_tag_compares_as_text():
    assert run_flow(SERIAL_FLOW, "7", [T("a", 7)]).outcome == "not_found"
    r = run_flow(h.GOOD, "007", [T("a", 7)])
    assert r.outcome == "not_found"  # "007" never finds asset 7
    r = run_flow(h.GOOD, "7", [T("a", 7), T("b", None, serial="7")])
    assert (r.outcome, r.asset.key, r.field, r.action) == ("found", "a", "asset_tag", "print_label")


def test_take_first_by_asset_tag():
    t107, t106 = T("b", 107, serial="DUP"), T("a", 106, serial="DUP")
    r = run_flow(SERIAL_FLOW, "DUP", [t107, t106])
    assert (r.outcome, r.asset.asset_tag, r.field) == ("found", 106, "serial")
    assert [h_.asset_tag for h_ in r.trace[-2].hits] == [106, 107]


def test_missing_asset_tag_sorts_last_then_by_key():
    targets = [T("z", None, serial="DUP"), T("y", None, serial="DUP"), T("x", 5, serial="DUP")]
    r = run_flow(SERIAL_FLOW, "DUP", targets)
    assert [t.key for t in r.trace[1].hits] == ["x", "y", "z"]
    assert r.asset.key == "x"


def test_hits_are_deduplicated_by_key():
    t = T("a", 1, serial="DUP")
    r = run_flow(SERIAL_FLOW_MOVE_AND_CLIENT, "DUP", [t, t])
    assert r.trace[1].hits == [t]


def test_search_in_scopes_client_targets():
    c = T("c", 108, serial="CLT", sits="client")
    assert run_flow(SERIAL_FLOW, "CLT", [c]).outcome == "not_found"
    assert run_flow(SERIAL_FLOW_MOVE_AND_CLIENT, "CLT", [c]).asset == c


def test_trace_records_each_step():
    r = run_flow(TRIM_UPPER_TAG_FLOW, " 7 ", [T("a", 7)])
    assert [(s.kind, s.value_in, s.value_out, s.output) for s in r.trace] == [
        ("scan_input", " 7 ", " 7 ", "out"),
        ("clean_up", " 7 ", "7", "out"),
        ("clean_up", "7", "7", "out"),
        ("match", "7", "7", "found"),
        ("found", "7", None, None),
    ]
    assert [s.node_id for s in r.trace] == ["n1", "n2", "n6", "n3", "n4"]
    assert [s.hits for s in r.trace] == [None, None, None, [T("a", 7)], None]
    assert (r.outcome, r.end_node_id, r.stop_reason, r.message) == ("found", "n4", None, None)


def test_not_found_result():
    r = run_flow(SERIAL_FLOW, "nothing", [T("a", 1, serial="S1")])
    assert (r.outcome, r.end_node_id, r.message, r.asset, r.field, r.action) == (
        "not_found",
        "n5",
        "No match",
        None,
        None,
        None,
    )
    assert [(s.kind, s.output, s.hits) for s in r.trace] == [
        ("scan_input", "out", None),
        ("match", "none", []),
        ("not_found", None, None),
    ]


def test_match_passes_its_value_through_both_outputs():
    # Match asset tag, then on "none" Match serial with the same value.
    flow = h.make_flow(
        [
            h.scan("n1"),
            h.match_node("n2"),
            h.match_node("n3", field="serial"),
            h.found("n4"),
            h.found("n6", "record_scan"),
            h.not_found("n5"),
        ],
        [
            ("e1", "n1", "out", "n2"),
            ("e2", "n2", "found", "n4"),
            ("e3", "n2", "none", "n3"),
            ("e4", "n3", "found", "n6"),
            ("e5", "n3", "none", "n5"),
        ],
    )
    r = run_flow(flow, "S9", [T("a", 9, serial="S9")])
    assert (r.outcome, r.field, r.action, r.asset.key) == ("found", "serial", "record_scan", "a")
    assert [(s.node_id, s.value_in, s.output) for s in r.trace] == [
        ("n1", "S9", "out"),
        ("n2", "S9", "none"),
        ("n3", "S9", "found"),
        ("n6", "S9", None),
    ]


def test_invalid_output_is_followed():  # number on "x" -> invalid -> Not found
    r = run_flow(NUMBER_FLOW, "x", [])
    assert r.outcome == "not_found"
    assert [(s.node_id, s.output) for s in r.trace] == [
        ("n1", "out"),
        ("n2", "invalid"),
        ("n5", None),
    ]


def test_run_stops_on_unwired_output():
    r = run_flow(GOOD_without_none_edge, "zzz", [])
    assert (r.outcome, r.stop_reason, r.end_node_id) == ("stopped", "unwired", "n3")
    assert [(s.node_id, s.output) for s in r.trace] == [
        ("n1", "out"),
        ("n2", "out"),
        ("n3", "none"),
    ]
    assert (r.asset, r.field, r.action) == (None, None, None)


def test_run_stops_on_output_wired_twice():
    r = run_flow(h.GOOD_plus_edge("n2", "out", "n5"), "zzz", [])
    assert (r.outcome, r.stop_reason, r.end_node_id) == ("stopped", "two_wires", "n2")


def test_run_stops_on_loop():
    flow = h.make_flow(
        [h.scan("n1"), h.clean("n2"), h.clean("n6", "upper"), h.not_found("n5")],
        [("e1", "n1", "out", "n2"), ("e2", "n2", "out", "n6"), ("e5", "n6", "out", "n2")],
    )
    r = run_flow(flow, "a", [])
    assert (r.outcome, r.stop_reason, r.end_node_id) == ("stopped", "loop", "n2")
    assert [s.node_id for s in r.trace] == ["n1", "n2", "n6"]


def test_run_stops_without_scan_input():
    r = run_flow(h.make_flow([h.found("n4")], []), "a", [])
    assert (r.outcome, r.stop_reason, r.end_node_id, r.trace) == (
        "stopped",
        "no_scan_input",
        None,
        [],
    )
    two = h.make_flow(h.GOOD_NODES + [h.scan("n6")], h.GOOD_EDGES)
    r = run_flow(two, "a", [])
    assert (r.outcome, r.stop_reason, r.end_node_id, r.trace) == (
        "stopped",
        "no_scan_input",
        None,
        [],
    )


def test_run_stops_on_bad_settings():
    nodes = [h.match_node("n3", field=None) if n["id"] == "n3" else n for n in h.GOOD_NODES]
    r = run_flow(h.make_flow(nodes, h.GOOD_EDGES), "7", [T("a", 7)])
    assert (r.outcome, r.stop_reason, r.end_node_id) == ("stopped", "bad_settings", "n3")
    assert r.message == "Match: choose a field."
    assert [s.node_id for s in r.trace] == ["n1", "n2"]


def test_found_without_match_stops():
    flow = h.make_flow(
        [h.scan("n1"), h.clean("n2"), h.found("n4")],
        [("e1", "n1", "out", "n2"), ("e2", "n2", "out", "n4")],
    )
    r = run_flow(flow, "7", [T("a", 7)])
    assert (r.outcome, r.stop_reason, r.end_node_id, r.asset) == (
        "stopped",
        "found_without_match",
        "n4",
        None,
    )


def test_found_after_a_none_output_stops():
    # Only the found output of the Match right before it gives Found an asset.
    flow = h.make_flow(
        [h.scan("n1"), h.match_node("n3"), h.found("n4")],
        [("e1", "n1", "out", "n3"), ("e3", "n3", "none", "n4"), ("e4", "n3", "found", "n4")],
    )
    r = run_flow(flow, "zzz", [T("a", 7)])
    assert (r.outcome, r.stop_reason) == ("stopped", "found_without_match")


def test_strip_zeros_compare_trims_again_like_the_kiosk_rfid_key():
    # rfidKey is key(displayRfid(v.trim())): trim, strip zeros, trim and upper-case again.
    assert compare("strip_zeros", "AB", "00 AB")
    assert compare("strip_zeros", "00 ab", "AB")
    assert compare("strip_zeros", "0\u3000AB", "00\tab")
    assert compare("strip_zeros", "0", " 0 ")  # the value side is trimmed first, as on the kiosk
    assert not compare("strip_zeros", "AB", " \t")  # a value that keys to blank never matches


def test_zero_strip_stops_at_a_line_terminator_like_js_dot():
    for lt in ("\n", "\r", "\u2028", "\u2029"):
        assert clean("strip_zeros", "0" + lt) == ("out", "0" + lt)
        assert clean("strip_zeros", "00" + lt + "A") == ("out", "0" + lt + "A")
        assert not compare("strip_zeros", "0" + lt + "A", lt + "A")
    assert clean("strip_zeros", "00\tA") == ("out", "\tA")  # a tab is not a line terminator
