"""POST /plans/{plan_id}/ops: links (add_link, update_link, delete_link), the
Predecessors cell (`update_task.fields.predecessors`) and assignees
(`set_assignees`), with the engine's link errors and the undo.

Reference week (Standard calendar): the plan starts Mon 2026-11-02 08:00."""

import time
import uuid
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import delete, select

from serversherpa.db.models import InitiativePerson, Partner, Person
from serversherpa.plans.models import PlanLink
from serversherpa.plans.ops import apply_ops
from serversherpa.plans.schemas import AddLinkOp, RestoreOp, SetAssigneesOp, UpdateTaskOp
from serversherpa.plans.service import load_state, settings_of
from tests.test_plans_api import _actor, _create, _initiative, _plan_row
from tests.test_plans_ops import _add, _by_id, _fails, _get, _ok, _setup, _update

# ── helpers ──────────────────────────────────────────────────────────


def _link(pred, succ, **fields) -> dict:
    return {"op": "add_link", "predecessor_id": pred, "successor_id": succ, **fields}


def _assign(task_id, *resources) -> dict:
    return {"op": "set_assignees", "task_id": task_id,
            "resources": [{"kind": kind, "id": str(rid)} for kind, rid in resources]}


def _view(body) -> dict:
    """A GET body without its clock (`now` ticks between calls)."""
    return {k: v for k, v in body.items() if k != "now"}


def _tasks(body) -> dict[str, dict]:
    """A GET body's tasks by name."""
    return {t["name"]: t for t in body["tasks"]}


async def _resources(db, move):
    """A team worker and a partner linked on the initiative."""
    worker = Person(first_name="Wanda", last_name="Worker")
    shipper = Partner(name="Champagne Logistics")
    db.add_all([worker, shipper])
    await db.flush()
    db.add(InitiativePerson(initiative_id=move.id, person_id=worker.id))
    move.shipping_partner_id = shipper.id
    await db.commit()
    return worker, shipper


async def _two(client, db):
    """A 2-day A and a 1-day B."""
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", duration="2d")
    ids.update(await _add(client, hdrs, plan, "B"))
    return hdrs, move, plan, ids


async def _db_links(db, move) -> list[PlanLink]:
    row = await _plan_row(db, move)
    return (await db.scalars(select(PlanLink).where(PlanLink.plan_id == row.id)
                             .execution_options(populate_existing=True))).all()


# ── add / update / delete ────────────────────────────────────────────


async def test_add_fs_link_moves_successor(client, db):
    hdrs, _move, plan, ids = await _two(client, db)
    body = await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    b = _by_id(body)[ids["B"]]
    assert b["start"] == "2026-11-04T08:00" and b["finish"] == "2026-11-04T17:00"
    assert len(body["links"]) == 1
    link = body["links"][0]
    assert (link["predecessor_id"], link["successor_id"]) == (ids["A"], ids["B"])
    assert link["link_type"] == "FS" and link["lag_minutes"] == 0
    assert body["order"] is None

    got = await _get(client, hdrs, plan)
    tasks = _tasks(got)
    assert tasks["B"]["predecessors"] == "1"
    assert tasks["A"]["successors"] == "2"
    assert [lk["id"] for lk in got["links"]] == [link["id"]]


async def test_link_types_and_lag(client, db):
    hdrs, _move, plan, ids = await _two(client, db)
    body = await _ok(client, hdrs, plan, [
        _link(ids["A"], ids["B"], link_type="SS", lag="+1d")])
    assert _by_id(body)[ids["B"]]["start"] == "2026-11-03T08:00"
    link = body["links"][0]
    assert link["link_type"] == "SS"
    assert (link["lag_minutes"], link["lag_unit"], link["lag_elapsed"]) == (480, "d", False)
    assert link["lag_text"] == "+1 day"
    assert _tasks(await _get(client, hdrs, plan))["B"]["predecessors"] == "1SS+1 day"


