"""2FA over HTTP: login branches, challenge tokens, verify, enrollment,
trusted browsers, kiosk exemption, the totp block on /auth/me."""

from datetime import UTC, datetime, timedelta

import pyotp
from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog,
    AuthSession,
    SystemConfig,
    TrustedDevice,
    UserAccount,
)
from serversherpa.services import totp as totp_service

EMAIL = "alice@test.example.com"
PW = "CorrectHorse9!"


async def _security(db, **flags):
    row = await db.get(SystemConfig, "security")
    if row is None:
        row = SystemConfig(section="security", data={})
        db.add(row)
    row.data = {"two_factor_enabled": False, "two_factor_required": False, **flags}
    await db.commit()


async def _login(http_client, email=EMAIL, password=PW, **extra):
    # Named `http_client` (not `client`) so callers can pass an extra
    # `client="kiosk"` kwarg — the LoginIn field — without colliding with
    # the positional httpx client argument.
    return await http_client.post(
        "/auth/login", json={"email": email, "password": password, **extra})


async def _enroll_direct(db, person_id):
    account = await db.get(UserAccount, person_id)
    secret, _ = await totp_service.begin_enrollment(db, account, actor_id=None, ip=None)
    codes = await totp_service.confirm_enrollment(
        db, account, pyotp.TOTP(secret).now(), actor_id=None, ip=None)
    return secret, codes


def _next_code(secret, seconds=30):
    return pyotp.TOTP(secret).at(datetime.now(UTC) + timedelta(seconds=seconds))


# ── login branches ──────────────────────────────────────────────────

async def test_switch_off_never_challenges_even_when_enrolled(client, db, seeded_user):
    await _enroll_direct(db, seeded_user.id)
    resp = await _login(client)
    assert resp.status_code == 200 and resp.json()["status"] == "ok"
    assert resp.json()["totp"]["enrolled"] is True
    assert "ss_refresh" in resp.cookies


async def test_enrolled_user_gets_verify_challenge_no_session(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    await _enroll_direct(db, seeded_user.id)
    resp = await _login(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "totp_verify" and body["challenge_token"]
    assert body["backup_codes_remaining"] == 8
    assert "ss_refresh" not in resp.cookies and "access_token" not in body
    assert (await db.scalar(select(AuthSession).where(
        AuthSession.person_id == seeded_user.id))) is None


async def test_verify_challenge_audits_login_challenged(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    await _enroll_direct(db, seeded_user.id)
    resp = await _login(client)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "totp_verify"
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "auth", AuditLog.entity_id == str(seeded_user.id),
        AuditLog.action == "login_challenged"))).all()
    assert len(audits) == 1
    assert audits[0].changes == {"purpose": "verify"}


async def test_required_unenrolled_user_gets_enroll_challenge(client, db, seeded_user):
    await _security(db, two_factor_enabled=True, two_factor_required=True)
    resp = await _login(client)
    assert resp.json()["status"] == "totp_enroll"


