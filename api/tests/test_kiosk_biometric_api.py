"""Kiosk biometric sign-in (Task 3): enroll-challenge, enroll, challenge,
sign-in and forget under /kiosk/biometric, the 30-day anchor's renewal on a
password session's bind, the read-only freeze exemptions and the shared
move-login failure cap.

The attestation verifier is patched to return a software key made here, so
these tests sign challenges with `cryptography`; the verifier has its own
tests (test_key_attestation.py).

Design: docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md
§Rules."""

import base64
import hashlib
import logging
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select, update

from serversherpa.api.routes import kiosk as kiosk_routes
from serversherpa.api.routes import kiosk_biometric as bio_routes
from serversherpa.db.models import (
    AuditLog,
    AuthSession,
    BiometricKey,
    Device,
    Initiative,
    Person,
    PersonRole,
    UserAccount,
)
from serversherpa.security.attestation_status import AttestationStatus
from serversherpa.security.key_attestation import AttestationError, AttestedKey
from serversherpa.services import biometric
from serversherpa.services.auth import hash_refresh_token
from serversherpa.services.password_policy import PasswordPolicy
from tests.test_kiosk_pairing_api import _create, _poll
from tests.test_sites_api import login
from tests.test_status_values_write import PW, _make
from tests.test_system_admin_api import _admin

SERIAL = "android-bio-0001"
EMAIL = "bio-worker@test.example.com"
MOVE_PW = "Crew-2026!"


# ── helpers ─────────────────────────────────────────────────────────

class FakeAttestation:
    """Stands in for verify_attestation: returns the next software key's
    public half and records the nonce it was asked to check."""

    def __init__(self):
        self.calls: list[dict] = []
        self.keys: list[ec.EllipticCurvePrivateKey] = []
        self.error: AttestationError | None = None

    def __call__(self, chain_der, *, nonce, digests, status, roots=None, now=None):
        self.calls.append({"chain": chain_der, "nonce": nonce, "digests": digests,
                           "status": status})
        if self.error is not None:
            raise self.error
        key = ec.generate_private_key(ec.SECP256R1())
        self.keys.append(key)
        der = key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        return AttestedKey(public_key_der=der, security_level="strongbox")


@pytest.fixture
def attest(monkeypatch):
    fake = FakeAttestation()
    monkeypatch.setattr(biometric, "verify_attestation", fake)

    async def fresh(_db):
        return AttestationStatus(fetched_at=datetime.now(UTC), revoked_serials=set())

    monkeypatch.setattr(biometric, "load_status", fresh)
    return fake


async def _kiosk_login(client, email=EMAIL) -> dict:
    resp = await client.post("/auth/login", json={
        "email": email, "password": PW, "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _beat(client, hdrs, serial=SERIAL, **extra):
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": serial, "name": "Phone", "mode": "android", "sign_in": True, **extra})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _person(db, email=EMAIL) -> SimpleNamespace:
    """The person's id and name, as plain values: the test session's ORM
    objects expire on every commit."""
    row = await db.scalar(select(Person).where(Person.email == email))
    return SimpleNamespace(id=row.id, display_name=row.display_name)


async def _make_personal(db, serial, person_id) -> Device:
    db.expire_all()
    device = await db.scalar(select(Device).where(Device.serial == serial))
    device.personal_person_id = person_id
    await db.commit()
    return device


async def _worker_on_phone(db, client, email=EMAIL, serial=SERIAL) -> tuple[dict, Person]:
    """A worker signed in with their password on their own personal phone."""
    await _make(db, client, "worker", email)
    hdrs = await _kiosk_login(client, email)
    await _beat(client, hdrs, serial, login_method="password")
    person = await _person(db, email)
    await _make_personal(db, serial, person.id)
    return hdrs, person


async def _alice_id(db) -> uuid.UUID:
    return (await _person(db, "alice@test.example.com")).id


async def _enroll_challenge(client, hdrs, serial=SERIAL):
    return await client.post("/kiosk/biometric/enroll-challenge", headers=hdrs,
                             json={"serial": serial})


async def _enroll(client, hdrs, serial=SERIAL, nonce=None):
    if nonce is None:
        r = await _enroll_challenge(client, hdrs, serial)
        assert r.status_code == 200, r.text
        nonce = r.json()["nonce"]
    chain = [base64.b64encode(b"leaf-der").decode(), base64.b64encode(b"root-der").decode()]
    return await client.post("/kiosk/biometric/enroll", headers=hdrs,
                             json={"serial": serial, "nonce": nonce, "chain": chain})


async def _enrolled(db, client, attest, **kw):
    hdrs, person = await _worker_on_phone(db, client, **kw)
    r = await _enroll(client, hdrs, kw.get("serial", SERIAL))
    assert r.status_code == 200, r.text
    return hdrs, person, r.json()["key_id"], attest.keys[-1]


async def _challenge(client, serial=SERIAL):
    return await client.post("/kiosk/biometric/challenge", json={"serial": serial})


def _sign(key, challenge: str) -> str:
    sig = key.sign(challenge.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    return base64.b64encode(sig).decode()


async def _sign_in(client, key_id, challenge, signature):
    return await client.post("/kiosk/biometric/sign-in", json={
        "key_id": key_id, "challenge": challenge, "signature": signature})


async def _challenge_and_sign_in(client, key, serial=SERIAL):
    c = await _challenge(client, serial)
    assert c.status_code == 200, c.text
    body = c.json()
    return await _sign_in(client, body["key_id"], body["challenge"], _sign(key, body["challenge"]))


async def _key(db, key_id) -> BiometricKey:
    db.expire_all()
    return await db.get(BiometricKey, key_id)


async def _set_anchor(db, key_id, when):
    db.expire_all()
    await db.execute(update(BiometricKey).where(BiometricKey.id == key_id)
                     .values(password_sign_in_at=when))
    await db.commit()


def _code(resp) -> str:
    return resp.json()["detail"]["code"]


async def _move_session(db, client, serial=SERIAL) -> tuple[dict, Person]:
    admin = await _make(db, client, "admin", "bio-move-admin@test.example.com")
    init = Initiative(name="Bio Move", initiative_type="move", status="planned")
    db.add(init)
    await db.commit()
    set_pw = await client.patch(f"/initiatives/{init.id}", headers=admin,
                                json={"kiosk_password": MOVE_PW})
    assert set_pw.status_code == 200, set_pw.text
    moved = await client.post("/kiosk/move-login", json={"password": MOVE_PW})
    assert moved.status_code == 200, moved.text
    hdrs = {"Authorization": f"Bearer {moved.json()['access_token']}"}
    await _beat(client, hdrs, serial)
    identity = SimpleNamespace(id=uuid.UUID(moved.json()["person"]["id"]))
    return hdrs, identity


# ── enroll ──────────────────────────────────────────────────────────

async def test_enroll_issues_a_key_and_audits(client, db, seeded_user, attest):
    hdrs, person = await _worker_on_phone(db, client)
    nonce = (await _enroll_challenge(client, hdrs)).json()["nonce"]
    r = await _enroll(client, hdrs, nonce=nonce)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"key_id", "security_level", "renews_at"}
    assert body["security_level"] == "strongbox"
    # the app hands KeyGenParameterSpec the SHA-256 of the nonce string
    assert attest.calls[0]["nonce"] == hashlib.sha256(nonce.encode()).digest()
    assert attest.calls[0]["chain"] == [b"leaf-der", b"root-der"]
    key = await _key(db, body["key_id"])
    assert key.person_id == person.id and key.revoked_at is None
    assert key.security_level == "strongbox" and key.key_alg == "ES256"
    renews = datetime.fromisoformat(body["renews_at"])
    assert renews == key.password_sign_in_at + timedelta(days=30)
    # the anchor is the password sign-in itself
    assert abs((key.password_sign_in_at - datetime.now(UTC)).total_seconds()) < 60
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "biometric_enroll"))).all()
    assert len(audits) == 1 and audits[0].actor_person_id == person.id


