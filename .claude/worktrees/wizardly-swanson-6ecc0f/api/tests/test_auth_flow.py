"""End-to-end auth flow tests over the HTTP API (real Postgres underneath)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text

from serversherpa.db.models import AuthSession

LOGIN = {"email": "alice@test.example.com", "password": "CorrectHorse9!"}


async def _login(client, **overrides):
    return await client.post("/auth/login", json={**LOGIN, **overrides})


# ── login ──────────────────────────────────────────────────────────


async def test_login_success_returns_tokens_roles_and_cookie(client, seeded_user):
    resp = await _login(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["person"]["display_name"] == "Alice Anderson"
    assert body["roles"] == ["staff"]
    assert body["access_token"]
    assert "ss_refresh" in resp.cookies
    # 24h absolute deadline (SS_SESSION_TTL_SECONDS=86400 in dev .env)
    deadline = datetime.fromisoformat(body["session_expires_at"])
    hours = (deadline - datetime.now(UTC)).total_seconds() / 3600
    assert 23.9 < hours <= 24.1


async def test_login_unknown_email_and_wrong_password_same_error(client, seeded_user):
    r1 = await _login(client, email="nobody@test.example.com")
    r2 = await _login(client, password="wrong-password")
    assert r1.status_code == r2.status_code == 401
    assert r1.json()["detail"]["code"] == r2.json()["detail"]["code"] == "invalid_credentials"


async def test_lockout_after_repeated_failures(client, seeded_user):
    for _ in range(10):
        resp = await _login(client, password="wrong-password")
        assert resp.status_code == 401
    resp = await _login(client)  # correct password, but now locked
    assert resp.status_code == 423
    assert resp.json()["detail"]["code"] == "account_locked"


async def test_disabled_account_cannot_login(client, seeded_user, db):
    await db.execute(text("UPDATE user_accounts SET disabled_at = now()"))
    await db.commit()
    resp = await _login(client)
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "account_disabled"


# ── authenticated requests ─────────────────────────────────────────


async def test_me_with_valid_token(client, seeded_user):
    token = (await _login(client)).json()["access_token"]
    resp = await client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["roles"] == ["staff"]


async def test_me_without_or_with_garbage_token(client, seeded_user):
    assert (await client.get("/auth/me")).status_code == 401
    resp = await client.get("/auth/me", headers={"Authorization": "Bearer garbage"})
    assert resp.status_code == 401


# ── refresh rotation & the 24h absolute deadline ───────────────────


async def test_refresh_rotates_and_inherits_absolute_deadline(client, seeded_user, db):
    login_body = (await _login(client)).json()
    deadline_at_login = login_body["session_expires_at"]

    resp = await client.post("/auth/refresh")
    assert resp.status_code == 200
    body = resp.json()
    assert body["access_token"]
    # the new access token works
    me = await client.get(
        "/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200
    # ABSOLUTE session rule: refresh must NOT extend the deadline
    assert body["session_expires_at"] == deadline_at_login

    rows = (await db.scalars(select(AuthSession))).all()
    assert len(rows) == 2
    old = next(r for r in rows if r.rotated_at is not None)
    new = next(r for r in rows if r.rotated_at is None)
    assert old.replaced_by == new.id
    assert old.family_id == new.family_id
    assert new.expires_at == old.expires_at


async def test_replayed_refresh_token_revokes_whole_family(client, seeded_user, db):
    await _login(client)
    stolen = client.cookies["ss_refresh"]

    assert (await client.post("/auth/refresh")).status_code == 200  # legit rotation

    client.cookies.set("ss_refresh", stolen, path="/auth")  # attacker replays
    resp = await client.post("/auth/refresh")
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "session_reuse_detected"

    # every session in the family is dead, including the legit successor
    rows = (await db.scalars(select(AuthSession))).all()
    assert len(rows) == 2
    assert all(r.revoked_at is not None for r in rows)
    assert all(r.revoke_reason == "reuse_detected" for r in rows)


async def test_expired_session_cannot_refresh(client, seeded_user, db):
    await _login(client)
    await db.execute(text("UPDATE auth_sessions SET expires_at = now() - interval '1 minute'"))
    await db.commit()
    resp = await client.post("/auth/refresh")
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "session_expired"


async def test_refresh_without_cookie(client):
    resp = await client.post("/auth/refresh")
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "missing_refresh"


# ── logout & revocation taking effect ──────────────────────────────


async def test_logout_revokes_family_and_kills_access_token(client, seeded_user, db):
    token = (await _login(client)).json()["access_token"]

    resp = await client.post("/auth/logout")
    assert resp.status_code == 204

    row = (await db.scalars(select(AuthSession))).one()
    assert row.revoke_reason == "logout"

    # access token is rejected immediately (session check in deps)
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 401
    assert me.json()["detail"]["code"] == "session_ended"

    # and the refresh cookie is gone from the jar
    assert (await client.post("/auth/refresh")).status_code == 401
