"""Nginx Proxy Manager for publishing (spec Section 2 step 13): proxy hosts
and Let's Encrypt certificates over NPM's REST API (<url>/api).

Logs in with the stored email and password (POST /api/tokens) and once more
when a call answers 401. NPM's hourly certbot renew can hold certbot's lock
("Another instance of Certbot is already running"), and a name Cloudflare
just published may not be visible to Let's Encrypt yet ("Some challenges
have failed"): certificate requests that fail for those reasons are retried
after each CERT_BACKOFF wait. NPM 2.x answers a certbot failure with
"Internal Error" and puts certbot's output in the response's debug block, so
the fixed markers are looked for anywhere in the body text (only matched,
never echoed); any other certificate failure gets our certificate copy.

A certificate request that times out may still have been issued by NPM:
callers re-list certificates (and reuse one that covers the name) before
requesting again.

NPM 2.13.0 dropped meta.letsencrypt_email and meta.letsencrypt_agree from
the certificate schema (meta refuses unknown keys, the email is the NPM
user's own and --agree-tos is always passed); 2.12.x needs both. The body is
picked by the version GET /api/ reports, and a 400 that names the other
schema is retried once with the other body.

The password goes only into the login body. Errors carry our own copy; a
4xx outside the login adds NPM's error.message, cleaned to one short line
with the password and token taken out. A login refusal never echoes NPM."""

import asyncio
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx

from sirdar_api.deploy import Check, ConnectFailed, ConnectResult
from sirdar_api.deploy.integrations import NpmConfig

HOST_FIELDS = ("domain_names", "forward_scheme", "forward_host", "forward_port",
               "certificate_id", "ssl_forced", "hsts_enabled", "hsts_subdomains",
               "http2_support", "block_exploits", "caching_enabled", "allow_websocket_upgrade",
               "access_list_id", "advanced_config", "meta", "locations")
CERT_BACKOFF = (30, 60, 120, 240)
CERT_TIMEOUT = 300
TIMEOUT = 30
RENEW_DAYS = 30
_RETRYABLE = {
    "Another instance of Certbot is already running": "Certbot is busy (NPM's hourly renewal)",
    "Some challenges have failed": "Let's Encrypt couldn't check the name yet",
}
_UNREACHABLE = "Couldn't reach Nginx Proxy Manager."
_TIMED_OUT = "Nginx Proxy Manager didn't answer in time."
_BAD_LOGIN = "Nginx Proxy Manager rejected the login."
_UNEXPECTED = "Nginx Proxy Manager sent a response Sirdar didn't understand."
_REFUSED = "Nginx Proxy Manager refused the request: "
MESSAGE_MAX = 200
LEGACY_CERT_BEFORE = (2, 13)   # NPM versions before this take letsencrypt_email/_agree
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


class NpmError(Exception):
    """`reason` is user-facing copy we wrote."""

    def __init__(self, reason: str, status: int | None = None, message: str = ""):
        super().__init__(reason)
        self.reason = reason
        self.status = status  # the HTTP status NPM answered with, when it did
        self.message = message  # NPM's cleaned error.message on a 4xx, else ""


class NotFound(NpmError):
    def __init__(self):
        super().__init__("Nginx Proxy Manager has no such item.", 404)


class TimedOut(NpmError):
    """NPM didn't answer in time; a write may still have happened."""

    def __init__(self):
        super().__init__(_TIMED_OUT)


class _Retryable(NpmError):
    def __init__(self, why: str):
        super().__init__(why)
        self.why = why


@dataclass(frozen=True)
class ProxyHost:
    id: int
    domain_names: tuple[str, ...]
    forward_scheme: str
    forward_host: str
    forward_port: int
    certificate_id: int
    ssl_forced: bool
    http2_support: bool
    allow_websocket_upgrade: bool
    raw: dict = field(repr=False, compare=False)


@dataclass(frozen=True)
class Certificate:
    id: int
    provider: str
    domain_names: tuple[str, ...]
    expires_on: datetime | None


