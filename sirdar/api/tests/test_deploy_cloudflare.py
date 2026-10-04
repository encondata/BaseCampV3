import httpx
import pytest

from sirdar_api.deploy import ConnectFailed, cloudflare
from sirdar_api.deploy.cloudflare import Cloudflare, CloudflareError, RecordGone
from sirdar_api.deploy.integrations import CloudflareConfig

from .fake_cloudflare import ZONE_ID, FakeCloudflare
from .integration_helpers import CF_TOKEN

CFG = CloudflareConfig(zone="serversherpa.com", public_ip="203.0.113.7", token=CF_TOKEN)


async def test_reads_the_whole_zone_page_by_page(monkeypatch):
    fake = FakeCloudflare()
    for i in range(5):
        fake.add("A", f"h{i}.uat.serversherpa.com", "203.0.113.7")
    fake.add("CNAME", "www.serversherpa.com", "serversherpa.com")
    monkeypatch.setattr(cloudflare, "PER_PAGE", 2)
    async with Cloudflare(CFG, transport=fake.transport()) as cf:
        assert await cf.zone_id() == ZONE_ID
        records = await cf.records()
    assert len(records) == 6
    assert records[0].name == "h0.uat.serversherpa.com" and records[-1].type == "CNAME"
    pages = [r.url.params.get("page") for r in fake.requests if r.url.path.endswith("records")]
    assert pages == ["1", "2", "3"]
    assert sum(r.url.path.endswith("/zones") for r in fake.requests) == 1     # cached


async def test_create_update_delete():
    fake = FakeCloudflare()
    async with Cloudflare(CFG, transport=fake.transport()) as cf:
        made = await cf.create_a("api.uat2.serversherpa.com", "203.0.113.7", proxied=False,
                                 comment="Managed by Sirdar (uat2/api)")
        assert (made.type, made.name, made.content, made.proxied) == (
            "A", "api.uat2.serversherpa.com", "203.0.113.7", False)
        assert fake.records[made.id]["ttl"] == 1
        assert fake.records[made.id]["comment"] == "Managed by Sirdar (uat2/api)"
        moved = await cf.update_a(made.id, name=made.name, content="203.0.113.9", proxied=True)
        assert (moved.content, moved.proxied) == ("203.0.113.9", True)
        assert fake.records[made.id]["comment"] == "Managed by Sirdar (uat2/api)"
        assert await cf.delete(made.id) is True
        assert await cf.delete(made.id) is False         # already gone counts as gone
    assert fake.writes() == [("POST", ""), ("PATCH", made.id), ("DELETE", made.id),
                             ("DELETE", made.id)]


async def test_a_zone_the_token_cannot_see():
    fake = FakeCloudflare(zone="example.org")
    with pytest.raises(CloudflareError) as e:
        async with Cloudflare(CFG, transport=fake.transport()) as cf:
            await cf.records()
    assert e.value.reason == "The API token can't see the zone serversherpa.com."


@pytest.mark.parametrize("setup, reason", [
    (lambda f: setattr(f, "token", "another-token-1234567890"),
     "Cloudflare rejected the API token, or it has no access to this zone."),
    (lambda f: setattr(f, "down", True), "Couldn't reach the Cloudflare API."),
])
async def test_errors_are_our_own_copy(setup, reason):
    fake = FakeCloudflare()
    setup(fake)
    with pytest.raises(CloudflareError) as e:
        async with Cloudflare(CFG, transport=fake.transport()) as cf:
            await cf.zone_id()
    assert e.value.reason == reason
    assert CF_TOKEN not in str(e.value)


async def test_a_refused_write_names_cloudflares_error_code_only():
    fake = FakeCloudflare()
    fake.fail_writes = 400
    with pytest.raises(CloudflareError) as e:
        async with Cloudflare(CFG, transport=fake.transport()) as cf:
            await cf.create_a("api.uat2.serversherpa.com", "203.0.113.7", proxied=False,
                              comment="x")
    assert e.value.reason == "Cloudflare refused the request (error 81057)."


async def test_connection_test():
    fake = FakeCloudflare()
    fake.add("A", "api.uat.serversherpa.com", "203.0.113.7")
    fake.add("A", "old.serversherpa.com", "198.51.100.1")
    fake.add("TXT", "serversherpa.com", "v=spf1 -all")
    result = await cloudflare.test_connection(CFG, transport=fake.transport())
    assert result.ok and result.target == "cloudflare"
    assert [(c.label, c.status, c.value) for c in result.checks] == [
        ("Zone", "pass", f"serversherpa.com ({ZONE_ID})"),
        ("DNS records", "pass", "3 records, 2 A"),
        ("Public IP", "pass", "203.0.113.7 · 1 A record points at it"),
    ]
    assert result.facts == {"zone": "serversherpa.com", "zone_id": ZONE_ID, "records": 3,
                            "public_ip": "203.0.113.7", "records_at_public_ip": 1}
    fake.records.clear()
    empty = await cloudflare.test_connection(CFG, transport=fake.transport())
    assert empty.checks[2].status == "warn"
    fake.down = True
    with pytest.raises(ConnectFailed) as e:
        await cloudflare.test_connection(CFG, transport=fake.transport())
    assert e.value.reason == "Couldn't reach the Cloudflare API."


