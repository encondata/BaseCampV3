"""A small ACME (RFC 8555) client: one ES256 account key, one order for a
set of DNS names, DNS-01 or HTTP-01 challenges, finalize with a CSR, and the
certificate chain. Standard library, `cryptography` and `httpx` only.

This file is shared byte-for-byte by Sirdar
(sirdar/api/src/sirdar_api/deploy/acme.py: DNS-01 through Cloudflare) and
ServerSherpa's cert-worker (api/src/serversherpa/certs/acme.py: HTTP-01).
Change both together; a Sirdar test compares them.

Errors are AcmeError with our own copy: the server's `detail` text is never
kept. Nothing here logs; private keys are returned only in Issued.key_pem,
which repr() hides."""

import asyncio
import base64
import hashlib
import json
import re
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from datetime import datetime

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.x509.oid import NameOID

LETSENCRYPT = "https://acme-v02.api.letsencrypt.org/directory"
LETSENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory"
POLL_SECONDS = 3
POLL_TRIES = 100
TIMEOUT = 30
_TYPE_RE = re.compile(r"urn:ietf:params:acme:error:([A-Za-z]{1,40})")
_PEM_RE = re.compile(r"-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----\n?")

Solver = Callable[[str, str, str, str], AbstractAsyncContextManager[None]]


class AcmeError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Issued:
    key_pem: str = field(repr=False)
    leaf_pem: str
    chain_pem: str
    not_after: datetime
    names: tuple[str, ...]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def new_key_pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode()


def _load_key(pem: str) -> ec.EllipticCurvePrivateKey:
    try:
        key = serialization.load_pem_private_key(pem.encode(), None)
    except (ValueError, TypeError):
        raise AcmeError("The ACME account key can't be read.") from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise AcmeError("The ACME account key isn't a P-256 key.")
    return key


def jwk(key: ec.EllipticCurvePrivateKey) -> dict:
    numbers = key.public_key().public_numbers()
    return {"crv": "P-256", "kty": "EC", "x": b64url(numbers.x.to_bytes(32, "big")),
            "y": b64url(numbers.y.to_bytes(32, "big"))}


def thumbprint(key: ec.EllipticCurvePrivateKey) -> str:
    canon = json.dumps(jwk(key), sort_keys=True, separators=(",", ":"))
    return b64url(hashlib.sha256(canon.encode()).digest())


def key_authorization(token: str, key: ec.EllipticCurvePrivateKey) -> str:
    return f"{token}.{thumbprint(key)}"


def dns01_value(key_auth: str) -> str:
    return b64url(hashlib.sha256(key_auth.encode()).digest())


def make_csr(names) -> tuple[str, bytes]:
    """(the certificate's new private key as PEM, the CSR as DER)."""
    names = list(names)
    key = ec.generate_private_key(ec.SECP256R1())
    csr = (x509.CertificateSigningRequestBuilder()
           .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])]))
           .add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in names]), False)
           .sign(key, hashes.SHA256()))
    key_pem = key.private_bytes(serialization.Encoding.PEM,
                                serialization.PrivateFormat.TraditionalOpenSSL,
                                serialization.NoEncryption()).decode()
    return key_pem, csr.public_bytes(serialization.Encoding.DER)


def split_chain(pem: str) -> tuple[str, str]:
    """(leaf, the rest of the chain) from a PEM chain."""
    blocks = [b if b.endswith("\n") else b + "\n" for b in _PEM_RE.findall(pem or "")]
    if not blocks:
        raise AcmeError("The ACME server sent no certificate.")
    return blocks[0], "".join(blocks[1:])


def _error_type(resp: httpx.Response) -> str | None:
    try:
        body = resp.json()
    except ValueError:
        return None
    found = _TYPE_RE.fullmatch(str(body.get("type", ""))) if isinstance(body, dict) else None
    return found.group(1) if found else None


def _refused(resp: httpx.Response) -> str:
    kind = _error_type(resp)
    return (f"The ACME server refused the request ({kind})." if kind
            else f"The ACME server answered with HTTP {resp.status_code}.")