def parse_expiry(value) -> datetime | None:
    """NPM writes "YYYY-MM-DD HH:MM:SS" (UTC); accept ISO too."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace(" ", "T").removesuffix("Z"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def covers(cert: Certificate, hostname: str) -> bool:
    """The certificate names the host, or is a wildcard for its parent."""
    hostname = hostname.lower()
    parent = hostname.split(".", 1)[1] if "." in hostname else ""
    return hostname in cert.domain_names or (bool(parent) and f"*.{parent}" in cert.domain_names)


def days_left(cert: Certificate, now: datetime) -> float | None:
    if cert.expires_on is None:
        return None
    return (cert.expires_on - now).total_seconds() / 86400


def _host(raw) -> ProxyHost:
    try:
        return ProxyHost(
            id=int(raw["id"]), domain_names=tuple(str(d).lower() for d in raw["domain_names"]),
            forward_scheme=str(raw.get("forward_scheme") or "http"),
            forward_host=str(raw["forward_host"]), forward_port=int(raw["forward_port"]),
            certificate_id=int(raw.get("certificate_id") or 0),
            ssl_forced=bool(raw.get("ssl_forced")), http2_support=bool(raw.get("http2_support")),
            allow_websocket_upgrade=bool(raw.get("allow_websocket_upgrade")), raw=dict(raw))
    except (KeyError, TypeError, ValueError, AttributeError):
        raise NpmError(_UNEXPECTED) from None


def _certificate(raw) -> Certificate:
    try:
        return Certificate(id=int(raw["id"]), provider=str(raw.get("provider") or ""),
                           domain_names=tuple(str(d).lower() for d in raw["domain_names"]),
                           expires_on=parse_expiry(raw.get("expires_on")))
    except (KeyError, TypeError, ValueError, AttributeError):
        raise NpmError(_UNEXPECTED) from None


def _clean(text: str, *secrets: str) -> str:
    """One printable line of at most MESSAGE_MAX characters, secrets removed."""
    for secret in secrets:
        if secret:
            text = text.replace(secret, "")
    text = " ".join(_CONTROL.sub(" ", text).split())
    for secret in secrets:  # a secret split by a control character
        if secret:
            text = text.replace(secret, "")
    return text if len(text) <= MESSAGE_MAX else text[:MESSAGE_MAX - 1].rstrip() + "…"


def _npm_message(resp: httpx.Response) -> str:
    try:
        message = resp.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        return ""
    return message if isinstance(message, str) else ""


def _parse_version(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split("."))


def _cert_body(domain: str, email: str, legacy: bool) -> dict:
    meta = {"dns_challenge": False}
    if legacy:
        meta = {"letsencrypt_email": email, "letsencrypt_agree": True, **meta}
    return {"provider": "letsencrypt", "domain_names": [domain], "meta": meta}


def _other_schema(e: NpmError, legacy: bool) -> bool:
    """The 400 says NPM wants the other certificate body."""
    if e.status != 400:
        return False
    text = e.message.lower()
    if legacy:
        return "additional properties" in text
    return any(k in text for k in ("letsencrypt_email", "letsencrypt_agree",
                                   "must have required property"))


def _cert_failed(domain: str) -> str:
    return (f"Nginx Proxy Manager couldn't get a certificate for {domain}. Check that the name "
            "resolves to the public IP and that port 80 reaches the proxy, then retry.")


class Npm:
    """`async with Npm(cfg, transport=...) as api:` — logs in on enter."""

    def __init__(self, cfg: NpmConfig, *, transport: httpx.AsyncBaseTransport | None = None,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 backoff: tuple[int, ...] = CERT_BACKOFF):
        self.cfg = cfg
        self._transport = transport
        self._sleep = sleep
        self._backoff = backoff
        self._client: httpx.AsyncClient | None = None
        self._token = ""
        self._legacy_certs: bool | None = None

    async def __aenter__(self) -> "Npm":
        self._client = httpx.AsyncClient(base_url=self.cfg.url + "/api", timeout=TIMEOUT,
                                         transport=self._transport)
        try:
            await self.login()
        except BaseException:
            await self._client.aclose()
            raise
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def login(self) -> None:
        try:
            resp = await self._client.post("/tokens", json={"identity": self.cfg.identity,
                                                            "secret": self.cfg.password})
        except httpx.TimeoutException:
            raise TimedOut() from None
        except httpx.HTTPError:
            raise NpmError(_UNREACHABLE) from None
        if resp.status_code in (400, 401, 403):
            raise NpmError(_BAD_LOGIN)
        if resp.status_code != 200:
            raise NpmError(f"Nginx Proxy Manager answered with HTTP {resp.status_code}.")
        try:
            token = resp.json().get("token")
        except (ValueError, AttributeError):
            token = None
        if not isinstance(token, str) or not token:
            raise NpmError(_UNEXPECTED)
        self._token = token

    async def _call(self, method: str, path: str, *, json=None, timeout: float = TIMEOUT,
                    again: bool = True):
        try:
            resp = await self._client.request(
                method, path, json=json, timeout=timeout,
                headers={"Authorization": f"Bearer {self._token}"})
        except httpx.TimeoutException:
            raise TimedOut() from None
        except httpx.HTTPError:
            raise NpmError(_UNREACHABLE) from None
        if resp.status_code == 401 and again:
            await self.login()
            return await self._call(method, path, json=json, timeout=timeout, again=False)
        if resp.status_code == 404:
            raise NotFound()
        if resp.status_code >= 400:
            text = resp.text
            for marker, why in _RETRYABLE.items():
                if marker in text:
                    raise _Retryable(why)
            if resp.status_code < 500:
                message = _clean(_npm_message(resp), self.cfg.password, self._token)
                if message:
                    raise NpmError(_REFUSED + message, resp.status_code, message)
            raise NpmError(f"Nginx Proxy Manager answered with HTTP {resp.status_code}.",
                           resp.status_code)
        try:
            return resp.json()
        except ValueError:
            raise NpmError(_UNEXPECTED) from None

    async def version(self) -> str:
        body = await self._call("GET", "/")
        try:
            v = body["version"]
            return f"{int(v['major'])}.{int(v['minor'])}.{int(v['revision'])}"
        except (KeyError, TypeError, ValueError):
            raise NpmError(_UNEXPECTED) from None

    async def proxy_hosts(self) -> list[ProxyHost]:
        body = await self._call("GET", "/nginx/proxy-hosts")
        if not isinstance(body, list):
            raise NpmError(_UNEXPECTED)
        return [_host(h) for h in body]

    async def create_host(self, body: dict) -> ProxyHost:
        return _host(await self._call("POST", "/nginx/proxy-hosts", json=body))

    async def update_host(self, host_id: int, body: dict) -> ProxyHost:
        return _host(await self._call("PUT", f"/nginx/proxy-hosts/{int(host_id)}", json=body))

    async def delete_host(self, host_id: int) -> bool:
        """False when the host was already gone."""
        try:
            await self._call("DELETE", f"/nginx/proxy-hosts/{int(host_id)}")
        except NotFound:
            return False
        return True

    async def certificates(self) -> list[Certificate]:
        body = await self._call("GET", "/nginx/certificates")
        if not isinstance(body, list):
            raise NpmError(_UNEXPECTED)
        return [_certificate(c) for c in body]

    async def _certbot(self, domain: str, out: Callable[[str], None] | None,
                       attempt: Callable[[], Awaitable]) -> Certificate:
        for wait in (*self._backoff, None):
            try:
                return _certificate(await attempt())
            except _Retryable as e:
                if wait is None:
                    break
                if out is not None:
                    out(f"{domain}: {e.why}; trying again in {wait} s\n")
                await self._sleep(wait)
            except NotFound:
                raise
            except NpmError as e:
                if e.status is not None and e.status >= 500:
                    raise NpmError(_cert_failed(domain), e.status) from None
                raise
        raise NpmError(_cert_failed(domain))

    async def _legacy_certificates(self) -> bool:
        """NPM before 2.13 wants letsencrypt_email/_agree; an unreadable
        version counts as current NPM (the 400 retry covers a wrong guess)."""
        if self._legacy_certs is None:
            try:
                self._legacy_certs = _parse_version(await self.version()) < LEGACY_CERT_BEFORE
            except TimedOut:
                raise
            except NpmError:
                self._legacy_certs = False
        return self._legacy_certs

    async def request_certificate(self, domain: str, email: str,
                                  out: Callable[[str], None] | None = None) -> Certificate:
        """`email` only reaches NPM before 2.13; later NPM uses its user's."""
        legacy = await self._legacy_certificates()
        try:
            return await self._post_certificate(domain, email, legacy, out)
        except NpmError as e:
            if not _other_schema(e, legacy):
                raise
        cert = await self._post_certificate(domain, email, not legacy, out)
        self._legacy_certs = not legacy
        return cert

    async def _post_certificate(self, domain: str, email: str, legacy: bool,
                                out: Callable[[str], None] | None) -> Certificate:
        body = _cert_body(domain, email, legacy)
        return await self._certbot(domain, out, lambda: self._call(
            "POST", "/nginx/certificates", json=body, timeout=CERT_TIMEOUT))

    async def renew_certificate(self, cert_id: int, domain: str,
                                out: Callable[[str], None] | None = None) -> Certificate:
        return await self._certbot(domain, out, lambda: self._call(
            "POST", f"/nginx/certificates/{int(cert_id)}/renew", timeout=CERT_TIMEOUT))

    async def delete_certificate(self, cert_id: int) -> bool:
        """False when the certificate was already gone."""
        try:
            await self._call("DELETE", f"/nginx/certificates/{int(cert_id)}")
        except NotFound:
            return False
        return True


async def test_connection(cfg: NpmConfig, *, transport: httpx.AsyncBaseTransport | None = None,
                          now: datetime | None = None) -> ConnectResult:
    """Read-only: log in, read the version, count hosts and certificates."""
    try:
        async with Npm(cfg, transport=transport) as api:
            version = await api.version()
            hosts = await api.proxy_hosts()
            certs = await api.certificates()
    except NpmError as e:
        raise ConnectFailed(e.reason) from None
    now = now or datetime.now(UTC)
    soon = [c for c in certs if (left := days_left(c, now)) is not None and left <= RENEW_DAYS]
    checks = [
        Check("Login", "pass", cfg.identity),
        Check("Version", "pass", version),
        Check("Proxy hosts", "pass", str(len(hosts))),
        Check("Certificates", "warn" if soon else "pass",
              f"{len(certs)}, {len(soon)} expiring within {RENEW_DAYS} days"),
    ]
    return ConnectResult(ok=True, target="npm", checks=checks, facts={
        "url": cfg.url, "version": version, "proxy_hosts": len(hosts),
        "certificates": len(certs)})


test_connection.__test__ = False  # not a pytest test, despite the name