async def test_enroll_needs_password_session_within_10_minutes(client, db, seeded_user, attest):
    hdrs, person = await _worker_on_phone(db, client)

    # a password session older than 10 minutes
    db.expire_all()
    sessions = (await db.scalars(select(AuthSession).where(
        AuthSession.person_id == person.id, AuthSession.client == "kiosk"))).all()
    assert len(sessions) == 1
    session_id, original_expiry = sessions[0].id, sessions[0].expires_at
    await db.execute(update(AuthSession).where(AuthSession.id == session_id)
                     .values(expires_at=original_expiry - timedelta(minutes=11)))
    await db.commit()
    r = await _enroll_challenge(client, hdrs)
    assert r.status_code == 403 and _code(r) == "enroll_window_closed"
    # 9 minutes is still inside the window
    await db.execute(update(AuthSession).where(AuthSession.id == session_id)
                     .values(expires_at=original_expiry - timedelta(minutes=9)))
    await db.commit()
    nonce = (await _enroll_challenge(client, hdrs)).json()["nonce"]
    # the window is checked at enroll too, not only at the challenge
    await db.execute(update(AuthSession).where(AuthSession.id == session_id)
                     .values(expires_at=original_expiry - timedelta(minutes=11)))
    await db.commit()
    r = await _enroll(client, hdrs, nonce=nonce)
    assert r.status_code == 403 and _code(r) == "enroll_window_closed"

    # an old session row with no recorded method is never a password one
    await db.execute(update(AuthSession).where(AuthSession.id == session_id)
                     .values(expires_at=original_expiry, login_method=None))
    await db.commit()
    r = await _enroll_challenge(client, hdrs)
    assert r.status_code == 403 and _code(r) == "enroll_window_closed"
    r = await _enroll(client, hdrs, nonce=nonce)
    assert r.status_code == 403 and _code(r) == "enroll_window_closed"

    # a link session (alice approves a pairing on her phone)
    alice = await login(client)
    await _beat(client, alice, "android-bio-alice")
    await _make_personal(db, "android-bio-alice", await _alice_id(db))
    d = await _create(client, serial="android-bio-alice")
    assert (await client.post(f"/kiosk/pair/{d['code']}/approve",
                              headers=alice)).status_code == 204
    polled = await _poll(client, d)
    linked = {"Authorization": f"Bearer {polled.json()['session']['access_token']}"}
    r = await _enroll_challenge(client, linked, "android-bio-alice")
    assert r.status_code == 403 and _code(r) == "enroll_window_closed"

    # a biometric session
    await db.execute(update(AuthSession).where(AuthSession.id == session_id)
                     .values(login_method="password"))
    await db.commit()
    hdrs = await _kiosk_login(client)          # fresh password session
    r = await _enroll(client, hdrs)
    assert r.status_code == 200, r.text
    signed = await _challenge_and_sign_in(client, attest.keys[-1])
    assert signed.status_code == 200, signed.text
    bio = {"Authorization": f"Bearer {signed.json()['access_token']}"}
    r = await _enroll_challenge(client, bio)
    assert r.status_code == 403 and _code(r) == "enroll_window_closed"
    assert len(attest.calls) == 1             # the refused enrolls never reached it


