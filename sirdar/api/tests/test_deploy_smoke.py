import httpx
import pytest

from sirdar_api.deploy import smoke

from .fake_smoke import FakeSmoke

TARGETS = [("api", "api.uat2.serversherpa.com"), ("portal", "portal.uat2.serversherpa.com"),
           ("spaces", "spaces.uat2.serversherpa.com")]


async def _run(fake, sleeps=None, lines=None, **kw):
    async def sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)
    return await smoke.run(TARGETS, "10.10.48.6", transport=fake.transport(), sleep=sleep,
                           out=lines.append if lines is not None else None, **kw)


async def test_every_url_goes_to_the_proxy_with_sni_and_host():
    fake = FakeSmoke()
    results = await _run(fake)
    assert [(r.service, r.url, r.ok, r.detail) for r in results] == [
        ("api", "https://api.uat2.serversherpa.com/healthz", True, "HTTP 200"),
        ("portal", "https://portal.uat2.serversherpa.com/", True, "HTTP 200"),
        ("spaces", "https://spaces.uat2.serversherpa.com/healthz", True, "HTTP 200"),
    ]
    first = fake.requests[0]
    assert str(first.url) == "https://10.10.48.6/healthz"
    assert first.headers["host"] == "api.uat2.serversherpa.com"
    assert first.extensions["sni_hostname"] == "api.uat2.serversherpa.com"


async def test_redirects_pass_and_errors_fail():
    fake = FakeSmoke()
    fake.set("api.uat2.serversherpa.com", 301)
    fake.set("portal.uat2.serversherpa.com", 404)
    fake.set("spaces.uat2.serversherpa.com", "tls")
    results = await _run(fake, attempts=1)
    assert [(r.ok, r.detail) for r in results] == [
        (True, "HTTP 301"), (False, "HTTP 404"), (False, "the certificate didn't verify")]
    fake.set("portal.uat2.serversherpa.com", "down")
    fake.set("spaces.uat2.serversherpa.com", "slow")
    results = await _run(fake, attempts=1)
    assert [r.detail for r in results[1:]] == ["couldn't connect to the proxy",
                                               "no answer within 10 s"]


async def test_failures_are_retried_until_they_answer():
    fake = FakeSmoke()
    fake.set("portal.uat2.serversherpa.com", "down", 502, 200)
    sleeps, lines = [], []
    results = await _run(fake, sleeps, lines)
    assert all(r.ok for r in results)
    assert sleeps == [10, 10]
    assert lines == ["Waiting 10 s, then trying portal again (2 of 6)\n",
                     "Waiting 10 s, then trying portal again (3 of 6)\n"]
    hosts = [r.headers["host"] for r in fake.requests]
    assert hosts.count("api.uat2.serversherpa.com") == 1          # passed URLs aren't re-asked


async def test_gives_up_after_the_last_attempt():
    fake = FakeSmoke()
    fake.set("spaces.uat2.serversherpa.com", 502)
    sleeps = []
    results = await _run(fake, sleeps)
    assert (results[2].ok, results[2].detail) == (False, "HTTP 502")
    assert sleeps == [10] * 5


async def test_the_guard_stops_real_requests(no_real_http):
    with pytest.raises(AssertionError, match="real HTTP request to 10.10.48.6"):
        await smoke.run(TARGETS[:1], "10.10.48.6", attempts=1)
    assert no_real_http == ["10.10.48.6"]
    no_real_http.clear()                    # this one was on purpose


async def test_two_failures_in_one_round_are_named_together():
    fake = FakeSmoke()
    fake.set("portal.uat2.serversherpa.com", 502, 200)
    fake.set("spaces.uat2.serversherpa.com", "down", 200)
    lines = []
    results = await _run(fake, [], lines)
    assert all(r.ok for r in results)
    assert lines == ["Waiting 10 s, then trying portal, spaces again (2 of 6)\n"]


async def test_an_ipv6_proxy_is_bracketed():
    fake = FakeSmoke()
    await smoke.run(TARGETS[:1], "fd00::6", transport=fake.transport(), attempts=1)
    assert str(fake.requests[0].url) == "https://[fd00::6]/healthz"
    assert fake.requests[0].headers["host"] == "api.uat2.serversherpa.com"


async def test_every_check_gets_its_own_connection_and_tls_handshake():
    """httpcore pools by origin (all checks share https://<proxy_ip>) and
    reads sni_hostname only when it opens a connection, so a reused
    connection would skip the later hosts' SNI and certificate check. With
    the real transport, each check must use a transport (pool) of its own,
    and ask the server not to keep the connection."""
    seen = []
    portal = iter([502, 200])

    async def answer(self, request):
        host = request.headers["host"]
        seen.append((id(self), host, request.headers.get("connection")))
        return httpx.Response(next(portal) if host.startswith("portal.") else 200)

    pools = []
    real_init = httpx.AsyncHTTPTransport.__init__

    def init(self, *a, **kw):
        pools.append(self)                  # kept alive so ids stay distinct
        real_init(self, *a, **kw)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(httpx.AsyncHTTPTransport, "handle_async_request", answer)
        mp.setattr(httpx.AsyncHTTPTransport, "__init__", init)
        results = await smoke.run(TARGETS, "10.10.48.6", sleep=_no_sleep)
    assert all(r.ok for r in results)
    assert [host for _, host, _ in seen] == [h for _, h in TARGETS] + [TARGETS[1][1]]
    assert len({pool for pool, _, _ in seen}) == 4      # a fresh pool, so a fresh handshake
    assert all(conn == "close" for _, _, conn in seen)


async def _no_sleep(seconds):
    pass


HOME = [("home", "uat2.serversherpa.com")]


async def _home(fake):
    return (await smoke.run(HOME, "10.10.48.6", transport=fake.transport(), attempts=1))[0]


async def test_the_bare_name_passes_only_as_a_302_to_its_portal():
    fake = FakeSmoke()                      # a bare name redirects by default, like NPM
    result = await _home(fake)
    assert (result.ok, result.url, result.detail) == (
        True, "https://uat2.serversherpa.com/", "HTTP 302 to the portal")
    assert fake.requests[0].headers["host"] == "uat2.serversherpa.com"
    for answer in (200, (301, "https://portal.uat2.serversherpa.com/"),
                   (302, "https://elsewhere.example/"),
                   (302, "https://portal.uat2.serversherpa.com.evil.example/"),
                   (302, "")):
        fake.set("uat2.serversherpa.com", answer)
        result = await _home(fake)
        code = answer if isinstance(answer, int) else answer[0]
        assert (result.ok, result.detail) == (
            False, f"HTTP {code}, not a redirect to the portal"), answer


async def test_a_service_name_still_passes_on_any_2xx_or_3xx():
    fake = FakeSmoke()
    fake.set("portal.uat2.serversherpa.com", (302, "https://anywhere.example/"))
    results = await _run(fake, attempts=1)
    assert [r.ok for r in results] == [True, True, True]
