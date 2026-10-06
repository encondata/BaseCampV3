"""The cert-worker (Sirdar deploy phase 7): keeps a DigitalOcean
environment's load balancer certificate fresh with Let's Encrypt HTTP-01.

Both slots of an environment run one, against the shared database. Only
the one on the droplet the load balancer targets renews (the challenge
reaches the active slot only), and only while it holds a Postgres advisory
lock, at 30 days or fewer. Renewing uploads a new custom certificate named
ss-<env>-<UTC yyyymmddhhmm>, moves the load balancer's HTTPS rule to it and
deletes the old one. Caddy sends /.well-known/acme-challenge/* here (:8089).

Sirdar renews too, by DNS-01, at 14 days or fewer: the backup. The DigitalOcean
token here is the account's renewal token (certificates and load balancers
only). Nothing here logs a token, a key or a certificate; errors are our own
copy, never DigitalOcean's or httpx's text. The advisory lock's connection
comes from the api's engine, so it uses the managed database's TLS
(serversherpa.db.tls) like every other path to the database."""

import asyncio
import base64
import binascii
import logging
import re
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
from sqlalchemy import text

from serversherpa.certs import acme
from serversherpa.config import Settings, get_settings
from serversherpa.db.engine import get_engine

log = logging.getLogger(__name__)

DO_API = "https://api.digitalocean.com/v2"
RENEW_DAYS = 30
CHECK_SECONDS = 24 * 3600
FIRST_CHECK_SECONDS = 5 * 60
LOCK_KEY = 0x5353434552545752           # "SSCERTWR"
CHALLENGE_PREFIX = "/.well-known/acme-challenge/"
_ID_RE = re.compile(r"[A-Za-z0-9-]{1,64}")
_LB_READ_ONLY = ("id", "ip", "ipv6", "status", "created_at")
_MAX_HEADER_LINES = 100


class CertWorkerError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class WorkerConfig:
    token: str = field(repr=False)
    lb_id: str = ""
    names: tuple[str, ...] = ()
    env: str = ""
    directory: str = acme.LETSENCRYPT
    key_pem: str = field(default="", repr=False)
    droplet_id: str = ""
    port: int = 8089


def _secret(value) -> str:
    return value.get_secret_value().strip() if value is not None else ""


def config_from(settings: Settings) -> WorkerConfig | None:
    """None when this isn't a DigitalOcean droplet (or a value is missing
    or malformed). Compose renders unset keys as empty strings."""
    names = tuple(n.strip() for n in settings.cert_names.split(",") if n.strip())
    token, key_b64 = _secret(settings.cert_do_token), _secret(settings.cert_acme_key)
    if (not token or not key_b64 or not _ID_RE.fullmatch(settings.cert_lb_id)
            or not names or not settings.cert_env
            or not settings.cert_droplet_id.isdecimal()):
        return None
    try:
        key_pem = base64.b64decode(key_b64, validate=True).decode()
    except (binascii.Error, ValueError):
        return None
    return WorkerConfig(token=token, lb_id=settings.cert_lb_id, names=names,
                        env=settings.cert_env, directory=settings.cert_acme_directory,
                        key_pem=key_pem, droplet_id=settings.cert_droplet_id,
                        port=settings.cert_challenge_port)


class Challenges:
    """Answers GET /.well-known/acme-challenge/<token> while a solver holds it."""

    def __init__(self):
        self.tokens: dict[str, str] = {}

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            line = (await asyncio.wait_for(reader.readline(), 10)).decode("latin-1")
            # Read the headers too: closing with unread input can reset the
            # connection before the proxy reads the answer.
            for _ in range(_MAX_HEADER_LINES):
                header = await asyncio.wait_for(reader.readline(), 10)
                if header in (b"\r\n", b"\n", b""):
                    break
            parts = line.split()
            path = parts[1] if len(parts) >= 2 else ""
            answer = (self.tokens.get(path.removeprefix(CHALLENGE_PREFIX))
                      if path.startswith(CHALLENGE_PREFIX) else None)
            if answer is None:
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n"
                             b"Connection: close\r\n\r\n")
            else:
                body = answer.encode()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
                             + f"Content-Length: {len(body)}\r\n".encode()
                             + b"Connection: close\r\n\r\n" + body)
            await writer.drain()
        except (TimeoutError, ConnectionError, UnicodeError, ValueError):
            pass
        finally:
            writer.close()

    async def start(self, host: str, port: int) -> asyncio.Server:
        return await asyncio.start_server(self._handle, host, port)

    @asynccontextmanager
    async def solver(self, kind: str, name: str, token: str, key_auth: str):
        self.tokens[token] = key_auth
        try:
            yield
        finally:
            self.tokens.pop(token, None)


