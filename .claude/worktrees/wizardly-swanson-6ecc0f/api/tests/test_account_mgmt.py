"""Account management: self-service password change + admin actions."""

from datetime import UTC, datetime

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
