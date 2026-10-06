"""DigitalOcean Spaces buckets through the S3 API (deploy phase 7): the API
v2 can't make buckets. Virtual-hosted addressing
(<bucket>.<region>.digitaloceanspaces.com), SigV4 with the region slug as
the signing region. Errors are SpacesError with our own copy; an S3 error
<Code> may be named. The transport comes from outbound.transports().

Known limitation: versioned buckets. Sirdar never turns versioning on, so
empty_bucket deletes current objects and aborts incomplete multipart
uploads, but doesn't remove old versions or delete markers; a bucket someone
versioned by hand will refuse delete_bucket with BucketNotEmpty.

Responses are parsed with the stdlib ElementTree (it never fetches external
entities); a body carrying a DOCTYPE is refused before parsing."""

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
_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
_REGION_RE = re.compile(r"^[a-z0-9-]+$")


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


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _elements(root: ET.Element, name: str) -> list[ET.Element]:
    """Direct children named `name`, with or without the S3 namespace."""
    return [el for el in root if _local(el.tag) == name]


def _child_text(el: ET.Element, name: str) -> str:
    found = _elements(el, name)
    return (found[0].text or "") if found else ""


def _parse(resp: httpx.Response, what: str) -> ET.Element:
    if b"<!DOCTYPE" in resp.content.upper():
        raise SpacesError(f"Spaces sent {what} Sirdar didn't understand.")
    try:
        return ET.fromstring(resp.content)
    except ET.ParseError:
        raise SpacesError(f"Spaces sent {what} Sirdar didn't understand.") from None


async def _send(method: str, bucket: str, region: str, key: SpacesKey, *, path: str = "/",
                query: dict[str, str] | None = None, body: bytes = b"",
                headers: dict[str, str] | None = None, transport=None,
                now: datetime | None = None, raise_on_403: bool = True) -> httpx.Response:
    if not isinstance(bucket, str) or not _BUCKET_RE.fullmatch(bucket):
        raise SpacesError("That isn't a valid Spaces bucket name.")
    if not isinstance(region, str) or not _REGION_RE.fullmatch(region):
        raise SpacesError("That isn't a valid Spaces region.")
    if transport is None:
        transport = outbound.transports().get("spaces")
    host = _host(bucket, region)
    query = query or {}
    signed = s3sig.sign(method=method, host=host, path=path, query=query,
                        headers=headers or {}, payload_sha256=hashlib.sha256(body).hexdigest(),
                        access_key=key.access_key, secret_key=key.secret_key, region=region,
                        now=now or datetime.now(UTC))
    url = f"https://{host}{s3sig.canonical_path(path)}"
    if query:
        url += "?" + s3sig.canonical_query(query)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport) as client:
            resp = await client.request(method, url, content=body, headers=signed)
    except httpx.HTTPError:
        raise SpacesError("Couldn't reach DigitalOcean Spaces.") from None
    if resp.status_code == 403 and raise_on_403:
        raise SpacesError(f"Spaces refused the key ({_code(resp) or 'HTTP 403'}).")
    return resp


def _refused(resp: httpx.Response) -> SpacesError:
    code = _code(resp)
    return SpacesError(f"Spaces refused the request ({code or f'HTTP {resp.status_code}'}).")


async def create_bucket(bucket: str, region: str, key: SpacesKey, *, transport=None,
                        now: datetime | None = None) -> bool:
    """True: made now. False: it was already ours. Spaces may answer a re-create
    of our own bucket with BucketAlreadyExists rather than
    BucketAlreadyOwnedByYou, so that answer is checked with a HEAD under the
    same key: 200 means ours, 403 or 404 means another account has the name."""
    resp = await _send("PUT", bucket, region, key, transport=transport, now=now)
    if resp.status_code == 200:
        return True
    if resp.status_code == 409 and _code(resp) == "BucketAlreadyOwnedByYou":
        return False
    if resp.status_code == 409:
        probe = await _send("HEAD", bucket, region, key, transport=transport, now=now,
                            raise_on_403=False)
        if probe.status_code == 200:
            return False
        if probe.status_code in (403, 404):
            raise SpacesError(f"Another Spaces account already has the bucket {bucket}.")
        raise _refused(probe)
    raise _refused(resp)


