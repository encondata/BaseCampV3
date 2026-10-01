"""DigitalOcean connection test: read-only calls with the configured API
token. The token goes only into the Authorization header; errors carry
our own copy, never httpx's message (it can echo request details)."""

import re

import httpx

from sirdar_api.config import Settings
from sirdar_api.deploy import Check, ConnectFailed, ConnectResult

BASE_URL = "https://api.digitalocean.com/v2"
_UNREACHABLE = "Couldn't reach the DigitalOcean API."
_BAD_TOKEN = "DigitalOcean rejected the API token."
_MALFORMED_TOKEN = "The DigitalOcean API token is malformed."
_UNEXPECTED = "DigitalOcean sent a response Sirdar didn't understand."


async def _get(client: httpx.AsyncClient, path: str, **params) -> dict:
    try:
        resp = await client.get(path, params=params or None)
    except httpx.HTTPError:
        raise ConnectFailed(_UNREACHABLE) from None
    if resp.status_code == 401:
        raise ConnectFailed(_BAD_TOKEN)
    if resp.status_code != 200:
        raise ConnectFailed(f"DigitalOcean answered with HTTP {resp.status_code}.")
    try:
        body = resp.json()
    except ValueError:
        raise ConnectFailed(_UNEXPECTED) from None
    if not isinstance(body, dict):
        raise ConnectFailed(_UNEXPECTED)
    return body


def _client(settings: Settings, transport: httpx.AsyncBaseTransport | None) -> httpx.AsyncClient:
    if settings.deploy_do_token is None:
        raise ConnectFailed("No DigitalOcean API token is configured.")
    token = settings.deploy_do_token.get_secret_value()
    try:
        return httpx.AsyncClient(base_url=BASE_URL, headers={"Authorization": f"Bearer {token}"},
                                 timeout=15, transport=transport)
    except (UnicodeError, ValueError, TypeError):      # e.g. a non-ASCII token
        raise ConnectFailed(_MALFORMED_TOKEN) from None


def _natural(text: str) -> list:
    return [(0, int(p), "") if p.isdigit() else (1, 0, p.casefold())
            for p in re.split(r"(\d+)", text) if p]


async def list_regions(settings: Settings, *,
                       transport: httpx.AsyncBaseTransport | None = None) -> dict:
    """Available regions as {regions: [{slug, name}], default}. The default is the
    env region when it is in the list. Never carries the token."""
    async with _client(settings, transport) as client:
        try:
            raw = (await _get(client, "/regions", per_page=200))["regions"]
            if not isinstance(raw, list):
                raise TypeError
            regions = [{"slug": str(r["slug"]), "name": str(r.get("name") or r["slug"])}
                       for r in raw if isinstance(r, dict) and r.get("available") is True]
        except (KeyError, TypeError, ValueError):
            raise ConnectFailed(_UNEXPECTED) from None
    regions.sort(key=lambda r: (_natural(r["name"]), r["slug"]))
    wanted = settings.deploy_do_region.strip()
    default = wanted if any(r["slug"] == wanted for r in regions) else None
    return {"regions": regions, "default": default}


async def test_connection(settings: Settings, *, region: str | None = None,
                          transport: httpx.AsyncBaseTransport | None = None) -> ConnectResult:
    """region: the caller's choice; None falls back to the env default (blank = no check)."""
    region = (region if region is not None else settings.deploy_do_region).strip()
    async with _client(settings, transport) as client:
        try:
            account = (await _get(client, "/account"))["account"]
            email, status = str(account["email"]), str(account["status"])
            limit = int(account["droplet_limit"])
            count = int((await _get(client, "/droplets", per_page=1))["meta"]["total"])
            regions = None
            if region:
                regions = (await _get(client, "/regions", per_page=200))["regions"]
                if not isinstance(regions, list):
                    raise TypeError
        except (KeyError, TypeError, ValueError):
            raise ConnectFailed(_UNEXPECTED) from None

    checks = [
        Check("Account", "pass" if status == "active" else "warn", f"{email} · {status}"),
        Check("Droplets", "pass" if count < limit else "warn", f"{count} of {limit}"),
    ]
    facts: dict = {"email": email, "status": status, "droplet_limit": limit,
                   "droplet_count": count}
    if regions is not None:
        match = next((r for r in regions if isinstance(r, dict) and r.get("slug") == region), None)
        available = bool(match and match.get("available"))
        value = (f"{region} available" if available
                 else f"{region} not found" if match is None else f"{region} not available")
        checks.append(Check("Region", "pass" if available else "warn", value))
        facts |= {"region": region, "region_available": available}
    return ConnectResult(ok=True, target="digitalocean", checks=checks, facts=facts)


test_connection.__test__ = False  # not a pytest test, despite the name
