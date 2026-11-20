import json

import httpx
import pytest
import respx

from edge.app import create_app
from edge.environments import BUILT_IN, STATUS_LIST_URL, ListSource, parse_list


def body(entries, version=1) -> bytes:
    return json.dumps({"version": version, "environments": entries}).encode()


GOOD = [{"id": "rc1", "name": "RC1", "domain": "rc1.serversherpa.com"},
        {"id": "qa", "name": "QA", "domain": "qa.serversherpa.com"}]


def test_built_in_order_and_urls():
    assert [e.id for e in BUILT_IN] == ["prod", "rc1", "uat", "beta", "alpha", "dev"]
    assert BUILT_IN[0].api_url == "https://api.serversherpa.com"
    assert BUILT_IN[2].portal_url == "https://portal.uat.serversherpa.com"
    assert [e.id for e in BUILT_IN if e.is_prod] == ["prod"]


def test_parse_drops_bad_entries_keeps_good():
    raw = body([
        {"id": "x", "name": "X", "domain": "evil.com"},
        {"id": "y", "name": "Y", "domain": "api.serversherpa.com:443"},
        {"id": "z", "name": "Z", "domain": "serversherpa.com/p"},
        {"id": "Bad", "name": "B", "domain": "b.serversherpa.com"},
        {"id": "rc1", "name": "RC1", "domain": "rc1.serversherpa.com"},
        {"id": "rc1", "name": "dup", "domain": "x.serversherpa.com"},
        {"id": "n", "name": "  ", "domain": "n.serversherpa.com"},
    ])
    envs = parse_list(raw)
    assert [(e.id, e.name, e.domain) for e in envs] == [("rc1", "RC1", "rc1.serversherpa.com")]


def test_parse_rejects_wrong_version_empty_and_bad_json():
    assert parse_list(body(GOOD, version=2)) is None
    assert parse_list(body([])) is None
    assert parse_list(b"{not json") is None
    assert parse_list(body([{"id": "a" * 30, "name": "X" * 70000,
                             "domain": "a.serversherpa.com"}])) is None


@pytest.mark.parametrize("bad_id", ["a", "ab-", "1ab", "a" * 33])
def test_parse_id_rules(bad_id):
    assert parse_list(body([{"id": bad_id, "name": "N", "domain": "n.serversherpa.com"}])) is None


async def test_source_fresh_then_saved_then_built_in(tmp_path):
    src = ListSource(tmp_path)
    try:
        with respx.mock(assert_all_called=False) as router:
            route = router.get(STATUS_LIST_URL)
            route.respond(200, content=body(GOOD))
            envs, kind = await src.current()
            assert kind == "fresh" and [e.id for e in envs] == ["rc1", "qa"]
            assert (tmp_path / "environments-cache.json").exists()
            route.respond(500)
            envs2, kind = await src.current()
            assert kind == "saved" and envs2 == envs
        (tmp_path / "environments-cache.json").unlink()
        with respx.mock(assert_all_called=False) as router:
            router.get(STATUS_LIST_URL).mock(side_effect=httpx.ConnectTimeout("slow"))
            envs3, kind = await src.current()
            assert kind == "built_in" and envs3 == list(BUILT_IN)
    finally:
        await src.aclose()


async def test_source_redirect_is_failure(tmp_path):
    src = ListSource(tmp_path)
    try:
        with respx.mock(assert_all_called=False) as router:
            router.get(STATUS_LIST_URL).respond(302, headers={"location": "https://evil.test/x.json"})
            evil = router.get("https://evil.test/x.json").respond(200, content=body(GOOD))
            _, kind = await src.current()
            assert kind == "built_in"
            assert not evil.called
    finally:
        await src.aclose()


async def test_source_oversize_body_is_failure(tmp_path):
    src = ListSource(tmp_path)
    try:
        with respx.mock(assert_all_called=False) as router:
            router.get(STATUS_LIST_URL).respond(200, content=b" " * 70000 + body(GOOD))
            _, kind = await src.current()
            assert kind == "built_in"
    finally:
        await src.aclose()


async def test_route_environments_anonymous(client, cloud):
    cloud.get(STATUS_LIST_URL).mock(side_effect=httpx.ConnectTimeout("slow"))
    r = await client.get("/edge/environments")
    assert r.status_code == 200
    data = r.json()
    assert data["source"] == "built_in"
    assert len(data["environments"]) == 6
    assert data["environments"][0] == {
        "id": "prod", "name": "Prod", "domain": "serversherpa.com",
        "api_url": "https://api.serversherpa.com",
        "portal_url": "https://portal.serversherpa.com", "is_prod": True}


DEEP = b"[" * 60000  # well under the 64 KB cap, deep enough to blow the JSON parser's stack


def test_parse_deep_nesting_is_unusable():
    assert len(DEEP) < 64 * 1024
    assert parse_list(DEEP) is None


@pytest.mark.parametrize("version", [1.0, True, "1"])
def test_parse_version_must_be_the_integer_1(version):
    assert parse_list(body(GOOD, version=version)) is None


async def test_source_deep_nested_cache_falls_back_to_built_in(tmp_path):
    (tmp_path / "environments-cache.json").write_bytes(DEEP)
    src = ListSource(tmp_path)
    try:
        with respx.mock(assert_all_called=False) as router:
            router.get(STATUS_LIST_URL).respond(500)
            envs, kind = await src.current()
            assert kind == "built_in" and envs == list(BUILT_IN)
    finally:
        await src.aclose()


async def test_route_environments_deep_nested_download_falls_back(client, cloud):
    cloud.get(STATUS_LIST_URL).respond(200, content=DEEP)
    r = await client.get("/edge/environments")
    assert r.status_code == 200
    assert r.json()["source"] == "built_in"


class _DripStream(httpx.AsyncByteStream):
    """A valid list sent a few bytes at a time, slower than the 5 s total."""

    def __init__(self, raw: bytes, pause: float) -> None:
        self._raw, self._pause = raw, pause

    async def __aiter__(self):
        import asyncio
        for i in range(0, len(self._raw), 8):
            await asyncio.sleep(self._pause)
            yield self._raw[i:i + 8]


class _DripTransport(httpx.AsyncBaseTransport):
    def __init__(self, raw: bytes, pause: float) -> None:
        self._raw, self._pause = raw, pause

    async def handle_async_request(self, request):
        return httpx.Response(200, stream=_DripStream(self._raw, self._pause))


async def test_source_slow_drip_download_is_bounded_to_5_seconds(tmp_path):
    import time
    raw = body(GOOD)
    # each chunk lands well inside any per-read timeout, but the whole body
    # takes about 10 s
    pause = 10.0 / (len(raw) / 8)
    src = ListSource(tmp_path, transport=_DripTransport(raw, pause))
    try:
        started = time.monotonic()
        envs, kind = await src.current()
        elapsed = time.monotonic() - started
        assert kind == "built_in" and envs == list(BUILT_IN)
        assert 4.5 <= elapsed < 6.5
    finally:
        await src.aclose()
