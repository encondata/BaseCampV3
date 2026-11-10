"""Flow schema and structure validator (pure Python, no database)."""

import pytest
from pydantic import ValidationError

from serversherpa.matching_rules.flow import outputs_for
from serversherpa.matching_rules.validate import CHECKS, structure_checks
from tests.matching_helpers import (
    GOOD,
    GOOD_EDGES,
    GOOD_NODES,
    GOOD_plus_edge,
    GOOD_without_edge,
    clean,
    found,
    match_node,
    not_found,
    scan,
)
from tests.matching_helpers import make_flow as _flow


def _item(flow, code):
    return next(i for i in structure_checks(flow) if i.code == code)


def _problems(flow, code):
    return [p.message for p in _item(flow, code).problems]


def _problem_nodes(flow, code):
    return [p.node_ids for p in _item(flow, code).problems]


def test_good_flow_passes_every_check():
    items = structure_checks(GOOD)
    assert [i.code for i in items] == [c for c, _ in CHECKS]
    assert all(i.ok for i in items)


def test_parse_rejects_duplicate_ids_and_dangling_edges():
    with pytest.raises(ValidationError):
        _flow([scan("n1"), found("n1")], [])
    with pytest.raises(ValidationError):
        _flow([scan("n1")], [("e1", "n1", "out", "n9")])
    with pytest.raises(ValidationError):
        _flow([scan("n1"), found("n2")], [("e1", "n1", "out", "n2"), ("e1", "n1", "out", "n2")])


def test_scan_input_count():
    no_scan = _flow([found("n4")], [])
    two_scans = _flow(GOOD_NODES + [scan("n6")], GOOD_EDGES)
    assert _problems(no_scan, "one_scan_input") == ["The flow has no Scan input."]
    assert _problems(two_scans, "one_scan_input") == [
        "The flow has 2 Scan inputs; it needs exactly one."
    ]


def test_unwired_output_flags_wiring_and_path():
    f = GOOD_without_edge("n3", "none")
    assert _problems(f, "outputs_wired") == ['Match (asset tag): the "none" output isn\'t wired.']
    assert _problems(f, "paths_end") == [
        "A path through Match (asset tag) doesn't end in Found or Not found."
    ]
    assert _problem_nodes(f, "outputs_wired") == [("n3",)]


def test_output_wired_twice():
    f = GOOD_plus_edge("n2", "out", "n5")
    assert _problems(f, "outputs_wired") == [
        'Clean up (Trim): the "out" output is wired to 2 steps.'
    ]


def test_wire_from_an_output_the_step_lacks():
    f = GOOD_plus_edge("n2", "invalid", "n5")
    assert 'Clean up (Trim): wired from "invalid", an output this step doesn\'t have.' in _problems(
        f, "outputs_wired"
    )


def test_nothing_wires_into_a_scan_input():
    f = GOOD_plus_edge("n2", "out", "n1")
    assert "Scan input: nothing can be wired into a Scan input." in _problems(f, "outputs_wired")


def test_unreachable_step():
    f = _flow(GOOD_NODES + [not_found("n6")], GOOD_EDGES)
    assert _problems(f, "all_reachable") == ["Not found can't be reached from the Scan input."]


def test_loop_flags_each_node_on_it():
    nodes = [
        scan("n1"),
        clean("n2"),
        clean("n6", "upper"),
        match_node("n3"),
        found("n4"),
        not_found("n5"),
    ]
    edges = [
        ("e1", "n1", "out", "n2"),
        ("e2", "n2", "out", "n6"),
        ("e5", "n6", "out", "n2"),
        ("e3", "n3", "found", "n4"),
        ("e4", "n3", "none", "n5"),
    ]
    f = _flow(nodes, edges)
    assert sorted(_problem_nodes(f, "no_loops")) == [("n2",), ("n6",)]
    assert _problems(_flow(GOOD_NODES, GOOD_EDGES), "no_loops") == []


def test_missing_and_unknown_settings():
    def with_match(m):
        nodes = [m if n["id"] == "n3" else n for n in GOOD_NODES]
        return _flow(nodes, GOOD_EDGES)

    assert _problems(with_match(match_node("n3", field=None)), "settings_filled") == [
        "Match: choose a field."
    ]
    assert _problems(with_match(match_node("n3", search_in="all")), "settings_filled") == [
        "Match (asset tag): choose where to search."
    ]
    blank = [not_found("n5", "   ") if n["id"] == "n5" else n for n in GOOD_NODES]
    assert _problems(_flow(blank, GOOD_EDGES), "settings_filled") == [
        "Not found: enter the message."
    ]


def test_found_must_follow_match_found():
    f = _flow(
        [scan("n1"), clean("n2"), found("n4")],
        [("e1", "n1", "out", "n2"), ("e2", "n2", "out", "n4")],
    )
    assert _problems(f, "found_after_match") == [
        'Found is wired from Clean up (Trim); only a Match\'s "found" output can lead to Found.'
    ]
    g = _flow(
        [scan("n1"), match_node("n3"), found("n4")],
        [("e1", "n1", "out", "n3"), ("e3", "n3", "none", "n4")],
    )
    assert _problems(g, "found_after_match") == [
        'Found is wired from Match (asset tag); only a Match\'s "found" output can lead to Found.'
    ]


def test_found_output_must_lead_to_found():
    f = _flow(
        [scan("n1"), match_node("n3"), not_found("n5")],
        [("e1", "n1", "out", "n3"), ("e3", "n3", "found", "n5")],
    )
    assert 'Match (asset tag): the "found" output must lead to Found.' in _problems(
        f, "found_after_match"
    )


def test_outputs_for():
    from serversherpa.matching_rules.flow import FlowNode

    n = lambda d: FlowNode.model_validate(d)
    assert outputs_for(n(scan("a"))) == ("out",)
    assert outputs_for(n(clean("a", "number"))) == ("out", "invalid")
    assert outputs_for(n(clean("a", "pad_24"))) == ("out", "invalid")
    assert outputs_for(n(clean("a", "trim"))) == ("out",)
    assert outputs_for(n(match_node("a"))) == ("found", "none")
    assert outputs_for(n(found("a"))) == ()
    assert outputs_for(n(not_found("a"))) == ()