async def test_enroll_needs_a_kiosk_session_on_this_serial(client, db, seeded_user, attest):
    hdrs, person = await _worker_on_phone(db, client)
    # the session is bound to SERIAL; another phone personal to them is refused
    await _beat(client, await _kiosk_login(client), "android-bio-other")
    await _make_personal(db, "android-bio-other", person.id)
    r = await _enroll_challenge(client, hdrs, "android-bio-other")
    assert r.status_code == 403 and _code(r) == "enroll_window_closed"
    # enroll itself refuses it too, even with a well-formed nonce
    db.expire_all()
    family = await db.scalar(select(AuthSession.family_id).where(
        AuthSession.person_id == person.id, AuthSession.kiosk_serial == SERIAL))
    r = await _enroll(client, hdrs, "android-bio-other",
                      nonce=biometric.make_enroll_nonce(person.id, family, "android-bio-other"))
    assert r.status_code == 403 and _code(r) == "enroll_window_closed"
    # a portal session never enrolls
    portal = await login(client, email=EMAIL)
    r = await _enroll_challenge(client, portal)
    assert r.status_code == 403


async def test_enroll_binds_an_unbound_session(client, db, seeded_user, attest):
    await _make(db, client, "worker", EMAIL)
    first = await _kiosk_login(client)
    await _beat(client, first)
    person = await _person(db)
    await _make_personal(db, SERIAL, person.id)
    hdrs = await _kiosk_login(client)          # never sent a heartbeat
    r = await _enroll(client, hdrs)
    assert r.status_code == 200, r.text
    db.expire_all()
    newest = await db.scalar(select(AuthSession).where(
        AuthSession.person_id == person.id, AuthSession.client == "kiosk")
        .order_by(AuthSession.created_at.desc()).limit(1))
    assert newest.kiosk_serial == SERIAL


async def test_enroll_refused_when_the_bind_loses(client, db, seeded_user, attest, monkeypatch):
    """The session was unbound when enroll looked, but another serial bound
    it first: the guarded bind loses and enroll refuses."""
    await _make(db, client, "worker", EMAIL)
    await _beat(client, await _kiosk_login(client))
    person = await _person(db)
    await _make_personal(db, SERIAL, person.id)
    hdrs = await _kiosk_login(client)          # never sent a heartbeat
    nonce = (await _enroll_challenge(client, hdrs)).json()["nonce"]
    real = bio_routes._enrollable_device

    async def racing(db_, actor, serial, **kw):
        device = await real(db_, actor, serial, **kw)
        if kw.get("lock"):
            await db_.execute(
                update(AuthSession).where(AuthSession.id == actor.session.id)
                .values(kiosk_serial="android-bio-elsewhere")
                .execution_options(synchronize_session=False))
        return device

    monkeypatch.setattr(bio_routes, "_enrollable_device", racing)
    r = await _enroll(client, hdrs, nonce=nonce)
    assert r.status_code == 403 and _code(r) == "enroll_window_closed"
    assert attest.calls == []
    assert (await db.scalar(select(BiometricKey))) is None


async def test_enroll_needs_personal_device(client, db, seeded_user, attest):
    await _make(db, client, "worker", EMAIL)
    hdrs = await _kiosk_login(client)
    await _beat(client, hdrs)
    r = await _enroll_challenge(client, hdrs)
    assert r.status_code == 403 and _code(r) == "not_personal_device"
    nonce_hdrs = hdrs
    # personal to someone else
    await _make_personal(db, SERIAL, await _alice_id(db))
    r = await _enroll_challenge(client, nonce_hdrs)
    assert r.status_code == 403 and _code(r) == "not_personal_device"
    # personal to them: a nonce, which stops working once the phone is reassigned
    person = await _person(db)
    await _make_personal(db, SERIAL, person.id)
    nonce = (await _enroll_challenge(client, hdrs)).json()["nonce"]
    await _make_personal(db, SERIAL, await _alice_id(db))
    r = await _enroll(client, hdrs, nonce=nonce)
    assert r.status_code == 403 and _code(r) == "not_personal_device"
    # an unknown serial
    r = await _enroll_challenge(client, hdrs, "no-such-phone")
    assert r.status_code == 403
    assert attest.calls == []


async def test_enroll_replaces_older_key(client, db, seeded_user, attest):
    hdrs, person, first_id, _ = await _enrolled(db, client, attest)
    second = await _enroll(client, hdrs)
    assert second.status_code == 200, second.text
    first = await _key(db, first_id)
    assert first.revoked_at is not None and first.revoke_reason == "replaced"
    live = (await db.scalars(select(BiometricKey).where(
        BiometricKey.person_id == person.id, BiometricKey.revoked_at.is_(None)))).all()
    assert [str(k.id) for k in live] == [second.json()["key_id"]]


