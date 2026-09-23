"""One HTTP probe per service. A probe never raises: every outcome is a
ProbeResult, and anything short of the expected response is a failure."""

import time
from dataclasses import dataclass

import httpx

from serversherpa_status.config import Service

# The API probe reads the database (/system/status), so a dead DB reads red;
# /healthz would only prove the process is alive. The kiosk's config.js is
# written by its entrypoint, so a 200 proves Caddy AND the runtime config.
PROBE_PATHS = {"api": "/system/status", "portal": "/", "kiosk": "/config.js"}

DETAIL_MAX = 200


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    latency_ms: int | None
    detail: str


def _body_problem(key: str, resp: httpx.Response) -> bool:
    if key == "api":
        try:
            return not isinstance(resp.json(), dict)
        except ValueError:
            return True
    if key == "portal":
        return 'id="root"' not in resp.text
    return False


async def probe(client: httpx.AsyncClient, service: Service, timeout: float) -> ProbeResult:
    url = service.url + PROBE_PATHS[service.key]
    started = time.monotonic()
    try:
        resp = await client.get(url, timeout=timeout, follow_redirects=True)
    except httpx.TimeoutException:
        return ProbeResult(False, None, "timeout")
    except httpx.HTTPError as exc:
        return ProbeResult(False, None, f"connection error: {type(exc).__name__}"[:DETAIL_MAX])
    latency = int(round((time.monotonic() - started) * 1000))
    if resp.status_code != 200:
        return ProbeResult(False, latency, f"HTTP {resp.status_code}")
    if _body_problem(service.key, resp):
        return ProbeResult(False, latency, "unexpected response body")
    return ProbeResult(True, latency, "")
