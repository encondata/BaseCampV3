"""SigV4 (checked against AWS's published examples) and the bucket calls
against FakeSpaces."""

import base64
import hashlib
from datetime import UTC, datetime, timedelta, timezone

import httpx
import pytest

from sirdar_api.deploy import s3sig, spaces
from sirdar_api.deploy.spaces import SpacesError, SpacesKey

from .fake_digitalocean import FakeDigitalOcean
from .fake_spaces import NS, FakeSpaces

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


BUCKET = "ss-uat9-0a1b2c3d"
SECRET = "secret-setup"


def _setup(do) -> SpacesKey:
    return _key(do, "setup", [{"bucket": "", "permission": "fullaccess"}])


async def test_a_name_another_account_has_is_taken(fakes):
    do, fake = fakes
    setup = _setup(do)
    fake.foreign.add(BUCKET)
    with pytest.raises(SpacesError) as err:
        await spaces.create_bucket(BUCKET, "nyc3", setup, transport=fake.transport())
    assert err.value.reason == f"Another Spaces account already has the bucket {BUCKET}."
    assert [r.method for r in fake.requests] == ["PUT", "HEAD"]
    assert repr(setup).count(SECRET) == 0


async def test_recreating_our_bucket_is_idempotent_when_spaces_says_already_exists(fakes):
    do, fake = fakes
    setup = _setup(do)
    fake.recreate_conflict = True
    t = fake.transport()
    assert await spaces.create_bucket(BUCKET, "nyc3", setup, transport=t) is True
    assert await spaces.create_bucket(BUCKET, "nyc3", setup, transport=t) is False
    assert [r.method for r in fake.requests] == ["PUT", "PUT", "HEAD"]


async def test_a_403_on_create_is_refused(fakes):
    do, fake = fakes
    app = _key(do, "app", [{"bucket": "ss-other-bucket", "permission": "readwrite"}])
    with pytest.raises(SpacesError) as err:
        await spaces.create_bucket(BUCKET, "nyc3", app, transport=fake.transport())
    assert err.value.reason == "Spaces refused the key (AccessDenied)."
    assert BUCKET not in fake.buckets


async def test_unreachable(fakes):
    do, fake = fakes
    fake.down = True
    with pytest.raises(SpacesError) as err:
        await spaces.bucket_exists(BUCKET, "nyc3", _setup(do), transport=fake.transport())
    assert err.value.reason == "Couldn't reach DigitalOcean Spaces."


async def test_emptying_a_missing_bucket_deletes_nothing(fakes):
    do, fake = fakes
    assert await spaces.empty_bucket(BUCKET, "nyc3", _setup(do), transport=fake.transport()) == 0


async def test_deleting_a_bucket_with_objects_is_refused(fakes):
    do, fake = fakes
    fake.put(BUCKET, "a.txt", b"a")
    with pytest.raises(SpacesError) as err:
        await spaces.delete_bucket(BUCKET, "nyc3", _setup(do), transport=fake.transport())
    assert err.value.reason == "Spaces refused the request (BucketNotEmpty)."
    assert BUCKET in fake.buckets


async def test_a_partial_multi_delete_is_an_error(fakes):
    do, fake = fakes
    for name in ("a.txt", "b.txt", "c.txt"):
        fake.put(BUCKET, name, b"x")
    fake.undeletable = {"b.txt"}
    with pytest.raises(SpacesError) as err:
        await spaces.empty_bucket(BUCKET, "nyc3", _setup(do), transport=fake.transport())
    assert err.value.reason == "Spaces couldn't delete 1 object in the bucket (AccessDenied)."
    assert set(fake.buckets[BUCKET]) == {"b.txt"}


