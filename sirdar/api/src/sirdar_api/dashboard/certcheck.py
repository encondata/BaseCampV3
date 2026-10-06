"""Live certificate expiry for the dashboard: connect to a public hostname on
443 (SNI = the hostname), read the served leaf certificate's notAfter and
hang up. Nothing is verified: an untrusted staging or self-signed
certificate must still report its date. Only hostnames Sirdar manages
(environment_services.hostname) are ever dialed.

A failure is our own short copy ("Timed out", "Couldn't connect", "No
certificate"), never exception text. The Checker caches each hostname's
result (an hour for a date, five minutes for a failure) and checks at most
16 hostnames at a time."""

import asyncio
import contextlib
import logging
import ssl
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import datetime

from cryptography import x509

log = logging.getLogger(__name__)

TIMED_OUT = "Timed out"
NO_CONNECT = "Couldn't connect"
NO_CERT = "No certificate"
OK_SECONDS = 3600
FAIL_SECONDS = 300
LIMIT = 16


@dataclass(frozen=True)
class HostCert:
    hostname: str
    not_after: datetime | None
    error: str | None


def _context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def check(hostname: str, *, port: int = 443, timeout: float = 3.0) -> HostCert:
    """The certificate `hostname` serves on `port`: `timeout` seconds to
    connect, then `timeout` more for the TLS handshake."""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(hostname, port), timeout)
    except TimeoutError:
        return HostCert(hostname, None, TIMED_OUT)
    except OSError:
        return HostCert(hostname, None, NO_CONNECT)
    try:
        await asyncio.wait_for(
            writer.start_tls(_context(), server_hostname=hostname,
                             ssl_handshake_timeout=timeout), timeout)
        tls = writer.get_extra_info("ssl_object")
        der = tls.getpeercert(binary_form=True) if tls else None
        if not der:
            return HostCert(hostname, None, NO_CERT)
        try:
            return HostCert(hostname, x509.load_der_x509_certificate(der).not_valid_after_utc,
                            None)
        except ValueError:
            return HostCert(hostname, None, NO_CERT)
    except TimeoutError:
        return HostCert(hostname, None, TIMED_OUT)
    except OSError:
        return HostCert(hostname, None, NO_CONNECT)
    finally:
        writer.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(writer.wait_closed(), 1)


CheckFn = Callable[..., Awaitable[HostCert]]


class Checker:
    """Checks hostnames concurrently (at most `limit` at a time), caching each
    result per hostname. `check` is injectable so tests never dial out."""

    def __init__(self, check: CheckFn | None = None, *, limit: int = LIMIT,
                 clock: Callable[[], float] = time.monotonic):
        self._check = check
        self._limit = limit
        self._clock = clock
        self._cache: dict[str, tuple[float, HostCert]] = {}

    def clear(self) -> None:
        self._cache.clear()

    def _cached(self, hostname: str) -> HostCert | None:
        hit = self._cache.get(hostname)
        if hit is None:
            return None
        ttl = OK_SECONDS if hit[1].not_after is not None else FAIL_SECONDS
        return hit[1] if self._clock() - hit[0] < ttl else None

    async def check_all(self, hostnames: Iterable[str], *,
                        refresh: bool = False) -> dict[str, HostCert]:
        wanted = list(dict.fromkeys(hostnames))
        found: dict[str, HostCert] = {}
        todo = []
        for h in wanted:
            hit = None if refresh else self._cached(h)
            if hit is None:
                todo.append(h)
            else:
                found[h] = hit
        gate = asyncio.Semaphore(self._limit)
        fn = self._check or check

        async def one(h: str) -> HostCert:
            async with gate:
                try:
                    return await fn(h)
                except TimeoutError:
                    return HostCert(h, None, TIMED_OUT)
                # A check must never break the dashboard; the reason stays in the log.
                except Exception as e:  # noqa: BLE001
                    log.warning("certificate check of %s failed: %s", h, type(e).__name__)
                    return HostCert(h, None, NO_CONNECT)

        for result in await asyncio.gather(*(one(h) for h in todo)):
            self._cache[result.hostname] = (self._clock(), result)
            found[result.hostname] = result
        return {h: found[h] for h in wanted}