async def test_enroll_nonce_is_single_use_and_bound(client, db, seeded_user, attest):
    # Nonce problems are 422 bad_enroll_nonce, never a 401: enroll runs under the session, and
    # the app reads any 401 there as a dead session and signs the person out.
    hdrs, person = await _worker_on_phone(db, client)
    nonce = (await _enroll_challenge(client, hdrs)).json()["nonce"]
    assert (await _enroll(client, hdrs, nonce=nonce)).status_code == 200
    again = await _enroll(client, hdrs, nonce=nonce)
    assert again.status_code == 422 and _code(again) == "bad_enroll_nonce"
    # a sign-in challenge is not an enroll nonce, nor is garbage
    c = (await _challenge(client)).json()["challenge"]
    for bad in (c, "not-a-token"):
        r = await _enroll(client, hdrs, nonce=bad)
        assert r.status_code == 422 and _code(r) == "bad_enroll_nonce"
    # another person's nonce
    other_hdrs, _ = await _worker_on_phone(db, client, "bio-two@test.example.com",
                                          "android-bio-0002")
    theirs = (await _enroll_challenge(client, other_hdrs, "android-bio-0002")).json()["nonce"]
    r = await _enroll(client, hdrs, nonce=theirs)
    assert r.status_code == 422 and _code(r) == "bad_enroll_nonce"
    # each binding on its own: the person, the session family, the serial
    db.expire_all()
    family = await db.scalar(select(AuthSession.family_id).where(
        AuthSession.person_id == person.id, AuthSession.client == "kiosk"))
    for crafted in (biometric.make_enroll_nonce(uuid.uuid4(), family, SERIAL),
                    biometric.make_enroll_nonce(person.id, uuid.uuid4(), SERIAL),
                    biometric.make_enroll_nonce(person.id, family, "android-bio-0002")):
        r = await _enroll(client, hdrs, nonce=crafted)
        assert r.status_code == 422 and _code(r) == "bad_enroll_nonce"
    # the control: all three right is accepted
    ok = await _enroll(client, hdrs, nonce=biometric.make_enroll_nonce(person.id, family, SERIAL))
    assert ok.status_code == 200, ok.text
    assert len(attest.calls) == 2


async def test_enroll_expired_nonce_is_422_and_the_session_lives(client, db, seeded_user, attest):
    # A Turn on prompt left open past the nonce's 5 minutes: a 422 the app maps to "try again",
    # never a 401 that would sign the person out.
    hdrs, person = await _worker_on_phone(db, client)
    family = await db.scalar(select(AuthSession.family_id).where(
        AuthSession.person_id == person.id, AuthSession.client == "kiosk"))
    ttl = biometric.ENROLL_NONCE_TTL_SECONDS
    biometric.ENROLL_NONCE_TTL_SECONDS = -5
    try:
        stale = biometric.make_enroll_nonce(person.id, family, SERIAL)
    finally:
        biometric.ENROLL_NONCE_TTL_SECONDS = ttl
    r = await _enroll(client, hdrs, nonce=stale)
    assert r.status_code == 422 and _code(r) == "bad_enroll_nonce"
    assert attest.calls == []
    # the session is untouched: a fresh nonce enrolls under the same headers
    assert (await _enroll(client, hdrs)).status_code == 200


async def test_enroll_refused_when_status_stale(client, db, seeded_user, attest, monkeypatch):
    hdrs, _ = await _worker_on_phone(db, client)

    async def missing(_db):
        return None

    monkeypatch.setattr(biometric, "load_status", missing)
    r = await _enroll(client, hdrs)
    assert r.status_code == 422 and _code(r) == "attestation_status_unavailable"

    async def stale(_db):
        return AttestationStatus(fetched_at=datetime.now(UTC) - timedelta(days=7, seconds=5),
                                 revoked_serials=set())

    monkeypatch.setattr(biometric, "load_status", stale)
    r = await _enroll(client, hdrs)
    assert r.status_code == 422 and _code(r) == "attestation_status_unavailable"
    assert attest.calls == []             # refused before the verifier runs


async def test_enroll_attestation_failure_carries_the_reason(client, db, seeded_user, attest):
    hdrs, _ = await _worker_on_phone(db, client)
    attest.error = AttestationError("boot_state", "bootloader unlocked")
    r = await _enroll(client, hdrs)
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "attestation_failed", "reason": "boot_state"}
    assert (await db.scalar(select(BiometricKey))) is None
    # a chain that isn't base64 is a parse failure, not a 500
    nonce = (await _enroll_challenge(client, hdrs)).json()["nonce"]
    attest.error = None
    r = await client.post("/kiosk/biometric/enroll", headers=hdrs,
                          json={"serial": SERIAL, "nonce": nonce, "chain": ["@@@"]})
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "attestation_failed", "reason": "parse"}


async def test_enroll_attestation_refusal_is_logged_with_its_detail(
        client, db, seeded_user, attest, caplog):
    # the API answers only the reason; the server log keeps the detail
    hdrs, _ = await _worker_on_phone(db, client)
    attest.error = AttestationError("boot_state", "bootloader unlocked")
    with caplog.at_level(logging.WARNING, logger="serversherpa.services.biometric"):
        r = await _enroll(client, hdrs)
    assert r.status_code == 422
    refused = [rec for rec in caplog.records
               if rec.name == "serversherpa.services.biometric"]
    assert [(rec.levelno, rec.getMessage()) for rec in refused] == [
        (logging.WARNING, "attestation refused: boot_state bootloader unlocked")]
    # no chain bytes in the log
    assert "leaf-der" not in caplog.text and "root-der" not in caplog.text


