"""Every place sessions or trust are revoked also revokes biometric keys
(spec §Rules › Revoked automatically): password change and reset, disable,
blacklist (portal + bulk import), demote, per-person and global revoke-all.

Each test enrolls a key for the target and one for a bystander, runs the
path, and asserts the target's key carries the expected reason, its nonce
is cleared and the revoke is audited, while the bystander's key stays live."""

import itertools
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog,
    BiometricKey,
    Device,
    Person,
    PersonRole,
    UserAccount,
)
from serversherpa.people import bulk_import as bi
from tests.test_password_reset_api import EMAIL, _latest_raw, _request
from tests.test_status_values_write import PW, _make

_serials = itertools.count(1)


async def _person_id(db, email: str) -> uuid.UUID:
    return await db.scalar(select(Person.id).where(Person.email == email))


async def _key(db, person_id: uuid.UUID) -> uuid.UUID:
    """A live key on a fresh personal phone, with a nonce outstanding."""
    now = datetime.now(UTC)
    device = Device(device_type="kiosk", name="Pixel", sub_type="android",
                    serial=f"android-rev-{next(_serials)}", personal_person_id=person_id,
                    personal_set_at=now, personal_set_by=person_id)
    db.add(device)
    await db.flush()
    key = BiometricKey(person_id=person_id, device_id=device.id,
                       public_key=b"\x30\x59fake-der", key_alg="ES256",
                       security_level="tee", password_sign_in_at=now,
                       last_nonce="jti:1")
    db.add(key)
    await db.commit()
    return key.id


async def _assert_revoked(db, key_id: uuid.UUID, reason: str) -> None:
    db.expire_all()
    key = await db.get(BiometricKey, key_id)
    assert key.revoked_at is not None, "key still live"
    assert key.revoke_reason == reason
    assert key.last_nonce is None
    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "biometric_revoke", AuditLog.entity_id == str(key_id)))
    assert audit_row is not None and audit_row.changes["reason"] == reason


async def _assert_live(db, key_id: uuid.UUID) -> None:
    db.expire_all()
    key = await db.get(BiometricKey, key_id)
    assert key.revoked_at is None and key.revoke_reason is None
    assert key.last_nonce == "jti:1"


async def _pair(db, target_email: str) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """(target person id, target key, bystander key)."""
    target = await _person_id(db, target_email)
    other = await _person_id(db, "bystander@test.example.com")
    return target, await _key(db, target), await _key(db, other)


@pytest.fixture
async def bystander(db, client, seeded_user):
    await _make(db, client, "worker", "bystander@test.example.com")


# ── password set: admin reset, own change, self-service reset ───────


async def test_admin_reset_password_revokes_keys(client, db, bystander):
    admin = await _make(db, client, "admin", "rev-admin@test.example.com")
    await _make(db, client, "worker", "rev-wan@test.example.com")
    target, key, other = await _pair(db, "rev-wan@test.example.com")
    resp = await client.post(f"/users/{target}/reset-password", headers=admin, json={
        "temp_password": "TempPassw0rd-12", "must_change_password": True})
    assert resp.status_code == 204, resp.text
    await _assert_revoked(db, key, "password_change")
    await _assert_live(db, other)


async def test_own_password_change_revokes_all_their_keys(client, db, bystander):
    mine = await _make(db, client, "worker", "rev-me@test.example.com")
    target, key, other = await _pair(db, "rev-me@test.example.com")
    second = await _key(db, target)          # another phone of theirs
    resp = await client.post("/auth/me/password", headers=mine, json={
        "current_password": PW, "new_password": "NewHorse-Battery-42"})
    assert resp.status_code == 204, resp.text
    await _assert_revoked(db, key, "password_change")
    await _assert_revoked(db, second, "password_change")
    await _assert_live(db, other)


async def test_self_service_reset_revokes_keys(client, db, bystander, email_on):
    _, key, other = await _pair(db, EMAIL)
    await _request(client)
    raw = await _latest_raw(db)
    done = await client.post("/auth/password-reset/confirm",
                             json={"token": raw, "new_password": "BrandNewPass9!"})
    assert done.status_code == 204, done.text
    await _assert_revoked(db, key, "password_change")
    await _assert_live(db, other)


# ── disable ─────────────────────────────────────────────────────────


async def test_disable_revokes_keys(client, db, bystander):
    admin = await _make(db, client, "admin", "rev-admin@test.example.com")
    await _make(db, client, "worker", "rev-wan@test.example.com")
    target, key, other = await _pair(db, "rev-wan@test.example.com")
    resp = await client.post(f"/users/{target}/disable", headers=admin)
    assert resp.status_code == 204, resp.text
    await _assert_revoked(db, key, "account_disabled")
    await _assert_live(db, other)


