"""Switchyard (Jimmy's Caddy-based proxy manager) for publishing: proxy and
redirect hosts over its REST API (<url>/api), the LAN proxy an environment
publishes through when its `proxy` is "switchyard" (npm.py is the other).

The API key (sy_…) goes only into the Authorization header. Changes are
staged: a host create, update or delete changes Switchyard's database until
POST /api/config/apply, so every change set ends with apply(). A 422 on
apply means Caddy refused the new config and kept running the old one.

Caddy gets the certificates itself (tls_mode "auto"); Sirdar only waits
until GET /api/certificates shows each name covered, polling every
CERT_POLL seconds for at most CERT_TIMEOUT (npm.py's CERT_TIMEOUT: as long
as Sirdar gives one NPM certificate request). A name Caddy reported a
failure for gets one POST /api/certificates/retry on the way.

Errors carry our own copy; a 4xx adds Switchyard's message (and the fields
of a validation error), cleaned to one short line with the key taken out."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

import httpx

from sirdar_api.deploy import Check, ConnectFailed, ConnectResult
from sirdar_api.deploy.integrations import SwitchyardConfig
from sirdar_api.deploy.npm import _clean

# What the API key needs, one by one (Settings shows this list).
OPERATIONS = ("status.get", "hosts.list", "hosts.get", "hosts.create", "hosts.update",
              "hosts.delete", "config.apply", "certs.list", "certs.retry")
TIMEOUT = 30
APPLY_TIMEOUT = 90          # Switchyard gives Caddy 60 s to load a config
CERT_POLL = 10
CERT_TIMEOUT = 300
READY = ("valid", "expiring")
_UNREACHABLE = "Couldn't reach Switchyard."
_TIMED_OUT = "Switchyard didn't answer in time."
_BAD_KEY = "Switchyard rejected the API key."
_UNEXPECTED = "Switchyard sent a response Sirdar didn't understand."
_REFUSED = "Switchyard refused the change: "
_CADDY_REJECTED = "Caddy refused the change and kept the old config: "


def _missing(operation: str) -> str:
    return (f"Switchyard's API key doesn't have the {operation} permission. Add it to the key "
            "in Switchyard.")


class SwitchyardError(Exception):
    """`reason` is user-facing copy we wrote (plus Switchyard's cleaned
    message on a 4xx); `code` is Switchyard's error code, when it sent one."""

    def __init__(self, reason: str, status: int | None = None, code: str = ""):
        super().__init__(reason)
        self.reason = reason
        self.status = status
        self.code = code


class NotFound(SwitchyardError):
    def __init__(self):
        super().__init__("Switchyard has no such host.", 404, "not_found")


class TimedOut(SwitchyardError):
    """Switchyard didn't answer in time; a write may still have happened."""

    def __init__(self):
        super().__init__(_TIMED_OUT)


@dataclass(frozen=True)
class Upstream:
    scheme: str
    host: str
    port: int


@dataclass(frozen=True)
class Host:
    id: int
    type: str
    domains: tuple[str, ...]
    enabled: bool
    upstreams: tuple[Upstream, ...]
    tls_mode: str
    force_https: bool
    hsts: bool
    redirect_to: str
    redirect_code: int
    preserve_path: bool
    notes: str
    raw: dict = field(repr=False, compare=False)    # the whole host, as PUT wants it back


@dataclass(frozen=True)
class CertState:
    domain: str
    state: str          # valid | expiring | expired | pending
    error: str          # Caddy's last failure for the name, "" when none

    @property
    def ready(self) -> bool:
        return self.state in READY


