"""The delivery log API, super admin and above: GET /notifications/log (the
decisions notify(), enqueue() and delivery recorded), GET /notifications/check
(what would happen right now for one person and one notification kind,
writing nothing) and GET /notifications/kinds (the check's picker). Log rows
are seeded with record(); the check runs against real prefs and company
settings.

Spec: docs/superpowers/specs/2026-10-31-notifications-phase0-design.md (section 9) and
docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (section 7)"""

from datetime import UTC, datetime, time, timedelta
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from serversherpa.access.resolver import AccessInfo
from serversherpa.api.deps import AuthContext, ensure_super_admin
from serversherpa.db.models import (
    EmailOutbox,
    Notification,
    NotificationGroup,
    NotificationGroupMember,
    NotificationLog,
    NotificationWatch,
    PermissionOverride,
    Person,
    Role,
    Site,
    SystemConfig,
    Truck,
    UserAccount,
)
from serversherpa.notifications.check import check_delivery
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import KINDS
from tests.test_status_values_write import _make

LOG, CHECK, KINDS_PATH = "/notifications/log", "/notifications/check", "/notifications/kinds"


async def _signed_in(db, client, role, email):
    """Auth headers and the person id of a fresh user holding `role`."""
    hdrs = await _make(db, client, role, email)
    return hdrs, await db.scalar(select(Person.id).where(Person.email == email))


async def _super_admin(db, client):
    hdrs, _ = await _signed_in(db, client, "super_admin", "sa@test.example.com")
    return hdrs


async def _non_global_super_admin(db, client):
    """Rank 80 without global access. A grant's scope comes from its role's
    anchor (a super_admin grant is always global), so this is a client-anchored
    rank-80 role. Today require_permission already refuses it (the
    notifications resource is visible to global anchors only); it also gets
    notifications:view directly, so ensure_super_admin's scope rule still
    refuses it if that resource is ever opened to client anchors."""
    db.add(Role(name="client_super_admin", description="test-only", rank=80,
                scope_anchor="client"))
    await db.commit()
    hdrs, person_id = await _signed_in(db, client, "client_super_admin",
                                       "client-sa@test.example.com")
    db.add(PermissionOverride(person_id=person_id, resource="notifications",
                              action="view", allow=True))
    await db.commit()
    return hdrs


async def _person(db, first="Pat", *, account_email=None, prefs=None):
    p = Person(first_name=first, last_name="Tester", email=f"{first.lower()}@test.example.com")
    db.add(p)
    await db.flush()
    if account_email or prefs is not None:
        db.add(UserAccount(person_id=p.id,
                           email=account_email or f"acct-{uuid4().hex[:8]}@test.example.com",
                           password_hash="x", ui_prefs=prefs or {}))
        await db.flush()
    return p


def _prefs(**cats):
    """ui_prefs of a person who chose, per category, "email" (follow the company
    default: no entry), "inbox" (Email off) or "off" (Inbox and Email off)."""
    own = {"inbox": {"email": False}, "off": {"inbox": False, "email": False}}
    return {"notif": {"switches": {category: own[choice] for category, choice in cats.items()
                                   if choice != "email"}}}


def _quiet_now():
    """A schedule (in UTC) whose quiet hours hold right now, and its summary
    time. The window starts an hour before the current hour and ends three
    hours after it, so the summary (an hour before it ends) is still ahead even
    when the hour turns while the test runs."""
    now = datetime.now(UTC)
    start, end = time((now.hour - 1) % 24), time((now.hour + 3) % 24)
    schedule = {"timezone": "UTC", "quiet_start": start.strftime("%H:%M"),
                "quiet_end": end.strftime("%H:%M")}
    return schedule, now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=2)


def _last_quiet_hour_now():
    """A schedule (in UTC) in the last hour of its quiet hours right now: the
    window began two hours ago and ends in half an hour, so its summary time
    (an hour before the end) has already passed, with ample margin for the
    test to run before the window ends."""
    now = datetime.now(UTC)
    start, end = now - timedelta(hours=2), now + timedelta(minutes=30)
    return {"timezone": "UTC", "quiet_start": start.strftime("%H:%M"),
            "quiet_end": end.strftime("%H:%M")}