async def test_enable_does_not_bring_the_key_back(client, db, bystander):
    admin = await _make(db, client, "admin", "rev-admin@test.example.com")
    await _make(db, client, "worker", "rev-wan@test.example.com")
    target, key, _ = await _pair(db, "rev-wan@test.example.com")
    assert (await client.post(f"/users/{target}/disable", headers=admin)).status_code == 204
    assert (await client.post(f"/users/{target}/enable", headers=admin)).status_code == 204
    await _assert_revoked(db, key, "account_disabled")


# ── blacklist ───────────────────────────────────────────────────────


async def test_blacklist_revokes_keys(client, db, bystander):
    admin = await _make(db, client, "admin", "rev-admin@test.example.com")
    await _make(db, client, "worker", "rev-wan@test.example.com")
    target, key, other = await _pair(db, "rev-wan@test.example.com")
    resp = await client.put(f"/workers/{target}/profile", headers=admin, json={
        "status": "blacklist", "status_note": "No-show on two moves"})
    assert resp.status_code == 204, resp.text
    await _assert_revoked(db, key, "blacklist")
    await _assert_live(db, other)


async def test_un_blacklist_keeps_key_revoked(client, db, bystander):
    admin = await _make(db, client, "admin", "rev-admin@test.example.com")
    await _make(db, client, "worker", "rev-wan@test.example.com")
    target, key, _ = await _pair(db, "rev-wan@test.example.com")
    assert (await client.put(f"/workers/{target}/profile", headers=admin, json={
        "status": "blacklist", "status_note": "No-show"})).status_code == 204
    assert (await client.put(f"/workers/{target}/profile", headers=admin, json={
        "status": "active"})).status_code == 204
    await _assert_revoked(db, key, "blacklist")


async def test_bulk_import_blacklist_revokes_keys(db, bystander):
    admin = Person(first_name="Ada", last_name="Importer", email="ada@test.example.com")
    db.add(admin)
    await db.flush()
    db.add(PersonRole(person_id=admin.id, role="admin"))
    worker = Person(first_name="Bad", last_name="Actor", email="bad@test.example.com")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    db.add(UserAccount(person_id=worker.id, email="bad@test.example.com", password_hash="x"))
    await db.commit()
    admin_id, target = admin.id, worker.id
    key = await _key(db, target)
    other = await _key(db, await _person_id(db, "bystander@test.example.com"))

    def run(rows):
        return bi.commit_rows(db, bi.number_json_rows(rows), actor_id=admin_id,
                              actor_rank=60, approved_updates={str(target)},
                              source_label="test.csv")

    out = await run([{"first_name": "Bad", "last_name": "Actor", "status": "blacklist",
                      "status_note": "no-show x3"}])
    assert out["updated"] == 1
    await _assert_revoked(db, key, "blacklist")
    await _assert_live(db, other)

    # leaving blacklist restores the login, not the key
    out = await run([{"first_name": "Bad", "last_name": "Actor", "status": "active"}])
    assert out["updated"] == 1
    await _assert_revoked(db, key, "blacklist")


# ── demote ──────────────────────────────────────────────────────────


async def test_demote_revokes_keys_before_the_account_goes(client, db, bystander):
    admin = await _make(db, client, "admin", "rev-admin@test.example.com")
    await _make(db, client, "staff", "rev-wan@test.example.com")
    target, key, other = await _pair(db, "rev-wan@test.example.com")
    resp = await client.post(f"/users/{target}/demote", headers=admin)
    assert resp.status_code == 204, resp.text
    assert await db.get(UserAccount, target) is None      # the account is gone...
    await _assert_revoked(db, key, "demoted")             # ...the key is revoked, not orphaned
    await _assert_live(db, other)


# ── revoke-all ──────────────────────────────────────────────────────


async def test_per_person_revoke_all_revokes_keys(client, db, bystander):
    admin = await _make(db, client, "admin", "rev-admin@test.example.com")
    await _make(db, client, "worker", "rev-wan@test.example.com")
    target, key, other = await _pair(db, "rev-wan@test.example.com")
    resp = await client.post(f"/users/{target}/sessions/revoke-all", headers=admin)
    assert resp.status_code == 204, resp.text
    await _assert_revoked(db, key, "admin")
    await _assert_live(db, other)


async def test_global_revoke_all_revokes_every_key(client, db, bystander):
    admin = await _make(db, client, "super_admin", "rev-admin@test.example.com")
    await _make(db, client, "worker", "rev-wan@test.example.com")
    _, key, other = await _pair(db, "rev-wan@test.example.com")
    # a person with no live session at all still loses the key
    admin_key = await _key(db, await _person_id(db, "rev-admin@test.example.com"))
    resp = await client.post("/system/sessions/revoke-all", headers=admin)
    assert resp.status_code == 200, resp.text
    await _assert_revoked(db, key, "admin")
    await _assert_revoked(db, other, "admin")
    await _assert_revoked(db, admin_key, "admin")
