"""The learn image serves the built SPA on :8080 with a history fallback,
writes config.js from LEARN_API_URL at start, and refuses to start
without it."""
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

TAG = "serversherpa-learn:pytest"
API = "https://api.uat.serversherpa.com"


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    build_image("learn/Dockerfile", TAG)
    port = free_port()
    cid = subprocess.run(
        ["docker", "run", "-d", "--rm", "-p", f"127.0.0.1:{port}:8080",
         "-e", f"LEARN_API_URL={API}", TAG],
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


def test_index_and_deep_links_are_the_learn_site(base_url: str) -> None:
    for path in ("/", "/start", "/training"):
        status, headers, body = _get(base_url + path)
        assert status == 200, path
        assert "<title>ServerSherpa Learn</title>" in body, path
        assert headers.get("Cache-Control") == "no-cache", path
        assert headers.get("Referrer-Policy") == "no-referrer", path


def test_config_js_carries_the_api_url_and_is_never_cached(base_url: str) -> None:
    status, headers, body = _get(base_url + "/config.js")
    assert status == 200
    assert body.strip() == f'window.__LEARN_CONFIG__ = {{ apiUrl: "{API}" }};'
    assert headers.get("Cache-Control") == "no-store"


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


def test_the_portal_artwork_is_served(base_url: str) -> None:
    # the sign-in scene's logo and mountains come from portal/public
    with urllib.request.urlopen(base_url + "/images/serversherpa-logo.png", timeout=5) as resp:
        assert resp.status == 200
        assert resp.read(4) == b"\x89PNG"


def test_it_refuses_to_start_without_an_api_url(base_url: str) -> None:
    out = subprocess.run(["docker", "run", "--rm", TAG], capture_output=True, text=True)
    assert out.returncode != 0
    assert "LEARN_API_URL is required" in out.stderr
