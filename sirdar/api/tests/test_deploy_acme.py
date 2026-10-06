"""ACME (RFC 8555) against FakeAcme, and Sirdar's DNS-01 issuance through
the Cloudflare integration: the challenge records are removed afterwards,
Sirdar's account key is stored encrypted and reused, a bad nonce is retried,
and errors are our own copy."""

import json
from contextlib import asynccontextmanager

import pytest
from cryptography import x509
from cryptography.x509.oid import NameOID
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import AcmeAccount
from sirdar_api.deploy import acme, certs, integrations, vault

from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import do_cloud  # noqa: F401
from .fake_acme import FakeAcme
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
    # SAN-only: no subject CN (Let's Encrypt ignores it; long names don't fit one).
    assert not parsed.subject.get_attributes_for_oid(NameOID.COMMON_NAME)


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


def test_is_ours_rejects_non_dicts():
    for junk in (None, "ss-uat9-1", ["ss-uat9-1"], 7):
        assert not certs.is_ours(junk, "uat9", NAMES)


async def test_pending_polls_then_done(db, do_cloud):
    do_cloud.acme.pending_polls = 3
    issued, _ = await _issue(db, do_cloud)
    assert issued.leaf_pem
    # authz, the order before finalize and the order after finalize each waited.
    assert do_cloud.acme.polls_answered_pending >= 3 * (len(NAMES) + 2)
    assert not [r for r in do_cloud.cloudflare.records.values() if r["type"] == "TXT"]


@asynccontextmanager
async def _nothing(*_args):
    yield


async def test_running_out_of_tries_is_our_copy():
    fake = FakeAcme(pending_polls=50)
    async with acme.AcmeClient(fake.directory_url, acme.new_key_pem(),
                               transport=fake.transport(), sleep=_nap, poll=0,
                               tries=3) as client:
        fake.http_fetch = lambda _n, token: acme.key_authorization(token, client.key)
        with pytest.raises(acme.AcmeError) as err:
            await acme.issue(client, ["a.example.com"], "http-01", _nothing)
    assert err.value.reason == "Let's Encrypt didn't finish a.example.com in time."
    assert err.value.__cause__ is None and err.value.__context__ is None
    assert fake.polls_answered_pending == 3


async def test_a_refused_request_hides_the_servers_text(db, do_cloud):
    do_cloud.acme.refuse_new_order = True
    lines: list[str] = []
    with pytest.raises(certs.CertError) as err:
        await _issue(db, do_cloud, out=lines.append)
    assert err.value.reason == "The ACME server refused the request (unauthorized)."
    assert "SECRET" not in err.value.reason and "SECRET" not in "".join(lines)
    assert "SECRET" not in repr(err.value) and err.value.__cause__ is None


@pytest.mark.parametrize("breakage", ["challenge_url", "finalize", "certificate", "pem",
                                      "authorizations", "token"])
async def test_malformed_responses_are_our_copy(db, do_cloud, breakage):
    do_cloud.acme.breakage = breakage
    with pytest.raises(certs.CertError) as err:
        await _issue(db, do_cloud)
    assert err.value.reason.startswith("The ACME server sent ")
    assert err.value.__cause__ is None
    assert not [r for r in do_cloud.cloudflare.records.values() if r["type"] == "TXT"]


def test_garbage_chains():
    with pytest.raises(acme.AcmeError):
        acme.split_chain("no certificate here")
    with pytest.raises(acme.AcmeError) as err:
        acme.split_chain("-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n"
                         "-----END CERTIFICATE-----\n")
    assert err.value.reason == "The ACME server sent a certificate Sirdar can't read."
    assert err.value.__cause__ is None and err.value.__suppress_context__


async def test_the_account_key_needs_the_secrets_key(db):
    settings = get_settings().model_copy(update={"secrets_key": None})
    with pytest.raises(certs.CertError) as err:
        await certs._account_key(settings, "https://acme.test/directory")
    assert "SIRDAR_SECRETS_KEY" in err.value.reason
    assert err.value.__cause__ is None
    assert (await db.scalars(select(AcmeAccount))).first() is None


async def test_a_racing_first_insert_keeps_the_winner(db, monkeypatch):
    directory = "https://acme.test/directory"
    winner = acme.new_key_pem()
    real_load = certs._load_account
    calls = {"n": 0}

    async def load_then_lose_the_race(d):
        calls["n"] += 1
        if calls["n"] == 1:
            # Our read saw nothing; another Sirdar task commits its key before our insert.
            async with get_sessionmaker()() as s:
                s.add(AcmeAccount(directory=d, key_enc=vault.encrypt(get_settings(), winner)))
                await s.commit()
            return None
        return await real_load(d)

    monkeypatch.setattr(certs, "_load_account", load_then_lose_the_race)
    key_pem, kid = await certs._account_key(get_settings(), directory)
    assert key_pem == winner and kid is None
    rows = (await db.scalars(select(AcmeAccount))).all()
    assert len(rows) == 1


async def _raw(client, url, payload, *, use_jwk=False, content_type="application/jose+json",
               alg=None):
    """One hand-made JWS POST, returning the fake's error type (or None)."""
    nonce = await client._fresh_nonce()
    body = client._signed(url, payload, nonce, use_jwk)
    if alg:
        jws = json.loads(body)
        protected = json.loads(acme.base64.urlsafe_b64decode(jws["protected"] + "=="))
        protected["alg"] = alg
        p64 = acme.b64url(json.dumps(protected).encode())
        r, s = acme.decode_dss_signature(client.key.sign(
            f"{p64}.{jws['payload']}".encode(), acme.ec.ECDSA(acme.hashes.SHA256())))
        body = json.dumps({"protected": p64, "payload": jws["payload"],
                           "signature": acme.b64url(r.to_bytes(32, "big")
                                                    + s.to_bytes(32, "big"))}).encode()
    resp = await client._http("POST", url, content=body, headers={"Content-Type": content_type})
    return acme._error_type(resp) if resp.status_code >= 400 else None


async def test_the_fake_is_strict():
    fake = FakeAcme()
    async with acme.AcmeClient(fake.directory_url, acme.new_key_pem(),
                               transport=fake.transport(), sleep=_nap, poll=0) as client:
        d = await client.directory()
        assert await _raw(client, d["newAccount"], {"termsOfServiceAgreed": True},
                          use_jwk=True, content_type="application/json") == "malformed"
        assert await _raw(client, d["newAccount"], {"termsOfServiceAgreed": True},
                          use_jwk=True, alg="RS256") == "badSignatureAlgorithm"
        assert await _raw(client, d["newAccount"], {}, use_jwk=True) == "malformed"
        await client.register()
        order_url, order = await client.new_order(["a.example.com"])
        assert await _raw(client, order_url, {}) == "malformed"           # not POST-as-GET
        assert await _raw(client, order["authorizations"][0], {"x": 1}) == "malformed"
        assert await _raw(client, order["finalize"], {"csr": "AA"}) == "orderNotReady"
        assert await _raw(client, order_url, None) is None
