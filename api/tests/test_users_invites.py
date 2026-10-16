"""Invite links, admin-sent reset links, the "invited" status and the 2FA
state flags (spec 2026-10-15 user-admin fixes, sections 5 and 7)."""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog,
    AuthSession,
    EmailOutbox,
    PermissionOverride,
    Person,
    UserAccount,
)
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from tests.test_access_roles_api import login_admin
from tests.test_totp_api import _security
from tests.test_users_api import _add_person, _add_user, _token

NEW_BODY = {
    "first_name": "Ivy",
    "last_name": "Invitee",
    "contact_email": "ivy@test.example.com",
    "roles": ["worker"],
    "create_account": True,
    "login_email": "ivy@test.example.com",
    "invite": True,
}


@pytest.fixture
def email_off(monkeypatch):
    """Email not configured, whatever the environment says."""
    from serversherpa.api.routes import users as users_routes
    monkeypatch.setattr(users_routes, "email_enabled", lambda: False)


async def _outbox(db, template, to=None):
    db.expire_all()
    query = select(EmailOutbox).where(EmailOutbox.template == template)
    if to is not None:
        query = query.where(EmailOutbox.to_address == to)
    # plain copies: a later expire_all() must not turn them into lazy loads
    return [SimpleNamespace(to_address=r.to_address, subject=r.subject,
                            text_body=r.text_body, html_body=r.html_body)
            for r in await db.scalars(query.order_by(EmailOutbox.created_at))]


def _raw(row) -> str:
    return row.text_body.split("#token=")[1].split()[0]


async def _audit(db, entity_id, action):
    db.expire_all()
    return list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(entity_id), AuditLog.action == action)))


async def _account(db, person_id) -> UserAccount:
    db.expire_all()
    return await db.get(UserAccount, person_id)


async def _check(client, raw):
    return (await client.post("/auth/password-reset/check", json={"token": raw})).json()


async def _invite_new(client, db, seeded_user, **overrides):
    headers = await login_admin(client, db, seeded_user)
    resp = await client.post("/users", headers=headers, json={**NEW_BODY, **overrides})
    assert resp.status_code == 201, resp.text
    return headers, resp.json()


async def _status_of(client, headers, person_id):
    return (await client.get(f"/users/{person_id}", headers=headers)).json()["account"]["status"]


# ── invite on create ───────────────────────────────────────────────


async def test_create_with_invite(client, db, seeded_user, email_on):
    headers, body = await _invite_new(client, db, seeded_user)
    pid = body["person_id"]
    assert body["status"] == "invited"
    account = await _account(db, pid)
    assert account.password_hash is None
    rows = await _outbox(db, "user_invite")
    assert len(rows) == 1
    assert rows[0].to_address == "ivy@test.example.com"
    assert "/reset-password#token=" in rows[0].text_body
    assert "/reset-password#token=" in rows[0].html_body
    assert rows[0].subject == "You've been invited to ServerSherpa"
    from serversherpa.services.first_admin import ttl_text
    assert "Ivy" in rows[0].text_body
    assert f"expires in {ttl_text(get_settings().invite_ttl_minutes)}" in rows[0].text_body
    (row,) = await _audit(db, pid, "create")
    assert row.changes["invited"] == {"from": None, "to": True}
    assert await _status_of(client, headers, pid) == "invited"
    listing = (await client.get("/users", headers=headers)).json()
    assert next(u for u in listing if u["person_id"] == pid)["status"] == "invited"
    # the link sets the first password
    assert await _check(client, _raw(rows[0])) == {"valid": True, "first_password": True}


async def test_create_with_invite_ignores_temp_password(client, db, seeded_user, email_on):
    _, body = await _invite_new(client, db, seeded_user, temp_password="TempPass-123456")
    assert (await _account(db, body["person_id"])).password_hash is None


