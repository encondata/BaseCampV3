"""Push Task 7: "This is my phone" (PUT/GET /kiosk/personal), the push
registration (POST/DELETE /kiosk/push/registration) and the push key that
refreshes the FCM token with no sign-in (PUT /kiosk/push/registration/token).

The app's session reaches only its own phone: the device is always the one
whose serial the kiosk session is bound to (kiosk.own_device). Any admin
(rank 60+) may claim a phone nobody owns; only the owner turns it off; every
personal change deletes the phone's push registration, which kills its key.

Spec: docs/superpowers/specs/2026-11-17-android-push-notifications-design.md
(decisions 4 and 14, "API: endpoints")."""

import hashlib
import logging
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from serversherpa.api.routes import kiosk_push as push_routes
from serversherpa.db.models import (
    AuditLog,
    BiometricKey,
    Device,
    Person,
    PushRegistration,
    UserAccount,
)
from serversherpa.people import bulk_import as bi
from serversherpa.services import push_registrations
from serversherpa.wiki.share_links import IpRateLimiter
from tests.push_helpers import _phone
from tests.test_kiosk_biometric_api import _beat, _kiosk_login, _person
from tests.test_status_values_write import PW, _make
from tests.test_system_admin_api import _admin as _super_admin

SERIAL = "android-push-0001"
ADMIN = "push-admin@test.example.com"
OTHER_ADMIN = "push-admin2@test.example.com"
TOKEN = "fcm-token-aaaa"


# ── helpers ─────────────────────────────────────────────────────────

def _code(resp) -> str:
    return resp.json()["detail"]["code"]


def _reason(resp) -> str:
    return resp.json()["detail"]["reason"]


async def _on_phone(db, client, role="admin", email=ADMIN, serial=SERIAL, **beat):
    """`email` (a new `role` login) signed in on the kiosk app on `serial`:
    the first heartbeat binds the session and registers the phone."""
    await _make(db, client, role, email)
    hdrs = await _kiosk_login(client, email)
    await _beat(client, hdrs, serial, login_method="password", **beat)
    return hdrs, await _person(db, email)


async def _device(db, serial=SERIAL) -> Device:
    db.expire_all()
    return await db.scalar(select(Device).where(Device.serial == serial))


async def _set_device(db, serial=SERIAL, **values):
    db.expire_all()
    await db.execute(update(Device).where(Device.serial == serial).values(**values))
    await db.commit()


async def _personal(client, hdrs, on: bool):
    return await client.put("/kiosk/personal", headers=hdrs, json={"on": on})


async def _register(client, hdrs, token=TOKEN):
    return await client.post("/kiosk/push/registration", headers=hdrs, json={"token": token})


def _key_header(registration_id, key) -> dict:
    return {"Authorization": f"PushKey {registration_id}.{key}"}


async def _claimed_and_registered(db, client, **kw):
    hdrs, person = await _on_phone(db, client, **kw)
    assert (await _personal(client, hdrs, True)).status_code == 200
    r = await _register(client, hdrs)
    assert r.status_code == 200, r.text
    return hdrs, person, r.json()


async def _registrations(db) -> list[PushRegistration]:
    db.expire_all()
    return list((await db.scalars(select(PushRegistration))).all())


async def _refresh(client, body, token="fcm-token-bbbb"):
    return await client.put("/kiosk/push/registration/token",
                            headers=_key_header(body["registration_id"], body["push_key"]),
                            json={"token": token})


# ── This is my phone ────────────────────────────────────────────────

async def test_admin_claims_unowned_phone(client, db, seeded_user):
    hdrs, person = await _on_phone(db, client)
    got = await client.get("/kiosk/personal", headers=hdrs)
    assert got.status_code == 200, got.text
    assert got.json() == {"on": False, "owner_name": None, "push_registered": False}

    r = await _personal(client, hdrs, True)
    assert r.status_code == 200, r.text
    assert r.json() == {"on": True, "owner_name": person.display_name}
    device = await _device(db)
    assert device.personal_person_id == person.id
    assert device.personal_set_by == person.id and device.personal_set_at is not None

    # the same again changes nothing and audits nothing more
    assert (await _personal(client, hdrs, True)).json()["on"] is True
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "personal_set"))).all()
    assert len(audits) == 1
    got = await client.get("/kiosk/personal", headers=hdrs)
    assert got.json() == {"on": True, "owner_name": person.display_name,
                          "push_registered": False}


