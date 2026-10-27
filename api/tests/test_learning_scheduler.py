"""The learning sweep (notification-worker's run_learning_once): scheduled
invites at the site's local send time, reminders once per offset, the
overdue notice once per initiative per local day. Plus the initiative
Learning manager API built on the same pieces: summary, schedule, roster,
regenerate / revoke, the code sheet PDF and the timeline's send marker."""
import logging
import uuid
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import func, select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import EmailOutbox, Initiative, Notification, Site
from serversherpa.learning import invites, scheduler
from serversherpa.learning.models import (
    LearningAssignment,
    LearningCode,
    LearningEmailLog,
    LearningInviteSchedule,
)
from tests.test_learning_assign import TODAY, _doc, _manager, _midnight, _packet, _worker
from tests.test_sites_api import login
from tests.test_status_values_write import _make

TOKYO = ZoneInfo("Asia/Tokyo")


async def _move(db, *, start, zone=None, end=None, name="Move"):
    site = None
    if zone is not None:
        site = Site(name=f"Site {uuid.uuid4().hex[:6]}", timezone=zone)
        db.add(site)
        await db.flush()
    move = Initiative(name=name, initiative_type="move", site_id=site.id if site else None,
                      scheduled_start=_midnight(start),
                      scheduled_end=_midnight(end) if end else None)
    db.add(move)
    await db.commit()
    return move


async def _add(db, client, hdrs, move, person):
    resp = await client.post(f"/initiatives/{move.id}/people", headers=hdrs,
                             json={"person_id": str(person.id)})
    assert resp.status_code == 201, resp.text


async def _outbox(db, template=None):
    stmt = select(EmailOutbox).order_by(EmailOutbox.created_at).execution_options(
        populate_existing=True)
    if template:
        stmt = stmt.where(EmailOutbox.template == template)
    return list(await db.scalars(stmt))


def _clock(monkeypatch, at: datetime):
    monkeypatch.setattr(scheduler, "_now", lambda: at)


async def _setup(db, client, *, start, zone=None, people=1, end=None):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Site safety")
    await _packet(db, [doc])
    move = await _move(db, start=start, zone=zone, end=end)
    workers = []
    for i in range(people):
        w = await _worker(db, f"W{i}", f"Worker{i}", f"w{i}-{uuid.uuid4().hex[:6]}@test.example.com")
        await _add(db, client, hdrs, move, w)
        workers.append(w)
    return hdrs, move, workers


# ── the sweep ────────────────────────────────────────────────────────


async def test_scheduled_send_fires_once_at_site_time(client, db, seeded_user, monkeypatch):
    start = TODAY + timedelta(days=14)
    hdrs, move, [worker] = await _setup(db, client, start=start, zone="Asia/Tokyo")
    resp = await client.put(f"/learning/initiatives/{move.id}/schedule", headers=hdrs, json={
        "mode": "scheduled", "send_offset_days": 7, "send_time": "08:00",
        "reminder_offsets": [5, 3], "due_offset_days": 2, "late_adds": True})
    assert resp.status_code == 200, resp.text
    send_at = datetime.combine(start - timedelta(days=7), time(8, 0), tzinfo=TOKYO)
    assert datetime.fromisoformat(resp.json()["send_at"]) == send_at

    _clock(monkeypatch, send_at - timedelta(minutes=1))
    assert (await scheduler.run_learning_once(get_sessionmaker()))["invites"] == 0
    assert await _outbox(db, "learning_invite") == []

    _clock(monkeypatch, send_at + timedelta(seconds=1))
    assert (await scheduler.run_learning_once(get_sessionmaker()))["invites"] == 1
    assert (await scheduler.run_learning_once(get_sessionmaker()))["invites"] == 0
    [mail] = await _outbox(db, "learning_invite")
    assert mail.person_id == worker.id
    schedule = await db.get(LearningInviteSchedule, move.id)
    await db.refresh(schedule)
    assert schedule.sent_at is not None


