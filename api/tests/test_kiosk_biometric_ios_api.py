"""Kiosk biometric sign-in on iOS: the `platform: "ios"` branch of
POST /kiosk/biometric/enroll, and sign-in with that key through the
unchanged routes. An enroll with an App Attest statement stores the Secure
Enclave key as `secure_enclave`; one without (App Attest is off in the app
until SS-521) stores it as `unattested`, unless
SS_KIOSK_IOS_REQUIRE_APP_ATTEST refuses it. The body's platform must be the
device's own.

The App Attest verifier is patched with a fake that records what it was
asked to check; the verifier has its own tests (test_app_attest.py). The
device key is a software P-256 key made here, so the proof and the
sign-in are signed with `cryptography`.

Design: docs/superpowers/specs/2026-11-09-ios-biometric-sign-in-design.md
§Server."""

import base64
from hashlib import sha256

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select

from serversherpa.config import Settings, get_settings
from serversherpa.db.models import AuditLog, BiometricKey, Device
from serversherpa.security.app_attest import KIOSK_IOS_APP_ID
from serversherpa.security.key_attestation import AttestationError
from serversherpa.services import biometric
from tests.test_kiosk_biometric_api import SERIAL as ANDROID_SERIAL
from tests.test_kiosk_biometric_api import (
    _alice_id,
    _beat,
    _challenge,
    _code,
    _enroll,
    _enroll_challenge,
    _kiosk_login,
    _make_personal,
    _person,
    _sign,
    _sign_in,
    _worker_on_phone,
    attest,  # noqa: F401  (a fixture: the Android enrolls in the audit and platform tests)
)
from tests.test_sites_api import login
from tests.test_status_values_write import PW, _make

SERIAL = "ios-bio-0001"
EMAIL = "ios-bio-worker@test.example.com"
KEY_ID = sha256(b"app attest key").digest()       # what DCAppAttestService hands back
ATTESTATION = b"\xa3cfmtoapple-appattest"           # opaque here: the fake never parses it


# ── helpers ─────────────────────────────────────────────────────────

class FakeAppAttest:
    """Stands in for verify_app_attest: records the keyword arguments it was
    called with and raises `.error` when set."""

    def __init__(self):
        self.calls: list[dict] = []
        self.error: AttestationError | None = None

    def __call__(self, attestation, **kwargs):
        self.calls.append({"attestation": attestation, **kwargs})
        if self.error is not None:
            raise self.error


