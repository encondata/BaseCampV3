"""Create a move in steps — the crate estimate from the From-To check."""

import pytest

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import Asset, AssetModel
from serversherpa.imports.crate_estimate import crates_needed, estimate, with_headroom
from serversherpa.imports.worker import run_once
from tests.test_move_setup_api import (  # noqa: F401
    BASE,
    admin_hdrs,
    make_sites,
    new_draft,
    upload_assets,
)


@pytest.mark.parametrize(("sizes", "crates"), [
    ([], 0),
    ([1], 1),
    ([1] * 20, 1),                   # two full stacks of 1U
    ([1] * 21, 2),
    ([10, 10], 1),                   # one 10U per stack
    ([6, 6], 1),                     # can't share a stack: 6 + 6 > 10, two stacks = one crate
    ([6, 6, 6], 2),                  # three stacks
    ([6, 4, 6, 4], 1),               # 6+4 and 6+4
    ([6, 6, 2, 2, 1, 1, 1, 1], 1),   # 1U fill the gaps 6+2 leave
    ([6, 6, 1, 1, 1, 1, 1, 1, 1, 1, 1], 2),   # 8 gaps, 9 ones: a third stack
    ([3, 3, 3, 3], 1),               # 3+3+3 then 3: two stacks
    ([14], 1),                       # over 10U: a crate of its own
    ([14, 12, 2], 3),                # two sole crates plus one stack
    ([11, 1], 2),
])
def test_crates_needed(sizes, crates):
    assert crates_needed(sizes) == crates


@pytest.mark.parametrize(("needed", "suggested"), [(0, 0), (1, 2), (4, 5), (19, 24), (20, 25)])
def test_headroom_adds_a_quarter_rounded_up(needed, suggested):
    assert with_headroom(needed) == suggested


def _row(serial, model_id=None, status="created"):
    return {"serial_number": serial, "status": status,
            "model_id": str(model_id) if model_id else None}


async def test_estimate_leaves_out_racks_and_nodes_and_counts_unknown_as_2u(db):
    server = AssetModel(make="Dell", model="R740", ru_size=2, category="server")
    big = AssetModel(make="NetApp", model="Shelf", ru_size=14, category="storage")
    rack = AssetModel(make="APC", model="AR3100", ru_size=42, category="rack")
    node = AssetModel(make="Dell", model="C6420", ru_size=1, form_factor="node")
    sizeless = AssetModel(make="Acme", model="Box")
    zero = AssetModel(make="APC", model="PDU", ru_size=0, category="power")
    db.add_all([server, big, rack, node, sizeless, zero])
    await db.flush()
    details = [
        _row("a", server.id), _row("b", server.id), _row("B", server.id),   # B repeats b
        _row("c", big.id), _row("d", rack.id), _row("e", node.id),
        _row("f", sizeless.id), _row("g", zero.id), _row("h"),
        _row("i", status="review"), _row("j", status="error"),
    ]
    got = await estimate(db, details)
    # sizes: 2, 2, 14, 2 (sizeless), 2 (0U), 2 (no model), 2 (review)
    assert got["devices"] == 7
    assert got["ru"] == 26
    assert got["racks"] == 1 and got["nodes"] == 1
    assert got["unknown_size"] == 4
    assert got["over_10u"] == 1
    # 14U → 1 crate; six 2U → 10 + 2 → two stacks → 1 crate; 2 → +25% → 3
    assert got["needed"] == 2
    assert got["crates"] == got["uncapped"] == 3


async def test_estimate_is_capped_at_the_crate_limit(db):
    big = AssetModel(make="IBM", model="Frame", ru_size=20, category="storage")
    db.add(big)
    await db.flush()
    got = await estimate(db, [_row(f"s{i}", big.id) for i in range(450)])
    assert got["needed"] == 450
    assert got["uncapped"] == 563
    assert got["crates"] == 500


async def test_the_check_job_carries_the_estimate(client, db, admin_hdrs):  # noqa: F811
    db.add_all([AssetModel(make="Dell", model="R740", ru_size=2, category="server"),
                AssetModel(make="APC", model="AR3100", ru_size=42, category="rack")])
    await db.flush()
    existing_model = AssetModel(make="Cisco", model="N9K", ru_size=1, category="network")
    db.add(existing_model)
    await db.flush()
    db.add(Asset(serial_number="SN-OLD", model_id=existing_model.id))
    await db.commit()
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    csv = (b"Serial Number,Asset Name,Asset Make,Asset Model\n"
           b"SN-1,web-01,Dell,R740\nSN-2,web-02,Dell,R740\n"
           b"SN-3,rack-01,APC,AR3100\nSN-OLD,sw-01,,\n")
    assert (await upload_assets(client, admin_hdrs, draft["id"], content=csv)).status_code == 201
    assert await run_once(get_sessionmaker()) is True
    done = (await client.get(f"{BASE}/{draft['id']}/assets", headers=admin_hdrs)).json()
    assert done["status"] == "completed"
    est = done["results"]["crate_estimate"]
    assert est["devices"] == 3 and est["ru"] == 5 and est["racks"] == 1
    assert est["unknown_size"] == 0
    assert est["crates"] == 2      # one stack → 1 crate → +25% → 2
