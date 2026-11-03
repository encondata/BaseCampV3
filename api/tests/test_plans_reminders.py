"""The plan reminder sweep (notification-worker's run_plan_reminders_once):
stages before, on and after a task's due day at the plan-local send time,
only the latest passed stage sent and only on its own day, each once per
(task, person, stage, due day), the overdue digest to the plan's owner,
and the delivery rules (the person's own Project plans choice,
`email_assignees`).

Reference week: plan timezone America/Chicago, send time 08:00, offsets
[3, 1]; a deadline of Thu 2026-11-05 17:00 has stages d3 Mon 11-02 08:00,
d1 Wed 11-04 08:00, due Thu 11-05 08:00, then overdue from Fri 11-06."""

import copy
import dataclasses
import logging
from datetime import UTC, date, datetime, time, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    EmailOutbox,
    Initiative,
    InitiativePerson,
    Notification,
    Person,
    UserAccount,
)
from serversherpa.notifications.email import portal_link
from serversherpa.plans import reminders
from serversherpa.plans.calendar import STANDARD_CALENDAR
from serversherpa.plans.models import PlanReminderLog, PlanTask
from serversherpa.plans.settings import effective
from tests.test_plans_api import _admin, _create, _initiative, _plan_row, dt
from tests.test_plans_links import _assign
from tests.test_plans_ops import _add, _get, _ok, _update

CHICAGO = ZoneInfo("America/Chicago")
MOVE = "NAP11 Hall Migration"
DEADLINE = "2026-11-05T17:00"


# ── helpers ──────────────────────────────────────────────────────────


def _r(**changes):
    """The built-in reminder settings, with `changes`."""
    return dataclasses.replace(effective({}, None).reminders, **changes)


def _clock(monkeypatch, text: str) -> None:
    """The sweep's clock at a Chicago wall-clock time "YYYY-MM-DD HH:MM"."""
    local = datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=CHICAGO)
    monkeypatch.setattr(reminders, "_now", lambda: local.astimezone(UTC))


async def _sweep() -> dict:
    return await reminders.run_plan_reminders_once(get_sessionmaker())


async def _world(client, db, *, settings=None, **create):
    """An admin's plan (they own it unless `create` says otherwise) in
    America/Chicago, with `settings` as the plan's reminder overrides."""
    hdrs = await _admin(db, client)
    move = await _initiative(db, name=MOVE)
    plan = await _create(client, hdrs, move, **create)
    row = await _plan_row(db, move)
    row.timezone = "America/Chicago"
    row.settings = {"reminders": settings} if settings else {}
    await db.commit()
    return hdrs, move, plan


async def _crew(db, move, first, *, email=True, account=False, choice=None, team=True):
    """A team member. `email`: a contact email; `account`: a portal account
    (its login email is the contact email, or its own when there is none);
    `choice`: their Project plans delivery choice."""
    tag = uuid4().hex[:6]
    address = f"{first.lower()}-{tag}@test.example.com" if email else None
    person = Person(first_name=first, last_name="Crew", email=address)
    db.add(person)
    await db.flush()
    if account:
        prefs = {"notif": {"categories": {"plans": choice}}} if choice else {}
        db.add(UserAccount(person_id=person.id,
                           email=address or f"{first.lower()}-{tag}@login.example.com",
                           ui_prefs=prefs))
    if team:
        db.add(InitiativePerson(initiative_id=move.id, person_id=person.id))
    await db.commit()
    return person


async def _night_week(client, hdrs, plan) -> None:
    """The plan on a night crew's week: Mon-Fri 20:00-24:00 (a 4-hour day),
    from Mon 11-02 20:00. A night's work ends at 24:00, which is stored as
    the next day's 00:00."""
    nights = [["20:00", "24:00"]]
    calendar = {**copy.deepcopy(STANDARD_CALENDAR), "hours_per_day": 4, "hours_per_week": 20,
                "default_start": "20:00", "default_end": "23:00",
                "week": {day: [] if day in ("sat", "sun") else copy.deepcopy(nights)
                         for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}}
    version = (await _get(client, hdrs, plan))["version"]
    resp = await client.patch(f"/plans/{plan['id']}", headers=hdrs, json={
        "base_version": version, "calendar": calendar, "project_start": "2026-11-02T20:00"})
    assert resp.status_code == 200, resp.text


async def _task(client, hdrs, plan, name="Order crates", *people, deadline=DEADLINE) -> str:
    ids = await _add(client, hdrs, plan, name, deadline=deadline)
    if people:
        await _ok(client, hdrs, plan, [_assign(ids[name], *[("person", p.id) for p in people])])
    return ids[name]


async def _inbox(db, kind=None) -> list[Notification]:
    stmt = (select(Notification).order_by(Notification.created_at)
            .execution_options(populate_existing=True))
    if kind:
        stmt = stmt.where(Notification.kind == kind)
    return list(await db.scalars(stmt))


async def _mail(db, template=None) -> list[EmailOutbox]:
    stmt = (select(EmailOutbox).order_by(EmailOutbox.created_at)
            .execution_options(populate_existing=True))
    if template:
        stmt = stmt.where(EmailOutbox.template == template)
    return list(await db.scalars(stmt))


async def _reminders(db) -> tuple[list[Notification], list[EmailOutbox]]:
    """Every due and overdue inbox row, and every reminder email."""
    rows = [n for n in await _inbox(db) if n.kind in ("plan_task_due", "plan_task_overdue")]
    return rows, await _mail(db, "plan_reminder")


