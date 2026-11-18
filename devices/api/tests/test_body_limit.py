"""The request-body limit (1 MiB in tests): refused before sign-in, whether
the size is declared or streamed."""

import pytest
from httpx import ASGITransport, AsyncClient

from serversherpa_devices.api.routes.apple import get_asc_http

from .fake_asc import FakeAsc
from .test_apple_settings_api import put_apple

TOO_LARGE = {"detail": {"code": "too_large", "message": "This request is too large."}}
BOUNDARY = "limit-test-boundary"


@pytest.fixture
async def anonymous(devices_app):
    async with AsyncClient(transport=ASGITransport(app=devices_app),
                           base_url="http://testserver") as client:
        yield client


async def test_body_over_limit_rejected_before_auth(anonymous, main_fake):
    body = b"x" * (2 * 1024 * 1024)
    r = await anonymous.put("/api/apple", content=body, headers={
        "Content-Type": f"multipart/form-data; boundary={BOUNDARY}",
        "Content-Length": str(len(body))})
    assert r.status_code == 413
    assert r.json() == TOO_LARGE
    assert not main_fake.authorize_route.called


async def test_chunked_body_over_limit_rejected(api, anonymous, main_fake):
    async def chunks():
        yield (f"--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"p12\"; "
               f"filename=\"big.p12\"\r\nContent-Type: application/x-pkcs12\r\n\r\n").encode()
        for _ in range(40):              # 2.5 MiB in all
            yield b"x" * (64 * 1024)

    headers = {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"}
    r = await anonymous.put("/api/apple", content=chunks(), headers=headers)
    assert "content-length" not in {k.lower() for k in r.request.headers}
    assert r.status_code == 413
    assert r.json() == TOO_LARGE
    assert not main_fake.authorize_route.called

    # Signed in, the answer is the same.
    r = await api.put("/api/apple", content=chunks(), headers=headers)
    assert r.status_code == 413
    assert r.json() == TOO_LARGE


async def test_normal_apple_save_still_works(api, devices_app):
    fake = FakeAsc()
    fake.add_certificate("7D2A0F1C3")

    async def http():
        async with fake.http() as client:
            yield client

    devices_app.dependency_overrides[get_asc_http] = http
    r = await put_apple(api)
    assert r.status_code == 200, r.text
    assert r.json()["configured"] is True

    # A small chunked JSON body passes through untouched.
    async def small():
        yield b'{"confirm": '
        yield b'"clear"}'

    r = await api.request("DELETE", "/api/apple", content=small(),
                          headers={"Content-Type": "application/json"})
    assert r.status_code == 204
