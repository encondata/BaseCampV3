"""Builders for matching-rule flows, shared by the flow and engine tests."""

from serversherpa.matching_rules.flow import Flow


def _node(id_, kind, settings=None, x=0.0, y=0.0):
    return {"id": id_, "kind": kind, "settings": settings or {}, "position": {"x": x, "y": y}}


def scan(id_):
    return _node(id_, "scan_input")


def clean(id_, op="trim"):
    return _node(id_, "clean_up", {"op": op})


def match_node(id_, **over):
    s = {
        "table": "assets",
        "field": "asset_tag",
        "compare": "ignore_case",
        "search_in": "move",
        "multiple": "first",
    }
    s.update(over)
    return _node(id_, "match", {k: v for k, v in s.items() if v is not None})


def found(id_, action="print_label"):
    return _node(id_, "found", {"action": action})


def not_found(id_, message="Nope"):
    return _node(id_, "not_found", {"message": message})


def make_flow(nodes, edges):
    """`edges` are (id, source, output, target) tuples."""
    return Flow.model_validate(
        {
            "nodes": nodes,
            "edges": [{"id": e[0], "source": e[1], "output": e[2], "target": e[3]} for e in edges],
        }
    )


# Scan input -> Clean up (Trim) -> Match (asset tag) -> Found / Not found
GOOD_NODES = [scan("n1"), clean("n2"), match_node("n3"), found("n4"), not_found("n5")]
GOOD_EDGES = [
    ("e1", "n1", "out", "n2"),
    ("e2", "n2", "out", "n3"),
    ("e3", "n3", "found", "n4"),
    ("e4", "n3", "none", "n5"),
]
GOOD = make_flow(GOOD_NODES, GOOD_EDGES)


def GOOD_without_edge(source, output):
    return make_flow(GOOD_NODES, [e for e in GOOD_EDGES if (e[1], e[2]) != (source, output)])


def GOOD_plus_edge(source, output, target, nodes=None):
    return make_flow(nodes or GOOD_NODES, GOOD_EDGES + [("ex", source, output, target)])
