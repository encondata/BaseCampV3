"""Object storage via the AWS SDK (boto3) with an endpoint override —
the same code drives MinIO in development and DigitalOcean Spaces in
production; only SS_SPACES_* settings differ.

The bucket is PRIVATE. Reads happen through short-lived presigned GET
URLs generated here (pure in-process signing — no network round-trip).
"""

import asyncio
from functools import lru_cache, partial

import boto3
from botocore.config import Config

from serversherpa.config import get_settings


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


def presign_get(key: str | None, *, download_filename: str | None = None) -> str | None:
    """Short-lived read URL for a private object (None passes through so
    callers can presign optional keys like avatar_key directly).

    `download_filename`, when given, sets Content-Disposition on the
    response so a browser saves the file under that name instead of the
    (often opaque, uuid-bearing) storage key."""
    if not key:
        return None
    s = get_settings()
    params: dict = {"Bucket": s.spaces_bucket, "Key": key}
    if download_filename:
        params["ResponseContentDisposition"] = (
            f'attachment; filename="{download_filename}"')
    return _client().generate_presigned_url(
        "get_object", Params=params, ExpiresIn=s.spaces_presign_ttl_seconds,
    )


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