async def test_lead_and_elapsed_lag(client, db):
    hdrs, _move, plan, ids = await _two(client, db)
    body = await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"], lag="-4h")])
    # a lead: B starts half a day before A finishes (Tue 17:00)
    assert _by_id(body)[ids["B"]]["start"] == "2026-11-03T13:00"
    link = body["links"][0]
    assert (link["lag_minutes"], link["lag_text"]) == (-240, "-4 hrs")

    body = await _ok(client, hdrs, plan, [{"op": "update_link", "id": link["id"],
                                           "lag": "+1ed"}])
    # an elapsed day runs through the night: Wed 17:00, the next work Thu 08:00
    assert _by_id(body)[ids["B"]]["start"] == "2026-11-05T08:00"
    assert body["links"][0]["lag_elapsed"] is True
    assert body["links"][0]["lag_text"] == "+1 eday"


async def test_update_and_delete_link(client, db):
    hdrs, _move, plan, ids = await _two(client, db)
    body = await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    link_id = body["links"][0]["id"]

    body = await _ok(client, hdrs, plan, [{"op": "update_link", "id": link_id,
                                           "link_type": "FF"}])
    # B (1 day) finishes with A, Tue 17:00
    b = _by_id(body)[ids["B"]]
    assert (b["start"], b["finish"]) == ("2026-11-03T08:00", "2026-11-03T17:00")
    assert [lk["id"] for lk in body["links"]] == [link_id]
    assert body["links"][0]["link_type"] == "FF"
    assert _tasks(await _get(client, hdrs, plan))["B"]["predecessors"] == "1FF"

    # an update that changes nothing reports nothing
    body = await _ok(client, hdrs, plan, [{"op": "update_link", "id": link_id,
                                           "link_type": "FF", "lag": "0"}])
    assert body["links"] == [] and body["tasks"] == []

    body = await _ok(client, hdrs, plan, [{"op": "delete_link", "id": link_id}])
    assert body["deleted_links"] == [link_id]
    b = _by_id(body)[ids["B"]]
    assert (b["start"], b["finish"]) == ("2026-11-02T08:00", "2026-11-02T17:00")
    got = await _get(client, hdrs, plan)
    assert got["links"] == [] and _tasks(got)["B"]["predecessors"] == ""


async def test_delete_and_add_the_same_pair_in_one_batch(client, db):
    hdrs, move, plan, ids = await _two(client, db)
    body = await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    old = body["links"][0]["id"]
    body = await _ok(client, hdrs, plan, [
        {"op": "delete_link", "id": old},
        _link(ids["A"], ids["B"], link_type="SS"),
    ])
    assert body["deleted_links"] == [old]
    assert len(body["links"]) == 1 and body["links"][0]["link_type"] == "SS"
    links = await _db_links(db, move)
    assert [(str(lk.id), lk.link_type) for lk in links] == [(body["links"][0]["id"], "SS")]


async def test_bad_link_values(client, db):
    hdrs, _move, plan, ids = await _two(client, db)
    a, b = ids["A"], ids["B"]
    for op, code, field in (
        (_link(a, b, link_type="XX"), "bad_field", "link_type"),
        (_link(a, b, link_type="fs"), "bad_field", "link_type"),
        (_link(a, b, lag="soon"), "bad_duration", "lag"),
        (_link(a, b, lag="+3000d"), "bad_duration", "lag"),       # past 10 years
        (_link(a, b, lag="-3000d"), "bad_duration", "lag"),
    ):
        detail = await _fails(client, hdrs, plan, [op], 422, code)
        assert detail["field"] == field, detail

    body = await _ok(client, hdrs, plan, [_link(a, b)])
    link_id = body["links"][0]["id"]
    for fields, code, field in (
        ({"link_type": None}, "bad_field", "link_type"),
        ({"lag": None}, "bad_field", "lag"),
        ({"link_type": "XS"}, "bad_field", "link_type"),
        ({"lag": "+3000d"}, "bad_duration", "lag"),
    ):
        detail = await _fails(client, hdrs, plan,
                              [{"op": "update_link", "id": link_id, **fields}], 422, code)
        assert detail["field"] == field, detail
    # extra keys are refused by the schema
    resp = await client.post(f"/plans/{plan['id']}/ops", headers=hdrs, json={
        "base_version": body["version"],
        "ops": [{"op": "delete_link", "id": link_id, "force": True}]})
    assert resp.status_code == 422