async def test_move_identity_never_enrolls(client, db, seeded_user, attest):
    hdrs, identity = await _move_session(db, client)
    await _make_personal(db, SERIAL, identity.id)
    r = await _enroll_challenge(client, hdrs)
    assert r.status_code == 403 and _code(r) == "enroll_window_closed"
    # even a key row that got stored anyway is never offered or honored
    key = ec.generate_private_key(ec.SECP256R1())
    device = await db.scalar(select(Device).where(Device.serial == SERIAL))
    row = BiometricKey(
        person_id=identity.id, device_id=device.id, security_level="tee",
        public_key=key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo),
        password_sign_in_at=datetime.now(UTC))
    db.add(row)
    await db.commit()
    c = await _challenge(client)
    assert c.status_code == 404 and _code(c) == "no_biometric"
    challenge, _ = biometric.make_sign_in_challenge(row.id)
    await db.execute(update(BiometricKey).where(BiometricKey.id == row.id)
                     .values(last_nonce=biometric.decode_sign_in_challenge(challenge)[1]))
    await db.commit()
    r = await _sign_in(client, str(row.id), challenge, _sign(key, challenge))
    assert r.status_code == 403 and _code(r) == "kiosk_not_allowed"
    assert attest.calls == []


@pytest.mark.parametrize("station", [
    {"station_type": "timeclock"}, {"station_type": "label"}, {"station_type": "rfid"},
    {"station_key_hash": "ab" * 32},
], ids=["timeclock", "label", "rfid", "station_key"])
async def test_shared_stations_are_never_personal(client, db, seeded_user, attest, station):
    hdrs, _, key_id, key = await _enrolled(db, client, attest)
    nonce = (await _enroll_challenge(client, hdrs)).json()["nonce"]
    card = (await _challenge(client)).json()        # the card is showing
    db.expire_all()
    await db.execute(update(Device).where(Device.serial == SERIAL).values(**station))
    await db.commit()
    r = await _enroll_challenge(client, hdrs)
    assert r.status_code == 403 and _code(r) == "not_personal_device"
    r = await _enroll(client, hdrs, nonce=nonce)
    assert r.status_code == 403 and _code(r) == "not_personal_device"
    r = await _challenge(client)
    assert r.status_code == 404 and _code(r) == "no_biometric"
    r = await _sign_in(client, key_id, card["challenge"], _sign(key, card["challenge"]))
    assert r.status_code == 403 and _code(r) == "not_personal_device"
    assert len(attest.calls) == 1             # only the enroll before the change


# ── challenge ───────────────────────────────────────────────────────

async def test_challenge_404_without_key(client, db, seeded_user, attest):
    assert _code(await _challenge(client, "no-such-phone")) == "no_biometric"
    _, person = await _worker_on_phone(db, client)
    r = await _challenge(client)
    assert r.status_code == 404 and _code(r) == "no_biometric"
    # a key for someone the phone no longer belongs to
    _, _, key_id, _ = await _enrolled(db, client, attest, email="bio-b@test.example.com",
                                      serial="android-bio-b")
    await _make_personal(db, "android-bio-b", person.id)
    r = await _challenge(client, "android-bio-b")
    assert r.status_code == 404 and _code(r) == "no_biometric"
    # a revoked key
    await _make_personal(db, "android-bio-b", (await _key(db, key_id)).person_id)
    assert (await _challenge(client, "android-bio-b")).status_code == 200
    await biometric.revoke_keys(db, device_id=(await _key(db, key_id)).device_id,
                                reason="admin")
    await db.commit()
    r = await _challenge(client, "android-bio-b")
    assert r.status_code == 404 and _code(r) == "no_biometric"


async def test_challenge_never_returns_email(client, db, seeded_user, attest):
    _, person, key_id, _ = await _enrolled(db, client, attest)
    r = await _challenge(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"key_id", "challenge", "display_name", "photo_url", "expired"}
    assert body["key_id"] == key_id
    assert body["display_name"] == person.display_name
    assert body["photo_url"] is None and body["expired"] is False
    assert EMAIL not in r.text and "@" not in r.text


async def test_challenge_expired_flag(client, db, seeded_user, attest):
    _, _, key_id, _ = await _enrolled(db, client, attest)
    now = datetime.now(UTC)
    await _set_anchor(db, key_id, now - timedelta(days=29, hours=23))
    assert (await _challenge(client)).json()["expired"] is False
    await _set_anchor(db, key_id, now - timedelta(days=30, seconds=1))
    assert (await _challenge(client)).json()["expired"] is True


# ── sign-in ─────────────────────────────────────────────────────────

async def test_sign_in_mints_kiosk_session_with_biometric_method(client, db, seeded_user, attest):
    _, person, key_id, key = await _enrolled(db, client, attest)
    password_body = (await client.post("/auth/login", json={
        "email": EMAIL, "password": PW, "client": "kiosk"})).json()
    client.cookies.clear()
    r = await _challenge_and_sign_in(client, key)
    assert r.status_code == 200, r.text
    body = r.json()
    # the same body as /auth/login's kiosk answer, and the same cookie
    assert set(body) == set(password_body)
    assert body["person"]["id"] == str(person.id)
    assert body["perms"]["kiosk"]["view"] is True and body["kiosk_move"] is None
    assert "ss_refresh" in r.cookies and "ss_portal_refresh" not in r.cookies
    set_cookie = r.headers["set-cookie"]
    assert "HttpOnly" in set_cookie and "Path=/auth" in set_cookie
    session = await db.scalar(select(AuthSession).where(
        AuthSession.token_hash == hash_refresh_token(r.cookies["ss_refresh"])))
    assert session.client == "kiosk" and session.login_method == "biometric"
    assert session.initiative_id is None
    assert session.kiosk_serial == SERIAL     # bound to the phone it signed in on
    audit_row = await db.scalar(select(AuditLog).where(AuditLog.action == "login_biometric"))
    assert audit_row.actor_person_id == person.id
    row = await _key(db, key_id)
    assert row.last_used_at is not None and row.last_nonce is None
    # the session works for kiosk routes and refreshes as a kiosk session
    refreshed = await client.post("/auth/refresh?client=kiosk")
    assert refreshed.status_code == 200, refreshed.text