async def test_not_required_unenrolled_user_gets_session(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    resp = await _login(client)
    assert resp.json()["status"] == "ok"
    assert resp.json()["totp"] == {"enrolled": False, "enrolled_at": None,
                                   "required": False, "backup_codes_remaining": 0}


async def test_kiosk_client_is_never_challenged(client, db, seeded_user):
    from serversherpa.db.models import RolePermission

    has_kiosk = await db.scalar(select(RolePermission).where(
        RolePermission.role == "staff", RolePermission.resource == "kiosk",
        RolePermission.action == "view"))
    if has_kiosk is None:
        db.add(RolePermission(role="staff", resource="kiosk", action="view"))
        await db.commit()
    await _security(db, two_factor_enabled=True, two_factor_required=True)
    await _enroll_direct(db, seeded_user.id)
    resp = await _login(client, client="kiosk")
    assert resp.status_code == 200 and resp.json()["status"] == "ok"
    # ...and this is why the exemption is safe: the session it hands back
    # is kiosk-scoped, so the self-asserted "client" field buys nothing
    # but the kiosk routes.
    denied = await client.get("/users", headers={
        "Authorization": f"Bearer {resp.json()['access_token']}"})
    assert denied.status_code == 403, denied.text
    assert denied.json()["detail"]["code"] == "kiosk_session"


async def test_wrong_password_still_401_when_enrolled(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    await _enroll_direct(db, seeded_user.id)
    resp = await _login(client, password="nope")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "invalid_credentials"


# ── verify ──────────────────────────────────────────────────────────

async def _challenge(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    secret, codes = await _enroll_direct(db, seeded_user.id)
    token = (await _login(client)).json()["challenge_token"]
    return secret, codes, token


async def test_verify_right_code_mints_session(client, db, seeded_user):
    secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": _next_code(secret)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok" and body["access_token"]
    assert "ss_refresh" in resp.cookies and "ss_trust" not in resp.cookies
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200 and me.json()["totp"]["enrolled"] is True


async def test_verify_wrong_code_401_and_counts_toward_lockout(client, db, seeded_user):
    _secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": "000000"})
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "totp_invalid"
    account = await db.get(UserAccount, seeded_user.id)
    await db.refresh(account)
    assert account.failed_login_count == 1


async def test_verify_with_backup_code(client, db, seeded_user):
    _secret, codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": codes[3]})
    assert resp.status_code == 200 and resp.json()["totp"]["backup_codes_remaining"] == 7


async def test_remember_sets_trust_cookie_and_next_login_skips_code(client, db, seeded_user):
    secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": _next_code(secret), "remember": True})
    assert resp.status_code == 200 and "ss_trust" in resp.cookies
    trust = resp.cookies["ss_trust"]

    # the cookie itself: HttpOnly, SameSite=lax, scoped to /auth, and good
    # for totp_trust_days (7 under tests) — no Secure assertion, since
    # tests run with env=development and Secure is omitted there.
    set_cookie = next(v for v in resp.headers.get_list("set-cookie")
                      if v.startswith("ss_trust="))
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie
    assert "Path=/auth" in set_cookie
    assert "Max-Age=604800" in set_cookie

    # a fresh login on the same browser (the client jar now holds ss_trust): no challenge
    again = await client.post("/auth/login", json={"email": EMAIL, "password": PW})
    assert again.json()["status"] == "ok"
    # logging out must not clear the trust cookie — only the session
    logout = await client.post("/auth/logout")
    assert logout.status_code == 204
    assert client.cookies.get("ss_trust") == trust
    # but wipe it by hand, and the next login is challenged again
    client.cookies.delete("ss_trust")
    bare = await client.post("/auth/login", json={"email": EMAIL, "password": PW})
    assert bare.json()["status"] == "totp_verify"
    # an expired trust row no longer helps
    row = await db.scalar(select(TrustedDevice).where(TrustedDevice.person_id == seeded_user.id))
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    client.cookies.set("ss_trust", trust, domain="testserver", path="/auth")
    stale = await client.post("/auth/login", json={"email": EMAIL, "password": PW})
    assert stale.json()["status"] == "totp_verify"


async def test_verify_unreadable_seed_is_409_not_500(client, db, seeded_user, monkeypatch):
    """decrypt_secret raises RuntimeError when the stored blob doesn't
    decrypt (encryption key rotated/lost) — that must surface as a 409,
    not bubble up as an unhandled 500."""
    _secret, _codes, token = await _challenge(client, db, seeded_user)

    def _boom(_blob):
        raise RuntimeError("stored TOTP seed does not decrypt with SS_TOTP_ENCRYPTION_KEY")

    monkeypatch.setattr(totp_service, "decrypt_secret", _boom)
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": "123456"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "totp_seed_unreadable"


async def test_challenge_token_is_not_an_access_token(client, db, seeded_user):
    _secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401


async def test_forged_expired_and_wrong_purpose_tokens_401(client, db, seeded_user):
    secret, _codes, token = await _challenge(client, db, seeded_user)
    bad = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token + "x"},
                            json={"code": _next_code(secret)})
    assert bad.status_code == 401 and bad.json()["detail"]["code"] == "invalid_challenge"
    enroll_tok = totp_service.make_challenge_token(seeded_user.id, "enroll")
    wrong = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": enroll_tok},
                              json={"code": _next_code(secret)})
    assert wrong.status_code == 401 and wrong.json()["detail"]["code"] == "invalid_challenge"
    missing = await client.post("/auth/totp/verify", json={"code": "123456"})
    assert missing.status_code == 401 and missing.json()["detail"]["code"] == "missing_token"


# ── enrollment via challenge (forced at login) ──────────────────────

