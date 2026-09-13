"""Kiosk 'link with phone' pairing: unauthenticated create/poll on the
kiosk side, kiosk:view-gated info/approve/deny on the phone side, a
fresh session family minted for the approver at claim time."""

import re

from sqlalchemy import select, text

from serversherpa.config import get_settings
from serversherpa.db.models import AuditLog, AuthSession, KioskPairRequest
from serversherpa.services.kiosk_pairing import CODE_ALPHABET
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_sites_api import login
from tests.test_status_values_write import _make
from tests.test_system_admin_api import _admin

KIOSK = {"serial": "kiosk-web-11111111-2222-3333-4444-555555555555", "name": "Dock 3"}


async def _create(client, **over):
    resp = await client.post("/kiosk/pair", json={**KIOSK, **over})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _poll(client, d):
    return await client.post(f"/kiosk/pair/{d['code']}/poll",
                             json={"poll_token": d["poll_token"]})


async def test_create_returns_code_token_and_link(client, db):
    d = await _create(client)
    assert re.fullmatch(f"[{CODE_ALPHABET}]{{8}}", d["code"])
    assert len(d["poll_token"]) >= 32
    origin = get_settings().portal_origin.rstrip("/")
    assert d["link_url"] == f"{origin}/link/{d['code']}"
    row = await db.scalar(select(KioskPairRequest).where(KioskPairRequest.code == d["code"]))
    assert row.status == "pending"
    assert row.kiosk_name == "Dock 3"
    assert row.poll_token_hash != d["poll_token"]      # only the hash is stored
    assert row.ip_address                               # creator IP recorded


async def test_second_code_for_same_kiosk_denies_the_first(client, db):
    a = await _create(client)
    b = await _create(client)
    assert (await _poll(client, a)).json()["status"] == "denied"
    assert (await _poll(client, b)).json()["status"] == "pending"


async def test_ip_rate_limit(client, db):
    for i in range(30):
        await _create(client, serial=f"kiosk-web-{i:04d}")
    resp = await client.post("/kiosk/pair", json=KIOSK)
    assert resp.status_code == 429
    assert resp.json()["detail"]["code"] == "pair_rate_limited"


async def test_poll_wrong_token_and_unknown_code(client, db):
    d = await _create(client)
    bad = await client.post(f"/kiosk/pair/{d['code']}/poll", json={"poll_token": "nope"})
    assert bad.status_code == 403
    assert bad.json()["detail"]["code"] == "pair_forbidden"
    missing = await client.post("/kiosk/pair/ZZZZZZZZ/poll", json={"poll_token": "nope"})
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "pair_not_found"


async def test_phone_side_requires_kiosk_permission(client, db, seeded_user):
    d = await _create(client)
    cv = await _client_viewer(db, client, "cv@test.example.com")
    assert (await client.get(f"/kiosk/pair/{d['code']}", headers=cv)).status_code == 403
    assert (await client.post(f"/kiosk/pair/{d['code']}/approve", headers=cv)).status_code == 403
    assert (await client.post(f"/kiosk/pair/{d['code']}/deny", headers=cv)).status_code == 403
    assert (await client.get(f"/kiosk/pair/{d['code']}")).status_code == 401


async def test_info_accepts_dashed_lowercase_code(client, db, seeded_user):
    d = await _create(client)
    hdrs = await login(client)                       # alice, staff → kiosk:view
    dashed = d["code"][:4].lower() + "-" + d["code"][4:].lower()
    resp = await client.get(f"/kiosk/pair/{dashed}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["kiosk_name"] == "Dock 3"
    assert resp.json()["serial"] == KIOSK["serial"]
    assert resp.json()["status"] == "pending"
    assert (await client.get("/kiosk/pair/ABC", headers=hdrs)).status_code == 404


async def test_approve_then_poll_mints_a_fresh_session_for_the_approver(client, db, seeded_user):
    d = await _create(client)
    hdrs = await login(client)
    assert len((await db.scalars(select(AuthSession))).all()) == 1   # the phone's session

    assert (await client.post(f"/kiosk/pair/{d['code']}/approve", headers=hdrs)).status_code == 204
    resp = await _poll(client, d)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "approved"
    assert body["session"]["person"]["email"] == "alice@test.example.com"
    assert body["session"]["perms"]["kiosk"]["view"] is True
    assert "ss_refresh" in resp.cookies

    sessions = (await db.scalars(select(AuthSession))).all()
    assert len(sessions) == 2
    assert {s.person_id for s in sessions} == {seeded_user.id}
    assert len({s.family_id for s in sessions}) == 2                  # its own family

    me = await client.get("/auth/me", headers={
        "Authorization": f"Bearer {body['session']['access_token']}"})
    assert me.status_code == 200

    again = (await _poll(client, d)).json()                            # one-shot
    assert again["status"] == "expired" and again["session"] is None

    actions = {a.action for a in (await db.scalars(select(AuditLog).where(
        AuditLog.action.in_(["kiosk_pair_approved", "login_pair"])))).all()}
    assert actions == {"kiosk_pair_approved", "login_pair"}


async def test_deny_then_approve_is_409(client, db, seeded_user):
    d = await _create(client)
    hdrs = await login(client)
    assert (await client.post(f"/kiosk/pair/{d['code']}/deny", headers=hdrs)).status_code == 204
    resp = await client.post(f"/kiosk/pair/{d['code']}/approve", headers=hdrs)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "pair_not_pending"
    assert (await _poll(client, d)).json()["status"] == "denied"
    assert (await db.scalar(select(AuditLog).where(
        AuditLog.action == "kiosk_pair_denied"))) is not None


async def test_expired_code(client, db, seeded_user):
    d = await _create(client)
    hdrs = await login(client)
    await db.execute(text("UPDATE kiosk_pair_requests SET expires_at = now() - interval '1 second'"))
    await db.commit()
    assert (await client.get(f"/kiosk/pair/{d['code']}", headers=hdrs)).json()["status"] == "expired"
    assert (await client.post(f"/kiosk/pair/{d['code']}/approve", headers=hdrs)).status_code == 409
    assert (await _poll(client, d)).json()["status"] == "expired"


async def test_approver_disabled_before_claim_is_denied(client, db, seeded_user):
    d = await _create(client)
    hdrs = await login(client)
    await client.post(f"/kiosk/pair/{d['code']}/approve", headers=hdrs)
    await db.execute(text("UPDATE user_accounts SET disabled_at = now() WHERE person_id = :p"),
                     {"p": seeded_user.id})
    await db.commit()
    resp = await _poll(client, d)
    assert resp.json()["status"] == "denied"
    assert "ss_refresh" not in resp.cookies
    assert len((await db.scalars(select(AuthSession))).all()) == 1


async def test_pairing_survives_read_only_mode(client, db, seeded_user):
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200
    staff = await _make(db, client, "staff", "st@test.example.com")
    d = await _create(client)
    assert (await client.post(f"/kiosk/pair/{d['code']}/approve", headers=staff)).status_code == 204
    assert (await _poll(client, d)).json()["status"] == "approved"