@pytest.fixture
def app_attest(monkeypatch):
    fake = FakeAppAttest()
    monkeypatch.setattr(biometric, "verify_app_attest", fake)
    return fake


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def _x963(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


async def _beat_ios(client, hdrs, serial=SERIAL, **extra):
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": serial, "name": "iPad", "mode": "ios", "sign_in": True, **extra})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _worker_on_ipad(db, client, email=EMAIL, serial=SERIAL):
    """A worker signed in with their password on their own personal iPad."""
    await _make(db, client, "worker", email)
    hdrs = await _kiosk_login(client, email)
    await _beat_ios(client, hdrs, serial, login_method="password")
    person = await _person(db, email)
    await _make_personal(db, serial, person.id)
    return hdrs, person


async def _nonce(client, hdrs, serial=SERIAL) -> str:
    r = await _enroll_challenge(client, hdrs, serial)
    assert r.status_code == 200, r.text
    return r.json()["nonce"]


def _ios_body(nonce: str, key: ec.EllipticCurvePrivateKey, serial=SERIAL, **over) -> dict:
    """An iOS enroll body as the app sends it: the proof is the device key's
    signature over the nonce's UTF-8 bytes."""
    proof = key.sign(nonce.encode(), ec.ECDSA(hashes.SHA256()))
    return {"serial": serial, "nonce": nonce, "platform": "ios",
            "public_key": _b64(_x963(key)), "app_attest_key_id": _b64(KEY_ID),
            "attestation": _b64(ATTESTATION), "signature": _b64(proof), **over}


async def _enroll_ios(client, hdrs, body: dict):
    return await client.post("/kiosk/biometric/enroll", headers=hdrs, json=body)


async def _ios_enrolled(db, client):
    """Enrolls a fresh software key on the worker's iPad: (headers, person,
    enroll response, key)."""
    hdrs, person = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    r = await _enroll_ios(client, hdrs, _ios_body(await _nonce(client, hdrs), key))
    return hdrs, person, r, key


async def _keys(db) -> list[BiometricKey]:
    db.expire_all()
    return (await db.scalars(select(BiometricKey))).all()


# ── enroll ──────────────────────────────────────────────────────────

async def test_ios_enroll_stores_secure_enclave_key_and_sign_in_works(
        client, db, seeded_user, app_attest):
    _, person, r, key = await _ios_enrolled(db, client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"key_id", "security_level", "renews_at"}
    assert body["security_level"] == "secure_enclave"
    [row] = await _keys(db)
    assert str(row.id) == body["key_id"] and row.person_id == person.id
    assert row.security_level == "secure_enclave" and row.key_alg == "ES256"
    # stored as DER SubjectPublicKeyInfo, wrapped from the X9.63 point
    assert row.public_key == key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)

    # sign-in is unchanged: the card's challenge, signed by the same key
    client.cookies.clear()
    c = await _challenge(client, SERIAL)
    assert c.status_code == 200, c.text
    card = c.json()
    assert card["key_id"] == body["key_id"]
    s = await _sign_in(client, card["key_id"], card["challenge"], _sign(key, card["challenge"]))
    assert s.status_code == 200, s.text
    assert s.json()["person"]["id"] == str(person.id)
    assert "ss_refresh" in s.cookies


async def test_ios_enroll_binds_nonce_and_key_into_client_data_hash(
        client, db, seeded_user, app_attest):
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    nonce = await _nonce(client, hdrs)
    r = await _enroll_ios(client, hdrs, _ios_body(nonce, key))
    assert r.status_code == 200, r.text
    [call] = app_attest.calls
    assert call["client_data_hash"] == sha256(nonce.encode() + _x963(key)).digest()
    assert call["app_id"] == KIOSK_IOS_APP_ID
    assert call["key_id"] == KEY_ID
    assert call["attestation"] == ATTESTATION


async def test_ios_enroll_follows_the_development_setting(
        client, db, seeded_user, app_attest, monkeypatch):
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    r = await _enroll_ios(client, hdrs, _ios_body(await _nonce(client, hdrs), key))
    assert r.status_code == 200, r.text
    assert app_attest.calls[-1]["allow_development"] is False

    # Settings is frozen: set it through the environment
    monkeypatch.setenv("SS_KIOSK_APP_ATTEST_DEVELOPMENT", "true")
    get_settings.cache_clear()
    try:
        assert get_settings().kiosk_app_attest_development is True
        r = await _enroll_ios(client, hdrs, _ios_body(await _nonce(client, hdrs), key))
        assert r.status_code == 200, r.text
        assert app_attest.calls[-1]["allow_development"] is True
    finally:
        monkeypatch.delenv("SS_KIOSK_APP_ATTEST_DEVELOPMENT")
        get_settings.cache_clear()


async def test_ios_enroll_skips_the_google_status_gate(
        client, db, seeded_user, app_attest, monkeypatch):
    async def missing(_db):
        return None

    # with no revocation list an Android enroll is attestation_status_unavailable
    monkeypatch.setattr(biometric, "load_status", missing)
    _, _, r, _ = await _ios_enrolled(db, client)
    assert r.status_code == 200, r.text
    assert r.json()["security_level"] == "secure_enclave"


async def test_ios_attestation_refused_is_422_with_reason(client, db, seeded_user, app_attest):
    app_attest.error = AttestationError("environment", "development aaguid")
    _, _, r, _ = await _ios_enrolled(db, client)
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "attestation_failed", "reason": "environment"}
    assert await _keys(db) == []