def _host(raw) -> Host:
    try:
        body = {k: v for k, v in dict(raw).items() if k != "certs"}
        return Host(
            id=int(body["id"]), type=str(body.get("type") or "proxy"),
            domains=tuple(str(d).lower() for d in body.get("domains") or ()),
            enabled=bool(body.get("enabled")),
            upstreams=tuple(Upstream(str(u.get("scheme") or "http"), str(u["host"]),
                                     int(u["port"])) for u in body.get("upstreams") or ()),
            tls_mode=str(body.get("tls_mode") or ""), force_https=bool(body.get("force_https")),
            hsts=bool(body.get("hsts")), redirect_to=str(body.get("redirect_to") or ""),
            redirect_code=int(body.get("redirect_code") or 0),
            preserve_path=bool(body.get("preserve_path")), notes=str(body.get("notes") or ""),
            raw=body)
    except (KeyError, TypeError, ValueError, AttributeError):
        raise SwitchyardError(_UNEXPECTED) from None


def _cert(raw) -> CertState:
    try:
        error = raw.get("last_error") or {}
        message = error.get("message") if isinstance(error, dict) else ""
        return CertState(domain=str(raw["domain"]).lower(), state=str(raw["state"]),
                         error=message if isinstance(message, str) else "")
    except (KeyError, TypeError, AttributeError):
        raise SwitchyardError(_UNEXPECTED) from None


def _body(resp: httpx.Response) -> tuple[str, str]:
    """(error code, message with any fields), "" when absent."""
    try:
        data = resp.json()
    except ValueError:
        return "", ""
    if not isinstance(data, dict):
        return "", ""
    code = data.get("error") if isinstance(data.get("error"), str) else ""
    message = data.get("message") if isinstance(data.get("message"), str) else ""
    fields = data.get("fields")
    if isinstance(fields, dict) and fields:
        parts = "; ".join(f"{k}: {v}" for k, v in fields.items()
                          if isinstance(k, str) and isinstance(v, str))
        if parts:
            message = f"{message} ({parts})".strip()
    return code, message


def _minutes(seconds: int) -> str:
    minutes = round(seconds / 60)
    return f"{minutes} minute{'s' if minutes != 1 else ''}"