async def test_staff_refused_not_admin(client, db, seeded_user):
    hdrs, _ = await _on_phone(db, client, role="staff", email="push-staff@test.example.com")
    r = await _personal(client, hdrs, True)
    assert r.status_code == 422 and _reason(r) == "not_admin"
    assert (await _device(db)).personal_person_id is None


async def test_zebra_refused(client, db, seeded_user):
    hdrs, _ = await _on_phone(db, client, raw_info={"manufacturer": "Zebra Technologies"})
    assert (await _device(db)).sub_type == "zebra"
    r = await _personal(client, hdrs, True)
    assert r.status_code == 422 and _reason(r) == "zebra"
    assert (await _device(db)).personal_person_id is None


async def test_station_refused(client, db, seeded_user):
    hdrs, _ = await _on_phone(db, client)
    await _set_device(db, station_key_hash="k" * 64)
    r = await _personal(client, hdrs, True)
    assert r.status_code == 422 and _reason(r) == "shared_station"
    assert (await _device(db)).personal_person_id is None


async def test_platform_unknown_refused(client, db, seeded_user):
    hdrs, _ = await _on_phone(db, client)
    await _set_device(db, sub_type=None)
    r = await _personal(client, hdrs, True)
    assert r.status_code == 422 and _reason(r) == "platform_unknown"
    assert (await _device(db)).personal_person_id is None


async def test_owned_by_other_refused(client, db, seeded_user):
    hdrs, _ = await _on_phone(db, client)
    alice = await _person(db, "alice@test.example.com")
    await _set_device(db, personal_person_id=alice.id)
    r = await _personal(client, hdrs, True)
    assert r.status_code == 422 and _reason(r) == "owned_by_other"
    assert (await _device(db)).personal_person_id == alice.id
    got = await client.get("/kiosk/personal", headers=hdrs)
    assert got.json() == {"on": False, "owner_name": alice.display_name,
                          "push_registered": False}


async def test_only_owner_turns_off(client, db, seeded_user):
    owner_hdrs, owner = await _on_phone(db, client)
    assert (await _personal(client, owner_hdrs, True)).status_code == 200
    # a second admin signed in on the same phone
    other_hdrs, _ = await _on_phone(db, client, email=OTHER_ADMIN)
    r = await _personal(client, other_hdrs, False)
    assert r.status_code == 422 and _reason(r) == "not_owner"
    assert (await _device(db)).personal_person_id == owner.id

    r = await _personal(client, owner_hdrs, False)
    assert r.status_code == 200, r.text
    assert r.json() == {"on": False, "owner_name": None}
    device = await _device(db)
    assert device.personal_person_id is None and device.personal_set_by is None
    # off on a phone nobody owns is a quiet no-op
    assert (await _personal(client, other_hdrs, False)).json() == {"on": False,
                                                                   "owner_name": None}


async def test_off_revokes_biometric_and_drops_registration(client, db, seeded_user):
    hdrs, person, body = await _claimed_and_registered(db, client)
    device = await _device(db)
    key = BiometricKey(person_id=person.id, device_id=device.id, public_key=b"\x30fake",
                       key_alg="ES256", security_level="tee",
                       password_sign_in_at=datetime.now(UTC))
    db.add(key)
    await db.commit()
    key_id = key.id

    r = await _personal(client, hdrs, False)
    assert r.status_code == 200, r.text
    db.expire_all()
    key = await db.get(BiometricKey, key_id)
    assert key.revoked_at is not None and key.revoke_reason == "reassigned"
    assert await _registrations(db) == []
    assert (await _refresh(client, body)).status_code == 401


async def test_audit_source_kiosk(client, db, seeded_user):
    hdrs, person = await _on_phone(db, client)
    await _personal(client, hdrs, True)
    await _personal(client, hdrs, False)
    device = await _device(db)
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.entity_id == str(device.id),
        AuditLog.action.in_(("personal_set", "personal_cleared")))
        .order_by(AuditLog.at, AuditLog.id))).all()
    assert [(a.action, a.changes) for a in rows] == [
        ("personal_set", {"person_id": {"from": None, "to": str(person.id)},
                          "source": "kiosk"}),
        ("personal_cleared", {"person_id": {"from": str(person.id), "to": None},
                              "source": "kiosk"}),
    ]
    assert all(a.actor_person_id == person.id for a in rows)


