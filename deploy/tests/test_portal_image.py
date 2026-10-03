"""The portal image serves the built SPA on :8080 with a history
fallback, so deep links load the app."""
from __future__ import annotations

import re
import subprocess
import urllib.error
import urllib.request
from collections.abc import Iterator

import pytest

from conftest import build_image, docker_daemon_ok, free_port, wait_http

pytestmark = [
    pytest.mark.images,
    pytest.mark.skipif(not docker_daemon_ok(), reason="Docker daemon not available"),
]

TAG = "serversherpa-portal:pytest"


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    build_image("portal/Dockerfile", TAG)
    port = free_port()
    cid = subprocess.run(
        ["docker", "run", "-d", "--rm", "-p", f"127.0.0.1:{port}:8080", TAG],
        capture_output=True, text=True, check=True).stdout.strip()
    try:
        url = f"http://127.0.0.1:{port}"
        wait_http(url + "/", timeout=30)
        yield url
    finally:
        subprocess.run(["docker", "stop", cid], capture_output=True)


def _get(url: str) -> tuple[int, dict[str, str], str]:
    with urllib.request.urlopen(url, timeout=5) as resp:
        return resp.status, dict(resp.headers), resp.read().decode()


def test_index_is_the_portal(base_url: str) -> None:
    status, _, body = _get(base_url + "/")
    assert status == 200
    assert "<title>ServerSherpa Portal</title>" in body


def test_deep_links_fall_back_to_index(base_url: str) -> None:
    status, _, body = _get(base_url + "/people/users/00000000-0000-0000-0000-000000000000")
    assert status == 200
    assert "<title>ServerSherpa Portal</title>" in body


def test_hashed_assets_are_cached_forever(base_url: str) -> None:
    _, _, body = _get(base_url + "/")
    asset = re.search(r'src="(/assets/[^"]+\.js)"', body)
    assert asset, "index.html references no /assets/*.js bundle"
    status, headers, _ = _get(base_url + asset.group(1))
    assert status == 200
    assert "immutable" in headers.get("Cache-Control", "")


def test_missing_assets_are_a_real_404(base_url: str) -> None:
    with pytest.raises(urllib.error.HTTPError) as exc:
        _get(base_url + "/assets/does-not-exist.js")
    assert exc.value.code == 404
    assert "immutable" not in exc.value.headers.get("Cache-Control", "")


def test_index_html_is_never_cached(base_url: str) -> None:
    for path in ("/", "/people/users/abc"):
        _, headers, _ = _get(base_url + path)
        assert headers.get("Cache-Control") == "no-cache", path
