import pytest

from sirdar_api.deploy import ConnectFailed, cloudflare
from sirdar_api.deploy.cloudflare import Cloudflare, CloudflareError
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


async def test_the_guard_stops_real_requests():
    with pytest.raises(AssertionError, match="real HTTP request to api.cloudflare.com"):
        async with Cloudflare(CFG) as cf:
            await cf.zone_id()