async def test_session_from_other_device_refused(client, db, seeded_user):
    # a portal session is never a phone
    portal = await _make(db, client, "admin", ADMIN)
    for call in (client.get("/kiosk/personal", headers=portal),
                 client.put("/kiosk/personal", headers=portal, json={"on": True}),
                 client.post("/kiosk/push/registration", headers=portal,
                             json={"token": TOKEN})):
        r = await call
        assert r.status_code == 403 and _code(r) == "not_this_kiosk"

    # a kiosk session no heartbeat has bound yet
    unbound = await _kiosk_login(client, ADMIN)
    r = await _personal(client, unbound, True)
    assert r.status_code == 403 and _code(r) == "not_this_kiosk"

    # bound to phone A: it reaches A only, and a beat for B doesn't move it
    await _beat(client, unbound, "android-push-A", login_method="password")
    other = await _kiosk_login(client, ADMIN)
    await _beat(client, other, "android-push-B", login_method="password")
    await _beat(client, unbound, "android-push-B", login_method="password")
    assert (await _personal(client, unbound, True)).status_code == 200
    person = await _person(db, ADMIN)
    assert (await _device(db, "android-push-A")).personal_person_id == person.id
    assert (await _device(db, "android-push-B")).personal_person_id is None


# ── registration and the push key ───────────────────────────────────

async def test_register_returns_key_once_and_hashes_it(client, db, seeded_user, caplog):
    caplog.set_level(logging.DEBUG, logger="serversherpa")
    hdrs, person = await _on_phone(db, client)
    # not personal yet
    r = await _register(client, hdrs)
    assert r.status_code == 403 and _code(r) == "not_personal_device"
    assert (await _personal(client, hdrs, True)).status_code == 200

    r = await _register(client, hdrs)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"registration_id", "push_key"}
    assert len(body["push_key"]) >= 43                     # 256 bits, url-safe base64
    device_id = (await _device(db)).id
    [row] = await _registrations(db)
    assert str(row.id) == body["registration_id"]
    assert row.person_id == person.id and row.device_id == device_id
    assert (row.platform, row.provider, row.token) == ("android", "fcm", TOKEN)
    assert row.secret_hash == hashlib.sha256(body["push_key"].encode()).hexdigest()
    # the module's records are captured (so the check below is real)...
    assert f"push registration {body['registration_id']}" in caplog.text
    # ...and carry neither the key nor the token
    assert body["push_key"] not in caplog.text and TOKEN not in caplog.text

    # the key is never shown again...
    got = (await client.get("/kiosk/personal", headers=hdrs)).json()
    assert got["push_registered"] is True and body["push_key"] not in str(got)
    # ...and registering again replaces the row's key and token
    r2 = await _register(client, hdrs, token="fcm-token-cccc")
    assert r2.status_code == 200
    [row] = await _registrations(db)
    assert str(row.id) == r2.json()["registration_id"] and row.token == "fcm-token-cccc"
    assert (await _refresh(client, body)).status_code == 401
    assert (await _refresh(client, r2.json())).status_code == 204

    # a staff session on an admin's phone can't register
    staff, _ = await _on_phone(db, client, role="staff", email="push-staff@test.example.com",
                               serial="android-push-staff")
    staff_person = await _person(db, "push-staff@test.example.com")
    await _set_device(db, "android-push-staff", personal_person_id=staff_person.id)
    r = await _register(client, staff)
    assert r.status_code == 403 and _code(r) == "not_admin"

    # DELETE: only its owner, then a quiet 204
    other_hdrs, _ = await _on_phone(db, client, email=OTHER_ADMIN)
    r = await client.delete("/kiosk/push/registration", headers=other_hdrs)
    assert r.status_code == 403 and _code(r) == "not_owner"
    assert len(await _registrations(db)) == 1
    assert (await client.delete("/kiosk/push/registration", headers=hdrs)).status_code == 204
    assert await _registrations(db) == []
    assert (await client.delete("/kiosk/push/registration", headers=hdrs)).status_code == 204