async def _company(db, **data):
    """Save the company notification settings (defaults and/or critical kinds)."""
    db.add(SystemConfig(section="notifications", data=data))
    await db.flush()


async def _counts(db):
    return tuple([await db.scalar(select(func.count()).select_from(model))
                  for model in (Notification, EmailOutbox, NotificationLog)])


# ── access ──────────────────────────────────────────────────────────

async def test_log_requires_super_admin(client, db):
    target = Person(first_name="Tia", last_name="Target")
    db.add(target)
    await db.commit()
    admin = await _make(db, client, "admin", "admin@test.example.com")
    scoped = await _non_global_super_admin(db, client)
    super_admin = await _make(db, client, "super_admin", "sa@test.example.com")
    developer = await _make(db, client, "developer", "dev@test.example.com")
    paths = [LOG, f"{CHECK}?person_id={target.id}&kind=report_ready", KINDS_PATH]
    for path in paths:
        for hdrs in (admin, scoped):
            resp = await client.get(path, headers=hdrs)
            assert resp.status_code == 403, (path, resp.text)
            assert resp.json()["detail"] == {"code": "forbidden"}
        for hdrs in (super_admin, developer):
            resp = await client.get(path, headers=hdrs)
            assert resp.status_code == 200, (path, resp.text)


@pytest.mark.parametrize("is_global,max_rank,allowed", [
    (True, 80, True), (True, 100, True), (True, 79, False),
    (False, 80, False), (False, 100, False),
])
def test_ensure_super_admin_needs_global_access_and_rank_80(is_global, max_rank, allowed):
    actor = AuthContext(person=None, account=None, roles=[], session=None,
                        access=AccessInfo(max_rank=max_rank, is_global=is_global))
    if allowed:
        ensure_super_admin(actor)
        return
    with pytest.raises(HTTPException) as caught:
        ensure_super_admin(actor)
    assert (caught.value.status_code, caught.value.detail) == (403, {"code": "forbidden"})


# ── GET /notifications/log ──────────────────────────────────────────

async def test_log_pages_newest_first(client, db):
    hdrs = await _super_admin(db, client)
    for _ in range(5):
        record(db, "inbox_written", channel="inbox", kind="report_ready", category="reports")
    await db.commit()
    expected = list(await db.scalars(
        select(NotificationLog.id).order_by(NotificationLog.id.desc())))
    assert len(expected) == 5

    pages, cursor = [], None
    while True:
        params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        resp = await client.get(LOG, params=params, headers=hdrs)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 5
        pages.append([row["id"] for row in body["rows"]])
        cursor = body["next_cursor"]
        if cursor is None:
            break
        assert cursor == str(pages[-1][-1])
    assert [len(page) for page in pages] == [2, 2, 1]
    assert [row_id for page in pages for row_id in page] == expected

    resp = await client.get(LOG, params={"cursor": "not-an-id"}, headers=hdrs)
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_cursor"


