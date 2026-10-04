"""A stand-in for the Nginx Proxy Manager REST API calls deploy/npm.py
makes: an httpx.MockTransport over in-memory proxy hosts and certificates.
Hosts and certificates share one id counter, as ids are only compared
within a kind."""

import itertools
import json
from datetime import UTC, datetime, timedelta

import httpx

from sirdar_api.deploy import npm

from .integration_helpers import NPM_PASSWORD

CERTBOT_BUSY = ("Command failed: certbot certonly ... Another instance of Certbot is already "
                "running.")
CHALLENGE_FAILED = "Some challenges have failed."
OTHER_CERTBOT = "Command failed: certbot certonly ... urn:ietf:params:acme:error:rateLimited"
REQUIRED_HOST_FIELDS = ("domain_names", "forward_scheme", "forward_host", "forward_port")


class FakeNpm:
    def __init__(self, *, identity: str = "admin@example.com", secret: str = NPM_PASSWORD,
                 now: datetime | None = None):
        self.identity, self.secret = identity, secret
        self.now = now or datetime.now(UTC)
        self.hosts: dict[int, dict] = {}
        self.certs: dict[int, dict] = {}
        self.requests: list[httpx.Request] = []
        self.tokens: set[str] = set()
        self.certbot_busy = 0          # the next N certificate calls collide with certbot
        self.challenge_fails = 0       # the next N fail Let's Encrypt's challenge
        self.cert_requests: list[list[str]] = []
        self.renewed: list[int] = []
        self.expire_tokens = False     # the next authenticated call finds its token expired
        self.down = False
        self.legacy_errors = False     # certbot text in error.message (else in debug.stack)
        self.cert_errors = 0           # the next N certificate calls fail some other way
        self.host_errors = 0           # the next N proxy-host calls answer a plain 500
        self.last_error: str | None = None
        self._ids = itertools.count(1)

    def add_host(self, domain: str, forward_host: str, forward_port: int, **over) -> int:
        hid = next(self._ids)
        self.hosts[hid] = {
            "id": hid, "domain_names": [domain], "forward_scheme": "http",
            "forward_host": forward_host, "forward_port": forward_port, "certificate_id": 0,
            "ssl_forced": False, "hsts_enabled": False, "hsts_subdomains": False,
            "http2_support": False, "block_exploits": False, "caching_enabled": False,
            "allow_websocket_upgrade": False, "access_list_id": 0, "advanced_config": "",
            "enabled": True, "locations": [],
            "meta": {"letsencrypt_agree": False, "dns_challenge": False, "nginx_online": True,
                     "nginx_err": None},
            **over}
        return hid

    def add_cert(self, domains: list[str], *, days: float = 60,
                 provider: str = "letsencrypt") -> int:
        cid = next(self._ids)
        self.certs[cid] = {
            "id": cid, "provider": provider, "nice_name": domains[0],
            "domain_names": list(domains), "meta": {},
            "expires_on": (self.now + timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")}
        return cid

    def logins(self) -> int:
        return sum(1 for r in self.requests if r.url.path == "/api/tokens")

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def _error(self, status: int, message: str) -> httpx.Response:
        self.last_error = message
        return httpx.Response(status, json={"error": {"code": status, "message": message}})

    def _command_error(self, text: str) -> httpx.Response:
        """NPM 2.x hides a CommandError: the message is "Internal Error" and
        certbot's output is only in debug."""
        if self.legacy_errors:
            return self._error(500, text)
        self.last_error = "Internal Error"
        return httpx.Response(500, json={
            "error": {"code": 500, "message": "Internal Error"},
            "debug": {"stack": [f"CommandError: {text}", "    at /app/lib/utils.js:16:13"],
                      "previous": {"code": 1, "public": False}}})

    def _certbot(self, domains: list[str]) -> httpx.Response | None:
        if self.certbot_busy:
            self.certbot_busy -= 1
            return self._command_error(CERTBOT_BUSY)
        if self.challenge_fails:
            self.challenge_fails -= 1
            return self._command_error(CHALLENGE_FAILED)
        if self.cert_errors:
            self.cert_errors -= 1
            return self._command_error(OTHER_CERTBOT)
        return None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            raise httpx.ConnectError("unreachable", request=request)
        path, method = request.url.path, request.method
        if path == "/api/tokens" and method == "POST":
            body = json.loads(request.content)
            if (body.get("identity"), body.get("secret")) != (self.identity, self.secret):
                return self._error(401, "Invalid email or password")
            token = f"tok-{next(self._ids)}"
            self.tokens.add(token)
            return httpx.Response(200, json={"token": token, "expires": "2026-10-05T00:00:00Z"})
        if path == "/api/" and method == "GET":
            return httpx.Response(200, json={"status": "OK",
                                             "version": {"major": 2, "minor": 12, "revision": 3}})
        if self.expire_tokens:
            self.tokens.clear()
            self.expire_tokens = False
        if request.headers.get("authorization", "").removeprefix("Bearer ") not in self.tokens:
            return self._error(401, "Token has expired")
        if path.startswith("/api/nginx/proxy-hosts") and self.host_errors:
            self.host_errors -= 1
            return self._error(500, "Internal Error")
        if path == "/api/nginx/proxy-hosts":
            if method == "GET":
                return httpx.Response(200, json=list(self.hosts.values()))
            body = json.loads(request.content)
            extra = sorted(set(body) - set(npm.HOST_FIELDS))
            if extra:
                return self._error(400, f"data should NOT have additional properties ({extra[0]})")
            for name in REQUIRED_HOST_FIELDS:
                if name not in body:
                    return self._error(400, f"data must have required property '{name}'")
            served = {d.lower() for h in self.hosts.values() for d in h["domain_names"]}
            for domain in body["domain_names"]:
                if domain.lower() in served:
                    return self._error(400, f"{domain.lower()} is already in use")
            rest = {k: v for k, v in body.items()
                    if k not in ("domain_names", "forward_host", "forward_port")}
            hid = self.add_host(body["domain_names"][0], body["forward_host"],
                                body["forward_port"], **rest)
            self.hosts[hid]["domain_names"] = list(body["domain_names"])
            return httpx.Response(201, json=self.hosts[hid])
        if path.startswith("/api/nginx/proxy-hosts/"):
            hid = int(path.rsplit("/", 1)[1])
            if hid not in self.hosts:
                return self._error(404, "Not Found")
            if method == "DELETE":
                del self.hosts[hid]
                return httpx.Response(200, json=True)
            body = json.loads(request.content)
            extra = sorted(set(body) - set(npm.HOST_FIELDS))
            if extra:
                return self._error(400, f"data should NOT have additional properties ({extra[0]})")
            self.hosts[hid].update(body)
            return httpx.Response(200, json=self.hosts[hid])
        if path == "/api/nginx/certificates":
            if method == "GET":
                return httpx.Response(200, json=list(self.certs.values()))
            body = json.loads(request.content)
            if body.get("provider") != "letsencrypt":
                return self._error(400, "data/provider must be equal to one of the allowed values")
            if (body.get("meta") or {}).get("letsencrypt_agree") is not True:
                return self._error(400, "data/meta/letsencrypt_agree must be true")
            self.cert_requests.append(list(body["domain_names"]))
            failed = self._certbot(body["domain_names"])
            if failed is not None:
                return failed
            cid = self.add_cert(body["domain_names"], days=90)
            return httpx.Response(201, json=self.certs[cid])
        if path.startswith("/api/nginx/certificates/"):
            parts = path.removeprefix("/api/nginx/certificates/").split("/")
            cid = int(parts[0])
            if cid not in self.certs:
                return self._error(404, "Not Found")
            if method == "DELETE":
                del self.certs[cid]
                return httpx.Response(200, json=True)
            if parts[1:] == ["renew"] and method == "POST":
                failed = self._certbot(self.certs[cid]["domain_names"])
                if failed is not None:
                    return failed
                self.renewed.append(cid)
                self.certs[cid]["expires_on"] = (self.now + timedelta(days=90)).strftime(
                    "%Y-%m-%d %H:%M:%S")
                return httpx.Response(200, json=self.certs[cid])
        return self._error(404, "Not Found")
