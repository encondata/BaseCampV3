"""Biometric sign-in, admin and self-service (Task 5): assigning a kiosk as
someone's personal device (PUT /devices/{id}/personal), the device detail's
personal and biometric fields, the admin forget on the device page, the
key lists and forgets on the user page and on /auth/me, and the
revoke_keys guard against an accidental revoke-everything.

Design: docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md
§Portal, §Rules."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from serversherpa.api.routes import devices as devices_routes
from serversherpa.db.models import (
    AuditLog,
    BiometricKey,
    Device,
    PermissionOverride,
    Person,
    PersonRole,
    Role,
    UserAccount,
)
from serversherpa.services import biometric
from tests.test_access_roles_api import login_admin
from tests.test_sites_api import login
from tests.test_status_values_write import _make
from tests.test_users_api import _add_user, _token

ME = "/auth/me/biometric-keys"


def H(token):
    return {"Authorization": f"Bearer {token}"}


def _code(resp):
    return resp.json()["detail"]["code"]


async def _kiosk(db, *, name="Jo's phone", **kw) -> uuid.UUID:
    device = Device(device_type="kiosk", name=name,
                    serial=f"android-{uuid.uuid4().hex[:8]}", sub_type="android", **kw)
    db.add(device)
    await db.commit()
    return device.id


async def _key(db, person_id, device_id, *, age_days=0, revoked=False,
               created_minutes_ago=0) -> uuid.UUID:
    """A key row as enroll leaves it (the public key is never read here)."""
    now = datetime.now(UTC)
    key = BiometricKey(
        id=uuid.uuid4(), person_id=person_id, device_id=device_id,
        public_key=b"\x30\x00", security_level="strongbox",
        created_at=now - timedelta(minutes=created_minutes_ago),
        password_sign_in_at=now - timedelta(days=age_days),
        last_nonce="jti:1",
        revoked_at=now if revoked else None, revoke_reason="replaced" if revoked else None)
    db.add(key)
    await db.commit()
    return key.id


async def _fresh_key(db, key_id) -> BiometricKey:
    return await db.get(BiometricKey, key_id, populate_existing=True)


async def _fresh_device(db, device_id) -> Device:
    return await db.get(Device, device_id, populate_existing=True)


async def _person_id(client, hdrs) -> str:
    return (await client.get("/auth/me", headers=hdrs)).json()["person"]["id"]


async def _super(db, client, email="bio-sa@test.example.com"):
    hdrs = await _make(db, client, "super_admin", email)
    return hdrs, uuid.UUID(await _person_id(client, hdrs))


async def _worker(db, email="bio-w@test.example.com", first="Jo", last="Worker"):
    return await _add_user(db, first=first, last=last, email=email, role="worker")


async def _rank_79_hardware_lead(db, client):
    """A global role one rank below super admin, granted scanning_hardware
    view and change directly: the rank floor alone must refuse it."""
    db.add(Role(name="hw_lead_79", description="test-only", rank=79, scope_anchor="global"))
    p = await _add_user(db, first="Hw", last="Lead", email="hw79@test.example.com",
                        role="worker")
    db.add(PersonRole(person_id=p.id, role="hw_lead_79"))
    for action in ("view", "change"):
        db.add(PermissionOverride(person_id=p.id, resource="scanning_hardware",
                                  action=action, allow=True))
    await db.commit()
    return H(await _token(client, email="hw79@test.example.com"))


async def _put_personal(client, hdrs, device_id, person_id):
    return await client.put(f"/devices/{device_id}/personal", headers=hdrs,
                            json={"person_id": str(person_id) if person_id else None})


async def _audits(db, action):
    return list(await db.scalars(select(AuditLog).where(AuditLog.action == action)))


# ── revoke_keys guard (Task 4 review M1) ────────────────────────────

async def test_revoke_keys_without_a_filter_or_all_keys_raises(client, db, seeded_user):
    w = await _worker(db)
    key_id = await _key(db, w.id, await _kiosk(db))
    with pytest.raises(ValueError):
        await biometric.revoke_keys(db, reason="admin")
    with pytest.raises(ValueError):
        await biometric.revoke_keys(db, person_id=None, device_id=None, reason="admin")
    assert (await _fresh_key(db, key_id)).revoked_at is None
    assert await biometric.revoke_keys(db, reason="admin", all_keys=True) == 1
    await db.commit()
    assert (await _fresh_key(db, key_id)).revoke_reason == "admin"


async def test_global_revoke_all_still_revokes_every_key(client, db, seeded_user):
    a, b = await _worker(db), await _worker(db, "bio-w2@test.example.com", "Bo")
    ka = await _key(db, a.id, await _kiosk(db))
    kb = await _key(db, b.id, await _kiosk(db, name="Bo's phone"))
    admin, _ = await _super(db, client)
    resp = await client.post("/system/sessions/revoke-all", headers=admin)
    assert resp.status_code in (200, 204), resp.text
    assert (await _fresh_key(db, ka)).revoked_at is not None
    assert (await _fresh_key(db, kb)).revoked_at is not None


# ── PUT /devices/{id}/personal: gates ───────────────────────────────

async def test_personal_put_refuses_rank_79_and_admins(client, db, seeded_user):
    w = await _worker(db)
    device_id = await _kiosk(db)
    lead = await _rank_79_hardware_lead(db, client)
    # the role can see the page (scanning_hardware:view)
    assert (await client.get(f"/devices/{device_id}", headers=lead)).status_code == 200
    r = await _put_personal(client, lead, device_id, w.id)
    assert r.status_code == 403 and _code(r) == "forbidden_rank"
    r = await client.delete(f"/devices/{device_id}/biometric", headers=lead)
    assert r.status_code == 403 and _code(r) == "forbidden_rank"
    admin60 = await login_admin(client, db, seeded_user)
    r = await _put_personal(client, admin60, device_id, w.id)
    assert r.status_code == 403 and _code(r) == "forbidden_rank"
    assert (await _fresh_device(db, device_id)).personal_person_id is None


async def test_personal_put_needs_scanning_hardware_change(client, db, seeded_user):
    w = await _worker(db)
    device_id = await _kiosk(db)
    sa, sa_id = await _super(db, client)
    db.add(PermissionOverride(person_id=sa_id, resource="scanning_hardware",
                              action="change", allow=False))
    await db.commit()
    sa = await login(client, email="bio-sa@test.example.com")
    r = await _put_personal(client, sa, device_id, w.id)
    assert r.status_code == 403 and _code(r) != "forbidden_rank"
    r = await client.delete(f"/devices/{device_id}/biometric", headers=sa)
    assert r.status_code == 403
    wkr = H(await _token(client, email="bio-w@test.example.com"))
    assert (await _put_personal(client, wkr, device_id, w.id)).status_code == 403


async def test_personal_put_unknown_device_or_not_a_kiosk(client, db, seeded_user):
    w = await _worker(db)
    sa, _ = await _super(db, client)
    r = await _put_personal(client, sa, uuid.uuid4(), w.id)
    assert r.status_code == 404 and _code(r) == "device_not_found"
    router = Device(device_type="router", name="R1", serial="r-1")
    db.add(router)
    await db.commit()
    r = await _put_personal(client, sa, router.id, w.id)
    assert r.status_code == 409 and _code(r) == "not_a_kiosk"


# ── PUT /devices/{id}/personal: eligibility ─────────────────────────

async def test_personal_put_refuses_ineligible_people(client, db, seeded_user):
    device_id = await _kiosk(db)
    sa, _ = await _super(db, client)
    # no login account
    bare = Person(first_name="No", last_name="Account")
    # a move's hidden kiosk identity (it has an account and kiosk:view)
    mover = await _add_user(db, first="Move", last="Crew", email="mv@test.example.com",
                            role="worker")
    # an account without kiosk:view
    blocked = await _add_user(db, first="No", last="Kiosk", email="nk@test.example.com",
                              role="worker")
    db.add(bare)
    db.add(PermissionOverride(person_id=blocked.id, resource="kiosk", action="view",
                              allow=False))
    (await db.get(Person, mover.id)).source = "kiosk_move"
    await db.commit()
    for person_id, reason in ((bare.id, "no_account"), (blocked.id, "no_kiosk_view"),
                              (mover.id, "move_identity")):
        r = await _put_personal(client, sa, device_id, person_id)
        assert r.status_code == 422, (reason, r.text)
        assert r.json()["detail"] == {"code": "not_eligible", "reason": reason}
    r = await _put_personal(client, sa, device_id, uuid.uuid4())
    assert r.status_code == 404 and _code(r) == "person_not_found"
    assert (await _fresh_device(db, device_id)).personal_person_id is None
    assert await _audits(db, "personal_set") == []


async def test_personal_put_refuses_a_disabled_account_or_an_archived_person(
        client, db, seeded_user):
    device_id = await _kiosk(db)
    sa, _ = await _super(db, client)
    disabled = await _worker(db, "bio-off@test.example.com", "Off")
    archived = await _worker(db, "bio-gone@test.example.com", "Gone")
    (await db.get(UserAccount, disabled.id)).disabled_at = datetime.now(UTC)
    (await db.get(Person, archived.id)).archived_at = datetime.now(UTC)
    await db.commit()
    for person_id in (disabled.id, archived.id):
        r = await _put_personal(client, sa, device_id, person_id)
        assert r.status_code == 422, r.text
        assert r.json()["detail"] == {"code": "not_eligible", "reason": "account_disabled"}
    assert (await _fresh_device(db, device_id)).personal_person_id is None


@pytest.mark.parametrize("station", ["timeclock", "label", "rfid", "station_key"])
async def test_personal_put_refuses_shared_stations(client, db, seeded_user, station):
    w = await _worker(db)
    kw = ({"station_key_hash": "x" * 64} if station == "station_key"
          else {"station_type": station})
    device_id = await _kiosk(db, **kw)
    sa, _ = await _super(db, client)
    r = await _put_personal(client, sa, device_id, w.id)
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "not_eligible", "reason": "shared_station"}
    assert (await _fresh_device(db, device_id)).personal_person_id is None
    # clearing a stale assignment on a station still works
    device = await _fresh_device(db, device_id)
    device.personal_person_id = w.id
    await db.commit()
    r = await _put_personal(client, sa, device_id, None)
    assert r.status_code == 200, r.text
    assert (await _fresh_device(db, device_id)).personal_person_id is None


# ── PUT /devices/{id}/personal: set, reassign, clear ────────────────

async def test_personal_put_sets_the_person_and_audits(client, db, seeded_user):
    w = await _worker(db)
    device_id = await _kiosk(db)
    sa, sa_id = await _super(db, client)
    r = await _put_personal(client, sa, device_id, w.id)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["personal_person"] == {"id": str(w.id), "display_name": "Jo Worker"}
    assert body["personal_biometric"] == {"on": False, "renews_at": None}
    d = await _fresh_device(db, device_id)
    assert d.personal_person_id == w.id and d.personal_set_by == sa_id
    assert d.personal_set_at is not None
    rows = await _audits(db, "personal_set")
    assert len(rows) == 1 and rows[0].actor_person_id == sa_id
    assert rows[0].entity_type == "device" and rows[0].entity_id == str(device_id)
    assert rows[0].changes == {"person_id": {"from": None, "to": str(w.id)}}


async def test_reassigning_revokes_the_previous_persons_key(client, db, seeded_user):
    a = await _worker(db)
    b = await _worker(db, "bio-w2@test.example.com", "Bo")
    device_id = await _kiosk(db)
    other_device = await _kiosk(db, name="Jo's tablet")
    sa, sa_id = await _super(db, client)
    assert (await _put_personal(client, sa, device_id, a.id)).status_code == 200
    key_here = await _key(db, a.id, device_id)
    key_elsewhere = await _key(db, a.id, other_device)
    r = await _put_personal(client, sa, device_id, b.id)
    assert r.status_code == 200, r.text
    assert r.json()["personal_person"]["id"] == str(b.id)
    gone = await _fresh_key(db, key_here)
    assert gone.revoked_at is not None and gone.revoke_reason == "reassigned"
    assert gone.last_nonce is None
    assert (await _fresh_key(db, key_elsewhere)).revoked_at is None
    revokes = await _audits(db, "biometric_revoke")
    assert [x.entity_id for x in revokes] == [str(key_here)]
    assert revokes[0].actor_person_id == sa_id
    rows = await _audits(db, "personal_set")
    assert sorted(r.changes["person_id"]["to"] for r in rows) == sorted([str(a.id), str(b.id)])
    assert {"person_id": {"from": str(a.id), "to": str(b.id)}} in [r.changes for r in rows]


async def test_clearing_revokes_the_key(client, db, seeded_user):
    a = await _worker(db)
    device_id = await _kiosk(db)
    sa, _ = await _super(db, client)
    assert (await _put_personal(client, sa, device_id, a.id)).status_code == 200
    key_id = await _key(db, a.id, device_id)
    r = await _put_personal(client, sa, device_id, None)
    assert r.status_code == 200, r.text
    assert r.json()["personal_person"] is None and r.json()["personal_biometric"] is None
    gone = await _fresh_key(db, key_id)
    assert gone.revoked_at is not None and gone.revoke_reason == "reassigned"
    d = await _fresh_device(db, device_id)
    assert d.personal_person_id is None and d.personal_set_at is None
    assert d.personal_set_by is None
    rows = await _audits(db, "personal_cleared")
    assert len(rows) == 1 and rows[0].changes == {"person_id": {"from": str(a.id), "to": None}}


async def test_assigning_the_same_person_again_is_a_no_op(client, db, seeded_user):
    a = await _worker(db)
    device_id = await _kiosk(db)
    sa, _ = await _super(db, client)
    assert (await _put_personal(client, sa, device_id, a.id)).status_code == 200
    set_at = (await _fresh_device(db, device_id)).personal_set_at
    key_id = await _key(db, a.id, device_id)
    r = await _put_personal(client, sa, device_id, a.id)
    assert r.status_code == 200, r.text
    assert r.json()["personal_biometric"]["on"] is True
    assert (await _fresh_key(db, key_id)).revoked_at is None
    assert (await _fresh_device(db, device_id)).personal_set_at == set_at
    assert len(await _audits(db, "personal_set")) == 1
    # clearing nothing is also quiet
    other = await _kiosk(db, name="Spare")
    assert (await _put_personal(client, sa, other, None)).status_code == 200
    assert await _audits(db, "personal_cleared") == []


async def test_personal_put_is_frozen_in_read_only_mode(client, db, seeded_user):
    a = await _worker(db)
    device_id = await _kiosk(db)
    sa, _ = await _super(db, client)
    assert (await client.put("/system/admin", headers=sa,
                             json={"read_only": True})).status_code == 200
    r = await _put_personal(client, sa, device_id, a.id)
    assert r.status_code == 423 and _code(r) == "read_only_mode"
    r = await client.delete(f"/devices/{device_id}/biometric", headers=sa)
    assert r.status_code == 423


# ── GET /devices/{id}/personal-candidates ───────────────────────────

def _cands(client, hdrs, device_id, q=None):
    params = {"q": q} if q is not None else None
    return client.get(f"/devices/{device_id}/personal-candidates", headers=hdrs,
                      params=params)


async def test_personal_candidates_offer_only_eligible_people(client, db, seeded_user):
    device_id = await _kiosk(db)
    sa, _ = await _super(db, client)
    ok = await _worker(db, "bio-ok@test.example.com", "Okay", "Pickme")
    bare = Person(first_name="Bare", last_name="Pickme")
    mover = await _add_user(db, first="Move", last="Pickme", email="mv@test.example.com",
                            role="worker")
    blocked = await _add_user(db, first="Blocked", last="Pickme",
                              email="nk@test.example.com", role="worker")
    disabled = await _worker(db, "bio-off@test.example.com", "Off", "Pickme")
    archived = await _worker(db, "bio-gone@test.example.com", "Gone", "Pickme")
    db.add(bare)
    db.add(PermissionOverride(person_id=blocked.id, resource="kiosk", action="view",
                              allow=False))
    (await db.get(Person, mover.id)).source = "kiosk_move"
    (await db.get(UserAccount, disabled.id)).disabled_at = datetime.now(UTC)
    (await db.get(Person, archived.id)).archived_at = datetime.now(UTC)
    await db.commit()
    r = await _cands(client, sa, device_id)
    assert r.status_code == 200, r.text
    ids = {row["person_id"] for row in r.json()}
    assert str(ok.id) in ids
    for person in (bare, mover, blocked, disabled, archived):
        assert str(person.id) not in ids, person.first_name
    # every row the picker offers is one the PUT accepts
    ok_row = next(row for row in r.json() if row["person_id"] == str(ok.id))
    assert ok_row == {"person_id": str(ok.id), "display_name": "Okay Pickme",
                      "login_email": "bio-ok@test.example.com"}
    assert (await _put_personal(client, sa, device_id, ok.id)).status_code == 200


async def test_personal_candidates_search_and_natural_order(client, db, seeded_user):
    device_id = await _kiosk(db)
    sa, _ = await _super(db, client)
    for first, email in (("Al 10", "al10@test.example.com"), ("bo", "bo@test.example.com"),
                         ("Al 2", "al2@test.example.com")):
        await _worker(db, email, first, "Sortcheck")
    r = await _cands(client, sa, device_id, "sortCHECK")
    assert r.status_code == 200, r.text
    assert [row["display_name"] for row in r.json()] == [
        "Al 2 Sortcheck", "Al 10 Sortcheck", "bo Sortcheck"]
    # the login email matches too
    r = await _cands(client, sa, device_id, "AL10@test")
    assert [row["display_name"] for row in r.json()] == ["Al 10 Sortcheck"]
    assert (await _cands(client, sa, device_id, "nobody-like-this")).json() == []


async def test_personal_candidates_are_capped(client, db, seeded_user, monkeypatch):
    device_id = await _kiosk(db)
    sa, _ = await _super(db, client)
    for i in range(3):
        await _worker(db, f"cap{i}@test.example.com", f"Cap {i}", "Capped")
    monkeypatch.setattr(devices_routes, "PERSONAL_CANDIDATE_LIMIT", 2)
    r = await _cands(client, sa, device_id, "capped")
    assert [row["display_name"] for row in r.json()] == ["Cap 0 Capped", "Cap 1 Capped"]
    assert devices_routes.PERSONAL_CANDIDATE_LIMIT == 2


async def test_personal_candidates_are_gated_like_the_put(client, db, seeded_user):
    device_id = await _kiosk(db)
    lead = await _rank_79_hardware_lead(db, client)
    r = await _cands(client, lead, device_id)
    assert r.status_code == 403 and _code(r) == "forbidden_rank"
    admin60 = await login_admin(client, db, seeded_user)
    r = await _cands(client, admin60, device_id)
    assert r.status_code == 403 and _code(r) == "forbidden_rank"
    _, sa_id = await _super(db, client)
    db.add(PermissionOverride(person_id=sa_id, resource="scanning_hardware",
                              action="change", allow=False))
    await db.commit()
    sa_no_change = await login(client, email="bio-sa@test.example.com")
    r = await _cands(client, sa_no_change, device_id)
    assert r.status_code == 403 and _code(r) != "forbidden_rank"
    other, _ = await _super(db, client, "bio-sa2@test.example.com")
    r = await _cands(client, other, uuid.uuid4())
    assert r.status_code == 404 and _code(r) == "device_not_found"
    router = Device(device_type="router", name="R1", serial="r-1")
    db.add(router)
    await db.commit()
    r = await _cands(client, other, router.id)
    assert r.status_code == 409 and _code(r) == "not_a_kiosk"
    r = await client.get(f"/devices/{device_id}/personal-candidates", headers=other,
                         params={"q": "x" * 201})
    assert r.status_code == 422


# ── device detail ───────────────────────────────────────────────────

async def test_device_detail_shows_personal_person_and_biometric(client, db, seeded_user):
    a = await _worker(db)
    device_id = await _kiosk(db, personal_person_id=None)
    sa, _ = await _super(db, client)
    body = (await client.get(f"/devices/{device_id}", headers=sa)).json()
    assert body["personal_person"] is None and body["personal_biometric"] is None
    assert (await _put_personal(client, sa, device_id, a.id)).status_code == 200
    key_id = await _key(db, a.id, device_id, age_days=8)
    # a revoked key of someone else on the device is not "on"
    await _key(db, seeded_user.id, device_id, revoked=True)
    body = (await client.get(f"/devices/{device_id}", headers=sa)).json()
    assert body["personal_person"] == {"id": str(a.id), "display_name": "Jo Worker"}
    renews = biometric.renews_at(await _fresh_key(db, key_id))
    assert body["personal_biometric"]["on"] is True
    assert datetime.fromisoformat(body["personal_biometric"]["renews_at"]) == renews
    # a revoked key is off
    await biometric.revoke_keys(db, key_id=key_id, reason="admin")
    await db.commit()
    body = (await client.get(f"/devices/{device_id}", headers=sa)).json()
    assert body["personal_biometric"] == {"on": False, "renews_at": None}
    # the list row is unchanged by the new fields
    rows = (await client.get("/devices", headers=sa)).json()
    assert "personal_person" not in rows[0]


@pytest.mark.parametrize("station", [None, "timeclock", "label", "rfid", "station_key"])
async def test_device_detail_says_whether_it_is_a_shared_station(
        client, db, seeded_user, station):
    kw = ({} if station is None
          else {"station_key_hash": "x" * 64} if station == "station_key"
          else {"station_type": station})
    device_id = await _kiosk(db, **kw)
    sa, _ = await _super(db, client)
    body = (await client.get(f"/devices/{device_id}", headers=sa)).json()
    assert body["shared_station"] is (station is not None)


# ── DELETE /devices/{id}/biometric ──────────────────────────────────

async def test_device_forget_revokes_the_key_and_audits(client, db, seeded_user):
    a = await _worker(db)
    device_id = await _kiosk(db)
    other_device = await _kiosk(db, name="Other")
    sa, sa_id = await _super(db, client)
    assert (await _put_personal(client, sa, device_id, a.id)).status_code == 200
    key_id = await _key(db, a.id, device_id)
    keep = await _key(db, a.id, other_device)
    r = await client.delete(f"/devices/{device_id}/biometric", headers=sa)
    assert r.status_code == 204, r.text
    gone = await _fresh_key(db, key_id)
    assert gone.revoked_at is not None and gone.revoke_reason == "forgotten"
    assert (await _fresh_key(db, keep)).revoked_at is None
    rows = await _audits(db, "biometric_forget")
    assert len(rows) == 1 and rows[0].actor_person_id == sa_id
    assert rows[0].entity_type == "device" and rows[0].entity_id == str(device_id)
    # the assignment stays; nothing left to forget is a quiet 204
    assert (await _fresh_device(db, device_id)).personal_person_id == a.id
    assert (await client.delete(f"/devices/{device_id}/biometric", headers=sa)).status_code == 204
    assert len(await _audits(db, "biometric_forget")) == 1
    r = await client.delete(f"/devices/{uuid.uuid4()}/biometric", headers=sa)
    assert r.status_code == 404 and _code(r) == "device_not_found"


async def test_device_forget_locks_the_kiosk_row(client, db, seeded_user, monkeypatch):
    # like the PUT, the forget reads the kiosk FOR UPDATE (_locked_kiosk)
    a = await _worker(db)
    device_id = await _kiosk(db)
    sa, _ = await _super(db, client)
    seen = []
    real = devices_routes._locked_kiosk

    async def spy(db_, did):
        seen.append(did)
        return await real(db_, did)

    monkeypatch.setattr(devices_routes, "_locked_kiosk", spy)
    await _key(db, a.id, device_id)
    assert (await client.delete(f"/devices/{device_id}/biometric",
                                headers=sa)).status_code == 204
    assert seen == [device_id]


async def test_deleting_a_device_cascades_its_keys(client, db, seeded_user):
    a = await _worker(db)
    device_id = await _kiosk(db)
    key_id = await _key(db, a.id, device_id)
    old_id = await _key(db, a.id, device_id, revoked=True)
    sa, _ = await _super(db, client)
    r = await client.delete(f"/devices/{device_id}", headers=sa)
    assert r.status_code == 204, r.text
    assert await _fresh_key(db, key_id) is None
    assert await _fresh_key(db, old_id) is None


# ── user page: list and forget ──────────────────────────────────────

def _adm(person_id):
    return f"/users/{person_id}/biometric-keys"


async def test_admin_list_shows_live_keys_newest_first(client, db, seeded_user):
    a = await _worker(db)
    phone = await _kiosk(db, name="Jo's phone")
    tablet = await _kiosk(db, name="Jo's tablet")
    old = await _key(db, a.id, phone, age_days=3, created_minutes_ago=60)
    new = await _key(db, a.id, tablet, created_minutes_ago=1)
    await _key(db, a.id, tablet, revoked=True, created_minutes_ago=90)
    await _key(db, seeded_user.id, phone)    # someone else's
    sa, _ = await _super(db, client)
    resp = await client.get(_adm(a.id), headers=sa)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [r["id"] for r in rows] == [str(new), str(old)]
    first = rows[0]
    assert set(first) == {"id", "device_id", "device_name", "security_level", "created_at",
                          "last_used_at", "renews_at"}
    assert first["device_id"] == str(tablet) and first["device_name"] == "Jo's tablet"
    assert first["security_level"] == "strongbox" and first["last_used_at"] is None
    renews = biometric.renews_at(await _fresh_key(db, old))
    assert datetime.fromisoformat(rows[1]["renews_at"]) == renews
    assert "public_key" not in resp.text and "last_nonce" not in resp.text


async def test_admin_list_uses_the_trusted_browser_gate(client, db, seeded_user):
    a = await _worker(db)
    await _key(db, a.id, await _kiosk(db))
    # a worker has no users:view
    wkr = H(await _token(client, email="bio-w@test.example.com"))
    assert (await client.get(_adm(a.id), headers=wkr)).status_code == 403
    # staff whose users:change is overridden off: can view the user, not the keys
    wan = await _add_user(db, first="Wan", last="Staff", email="wan@test.example.com",
                          role="staff")
    db.add(PermissionOverride(person_id=wan.id, resource="users", action="change",
                              allow=False))
    await db.commit()
    wan_hdrs = H(await _token(client, email="wan@test.example.com"))
    assert (await client.get(f"/users/{a.id}", headers=wan_hdrs)).status_code == 200
    r = await client.get(_adm(a.id), headers=wan_hdrs)
    assert r.status_code == 403 and _code(r) == "forbidden"
    # a lower-rank admin on a super admin: forbidden; their own list is fine
    boss, boss_id = await _super(db, client, "bio-boss@test.example.com")
    await _key(db, boss_id, await _kiosk(db, name="Boss phone"))
    admin = await _make(db, client, "admin", "bio-admin@test.example.com")
    admin_id = await _person_id(client, admin)
    r = await client.get(_adm(boss_id), headers=admin)
    assert r.status_code == 403 and _code(r) == "forbidden"
    assert (await client.get(_adm(admin_id), headers=admin)).status_code == 200
    assert len((await client.get(_adm(boss_id), headers=boss)).json()) == 1
    # unknown person / no account
    ghost = Person(first_name="No", last_name="Account")
    db.add(ghost)
    await db.commit()
    for pid in (ghost.id, uuid.uuid4()):
        r = await client.get(_adm(pid), headers=boss)
        assert r.status_code == 404 and _code(r) == "user_not_found"


async def test_admin_forget_one_revokes_and_audits(client, db, seeded_user):
    a = await _worker(db)
    b = await _worker(db, "bio-w2@test.example.com", "Bo")
    phone = await _kiosk(db)
    gone = await _key(db, a.id, phone)
    keep = await _key(db, a.id, await _kiosk(db, name="Tablet"))
    theirs = await _key(db, b.id, await _kiosk(db, name="Bo's phone"))
    sa, sa_id = await _super(db, client)
    r = await client.delete(f"{_adm(a.id)}/{gone}", headers=sa)
    assert r.status_code == 204, r.text
    k = await _fresh_key(db, gone)
    assert k.revoked_at is not None and k.revoke_reason == "forgotten"
    assert (await _fresh_key(db, keep)).revoked_at is None
    rows = await _audits(db, "biometric_forget")
    assert len(rows) == 1 and rows[0].actor_person_id == sa_id
    assert rows[0].entity_type == "user_account" and rows[0].entity_id == str(a.id)
    assert rows[0].changes == {"key_id": str(gone), "device_id": str(phone)}
    # someone else's key, a revoked key, an unknown id: 404, nothing changes
    for target in (theirs, gone, uuid.uuid4()):
        r = await client.delete(f"{_adm(a.id)}/{target}", headers=sa)
        assert r.status_code == 404 and _code(r) == "biometric_key_not_found"
    assert (await _fresh_key(db, theirs)).revoked_at is None
    r = await client.delete(f"{_adm(uuid.uuid4())}/{theirs}", headers=sa)
    assert r.status_code == 404 and _code(r) == "user_not_found"


async def test_admin_forget_all_revokes_only_that_person(client, db, seeded_user):
    a = await _worker(db)
    b = await _worker(db, "bio-w2@test.example.com", "Bo")
    k1 = await _key(db, a.id, await _kiosk(db))
    k2 = await _key(db, a.id, await _kiosk(db, name="Tablet"))
    theirs = await _key(db, b.id, await _kiosk(db, name="Bo's phone"))
    sa, _ = await _super(db, client)
    r = await client.delete(_adm(a.id), headers=sa)
    assert r.status_code == 204, r.text
    for k in (k1, k2):
        assert (await _fresh_key(db, k)).revoke_reason == "forgotten"
    assert (await _fresh_key(db, theirs)).revoked_at is None
    rows = await _audits(db, "biometric_forget_all")
    assert len(rows) == 1 and rows[0].changes == {"count": 2}
    # nothing left: quiet 204, no second audit row
    assert (await client.delete(_adm(a.id), headers=sa)).status_code == 204
    assert len(await _audits(db, "biometric_forget_all")) == 1


async def test_admin_forgets_need_users_change_rank_and_not_self(client, db, seeded_user):
    boss, boss_id = await _super(db, client, "bio-boss@test.example.com")
    boss_key = await _key(db, boss_id, await _kiosk(db, name="Boss phone"))
    a = await _worker(db)
    a_key = await _key(db, a.id, await _kiosk(db))
    # a worker has no users:change
    wkr = H(await _token(client, email="bio-w@test.example.com"))
    assert (await client.delete(f"{_adm(a.id)}/{a_key}", headers=wkr)).status_code == 403
    assert (await client.delete(_adm(a.id), headers=wkr)).status_code == 403
    # users:view without users:change is not enough either
    wan = await _add_user(db, first="Wan", last="Staff", email="wan@test.example.com",
                          role="staff")
    db.add(PermissionOverride(person_id=wan.id, resource="users", action="change",
                              allow=False))
    await db.commit()
    wan_hdrs = H(await _token(client, email="wan@test.example.com"))
    for url in (f"{_adm(a.id)}/{a_key}", _adm(a.id)):
        r = await client.delete(url, headers=wan_hdrs)
        assert r.status_code == 403 and _code(r) == "forbidden", r.text
    # staff (40) can't touch a super admin (80)
    alice = await login(client)
    for url in (f"{_adm(boss_id)}/{boss_key}", _adm(boss_id)):
        r = await client.delete(url, headers=alice)
        assert r.status_code == 403 and _code(r) == "rank_too_low"
    # not on yourself (use /auth/me)
    r = await client.delete(f"{_adm(boss_id)}/{boss_key}", headers=boss)
    assert r.status_code == 403 and _code(r) == "cannot_target_self"
    assert (await _fresh_key(db, boss_key)).revoked_at is None
    assert (await _fresh_key(db, a_key)).revoked_at is None


async def test_admin_forgets_are_frozen_in_read_only_mode(client, db, seeded_user):
    a = await _worker(db)
    a_key = await _key(db, a.id, await _kiosk(db))
    sa, _ = await _super(db, client)
    assert (await client.put("/system/admin", headers=sa,
                             json={"read_only": True})).status_code == 200
    for url in (f"{_adm(a.id)}/{a_key}", _adm(a.id)):
        r = await client.delete(url, headers=sa)
        assert r.status_code == 423 and _code(r) == "read_only_mode"
    assert (await _fresh_key(db, a_key)).revoked_at is None


# ── /auth/me ────────────────────────────────────────────────────────

async def test_me_lists_only_my_live_keys(client, db, seeded_user):
    a = await _worker(db)
    phone = await _kiosk(db, name="Alice phone")
    mine = await _key(db, seeded_user.id, phone)
    await _key(db, seeded_user.id, phone, revoked=True, created_minutes_ago=5)
    await _key(db, a.id, await _kiosk(db))
    hdrs = await login(client)
    resp = await client.get(ME, headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [r["id"] for r in rows] == [str(mine)]
    assert rows[0]["device_name"] == "Alice phone"
    assert (await client.get(ME)).status_code == 401


async def test_me_forget_revokes_my_key_only(client, db, seeded_user):
    a = await _worker(db)
    phone = await _kiosk(db, name="Alice phone")
    mine = await _key(db, seeded_user.id, phone)
    theirs = await _key(db, a.id, await _kiosk(db))
    hdrs = await login(client)
    r = await client.delete(f"{ME}/{mine}", headers=hdrs)
    assert r.status_code == 204, r.text
    k = await _fresh_key(db, mine)
    assert k.revoked_at is not None and k.revoke_reason == "forgotten"
    rows = await _audits(db, "biometric_forget")
    assert len(rows) == 1 and rows[0].actor_person_id == seeded_user.id
    assert rows[0].entity_id == str(seeded_user.id)
    assert (await client.get(ME, headers=hdrs)).json() == []
    for target in (theirs, mine, uuid.uuid4()):
        r = await client.delete(f"{ME}/{target}", headers=hdrs)
        assert r.status_code == 404 and _code(r) == "biometric_key_not_found"
    assert (await _fresh_key(db, theirs)).revoked_at is None


async def test_me_routes_work_during_a_freeze(client, db, seeded_user):
    mine = await _key(db, seeded_user.id, await _kiosk(db))
    sa, _ = await _super(db, client)
    assert (await client.put("/system/admin", headers=sa,
                             json={"read_only": True})).status_code == 200
    hdrs = await login(client)
    assert len((await client.get(ME, headers=hdrs)).json()) == 1
    r = await client.delete(f"{ME}/{mine}", headers=hdrs)
    assert r.status_code == 204, r.text
    assert (await _fresh_key(db, mine)).revoked_at is not None


async def test_forgotten_key_no_longer_signs_in(client, db, seeded_user):
    """End to end: after a forget from /me the kiosk card is gone."""
    phone = await _kiosk(db, name="Alice phone")
    device = await _fresh_device(db, phone)
    device.personal_person_id = seeded_user.id
    serial = device.serial
    await db.commit()
    mine = await _key(db, seeded_user.id, phone)
    r = await client.post("/kiosk/biometric/challenge", json={"serial": serial})
    assert r.status_code == 200 and r.json()["key_id"] == str(mine)
    hdrs = await login(client)
    assert (await client.delete(f"{ME}/{mine}", headers=hdrs)).status_code == 204
    r = await client.post("/kiosk/biometric/challenge", json={"serial": serial})
    assert r.status_code == 404 and _code(r) == "no_biometric"
