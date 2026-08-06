"""Password minimum length is settings-driven (SS_PASSWORD_MIN_LENGTH,
default 8) and enforced at every intake: self-change, admin reset, and
both temp-password account paths. Schemas only require non-empty."""
from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole
from tests.test_sites_api import login, make_login


async def test_default_min_is_eight():
    assert get_settings().password_min_length == 8


async def test_change_password_enforces_min(client, seeded_user):
    hdrs = await login(client)
    short = await client.post("/auth/me/password", headers=hdrs, json={
        "current_password": "CorrectHorse9!", "new_password": "seven77"})
    assert short.status_code == 422
    assert short.json()["detail"]["code"] == "password_too_short"
    assert short.json()["detail"]["min_length"] == 8

    # 8 chars passes now (used to need 12)
    ok = await client.post("/auth/me/password", headers=hdrs, json={
        "current_password": "CorrectHorse9!", "new_password": "eight888"})
    assert ok.status_code == 204, ok.text

    # wrong current still reads as exactly that — not a length problem
    bad = await client.post("/auth/me/password", headers=hdrs, json={
        "current_password": "nope-nope", "new_password": "long-enough-pw"})
    assert bad.status_code == 403
    assert bad.json()["detail"]["code"] == "invalid_current_password"


async def test_admin_reset_enforces_min(client, db, seeded_user):
    admin = Person(first_name="Ada", last_name="Admin",
                   email="ada-pw@test.example.com")
    db.add(admin)
    await db.flush()
    db.add(PersonRole(person_id=admin.id, role="admin"))
    await db.commit()
    hdrs = await make_login(db, client, admin, "ada-pw@test.example.com")

    short = await client.post(f"/users/{seeded_user.id}/reset-password",
                              headers=hdrs, json={"temp_password": "tiny"})
    assert short.status_code == 422
    assert short.json()["detail"]["code"] == "password_too_short"

    ok = await client.post(f"/users/{seeded_user.id}/reset-password",
                           headers=hdrs, json={"temp_password": "temp8pw!"})
    assert ok.status_code in (200, 204), ok.text


async def test_grant_account_enforces_min(client, db, seeded_user):
    admin = Person(first_name="Gina", last_name="Granter",
                   email="gina-pw@test.example.com")
    contact = Person(first_name="New", last_name="Contact",
                     email="newc@test.example.com")
    db.add_all([admin, contact])
    await db.flush()
    db.add(PersonRole(person_id=admin.id, role="admin"))
    await db.commit()
    hdrs = await make_login(db, client, admin, "gina-pw@test.example.com")

    short = await client.post(f"/users/{contact.id}/account", headers=hdrs,
                              json={"login_email": "newc@test.example.com",
                                    "temp_password": "tiny"})
    assert short.status_code == 422
    assert short.json()["detail"]["code"] == "password_too_short"

    ok = await client.post(f"/users/{contact.id}/account", headers=hdrs,
                           json={"login_email": "newc@test.example.com",
                                 "temp_password": "temp8pw!"})
    assert ok.status_code == 201, ok.text


async def test_session_payload_carries_min_length(client, seeded_user):
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    assert resp.json()["password_min_length"] == 8