async def test_token_refresh_with_push_key(client, db, seeded_user):
    hdrs, _, body = await _claimed_and_registered(db, client)
    # signed out: the push key needs no session at all
    assert (await client.post("/auth/logout", headers=hdrs)).status_code in (200, 204)
    r = await _refresh(client, body)
    assert r.status_code == 204, r.text
    [row] = await _registrations(db)
    assert row.token == "fcm-token-bbbb" and row.last_error is None

    # a lapsed kiosk registration stops the key until a sign-in renews it
    await _set_device(db, token_expires_at=datetime.now(UTC) - timedelta(minutes=1))
    r = await _refresh(client, body, token="fcm-token-dddd")
    assert r.status_code == 401 and _code(r) == "push_key_invalid"
    await _set_device(db, token_expires_at=datetime.now(UTC) + timedelta(days=1))
    assert (await _refresh(client, body, token="fcm-token-dddd")).status_code == 204

    # a token another phone held moves here (FCM tokens are unique)
    owner = await _person(db, ADMIN)
    other = await _phone(db, owner)
    await db.commit()
    other_token = (await db.scalar(select(PushRegistration.token).where(
        PushRegistration.device_id == other.id)))
    assert (await _refresh(client, body, token=other_token)).status_code == 204
    rows = await _registrations(db)
    assert [r.token for r in rows] == [other_token]


async def test_wrong_key_flat_401(client, db, seeded_user, monkeypatch):
    hdrs, _, body = await _claimed_and_registered(db, client)
    rid, key = body["registration_id"], body["push_key"]
    bad = [
        {},
        {"Authorization": f"PushKey {rid}.{key}x"},
        {"Authorization": f"PushKey {rid}.{key[:-1]}"},
        {"Authorization": f"PushKey 6f1d9a43-0000-4000-8000-000000000000.{key}"},
        {"Authorization": f"PushKey {rid}"},
        {"Authorization": f"PushKey not-a-uuid.{key}"},
        {"Authorization": f"Station {key}"},
        {"Authorization": f"pushkey {rid}.{key}"},
        hdrs,                                              # a session is not a push key
    ]
    for headers in bad:
        r = await client.put("/kiosk/push/registration/token", headers=headers,
                             json={"token": "x"})
        assert r.status_code == 401, (headers, r.text)
        assert r.json() == {"detail": {"code": "push_key_invalid"}}
    assert [row.token for row in await _registrations(db)] == [TOKEN]

    # wrong keys are capped per address; the right key alone never counts
    monkeypatch.setattr(push_routes, "push_key_limiter",
                        IpRateLimiter(limit=3, window_seconds=3600))
    for _ in range(5):
        assert (await _refresh(client, body)).status_code == 204
    for _ in range(3):
        assert (await client.put("/kiosk/push/registration/token",
                                 headers=_key_header(rid, "nope"),
                                 json={"token": "x"})).status_code == 401
    r = await _refresh(client, body)
    assert r.status_code == 429 and _code(r) == "rate_limited"


async def test_key_dead_after_portal_reassign(client, db, seeded_user):
    _, _, body = await _claimed_and_registered(db, client)
    sa = await _super_admin(db, client)
    alice = await _person(db, "alice@test.example.com")
    device = await _device(db)
    r = await client.put(f"/devices/{device.id}/personal", headers=sa,
                         json={"person_id": str(alice.id)})
    assert r.status_code == 200, r.text
    assert await _registrations(db) == []
    r = await _refresh(client, body)
    assert r.status_code == 401 and _code(r) == "push_key_invalid"


async def test_key_dead_when_device_no_longer_personal_to_owner(client, db, seeded_user):
    """verify_key applies live_registrations' rules even to a row a writer
    missed: the device's owner changed, a Zebra, a shared station."""
    _, _, body = await _claimed_and_registered(db, client)
    alice = await _person(db, "alice@test.example.com")
    owner = (await _device(db)).personal_person_id
    for values in ({"personal_person_id": alice.id}, {"sub_type": "zebra"},
                   {"station_type": "label"}):
        await _set_device(db, **values)
        assert (await _refresh(client, body)).status_code == 401, values
        await _set_device(db, personal_person_id=owner, sub_type="android", station_type=None)
        assert (await _refresh(client, body)).status_code == 204


