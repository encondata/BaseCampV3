import string
from datetime import UTC, datetime

import pyotp
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, AuthSession, TotpBackupCode, User

from .api_helpers import auth_headers
from .factories import PASSWORD, make_user

EMAIL = "boss@test.example.com"
ALPHABET = set("abcdefghjkmnpqrstuvwxyz23456789")


async def _local(client, db, **kw):
    return await auth_headers(client, db, email=EMAIL, source="local", **kw)


async def _user(db):
    user = await db.scalar(select(User).where(User.email == EMAIL))
    await db.refresh(user)
    return user


async def _enroll(client, headers):
    start = await client.post("/api/auth/totp/enroll/start", headers=headers)
    assert start.status_code == 200, start.text
    secret = start.json()["secret"]
    resp = await client.post("/api/auth/totp/enroll/confirm", headers=headers,
                             json={"code": pyotp.TOTP(secret).now(), "remember": False})
    assert resp.status_code == 200, resp.text
    return secret, resp.json()


# ── password ─────────────────────────────────────────────────────────

async def _pw(client, headers, cur=PASSWORD, new="BrandNewPass1!"):
    return await client.post("/api/auth/me/password", headers=headers,
                             json={"current_password": cur, "new_password": new})


async def test_password_change_success(client, db):
    headers = await _local(client, db)
    other = await client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert other.status_code == 200
    resp = await _pw(client, headers)
    assert resp.status_code == 204
    user = await _user(db)
    assert user.password_updated_at is not None
    sessions = (await db.scalars(select(AuthSession).where(
        AuthSession.person_id == user.person_id))).all()
    revoked = [s for s in sessions if s.revoked_at is not None]
    live = [s for s in sessions if s.revoked_at is None]
    assert revoked and all(s.revoke_reason == "password_change" for s in revoked)
    assert len({s.family_id for s in live}) == 1          # only the current one survives
    assert (await client.get("/api/auth/me", headers=headers)).status_code == 200
    assert (await client.post("/api/auth/login",
                              json={"email": EMAIL, "password": PASSWORD})).status_code == 401
    assert (await client.post("/api/auth/login", json={
        "email": EMAIL, "password": "BrandNewPass1!"})).status_code == 200
    assert await db.scalar(select(AuditLog).where(AuditLog.action == "password.change"))


async def test_password_wrong_current_no_strike(client, db):
    headers = await _local(client, db)
    resp = await _pw(client, headers, cur="nope-nope-nope")
    assert resp.status_code == 403
    assert resp.json()["detail"] == {"code": "invalid_current_password"}
    assert (await _user(db)).failed_login_count == 0


async def test_password_same_as_current(client, db):
    headers = await _local(client, db)
    resp = await _pw(client, headers, new=PASSWORD)
    assert resp.status_code == 422 and resp.json()["detail"] == {"code": "same_as_current"}


async def test_password_too_short(client, db):
    headers = await _local(client, db)
    resp = await _pw(client, headers, new="short")
    assert resp.status_code == 422
    assert resp.json()["detail"] == {
        "code": "password_too_short", "min_length": get_settings().password_min_length}


# ── enroll ───────────────────────────────────────────────────────────

async def test_enroll_start_confirm_and_status(client, db):
    headers = await _local(client, db)
    start = await client.post("/api/auth/totp/enroll/start", headers=headers)
    body = start.json()
    assert set(body) == {"secret", "otpauth_uri"}
    assert body["otpauth_uri"] == pyotp.TOTP(body["secret"]).provisioning_uri(
        name=EMAIL, issuer_name="Sirdar")
    user = await _user(db)
    assert user.totp_secret_enc is not None and user.totp_confirmed_at is None
    assert not user.totp_enabled
    bad = await client.post("/api/auth/totp/enroll/confirm", headers=headers,
                            json={"code": "000000", "remember": False})
    # 000000 could in principle be valid; astronomically unlikely
    assert bad.status_code == 401 and bad.json()["detail"] == {"code": "totp_invalid"}
    ok = await client.post("/api/auth/totp/enroll/confirm", headers=headers, json={
        "code": pyotp.TOTP(body["secret"]).now(), "remember": False})
    assert ok.status_code == 200
    out = ok.json()
    assert out["session"] is None and len(out["backup_codes"]) == 8
    for code in out["backup_codes"]:
        a, dash, b = code[:5], code[5], code[6:]
        assert dash == "-" and len(b) == 5 and set(a + b) <= ALPHABET
    user = await _user(db)
    assert user.totp_enabled and user.totp_confirmed_at and user.totp_last_counter
    rows = (await db.scalars(select(TotpBackupCode).where(
        TotpBackupCode.person_id == user.person_id))).all()
    assert len(rows) == 8 and all(r.code_hash != out["backup_codes"][0] for r in rows)
    assert await db.scalar(select(AuditLog).where(AuditLog.action == "totp.enroll"))
    me = (await client.get("/api/auth/me", headers=headers)).json()
    assert me["totp"]["enrolled"] is True and me["totp"]["backup_codes_remaining"] == 8


