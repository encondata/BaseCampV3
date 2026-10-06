"""deploy/do_api.py against FakeDigitalOcean: the token travels only in the
Authorization header, errors are our own copy (DigitalOcean's message, which
may echo the request, never shows), a 404 reads as "gone", a 429 is retried
once, and lists follow pages."""

import httpx
import pytest

from sirdar_api.deploy import do_api, outbound
from sirdar_api.deploy.do_api import DoError, DoForbidden

from .fake_digitalocean import DO_TOKEN, RENEW_TOKEN, FakeDigitalOcean


@pytest.fixture
def fake(monkeypatch):
    fake = FakeDigitalOcean()
    monkeypatch.setattr(outbound, "transports", lambda: {k: None for k in outbound.KINDS}
                        | {"digitalocean": fake.transport()})
    return fake


async def test_account_and_the_token_header(fake):
    async with do_api.connect(DO_TOKEN) as api:
        account = await api.account()
    assert account["team"]["uuid"] == "team-prod-0001"
    request = fake.requests[0]
    assert request.headers["authorization"] == f"Bearer {DO_TOKEN}"
    assert DO_TOKEN not in str(request.url)


async def test_a_bad_token_is_our_copy():
    with pytest.raises(DoError) as err:
        async with do_api.connect("nope", transport=FakeDigitalOcean().transport()) as api:
            await api.account()
    assert err.value.reason == "DigitalOcean rejected the API token."
    assert err.value.status == 401


async def test_errors_never_carry_digitalocean_text(fake):
    fake.fail[("POST", "/vpcs")] = 422          # the fake's message echoes the token
    with pytest.raises(DoError) as err:
        async with do_api.connect(DO_TOKEN) as api:
            await api.create_vpc("ss-uat9", "nyc3", "sirdar:x")
    assert err.value.reason == ("DigitalOcean refused the request (unprocessable_entity, "
                                "HTTP 422).")
    assert DO_TOKEN not in repr(err.value)


async def test_gone_reads_as_none_or_false(fake):
    async with do_api.connect(DO_TOKEN) as api:
        assert await api.droplet("999") is None
        assert await api.delete_droplet("999") is False
        assert await api.certificate("nope") is None


async def test_a_scoped_token_is_forbidden_elsewhere(fake):
    async with do_api.connect(RENEW_TOKEN) as api:
        assert await api.load_balancer("nope") is None        # in scope: a plain 404
        with pytest.raises(DoForbidden):
            await api.droplets_tagged("sirdar")


async def test_429_is_retried_once():
    calls = {"n": 0}
    slept: list[float] = []

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "3"})
        return httpx.Response(200, json={"account": {"uuid": "u"}})

    async def sleep(s):
        slept.append(s)

    async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler),
                              sleep=sleep) as api:
        assert (await api.account())["uuid"] == "u"
    assert slept == [3.0]


async def test_lists_follow_pages():
    def handler(request):
        page = request.url.params.get("page", "1")
        nxt = {"pages": {"next": "https://api.digitalocean.com/v2/droplets?page=2"}} \
            if page == "1" else {}
        return httpx.Response(200, json={"droplets": [{"id": int(page)}], "links": nxt})

    async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler)) as api:
        assert [d["id"] for d in await api.droplets_tagged("sirdar")] == [1, 2]


async def test_droplet_ips_and_readiness(fake):
    fake.boot_polls = 2
    async with do_api.connect(DO_TOKEN) as api:
        made = await api.create_droplet({"name": "ss-uat9-orange", "region": "nyc3",
                                         "size": "s-2vcpu-4gb", "image": "ubuntu-24-04-x64",
                                         "tags": ["sirdar"], "user_data": "#cloud-config\n"})
        assert do_api.droplet_ips(made) == (None, None)
        first = await api.droplet(str(made["id"]))
        assert first["status"] == "new"
        second = await api.droplet(str(made["id"]))
    assert second["status"] == "active"
    public, private = do_api.droplet_ips(second)
    assert public == "127.0.0.1" and private.startswith("10.116.0.")


async def test_database_firewall_and_ca(fake):
    async with do_api.connect(DO_TOKEN) as api:
        made = await api.create_database({"name": "ss-uat9-db", "engine": "pg", "version": "16",
                                          "region": "nyc3", "size": "db-s-2vcpu-4gb",
                                          "num_nodes": 1, "tags": ["sirdar"]})
        await api.set_database_firewall(made["id"], ["4001", "4002"])
        assert await api.database_firewall(made["id"]) == [
            {"type": "droplet", "value": "4001"}, {"type": "droplet", "value": "4002"}]
        assert (await api.database_ca(made["id"])).startswith("-----BEGIN CERTIFICATE-----")


async def test_unreachable_is_our_copy(fake):
    fake.down = True
    with pytest.raises(DoError) as err:
        async with do_api.connect(DO_TOKEN) as api:
            await api.account()
    assert err.value.reason == "Couldn't reach the DigitalOcean API."