async def test_platform_change_drops_registration(client, db, seeded_user):
    hdrs, _, _ = await _claimed_and_registered(db, client)
    # the owner checks the phone in as an iPad: assignment, keys and push go
    await _beat(client, hdrs, SERIAL, mode="ios")
    assert (await _device(db)).personal_person_id is None
    assert await _registrations(db) == []


# ── people losing access ────────────────────────────────────────────

async def _target_with_phone(db, client, email, role="admin"):
    await _make(db, client, role, email)
    person = await db.scalar(select(Person).where(Person.email == email))
    await _phone(db, person)
    await db.commit()
    return person.id


async def test_demote_drops_registrations(client, db, seeded_user):
    sa = await _super_admin(db, client)
    target = await _target_with_phone(db, client, "push-demote@test.example.com")
    bystander = await _target_with_phone(db, client, "push-bystander@test.example.com")
    r = await client.post(f"/users/{target}/demote", headers=sa)
    assert r.status_code == 204, r.text
    assert [row.person_id for row in await _registrations(db)] == [bystander]


async def test_disable_and_blacklist_drop_registrations(client, db, seeded_user):
    sa = await _super_admin(db, client)
    disabled = await _target_with_phone(db, client, "push-disabled@test.example.com")
    listed = await _target_with_phone(db, client, "push-listed@test.example.com", "worker")
    imported = await _target_with_phone(db, client, "push-imported@test.example.com",
                                        "worker")
    bystander = await _target_with_phone(db, client, "push-bystander@test.example.com")

    assert (await client.post(f"/users/{disabled}/disable", headers=sa)).status_code == 204
    r = await client.put(f"/workers/{listed}/profile", headers=sa, json={
        "status": "blacklist", "status_note": "No-show on two moves"})
    assert r.status_code == 204, r.text
    sa_id = (await _person(db, "sa@test.example.com")).id
    imported_person = await db.get(Person, imported)
    out = await bi.commit_rows(
        db, bi.number_json_rows([{"first_name": imported_person.first_name,
                                  "last_name": imported_person.last_name,
                                  "email": "push-imported@test.example.com",
                                  "status": "blacklist", "status_note": "no-show x3"}]),
        actor_id=sa_id, actor_rank=80, approved_updates={str(imported)},
        source_label="test.csv")
    assert out["updated"] == 1, out
    assert [row.person_id for row in await _registrations(db)] == [bystander]
    assert (await db.get(UserAccount, disabled)).disabled_at is not None


async def test_drop_helpers(db, seeded_user):
    alice = await db.scalar(select(Person).where(Person.email == "alice@test.example.com"))
    one = await _phone(db, alice)
    await _phone(db, alice)
    assert await push_registrations.drop_for_device(db, one.id, reason="test") is True
    assert await push_registrations.drop_for_device(db, one.id, reason="test") is False
    assert await push_registrations.drop_for_person(db, alice.id, reason="test") == 1
    assert await push_registrations.drop_for_person(db, alice.id, reason="test") == 0


@pytest.mark.parametrize("header", ["", "PushKey", "PushKey .", "PushKey a.b.c",
                                    "Bearer x.y"])
async def test_verify_key_malformed_is_none(db, header):
    assert await push_registrations.verify_key(db, header) is None


# ── fix round 1: revoke-all, races, read-only ──────────────────────

async def test_per_person_revoke_all_drops_push(client, db, seeded_user):
    sa = await _super_admin(db, client)
    target = await _target_with_phone(db, client, "push-revoke@test.example.com")
    bystander = await _target_with_phone(db, client, "push-bystander@test.example.com")
    r = await client.post(f"/users/{target}/sessions/revoke-all", headers=sa)
    assert r.status_code == 204, r.text
    assert [row.person_id for row in await _registrations(db)] == [bystander]


async def test_system_revoke_all_drops_every_registration(client, db, seeded_user):
    sa = await _super_admin(db, client)
    await _target_with_phone(db, client, "push-one@test.example.com")
    await _target_with_phone(db, client, "push-two@test.example.com")
    assert len(await _registrations(db)) == 2
    r = await client.post("/system/sessions/revoke-all", headers=sa)
    assert r.status_code == 200, r.text
    assert await _registrations(db) == []


