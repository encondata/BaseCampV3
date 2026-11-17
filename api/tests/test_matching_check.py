import uuid
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from serversherpa.api.routes.kiosk import _assets_body
from serversherpa.db.models import Asset, Client, Initiative, InitiativeAsset
from serversherpa.matching_rules.check import (
    check_flow,
    move_targets,
    uses_client,
)
from serversherpa.matching_rules.flow import PLACES, Flow
from serversherpa.matching_rules.seed import V1_FLOWS
from tests import matching_helpers as h


def printing_v1_without_serial_match() -> Flow:
    """V1 printing with the serial Match's found output dropped, so it falls to Not found."""
    raw = V1_FLOWS["printing"]
    serial_ids = {n["id"] for n in raw["nodes"]
                  if n["kind"] == "match" and n["settings"]["field"] == "serial"}
    assert serial_ids
    data = {"nodes": raw["nodes"], "edges": [dict(e) for e in raw["edges"]]}
    for e in data["edges"]:
        if e["source"] in serial_ids and e["output"] == "found":
            nf = next(x["target"] for x in raw["edges"] if x["source"] in serial_ids
                      and x["output"] == "none")
            e["target"] = nf
    return Flow.model_validate(data)


async def test_v1_passes_the_seeded_test_set(db):
    for place in PLACES:
        res = await check_flow(db, place, Flow.model_validate(V1_FLOWS[place]))
        assert (res.ok, res.passed, res.total) == (True, 9, 9)


async def test_a_failing_row_is_reported(db):
    res = await check_flow(db, "printing", printing_v1_without_serial_match())
    failed = {r.row.value: r.result.outcome for r in res.rows if not r.passed}
    assert failed == {"abc-104X": "not_found", "dup-200": "not_found"}
    assert (res.passed, res.ok) == (7, False)


async def test_check_fails_with_no_rows_for_place(db):
    await db.execute(text("DELETE FROM matching_test_rows WHERE place = 'scanning'"))
    await db.commit()
    res = await check_flow(db, "scanning", Flow.model_validate(V1_FLOWS["scanning"]))
    assert (res.total, res.tests_ok, res.ok) == (0, False, False) and res.structure_ok


async def test_broken_structure_still_runs_tests(db):
    flow = h.GOOD_without_edge("n3", "found")
    res = await check_flow(db, "printing", flow)
    assert not res.structure_ok and res.total == 9 and not res.ok
    tag_rows = [r for r in res.rows if r.row.expected == "asset_tag"]
    assert tag_rows
    assert all(r.result.outcome == "stopped" and r.result.stop_reason == "unwired"
               and not r.passed for r in tag_rows)


async def test_summary(db):
    res = await check_flow(db, "printing", Flow.model_validate(V1_FLOWS["printing"]))
    now = datetime(2026, 11, 10, tzinfo=UTC)
    assert res.summary(now) == {
        "passed": 9, "total": 9, "ok": True, "checked_at": now.isoformat()}


def test_uses_client():
    assert not uses_client(h.GOOD)
    nodes = [h.scan("n1"), h.match_node("n3", search_in="move_and_client"),
             h.found("n4"), h.not_found("n5")]
    flow = h.make_flow(nodes, [("e1", "n1", "out", "n3"), ("e3", "n3", "found", "n4"),
                               ("e4", "n3", "none", "n5")])
    assert uses_client(flow)


async def seed_move(db):
    cx, cy = Client(name="Client X"), Client(name="Client Y")
    db.add_all([cx, cy])
    await db.flush()

    def mv(name, cid):
        return Initiative(name=name, initiative_type="move", status="in_progress", client_id=cid)

    sel, other, other2 = mv("Sel", cx.id), mv("X Other", cx.id), mv("X Other 2", cx.id)
    ymove = mv("Y Move", cy.id)
    proj = Initiative(name="Proj", initiative_type="project", status="in_progress")
    db.add_all([sel, other, other2, ymove, proj])
    await db.flush()
    a3 = Asset(name="three", serial_number="S3", legacy_id=300)
    a1 = Asset(name="one", serial_number="S1", legacy_id=100)
    a2 = Asset(name="two", serial_number="S2", legacy_id=200, archived_at=datetime.now(UTC))
    ax = Asset(name="x-asset", serial_number="SX", rfid_tag="RX", legacy_id=400)
    ay = Asset(name="y-asset", serial_number="SY", legacy_id=500)
    db.add_all([a3, a1, a2, ax, ay])
    await db.flush()
    db.add_all([
        InitiativeAsset(initiative_id=sel.id, asset_id=a3.id),
        InitiativeAsset(initiative_id=sel.id, asset_id=a1.id),
        InitiativeAsset(initiative_id=sel.id, asset_id=a2.id),
        InitiativeAsset(initiative_id=other.id, asset_id=ax.id),
        InitiativeAsset(initiative_id=other2.id, asset_id=ax.id),
        InitiativeAsset(initiative_id=ymove.id, asset_id=ay.id),
    ])
    await db.commit()
    return {"move": sel.id, "project": proj.id, "archived": str(a2.id),
            "on_two_moves": str(ax.id)}


async def test_move_targets_are_the_kiosk_sync(db):
    s = await seed_move(db)
    body = await _assets_body(db, s["move"])
    ts = await move_targets(db, s["move"], with_client=False)
    assert [t.key for t in ts] == [str(a.id) for a in body.assets]
    assert [t.asset_tag for t in ts] == [100, 200, 300]
    assert s["archived"] in {t.key for t in ts}
    assert {t.sits for t in ts} == {"move"}


async def test_move_targets_with_client_dedupes(db):
    s = await seed_move(db)
    ts = await move_targets(db, s["move"], with_client=True)
    client = [t for t in ts if t.sits == "client"]
    assert [t.key for t in client] == [s["on_two_moves"]]
    assert len([t for t in ts if t.sits == "move"]) == 3


async def test_move_targets_errors(db):
    s = await seed_move(db)
    with pytest.raises(HTTPException) as e:
        await move_targets(db, uuid.uuid4(), with_client=False)
    assert e.value.status_code == 404 and e.value.detail["code"] == "initiative_not_found"
    with pytest.raises(HTTPException) as e:
        await move_targets(db, s["project"], with_client=False)
    assert e.value.status_code == 422 and e.value.detail["code"] == "bad_initiative"
