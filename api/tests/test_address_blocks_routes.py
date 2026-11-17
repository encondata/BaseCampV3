"""Sign-in address blocks on the routes (SS-487, Task 3): which sign-in
outcomes count as failures, that the block check comes first on every
guarded route, and what never counts (refresh, station keys) or is never
stopped (sessions already signed in).

The test client's peer is loopback, which is exempt, so every call that
should count sends X-Forwarded-For with a documentation address.

Spec: docs/superpowers/specs/2026-11-10-sign-in-address-blocking-design.md"""
from sqlalchemy import func, select

from serversherpa.db.models import Device, SignInFailure
from serversherpa.services import station_keys
from serversherpa.services import totp as totp_service
from tests.test_kiosk_biometric_api import (  # noqa: F401 (attest is a fixture)
    _challenge,
    _enrolled,
    _sign,
    _sign_in,
    attest,
)
from tests.test_kiosk_station_key import SERIAL as STATION_SERIAL
from tests.test_kiosk_station_scans import _auth, _station
from tests.test_move_password_api import PW as MOVE_PW
from tests.test_move_password_api import _admin, _move, _set
from tests.test_totp_api import _enroll_direct, _security

ADDR = {"X-Forwarded-For": "203.0.113.7"}
OTHER = {"X-Forwarded-For": "203.0.113.8"}
EMAIL = "alice@test.example.com"
PW = "CorrectHorse9!"


async def _login(client, email=EMAIL, password=PW, headers=ADDR):
    return await client.post("/auth/login", headers=headers,
                             json={"email": email, "password": password})


async def _fail_logins(client, n, headers=ADDR, email="nobody@test.example.com"):
    for _ in range(n):
        r = await _login(client, email=email, password="wrong-wrong", headers=headers)
        assert r.status_code in (401, 423), r.text


def _blocked(resp, retry_after=3600):
    assert resp.status_code == 429, resp.text
    assert resp.json() == {"detail": {"code": "address_blocked", "retry_after": retry_after}}
    assert resp.headers["Retry-After"] == str(retry_after)


async def _failures(db) -> int:
    return await db.scalar(select(func.count()).select_from(SignInFailure))


# ── login ───────────────────────────────────────────────────────────

async def test_login_ten_wrong_passwords_blocks(client, db, seeded_user):
    await _fail_logins(client, 10, email=EMAIL)
    _blocked(await _login(client))


async def test_attempts_while_blocked_are_counted(client, db, seeded_user):
    from serversherpa.db.models import AddressBlock
    await _fail_logins(client, 10)
    for _ in range(8):
        r = await _login(client)
        assert r.status_code == 429 and r.json()["detail"]["code"] == "address_blocked"
    block = await db.get(AddressBlock, "203.0.113.7", populate_existing=True)
    assert block.attempts_while_blocked == 8
    assert block.last_attempt_at is not None
    assert await _failures(db) == 0  # turned away, never a failure row


async def test_unknown_account_failures_count(client, db, seeded_user):
    await _fail_logins(client, 9)
    assert await _failures(db) == 9
    await _fail_logins(client, 1)
    _blocked(await _login(client))


async def test_blocked_response_identical_for_existing_and_unknown_account(
        client, db, seeded_user):
    await _fail_logins(client, 10)
    real = await _login(client)
    made_up = await _login(client, email="made-up@test.example.com", password="whatever1")
    assert real.status_code == made_up.status_code == 429
    assert real.content == made_up.content
    assert real.headers["Retry-After"] == made_up.headers["Retry-After"] == "3600"


async def test_other_address_unaffected(client, db, seeded_user):
    await _fail_logins(client, 10)
    _blocked(await _login(client))
    r = await _login(client, headers=OTHER)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok"


async def test_successful_sign_ins_never_count(client, db, seeded_user):
    for _ in range(20):
        r = await _login(client)
        assert r.status_code == 200, r.text
    assert await _failures(db) == 0


async def test_blocked_address_keeps_existing_session(client, db, seeded_user):
    ok = await _login(client)
    assert ok.status_code == 200, ok.text
    bearer = {"Authorization": f"Bearer {ok.json()['access_token']}", **ADDR}
    await _fail_logins(client, 10)
    _blocked(await _login(client))
    me = await client.get("/auth/me", headers=bearer)
    assert me.status_code == 200, me.text


# ── two-factor ──────────────────────────────────────────────────────

