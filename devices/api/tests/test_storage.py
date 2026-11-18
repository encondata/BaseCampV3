"""Storage: presigning is pure in-process signing and building a client makes
no request, so those run against a real boto3 client; every call that would
reach a bucket fakes out `storage._client()` instead."""
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest
from botocore.exceptions import ClientError
from pydantic import SecretStr

from serversherpa_devices.services import storage


def _settings(endpoint: str):
    return SimpleNamespace(
        spaces_endpoint=endpoint,
        spaces_region="us-east-1",
        spaces_bucket="devices-test",
        spaces_access_key=SecretStr("test-access"),
        spaces_secret_key=SecretStr("test-secret"),
        spaces_use_path_style=True,
    )


def _pool_context(client, url: str):
    """The SSLContext urllib3 will hand every connection it opens to `url`."""
    manager = client._endpoint.http_session._manager
    return manager.connection_from_url(url).conn_kw["ssl_context"]


def test_presign_put_signs_type_and_length():
    url = storage.presign_put("apps/a/v1.apk", "application/vnd.android.package-archive", 1234)
    qs = parse_qs(urlparse(url).query)
    signed = qs["X-Amz-SignedHeaders"][0].split(";")
    assert "content-length" in signed
    assert "content-type" in signed
    assert "apps/a/v1.apk" in url
    assert qs["X-Amz-Expires"] == ["900"]


def test_presign_put_honors_a_custom_expiry():
    url = storage.presign_put("apps/a/v1.apk", "application/octet-stream", 10, expires=60)
    assert parse_qs(urlparse(url).query)["X-Amz-Expires"] == ["60"]


def test_preload_ca_bundle_called_for_https(monkeypatch):
    monkeypatch.setattr(storage, "get_settings",
                        lambda: _settings("https://files.example.test"))
    client = storage._client.__wrapped__()   # bypass the process-wide cache
    ctx = _pool_context(client, "https://files.example.test/bucket/key")
    assert ctx.cert_store_stats()["x509_ca"] > 0


def test_plain_http_client_is_left_alone(monkeypatch):
    monkeypatch.setattr(storage, "get_settings",
                        lambda: _settings("http://localhost:9000"))
    client = storage._client.__wrapped__()
    ctx = _pool_context(client, "https://files.example.test/bucket/key")
    assert ctx.cert_store_stats()["x509_ca"] == 0


class _FakeClient:
    def __init__(self, *, head=None, error_code=None):
        self._head = head
        self._error_code = error_code
        self.calls: list[tuple] = []

    def _maybe_fail(self, op):
        if self._error_code is not None:
            raise ClientError({"Error": {"Code": self._error_code, "Message": "secret-host"}}, op)

    def head_object(self, **kw):
        self.calls.append(("head_object", kw))
        self._maybe_fail("HeadObject")
        return self._head

    def head_bucket(self, **kw):
        self.calls.append(("head_bucket", kw))
        self._maybe_fail("HeadBucket")

    def create_bucket(self, **kw):
        self.calls.append(("create_bucket", kw))

    def delete_object(self, **kw):
        self.calls.append(("delete_object", kw))

    def copy_object(self, **kw):
        self.calls.append(("copy_object", kw))

    def download_file(self, *a):
        self.calls.append(("download_file", a))

    def upload_file(self, *a, **kw):
        self.calls.append(("upload_file", a, kw))

    def get_object(self, **kw):
        self.calls.append(("get_object", kw))
        chunks = [b"a" * 10, b"b" * 5]

        class Body:
            def read(self, n):
                return chunks.pop(0) if chunks else b""

            def close(self):
                pass

        return {"Body": Body()}


async def test_head_object_returns_size_and_type(monkeypatch):
    fake = _FakeClient(head={"ContentLength": 7, "ContentType": "image/png"})
    monkeypatch.setattr(storage, "_client", lambda: fake)
    assert await storage.head_object("k") == {"size": 7, "content_type": "image/png"}


async def test_head_object_missing_is_none_other_errors_raise(monkeypatch):
    monkeypatch.setattr(storage, "_client", lambda: _FakeClient(error_code="404"))
    assert await storage.head_object("k") is None
    monkeypatch.setattr(storage, "_client", lambda: _FakeClient(error_code="403"))
    with pytest.raises(ClientError):
        await storage.head_object("k")


async def test_delete_download_upload_use_the_bucket(monkeypatch, tmp_path):
    fake = _FakeClient()
    monkeypatch.setattr(storage, "_client", lambda: fake)
    await storage.delete_object("k")
    await storage.download_to("k", tmp_path / "f")
    await storage.upload_from(tmp_path / "f", "k2", "text/plain")
    names = [c[0] for c in fake.calls]
    assert names == ["delete_object", "download_file", "upload_file"]
    assert fake.calls[0][1]["Bucket"] == storage.get_settings().spaces_bucket
    assert fake.calls[2][2]["ExtraArgs"] == {"ContentType": "text/plain"}


async def test_copy_object_copies_within_the_bucket(monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(storage, "_client", lambda: fake)
    await storage.copy_object("uploads/u/a.apk", "apps/x/v/a.apk")
    bucket = storage.get_settings().spaces_bucket
    assert fake.calls == [("copy_object", {
        "Bucket": bucket, "Key": "apps/x/v/a.apk",
        "CopySource": {"Bucket": bucket, "Key": "uploads/u/a.apk"}})]


async def test_open_stream_yields_chunks(monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(storage, "_client", lambda: fake)
    got = [c async for c in storage.open_stream("k")]
    assert got == [b"a" * 10, b"b" * 5]


async def test_ensure_bucket_creates_when_missing(monkeypatch):
    fake = _FakeClient(error_code="404")
    monkeypatch.setattr(storage, "_client", lambda: fake)
    await storage.ensure_bucket()
    assert [c[0] for c in fake.calls] == ["head_bucket", "create_bucket"]


async def test_ensure_bucket_leaves_an_existing_bucket(monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(storage, "_client", lambda: fake)
    await storage.ensure_bucket()
    assert [c[0] for c in fake.calls] == ["head_bucket"]


async def test_ensure_bucket_never_raises_or_logs_the_message(monkeypatch, caplog):
    def boom():
        raise ClientError({"Error": {"Code": "403", "Message": "secret-host"}}, "HeadBucket")

    monkeypatch.setattr(storage, "_client", boom)
    await storage.ensure_bucket()
    assert "secret-host" not in caplog.text
    assert "ClientError" in caplog.text