async def bucket_exists(bucket: str, region: str, key: SpacesKey, *, transport=None,
                        now: datetime | None = None) -> bool:
    resp = await _send("HEAD", bucket, region, key, transport=transport, now=now)
    if resp.status_code == 200:
        return True
    if resp.status_code == 404:
        return False
    raise _refused(resp)


async def _delete_objects(bucket: str, region: str, key: SpacesKey, *, transport,
                          now: datetime | None) -> int | None:
    """Delete up to one listing page of objects. None: the bucket is gone.
    Counts only the keys Spaces reports as <Deleted>; any per-key <Error> raises."""
    deleted = 0
    for _ in range(MAX_PAGES):
        resp = await _send("GET", bucket, region, key, query={"list-type": "2"},
                           transport=transport, now=now)
        if resp.status_code == 404:
            return None if deleted == 0 else deleted
        if resp.status_code != 200:
            raise _refused(resp)
        root = _parse(resp, "a listing")
        keys = [_child_text(c, "Key") for c in _elements(root, "Contents")]
        if not keys:
            return deleted
        doc = ("<Delete><Quiet>false</Quiet>"
               + "".join(f"<Object><Key>{escape(k)}</Key></Object>" for k in keys)
               + "</Delete>").encode()
        md5 = base64.b64encode(hashlib.md5(doc).digest()).decode()
        resp = await _send("POST", bucket, region, key, query={"delete": ""}, body=doc,
                           headers={"Content-MD5": md5, "Content-Type": "application/xml"},
                           transport=transport, now=now)
        if resp.status_code != 200:
            raise _refused(resp)
        result = _parse(resp, "a delete result")
        errors = _elements(result, "Error")
        if errors:
            code = next((c for c in (_child_text(e, "Code") for e in errors)
                         if re.fullmatch(r"[A-Za-z]{1,60}", c)), None)
            noun = "object" if len(errors) == 1 else "objects"
            raise SpacesError(f"Spaces couldn't delete {len(errors)} {noun} in the bucket"
                              f" ({code or 'no reason given'}).")
        done = len(_elements(result, "Deleted"))
        if done == 0:
            raise SpacesError("Spaces deleted nothing from the bucket, so Sirdar stopped.")
        deleted += done
    raise SpacesError("The bucket has more objects than Sirdar deletes in one step.")


async def _abort_uploads(bucket: str, region: str, key: SpacesKey, *, transport,
                         now: datetime | None) -> None:
    for _ in range(MAX_PAGES):
        resp = await _send("GET", bucket, region, key, query={"uploads": ""},
                           transport=transport, now=now)
        if resp.status_code == 404:
            return
        if resp.status_code != 200:
            raise _refused(resp)
        uploads = [(_child_text(u, "Key"), _child_text(u, "UploadId"))
                   for u in _elements(_parse(resp, "an upload listing"), "Upload")]
        if not uploads:
            return
        for name, upload_id in uploads:
            if not name or not upload_id:
                raise SpacesError("Spaces sent an upload listing Sirdar didn't understand.")
            resp = await _send("DELETE", bucket, region, key, path="/" + name,
                               query={"uploadId": upload_id}, transport=transport, now=now)
            if resp.status_code not in (200, 204, 404):
                raise _refused(resp)
    raise SpacesError("The bucket has more uploads than Sirdar aborts in one step.")


async def empty_bucket(bucket: str, region: str, key: SpacesKey, *, transport=None,
                       now: datetime | None = None) -> int:
    """Delete every object, a page (up to 1,000) at a time, re-listing from the
    start after each delete, then abort every incomplete multipart upload.
    Returns the objects deleted (0 when the bucket doesn't exist). Old
    versions aren't touched: see the module docstring."""
    deleted = await _delete_objects(bucket, region, key, transport=transport, now=now)
    if deleted is None:
        return 0
    await _abort_uploads(bucket, region, key, transport=transport, now=now)
    return deleted


async def delete_bucket(bucket: str, region: str, key: SpacesKey, *, transport=None,
                        now: datetime | None = None) -> bool:
    resp = await _send("DELETE", bucket, region, key, transport=transport, now=now)
    if resp.status_code in (200, 204):
        return True
    if resp.status_code == 404:
        return False
    raise _refused(resp)
