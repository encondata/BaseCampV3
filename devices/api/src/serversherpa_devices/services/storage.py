"""Object storage via boto3 with an endpoint override: MinIO in development,
DigitalOcean Spaces in production. A port of the subset of the main API's
`serversherpa/services/storage.py` this service needs, including its
`_client_lock` and the `_preload_ca_bundle` TLS-segfault guard.

The bucket is PRIVATE. Callers upload through presigned PUT URLs and read
through short-lived tokenized routes, never a public bucket URL.
"""

import asyncio
import logging
import threading
from collections.abc import AsyncIterator
from functools import lru_cache, partial
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from botocore.httpsession import get_cert_path

from serversherpa_devices.config import get_settings

logger = logging.getLogger(__name__)

_client_lock = threading.Lock()
_CHUNK = 1024 * 1024
_MISSING = ("404", "NoSuchKey", "NoSuchBucket", "NotFound")


@lru_cache
def _client():
    s = get_settings()
    # boto3's default session isn't thread-safe: never let two builds overlap.
    with _client_lock:
        client = boto3.client(
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
        _preload_ca_bundle(client)
    return client


def _preload_ca_bundle(client) -> None:
    """Load the CA bundle into the client's shared SSLContext once, before
    any request can use it.

    botocore gives the client ONE SSLContext for its whole connection pool,
    and urllib3 calls `load_verify_locations()` on it for every new
    connection. The first load on a context adds a lookup to OpenSSL's
    X509_STORE with no lock (openssl/openssl#24480, boto/botocore#3164), so
    two connections opening at once on a fresh client can corrupt it and
    segfault the process in the next certificate check. Once this load is
    done, the later per-connection loads find the lookup already present.

    Same guard as the main API's `serversherpa.services.storage` (see its
    `_preload_ca_bundle` docstring). Reaches into botocore internals; if
    they ever move, log and carry on (tests/test_storage.py fails loudly)."""
    if not client.meta.endpoint_url.lower().startswith("https"):
        return
    try:
        session = client._endpoint.http_session
        verify = session._verify
        ctx = session._manager.connection_pool_kw["ssl_context"]
    except (AttributeError, KeyError):
        logger.warning("storage: can't reach botocore's SSLContext to preload CA certs")
        return
    if verify:
        ctx.load_verify_locations(get_cert_path(verify))


def _loggable(exc: BaseException) -> str:
    """The error's class and S3 code, never its message (it can carry the
    endpoint URL)."""
    code = exc.response.get("Error", {}).get("Code") if isinstance(exc, ClientError) else None
    return f"{type(exc).__name__} (code={code})" if code else type(exc).__name__


def presign_put(key: str, content_type: str, size: int, expires: int = 900) -> str:
    """A short-lived PUT URL for a browser to upload straight to storage.
    The signature covers `Content-Type` and `Content-Length`, so anything
    but exactly `content_type` and `size` bytes is rejected."""
    return _client().generate_presigned_url(
        "put_object",
        Params={"Bucket": get_settings().spaces_bucket, "Key": key,
                "ContentType": content_type, "ContentLength": size},
        ExpiresIn=expires,
    )


async def head_object(key: str) -> dict | None:
    """The object's size and content type, or None when nothing exists at
    `key`. Any other storage error propagates."""
    try:
        resp = await asyncio.to_thread(partial(
            _client().head_object, Bucket=get_settings().spaces_bucket, Key=key))
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in _MISSING:
            return None
        raise
    return {"size": resp["ContentLength"], "content_type": resp.get("ContentType", "")}


async def download_to(key: str, path: Path) -> None:
    """Stream an object to a local file (managed transfer, never the whole
    object in memory)."""
    await asyncio.to_thread(partial(
        _client().download_file, get_settings().spaces_bucket, key, str(path)))


async def upload_from(path: Path, key: str, content_type: str) -> None:
    """Upload a local file to `key` (multipart for large files)."""
    await asyncio.to_thread(partial(
        _client().upload_file, str(path), get_settings().spaces_bucket, key,
        ExtraArgs={"ContentType": content_type}))


async def open_stream(key: str) -> AsyncIterator[bytes]:
    """The object's bytes in 1 MiB chunks; each blocking read runs in a thread."""
    resp = await asyncio.to_thread(partial(
        _client().get_object, Bucket=get_settings().spaces_bucket, Key=key))
    body = resp["Body"]
    try:
        while chunk := await asyncio.to_thread(body.read, _CHUNK):
            yield chunk
    finally:
        await asyncio.to_thread(body.close)


async def delete_object(key: str) -> None:
    """Delete an object. S3 DELETE is idempotent, so a missing key is fine."""
    await asyncio.to_thread(partial(
        _client().delete_object, Bucket=get_settings().spaces_bucket, Key=key))


async def ensure_bucket() -> None:
    """Create the bucket when it doesn't exist. Meant for startup: failures
    are logged by class and code only and never raised."""
    bucket = get_settings().spaces_bucket
    try:
        client = _client()
        try:
            await asyncio.to_thread(partial(client.head_bucket, Bucket=bucket))
            return
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") not in _MISSING:
                raise
        await asyncio.to_thread(partial(client.create_bucket, Bucket=bucket))
        logger.info("storage: created bucket %s", bucket)
    except (ClientError, BotoCoreError, OSError) as exc:
        logger.error("storage: ensure_bucket failed: %s", _loggable(exc))
