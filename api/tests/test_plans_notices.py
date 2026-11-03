"""Assignment notices: POST /plans/{plan_id}/ops tells each person a
`set_assignees` newly put on tasks (never the actor), once per batch, with
an inbox row (`plan_task_assigned`) and a direct `plan_assigned` email,
under the same delivery rules as the reminders."""

from datetime import date

from sqlalchemy import select, update

from serversherpa.db.models import Notification
from serversherpa.notifications.email import portal_link
from serversherpa.plans import notices
from serversherpa.plans.models import ProjectPlan
from tests.test_plans_api import dt
from tests.test_plans_links import _assign
from tests.test_plans_ops import _add, _ok, _ops
from tests.test_plans_reminders import MOVE, _crew, _inbox, _mail, _world


async def _assigned(db):
    return await _inbox(db, "plan_task_assigned"), await _mail(db, "plan_assigned")


async def _actor_id(db, plan) -> object:
    return await db.scalar(select(ProjectPlan.created_by)
                           .where(ProjectPlan.id == plan["id"]))


async def test_assignment_notice(client, db, monkeypatch):
    # the labels carry the year only when it is not this year's: pin "today"
    monkeypatch.setattr(notices, "plan_now", lambda zone: dt("2026-11-02 09:00"))
    hdrs, move, plan = await _world(client, db)
    me = await _actor_id(db, plan)
    worker = await _crew(db, move, "Wanda", account=True)
    ids = await _add(client, hdrs, plan, "Order crates", deadline="2026-11-05T17:00")
    ids.update(await _add(client, hdrs, plan, "Book trucks", "Load trucks"))

    # two people, one of them the actor: only the other hears about it
    await _ok(client, hdrs, plan, [_assign(ids["Order crates"], ("person", me),
                                           ("person", worker.id))])
    [row], [mail] = await _assigned(db)
    assert row.person_id == worker.id and row.kind == "plan_task_assigned"
    assert row.title == f"You were assigned 1 task in {MOVE}"
    assert row.body == "Order crates"
    link = f"/initiatives/{move.id}?tab=plan&task={ids['Order crates']}"
    assert row.link == link
    assert mail.person_id == worker.id and mail.to_address == worker.email
    assert mail.kind == "plan_task_assigned"
    assert mail.subject == row.title
    text = mail.text_body
    assert "Hi Wanda" in text and "R X assigned you 1 task in" in text
    assert "Order crates" in text
    assert "Start Mon, Nov 2 · Finish Mon, Nov 2 · Deadline Thu, Nov 5" in text
    assert portal_link(link) in text
    assert {n.person_id for n in await _inbox(db)} == {worker.id}

    # one notice per person per batch, however many tasks
    await _ok(client, hdrs, plan, [_assign(ids["Book trucks"], ("person", worker.id)),
                                   _assign(ids["Load trucks"], ("person", worker.id))])
    rows, mails = await _assigned(db)
    assert len(rows) == 2 and len(mails) == 2
    assert rows[-1].title == mails[-1].subject == f"You were assigned 2 tasks in {MOVE}"
    assert rows[-1].body == "Book trucks, Load trucks"
    assert rows[-1].link.endswith(f"task={ids['Book trucks']}")
    assert "Book trucks" in mails[-1].text_body and "Load trucks" in mails[-1].text_body

    # the same assignees again, then off and back by undo: nobody is new
    await _ok(client, hdrs, plan, [_assign(ids["Book trucks"], ("person", worker.id))])
    body = await _ok(client, hdrs, plan, [_assign(ids["Book trucks"])])
    await _ok(client, hdrs, plan, body["inverse"])
    rows, mails = await _assigned(db)
    assert len(rows) == 2 and len(mails) == 2


async def test_notify_on_assign_off(client, db):
    hdrs, move, plan = await _world(client, db, settings={"notify_on_assign": False})
    worker = await _crew(db, move, "Wanda", account=True)
    ids = await _add(client, hdrs, plan, "Order crates")
    await _ok(client, hdrs, plan, [_assign(ids["Order crates"], ("person", worker.id))])
    assert await _assigned(db) == ([], [])


async def test_assignment_notice_delivery_rules(client, db):
    hdrs, move, plan = await _world(client, db)
    off = await _crew(db, move, "Olive", account=True, choice="off")
    inbox_only = await _crew(db, move, "Ian", account=True, choice="inbox")
    no_account = await _crew(db, move, "Nora")
    unreachable = await _crew(db, move, "Una", email=False)
    ids = await _add(client, hdrs, plan, "Order crates")
    await _ok(client, hdrs, plan, [_assign(ids["Order crates"], *[
        ("person", p.id) for p in (off, inbox_only, no_account, unreachable)])])
    rows, mails = await _assigned(db)
    assert [n.person_id for n in rows] == [inbox_only.id]
    assert [(m.person_id, m.to_address) for m in mails] == [(no_account.id, no_account.email)]

    # email_assignees off: the inbox row stays, the email goes
    row = await db.scalar(select(ProjectPlan).where(ProjectPlan.id == plan["id"]))
    await db.execute(update(ProjectPlan).where(ProjectPlan.id == row.id)
                     .values(settings={"reminders": {"email_assignees": False}}))
    await db.commit()
    worker = await _crew(db, move, "Wanda", account=True)
    ids.update(await _add(client, hdrs, plan, "Book trucks"))
    await _ok(client, hdrs, plan, [_assign(ids["Book trucks"], ("person", worker.id),
                                           ("person", no_account.id))])
    rows, mails = await _assigned(db)
    assert [n.person_id for n in rows] == [inbox_only.id, worker.id]
    assert len(mails) == 1


def test_day_labels_carry_the_year_only_when_it_differs():
    today = date(2026, 11, 2)
    assert notices.long_day(date(2026, 11, 5), today) == "Thursday, November 5"
    assert notices.long_day(date(2027, 1, 7), today) == "Thursday, January 7, 2027"
    assert notices.short_day(date(2026, 11, 5), today) == "Thu, Nov 5"
    assert notices.short_day(date(2027, 1, 7), today) == "Thu, Jan 7, 2027"


def test_name_list_caps_the_inbox_body():
    assert notices.name_list(["A"]) == "A"
    assert notices.name_list([str(n) for n in range(7)]) == "0, 1, 2, 3, 4 and 2 more"


async def test_a_failed_batch_sends_no_notice(client, db):
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    ids = await _add(client, hdrs, plan, "Order crates")
    resp = await _ops(client, hdrs, plan, [
        _assign(ids["Order crates"], ("person", worker.id)),
        {"op": "update_task", "id": ids["Order crates"], "fields": {"duration": "soon"}}])
    assert resp.status_code == 422, resp.text
    assert await _assigned(db) == ([], [])
    assert await db.scalar(select(Notification.id).limit(1)) is None
