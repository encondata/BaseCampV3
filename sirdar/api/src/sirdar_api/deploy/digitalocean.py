"""DigitalOcean connection test: read-only calls with the configured API
token. The token goes only into the Authorization header; errors carry
our own copy, never httpx's message (it can echo request details).

The token is a DigitalOcean account's (do_accounts; the Production account,
which the Settings › Integrations card shows, falls back to
SIRDAR_DEPLOY_DO_TOKEN). Callers pass resolve()'s settings, whose
deploy_do_token is that token."""

import logging
import re

import httpx
from pydantic import SecretStr
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings, get_settings
from sirdar_api.deploy import Check, ConnectFailed, ConnectResult
from sirdar_api.deploy.integrations import DigitalOceanConfig

log = logging.getLogger(__name__)

BASE_URL = "https://api.digitalocean.com/v2"
_UNREACHABLE = "Couldn't reach the DigitalOcean API."
_BAD_TOKEN = "DigitalOcean rejected the API token."
_MALFORMED_TOKEN = "The DigitalOcean API token is malformed."
_UNEXPECTED = "DigitalOcean sent a response Sirdar didn't understand."


def with_token(settings: Settings, token: str | None) -> Settings:
    """A copy of settings whose deploy_do_token is `token` (None: no token)."""
    return settings.model_copy(
        update={"deploy_do_token": SecretStr(token) if token is not None else None})


async def resolve(db: AsyncSession, settings: Settings, account: str = "production") -> Settings:
    """settings with the token and region of the given DigitalOcean account
    (do_accounts; the Production account falls back to SIRDAR_DEPLOY_DO_TOKEN
    and _REGION), else no token. A stored Production region beats the env
    fallback; an account without a region gets "". IntegrationError when a
    stored token can't be decrypted."""
    from sirdar_api.deploy import do_accounts
    found = await do_accounts.load(db, settings, account)
    resolved = with_token(settings, found.token if found else None)
    if found is not None:
        region = found.region or ""
    elif account == "production":
        region = settings.deploy_do_region
    else:
        region = ""
    return resolved.model_copy(update={"deploy_do_region": region})


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


_MAX_DROPLET_PAGES = 5


def _items(body: dict, key: str) -> list:
    """body[key] as a list of dicts. DigitalOcean answers null for an account with
    none of a kind; anything else that isn't a list is a response Sirdar can't read
    (logged by key only, never the values)."""
    if key not in body:
        log.warning("DigitalOcean inventory: the %s reply has no %s list", key, key)
        raise ConnectFailed(_UNEXPECTED)
    value = body[key]
    if value is None:
        return []
    if not isinstance(value, list):
        log.warning("DigitalOcean inventory: %s isn't a list (%s)", key, type(value).__name__)
        raise ConnectFailed(_UNEXPECTED)
    return [d for d in value if isinstance(d, dict)]


async def inventory(settings: Settings, *,
                    transport: httpx.AsyncBaseTransport | None = None) -> dict:
    """Raw read-only inventory: {droplets, databases, load_balancers}, each a list
    of DO resource dicts. Droplets follow links.pages.next up to 5 pages. Never
    carries the token; errors are sanitized ConnectFailed."""
    async with _client(settings, transport) as client:
        droplets: list = []
        params: dict = {"per_page": 200}
        for _ in range(_MAX_DROPLET_PAGES):
            body = await _get(client, "/droplets", **params)
            droplets += _items(body, "droplets")
            links = body.get("links")
            pages = links.get("pages") if isinstance(links, dict) else None
            nxt = pages.get("next") if isinstance(pages, dict) else None
            try:
                number = httpx.URL(nxt).params.get("page") if isinstance(nxt, str) else None
            except (TypeError, ValueError):
                number = None
            if not number:
                break
            params = {"per_page": 200, "page": number}
        databases = _items(await _get(client, "/databases"), "databases")
        lbs = _items(await _get(client, "/load_balancers", per_page=200), "load_balancers")
    return {"droplets": droplets, "databases": databases, "load_balancers": lbs}


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


async def test_integration(cfg: DigitalOceanConfig, *,
                           transport: httpx.AsyncBaseTransport | None = None) -> ConnectResult:
    """Settings › Integrations › Test: the connection test with cfg's token
    (saved or not) and SIRDAR_DEPLOY_DO_REGION's region check, if one is set."""
    return await test_connection(with_token(get_settings(), cfg.token), transport=transport)


test_integration.__test__ = False
