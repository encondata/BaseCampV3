"""The DigitalOcean API v2 calls Sirdar builds environments with (deploy
phase 7): VPCs, droplets, managed databases (firewall, CA), Spaces keys,
certificates, load balancers and cloud firewalls.

One seam: `async with connect(token) as api:`. The token goes only into the
Authorization header. Errors are DoError with our own copy: DigitalOcean's
`message` (which may echo request details) is never kept; its error `id`
(like `unprocessable_entity`) may be named. A 404 on a single resource reads
as "gone" (None, or False from a delete). A 429 waits (Retry-After, else
RateLimit-Reset, at most 30 s) and is retried once; a GET is retried once on
502/503/504 (a write never is: it may have landed). IDs that go into a URL
path must be letters, digits and dashes. The transport comes from
outbound.transports(), so tests answer with FakeDigitalOcean."""

import asyncio
import base64
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import httpx

from sirdar_api.deploy import outbound

BASE_URL = "https://api.digitalocean.com/v2"
TIMEOUT = 30
PER_PAGE = 200
MAX_PAGES = 10
RETRY_AFTER_DEFAULT = 5.0
RETRY_AFTER_CAP = 30.0
GATEWAY_RETRY_DELAY = 2.0
GATEWAY_STATUSES = (502, 503, 504)
_ID_RE = re.compile(r"[a-z_]{1,40}")
_PATH_ID_RE = re.compile(r"[A-Za-z0-9-]{1,128}")
_UNREACHABLE = "Couldn't reach the DigitalOcean API."
_BAD_TOKEN = "DigitalOcean rejected the API token."
_MALFORMED = "The DigitalOcean API token is malformed."
_FORBIDDEN = "The DigitalOcean token isn't allowed to do that."
_NOT_FOUND = "DigitalOcean couldn't find that resource."
_UNEXPECTED = "DigitalOcean sent a response Sirdar didn't understand."
_RATE_LIMITED = "DigitalOcean is rate-limiting Sirdar; try again in a few minutes."
_BAD_ID = "Sirdar refused to send a malformed DigitalOcean ID."
_now = time.time