async def test_manual_mode_never_sends_on_its_own(client, db, seeded_user, monkeypatch):
    start = TODAY + timedelta(days=14)
    _, move, _ = await _setup(db, client, start=start)
    db.add(LearningInviteSchedule(initiative_id=move.id, mode="manual"))
    await db.commit()
    _clock(monkeypatch, datetime.now(UTC) + timedelta(days=13))
    assert (await scheduler.run_learning_once(get_sessionmaker()))["invites"] == 0


async def test_reminders_per_offset_once(client, db, seeded_user, monkeypatch):
    start = TODAY + timedelta(days=14)
    hdrs, move, workers = await _setup(db, client, start=start, people=2)
    resp = await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})
    assert resp.json()["sent"] == 2
    # one of them finishes: reminders only go to people with open items
    await db.execute(update(LearningAssignment)
                     .where(LearningAssignment.person_id == workers[1].id)
                     .values(status="signed", signed_at=datetime.now(UTC)))
    await db.commit()

    def at(offset):
        return datetime.combine(start - timedelta(days=offset), time(8, 0), tzinfo=UTC)

    _clock(monkeypatch, at(5) - timedelta(minutes=1))
    assert (await scheduler.run_learning_once(get_sessionmaker()))["reminders"] == 0
    _clock(monkeypatch, at(5) + timedelta(minutes=1))
    assert (await scheduler.run_learning_once(get_sessionmaker()))["reminders"] == 1
    assert (await scheduler.run_learning_once(get_sessionmaker()))["reminders"] == 0
    _clock(monkeypatch, at(3) + timedelta(hours=2))
    assert (await scheduler.run_learning_once(get_sessionmaker()))["reminders"] == 1
    assert (await scheduler.run_learning_once(get_sessionmaker()))["reminders"] == 0

    mails = await _outbox(db, "learning_reminder")
    assert [m.person_id for m in mails] == [workers[0].id, workers[0].id]
    stages = sorted(log.stage for log in await db.scalars(
        select(LearningEmailLog).where(LearningEmailLog.kind == "reminder")))
    assert stages == ["r3", "r5"]


async def test_reminders_skip_a_missed_stage_and_never_after_start(
        client, db, seeded_user, monkeypatch):
    start = TODAY + timedelta(days=14)
    hdrs, move, [worker] = await _setup(db, client, start=start)
    await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})
    # the worker was down through both reminder times: only the latest goes
    _clock(monkeypatch, datetime.combine(start - timedelta(days=1), time(9), tzinfo=UTC))
    assert (await scheduler.run_learning_once(get_sessionmaker()))["reminders"] == 1
    [log] = list(await db.scalars(select(LearningEmailLog).where(
        LearningEmailLog.kind == "reminder", LearningEmailLog.person_id == worker.id)))
    assert log.stage == "r3"
    # someone invited after the last reminder time gets no instant reminder
    late = await _worker(db, "Lee", "Late", "lee@test.example.com")
    await _add(db, client, hdrs, move, late)     # a late add: invited right away
    await db.execute(update(LearningCode).where(LearningCode.person_id == late.id).values(
        created_at=datetime.combine(start - timedelta(days=3), time(10), tzinfo=UTC)))
    await db.commit()
    assert len(await _outbox(db, "learning_invite")) == 2
    assert (await scheduler.run_learning_once(get_sessionmaker()))["reminders"] == 0
    # and nothing at all once the initiative has started
    _clock(monkeypatch, datetime.combine(start + timedelta(days=2), time(9), tzinfo=UTC))
    assert (await scheduler.run_learning_once(get_sessionmaker()))["reminders"] == 0