async def test_sign_in_expiry_boundary(client, db, seeded_user, attest, monkeypatch):
    _, _, key_id, key = await _enrolled(db, client, attest)
    frozen = datetime.now(UTC).replace(microsecond=0)
    monkeypatch.setattr(biometric, "_now", lambda: frozen)
    await _set_anchor(db, key_id, frozen - timedelta(days=30) + timedelta(seconds=1))
    r = await _challenge_and_sign_in(client, key)
    assert r.status_code == 200, r.text
    await _set_anchor(db, key_id, frozen - timedelta(days=30))
    c = await _challenge(client)
    assert c.json()["expired"] is True
    r = await _challenge_and_sign_in(client, key)
    assert r.status_code == 403 and _code(r) == "biometric_expired"


async def test_challenge_single_use(client, db, seeded_user, attest):
    _, _, key_id, key = await _enrolled(db, client, attest)
    c = (await _challenge(client)).json()
    sig = _sign(key, c["challenge"])
    assert (await _sign_in(client, key_id, c["challenge"], sig)).status_code == 200
    replay = await _sign_in(client, key_id, c["challenge"], sig)
    assert replay.status_code == 401 and _code(replay) == "bad_challenge"


async def test_challenge_reuses_outstanding(client, db, seeded_user, attest):
    """A second /challenge returns the outstanding challenge instead of
    voiding it, so whoever knows the serial can't knock the owner's card
    out. Sign-in still spends it."""
    _, _, key_id, key = await _enrolled(db, client, attest)
    first = (await _challenge(client)).json()["challenge"]
    second = (await _challenge(client)).json()["challenge"]
    assert second == first
    r = await _sign_in(client, key_id, first, _sign(key, first))
    assert r.status_code == 200, r.text
    third = (await _challenge(client)).json()["challenge"]
    assert third != first                     # the spent one is never handed out again
    # one too close to expiring to be signed in time is replaced
    row = await _key(db, key_id)
    jti, iat = row.last_nonce.split(":")
    aged = int(iat) - (biometric.CHALLENGE_TTL_SECONDS - biometric.CHALLENGE_REUSE_MIN_SECONDS + 1)
    await db.execute(update(BiometricKey).where(BiometricKey.id == key_id)
                     .values(last_nonce=f"{jti}:{aged}"))
    await db.commit()
    fourth = (await _challenge(client)).json()["challenge"]
    assert biometric.decode_sign_in_challenge(fourth)[1].split(":")[0] != jti   # a new one
    r = await _sign_in(client, key_id, third, _sign(key, third))
    assert r.status_code == 401 and _code(r) == "bad_challenge"
    r = await _sign_in(client, key_id, fourth, _sign(key, fourth))
    assert r.status_code == 200, r.text
    # an expired one is replaced too
    row = await _key(db, key_id)
    assert row.last_nonce is None
    fifth = (await _challenge(client)).json()["challenge"]
    row = await _key(db, key_id)
    jti, iat = row.last_nonce.split(":")
    await db.execute(update(BiometricKey).where(BiometricKey.id == key_id)
                     .values(last_nonce=f"{jti}:{int(iat) - 120}"))
    await db.commit()
    sixth = (await _challenge(client)).json()["challenge"]
    assert sixth != fifth
    assert biometric.decode_sign_in_challenge(sixth)[1].split(":")[0] != jti
    r = await _sign_in(client, key_id, sixth, _sign(key, sixth))
    assert r.status_code == 200, r.text


async def test_challenge_rate_limited(client, db, seeded_user, attest, monkeypatch):
    from serversherpa.wiki.share_links import IpRateLimiter

    await _enrolled(db, client, attest)
    monkeypatch.setattr(bio_routes, "challenge_limiter",
                        IpRateLimiter(limit=3, window_seconds=300))
    for _ in range(3):
        assert (await _challenge(client)).status_code == 200
    r = await _challenge(client)
    assert r.status_code == 429 and _code(r) == "biometric_rate_limited"
    # unknown serials count too: probing is what the cap is for
    r = await _challenge(client, "no-such-phone")
    assert r.status_code == 429


async def test_challenge_belongs_to_its_key(client, db, seeded_user, attest):
    _, _, key_id, key = await _enrolled(db, client, attest)
    _, _, other_id, _ = await _enrolled(db, client, attest, email="bio-c@test.example.com",
                                        serial="android-bio-c")
    c = (await _challenge(client)).json()["challenge"]
    r = await _sign_in(client, other_id, c, _sign(key, c))
    assert r.status_code == 401 and _code(r) == "bad_challenge"
    # an expired challenge
    expired, jti = biometric.make_sign_in_challenge(key_id, ttl_seconds=-1)
    await db.execute(update(BiometricKey).where(BiometricKey.id == key_id)
                     .values(last_nonce=jti))
    await db.commit()
    r = await _sign_in(client, key_id, expired, _sign(key, expired))
    assert r.status_code == 401 and _code(r) == "bad_challenge"


async def test_bad_signature(client, db, seeded_user, attest):
    _, _, key_id, key = await _enrolled(db, client, attest)
    c = (await _challenge(client)).json()["challenge"]
    stranger = ec.generate_private_key(ec.SECP256R1())
    for sig in (_sign(stranger, c), _sign(key, c + "x"), base64.b64encode(b"junk").decode(),
                "not base64!"):
        c = (await _challenge(client)).json()["challenge"]
        r = await _sign_in(client, key_id, c, sig)
        assert r.status_code == 401 and _code(r) == "bad_signature", sig
        # the attempt spent the challenge
        r = await _sign_in(client, key_id, c, _sign(key, c))
        assert r.status_code == 401 and _code(r) == "bad_challenge"
    unknown = await _sign_in(client, "00000000-0000-0000-0000-000000000000", c, _sign(key, c))
    assert unknown.status_code == 401 and _code(unknown) == "bad_challenge"


