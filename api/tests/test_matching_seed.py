"""v1 flows and the starting test set (seed module), plus parity with today's kiosk."""

import re

import pytest

from serversherpa.matching_rules.engine import JS_WHITESPACE, Target, run_flow
from serversherpa.matching_rules.flow import PLACES, Flow
from serversherpa.matching_rules.seed import TEST_ASSETS, TEST_ROWS, V1_FLOWS, seed_statements
from serversherpa.matching_rules.validate import structure_checks


def _targets():
    return [
        Target(
            key=str(a["asset_tag"]),
            asset_tag=a["asset_tag"],
            name=a["name"],
            rfid=a["rfid"],
            serial=a["serial"],
            sits=a["sits"],
        )
        for a in TEST_ASSETS
    ]


def _chain(place):
    """(kind, settings) from the Scan input along `out`/`none` edges to the end."""
    flow = V1_FLOWS[place]
    nodes = {n["id"]: n for n in flow["nodes"]}
    nxt = {e["source"]: e["target"] for e in flow["edges"] if e["output"] in ("out", "none")}
    node = next(n for n in flow["nodes"] if n["kind"] == "scan_input")
    out = []
    while True:
        out.append((node["kind"], node["settings"]))
        if node["id"] not in nxt:
            return out
        node = nodes[nxt[node["id"]]]


def _found_targets(place):
    """Ids of the nodes each Match's `found` output leads to."""
    return {e["target"] for e in V1_FLOWS[place]["edges"] if e["output"] == "found"}


def _summary(place):
    return [(k, s.get("op") or s.get("field") or s.get("message")) for k, s in _chain(place)]


def _assert_matches_and_found(place, compares, action):
    matches = [s for k, s in _chain(place) if k == "match"]
    assert [(s["field"], s["compare"]) for s in matches] == compares
    for s in matches:
        assert s == {
            "table": "assets",
            "field": s["field"],
            "compare": s["compare"],
            "search_in": "move",
            "multiple": "first",
        }
    found_ids = _found_targets(place)
    assert len(found_ids) == 1
    flow = V1_FLOWS[place]
    found_edges = [e for e in flow["edges"] if e["output"] == "found"]
    assert len(found_edges) == len(matches)
    (found,) = [n for n in flow["nodes"] if n["id"] in found_ids]
    assert (found["kind"], found["settings"]) == ("found", {"action": action})


def test_v1_flows_pass_structure():
    for place in PLACES:
        assert V1_FLOWS[place]["format"] == 1
        assert all(i.ok for i in structure_checks(Flow.model_validate(V1_FLOWS[place])))


def test_v1_flows_ids_and_layout():
    for place in PLACES:
        flow = V1_FLOWS[place]
        assert [n["id"] for n in flow["nodes"]] == [
            f"n{i}" for i in range(1, len(flow["nodes"]) + 1)
        ]
        assert [e["id"] for e in flow["edges"]] == [
            f"e{i}" for i in range(1, len(flow["edges"]) + 1)
        ]
        chain_ids = [n["id"] for n in flow["nodes"] if n["kind"] != "found"]
        xs = [next(n for n in flow["nodes"] if n["id"] == i)["position"]["x"] for i in chain_ids]
        assert xs == [240 * i for i in range(len(xs))]
        chain_y = {n["position"]["y"] for n in flow["nodes"] if n["kind"] != "found"}
        (found,) = [n for n in flow["nodes"] if n["kind"] == "found"]
        assert len(chain_y) == 1 and found["position"]["y"] > chain_y.pop()


def test_v1_printing_is_todays_matchAssetOrSerial():
    assert _summary("printing") == [
        ("scan_input", None),
        ("clean_up", "trim"),
        ("clean_up", "upper"),
        ("match", "asset_tag"),
        ("match", "serial"),
        ("not_found", "This asset isn't on this move."),
    ]
    _assert_matches_and_found(
        "printing", [("asset_tag", "ignore_case"), ("serial", "ignore_case")], "print_label"
    )


def test_v1_scanning_is_todays_matchScan():
    assert _summary("scanning") == [
        ("scan_input", None),
        ("clean_up", "trim"),
        ("clean_up", "upper"),
        ("match", "rfid"),
        ("match", "asset_tag"),
        ("match", "serial"),
        ("not_found", "No match"),
    ]
    _assert_matches_and_found(
        "scanning",
        [("rfid", "strip_zeros"), ("asset_tag", "ignore_case"), ("serial", "ignore_case")],
        "record_scan",
    )