async def test_start_day_reminder_late_in_a_western_zone(client, db, seeded_user,
                                                         monkeypatch):
    start = TODAY + timedelta(days=10)
    hdrs, move, _ = await _setup(db, client, start=start, zone="America/Los_Angeles")
    await client.put(f"/learning/initiatives/{move.id}/schedule", headers=hdrs,
                     json={"reminder_offsets": [0], "send_time": "23:00"})
    await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})
    # 23:01 on the start day in Los Angeles is the next morning in UTC, more
    # than a day after the start's midnight-UTC value
    at = datetime.combine(start, time(23, 1), tzinfo=ZoneInfo("America/Los_Angeles"))
    _clock(monkeypatch, at)
    assert (await scheduler.run_learning_once(get_sessionmaker()))["reminders"] == 1


async def test_overdue_notice_once_per_day(client, db, seeded_user, monkeypatch):
    start = TODAY + timedelta(days=3)
    hdrs, move, _ = await _setup(db, client, start=start, end=start + timedelta(days=5))
    await db.execute(update(LearningAssignment).values(due_on=TODAY - timedelta(days=1)))
    await db.commit()

    now = datetime.combine(TODAY, time(12), tzinfo=UTC)
    _clock(monkeypatch, now)
    # nothing is overdue on training nobody was invited to yet
    assert (await scheduler.run_learning_once(get_sessionmaker()))["overdue"] == 0
    await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})
    first = await scheduler.run_learning_once(get_sessionmaker())
    assert first["overdue"] == 1
    assert (await scheduler.run_learning_once(get_sessionmaker()))["overdue"] == 0
    notes = list(await db.scalars(select(Notification).where(
        Notification.kind == scheduler.KIND)))
    assert len(notes) == 1
    assert notes[0].link == f"/initiatives/{move.id}?tab=learning"
    assert "1" in notes[0].title and "Move" in notes[0].title
    # the staff user isn't a learning manager
    assert notes[0].person_id != seeded_user.id

    _clock(monkeypatch, now + timedelta(days=1))
    assert (await scheduler.run_learning_once(get_sessionmaker()))["overdue"] == 1
    # nothing open → no notice
    await db.execute(update(LearningAssignment).values(status="signed"))
    await db.commit()
    _clock(monkeypatch, now + timedelta(days=2))
    assert (await scheduler.run_learning_once(get_sessionmaker()))["overdue"] == 0


@pytest.mark.parametrize("over", ["cancelled", "completed", "archived"])
async def test_sweep_leaves_over_and_archived_initiatives_alone(
        client, db, seeded_user, monkeypatch, over):
    start = TODAY + timedelta(days=14)
    hdrs, move, _ = await _setup(db, client, start=start, end=start + timedelta(days=5))
    resp = await client.put(f"/learning/initiatives/{move.id}/schedule", headers=hdrs, json={
        "mode": "scheduled", "send_offset_days": 7, "send_time": "08:00",
        "reminder_offsets": [5, 3], "due_offset_days": 2, "late_adds": True})
    assert resp.status_code == 200, resp.text
    # a second move, sent by hand, owed a reminder and overdue
    hdrs, sent, _ = await _setup(db, client, start=start, end=start + timedelta(days=5))
    await client.post(f"/learning/initiatives/{sent.id}/send", headers=hdrs, json={})
    await db.execute(update(LearningAssignment).values(due_on=TODAY - timedelta(days=1)))
    for target in (move, sent):
        values = ({"archived_at": datetime.now(UTC)} if over == "archived"
                  else {"status": over})
        await db.execute(update(Initiative).where(Initiative.id == target.id).values(**values))
    await db.commit()
    before = len(await _outbox(db))
    # past the scheduled send and the r5 reminder; the assignments are overdue
    _clock(monkeypatch, datetime.combine(start - timedelta(days=5), time(9), tzinfo=UTC))
    out = await scheduler.run_learning_once(get_sessionmaker())
    assert out == {"invites": 0, "reminders": 0, "overdue": 0, "errors": 0}
    assert len(await _outbox(db)) == before
    assert list(await db.scalars(select(Notification).where(
        Notification.kind == scheduler.KIND))) == []
    # the per-initiative steps check again on their own
    async with get_sessionmaker()() as fresh:
        now = datetime.combine(start - timedelta(days=5), time(9), tzinfo=UTC)
        assert await scheduler._scheduled_one(fresh, move.id, now) == 0
        assert await scheduler._reminders_one(fresh, sent.id, now) == 0
        assert await scheduler._overdue_one(fresh, sent.id, now) == 0


