"""Android key attestation (security/key_attestation.py): a chain is
accepted only when it reaches a pinned root, nothing in it is revoked, and the
leaf's KeyDescription proves a hardware, biometric-per-use EC P-256 signing
key made for the kiosk app on a locked, verified device. The chains are
generated (tests/attestation_helpers.py); the roots are injected with
`roots=`."""

from datetime import timedelta
from hashlib import sha256

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from pyasn1.type import univ

from serversherpa.security.attestation_status import AttestationStatus
from serversherpa.security.key_attestation import (
    AttestationError,
    AttestedKey,
    google_roots,
    verify_attestation,
)
from tests.attestation_helpers import (
    ALGORITHM,
    APPLICATION_ID,
    AUTH_TIMEOUT,
    DIGEST,
    EC_CURVE,
    FINGERPRINT,
    NO_AUTH_REQUIRED,
    NONCE,
    NOW,
    PASSWORD,
    PURPOSE,
    ROOT_OF_TRUST,
    RSA,
    SOFTWARE,
    TEE,
    UNVERIFIED,
    USER_AUTH_TYPE,
    VERIFY,
    application_id,
    default_hw,
    default_sw,
    explicit,
    key_description,
    make_chain,
    root_of_trust,
    rsa_leaf_key,
    set_of_ints,
)

FRESH = AttestationStatus(fetched_at=NOW - timedelta(hours=3), revoked_serials=set())


def verify(chain, *, nonce=NONCE, digests=None, status=FRESH, roots=None, now=NOW):
    return verify_attestation(
        chain.der, nonce=nonce, digests={DIGEST} if digests is None else digests,
        status=status, roots=[chain.root] if roots is None else roots, now=now)


def refused(chain, reason, **kwargs):
    with pytest.raises(AttestationError) as exc:
        verify(chain, **kwargs)
    assert exc.value.reason == reason
    return exc.value


def hw_with(**changes):
    hw = default_hw()
    for k, v in changes.items():
        tag_number = globals()[k]
        if v is None:
            hw.pop(tag_number)
        else:
            hw[tag_number] = v
    return hw


# ── positive ───────────────────────────────────────────────────────

def test_good_chain_attests():
    chain = make_chain()
    result = verify(chain)
    assert result == AttestedKey(public_key_der=chain.leaf_public_der,
                                 security_level="strongbox")


def test_tee_key_attests_as_tee():
    chain = make_chain(kd=key_description(attestation_level=TEE, keymint_level=TEE))
    assert verify(chain).security_level == "tee"


def test_keymint_400_and_unknown_tags_are_skipped():
    """A newer KeyMint (Android 15/16 phones report 400) with tags this
    schema doesn't name still attests: unknown entries are skipped."""
    hw = default_hw()
    hw[724] = explicit(724, univ.OctetString(b"module hash"))
    hw[9999] = explicit(9999, univ.Integer(7))
    hw[11] = explicit(11, univ.Integer(1))           # mlDsaVariant
    chain = make_chain(kd=key_description(version=400, hw=hw))
    assert verify(chain).security_level == "strongbox"


def test_digest_matching_ignores_case_and_colons():
    chain = make_chain()
    colon_upper = ":".join(DIGEST[i:i + 2] for i in range(0, 64, 2)).upper()
    assert verify(chain, digests={colon_upper}).security_level == "strongbox"


# ── security level ─────────────────────────────────────────────────

def test_software_level_refused():
    refused(make_chain(kd=key_description(attestation_level=SOFTWARE,
                                          keymint_level=SOFTWARE)), "security_level")


def test_software_keymint_level_refused():
    refused(make_chain(kd=key_description(keymint_level=SOFTWARE)), "security_level")


# ── challenge ──────────────────────────────────────────────────────

def test_wrong_challenge_refused():
    refused(make_chain(), "challenge", nonce=b"some other nonce")


# ── chain, root, expiry, revocation ────────────────────────────────

def test_unknown_root_refused():
    chain = make_chain(root_key_name="attacker root")
    other_root = make_chain().root
    refused(chain, "root", roots=[other_root])


def test_unknown_root_refused_against_google_roots():
    refused(make_chain(), "root", roots=google_roots())


def test_broken_signature_refused():
    """An intermediate the root didn't sign: the leaf and intermediate come
    from a chain under another root."""
    good = make_chain()
    forged = make_chain(root_key_name="other root")
    chain = make_chain()
    chain.der = [forged.der[0], forged.der[1], good.der[2]]
    refused(chain, "chain", roots=[good.root])


