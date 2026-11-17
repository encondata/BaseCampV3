"""Matching rules versions API: drafts, standby, deploy, rollback and audit,
under Developer (`devtools`) only. At most one Live version per place."""

import asyncio
import copy

import pytest
from sqlalchemy import select, text

from serversherpa.db.models import AuditLog
from serversherpa.matching_rules import versions
from serversherpa.matching_rules.seed import V1_FLOWS
from tests.test_devtools import login as devtools_login
from tests.test_devtools import set_role

URL = "/devtools/matching-rules"


async def dev(client, db, seeded_user, role="developer"):
    await set_role(db, seeded_user.id, role)
    return await devtools_login(client)


async def _list(client, h, place="printing"):
    r = await client.get(f"{URL}/versions?place={place}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _v1(client, h, place="printing"):
    [v1] = [v for v in await _list(client, h, place) if v["version"] == 1]
    return v1


async def _by_version(client, h, place="printing"):
    return {v["version"]: v for v in await _list(client, h, place)}


async def draft(client, h, place="printing", flow=None, based_on_id=None):
    body = {"place": place, "flow": flow or V1_FLOWS[place]}
    if based_on_id:
        body["based_on_id"] = based_on_id
    r = await client.post(f"{URL}/versions", headers=h, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def unwired_printing():
    """V1 printing with the serial Match's "none" wire dropped."""
    flow = copy.deepcopy(V1_FLOWS["printing"])
    serial = next(n["id"] for n in flow["nodes"]
                  if n["kind"] == "match" and n["settings"]["field"] == "serial")
    flow["edges"] = [e for e in flow["edges"]
                     if not (e["source"] == serial and e["output"] == "none")]
    return flow


async def _add_name_row(db):
    """A printing row v1 can't pass: it never matches by name."""
    await db.execute(text(
        "INSERT INTO matching_test_rows (test_asset_id, place, value, expected) "
        "SELECT id, 'printing', 'Test asset 1', 'name' "
        "FROM matching_test_assets WHERE asset_tag = 101"))
    await db.commit()


async def _audits(db, action):
    return list((await db.execute(
        select(AuditLog).where(AuditLog.action == action)
        .order_by(AuditLog.at))).scalars().all())


async def test_list_shows_live_v1(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    r = await client.get(f"{URL}/versions?place=printing", headers=h)
    assert r.status_code == 200, r.text
    [v] = r.json()
    assert (v["version"], v["state"], v["saved_by_name"]) == (1, "live", None)
    assert v["current"] == {"passed": 9, "total": 9, "ok": True, "checked_at": None}


@pytest.mark.parametrize("role", ["founder", "super_admin", "admin", "staff"])
async def test_only_developers(client, db, seeded_user, role):
    h = await dev(client, db, seeded_user, role)
    assert (await client.get(f"{URL}/versions?place=printing", headers=h)).status_code == 403
    v1_id = (await db.scalar(text(
        "SELECT id FROM matching_rule_versions WHERE place = 'printing'")))
    assert (await client.get(f"{URL}/versions/{v1_id}", headers=h)).status_code == 403
    r = await client.post(f"{URL}/versions", headers=h,
                          json={"place": "printing", "flow": V1_FLOWS["printing"]})
    assert r.status_code == 403
    assert (await client.post(f"{URL}/versions/{v1_id}/rollback", headers=h)).status_code == 403


async def test_create_draft_numbers_next_version_and_audits(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    v1 = await _v1(client, h)
    r = await client.post(f"{URL}/versions", headers=h, json={
        "place": "printing", "flow": V1_FLOWS["printing"], "based_on_id": v1["id"]})
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["version"], body["state"], body["based_on_version"]) == (2, "draft", 1)
    assert body["saved_by_name"] == "Alice Anderson" and body["checked"] is None
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "matching_rules.save"))
    assert row.changes == {"place": "printing", "version": 2, "created": True}
    assert row.actor_person_id == seeded_user.id
    assert (row.entity_type, row.entity_id) == ("matching_rule_version", body["id"])
    # the other place numbers on its own
    assert (await draft(client, h, "scanning"))["version"] == 2
    assert (await draft(client, h, "printing"))["version"] == 3


async def test_create_rejects_extra_fields(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    r = await client.post(f"{URL}/versions", headers=h, json={
        "place": "printing", "flow": V1_FLOWS["printing"], "state": "live"})
    assert r.status_code == 422


async def test_based_on_other_place_is_422(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    scanning_v1 = await _v1(client, h, "scanning")
    r = await client.post(f"{URL}/versions", headers=h, json={
        "place": "printing", "flow": V1_FLOWS["printing"], "based_on_id": scanning_v1["id"]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "wrong_place"


async def test_draft_may_fail_the_check(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    body = await draft(client, h, flow=unwired_printing())
    assert body["state"] == "draft"
    assert body["check"]["ok"] is False and body["check"]["structure_ok"] is False
    assert body["current"]["ok"] is False


async def test_only_drafts_are_edited(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    v1 = await _v1(client, h)
    r = await client.put(f"{URL}/versions/{v1['id']}", headers=h,
                         json={"flow": unwired_printing()})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_draft"

    d = await draft(client, h, flow=unwired_printing())
    r = await client.put(f"{URL}/versions/{d['id']}", headers=h,
                         json={"flow": V1_FLOWS["printing"]})
    assert r.status_code == 200, r.text
    assert r.json()["flow"] == V1_FLOWS["printing"] and r.json()["check"]["ok"] is True
    saves = await _audits(db, "matching_rules.save")
    assert [a.changes for a in saves] == [
        {"place": "printing", "version": 2, "created": True},
        {"place": "printing", "version": 2, "created": False},
    ]


async def test_standby_needs_the_check(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    bad = await draft(client, h, flow=unwired_printing())
    r = await client.post(f"{URL}/versions/{bad['id']}/standby", headers=h)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "check_failed"
    assert r.json()["detail"]["check"]["structure_ok"] is False
    assert (await _by_version(client, h))[2]["state"] == "draft"

    good = await draft(client, h)
    r = await client.post(f"{URL}/versions/{good['id']}/standby", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "standby" and body["state_changed_at"] is not None
    assert body["checked"]["passed"] == 9 and body["checked"]["total"] == 9
    assert body["checked"]["ok"] is True and body["checked"]["checked_at"] is not None
    [a] = await _audits(db, "matching_rules.standby")
    assert a.changes == {"place": "printing", "version": 3}
    # standby is only from draft
    r = await client.post(f"{URL}/versions/{good['id']}/standby", headers=h)
    assert r.status_code == 409 and r.json()["detail"] == {"code": "bad_state",
                                                           "state": "standby"}


async def test_deploy_retires_the_old_live(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    d = await draft(client, h)
    r = await client.post(f"{URL}/versions/{d['id']}/deploy", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "live" and r.json()["checked"]["ok"] is True
    vs = await _by_version(client, h)
    assert (vs[1]["state"], vs[2]["state"]) == ("retired", "live")
    [a] = await _audits(db, "matching_rules.deploy")
    assert a.changes == {"place": "printing", "version": 2, "retired_version": 1}
    # the other place is untouched
    assert (await _v1(client, h, "scanning"))["state"] == "live"


async def test_deploy_from_standby(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    d = await draft(client, h)
    assert (await client.post(f"{URL}/versions/{d['id']}/standby", headers=h)).status_code == 200
    r = await client.post(f"{URL}/versions/{d['id']}/deploy", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "live"
    vs = await _by_version(client, h)
    assert (vs[1]["state"], vs[2]["state"]) == ("retired", "live")


async def test_deploy_needs_the_check(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    bad = await draft(client, h, flow=unwired_printing())
    r = await client.post(f"{URL}/versions/{bad['id']}/deploy", headers=h)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "check_failed"
    vs = await _by_version(client, h)
    assert (vs[1]["state"], vs[2]["state"]) == ("live", "draft")
    assert await _audits(db, "matching_rules.deploy") == []


async def test_deploying_a_live_version_is_409(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    v1 = await _v1(client, h)
    r = await client.post(f"{URL}/versions/{v1['id']}/deploy", headers=h)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "bad_state", "state": "live"}


async def test_rollback_to_retired(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    v1 = await _v1(client, h)
    d = await draft(client, h)
    assert (await client.post(f"{URL}/versions/{d['id']}/deploy", headers=h)).status_code == 200
    r = await client.post(f"{URL}/versions/{v1['id']}/rollback", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "live" and r.json()["checked"]["ok"] is True
    vs = await _by_version(client, h)
    assert (vs[1]["state"], vs[2]["state"]) == ("live", "retired")
    [a] = await _audits(db, "matching_rules.rollback")
    assert a.changes == {"place": "printing", "version": 1, "retired_version": 2}
    assert (a.entity_type, a.entity_id) == ("matching_rule_version", v1["id"])


async def test_rollback_only_from_retired(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    d = await draft(client, h)
    r = await client.post(f"{URL}/versions/{d['id']}/rollback", headers=h)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "bad_state", "state": "draft"}


async def test_rollback_must_pass_todays_test_set(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    v1 = await _v1(client, h)
    d = await draft(client, h)
    assert (await client.post(f"{URL}/versions/{d['id']}/deploy", headers=h)).status_code == 200
    await _add_name_row(db)
    r = await client.post(f"{URL}/versions/{v1['id']}/rollback", headers=h)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "check_failed"
    check = r.json()["detail"]["check"]
    assert check["structure_ok"] is True and (check["passed"], check["total"]) == (9, 10)
    vs = await _by_version(client, h)
    assert (vs[1]["state"], vs[2]["state"]) == ("retired", "live")


async def test_live_failing_today_is_flagged_not_retired(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    await _add_name_row(db)
    [v] = await _list(client, h)
    assert v["state"] == "live"
    assert v["current"] == {"passed": 9, "total": 10, "ok": False, "checked_at": None}


async def test_concurrent_deploys_leave_one_live(client, db, seeded_user, monkeypatch):
    """Each request has its own pooled connection, but left alone the first
    deploy commits before the second has finished signing in, so nothing
    overlaps. A barrier holds both until each has read its version and is
    about to lock the place: then they really contend, the second waits for
    the first to commit and retires the first's version (not v1 again)
    rather than tripping the one-live index."""
    real_lock = versions._lock_place
    barrier = asyncio.Barrier(2)
    seen: list[dict[int, str]] = []

    async def lock_together(session, place):
        await asyncio.wait_for(barrier.wait(), timeout=10)
        rows = await real_lock(session, place)
        seen.append({r.version: r.state for r in rows})
        return rows

    monkeypatch.setattr(versions, "_lock_place", lock_together)
    h = await dev(client, db, seeded_user)
    a, b = (await draft(client, h))["id"], (await draft(client, h))["id"]
    ra, rb = await asyncio.gather(
        client.post(f"{URL}/versions/{a}/deploy", headers=h),
        client.post(f"{URL}/versions/{b}/deploy", headers=h))
    assert (ra.status_code, rb.status_code) == (200, 200), (ra.text, rb.text)
    assert await db.scalar(text(
        "SELECT count(*) FROM matching_rule_versions "
        "WHERE place = 'printing' AND state = 'live'")) == 1
    vs = await _by_version(client, h)
    winner = next(n for n, v in vs.items() if v["state"] == "live")
    first = {2: 3, 3: 2}[winner]
    assert (vs[1]["state"], vs[first]["state"]) == ("retired", "retired")
    # the second locker saw the first's commit, not the v1-live state both started from
    assert seen == [{1: "live", 2: "draft", 3: "draft"},
                    {1: "retired", first: "live", winner: "draft"}]
    retired = sorted(x.changes["retired_version"]
                     for x in await _audits(db, "matching_rules.deploy"))
    assert retired == [1, first]


_TAKE_NUMBER = text(
    "INSERT INTO matching_rule_versions (place, version, state, flow) "
    "VALUES ('printing', :v, 'draft', '{}'::jsonb)")


async def _holder(version):
    """A session holding printing `version` uncommitted, and its backend pid."""
    from serversherpa.db.engine import get_sessionmaker

    s = get_sessionmaker()()
    pid = await s.scalar(text("SELECT pg_backend_pid()"))
    await s.execute(_TAKE_NUMBER, {"v": version})
    return s, pid


async def _until_blocked_by(pid):
    """Wait until some backend is waiting on `pid` (the save's insert)."""
    from serversherpa.db.engine import get_sessionmaker

    async with get_sessionmaker()() as s:
        for _ in range(200):
            if await s.scalar(text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE :pid = ANY(pg_blocking_pids(pid))"), {"pid": pid}):
                return
            await asyncio.sleep(0.05)
    raise AssertionError(f"nothing waited on backend {pid}")


async def test_save_retries_a_taken_number(client, db, seeded_user):
    """Another save takes v2 between this one's max and insert: it numbers 3."""
    h = await dev(client, db, seeded_user)
    x, x_pid = await _holder(2)
    try:
        save = asyncio.create_task(client.post(
            f"{URL}/versions", headers=h,
            json={"place": "printing", "flow": V1_FLOWS["printing"]}))
        await _until_blocked_by(x_pid)
        await x.commit()
        r = await asyncio.wait_for(save, timeout=10)
    finally:
        await x.close()
    assert r.status_code == 201, r.text
    assert r.json()["version"] == 3


async def test_save_gives_up_after_one_retry(client, db, seeded_user):
    """Taken again on the retry: 409 version_conflict, nothing saved or audited."""
    h = await dev(client, db, seeded_user)
    x, x_pid = await _holder(2)
    y, y_pid = await _holder(3)
    try:
        save = asyncio.create_task(client.post(
            f"{URL}/versions", headers=h,
            json={"place": "printing", "flow": V1_FLOWS["printing"]}))
        await _until_blocked_by(x_pid)
        await x.commit()            # the save retries, reads max 2, waits on y's 3
        await _until_blocked_by(y_pid)
        await y.commit()
        r = await asyncio.wait_for(save, timeout=10)
    finally:
        await x.close()
        await y.close()
    assert r.status_code == 409 and r.json()["detail"] == {"code": "version_conflict"}
    assert await db.scalar(text(
        "SELECT count(*) FROM matching_rule_versions WHERE place = 'printing'")) == 3
    assert await _audits(db, "matching_rules.save") == []


async def test_save_waits_for_a_state_change_then_refuses(client, db, seeded_user):
    """A save racing a standby of the same draft must not rewrite the flow that
    was just checked: it waits for the state change, then gives not_draft."""
    from serversherpa.db.engine import get_sessionmaker

    h = await dev(client, db, seeded_user)
    d = await draft(client, h)
    x = get_sessionmaker()()
    try:
        x_pid = await x.scalar(text("SELECT pg_backend_pid()"))
        await x.execute(text(
            "UPDATE matching_rule_versions SET state = 'standby' WHERE id = :id"),
            {"id": d["id"]})
        save = asyncio.create_task(client.put(
            f"{URL}/versions/{d['id']}", headers=h, json={"flow": unwired_printing()}))
        await _until_blocked_by(x_pid)
        await x.commit()
        r = await asyncio.wait_for(save, timeout=10)
    finally:
        await x.close()
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_draft"
    detail = (await client.get(f"{URL}/versions/{d['id']}", headers=h)).json()
    assert detail["flow"] == V1_FLOWS["printing"]


async def test_detail_has_flow_and_full_check(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    v1 = await _v1(client, h)
    r = await client.get(f"{URL}/versions/{v1['id']}", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["flow"] == V1_FLOWS["printing"]
    assert len(body["check"]["tests"]) == 9 and len(body["check"]["structure"]) == 7
    assert body["check"]["ok"] is True
    t = next(t for t in body["check"]["tests"] if t["value"] == "abc-104X")
    assert (t["asset_tag"], t["asset_name"], t["expected"], t["outcome"]) == (
        104, "Test asset 4", "serial", "found")
    assert (t["found_asset_tag"], t["found_field"], t["passed"]) == (104, "serial", True)
    s = body["check"]["structure"][0]
    assert (s["code"], s["ok"], s["problems"]) == ("one_scan_input", True, [])


async def test_unknown_version_is_404(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    r = await client.get(f"{URL}/versions/00000000-0000-0000-0000-000000000000", headers=h)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "version_not_found"


async def test_other_place_is_422(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    r = await client.get(f"{URL}/versions?place=containers", headers=h)
    assert r.status_code == 422