async def test_device_reassigned_refuses(client, db, seeded_user, attest):
    _, _, key_id, key = await _enrolled(db, client, attest)
    c = (await _challenge(client)).json()       # the card is showing
    await _make_personal(db, SERIAL, await _alice_id(db))
    r = await _sign_in(client, key_id, c["challenge"], _sign(key, c["challenge"]))
    assert r.status_code == 403 and _code(r) == "not_personal_device"
    await _make_personal(db, SERIAL, (await _key(db, key_id)).person_id)
    c = (await _challenge(client)).json()
    await _make_personal(db, SERIAL, None)
    r = await _sign_in(client, key_id, c["challenge"], _sign(key, c["challenge"]))
    assert r.status_code == 403 and _code(r) == "not_personal_device"


async def test_revoked_key_refuses(client, db, seeded_user, attest):
    _, person, key_id, key = await _enrolled(db, client, attest)
    c = (await _challenge(client)).json()
    assert await biometric.revoke_keys(db, person_id=person.id, reason="admin") == 1
    await db.commit()
    r = await _sign_in(client, key_id, c["challenge"], _sign(key, c["challenge"]))
    assert r.status_code == 404 and _code(r) == "no_biometric"


async def test_disabled_account_refuses(client, db, seeded_user, attest):
    _, person, key_id, key = await _enrolled(db, client, attest)
    c = (await _challenge(client)).json()
    account = await db.get(UserAccount, person.id)
    account.disabled_at = datetime.now(UTC)
    await db.commit()
    r = await _sign_in(client, key_id, c["challenge"], _sign(key, c["challenge"]))
    assert r.status_code == 401 and _code(r) == "account_disabled"
    account.disabled_at = None
    person_row = await db.get(Person, person.id)
    person_row.archived_at = datetime.now(UTC)
    await db.commit()
    r = await _challenge_and_sign_in(client, key)
    assert r.status_code == 401 and _code(r) == "account_disabled"


async def test_without_kiosk_view_refuses(client, db, seeded_user, attest):
    _, person, _key_id, key = await _enrolled(db, client, attest)
    await db.execute(update(PersonRole).where(PersonRole.person_id == person.id)
                     .values(revoked_at=datetime.now(UTC)))
    await db.commit()
    r = await _challenge_and_sign_in(client, key)
    assert r.status_code == 403 and _code(r) == "kiosk_not_allowed"
    assert (await db.scalar(select(AuthSession).where(
        AuthSession.login_method == "biometric"))) is None


async def test_expired_password_refuses(client, db, seeded_user, attest, monkeypatch):
    _, person, _key_id, key = await _enrolled(db, client, attest)
    long_ago = datetime(2020, 1, 1, tzinfo=UTC)

    async def expiring(_db):
        return PasswordPolicy(enabled=True, days=30, history_count=3, since=long_ago)

    monkeypatch.setattr(bio_routes, "load_policy", expiring)
    account = await db.get(UserAccount, person.id)
    account.password_updated_at = long_ago
    await db.commit()
    r = await _challenge_and_sign_in(client, key)
    assert r.status_code == 403 and _code(r) == "password_change_required"
    # a fresh password signs in; a temporary one does not
    account.password_updated_at = datetime.now(UTC)
    await db.commit()
    assert (await _challenge_and_sign_in(client, key)).status_code == 200
    account.must_change_password = True
    await db.commit()
    r = await _challenge_and_sign_in(client, key)
    assert r.status_code == 403 and _code(r) == "password_change_required"


async def test_sign_in_failures_rate_limited(client, db, seeded_user, attest, monkeypatch):
    _, _, key_id, key = await _enrolled(db, client, attest)
    monkeypatch.setattr(kiosk_routes, "MOVE_LOGIN_IP_LIMIT", 3)
    for _ in range(3):
        c = (await _challenge(client)).json()["challenge"]
        r = await _sign_in(client, key_id, c, base64.b64encode(b"junk").decode())
        assert r.status_code == 401
    r = await _challenge_and_sign_in(client, key)
    assert r.status_code == 429 and _code(r) == "biometric_rate_limited"
    rows = (await db.scalars(select(AuditLog).where(AuditLog.action == "login_failed"))).all()
    assert len(rows) == 3
    assert all(row.changes["method"] == "biometric" for row in rows)
    # the cap is move-login's: its failures count against biometric sign-in too
    monkeypatch.setattr(kiosk_routes, "MOVE_LOGIN_IP_LIMIT", 4)
    assert (await client.post("/kiosk/move-login", json={"password": "nope"})).status_code == 401
    r = await _challenge_and_sign_in(client, key)
    assert r.status_code == 429


# ── forget ──────────────────────────────────────────────────────────

async def test_forget_revokes_own_key(client, db, seeded_user, attest):
    hdrs, person, key_id, _ = await _enrolled(db, client, attest)
    r = await client.delete(f"/kiosk/biometric?serial={SERIAL}", headers=hdrs)
    assert r.status_code == 204, r.text
    row = await _key(db, key_id)
    assert row.revoked_at is not None and row.revoke_reason == "forgotten"
    assert (await _challenge(client)).status_code == 404
    audit_row = await db.scalar(select(AuditLog).where(AuditLog.action == "biometric_forget"))
    assert audit_row.actor_person_id == person.id
    # nothing left to forget, or an unknown phone, is still 204
    assert (await client.delete(f"/kiosk/biometric?serial={SERIAL}",
                                headers=hdrs)).status_code == 204
    assert (await client.delete("/kiosk/biometric?serial=nope",
                                headers=hdrs)).status_code == 204