async def test_a_delete_that_makes_no_progress_stops(fakes):
    do, fake = fakes
    fake.put(BUCKET, "a.txt", b"x")
    inner = fake.transport()

    class Silent(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            if request.method == "POST":
                fake.requests.append(request)
                return httpx.Response(200, content=f'<DeleteResult xmlns="{NS}"/>'.encode())
            return await inner.handle_async_request(request)

    with pytest.raises(SpacesError) as err:
        await spaces.empty_bucket(BUCKET, "nyc3", _setup(do), transport=Silent())
    assert err.value.reason == "Spaces deleted nothing from the bucket, so Sirdar stopped."
    assert [r.method for r in fake.requests] == ["GET", "POST"]


async def test_the_page_cap_stops_a_bottomless_bucket(fakes, monkeypatch):
    do, fake = fakes
    monkeypatch.setattr(spaces, "MAX_PAGES", 2)
    fake.page_size = 1
    for i in range(5):
        fake.put(BUCKET, f"{i}.txt", b"x")
    with pytest.raises(SpacesError) as err:
        await spaces.empty_bucket(BUCKET, "nyc3", _setup(do), transport=fake.transport())
    assert err.value.reason == "The bucket has more objects than Sirdar deletes in one step."
    assert len(fake.buckets[BUCKET]) == 3


async def test_emptying_aborts_incomplete_uploads(fakes):
    do, fake = fakes
    setup = _setup(do)
    t = fake.transport()
    fake.page_size = 1
    fake.put(BUCKET, "done.bin", b"x")
    fake.start_upload(BUCKET, "big/one&<x>.bin")
    fake.start_upload(BUCKET, "big/two.bin")
    assert await spaces.empty_bucket(BUCKET, "nyc3", setup, transport=t) == 1
    assert fake.uploads[BUCKET] == {}
    assert await spaces.delete_bucket(BUCKET, "nyc3", setup, transport=t) is True


async def test_validation(fakes):
    do, fake = fakes
    for bucket, region in (("Bad_Name", "nyc3"), ("ab", "nyc3"), ("-abc", "nyc3"),
                           ("abc-", "nyc3"), ("a" * 64, "nyc3"), ("x.evil.com/abc", "nyc3"),
                           (BUCKET, "nyc3.evil.com"), (BUCKET, ""), ("abc\n", "nyc3"),
                           (BUCKET, "nyc3\n")):
        with pytest.raises(SpacesError) as err:
            await spaces.bucket_exists(bucket, region, _setup(do), transport=fake.transport())
        assert err.value.reason in ("That isn't a valid Spaces bucket name.",
                                    "That isn't a valid Spaces region.")
    assert fake.requests == []


def test_sign_normalizes_to_utc_and_rejects_naive_times():
    args = dict(method="GET", host="examplebucket.s3.amazonaws.com", path="/", query={},
                headers={}, payload_sha256=s3sig.EMPTY_SHA256, access_key=AWS_KEY,
                secret_key=AWS_SECRET, region="us-east-1")
    eastern = AWS_NOW.astimezone(timezone(timedelta(hours=-4)))
    assert s3sig.sign(**args, now=eastern) == s3sig.sign(**args, now=AWS_NOW)
    with pytest.raises(ValueError):
        s3sig.sign(**args, now=datetime(2013, 5, 24))


async def _raw(fake, key: SpacesKey, *, method="GET", query=None, send_query=None,
               body=b"", send_body=None, region="nyc3", headers=None) -> httpx.Response:
    """Sign one request, then send it possibly changed on the way."""
    host = f"{BUCKET}.nyc3.digitaloceanspaces.com"
    signed = s3sig.sign(method=method, host=host, path="/", query=query or {},
                        headers=headers or {}, payload_sha256=hashlib.sha256(body).hexdigest(),
                        access_key=key.access_key, secret_key=key.secret_key, region=region,
                        now=datetime.now(UTC))
    q = send_query if send_query is not None else (query or {})
    url = f"https://{host}/" + ("?" + s3sig.canonical_query(q) if q else "")
    async with httpx.AsyncClient(transport=fake.transport()) as client:
        return await client.request(method, url, headers=signed,
                                    content=body if send_body is None else send_body)


def _delete_doc(*names: str) -> tuple[bytes, dict]:
    doc = ("<Delete>" + "".join(f"<Object><Key>{n}</Key></Object>" for n in names)
           + "</Delete>").encode()
    md5 = base64.b64encode(hashlib.md5(doc).digest()).decode()
    return doc, {"Content-MD5": md5, "Content-Type": "application/xml"}


async def test_the_fake_checks_signatures(fakes):
    do, fake = fakes
    setup = _setup(do)
    fake.put(BUCKET, "a.txt", b"a")
    fake.put(BUCKET, "b.txt", b"b")
    ok = await _raw(fake, setup, query={"list-type": "2"})
    assert ok.status_code == 200

    def code(resp):
        return (resp.status_code, resp.text)

    denied = (403, "<Error><Code>SignatureDoesNotMatch</Code></Error>")
    assert code(await _raw(fake, setup, query={"list-type": "2"},
                           send_query={"list-type": "2", "prefix": "a"})) == denied
    assert code(await _raw(fake, setup, region="sfo3")) == denied
    assert code(await _raw(fake, SpacesKey(setup.access_key, "wrong"))) == denied
    doc, headers = _delete_doc("a.txt")
    other, _ = _delete_doc("b.txt")
    assert code(await _raw(fake, setup, method="POST", query={"delete": ""}, body=doc,
                           send_body=other, headers=headers)) == denied
    assert set(fake.buckets[BUCKET]) == {"a.txt", "b.txt"}
    resp = await _raw(fake, setup, method="POST", query={"delete": ""}, body=doc,
                      headers=headers)
    assert resp.status_code == 200 and set(fake.buckets[BUCKET]) == {"b.txt"}


async def test_the_secret_never_leaves_in_a_request_or_an_error(fakes):
    do, fake = fakes
    setup = _setup(do)
    t = fake.transport()
    reasons = []
    await spaces.create_bucket(BUCKET, "nyc3", setup, transport=t)
    fake.put(BUCKET, "a.txt", b"a")
    fake.start_upload(BUCKET, "b.bin")
    await spaces.empty_bucket(BUCKET, "nyc3", setup, transport=t)
    await spaces.delete_bucket(BUCKET, "nyc3", setup, transport=t)
    fake.put(BUCKET, "c.txt", b"c")
    fake.undeletable = {"c.txt"}
    fake.foreign.add("ss-taken-bucket")
    for call in (spaces.empty_bucket(BUCKET, "nyc3", setup, transport=t),
                 spaces.delete_bucket(BUCKET, "nyc3", setup, transport=t),
                 spaces.create_bucket("ss-taken-bucket", "nyc3", setup, transport=t),
                 spaces.bucket_exists(BUCKET, "nyc3", SpacesKey("DO00NOBODY", SECRET),
                                      transport=t)):
        with pytest.raises(SpacesError) as err:
            await call
        reasons.append(err.value.reason)
        reasons.append(repr(err.value))
        reasons.append(str(err.value.__cause__) + str(err.value.__context__))
    assert len(fake.requests) > 8
    for request in fake.requests:
        seen = str(request.url) + str(dict(request.headers)) + request.content.decode()
        assert SECRET not in seen
    assert all(SECRET not in r for r in reasons)
    assert SECRET not in repr(setup)


# ---- CORS ------------------------------------------------------------------------------

ORIGINS = ("https://portal.uat9.example.com", "https://wiki.uat9.example.com")


async def test_cors_round_trip(fakes):
    do, fake = fakes
    setup, t = _setup(do), fake.transport()
    await spaces.create_bucket(BUCKET, "nyc3", setup, transport=t)
    assert await spaces.bucket_cors(BUCKET, "nyc3", setup, transport=t) == []
    rule = spaces.cors_rule(ORIGINS)
    await spaces.put_bucket_cors(BUCKET, "nyc3", setup, [rule], transport=t)
    assert await spaces.bucket_cors(BUCKET, "nyc3", setup, transport=t) == [rule]
    assert set(rule.methods) == {"GET", "HEAD", "PUT"}
    assert "Content-Type" in rule.headers or "*" in rule.headers
    assert rule.max_age > 0
    put = next(r for r in fake.requests if r.method == "PUT" and "cors" in r.url.params)
    assert put.headers["content-md5"] == base64.b64encode(
        hashlib.md5(put.content).digest()).decode()
    assert b"https://wiki.uat9.example.com" in put.content


async def test_cors_on_a_missing_bucket_is_an_error(fakes):
    do, fake = fakes
    with pytest.raises(SpacesError):
        await spaces.bucket_cors(BUCKET, "nyc3", _setup(do), transport=fake.transport())


async def test_cors_refused_to_a_scoped_key_is_spaces_denied(fakes):
    do, fake = fakes
    t = fake.transport()
    await spaces.create_bucket(BUCKET, "nyc3", _setup(do), transport=t)
    app = _key(do, "app", [{"bucket": BUCKET, "permission": "readwrite"}])
    fake.cors_needs_fullaccess = True
    with pytest.raises(spaces.SpacesDenied):
        await spaces.put_bucket_cors(BUCKET, "nyc3", app, [spaces.cors_rule(ORIGINS)],
                                     transport=t)
