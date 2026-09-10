"""notifications/requests.py: the create/cancel/decide service behind the
notification-group self-service feature. approver_ids fan-out, request
lifecycle rules, and copy resolution — exercised at the service layer
(no HTTP), since the API routes land in Task 2."""

import uuid

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog, Notification, NotificationGroup, NotificationGroupMember,
    NotificationMembershipRequest, Person, PersonRole, UserAccount,
)
from serversherpa.notifications.requests import (
    RequestError, approver_ids, cancel_request, create_request, decide_request,
    is_member,
)
from serversherpa.security.passwords import hash_password

PW = "CorrectHorse9!"


async def _person(db, role=None, *, first="Terry", last="Tech", email=None,
                   with_account=False):
    """A person, optionally with a UserAccount and/or a PersonRole grant."""
    email = email or f"{first.lower()}.{last.lower()}.{uuid.uuid4().hex[:8]}@test.example.com"
    p = Person(first_name=first, last_name=last, email=email)
    db.add(p)
    await db.flush()
    if with_account:
        db.add(UserAccount(
            person_id=p.id, email=email,
            password_hash=hash_password(
                PW, pepper=get_settings().password_pepper.get_secret_value())))
    if role:
        db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    return p


async def _group(db, name="On-call", *, enabled=True):
    g = NotificationGroup(name=name, enabled=enabled)
    db.add(g)
    await db.commit()
    return g


# ── approver_ids ────────────────────────────────────────────────────

async def test_approver_ids_only_accounted_change_grantees_excluding_requester(db):
    requester = await _person(db, "staff", first="Ray", last="Requester",
                              with_account=True)
    admin = await _person(db, "admin", first="Ann", last="Admin",
                          with_account=True)
    worker = await _person(db, "worker", first="Wes", last="Worker",
                           with_account=True)
    no_account_admin = await _person(db, "admin", first="Noe", last="Account",
                                     with_account=False)

    ids = await approver_ids(db, exclude=requester.id)

    assert admin.id in ids
    assert requester.id not in ids
    assert worker.id not in ids
    assert no_account_admin.id not in ids


# ── create_request ──────────────────────────────────────────────────

async def test_create_request_join_pending_and_notifies_approvers_only(db):
    requester = await _person(db, "staff", first="Ray", last="Requester",
                              with_account=True)
    admin = await _person(db, "admin", first="Ann", last="Admin",
                          with_account=True)
    other_staff = await _person(db, "staff", first="Sam", last="Staff",
                                with_account=True)
    group = await _group(db, "On-call")

    req = await create_request(db, person=requester, group=group,
                               action="join", note="please add me")
    await db.commit()

    assert req.status == "pending"
    assert req.action == "join"
    assert req.group_id == group.id
    assert req.person_id == requester.id

    notes = (await db.execute(select(Notification).where(
        Notification.kind == "membership_request"))).scalars().all()
    assert [n.person_id for n in notes] == [admin.id]
    n = notes[0]
    assert n.title == "Ray Requester asks to join On-call"
    assert n.body == "please add me"
    assert n.link == "/system/notifications"
    assert n.payload == {
        "request_id": str(req.id), "group_id": str(group.id),
        "group_name": "On-call", "person_id": str(requester.id),
        "person_name": "Ray Requester", "action": "join", "state": "pending",
    }
    # requester and a non-approver staff person get nothing
    other_person_ids = {n.person_id for n in notes}
    assert requester.id not in other_person_ids
    assert other_staff.id not in other_person_ids

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "request.create"))
    assert audit_row is not None and audit_row.entity_id == str(group.id)


async def test_create_request_disabled_group_raises_group_not_found(db):
    requester = await _person(db, "staff", with_account=True)
    group = await _group(db, "Disabled", enabled=False)

    try:
        await create_request(db, person=requester, group=group,
                             action="join", note="")
        assert False, "expected RequestError"
    except RequestError as e:
        assert e.code == "group_not_found"
        assert e.status == 404


async def test_create_request_join_already_member_conflicts(db):
    requester = await _person(db, "staff", with_account=True)
    group = await _group(db)
    db.add(NotificationGroupMember(group_id=group.id, person_id=requester.id))
    await db.commit()

    try:
        await create_request(db, person=requester, group=group,
                             action="join", note="")
        assert False, "expected RequestError"
    except RequestError as e:
        assert e.code == "already_member"


async def test_create_request_leave_when_not_member_raises_not_a_member(db):
    requester = await _person(db, "staff", with_account=True)
    group = await _group(db)

    try:
        await create_request(db, person=requester, group=group,
                             action="leave", note="")
        assert False, "expected RequestError"
    except RequestError as e:
        assert e.code == "not_a_member"


async def test_create_request_duplicate_pending_conflicts(db):
    requester = await _person(db, "staff", with_account=True)
    group = await _group(db)
    await create_request(db, person=requester, group=group,
                         action="join", note="first")
    await db.commit()

    try:
        await create_request(db, person=requester, group=group,
                             action="join", note="second")
        assert False, "expected RequestError"
    except RequestError as e:
        assert e.code == "request_pending"


# ── cancel_request ───────────────────────────────────────────────────