async def test_forced_enrollment_flow_mints_session(client, db, seeded_user):
    await _security(db, two_factor_enabled=True, two_factor_required=True)
    token = (await _login(client)).json()["challenge_token"]
    hdrs = {"X-Totp-Challenge": token}
    start = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert start.status_code == 200, start.text
    secret = start.json()["secret"]
    assert start.json()["otpauth_uri"].startswith("otpauth://totp/ServerSherpa:")
    # a second start replaces the pending seed
    start2 = await client.post("/auth/totp/enroll/start", headers=hdrs)
    secret = start2.json()["secret"]
    bad = await client.post("/auth/totp/enroll/confirm", headers=hdrs, json={"code": "000000"})
    assert bad.status_code == 401 and bad.json()["detail"]["code"] == "totp_invalid"
    good = await client.post("/auth/totp/enroll/confirm", headers=hdrs,
                             json={"code": pyotp.TOTP(secret).now(), "remember": True})
    assert good.status_code == 200, good.text
    body = good.json()
    assert len(body["backup_codes"]) == 8
    assert body["session"]["status"] == "ok" and body["session"]["totp"]["enrolled"] is True
    assert "ss_refresh" in good.cookies and "ss_trust" in good.cookies
    # the challenge token is spent: the account is enrolled now
    spent = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert spent.status_code == 401 and spent.json()["detail"]["code"] == "invalid_challenge"


async def test_verify_challenge_cannot_enroll(client, db, seeded_user):
    _secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/enroll/start", headers={"X-Totp-Challenge": token})
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "invalid_challenge"


# ── enrollment via session (My Profile) ─────────────────────────────

async def test_self_service_enrollment_no_new_session(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    login = await _login(client)
    hdrs = {"Authorization": f"Bearer {login.json()['access_token']}"}
    start = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert start.status_code == 200, start.text
    secret = start.json()["secret"]
    good = await client.post("/auth/totp/enroll/confirm", headers=hdrs,
                             json={"code": pyotp.TOTP(secret).now()})
    assert good.status_code == 200 and good.json()["session"] is None
    assert "ss_refresh" not in good.cookies
    me = await client.get("/auth/me", headers=hdrs)
    assert me.json()["totp"]["enrolled"] is True
    again = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert again.status_code == 409 and again.json()["detail"]["code"] == "totp_already_enrolled"


async def test_forced_password_change_blocks_self_service_enroll(client, db, seeded_user):
    """A temp-password session must change its password before it can
    enroll in 2FA or regenerate backup codes from My Profile — the
    /auth/totp/* sign-in routes are read-only-exempt but not forced-
    change-exempt."""
    await _security(db, two_factor_enabled=True)
    login = await _login(client)
    hdrs = {"Authorization": f"Bearer {login.json()['access_token']}"}
    account = await db.get(UserAccount, seeded_user.id)
    account.must_change_password = True
    await db.commit()
    resp = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "password_change_required"


async def test_enrollment_refused_when_switch_off(client, db, seeded_user):
    login = await _login(client)
    hdrs = {"Authorization": f"Bearer {login.json()['access_token']}"}
    resp = await client.post("/auth/totp/enroll/start", headers=hdrs)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "totp_disabled"


async def test_regenerate_needs_a_current_code(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    secret, codes = await _enroll_direct(db, seeded_user.id)
    token = (await _login(client)).json()["challenge_token"]
    sess = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": _next_code(secret)})
    hdrs = {"Authorization": f"Bearer {sess.json()['access_token']}"}
    bad = await client.post("/auth/totp/backup-codes/regenerate", headers=hdrs,
                            json={"code": "000000"})
    assert bad.status_code == 401

    # verify_code accepts a backup code too, and the schema field is now
    # wide enough (16 chars) to hold a formatted one ("XXXXX-XXXXX" = 11) —
    # an unused backup code works as the "current code" for regeneration.
    good = await client.post("/auth/totp/backup-codes/regenerate", headers=hdrs,
                             json={"code": codes[1]})
    assert good.status_code == 200, good.text
    assert len(good.json()["backup_codes"]) == 8
    assert not set(good.json()["backup_codes"]) & set(codes)

    # regenerating retires the old codes: a second regenerate with another
    # stale code from the original batch now fails.
    stale = await client.post("/auth/totp/backup-codes/regenerate", headers=hdrs,
                              json={"code": codes[2]})
    assert stale.status_code == 401