class DoError(Exception):
    """`reason` is user-facing copy we wrote; `status` the HTTP status, if any."""

    def __init__(self, reason: str, *, status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


class DoNotFound(DoError):
    pass


class DoForbidden(DoError):
    pass


def _refused(status: int, body) -> str:
    code = body.get("id") if isinstance(body, dict) else None
    if isinstance(code, str) and _ID_RE.fullmatch(code):
        return f"DigitalOcean refused the request ({code}, HTTP {status})."
    return f"DigitalOcean answered with HTTP {status}."


def _seconds(value: str | None) -> float | None:
    try:
        seconds = float(value) if value is not None else None
    except ValueError:
        return None
    if seconds is None or seconds != seconds or seconds in (float("inf"), float("-inf")):
        return None
    return seconds


def _retry_after(resp: httpx.Response) -> float:
    """How long to wait after a 429: Retry-After (seconds), else RateLimit-Reset
    (epoch seconds) minus now, capped at RETRY_AFTER_CAP."""
    seconds = _seconds(resp.headers.get("retry-after"))
    if seconds is None:
        reset = _seconds(resp.headers.get("ratelimit-reset"))
        if reset is None:
            return RETRY_AFTER_DEFAULT
        return min(max(reset - _now(), 0.0), RETRY_AFTER_CAP)
    if seconds < 0:
        return RETRY_AFTER_DEFAULT
    return min(seconds, RETRY_AFTER_CAP)


def _id(value) -> str:
    """An ID that goes into a URL path: digits, letters and dashes only."""
    text = str(value) if isinstance(value, (str, int)) and not isinstance(value, bool) else ""
    if not _PATH_ID_RE.fullmatch(text):
        raise DoError(_BAD_ID)
    return text


def droplet_ips(droplet: dict) -> tuple[str | None, str | None]:
    """(public, private) IPv4 of a droplet; None until DigitalOcean assigns them."""
    v4 = ((droplet.get("networks") or {}).get("v4") or []) if isinstance(droplet, dict) else []
    found = {n.get("type"): n.get("ip_address") for n in v4 if isinstance(n, dict)}
    return found.get("public"), found.get("private")


class DigitalOceanApi:
    def __init__(self, client: httpx.AsyncClient, sleep: Callable[[float], Awaitable[None]]):
        self._client = client
        self._sleep = sleep

    async def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            return await self._client.request(method, path, **kwargs)
        except httpx.HTTPError:
            raise DoError(_UNREACHABLE) from None

    async def call(self, method: str, path: str, *, params: dict | None = None,
                   json: dict | None = None) -> dict:
        kwargs: dict = {}
        if params:
            kwargs["params"] = params
        if json is not None:
            kwargs["json"] = json
        resp = await self._request(method, path, **kwargs)
        if resp.status_code == 429:
            await self._sleep(_retry_after(resp))
            resp = await self._request(method, path, **kwargs)
        elif method == "GET" and resp.status_code in GATEWAY_STATUSES:
            await self._sleep(GATEWAY_RETRY_DELAY)      # reads only: a write may have landed
            resp = await self._request(method, path, **kwargs)
        if resp.status_code == 429:
            raise DoError(_RATE_LIMITED, status=429)
        if resp.status_code == 401:
            raise DoError(_BAD_TOKEN, status=401)
        if resp.status_code in (202, 204) and not resp.content:
            return {}
        try:
            body = resp.json()
        except ValueError:
            body = None
        if resp.status_code == 403:
            raise DoForbidden(_FORBIDDEN, status=403)
        if resp.status_code == 404:
            raise DoNotFound(_NOT_FOUND, status=404)
        if resp.status_code >= 400:
            raise DoError(_refused(resp.status_code, body), status=resp.status_code)
        if not isinstance(body, dict):
            raise DoError(_UNEXPECTED)
        return body

    @staticmethod
    def _field(body: dict, key: str) -> dict:
        value = body.get(key)
        if not isinstance(value, dict):
            raise DoError(_UNEXPECTED)
        return value

    async def _one(self, path: str, key: str) -> dict | None:
        try:
            return self._field(await self.call("GET", path), key)
        except DoNotFound:
            return None

    async def _delete(self, path: str) -> bool:
        try:
            await self.call("DELETE", path)
        except DoNotFound:
            return False
        return True

    async def _list(self, path: str, key: str, **params) -> list[dict]:
        out: list[dict] = []
        query = {"per_page": PER_PAGE, **params}
        for _ in range(MAX_PAGES):
            body = await self.call("GET", path, params=query)
            page = body.get(key)
            if not isinstance(page, list):
                raise DoError(_UNEXPECTED)
            out += [r for r in page if isinstance(r, dict)]
            nxt = ((body.get("links") or {}).get("pages") or {}).get("next")
            number = httpx.URL(nxt).params.get("page") if isinstance(nxt, str) else None
            if not number:
                return out
            query = {**query, "page": number}
        raise DoError("DigitalOcean listed more than Sirdar reads.")

    # account and catalogs

    async def account(self) -> dict:
        return self._field(await self.call("GET", "/account"), "account")

    async def sizes(self) -> list[dict]:
        return await self._list("/sizes", "sizes")

    async def database_options(self) -> dict:
        return self._field(await self.call("GET", "/databases/options"), "options")

    # VPCs

    async def vpc(self, vpc_id: str) -> dict | None:
        return await self._one(f"/vpcs/{_id(vpc_id)}", "vpc")

    async def create_vpc(self, name: str, region: str, description: str) -> dict:
        body = await self.call("POST", "/vpcs", json={"name": name, "region": region,
                                                      "description": description})
        return self._field(body, "vpc")

    async def delete_vpc(self, vpc_id: str) -> bool:
        return await self._delete(f"/vpcs/{_id(vpc_id)}")

    async def vpc_member_count(self, vpc_id: str) -> int:
        body = await self.call("GET", f"/vpcs/{_id(vpc_id)}/members", params={"per_page": 1})
        try:
            return int((body.get("meta") or {})["total"])
        except (KeyError, TypeError, ValueError):
            raise DoError(_UNEXPECTED) from None

    # droplets

    async def droplet(self, droplet_id: str) -> dict | None:
        return await self._one(f"/droplets/{_id(droplet_id)}", "droplet")

    async def droplets_tagged(self, tag: str) -> list[dict]:
        return await self._list("/droplets", "droplets", tag_name=tag)

    async def create_droplet(self, body: dict) -> dict:
        return self._field(await self.call("POST", "/droplets", json=body), "droplet")

    async def delete_droplet(self, droplet_id: str) -> bool:
        return await self._delete(f"/droplets/{_id(droplet_id)}")

    async def droplet_action(self, droplet_id: str, type_: str, **extra) -> dict:
        body = await self.call("POST", f"/droplets/{_id(droplet_id)}/actions",
                               json={"type": type_, **extra})
        return self._field(body, "action")

    # managed databases

    async def database(self, database_id: str) -> dict | None:
        return await self._one(f"/databases/{_id(database_id)}", "database")

    async def databases_tagged(self, tag: str) -> list[dict]:
        body = await self.call("GET", "/databases", params={"tag_name": tag})
        rows = body.get("databases")
        if rows is None:                    # DigitalOcean answers null for "none"
            return []
        if not isinstance(rows, list):
            raise DoError(_UNEXPECTED)
        return [r for r in rows if isinstance(r, dict)]

    async def create_database(self, body: dict) -> dict:
        return self._field(await self.call("POST", "/databases", json=body), "database")

    async def set_database_firewall(self, database_id: str, droplet_ids: list[str]) -> None:
        await self.call("PUT", f"/databases/{_id(database_id)}/firewall", json={
            "rules": [{"type": "droplet", "value": str(d)} for d in droplet_ids]})

    async def database_firewall(self, database_id: str) -> list[dict]:
        rules = (await self.call("GET", f"/databases/{_id(database_id)}/firewall")).get("rules")
        if not isinstance(rules, list):
            raise DoError(_UNEXPECTED)
        return [{"type": r.get("type"), "value": r.get("value")} for r in rules
                if isinstance(r, dict)]

    async def database_ca(self, database_id: str) -> str:
        ca = self._field(await self.call("GET", f"/databases/{_id(database_id)}/ca"), "ca")
        try:
            return base64.b64decode(ca["certificate"]).decode()
        except (KeyError, ValueError, TypeError):
            raise DoError(_UNEXPECTED) from None

    async def delete_database(self, database_id: str) -> bool:
        return await self._delete(f"/databases/{_id(database_id)}")

    async def resize_database(self, database_id: str, size: str, num_nodes: int) -> None:
        await self.call("PUT", f"/databases/{_id(database_id)}/resize",
                        json={"size": size, "num_nodes": num_nodes})

    # Spaces keys

    async def spaces_keys(self) -> list[dict]:
        return await self._list("/spaces/keys", "keys")

    async def create_spaces_key(self, name: str, grants: list[dict]) -> dict:
        body = await self.call("POST", "/spaces/keys", json={"name": name, "grants": grants})
        return self._field(body, "key")

    async def delete_spaces_key(self, access_key: str) -> bool:
        return await self._delete(f"/spaces/keys/{_id(access_key)}")

    # certificates

    async def certificate(self, certificate_id: str) -> dict | None:
        return await self._one(f"/certificates/{_id(certificate_id)}", "certificate")

    async def create_certificate(self, name: str, private_key: str, leaf: str,
                                 chain: str) -> dict:
        body = await self.call("POST", "/certificates", json={
            "name": name, "type": "custom", "private_key": private_key,
            "leaf_certificate": leaf, "certificate_chain": chain})
        return self._field(body, "certificate")

    async def delete_certificate(self, certificate_id: str) -> bool:
        return await self._delete(f"/certificates/{_id(certificate_id)}")

    # load balancers

    async def load_balancer(self, lb_id: str) -> dict | None:
        return await self._one(f"/load_balancers/{_id(lb_id)}", "load_balancer")

    async def create_load_balancer(self, body: dict) -> dict:
        return self._field(await self.call("POST", "/load_balancers", json=body), "load_balancer")

    async def update_load_balancer(self, lb_id: str, body: dict) -> dict:
        return self._field(await self.call("PUT", f"/load_balancers/{_id(lb_id)}", json=body),
                           "load_balancer")

    async def delete_load_balancer(self, lb_id: str) -> bool:
        return await self._delete(f"/load_balancers/{_id(lb_id)}")

    # cloud firewalls

    async def firewall(self, firewall_id: str) -> dict | None:
        return await self._one(f"/firewalls/{_id(firewall_id)}", "firewall")

    async def create_firewall(self, body: dict) -> dict:
        return self._field(await self.call("POST", "/firewalls", json=body), "firewall")

    async def delete_firewall(self, firewall_id: str) -> bool:
        return await self._delete(f"/firewalls/{_id(firewall_id)}")


@asynccontextmanager
async def connect(token: str, *, transport: httpx.AsyncBaseTransport | None = None,
                  sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
                  ) -> AsyncIterator[DigitalOceanApi]:
    if transport is None:
        transport = outbound.transports().get("digitalocean")
    try:
        client = httpx.AsyncClient(base_url=BASE_URL, timeout=TIMEOUT, transport=transport,
                                   headers={"Authorization": f"Bearer {token}"})
    except (UnicodeError, ValueError, TypeError):
        raise DoError(_MALFORMED) from None
    async with client:
        yield DigitalOceanApi(client, sleep)