async def test_sweep_survives_an_initiative_error(client, db, seeded_user, monkeypatch,
                                                  caplog):
    start = TODAY + timedelta(days=3)
    await _setup(db, client, start=start)
    await db.execute(update(LearningAssignment).values(due_on=TODAY - timedelta(days=1)))
    await db.commit()

    async def boom(*a, **kw):
        raise RuntimeError("db blip")

    monkeypatch.setattr(scheduler, "_overdue_one", boom)
    caplog.set_level(logging.WARNING, logger="serversherpa.learning.scheduler")
    for _ in range(2):
        out = await scheduler.run_learning_once(get_sessionmaker())
        assert out["overdue"] == 0 and out["errors"] == 1
    # once per outage, the class only (a DB error's text can carry parameters)
    assert caplog.text.count("overdue notice failed") == 1
    assert "RuntimeError" in caplog.text and "db blip" not in caplog.text


async def test_scheduled_send_time_follows_dst(db):
    """America/Chicago leaves daylight time on 2026-11-01: 08:00 local is
    13:00 UTC the week before and 14:00 UTC after."""
    before = await _move(db, start=date(2026, 11, 5), zone="America/Chicago")
    after = await _move(db, start=date(2026, 11, 10), zone="America/Chicago")
    for move in (before, after):
        db.add(LearningInviteSchedule(initiative_id=move.id, mode="scheduled",
                                      send_offset_days=7, send_time=time(8, 0)))
    await db.commit()
    schedule = await db.get(LearningInviteSchedule, before.id)
    assert (await invites.send_at(db, before, schedule)).astimezone(UTC) == datetime(
        2026, 10, 29, 13, 0, tzinfo=UTC)
    schedule = await db.get(LearningInviteSchedule, after.id)
    assert (await invites.send_at(db, after, schedule)).astimezone(UTC) == datetime(
        2026, 11, 3, 14, 0, tzinfo=UTC)
    markers = await invites.send_markers(db, [before, after])
    assert markers[before.id].astimezone(UTC).hour == 13
    assert markers[after.id].astimezone(UTC).hour == 14


# ── the manager API ──────────────────────────────────────────────────