async def test_unknown_and_foreign_ids(client, db):
    hdrs, _move, plan, ids = await _two(client, db)
    other = await _create(client, hdrs, await _initiative(db, name="Other"))
    theirs = await _add(client, hdrs, other, "X", "Y")
    body = await _ok(client, hdrs, other, [_link(theirs["X"], theirs["Y"])])
    their_link = body["links"][0]["id"]

    await _fails(client, hdrs, plan, [_link(ids["A"], theirs["Y"])], 422, "unknown_task")
    await _fails(client, hdrs, plan, [_link(str(uuid4()), ids["B"])], 422, "unknown_task")
    for op in ({"op": "update_link", "id": their_link, "lag": "+1d"},
               {"op": "delete_link", "id": their_link},
               {"op": "delete_link", "id": str(uuid4())}):
        detail = await _fails(client, hdrs, plan, [op], 422, "unknown_link")
        assert detail["link_id"] == op["id"]
    await _fails(client, hdrs, plan, [_assign(theirs["X"])], 422, "unknown_task")
    # the other plan is untouched
    got = await _get(client, hdrs, other)
    assert [(lk["id"], lk["lag_minutes"]) for lk in got["links"]] == [(their_link, 0)]


async def test_link_ops_need_an_unlocked_plan(client, db):
    hdrs, move, plan, ids = await _two(client, db)
    row = await _plan_row(db, move)
    row.locked_at = datetime.now(UTC)
    await db.commit()
    await _fails(client, hdrs, plan, [_link(ids["A"], ids["B"])], 409, "plan_locked")
    await _fails(client, hdrs, plan, [_update(ids["B"], predecessors="1")], 409, "plan_locked")
    await _fails(client, hdrs, plan, [_assign(ids["B"])], 409, "plan_locked")


# ── rules and engine errors ──────────────────────────────────────────


async def test_duplicate_and_self(client, db):
    hdrs, _move, plan, ids = await _two(client, db)
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    version = (await _get(client, hdrs, plan))["version"]
    await _fails(client, hdrs, plan, [_link(ids["A"], ids["B"], link_type="SS")],
                 422, "duplicate_link")
    await _fails(client, hdrs, plan, [_link(ids["A"], ids["A"])], 422, "bad_link")
    # two adds of one pair in a batch
    await _fails(client, hdrs, plan, [{"op": "delete_link", "id": (await _get(
        client, hdrs, plan))["links"][0]["id"]}, _link(ids["A"], ids["B"]),
        _link(ids["A"], ids["B"])], 422, "duplicate_link")
    got = await _get(client, hdrs, plan)
    assert got["version"] == version and len(got["links"]) == 1


async def test_cycle(client, db):
    hdrs, _move, plan, ids = await _two(client, db)
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    before = await _get(client, hdrs, plan)
    detail = await _fails(client, hdrs, plan, [_link(ids["B"], ids["A"])], 422, "link_cycle")
    assert detail["display_ids"] == [1, 2]
    assert sorted(detail["task_ids"]) == sorted([ids["A"], ids["B"]])
    after = await _get(client, hdrs, plan)
    assert _view(after) == _view(before)


async def test_link_to_parent(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "S", "A")
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["A"]]}])
    detail = await _fails(client, hdrs, plan, [_link(ids["A"], ids["S"])],
                          422, "link_to_outline")
    assert detail["display_ids"] == [1, 2] and len(detail["link_ids"]) == 1
    await _fails(client, hdrs, plan, [_update(ids["A"], predecessors="1")],
                 422, "link_to_outline")