def test_test_set_covers_the_tricky_cases():
    by = {a["asset_tag"]: a for a in TEST_ASSETS}
    assert len(TEST_ASSETS) == 8 and len(TEST_ROWS) == 18
    assert re.sub(r"^0+(?=.)", "", by[103]["rfid"]) == str(by[102]["asset_tag"])
    assert by[106]["serial"] == by[107]["serial"] and by[108]["sits"] == "client"
    assert by[106]["name"] in by[107]["name"] and by[104]["serial"] not in (
        by[104]["serial"].upper(),
        by[104]["serial"].lower(),
    )
    for place in PLACES:
        rows = [r for r in TEST_ROWS if r["place"] == place]
        assert len(rows) == 9 and len({r["value"] for r in rows}) == 9
        assert {r["asset_tag"] for r in rows} <= set(by)


@pytest.mark.parametrize("row", TEST_ROWS, ids=lambda r: f"{r['place']}:{r['value']}")
def test_every_seed_row_passes_v1(row):
    r = run_flow(Flow.model_validate(V1_FLOWS[row["place"]]), row["value"], _targets())
    if row["expected"] == "not_found":
        assert r.outcome == "not_found"
    else:
        assert (r.outcome, r.field, r.asset.asset_tag) == (
            "found",
            row["expected"],
            row["asset_tag"],
        )


def test_seed_statements_cover_versions_assets_and_rows():
    stmts = seed_statements()
    versions = [p for sql, p in stmts if "matching_rule_versions" in sql]
    assets = [p for sql, p in stmts if sql.lstrip().startswith("INSERT INTO matching_test_assets")]
    rows = [p for sql, p in stmts if "matching_test_rows" in sql]
    assert len(stmts) == len(versions) + len(assets) + len(rows)
    assert sorted(p["place"] for p in versions) == ["printing", "scanning"]
    assert len(assets) == 8 and len(rows) == 18
    # Every asset insert comes before the row inserts that look it up.
    kinds = ["row" if "matching_test_rows" in sql else "other" for sql, _ in stmts]
    assert kinds == sorted(kinds, key=lambda k: k == "row")


# --- Parity: a literal Python port of kiosk/src/lib/scanMatch.ts -------------------------

# JS `/^0+(?=.)/` (displayRfid): JS `.` is anything but a line terminator.
_JS_LEADING_ZEROS = re.compile("^0+(?=[^\n\r  ])")


def _key(v):
    t = (v or "").strip(JS_WHITESPACE).upper()
    return t or None


def _rfid_key(v):
    if not v or not v.strip(JS_WHITESPACE):
        return None
    return _key(_JS_LEADING_ZEROS.sub("", v.strip(JS_WHITESPACE)))


def _index(targets):  # roster in asset-tag order; first row wins per key
    by = {"rfid": {}, "asset_tag": {}, "serial": {}}
    for t in sorted(targets, key=lambda t: t.asset_tag):
        for field, k in (
            ("rfid", _rfid_key(t.rfid)),
            ("asset_tag", _key(str(t.asset_tag))),
            ("serial", _key(t.serial)),
        ):
            if k and k not in by[field]:
                by[field][k] = t
    return by


def _kiosk(by, raw, order):  # the page trims, then the matcher runs
    raw = raw.strip(JS_WHITESPACE)
    plain = _key(raw)
    if not plain:
        return None
    for field in order:
        k = _rfid_key(raw) if field == "rfid" else plain
        if k and k in by[field]:
            return field, by[field][k].asset_tag
    return None


VALUES = sorted(
    {
        v
        for a in TEST_ASSETS
        for f in ("rfid", "serial", "name")
        if (s := a[f])
        for v in (s, s.lower(), f" {s} ", "00" + s, re.sub(r"^0+(?=.)", "", s))
    }
    | {str(a["asset_tag"]) for a in TEST_ASSETS}
    | {"007", "07", "0", "000", "0C05", "c05", "nothing", "Test asset 6"}
)


@pytest.mark.parametrize(
    "place,order",
    [("printing", ("asset_tag", "serial")), ("scanning", ("rfid", "asset_tag", "serial"))],
)
def test_v1_matches_the_kiosk_port_on_every_value(place, order):
    # The port's roster is in asset-tag order, so its first-row-wins tie-break is the
    # engine's "first by asset tag order". The live kiosk keeps roster (IndexedDB) order
    # instead; DUP-200 (106 and 107) is the one tie here and both sides give 106.
    move = [t for t in _targets() if t.sits == "move"]
    by, flow = _index(move), Flow.model_validate(V1_FLOWS[place])
    for v in VALUES:
        r = run_flow(flow, v, move)
        got = (r.field, r.asset.asset_tag) if r.outcome == "found" else None
        assert got == _kiosk(by, v, order), v
