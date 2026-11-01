"""The delivery log API, super admin and above: GET /notifications/log (the
decisions notify(), enqueue() and delivery recorded), GET /notifications/check
(what would happen right now for one person and one notification kind,
writing nothing) and GET /notifications/kinds (the check's picker). Log rows
are seeded with record(); the check runs against real groups and prefs.

Spec: docs/superpowers/specs/2026-10-31-notifications-phase0-design.md (section 9)"""

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
    PermissionOverride,
    Person,
    Role,
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


async def _group(db, person, *, categories=("reports",), **over):
    g = NotificationGroup(name=f"g-{uuid4().hex[:8]}", categories=list(categories),
                          timezone="UTC", **over)
    db.add(g)
    await db.flush()
    db.add(NotificationGroupMember(group_id=g.id, person_id=person.id))
    await db.flush()
    return g


def _prefs(**cats):
    return {"notif": {"categories": cats}}


def _quiet_now():
    """UTC quiet hours around the current time, and the instant they end."""
    now = datetime.now(UTC)
    window = {"quiet_start": time((now.hour - 1) % 24), "quiet_end": time((now.hour + 2) % 24)}
    return window, now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=2)


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
    await _group(db, pat)
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


async def test_check_explains_without_writing(client, db, email_on):
    hdrs = await _super_admin(db, client)
    pat = await _person(db)
    await _group(db, pat)
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
    quiet, quiet_end = _quiet_now()

    # a subscribed group that is open now
    open_person = await _person(db, "Olive")
    open_group = await _group(db, open_person)
    # quiet hours that defer
    held_person = await _person(db, "Hank")
    held_group = await _group(db, held_person, dnd_behavior="defer", **quiet)
    # no group at all
    lone = await _person(db, "Lena")
    # the category turned off
    off = await _person(db, "Otto", prefs=_prefs(reports="off"))
    await _group(db, off)
    # a paused group and one that does not cover the category
    member = await _person(db, "Mira")
    paused = await _group(db, member, enabled=False)
    other = await _group(db, member, categories=("wiki",))
    # an owner's own security notice
    owner = await _person(db, "Owen", account_email="owen.login@test.example.com")
    # an admin copy of an urgent kind, in quiet hours with urgent bypass
    admin_copy = await _person(db, "Ada")
    bypass = await _group(db, admin_copy, categories=("security",), dnd_behavior="skip",
                          urgent_bypass=True, **quiet)
    # a kind that is never emailed, with its category off
    reset = await _person(db, "Rhea", prefs=_prefs(approvals="off"))
    await db.commit()

    body = await _check(client, hdrs, open_person)
    assert (body["outcome"], body["reason"], body["inbox"]) == ("now", None, "written")
    assert (body["person_id"], body["person_name"]) == (str(open_person.id), "Olive Tester")
    assert (body["kind"], body["kind_label"], body["category"]) == (
        "report_ready", "Report ready", "reports")
    assert (body["email_source"], body["owner_copy"], body["choice"]) == ("groups", False, "email")
    assert (body["active"], body["has_account"], body["email_enabled"]) == (True, False, True)
    assert (body["address"], body["address_source"]) == ("olive@test.example.com", "contact")
    assert body["send_at"] is not None
    [g] = body["groups"]
    assert (g["group_id"], g["name"], g["verdict"]) == (str(open_group.id), open_group.name, "open")
    assert (g["enabled"], g["subscribed"], g["email_channel"]) == (True, True, True)
    assert g["allowed_at"] == body["send_at"]
    assert (g["timezone"], g["quiet_start"], g["quiet_end"]) == ("UTC", None, None)
    assert g["active_days"] == ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

    body = await _check(client, hdrs, held_person)
    assert (body["outcome"], body["reason"]) == ("held", "quiet_hours")
    assert datetime.fromisoformat(body["send_at"]) == quiet_end
    [g] = body["groups"]
    assert (g["group_id"], g["verdict"]) == (str(held_group.id), "quiet_hours")
    assert datetime.fromisoformat(g["allowed_at"]) == quiet_end
    assert g["quiet_start"] == quiet["quiet_start"].isoformat()
    assert g["quiet_end"] == quiet["quiet_end"].isoformat()

    body = await _check(client, hdrs, lone)
    assert (body["outcome"], body["reason"], body["groups"]) == ("not_sent", "no_email_group", [])
    assert body["send_at"] is None

    body = await _check(client, hdrs, off)
    assert (body["inbox"], body["choice"]) == ("suppressed", "off")
    assert (body["outcome"], body["reason"]) == ("not_sent", "category_off")
    assert body["has_account"] is True

    body = await _check(client, hdrs, member)
    assert (body["outcome"], body["reason"]) == ("not_sent", "no_email_group")
    verdicts = {g["group_id"]: (g["verdict"], g["enabled"], g["subscribed"], g["allowed_at"])
                for g in body["groups"]}
    assert verdicts == {str(paused.id): ("paused", False, True, None),
                        str(other.id): ("not_subscribed", True, False, None)}

    body = await _check(client, hdrs, owner, "password_expiring")
    assert (body["outcome"], body["owner_copy"], body["email_source"]) == ("now", True, "always")
    assert (body["address"], body["address_source"]) == ("owen.login@test.example.com", "login")
    assert body["category"] == "security" and body["choice"] == "email"

    body = await _check(client, hdrs, admin_copy, "totp_enrolled", owner_copy="false")
    assert (body["outcome"], body["owner_copy"]) == ("now", False)
    [g] = body["groups"]
    assert (g["group_id"], g["verdict"]) == (str(bypass.id), "urgent_bypass")

    body = await _check(client, hdrs, reset, "password_reset_request")
    assert (body["inbox"], body["choice"]) == ("written", "off")
    assert (body["outcome"], body["reason"]) == ("not_sent", "kind_not_emailed")

    resp = await client.get(CHECK, params={"person_id": str(open_person.id), "kind": "nope"},
                            headers=hdrs)
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_kind"
    resp = await client.get(CHECK, params={"person_id": str(uuid4()), "kind": "report_ready"},
                            headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "person_not_found"


async def test_check_names_an_inactive_recipient(client, db, email_on):
    hdrs = await _super_admin(db, client)
    gone = await _person(db, "Gale")
    gone.archived_at = datetime.now(UTC)
    await _group(db, gone)
    await db.commit()
    body = await _check(client, hdrs, gone)
    assert (body["active"], body["outcome"], body["reason"]) == (
        False, "not_sent", "recipient_inactive")


# ── GET /notifications/kinds ────────────────────────────────────────

async def test_kinds_lists_the_registry(client, db):
    hdrs = await _super_admin(db, client)
    resp = await client.get(KINDS_PATH, headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == [
        {"kind": kind, "label": info.label, "category": info.category, "email": info.email,
         "owner_always": info.owner_always, "urgent": info.urgent}
        for kind, info in KINDS.items()]

    admin = await _make(db, client, "admin", "admin@test.example.com")
    resp = await client.get(KINDS_PATH, headers=admin)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"
