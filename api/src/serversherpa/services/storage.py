"""Object storage via the AWS SDK (boto3) with an endpoint override —
the same code drives MinIO in development and DigitalOcean Spaces in
production; only SS_SPACES_* settings differ.

The bucket is PRIVATE. Reads happen through short-lived presigned GET
URLs generated here (pure in-process signing — no network round-trip).
"""

import asyncio
from functools import lru_cache, partial
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from serversherpa.config import get_settings
from serversherpa.services.filenames import ascii_header_filename


@lru_cache
def _client():
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.spaces_endpoint,
        region_name=s.spaces_region,
        aws_access_key_id=s.spaces_access_key.get_secret_value(),
        aws_secret_access_key=s.spaces_secret_key.get_secret_value(),
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if s.spaces_use_path_style else "virtual"},
        ),
    )


def content_disposition(filename: str, *, inline: bool = False) -> str:
    """A header-safe Content-Disposition for `filename`: a plain-ASCII
    `filename="…"` (the storage-safe name — no quotes, CR/LF, or other
    characters that could break out of the header) plus the full
    original name, percent-encoded, as RFC 5987 `filename*=UTF-8''…`,
    which every current browser prefers."""
    disposition = "inline" if inline else "attachment"
    return (f'{disposition}; filename="{ascii_header_filename(filename)}"; '
            f"filename*=UTF-8''{quote(filename, safe='')}")


def presign_get(key: str | None, *, download_filename: str | None = None,
                inline: bool = False, content_type: str | None = None) -> str | None:
    """Short-lived read URL for a private object (None passes through so
    callers can presign optional keys like avatar_key directly).

    `download_filename`, when given, sets Content-Disposition on the
    response so a browser saves/shows the file under that name instead of
    the (often opaque, uuid-bearing) storage key — `attachment` unless
    `inline` is set, which asks the browser to render the response (an
    image, PDF, etc.) in place instead of downloading it. See
    `content_disposition` for how the name is encoded.

    `content_type`, when given, overrides the response's Content-Type
    (`ResponseContentType`) — used to force `text/plain` on an inline
    text preview so the bucket's origin can never serve stored text back
    as HTML or SVG that could run script."""
    if not key:
        return None
    s = get_settings()
    params: dict = {"Bucket": s.spaces_bucket, "Key": key}
    if download_filename:
        params["ResponseContentDisposition"] = content_disposition(
            download_filename, inline=inline)
    if content_type:
        params["ResponseContentType"] = content_type
    return _client().generate_presigned_url(
        "get_object", Params=params, ExpiresIn=s.spaces_presign_ttl_seconds,
    )


def presign_put(key: str, content_type: str, size: int, expires: int = 3600) -> str:
    """A short-lived PUT URL for a browser to upload straight to storage.
    The signature covers both `Content-Type` and `Content-Length`, so the
    browser must send exactly `content_type` and exactly `size` bytes —
    anything else makes storage reject the PUT."""
    s = get_settings()
    return _client().generate_presigned_url(
        "put_object",
        Params={"Bucket": s.spaces_bucket, "Key": key, "ContentType": content_type,
                "ContentLength": size},
        ExpiresIn=expires,
    )


async def head_object(key: str) -> dict | None:
    """The object's size and content type, or None when no object exists
    at `key` (used to confirm a presigned upload actually landed)."""
    s = get_settings()
    try:
        resp = await asyncio.to_thread(partial(
            _client().head_object, Bucket=s.spaces_bucket, Key=key))
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code in ("404", "NoSuchKey", "NotFound"):
            return None
        raise
    return {"size": resp["ContentLength"], "content_type": resp.get("ContentType", "")}


async def put_object(key: str, data: bytes, content_type: str) -> None:
    """Blocking boto3 call moved off the event loop."""
    s = get_settings()
    await asyncio.to_thread(partial(
        _client().put_object,
        Bucket=s.spaces_bucket,
        Key=key,
        Body=data,
        ContentType=content_type,
    ))


async def get_object(key: str) -> bytes:
    """Read a private object's bytes (blocking boto3 moved off the loop).
    Used by the import worker to fetch uploaded files."""
    s = get_settings()
    resp = await asyncio.to_thread(partial(
        _client().get_object,
        Bucket=s.spaces_bucket,
        Key=key,
    ))
    return await asyncio.to_thread(resp["Body"].read)


async def delete_object(key: str) -> None:
    """Delete a private object. S3-compatible DELETE is idempotent (no error
    for a key that's already gone), so callers never need to check
    existence first — a delete of a key that was never written, or was
    already removed, succeeds exactly like one that removes something."""
    s = get_settings()
    await asyncio.to_thread(partial(
        _client().delete_object,
        Bucket=s.spaces_bucket,
        Key=key,
    ))


async def download_to(key: str, path) -> None:
    """Stream a private object to a local file (boto3's managed transfer:
    chunked, never the whole object in memory) — for the wiki worker,
    whose uploads can run to the 1 GB upload cap."""
    s = get_settings()
    await asyncio.to_thread(partial(
        _client().download_file, s.spaces_bucket, key, str(path)))


async def upload_from(path, key: str, content_type: str) -> None:
    """Upload a local file to `key` (managed transfer: multipart for large
    files), stored with `content_type`."""
    s = get_settings()
    await asyncio.to_thread(partial(
        _client().upload_file, str(path), s.spaces_bucket, key,
        ExtraArgs={"ContentType": content_type}))