@asynccontextmanager
async def advisory_lock():
    """True while this worker is the only renewer (both slots share the
    database); False when another holds it. A session lock on a pooled
    connection: released on the way out, or the connection is thrown away."""
    async with get_engine().connect() as conn:
        got = bool(await conn.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY}))
        try:
            yield got
        finally:
            if got:
                try:
                    await conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
                except BaseException:
                    # Never hand a connection that may still hold the lock
                    # back to the pool.
                    await conn.invalidate()
                    raise


async def _do(client: httpx.AsyncClient, method: str, path: str, body: dict | None = None,
              *, missing_ok: bool = False) -> dict:
    try:
        resp = await client.request(method, path, json=body)
    except httpx.HTTPError:
        raise CertWorkerError("Couldn't reach the DigitalOcean API.") from None
    if missing_ok and resp.status_code == 404:
        return {}
    if resp.status_code >= 400:
        raise CertWorkerError(f"DigitalOcean answered with HTTP {resp.status_code}.")
    if resp.status_code == 204 or not resp.content:
        return {}
    try:
        found = resp.json()
    except ValueError:
        found = None
    if not isinstance(found, dict):
        raise CertWorkerError("DigitalOcean sent a response the worker didn't understand.")
    return found


def _field(body: dict, key: str) -> dict:
    value = body.get(key)
    if not isinstance(value, dict):
        raise CertWorkerError("DigitalOcean sent a response the worker didn't understand.")
    return value


def _id(value) -> str:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise CertWorkerError("DigitalOcean sent an ID the worker didn't understand.")
    return value


async def _load_balancer(do: httpx.AsyncClient, cfg: WorkerConfig) -> dict:
    return _field(await _do(do, "GET", f"/load_balancers/{cfg.lb_id}"), "load_balancer")


async def _certificate(do: httpx.AsyncClient, certificate_id: str | None) -> dict | None:
    if not certificate_id:
        return None
    found = (await _do(do, "GET", f"/certificates/{_id(certificate_id)}",
                       missing_ok=True)).get("certificate")
    return found if isinstance(found, dict) else None


def _targets(lb: dict, cfg: WorkerConfig) -> bool:
    ids = lb.get("droplet_ids") or []
    return isinstance(ids, list) and int(cfg.droplet_id) in [
        d for d in ids if isinstance(d, int)]


def _https_certificate(lb: dict) -> str | None:
    return next((r.get("certificate_id") for r in lb.get("forwarding_rules") or []
                 if isinstance(r, dict) and r.get("entry_protocol") == "https"), None)


def _lb_body(lb: dict, certificate_id: str) -> dict:
    """A PUT replaces the whole load balancer: its live body (read-only and
    empty fields left out, so settings the worker doesn't manage stay), with
    the HTTPS rule on the new certificate (Sirdar's do_provision.lb_update_body)."""
    body = {k: v for k, v in lb.items()
            if k not in _LB_READ_ONLY and not k.startswith("_") and v is not None}
    if isinstance(body.get("region"), dict):
        body["region"] = body["region"].get("slug")
    if "size_unit" in body:
        body.pop("size", None)                 # size is the older spelling; never both
    body["forwarding_rules"] = [
        {**r, "certificate_id": certificate_id}
        if isinstance(r, dict) and r.get("entry_protocol") == "https" else r
        for r in lb.get("forwarding_rules") or []]
    if body.get("droplet_ids") is not None or not body.get("tag"):
        body.pop("tag", None)                  # droplet_ids and tag are exclusive
    return body


