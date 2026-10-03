"""/auth/password-reset/* over HTTP: enumeration parity, the full
email-on flow (incl. 2FA still required after reset), rate limits."""

from sqlalchemy import select

from serversherpa.db.models import EmailOutbox, UserAccount

from tests.test_totp_api import _enroll_direct, _security

EMAIL = "alice@test.example.com"


async def _request(client, email=EMAIL):
    return await client.post("/auth/password-reset/request", json={"email": email})


async def _latest_raw(db):
    db.expire_all()
    row = (await db.scalars(select(EmailOutbox).where(EmailOutbox.template == "password_reset")
                            .order_by(EmailOutbox.created_at.desc()))).first()
    return row.text_body.split("#token=")[1].split()[0]


async def test_request_responses_are_identical(client, db, seeded_user, email_on):
    real = await _request(client)
    missing = await _request(client, "nobody@test.example.com")
    account = await db.get(UserAccount, seeded_user.id)
    from datetime import UTC, datetime
    account.disabled_at = datetime.now(UTC)
    await db.commit()
    disabled = await _request(client)
    for resp in (real, missing, disabled):
        assert resp.status_code == 202
        assert resp.content == real.content == b'{"status":"accepted"}'


async def test_request_parity_when_email_off(client, db, seeded_user):
    real = await _request(client)
    missing = await _request(client, "nobody@test.example.com")
    assert real.status_code == missing.status_code == 202
    assert real.content == missing.content


async def test_full_flow_requires_2fa_at_next_sign_in(client, db, seeded_user, email_on):
    await _security(db, two_factor_enabled=True)
    await _enroll_direct(db, seeded_user.id)
    await _request(client)
    raw = await _latest_raw(db)

    check = await client.post("/auth/password-reset/check", json={"token": raw})
    assert check.json() == {"valid": True}
    done = await client.post("/auth/password-reset/confirm",
                             json={"token": raw, "new_password": "BrandNewPass9!"})
    assert done.status_code == 204, done.text

    reused = await client.post("/auth/password-reset/confirm",
                               json={"token": raw, "new_password": "AnotherPass9!x"})
    assert reused.status_code == 400 and reused.json()["detail"]["code"] == "reset_token_invalid"
    assert (await client.post("/auth/password-reset/check", json={"token": raw})).json() == {"valid": False}

    old = await client.post("/auth/login", json={"email": EMAIL, "password": "CorrectHorse9!"})
    assert old.status_code == 401
    new = await client.post("/auth/login", json={"email": EMAIL, "password": "BrandNewPass9!"})
    assert new.status_code == 200 and new.json()["status"] == "totp_verify"


async def test_confirm_enforces_length_and_history(client, db, seeded_user, email_on):
    # the reuse rule is part of the password-expiry policy: it only runs
    # while that policy is on (services/password_policy.assert_not_reused)
    await _security(db, password_expiry_enabled=True, password_history_count=3)
    await _request(client)
    raw = await _latest_raw(db)
    short = await client.post("/auth/password-reset/confirm",
                              json={"token": raw, "new_password": "x"})
    assert short.status_code == 422 and short.json()["detail"]["code"] == "password_too_short"
    same = await client.post("/auth/password-reset/confirm",
                             json={"token": raw, "new_password": "CorrectHorse9!"})
    assert same.status_code == 422 and same.json()["detail"]["code"] == "password_recently_used"
    # a refused attempt doesn't burn the link
    assert (await client.post("/auth/password-reset/check", json={"token": raw})).json() == {"valid": True}


async def test_bad_token_is_400(client, seeded_user):
    resp = await client.post("/auth/password-reset/confirm",
                             json={"token": "nope", "new_password": "BrandNewPass9!"})
    assert resp.status_code == 400 and resp.json()["detail"]["code"] == "reset_token_invalid"


async def test_request_rate_limit(client, seeded_user, monkeypatch):
    from serversherpa.api.routes import auth as auth_routes
    monkeypatch.setattr(auth_routes.reset_request_limiter, "limit", 2)
    codes = [(await _request(client, f"x{i}@test.example.com")).status_code for i in range(3)]
    assert codes == [202, 202, 429]


async def test_confirm_and_check_share_a_limit(client, seeded_user, monkeypatch):
    from serversherpa.api.routes import auth as auth_routes
    monkeypatch.setattr(auth_routes.reset_confirm_limiter, "limit", 2)
    a = await client.post("/auth/password-reset/check", json={"token": "t"})
    b = await client.post("/auth/password-reset/confirm", json={"token": "t", "new_password": "BrandNewPass9!"})
    c = await client.post("/auth/password-reset/check", json={"token": "t"})
    assert (a.status_code, b.status_code, c.status_code) == (200, 400, 429)
    assert c.json()["detail"]["code"] == "rate_limited"


async def test_status_reports_email_and_reset_settings(client, email_on):
    body = (await client.get("/system/status")).json()
    assert body["email_enabled"] is True
    assert body["password_reset_ttl_minutes"] == 15
    from serversherpa.config import get_settings
    assert body["password_min_length"] == get_settings().password_min_length


async def test_request_failure_still_answers_202(client, seeded_user, monkeypatch, caplog):
    from serversherpa.services import password_reset

    async def boom(*a, **k):
        raise RuntimeError("alice@test.example.com boom")

    monkeypatch.setattr(password_reset, "request_reset", boom)
    resp = await _request(client)
    assert resp.status_code == 202
    assert resp.content == b'{"status":"accepted"}'
    assert "alice@test.example.com" not in caplog.text


async def test_malformed_email_gets_the_same_202(client, seeded_user):
    resp = await _request(client, "not-an-email")
    assert resp.status_code == 202
    assert resp.content == b'{"status":"accepted"}'