async def test_link_to_outline_names_the_links(client, db):
    """Link 1 -> 2, then indent 2 under 1: the error names the link the
    outline cannot keep (as bad_summary_link does), and only that one."""
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C", "X")
    body = await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"]), _link(ids["A"], ids["C"]),
                                          _link(ids["X"], ids["C"])])
    by_ends = {(lk["predecessor_id"], lk["successor_id"]): lk["id"] for lk in body["links"]}
    # B and C both go under A; X -> C stays a plain link
    detail = await _fails(client, hdrs, plan, [{"op": "indent", "ids": [ids["B"], ids["C"]]}],
                          422, "link_to_outline")
    assert detail["link_ids"] == sorted([by_ends[(ids["A"], ids["B"])],
                                         by_ends[(ids["A"], ids["C"])]])
    assert detail["display_ids"] == [1, 2, 3]
    # a grandchild's link to its grandparent is named the same way
    await _ok(client, hdrs, plan, [{"op": "delete_link", "id": by_ends[(ids["A"], ids["C"])]}])
    detail = await _fails(client, hdrs, plan, [{"op": "indent", "ids": [ids["B"]]},
                                               {"op": "indent", "ids": [ids["C"]]},
                                               {"op": "indent", "ids": [ids["C"]]},
                                               {"op": "delete_link",
                                                "id": by_ends[(ids["A"], ids["B"])]},
                                               _link(ids["C"], ids["A"])],
                          422, "link_to_outline")
    assert len(detail["link_ids"]) == 1
    assert detail["display_ids"] == [1, 3]


async def test_finish_link_into_a_summary(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "X", "S", "A")
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["A"]]}])
    detail = await _fails(client, hdrs, plan, [_link(ids["X"], ids["S"], link_type="FF")],
                          422, "bad_summary_link")
    assert detail["display_ids"] == [1, 2] and len(detail["link_ids"]) == 1
    # FS and SS into a summary are fine, and reach its subtasks
    body = await _ok(client, hdrs, plan, [_link(ids["X"], ids["S"], link_type="SS",
                                                lag="+2h")])
    assert _by_id(body)[ids["A"]]["start"] == "2026-11-02T10:00"


# ── the Predecessors cell ────────────────────────────────────────────


async def test_predecessors_text(client, db):
    hdrs, _move, plan, ids = await _two(client, db)
    body = await _ok(client, hdrs, plan, [_update(ids["B"], predecessors="1FS+2d")])
    assert len(body["links"]) == 1
    link = body["links"][0]
    assert (link["predecessor_id"], link["successor_id"]) == (ids["A"], ids["B"])
    assert (link["link_type"], link["lag_minutes"], link["lag_unit"]) == ("FS", 960, "d")
    # A finishes Tue 17:00; two days later is Thu 17:00, so B starts Fri
    assert _by_id(body)[ids["B"]]["start"] == "2026-11-06T08:00"
    assert _tasks(await _get(client, hdrs, plan))["B"]["predecessors"] == "1FS+2 days"

    body = await _ok(client, hdrs, plan, [_update(ids["B"], predecessors="")])
    assert body["deleted_links"] == [link["id"]]
    got = await _get(client, hdrs, plan)
    assert got["links"] == []
    assert _tasks(got)["B"]["start"] == "2026-11-02T08:00"