class Switchyard:
    """`async with Switchyard(cfg, transport=...) as api:`."""

    def __init__(self, cfg: SwitchyardConfig, *,
                 transport: httpx.AsyncBaseTransport | None = None,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 poll: float = CERT_POLL, cert_timeout: float = CERT_TIMEOUT):
        self.cfg = cfg
        self._transport = transport
        self._sleep = sleep
        self._poll = poll
        self._cert_timeout = cert_timeout
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "Switchyard":
        self._client = httpx.AsyncClient(
            base_url=self.cfg.url + "/api", timeout=TIMEOUT, transport=self._transport,
            headers={"Authorization": f"Bearer {self.cfg.api_key}"})
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _call(self, operation: str, method: str, path: str, *, json=None,
                    timeout: float = TIMEOUT):
        try:
            resp = await self._client.request(method, path, json=json, timeout=timeout)
        except httpx.TimeoutException:
            raise TimedOut() from None
        except httpx.HTTPError:
            raise SwitchyardError(_UNREACHABLE) from None
        status = resp.status_code
        if status == 401:
            raise SwitchyardError(_BAD_KEY, 401, "invalid_api_key")
        code, message = _body(resp)
        message = _clean(message, self.cfg.api_key)
        if status == 403:
            raise SwitchyardError(_missing(operation), 403, code or "missing_permission")
        if status == 404:
            raise NotFound()
        if status == 422 and code == "caddy_rejected":
            raise SwitchyardError(_CADDY_REJECTED + (message or "no reason given"), 422, code)
        if 400 <= status < 500 and message:
            raise SwitchyardError(_REFUSED + message, status, code)
        if status >= 400:
            raise SwitchyardError(f"Switchyard answered with HTTP {status}.", status, code)
        if status == 204 or not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            raise SwitchyardError(_UNEXPECTED) from None

    async def status(self) -> dict:
        body = await self._call("status.get", "GET", "/status")
        try:
            return {"version": str(body.get("version") or ""),
                    "caddy_reachable": bool(body["caddy"]["reachable"])}
        except (KeyError, TypeError, AttributeError):
            raise SwitchyardError(_UNEXPECTED) from None

    async def hosts(self) -> list[Host]:
        body = await self._call("hosts.list", "GET", "/hosts")
        if not isinstance(body, list):
            raise SwitchyardError(_UNEXPECTED)
        return [_host(h) for h in body]

    async def host(self, host_id: int) -> Host:
        return _host(await self._call("hosts.get", "GET", f"/hosts/{int(host_id)}"))

    async def create_host(self, body: dict) -> Host:
        return _host(await self._call("hosts.create", "POST", "/hosts", json=body))

    async def update_host(self, host_id: int, body: dict) -> Host:
        """PUT replaces the whole host: send everything host() returned."""
        return _host(await self._call("hosts.update", "PUT", f"/hosts/{int(host_id)}",
                                      json=body))

    async def delete_host(self, host_id: int) -> bool:
        """False when the host was already gone."""
        try:
            await self._call("hosts.delete", "DELETE", f"/hosts/{int(host_id)}")
        except NotFound:
            return False
        return True

    async def apply(self, note: str) -> None:
        await self._call("config.apply", "POST", "/config/apply", json={"note": note},
                         timeout=APPLY_TIMEOUT)

    async def certificates(self) -> list[CertState]:
        body = await self._call("certs.list", "GET", "/certificates")
        if not isinstance(body, list):
            raise SwitchyardError(_UNEXPECTED)
        return [_cert(c) for c in body]

    async def retry_certificates(self) -> None:
        await self._call("certs.retry", "POST", "/certificates/retry", timeout=APPLY_TIMEOUT)

    async def wait_for_certificates(self, names, out: Callable[[str], None]) -> None:
        """Until every name has a valid certificate, at most cert_timeout
        seconds. One retry when Caddy reports a failure for a name still
        waiting; a timeout names the first name still without one."""
        waiting = sorted({n.lower() for n in names})
        announced: set[str] = set()
        retried = False
        waited = 0.0
        while True:
            rows = {c.domain: c for c in await self.certificates()}
            for name in [n for n in waiting if n in rows and rows[n].ready]:
                if name in announced:
                    out(f"{name}: certificate in place\n")
                waiting.remove(name)
            if not waiting:
                return
            for name in waiting:
                if name not in announced:
                    announced.add(name)
                    out(f"Waiting for Caddy's certificate for {name}\n")
            failed = [n for n in waiting if n in rows and rows[n].error]
            if failed and not retried:
                retried = True
                out(f"{failed[0]}: Caddy couldn't get the certificate yet; asking it to try "
                    "again\n")
                await self.retry_certificates()
            if waited >= self._cert_timeout:
                raise SwitchyardError(
                    f"Caddy didn't get a certificate for {waiting[0]} within "
                    f"{_minutes(self._cert_timeout)}. Check that the name resolves to the "
                    "public IP and that ports 80 and 443 reach Switchyard, then retry.")
            await self._sleep(self._poll)
            waited += self._poll


async def test_connection(cfg: SwitchyardConfig, *,
                          transport: httpx.AsyncBaseTransport | None = None) -> ConnectResult:
    """Read-only: GET /api/status and GET /api/hosts."""
    try:
        async with Switchyard(cfg, transport=transport) as api:
            status = await api.status()
            hosts = await api.hosts()
    except SwitchyardError as e:
        raise ConnectFailed(e.reason) from None
    version = status["version"] or "unknown version"
    checks = [
        Check("Reachable", "pass", f"Switchyard {version}"),
        Check("Caddy", "pass", "Running") if status["caddy_reachable"]
        else Check("Caddy", "warn", "Switchyard can't reach Caddy"),
        Check("API key", "pass", "Can read hosts"),
        Check("Hosts", "pass", str(len(hosts))),
    ]
    return ConnectResult(ok=True, target="switchyard", checks=checks, facts={
        "url": cfg.url, "version": status["version"], "hosts": len(hosts),
        "caddy_reachable": status["caddy_reachable"]})


test_connection.__test__ = False  # not a pytest test, despite the name
