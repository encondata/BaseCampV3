"""API routes for notification-group self-service (/auth/me/notification-groups)
and membership-request approval (/notifications/requests). Task 1's service
(notifications/requests.py) is exercised at the service layer already —
this file is HTTP-level: shapes, status codes, error-code mapping, and the
approver fan-out / decision side effects end to end."""

import uuid

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog, Notification, NotificationGroup, NotificationGroupMember,
    NotificationMembershipRequest, Person, PersonRole, UserAccount,
)
from serversherpa.security.passwords import hash_password
from tests.test_access_roles_api import login_admin

PW = "CorrectHorse9!"


async def _person(db, role=None, *, first="Terry", last="Tech", email=None,
                   with_account=False):
    """A person, optionally with a UserAccount and/or a PersonRole grant.
    Mirrors test_notification_requests_service.py's helper."""
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


async def _group(db, name="On-call", *, enabled=True, description=""):
    g = NotificationGroup(name=name, enabled=enabled, description=description)
    db.add(g)
    await db.commit()
    return g


async def _login_alice(client):
    """alice (seeded_user) as a plain staff user — no role upgrade — used
    as the requester so approval tests don't conflate requester/approver."""
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": PW})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _login(client, person):
    resp = await client.post("/auth/login", json={
        "email": person.email, "password": PW})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


# ── GET /auth/me/notification-groups ──────────────────────────────────

