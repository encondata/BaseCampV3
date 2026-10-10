"""Remembered browsers: list and forget, self-service (/auth/me) and admin
(/users/{id}). Rows live in trusted_devices; forgetting sets revoked_at."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Person, TrustedDevice, UserAccount
from serversherpa.services import totp as totp_service
from tests.test_access_roles_api import login_admin
from tests.test_sites_api import login
from tests.test_status_values_write import _make
from tests.test_totp_api import _enroll_direct, _login, _next_code, _security
from tests.test_users_api import _add_user, _token

ME = "/auth/me/trusted-browsers"
UA_CHROME = "Mozilla/5.0 (Macintosh) Chrome/120"


def H(token):
    return {"Authorization": f"Bearer {token}"}


async def _remember(db, person_id, *, ua=UA_CHROME, age_minutes=0):
    """Issue a trusted-browser row and back-date it; return (token, row)."""
    account = await db.get(UserAccount, person_id)
    token = await totp_service.issue_trust(db, account, user_agent=ua, ip=None)
    row = await db.scalar(select(TrustedDevice).where(
        TrustedDevice.token_hash == totp_service.trust_token_hash(token)))
    if age_minutes:
        row.created_at = datetime.now(UTC) - timedelta(minutes=age_minutes)
        await db.commit()
    return token, row


async def _live(db, person_id):
    return list(await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == person_id, TrustedDevice.revoked_at.is_(None))))


async def _audit(db, action, person_id):
    return list(await db.scalars(select(AuditLog).where(
        AuditLog.action == action, AuditLog.entity_type == "user_account",
        AuditLog.entity_id == str(person_id))))


def _cleared(resp):
    """True when the response deletes ss_trust with the auth route's attributes."""
    for value in resp.headers.get_list("set-cookie"):
        if value.startswith("ss_trust="):
            return ("Max-Age=0" in value and "Path=/auth" in value
                    and "HttpOnly" in value and "SameSite=lax" in value)
    return False


# ── service helpers ─────────────────────────────────────────────────

def test_trust_token_hash_matches_stored_hash_and_handles_none():
    assert totp_service.trust_token_hash(None) is None
    assert totp_service.trust_token_hash("abc") == totp_service._hash_trust("abc")


# ── self-service list ───────────────────────────────────────────────