async def test_forget_touches_only_the_callers_key(client, db, seeded_user, attest):
    _, _, key_id, _ = await _enrolled(db, client, attest)
    other = await _make(db, client, "worker", "bio-d@test.example.com")
    other_kiosk = await _kiosk_login(client, "bio-d@test.example.com")
    assert (await client.delete(f"/kiosk/biometric?serial={SERIAL}",
                                headers=other_kiosk)).status_code == 204
    assert other
    assert (await _key(db, key_id)).revoked_at is None


# ── service ─────────────────────────────────────────────────────────

async def test_revoke_keys_filters_and_audits(client, db, seeded_user, attest):
    _, a, a_key, _ = await _enrolled(db, client, attest)
    _, _b, b_key, _ = await _enrolled(db, client, attest, email="bio-e@test.example.com",
                                     serial="android-bio-e")
    assert await biometric.revoke_keys(db, person_id=a.id, reason="password_change") == 1
    await db.commit()
    assert (await _key(db, a_key)).revoke_reason == "password_change"
    assert (await _key(db, b_key)).revoked_at is None
    # already revoked keys are not counted again
    assert await biometric.revoke_keys(db, person_id=a.id, reason="admin") == 0
    device_b = (await _key(db, b_key)).device_id
    assert await biometric.revoke_keys(db, device_id=device_b, reason="reassigned") == 1
    await db.commit()
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "biometric_revoke").order_by(AuditLog.at))).all()
    assert [r.changes["reason"] for r in rows] == ["password_change", "reassigned"]
    assert rows[0].entity_id == str(a_key) and rows[0].entity_type == "biometric_key"


# ── renewal and freeze ──────────────────────────────────────────────

async def test_password_bind_renews_anchor(client, db, seeded_user, attest):
    _, _, key_id, _ = await _enrolled(db, client, attest)
    old = datetime.now(UTC) - timedelta(days=20)
    await _set_anchor(db, key_id, old)
    hdrs = await _kiosk_login(client)
    # binding another serial renews nothing here
    await _beat(client, hdrs, "android-bio-elsewhere", login_method="password")
    assert (await _key(db, key_id)).password_sign_in_at == old
    hdrs = await _kiosk_login(client)
    await _beat(client, hdrs, login_method="password")
    renewed = (await _key(db, key_id)).password_sign_in_at
    assert abs((renewed - datetime.now(UTC)).total_seconds()) < 60
    # later beats of the same session don't move it again
    await _set_anchor(db, key_id, old)
    await _beat(client, hdrs, login_method="password")
    assert (await _key(db, key_id)).password_sign_in_at == old


async def test_heartbeat_reported_password_does_not_renew_biometric_session(
        client, db, seeded_user, attest):
    _, _, key_id, key = await _enrolled(db, client, attest)
    old = datetime.now(UTC) - timedelta(days=20)
    await _set_anchor(db, key_id, old)
    signed = await _challenge_and_sign_in(client, key)
    assert signed.status_code == 200, signed.text
    bio = {"Authorization": f"Bearer {signed.json()['access_token']}"}
    beat = await _beat(client, bio, login_method="password")
    assert beat["device_id"]
    assert (await _key(db, key_id)).password_sign_in_at == old
    # the heartbeat accepts the new method name
    await _beat(client, bio, login_method="biometric")
    db.expire_all()
    device = await db.scalar(select(Device).where(Device.serial == SERIAL))
    assert device.session_login_method == "biometric"


async def test_link_bind_does_not_renew(client, db, seeded_user, attest):
    alice = await login(client)
    await _beat(client, alice, "android-bio-alice")
    db.expire_all()
    device = await db.scalar(select(Device).where(Device.serial == "android-bio-alice"))
    old = datetime.now(UTC) - timedelta(days=20)
    row = BiometricKey(person_id=await _alice_id(db), device_id=device.id, security_level="tee",
                       public_key=b"x", password_sign_in_at=old)
    db.add(row)
    await db.commit()
    d = await _create(client, serial="android-bio-alice")
    assert (await client.post(f"/kiosk/pair/{d['code']}/approve",
                              headers=alice)).status_code == 204
    polled = await _poll(client, d)
    linked = {"Authorization": f"Bearer {polled.json()['session']['access_token']}"}
    await _beat(client, linked, "android-bio-alice", login_method="password")
    assert (await _key(db, row.id)).password_sign_in_at == old


async def test_read_only_freeze_allows_challenge_sign_in_forget_not_enroll(
        client, db, seeded_user, attest):
    hdrs, _, key_id, key = await _enrolled(db, client, attest)
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200
    r = await _enroll_challenge(client, hdrs)
    assert r.status_code == 423 and _code(r) == "read_only_mode"
    r = await _enroll(client, hdrs, nonce="whatever")
    assert r.status_code == 423
    signed = await _challenge_and_sign_in(client, key)
    assert signed.status_code == 200, signed.text
    bio = {"Authorization": f"Bearer {signed.json()['access_token']}"}
    r = await client.delete(f"/kiosk/biometric?serial={SERIAL}", headers=bio)
    assert r.status_code == 204, r.text
    assert (await _key(db, key_id)).revoked_at is not None