async def test_list_shows_member_and_non_member_shape(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    mine = await _group(db, "On-call")
    db.add(NotificationGroupMember(group_id=mine.id, person_id=seeded_user.id,
                                   channels=["email"]))
    theirs = await _group(db, "Escalations")
    await db.commit()

    resp = await client.get("/auth/me/notification-groups", headers=hdrs)
    assert resp.status_code == 200, resp.text
    items = resp.json()
    names = [i["name"] for i in items]
    assert names == sorted(names)  # name asc
    by_name = {i["name"]: i for i in items}

    mine_out = by_name["On-call"]
    assert mine_out["is_member"] is True
    assert mine_out["member_count"] == 1
    assert mine_out["overrides"]["channels"] == ["email"]
    assert mine_out["effective"]["channels"] == ["email"]
    assert mine_out["pending_request"] is None

    theirs_out = by_name["Escalations"]
    assert theirs_out["is_member"] is False
    assert theirs_out["member_count"] == 0
    assert theirs_out["overrides"] is None
    assert theirs_out["effective"] is None
    assert theirs_out["pending_request"] is None


async def test_list_includes_pending_request_summary(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    group = await _group(db, "On-call")
    req = NotificationMembershipRequest(
        group_id=group.id, person_id=seeded_user.id, action="join",
        note="please add me")
    db.add(req)
    await db.commit()

    resp = await client.get("/auth/me/notification-groups", headers=hdrs)
    item = next(i for i in resp.json() if i["name"] == "On-call")
    assert item["pending_request"] == {
        "id": str(req.id), "action": "join", "note": "please add me",
        "created_at": item["pending_request"]["created_at"],
    }


async def test_list_q_filters_name_and_description_case_insensitive(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _group(db, "On-call")
    await _group(db, "Ops", description="shipping ESCALATIONS")
    await db.commit()

    resp = await client.get("/auth/me/notification-groups", headers=hdrs, params={"q": "escal"})
    assert {i["name"] for i in resp.json()} == {"Ops"}

    resp = await client.get("/auth/me/notification-groups", headers=hdrs, params={"q": "on-"})
    assert {i["name"] for i in resp.json()} == {"On-call"}


async def test_list_hides_disabled_groups(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _group(db, "Active")
    await _group(db, "Retired", enabled=False)

    resp = await client.get("/auth/me/notification-groups", headers=hdrs)
    assert {i["name"] for i in resp.json()} == {"Active"}


async def test_worker_can_call_my_notification_groups(client, db, seeded_user):
    worker = await _person(db, "worker", with_account=True)
    hdrs = await _login(client, worker)

    resp = await client.get("/auth/me/notification-groups", headers=hdrs)
    assert resp.status_code == 200


# ── PATCH /auth/me/notification-groups/{group_id}/overrides ──────────

async def test_patch_overrides_applies_and_returns_my_group(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    group = await _group(db, "On-call")
    db.add(NotificationGroupMember(group_id=group.id, person_id=seeded_user.id))
    await db.commit()

    resp = await client.patch(
        f"/auth/me/notification-groups/{group.id}/overrides", headers=hdrs,
        json={"quiet_mode": "custom", "quiet_start": "22:00:00",
              "quiet_end": "07:00:00"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["overrides"]["quiet_mode"] == "custom"
    assert body["overrides"]["quiet_start"] == "22:00:00"
    assert body["effective"]["quiet_start"] == "22:00:00"
    assert body["effective"]["quiet_end"] == "07:00:00"

    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "notification_group",
        AuditLog.action == "member.self_override"))
    assert row is not None and row.entity_id == str(group.id)


async def test_patch_overrides_invalid_quiet_hours_422(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    group = await _group(db, "On-call")
    db.add(NotificationGroupMember(group_id=group.id, person_id=seeded_user.id))
    await db.commit()

    resp = await client.patch(
        f"/auth/me/notification-groups/{group.id}/overrides", headers=hdrs,
        json={"quiet_mode": "custom", "quiet_start": "22:00:00",
              "quiet_end": "22:00:00"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_quiet_hours"


async def test_patch_overrides_non_member_404(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    group = await _group(db, "On-call")

    resp = await client.patch(
        f"/auth/me/notification-groups/{group.id}/overrides", headers=hdrs,
        json={"quiet_mode": "none"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_a_member"


# ── POST /auth/me/notification-groups/{group_id}/requests ────────────

async def test_create_request_join_already_member_409(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    group = await _group(db, "On-call")
    db.add(NotificationGroupMember(group_id=group.id, person_id=seeded_user.id))
    await db.commit()

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=hdrs,
        json={"action": "join"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "already_member"


async def test_create_request_leave_not_a_member_409(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    group = await _group(db, "On-call")

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=hdrs,
        json={"action": "leave"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "not_a_member"


async def test_create_request_duplicate_pending_409(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    group = await _group(db, "On-call")

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=hdrs,
        json={"action": "join", "note": "first"})
    assert resp.status_code == 201, resp.text

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=hdrs,
        json={"action": "join", "note": "second"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "request_pending"


async def test_create_request_disabled_group_404(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    group = await _group(db, "Retired", enabled=False)

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=hdrs,
        json={"action": "join"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "group_not_found"


async def test_create_request_extra_field_forbidden_422(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    group = await _group(db, "On-call")

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=hdrs,
        json={"action": "join", "bogus": True})
    assert resp.status_code == 422


async def test_create_request_notifies_approvers_only_over_http(client, db, seeded_user):
    # alice (seeded_user), a plain staff user, is the requester
    hdrs = await _login_alice(client)
    admin = await _person(db, "admin", first="Ann", last="Admin", with_account=True)
    worker = await _person(db, "worker", first="Wes", last="Worker", with_account=True)
    group = await _group(db, "On-call")

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=hdrs,
        json={"action": "join", "note": "please add me"})
    assert resp.status_code == 201, resp.text
    req_id = resp.json()["id"]

    notes = (await db.execute(select(Notification).where(
        Notification.kind == "membership_request"))).scalars().all()
    recipients = {n.person_id for n in notes}
    assert recipients == {admin.id}
    assert worker.id not in recipients
    assert seeded_user.id not in recipients

    n = notes[0]
    assert n.title == "Alice Anderson asks to join On-call"
    assert n.payload == {
        "request_id": req_id, "group_id": str(group.id), "group_name": "On-call",
        "person_id": str(seeded_user.id), "person_name": "Alice Anderson",
        "action": "join", "state": "pending",
    }


# ── DELETE /auth/me/notification-groups/requests/{request_id} ────────

async def test_cancel_my_request_204_and_resolves_copies(client, db, seeded_user):
    hdrs = await _login_alice(client)
    await _person(db, "admin", first="Ann", last="Admin", with_account=True)
    group = await _group(db, "On-call")

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=hdrs,
        json={"action": "join"})
    req_id = resp.json()["id"]

    resp = await client.delete(
        f"/auth/me/notification-groups/requests/{req_id}", headers=hdrs)
    assert resp.status_code == 204

    row = await db.get(NotificationMembershipRequest, uuid.UUID(req_id))
    assert row.status == "cancelled"

    copy = await db.scalar(select(Notification).where(
        Notification.kind == "membership_request"))
    assert copy.payload["state"] == "cancelled"


async def test_cancel_my_request_not_found_404(client, db, seeded_user):
    hdrs = await _login_alice(client)

    resp = await client.delete(
        f"/auth/me/notification-groups/requests/{uuid.uuid4()}", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "request_not_found"


async def test_cancel_someone_elses_request_not_found_404(client, db, seeded_user):
    other = await _person(db, "staff", first="Oli", last="Other", with_account=True)
    other_hdrs = await _login(client, other)
    group = await _group(db, "On-call")

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=other_hdrs,
        json={"action": "join"})
    req_id = resp.json()["id"]

    alice_hdrs = await _login_alice(client)
    resp = await client.delete(
        f"/auth/me/notification-groups/requests/{req_id}", headers=alice_hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "request_not_found"


# ── /notifications/requests (gated notifications:change) ─────────────

async def test_approve_join_over_http_adds_membership_and_notifies(client, db, seeded_user):
    req_hdrs = await _login_alice(client)
    admin = await _person(db, "admin", first="Ann", last="Admin", with_account=True)
    admin_hdrs = await _login(client, admin)
    group = await _group(db, "On-call")

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=req_hdrs,
        json={"action": "join", "note": "please"})
    req_id = resp.json()["id"]

    resp = await client.post(
        f"/notifications/requests/{req_id}/approve", headers=admin_hdrs,
        json={"note": "welcome aboard"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "approved"
    assert body["decided_by_name"] == "Ann Admin"
    assert body["person_name"] == "Alice Anderson"
    assert body["group_name"] == "On-call"
    assert body["decision_note"] == "welcome aboard"

    member = await db.get(NotificationGroupMember, (group.id, seeded_user.id))
    assert member is not None

    decision = await db.scalar(select(Notification).where(
        Notification.kind == "membership_decided"))
    assert decision.person_id == seeded_user.id
    assert decision.title == "Your request to join On-call was approved"
    assert decision.payload == {
        "request_id": req_id, "group_id": str(group.id),
        "action": "join", "status": "approved",
    }

    copy = await db.scalar(select(Notification).where(
        Notification.kind == "membership_request"))
    assert copy.payload["state"] == "approved"
    assert copy.payload["decided_by"] == "Ann Admin"


async def test_reject_leave_over_http_keeps_membership(client, db, seeded_user):
    req_hdrs = await _login_alice(client)
    admin = await _person(db, "admin", first="Ann", last="Admin", with_account=True)
    admin_hdrs = await _login(client, admin)
    group = await _group(db, "On-call")
    db.add(NotificationGroupMember(group_id=group.id, person_id=seeded_user.id))
    await db.commit()

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=req_hdrs,
        json={"action": "leave"})
    req_id = resp.json()["id"]

    resp = await client.post(
        f"/notifications/requests/{req_id}/reject", headers=admin_hdrs,
        json={"note": "not yet"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "rejected"

    member = await db.get(NotificationGroupMember, (group.id, seeded_user.id))
    assert member is not None  # leave rejected — still a member


async def test_second_decision_409_already_decided(client, db, seeded_user):
    req_hdrs = await _login_alice(client)
    admin = await _person(db, "admin", first="Ann", last="Admin", with_account=True)
    admin_hdrs = await _login(client, admin)
    group = await _group(db, "On-call")

    resp = await client.post(
        f"/auth/me/notification-groups/{group.id}/requests", headers=req_hdrs,
        json={"action": "join"})
    req_id = resp.json()["id"]

    resp = await client.post(
        f"/notifications/requests/{req_id}/approve", headers=admin_hdrs, json={})
    assert resp.status_code == 200, resp.text

    resp = await client.post(
        f"/notifications/requests/{req_id}/approve", headers=admin_hdrs, json={})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "already_decided"


async def test_decide_unknown_id_404(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.post(
        f"/notifications/requests/{uuid.uuid4()}/approve", headers=hdrs, json={})
    assert resp.status_code == 404


async def test_list_requests_default_pending_newest_first(client, db, seeded_user):
    req_hdrs = await _login_alice(client)
    admin = await _person(db, "admin", first="Ann", last="Admin", with_account=True)
    admin_hdrs = await _login(client, admin)
    g1 = await _group(db, "On-call")
    g2 = await _group(db, "Escalations")

    r1 = await client.post(f"/auth/me/notification-groups/{g1.id}/requests",
                           headers=req_hdrs, json={"action": "join"})
    r2 = await client.post(f"/auth/me/notification-groups/{g2.id}/requests",
                           headers=req_hdrs, json={"action": "join"})
    assert r1.status_code == 201 and r2.status_code == 201

    resp = await client.get("/notifications/requests", headers=admin_hdrs)
    assert resp.status_code == 200, resp.text
    items = resp.json()
    ids = [r["id"] for r in items]
    assert ids == [r2.json()["id"], r1.json()["id"]]  # newest first
    assert all(r["status"] == "pending" for r in items)
    assert {r["group_name"] for r in items} == {"On-call", "Escalations"}
    assert all(r["person_name"] == "Alice Anderson" for r in items)


async def test_list_requests_status_filter(client, db, seeded_user):
    req_hdrs = await _login_alice(client)
    admin = await _person(db, "admin", first="Ann", last="Admin", with_account=True)
    admin_hdrs = await _login(client, admin)
    group = await _group(db, "On-call")

    resp = await client.post(f"/auth/me/notification-groups/{group.id}/requests",
                             headers=req_hdrs, json={"action": "join"})
    req_id = resp.json()["id"]
    await client.post(f"/notifications/requests/{req_id}/approve",
                      headers=admin_hdrs, json={})

    resp = await client.get("/notifications/requests", headers=admin_hdrs,
                            params={"status": "approved"})
    assert resp.status_code == 200
    assert [r["id"] for r in resp.json()] == [req_id]

    resp = await client.get("/notifications/requests", headers=admin_hdrs)
    assert resp.json() == []  # default pending — none left


async def test_worker_forbidden_on_notifications_requests(client, db, seeded_user):
    worker = await _person(db, "worker", with_account=True)
    hdrs = await _login(client, worker)

    resp = await client.get("/notifications/requests", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"

    resp = await client.post(f"/notifications/requests/{uuid.uuid4()}/approve",
                             headers=hdrs, json={})
    assert resp.status_code == 403
