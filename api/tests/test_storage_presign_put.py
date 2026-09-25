"""Unit tests for `storage.presign_put`, the `inline`/`content_type`
additions to `presign_get`, and `storage.head_object` — Task 6.
Presigning is pure in-process signing (no network call), so the presign
tests run against the real boto3 client with the test settings'
SS_SPACES_* config; `head_object` makes a real HEAD request, so its
tests fake out `storage._client()` instead of hitting the network."""
import pytest
from botocore.exceptions import ClientError

from serversherpa.services import storage


def test_presign_put_url_contains_key_and_signature():
    url = storage.presign_put("wiki/abc-123/def-456/report.pdf", "application/pdf")
    assert "wiki/abc-123/def-456/report.pdf" in url
    assert "X-Amz-Signature" in url
    assert "X-Amz-Expires=3600" in url


def test_presign_put_honors_a_custom_expiry():
    url = storage.presign_put("wiki/x/y/z.txt", "text/plain", expires=60)
    assert "X-Amz-Expires=60" in url


def test_presign_get_inline_sets_content_disposition_and_type():
    url = storage.presign_get("wiki/a/b/notes.txt", download_filename="notes.txt",
                              inline=True, content_type="text/plain; charset=utf-8")
    assert "response-content-disposition=inline" in url
    assert "notes.txt" in url
    assert "response-content-type=text" in url


def test_presign_get_attachment_is_the_default_disposition():
    url = storage.presign_get("wiki/a/b/notes.txt", download_filename="notes.txt")
    assert "response-content-disposition=attachment" in url
    assert "response-content-type=" not in url


def test_presign_get_none_key_passes_through():
    assert storage.presign_get(None) is None


# ── head_object ──────────────────────────────────────────────────────


class _FakeClient:
    def __init__(self, *, result=None, error_code=None):
        self._result = result
        self._error_code = error_code

    def head_object(self, **kwargs):
        if self._error_code is not None:
            raise ClientError(
                {"Error": {"Code": self._error_code, "Message": "x"}}, "HeadObject")
        return self._result


async def test_head_object_returns_size_and_content_type(monkeypatch):
    monkeypatch.setattr(storage, "_client", lambda: _FakeClient(
        result={"ContentLength": 1234, "ContentType": "image/png"}))
    assert await storage.head_object("wiki/some/key.png") == {
        "size": 1234, "content_type": "image/png"}


async def test_head_object_missing_key_returns_none(monkeypatch):
    monkeypatch.setattr(storage, "_client",
                        lambda: _FakeClient(error_code="404"))
    assert await storage.head_object("wiki/gone/key.bin") is None


async def test_head_object_translates_only_missing_errors(monkeypatch):
    """A non-404 ClientError (e.g. access denied) propagates instead of
    being swallowed as `None` — only a missing object is a clean miss."""
    monkeypatch.setattr(storage, "_client",
                        lambda: _FakeClient(error_code="403"))
    with pytest.raises(ClientError):
        await storage.head_object("wiki/some/key.bin")