async def test_ios_bad_proof_is_422_proof(client, db, seeded_user, app_attest):
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    nonce = await _nonce(client, hdrs)
    elsewhere = key.sign(b"a different message", ec.ECDSA(hashes.SHA256()))
    r = await _enroll_ios(client, hdrs, _ios_body(nonce, key, signature=_b64(elsewhere)))
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "attestation_failed", "reason": "proof"}
    assert len(app_attest.calls) == 1        # the attestation passed; the proof didn't
    assert await _keys(db) == []


def _off_curve_point(key: ec.EllipticCurvePrivateKey) -> bytes:
    """65 bytes shaped like an uncompressed point, with Y nudged off P-256."""
    point = bytearray(_x963(key))
    point[-1] ^= 0x01
    return bytes(point)


async def test_ios_enroll_malformed_fields_are_422(client, db, seeded_user, app_attest):
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    chain = [_b64(b"leaf-der")]
    nonce = await _nonce(client, hdrs)
    full = _ios_body(nonce, key)
    without_signature = {k: v for k, v in full.items() if k != "signature"}
    parse = {"code": "attestation_failed", "reason": "parse"}
    cases = {
        "64-byte key": (_ios_body(nonce, key, public_key=_b64(_x963(key)[1:])), parse),
        "off-curve point": (_ios_body(nonce, key, public_key=_b64(_off_curve_point(key))),
                            parse),
        # a valid point, but not the uncompressed X9.63 form the app hashes
        "compressed point": (_ios_body(nonce, key, public_key=_b64(
            key.public_key().public_bytes(serialization.Encoding.X962,
                                          serialization.PublicFormat.CompressedPoint))),
                             parse),
        "non-base64 attestation": (_ios_body(nonce, key, attestation="@@not base64@@"), parse),
        "31-byte key id": (_ios_body(nonce, key, app_attest_key_id=_b64(KEY_ID[:31])), parse),
        "chain and iOS fields": ({**full, "chain": chain}, None),
        "Android body with iOS fields": (
            {**{k: v for k, v in full.items() if k != "platform"}, "chain": chain}, None),
        "iOS body missing signature": (without_signature, None),
        "Android body without chain": ({"serial": SERIAL, "nonce": nonce}, None),
    }
    for name, (body, detail) in cases.items():
        r = await _enroll_ios(client, hdrs, body)
        assert r.status_code == 422, (name, r.status_code, r.text)
        if detail is not None:
            assert r.json()["detail"] == detail, name
    # every one was refused before the verifier ran, and stored nothing
    assert app_attest.calls == []
    assert await _keys(db) == []
    # the same nonce still enrolls: none of the refusals spent it
    r = await _enroll_ios(client, hdrs, full)
    assert r.status_code == 200, r.text


async def test_ios_enroll_uses_the_same_gate(client, db, seeded_user, app_attest):
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    nonce = await _nonce(client, hdrs)
    r = await _enroll_ios(client, hdrs, _ios_body(nonce, key))
    assert r.status_code == 200, r.text
    # a nonce enrolls one key
    again = await _enroll_ios(client, hdrs, _ios_body(nonce, key))
    assert again.status_code == 422 and _code(again) == "bad_enroll_nonce"
    # a nonce issued while the iPad was theirs stops working once it is reassigned
    nonce = await _nonce(client, hdrs)
    await _make_personal(db, SERIAL, await _alice_id(db))
    r = await _enroll_ios(client, hdrs, _ios_body(nonce, key))
    assert r.status_code == 403 and _code(r) == "not_personal_device"
    assert len(app_attest.calls) == 1


