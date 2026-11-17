"""Matching rules check and test-run API: reads only, developer (`devtools`) only."""

import copy

from sqlalchemy import func, select

from serversherpa.api.deps import READ_ONLY_EXEMPT_PATHS
from serversherpa.db.models import Asset, AuditLog, ProcessedScan, RawScan
from serversherpa.matching_rules.models import MatchingRuleVersion, MatchingTestRow
from serversherpa.matching_rules.seed import V1_FLOWS
from tests.test_matching_check import seed_move
from tests.test_matching_versions_api import URL, dev
from tests.test_status_values_write import _make


def _run_body(value, place="scanning", against="test_set", flow=None, **extra):
    return {"place": place, "flow": flow or V1_FLOWS[place], "value": value,
            "against": against, **extra}


async def _counts(db) -> list[int]:
    return [
        await db.scalar(select(func.count()).select_from(model))
        for model in (RawScan, ProcessedScan, Asset, MatchingRuleVersion,
                      MatchingTestRow, AuditLog)
    ]


async def test_check_an_unsaved_flow(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    r = await client.post(f"{URL}/check", headers=h,
                          json={"place": "printing", "flow": V1_FLOWS["printing"]})
    assert r.status_code == 200, r.text
    b = r.json()
    assert (b["ok"], b["passed"], b["total"], len(b["structure"])) == (True, 9, 9, 7)


async def test_test_run_against_the_test_set(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    r = await client.post(f"{URL}/test-run", headers=h, json=_run_body("102"))
    assert r.status_code == 200, r.text
    b = r.json()
    assert (b["outcome"], b["field"], b["asset"]["asset_tag"], b["action"]) == (
        "found", "rfid", 103, "record_scan")
    assert [s["kind"] for s in b["trace"]] == [
        "scan_input", "clean_up", "clean_up", "match", "found"]


async def test_test_run_writes_nothing(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    s = await seed_move(db)
    before = await _counts(db)
    r = await client.post(f"{URL}/test-run", headers=h, json=_run_body("102"))
    assert r.status_code == 200, r.text
    r = await client.post(f"{URL}/test-run", headers=h, json=_run_body(
        "s1", place="printing", against="move", initiative_id=str(s["move"])))
    assert r.status_code == 200, r.text
    await db.rollback()
    assert await _counts(db) == before


async def test_test_run_against_a_move(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    s = await seed_move(db)
    a1 = await db.scalar(select(Asset).where(Asset.serial_number == "S1"))
    r = await client.post(f"{URL}/test-run", headers=h, json=_run_body(
        "s1", place="printing", against="move", initiative_id=str(s["move"])))
    assert r.status_code == 200, r.text
    b = r.json()
    assert (b["outcome"], b["field"], b["asset"]["id"]) == ("found", "serial", str(a1.id))


async def test_move_run_needs_a_move(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    r = await client.post(f"{URL}/test-run", headers=h,
                          json=_run_body("s1", place="printing", against="move"))
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "initiative_required")


async def test_move_run_unknown_or_not_a_move(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    s = await seed_move(db)
    unknown = "00000000-0000-4000-8000-000000000001"
    r = await client.post(f"{URL}/test-run", headers=h, json=_run_body(
        "s1", place="printing", against="move", initiative_id=unknown))
    assert (r.status_code, r.json()["detail"]["code"]) == (404, "initiative_not_found")
    r = await client.post(f"{URL}/test-run", headers=h, json=_run_body(
        "s1", place="printing", against="move", initiative_id=str(s["project"])))
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "bad_initiative")


async def test_test_run_blank_value_422(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    for blank in ("   ", " ﻿\t"):
        r = await client.post(f"{URL}/test-run", headers=h, json=_run_body(blank))
        assert (r.status_code, r.json()["detail"]["code"]) == (422, "value_required")


async def test_stopped_run_is_200(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    flow = copy.deepcopy(V1_FLOWS["printing"])
    flow["edges"] = []
    r = await client.post(f"{URL}/test-run", headers=h,
                          json=_run_body("101", place="printing", flow=flow))
    assert r.status_code == 200, r.text
    b = r.json()
    assert (b["outcome"], b["stop_reason"]) == ("stopped", "unwired")
    assert b["end_node_id"] is not None


async def test_runs_work_in_read_only_mode(client, db, seeded_user):
    # developers skip read-only enforcement, so the freeze is proven by the
    # exemption list, and by a developer still running while it is on
    assert {f"{URL}/check", f"{URL}/test-run"} <= READ_ONLY_EXEMPT_PATHS
    sa = await _make(db, client, "super_admin", "sa@test.example.com")
    assert (await client.put("/system/admin", headers=sa,
                             json={"read_only": True})).status_code == 200
    h = await dev(client, db, seeded_user)
    r = await client.post(f"{URL}/check", headers=h,
                          json={"place": "printing", "flow": V1_FLOWS["printing"]})
    assert r.status_code == 200, r.text
    r = await client.post(f"{URL}/test-run", headers=h, json=_run_body("102"))
    assert r.status_code == 200, r.text


async def test_runs_need_devtools(client, db, seeded_user):
    h = await dev(client, db, seeded_user, role="founder")
    r = await client.post(f"{URL}/check", headers=h,
                          json={"place": "printing", "flow": V1_FLOWS["printing"]})
    assert r.status_code == 403
    r = await client.post(f"{URL}/test-run", headers=h, json=_run_body("102"))
    assert r.status_code == 403