async def test_predecessors_replace_every_incoming_link(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C", "D")
    await _ok(client, hdrs, plan, [_link(ids["A"], ids["D"]), _link(ids["B"], ids["D"]),
                                   _link(ids["A"], ids["C"])])
    before = {lk.predecessor_id: lk.id for lk in await _db_links(db, move)
              if str(lk.successor_id) == ids["D"]}

    body = await _ok(client, hdrs, plan, [_update(ids["D"], predecessors=" 2SS , 3 ")])
    links = {(str(lk.predecessor_id), str(lk.successor_id)): lk
             for lk in await _db_links(db, move)}
    assert set(links) == {(ids["B"], ids["D"]), (ids["C"], ids["D"]), (ids["A"], ids["C"])}
    # the link from B is the same row, changed in place; the one from A is gone
    assert links[(ids["B"], ids["D"])].id == before[uuid.UUID(ids["B"])]
    assert links[(ids["B"], ids["D"])].link_type == "SS"
    assert body["deleted_links"] == [str(before[uuid.UUID(ids["A"])])]
    assert _tasks(await _get(client, hdrs, plan))["D"]["predecessors"] == "2SS,3"


async def test_bad_predecessor_text(client, db):
    hdrs, _move, plan, ids = await _two(client, db)
    for text in ("9", "2", "1XX", "1,", "1,1", "1FS2d", "1FS+3000d"):
        detail = await _fails(client, hdrs, plan, [_update(ids["B"], predecessors=text)],
                              422, "bad_duration" if text == "1FS+3000d" else "bad_predecessor")
        assert detail["field"] == "predecessors", detail
    detail = await _fails(client, hdrs, plan, [_update(ids["B"], predecessors="9")],
                          422, "bad_predecessor")
    assert detail["task_id"] == ids["B"] and "9" in detail["message"]
    await _fails(client, hdrs, plan, [_update(ids["B"], predecessors=None)], 422, "bad_field")
    assert (await _get(client, hdrs, plan))["links"] == []


async def test_predecessors_read_the_outline_before_the_batch(client, db):
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    # C moves to the top first; "3" still means C, its number when the batch began
    body = await _ok(client, hdrs, plan, [
        {"op": "move_tasks", "ids": [ids["C"]], "before_id": ids["A"]},
        _update(ids["B"], predecessors="3"),
    ])
    assert body["order"] == [ids["C"], ids["A"], ids["B"]]
    link = body["links"][0]
    assert (link["predecessor_id"], link["successor_id"]) == (ids["C"], ids["B"])
    assert _tasks(await _get(client, hdrs, plan))["B"]["predecessors"] == "1"

    # B was 3 when this batch began: naming itself is refused even after a move
    await _fails(client, hdrs, plan, [
        {"op": "move_tasks", "ids": [ids["B"]], "before_id": ids["C"]},
        _update(ids["B"], predecessors="3")], 422, "bad_predecessor")
    # a task deleted earlier in the batch can no longer be named
    detail = await _fails(client, hdrs, plan, [
        {"op": "delete_tasks", "ids": [ids["A"]]},
        _update(ids["B"], predecessors="2")], 422, "bad_predecessor")
    assert "does not exist" in detail["message"]


async def test_unchanged_predecessor_text_keeps_the_stored_lag(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C", "D")
    row = await _plan_row(db, move)
    a, b, c, d = (uuid.UUID(ids[k]) for k in "ABCD")
    # 160 minutes shows as 0.33 days (which would parse back as 158);
    # a zero lag typed in hours; one minute of a month shows as "+0 mons"
    db.add_all([
        PlanLink(plan_id=row.id, predecessor_id=a, successor_id=d, lag_minutes=160,
                 lag_unit="d"),
        PlanLink(plan_id=row.id, predecessor_id=b, successor_id=d, lag_minutes=0,
                 lag_unit="h"),
        PlanLink(plan_id=row.id, predecessor_id=c, successor_id=d, lag_minutes=1,
                 lag_unit="mo"),
    ])
    await db.commit()
    text = _tasks(await _get(client, hdrs, plan))["D"]["predecessors"]
    assert text == "1FS+0.33 days,2,3FS+0 mons"

    def lags(links):
        return {str(lk.predecessor_id): (lk.link_type, lk.lag_minutes, lk.lag_unit)
                for lk in links}

    stored = lags(await _db_links(db, move))
    body = await _ok(client, hdrs, plan, [_update(ids["D"], predecessors=text)])
    assert body["links"] == [] and body["deleted_links"] == []
    assert lags(await _db_links(db, move)) == stored

    # the same lags typed another way, and a zero lag in other units
    await _ok(client, hdrs, plan, [_update(ids["D"], predecessors="1fs+0.33d, 2FS+0d, 3")])
    now = lags(await _db_links(db, move))
    assert now[ids["A"]] == ("FS", 160, "d")
    assert now[ids["B"]] == ("FS", 0, "h")
    assert now[ids["C"]] == ("FS", 0, "d")            # the lag was taken out

    # a new link type keeps a lag that reads the same
    await _ok(client, hdrs, plan, [_update(ids["D"], predecessors="1SS+0.33 days,2SS,3")])
    now = lags(await _db_links(db, move))
    assert now[ids["A"]] == ("SS", 160, "d")
    assert now[ids["B"]] == ("SS", 0, "h")

    # a lag that reads differently is parsed
    await _ok(client, hdrs, plan, [_update(ids["D"], predecessors="1SS+0.5d,2SS+1h,3")])
    now = lags(await _db_links(db, move))
    assert now[ids["A"]] == ("SS", 240, "d")
    assert now[ids["B"]] == ("SS", 60, "h")


# ── assignees ────────────────────────────────────────────────────────


async def test_set_assignees(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    worker, shipper = await _resources(db, move)
    body = await _ok(client, hdrs, plan, [
        _assign(ids["A"], ("partner", shipper.id), ("person", worker.id),
                ("person", worker.id))])
    expected = [
        {"kind": "person", "id": str(worker.id), "name": "Wanda Worker"},
        {"kind": "partner", "id": str(shipper.id), "name": "Champagne Logistics"},
    ]
    assert _by_id(body)[ids["A"]]["assignees"] == expected
    assert set(_by_id(body)) == {ids["A"]}
    assert _tasks(await _get(client, hdrs, plan))["A"]["assignees"] == expected

    # a person who is no resource of this plan, or no one at all
    stranger = Person(first_name="Stan", last_name="Stranger")
    db.add(stranger)
    await db.commit()
    for kind, rid in (("person", stranger.id), ("person", uuid4()), ("partner", uuid4())):
        detail = await _fails(client, hdrs, plan, [_assign(ids["B"], (kind, rid))],
                              422, "bad_resource")
        assert detail["kind"] == kind and detail["id"] == str(rid)
    await _fails(client, hdrs, plan, [
        {"op": "set_assignees", "task_id": ids["B"],
         "resources": [{"kind": "crew", "id": str(worker.id)}]}], 422, "bad_field")

    # replacing, then clearing
    body = await _ok(client, hdrs, plan, [_assign(ids["A"], ("partner", shipper.id))])
    assert [x["kind"] for x in _by_id(body)[ids["A"]]["assignees"]] == ["partner"]
    body = await _ok(client, hdrs, plan, [_assign(ids["A"])])
    assert _by_id(body)[ids["A"]]["assignees"] == []


async def test_assignees_on_a_summary_and_staff(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "S", "A")
    await _ok(client, hdrs, plan, [{"op": "indent", "ids": [ids["A"]]}])
    worker, _shipper = await _resources(db, move)
    me = next(r for r in (await _get(client, hdrs, plan))["resources"]
              if r["group"] == "staff")
    body = await _ok(client, hdrs, plan, [
        _assign(ids["S"], ("person", worker.id), ("person", me["id"]))])
    assert {x["id"] for x in _by_id(body)[ids["S"]]["assignees"]} == {
        str(worker.id), me["id"]}


async def test_existing_assignees_survive_leaving_the_resources(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    worker, shipper = await _resources(db, move)
    await _ok(client, hdrs, plan, [_assign(ids["A"], ("person", worker.id))])
    # archived, then taken off the team as well
    worker.archived_at = datetime.now(UTC)
    await db.execute(delete(InitiativePerson).where(InitiativePerson.person_id == worker.id))
    await db.commit()
    assert str(worker.id) not in {r["id"] for r in (await _get(client, hdrs, plan))["resources"]}
    body = await _ok(client, hdrs, plan, [
        _assign(ids["A"], ("person", worker.id), ("partner", shipper.id))])
    assert len(_by_id(body)[ids["A"]]["assignees"]) == 2
    # but nobody can newly assign them
    await _fails(client, hdrs, plan, [_assign(ids["B"], ("person", worker.id))],
                 422, "bad_resource")


async def test_assignees_changed_twice_in_one_batch(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    worker, shipper = await _resources(db, move)
    # added and taken off again before the batch ends
    body = await _ok(client, hdrs, plan, [_assign(ids["A"], ("person", worker.id)),
                                          _assign(ids["A"], ("partner", shipper.id))])
    assert [x["kind"] for x in _by_id(body)[ids["A"]]["assignees"]] == ["partner"]
    # taken off and put back: still one row (B's edit reads the resources
    # first, so nothing else flushes the removal before the row comes back)
    body = await _ok(client, hdrs, plan, [_assign(ids["B"], ("person", worker.id)),
                                          _assign(ids["A"]),
                                          _assign(ids["A"], ("partner", shipper.id))])
    assert set(_by_id(body)) == {ids["B"]}
    assert len(_tasks(await _get(client, hdrs, plan))["A"]["assignees"]) == 1


async def test_newly_assigned_reported(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B")
    a, b = uuid.UUID(ids["A"]), uuid.UUID(ids["B"])
    worker, shipper = await _resources(db, move)
    helper = Person(first_name="Hal", last_name="Helper")
    db.add(helper)
    await db.flush()
    db.add(InitiativePerson(initiative_id=move.id, person_id=helper.id))
    await db.commit()
    actor = await _actor(db, hdrs)
    row = await _plan_row(db, move)
    settings = await settings_of(db, row)

    def assign(task_id, *resources):
        return SetAssigneesOp.model_validate(_assign(task_id, *resources))

    async def run(*ops):
        result = await apply_ops(db, await load_state(db, row), list(ops), actor, settings)
        await db.flush()
        return result

    result = await run(assign(a, ("person", worker.id), ("partner", shipper.id)),
                       assign(b, ("person", worker.id), ("person", helper.id)))
    # partners never get reminders, so only people are reported
    assert result.newly_assigned == {worker.id: [a, b], helper.id: [b]}
    # the same again: nobody is new
    result = await run(assign(a, ("person", worker.id), ("partner", shipper.id)))
    assert result.newly_assigned == {}
    # added and taken off in one batch, or taken off and put back: nobody
    result = await run(assign(a, ("person", worker.id), ("person", helper.id)),
                       assign(a, ("person", worker.id)))
    assert result.newly_assigned == {}
    result = await run(assign(b), assign(b, ("person", helper.id)))
    assert result.newly_assigned == {}

    # an undo that puts someone back is not a new assignment
    result = await run(assign(a))
    undo = RestoreOp.model_validate(result.inverse[0])
    assert undo.assignments
    result = await run(undo)
    assert result.newly_assigned == {}
    await db.rollback()


# ── undo ─────────────────────────────────────────────────────────────


async def test_inverse_of_link_and_assignee_ops(client, db):
    hdrs, move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    worker, shipper = await _resources(db, move)
    body = await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"]),
                                          _assign(ids["C"], ("person", worker.id))])
    ab = body["links"][0]["id"]
    before = await _get(client, hdrs, plan)

    body = await _ok(client, hdrs, plan, [
        {"op": "update_link", "id": ab, "link_type": "SS", "lag": "+2h"},
        _link(ids["B"], ids["C"]),
        _update(ids["C"], predecessors="1FF"),
        _assign(ids["C"], ("partner", shipper.id)),
        _assign(ids["A"], ("person", worker.id)),
    ])
    after = await _get(client, hdrs, plan)
    assert after != before

    undo = await _ok(client, hdrs, plan, body["inverse"])
    restored = await _get(client, hdrs, plan)

    def comparable(got):
        return ([{k: v for k, v in t.items() if k != "updated_at"} for t in got["tasks"]],
                sorted(got["links"], key=lambda lk: lk["id"]))

    assert comparable(restored) == comparable(before)
    await _ok(client, hdrs, plan, undo["inverse"])
    assert comparable(await _get(client, hdrs, plan)) == comparable(after)


# ── large batches: the link checks don't walk every link per op ──────


class _CountingLinks(dict):
    """`state.links` that counts every walk over all of the plan's links."""

    walks = 0

    def values(self):
        self.walks += 1
        return super().values()

    def items(self):
        self.walks += 1
        return super().items()

    def __iter__(self):
        self.walks += 1
        return super().__iter__()


async def _big_plan(client, hdrs, plan, size: int) -> list[str]:
    """`size` one-day tasks, each linked FS to the three after it."""
    ops = [{"op": "add_task", "temp_id": f"t{i}", "name": f"T{i}"} for i in range(size)]
    body = await _ok(client, hdrs, plan, ops)
    ids = [body["temp_ids"][f"t{i}"] for i in range(size)]
    links = [_link(ids[i], ids[j]) for i in range(size) for j in range(i + 1, min(i + 4, size))]
    await _ok(client, hdrs, plan, links)
    return ids


async def test_a_large_predecessors_batch_walks_the_links_a_few_times(client, db):
    """2,000 Predecessors edits on a 3,000-link plan (a big paste): each op
    reads the task's incoming links and the duplicate check from an index,
    not a walk over every link (which was ~6M checks inside the plan lock)."""
    hdrs, move, plan = await _setup(client, db)
    ids = await _big_plan(client, hdrs, plan, 1001)
    actor = await _actor(db, hdrs)
    row = await _plan_row(db, move)
    settings = await settings_of(db, row)
    state = await load_state(db, row)
    assert len(state.links) == 2997
    state.links = _CountingLinks(state.links)

    # display ID k is ids[k - 1]; task k follows k-1, k-2 and k-3
    ops = [UpdateTaskOp.model_validate(_update(ids[k - 1], predecessors=f"{k - 2},{k - 1}"))
           for k in range(4, 1001)]
    ops += [UpdateTaskOp.model_validate(_update(ids[k - 1], predecessors=f"{k - 3}SS,{k - 2},{k - 1}"))
            for k in range(4, 1001)]
    # and the duplicate check of add_link: links the plan doesn't have yet
    ops += [AddLinkOp.model_validate(_link(ids[k], ids[k + 4])) for k in range(6)]
    assert len(ops) == 2000

    started = time.perf_counter()
    result = await apply_ops(db, state, ops, actor, settings)
    elapsed = time.perf_counter() - started
    print(f"\n2,000-op batch on a 2,997-link plan: {elapsed:.2f}s, {state.links.walks} link walks")
    # a handful per batch (the snapshots, the schedule), none per op
    assert state.links.walks < 40
    assert elapsed < 60          # generous: the old per-op walks made the batch quadratic
    assert len(state.links) == 2997 + 6
    types = {(lk.predecessor_id, lk.successor_id): lk.link_type for lk in state.links.values()}
    k = 500
    assert types[(uuid.UUID(ids[k - 4]), uuid.UUID(ids[k - 1]))] == "SS"
    assert types[(uuid.UUID(ids[k - 2]), uuid.UUID(ids[k - 1]))] == "FS"
    # the SS links (re-created after the first pass dropped them) and the new ones
    assert len(result.changed_links) == 997 + 6
    await db.rollback()


async def test_link_index_follows_deleted_tasks(client, db):
    """X→S and P→S; once the batch has read the links (an add_link),
    deleting X takes its link out of the index too, so S's Predecessors
    text naming only P drops nothing that is already gone."""
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "P", "X", "S", "Q")
    await _ok(client, hdrs, plan, [_link(ids["X"], ids["S"]), _link(ids["P"], ids["S"])])
    body = await _ok(client, hdrs, plan, [
        _link(ids["P"], ids["Q"]),
        {"op": "delete_tasks", "ids": [ids["X"]]},
        _update(ids["S"], predecessors="1"),
        _link(ids["Q"], ids["S"]),
    ])
    assert ids["X"] in body["deleted_tasks"]
    got = _tasks(await _get(client, hdrs, plan))
    assert got["S"]["predecessors"] == "1,3"


async def test_link_index_follows_a_restore(client, db):
    """A restore that takes a link out lets the same pair be linked again
    later in the batch, after the duplicate check has read the links."""
    hdrs, _move, plan = await _setup(client, db)
    ids = await _add(client, hdrs, plan, "A", "B", "C")
    body = await _ok(client, hdrs, plan, [_link(ids["A"], ids["B"])])
    undo = body["inverse"]
    await _ok(client, hdrs, plan, [
        _link(ids["B"], ids["C"]),
        *undo,
        _link(ids["A"], ids["B"], link_type="SS"),
    ])
    got = await _get(client, hdrs, plan)
    pairs = sorted((lk["predecessor_id"], lk["successor_id"], lk["link_type"]) for lk in got["links"])
    assert pairs == sorted([(ids["A"], ids["B"], "SS"), (ids["B"], ids["C"], "FS")])
