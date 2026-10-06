"""deploy/do_api.py against FakeDigitalOcean: the token travels only in the
Authorization header, errors are our own copy (DigitalOcean's message, which
may echo the request, never shows), a 404 reads as "gone", a 429 is retried
once, and lists follow pages."""

import json
import time

import httpx
import pytest

from sirdar_api.deploy import do_api, outbound
from sirdar_api.deploy.do_api import DoError, DoForbidden

from .fake_digitalocean import DO_TOKEN, LB_IP, RENEW_TOKEN, FakeDigitalOcean
from .tls_helpers import make_cert


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
        a = str(fake.add_droplet("ss-uat9-orange", ["sirdar"])["id"])
        b = str(fake.add_droplet("ss-uat9-purple", ["sirdar"])["id"])
        await api.set_database_firewall(made["id"], [a, b])
        assert await api.database_firewall(made["id"]) == [
            {"type": "droplet", "value": a}, {"type": "droplet", "value": b}]
        assert (await api.database_ca(made["id"])).startswith("-----BEGIN CERTIFICATE-----")


async def test_unreachable_is_our_copy(fake):
    fake.down = True
    with pytest.raises(DoError) as err:
        async with do_api.connect(DO_TOKEN) as api:
            await api.account()
    assert err.value.reason == "Couldn't reach the DigitalOcean API."


# ---- rate limits, retries, pages ------------------------------------------------------


async def test_a_second_429_is_our_copy():
    slept: list[float] = []

    async def sleep(s):
        slept.append(s)

    transport = httpx.MockTransport(lambda r: httpx.Response(429, headers={"retry-after": "2"}))
    with pytest.raises(DoError) as err:
        async with do_api.connect(DO_TOKEN, transport=transport, sleep=sleep) as api:
            await api.account()
    assert err.value.status == 429
    assert err.value.reason == "DigitalOcean is rate-limiting Sirdar; try again in a few minutes."
    assert slept == [2.0]


@pytest.mark.parametrize(("ahead", "expected"), [(12, 12.0), (500, 30.0), (-5, 0.0)])
async def test_429_without_retry_after_reads_ratelimit_reset(monkeypatch, ahead, expected):
    monkeypatch.setattr(do_api, "_now", lambda: 1_800_000_000.0)
    calls = {"n": 0}
    slept: list[float] = []

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"ratelimit-reset": str(1_800_000_000 + ahead)})
        return httpx.Response(200, json={"account": {"uuid": "u"}})

    async def sleep(s):
        slept.append(s)

    async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler),
                              sleep=sleep) as api:
        await api.account()
    assert slept == [expected]


async def test_429_with_nothing_to_read_waits_the_default():
    calls = {"n": 0}
    slept: list[float] = []

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"ratelimit-reset": "soon"})
        return httpx.Response(200, json={"account": {"uuid": "u"}})

    async def sleep(s):
        slept.append(s)

    async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler),
                              sleep=sleep) as api:
        await api.account()
    assert slept == [do_api.RETRY_AFTER_DEFAULT]


def test_ratelimit_reset_uses_the_wall_clock():
    resp = httpx.Response(429, headers={"ratelimit-reset": str(int(time.time()) + 10)})
    assert 8.0 <= do_api._retry_after(resp) <= 10.0


@pytest.mark.parametrize("status", [502, 503, 504])
async def test_a_get_is_retried_once_on_a_gateway_error(status):
    calls = {"n": 0}
    slept: list[float] = []

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(status)
        return httpx.Response(200, json={"account": {"uuid": "u"}})

    async def sleep(s):
        slept.append(s)

    async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler),
                              sleep=sleep) as api:
        assert (await api.account())["uuid"] == "u"
    assert calls["n"] == 2 and len(slept) == 1


async def test_a_get_gives_up_after_one_gateway_retry():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503)

    async def sleep(s):
        pass

    with pytest.raises(DoError) as err:
        async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler),
                                  sleep=sleep) as api:
            await api.account()
    assert calls["n"] == 2
    assert err.value.status == 503


@pytest.mark.parametrize("status", [500, 502, 503, 504])
async def test_a_write_is_never_retried_on_a_server_error(status):
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(status)

    async def sleep(s):
        raise AssertionError("no retry for writes")

    with pytest.raises(DoError) as err:
        async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler),
                                  sleep=sleep) as api:
            await api.create_vpc("ss-uat9", "nyc3", "sirdar:x")
    assert calls["n"] == 1
    assert err.value.status == status


async def test_a_500_get_is_not_retried():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(500)

    with pytest.raises(DoError):
        async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler)) as api:
            await api.account()
    assert calls["n"] == 1