def test_short_chain_refused():
    chain = make_chain()
    chain.der = chain.der[:1]
    refused(chain, "chain")


def test_extension_on_an_intermediate_refused():
    """Only the leaf may carry a KeyDescription (chain-extension attack)."""
    refused(make_chain(intermediate_extension=key_description()), "chain")


def test_revoked_intermediate_refused():
    chain = make_chain()
    serial = format(chain.certs[1].serial_number, "x")
    status = AttestationStatus(fetched_at=NOW, revoked_serials={serial})
    refused(chain, "revoked", status=status)


def test_revoked_leaf_refused():
    chain = make_chain()
    status = AttestationStatus(fetched_at=NOW,
                               revoked_serials={format(chain.certs[0].serial_number, "x")})
    refused(chain, "revoked", status=status)


def test_expired_cert_refused():
    chain = make_chain(intermediate_not_after=NOW - timedelta(days=1))
    refused(chain, "expired")


def test_expired_leaf_refused():
    chain = make_chain(leaf_not_after=NOW - timedelta(seconds=1))
    refused(chain, "expired")


def test_expired_factory_chain_still_attests():
    """Google: certificates chaining to the RSA root (SERIALNUMBER subject)
    from factory-provisioned devices stay trusted after they expire."""
    chain = make_chain(factory=True, intermediate_not_after=NOW - timedelta(days=400),
                       leaf_not_after=NOW - timedelta(days=400))
    assert verify(chain).security_level == "strongbox"


def test_expired_pinned_root_is_still_the_trust_anchor():
    """The 2016 Google RSA root expired 2026-05-24; the anchor's own dates
    are not checked."""
    chain = make_chain(root_not_after=NOW - timedelta(days=30))
    assert verify(chain).security_level == "strongbox"


# ── key properties ─────────────────────────────────────────────────

def test_rsa_key_refused():
    chain = make_chain(leaf_key=rsa_leaf_key(),
                       kd=key_description(hw=hw_with(ALGORITHM=explicit(ALGORITHM,
                                                                        univ.Integer(RSA)),
                                                     EC_CURVE=None)))
    refused(chain, "key_properties")


def test_ec_algorithm_claim_with_rsa_leaf_refused():
    refused(make_chain(leaf_key=rsa_leaf_key()), "key_properties")


def test_wrong_curve_refused():
    refused(make_chain(kd=key_description(
        hw=hw_with(EC_CURVE=explicit(EC_CURVE, univ.Integer(2))))), "key_properties")


def test_verify_only_purpose_refused():
    refused(make_chain(kd=key_description(
        hw=hw_with(PURPOSE=explicit(PURPOSE, set_of_ints({VERIFY}))))), "key_properties")


@pytest.mark.parametrize("moved", [PURPOSE, ALGORITHM, EC_CURVE])
def test_property_only_in_software_list_refused(moved):
    """EC / P-256 / SIGN must each be hardware enforced, not just claimed by
    the OS."""
    hw = default_hw()
    sw = default_sw()
    sw[moved] = hw.pop(moved)
    refused(make_chain(kd=key_description(sw=sw, hw=hw)), "key_properties")


def test_rsa_algorithm_claim_on_an_ec_key_refused():
    refused(make_chain(kd=key_description(
        hw=hw_with(ALGORITHM=explicit(ALGORITHM, univ.Integer(RSA))))), "key_properties")


# ── user auth ──────────────────────────────────────────────────────

def test_no_auth_required_refused():
    refused(make_chain(kd=key_description(hw=hw_with(
        NO_AUTH_REQUIRED=explicit(NO_AUTH_REQUIRED, univ.Null(""))))), "user_auth")


def test_no_auth_required_in_software_list_refused():
    sw = default_sw()
    sw[NO_AUTH_REQUIRED] = explicit(NO_AUTH_REQUIRED, univ.Null(""))
    refused(make_chain(kd=key_description(sw=sw)), "user_auth")


def test_auth_timeout_refused():
    refused(make_chain(kd=key_description(hw=hw_with(
        AUTH_TIMEOUT=explicit(AUTH_TIMEOUT, univ.Integer(30))))), "user_auth")


def test_password_only_auth_refused():
    refused(make_chain(kd=key_description(hw=hw_with(
        USER_AUTH_TYPE=explicit(USER_AUTH_TYPE, univ.Integer(PASSWORD))))), "user_auth")