async def test_enroll_start_conflict_when_enrolled(client, db):
    headers = await _local(client, db)
    await _enroll(client, headers)
    resp = await client.post("/api/auth/totp/enroll/start", headers=headers)
    assert resp.status_code == 409 and resp.json()["detail"] == {"code": "totp_already_enrolled"}


async def test_enroll_restart_before_confirm_replaces_secret(client, db):
    headers = await _local(client, db)
    first = (await client.post("/api/auth/totp/enroll/start", headers=headers)).json()
    second = (await client.post("/api/auth/totp/enroll/start", headers=headers)).json()
    assert first["secret"] != second["secret"]


async def test_enroll_confirm_not_started(client, db):
    headers = await _local(client, db)
    resp = await client.post("/api/auth/totp/enroll/confirm", headers=headers,
                             json={"code": "123456", "remember": False})
    assert resp.status_code == 409 and resp.json()["detail"] == {"code": "totp_not_started"}


async def test_enroll_then_login_challenges(client, db):
    headers = await _local(client, db)
    secret, _ = await _enroll(client, headers)
    client.cookies.clear()
    login = await client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert login.status_code == 200
    body = login.json()
    assert body["status"] == "totp_verify"
    token = body["challenge_token"]
    # the enrollment consumed the current counter; use the next step
    from datetime import timedelta
    code = pyotp.TOTP(secret).at(datetime.now(UTC) + timedelta(seconds=30))
    ver = await client.post("/api/auth/totp/verify", headers={"X-TOTP-Challenge": token},
                            json={"code": code})
    assert ver.status_code == 200, ver.text
    assert "access_token" in ver.json()


# ── regenerate ───────────────────────────────────────────────────────

async def test_regenerate_requires_enrollment(client, db):
    headers = await _local(client, db)
    resp = await client.post("/api/auth/totp/backup-codes/regenerate", headers=headers,
                             json={"code": "123456"})
    assert resp.status_code == 409 and resp.json()["detail"] == {"code": "totp_not_enrolled"}


async def test_regenerate_success_and_replay(client, db):
    from datetime import timedelta
    headers = await _local(client, db)
    secret, first = await _enroll(client, headers)
    code = pyotp.TOTP(secret).at(datetime.now(UTC) + timedelta(seconds=30))
    resp = await client.post("/api/auth/totp/backup-codes/regenerate", headers=headers,
                             json={"code": code})
    assert resp.status_code == 200
    new = resp.json()["backup_codes"]
    assert len(new) == 8 and set(new) != set(first["backup_codes"])
    user = await _user(db)
    assert len((await db.scalars(select(TotpBackupCode).where(
        TotpBackupCode.person_id == user.person_id))).all()) == 8
    assert await db.scalar(select(AuditLog).where(
        AuditLog.action == "totp.backup_codes_regenerated"))
    replay = await client.post("/api/auth/totp/backup-codes/regenerate", headers=headers,
                               json={"code": code})
    assert replay.status_code == 401 and replay.json()["detail"] == {"code": "totp_invalid"}


async def test_regenerate_wrong_code_strikes_then_locks(client, db):
    headers = await _local(client, db)
    await _enroll(client, headers)
    limit = get_settings().max_failed_logins
    for _ in range(limit):
        resp = await client.post("/api/auth/totp/backup-codes/regenerate", headers=headers,
                                 json={"code": "000000"})
        assert resp.status_code == 401
    resp = await client.post("/api/auth/totp/backup-codes/regenerate", headers=headers,
                             json={"code": "000000"})
    assert resp.status_code == 423 and resp.json()["detail"] == {"code": "account_locked"}


# ── portal users ─────────────────────────────────────────────────────

async def test_portal_users_managed_in_portal(client, db):
    headers = await auth_headers(client, db, email=EMAIL, source="portal")
    calls = [
        ("/api/auth/me/password", {"current_password": PASSWORD, "new_password": "BrandNewPass1!"}),
        ("/api/auth/totp/enroll/start", None),
        ("/api/auth/totp/enroll/confirm", {"code": "123456", "remember": False}),
        ("/api/auth/totp/backup-codes/regenerate", {"code": "123456"}),
    ]
    for path, body in calls:
        resp = await client.post(path, headers=headers, json=body)
        assert resp.status_code == 403, path
        assert resp.json()["detail"] == {"code": "managed_in_portal"}, path


async def test_requires_sign_in(client, db):
    for path in ("/api/auth/me/password", "/api/auth/totp/enroll/start"):
        assert (await client.post(path, json={})).status_code in (401, 403)