async def test_the_guard_stops_real_requests(no_real_http):
    with pytest.raises(AssertionError, match="real HTTP request to api.cloudflare.com"):
        async with Cloudflare(CFG) as cf:
            await cf.zone_id()
    with pytest.raises(AssertionError, match="real HTTP request to example.com"):
        with httpx.Client() as client:
            client.get("https://example.com/")
    assert no_real_http == ["api.cloudflare.com", "example.com"]
    no_real_http.clear()                    # these two were on purpose


async def test_the_guard_still_fails_a_test_that_swallows_the_error(no_real_http):
    """A catch-all (the pipeline's `except Exception`) can eat the
    AssertionError; the fixture's hit list still fails the test at teardown."""
    try:
        async with httpx.AsyncClient() as client:
            await client.get("https://example.com/")
    except Exception:
        pass
    assert no_real_http == ["example.com"]  # teardown asserts this list is empty
    no_real_http.clear()


async def test_update_converges_ttl_to_auto():
    fake = FakeCloudflare()
    rid = fake.add("A", "api.uat2.serversherpa.com", "203.0.113.7")
    fake.records[rid]["ttl"] = 300          # a record created by hand, then claimed
    async with Cloudflare(CFG, transport=fake.transport()) as cf:
        await cf.update_a(rid, name="api.uat2.serversherpa.com", content="203.0.113.7",
                          proxied=False)
    assert fake.records[rid]["ttl"] == 1


async def test_a_missing_record_is_gone_only_for_update_and_delete():
    fake = FakeCloudflare()
    async with Cloudflare(CFG, transport=fake.transport()) as cf:
        with pytest.raises(RecordGone):
            await cf.update_a("rec-9999", name="x.serversherpa.com", content="203.0.113.7",
                              proxied=False)
        assert await cf.delete("rec-9999") is False


async def test_a_404_elsewhere_is_honest_copy_not_record_gone():
    def handler(request):
        return httpx.Response(404, json={"success": False, "result": None, "messages": [],
                                         "errors": [{"code": 7003, "message": "No route"}]})

    with pytest.raises(CloudflareError) as e:
        async with Cloudflare(CFG, transport=httpx.MockTransport(handler)) as cf:
            await cf.zone_id()
    assert type(e.value) is CloudflareError
    assert e.value.reason == "Cloudflare couldn't find that zone or record."


@pytest.mark.parametrize("code", [6003, 6111, 9109, 10000, 1000])
async def test_auth_error_codes_are_the_token_copy_even_under_400(code):
    def handler(request):
        return httpx.Response(400, json={"success": False, "result": None, "messages": [],
                                         "errors": [{"code": code, "message": "nope"}]})

    with pytest.raises(CloudflareError) as e:
        async with Cloudflare(CFG, transport=httpx.MockTransport(handler)) as cf:
            await cf.zone_id()
    assert e.value.reason == ("Cloudflare rejected the API token, or it has no access to "
                              "this zone.")


@pytest.mark.parametrize("retry_after, waited", [("7", 7.0), ("600", 30.0), (None, 5.0),
                                                 ("soon", 5.0)])
async def test_a_429_is_retried_once_after_retry_after(retry_after, waited):
    fake = FakeCloudflare()
    fake.throttle, fake.retry_after = 1, retry_after
    sleeps: list[float] = []

    async def sleep(seconds):
        sleeps.append(seconds)

    async with Cloudflare(CFG, transport=fake.transport(), sleep=sleep) as cf:
        assert await cf.zone_id() == ZONE_ID
    assert sleeps == [waited]
    assert len(fake.requests) == 2


async def test_a_second_429_is_the_rate_limit_copy():
    fake = FakeCloudflare()
    fake.throttle = 2
    sleeps: list[float] = []

    async def sleep(seconds):
        sleeps.append(seconds)

    with pytest.raises(CloudflareError) as e:
        async with Cloudflare(CFG, transport=fake.transport(), sleep=sleep) as cf:
            await cf.zone_id()
    assert e.value.reason == ("Cloudflare is rate-limiting Sirdar; try again in a few "
                              "minutes.")
    assert sleeps == [7.0] and len(fake.requests) == 2