async def test_ios_enroll_audit_records_platform(
        client, db, seeded_user, app_attest, attest):  # noqa: F811
    _, _, r, _ = await _ios_enrolled(db, client)
    assert r.status_code == 200, r.text
    android_hdrs, _ = await _worker_on_phone(db, client)
    a = await _enroll(client, android_hdrs)
    assert a.status_code == 200, a.text
    db.expire_all()
    rows = {row.entity_id: row.changes for row in (await db.scalars(
        select(AuditLog).where(AuditLog.action == "biometric_enroll"))).all()}
    ios = rows[r.json()["key_id"]]
    assert ios["platform"] == "ios" and ios["security_level"] == "secure_enclave"
    assert ios["serial"] == SERIAL
    android = rows[a.json()["key_id"]]
    assert android["platform"] == "android" and android["security_level"] == "strongbox"
    # an Android key's chain is its attestation
    assert ios["attested"] is True and android["attested"] is True


async def _enroll_audit(db, key_id: str) -> dict:
    db.expire_all()
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "biometric_enroll", AuditLog.entity_id == key_id))
    return row.changes


# ── App Attest off for now (spec decision 3, follow-up SS-521) ─────

def _unattested(body: dict) -> dict:
    """The body the app sends while BiometricAppAttest.isEnabled is false."""
    return {k: v for k, v in body.items() if k not in ("app_attest_key_id", "attestation")}


@pytest.fixture
def require_app_attest(monkeypatch):
    """SS_KIOSK_IOS_REQUIRE_APP_ATTEST=true (Settings is frozen: set it through
    the environment)."""
    monkeypatch.setenv("SS_KIOSK_IOS_REQUIRE_APP_ATTEST", "true")
    get_settings.cache_clear()
    assert get_settings().kiosk_ios_require_app_attest is True
    yield
    # back to conftest's pin (a delenv would let a developer's .env through)
    monkeypatch.setenv("SS_KIOSK_IOS_REQUIRE_APP_ATTEST", "false")
    get_settings.cache_clear()


def test_ios_app_attest_is_not_required_by_default():
    assert Settings.model_fields["kiosk_ios_require_app_attest"].default is False
    # conftest pins it, so a developer's .env can't flip it under the suite
    assert get_settings().kiosk_ios_require_app_attest is False


async def test_ios_unattested_enroll_is_stored_and_signs_in(
        client, db, seeded_user, app_attest):
    hdrs, person = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    r = await _enroll_ios(client, hdrs, _unattested(_ios_body(await _nonce(client, hdrs), key)))
    assert r.status_code == 200, r.text
    assert r.json()["security_level"] == "unattested"
    [row] = await _keys(db)
    assert row.security_level == "unattested" and row.person_id == person.id
    assert row.public_key == key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    audit = await _enroll_audit(db, r.json()["key_id"])
    assert audit["attested"] is False
    assert audit["platform"] == "ios" and audit["security_level"] == "unattested"
    assert app_attest.calls == []          # nothing to verify: App Attest never ran

    # sign-in is the same as for an attested key
    client.cookies.clear()
    c = await _challenge(client, SERIAL)
    assert c.status_code == 200, c.text
    card = c.json()
    s = await _sign_in(client, card["key_id"], card["challenge"], _sign(key, card["challenge"]))
    assert s.status_code == 200, s.text
    assert s.json()["person"]["id"] == str(person.id)


async def test_ios_unattested_enroll_refused_when_required(
        client, db, seeded_user, app_attest, require_app_attest):
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    nonce = await _nonce(client, hdrs)
    r = await _enroll_ios(client, hdrs, _unattested(_ios_body(nonce, key)))
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "attestation_failed", "reason": "attestation_required"}
    assert await _keys(db) == []
    assert app_attest.calls == []
    # an attested enroll still works with the setting on, on the same nonce
    r = await _enroll_ios(client, hdrs, _ios_body(nonce, key))
    assert r.status_code == 200, r.text
    assert r.json()["security_level"] == "secure_enclave"


