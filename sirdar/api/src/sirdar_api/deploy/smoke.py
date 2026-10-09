"""Smoke test after a publish (spec Section 2 step 14): every public URL
answers over HTTPS. Requests go to the environment's proxy IP (NPM on the
LAN) with SNI and Host set to the public name, so the check covers NPM, the
certificate (verified against that name) and the app without depending on
the router's hairpin NAT — the reason the stacks map these names to NPM in
extra_hosts too. Redirects are not followed: 200–399 passes, except for the
bare environment name (home), which must answer 302 with a Location on its
portal, so a host that serves the portal directly fails. Details are
our own copy, never httpx's text.

Every check opens its own client, with keep-alive off: all checks share the
origin https://<proxy_ip>, and httpcore reads sni_hostname only when it
opens a connection, so a pooled connection would skip the next host's SNI
and certificate verification.

With insecure (a DigitalOcean environment on Let's Encrypt staging) the
certificate isn't verified."""

import asyncio
import ssl
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

from sirdar_api.deploy import home

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


def _is_tls(error: BaseException) -> bool:
    """A certificate or handshake failure: an ssl error anywhere in the
    chain, or (fallback) its marks in the text. Branch only; never shown."""
    seen: set[int] = set()
    e: BaseException | None = error
    while e is not None and id(e) not in seen:
        if isinstance(e, ssl.SSLError):
            return True
        seen.add(id(e))
        e = e.__cause__ or e.__context__
    text = str(error).upper()
    return "CERTIFICATE_VERIFY_FAILED" in text or "[SSL" in text


async def _check(transport: httpx.AsyncBaseTransport | None, proxy_ip: str, service: str,
                 hostname: str, insecure: bool = False) -> SmokeResult:
    path = PATHS.get(service, "/")
    url = f"https://{hostname}{path}"
    host = f"[{proxy_ip}]" if ":" in proxy_ip else proxy_ip
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport,
                                     follow_redirects=False, verify=not insecure,
                                     limits=httpx.Limits(max_keepalive_connections=0)) as client:
            resp = await client.get(f"https://{host}{path}",
                                    headers={"Host": hostname, "Connection": "close"},
                                    extensions={"sni_hostname": hostname})
    except httpx.TimeoutException:
        return SmokeResult(service, url, False, f"no answer within {TIMEOUT} s")
    except httpx.ConnectError as e:
        tls = _is_tls(e)
        return SmokeResult(service, url, False, "the certificate didn't verify" if tls
                           else "couldn't connect to the proxy")
    except httpx.HTTPError:
        return SmokeResult(service, url, False, "the request failed")
    if service == home.HOME:
        wanted = home.redirect_target(hostname) + "/"
        if resp.status_code == 302 and resp.headers.get("location", "").startswith(wanted):
            return SmokeResult(service, url, True, "HTTP 302 to the portal")
        return SmokeResult(service, url, False,
                           f"HTTP {resp.status_code}, not a redirect to the portal")
    return SmokeResult(service, url, 200 <= resp.status_code < 400, f"HTTP {resp.status_code}")


async def run(targets: list[tuple[str, str]], proxy_ip: str, *,
              transport: httpx.AsyncBaseTransport | None = None,
              sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
              attempts: int = ATTEMPTS, delay: float = DELAY,
              out: Callable[[str], None] | None = None,
              insecure: bool = False) -> list[SmokeResult]:
    """Check each (service, hostname); failures are asked again, up to
    `attempts` rounds `delay` seconds apart (NPM may still be reloading)."""
    results: dict[str, SmokeResult] = {}
    pending = list(targets)
    for attempt in range(1, attempts + 1):
        failed = []
        for service, hostname in pending:
            result = await _check(transport, proxy_ip, service, hostname, insecure)
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