async def test_roster_statuses(client, db, seeded_user):
    start = TODAY + timedelta(days=10)
    hdrs = await _manager(db, client)
    docs = [await _doc(db, "Site safety"), await _doc(db, "Dress code")]
    await _packet(db, docs)
    move = await _move(db, start=start)
    names = ["Cathy", "Ivan", "Olga", "Nora", "Ned"]
    people = {}
    for name in names:
        email = None if name == "Ned" else f"{name.lower()}@test.example.com"
        people[name] = await _worker(db, name, "Tester", email)
        await _add(db, client, hdrs, move, people[name])
    now = datetime.now(UTC)

    def where(name):
        return LearningAssignment.person_id == people[name].id

    await db.execute(update(LearningAssignment).where(where("Cathy"))
                     .values(status="signed", opened_at=now, signed_at=now))
    first = (await db.scalars(select(LearningAssignment).where(where("Ivan"))
                              .order_by(LearningAssignment.created_at))).first()
    first.status, first.opened_at = "opened", now
    await db.execute(update(LearningAssignment).where(where("Olga"))
                     .values(due_on=TODAY - timedelta(days=1)))
    await db.commit()

    resp = await client.get(f"/learning/initiatives/{move.id}/roster", headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = {r["name"].split()[0]: r for r in resp.json()}
    assert {k: r["status"] for k, r in rows.items()} == {
        "Cathy": "complete", "Ivan": "in_progress", "Olga": "overdue",
        "Nora": "not_opened", "Ned": "no_email"}
    assert (rows["Cathy"]["done"], rows["Cathy"]["total"]) == (2, 2)
    assert (rows["Ivan"]["done"], rows["Ivan"]["total"]) == (0, 2)
    assert rows["Nora"]["email"] == "nora@test.example.com" and rows["Ned"]["email"] is None
    assert rows["Cathy"]["last_activity"] is not None and rows["Nora"]["last_activity"] is None
    assert rows["Nora"]["language"] == "en"

    resp = await client.get(f"/learning/initiatives/{move.id}/roster?status=overdue",
                            headers=hdrs)
    assert [r["name"] for r in resp.json()] == ["Olga Tester"]

    resp = await client.get(f"/learning/initiatives/{move.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["stats"] == {"invited": 0, "opened": 2, "in_progress": 1, "complete": 1,
                             "overdue": 1}
    assert body["schedule"]["mode"] == "manual" and body["schedule"]["sent_at"] is None
    assert body["schedule"]["reminder_offsets"] == [5, 3]
    assert [p["packet"]["name"] for p in body["packets"]] == ["Standard onboarding"]
    assert body["packets"][0]["rule_name"] == "Standard onboarding"
    assert body["packets"][0]["every_initiative"] is False
    assert body["extras"] == []
    kinds = [t["kind"] for t in body["timeline"]]
    assert kinds == ["invite", "reminder", "reminder", "due", "start"]

    # staff may look (learning:view) but not change the schedule or send
    staff = await login(client)
    assert (await client.get(f"/learning/initiatives/{move.id}/roster",
                             headers=staff)).status_code == 200
    assert (await client.put(f"/learning/initiatives/{move.id}/schedule", headers=staff,
                             json={"mode": "scheduled"})).status_code == 403
    assert (await client.post(f"/learning/initiatives/{move.id}/send", headers=staff,
                              json={})).status_code == 403


async def test_roster_and_sends_agree_on_a_disabled_account(client, db, seeded_user):
    """The roster's email is the address a send would use: a person whose
    only email is a disabled login's is "no email" on both."""
    from serversherpa.db.models import UserAccount

    start = TODAY + timedelta(days=10)
    hdrs, move, _ = await _setup(db, client, start=start, people=0)
    dana = await _worker(db, "Dana", "Disabled", None)
    db.add(UserAccount(person_id=dana.id, email="dana@test.example.com",
                       disabled_at=datetime.now(UTC)))
    await db.commit()
    await _add(db, client, hdrs, move, dana)
    [row] = (await client.get(f"/learning/initiatives/{move.id}/roster", headers=hdrs)).json()
    assert row["email"] is None and row["status"] == "no_email"
    sent = (await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs,
                              json={})).json()
    assert sent["no_email"] == 1 and sent["sent"] == 0