async def test_ios_attestation_fields_come_together(client, db, seeded_user, app_attest):
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    nonce = await _nonce(client, hdrs)
    full = _ios_body(nonce, key)
    for missing in ("app_attest_key_id", "attestation"):
        body = {k: v for k, v in full.items() if k != missing}
        r = await _enroll_ios(client, hdrs, body)
        assert r.status_code == 422, (missing, r.text)
        # an explicit null is the same as leaving it out
        r = await _enroll_ios(client, hdrs, {**full, missing: None})
        assert r.status_code == 422, (missing, r.text)
    # the public key and the proof are always needed
    for needed in ("public_key", "signature"):
        r = await _enroll_ios(client, hdrs, {k: v for k, v in _unattested(full).items()
                                             if k != needed})
        assert r.status_code == 422, (needed, r.text)
    assert app_attest.calls == []
    assert await _keys(db) == []


async def test_ios_unattested_bad_proof_is_422_proof(client, db, seeded_user, app_attest):
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    nonce = await _nonce(client, hdrs)
    elsewhere = key.sign(b"a different message", ec.ECDSA(hashes.SHA256()))
    body = _unattested(_ios_body(nonce, key, signature=_b64(elsewhere)))
    r = await _enroll_ios(client, hdrs, body)
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "attestation_failed", "reason": "proof"}
    # a malformed key or proof is a refusal with a reason, never a 500
    parse = {"code": "attestation_failed", "reason": "parse"}
    for name, over in {"64-byte key": {"public_key": _b64(_x963(key)[1:])},
                       "off-curve point": {"public_key": _b64(_off_curve_point(key))},
                       "non-base64 signature": {"signature": "@@not base64@@"}}.items():
        r = await _enroll_ios(client, hdrs, _unattested(_ios_body(nonce, key, **over)))
        assert r.status_code == 422, (name, r.text)
        assert r.json()["detail"] == parse, name
    r = await _enroll_ios(client, hdrs, _unattested(_ios_body(nonce, key, signature=_b64(b"x"))))
    assert r.status_code == 422 and r.json()["detail"]["reason"] == "proof"
    assert app_attest.calls == []
    assert await _keys(db) == []


async def test_ios_attested_enroll_records_attested_true(client, db, seeded_user, app_attest):
    _, _, r, _ = await _ios_enrolled(db, client)
    assert r.status_code == 200, r.text
    assert r.json()["security_level"] == "secure_enclave"
    audit = await _enroll_audit(db, r.json()["key_id"])
    assert audit["attested"] is True and audit["security_level"] == "secure_enclave"
    assert len(app_attest.calls) == 1


async def test_ios_unattested_key_lists_as_unattested(client, db, seeded_user, app_attest):
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    r = await _enroll_ios(client, hdrs, _unattested(_ios_body(await _nonce(client, hdrs), key)))
    assert r.status_code == 200, r.text
    resp = await client.get("/auth/me/biometric-keys", headers=await login(client, EMAIL, PW))
    assert resp.status_code == 200, resp.text
    assert [row["security_level"] for row in resp.json()] == ["unattested"]


# ── the body's platform is the device's own ────────────────────────

PLATFORM = {"code": "attestation_failed", "reason": "platform"}


async def _set_sub_type(db, serial: str, sub_type: str | None) -> None:
    db.expire_all()
    device = await db.scalar(select(Device).where(Device.serial == serial))
    device.sub_type = sub_type
    await db.commit()


