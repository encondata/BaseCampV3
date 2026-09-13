"""Login enumeration hardening + server-side must_change_password enforcement.

(a) A wrong password must return the same status/code whether the account
is unknown, disabled, or locked — only the RIGHT password may reveal the
account's own status to its owner.
(b) `must_change_password` must be enforced on the API itself, not just the
portal: every route except the auth-lifecycle allowlist + the self
password-change route must 403 while the flag is set.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import text, update as sa_update

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password

PW = "CorrectHorse9!"
NEW_PW = "NewHorse-Battery-42"


async def _login(client, email, password=PW):
    return await client.post("/auth/login", json={"email": email, "password": password})


async def _headers_from(login_resp):
    assert login_resp.status_code == 200, login_resp.text
    return {"Authorization": f"Bearer {login_resp.json()['access_token']}"}


async def _make_user(db, *, first, last, email, role="staff", password=PW):
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email=email,
        password_hash=hash_password(
            password, pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=person.id, role=role))
    await db.commit()
    return person


# ── (a) enumeration: wrong password looks the same for every account state ──


async def test_wrong_password_same_code_unknown_disabled_locked(client, db, seeded_user):
    disabled = await _make_user(db, first="Dee", last="Disabled",
                                 email="dee@test.example.com")
    locked = await _make_user(db, first="Lex", last="Locked",
                              email="lex@test.example.com")

    await db.execute(sa_update(UserAccount)
                     .where(UserAccount.person_id == disabled.id)
                     .values(disabled_at=datetime.now(UTC)))
    await db.execute(sa_update(UserAccount)
                     .where(UserAccount.person_id == locked.id)
                     .values(locked_until=datetime.now(UTC) + timedelta(minutes=15)))
    await db.commit()

    r_unknown = await _login(client, "nobody@test.example.com", password="wrong-password")
    r_disabled = await _login(client, "dee@test.example.com", password="wrong-password")
    r_locked = await _login(client, "lex@test.example.com", password="wrong-password")

    assert r_unknown.status_code == r_disabled.status_code == r_locked.status_code == 401
    assert (r_unknown.json()["detail"]["code"]
            == r_disabled.json()["detail"]["code"]
            == r_locked.json()["detail"]["code"]
            == "invalid_credentials")


async def test_right_password_still_reveals_own_disabled_status(client, db, seeded_user):
    disabled = await _make_user(db, first="Dee", last="Disabled",
                                 email="dee2@test.example.com")
    await db.execute(sa_update(UserAccount)
                     .where(UserAccount.person_id == disabled.id)
                     .values(disabled_at=datetime.now(UTC)))
    await db.commit()

    resp = await _login(client, "dee2@test.example.com", password=PW)
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "account_disabled"


async def test_right_password_still_reveals_own_locked_status(client, db, seeded_user):
    locked = await _make_user(db, first="Lex", last="Locked",
                              email="lex2@test.example.com")
    await db.execute(sa_update(UserAccount)
                     .where(UserAccount.person_id == locked.id)
                     .values(locked_until=datetime.now(UTC) + timedelta(minutes=15)))
    await db.commit()

    resp = await _login(client, "lex2@test.example.com", password=PW)
    assert resp.status_code == 423
    assert resp.json()["detail"]["code"] == "account_locked"


async def test_wrong_password_on_locked_account_still_counts_failed_attempts(
        client, db, seeded_user):
    """A wrong password against a locked account must still hit the normal
    failed-attempt path (and re-raise invalid_credentials), not short-circuit
    on the lock."""
    locked = await _make_user(db, first="Lex", last="Locked",
                              email="lex3@test.example.com")
    await db.execute(sa_update(UserAccount)
                     .where(UserAccount.person_id == locked.id)
                     .values(locked_until=datetime.now(UTC) + timedelta(minutes=15)))
    await db.commit()

    resp = await _login(client, "lex3@test.example.com", password="wrong-password")
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "invalid_credentials"

    row = await db.execute(text(
        "SELECT failed_login_count FROM user_accounts WHERE person_id = :pid"),
        {"pid": str(locked.id)})
    assert row.scalar() == 1


# ── (b) must_change_password server-side enforcement ────────────────────────


async def test_forced_change_blocks_normal_routes(client, db, seeded_user):
    await db.execute(sa_update(UserAccount).values(must_change_password=True))
    await db.commit()

    headers = await _headers_from(await _login(client, "alice@test.example.com"))

    resp = await client.get("/initiatives", headers=headers)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "password_change_required"


async def test_forced_change_allows_auth_lifecycle_and_self_password_change(
        client, db, seeded_user):
    await db.execute(sa_update(UserAccount).values(must_change_password=True))
    await db.commit()

    login_resp = await _login(client, "alice@test.example.com")
    headers = await _headers_from(login_resp)

    # GET /auth/me still works
    assert (await client.get("/auth/me", headers=headers)).status_code == 200

    # refresh still works (cookie-based, no bearer token involved)
    refresh_resp = await client.post("/auth/refresh")
    assert refresh_resp.status_code == 200

    # self password-change still reachable and clears the flag
    resp = await client.post("/auth/me/password", headers=headers, json={
        "current_password": PW, "new_password": NEW_PW})
    assert resp.status_code == 204

    # logout still works
    assert (await client.post("/auth/logout")).status_code == 204

    # after the change, a fresh login shows the flag cleared and normal
    # routes are reachable again
    new_headers = await _headers_from(await _login(client, "alice@test.example.com", NEW_PW))
    assert (await client.get("/initiatives", headers=new_headers)).status_code == 200


async def test_forced_change_does_not_affect_other_users(client, db, seeded_user):
    other = await _make_user(db, first="Bob", last="Bystander",
                             email="bob@test.example.com")
    headers = await _headers_from(await _login(client, "bob@test.example.com"))
    assert (await client.get("/initiatives", headers=headers)).status_code == 200


async def test_forced_change_blocks_system_admin_even_for_admins(client, db, seeded_user):
    """`/system/admin` is exempt from READ-ONLY mode (whoever can turn it on
    can turn it off) but must NOT inherit that exemption for the forced
    password-change guard: a temp-password super_admin session cannot flip
    read-only / pause workers / set the banner until the password is
    changed. After the change, the same call goes through."""
    await _make_user(db, first="Sue", last="Admin", email="sue@test.example.com",
                     role="super_admin")
    await db.execute(sa_update(UserAccount)
                     .where(UserAccount.email == "sue@test.example.com")
                     .values(must_change_password=True))
    await db.commit()

    headers = await _headers_from(await _login(client, "sue@test.example.com"))
    resp = await client.put("/system/admin", headers=headers,
                            json={"read_only": True})
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "password_change_required"

    resp = await client.post("/auth/me/password", headers=headers, json={
        "current_password": PW, "new_password": NEW_PW})
    assert resp.status_code == 204, resp.text

    headers = await _headers_from(await _login(client, "sue@test.example.com", NEW_PW))
    resp = await client.put("/system/admin", headers=headers,
                            json={"read_only": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["read_only"] is True


async def test_forced_change_allows_listing_own_sessions(client, db, seeded_user):
    """GET /auth/me/sessions (no trailing slash) is self-scoped and gains no
    privilege — a temp-password user may list what they are allowed to
    revoke (DELETE /auth/me/sessions/{family_id} was already exempt via the
    read-only prefix)."""
    await db.execute(sa_update(UserAccount).values(must_change_password=True))
    await db.commit()

    headers = await _headers_from(await _login(client, "alice@test.example.com"))
    resp = await client.get("/auth/me/sessions", headers=headers)
    assert resp.status_code == 200, resp.text
    assert isinstance(resp.json(), list) and len(resp.json()) >= 1
