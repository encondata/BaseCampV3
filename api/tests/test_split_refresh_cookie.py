"""Portal and kiosk sessions keep separate refresh cookies.

Kiosk sessions keep `ss_refresh` (the Android/iOS apps and the laptop edge
read it by name); portal sessions use `ss_portal_refresh`. `/auth/refresh`
and `/auth/logout` take an optional `client` query parameter; when it is
given, a session that belongs to the other app is refused (401
`wrong_client`) and left completely alone — no rotation, no revocation, no
reuse-detection family kill, and its cookie is not cleared. Without the
parameter both routes behave exactly as before, on `ss_refresh`.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update

from serversherpa.db.models import AuthSession
from tests.test_kiosk_pairing_api import _create, _poll
from tests.test_move_password_api import _admin as _move_admin
from tests.test_move_password_api import _move, _move_login, _set
from tests.test_sites_api import login
from tests.test_totp_api import _challenge, _next_code

EMAIL = "alice@test.example.com"
PW = "CorrectHorse9!"
PORTAL = "ss_portal_refresh"
KIOSK = "ss_refresh"


async def _portal_login(client):
    resp = await client.post("/auth/login", json={"email": EMAIL, "password": PW})
    assert resp.status_code == 200, resp.text
    return resp


async def _kiosk_login(client):
    resp = await client.post(
        "/auth/login", json={"email": EMAIL, "password": PW, "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    return resp


def _set_cookies(resp) -> dict[str, str]:
    """Set-Cookie headers on a response, by cookie name."""
    out = {}
    for header in resp.headers.get_list("set-cookie"):
        out[header.split("=", 1)[0]] = header
    return out


def _cleared(header: str) -> bool:
    return "Max-Age=0" in header or 'max-age=0' in header.lower()


def _jar_cookie(client, name):
    found = [c for c in client.cookies.jar if c.name == name]
    return found[0] if found else None


def _move_cookie(client, src, dst):
    """Re-file a jar cookie under another name (a legacy browser jar)."""
    cookie = _jar_cookie(client, src)
    assert cookie is not None, src
    client.cookies.delete(src)
    client.cookies.set(dst, cookie.value, domain=cookie.domain, path="/auth")


def _hdrs(resp):
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _is_portal_session(client, resp) -> bool:
    """A portal token reaches /users; a kiosk token is refused there."""
    r = await client.get("/users", headers=_hdrs(resp))
    if r.status_code == 403:
        assert r.json()["detail"]["code"] == "kiosk_session", r.text
        return False
    assert r.status_code == 200, r.text
    return True


async def _rows(db):
    db.expire_all()
    return (await db.scalars(select(AuthSession))).all()


# ── which cookie each sign-in sets ──────────────────────────────────


async def test_portal_login_sets_the_portal_cookie_only(client, db, seeded_user):
    resp = await _portal_login(client)
    cookies = _set_cookies(resp)
    assert PORTAL in cookies and KIOSK not in cookies
    header = cookies[PORTAL]
    assert "HttpOnly" in header and "SameSite=lax" in header and "Path=/auth" in header


async def test_kiosk_login_sets_the_kiosk_cookie_only(client, db, seeded_user):
    cookies = _set_cookies(await _kiosk_login(client))
    assert KIOSK in cookies and PORTAL not in cookies


async def test_pair_poll_sets_the_kiosk_cookie(client, db, seeded_user):
    d = await _create(client)
    phone = await login(client)
    client.cookies.clear()
    assert (await client.post(f"/kiosk/pair/{d['code']}/approve", headers=phone)).status_code == 204
    resp = await _poll(client, d)
    assert resp.status_code == 200 and resp.json()["status"] == "approved", resp.text
    cookies = _set_cookies(resp)
    assert KIOSK in cookies and PORTAL not in cookies


async def test_move_login_sets_the_kiosk_cookie(client, db, seeded_user):
    admin = await _move_admin(db, client)
    await _set(client, admin, await _move(db))
    client.cookies.clear()
    resp = await _move_login(client)
    assert resp.status_code == 200, resp.text
    cookies = _set_cookies(resp)
    assert KIOSK in cookies and PORTAL not in cookies


async def test_two_factor_session_sets_the_portal_cookie(client, db, seeded_user):
    secret, _codes, token = await _challenge(client, db, seeded_user)
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": _next_code(secret)})
    assert resp.status_code == 200, resp.text
    cookies = _set_cookies(resp)
    assert PORTAL in cookies and KIOSK not in cookies


# ── refresh with both apps signed in in one browser ─────────────────


async def test_both_cookies_each_client_gets_its_own_session(client, db, seeded_user):
    await _portal_login(client)
    await _kiosk_login(client)
    assert _jar_cookie(client, PORTAL) and _jar_cookie(client, KIOSK)

    portal = await client.post("/auth/refresh?client=portal")
    assert portal.status_code == 200, portal.text
    assert await _is_portal_session(client, portal)
    cookies = _set_cookies(portal)
    assert PORTAL in cookies and not _cleared(cookies[PORTAL]) and KIOSK not in cookies

    kiosk = await client.post("/auth/refresh?client=kiosk")
    assert kiosk.status_code == 200, kiosk.text
    assert not await _is_portal_session(client, kiosk)
    cookies = _set_cookies(kiosk)
    assert KIOSK in cookies and not _cleared(cookies[KIOSK]) and PORTAL not in cookies

    # one rotation per family, nothing revoked
    rows = await _rows(db)
    assert len(rows) == 4 and all(r.revoked_at is None for r in rows)
    assert sorted(r.client for r in rows if r.rotated_at is not None) == ["kiosk", "portal"]


async def test_portal_refresh_with_only_a_kiosk_cookie_is_refused_and_harmless(
        client, db, seeded_user):
    await _kiosk_login(client)
    resp = await client.post("/auth/refresh?client=portal")
    assert resp.status_code == 401
    assert resp.json()["detail"] == {"code": "wrong_client"}
    assert KIOSK not in _set_cookies(resp)         # the kiosk's cookie is not cleared
    rows = await _rows(db)
    assert len(rows) == 1
    assert rows[0].rotated_at is None and rows[0].revoked_at is None

    # the kiosk session is still alive, by name and without a parameter
    again = await client.post("/auth/refresh?client=kiosk")
    assert again.status_code == 200, again.text
    assert not await _is_portal_session(client, again)
    assert (await client.post("/auth/refresh")).status_code == 200


async def test_mismatch_never_triggers_reuse_detection(client, db, seeded_user):
    """A rotated kiosk token presented by the portal is the kiosk's problem,
    not the portal's: the guard runs before reuse detection, so the kiosk's
    family survives."""
    await _kiosk_login(client)
    stale = _jar_cookie(client, KIOSK).value
    assert (await client.post("/auth/refresh?client=kiosk")).status_code == 200
    live = _jar_cookie(client, KIOSK)
    live_value, domain = live.value, live.domain

    client.cookies.delete(KIOSK)
    client.cookies.set(KIOSK, stale, domain=domain, path="/auth")
    resp = await client.post("/auth/refresh?client=portal")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "wrong_client"
    rows = await _rows(db)
    assert all(r.revoked_at is None for r in rows)

    client.cookies.delete(KIOSK)
    client.cookies.set(KIOSK, live_value, domain=domain, path="/auth")
    assert (await client.post("/auth/refresh?client=kiosk")).status_code == 200


async def test_kiosk_refresh_never_adopts_a_portal_session(client, db, seeded_user):
    await _portal_login(client)
    # only the portal cookie: the kiosk has nothing to refresh
    missing = await client.post("/auth/refresh?client=kiosk")
    assert missing.status_code == 401
    assert missing.json()["detail"]["code"] == "missing_refresh"
    # a legacy portal session filed under ss_refresh: refused, untouched
    _move_cookie(client, PORTAL, KIOSK)
    resp = await client.post("/auth/refresh?client=kiosk")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "wrong_client"
    assert KIOSK not in _set_cookies(resp)
    rows = await _rows(db)
    assert len(rows) == 1 and rows[0].rotated_at is None and rows[0].revoked_at is None


async def test_portal_refresh_without_any_cookie(client, db, seeded_user):
    resp = await client.post("/auth/refresh?client=portal")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "missing_refresh"


# ── the legacy fallback (a portal signed in before the split) ───────


async def test_legacy_portal_cookie_moves_to_the_portal_cookie(client, db, seeded_user):
    await _portal_login(client)
    _move_cookie(client, PORTAL, KIOSK)
    resp = await client.post("/auth/refresh?client=portal")
    assert resp.status_code == 200, resp.text
    assert await _is_portal_session(client, resp)
    cookies = _set_cookies(resp)
    assert PORTAL in cookies and not _cleared(cookies[PORTAL])
    assert KIOSK in cookies and _cleared(cookies[KIOSK])
    assert _jar_cookie(client, KIOSK) is None and _jar_cookie(client, PORTAL) is not None
    # and the next refresh runs on the new cookie
    assert (await client.post("/auth/refresh?client=portal")).status_code == 200


async def test_failed_legacy_portal_refresh_clears_the_legacy_cookie(client, db, seeded_user):
    await _portal_login(client)
    _move_cookie(client, PORTAL, KIOSK)
    await db.execute(update(AuthSession).values(
        expires_at=datetime.now(UTC) - timedelta(minutes=1)))
    await db.commit()
    resp = await client.post("/auth/refresh?client=portal")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "session_expired"
    assert _cleared(_set_cookies(resp)[KIOSK])


async def test_failed_portal_refresh_clears_only_the_portal_cookie(client, db, seeded_user):
    await _portal_login(client)
    await _kiosk_login(client)
    await db.execute(update(AuthSession).where(AuthSession.client == "portal").values(
        expires_at=datetime.now(UTC) - timedelta(minutes=1)))
    await db.commit()
    resp = await client.post("/auth/refresh?client=portal")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "session_expired"
    cookies = _set_cookies(resp)
    assert _cleared(cookies[PORTAL]) and KIOSK not in cookies
    # no fallback to the kiosk's cookie, and the kiosk is fine
    assert (await client.post("/auth/refresh?client=kiosk")).status_code == 200


# ── no parameter: exactly the old behavior on ss_refresh ────────────


async def test_no_parameter_refreshes_ss_refresh_as_before(client, db, seeded_user):
    await _kiosk_login(client)
    resp = await client.post("/auth/refresh")
    assert resp.status_code == 200, resp.text
    cookies = _set_cookies(resp)
    assert KIOSK in cookies and PORTAL not in cookies
    # an old portal bundle with a legacy cookie keeps it under ss_refresh
    client.cookies.clear()
    await _portal_login(client)
    _move_cookie(client, PORTAL, KIOSK)
    resp = await client.post("/auth/refresh")
    assert resp.status_code == 200, resp.text
    assert await _is_portal_session(client, resp)
    cookies = _set_cookies(resp)
    assert KIOSK in cookies and not _cleared(cookies[KIOSK]) and PORTAL not in cookies
    assert (await client.post("/auth/refresh")).status_code == 200


async def test_no_parameter_ignores_the_portal_cookie(client, db, seeded_user):
    await _portal_login(client)
    resp = await client.post("/auth/refresh")
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "missing_refresh"


async def test_bad_client_value_is_422(client, db, seeded_user):
    await _portal_login(client)
    assert (await client.post("/auth/refresh?client=wiki")).status_code == 422
    assert (await client.post("/auth/logout?client=wiki")).status_code == 422
    rows = await _rows(db)
    assert len(rows) == 1 and rows[0].rotated_at is None and rows[0].revoked_at is None


# ── logout per client ───────────────────────────────────────────────


async def test_logout_per_client_ends_and_clears_only_its_own(client, db, seeded_user):
    await _portal_login(client)
    await _kiosk_login(client)

    resp = await client.post("/auth/logout?client=kiosk")
    assert resp.status_code == 204
    cookies = _set_cookies(resp)
    assert _cleared(cookies[KIOSK]) and PORTAL not in cookies
    rows = {r.client: r for r in await _rows(db)}
    assert rows["kiosk"].revoke_reason == "logout" and rows["portal"].revoked_at is None
    assert (await client.post("/auth/refresh?client=portal")).status_code == 200

    resp = await client.post("/auth/logout?client=portal")
    assert resp.status_code == 204
    cookies = _set_cookies(resp)
    assert _cleared(cookies[PORTAL]) and KIOSK not in cookies
    assert all(r.revoked_at is not None for r in await _rows(db))


async def test_mismatched_logout_revokes_nothing(client, db, seeded_user):
    await _kiosk_login(client)
    resp = await client.post("/auth/logout?client=portal")
    assert resp.status_code == 204
    assert KIOSK not in _set_cookies(resp)
    rows = await _rows(db)
    assert len(rows) == 1 and rows[0].revoked_at is None
    assert (await client.post("/auth/refresh?client=kiosk")).status_code == 200

    # the mirror: a legacy portal session under ss_refresh survives a kiosk logout
    client.cookies.clear()
    await _portal_login(client)
    _move_cookie(client, PORTAL, KIOSK)
    resp = await client.post("/auth/logout?client=kiosk")
    assert resp.status_code == 204
    assert KIOSK not in _set_cookies(resp)
    portal_rows = [r for r in await _rows(db) if r.client == "portal"]
    assert len(portal_rows) == 1 and portal_rows[0].revoked_at is None
    assert (await client.post("/auth/refresh?client=portal")).status_code == 200


async def test_portal_logout_ends_a_legacy_portal_cookie(client, db, seeded_user):
    await _portal_login(client)
    _move_cookie(client, PORTAL, KIOSK)
    resp = await client.post("/auth/logout?client=portal")
    assert resp.status_code == 204
    assert _cleared(_set_cookies(resp)[KIOSK])
    rows = await _rows(db)
    assert len(rows) == 1 and rows[0].revoke_reason == "logout"


async def test_no_parameter_logout_is_unchanged(client, db, seeded_user):
    await _kiosk_login(client)
    resp = await client.post("/auth/logout")
    assert resp.status_code == 204
    cookies = _set_cookies(resp)
    assert _cleared(cookies[KIOSK]) and PORTAL not in cookies
    rows = await _rows(db)
    assert len(rows) == 1 and rows[0].revoke_reason == "logout"
