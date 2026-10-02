import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from sirdar_api.db.models import AuditLog, AuthSession

from .api_helpers import auth_headers
from .factories import PASSWORD, make_user


async def _me(client, db, **kw):
    headers = await auth_headers(client, db, **kw)
    return headers


async def _user_for(db, email):
    from sirdar_api.db.models import User
    return await db.scalar(select(User).where(User.email == email))


# ── profile ──────────────────────────────────────────────────────────

async def test_profile_shape(client, db):
    headers = await _me(client, db, email="boss@test.example.com", source="local")
    user = await _user_for(db, "boss@test.example.com")
    user.contact_email, user.phone, user.city = "boss@home.example.com", "555-1", "Reno"
    user.job_title = "Chief"
    await db.commit()
    body = (await client.get("/api/auth/me/profile", headers=headers)).json()
    assert body["id"] == str(user.person_id)
    assert body["first_name"] == "Boss" and body["display_name"] == "Boss User"
    assert body["email"] == "boss@home.example.com"
    assert body["login_email"] == "boss@test.example.com" and body["source"] == "local"
    assert body["phone"] == "555-1" and body["city"] == "Reno" and body["country"] == "US"
    assert body["job_title"] == "Chief"
    assert body["badge_uid"] is None and body["avatar_key"] is None
    assert body["avatar_url"] is None
    assert body["created_at"] and "password_updated_at" in body
    for k in ("preferred_name", "address_line1", "address_line2", "region", "postal_code"):
        assert k in body


async def test_profile_requires_auth(client):
    assert (await client.get("/api/auth/me/profile")).status_code == 401


async def test_patch_profile_applies_only_sent_fields_and_audits(client, db):
    headers = await _me(client, db)          # portal user: still allowed
    resp = await client.patch("/api/auth/me/profile", headers=headers, json={
        "phone": "555-9", "email": "new@example.com", "country": "ca", "city": "Reno"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["phone"] == "555-9" and body["email"] == "new@example.com"
    assert body["country"] == "CA" and body["first_name"] == "Boss"
    user = await _user_for(db, "boss@test.example.com")
    await db.refresh(user)
    assert user.contact_email == "new@example.com" and user.email == "boss@test.example.com"
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "profile.update"))
    assert row.actor_id == user.person_id
    assert set(row.changes) >= {"phone", "email", "country", "city"}


async def test_patch_profile_can_clear_nullable_fields(client, db):
    headers = await _me(client, db)
    await client.patch("/api/auth/me/profile", headers=headers, json={"phone": "1"})
    resp = await client.patch("/api/auth/me/profile", headers=headers, json={"phone": None})
    assert resp.status_code == 200 and resp.json()["phone"] is None


async def test_patch_profile_required_fields(client, db):
    headers = await _me(client, db)
    for field in ("first_name", "last_name", "country"):
        resp = await client.patch("/api/auth/me/profile", headers=headers,
                                  json={field: None})
        assert resp.status_code == 422
        assert resp.json()["detail"] == {"code": f"{field}_required"}
    for field in ("first_name", "last_name"):
        resp = await client.patch("/api/auth/me/profile", headers=headers,
                                  json={field: "   "})
        assert resp.json()["detail"] == {"code": f"{field}_required"}


async def test_patch_profile_validation(client, db):
    headers = await _me(client, db)
    assert (await client.patch("/api/auth/me/profile", headers=headers,
                               json={"email": "nope"})).status_code == 422
    assert (await client.patch("/api/auth/me/profile", headers=headers,
                               json={"country": "USA"})).status_code == 422
    assert (await client.patch("/api/auth/me/profile", headers=headers,
                               json={"country": "1x"})).status_code == 422
    assert (await client.patch("/api/auth/me/profile", headers=headers,
                               json={"bogus": 1})).status_code == 422


# ── sessions ─────────────────────────────────────────────────────────

async def _login(client, email):
    resp = await client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def test_sessions_list_current_first_and_one_per_family(client, db):
    headers = await _me(client, db)
    first = await client.get("/api/auth/me/sessions", headers=headers)
    assert first.status_code == 200 and len(first.json()) == 1
    # rotate the current family so it has a rotated + a live row
    refresh = client.cookies.get("sirdar_refresh")
    assert refresh
    assert (await client.post("/api/auth/refresh")).status_code == 200
    newer = await _login(client, "boss@test.example.com")     # a second family
    items = (await client.get("/api/auth/me/sessions", headers=newer)).json()
    assert len(items) == 2
    assert items[0]["current"] is True and items[1]["current"] is False
    for item in items:
        assert set(item) == {"family_id", "started_at", "last_active_at", "expires_at",
                             "ip_address", "user_agent", "current"}
    rotated = [i for i in items if i["family_id"] == first.json()[0]["family_id"]][0]
    assert rotated["started_at"] <= rotated["last_active_at"]


