"""DigitalOcean Spaces buckets through the S3 API (deploy phase 7): the API
v2 can't make buckets. Virtual-hosted addressing
(<bucket>.<region>.digitaloceanspaces.com), SigV4 with the region slug as
the signing region. Errors are SpacesError with our own copy; an S3 error
<Code> may be named. The transport comes from outbound.transports()."""

import base64
import hashlib
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

import httpx

from sirdar_api.deploy import outbound, s3sig

TIMEOUT = 60
MAX_PAGES = 10_000
_CODE_RE = re.compile(r"<Code>([A-Za-z]{1,60})</Code>")
_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


class SpacesError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class SpacesKey:
    access_key: str
    secret_key: str = field(repr=False)


def endpoint(region: str) -> str:
    return f"https://{region}.digitaloceanspaces.com"


def _host(bucket: str, region: str) -> str:
    return f"{bucket}.{region}.digitaloceanspaces.com"


def _code(resp: httpx.Response) -> str | None:
    found = _CODE_RE.search(resp.text or "")
    return found.group(1) if found else None


async def _send(method: str, bucket: str, region: str, key: SpacesKey, *,
                query: dict[str, str] | None = None, body: bytes = b"",
                headers: dict[str, str] | None = None, transport=None,
                now: datetime | None = None) -> httpx.Response:
    if transport is None:
        transport = outbound.transports().get("spaces")
    host = _host(bucket, region)
    query = query or {}
    signed = s3sig.sign(method=method, host=host, path="/", query=query,
                        headers=headers or {}, payload_sha256=hashlib.sha256(body).hexdigest(),
                        access_key=key.access_key, secret_key=key.secret_key, region=region,
                        now=now or datetime.now(UTC))
    url = f"https://{host}/"
    if query:
        url += "?" + s3sig.canonical_query(query)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport) as client:
            resp = await client.request(method, url, content=body, headers=signed)
    except httpx.HTTPError:
        raise SpacesError("Couldn't reach DigitalOcean Spaces.") from None
    if resp.status_code == 403:
        raise SpacesError(f"Spaces refused the key ({_code(resp) or 'HTTP 403'}).")
    return resp


def _refused(resp: httpx.Response) -> SpacesError:
    code = _code(resp)
    return SpacesError(f"Spaces refused the request ({code or f'HTTP {resp.status_code}'}).")


async def create_bucket(bucket: str, region: str, key: SpacesKey, *, transport=None,
                        now: datetime | None = None) -> bool:
    resp = await _send("PUT", bucket, region, key, transport=transport, now=now)
    if resp.status_code == 200:
        return True
    if resp.status_code == 409 and _code(resp) == "BucketAlreadyOwnedByYou":
        return False
    if resp.status_code == 409:
        raise SpacesError(f"Another Spaces account already has the bucket {bucket}.")
    raise _refused(resp)


async def bucket_exists(bucket: str, region: str, key: SpacesKey, *, transport=None,
                        now: datetime | None = None) -> bool:
    resp = await _send("HEAD", bucket, region, key, transport=transport, now=now)
    if resp.status_code == 200:
        return True
    if resp.status_code == 404:
        return False
    raise _refused(resp)


async def empty_bucket(bucket: str, region: str, key: SpacesKey, *, transport=None,
                       now: datetime | None = None) -> int:
    """Delete every object, a page (up to 1,000) at a time."""
    deleted = 0
    for _ in range(MAX_PAGES):
        resp = await _send("GET", bucket, region, key, query={"list-type": "2"},
                           transport=transport, now=now)
        if resp.status_code == 404:
            return deleted
        if resp.status_code != 200:
            raise _refused(resp)
        try:
            root = ET.fromstring(resp.content)
        except ET.ParseError:
            raise SpacesError("Spaces sent a listing Sirdar didn't understand.") from None
        keys = [k.text or "" for k in root.iter(f"{_NS}Key")] or \
               [k.text or "" for k in root.iter("Key")]
        if not keys:
            return deleted
        doc = ("<Delete><Quiet>true</Quiet>"
               + "".join(f"<Object><Key>{escape(k)}</Key></Object>" for k in keys)
               + "</Delete>").encode()
        md5 = base64.b64encode(hashlib.md5(doc).digest()).decode()
        resp = await _send("POST", bucket, region, key, query={"delete": ""}, body=doc,
                           headers={"Content-MD5": md5, "Content-Type": "application/xml"},
                           transport=transport, now=now)
        if resp.status_code != 200:
            raise _refused(resp)
        deleted += len(keys)
    raise SpacesError("The bucket has more objects than Sirdar deletes in one step.")


async def delete_bucket(bucket: str, region: str, key: SpacesKey, *, transport=None,
                        now: datetime | None = None) -> bool:
    resp = await _send("DELETE", bucket, region, key, transport=transport, now=now)
    if resp.status_code in (200, 204):
        return True
    if resp.status_code == 404:
        return False
    raise _refused(resp)
