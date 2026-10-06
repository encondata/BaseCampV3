"""SigV4 (checked against AWS's published examples) and the bucket calls
against FakeSpaces."""

from datetime import UTC, datetime

import httpx
import pytest

from sirdar_api.deploy import s3sig, spaces
from sirdar_api.deploy.spaces import SpacesError, SpacesKey

from .fake_digitalocean import FakeDigitalOcean
from .fake_spaces import FakeSpaces

AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
AWS_NOW = datetime(2013, 5, 24, tzinfo=UTC)


def _signature(headers: dict) -> str:
    return headers["Authorization"].rsplit("Signature=", 1)[1]


def test_sigv4_get_object_example():
    """AWS S3 docs, "Signature Calculations for the Authorization Header:
    Transferring Payload in a Single Chunk", example "GET Object". If this
    fails, compare each string with that page before changing the signer."""
    headers = s3sig.sign(method="GET", host="examplebucket.s3.amazonaws.com", path="/test.txt",
                         query={}, headers={"Range": "bytes=0-9"},
                         payload_sha256=s3sig.EMPTY_SHA256, access_key=AWS_KEY,
                         secret_key=AWS_SECRET, region="us-east-1", now=AWS_NOW)
    assert _signature(headers) == \
        "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    assert headers["Authorization"].startswith(
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ")


def test_sigv4_list_objects_example():
    """The same page's "GET Bucket (List Objects)" example."""
    headers = s3sig.sign(method="GET", host="examplebucket.s3.amazonaws.com", path="/",
                         query={"max-keys": "2", "prefix": "J"}, headers={},
                         payload_sha256=s3sig.EMPTY_SHA256, access_key=AWS_KEY,
                         secret_key=AWS_SECRET, region="us-east-1", now=AWS_NOW)
    assert _signature(headers) == \
        "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"


@pytest.fixture
def fakes():
    do = FakeDigitalOcean()
    return do, FakeSpaces(do)


def _key(do, name: str, grants: list[dict]) -> SpacesKey:
    made = do.keys.setdefault(f"DO00{name.upper()}", {
        "name": name, "access_key": f"DO00{name.upper()}", "secret_key": f"secret-{name}",
        "grants": grants})
    return SpacesKey(made["access_key"], made["secret_key"])


async def test_create_empty_delete(fakes):
    do, fake = fakes
    setup = _key(do, "setup", [{"bucket": "", "permission": "fullaccess"}])
    t = fake.transport()
    assert await spaces.create_bucket("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t) is True
    assert await spaces.create_bucket("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t) is False
    assert await spaces.bucket_exists("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t)
    fake.page_size = 2
    for i in range(5):
        fake.put("ss-uat9-0a1b2c3d", f"photos/{i}&<x>.jpg", b"x")
    assert await spaces.empty_bucket("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t) == 5
    assert await spaces.delete_bucket("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t) is True
    assert await spaces.delete_bucket("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t) is False
    assert not await spaces.bucket_exists("ss-uat9-0a1b2c3d", "nyc3", setup, transport=t)
    first = fake.requests[0]
    assert first.url.host == "ss-uat9-0a1b2c3d.nyc3.digitaloceanspaces.com"
    assert "secret-setup" not in str(first.headers)


async def test_a_bucket_scoped_key_reaches_only_its_bucket(fakes):
    do, fake = fakes
    app = _key(do, "app", [{"bucket": "ss-uat9-0a1b2c3d", "permission": "readwrite"}])
    fake.buckets["other"] = {}
    with pytest.raises(SpacesError) as err:
        await spaces.bucket_exists("other", "nyc3", app, transport=fake.transport())
    assert err.value.reason == "Spaces refused the key (AccessDenied)."


async def test_a_taken_name_is_our_copy(fakes):
    do, fake = fakes
    setup = _key(do, "setup", [{"bucket": "", "permission": "fullaccess"}])

    def taken(request):
        return httpx.Response(409, content=b"<Error><Code>BucketAlreadyExists</Code></Error>")

    with pytest.raises(SpacesError) as err:
        await spaces.create_bucket("ss-uat9-0a1b2c3d", "nyc3", setup,
                                   transport=httpx.MockTransport(taken))
    assert err.value.reason == "Another Spaces account already has the bucket ss-uat9-0a1b2c3d."
    assert repr(setup).count("secret-setup") == 0