def _days_left(cert: dict | None, now: datetime) -> float | None:
    try:
        when = datetime.strptime(str((cert or {}).get("not_after")),
                                 "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError:
        return None
    return (when - now).total_seconds() / 86400


async def _due(do: httpx.AsyncClient, cfg: WorkerConfig, now: datetime,
               renew_days: float) -> tuple[str | None, dict, dict | None]:
    """(None or "not_active"/"fresh", the load balancer, its certificate)."""
    lb = await _load_balancer(do, cfg)
    if not _targets(lb, cfg):
        return "not_active", lb, None
    cert = await _certificate(do, _https_certificate(lb))
    left = _days_left(cert, now)
    if left is not None and left > renew_days:
        return "fresh", lb, cert
    return None, lb, cert


async def check_once(cfg: WorkerConfig, *, challenges: Challenges,
                     transports: dict | None = None, now: datetime | None = None,
                     try_lock: Callable[[], AbstractAsyncContextManager[bool]] | None = None,
                     sleep=asyncio.sleep, poll: float = acme.POLL_SECONDS,
                     renew_days: float = RENEW_DAYS) -> str:
    """One check: "not_active" (the load balancer targets another droplet),
    "fresh" (more than `renew_days` left), "locked" (another worker is
    renewing) or "renewed"."""
    transports = transports or {}
    now = now or datetime.now(UTC)
    async with httpx.AsyncClient(base_url=DO_API, timeout=30,
                                 headers={"Authorization": f"Bearer {cfg.token}"},
                                 transport=transports.get("digitalocean")) as do:
        outcome, _, _ = await _due(do, cfg, now, renew_days)
        if outcome:
            return outcome
        async with (try_lock or advisory_lock)() as got:
            if not got:
                return "locked"
            # Under the lock, look again: another worker may have just renewed.
            outcome, _, _ = await _due(do, cfg, now, renew_days)
            if outcome:
                return outcome
            async with acme.AcmeClient(cfg.directory, cfg.key_pem,
                                       transport=transports.get("acme"), sleep=sleep,
                                       poll=poll) as client:
                issued = await acme.issue(client, cfg.names, "http-01", challenges.solver)
            upload = {"name": f"ss-{cfg.env}-{now:%Y%m%d%H%M}", "type": "custom",
                      "private_key": issued.key_pem, "leaf_certificate": issued.leaf_pem}
            if issued.chain_pem:
                upload["certificate_chain"] = issued.chain_pem
            made = _field(await _do(do, "POST", "/certificates", upload), "certificate")
            made_id = _id(made.get("id"))
            # Issuing takes a while: move the load balancer as it is now.
            lb = await _load_balancer(do, cfg)
            old_id = _https_certificate(lb)
            old = await _certificate(do, old_id) if old_id != made_id else None
            await _do(do, "PUT", f"/load_balancers/{cfg.lb_id}", _lb_body(lb, made_id))
            # Delete only the environment's own certificates (Sirdar's or ours).
            if old and str(old.get("name", "")).startswith(f"ss-{cfg.env}-"):
                await _do(do, "DELETE", f"/certificates/{_id(old_id)}", missing_ok=True)
            return "renewed"


async def check_logged(cfg: WorkerConfig, challenges: Challenges, **kwargs) -> str | None:
    """check_once for the service loop: the outcome, or None after logging
    our own copy of what went wrong (never an unknown error's text)."""
    try:
        outcome = await check_once(cfg, challenges=challenges, **kwargs)
    except (CertWorkerError, acme.AcmeError) as e:
        log.warning("cert-worker: %s", e.reason)
        return None
    except Exception as e:  # noqa: BLE001 — the loop must never stop
        log.warning("cert-worker: check failed (%s)", type(e).__name__)
        return None
    log.info("cert-worker: %s", outcome)
    return outcome


async def run_forever(*, once: bool = False, renew_days: float = RENEW_DAYS) -> str | None:
    """The service: a check a few minutes after start, then daily. `once`
    (the CLI's --once, for an operator who stopped the service first): one
    check right away, its outcome returned; `renew_days` forces a renewal
    when raised past the days left."""
    if not once:
        from serversherpa.system.db_logging import install
        install("cert-worker")
    cfg = config_from(get_settings())
    if cfg is None:
        log.info("cert-worker: not a DigitalOcean droplet (SS_CERT_* unset); idle")
        if once:
            return "not_configured"
        while True:
            await asyncio.sleep(CHECK_SECONDS)
    challenges = Challenges()
    server = await challenges.start("0.0.0.0", cfg.port)
    log.info("cert-worker: answering HTTP-01 on :%s", cfg.port)
    try:
        if once:
            return await check_once(cfg, challenges=challenges, renew_days=renew_days)
        await asyncio.sleep(FIRST_CHECK_SECONDS)
        while True:
            await check_logged(cfg, challenges, renew_days=renew_days)
            await asyncio.sleep(CHECK_SECONDS)
    finally:
        server.close()
