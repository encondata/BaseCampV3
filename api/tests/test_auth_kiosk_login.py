"""Login with client="kiosk": refused (403 kiosk_not_allowed, no session)
for accounts without kiosk:view, otherwise identical to a portal login.
The portal (client omitted) is unchanged."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, AuthSession, Client, Person, PersonRole, UserAccount
from tests.test_sites_api import make_login
from tests.test_status_values_write import PW, _make


async def _client_viewer(db, client, email):
    """A client-scoped viewer with a login (headers). _make() can't build
    this role: person_roles_client_scope_check requires a client_id."""
    org = Client(name=f"Org for {email}")
    db.add(org)
    await db.flush()
    contact = Person(first_name="C", last_name="Viewer", email=email)
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=org.id))
    await db.commit()
    return await make_login(db, client, contact, email)   # logs in once (portal)


async def test_kiosk_login_refused_without_kiosk_permission(client, db, seeded_user):
    await _client_viewer(db, client, "cv@test.example.com")
    resp = await client.post("/auth/login", json={
        "email": "cv@test.example.com", "password": PW, "client": "kiosk"})
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "kiosk_not_allowed"
    assert "ss_refresh" not in resp.cookies
    sessions = (await db.scalars(select(AuthSession))).all()
    assert len(sessions) == 1                      # only make_login's portal login
    account = await db.scalar(select(UserAccount).where(
        UserAccount.email == "cv@test.example.com"))
    assert account.failed_login_count == 0         # a valid password never counts as a failure
    failed = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "login_failed"))).all()
    assert len(failed) == 1
    assert failed[0].changes == {"reason": "kiosk_not_allowed"}


async def test_kiosk_login_allowed_for_worker(client, db, seeded_user):
    await _make(db, client, "worker", "w@test.example.com")
    resp = await client.post("/auth/login", json={
        "email": "w@test.example.com", "password": PW, "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["perms"]["kiosk"]["view"] is True
    assert "ss_refresh" in resp.cookies


async def test_portal_login_unchanged_for_client_viewer(client, db, seeded_user):
    await _client_viewer(db, client, "cv2@test.example.com")
    resp = await client.post("/auth/login", json={
        "email": "cv2@test.example.com", "password": PW})
    assert resp.status_code == 200
    assert resp.json()["perms"].get("kiosk", {}).get("view", False) is False


async def test_kiosk_login_wrong_password_is_still_invalid_credentials(client, db, seeded_user):
    await _client_viewer(db, client, "cv3@test.example.com")
    resp = await client.post("/auth/login", json={
        "email": "cv3@test.example.com", "password": "nope", "client": "kiosk"})
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "invalid_credentials"


async def test_bad_client_value_is_422(client, seeded_user):
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": PW, "client": "toaster"})
    assert resp.status_code == 422
