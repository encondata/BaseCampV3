"""Cloudflare DNS for publishing (spec Section 2 step 12): read the zone's
records, and create, change and delete A records by id. The API token goes
only into the Authorization header; errors carry our own copy, never
Cloudflare's or httpx's text (either may echo request details)."""

from dataclasses import dataclass

import httpx

from sirdar_api.deploy import Check, ConnectFailed, ConnectResult
from sirdar_api.deploy.integrations import CloudflareConfig

BASE_URL = "https://api.cloudflare.com/client/v4"
PER_PAGE = 500
MAX_PAGES = 20
_UNREACHABLE = "Couldn't reach the Cloudflare API."
_DENIED = "Cloudflare rejected the API token, or it has no access to this zone."
_MALFORMED = "The Cloudflare API token is malformed."
_UNEXPECTED = "Cloudflare sent a response Sirdar didn't understand."


class CloudflareError(Exception):
    """`reason` is user-facing copy we wrote."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class RecordGone(CloudflareError):
    def __init__(self):
        super().__init__("The record no longer exists.")


@dataclass(frozen=True)
class DnsRecord:
    id: str
    type: str
    name: str
    content: str
    proxied: bool
    comment: str | None = None


def _record(raw) -> DnsRecord:
    try:
        comment = raw.get("comment")
        return DnsRecord(id=str(raw["id"]), type=str(raw["type"]),
                         name=str(raw["name"]).lower().rstrip("."), content=str(raw["content"]),
                         proxied=bool(raw.get("proxied")),
                         comment=comment if isinstance(comment, str) else None)
    except (KeyError, TypeError, AttributeError):
        raise CloudflareError(_UNEXPECTED) from None


def _refused(body, status: int) -> str:
    errors = body.get("errors") if isinstance(body, dict) else None
    if (isinstance(errors, list) and errors and isinstance(errors[0], dict)
            and isinstance(errors[0].get("code"), int)):
        return f"Cloudflare refused the request (error {errors[0]['code']})."
    return f"Cloudflare answered with HTTP {status}."


class Cloudflare:
    """`async with Cloudflare(cfg, transport=...) as cf:` — one client per step."""

    def __init__(self, cfg: CloudflareConfig, *,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.cfg = cfg
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._zone_id: str | None = None

    async def __aenter__(self) -> "Cloudflare":
        try:
            self._client = httpx.AsyncClient(
                base_url=BASE_URL, headers={"Authorization": f"Bearer {self.cfg.token}"},
                timeout=20, transport=self._transport)
        except (UnicodeError, ValueError, TypeError):
            raise CloudflareError(_MALFORMED) from None
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.aclose()

    async def _call(self, method: str, path: str, *, params: dict | None = None,
                    json: dict | None = None) -> dict:
        try:
            resp = await self._client.request(method, path, params=params, json=json)
        except httpx.HTTPError:
            raise CloudflareError(_UNREACHABLE) from None
        try:
            body = resp.json()
        except ValueError:
            body = None
        if resp.status_code in (401, 403):
            raise CloudflareError(_DENIED)
        if resp.status_code == 404:
            raise RecordGone()
        if not isinstance(body, dict) or resp.status_code >= 400 or body.get("success") is not True:
            raise CloudflareError(_refused(body, resp.status_code))
        return body

    async def zone_id(self) -> str:
        if self._zone_id is None:
            body = await self._call("GET", "/zones", params={"name": self.cfg.zone})
            result = body.get("result")
            found = [z for z in result if isinstance(z, dict) and z.get("name") == self.cfg.zone
                     and z.get("id")] if isinstance(result, list) else []
            if not found:
                raise CloudflareError(f"The API token can't see the zone {self.cfg.zone}.")
            self._zone_id = str(found[0]["id"])
        return self._zone_id

    async def records(self) -> list[DnsRecord]:
        """Every record in the zone, any type."""
        zone = await self.zone_id()
        out: list[DnsRecord] = []
        for page in range(1, MAX_PAGES + 1):
            body = await self._call("GET", f"/zones/{zone}/dns_records",
                                    params={"page": page, "per_page": PER_PAGE})
            result = body.get("result")
            if not isinstance(result, list):
                raise CloudflareError(_UNEXPECTED)
            out += [_record(r) for r in result]
            try:
                pages = int((body.get("result_info") or {}).get("total_pages") or 1)
            except (TypeError, ValueError, AttributeError):
                raise CloudflareError(_UNEXPECTED) from None
            if page >= pages:
                return out
        raise CloudflareError("The zone has more DNS records than Sirdar reads.")

    async def create_a(self, name: str, content: str, *, proxied: bool,
                       comment: str) -> DnsRecord:
        zone = await self.zone_id()
        body = await self._call("POST", f"/zones/{zone}/dns_records", json={
            "type": "A", "name": name, "content": content, "ttl": 1, "proxied": proxied,
            "comment": comment})
        return _record(body.get("result"))

    async def update_a(self, record_id: str, *, name: str, content: str,
                       proxied: bool) -> DnsRecord:
        zone = await self.zone_id()
        body = await self._call("PATCH", f"/zones/{zone}/dns_records/{record_id}", json={
            "type": "A", "name": name, "content": content, "proxied": proxied})
        return _record(body.get("result"))

    async def delete(self, record_id: str) -> bool:
        """False when the record was already gone."""
        zone = await self.zone_id()
        try:
            await self._call("DELETE", f"/zones/{zone}/dns_records/{record_id}")
        except RecordGone:
            return False
        return True


async def test_connection(cfg: CloudflareConfig, *,
                          transport: httpx.AsyncBaseTransport | None = None) -> ConnectResult:
    """Read-only: the zone and its records. Cloudflare doesn't let a token
    read its own permissions, so edit access shows on the first publish."""
    try:
        async with Cloudflare(cfg, transport=transport) as cf:
            zone = await cf.zone_id()
            records = await cf.records()
    except CloudflareError as e:
        raise ConnectFailed(e.reason) from None
    a_records = [r for r in records if r.type == "A"]
    pointing = sum(1 for r in a_records if r.content == cfg.public_ip)
    noun = "A record points" if pointing == 1 else "A records point"
    checks = [
        Check("Zone", "pass", f"{cfg.zone} ({zone})"),
        Check("DNS records", "pass", f"{len(records)} records, {len(a_records)} A"),
        Check("Public IP", "pass" if pointing else "warn",
              f"{cfg.public_ip} · {pointing} {noun} at it"),
    ]
    return ConnectResult(ok=True, target="cloudflare", checks=checks, facts={
        "zone": cfg.zone, "zone_id": zone, "records": len(records),
        "public_ip": cfg.public_ip, "records_at_public_ip": pointing})


test_connection.__test__ = False  # not a pytest test, despite the name