async def test_sessions_omit_revoked_and_expired(client, db):
    headers = await _me(client, db)
    user = await _user_for(db, "boss@test.example.com")
    other = uuid.uuid4()
    for fam, revoked, expires in ((other, datetime.now(UTC), 1), (uuid.uuid4(), None, -1)):
        db.add(AuthSession(id=fam, person_id=user.person_id, family_id=fam,
                           token_hash=f"h{fam}", revoked_at=revoked,
                           expires_at=datetime.now(UTC) + timedelta(days=expires)))
    await db.commit()
    items = (await client.get("/api/auth/me/sessions", headers=headers)).json()
    assert len(items) == 1 and items[0]["current"] is True


async def test_revoke_other_session(client, db):
    headers = await _me(client, db)
    other = await _login(client, "boss@test.example.com")
    items = (await client.get("/api/auth/me/sessions", headers=headers)).json()
    target = next(i for i in items if not i["current"])
    resp = await client.delete(f"/api/auth/me/sessions/{target['family_id']}",
                               headers=headers)
    assert resp.status_code == 204
    assert (await client.get("/api/auth/me", headers=other)).status_code == 401
    assert len((await client.get("/api/auth/me/sessions", headers=headers)).json()) == 1
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "session.revoke"))
    assert row is not None


async def test_revoke_current_session_allowed(client, db):
    headers = await _me(client, db)
    current = (await client.get("/api/auth/me/sessions", headers=headers)).json()[0]
    resp = await client.delete(f"/api/auth/me/sessions/{current['family_id']}",
                               headers=headers)
    assert resp.status_code == 204


async def test_revoke_unknown_or_foreign_family_404(client, db):
    headers = await _me(client, db)
    await make_user(db, email="eve@test.example.com", first_name="Eve")
    eve = await _login(client, "eve@test.example.com")
    eve_family = (await client.get("/api/auth/me/sessions", headers=eve)).json()[0]["family_id"]
    for fam in (str(uuid.uuid4()), eve_family):
        resp = await client.delete(f"/api/auth/me/sessions/{fam}", headers=headers)
        assert resp.status_code == 404 and resp.json()["detail"] == {"code": "session_not_found"}
    assert (await client.get("/api/auth/me", headers=eve)).status_code == 200  # untouched


# ── activity ─────────────────────────────────────────────────────────

async def test_activity_own_rows_newest_first_and_isolated(client, db):
    headers = await _me(client, db)
    me = await _user_for(db, "boss@test.example.com")
    eve = await make_user(db, email="eve@test.example.com", first_name="Eve")
    t0 = datetime.now(UTC) - timedelta(hours=1)
    db.add_all([
        AuditLog(at=t0, actor_id=me.person_id, action="a.mine", entity_type="widget",
                 entity_id="w1", changes={"x": 1}),
        AuditLog(at=t0 + timedelta(minutes=5), actor_id=eve.person_id, action="a.about_me",
                 entity_type="user", entity_id=str(me.person_id)),
        AuditLog(at=t0 + timedelta(minutes=6), actor_id=eve.person_id, action="a.eves",
                 entity_type="user", entity_id=str(eve.person_id)),
        AuditLog(at=t0 + timedelta(minutes=7), actor_id=eve.person_id, action="a.other",
                 entity_type="widget", entity_id=str(me.person_id)),
    ])
    await db.commit()
    items = (await client.get("/api/auth/me/activity", headers=headers)).json()
    actions = [i["action"] for i in items]
    assert "a.mine" in actions and "a.about_me" in actions
    assert "a.eves" not in actions and "a.other" not in actions
    assert actions.index("a.about_me") < actions.index("a.mine")      # newest first
    assert "login" in actions
    mine = next(i for i in items if i["action"] == "a.mine")
    assert isinstance(mine["id"], str)
    assert set(mine) >= {"id", "at", "action", "entity_type", "entity_id", "entity_name",
                         "actor_id", "actor_name", "ip", "changes"}
    assert mine["actor_name"] == "Boss User" and mine["changes"] == {"x": 1}
    about = next(i for i in items if i["action"] == "a.about_me")
    assert about["actor_name"] == "Eve Anderson" and about["entity_name"] == "Boss User"


async def test_activity_limit(client, db):
    headers = await _me(client, db)
    me = await _user_for(db, "boss@test.example.com")
    db.add_all([AuditLog(actor_id=me.person_id, action=f"n{i}", entity_type="w")
                for i in range(5)])
    await db.commit()
    assert len((await client.get("/api/auth/me/activity?limit=3", headers=headers)).json()) == 3
    assert (await client.get("/api/auth/me/activity?limit=501",
                             headers=headers)).status_code == 422
