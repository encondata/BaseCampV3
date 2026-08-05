"""Users directory endpoint: role gating + content."""

from datetime import UTC, datetime

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password
from tests.test_access_roles_api import login_admin

LOGIN = {"email": "alice@test.example.com", "password": "CorrectHorse9!"}


async def _token(client, email=LOGIN["email"], password=LOGIN["password"]):
    resp = await client.post("/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200
    return resp.json()["access_token"]


async def _add_user(db, *, first, last, email, role, password="CorrectHorse9!"):
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email=email,
        password_hash=hash_password(
            password, pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC),
    ))
    db.add(PersonRole(person_id=person.id, role=role))
    await db.commit()
    return person


async def test_requires_auth(client):
    assert (await client.get("/users")).status_code == 401


async def test_staff_can_list_users(client, seeded_user, db):
    await _add_user(db, first="Wan", last="Worker",
                    email="wan@test.example.com", role="worker")
    token = await _token(client)
    resp = await client.get("/users", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 2  # alice + wan (both have accounts)

    alice = next(u for u in body if u["login_email"] == "alice@test.example.com")
    assert alice["display_name"] == "Alice Anderson"
    assert alice["roles"] == ["staff"]
    assert alice["status"] == "active"
    assert alice["last_login_at"] is not None  # she just logged in
    assert alice["max_rank"] == 40  # staff rank, from the seeded role grant


async def test_worker_role_gets_403(client, seeded_user, db):
    await _add_user(db, first="Wan", last="Worker",
                    email="wan@test.example.com", role="worker")
    token = await _token(client, email="wan@test.example.com")
    resp = await client.get("/users", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


async def test_disabled_status_reported(client, seeded_user, db):
    person = await _add_user(db, first="Dee", last="Disabled",
                             email="dee@test.example.com", role="staff")
    from sqlalchemy import update
    await db.execute(update(UserAccount)
                     .where(UserAccount.person_id == person.id)
                     .values(disabled_at=datetime.now(UTC)))
    await db.commit()

    token = await _token(client)
    body = (await client.get(
        "/users", headers={"Authorization": f"Bearer {token}"})).json()
    dee = next(u for u in body if u["login_email"] == "dee@test.example.com")
    assert dee["status"] == "disabled"


# ── create ─────────────────────────────────────────────────────────


CREATE_BODY = {
    "first_name": "Nina", "last_name": "Newhire",
    "job_title": "Field Lead", "roles": ["staff", "worker"],
    "create_account": True,
    "login_email": "nina@test.example.com",
    "temp_password": "TempPass-123456",
    "must_change_password": True,
}


async def test_create_user_with_account_and_roles(client, seeded_user, db):
    # granting "staff" (rank 40) requires an actor with rank strictly above
    # 40, so this exercises the rank cap via an admin actor.
    headers = await login_admin(client, db, seeded_user)
    resp = await client.post("/users", headers=headers, json=CREATE_BODY)
    assert resp.status_code == 201
    body = resp.json()
    assert body["display_name"] == "Nina Newhire"
    assert body["roles"] == ["staff", "worker"]
    assert body["status"] == "active"
    assert body["must_change_password"] is True

    # she appears in the directory
    listing = (await client.get("/users", headers=headers)).json()
    assert any(u["login_email"] == "nina@test.example.com" for u in listing)

    # and can log in with the temp password
    login = await client.post("/auth/login", json={
        "email": "nina@test.example.com", "password": "TempPass-123456"})
    assert login.status_code == 200
    assert login.json()["must_change_password"] is True
    assert sorted(login.json()["roles"]) == ["staff", "worker"]


async def test_create_user_validation(client, seeded_user, db):
    headers = await login_admin(client, db, seeded_user)

    resp = await client.post("/users", headers=headers,
                             json={**CREATE_BODY, "roles": ["superuser"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_role"

    resp = await client.post("/users", headers=headers,
                             json={**CREATE_BODY, "roles": ["client_viewer"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "role_requires_org"

    resp = await client.post("/users", headers=headers,
                             json={**CREATE_BODY, "temp_password": None})
    assert resp.json()["detail"]["code"] == "login_details_required"

    # duplicate login email
    assert (await client.post("/users", headers=headers,
                              json=CREATE_BODY)).status_code == 201
    resp = await client.post("/users", headers=headers, json=CREATE_BODY)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "email_in_use"


async def test_create_user_rejects_org_scoped_roles(client, seeded_user):
    token = await _token(client)
    resp = await client.post("/users", headers={"Authorization": f"Bearer {token}"},
                             json={**CREATE_BODY, "roles": ["client_owner"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "role_requires_org"


async def test_create_user_rejects_rank_too_low(client, seeded_user):
    # alice is plain staff (rank 40); granting "admin" (rank 60) is above
    # her own rank, so the rank cap — not the org-anchor rule — blocks it.
    token = await _token(client)
    resp = await client.post("/users", headers={"Authorization": f"Bearer {token}"},
                             json={**CREATE_BODY, "roles": ["admin"]})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"


async def test_worker_cannot_create_users(client, seeded_user, db):
    await _add_user(db, first="Wan", last="Worker",
                    email="wan@test.example.com", role="worker")
    token = await _token(client, email="wan@test.example.com")
    resp = await client.post("/users", headers={"Authorization": f"Bearer {token}"},
                             json=CREATE_BODY)
    assert resp.status_code == 403


# ── create login account for an existing person ────────────────────


async def _add_person(db, *, first, last, email=None, role=None):
    """A person WITHOUT a login account (the external-contact shape)."""
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.flush()
    if role is not None:
        db.add(PersonRole(person_id=person.id, role=role))
    await db.commit()
    return person


ACCOUNT_BODY = {
    "login_email": "carla@test.example.com",
    "temp_password": "TempPass-123456",
    "must_change_password": True,
}


async def test_create_account_for_existing_person(client, seeded_user, db):
    person = await _add_person(db, first="Carla", last="Contact",
                               email="carla@test.example.com")
    token = await _token(client)  # alice: staff (rank 40) vs rank-0 target
    resp = await client.post(f"/users/{person.id}/account",
                             headers={"Authorization": f"Bearer {token}"},
                             json=ACCOUNT_BODY)
    assert resp.status_code == 201

    # she can now log in with the temp password and must change it
    login = await client.post("/auth/login", json={
        "email": "carla@test.example.com", "password": "TempPass-123456"})
    assert login.status_code == 200
    assert login.json()["must_change_password"] is True

    # audit row exists and never carries password material
    from sqlalchemy import select

    from serversherpa.db.models import AuditLog
    row = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "user_account",
        AuditLog.entity_id == str(person.id),
        AuditLog.action == "account.create"))).one()
    assert "TempPass-123456" not in str(row.changes or {})  # no password content


async def test_create_account_respects_must_change_false(client, seeded_user, db):
    person = await _add_person(db, first="Nate", last="NoForce")
    token = await _token(client)
    resp = await client.post(f"/users/{person.id}/account",
                             headers={"Authorization": f"Bearer {token}"},
                             json={**ACCOUNT_BODY,
                                   "login_email": "nate@test.example.com",
                                   "must_change_password": False})
    assert resp.status_code == 201
    login = await client.post("/auth/login", json={
        "email": "nate@test.example.com", "password": "TempPass-123456"})
    assert login.status_code == 200
    assert login.json()["must_change_password"] is False


async def test_create_account_409_when_account_exists(client, seeded_user, db):
    person = await _add_user(db, first="Hazel", last="HasLogin",
                             email="hazel@test.example.com", role="worker")
    token = await _token(client)
    resp = await client.post(f"/users/{person.id}/account",
                             headers={"Authorization": f"Bearer {token}"},
                             json={**ACCOUNT_BODY,
                                   "login_email": "hazel2@test.example.com"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "account_exists"


async def test_create_account_409_on_duplicate_email(client, seeded_user, db):
    person = await _add_person(db, first="Dupe", last="Email")
    token = await _token(client)
    resp = await client.post(f"/users/{person.id}/account",
                             headers={"Authorization": f"Bearer {token}"},
                             json={**ACCOUNT_BODY,
                                   "login_email": "alice@test.example.com"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "email_in_use"


async def test_create_account_403_rank_too_low(client, seeded_user, db):
    # alice is staff (rank 40); the target holds staff too, so the
    # strictly-below rank rule blocks her (peer management is top-only).
    person = await _add_person(db, first="Pete", last="Peer", role="staff")
    token = await _token(client)
    resp = await client.post(f"/users/{person.id}/account",
                             headers={"Authorization": f"Bearer {token}"},
                             json={**ACCOUNT_BODY,
                                   "login_email": "pete@test.example.com"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"


async def test_non_global_actor_with_users_change_override_gets_403(
    client, seeded_user, db,
):
    """A worker (self-anchored, rank 10) granted a users:change override
    passes the resolver's permission cell (visible_to includes "self"),
    but the mutating users-router endpoints have no row-scope — only a
    rank check — so without an explicit global-anchor gate a worker could
    reset the password of any lower-ranked person, e.g. an external
    contact. That must be denied outright for non-global actors."""
    from serversherpa.db.models import PermissionOverride

    worker = await _add_user(db, first="Wanda", last="Worker",
                             email="wanda@test.example.com", role="worker")
    db.add(PermissionOverride(person_id=worker.id, resource="users",
                              action="change", allow=True,
                              set_by=seeded_user.id))
    await db.commit()

    target = await _add_person(db, first="Ext", last="Person",
                               email="ext@test.example.com", role="external")
    db.add(UserAccount(
        person_id=target.id, email="ext@test.example.com",
        password_hash=hash_password(
            "CorrectHorse9!",
            pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC),
    ))
    await db.commit()

    token = await _token(client, email="wanda@test.example.com")
    resp = await client.post(
        f"/users/{target.id}/reset-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"temp_password": "NewTempPass-123456",
              "must_change_password": True})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_create_account_422_for_archived_person(client, seeded_user, db):
    from datetime import UTC as _UTC, datetime as _dt

    person = await _add_person(db, first="Archie", last="Archived")
    person.archived_at = _dt.now(_UTC)
    await db.commit()

    token = await _token(client)
    resp = await client.post(f"/users/{person.id}/account",
                             headers={"Authorization": f"Bearer {token}"},
                             json={**ACCOUNT_BODY,
                                   "login_email": "archie@test.example.com"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "person_archived"


async def test_create_account_404_unknown_person(client, seeded_user):
    token = await _token(client)
    resp = await client.post(
        "/users/00000000-0000-0000-0000-000000000000/account",
        headers={"Authorization": f"Bearer {token}"}, json=ACCOUNT_BODY)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "person_not_found"