async def _logs(db) -> list[PlanReminderLog]:
    return list(await db.scalars(
        select(PlanReminderLog).order_by(PlanReminderLog.sent_at, PlanReminderLog.stage)
        .execution_options(populate_existing=True)))


def _counts(reminders=0, digests=0, errors=0) -> dict:
    return {"reminders": reminders, "digests": digests, "errors": errors}


def _task_link(move, task_id) -> str:
    return f"/initiatives/{move.id}?tab=plan&task={task_id}"


# ── stages (pure) ────────────────────────────────────────────────────

THU = date(2026, 11, 5)         # DEADLINE's day


def test_stages_before_and_on_the_due_day():
    stages = reminders.stages_for(THU, _r(), dt("2026-11-02 07:00"))
    assert stages == [("d3", dt("2026-11-02 08:00")), ("d1", dt("2026-11-04 08:00")),
                      ("due", dt("2026-11-05 08:00"))]


def test_daily_overdue_stages_are_only_the_last_two_days():
    """Only yesterday's and today's overdue stages: with a stage sent only
    on its own day, an older one is never the latest passed, so a task
    years overdue costs two stages a sweep, not one per day."""
    stages = reminders.stages_for(THU, _r(), dt("2026-11-07 10:00"))
    assert stages == [("d3", dt("2026-11-02 08:00")), ("d1", dt("2026-11-04 08:00")),
                      ("due", dt("2026-11-05 08:00")),
                      ("overdue:2026-11-06", dt("2026-11-06 08:00")),
                      ("overdue:2026-11-07", dt("2026-11-07 08:00"))]
    stages = reminders.stages_for(THU, _r(), dt("2028-11-07 10:00"))
    assert stages[3:] == [("overdue:2028-11-06", dt("2028-11-06 08:00")),
                          ("overdue:2028-11-07", dt("2028-11-07 08:00"))]
    # the day after the due day there is one; on the due day, none
    assert [s for s, _ in reminders.stages_for(THU, _r(), dt("2026-11-06 07:00"))][3:] == [
        "overdue:2026-11-06"]
    assert [s for s, _ in reminders.stages_for(THU, _r(), dt("2026-11-05 23:59"))] == [
        "d3", "d1", "due"]


def test_the_latest_passed_stage_is_the_one_the_full_run_has():
    """The two overdue stages kept give the same latest passed stage as
    every day's stage would, at any moment."""
    def every_day(now):
        stages = reminders.stages_for(THU, _r(overdue="off"), now)
        day = THU + timedelta(days=1)
        while day <= now.date():
            stages.append((f"overdue:{day.isoformat()}", datetime.combine(day, time(8))))
            day += timedelta(days=1)
        return stages

    start = dt("2026-11-01 00:00")
    for minutes in range(0, 20 * 24 * 60, 37):
        now = start + timedelta(minutes=minutes)
        assert (reminders.latest_due_stage(reminders.stages_for(THU, _r(), now), now)
                == reminders.latest_due_stage(every_day(now), now)), now


def test_once_overdue_is_one_stage_and_off_is_none():
    late = dt("2026-11-12 10:00")
    once = reminders.stages_for(THU, _r(overdue="once"), late)
    assert once[-1] == ("overdue", dt("2026-11-06 08:00"))
    assert [s for s, _ in once] == ["d3", "d1", "due", "overdue"]
    off = reminders.stages_for(THU, _r(overdue="off"), late)
    assert [s for s, _ in off] == ["d3", "d1", "due"]


def test_no_due_day_stage_when_it_is_off_and_the_send_time_is_the_plans():
    stages = reminders.stages_for(THU, _r(on_due_day=False, offsets_days=(2,), send_time="06:30"),
                                  dt("2026-11-01 00:00"))
    assert stages == [("d2", dt("2026-11-03 06:30"))]


def test_latest_due_stage():
    stages = reminders.stages_for(THU, _r(), dt("2026-11-07 07:00"))
    assert reminders.latest_due_stage(stages, dt("2026-11-02 07:59")) is None
    assert reminders.latest_due_stage(stages, dt("2026-11-04 09:00")) == (
        "d1", dt("2026-11-04 08:00"))
    assert reminders.latest_due_stage(stages, dt("2026-11-04 08:00")) == (
        "d1", dt("2026-11-04 08:00"))
    # before today's send time the latest is still yesterday's
    assert reminders.latest_due_stage(stages, dt("2026-11-07 07:00")) == (
        "overdue:2026-11-06", dt("2026-11-06 08:00"))


def _row(**fields) -> PlanTask:
    return PlanTask(name="T", **fields)


def test_the_due_day_is_a_deadlines_own_day_or_the_day_the_work_ends():
    """A deadline is a moment: 00:00 Friday is Friday. A finish is the end
    of the work: 00:00 Friday is Thursday's end (floating.last_day, the
    day the Calendar, Board and Timeline show it ending)."""
    night = {"start": dt("2026-11-05 20:00"), "finish": dt("2026-11-06 00:00")}
    assert reminders.due_day(_row(**night)) == date(2026, 11, 5)
    assert reminders.due_day(_row(**night, deadline=dt("2026-11-06 00:00"))) == date(2026, 11, 6)
    assert reminders.due_day(_row(start=dt("2026-11-05 08:00"),
                                  finish=dt("2026-11-05 17:00"))) == date(2026, 11, 5)
    # a milestone at midnight is that day
    assert reminders.due_day(_row(start=dt("2026-11-06 00:00"),
                                  finish=dt("2026-11-06 00:00"))) == date(2026, 11, 6)
    assert reminders.due_key(date(2026, 11, 5)) == dt("2026-11-05 00:00")


