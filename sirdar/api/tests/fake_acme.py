"""A stand-in ACME (RFC 8555) directory for deploy/acme.py: JWS signatures
are checked (ES256; jwk for a new account, kid after), nonces are
single-use, DNS-01 is answered from a FakeCloudflare's TXT records and
HTTP-01 through http_fetch(name, token) -> str | None, and certificates come
from a test CA.

Knobs: pending_polls (an authz, the order before finalize and the order
after finalize each answer pending/processing for that many polls),
bad_nonce_once, fail_validation, refuse_new_order (a 403 whose detail holds
SECRET text), and breakage (one malformed answer: "challenge_url", "token",
"authorizations", "finalize", "certificate" or "pem")."""

import base64
import hashlib
import itertools
import json
from datetime import UTC, datetime, timedelta

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.x509.oid import NameOID

BASE = "https://acme.test"


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _thumb(jwk: dict) -> str:
    canon = json.dumps({k: jwk[k] for k in ("crv", "kty", "x", "y")}, sort_keys=True,
                       separators=(",", ":"))
    return _b64(hashlib.sha256(canon.encode()).digest())


def _verify(jwk: dict, signing_input: bytes, sig: bytes) -> bool:
    pub = ec.EllipticCurvePublicNumbers(int.from_bytes(_unb64(jwk["x"]), "big"),
                                        int.from_bytes(_unb64(jwk["y"]), "big"),
                                        ec.SECP256R1()).public_key()
    try:
        pub.verify(encode_dss_signature(int.from_bytes(sig[:32], "big"),
                                        int.from_bytes(sig[32:], "big")),
                   signing_input, ec.ECDSA(hashes.SHA256()))
    except Exception:  # noqa: BLE001 — any failure is a bad signature
        return False
    return True


