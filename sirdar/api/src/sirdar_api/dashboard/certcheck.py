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
import logging
import socket
import ssl
import time
from collections.abc import Awaitable, Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
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
DEADLINE = 4.0
# Lookups run here, not on the loop's shared default executor: a stuck
# resolver ties up at most these threads (a timed-out lookup can't be
# cancelled, it finishes in its thread).
_DNS = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sirdar-certcheck-dns")


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


async def _open(hostname: str, port: int):
    """Resolve on _DNS, then connect to each address in turn."""
    loop = asyncio.get_running_loop()
    infos = await loop.run_in_executor(
        _DNS, socket.getaddrinfo, hostname, port, 0, socket.SOCK_STREAM)
    last: OSError | None = None
    for *_, addr in infos:
        try:
            return await asyncio.open_connection(addr[0], port)
        except OSError as e:
            last = e
    raise last or OSError("no address")


async def check(hostname: str, *, port: int = 443, timeout: float = 3.0) -> HostCert:
    """The certificate `hostname` serves on `port`: `timeout` seconds to
    resolve and connect, then `timeout` more for the TLS handshake. The
    connection is aborted, not closed politely."""
    try:
        _, writer = await asyncio.wait_for(_open(hostname, port), timeout)
    except TimeoutError:
        return HostCert(hostname, None, TIMED_OUT)
    except OSError:
        return HostCert(hostname, None, NO_CONNECT)
    try:
        await asyncio.wait_for(writer.start_tls(_context(), server_hostname=hostname), timeout)
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
        writer.transport.abort()


CheckFn = Callable[..., Awaitable[HostCert]]


class Checker:
    """Checks hostnames concurrently, caching each result per hostname. One
    limit (`limit` checks in flight) covers every caller, and callers that
    want a hostname already being checked await that same check. A call
    returns by `deadline`: hosts still being checked read "Timed out" this
    time, and their checks finish in the background and fill the cache.
    `check` is injectable so tests never dial out."""

    def __init__(self, check: CheckFn | None = None, *, limit: int = LIMIT,
                 deadline: float = DEADLINE, clock: Callable[[], float] = time.monotonic):
        self._check = check
        self._gate = asyncio.Semaphore(limit)
        self._deadline = deadline
        self._clock = clock
        self._cache: dict[str, tuple[float, HostCert]] = {}
        # Also the strong reference that keeps a check outliving its caller alive.
        self._inflight: dict[str, asyncio.Task] = {}

    def clear(self) -> None:
        self._cache.clear()

    def _cached(self, hostname: str) -> HostCert | None:
        hit = self._cache.get(hostname)
        if hit is None:
            return None
        ttl = OK_SECONDS if hit[1].not_after is not None else FAIL_SECONDS
        return hit[1] if self._clock() - hit[0] < ttl else None

    def _prune(self) -> None:
        """Entries past the longest TTL are useless: drop them, so the cache
        only holds hostnames checked within the hour."""
        now = self._clock()
        for h in [h for h, (at, _) in self._cache.items() if now - at >= OK_SECONDS]:
            del self._cache[h]

    async def _run(self, hostname: str) -> HostCert:
        fn = self._check or check
        async with self._gate:
            try:
                result = await fn(hostname)
            except TimeoutError:
                result = HostCert(hostname, None, TIMED_OUT)
            # A check must never break the dashboard; the reason stays in the log.
            except Exception as e:  # noqa: BLE001
                log.warning("certificate check of %s failed: %s", hostname, type(e).__name__)
                result = HostCert(hostname, None, NO_CONNECT)
        self._cache[hostname] = (self._clock(), result)
        return result

    def _start(self, hostname: str) -> asyncio.Task:
        task = self._inflight.get(hostname)
        if task is None:
            task = asyncio.ensure_future(self._run(hostname))
            self._inflight[hostname] = task

            def done(t: asyncio.Task, h: str = hostname) -> None:
                if self._inflight.get(h) is t:
                    del self._inflight[h]
            task.add_done_callback(done)
        return task

    async def check_all(self, hostnames: Iterable[str], *,
                        refresh: bool = False) -> dict[str, HostCert]:
        self._prune()
        wanted = list(dict.fromkeys(hostnames))
        found: dict[str, HostCert] = {}
        tasks: dict[str, asyncio.Task] = {}
        for h in wanted:
            hit = None if refresh else self._cached(h)
            if hit is None:
                tasks[h] = self._start(h)
            else:
                found[h] = hit
        if tasks:
            # asyncio.wait leaves the unfinished ones running (they fill the cache).
            await asyncio.wait(set(tasks.values()), timeout=self._deadline)
        for h, t in tasks.items():
            found[h] = t.result() if t.done() else HostCert(h, None, TIMED_OUT)
        return {h: found[h] for h in wanted}