async def test_totp_wrong_codes_count(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    await _enroll_direct(db, seeded_user.id)
    first = await _login(client)
    assert first.json()["status"] == "totp_verify", first.text
    token = first.json()["challenge_token"]
    for _ in range(10):
        r = await client.post("/auth/totp/verify", headers={**ADDR, "X-Totp-Challenge": token},
                              json={"code": "000000"})
        assert r.status_code in (401, 423), r.text
        assert r.json()["detail"]["code"] in ("totp_invalid", "account_locked")
    fresh = totp_service.make_challenge_token(seeded_user.id, "verify")
    _blocked(await client.post("/auth/totp/verify",
                               headers={**ADDR, "X-Totp-Challenge": fresh},
                               json={"code": "000000"}))
    # the block check runs ahead of the challenge check
    _blocked(await client.post("/auth/totp/verify", headers=ADDR, json={"code": "000000"}))


async def test_totp_invalid_challenge_never_counts(client, db, seeded_user):
    for _ in range(12):
        r = await client.post("/auth/totp/verify", headers=ADDR, json={"code": "000000"})
        assert r.status_code == 401, r.text
    assert await _failures(db) == 0


# ── move password ───────────────────────────────────────────────────

async def test_move_login_wrong_password_counts_and_block_precedes_cap(
        client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    await _set(client, admin, init)
    for _ in range(10):
        r = await client.post("/kiosk/move-login", headers=ADDR,
                              json={"password": "wrong-wrong"})
        assert r.status_code == 401 and r.json()["detail"]["code"] == "invalid_move_password"
    _blocked(await client.post("/kiosk/move-login", headers=ADDR, json={"password": MOVE_PW}))
    r = await client.post("/kiosk/move-login", headers=OTHER, json={"password": MOVE_PW})
    assert r.status_code == 200, r.text


async def test_move_login_inactive_move_never_counts(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db, status="completed")
    await _set(client, admin, init)
    for _ in range(11):
        r = await client.post("/kiosk/move-login", headers=ADDR, json={"password": MOVE_PW})
        assert r.status_code == 401 and r.json()["detail"]["code"] == "move_not_active"
    assert await _failures(db) == 0


# ── biometric ───────────────────────────────────────────────────────

async def test_biometric_bad_signature_counts(client, db, seeded_user, attest):  # noqa: F811
    _, _, key_id, key = await _enrolled(db, client, attest)
    junk = "AAAA"
    for _ in range(10):
        c = (await _challenge(client)).json()["challenge"]
        r = await client.post("/kiosk/biometric/sign-in", headers=ADDR, json={
            "key_id": key_id, "challenge": c, "signature": junk})
        assert r.status_code == 401 and r.json()["detail"]["code"] == "bad_signature"
    c = (await _challenge(client)).json()["challenge"]
    _blocked(await client.post("/kiosk/biometric/sign-in", headers=ADDR, json={
        "key_id": key_id, "challenge": c, "signature": _sign(key, c)}))
    # the loopback peer (no XFF) is never blocked
    c = (await _challenge(client)).json()["challenge"]
    assert (await _sign_in(client, key_id, c, _sign(key, c))).status_code == 200


async def test_biometric_spent_or_wrong_challenge_never_counts(
        client, db, seeded_user, attest):  # noqa: F811
    """bad_challenge (an expired, spent or another key's challenge) is not a
    wrong credential: only no_biometric and bad_signature count."""
    _, _, key_id, key = await _enrolled(db, client, attest)
    c = (await _challenge(client)).json()["challenge"]
    ok = await client.post("/kiosk/biometric/sign-in", headers=ADDR, json={
        "key_id": key_id, "challenge": c, "signature": _sign(key, c)})
    assert ok.status_code == 200, ok.text
    for _ in range(12):  # replay the spent challenge
        r = await client.post("/kiosk/biometric/sign-in", headers=ADDR, json={
            "key_id": key_id, "challenge": c, "signature": _sign(key, c)})
        assert r.status_code == 401 and r.json()["detail"]["code"] == "bad_challenge"
    assert await _failures(db) == 0


# ── password reset ──────────────────────────────────────────────────

async def test_reset_check_and_confirm_invalid_tokens_count(client, db, seeded_user):
    for _ in range(4):
        r = await client.post("/auth/password-reset/check", headers=ADDR,
                              json={"token": "not-a-real-token"})
        assert r.status_code == 200 and r.json()["valid"] is False
    r = await client.post("/auth/password-reset/check", headers=ADDR,
                          json={"token": "x" * 600})
    assert r.status_code == 200 and r.json()["valid"] is False
    for token in ["not-a-real-token"] * 4 + ["y" * 600]:
        r = await client.post("/auth/password-reset/confirm", headers=ADDR,
                              json={"token": token, "new_password": "Whatever-2026!"})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "reset_token_invalid"
    assert await _failures(db) == 0  # the blocking rows were deleted by the trip
    _blocked(await client.post("/auth/password-reset/check", headers=ADDR,
                               json={"token": "not-a-real-token"}))
    _blocked(await client.post("/auth/password-reset/confirm", headers=ADDR,
                               json={"token": "t", "new_password": "Whatever-2026!"}))


# ── never counted ───────────────────────────────────────────────────

async def test_refresh_and_station_heartbeat_never_count(client, db, seeded_user):
    for _ in range(15):
        r = await client.post("/auth/refresh", headers={
            **ADDR, "Cookie": "ss_refresh=bogus-refresh-token"})
        assert r.status_code == 401, r.text
    device, _, key = await _station(db)
    await station_keys.revoke(db, await db.get(Device, device.id), actor_id=None,
                              reason="test")
    await db.commit()
    for _ in range(15):
        r = await client.post("/kiosk/station/heartbeat", headers={**_auth(key), **ADDR},
                              json={"serial": STATION_SERIAL})
        assert r.status_code == 401, r.text
    assert await _failures(db) == 0
    assert (await _login(client)).status_code == 200