async def test_list_shows_only_my_remembered_rows_newest_first(client, db, seeded_user):
    other = await _add_user(db, first="Ot", last="Her", email="other@test.example.com",
                            role="staff")
    _t1, old = await _remember(db, seeded_user.id, ua="Old UA", age_minutes=30)
    _t2, new = await _remember(db, seeded_user.id, ua="New UA")
    _t3, expired = await _remember(db, seeded_user.id, ua="Expired UA")
    expired.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    _t4, revoked = await _remember(db, seeded_user.id, ua="Revoked UA")
    revoked.revoked_at = datetime.now(UTC)
    await _remember(db, other.id, ua="Theirs")
    await db.commit()

    hdrs = await login(client)
    resp = await client.get(ME, headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["trust_days"] == 7
    assert [b["id"] for b in body["browsers"]] == [str(new.id), str(old.id)]
    first = body["browsers"][0]
    assert set(first) == {"id", "user_agent", "created_at", "last_used_at",
                          "expires_at", "current"}
    assert first["user_agent"] == "New UA" and first["current"] is False
    assert "token_hash" not in resp.text


async def test_list_flags_the_current_browser_from_the_cookie(client, db, seeded_user):
    token, mine = await _remember(db, seeded_user.id, ua="This one")
    await _remember(db, seeded_user.id, ua="That one", age_minutes=5)
    hdrs = await login(client)
    client.cookies.set("ss_trust", token, domain="testserver.local", path="/auth")
    rows = (await client.get(ME, headers=hdrs)).json()["browsers"]
    assert {r["id"]: r["current"] for r in rows}[str(mine.id)] is True
    assert sum(r["current"] for r in rows) == 1


async def test_list_without_cookie_has_no_current_and_requires_login(client, db, seeded_user):
    await _remember(db, seeded_user.id)
    hdrs = await login(client)
    rows = (await client.get(ME, headers=hdrs)).json()["browsers"]
    assert rows and not any(r["current"] for r in rows)
    client.cookies.clear()
    assert (await client.get(ME)).status_code == 401


async def test_list_is_empty_when_nothing_is_remembered(client, db, seeded_user):
    body = (await client.get(ME, headers=await login(client))).json()
    assert body == {"trust_days": 7, "browsers": []}


# ── self-service forget one ─────────────────────────────────────────

async def test_forget_one_revokes_the_row_and_audits(client, db, seeded_user):
    _t, keep = await _remember(db, seeded_user.id, age_minutes=5)
    _t, gone = await _remember(db, seeded_user.id)
    hdrs = await login(client)
    resp = await client.delete(f"{ME}/{gone.id}", headers=hdrs)
    assert resp.status_code == 204, resp.text
    assert not _cleared(resp)  # not the current browser: cookie untouched
    await db.refresh(gone)
    assert gone.revoked_at is not None
    assert [r.id for r in await _live(db, seeded_user.id)] == [keep.id]
    rows = await _audit(db, "totp.trust_forget", seeded_user.id)
    assert len(rows) == 1
    assert rows[0].changes == {"trusted_browser_id": str(gone.id)}
    assert rows[0].actor_person_id == seeded_user.id
    # the row is kept, not deleted
    assert await db.get(TrustedDevice, gone.id) is not None


async def test_forget_one_404s_for_others_revoked_expired_and_unknown(client, db, seeded_user):
    other = await _add_user(db, first="Ot", last="Her", email="other@test.example.com",
                            role="staff")
    _t, theirs = await _remember(db, other.id)
    _t, revoked = await _remember(db, seeded_user.id)
    revoked.revoked_at = datetime.now(UTC)
    _t, expired = await _remember(db, seeded_user.id)
    expired.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    hdrs = await login(client)
    for target in (theirs.id, revoked.id, expired.id, uuid.uuid4()):
        resp = await client.delete(f"{ME}/{target}", headers=hdrs)
        assert resp.status_code == 404, (target, resp.text)
        assert resp.json()["detail"]["code"] == "trusted_browser_not_found"
    await db.refresh(theirs)
    assert theirs.revoked_at is None
    assert await _audit(db, "totp.trust_forget", seeded_user.id) == []


async def test_forgetting_the_current_browser_clears_the_cookie(client, db, seeded_user):
    token, mine = await _remember(db, seeded_user.id)
    hdrs = await login(client)
    client.cookies.set("ss_trust", token, domain="testserver.local", path="/auth")
    resp = await client.delete(f"{ME}/{mine.id}", headers=hdrs)
    assert resp.status_code == 204 and _cleared(resp)


# ── self-service forget all ─────────────────────────────────────────

async def test_forget_all_revokes_mine_only_clears_cookie_and_audits(client, db, seeded_user):
    other = await _add_user(db, first="Ot", last="Her", email="other@test.example.com",
                            role="staff")
    token, _ = await _remember(db, seeded_user.id)
    await _remember(db, seeded_user.id, age_minutes=5)
    _t, expired = await _remember(db, seeded_user.id, age_minutes=9)
    expired.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    await _remember(db, other.id)
    hdrs = await login(client)
    client.cookies.set("ss_trust", token, domain="testserver.local", path="/auth")
    resp = await client.delete(ME, headers=hdrs)
    assert resp.status_code == 204 and _cleared(resp)
    assert await _live(db, seeded_user.id) == []
    assert len(await _live(db, other.id)) == 1
    rows = await _audit(db, "totp.trust_forget_all", seeded_user.id)
    assert len(rows) == 1 and rows[0].changes == {"count": 2}  # expired row not counted
    assert rows[0].actor_person_id == seeded_user.id


async def test_forget_all_with_nothing_remembered_is_a_quiet_204(client, db, seeded_user):
    resp = await client.delete(ME, headers=await login(client))
    assert resp.status_code == 204
    assert await _audit(db, "totp.trust_forget_all", seeded_user.id) == []


# ── admin ───────────────────────────────────────────────────────────

def _adm(person_id):
    return f"/users/{person_id}/trusted-browsers"


async def test_admin_list_matches_shape_without_current(client, db, seeded_user):
    admin = await _make(db, client, "super_admin", "tb-admin@test.example.com")
    await _remember(db, seeded_user.id, ua="Old UA", age_minutes=20)
    _t, new = await _remember(db, seeded_user.id, ua="New UA")
    _t, expired = await _remember(db, seeded_user.id, ua="Expired UA")
    expired.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    resp = await client.get(_adm(seeded_user.id), headers=admin)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["trust_days"] == 7
    assert [b["user_agent"] for b in body["browsers"]] == ["New UA", "Old UA"]
    assert body["browsers"][0]["id"] == str(new.id)
    assert set(body["browsers"][0]) == {"id", "user_agent", "created_at",
                                        "last_used_at", "expires_at"}
    assert "token_hash" not in resp.text


async def test_admin_list_visibility_and_missing_rows(client, db, seeded_user):
    await _remember(db, seeded_user.id)
    # a worker has no users:view -> 403, same as GET /users/{id}
    await _add_user(db, first="Wan", last="Worker", email="wan@test.example.com", role="worker")
    wan = H(await _token(client, email="wan@test.example.com"))
    assert (await client.get(f"/users/{seeded_user.id}", headers=wan)).status_code == 403
    assert (await client.get(_adm(seeded_user.id), headers=wan)).status_code == 403
    # staff can view; unknown person / no account -> 404 user_not_found
    ghost = Person(first_name="No", last_name="Account")
    db.add(ghost)
    await db.commit()
    alice = await login(client)
    assert (await client.get(_adm(seeded_user.id), headers=alice)).status_code == 200
    for pid in (ghost.id, uuid.uuid4()):
        resp = await client.get(_adm(pid), headers=alice)
        assert resp.status_code == 404 and resp.json()["detail"]["code"] == "user_not_found"


async def test_admin_list_needs_users_change(client, db, seeded_user):
    # user agents are as sensitive as the detail's sessions block: a staffer
    # whose users:change is overridden off can view the user but not this list
    await _remember(db, seeded_user.id)
    wan = await _add_user(db, first="Wan", last="Staff", email="wan@test.example.com",
                          role="staff")
    admin = await login_admin(client, db, seeded_user)
    assert (await client.put(f"/access/overrides/{wan.id}", headers=admin,
                             json={"overrides": {"users": {"change": False}}})).status_code == 200
    wan_hdrs = H(await _token(client, email="wan@test.example.com"))
    assert (await client.get(f"/users/{seeded_user.id}", headers=wan_hdrs)).status_code == 200
    resp = await client.get(_adm(seeded_user.id), headers=wan_hdrs)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"


async def test_admin_list_needs_a_touchable_rank_but_self_is_fine(client, db, seeded_user):
    boss = await _make(db, client, "super_admin", "tb-boss@test.example.com")
    boss_id = (await client.get("/auth/me", headers=boss)).json()["person"]["id"]
    await _remember(db, boss_id)
    admin = await _make(db, client, "admin", "tb-admin@test.example.com")
    admin_id = (await client.get("/auth/me", headers=admin)).json()["person"]["id"]
    await _remember(db, admin_id)
    # a lower-rank admin on a founder: 403 forbidden (the detail hides sessions too)
    resp = await client.get(_adm(boss_id), headers=admin)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"
    assert (await client.get(f"/users/{boss_id}", headers=admin)).json()["sessions"] is None
    # an actor viewing themself sees their own list
    resp = await client.get(_adm(admin_id), headers=admin)
    assert resp.status_code == 200 and len(resp.json()["browsers"]) == 1
    # and a founder can read an admin's
    assert (await client.get(_adm(admin_id), headers=boss)).status_code == 200


async def test_admin_forget_one_revokes_audits_with_admin_as_actor(client, db, seeded_user):
    admin = await _make(db, client, "super_admin", "tb-admin@test.example.com")
    admin_id = (await client.get("/auth/me", headers=admin)).json()["person"]["id"]
    _t, keep = await _remember(db, seeded_user.id, age_minutes=5)
    _t, gone = await _remember(db, seeded_user.id)
    resp = await client.delete(f"{_adm(seeded_user.id)}/{gone.id}", headers=admin)
    assert resp.status_code == 204, resp.text
    assert not _cleared(resp)  # an admin's browser cookie is never touched
    await db.refresh(gone)
    assert gone.revoked_at is not None
    assert [r.id for r in await _live(db, seeded_user.id)] == [keep.id]
    rows = await _audit(db, "totp.trust_forget", seeded_user.id)
    assert len(rows) == 1 and str(rows[0].actor_person_id) == admin_id
    assert rows[0].changes == {"trusted_browser_id": str(gone.id)}


async def test_admin_forget_one_404s_for_wrong_person_revoked_and_unknown(client, db, seeded_user):
    admin = await _make(db, client, "super_admin", "tb-admin@test.example.com")
    other = await _add_user(db, first="Ot", last="Her", email="other@test.example.com",
                            role="staff")
    _t, theirs = await _remember(db, other.id)
    _t, revoked = await _remember(db, seeded_user.id)
    revoked.revoked_at = datetime.now(UTC)
    await db.commit()
    for target in (theirs.id, revoked.id, uuid.uuid4()):
        resp = await client.delete(f"{_adm(seeded_user.id)}/{target}", headers=admin)
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"]["code"] == "trusted_browser_not_found"
    await db.refresh(theirs)
    assert theirs.revoked_at is None
    resp = await client.delete(f"{_adm(uuid.uuid4())}/{theirs.id}", headers=admin)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "user_not_found"


async def test_admin_forget_all_revokes_and_audits_count(client, db, seeded_user):
    admin = await _make(db, client, "super_admin", "tb-admin@test.example.com")
    other = await _add_user(db, first="Ot", last="Her", email="other@test.example.com",
                            role="staff")
    await _remember(db, seeded_user.id)
    await _remember(db, seeded_user.id, age_minutes=5)
    await _remember(db, other.id)
    resp = await client.delete(_adm(seeded_user.id), headers=admin)
    assert resp.status_code == 204, resp.text
    assert await _live(db, seeded_user.id) == []
    assert len(await _live(db, other.id)) == 1
    rows = await _audit(db, "totp.trust_forget_all", seeded_user.id)
    assert len(rows) == 1 and rows[0].changes == {"count": 2}


async def test_admin_deletes_need_users_change_rank_and_not_self(client, db, seeded_user):
    boss = await _make(db, client, "super_admin", "tb-boss@test.example.com")
    boss_id = (await client.get("/auth/me", headers=boss)).json()["person"]["id"]
    _t, boss_row = await _remember(db, boss_id)
    # no users:change (worker) -> 403
    await _add_user(db, first="Wan", last="Worker", email="wan@test.example.com", role="worker")
    wan = H(await _token(client, email="wan@test.example.com"))
    _t, row = await _remember(db, seeded_user.id)
    assert (await client.delete(f"{_adm(seeded_user.id)}/{row.id}", headers=wan)).status_code == 403
    assert (await client.delete(_adm(seeded_user.id), headers=wan)).status_code == 403
    # alice (staff 40) can't touch a super_admin (80)
    alice = await login(client)
    for url in (f"{_adm(boss_id)}/{boss_row.id}", _adm(boss_id)):
        resp = await client.delete(url, headers=alice)
        assert resp.status_code == 403 and resp.json()["detail"]["code"] == "rank_too_low"
    assert len(await _live(db, boss_id)) == 1
    # an admin can't use the admin route on themself
    resp = await client.delete(_adm(boss_id), headers=boss)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "cannot_target_self"
    await db.refresh(row)
    assert row.revoked_at is None


# ── end to end: sign-in honours forget ──────────────────────────────

async def test_forgetting_a_remembered_browser_brings_the_code_back(client, db, seeded_user):
    await _security(db, two_factor_enabled=True)
    secret, _codes = await _enroll_direct(db, seeded_user.id)
    token = (await _login(client)).json()["challenge_token"]
    resp = await client.post("/auth/totp/verify", headers={"X-Totp-Challenge": token},
                             json={"code": _next_code(secret), "remember": True})
    assert resp.status_code == 200 and "ss_trust" in resp.cookies
    access = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    # remembered: a fresh sign-in on this browser skips the code
    again = await _login(client)
    assert again.json()["status"] == "ok"

    # the list sees this browser as current; forget it
    listing = (await client.get(ME, headers=access)).json()["browsers"]
    assert len(listing) == 1 and listing[0]["current"] is True
    gone = await client.delete(f"{ME}/{listing[0]['id']}", headers=access)
    assert gone.status_code == 204 and _cleared(gone)

    # the cookie is gone from the jar and the next sign-in asks for the code
    assert client.cookies.get("ss_trust") is None
    asked = await _login(client)
    assert asked.json()["status"] == "totp_verify"

    # even if the old cookie came back, the revoked row no longer helps
    client.cookies.set("ss_trust", resp.cookies["ss_trust"], domain="testserver.local", path="/auth")
    stale = await _login(client)
    assert stale.json()["status"] == "totp_verify"


async def test_admin_list_refuses_a_client_scoped_actor(client, db, seeded_user):
    # users:change alone is not enough: the actor must be global, like the
    # sessions block on GET /users/{id}
    from serversherpa.db.models import Client, PermissionOverride
    from tests.test_initiatives_client_scope import client_login

    acme = Client(name="Acme Trust")
    db.add(acme)
    await db.flush()
    await _remember(db, seeded_user.id)
    email = "cl-trust@test.example.com"
    await client_login(db, client, acme.id, role="client_admin", email=email)
    person = await db.scalar(select(Person).where(Person.email == email))
    for action in ("view", "change"):
        db.add(PermissionOverride(person_id=person.id, resource="users",
                                  action=action, allow=True))
    await db.commit()
    hdrs = await login(client, email=email)  # fresh token, after the overrides
    resp = await client.get(_adm(seeded_user.id), headers=hdrs)
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "forbidden"