async def test_log_filters(client, db):
    hdrs = await _super_admin(db, client)
    quinn = Person(first_name="Quinn", last_name="Query")
    rory = Person(first_name="Rory", last_name="Other", preferred_name="Ro")
    db.add_all([quinn, rory])
    await db.flush()
    note = Notification(person_id=quinn.id, kind="report_ready", title="NAP11 report is ready")
    mail = EmailOutbox(template="password_reset", to_address="rory@test.example.com",
                       person_id=rory.id, subject="Reset", html_body="h", text_body="t")
    db.add_all([note, mail])
    await db.flush()
    written = record(db, "inbox_written", channel="inbox", person_id=quinn.id,
                     notification_id=note.id, kind="report_ready", category="reports")
    queued = record(db, "email_queued", channel="email", person_id=quinn.id,
                    notification_id=note.id, kind="report_ready", category="reports")
    sent = record(db, "email_sent", channel="email", person_id=rory.id, outbox_id=mail.id,
                  kind="password_reset")
    suppressed = record(db, "inbox_suppressed", channel="inbox", person_id=rory.id,
                        kind="wiki_comment", category="wiki", reason="category_off")
    old = record(db, "email_not_queued", channel="email", person_id=quinn.id,
                 kind="report_ready", category="reports", reason="no_email_group")
    old.at = datetime.now(UTC) - timedelta(days=3)
    await db.commit()

    async def ids(**params):
        resp = await client.get(LOG, params=params, headers=hdrs)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == len(body["rows"])
        return {row["id"] for row in body["rows"]}

    assert await ids() == {written.id, queued.id, sent.id, suppressed.id, old.id}
    assert await ids(event=["inbox_written", "email_sent"]) == {written.id, sent.id}
    assert await ids(channel="email") == {queued.id, sent.id, old.id}
    assert await ids(category="reports") == {written.id, queued.id, old.id}
    assert await ids(person_id=str(rory.id)) == {sent.id, suppressed.id}
    assert await ids(notification_id=str(note.id)) == {written.id, queued.id}
    assert await ids(outbox_id=str(mail.id)) == {sent.id}
    since = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    assert await ids(since=since) == {written.id, queued.id, sent.id, suppressed.id}
    assert await ids(q="quinn") == {written.id, queued.id, old.id}       # person name
    assert await ids(q="Ro Other") == {sent.id, suppressed.id}            # as displayed
    assert await ids(q="nap11") == {written.id, queued.id}                # notification title
    assert await ids(q="password_reset") == {sent.id}                     # kind / template
    assert await ids(q="%") == set()                                       # literal, not a wildcard
    assert await ids(q=" quinn ") == {written.id, queued.id, old.id}
    assert await ids(channel="email", person_id=str(quinn.id), since=since) == {queued.id}

    resp = await client.get(LOG, params={"event": ["email_sent", "nope"]}, headers=hdrs)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_event"
    # `since` must carry its offset: a bare local time is ambiguous
    resp = await client.get(LOG, params={"since": "2026-10-30T12:00:00"}, headers=hdrs)
    assert resp.status_code == 422


async def test_log_entry_joins_names_and_address(client, db, email_on):
    hdrs = await _super_admin(db, client)
    pat = await _person(db)
    row = await notify(db, pat.id, "report_ready", "Move Report is ready",
                       body="NAP11 finished", link="/reports?run=abc")
    record(db, "email_sent", channel="email", kind="invite")     # template mail, no outbox
    await db.commit()
    mail = await db.scalar(select(EmailOutbox).where(EmailOutbox.notification_id == row.id))

    stored = await db.scalar(select(NotificationLog).where(
        NotificationLog.event == "email_queued"))

    resp = await client.get(LOG, params={"event": "email_queued"}, headers=hdrs)
    assert resp.status_code == 200, resp.text
    [entry] = resp.json()["rows"]
    assert (entry["id"], entry["event"], entry["channel"]) == (stored.id, "email_queued", "email")
    assert (entry["person_id"], entry["person_name"]) == (str(pat.id), "Pat Tester")
    assert entry["notification_id"] == str(row.id)
    assert entry["notification_title"] == "Move Report is ready"
    assert entry["notification_link"] == "/reports?run=abc"
    assert entry["outbox_id"] == str(mail.id)
    assert entry["to_address"] == "pat@test.example.com"
    assert entry["outbox_status"] == "queued"
    assert (entry["kind"], entry["kind_label"], entry["category"]) == (
        "report_ready", "Report ready", "reports")
    assert entry["detail"] == stored.detail and entry["detail"]["deferred"] is False
    assert (entry["reason"], entry["process"]) == (None, stored.process)
    assert datetime.fromisoformat(entry["at"]) == stored.at
    # the address comes from the outbox row: the log row never holds it
    assert "pat@test.example.com" not in str(stored.detail)

    resp = await client.get(LOG, params={"event": "inbox_written"}, headers=hdrs)
    [inbox] = resp.json()["rows"]
    assert inbox["notification_title"] == "Move Report is ready"
    assert inbox["to_address"] is None and inbox["outbox_status"] is None

    resp = await client.get(LOG, params={"event": "email_sent"}, headers=hdrs)
    [template] = resp.json()["rows"]
    assert (template["kind"], template["kind_label"]) == ("invite", "invite")
    assert template["person_name"] is None and template["notification_title"] is None