# ── the sweep ────────────────────────────────────────────────────────


async def test_sends_latest_stage_only(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    task_id = await _task(client, hdrs, plan, "Order crates", worker)

    _clock(monkeypatch, "2026-11-04 09:00")
    assert await _sweep() == _counts(reminders=1)
    [row], [mail] = await _reminders(db)
    assert row.person_id == worker.id and row.kind == "plan_task_due"
    assert row.title == f"Due Thursday, November 5: Order crates — {MOVE}"
    assert row.body == f"Order crates in {MOVE} is due Thursday, November 5."
    assert row.link == _task_link(move, task_id)
    assert mail.person_id == worker.id and mail.to_address == worker.email
    assert mail.kind == "plan_task_due"
    assert mail.subject == row.title
    assert "is due Thursday, November 5." in mail.text_body
    assert "Hi Wanda" in mail.text_body
    assert portal_link(_task_link(move, task_id)) in mail.text_body
    [log] = await _logs(db)
    assert (str(log.task_id), log.person_id, log.stage, log.due_at) == (
        task_id, worker.id, "d1", dt("2026-11-05 00:00"))

    # the same moment again, and later the same day: nothing new
    assert await _sweep() == _counts()
    _clock(monkeypatch, "2026-11-04 18:00")
    assert await _sweep() == _counts()
    rows, mails = await _reminders(db)
    assert len(rows) == 1 and len(mails) == 1


async def test_due_stage_says_due_today(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    await _task(client, hdrs, plan, "Order crates", worker)

    _clock(monkeypatch, "2026-11-05 08:00")
    assert await _sweep() == _counts(reminders=1)
    [row], [mail] = await _reminders(db)
    assert row.kind == "plan_task_due"
    assert row.title == mail.subject == f"Due today: Order crates — {MOVE}"
    assert row.body == f"Order crates in {MOVE} is due today."
    assert f"Order crates in {MOVE} is due today." in mail.text_body
    assert [log.stage for log in await _logs(db)] == ["due"]


async def test_downtime_no_burst(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    await _task(client, hdrs, plan, "Order crates", worker)

    # the sweep's first run ever is two days after the deadline
    _clock(monkeypatch, "2026-11-07 09:00")
    out = await _sweep()
    assert out["reminders"] == 1 and out["errors"] == 0
    [row], [mail] = await _reminders(db)
    assert row.kind == "plan_task_overdue" and mail.kind == "plan_task_overdue"
    assert row.title == mail.subject == f"Overdue: Order crates — {MOVE}"
    assert row.body == f"Order crates in {MOVE} has been overdue since Thursday, November 5."
    assert "has been overdue since Thursday, November 5." in mail.text_body
    assert [log.stage for log in await _logs(db) if log.person_id == worker.id] == [
        "overdue:2026-11-07"]

    # daily: the next one is tomorrow at the send time
    _clock(monkeypatch, "2026-11-08 07:59")
    assert (await _sweep())["reminders"] == 0
    _clock(monkeypatch, "2026-11-08 08:00")
    assert (await _sweep())["reminders"] == 1
    rows, mails = await _reminders(db)
    assert len(rows) == 2 and len(mails) == 2


async def test_overdue_once(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db, settings={"overdue": "once"})
    worker = await _crew(db, move, "Wanda", account=True)
    await _task(client, hdrs, plan, "Order crates", worker)

    _clock(monkeypatch, "2026-11-09 09:00")
    assert (await _sweep())["reminders"] == 1
    _clock(monkeypatch, "2026-11-10 09:00")
    assert (await _sweep())["reminders"] == 0
    [row], _ = await _reminders(db)
    assert row.kind == "plan_task_overdue"
    assert [log.stage for log in await _logs(db) if log.person_id == worker.id] == ["overdue"]


async def test_overdue_off_sends_no_stale_due_reminder(client, db, monkeypatch):
    """With overdue notices off, a sweep that missed the due day does not
    send a "Due today" for a task that was due yesterday."""
    hdrs, move, plan = await _world(client, db, settings={"overdue": "off"})
    worker = await _crew(db, move, "Wanda", account=True)
    await _task(client, hdrs, plan, "Order crates", worker)

    _clock(monkeypatch, "2026-11-06 09:00")
    assert await _sweep() == _counts()
    assert await _reminders(db) == ([], [])


async def test_no_due_today_the_morning_after(client, db, monkeypatch):
    """The day after the due day, before the send time, the latest passed
    stage is still `due`: it is not sent as "Due today"; the first overdue
    reminder goes at the send time."""
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    await _task(client, hdrs, plan, "Order crates", worker)

    _clock(monkeypatch, "2026-11-06 07:00")
    assert await _sweep() == _counts()
    _clock(monkeypatch, "2026-11-06 08:00")
    assert (await _sweep())["reminders"] == 1
    [row], _ = await _reminders(db)
    assert row.kind == "plan_task_overdue"


async def test_a_stage_is_sent_only_on_its_own_day(client, db, monkeypatch):
    """At 01:00 on the due day the latest passed stage is yesterday's d1:
    it is not sent then; the due day's reminder goes at the send time."""
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    await _task(client, hdrs, plan, "Order crates", worker)

    _clock(monkeypatch, "2026-11-05 01:00")
    assert await _sweep() == _counts()
    _clock(monkeypatch, "2026-11-05 08:00")
    assert await _sweep() == _counts(reminders=1)
    assert [log.stage for log in await _logs(db)] == ["due"]


async def test_reopened_overdue_task_sends_only_todays_reminder(client, db, monkeypatch):
    """A task reopened at 01:00 does not get yesterday's overdue reminder
    then and today's at the send time: only today's, at the send time."""
    hdrs, move, plan = await _world(client, db, settings={"overdue_to_owner": False})
    worker = await _crew(db, move, "Wanda", account=True)
    task_id = await _task(client, hdrs, plan, "Order crates", worker)

    async def percent(value):
        await db.execute(update(PlanTask).where(PlanTask.id == task_id)
                         .values(percent_complete=value))
        await db.commit()

    await percent(100)
    _clock(monkeypatch, "2026-11-08 01:00")
    assert await _sweep() == _counts()
    await percent(50)
    assert await _sweep() == _counts()
    _clock(monkeypatch, "2026-11-08 08:00")
    assert await _sweep() == _counts(reminders=1)
    assert [log.stage for log in await _logs(db)] == ["overdue:2026-11-08"]


async def test_dst_fall_back_sends_once(client, db, monkeypatch):
    """2026-11-01 01:30 happens twice in Chicago: d1 goes once, and the
    stage from two days before (d3) is not sent late."""
    hdrs, move, plan = await _world(client, db, settings={"send_time": "01:30"})
    worker = await _crew(db, move, "Wanda", account=True)
    await _task(client, hdrs, plan, "Order crates", worker, deadline="2026-11-02T17:00")
    sent = []
    # 06:20 UTC = 01:20 CDT, 06:40 = 01:40 CDT, 07:20 = 01:20 CST, 07:40 = 01:40 CST
    for hour, minute in ((6, 20), (6, 40), (7, 20), (7, 40)):
        moment = datetime(2026, 11, 1, hour, minute, tzinfo=UTC)
        monkeypatch.setattr(reminders, "_now", lambda m=moment: m)
        sent.append((await _sweep())["reminders"])
    assert sent == [0, 1, 0, 0]


async def test_same_day_due_time_change_sends_nothing_new(client, db, monkeypatch):
    """Reminders are deduplicated per due day: a deadline moved to another
    time the same day, or a finish nudged by a recalc, re-sends nothing."""
    hdrs, move, plan = await _world(
        client, db, settings={"use_finish_without_deadline": True, "overdue": "off"})
    worker = await _crew(db, move, "Wanda", account=True)
    task_id = await _task(client, hdrs, plan, "Order crates", worker)
    # no deadline: a 1-day task finishing Mon 11-02 17:00
    survey = (await _add(client, hdrs, plan, "Survey"))["Survey"]
    await _ok(client, hdrs, plan, [_assign(survey, ("person", worker.id))])

    _clock(monkeypatch, "2026-11-02 09:00")
    assert await _sweep() == _counts(reminders=2)      # Survey due, Order crates d3
    await _ok(client, hdrs, plan, [_update(survey, duration="4h"),
                                   _update(task_id, deadline="2026-11-05T12:00")])
    _clock(monkeypatch, "2026-11-02 10:00")
    assert await _sweep() == _counts()
    # the labels still read from the real due moment
    _clock(monkeypatch, "2026-11-04 08:00")
    assert await _sweep() == _counts(reminders=1)
    rows, _ = await _reminders(db)
    assert rows[-1].title == f"Due Thursday, November 5: Order crates — {MOVE}"
    assert rows[-1].payload["due_at"] == "2026-11-05T12:00"
    assert {(log.stage, log.due_at) for log in await _logs(db)} == {
        ("due", dt("2026-11-02 00:00")), ("d3", dt("2026-11-05 00:00")),
        ("d1", dt("2026-11-05 00:00"))}


async def test_resources_are_not_read_when_everything_is_logged(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    await _task(client, hdrs, plan, "Order crates", worker)
    calls = []
    real = reminders.resources_of

    async def counted(db_, initiative):
        calls.append(initiative.id)
        return await real(db_, initiative)

    monkeypatch.setattr(reminders, "resources_of", counted)
    _clock(monkeypatch, "2026-11-04 09:00")
    assert await _sweep() == _counts(reminders=1)
    assert calls == [move.id]
    _clock(monkeypatch, "2026-11-04 09:01")
    assert await _sweep() == _counts()
    assert calls == [move.id]           # the second sweep found it all logged


async def test_moved_deadline_rearms(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    task_id = await _task(client, hdrs, plan, "Order crates", worker)

    _clock(monkeypatch, "2026-11-04 09:00")
    assert (await _sweep())["reminders"] == 1

    # a week later: the new due_at starts over at d3
    await _ok(client, hdrs, plan, [_update(task_id, deadline="2026-11-12T17:00")])
    _clock(monkeypatch, "2026-11-09 09:00")
    assert (await _sweep())["reminders"] == 1
    rows, mails = await _reminders(db)
    assert rows[-1].title == f"Due Thursday, November 12: Order crates — {MOVE}"
    assert mails[-1].subject == rows[-1].title
    log = (await _logs(db))[-1]
    assert (log.stage, log.due_at) == ("d3", dt("2026-11-12 00:00"))

    # earlier, so d1 and the due day have both passed: only the latest goes
    await _ok(client, hdrs, plan, [_update(task_id, deadline="2026-11-09T17:00")])
    assert await _sweep() == _counts(reminders=1)
    rows, mails = await _reminders(db)
    assert len(rows) == 3 and len(mails) == 3
    assert rows[-1].title == f"Due today: Order crates — {MOVE}"
    log = (await _logs(db))[-1]
    assert (log.stage, log.due_at) == ("due", dt("2026-11-09 00:00"))


async def test_completed_and_inactive_skipped(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    task_id = await _task(client, hdrs, plan, "Order crates", worker)
    row = await _plan_row(db, move)
    _clock(monkeypatch, "2026-11-04 09:00")

    async def task_values(**values):
        await db.execute(update(PlanTask).where(PlanTask.id == task_id).values(**values))
        await db.commit()

    async def move_values(**values):
        await db.execute(update(Initiative).where(Initiative.id == move.id).values(**values))
        await db.commit()

    await task_values(percent_complete=100)
    assert await _sweep() == _counts()
    await task_values(percent_complete=0)

    await move_values(archived_at=datetime.now(UTC))
    assert await _sweep() == _counts()
    await move_values(archived_at=None)

    for status in ("completed", "cancelled"):
        await move_values(status=status)
        assert await _sweep() == _counts()
    await move_values(status="planned")

    row.settings = {"reminders": {"enabled": False}}
    await db.commit()
    assert await _sweep() == _counts()
    assert await _reminders(db) == ([], []) and await _logs(db) == []

    # with everything put back the same moment sends: the checks above were real
    row.settings = {}
    await db.commit()
    assert await _sweep() == _counts(reminders=1)


async def test_finish_used_only_when_the_setting_says(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    # no deadline; a 1-day task finishing Mon 11-02 17:00
    ids = await _add(client, hdrs, plan, "Survey")
    await _ok(client, hdrs, plan, [_assign(ids["Survey"], ("person", worker.id))])

    _clock(monkeypatch, "2026-11-02 09:00")
    assert await _sweep() == _counts()
    row = await _plan_row(db, move)
    row.settings = {"reminders": {"use_finish_without_deadline": True}}
    await db.commit()
    assert await _sweep() == _counts(reminders=1)
    [log] = await _logs(db)
    assert (log.stage, log.due_at) == ("due", dt("2026-11-02 00:00"))


async def test_a_finish_at_midnight_is_due_the_day_its_work_ends(client, db, monkeypatch):
    """A night move's task ends Thursday at 24:00 (stored Fri 00:00): its
    reminders call it due Thursday, as the Calendar, Board and Timeline
    show it, and its log rows are keyed on Thursday."""
    hdrs, move, plan = await _world(client, db, settings={"use_finish_without_deadline": True})
    row = await _plan_row(db, move)
    owner = await db.get(Person, row.owner_id)
    worker = await _crew(db, move, "Wanda", account=True)
    await _night_week(client, hdrs, plan)
    ids = await _add(client, hdrs, plan, "Night move", duration="4d")
    await _ok(client, hdrs, plan, [_assign(ids["Night move"], ("person", worker.id))])
    [task] = (await _get(client, hdrs, plan))["tasks"]
    assert (task["start"], task["finish"]) == ("2026-11-02T20:00", "2026-11-06T00:00")

    # d3 the Monday before: the finish is the edge of the sweep's horizon
    for day in ("2026-11-02", "2026-11-04", "2026-11-05"):
        _clock(monkeypatch, f"{day} 08:00")
        assert await _sweep() == _counts(reminders=1), day
    _clock(monkeypatch, "2026-11-06 08:00")
    assert await _sweep() == _counts(reminders=1, digests=1)
    rows, mails = await _reminders(db)
    assert [r.title for r in rows] == [
        f"Due Thursday, November 5: Night move — {MOVE}",
        f"Due Thursday, November 5: Night move — {MOVE}",
        f"Due today: Night move — {MOVE}",
        f"Overdue: Night move — {MOVE}"]
    assert rows[-1].body == f"Night move in {MOVE} has been overdue since Thursday, November 5."
    assert [m.subject for m in mails] == [r.title for r in rows]
    # the payload keeps the real due moment
    assert rows[0].payload["due_at"] == "2026-11-06T00:00"
    assert [(log.stage, log.due_at) for log in await _logs(db) if log.person_id == worker.id] == [
        ("d3", dt("2026-11-05 00:00")), ("d1", dt("2026-11-05 00:00")),
        ("due", dt("2026-11-05 00:00")),
        ("overdue:2026-11-06", dt("2026-11-05 00:00"))]
    [digest] = await _mail(db, "plan_overdue_digest")
    assert digest.person_id == owner.id
    assert "Due Thursday, November 5 · Wanda Crew" in digest.text_body
    # a later sweep the same day finds them all logged under Thursday
    _clock(monkeypatch, "2026-11-06 09:00")
    assert await _sweep() == _counts()


async def test_a_deadline_at_midnight_is_its_own_day(client, db, monkeypatch):
    """A deadline is a moment, not a span: one at 00:00 Friday is due
    Friday, even with the finish rule on."""
    hdrs, move, plan = await _world(client, db, settings={"use_finish_without_deadline": True})
    worker = await _crew(db, move, "Wanda", account=True)
    await _task(client, hdrs, plan, "Order crates", worker, deadline="2026-11-06T00:00")

    _clock(monkeypatch, "2026-11-05 08:00")
    assert await _sweep() == _counts(reminders=1)
    [row], _ = await _reminders(db)
    assert row.title == f"Due Friday, November 6: Order crates — {MOVE}"
    [log] = await _logs(db)
    assert (log.stage, log.due_at) == ("d1", dt("2026-11-06 00:00"))


async def _summary_over(client, hdrs, plan, worker, **summary) -> dict[str, str]:
    """"Planning" over "Survey" (no deadline: 1 day, finishing Mon 11-02
    17:00), both assigned to `worker`; `summary` are fields for Planning."""
    ids = await _add(client, hdrs, plan, "Planning", "Survey")
    await _ok(client, hdrs, plan, [
        {"op": "indent", "ids": [ids["Survey"]]},
        *([_update(ids["Planning"], **summary)] if summary else []),
        _assign(ids["Planning"], ("person", worker.id)),
        _assign(ids["Survey"], ("person", worker.id))])
    tasks = {t["name"]: t for t in (await _get(client, hdrs, plan))["tasks"]}
    assert tasks["Survey"]["parent_id"] == ids["Planning"]
    assert tasks["Planning"]["finish"] == tasks["Survey"]["finish"] == "2026-11-02T17:00"
    return ids


async def test_a_summary_is_not_reminded_on_its_finish(client, db, monkeypatch):
    """With finishes as due dates, a summary's finish is its last subtask's:
    its subtasks are reminded on their own, so the summary gets no stages
    and stays out of the owner's digest. Being a summary is the outline's
    say: a summary whose subtask leaves is reminded on its finish again."""
    hdrs, move, plan = await _world(client, db, settings={"use_finish_without_deadline": True})
    worker = await _crew(db, move, "Wanda", account=True)
    ids = await _summary_over(client, hdrs, plan, worker)

    # Wed 11-04: both finished Monday, but only Survey is overdue
    _clock(monkeypatch, "2026-11-04 09:00")
    assert await _sweep() == _counts(reminders=1, digests=1)
    rows, mails = await _reminders(db)
    assert [r.title for r in rows] == [f"Overdue: Survey — {MOVE}"]
    assert [m.subject for m in mails] == [r.title for r in rows]
    [digest] = await _inbox(db, "plan_overdue_digest")
    assert (digest.title, digest.body) == (f"1 overdue task in {MOVE}", "Survey")
    assert digest.payload["task_ids"] == [ids["Survey"]]
    [mail] = await _mail(db, "plan_overdue_digest")
    assert "Planning" not in mail.text_body
    assert {str(log.task_id) for log in await _logs(db)} == {ids["Survey"]}

    # outdented, Survey leaves Planning a task of its own, due at its finish
    await _ok(client, hdrs, plan, [{"op": "outdent", "ids": [ids["Survey"]]}])
    _clock(monkeypatch, "2026-11-05 09:00")
    assert await _sweep() == _counts(reminders=2, digests=1)
    rows, _ = await _reminders(db)
    assert sorted(r.title for r in rows[1:]) == [f"Overdue: Planning — {MOVE}",
                                                 f"Overdue: Survey — {MOVE}"]
    assert (await _inbox(db, "plan_overdue_digest"))[-1].title == f"2 overdue tasks in {MOVE}"


async def test_a_summary_with_its_own_deadline_is_still_reminded(client, db, monkeypatch):
    """A summary's own Deadline is a due date like any other task's: its
    stages go, and it is counted in the owner's digest once overdue."""
    hdrs, move, plan = await _world(client, db, settings={"use_finish_without_deadline": True})
    worker = await _crew(db, move, "Wanda", account=True)
    ids = await _summary_over(client, hdrs, plan, worker, deadline=DEADLINE)

    # Wed 11-04: Planning's d1 (due Thursday), Survey overdue since Monday
    _clock(monkeypatch, "2026-11-04 09:00")
    assert await _sweep() == _counts(reminders=2, digests=1)
    rows, _ = await _reminders(db)
    assert sorted(r.title for r in rows) == [f"Due Thursday, November 5: Planning — {MOVE}",
                                             f"Overdue: Survey — {MOVE}"]
    [digest] = await _inbox(db, "plan_overdue_digest")
    assert (digest.title, digest.body) == (f"1 overdue task in {MOVE}", "Survey")

    # Fri 11-06: Planning is overdue too, and the digest counts both
    _clock(monkeypatch, "2026-11-06 09:00")
    assert await _sweep() == _counts(reminders=2, digests=1)
    rows, _ = await _reminders(db)
    assert sorted(r.title for r in rows[2:]) == [f"Overdue: Planning — {MOVE}",
                                                 f"Overdue: Survey — {MOVE}"]
    digest = (await _inbox(db, "plan_overdue_digest"))[-1]
    assert (digest.title, digest.body) == (f"2 overdue tasks in {MOVE}", "Planning, Survey")
    assert sorted(digest.payload["task_ids"]) == sorted([ids["Planning"], ids["Survey"]])
    planning = {(log.stage, log.person_id) for log in await _logs(db)
                if str(log.task_id) == ids["Planning"]}
    assert ("d1", worker.id) in planning and ("overdue:2026-11-06", worker.id) in planning


async def test_category_off(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db)
    off = await _crew(db, move, "Olive", account=True, choice="off")
    inbox_only = await _crew(db, move, "Ian", account=True, choice="inbox")
    no_account = await _crew(db, move, "Nora")
    unreachable = await _crew(db, move, "Una", email=False)
    await _task(client, hdrs, plan, "Order crates", off, inbox_only, no_account, unreachable)

    _clock(monkeypatch, "2026-11-04 09:00")
    assert await _sweep() == _counts(reminders=2)
    rows, mails = await _reminders(db)
    assert [n.person_id for n in rows] == [inbox_only.id]
    assert [(m.person_id, m.to_address) for m in mails] == [(no_account.id, no_account.email)]
    # nobody without an account has an inbox row, of any kind
    people = {n.person_id for n in await _inbox(db)}
    assert no_account.id not in people and unreachable.id not in people


async def test_email_assignees_off(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db, settings={"email_assignees": False})
    worker = await _crew(db, move, "Wanda", account=True)
    no_account = await _crew(db, move, "Nora")
    await _task(client, hdrs, plan, "Order crates", worker, no_account)

    _clock(monkeypatch, "2026-11-04 09:00")
    assert await _sweep() == _counts(reminders=1)
    rows, mails = await _reminders(db)
    assert [n.person_id for n in rows] == [worker.id]
    assert mails == []


async def test_departed_assignee_skipped(client, db, monkeypatch):
    """Reminders go only to assignees still among the plan's resources: an
    undo can put back someone who has since left the initiative."""
    hdrs, move, plan = await _world(client, db)
    stays = await _crew(db, move, "Stan", account=True)
    leaves = await _crew(db, move, "Lena", account=True)
    await _task(client, hdrs, plan, "Order crates", stays, leaves)
    await db.execute(delete(InitiativePerson).where(InitiativePerson.person_id == leaves.id))
    await db.commit()

    _clock(monkeypatch, "2026-11-04 09:00")
    assert await _sweep() == _counts(reminders=1)
    rows, mails = await _reminders(db)
    assert [n.person_id for n in rows] == [stays.id]
    assert [m.person_id for m in mails] == [stays.id]
    assert {log.person_id for log in await _logs(db)} == {stays.id}


async def test_partners_get_nothing(client, db, monkeypatch):
    from serversherpa.db.models import Partner

    hdrs, move, plan = await _world(client, db)
    shipper = Partner(name="Champagne Logistics")
    db.add(shipper)
    await db.flush()
    await db.execute(update(Initiative).where(Initiative.id == move.id)
                     .values(shipping_partner_id=shipper.id))
    await db.commit()
    ids = await _add(client, hdrs, plan, "Order crates", deadline=DEADLINE)
    await _ok(client, hdrs, plan, [_assign(ids["Order crates"], ("partner", shipper.id))])

    _clock(monkeypatch, "2026-11-04 09:00")
    assert await _sweep() == _counts()


# ── the owner's overdue digest ───────────────────────────────────────


async def test_owner_digest(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db)
    row = await _plan_row(db, move)
    owner = await db.get(Person, row.owner_id)
    worker = await _crew(db, move, "Wanda", account=True)
    crates = await _task(client, hdrs, plan, "Order crates", worker)
    trucks = await _task(client, hdrs, plan, "Book trucks", deadline="2026-11-04T12:00")

    _clock(monkeypatch, "2026-11-06 09:00")
    assert await _sweep() == _counts(reminders=1, digests=1)
    [digest] = await _inbox(db, "plan_overdue_digest")
    assert digest.person_id == owner.id
    assert digest.title == f"2 overdue tasks in {MOVE}"
    assert digest.link == f"/initiatives/{move.id}?tab=plan"
    assert "Order crates" in digest.body and "Book trucks" in digest.body
    [mail] = await _mail(db, "plan_overdue_digest")
    assert mail.person_id == owner.id and mail.kind == "plan_overdue_digest"
    assert mail.subject == digest.title
    # outline order, each with its due day and its resources
    text = mail.text_body
    assert text.index("Order crates") < text.index("Book trucks")
    assert "Due Thursday, November 5 · Wanda Crew" in text
    assert "Due Wednesday, November 4 · Unassigned" in text
    assert portal_link(f"/initiatives/{move.id}?tab=plan") in text
    owner_logs = [(str(log.task_id), log.stage) for log in await _logs(db)
                  if log.person_id == owner.id]
    assert sorted(owner_logs) == sorted([(crates, "owner:2026-11-06"),
                                         (trucks, "owner:2026-11-06")])

    # once a day: nothing more today, one new digest tomorrow
    _clock(monkeypatch, "2026-11-06 15:00")
    assert await _sweep() == _counts()
    _clock(monkeypatch, "2026-11-07 08:00")
    assert await _sweep() == _counts(reminders=1, digests=1)
    digests = await _inbox(db, "plan_overdue_digest")
    assert len(digests) == 2 and digests[-1].title == f"2 overdue tasks in {MOVE}"
    assert len(await _mail(db, "plan_overdue_digest")) == 2


async def test_owner_digest_once_a_day(client, db, monkeypatch):
    """A task that turns overdue after today's digest waits for tomorrow's."""
    hdrs, _move, plan = await _world(client, db)
    await _task(client, hdrs, plan, "Order crates")
    later = await _task(client, hdrs, plan, "Book trucks", deadline="2026-11-20T17:00")

    _clock(monkeypatch, "2026-11-06 09:00")
    assert await _sweep() == _counts(digests=1)
    await _ok(client, hdrs, plan, [_update(later, deadline="2026-11-05T12:00")])
    _clock(monkeypatch, "2026-11-06 14:00")
    assert await _sweep() == _counts()
    _clock(monkeypatch, "2026-11-07 09:00")
    assert await _sweep() == _counts(digests=1)
    digests = await _inbox(db, "plan_overdue_digest")
    assert [d.title for d in digests] == [f"1 overdue task in {MOVE}",
                                          f"2 overdue tasks in {MOVE}"]


async def test_late_overdue_task_waits_for_the_next_send_time(client, db, monkeypatch):
    """A task that turns overdue after today's digest is not sent just after
    midnight: tomorrow's digest goes at the send time and lists both."""
    hdrs, _move, plan = await _world(client, db)
    await _task(client, hdrs, plan, "Order crates")
    later = await _task(client, hdrs, plan, "Book trucks", deadline="2026-11-20T17:00")

    _clock(monkeypatch, "2026-11-06 09:00")
    assert await _sweep() == _counts(digests=1)
    await _ok(client, hdrs, plan, [_update(later, deadline="2026-11-05T12:00")])
    _clock(monkeypatch, "2026-11-06 14:00")
    assert await _sweep() == _counts()
    _clock(monkeypatch, "2026-11-07 00:30")
    assert await _sweep() == _counts()
    _clock(monkeypatch, "2026-11-07 08:00")
    assert await _sweep() == _counts(digests=1)
    # and the day after, at the send time again, not at midnight
    _clock(monkeypatch, "2026-11-08 00:30")
    assert await _sweep() == _counts()
    _clock(monkeypatch, "2026-11-08 08:00")
    assert await _sweep() == _counts(digests=1)
    digests = await _inbox(db, "plan_overdue_digest")
    assert [(d.title, d.payload["day"]) for d in digests] == [
        (f"1 overdue task in {MOVE}", "2026-11-06"),
        (f"2 overdue tasks in {MOVE}", "2026-11-07"),
        (f"2 overdue tasks in {MOVE}", "2026-11-08")]


async def test_digest_waits_for_the_send_time_with_overdue_once(client, db, monkeypatch):
    hdrs, _move, plan = await _world(client, db, settings={"overdue": "once"})
    await _task(client, hdrs, plan, "Order crates")
    later = await _task(client, hdrs, plan, "Book trucks", deadline="2026-11-20T17:00")

    _clock(monkeypatch, "2026-11-06 09:00")
    assert await _sweep() == _counts(digests=1)
    await _ok(client, hdrs, plan, [_update(later, deadline="2026-11-05T12:00")])
    _clock(monkeypatch, "2026-11-07 00:30")
    assert await _sweep() == _counts()
    _clock(monkeypatch, "2026-11-07 08:00")
    assert await _sweep() == _counts(digests=1)
    digests = await _inbox(db, "plan_overdue_digest")
    assert [d.body for d in digests] == ["Order crates", "Book trucks"]


async def test_creator_is_default_owner(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db, owner_id=None)
    row = await _plan_row(db, move)
    assert row.owner_id is None and row.created_by is not None
    await _task(client, hdrs, plan, "Order crates")

    _clock(monkeypatch, "2026-11-06 09:00")
    assert await _sweep() == _counts(digests=1)
    [digest] = await _inbox(db, "plan_overdue_digest")
    assert digest.person_id == row.created_by
    [mail] = await _mail(db, "plan_overdue_digest")
    assert mail.person_id == row.created_by


async def test_owner_digest_off(client, db, monkeypatch):
    hdrs, _move, plan = await _world(client, db, settings={"overdue_to_owner": False})
    await _task(client, hdrs, plan, "Order crates")
    _clock(monkeypatch, "2026-11-06 09:00")
    assert await _sweep() == _counts()
    assert await _inbox(db, "plan_overdue_digest") == []


async def test_owner_digest_follows_the_owners_choice(client, db, monkeypatch):
    hdrs, move, plan = await _world(client, db)
    row = await _plan_row(db, move)
    await db.execute(update(UserAccount).where(UserAccount.person_id == row.owner_id)
                     .values(ui_prefs={"notif": {"categories": {"plans": "inbox"}}}))
    await db.commit()
    await _task(client, hdrs, plan, "Order crates")
    _clock(monkeypatch, "2026-11-06 09:00")
    assert await _sweep() == _counts(digests=1)
    assert len(await _inbox(db, "plan_overdue_digest")) == 1
    assert await _mail(db, "plan_overdue_digest") == []


# ── failures ─────────────────────────────────────────────────────────


async def test_one_failing_plan_is_counted_and_logged_once(client, db, monkeypatch, caplog):
    hdrs, move, plan = await _world(client, db)
    worker = await _crew(db, move, "Wanda", account=True)
    await _task(client, hdrs, plan, "Order crates", worker)
    hdrs2, move2, plan2 = await _world(client, db)
    worker2 = await _crew(db, move2, "Walt", account=True)
    await _task(client, hdrs2, plan2, "Order crates", worker2)
    broken = (await _plan_row(db, move2)).id

    real = reminders._plan_one

    async def flaky(db_, plan_id, now, system):
        if plan_id == broken:
            raise RuntimeError("boom")
        return await real(db_, plan_id, now, system)

    monkeypatch.setattr(reminders, "_plan_one", flaky)
    caplog.set_level(logging.WARNING, logger="serversherpa.plans.reminders")
    _clock(monkeypatch, "2026-11-04 09:00")
    assert await _sweep() == _counts(reminders=1, errors=1)
    assert await _sweep() == _counts(errors=1)
    assert caplog.text.count("plan reminders failed") == 1     # once per outage
    rows, _ = await _reminders(db)
    assert [n.person_id for n in rows] == [worker.id]
