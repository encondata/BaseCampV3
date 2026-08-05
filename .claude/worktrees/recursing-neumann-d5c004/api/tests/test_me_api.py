"""Self-service profile editing and active-session management."""

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password

LOGIN = {"email": "alice@test.example.com", "password": "CorrectHorse9!"}


async def _login(client):
    resp = await client.post("/auth/login", json=LOGIN)
    assert resp.status_code == 200
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


# ── profile ────────────────────────────────────────────────────────


async def test_get_profile(client, seeded_user):
    headers = await _login(client)
    resp = await client.get("/auth/me/profile", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["display_name"] == "Alice Anderson"
    assert body["country"] == "US"
    assert body["badge_uid"]


async def test_update_profile_partial_and_clear(client, seeded_user):
    headers = await _login(client)
    resp = await client.patch("/auth/me/profile", headers=headers, json={
        "preferred_name": "Ally",
        "phone": "+15555550123",
        "job_title": "Move Coordinator",
        "city": "Las Vegas",
        "region": "NV",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["display_name"] == "Ally Anderson"
    assert body["phone"] == "+15555550123"

    # explicit null clears a nullable field; untouched fields persist
    resp = await client.patch("/auth/me/profile", headers=headers,
                              json={"preferred_name": None})
    body = resp.json()
    assert body["display_name"] == "Alice Anderson"
    assert body["job_title"] == "Move Coordinator"


async def test_update_profile_rejects_null_name_and_unknown_fields(client, seeded_user):
    headers = await _login(client)
    assert (await client.patch("/auth/me/profile", headers=headers,
                               json={"first_name": None})).status_code == 422
    assert (await client.patch("/auth/me/profile", headers=headers,
                               json={"role": "admin"})).status_code == 422  # extra=forbid


async def test_update_profile_email_conflict_409(client, seeded_user, db):
    other = Person(first_name="Bob", last_name="Barker", email="bob@test.example.com")
    db.add(other)
    await db.commit()

    headers = await _login(client)
    resp = await client.patch("/auth/me/profile", headers=headers,
                              json={"email": "bob@test.example.com"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "email_in_use"


# ── sessions ───────────────────────────────────────────────────────


async def test_sessions_list_and_revoke(client, seeded_user):
    first = await _login(client)    # login #1
    second = await _login(client)   # login #2 (current for this token)

    resp = await client.get("/auth/me/sessions", headers=second)
    assert resp.status_code == 200
    sessions = resp.json()
    assert len(sessions) == 2
    assert sessions[0]["current"] is True     # current login sorts first
    assert sessions[1]["current"] is False

    # revoke the other (older) session
    other_family = sessions[1]["family_id"]
    resp = await client.delete(f"/auth/me/sessions/{other_family}", headers=second)
    assert resp.status_code == 204

    sessions = (await client.get("/auth/me/sessions", headers=second)).json()
    assert len(sessions) == 1
    assert sessions[0]["current"] is True

    # the revoked login's access token is dead immediately
    me = await client.get("/auth/me", headers=first)
    assert me.status_code == 401


async def test_cannot_revoke_someone_elses_session(client, seeded_user, db):
    # second user with their own session
    person = Person(first_name="Eve", last_name="Evans", email="eve@test.example.com")
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email="eve@test.example.com",
        password_hash=hash_password(
            "CorrectHorse9!", pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=person.id, role="staff"))
    await db.commit()

    eve_login = await client.post("/auth/login", json={
        "email": "eve@test.example.com", "password": "CorrectHorse9!"})
    eve_headers = {"Authorization": f"Bearer {eve_login.json()['access_token']}"}
    eve_family = (await client.get(
        "/auth/me/sessions", headers=eve_headers)).json()[0]["family_id"]

    alice = await _login(client)
    resp = await client.delete(f"/auth/me/sessions/{eve_family}", headers=alice)
    assert resp.status_code == 404  # not yours = not found