# ── GET /notifications/check ────────────────────────────────────────

async def _check(client, hdrs, person, kind="report_ready", **params):
    resp = await client.get(CHECK, params={"person_id": str(person.id), "kind": kind, **params},
                            headers=hdrs)
    assert resp.status_code == 200, resp.text
    return resp.json()


CHECK_KEYS = {
    "person_id", "person_name", "kind", "kind_label", "category", "owner_copy", "active",
    "has_account", "inbox", "inbox_source", "email_enabled", "critical", "switches",
    "schedule", "outcome", "after_summary", "send_at", "summary_at", "reason", "address",
    "address_source", "watches",
}
EVERY_DAY = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


async def test_check_explains_without_writing(client, db, email_on):
    hdrs = await _super_admin(db, client)
    pat = await _person(db)
    await db.commit()
    before = await _counts(db)

    assert (await _check(client, hdrs, pat))["outcome"] == "now"
    assert await _counts(db) == before
    # called directly, on this session: nothing added, nothing flushed
    result = await check_delivery(db, pat.id, "report_ready", now=datetime.now(UTC))
    assert result["outcome"] == "now"
    assert not db.new and not db.dirty
    assert await _counts(db) == before


async def test_check_outcomes(client, db, email_on):
    hdrs = await _super_admin(db, client)
    # no account: the default switches and the open schedule
    open_person = await _person(db, "Olive")
    # the category turned off
    off = await _person(db, "Otto", prefs=_prefs(reports="off"))
    # a kind that is never emailed, with its category off
    reset = await _person(db, "Rhea", prefs=_prefs(approvals="off"))
    await db.commit()

    body = await _check(client, hdrs, open_person)
    assert set(body) == CHECK_KEYS
    assert (body["outcome"], body["reason"], body["after_summary"]) == ("now", None, False)
    assert (body["inbox"], body["inbox_source"]) == ("written", "default")
    assert (body["person_id"], body["person_name"]) == (str(open_person.id), "Olive Tester")
    assert (body["kind"], body["kind_label"], body["category"]) == (
        "report_ready", "Report ready", "reports")
    assert (body["owner_copy"], body["critical"]) == (False, False)
    assert (body["active"], body["has_account"], body["email_enabled"]) == (True, False, True)
    assert (body["address"], body["address_source"]) == ("olive@test.example.com", "contact")
    assert body["send_at"] is not None and body["summary_at"] is None
    assert body["switches"] == {"inbox": {"on": True, "source": "default"},
                                "email": {"on": True, "source": "default"}}
    assert body["schedule"] == {"timezone": "America/New_York", "days": EVERY_DAY,
                                "quiet_start": None, "quiet_end": None, "state": "open"}
    assert body["watches"] is None                  # nobody can watch for Report ready

    body = await _check(client, hdrs, off)
    assert (body["inbox"], body["inbox_source"]) == ("suppressed", "own")
    assert (body["outcome"], body["reason"]) == ("not_sent", "category_off")
    assert body["switches"] == {"inbox": {"on": False, "source": "own"},
                                "email": {"on": False, "source": "own"}}
    assert body["has_account"] is True
    assert body["send_at"] is None and body["summary_at"] is None

    body = await _check(client, hdrs, reset, "password_reset_request")
    assert (body["inbox"], body["switches"]["inbox"]["on"]) == ("written", False)
    assert (body["outcome"], body["reason"]) == ("not_sent", "kind_not_emailed")

    resp = await client.get(CHECK, params={"person_id": str(open_person.id), "kind": "nope"},
                            headers=hdrs)
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_kind"
    resp = await client.get(CHECK, params={"person_id": str(uuid4()), "kind": "report_ready"},
                            headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "person_not_found"


async def test_check_lists_the_watches_that_would_hear_a_watchable_kind(client, db, email_on):
    """For Truck status changed: the person's own watch and their group's, each with what it
    is on, the events it names and whose it is. Pat has no role, so can't open either thing:
    Check delivery lists the watches all the same."""
    hdrs = await _super_admin(db, client)
    pat = await _person(db, "Pat", prefs={})
    group = NotificationGroup(name="Group A")
    site, truck = Site(name="Site A"), Truck(name="Truck A")
    db.add_all([group, site, truck])
    await db.flush()
    db.add_all([NotificationGroupMember(group_id=group.id, person_id=pat.id),
                NotificationWatch(person_id=pat.id, truck_id=truck.id,
                                  kinds=["truck_status_changed"]),
                NotificationWatch(group_id=group.id, site_id=site.id)])
    await db.commit()
    before = await _counts(db)

    body = await _check(client, hdrs, pat, "truck_status_changed")
    assert body["watches"] == [
        {"thing": "truck", "thing_id": str(truck.id), "thing_name": "Truck A",
         "kinds": ["truck_status_changed"], "via": {"type": "you", "id": None, "name": None}},
        {"thing": "site", "thing_id": str(site.id), "thing_name": "Site A", "kinds": [],
         "via": {"type": "group", "id": str(group.id), "name": "Group A"}},
    ]
    # a kind nobody can watch: null, not an empty list
    assert (await _check(client, hdrs, pat))["watches"] is None
    assert await _counts(db) == before


async def test_check_held_shows_summary_time(client, db, email_on):
    hdrs = await _super_admin(db, client)
    schedule, summary = _quiet_now()
    held = await _person(db, "Held", prefs={"notif": {"schedule": schedule}})
    await db.commit()

    body = await _check(client, hdrs, held)
    assert (body["outcome"], body["reason"], body["after_summary"]) == (
        "held", "quiet_hours", False)
    assert datetime.fromisoformat(body["summary_at"]) == summary
    assert body["send_at"] is None
    assert (body["address"], body["address_source"]) == ("held@test.example.com", "contact")
    assert body["schedule"] == {"timezone": "UTC", "days": EVERY_DAY,
                                "quiet_start": schedule["quiet_start"],
                                "quiet_end": schedule["quiet_end"], "state": "quiet_hours"}


async def test_check_last_quiet_hour_sends_now_after_the_summary(client, db, email_on):
    """In the last hour before the person is back online, that morning's
    summary has already gone: the email goes now, in quiet hours, and the
    answer says it goes after the summary."""
    hdrs = await _super_admin(db, client)
    late = await _person(db, "Late", prefs={"notif": {"schedule": _last_quiet_hour_now()}})
    await db.commit()

    body = await _check(client, hdrs, late)
    assert (body["outcome"], body["reason"], body["after_summary"]) == ("now", None, True)
    assert body["schedule"]["state"] == "quiet_hours"
    assert body["send_at"] is not None and body["summary_at"] is None
    assert (body["address"], body["address_source"]) == ("late@test.example.com", "contact")
    assert body["critical"] is False


async def test_check_switch_sources(client, db, email_on):
    hdrs = await _super_admin(db, client)
    await _company(db, defaults={"wiki": {"inbox": True, "email": False}})
    person = await _person(db, "Sources", prefs={})
    await db.commit()

    body = await _check(client, hdrs, person, "wiki_comment")
    assert body["switches"]["email"] == {"on": False, "source": "default"}
    assert body["switches"]["inbox"] == {"on": True, "source": "default"}
    assert (body["outcome"], body["reason"]) == ("not_sent", "category_inbox_only")

    account = await db.get(UserAccount, person.id)
    account.ui_prefs = {"notif": {"switches": {"wiki": {"email": True}}}}
    await db.commit()
    body = await _check(client, hdrs, person, "wiki_comment")
    assert body["switches"]["email"] == {"on": True, "source": "own"}
    assert body["outcome"] == "now"


async def test_check_owner_copy_now(client, db, email_on):
    """The owner's own security notice goes now, quiet hours or not, to the
    sign-in email."""
    hdrs = await _super_admin(db, client)
    schedule, _ = _quiet_now()
    owner = await _person(db, "Owner", account_email="owner.login@test.example.com",
                         prefs={"notif": {"schedule": schedule}})
    await db.commit()

    body = await _check(client, hdrs, owner, "password_expiring")
    assert (body["outcome"], body["reason"], body["owner_copy"]) == ("now", None, True)
    assert (body["address"], body["address_source"]) == ("owner.login@test.example.com", "login")
    assert (body["category"], body["critical"], body["inbox"]) == ("security", True, "written")
    assert body["switches"] == {"inbox": {"on": True, "source": "fixed"},
                                "email": {"on": True, "source": "fixed"}}
    assert body["schedule"]["state"] == "quiet_hours"
    assert body["send_at"] is not None and body["summary_at"] is None


async def test_check_admin_copy_not_sent(client, db, email_on):
    hdrs = await _super_admin(db, client)
    admin = await _person(db, "Admin")
    await db.commit()

    body = await _check(client, hdrs, admin, "totp_enrolled", owner_copy="false")
    assert (body["outcome"], body["reason"], body["owner_copy"]) == (
        "not_sent", "admin_copy", False)
    assert body["inbox"] == "written"
    assert body["send_at"] is None and body["summary_at"] is None


async def test_check_critical_flag(client, db, email_on):
    """A kind marked critical goes now even in quiet hours; one that is not
    waits for the summary."""
    hdrs = await _super_admin(db, client)
    await _company(db, critical_kinds=["report_failed"])
    schedule, summary = _quiet_now()
    person = await _person(db, "Critical", prefs={"notif": {"schedule": schedule}})
    await db.commit()

    body = await _check(client, hdrs, person, "report_failed")
    assert (body["critical"], body["outcome"], body["reason"]) == (True, "now", None)
    assert body["after_summary"] is False     # it goes now because it is critical
    assert body["schedule"]["state"] == "quiet_hours"
    body = await _check(client, hdrs, person, "report_ready")
    assert (body["critical"], body["outcome"]) == (False, "held")
    assert datetime.fromisoformat(body["summary_at"]) == summary


async def test_check_names_an_inactive_recipient(client, db, email_on):
    hdrs = await _super_admin(db, client)
    gone = await _person(db, "Gale")
    gone.archived_at = datetime.now(UTC)
    await db.commit()
    body = await _check(client, hdrs, gone)
    assert (body["active"], body["outcome"], body["reason"]) == (
        False, "not_sent", "recipient_inactive")


# ── GET /notifications/kinds ────────────────────────────────────────

async def test_kinds_report_critical_and_locked(client, db):
    hdrs = await _super_admin(db, client)
    await _company(db, critical_kinds=["report_failed"])
    await db.commit()
    resp = await client.get(KINDS_PATH, headers=hdrs)
    assert resp.status_code == 200, resp.text
    always = {"password_expiring", "totp_enrolled"}
    assert resp.json() == [
        {"kind": kind, "label": info.label, "category": info.category, "email": info.email,
         "owner_always": info.owner_always,
         "critical": kind in always | {"report_failed"}, "locked": kind in always,
         "watchable": info.watchable, "everywhere": info.everywhere,
         "reaches": list(info.reaches)}
        for kind, info in KINDS.items()]
    assert [k for k in resp.json() if k["critical"]] == [
        {"kind": "report_failed", "label": "Report failed", "category": "reports",
         "email": True, "owner_always": False, "critical": True, "locked": False,
         "watchable": False, "everywhere": False, "reaches": []},
        {"kind": "password_expiring", "label": "Password expiring", "category": "security",
         "email": True, "owner_always": True, "critical": True, "locked": True,
         "watchable": False, "everywhere": False, "reaches": []},
        {"kind": "totp_enrolled", "label": "Two-factor authentication enrolled",
         "category": "security", "email": True, "owner_always": True, "critical": True,
         "locked": True, "watchable": False, "everywhere": False, "reaches": []},
    ]
    # the two status changes and Device offline can be watched, on the things they reach
    assert [(k["kind"], k["watchable"], k["everywhere"], k["reaches"])
            for k in resp.json() if k["watchable"]] == [
        ("initiative_status_changed", True, True, ["initiative", "site"]),
        ("truck_status_changed", True, True, ["truck", "initiative", "site"]),
        ("device_offline", True, True, ["device", "site", "initiative"]),
    ]

    admin = await _make(db, client, "admin", "admin@test.example.com")
    resp = await client.get(KINDS_PATH, headers=admin)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"
