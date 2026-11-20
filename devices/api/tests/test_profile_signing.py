"""The add-device profile signed with the Apple Distribution certificate:
signing/profile.py, the bundled WWDR intermediates, and
GET /enroll/<token>.mobileconfig serving it signed (or, when it can't be,
the plain plist as before).

Fixture chain: a self-made root -> intermediate -> "Apple Distribution"
leaf, the leaf and its key in a .p12 like one exported from Keychain
Access (no intermediate)."""

import datetime as dt
import hashlib
import logging
import plistlib
import shutil
import subprocess
from pathlib import Path

import pytest
from asn1crypto import cms
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from serversherpa_devices.db.models import AppleSettings
from serversherpa_devices.services.secrets import seal
from serversherpa_devices.signing import SignError, profile
from serversherpa_devices.signing.p12 import P12_UNREADABLE

from .test_enroll import anonymous, new_link  # noqa: F401 - anonymous is a fixture

PASSWORD = "fixture p12 password"
TEAM = "TEAM123456"
_NOW = dt.datetime.now(dt.UTC)
PLIST = plistlib.dumps({"PayloadType": "Profile Service", "PayloadVersion": 1,
                        "PayloadContent": {"Challenge": "x\ny"}})
WWDR_SUBJECT = x509.Name([
    x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
    x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Fixture Inc."),
    x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "G3"),
    x509.NameAttribute(NameOID.COMMON_NAME,
                       "Fixture Worldwide Developer Relations Certification Authority"),
])


def _cert(subject: x509.Name, key, issuer: x509.Name, issuer_key, *, ca: bool,
          code_signing: bool = False) -> x509.Certificate:
    builder = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer)
               .public_key(key.public_key()).serial_number(x509.random_serial_number())
               .not_valid_before(_NOW - dt.timedelta(days=1))
               .not_valid_after(_NOW + dt.timedelta(days=365))
               .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    if ca:
        builder = builder.add_extension(x509.KeyUsage(
            digital_signature=False, content_commitment=False, key_encipherment=False,
            data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
            encipher_only=False, decipher_only=False), critical=True)
    if code_signing:   # what an Apple Distribution certificate carries
        builder = builder.add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CODE_SIGNING]), critical=True)
    return builder.sign(issuer_key, hashes.SHA256())


ROOT_KEY = ec.generate_private_key(ec.SECP256R1())
ROOT_NAME = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Fixture Root CA")])
ROOT = _cert(ROOT_NAME, ROOT_KEY, ROOT_NAME, ROOT_KEY, ca=True)
WWDR_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
WWDR = _cert(WWDR_SUBJECT, WWDR_KEY, ROOT_NAME, ROOT_KEY, ca=True)
LEAF_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
LEAF = _cert(x509.Name([
    x509.NameAttribute(NameOID.USER_ID, TEAM),
    x509.NameAttribute(NameOID.COMMON_NAME, f"Apple Distribution: Fixture ({TEAM})"),
    x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, TEAM),
    x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Fixture"),
    x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
]), LEAF_KEY, WWDR_SUBJECT, WWDR_KEY, ca=False, code_signing=True)
# The same name as WWDR, another key: it didn't issue the leaf.
IMPOSTOR = _cert(WWDR_SUBJECT, ec.generate_private_key(ec.SECP256R1()), ROOT_NAME, ROOT_KEY,
                 ca=True)


def make_p12(*, extra: list[x509.Certificate] | None = None, password: str = PASSWORD) -> bytes:
    return pkcs12.serialize_key_and_certificates(
        b"Fixture", LEAF_KEY, LEAF, extra, serialization.BestAvailableEncryption(password.encode()))


def der(cert: x509.Certificate) -> bytes:
    return cert.public_bytes(serialization.Encoding.DER)


def unwrap(body: bytes) -> tuple[bytes, list[bytes], cms.SignerInfo]:
    """The SignedData's content, its certificates (DER) and its one signer."""
    info = cms.ContentInfo.load(body)
    assert info["content_type"].native == "signed_data"
    signed = info["content"]
    assert signed["encap_content_info"]["content_type"].native == "data"
    content = signed["encap_content_info"]["content"].native
    certs = [c.chosen.dump() for c in signed["certificates"]]
    [signer] = signed["signer_infos"]
    assert [a["algorithm"].native for a in signed["digest_algorithms"]] == ["sha256"]
    return content, certs, signer