def test_missing_user_auth_type_refused():
    refused(make_chain(kd=key_description(hw=hw_with(USER_AUTH_TYPE=None))), "user_auth")


def test_biometric_or_password_auth_attests():
    chain = make_chain(kd=key_description(hw=hw_with(
        USER_AUTH_TYPE=explicit(USER_AUTH_TYPE, univ.Integer(PASSWORD | FINGERPRINT)))))
    assert verify(chain).security_level == "strongbox"


# ── package ────────────────────────────────────────────────────────

def _sw_app_id(**kwargs):
    sw = default_sw()
    sw[APPLICATION_ID] = explicit(APPLICATION_ID, univ.OctetString(application_id(**kwargs)))
    return sw


def test_wrong_package_refused():
    refused(make_chain(kd=key_description(sw=_sw_app_id(packages=(b"com.evil.app",)))),
            "package")


def test_unlisted_digest_refused():
    refused(make_chain(), "package", digests={sha256(b"another signer").hexdigest()})


def test_no_digests_configured_refused():
    refused(make_chain(), "package", digests=set())


def test_missing_application_id_refused():
    sw = default_sw()
    sw.pop(APPLICATION_ID)
    refused(make_chain(kd=key_description(sw=sw)), "package")


# ── root of trust ──────────────────────────────────────────────────

def test_unlocked_boot_refused():
    refused(make_chain(kd=key_description(hw=hw_with(
        ROOT_OF_TRUST=explicit(ROOT_OF_TRUST, univ.Any(root_of_trust(locked=False)))))),
        "boot_state")


def test_unverified_boot_refused():
    refused(make_chain(kd=key_description(hw=hw_with(
        ROOT_OF_TRUST=explicit(ROOT_OF_TRUST, univ.Any(root_of_trust(state=UNVERIFIED)))))),
        "boot_state")


def test_missing_root_of_trust_refused():
    refused(make_chain(kd=key_description(hw=hw_with(ROOT_OF_TRUST=None))), "boot_state")


# ── parsing ────────────────────────────────────────────────────────

def test_garbage_refused():
    chain = make_chain()
    chain.der = [b"not a certificate", *chain.der[1:]]
    refused(chain, "parse")


def test_garbage_extension_refused():
    refused(make_chain(kd=b"\x30\x03\x02\x01"), "parse")


def test_missing_extension_refused():
    refused(make_chain(leaf_extension=False), "parse")


def test_old_attestation_version_refused():
    refused(make_chain(kd=key_description(version=2)), "parse")


def test_malformed_known_field_refused():
    """A known tag whose content isn't the schema's type is a parse error,
    not silently skipped."""
    refused(make_chain(kd=key_description(hw=hw_with(
        ALGORITHM=explicit(ALGORITHM, univ.OctetString(b"EC"))))), "parse")


# ── pinned roots ───────────────────────────────────────────────────

def test_pinned_google_roots():
    """The roots match the README table in security/attestation_roots/."""
    fingerprints = {sha256(c.public_bytes(serialization.Encoding.DER)).hexdigest()
                    for c in google_roots()}
    assert fingerprints == {
        "cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc",
        "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0",
        "c1984a3ef45c1e2a918551de10603c86f7051b2249c4891cae3230eabd0c97d5",
        "1ef1a04b8ba58ab94589ac498c8982a783f24ea7307e0159a0c3a73b377d87cc",
        "ab6641178a36e179aa0c1cdddf9a16eb45fa20943e2b8cd7c7c05c26cf8b487a",
    }
    assert any(isinstance(c, x509.Certificate) and c.subject.rfc4514_string()
               == "C=US,O=Google LLC,OU=Android,CN=Key Attestation CA1"
               for c in google_roots())


def test_stale_status_is_the_callers_check_not_a_refusal():
    """verify_attestation checks the serials it is given; refusing a stale
    list (attestation_status_unavailable) is the enroll route's job."""
    stale = AttestationStatus(fetched_at=NOW - timedelta(days=30), revoked_serials=set())
    assert verify(make_chain(), status=stale).security_level == "strongbox"


# ── revocation status freshness ────────────────────────────────────

def test_status_stale_after_7_days():
    status = AttestationStatus(fetched_at=NOW, revoked_serials=set())
    assert status.fresh(NOW)
    assert status.fresh(NOW + timedelta(days=7))
    assert not status.fresh(NOW + timedelta(days=7, seconds=1))
