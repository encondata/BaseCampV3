"""Kiosk-scoped sessions.

A login that claims `client="kiosk"` skips the 2FA challenge, and that
field is self-asserted — anyone holding a password can send it. So the
session such a login mints must be worth no more than a kiosk: it may
reach `/kiosk/*`, the sign-in lifecycle and `/system/status`, and
nothing else. Kiosk pairing (the phone-approved claim) mints the same
kiosk-scoped session. Portal sessions are untouched.
"""

from sqlalchemy import select

from serversherpa.db.models import AuthSession
from tests.test_kiosk_pairing_api import _create, _poll
from tests.test_sites_api import login
from tests.test_totp_api import _enroll_direct, _security

EMAIL = "alice@test.example.com"
PW = "CorrectHorse9!"

# paths a kiosk session must never reach, one per gate they sit behind:
# an ordinary permission-guarded route, a self-service route, a 2FA route
# (which authenticates through totp_actor, not get_current_user), and an
# admin settings route
PORTAL_ONLY_GETS = ("/users", "/auth/me/sessions", "/system/security")


def _hdrs(resp):
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _kiosk_login(http_client):
    resp = await http_client.post(
        "/auth/login", json={"email": EMAIL, "password": PW, "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ok"
    return resp


async def _assert_kiosk_scoped(http_client, hdrs):
    for path in PORTAL_ONLY_GETS:
        resp = await http_client.get(path, headers=hdrs)
        assert resp.status_code == 403, (path, resp.text)
        assert resp.json()["detail"]["code"] == "kiosk_session", (path, resp.text)
    resp = await http_client.post("/auth/totp/enroll/start", headers=hdrs)
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "kiosk_session", resp.text


async def test_kiosk_login_is_still_exempt_from_the_challenge(client, db, seeded_user):
    """The exemption stands — this is what makes the scope necessary."""
    await _security(db, two_factor_enabled=True, two_factor_required=True)
    await _enroll_direct(db, seeded_user.id)
    await _kiosk_login(client)


async def test_kiosk_session_cannot_reach_portal_routes(client, db, seeded_user):
    await _security(db, two_factor_enabled=True, two_factor_required=True)
    await _enroll_direct(db, seeded_user.id)
    await _assert_kiosk_scoped(client, _hdrs(await _kiosk_login(client)))


async def test_kiosk_session_reaches_the_kiosk_routes(client, db, seeded_user):
    hdrs = _hdrs(await _kiosk_login(client))
    assert (await client.get("/auth/me", headers=hdrs)).status_code == 200
    assert (await client.get("/system/status", headers=hdrs)).status_code == 200
    beat = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": "kiosk-scope-1", "name": "Dock 9", "mode": "web"})
    assert beat.status_code == 200, beat.text


async def test_session_row_records_which_app_minted_it(client, db, seeded_user):
    await login(client)                       # portal
    await _kiosk_login(client)
    rows = (await db.scalars(select(AuthSession))).all()
    assert sorted(r.client for r in rows) == ["kiosk", "portal"]


async def test_refresh_keeps_the_kiosk_scope(client, db, seeded_user):
    resp = await _kiosk_login(client)
    assert "ss_refresh" in resp.cookies
    refreshed = await client.post("/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    await _assert_kiosk_scoped(client, _hdrs(refreshed))
    rows = (await db.scalars(select(AuthSession))).all()
    assert len(rows) == 2 and {r.client for r in rows} == {"kiosk"}


async def test_portal_session_is_not_scoped(client, db, seeded_user):
    """Regression guard: the gate is a no-op for a portal session."""
    hdrs = await login(client)
    assert (await client.get("/users", headers=hdrs)).status_code == 200
    assert (await client.get("/auth/me/sessions", headers=hdrs)).status_code == 200


async def test_pairing_claim_mints_a_kiosk_scoped_session(client, db, seeded_user):
    d = await _create(client)
    phone = await login(client)
    approve = await client.post(f"/kiosk/pair/{d['code']}/approve", headers=phone)
    assert approve.status_code == 204, approve.text
    body = (await _poll(client, d)).json()
    assert body["status"] == "approved"

    claimed = {"Authorization": f"Bearer {body['session']['access_token']}"}
    assert (await client.get("/auth/me", headers=claimed)).status_code == 200
    await _assert_kiosk_scoped(client, claimed)

    # the phone that approved it keeps its own, unscoped portal session
    assert (await client.get("/users", headers=phone)).status_code == 200
    rows = (await db.scalars(select(AuthSession))).all()
    assert sorted(r.client for r in rows) == ["kiosk", "portal"]
