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
