"""Account management: self-service password change + admin actions."""

from datetime import UTC, datetime, timedelta

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password
from tests.test_access_roles_api import login_admin

PW = "CorrectHorse9!"
NEW_PW = "NewHorse-Battery-42"


async def _login(client, email, password=PW):
    resp = await client.post("/auth/login", json={"email": email, "password": password})
    return resp


async def _headers(client, email, password=PW):
    resp = await _login(client, email, password)
    assert resp.status_code == 200
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _mk_user(db, *, first, last, email, roles=("staff",)):
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))
    for r in roles:
        db.add(PersonRole(person_id=person.id, role=r))
    await db.commit()
    return person


# ── self-service change password ───────────────────────────────────


async def test_change_password_full_flow(client, seeded_user):
    # two logins = two families; changing the password kills the other one
    other = await _headers(client, "alice@test.example.com")
    current = await _headers(client, "alice@test.example.com")

    resp = await client.post("/auth/me/password", headers=current, json={
        "current_password": PW, "new_password": NEW_PW})
    assert resp.status_code == 204

    # current session still works; the other one is dead
    assert (await client.get("/auth/me", headers=current)).status_code == 200
    assert (await client.get("/auth/me", headers=other)).status_code == 401

    # old password rejected, new one works
    assert (await _login(client, "alice@test.example.com", PW)).status_code == 401
    assert (await _login(client, "alice@test.example.com", NEW_PW)).status_code == 200


async def test_change_password_validation(client, seeded_user):
    headers = await _headers(client, "alice@test.example.com")

    resp = await client.post("/auth/me/password", headers=headers, json={
        "current_password": "wrong-password!", "new_password": NEW_PW})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "invalid_current_password"

    resp = await client.post("/auth/me/password", headers=headers, json={
        "current_password": PW, "new_password": PW})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "same_as_current"

    resp = await client.post("/auth/me/password", headers=headers, json={
        "current_password": PW, "new_password": "short"})
    assert resp.status_code == 422  # min_length


async def test_change_password_clears_must_change(client, seeded_user, db):
    from sqlalchemy import update as sa_update
    await db.execute(sa_update(UserAccount).values(must_change_password=True))
    await db.commit()

    headers = await _headers(client, "alice@test.example.com")
    await client.post("/auth/me/password", headers=headers, json={
        "current_password": PW, "new_password": NEW_PW})
    login = await _login(client, "alice@test.example.com", NEW_PW)
    assert login.json()["must_change_password"] is False


# ── admin: reset password ──────────────────────────────────────────


async def test_admin_reset_password(client, seeded_user, db):
    worker = await _mk_user(db, first="Wan", last="Worker",
                            email="wan@test.example.com", roles=("worker",))
    worker_session = await _headers(client, "wan@test.example.com")
    staff = await _headers(client, "alice@test.example.com")

    resp = await client.post(f"/users/{worker.id}/reset-password", headers=staff,
                             json={"temp_password": "TempReset-9876!", "must_change_password": True})
    assert resp.status_code == 204

    # worker's sessions are dead, old password dead, temp works + must change
    assert (await client.get("/auth/me", headers=worker_session)).status_code == 401
    assert (await _login(client, "wan@test.example.com", PW)).status_code == 401
    login = await _login(client, "wan@test.example.com", "TempReset-9876!")
    assert login.status_code == 200
    assert login.json()["must_change_password"] is True