async def test_create_with_invite_needs_login_email(client, db, seeded_user, email_on):
    headers = await login_admin(client, db, seeded_user)
    resp = await client.post("/users", headers=headers, json={**NEW_BODY, "login_email": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "login_details_required"


async def test_create_with_invite_email_off(client, db, seeded_user, email_off):
    headers = await login_admin(client, db, seeded_user)
    resp = await client.post("/users", headers=headers, json=NEW_BODY)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "mail_not_configured"
    db.expire_all()
    assert await db.scalar(select(func.count()).select_from(Person)
                           .where(Person.first_name == "Ivy")) == 0
    assert await db.scalar(select(func.count()).select_from(UserAccount)
                           .where(UserAccount.email == "ivy@test.example.com")) == 0


async def test_create_without_invite_still_needs_temp_password(client, db, seeded_user):
    headers = await login_admin(client, db, seeded_user)
    resp = await client.post("/users", headers=headers, json={**NEW_BODY, "invite": False})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "login_details_required"


async def test_sign_in_fails_while_invited(client, db, seeded_user, email_on):
    await _invite_new(client, db, seeded_user)
    for password in ("", "anything", "TempPass-123456"):
        resp = await client.post("/auth/login",
                                 json={"email": "ivy@test.example.com", "password": password})
        assert resp.status_code in (401, 422)
        assert "access_token" not in resp.json()


# ── invite on grant ────────────────────────────────────────────────


async def test_grant_with_invite(client, db, seeded_user, email_on):
    person = await _add_person(db, first="Gail", last="Grant", email="gail@test.example.com")
    pid = person.id
    token = await _token(client)
    resp = await client.post(f"/users/{pid}/account",
                             headers={"Authorization": f"Bearer {token}"},
                             json={"login_email": "gail@test.example.com", "invite": True})
    assert resp.status_code == 201, resp.text
    account = await _account(db, pid)
    assert account is not None and account.password_hash is None
    rows = await _outbox(db, "user_invite", "gail@test.example.com")
    assert len(rows) == 1 and "/reset-password#token=" in rows[0].text_body
    (row,) = await _audit(db, pid, "account.create")
    assert row.changes["invited"] == {"from": None, "to": True}
    headers = {"Authorization": f"Bearer {token}"}
    assert await _status_of(client, headers, pid) == "invited"


async def test_grant_with_invite_email_off(client, db, seeded_user, email_off):
    person = await _add_person(db, first="Gail", last="Grant", email="gail@test.example.com")
    token = await _token(client)
    resp = await client.post(f"/users/{person.id}/account",
                             headers={"Authorization": f"Bearer {token}"},
                             json={"login_email": "gail@test.example.com", "invite": True})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "mail_not_configured"
    assert await _account(db, person.id) is None


async def test_grant_without_invite_needs_temp_password(client, db, seeded_user):
    person = await _add_person(db, first="Gail", last="Grant")
    token = await _token(client)
    resp = await client.post(f"/users/{person.id}/account",
                             headers={"Authorization": f"Bearer {token}"},
                             json={"login_email": "gail@test.example.com"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "login_details_required"


# ── resend invite ──────────────────────────────────────────────────


async def test_resend_invite(client, db, seeded_user, email_on):
    headers, body = await _invite_new(client, db, seeded_user)
    pid = body["person_id"]
    (first,) = await _outbox(db, "user_invite")
    resp = await client.post(f"/users/{pid}/invite", headers=headers)
    assert resp.status_code == 204, resp.text
    rows = await _outbox(db, "user_invite")
    assert len(rows) == 2
    assert await _check(client, _raw(first)) == {"valid": False, "first_password": False}
    assert await _check(client, _raw(rows[1])) == {"valid": True, "first_password": True}
    assert len(await _audit(db, pid, "account.invite_resent")) == 1


async def test_resend_invite_refused_once_password_set(client, db, seeded_user, email_on):
    headers, body = await _invite_new(client, db, seeded_user)
    (row,) = await _outbox(db, "user_invite")
    done = await client.post("/auth/password-reset/confirm",
                             json={"token": _raw(row), "new_password": "BrandNewPass9!"})
    assert done.status_code == 204, done.text
    assert await _status_of(client, headers, body["person_id"]) == "active"
    resp = await client.post(f"/users/{body['person_id']}/invite", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "not_invited"
    login = await client.post("/auth/login", json={"email": "ivy@test.example.com",
                                                   "password": "BrandNewPass9!"})
    assert login.status_code == 200
    assert login.json()["must_change_password"] is False


async def test_resend_invite_refused_when_disabled(client, db, seeded_user, email_on):
    headers, body = await _invite_new(client, db, seeded_user)
    pid = body["person_id"]
    assert (await client.post(f"/users/{pid}/disable", headers=headers)).status_code == 204
    # Review Focus 2: a disabled invited account reads "disabled"
    assert await _status_of(client, headers, pid) == "disabled"
    resp = await client.post(f"/users/{pid}/invite", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "account_disabled"
    assert len(await _outbox(db, "user_invite")) == 1


async def test_resend_invite_email_off(client, db, seeded_user, email_on, monkeypatch):
    headers, body = await _invite_new(client, db, seeded_user)
    from serversherpa.api.routes import users as users_routes
    monkeypatch.setattr(users_routes, "email_enabled", lambda: False)
    resp = await client.post(f"/users/{body['person_id']}/invite", headers=headers)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "mail_not_configured"
    # the only invite is the one from creation; the resend sent nothing
    assert len(await _outbox(db, "user_invite")) == 1


async def test_resend_invite_rank_and_self(client, db, seeded_user, email_on):
    peer = await _add_person(db, first="Pete", last="Peer", role="staff")
    db.add(UserAccount(person_id=peer.id, email="pete@test.example.com"))
    await db.commit()
    headers = {"Authorization": f"Bearer {await _token(client)}"}
    resp = await client.post(f"/users/{peer.id}/invite", headers=headers)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "rank_too_low"
    resp = await client.post(f"/users/{seeded_user.id}/invite", headers=headers)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "cannot_target_self"


async def test_resend_invite_unknown_account(client, db, seeded_user, email_on):
    person = await _add_person(db, first="No", last="Login")
    headers = {"Authorization": f"Bearer {await _token(client)}"}
    resp = await client.post(f"/users/{person.id}/invite", headers=headers)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "user_not_found"


# ── admin-sent reset link ──────────────────────────────────────────


async def _target_with_session(client, db):
    person = await _add_user(db, first="Rita", last="Reset",
                             email="rita@test.example.com", role="worker")
    login = await client.post("/auth/login", json={"email": "rita@test.example.com",
                                                   "password": "CorrectHorse9!"})
    assert login.status_code == 200
    return person


async def _live_sessions(db, person_id) -> int:
    db.expire_all()
    return await db.scalar(select(func.count()).select_from(AuthSession).where(
        AuthSession.person_id == person_id, AuthSession.revoked_at.is_(None)))


async def test_reset_link(client, db, seeded_user, email_on):
    target = await _target_with_session(client, db)
    tid = target.id
    before = (await _account(db, tid)).password_hash
    assert await _live_sessions(db, tid) == 1
    headers = {"Authorization": f"Bearer {await _token(client)}"}
    resp = await client.post(f"/users/{tid}/reset-link", headers=headers)
    assert resp.status_code == 204, resp.text
    rows = await _outbox(db, "admin_password_reset", "rita@test.example.com")
    assert len(rows) == 1 and "/reset-password#token=" in rows[0].text_body
    assert "Rita" in rows[0].text_body
    assert f"{get_settings().password_reset_ttl_minutes} minutes" in rows[0].text_body
    # an admin sent it: the email says so, and never claims the person asked
    for body in (rows[0].text_body, rows[0].html_body):
        assert "An administrator sent you a link" in body
        assert "Someone asked" not in body and "If it was you" not in body
    assert rows[0].subject == "Set a new ServerSherpa password"
    # the self-service template isn't used for it
    assert await _outbox(db, "password_reset") == []
    # nothing changes until the link is used
    assert await _live_sessions(db, tid) == 1
    assert (await _account(db, tid)).password_hash == before
    assert len(await _audit(db, tid, "password.reset_link_sent")) == 1
    assert await _check(client, _raw(rows[0])) == {"valid": True, "first_password": False}


async def test_reset_link_refused_for_invited(client, db, seeded_user, email_on):
    headers, body = await _invite_new(client, db, seeded_user)
    resp = await client.post(f"/users/{body['person_id']}/reset-link", headers=headers)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "invited"


async def test_reset_link_refused_when_disabled(client, db, seeded_user, email_on):
    target = await _target_with_session(client, db)
    headers = {"Authorization": f"Bearer {await _token(client)}"}
    assert (await client.post(f"/users/{target.id}/disable", headers=headers)).status_code == 204
    resp = await client.post(f"/users/{target.id}/reset-link", headers=headers)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "account_disabled"


async def test_reset_link_email_off(client, db, seeded_user, email_off):
    target = await _target_with_session(client, db)
    headers = {"Authorization": f"Bearer {await _token(client)}"}
    resp = await client.post(f"/users/{target.id}/reset-link", headers=headers)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "mail_not_configured"
    assert await _outbox(db, "admin_password_reset") == []


async def test_reset_link_rank_and_self(client, db, seeded_user, email_on):
    peer = await _add_user(db, first="Pete", last="Peer",
                           email="pete@test.example.com", role="staff")
    headers = {"Authorization": f"Bearer {await _token(client)}"}
    resp = await client.post(f"/users/{peer.id}/reset-link", headers=headers)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "rank_too_low"
    resp = await client.post(f"/users/{seeded_user.id}/reset-link", headers=headers)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "cannot_target_self"


# ── who may be invited or sent a link ──────────────────────────────


async def _worker_with_users_change(client, db, seeded_user):
    worker = await _add_user(db, first="Wanda", last="Worker",
                             email="wanda@test.example.com", role="worker")
    db.add(PermissionOverride(person_id=worker.id, resource="users",
                              action="change", allow=True, set_by=seeded_user.id))
    await db.commit()
    return {"Authorization": f"Bearer {await _token(client, email='wanda@test.example.com')}"}


@pytest.mark.parametrize("endpoint", ["invite", "reset-link"])
async def test_non_global_actor_forbidden(client, db, seeded_user, email_on, endpoint):
    headers = await _worker_with_users_change(client, db, seeded_user)
    target = await _add_user(db, first="Tara", last="Target",
                             email="tara@test.example.com", role="worker")
    resp = await client.post(f"/users/{target.id}/{endpoint}", headers=headers)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"
    assert await _outbox(db, "user_invite") == []
    assert await _outbox(db, "admin_password_reset") == []


async def _archived_invited(client, db, seeded_user):
    headers, body = await _invite_new(client, db, seeded_user)
    pid = body["person_id"]
    person = await db.get(Person, pid)
    person.archived_at = datetime.now(UTC)
    await db.commit()
    return headers, pid


async def test_resend_invite_refused_for_archived(client, db, seeded_user, email_on):
    headers, pid = await _archived_invited(client, db, seeded_user)
    resp = await client.post(f"/users/{pid}/invite", headers=headers)
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "person_archived"
    assert len(await _outbox(db, "user_invite")) == 1        # only the original
    assert await _audit(db, pid, "account.invite_resent") == []


async def test_reset_link_refused_for_archived(client, db, seeded_user, email_on):
    tid = (await _target_with_session(client, db)).id
    (await db.get(Person, tid)).archived_at = datetime.now(UTC)
    await db.commit()
    headers = {"Authorization": f"Bearer {await _token(client)}"}
    resp = await client.post(f"/users/{tid}/reset-link", headers=headers)
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "person_archived"
    assert await _outbox(db, "admin_password_reset") == []
    assert await _audit(db, tid, "password.reset_link_sent") == []


@pytest.mark.parametrize("endpoint", ["invite", "reset-link"])
async def test_kiosk_move_identity_not_found(client, db, seeded_user, email_on, endpoint):
    kiosk = await _add_user(db, first="Kiosk", last="Move",
                            email="kiosk-move@test.example.com", role="worker")
    kid = kiosk.id
    kiosk.source = KIOSK_MOVE_SOURCE
    # no password: it would otherwise read as "invited" and pass the invite guards
    (await db.get(UserAccount, kid)).password_hash = None
    await db.commit()
    headers = {"Authorization": f"Bearer {await _token(client)}"}
    resp = await client.post(f"/users/{kid}/{endpoint}", headers=headers)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "user_not_found"
    assert await _outbox(db, "user_invite") == []
    assert await _outbox(db, "admin_password_reset") == []


async def test_kiosk_move_identity_reset_password_not_found(client, db, seeded_user):
    """The temporary-password reset follows the same rule as the mail
    endpoints: a move's hidden kiosk identity is not found."""
    kiosk = await _add_user(db, first="Kiosk", last="Move",
                            email="kiosk-move2@test.example.com", role="worker")
    kid = kiosk.id
    kiosk.source = KIOSK_MOVE_SOURCE
    await db.commit()
    headers = {"Authorization": f"Bearer {await _token(client)}"}
    resp = await client.post(f"/users/{kid}/reset-password", headers=headers,
                             json={"temp_password": "NewTempPass-123456",
                                   "must_change_password": True})
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "user_not_found"
    assert await _audit(db, kid, "password.reset") == []


async def test_invite_token_dies_when_admin_sets_temp_password(client, db, seeded_user, email_on):
    headers, body = await _invite_new(client, db, seeded_user)
    (row,) = await _outbox(db, "user_invite")
    assert await _check(client, _raw(row)) == {"valid": True, "first_password": True}
    resp = await client.post(f"/users/{body['person_id']}/reset-password", headers=headers,
                             json={"temp_password": "TempPass-123456",
                                   "must_change_password": True})
    assert resp.status_code == 204, resp.text
    assert (await _check(client, _raw(row)))["valid"] is False
    done = await client.post("/auth/password-reset/confirm",
                             json={"token": _raw(row), "new_password": "BrandNewPass9!"})
    assert done.status_code != 204


# ── "password changed" mail ────────────────────────────────────────


async def test_invite_completion_sends_no_password_changed_mail(
        client, db, seeded_user, email_on):
    await _invite_new(client, db, seeded_user)
    (row,) = await _outbox(db, "user_invite")
    done = await client.post("/auth/password-reset/confirm",
                             json={"token": _raw(row), "new_password": "BrandNewPass9!"})
    assert done.status_code == 204, done.text
    assert await _outbox(db, "password_changed") == []


async def test_self_service_reset_sends_password_changed_mail(
        client, db, seeded_user, email_on):
    await client.post("/auth/password-reset/request", json={"email": "alice@test.example.com"})
    (row,) = await _outbox(db, "password_reset")
    done = await client.post("/auth/password-reset/confirm",
                             json={"token": _raw(row), "new_password": "BrandNewPass9!"})
    assert done.status_code == 204, done.text
    assert len(await _outbox(db, "password_changed", "alice@test.example.com")) == 1


async def test_admin_reset_link_completion_sends_password_changed_mail(
        client, db, seeded_user, email_on):
    target = await _target_with_session(client, db)
    headers = {"Authorization": f"Bearer {await _token(client)}"}
    assert (await client.post(f"/users/{target.id}/reset-link",
                              headers=headers)).status_code == 204
    (row,) = await _outbox(db, "admin_password_reset", "rita@test.example.com")
    done = await client.post("/auth/password-reset/confirm",
                             json={"token": _raw(row), "new_password": "BrandNewPass9!"})
    assert done.status_code == 204, done.text
    assert len(await _outbox(db, "password_changed", "rita@test.example.com")) == 1


# ── check / first_password ─────────────────────────────────────────


async def test_check_first_password_false_after_normal_reset(client, db, seeded_user, email_on):
    await client.post("/auth/password-reset/request", json={"email": "alice@test.example.com"})
    (row,) = await _outbox(db, "password_reset")
    assert await _check(client, _raw(row)) == {"valid": True, "first_password": False}


async def test_check_invalid_token(client, seeded_user):
    assert await _check(client, "nope") == {"valid": False, "first_password": False}


async def test_self_service_reset_keeps_invite(client, db, seeded_user, email_on):
    """Review Focus 1: "Forgot password" on an invited account retires the
    invite link but the account stays invited and the reset link still
    lands on the first-password wording."""
    headers, body = await _invite_new(client, db, seeded_user)
    (invite,) = await _outbox(db, "user_invite")
    await client.post("/auth/password-reset/request", json={"email": "ivy@test.example.com"})
    (reset,) = await _outbox(db, "password_reset", "ivy@test.example.com")
    assert await _status_of(client, headers, body["person_id"]) == "invited"
    assert await _check(client, _raw(invite)) == {"valid": False, "first_password": False}
    assert await _check(client, _raw(reset)) == {"valid": True, "first_password": True}


# ── two_factor_enabled ─────────────────────────────────────────────


@pytest.mark.parametrize("enabled", [False, True])
async def test_two_factor_enabled_flags(client, db, seeded_user, enabled):
    await _security(db, two_factor_enabled=enabled)
    target = await _add_user(db, first="Tess", last="Totp",
                             email="tess@test.example.com", role="worker")
    headers = await login_admin(client, db, seeded_user)
    detail = (await client.get(f"/users/{target.id}", headers=headers)).json()
    assert detail["account"]["two_factor_enabled"] is enabled
    summary = (await client.get("/access/summary", headers=headers)).json()
    assert summary["two_factor_enabled"] is enabled


async def test_two_factor_enabled_defaults_off(client, db, seeded_user):
    headers = await login_admin(client, db, seeded_user)
    summary = (await client.get("/access/summary", headers=headers)).json()
    assert summary["two_factor_enabled"] is False
    detail = (await client.get(f"/users/{seeded_user.id}", headers=headers)).json()
    assert detail["account"]["two_factor_enabled"] is False


async def test_disabled_never_set_account_status(client, db, seeded_user):
    """Review Focus 2 without email: an account with no password that is
    disabled reads "disabled", not "invited"."""
    person = await _add_person(db, first="Dee", last="Disabled")
    db.add(UserAccount(person_id=person.id, email="dee@test.example.com",
                       disabled_at=datetime.now(UTC)))
    await db.commit()
    headers = await login_admin(client, db, seeded_user)
    assert await _status_of(client, headers, person.id) == "disabled"