async def test_cancel_request_marks_cancelled_and_resolves_copies(db):
    requester = await _person(db, "staff", first="Ray", last="Requester",
                              with_account=True)
    await _person(db, "admin", first="Ann", last="Admin", with_account=True)
    group = await _group(db)
    req = await create_request(db, person=requester, group=group,
                               action="join", note="")
    await db.commit()

    await cancel_request(db, request_id=req.id, person_id=requester.id)
    await db.commit()

    await db.refresh(req)
    assert req.status == "cancelled"

    copies = (await db.execute(select(Notification).where(
        Notification.kind == "membership_request"))).scalars().all()
    assert len(copies) == 1
    assert copies[0].payload["state"] == "cancelled"


async def test_cancel_request_wrong_person_raises_request_not_found(db):
    requester = await _person(db, "staff", with_account=True)
    intruder = await _person(db, "staff", first="Ivy", last="Intruder",
                             with_account=True)
    group = await _group(db)
    req = await create_request(db, person=requester, group=group,
                               action="join", note="")
    await db.commit()

    try:
        await cancel_request(db, request_id=req.id, person_id=intruder.id)
        assert False, "expected RequestError"
    except RequestError as e:
        assert e.code == "request_not_found"
        assert e.status == 404


# ── decide_request ───────────────────────────────────────────────────

async def test_decide_request_approve_join_adds_membership_and_notifies(db):
    requester = await _person(db, "staff", first="Ray", last="Requester",
                              with_account=True)
    admin = await _person(db, "admin", first="Ann", last="Admin",
                          with_account=True)
    group = await _group(db, "On-call")
    req = await create_request(db, person=requester, group=group,
                               action="join", note="please")
    await db.commit()

    decided = await decide_request(db, request_id=req.id, actor=admin,
                                   approve=True, note="welcome aboard")
    await db.commit()

    assert decided.status == "approved"
    assert decided.decided_by == admin.id
    assert decided.decision_note == "welcome aboard"
    assert decided.decided_at is not None
    assert await is_member(db, group.id, requester.id) is True

    decision = await db.scalar(select(Notification).where(
        Notification.kind == "membership_decided"))
    assert decision.person_id == requester.id
    assert decision.title == "Your request to join On-call was approved"
    assert decision.body == "welcome aboard"
    assert decision.link == "/me/notifications"
    assert decision.payload == {
        "request_id": str(req.id), "group_id": str(group.id),
        "action": "join", "status": "approved",
    }

    copy = await db.scalar(select(Notification).where(
        Notification.kind == "membership_request"))
    assert copy.payload["state"] == "approved"
    assert copy.payload["decided_by"] == "Ann Admin"

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "request.approve"))
    assert audit_row is not None


async def test_decide_request_reject_leave_keeps_membership(db):
    requester = await _person(db, "staff", first="Ray", last="Requester",
                              with_account=True)
    admin = await _person(db, "admin", first="Ann", last="Admin",
                          with_account=True)
    group = await _group(db)
    db.add(NotificationGroupMember(group_id=group.id, person_id=requester.id))
    await db.commit()

    req = await create_request(db, person=requester, group=group,
                               action="leave", note="")
    await db.commit()

    decided = await decide_request(db, request_id=req.id, actor=admin,
                                   approve=False, note="not yet")
    await db.commit()

    assert decided.status == "rejected"
    assert await is_member(db, group.id, requester.id) is True

    decision = await db.scalar(select(Notification).where(
        Notification.kind == "membership_decided"))
    assert decision.title == "Your request to leave On-call was rejected"
    assert decision.payload["status"] == "rejected"


async def test_decide_request_approve_leave_removes_membership(db):
    requester = await _person(db, "staff", with_account=True)
    admin = await _person(db, "admin", with_account=True)
    group = await _group(db)
    db.add(NotificationGroupMember(group_id=group.id, person_id=requester.id))
    await db.commit()

    req = await create_request(db, person=requester, group=group,
                               action="leave", note="")
    await db.commit()

    await decide_request(db, request_id=req.id, actor=admin,
                         approve=True, note="")
    await db.commit()

    assert await is_member(db, group.id, requester.id) is False


async def test_decide_request_second_decision_raises_already_decided(db):
    requester = await _person(db, "staff", with_account=True)
    admin = await _person(db, "admin", with_account=True)
    group = await _group(db)
    req = await create_request(db, person=requester, group=group,
                               action="join", note="")
    await db.commit()

    await decide_request(db, request_id=req.id, actor=admin, approve=True, note="")
    await db.commit()

    try:
        await decide_request(db, request_id=req.id, actor=admin,
                             approve=True, note="")
        assert False, "expected RequestError"
    except RequestError as e:
        assert e.code == "already_decided"


async def test_decide_request_unknown_id_raises_request_not_found(db):
    admin = await _person(db, "admin", with_account=True)
    try:
        await decide_request(db, request_id=uuid.uuid4(), actor=admin,
                             approve=True, note="")
        assert False, "expected RequestError"
    except RequestError as e:
        assert e.code == "request_not_found"
        assert e.status == 404


# ── is_member ─────────────────────────────────────────────────────────

async def test_is_member_true_and_false(db):
    person = await _person(db, "staff", with_account=True)
    group = await _group(db)
    assert await is_member(db, group.id, person.id) is False
    db.add(NotificationGroupMember(group_id=group.id, person_id=person.id))
    await db.commit()
    assert await is_member(db, group.id, person.id) is True
