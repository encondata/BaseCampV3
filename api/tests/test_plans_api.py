"""The plan service and the create / read / delete routes: an initiative's
plan as the API serves it (tasks with display IDs, WBS, predecessor text and
status, links, the resource list) and the recalc that persists the engine's
dates onto the stored rows."""

import copy
import uuid
from datetime import UTC, date, datetime
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog,
    Initiative,
    InitiativePerson,
    Partner,
    Person,
    PersonRole,
    Site,
    UserAccount,
)
from serversherpa.plans import service
from serversherpa.plans.models import PlanAssignment, PlanLink, PlanTask, ProjectPlan
from serversherpa.system.config_store import DEFAULTS
from tests.test_sites_api import login
from tests.test_status_values_write import _make

# ── helpers ──────────────────────────────────────────────────────────


async def _admin(db, client):
    return await _make(db, client, "admin", f"pa-{uuid4().hex[:8]}@test.example.com")


def _midnight(day: date) -> datetime:
    """Date-only initiative fields are stored as midnight UTC."""
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


async def _initiative(db, name="Move", **fields):
    move = Initiative(name=name, initiative_type="move", **fields)
    db.add(move)
    await db.commit()
    return move


def dt(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%d %H:%M")


async def _create(client, hdrs, move, **body):
    resp = await client.post(f"/initiatives/{move.id}/plan", headers=hdrs,
                             json={"project_start": "2026-11-02", **body})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _plan_row(db, move) -> ProjectPlan:
    return await db.scalar(select(ProjectPlan).where(ProjectPlan.initiative_id == move.id)
                           .execution_options(populate_existing=True))


def _task(plan, position, name, **fields) -> PlanTask:
    fields.setdefault("duration_minutes", 480)
    return PlanTask(id=uuid.uuid4(), plan_id=plan.id, position=position, name=name, **fields)


async def _person_id(db, email) -> uuid.UUID:
    return await db.scalar(select(UserAccount.person_id).where(UserAccount.email == email))


# ── create / read / delete ───────────────────────────────────────────


async def test_create_and_get_plan(client, db):
    email = f"pc-{uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    me = await _person_id(db, email)
    move = await _initiative(db)
    resp = await client.post(f"/initiatives/{move.id}/plan", headers=hdrs,
                             json={"project_start": "2026-11-02"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["initiative_id"] == str(move.id)
    assert body["initiative_name"] == "Move"
    assert body["project_start"] == "2026-11-02T08:00"
    assert body["project_finish"] is None
    assert body["version"] == 1
    assert body["tasks"] == []
    assert body["links"] == []
    assert body["timezone"] == "America/New_York"
    assert body["calendar"]["hours_per_day"] == 8
    assert body["permissions"] == {"view": True, "add": True, "change": True, "delete": True}
    assert body["settings"]["completion"] == {"subtasks": "cascade", "predecessors": "block"}
    assert body["settings_overrides"] == {}
    assert body["status_date"] is None
    assert len(body["now"]) == len("2026-11-02T08:00")
    assert body["owner_id"] == str(me) and body["owner_name"] == "R X"   # the creator
    assert body["locked_at"] is None and body["locked_by_name"] is None
    assert body["baseline_set_at"] is None

    got = await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)
    assert got.status_code == 200
    assert got.json()["id"] == body["id"]

    row = await db.scalar(select(AuditLog).where(AuditLog.action == "plan_create"))
    assert row is not None and row.entity_id == body["id"]


async def test_project_start_with_a_time(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    body = await _create(client, hdrs, move, project_start="2026-11-02T10:30")
    assert body["project_start"] == "2026-11-02T10:30"


async def test_bad_project_start(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    for text in ("2026-11-02T08:00Z", "Nov 2", "2026-02-30"):
        resp = await client.post(f"/initiatives/{move.id}/plan", headers=hdrs,
                                 json={"project_start": text})
        assert resp.status_code == 422, text
        assert resp.json()["detail"]["code"] == "bad_field"
        assert resp.json()["detail"]["field"] == "project_start"


async def test_template_id_is_accepted_and_ignored(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    body = await _create(client, hdrs, move, template_id=str(uuid4()))
    assert body["tasks"] == []


async def test_initiative_window(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db, scheduled_start=_midnight(date(2026, 11, 2)),
                             scheduled_end=_midnight(date(2026, 11, 20)))
    body = await _create(client, hdrs, move)
    assert body["initiative_window"] == {"start": "2026-11-02", "end": "2026-11-20"}

    bare = await _initiative(db, name="Bare")
    body = await _create(client, hdrs, bare)
    assert body["initiative_window"] == {"start": None, "end": None}


async def test_site_zone_used(client, db):
    hdrs = await _admin(db, client)
    site = Site(name="DC-CHI", timezone="America/Chicago")
    db.add(site)
    await db.flush()
    move = await _initiative(db, site_id=site.id)
    body = await _create(client, hdrs, move)
    assert body["timezone"] == "America/Chicago"


async def test_destination_site_zone_used(client, db):
    hdrs = await _admin(db, client)
    site = Site(name="DC-LA", timezone="America/Los_Angeles")
    db.add(site)
    await db.flush()
    move = await _initiative(db, destination_site_id=site.id)
    body = await _create(client, hdrs, move)
    assert body["timezone"] == "America/Los_Angeles"


async def test_site_without_zone_falls_back(client, db):
    hdrs = await _admin(db, client)
    site = Site(name="DC-X")
    db.add(site)
    await db.flush()
    move = await _initiative(db, site_id=site.id)
    body = await _create(client, hdrs, move)
    assert body["timezone"] == "America/New_York"


async def test_owner(client, db):
    email = f"po-{uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    me = await _person_id(db, email)
    move = await _initiative(db)
    body = await _create(client, hdrs, move, owner_id=str(me))
    assert body["owner_id"] == str(me)
    assert body["owner_name"] == "R X"


async def test_owner_defaults_to_the_creator(client, db):
    email = f"pd-{uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    me = await _person_id(db, email)
    move = await _initiative(db)
    body = await _create(client, hdrs, move)
    assert body["owner_id"] == str(me)
    assert body["owner_name"] == "R X"
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "plan_create",
                                                 AuditLog.entity_id == body["id"]))
    assert row.changes["owner_id"] == str(me)


async def test_owner_sent_as_null_means_no_owner(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    body = await _create(client, hdrs, move, owner_id=None)
    assert body["owner_id"] is None and body["owner_name"] is None


async def test_owner_default_is_skipped_for_a_creator_who_cannot_own(client, db, monkeypatch):
    # the same staff check an explicit owner gets; a default never refuses the plan
    hdrs = await _admin(db, client)

    async def nobody_is_staff(_db, _person_id):
        return False

    monkeypatch.setattr(service, "is_staff", nobody_is_staff)
    move = await _initiative(db)
    body = await _create(client, hdrs, move)
    assert body["owner_id"] is None and body["owner_name"] is None


async def test_owner_must_be_staff(client, db):
    hdrs = await _admin(db, client)
    worker = Person(first_name="Wanda", last_name="Worker")
    db.add(worker)
    await db.commit()
    move = await _initiative(db)
    for owner in (uuid4(), worker.id):
        resp = await client.post(f"/initiatives/{move.id}/plan", headers=hdrs,
                                 json={"project_start": "2026-11-02", "owner_id": str(owner)})
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "bad_owner"


async def test_get_without_plan(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    resp = await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "no_plan"


async def test_create_twice(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    resp = await client.post(f"/initiatives/{move.id}/plan", headers=hdrs,
                             json={"project_start": "2026-11-09"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "plan_exists"


async def test_staff_forbidden(client, db, seeded_user):
    move = await _initiative(db)
    hdrs = await login(client)
    for method in ("get", "post", "delete"):
        kwargs = {"json": {"project_start": "2026-11-02"}} if method == "post" else {}
        resp = await getattr(client, method)(
            f"/initiatives/{move.id}/plan", headers=hdrs, **kwargs)
        assert resp.status_code == 403, method
        assert resp.json()["detail"]["code"] == "forbidden"


async def test_unknown_initiative(client, db):
    hdrs = await _admin(db, client)
    for method in ("get", "post", "delete"):
        kwargs = {"json": {"project_start": "2026-11-02"}} if method == "post" else {}
        resp = await getattr(client, method)(
            f"/initiatives/{uuid4()}/plan", headers=hdrs, **kwargs)
        assert resp.status_code == 404, method
        assert resp.json()["detail"]["code"] == "initiative_not_found"


async def test_delete_plan(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    body = await _create(client, hdrs, move)
    plan = await _plan_row(db, move)
    db.add(_task(plan, 0, "A"))
    await db.commit()

    resp = await client.delete(f"/initiatives/{move.id}/plan", headers=hdrs)
    assert resp.status_code == 204
    resp = await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "no_plan"
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "plan_delete"))
    assert row is not None and row.entity_id == body["id"]
    assert await db.scalar(select(PlanTask.id)) is None

    again = await client.delete(f"/initiatives/{move.id}/plan", headers=hdrs)
    assert again.status_code == 404
    assert again.json()["detail"]["code"] == "no_plan"


async def test_create_again_after_delete(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    first = await _create(client, hdrs, move)
    assert (await client.delete(f"/initiatives/{move.id}/plan", headers=hdrs)).status_code == 204
    second = await _create(client, hdrs, move)
    assert second["id"] != first["id"]


# ── resources ────────────────────────────────────────────────────────


async def test_resources_listed(client, db):
    email = f"pr-{uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    me = await _person_id(db, email)
    worker = Person(first_name="Wanda", last_name="Worker", email="wanda@test.example.com")
    nobody = Person(first_name="Ned", last_name="Noemail")
    shipper = Partner(name="Champagne Logistics")
    db.add_all([worker, nobody, shipper])
    await db.flush()
    move = await _initiative(db, shipping_partner_id=shipper.id,
                             origin_tech_partner_id=shipper.id)
    db.add_all([InitiativePerson(initiative_id=move.id, person_id=worker.id),
                InitiativePerson(initiative_id=move.id, person_id=nobody.id)])
    await db.commit()

    body = await _create(client, hdrs, move)
    by_id = {r["id"]: r for r in body["resources"]}
    assert by_id[str(worker.id)] == {
        "kind": "person", "id": str(worker.id), "name": "Wanda Worker", "group": "team",
        "has_email": True, "has_account": False, "is_staff": False}
    assert by_id[str(nobody.id)]["has_email"] is False
    assert by_id[str(shipper.id)] == {
        "kind": "partner", "id": str(shipper.id), "name": "Champagne Logistics",
        "group": "partner", "has_email": False, "has_account": False, "is_staff": False}
    assert by_id[str(me)]["group"] == "staff"
    assert by_id[str(me)]["is_staff"] is True
    assert by_id[str(me)]["has_account"] is True
    assert by_id[str(me)]["has_email"] is True
    # the partner named in two fields is listed once
    assert len(body["resources"]) == 4
    # grouped: team, then staff, then partners
    groups = [r["group"] for r in body["resources"]]
    assert groups == sorted(groups, key=["team", "staff", "partner"].index)


async def test_staff_on_the_team_listed_once_as_team(client, db):
    email = f"pt-{uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    me = await _person_id(db, email)
    move = await _initiative(db)
    db.add(InitiativePerson(initiative_id=move.id, person_id=me))
    await db.commit()
    body = await _create(client, hdrs, move)
    mine = [r for r in body["resources"] if r["id"] == str(me)]
    assert len(mine) == 1
    assert mine[0]["group"] == "team"
    assert mine[0]["has_account"] is True
    # listed as team, still staff: the owner picker offers them
    assert mine[0]["is_staff"] is True


async def test_team_member_without_a_global_role_is_not_staff(client, db):
    """`is_staff` is the owner rule (service.is_staff), whatever the group:
    a team member whose login holds only a worker role is not staff."""
    hdrs = await _admin(db, client)
    crew = Person(first_name="Kiosk", last_name="Crew")
    db.add(crew)
    await db.flush()
    db.add_all([UserAccount(person_id=crew.id, email=f"kc-{uuid4().hex[:8]}@test.example.com"),
                PersonRole(person_id=crew.id, role="worker")])
    move = await _initiative(db)
    db.add(InitiativePerson(initiative_id=move.id, person_id=crew.id))
    await db.commit()
    body = await _create(client, hdrs, move)
    mine = next(r for r in body["resources"] if r["id"] == str(crew.id))
    assert mine["group"] == "team" and mine["has_account"] is True
    assert mine["is_staff"] is False


async def test_resources_skip_archived_revoked_and_non_global(client, db):
    hdrs = await _admin(db, client)
    gone = Person(first_name="Gone", last_name="Away", archived_at=datetime.now(UTC))
    revoked = Person(first_name="Rev", last_name="Oked")
    worker_login = Person(first_name="Kiosk", last_name="Worker")
    db.add_all([gone, revoked, worker_login])
    await db.flush()
    db.add_all([
        UserAccount(person_id=revoked.id, email="rev@test.example.com"),
        PersonRole(person_id=revoked.id, role="staff", revoked_at=datetime.now(UTC)),
        UserAccount(person_id=worker_login.id, email="kw@test.example.com"),
        PersonRole(person_id=worker_login.id, role="worker"),
    ])
    move = await _initiative(db)
    db.add(InitiativePerson(initiative_id=move.id, person_id=gone.id))
    await db.commit()
    body = await _create(client, hdrs, move)
    ids = {r["id"] for r in body["resources"]}
    assert str(gone.id) not in ids
    assert str(revoked.id) not in ids
    assert str(worker_login.id) not in ids


# ── plan_for_actor / state ───────────────────────────────────────────


async def _actor(db, hdrs):
    from serversherpa.api.deps import authenticate_token

    return await authenticate_token(db, hdrs["Authorization"].split()[1])


async def test_create_plan_copies_the_calendar(client, db):
    hdrs = await _admin(db, client)
    actor = await _actor(db, hdrs)
    move = await _initiative(db)
    pristine = copy.deepcopy(DEFAULTS["project_plans"]["calendar"])

    plan = await service.create_plan(db, move, actor, project_start=dt("2026-11-02 08:00"),
                                     owner_id=None)
    assert plan.calendar == pristine
    assert plan.calendar["week"] is not DEFAULTS["project_plans"]["calendar"]["week"]
    # editing the plan's calendar leaves the system defaults alone
    plan.calendar["week"]["sat"].append(["08:00", "12:00"])
    plan.calendar["exceptions"].append({"date": "2026-11-26", "hours": []})
    assert DEFAULTS["project_plans"]["calendar"] == pristine
    assert plan.version == 1 and plan.settings == {}
    assert plan.timezone == "America/New_York"
    await db.rollback()


async def test_load_state_and_renumber(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    plan = await _plan_row(db, move)
    # positions out of outline order: S's child C sits after B
    s = _task(plan, 0, "S")
    a = _task(plan, 5, "A")
    b = _task(plan, 9, "B")
    c = _task(plan, 12, "C", parent_id=s.id)
    db.add(s)
    await db.flush()
    db.add_all([a, b, c])
    await db.commit()

    state = await service.load_state(db, plan)
    assert state.order == [s.id, a.id, b.id, c.id]
    assert set(state.tasks) == {s.id, a.id, b.id, c.id}

    service.renumber(state)
    assert state.order == [s.id, c.id, a.id, b.id]
    assert [state.tasks[t].position for t in state.order] == [0, 1, 2, 3]


async def test_recalc_persists_the_schedule(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    plan = await _plan_row(db, move)
    s = _task(plan, 0, "S")
    a = _task(plan, 1, "A", parent_id=s.id, duration_minutes=960, percent_complete=100)
    b = _task(plan, 2, "B", parent_id=s.id, duration_minutes=480)
    m = _task(plan, 3, "M", mode="manual", start=dt("2026-11-03 10:00"),
              finish=dt("2026-11-04 15:00"), duration_minutes=480)
    db.add(s)
    await db.flush()
    db.add_all([a, b, m])
    await db.flush()
    db.add(PlanLink(plan_id=plan.id, predecessor_id=a.id, successor_id=b.id))
    await db.commit()

    state = await service.load_state(db, plan)
    settings = await service.settings_of(db, plan)
    changed = service.recalc(state, settings)
    assert changed == {s.id, a.id, b.id, m.id}
    assert (a.start, a.finish) == (dt("2026-11-02 08:00"), dt("2026-11-03 17:00"))
    assert (b.start, b.finish) == (dt("2026-11-04 08:00"), dt("2026-11-04 17:00"))
    # summary: rolled-up dates, duration and percent
    assert (s.start, s.finish) == (dt("2026-11-02 08:00"), dt("2026-11-04 17:00"))
    assert s.duration_minutes == 1440
    assert s.percent_complete == 67
    # a manual task with both dates stores its typed span as its duration
    assert (m.start, m.finish) == (dt("2026-11-03 10:00"), dt("2026-11-04 15:00"))
    assert m.duration_minutes == 720
    assert b.is_critical is True and b.total_slack_minutes == 0
    # rows added in this session serialize without a reload (Task 9's path)
    served = await service.tasks_out(db, state, [m.id, a.id])
    assert [t.name for t in served] == ["A", "M"]
    assert served[1].duration_minutes == 720 and served[1].updated_at is not None
    await db.commit()

    # nothing moved: a second recalc changes nothing
    state = await service.load_state(db, plan)
    assert service.recalc(state, settings) == set()


async def test_recalc_critical_slack_days(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    plan = await _plan_row(db, move)
    a = _task(plan, 0, "A", duration_minutes=480)
    b = _task(plan, 1, "B", duration_minutes=960)
    db.add_all([a, b])
    await db.commit()

    state = await service.load_state(db, plan)
    settings = await service.settings_of(db, plan)
    service.recalc(state, settings)
    # A has a day of slack next to the 2-day B
    assert a.total_slack_minutes == 480 and a.is_critical is False

    plan.settings = {"critical_slack_days": 1}
    settings = await service.settings_of(db, plan)
    assert service.recalc(state, settings) == {a.id}
    assert a.is_critical is True


async def test_plan_for_actor(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    body = await _create(client, hdrs, move)
    actor = await _actor(db, hdrs)

    with pytest.raises(HTTPException) as caught:
        await service.plan_for_actor(db, uuid4(), actor)
    assert caught.value.status_code == 404
    assert caught.value.detail == {"code": "plan_not_found"}

    plan = await service.plan_for_actor(db, uuid.UUID(body["id"]), actor, lock=True)
    assert plan.initiative_id == move.id and plan.version == 1
    await db.rollback()


async def test_scoped_actor_never_reaches_another_clients_plan(client, db):
    """`project_plans` is global-only today; the lookups still apply the
    initiatives scope so a plan is never wider than its initiative."""
    from serversherpa.access.resolver import AccessInfo
    from serversherpa.db.models import Client

    hdrs = await _admin(db, client)
    mine, theirs = Client(name="Mine"), Client(name="Theirs")
    db.add_all([mine, theirs])
    await db.flush()
    move = await _initiative(db, client_id=theirs.id)
    body = await _create(client, hdrs, move)
    actor = await _actor(db, hdrs)
    plan_id = uuid.UUID(body["id"])

    actor.access = AccessInfo(anchors={"client"}, client_ids={mine.id})
    with pytest.raises(HTTPException) as caught:
        await service.plan_for_actor(db, plan_id, actor)
    assert caught.value.detail == {"code": "plan_not_found"}
    with pytest.raises(HTTPException) as caught:
        await service.visible_initiative(db, move.id, actor)
    assert caught.value.detail == {"code": "initiative_not_found"}

    actor.access = AccessInfo(anchors={"client"}, client_ids={theirs.id})
    assert (await service.plan_for_actor(db, plan_id, actor)).id == plan_id
    assert (await service.visible_initiative(db, move.id, actor)).id == move.id


# ── serialization ────────────────────────────────────────────────────


async def test_tasks_and_links_served(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    worker = Person(first_name="Wanda", last_name="Worker")
    shipper = Partner(name="Champagne Logistics")
    db.add_all([worker, shipper])
    await db.flush()
    plan = await _plan_row(db, move)
    s = _task(plan, 0, "Prep")
    a = _task(plan, 1, "Order crates", parent_id=s.id, duration_minutes=960,
              notes="call first")
    b = _task(plan, 2, "Pack", parent_id=s.id, duration_unit="h", duration_minutes=240)
    m = _task(plan, 3, "Go live", duration_minutes=0, is_milestone=True,
              show_on_timeline=True, color="#8e24aa")
    db.add(s)
    await db.flush()
    db.add_all([a, b, m])
    await db.flush()
    link_ab = PlanLink(plan_id=plan.id, predecessor_id=a.id, successor_id=b.id)
    link_sm = PlanLink(plan_id=plan.id, predecessor_id=s.id, successor_id=m.id,
                       link_type="FS", lag_minutes=960, lag_unit="d")
    db.add_all([link_ab, link_sm,
                PlanAssignment(task_id=a.id, person_id=worker.id),
                PlanAssignment(task_id=a.id, partner_id=shipper.id)])
    await db.commit()
    state = await service.load_state(db, plan)
    service.recalc(state, await service.settings_of(db, plan))
    await db.commit()

    body = (await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)).json()
    tasks = {t["name"]: t for t in body["tasks"]}
    assert [t["name"] for t in body["tasks"]] == ["Prep", "Order crates", "Pack", "Go live"]
    assert [t["display_id"] for t in body["tasks"]] == [1, 2, 3, 4]
    assert [t["wbs"] for t in body["tasks"]] == ["1", "1.1", "1.2", "2"]
    assert [t["outline_level"] for t in body["tasks"]] == [1, 2, 2, 1]
    assert [t["is_summary"] for t in body["tasks"]] == [True, False, False, False]
    assert tasks["Order crates"]["parent_id"] == str(s.id)

    crates = tasks["Order crates"]
    assert crates["start"] == "2026-11-02T08:00"
    assert crates["finish"] == "2026-11-03T17:00"
    assert crates["duration_text"] == "2 days"
    assert crates["successors"] == "3"
    assert crates["predecessors"] == ""
    assert crates["notes"] == "call first"
    assert sorted(crates["assignees"], key=lambda x: x["kind"]) == [
        {"kind": "partner", "id": str(shipper.id), "name": "Champagne Logistics"},
        {"kind": "person", "id": str(worker.id), "name": "Wanda Worker"},
    ]
    assert tasks["Pack"]["duration_text"] == "4 hrs"
    assert tasks["Pack"]["predecessors"] == "2"
    assert tasks["Pack"]["start"] == "2026-11-04T08:00"
    assert tasks["Pack"]["finish"] == "2026-11-04T12:00"
    assert tasks["Go live"]["predecessors"] == "1FS+2 days"
    assert tasks["Go live"]["is_milestone"] is True
    assert tasks["Go live"]["color"] == "#8e24aa"
    assert tasks["Go live"]["start"] == tasks["Go live"]["finish"] == "2026-11-06T12:00"
    assert tasks["Prep"]["successors"] == "4FS+2 days"
    assert tasks["Prep"]["duration_minutes"] == 1200
    assert body["project_finish"] == "2026-11-06T12:00"

    links = {(lk["predecessor_id"], lk["successor_id"]): lk for lk in body["links"]}
    lag = links[(str(s.id), str(m.id))]
    assert lag == {"id": str(link_sm.id), "predecessor_id": str(s.id),
                   "successor_id": str(m.id), "link_type": "FS", "lag_minutes": 960,
                   "lag_unit": "d", "lag_elapsed": False, "lag_text": "+2 days"}
    assert links[(str(a.id), str(b.id))]["lag_text"] == "0 days"

    for key in ("constraint_type", "constraint_date", "deadline", "actual_start",
                "actual_finish", "total_slack_minutes", "is_critical", "conflict",
                "baseline_start", "baseline_finish", "baseline_duration_minutes",
                "completed_at", "completed_by_name", "show_on_timeline", "mode",
                "elapsed", "duration_unit", "position", "updated_at", "status",
                "missed_deadline", "percent_complete", "created_at",
                "start_variance_minutes", "finish_variance_minutes", "color"):
        assert key in crates, key
    assert crates["color"] is None
    assert crates["created_at"] is not None
    assert crates["start_variance_minutes"] is None     # no baseline yet


async def test_variance_is_negative_ahead_of_the_baseline(client, db):
    """A task running ahead of its baseline has a negative variance: the
    working minutes from the baseline back to the schedule (MS Project's
    Start / Finish Variance), as the sheet shows them."""
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    plan = await _plan_row(db, move)
    db.add_all([
        # baselined to run Wed; it now runs Mon, two working days early
        _task(plan, 0, "ahead", baseline_start=dt("2026-11-04 08:00"),
              baseline_finish=dt("2026-11-04 17:00"), baseline_duration_minutes=480),
        # starts on its baseline but finishes a day early (Mon-Tue, not Mon-Wed)
        _task(plan, 1, "shorter", duration_minutes=960, baseline_start=dt("2026-11-02 08:00"),
              baseline_finish=dt("2026-11-04 17:00"), baseline_duration_minutes=1440),
    ])
    await db.commit()
    state = await service.load_state(db, plan)
    service.recalc(state, await service.settings_of(db, plan))
    await db.commit()

    body = (await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)).json()
    tasks = {t["name"]: t for t in body["tasks"]}
    ahead, shorter = tasks["ahead"], tasks["shorter"]
    assert (ahead["start"], ahead["finish"]) == ("2026-11-02T08:00", "2026-11-02T17:00")
    assert (ahead["start_variance_minutes"], ahead["finish_variance_minutes"]) == (-960, -960)
    assert shorter["finish"] == "2026-11-03T17:00"
    assert (shorter["start_variance_minutes"], shorter["finish_variance_minutes"]) == (0, -480)


async def test_task_status_and_missed_deadline(client, db):
    hdrs = await _admin(db, client)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    plan = await _plan_row(db, move)
    plan.status_date = dt("2026-11-04 12:00")
    rows = [
        # finishes Tue 17:00, before the status date
        _task(plan, 0, "late", duration_minutes=960),
        _task(plan, 1, "done", duration_minutes=960, percent_complete=100),
        _task(plan, 2, "going", duration_minutes=2400, percent_complete=50),
        _task(plan, 3, "waiting", duration_minutes=2400),
        # finishes Fri, but its deadline (Tue) has passed
        _task(plan, 4, "deadline", duration_minutes=2400, deadline=dt("2026-11-03 17:00")),
        # deadline later than the status date and the finish: not late
        _task(plan, 5, "roomy", duration_minutes=2400, deadline=dt("2026-11-20 17:00")),
    ]
    db.add_all(rows)
    await db.commit()
    state = await service.load_state(db, plan)
    service.recalc(state, await service.settings_of(db, plan))
    await db.commit()

    body = (await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)).json()
    assert body["status_date"] == "2026-11-04T12:00"
    tasks = {t["name"]: t for t in body["tasks"]}
    assert tasks["late"]["status"] == "late"
    assert tasks["done"]["status"] == "complete"
    assert tasks["going"]["status"] == "in_progress"
    assert tasks["waiting"]["status"] == "not_started"
    assert tasks["deadline"]["status"] == "late"
    assert tasks["roomy"]["status"] == "not_started"
    assert tasks["deadline"]["missed_deadline"] is True
    assert tasks["roomy"]["missed_deadline"] is False
    assert tasks["late"]["missed_deadline"] is False


async def test_owner_lock_and_completion_names(client, db):
    email = f"pn-{uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    me = await _person_id(db, email)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    plan = await _plan_row(db, move)
    plan.locked_at = datetime.now(UTC)
    plan.locked_by = me
    db.add(_task(plan, 0, "A", percent_complete=100, completed_at=datetime.now(UTC),
                 completed_by=me))
    await db.commit()

    body = (await client.get(f"/initiatives/{move.id}/plan", headers=hdrs)).json()
    assert body["locked_at"] is not None
    assert body["locked_by_name"] == "R X"
    assert body["tasks"][0]["completed_by_name"] == "R X"
    assert body["tasks"][0]["completed_at"] is not None