async def test_lists_stop_at_max_pages():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        page = int(request.url.params.get("page", "1"))
        nxt = f"https://api.digitalocean.com/v2/droplets?page={page + 1}"
        return httpx.Response(200, json={"droplets": [{"id": page}],
                                         "links": {"pages": {"next": nxt}}})

    with pytest.raises(DoError) as err:
        async with do_api.connect(DO_TOKEN, transport=httpx.MockTransport(handler)) as api:
            await api.droplets_tagged("sirdar")
    assert err.value.reason == "DigitalOcean listed more than Sirdar reads."
    assert calls["n"] == do_api.MAX_PAGES


async def test_databases_null_reads_as_none():
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json={"databases": None}))
    async with do_api.connect(DO_TOKEN, transport=transport) as api:
        assert await api.databases_tagged("sirdar") == []


# ---- IDs in paths ----------------------------------------------------------------------


@pytest.mark.parametrize("bad", ["", "../account", "a/b", "4001?x=1", "id with space", "é", None])
async def test_ids_in_paths_are_checked(fake, bad):
    async with do_api.connect(DO_TOKEN) as api:
        for call in (api.droplet, api.delete_droplet, api.vpc, api.database_ca,
                     api.certificate, api.load_balancer, api.delete_spaces_key):
            with pytest.raises(DoError) as err:
                await call(bad)
            assert err.value.reason == "Sirdar refused to send a malformed DigitalOcean ID."
    assert fake.requests == []


async def test_numeric_and_uuid_ids_pass(fake):
    async with do_api.connect(DO_TOKEN) as api:
        assert await api.droplet(4001) is None
        assert await api.vpc("5a4f3c1e-9b2d-4e8f-a1b2-c3d4e5f60718") is None
        assert await api.delete_spaces_key("DO00KEY000001") is False


# ---- the fake's stricter rules ------------------------------------------------------------


async def test_database_firewall_wait_is_a_422(fake):
    fake.firewall_wait = 1
    async with do_api.connect(DO_TOKEN) as api:
        made = await api.create_database({"name": "ss-uat9-db", "engine": "pg", "version": "16",
                                          "region": "nyc3", "size": "db-s-2vcpu-4gb",
                                          "num_nodes": 1, "tags": ["sirdar"]})
        d = str(fake.add_droplet("ss-uat9-orange", ["sirdar"])["id"])
        with pytest.raises(DoError) as err:
            await api.set_database_firewall(made["id"], [d])
        assert err.value.status == 422
        assert err.value.reason == ("DigitalOcean refused the request (unprocessable_entity, "
                                    "HTTP 422).")
        await api.set_database_firewall(made["id"], [d])
        assert await api.database_firewall(made["id"]) == [{"type": "droplet", "value": d}]


async def test_database_firewall_refuses_unknown_droplets(fake):
    async with do_api.connect(DO_TOKEN) as api:
        made = await api.create_database({"name": "ss-uat9-db", "engine": "pg", "version": "16",
                                          "region": "nyc3", "size": "db-s-2vcpu-4gb",
                                          "num_nodes": 1, "tags": ["sirdar"]})
        with pytest.raises(DoError) as err:
            await api.set_database_firewall(made["id"], ["999999"])
    assert err.value.status == 422
    assert fake.db_rules[made["id"]] == []


def _droplet_body(**over) -> dict:
    return {"name": "ss-uat9-orange", "region": "nyc3", "size": "s-2vcpu-4gb",
            "image": "ubuntu-24-04-x64", "tags": ["sirdar"], "user_data": "#cloud-config\n",
            **over}


async def test_create_droplet_passes_vpc_and_ssh_keys_through(fake):
    async with do_api.connect(DO_TOKEN) as api:
        vpc = await api.create_vpc("ss-uat9", "nyc3", "sirdar:x")
        made = await api.create_droplet(_droplet_body(vpc_uuid=vpc["id"],
                                                      ssh_keys=["ab:cd:ef", 12345]))
    sent = json.loads(next(r for r in fake.requests
                           if r.method == "POST" and r.url.path == "/v2/droplets").content)
    assert sent["vpc_uuid"] == vpc["id"]
    assert sent["ssh_keys"] == ["ab:cd:ef", 12345]
    assert made["vpc_uuid"] == vpc["id"]
    assert fake.droplets[str(made["id"])]["_ssh_keys"] == ["ab:cd:ef", 12345]


async def test_a_droplet_without_a_vpc_lands_in_the_region_default(fake):
    async with do_api.connect(DO_TOKEN) as api:
        one = await api.create_droplet(_droplet_body())
        two = await api.create_droplet(_droplet_body(name="ss-uat9-purple"))
        default = await api.vpc(one["vpc_uuid"])
    assert one["vpc_uuid"] and one["vpc_uuid"] == two["vpc_uuid"]
    assert default["default"] is True and default["region"] == "nyc3"
    assert fake.vpcs == {}                       # default VPCs aren't Sirdar's


