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