class FakeAcme:
    def __init__(self, *, cloudflare=None, http_fetch=None, days: int = 90,
                 pending_polls: int = 0):
        self.cloudflare = cloudflare
        self.http_fetch = http_fetch
        self.days = days
        self.ca_key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Fake ACME CA")])
        now = datetime.now(UTC)
        self.ca_cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                        .public_key(self.ca_key.public_key())
                        .serial_number(x509.random_serial_number())
                        .not_valid_before(now - timedelta(days=1))
                        .not_valid_after(now + timedelta(days=3650))
                        .add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
                        .sign(self.ca_key, hashes.SHA256()))
        self.nonces: set[str] = set()
        self.accounts: dict[str, dict] = {}
        self.orders: dict[str, dict] = {}
        self.authzs: dict[str, dict] = {}
        self.certs: dict[str, str] = {}
        self.issued: list[x509.Certificate] = []
        self.requests: list[httpx.Request] = []
        self.new_accounts = 0
        self.bad_nonce_once = False
        self.fail_validation = False
        self.refuse_new_order = False
        self.pending_polls = pending_polls
        self.polls_answered_pending = 0
        self.breakage: str | None = None
        self._ids = itertools.count(1)

    @property
    def directory_url(self) -> str:
        return f"{BASE}/directory"

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def _nonce(self) -> str:
        n = f"nonce-{next(self._ids)}"
        self.nonces.add(n)
        return n

    def _problem(self, status: int, type_: str, detail: str = "") -> httpx.Response:
        return httpx.Response(status, json={"type": f"urn:ietf:params:acme:error:{type_}",
                                            "detail": detail or type_},
                              headers={"Replay-Nonce": self._nonce(),
                                       "Content-Type": "application/problem+json"})

    def _json(self, status: int, body: dict, location: str | None = None) -> httpx.Response:
        headers = {"Replay-Nonce": self._nonce()}
        if location:
            headers["Location"] = location
        return httpx.Response(status, json=body, headers=headers)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/directory":
            return httpx.Response(200, json={"newNonce": f"{BASE}/new-nonce",
                                             "newAccount": f"{BASE}/new-account",
                                             "newOrder": f"{BASE}/new-order"})
        if path == "/new-nonce":
            return httpx.Response(200, headers={"Replay-Nonce": self._nonce()})
        if request.method != "POST":
            return self._problem(405, "malformed")
        if request.headers.get("content-type") != "application/jose+json":
            return self._problem(415, "malformed", "wrong content type")
        jws = json.loads(request.content)
        protected = json.loads(_unb64(jws["protected"]))
        if protected.get("alg") != "ES256":
            return self._problem(400, "badSignatureAlgorithm")
        if self.bad_nonce_once:
            self.bad_nonce_once = False
            return self._problem(400, "badNonce", "SECRET-DETAIL bad nonce")
        if protected.get("nonce") not in self.nonces:
            return self._problem(400, "badNonce")
        self.nonces.discard(protected["nonce"])
        if protected.get("url") != str(request.url):
            return self._problem(401, "unauthorized")
        if "jwk" in protected:
            if path != "/new-account":
                return self._problem(400, "malformed")
            account_jwk = protected["jwk"]
        else:
            account_jwk = self.accounts.get(protected.get("kid"))
            if account_jwk is None:
                return self._problem(400, "accountDoesNotExist")
        if not _verify(account_jwk, f"{jws['protected']}.{jws['payload']}".encode(),
                       _unb64(jws["signature"])):
            return self._problem(400, "malformed", "bad signature")
        payload = json.loads(_unb64(jws["payload"])) if jws["payload"] else None
        parts = [p for p in path.split("/") if p]
        if parts[0] in ("authz", "order", "cert") and jws["payload"] != "":
            return self._problem(400, "malformed", "POST-as-GET needs an empty payload")
        if parts == ["new-account"]:
            if not isinstance(payload, dict) or payload.get("termsOfServiceAgreed") is not True:
                return self._problem(400, "malformed", "terms not agreed")
            for kid, known in self.accounts.items():
                if _thumb(known) == _thumb(account_jwk):
                    return self._json(200, {"status": "valid"}, kid)
            kid = f"{BASE}/acct/{next(self._ids)}"
            self.accounts[kid] = account_jwk
            self.new_accounts += 1
            return self._json(201, {"status": "valid"}, kid)
        if parts == ["new-order"]:
            if self.refuse_new_order:
                return self._problem(403, "unauthorized",
                                     "SECRET-DETAIL CAA record forbids issuance")
            names = [i["value"] for i in payload["identifiers"]]
            oid = str(next(self._ids))
            authz_urls = []
            for name in names:
                aid = str(next(self._ids))
                token = _b64(hashlib.sha256(f"{oid}-{aid}".encode()).digest())
                self.authzs[aid] = {"identifier": {"type": "dns", "value": name},
                                    "status": "pending", "_order": oid,
                                    "challenges": [
                                        {"type": "dns-01", "url": f"{BASE}/chall/{aid}/dns",
                                         "token": token, "status": "pending"},
                                        {"type": "http-01", "url": f"{BASE}/chall/{aid}/http",
                                         "token": token, "status": "pending"}]}
                authz_urls.append(f"{BASE}/authz/{aid}")
            self.orders[oid] = {"status": "pending", "identifiers": payload["identifiers"],
                                "authorizations": authz_urls,
                                "finalize": f"{BASE}/finalize/{oid}", "_left": 0}
            return self._json(201, self._order_view(self.orders[oid]), f"{BASE}/order/{oid}")
        if parts[0] == "authz":
            authz = self.authzs[parts[1]]
            if "_result" in authz:
                if authz["_left"] > 0:
                    authz["_left"] -= 1
                    self.polls_answered_pending += 1
                    return self._json(200, self._authz_view(authz))
                self._settle(authz)
            return self._json(200, self._authz_view(authz))
        if parts[0] == "chall":
            if payload != {}:
                return self._problem(400, "malformed", "a challenge answer is {}")
            authz = self.authzs[parts[1]]
            ok = self._validate(authz, parts[2], account_jwk)
            authz |= {"_result": "valid" if ok else "invalid", "_left": self.pending_polls}
            if not self.pending_polls:
                self._settle(authz)
            return self._json(200, {"type": parts[2], "status": "processing"})
        if parts[0] == "order":
            order = self.orders[parts[1]]
            if order["_left"] > 0:
                order["_left"] -= 1
                self.polls_answered_pending += 1
                busy = "pending" if order["status"] == "ready" else "processing"
                return self._json(200, self._order_view(order, busy=busy))
            return self._json(200, self._order_view(order))
        if parts[0] == "finalize":
            order = self.orders[parts[1]]
            if order["status"] != "ready" or order["_left"] > 0:
                return self._problem(403, "orderNotReady")
            csr = x509.load_der_x509_csr(_unb64(payload["csr"]))
            names = sorted(csr.extensions.get_extension_for_class(
                x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName))
            if names != sorted(i["value"] for i in order["identifiers"]):
                return self._problem(400, "badCSR")
            leaf = self._issue(csr, names)
            pem = serialization.Encoding.PEM
            self.certs[parts[1]] = (leaf.public_bytes(pem).decode()
                                    + self.ca_cert.public_bytes(pem).decode())
            order |= {"status": "valid", "certificate": f"{BASE}/cert/{parts[1]}",
                      "_left": self.pending_polls}
            return self._json(200, self._order_view(
                order, busy="processing" if order["_left"] else None))
        if parts[0] == "cert":
            text = self.certs[parts[1]]
            if self.breakage == "pem":
                text = "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n"
            return httpx.Response(200, text=text,
                                  headers={"Replay-Nonce": self._nonce(),
                                           "Content-Type": "application/pem-certificate-chain"})
        return self._problem(404, "malformed")

    @staticmethod
    def _public(row: dict) -> dict:
        return {k: v for k, v in row.items() if not k.startswith("_")}

    def _settle(self, authz: dict) -> None:
        """Apply a challenge's result to its authz and order."""
        authz["status"] = authz.pop("_result")
        order = self.orders[authz["_order"]]
        states = {self.authzs[u.rsplit("/", 1)[1]]["status"] for u in order["authorizations"]}
        order["status"] = "invalid" if "invalid" in states else (
            "ready" if states == {"valid"} else "pending")
        if order["status"] == "ready":
            order["_left"] = self.pending_polls

    def _authz_view(self, authz: dict) -> dict:
        view = json.loads(json.dumps(self._public(authz)))
        for challenge in view["challenges"]:
            if self.breakage == "challenge_url":
                challenge.pop("url")
            if self.breakage == "token":
                challenge["token"] = "../../etc/passwd"
        return view

    def _order_view(self, order: dict, busy: str | None = None) -> dict:
        view = self._public(order)
        if busy:
            view["status"] = busy
            view.pop("certificate", None)
        if self.breakage == "authorizations":
            view["authorizations"] = "nope"
        if self.breakage in ("finalize", "certificate"):
            view.pop(self.breakage, None)
        return view

    def _validate(self, authz: dict, kind: str, account_jwk: dict) -> bool:
        if self.fail_validation:
            return False
        token = authz["challenges"][0]["token"]
        key_auth = f"{token}.{_thumb(account_jwk)}"
        name = authz["identifier"]["value"]
        if kind == "dns":
            want = _b64(hashlib.sha256(key_auth.encode()).digest())
            return any(r["type"] == "TXT" and r["name"] == f"_acme-challenge.{name}"
                       and r["content"] == want for r in self.cloudflare.records.values())
        return self.http_fetch is not None and self.http_fetch(name, token) == key_auth

    def _issue(self, csr: x509.CertificateSigningRequest, names: list[str]) -> x509.Certificate:
        now = datetime.now(UTC)
        leaf = (x509.CertificateBuilder()
                .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])]))
                .issuer_name(self.ca_cert.subject).public_key(csr.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(hours=1))
                .not_valid_after(now + timedelta(days=self.days))
                .add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in names]),
                               False)
                .sign(self.ca_key, hashes.SHA256()))
        self.issued.append(leaf)
        return leaf