async def test_user_data_over_64_kib_is_refused(fake):
    async with do_api.connect(DO_TOKEN) as api:
        await api.create_droplet(_droplet_body(user_data="x" * 65536))
        with pytest.raises(DoError) as err:
            await api.create_droplet(_droplet_body(name="big", user_data="x" * 65537))
    assert err.value.status == 422
    assert len(fake.droplets) == 1


async def test_a_pending_resize_blocks_power_on(fake):
    fake.action_polls = 2
    d = fake.add_droplet("ss-uat9-orange", ["sirdar"], status="off")
    did = str(d["id"])
    async with do_api.connect(DO_TOKEN) as api:
        action = await api.droplet_action(did, "resize", size="s-4vcpu-8gb")
        assert action["status"] == "in-progress"
        assert fake.droplets[did]["size_slug"] == "s-2vcpu-4gb"
        with pytest.raises(DoError) as err:
            await api.droplet_action(did, "power_on")
        assert err.value.status == 422
        path = f"/droplets/{did}/actions/{action['id']}"
        assert (await api.call("GET", path))["action"]["status"] == "in-progress"
        assert (await api.call("GET", path))["action"]["status"] == "completed"
        assert fake.droplets[did]["size_slug"] == "s-4vcpu-8gb"
        on = await api.droplet_action(did, "power_on")
        assert on["status"] == "in-progress"
        await api.call("GET", f"/droplets/{did}/actions/{on['id']}")
        await api.call("GET", f"/droplets/{did}/actions/{on['id']}")
    assert fake.droplets[did]["status"] == "active"


async def test_actions_complete_at_once_by_default(fake):
    d = fake.add_droplet("ss-uat9-orange", ["sirdar"])
    async with do_api.connect(DO_TOKEN) as api:
        action = await api.droplet_action(str(d["id"]), "power_off")
    assert action["status"] == "completed"
    assert fake.droplets[str(d["id"])]["status"] == "off"


def _lb_body(**over) -> dict:
    return {"name": "ss-uat9-lb", "region": "nyc3", "size_unit": 1,
            "forwarding_rules": [{"entry_protocol": "http", "entry_port": 80,
                                  "target_protocol": "http", "target_port": 80}],
            "health_check": {"protocol": "http", "port": 80, "path": "/healthz"},
            "droplet_ids": [], "redirect_http_to_https": False, **over}


async def test_load_balancer_put_replaces_the_whole_body(fake):
    async with do_api.connect(DO_TOKEN) as api:
        lb = await api.create_load_balancer(_lb_body(sticky_sessions={"type": "none"}))
        updated = await api.update_load_balancer(lb["id"], {
            "name": "ss-uat9-lb", "region": "nyc3",
            "forwarding_rules": _lb_body()["forwarding_rules"]})
    assert updated["droplet_ids"] is None
    assert updated["health_check"] is None
    assert updated["sticky_sessions"] is None
    assert updated["region"] == {"slug": "nyc3"}


async def test_load_balancer_refuses_an_unknown_certificate(fake):
    rules = [{"entry_protocol": "https", "entry_port": 443, "target_protocol": "http",
              "target_port": 80, "certificate_id": "5a4f3c1e-0000-0000-0000-000000000000"}]
    async with do_api.connect(DO_TOKEN) as api:
        with pytest.raises(DoError) as err:
            await api.create_load_balancer(_lb_body(forwarding_rules=rules))
        assert err.value.status == 422
        assert fake.load_balancers == {}
        leaf, key = make_cert("api.uat9.example.com", ips=(), dns=("api.uat9.example.com",))
        cert = await api.create_certificate("ss-uat9-1", key, leaf, leaf)
        rules[0]["certificate_id"] = cert["id"]
        lb = await api.create_load_balancer(_lb_body(forwarding_rules=rules))
        bad = [{**rules[0], "certificate_id": "5a4f3c1e-0000-0000-0000-000000000000"}]
        with pytest.raises(DoError):
            await api.update_load_balancer(lb["id"], _lb_body(forwarding_rules=bad))
    assert fake.load_balancers[lb["id"]]["forwarding_rules"][0]["certificate_id"] == cert["id"]


async def test_load_balancer_refuses_droplet_ids_and_tag_together(fake):
    async with do_api.connect(DO_TOKEN) as api:
        with pytest.raises(DoError) as err:
            await api.create_load_balancer(_lb_body(droplet_ids=[4001], tag="sirdar"))
        assert err.value.status == 422
        lb = await api.create_load_balancer(_lb_body(droplet_ids=None, tag="sirdar"))
        assert lb["tag"] == "sirdar"
        lb2 = await api.load_balancer(lb["id"])
    assert lb2["status"] == "active" and lb2["ip"] == LB_IP