async def test_admin_guards(client, seeded_user, db):
    admin = await _mk_user(db, first="Ada", last="Admin",
                           email="ada@test.example.com", roles=("admin",))
    staff = await _headers(client, "alice@test.example.com")

    # staff cannot reset an admin's password (rank cap: 40 can't touch 60)
    resp = await client.post(f"/users/{admin.id}/reset-password", headers=staff,
                             json={"temp_password": "TempReset-9876!"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"

    # nobody can target themselves through admin endpoints
    me = (await client.get("/auth/me/profile", headers=staff)).json()
    resp = await client.post(f"/users/{me['id']}/disable", headers=staff)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "cannot_target_self"


# ── admin: disable / enable / unlock ───────────────────────────────


async def test_disable_enable_cycle(client, seeded_user, db):
    worker = await _mk_user(db, first="Wan", last="Worker",
                            email="wan@test.example.com", roles=("worker",))
    worker_session = await _headers(client, "wan@test.example.com")
    staff = await _headers(client, "alice@test.example.com")

    assert (await client.post(f"/users/{worker.id}/disable",
                              headers=staff)).status_code == 204
    # sessions revoked and login blocked
    assert (await client.get("/auth/me", headers=worker_session)).status_code == 401
    login = await _login(client, "wan@test.example.com")
    assert login.status_code == 401
    assert login.json()["detail"]["code"] == "account_disabled"

    assert (await client.post(f"/users/{worker.id}/enable",
                              headers=staff)).status_code == 204
    assert (await _login(client, "wan@test.example.com")).status_code == 200


async def test_unlock_after_lockout(client, seeded_user, db):
    worker = await _mk_user(db, first="Wan", last="Worker",
                            email="wan@test.example.com", roles=("worker",))
    for _ in range(10):
        await _login(client, "wan@test.example.com", "wrong-password!")
    assert (await _login(client, "wan@test.example.com")).status_code == 423

    staff = await _headers(client, "alice@test.example.com")
    assert (await client.post(f"/users/{worker.id}/unlock",
                              headers=staff)).status_code == 204
    assert (await _login(client, "wan@test.example.com")).status_code == 200


# ── admin: roles ───────────────────────────────────────────────────


async def test_set_roles_diff_and_history(client, seeded_user, db):
    # set_roles now requires access:change, which plain staff lacks — use
    # an admin actor (rank 60), which comfortably outranks staff/external.
    worker = await _mk_user(db, first="Wan", last="Worker",
                            email="wan@test.example.com", roles=("worker",))
    admin = await login_admin(client, db, seeded_user)

    resp = await client.put(f"/users/{worker.id}/roles", headers=admin,
                            json={"roles": ["staff", "external"]})
    assert resp.status_code == 200
    assert resp.json() == ["external", "staff"]

    # login reflects the change; history rows preserved
    login = await _login(client, "wan@test.example.com")
    assert sorted(login.json()["roles"]) == ["external", "staff"]

    from sqlalchemy import func, select
    total = await db.scalar(select(func.count()).select_from(PersonRole)
                            .where(PersonRole.person_id == worker.id))
    assert total == 3  # worker (revoked) + staff + external


async def test_set_roles_rejects_org_scoped_roles(client, seeded_user, db):
    worker = await _mk_user(db, first="Wan", last="Worker",
                            email="wan@test.example.com", roles=("worker",))
    admin = await login_admin(client, db, seeded_user)
    resp = await client.put(f"/users/{worker.id}/roles", headers=admin,
                            json={"roles": ["worker", "vendor_admin"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "role_requires_org"


async def test_set_roles_preserves_org_anchored_grants(client, seeded_user, db):
    # A person holding a global role AND a client-anchored contact grant:
    # the legal payload for a global-role change omits the org-anchored
    # name (the endpoint 422s on it — role_requires_org), and the endpoint
    # must NOT treat that absence as a revocation of the org grant.
    # Actor is top-rank (developer) so it may grant "admin" (rank 60).
    from sqlalchemy import select, text
    from serversherpa.db.models import Client

    person = await _mk_user(db, first="Cora", last="Contact",
                            email="cora@test.example.com", roles=("staff",))
    person_id = person.id
    org = Client(name="Acme Networks")
    db.add(org)
    await db.flush()
    org_id = org.id
    db.add(PersonRole(person_id=person_id, role="client_viewer", client_id=org_id))
    await db.execute(text(
        "UPDATE person_roles SET role='developer' WHERE person_id=:p"),
        {"p": seeded_user.id})
    await db.commit()
    top = await _headers(client, "alice@test.example.com")

    resp = await client.put(f"/users/{person_id}/roles", headers=top,
                            json={"roles": ["admin"]})
    assert resp.status_code == 200
    assert resp.json() == ["admin"]

    db.expire_all()
    active = {(role, client_id) for role, client_id in (await db.execute(
        select(PersonRole.role, PersonRole.client_id)
        .where(PersonRole.person_id == person_id,
               PersonRole.revoked_at.is_(None)))).all()}
    assert ("admin", None) in active                 # new global role granted
    assert ("client_viewer", org_id) in active       # org grant untouched
    assert not any(role == "staff" for role, _ in active)  # old global revoked


async def test_staff_cannot_set_roles_at_all(client, seeded_user, db):
    # set_roles requires access:change; staff only has access:view, so the
    # permission guard rejects it before any rank logic is reached.
    worker = await _mk_user(db, first="Wan", last="Worker",
                            email="wan@test.example.com", roles=("worker",))
    staff = await _headers(client, "alice@test.example.com")
    resp = await client.put(f"/users/{worker.id}/roles", headers=staff,
                            json={"roles": ["worker", "external"]})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_admin_cannot_grant_admin_rank_too_low(client, seeded_user, db):
    # granting "admin" (rank 60) requires an actor strictly above rank 60;
    # a plain admin actor (rank 60) is capped at strictly-lower ranks, so
    # even an admin can't hand out the admin role itself.
    worker = await _mk_user(db, first="Wan", last="Worker",
                            email="wan@test.example.com", roles=("worker",))
    admin = await login_admin(client, db, seeded_user)
    resp = await client.put(f"/users/{worker.id}/roles", headers=admin,
                            json={"roles": ["worker", "admin"]})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"


# ── admin: edit profile ────────────────────────────────────────────


async def test_admin_edit_profile(client, seeded_user, db):
    worker = await _mk_user(db, first="Wan", last="Worker",
                            email="wan@test.example.com", roles=("worker",))
    staff = await _headers(client, "alice@test.example.com")
    resp = await client.patch(f"/users/{worker.id}/profile", headers=staff,
                              json={"job_title": "Splice Lead", "city": "Reno"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["job_title"] == "Splice Lead"
    assert body["city"] == "Reno"


# ── admin: demote to worker ────────────────────────────────────────

from sqlalchemy import select  # noqa: E402

from serversherpa.db.models import (  # noqa: E402
    AccessGroup, AccessGroupMember, AuditLog, Client, Notification, NotificationGroup,
    NotificationGroupMember, NotificationMembershipRequest, PasswordHistory,
    PermissionOverride, TrustedDevice,
)
from serversherpa.notifications.requests import create_request  # noqa: E402


async def _demote_audit(db, person_id):
    rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "user_account", AuditLog.entity_id == str(person_id),
        AuditLog.action == "account.demote")))
    assert len(rows) == 1
    return rows[0].changes


async def _active_roles(db, person_id):
    return sorted(await db.scalars(select(PersonRole.role).where(
        PersonRole.person_id == person_id, PersonRole.revoked_at.is_(None))))


async def test_demote_removes_login_and_every_access_but_keeps_the_person(client, seeded_user, db):
    worker = await _mk_user(db, first="Wan", last="Worker",
                            email="wan@test.example.com", roles=("worker", "staff"))
    worker_id = worker.id
    worker.rfid_tag = "E200ABCDEF"
    badge = worker.badge_uid
    account = await db.get(UserAccount, worker.id)
    account.totp_secret_enc = b"secret"
    account.totp_confirmed_at = datetime.now(UTC)
    # logged in first so the admin is an approver who gets a copy of the
    # pending request below
    admin = await login_admin(client, db, seeded_user)
    ag = AccessGroup(name="Dock crew")
    ng = NotificationGroup(name="On-call")
    night = NotificationGroup(name="Night shift")
    db.add_all([ag, ng, night])
    await db.flush()
    db.add_all([
        AccessGroupMember(group_id=ag.id, person_id=worker.id),
        NotificationGroupMember(group_id=ng.id, person_id=worker.id),
        TrustedDevice(person_id=worker.id, token_hash="t" * 64, user_agent="UA",
                      last_used_at=datetime.now(UTC),
                      expires_at=datetime.now(UTC) + timedelta(days=7)),
        PermissionOverride(person_id=worker.id, resource="assets", action="delete",
                           allow=True),
    ])
    await db.flush()
    pending = await create_request(db, person=worker, group=night, action="join", note="")
    pending_id = pending.id
    await db.commit()
    worker_session = await _headers(client, "wan@test.example.com")

    resp = await client.post(f"/users/{worker.id}/demote", headers=admin)
    assert resp.status_code == 204, resp.text

    # signed out, and there is nothing left to sign in to
    assert (await client.get("/auth/me", headers=worker_session)).status_code == 401
    login = await _login(client, "wan@test.example.com")
    assert login.status_code == 401
    assert login.json()["detail"]["code"] == "invalid_credentials"

    # ids read above, before expiring, so accessing them below doesn't
    # itself trigger a synchronous refresh of an expired instance
    db.expire_all()
    assert await db.get(UserAccount, worker_id) is None
    assert list(await db.scalars(select(PasswordHistory).where(
        PasswordHistory.person_id == worker_id))) == []
    # still a worker: the worker role survives, everything else is revoked
    assert await _active_roles(db, worker_id) == ["worker"]
    revoked = list(await db.scalars(select(PersonRole).where(
        PersonRole.person_id == worker_id, PersonRole.revoked_at.is_not(None))))
    assert {r.role for r in revoked} == {"staff"}
    assert list(await db.scalars(select(PermissionOverride).where(
        PermissionOverride.person_id == worker_id))) == []
    req = await db.get(NotificationMembershipRequest, pending_id)
    assert req.status == "cancelled"
    copies = [c for c in await db.scalars(select(Notification).where(
        Notification.kind == "membership_request"))
        if c.payload["request_id"] == str(pending_id)]
    assert copies and all(c.payload["state"] == "cancelled" for c in copies)
    assert list(await db.scalars(select(AccessGroupMember).where(
        AccessGroupMember.person_id == worker_id))) == []
    assert list(await db.scalars(select(NotificationGroupMember).where(
        NotificationGroupMember.person_id == worker_id))) == []
    assert list(await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == worker_id, TrustedDevice.revoked_at.is_(None)))) == []

    person = await db.get(Person, worker_id)
    assert person is not None and person.archived_at is None
    assert person.badge_uid == badge and person.rfid_tag == "E200ABCDEF"

    listed = (await client.get("/users", headers=admin)).json()
    assert all(u["person_id"] != str(worker_id) for u in listed)
    assert (await client.get(f"/users/{worker_id}", headers=admin)).status_code == 404
    workers = (await client.get("/workers", headers=admin)).json()
    assert any(w["person_id"] == str(worker_id) for w in workers)
    assert (await client.get(f"/workers/{worker_id}", headers=admin)).status_code == 200

    changes = await _demote_audit(db, worker_id)
    assert changes["login_email"] == "wan@test.example.com"
    assert changes["roles"] == ["staff"]
    assert changes["worker_granted"] is False
    assert changes["access_groups"] == ["Dock crew"]
    assert changes["notification_groups"] == ["On-call"]
    assert changes["overrides"] == [
        {"resource": "assets", "action": "delete", "allow": True}]
    assert changes["pending_requests_cancelled"] == 1

    # the person can be promoted again
    again = await client.post(f"/users/{worker_id}/account", headers=admin, json={
        "login_email": "wan@test.example.com", "temp_password": "Temp-pw-9999",
        "must_change_password": True})
    assert again.status_code == 201, again.text


async def test_demote_grants_worker_when_missing(client, seeded_user, db):
    user = await _mk_user(db, first="Sam", last="Staff", email="sam@test.example.com",
                          roles=("staff",))
    user_id = user.id
    admin = await login_admin(client, db, seeded_user)

    resp = await client.post(f"/users/{user_id}/demote", headers=admin)
    assert resp.status_code == 204, resp.text

    db.expire_all()
    assert await _active_roles(db, user_id) == ["worker"]
    changes = await _demote_audit(db, user_id)
    assert changes["roles"] == ["staff"]
    assert changes["worker_granted"] is True
    workers = (await client.get("/workers", headers=admin)).json()
    assert any(w["person_id"] == str(user_id) for w in workers)


async def test_demote_keeps_org_contact_roles(client, seeded_user, db):
    user = await _mk_user(db, first="Cora", last="Contact", email="cora@test.example.com",
                          roles=("staff",))
    user_id = user.id
    org = Client(name="Contact Org")
    db.add(org)
    await db.flush()
    db.add(PersonRole(person_id=user_id, role="client_viewer", client_id=org.id))
    await db.commit()
    admin = await login_admin(client, db, seeded_user)

    resp = await client.post(f"/users/{user_id}/demote", headers=admin)
    assert resp.status_code == 204, resp.text

    db.expire_all()
    assert await _active_roles(db, user_id) == ["client_viewer", "worker"]
    revoked = set(await db.scalars(select(PersonRole.role).where(
        PersonRole.person_id == user_id, PersonRole.revoked_at.is_not(None))))
    assert revoked == {"staff"}
    changes = await _demote_audit(db, user_id)
    assert changes["roles"] == ["staff"]
    assert changes["worker_granted"] is True


async def test_demote_refusals(client, seeded_user, db):
    staff = await _headers(client, "alice@test.example.com")
    me = (await client.get("/auth/me", headers=staff)).json()["person"]
    resp = await client.post(f"/users/{me['id']}/demote", headers=staff)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "cannot_target_self"

    contact = Person(first_name="No", last_name="Login", email="nologin@test.example.com")
    db.add(contact)
    await db.commit()
    assert (await client.post(f"/users/{contact.id}/demote", headers=staff)).status_code == 404

    boss = await _mk_user(db, first="Big", last="Boss", email="boss@test.example.com",
                          roles=("admin",))
    resp = await client.post(f"/users/{boss.id}/demote", headers=staff)
    assert resp.status_code == 403