async def test_android_device_never_takes_the_ios_path(
        client, db, seeded_user, app_attest, attest):  # noqa: F811
    # an Android phone sending an iOS body would skip Google's key attestation
    hdrs, _ = await _worker_on_phone(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    nonce = await _nonce(client, hdrs, ANDROID_SERIAL)
    full = _ios_body(nonce, key, serial=ANDROID_SERIAL)
    for name, body in {"unattested": _unattested(full), "attested": full,
                       "bad base64 too": {**_unattested(full), "public_key": "@@"}}.items():
        r = await _enroll_ios(client, hdrs, body)
        assert r.status_code == 422, (name, r.text)
        assert r.json()["detail"] == PLATFORM, name
    assert app_attest.calls == [] and attest.calls == []
    assert await _keys(db) == []
    # the nonce isn't spent: the phone's own Android enroll still takes it
    a = await _enroll(client, hdrs, ANDROID_SERIAL, nonce=nonce)
    assert a.status_code == 200, a.text
    assert a.json()["security_level"] == "strongbox"


async def test_zebra_handheld_enrolls_as_android_only(
        client, db, seeded_user, app_attest, attest):  # noqa: F811
    hdrs, _ = await _worker_on_phone(db, client)
    await _beat(client, hdrs, ANDROID_SERIAL, login_method="password",
                raw_info={"manufacturer": "Zebra Technologies"})
    db.expire_all()
    device = await db.scalar(select(Device).where(Device.serial == ANDROID_SERIAL))
    assert device.sub_type == "zebra"
    key = ec.generate_private_key(ec.SECP256R1())
    nonce = await _nonce(client, hdrs, ANDROID_SERIAL)
    r = await _enroll_ios(client, hdrs, _unattested(_ios_body(nonce, key, serial=ANDROID_SERIAL)))
    assert r.status_code == 422 and r.json()["detail"] == PLATFORM
    a = await _enroll(client, hdrs, ANDROID_SERIAL, nonce=nonce)
    assert a.status_code == 200, a.text


async def test_ios_device_never_takes_the_android_path(
        client, db, seeded_user, app_attest, attest):  # noqa: F811
    hdrs, _ = await _worker_on_ipad(db, client)
    nonce = await _nonce(client, hdrs)
    a = await _enroll(client, hdrs, SERIAL, nonce=nonce)
    assert a.status_code == 422, a.text
    assert a.json()["detail"] == PLATFORM
    assert attest.calls == [] and app_attest.calls == []
    assert await _keys(db) == []
    # the nonce isn't spent: the iPad's own iOS enroll still takes it
    key = ec.generate_private_key(ec.SECP256R1())
    r = await _enroll_ios(client, hdrs, _unattested(_ios_body(nonce, key)))
    assert r.status_code == 200, r.text


async def test_device_of_another_kind_takes_neither_path(
        client, db, seeded_user, app_attest, attest):  # noqa: F811
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    for sub_type in ("laptop", "web", None):
        await _set_sub_type(db, SERIAL, sub_type)
        nonce = await _nonce(client, hdrs)
        r = await _enroll_ios(client, hdrs, _unattested(_ios_body(nonce, key)))
        assert r.status_code == 422 and r.json()["detail"] == PLATFORM, (sub_type, r.text)
        a = await _enroll(client, hdrs, SERIAL, nonce=nonce)
        assert a.status_code == 422 and a.json()["detail"] == PLATFORM, (sub_type, a.text)
    assert attest.calls == [] and app_attest.calls == []
    assert await _keys(db) == []


async def test_ios_key_lists_as_secure_enclave(client, db, seeded_user, app_attest):
    _, _, r, _ = await _ios_enrolled(db, client)
    assert r.status_code == 200, r.text
    # /auth/me is the portal's: the worker's own portal sign-in
    resp = await client.get("/auth/me/biometric-keys", headers=await login(client, EMAIL, PW))
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [row["id"] for row in rows] == [r.json()["key_id"]]
    assert rows[0]["security_level"] == "secure_enclave"


async def test_ios_enroll_garbage_attestation_with_the_real_verifier_is_422(
        client, db, seeded_user):
    # no fake: whatever an attacker sends as the attestation object is a
    # refusal with a reason, never a 500
    hdrs, _ = await _worker_on_ipad(db, client)
    key = ec.generate_private_key(ec.SECP256R1())
    for garbage in (b"not cbor at all", b"\xa0", b"\xff" * 64):
        r = await _enroll_ios(client, hdrs, _ios_body(
            await _nonce(client, hdrs), key, attestation=_b64(garbage)))
        assert r.status_code == 422, (garbage, r.text)
        assert _code(r) == "attestation_failed", garbage
    assert await _keys(db) == []
