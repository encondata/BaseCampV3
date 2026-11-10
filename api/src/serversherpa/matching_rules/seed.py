"""Migration 0126's rows: the v1 flows and the starting test set.

v1 of each place is today's web kiosk (`kiosk/src/lib/scanMatch.ts`), quirks
included: Printing is `matchAssetOrSerial` (RFID is never tried) and Scanning
is `matchScan`. The test set covers the cases that are easy to get wrong.

This file is the record of what 0126 inserted. After merge, never change it: a
later change goes in a new migration. It imports nothing heavy, so the
migration can import it.
"""

import json
from itertools import pairwise
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

_STEP_X = 240
_FOUND_Y = 160


def _match(field: str, compare: str) -> dict:
    return {
        "table": "assets",
        "field": field,
        "compare": compare,
        "search_in": "move",
        "multiple": "first",
    }


def _chain_flow(chain: list[tuple[str, dict]], action: str) -> dict:
    """A left-to-right chain; every Match's `found` leads to one Found below the Matches."""
    nodes = [
        {
            "id": f"n{i}",
            "kind": kind,
            "settings": settings,
            "position": {"x": _STEP_X * (i - 1), "y": 0},
        }
        for i, (kind, settings) in enumerate(chain, start=1)
    ]
    match_ids = [n["id"] for n in nodes if n["kind"] == "match"]
    match_xs = [n["position"]["x"] for n in nodes if n["kind"] == "match"]
    found_id = f"n{len(nodes) + 1}"
    nodes.append(
        {
            "id": found_id,
            "kind": "found",
            "settings": {"action": action},
            "position": {"x": (match_xs[0] + match_xs[-1]) // 2, "y": _FOUND_Y},
        }
    )
    wires = [
        (a["id"], "none" if a["kind"] == "match" else "out", b["id"])
        for a, b in pairwise(nodes[: len(chain)])
    ]
    wires += [(m, "found", found_id) for m in match_ids]
    edges = [
        {"id": f"e{i}", "source": s, "output": o, "target": t}
        for i, (s, o, t) in enumerate(wires, start=1)
    ]
    return {"format": 1, "nodes": nodes, "edges": edges}


V1_FLOWS: dict[str, dict] = {
    "printing": _chain_flow(
        [
            ("scan_input", {}),
            ("clean_up", {"op": "trim"}),
            ("clean_up", {"op": "upper"}),
            ("match", _match("asset_tag", "ignore_case")),
            ("match", _match("serial", "ignore_case")),
            ("not_found", {"message": "This asset isn't on this move."}),
        ],
        "print_label",
    ),
    "scanning": _chain_flow(
        [
            ("scan_input", {}),
            ("clean_up", {"op": "trim"}),
            ("clean_up", {"op": "upper"}),
            ("match", _match("rfid", "strip_zeros")),
            ("match", _match("asset_tag", "ignore_case")),
            ("match", _match("serial", "ignore_case")),
            ("not_found", {"message": "No match"}),
        ],
        "record_scan",
    ),
}

TEST_ASSETS: list[dict] = [
    # RFID stored padded, scanned without zeros
    {
        "asset_tag": 101,
        "name": "Test asset 1",
        "rfid": "000000000000000000000A1B",
        "serial": "SER-101",
        "sits": "move",
    },
    # asset tag that is another asset's RFID
    {
        "asset_tag": 102,
        "name": "Test asset 2",
        "rfid": "00000000000000000000B002",
        "serial": "SER-102",
        "sits": "move",
    },
    # (the RFID that equals 102)
    {
        "asset_tag": 103,
        "name": "Test asset 3",
        "rfid": "000000000000000000000102",
        "serial": "SER-103",
        "sits": "move",
    },
    # mixed-case serial
    {"asset_tag": 104, "name": "Test asset 4", "rfid": None, "serial": "AbC-104x", "sits": "move"},
    # "007" for asset 7
    {
        "asset_tag": 7,
        "name": "Test asset 5",
        "rfid": "000000000000000000000C05",
        "serial": "SER-007",
        "sits": "move",
    },
    # name part of another name; first of two
    {
        "asset_tag": 106,
        "name": "Test asset 6",
        "rfid": "000000000000000000000C06",
        "serial": "DUP-200",
        "sits": "move",
    },
    # second of two
    {
        "asset_tag": 107,
        "name": "Test asset 6B",
        "rfid": "000000000000000000000C07",
        "serial": "DUP-200",
        "sits": "move",
    },
    # client's other device
    {
        "asset_tag": 108,
        "name": "Test asset 8",
        "rfid": "000000000000000000000C08",
        "serial": "CLT-108",
        "sits": "client",
    },
]


def _rows(place: str, rows: list[tuple[str, str, int]]) -> list[dict]:
    return [
        {"asset_tag": tag, "place": place, "value": value, "expected": expected}
        for value, expected, tag in rows
    ]


TEST_ROWS: list[dict] = _rows(
    "printing",
    [
        ("101", "asset_tag", 101),
        ("A1B", "not_found", 101),
        ("102", "asset_tag", 102),
        ("abc-104X", "serial", 104),
        ("007", "not_found", 7),
        ("7", "asset_tag", 7),
        ("dup-200", "serial", 106),
        ("Test asset 6", "not_found", 106),
        ("CLT-108", "not_found", 108),
    ],
) + _rows(
    "scanning",
    [
        ("A1B", "rfid", 101),
        ("102", "rfid", 103),
        ("SER-103", "serial", 103),
        ("abc-104X", "serial", 104),
        ("007", "not_found", 7),
        ("7", "asset_tag", 7),
        ("DUP-200", "serial", 106),
        ("Test asset 6", "not_found", 106),
        ("CLT-108", "not_found", 108),
    ],
)

_INSERT_VERSION = (
    "INSERT INTO matching_rule_versions (place, version, state, flow, state_changed_at) "
    "VALUES (:place, 1, 'live', CAST(:flow AS jsonb), now())"
)
_INSERT_ASSET = (
    "INSERT INTO matching_test_assets (asset_tag, name, rfid, serial, sits) "
    "VALUES (:asset_tag, :name, :rfid, :serial, :sits)"
)
_INSERT_ROW = (
    "INSERT INTO matching_test_rows (test_asset_id, place, value, expected) "
    "SELECT id, :place, :value, :expected FROM matching_test_assets WHERE asset_tag = :asset_tag"
)


def seed_statements() -> list[tuple[str, dict]]:
    """Plain-SQL inserts with bind params; migration 0126 and the test reset both run them."""
    out: list[tuple[str, dict]] = [
        (_INSERT_VERSION, {"place": place, "flow": json.dumps(flow)})
        for place, flow in V1_FLOWS.items()
    ]
    out += [(_INSERT_ASSET, dict(a)) for a in TEST_ASSETS]
    out += [(_INSERT_ROW, dict(r)) for r in TEST_ROWS]
    return out


async def reset_matching_seed(session: "AsyncSession") -> None:
    """Empty the matching tables and put 0126's rows back (the test DB reset)."""
    from sqlalchemy import text  # here, so the migration's import stays light

    await session.execute(
        text("TRUNCATE matching_test_rows, matching_test_assets, matching_rule_versions")
    )
    for sql, params in seed_statements():
        await session.execute(text(sql), params)