async def test_schedule_put_validates_and_marks_the_timeline(client, db, seeded_user):
    start = TODAY + timedelta(days=14)
    hdrs, move, _ = await _setup(db, client, start=start, people=0)
    for bad in ({"send_time": "8am"}, {"reminder_offsets": [3, 3]},
                {"send_offset_days": 0}, {"mode": "sometimes"}, {"late_adds": None}):
        resp = await client.put(f"/learning/initiatives/{move.id}/schedule", headers=hdrs,
                                json=bad)
        assert resp.status_code == 422, bad

    resp = await client.get("/initiatives", headers=hdrs)
    [item] = [i for i in resp.json() if i["id"] == str(move.id)]
    assert item["learning_send_at"] is None

    resp = await client.put(f"/learning/initiatives/{move.id}/schedule", headers=hdrs,
                            json={"mode": "scheduled", "send_time": "09:30"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["send_time"] == "09:30" and resp.json()["send_offset_days"] == 7
    expected = datetime.combine(start - timedelta(days=7), time(9, 30), tzinfo=UTC)
    resp = await client.get("/initiatives", headers=hdrs)
    [item] = [i for i in resp.json() if i["id"] == str(move.id)]
    assert datetime.fromisoformat(item["learning_send_at"]) == expected
    resp = await client.get(f"/initiatives/{move.id}", headers=hdrs)
    assert datetime.fromisoformat(resp.json()["learning_send_at"]) == expected


async def test_regenerate_revokes_old_code(client, db, seeded_user):
    start = TODAY + timedelta(days=14)
    hdrs, move, [worker] = await _setup(db, client, start=start)
    await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})
    [old] = list(await db.scalars(select(LearningCode).where(
        LearningCode.person_id == worker.id)))

    resp = await client.post(
        f"/learning/initiatives/{move.id}/people/{worker.id}/regenerate", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"sent": True}
    codes = list(await db.scalars(select(LearningCode).where(
        LearningCode.person_id == worker.id).execution_options(populate_existing=True)))
    assert len(codes) == 2
    assert {c.id for c in codes if c.revoked_at is None} != {old.id}
    assert len([c for c in codes if c.revoked_at is None]) == 1
    assert len(await _outbox(db, "learning_invite")) == 2

    resp = await client.post(
        f"/learning/initiatives/{move.id}/people/{worker.id}/revoke", headers=hdrs)
    assert resp.status_code == 200 and resp.json() == {"revoked": 1}
    assert await db.scalar(select(LearningCode).where(
        LearningCode.person_id == worker.id, LearningCode.revoked_at.is_(None))
        .execution_options(populate_existing=True)) is None

    # someone not on the initiative
    stranger = await _worker(db, "Sam", "Stranger", "sam@test.example.com")
    resp = await client.post(
        f"/learning/initiatives/{move.id}/people/{stranger.id}/regenerate", headers=hdrs)
    assert resp.status_code == 404


async def test_manual_reminder_keeps_codes_and_sessions(client, db, seeded_user,
                                                       monkeypatch):
    from serversherpa.learning import sessions
    from serversherpa.learning.models import LearningSession

    start = TODAY + timedelta(days=14)
    hdrs, move, workers = await _setup(db, client, start=start, people=3)
    sent, done, nocode = workers
    await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})
    ned = await _worker(db, "Ned", "Nomail", None)
    await _add(db, client, hdrs, move, ned)
    await db.execute(update(LearningAssignment)
                     .where(LearningAssignment.person_id == done.id)
                     .values(status="signed", signed_at=datetime.now(UTC)))
    await db.execute(update(LearningCode).where(LearningCode.person_id == nocode.id)
                     .values(revoked_at=datetime.now(UTC)))
    code = await db.scalar(select(LearningCode).where(LearningCode.person_id == sent.id))
    old_link = code.link_token_hash
    raw = await sessions.start(db, code=code, person_id=sent.id, ip=None, user_agent=None)
    await db.commit()
    codes_before = await db.scalar(select(func.count()).select_from(LearningCode))
    invites_before = len(await _outbox(db, "learning_invite"))

    resp = await client.post(f"/learning/initiatives/{move.id}/remind", headers=hdrs, json={})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"sent": 1, "no_email": 1, "no_code": 1, "skipped_complete": 0}
    [mail] = await _outbox(db, "learning_reminder")
    assert mail.person_id == sent.id
    # no code issued or revoked, no invite, the learn session still works
    assert await db.scalar(select(func.count()).select_from(LearningCode)) == codes_before
    assert len(await _outbox(db, "learning_invite")) == invites_before
    await db.refresh(code)
    assert code.revoked_at is None and code.link_token_hash != old_link
    assert await sessions.find(db, raw) is not None
    assert await db.scalar(select(func.count()).select_from(LearningSession).where(
        LearningSession.revoked_at.is_not(None))) == 0
    [log] = list(await db.scalars(select(LearningEmailLog).where(
        LearningEmailLog.kind == "reminder")))
    assert log.stage.startswith("manual:")

    # listed people only; a double submit in the same minute sends once
    frozen = (datetime.now(UTC) + timedelta(minutes=2)).replace(second=30)
    monkeypatch.setattr(invites, "_now", lambda: frozen)
    body = {"person_ids": [str(sent.id), str(done.id)]}
    first = await client.post(f"/learning/initiatives/{move.id}/remind", headers=hdrs,
                              json=body)
    assert first.json() == {"sent": 1, "no_email": 0, "no_code": 0, "skipped_complete": 1}
    again = await client.post(f"/learning/initiatives/{move.id}/remind", headers=hdrs,
                              json=body)
    assert again.json()["sent"] == 0

    # view-only managers can't send
    viewer = await _make(db, client, "staff", f"st-{uuid.uuid4().hex[:8]}@test.example.com")
    resp = await client.post(f"/learning/initiatives/{move.id}/remind", headers=viewer,
                             json={})
    assert resp.status_code == 403


