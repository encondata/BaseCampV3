"""App Attest verification (security/app_attest.py): an attestation object is
accepted only when its credential certificate chains through the intermediate
to the pinned Apple root, its nonce extension binds the authData and the
client data hash, and its authData names this key, this app, a fresh counter
and the production environment (development only when allowed). The objects
are generated (tests/app_attest_helpers.py); the root is injected with
`roots=`."""

from datetime import timedelta
from hashlib import sha256
from pathlib import Path

import cbor2
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.x509.oid import NameOID

import serversherpa.security.app_attest as app_attest_module
from serversherpa.security.app_attest import (
    apple_app_attest_root,
    client_data_hash,
    verify_app_attest,
)
from serversherpa.security.key_attestation import AttestationError, google_roots
from tests.app_attest_helpers import DEVELOPMENT, NOW, der, make_attestation, make_root

APPLE_ROOT_SHA256 = "1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932"


def verify(built, *, obj=None, key_id=None, cdh=None, allow_development=False,
           roots=None, now=NOW):
    return verify_app_attest(
        built.obj if obj is None else obj,
        key_id=built.key_id if key_id is None else key_id,
        client_data_hash=built.client_data_hash if cdh is None else cdh,
        allow_development=allow_development,
        roots=[built.root] if roots is None else roots, now=now)


def refused(built, reason, **kwargs):
    with pytest.raises(AttestationError) as exc:
        verify(built, **kwargs)
    assert exc.value.reason == reason
    return exc.value


def reencoded(built, change) -> bytes:
    """The object decoded, changed by `change(obj)`, and encoded again."""
    obj = cbor2.loads(built.obj)
    change(obj)
    return cbor2.dumps(obj)


def test_production_attestation_passes():
    assert verify(make_attestation(), allow_development=False) is None


def test_development_aaguid_needs_allow_development():
    built = make_attestation(aaguid=DEVELOPMENT)
    refused(built, "environment", allow_development=False)
    assert verify(built, allow_development=True) is None


def test_unknown_aaguid_is_environment():
    refused(make_attestation(aaguid=b"appattestxxxxxxx"), "environment")
    # allow_development accepts the development aaguid and nothing else
    refused(make_attestation(aaguid=b"\x00" * 16), "environment", allow_development=True)


def test_wrong_root_is_root():
    """The intermediate is signed by another key under the pinned root's name."""
    refused(make_attestation(root_key_name="attacker root"), "root")
    # the test chain against the real pinned Apple root
    built = make_attestation()
    with pytest.raises(AttestationError) as exc:
        verify_app_attest(built.obj, key_id=built.key_id,
                          client_data_hash=built.client_data_hash,
                          allow_development=False, now=NOW)
    assert exc.value.reason == "root"


def test_broken_chain_is_chain():
    good = make_attestation()
    cred, inter = good.x5c
    refused(make_attestation(x5c=[inter, cred]), "chain")
    refused(make_attestation(x5c=[cred]), "chain")
    refused(make_attestation(x5c=[cred, inter, der(good.root)]), "chain")


def test_expired_credential_cert_is_expired():
    refused(make_attestation(cred_not_after=NOW - timedelta(seconds=1)), "expired")
    # not valid yet: the credential certificate starts a day before NOW
    refused(make_attestation(), "expired", now=NOW - timedelta(days=2))


def test_expired_root_is_expired():
    """Unlike Android's anchors, the pinned root's own dates are checked."""
    expired_root = make_root(not_after=NOW - timedelta(days=1))
    refused(make_attestation(), "expired", roots=[expired_root])


def test_nonce_mismatch_is_challenge():
    refused(make_attestation(nonce_override=b"\x00" * 32), "challenge")
    refused(make_attestation(), "challenge", cdh=sha256(b"other client data").digest())


def test_missing_extension_is_challenge():
    refused(make_attestation(no_extension=True), "challenge")


def test_key_id_not_hash_of_cert_key():
    refused(make_attestation(), "key_id", key_id=sha256(b"another key").digest())


def test_credential_id_mismatch_is_key_id():
    refused(make_attestation(cred_id=sha256(b"another key").digest()), "key_id")


def test_app_id_mismatch():
    refused(make_attestation(app_id="Y2QYBG96U4.Server-Sherpas.SomethingElse"), "app_id")


def test_nonzero_counter():
    refused(make_attestation(counter=1), "counter")


def test_not_cbor_is_parse():
    built = make_attestation()
    refused(built, "parse", obj=b"\xff\xff")
    refused(built, "parse", obj=built.obj[:-20])


def test_short_auth_data_is_parse():
    auth = cbor2.loads(make_attestation().obj)["authData"]
    assert verify(make_attestation(auth_data=auth)) is None     # the override alone passes
    refused(make_attestation(auth_data=auth[:54]), "parse")
    # credIdLen points past the end
    refused(make_attestation(auth_data=auth[:53] + b"\x01\x00" + auth[55:]), "parse")


def test_wrong_fmt_is_format():
    refused(make_attestation(fmt="packed"), "format")
    refused(make_attestation(), "format", obj=cbor2.dumps([1, 2]))


def test_missing_x5c_is_format():
    built = make_attestation()
    refused(built, "format", obj=reencoded(built, lambda o: o["attStmt"].pop("x5c")))
    refused(make_attestation(x5c=[]), "format")
    refused(make_attestation(x5c=["not bytes"]), "format")
    refused(built, "format", obj=reencoded(built, lambda o: o.pop("authData")))


def test_client_data_hash_vector():
    assert client_data_hash("enroll-nonce", bytes([4]) + bytes(range(1, 65))).hex() == (
        "e66ae6444b04ccdff839a7a0d5041d2bf2b1797a3ffdcddfd7e59fd5828df43a")


def test_pinned_apple_root():
    """The root matches the README table in security/app_attest_roots/."""
    root = apple_app_attest_root()
    assert sha256(root.public_bytes(serialization.Encoding.DER)).hexdigest() == (
        APPLE_ROOT_SHA256)
    readme = (Path(app_attest_module.__file__).parent / "app_attest_roots" / "README.md")
    assert APPLE_ROOT_SHA256 in readme.read_text()
    assert root.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value == (
        "Apple App Attestation Root CA")


def test_google_roots_unchanged():
    """Apple's root is not in attestation_roots/, so Google's list is still 5."""
    assert len(google_roots()) == 5
