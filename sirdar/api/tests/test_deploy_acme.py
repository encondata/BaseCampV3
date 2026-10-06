"""ACME (RFC 8555) against FakeAcme, and Sirdar's DNS-01 issuance through
the Cloudflare integration: the challenge records are removed afterwards,
Sirdar's account key is stored encrypted and reused, a bad nonce is retried,
and errors are our own copy."""

import pytest
from cryptography import x509
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AcmeAccount
from sirdar_api.deploy import acme, certs, integrations

from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import do_cloud  # noqa: F401
from .integration_helpers import CF_TOKEN, configure

pytestmark = pytest.mark.usefixtures("secrets_key")
NAMES = certs.public_names("uat9.serversherpa.com")


async def _nap(_s):
    return None


def test_names_and_helpers():
    assert NAMES == ("api.uat9.serversherpa.com", "portal.uat9.serversherpa.com",
                     "kiosk.uat9.serversherpa.com", "wiki.uat9.serversherpa.com",
                     "status.uat9.serversherpa.com")
    key = acme._load_key(acme.new_key_pem())
    assert set(acme.jwk(key)) == {"crv", "kty", "x", "y"}
    assert len(acme.thumbprint(key)) == 43
    assert acme.key_authorization("tok", key) == f"tok.{acme.thumbprint(key)}"
    assert len(acme.dns01_value("tok.x")) == 43
    key_pem, csr = acme.make_csr(list(NAMES))
    parsed = x509.load_der_x509_csr(csr)
    assert sorted(parsed.extensions.get_extension_for_class(
        x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)) == sorted(NAMES)
    assert "PRIVATE KEY" in key_pem


async def _issue(db, do_cloud, out=None):
    await configure(db, npm=False)
    cf = await integrations.load_cloudflare(db, get_settings())
    lines: list[str] = []
    issued = await certs.issue_dns01(get_settings(), names=NAMES,
                                     directory=do_cloud.acme.directory_url, cloudflare=cf,
                                     out=out or lines.append, sleep=_nap, dns_wait=0, poll=0)
    return issued, lines


async def test_issue_by_dns01(db, do_cloud):
    issued, lines = await _issue(db, do_cloud)
    assert sorted(issued.names) == sorted(NAMES)
    leaf = x509.load_pem_x509_certificate(issued.leaf_pem.encode())
    assert leaf.not_valid_after_utc == issued.not_after
    assert "BEGIN CERTIFICATE" in issued.chain_pem
    assert issued.key_pem not in repr(issued)
    # Every challenge record went again.
    assert not [r for r in do_cloud.cloudflare.records.values() if r["type"] == "TXT"]
    assert sum("DNS challenge record added" in line for line in lines) == len(NAMES)
    row = (await db.scalars(select(AcmeAccount))).one()
    assert row.directory == do_cloud.acme.directory_url and row.kid
    assert b"PRIVATE KEY" not in bytes(row.key_enc)
    # The account is reused: no second registration.
    await _issue(db, do_cloud)
    assert do_cloud.acme.new_accounts == 1


async def test_a_bad_nonce_is_retried(db, do_cloud):
    do_cloud.acme.bad_nonce_once = True
    issued, _ = await _issue(db, do_cloud)
    assert issued.leaf_pem


async def test_a_failed_challenge_is_our_copy(db, do_cloud):
    do_cloud.acme.fail_validation = True
    with pytest.raises(certs.CertError) as err:
        await _issue(db, do_cloud)
    assert err.value.reason.startswith("Let's Encrypt couldn't validate ")
    assert "SECRET" not in err.value.reason and CF_TOKEN not in err.value.reason
    assert not [r for r in do_cloud.cloudflare.records.values() if r["type"] == "TXT"]


def test_ownership_and_expiry_helpers():
    from datetime import UTC, datetime
    now = datetime(2026, 10, 5, tzinfo=UTC)
    assert certs.cert_name("uat9", now) == "ss-uat9-202610050000"
    cert = {"name": "ss-uat9-202610050000", "dns_names": list(reversed(NAMES)),
            "not_after": "2026-11-04T00:00:00Z"}
    assert certs.is_ours(cert, "uat9", NAMES)
    assert not certs.is_ours({**cert, "name": "hand-made"}, "uat9", NAMES)
    assert not certs.is_ours({**cert, "dns_names": list(NAMES[:2])}, "uat9", NAMES)
    assert certs.days_left(certs.not_after(cert), now) == 30