async def test_moving_the_end_day_moves_code_expiry(client, db, seeded_user):
    start = TODAY + timedelta(days=14)
    end = start + timedelta(days=3)
    hdrs, move, [worker] = await _setup(db, client, start=start, zone="Asia/Tokyo", end=end)
    await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})

    async def expiry():
        return await db.scalar(select(LearningCode.expires_at).where(
            LearningCode.person_id == worker.id, LearningCode.revoked_at.is_(None))
            .execution_options(populate_existing=True))

    assert await expiry() == datetime.combine(end, time(23, 59), tzinfo=TOKYO)
    later = end + timedelta(days=10)
    resp = await client.patch(f"/initiatives/{move.id}", headers=hdrs,
                              json={"scheduled_end": _midnight(later).isoformat()})
    assert resp.status_code == 200, resp.text
    assert await expiry() == datetime.combine(later, time(23, 59), tzinfo=TOKYO)
    # an edit that leaves the dates alone leaves the codes alone
    resp = await client.patch(f"/initiatives/{move.id}", headers=hdrs,
                              json={"description": "Updated"})
    assert resp.status_code == 200, resp.text
    assert await expiry() == datetime.combine(later, time(23, 59), tzinfo=TOKYO)


async def test_code_sheet_pdf_returns_pdf(client, db, seeded_user):
    pytest.importorskip("weasyprint")
    start = TODAY + timedelta(days=14)
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Site safety")
    await _packet(db, [doc])
    move = await _move(db, start=start)
    ned = await _worker(db, "Ned", "Nomail", None)
    wanda = await _worker(db, "Wanda", "Worker", "wanda@test.example.com")
    for person in (ned, wanda):
        await _add(db, client, hdrs, move, person)

    # a GET never issues codes (it would revoke them as a side effect)
    resp = await client.get(f"/learning/initiatives/{move.id}/code-sheet.pdf", headers=hdrs)
    assert resp.status_code == 405
    assert list(await db.scalars(select(LearningCode.person_id))) == []
    resp = await client.post(f"/learning/initiatives/{move.id}/code-sheet.pdf", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.content.startswith(b"%PDF")
    issued = list(await db.scalars(select(LearningCode.person_id)))
    assert issued == [ned.id]

    resp = await client.post(f"/learning/initiatives/{move.id}/code-sheet.pdf?all=1",
                             headers=hdrs)
    assert resp.status_code == 200
    rows = list(await db.scalars(select(LearningCode).execution_options(
        populate_existing=True)))
    active = {r.person_id for r in rows if r.revoked_at is None}
    assert active == {ned.id, wanda.id} and len(rows) == 3


def test_sheet_html_lists_codes_and_the_replace_note():
    from serversherpa.learning import invites

    html = invites.code_sheet_html("Acme move", [("Ned Nomail", "K7QM2X")],
                                   learn_origin="https://learn.example.com")
    assert "Ned Nomail" in html and "K7Q M2X" in html
    assert "replace earlier ones" in html