class AcmeClient:
    def __init__(self, directory_url: str, account_key_pem: str, *, kid: str | None = None,
                 transport: httpx.AsyncBaseTransport | None = None, sleep=asyncio.sleep,
                 poll: float = POLL_SECONDS, tries: int = POLL_TRIES):
        self.directory_url = directory_url
        self.key = _load_key(account_key_pem)
        self.kid = kid
        self._transport = transport
        self._sleep = sleep
        self._poll = poll
        self._tries = tries
        self._nonce: str | None = None
        self._directory: dict | None = None
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "AcmeClient":
        self._client = httpx.AsyncClient(timeout=TIMEOUT, transport=self._transport,
                                         headers={"User-Agent": "sirdar-acme/1"})
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _http(self, method: str, url: str, **kwargs) -> httpx.Response:
        try:
            return await self._client.request(method, url, **kwargs)
        except httpx.HTTPError:
            raise AcmeError("Couldn't reach the ACME server.") from None

    async def directory(self) -> dict:
        if self._directory is None:
            resp = await self._http("GET", self.directory_url)
            try:
                body = resp.json()
            except ValueError:
                body = None
            if (resp.status_code != 200 or not isinstance(body, dict)
                    or not all(isinstance(body.get(k), str)
                               for k in ("newNonce", "newAccount", "newOrder"))):
                raise AcmeError("The ACME directory isn't usable.")
            self._directory = body
        return self._directory

    async def _fresh_nonce(self) -> str:
        resp = await self._http("HEAD", (await self.directory())["newNonce"])
        nonce = resp.headers.get("replay-nonce")
        if not nonce:
            raise AcmeError("The ACME server sent no nonce.")
        return nonce

    def _signed(self, url: str, payload, nonce: str, use_jwk: bool) -> bytes:
        protected: dict = {"alg": "ES256", "nonce": nonce, "url": url}
        protected |= {"jwk": jwk(self.key)} if use_jwk else {"kid": self.kid}
        p64 = b64url(json.dumps(protected).encode())
        pl64 = "" if payload is None else b64url(json.dumps(payload).encode())
        r, s = decode_dss_signature(self.key.sign(f"{p64}.{pl64}".encode(),
                                                  ec.ECDSA(hashes.SHA256())))
        signature = b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
        return json.dumps({"protected": p64, "payload": pl64, "signature": signature}).encode()

    async def post(self, url: str, payload, *, use_jwk: bool = False,
                   accept: str | None = None) -> httpx.Response:
        """A signed POST (payload None: POST-as-GET). A badNonce is retried once."""
        for attempt in (1, 2):
            nonce = self._nonce or await self._fresh_nonce()
            self._nonce = None
            headers = {"Content-Type": "application/jose+json"}
            if accept:
                headers["Accept"] = accept
            resp = await self._http("POST", url, content=self._signed(url, payload, nonce, use_jwk),
                                    headers=headers)
            self._nonce = resp.headers.get("replay-nonce")
            if resp.status_code == 400 and _error_type(resp) == "badNonce" and attempt == 1:
                continue
            if resp.status_code >= 400:
                raise AcmeError(_refused(resp))
            return resp
        raise AcmeError("The ACME server kept refusing the nonce.")

    async def get_json(self, url: str) -> dict:
        resp = await self.post(url, None)
        try:
            body = resp.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            raise AcmeError("The ACME server sent a response Sirdar didn't understand.")
        return body

    async def register(self) -> str:
        if self.kid:
            return self.kid
        resp = await self.post((await self.directory())["newAccount"],
                               {"termsOfServiceAgreed": True}, use_jwk=True)
        kid = resp.headers.get("location")
        if not kid:
            raise AcmeError("The ACME server sent no account URL.")
        self.kid = kid
        return kid

    async def new_order(self, names) -> tuple[str, dict]:
        resp = await self.post((await self.directory())["newOrder"], {
            "identifiers": [{"type": "dns", "value": n} for n in names]})
        url = resp.headers.get("location")
        try:
            body = resp.json()
        except ValueError:
            body = None
        if not url or not isinstance(body, dict):
            raise AcmeError("The ACME server sent an order Sirdar didn't understand.")
        return url, body

    async def wait_for(self, url: str, ready: tuple[str, ...], what: str) -> dict:
        for _ in range(self._tries):
            body = await self.get_json(url)
            status = body.get("status")
            if status in ready:
                return body
            if status == "invalid":
                raise AcmeError(f"Let's Encrypt couldn't validate {what}.")
            await self._sleep(self._poll)
        raise AcmeError(f"Let's Encrypt didn't finish {what} in time.")

    async def certificate(self, url: str) -> str:
        return (await self.post(url, None, accept="application/pem-certificate-chain")).text


async def issue(client: AcmeClient, names, challenge_type: str, solve: Solver) -> Issued:
    """Order a certificate for `names` and answer each authorization with
    `solve(challenge_type, name, token, key_authorization)`, an async context
    manager that publishes the answer while it is open."""
    names = list(dict.fromkeys(names))
    await client.register()
    order_url, order = await client.new_order(names)
    for authz_url in order.get("authorizations") or []:
        authz = await client.get_json(authz_url)
        if authz.get("status") == "valid":
            continue
        name = (authz.get("identifier") or {}).get("value")
        challenge = next((c for c in authz.get("challenges") or []
                          if isinstance(c, dict) and c.get("type") == challenge_type), None)
        if challenge is None or not isinstance(name, str):
            raise AcmeError(f"The ACME server offered no {challenge_type} challenge.")
        key_auth = key_authorization(str(challenge["token"]), client.key)
        async with solve(challenge_type, name, str(challenge["token"]), key_auth):
            await client.post(challenge["url"], {})
            await client.wait_for(authz_url, ("valid",), name)
    order = await client.wait_for(order_url, ("ready", "valid"), "the order")
    key_pem, csr = make_csr(names)
    if order.get("status") == "ready":
        await client.post(order["finalize"], {"csr": b64url(csr)})
        order = await client.wait_for(order_url, ("valid",), "the certificate")
    leaf, rest = split_chain(await client.certificate(order["certificate"]))
    not_after = x509.load_pem_x509_certificate(leaf.encode()).not_valid_after_utc
    return Issued(key_pem=key_pem, leaf_pem=leaf, chain_pem=rest, not_after=not_after,
                  names=tuple(names))
