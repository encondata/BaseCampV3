"""Smoke test after a publish (spec Section 2 step 14): every public URL
answers over HTTPS. Requests go to the environment's proxy IP (NPM on the
LAN) with SNI and Host set to the public name, so the check covers NPM, the
certificate (verified against that name) and the app without depending on
the router's hairpin NAT — the reason the stacks map these names to NPM in
extra_hosts too. Redirects are not followed: 200–399 passes. Details are
our own copy, never httpx's text."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

PATHS = {"api": "/healthz", "portal": "/", "kiosk": "/", "wiki": "/healthz",
         "spaces": "/healthz", "status": "/healthz"}
ATTEMPTS = 6
DELAY = 10
TIMEOUT = 10


@dataclass(frozen=True)
class SmokeResult:
    service: str
    url: str
    ok: bool
    detail: str


async def _check(client: httpx.AsyncClient, proxy_ip: str, service: str,
                 hostname: str) -> SmokeResult:
    path = PATHS.get(service, "/")
    url = f"https://{hostname}{path}"
    try:
        resp = await client.get(f"https://{proxy_ip}{path}", headers={"Host": hostname},
                                extensions={"sni_hostname": hostname})
    except httpx.TimeoutException:
        return SmokeResult(service, url, False, f"no answer within {TIMEOUT} s")
    except httpx.ConnectError as e:
        text = str(e).upper()
        tls = "CERTIFICATE" in text or "SSL" in text      # branch only; never shown
        return SmokeResult(service, url, False, "the certificate didn't verify" if tls
                           else "couldn't connect to the proxy")
    except httpx.HTTPError:
        return SmokeResult(service, url, False, "the request failed")
    return SmokeResult(service, url, 200 <= resp.status_code < 400, f"HTTP {resp.status_code}")


async def run(targets: list[tuple[str, str]], proxy_ip: str, *,
              transport: httpx.AsyncBaseTransport | None = None,
              sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
              attempts: int = ATTEMPTS, delay: float = DELAY,
              out: Callable[[str], None] | None = None) -> list[SmokeResult]:
    """Check each (service, hostname); failures are asked again, up to
    `attempts` rounds `delay` seconds apart (NPM may still be reloading)."""
    results: dict[str, SmokeResult] = {}
    pending = list(targets)
    async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport,
                                 follow_redirects=False) as client:
        for attempt in range(1, attempts + 1):
            failed = []
            for service, hostname in pending:
                result = await _check(client, proxy_ip, service, hostname)
                results[service] = result
                if not result.ok:
                    failed.append((service, hostname))
            pending = failed
            if not pending or attempt == attempts:
                break
            if out is not None:
                names = ", ".join(service for service, _ in pending)
                out(f"Waiting {delay:g} s, then trying {names} again "
                    f"({attempt + 1} of {attempts})\n")
            await sleep(delay)
    return [results[service] for service, _ in targets]