async def test_password_change_keeps_push(client, db, seeded_user):
    _, _, body = await _claimed_and_registered(db, client)
    portal = await client.post("/auth/login", json={"email": ADMIN, "password": PW})
    assert portal.status_code == 200, portal.text
    mine = {"Authorization": f"Bearer {portal.json()['access_token']}"}
    r = await client.post("/auth/me/password", headers=mine, json={
        "current_password": PW, "new_password": "NewHorse-Battery-42"})
    assert r.status_code == 204, r.text
    assert len(await _registrations(db)) == 1
    # the key needs no session, so it still works after the sign-out
    assert (await _refresh(client, body)).status_code == 204


async def _other_phone_token(db) -> str:
    """A token alice's phone (another device) already holds."""
    alice = await db.scalar(select(Person).where(Person.email == "alice@test.example.com"))
    other = await _phone(db, alice)
    await db.commit()
    return await db.scalar(select(PushRegistration.token).where(
        PushRegistration.device_id == other.id))


async def test_register_retakes_token_after_a_collision(client, db, seeded_user,
                                                        monkeypatch, caplog):
    """Another phone stored the same token between our free and our write: the
    write collides, its savepoint rolls back, and the retry takes the token."""
    caplog.set_level(logging.DEBUG)
    hdrs, _ = await _on_phone(db, client)
    assert (await _personal(client, hdrs, True)).status_code == 200
    taken = await _other_phone_token(db)
    real_free = push_registrations._free_token
    calls = []

    async def late_free(db_, token, *, keep_device):
        calls.append(token)
        if len(calls) > 1:                     # the first pass misses the other row
            await real_free(db_, token, keep_device=keep_device)

    monkeypatch.setattr(push_registrations, "_free_token", late_free)
    r = await _register(client, hdrs, token=taken)
    assert r.status_code == 200, r.text
    assert len(calls) == 2
    rows = await _registrations(db)
    assert [(row.token, str(row.id)) for row in rows] == [(taken, r.json()["registration_id"])]
    assert taken not in caplog.text


async def test_token_conflict_twice_is_409_without_the_token(client, db, seeded_user,
                                                             monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    hdrs, _, body = await _claimed_and_registered(db, client)
    taken = await _other_phone_token(db)

    async def never_free(db_, token, *, keep_device):
        return None

    monkeypatch.setattr(push_registrations, "_free_token", never_free)
    for r in (await _register(client, hdrs, token=taken),
              await _refresh(client, body, token=taken)):
        assert r.status_code == 409, r.text
        assert r.json() == {"detail": {"code": "token_conflict"}}
    assert taken not in caplog.text
    # both rows are as they were, and the phone's key still works
    assert sorted(row.token for row in await _registrations(db)) == sorted([TOKEN, taken])
    monkeypatch.undo()
    assert (await _refresh(client, body)).status_code == 204


async def test_token_refresh_after_row_deleted_is_401(client, db, seeded_user, monkeypatch):
    """The row is deleted between the key check and the write."""
    _, _, body = await _claimed_and_registered(db, client)
    real_update = push_registrations.update_token

    async def deleted_first(db_, registration, token):
        await push_registrations.drop_for_device(db_, registration.device_id, reason="test")
        return await real_update(db_, registration, token)

    monkeypatch.setattr(push_registrations, "update_token", deleted_first)
    r = await _refresh(client, body)
    assert r.status_code == 401 and r.json() == {"detail": {"code": "push_key_invalid"}}


async def test_token_refresh_refused_in_read_only_mode(client, db, seeded_user):
    _, _, body = await _claimed_and_registered(db, client)
    sa = await _super_admin(db, client)
    r = await client.put("/system/admin", headers=sa, json={"read_only": True})
    assert r.status_code == 200, r.text
    r = await _refresh(client, body)
    assert r.status_code == 423 and _code(r) == "read_only_mode"
    assert [row.token for row in await _registrations(db)] == [TOKEN]
    r = await client.put("/system/admin", headers=sa, json={"read_only": False})
    assert r.status_code == 200, r.text
    assert (await _refresh(client, body)).status_code == 204