def assert_signed_by_leaf(body: bytes, content: bytes) -> None:
    """The signature over `content` is the leaf's, checked by hand: the
    messageDigest attribute is the content's SHA-256 and the leaf's key
    signed the attributes (as a DER SET)."""
    found, _, signer = unwrap(body)
    assert found == content
    sid = signer["sid"].chosen
    assert sid["serial_number"].native == LEAF.serial_number
    assert sid["issuer"].dump() == LEAF.issuer.public_bytes()
    assert signer["digest_algorithm"]["algorithm"].native == "sha256"
    attrs = {a["type"].native: a["values"][0].native for a in signer["signed_attrs"]}
    assert attrs["message_digest"] == hashlib.sha256(content).digest()
    signed_attrs = bytearray(signer["signed_attrs"].dump())
    signed_attrs[0] = 0x31   # [0] IMPLICIT -> SET OF, what was signed
    LEAF.public_key().verify(signer["signature"].native, bytes(signed_attrs),
                             padding.PKCS1v15(), hashes.SHA256())


def openssl_verify(tmp_path: Path, body: bytes) -> bytes:
    """`openssl cms -verify` against the fixture root only (the
    intermediate has to come from the SignedData); the content it gives back."""
    if shutil.which("openssl") is None:
        pytest.skip("openssl isn't installed")
    (tmp_path / "profile.der").write_bytes(body)
    (tmp_path / "root.pem").write_bytes(ROOT.public_bytes(serialization.Encoding.PEM))
    done = subprocess.run(
        ["openssl", "cms", "-verify", "-inform", "DER", "-in", str(tmp_path / "profile.der"),
         "-CAfile", str(tmp_path / "root.pem"), "-purpose", "any", "-binary",
         "-out", str(tmp_path / "content")],
        capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr
    return (tmp_path / "content").read_bytes()


# signing/profile.py


def test_sign_profile_wraps_the_plist_with_the_leaf_and_intermediate(tmp_path):
    body = profile.sign_profile(PLIST, p12=make_p12(), password=PASSWORD,
                                intermediates=[IMPOSTOR, WWDR])
    content, certs, _ = unwrap(body)
    assert content == PLIST                       # byte for byte: no CRLF rewrite
    assert sorted(certs) == sorted([der(LEAF), der(WWDR)])   # not the impostor
    assert_signed_by_leaf(body, PLIST)
    assert openssl_verify(tmp_path, body) == PLIST


def test_sign_profile_keeps_the_p12s_own_intermediate_once(tmp_path):
    body = profile.sign_profile(PLIST, p12=make_p12(extra=[WWDR]), password=PASSWORD,
                                intermediates=[WWDR])
    _, certs, _ = unwrap(body)
    assert sorted(certs) == sorted([der(LEAF), der(WWDR)])
    assert openssl_verify(tmp_path, body) == PLIST


def test_sign_profile_without_a_matching_intermediate_carries_the_leaf(tmp_path):
    # The real bundled intermediates didn't issue the fixture leaf.
    body = profile.sign_profile(PLIST, p12=make_p12(), password=PASSWORD)
    _, certs, _ = unwrap(body)
    assert certs == [der(LEAF)]
    assert_signed_by_leaf(body, PLIST)


def test_sign_profile_wrong_password():
    with pytest.raises(SignError) as failed:
        profile.sign_profile(PLIST, p12=make_p12(), password="not it")
    assert str(failed.value) == P12_UNREADABLE
    with pytest.raises(SignError):
        profile.sign_profile(PLIST, p12=b"not a p12", password=PASSWORD)


BUNDLED = {
    "apple_wwdr_g3.pem": "dcf21878c77f4198e4b4614f03d696d89c66c66008d4244e1b99161aac91601f",
    "apple_wwdr_g6.pem": "bdd4ed6e74691f0c2bfd01be0296197af1379e0418e2d300efa9c3bef642ca30",
}


def test_bundled_wwdr_intermediates():
    """The files, this table and wwdr/README.md agree; each is an unexpired
    Apple WWDR CA named by its generation."""
    readme = (profile.WWDR_DIR / "README.md").read_text()
    files = sorted(p.name for p in profile.WWDR_DIR.glob("*.pem"))
    assert files == sorted(BUNDLED)
    for name, fingerprint in BUNDLED.items():
        [cert] = x509.load_pem_x509_certificates((profile.WWDR_DIR / name).read_bytes())
        assert cert.fingerprint(hashes.SHA256()).hex() == fingerprint
        assert f"`{name}`" in readme and fingerprint in readme
        names = cert.subject.get_attributes_for_oid
        assert names(NameOID.COMMON_NAME)[0].value == (
            "Apple Worldwide Developer Relations Certification Authority")
        assert name == f"apple_wwdr_{names(NameOID.ORGANIZATIONAL_UNIT_NAME)[0].value.lower()}.pem"
        assert cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
        assert cert.not_valid_after_utc > dt.datetime.now(dt.UTC)
    assert len(profile.bundled_intermediates()) == len(BUNDLED)


# GET /enroll/<token>.mobileconfig


async def seed_certificate(db, *, p12: bytes | None = None, password: str = PASSWORD,
                           p12_enc: bytes | None = None) -> None:
    db.add(AppleSettings(id=1, team_id=TEAM, p12_enc=p12_enc or seal(p12 or make_p12()),
                         p12_password_enc=seal(password.encode())))
    await db.commit()


@pytest.fixture
def fixture_wwdr(monkeypatch):
    """The fixture intermediate stands in for Apple's bundled ones."""
    monkeypatch.setattr(profile, "bundled_intermediates", lambda: [IMPOSTOR, WWDR])


def unsigned_warnings(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records
            if r.name == "serversherpa_devices.enroll" and r.levelno == logging.WARNING]


async def test_mobileconfig_is_signed_with_the_saved_certificate(
        api, anonymous, db, fixture_wwdr, tmp_path, caplog):
    await seed_certificate(db)
    token = await new_link(api)
    with caplog.at_level(logging.WARNING):
        r = await anonymous.get(f"/enroll/{token}.mobileconfig", params={"device": "ipad"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/x-apple-aspen-config"
    assert r.headers["content-disposition"] == 'attachment; filename="add-this-ipad.mobileconfig"'
    assert r.headers["cache-control"] == "no-store"
    assert unsigned_warnings(caplog) == []

    content, certs, _ = unwrap(r.content)
    assert sorted(certs) == sorted([der(LEAF), der(WWDR)])
    assert_signed_by_leaf(r.content, content)
    assert openssl_verify(tmp_path, r.content) == content
    found = plistlib.loads(content)
    assert found["PayloadType"] == "Profile Service"
    assert found["PayloadDisplayName"] == "ServerSherpa Devices — add this iPad"
    assert found["PayloadContent"] == {
        "URL": f"https://devices.test/enroll/{token}/callback",
        "DeviceAttributes": ["UDID", "PRODUCT", "VERSION", "SERIAL", "DEVICE_NAME"],
        "Challenge": token,
    }


async def test_mobileconfig_unsigned_without_apple_settings(api, anonymous, caplog):
    token = await new_link(api)
    with caplog.at_level(logging.WARNING):
        r = await anonymous.get(f"/enroll/{token}.mobileconfig")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/x-apple-aspen-config"
    assert plistlib.loads(r.content)["PayloadContent"]["Challenge"] == token
    assert unsigned_warnings(caplog) == [
        "enroll: serving the add-device profile unsigned: the Apple settings aren't saved"]


@pytest.mark.parametrize("broken", ["password", "p12", "sealed"])
async def test_mobileconfig_unsigned_when_the_certificate_cant_be_used(
        api, anonymous, db, fixture_wwdr, caplog, broken):
    if broken == "password":
        await seed_certificate(db, p12=make_p12(password="another password"))
        reason = P12_UNREADABLE
    elif broken == "p12":
        await seed_certificate(db, p12=b"not a p12 at all")
        reason = P12_UNREADABLE
    else:   # sealed under another key
        await seed_certificate(db, p12_enc=b"sealed")
        reason = "the saved certificate can't be unsealed"
    token = await new_link(api)
    with caplog.at_level(logging.DEBUG):
        r = await anonymous.get(f"/enroll/{token}.mobileconfig")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/x-apple-aspen-config"
    profile_out = plistlib.loads(r.content)   # the plain plist, as before
    assert profile_out["PayloadContent"]["Challenge"] == token
    assert unsigned_warnings(caplog) == [
        f"enroll: serving the add-device profile unsigned: {reason}"]
    assert PASSWORD not in caplog.text and "another password" not in caplog.text
