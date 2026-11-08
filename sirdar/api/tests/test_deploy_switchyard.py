"""deploy/switchyard.py against FakeSwitchyard (an httpx MockTransport)."""

import pytest

from sirdar_api.deploy import ConnectFailed, switchyard
from sirdar_api.deploy.integrations import SwitchyardConfig
from sirdar_api.deploy.switchyard import Switchyard, SwitchyardError

from .fake_switchyard import FakeSwitchyard
from .integration_helpers import SY_KEY

CFG = SwitchyardConfig(url="https://switchyard.lan:8443", api_key=SY_KEY)
BODY = {"type": "proxy", "enabled": True, "domains": ["api.uat2.serversherpa.com"],
        "tls_mode": "auto", "force_https": True, "hsts": False, "notes": "x",
        "upstreams": [{"scheme": "http", "host": "10.10.48.63", "port": 8100}]}


def _client(fake, sleeps=None) -> Switchyard:
    async def sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)
    return Switchyard(CFG, transport=fake.transport(), sleep=sleep)


async def test_reads_send_the_key_as_a_bearer_token():
    fake = FakeSwitchyard()
    hid = fake.add_host("api.uat.serversherpa.com", "10.10.48.63", 8000, notes="by hand")
    async with _client(fake) as api:
        status = await api.status()
        hosts = await api.hosts()
        one = await api.host(hid)
    assert status == {"version": "1.4.0", "caddy_reachable": True}
    assert [(h.id, h.type, h.domains, h.upstreams, h.notes) for h in hosts] == [
        (hid, "proxy", ("api.uat.serversherpa.com",),
         (switchyard.Upstream("http", "10.10.48.63", 8000),), "by hand")]
    assert one.raw["load_balancing"] == "round_robin"
    assert "certs" not in one.raw
    first = fake.requests[0]
    assert str(first.url) == "https://switchyard.lan:8443/api/status"
    assert first.headers["authorization"] == f"Bearer {SY_KEY}"


async def test_a_bad_key_and_a_missing_permission_are_our_copy():
    async with _client(FakeSwitchyard(key="sy_other")) as api:
        with pytest.raises(SwitchyardError) as e:
            await api.hosts()
    assert e.value.reason == "Switchyard rejected the API key."
    assert e.value.code == "invalid_api_key"
    assert SY_KEY not in str(e.value)
    async with _client(FakeSwitchyard(permissions={"status.get"})) as api:
        with pytest.raises(SwitchyardError) as e:
            await api.hosts()
    assert e.value.reason == ("Switchyard's API key doesn't have the hosts.list permission. "
                              "Add it to the key in Switchyard.")
    assert e.value.code == "missing_permission"


async def test_unreachable():
    fake = FakeSwitchyard()
    fake.down = True
    async with _client(fake) as api:
        with pytest.raises(SwitchyardError) as e:
            await api.status()
    assert e.value.reason == "Couldn't reach Switchyard."


async def test_create_update_delete_and_apply():
    fake = FakeSwitchyard()
    async with _client(fake) as api:
        host = await api.create_host(BODY)
        assert host.upstreams == (switchyard.Upstream("http", "10.10.48.63", 8100),)
        assert fake.applied == {}                   # staged only
        got = await api.host(host.id)
        moved = await api.update_host(host.id, {**got.raw, "upstreams": [
            {"scheme": "http", "host": "10.10.48.64", "port": 8100}]})
        assert moved.upstreams[0].host == "10.10.48.64"
        await api.apply("Sirdar: uat2 proxy hosts")
        assert fake.applies == ["Sirdar: uat2 proxy hosts"]
        assert fake.applied[host.id]["upstreams"][0]["host"] == "10.10.48.64"
        assert await api.delete_host(host.id) is True
        assert await api.delete_host(host.id) is False      # already gone
    assert fake.hosts == {}


async def test_a_domain_in_use_and_a_refused_field_carry_switchyards_message():
    fake = FakeSwitchyard()
    fake.add_host("api.uat2.serversherpa.com")
    async with _client(fake) as api:
        with pytest.raises(SwitchyardError) as e:
            await api.create_host(BODY)
    assert e.value.status == 409
    assert e.value.reason == ("Switchyard refused the change: api.uat2.serversherpa.com is "
                              "already used by another host")


async def test_validation_fields_are_named():
    fake = FakeSwitchyard()
    async with _client(fake) as api:
        with pytest.raises(SwitchyardError) as e:
            await api.create_host({**BODY, "upstreams": []})
    assert e.value.reason == ("Switchyard refused the change: Fix the highlighted fields. "
                              "(upstreams: add at least one upstream)")


async def test_caddy_rejecting_an_apply_says_the_old_config_stays():
    fake = FakeSwitchyard()
    fake.reject_apply = "loading new config: http.handlers.reverse_proxy: bad upstream"
    async with _client(fake) as api:
        with pytest.raises(SwitchyardError) as e:
            await api.apply("Sirdar: uat2 proxy hosts")
    assert e.value.status == 422
    assert e.value.reason == ("Caddy refused the change and kept the old config: loading new "
                              "config: http.handlers.reverse_proxy: bad upstream")


async def test_certificates():
    fake = FakeSwitchyard()
    fake.add_host("api.uat2.serversherpa.com")
    fake.add_host("portal.uat2.serversherpa.com")
    fake.issue("api.uat2.serversherpa.com")
    fake.cert_errors["portal.uat2.serversherpa.com"] = "challenge failed"
    async with _client(fake) as api:
        rows = await api.certificates()
    assert [(c.domain, c.state, c.ready, c.error) for c in rows] == [
        ("api.uat2.serversherpa.com", "valid", True, ""),
        ("portal.uat2.serversherpa.com", "pending", False, "challenge failed")]


async def test_waiting_for_certificates_polls_until_every_name_is_covered():
    fake = FakeSwitchyard()
    fake.add_host("api.uat2.serversherpa.com")
    fake.add_host("portal.uat2.serversherpa.com")
    fake.issue("api.uat2.serversherpa.com")
    sleeps, lines = [], []

    async def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            fake.issue("portal.uat2.serversherpa.com")

    async with Switchyard(CFG, transport=fake.transport(), sleep=sleep) as api:
        await api.wait_for_certificates(["api.uat2.serversherpa.com",
                                         "portal.uat2.serversherpa.com"], lines.append)
    assert sleeps == [switchyard.CERT_POLL, switchyard.CERT_POLL]
    assert fake.retries == 0
    assert lines[0] == "Waiting for Caddy's certificate for portal.uat2.serversherpa.com\n"
    assert lines[-1] == "portal.uat2.serversherpa.com: certificate in place\n"


async def test_a_failed_certificate_is_retried_once():
    fake = FakeSwitchyard()
    fake.add_host("api.uat2.serversherpa.com")
    fake.cert_errors["api.uat2.serversherpa.com"] = "acme: challenge failed"
    fake.issue_on_retry = True
    lines = []
    async with _client(fake) as api:
        await api.wait_for_certificates(["api.uat2.serversherpa.com"], lines.append)
    assert fake.retries == 1
    assert "api.uat2.serversherpa.com: Caddy couldn't get the certificate yet; asking it to " \
           "try again\n" in lines


async def test_waiting_times_out_with_our_copy():
    fake = FakeSwitchyard()
    fake.add_host("api.uat2.serversherpa.com")
    fake.cert_errors["api.uat2.serversherpa.com"] = "acme: challenge failed"
    sleeps = []
    async with _client(fake, sleeps) as api:
        with pytest.raises(SwitchyardError) as e:
            await api.wait_for_certificates(["api.uat2.serversherpa.com"], lambda _: None)
    assert sum(sleeps) == switchyard.CERT_TIMEOUT
    assert fake.retries == 1
    assert e.value.reason == (
        "Caddy didn't get a certificate for api.uat2.serversherpa.com within 5 minutes. Check "
        "that the name resolves to the public IP and that ports 80 and 443 reach Switchyard, "
        "then retry.")


async def test_test_connection_reads_status_and_hosts():
    fake = FakeSwitchyard()
    fake.add_host("api.uat.serversherpa.com")
    result = await switchyard.test_connection(CFG, transport=fake.transport())
    assert result.ok and result.target == "switchyard"
    assert [(c.label, c.status, c.value) for c in result.checks] == [
        ("Reachable", "pass", "Switchyard 1.4.0"), ("Caddy", "pass", "Running"),
        ("API key", "pass", "Can read hosts"), ("Hosts", "pass", "1")]
    assert SY_KEY not in str(result.as_dict())


async def test_test_connection_reports_caddy_down_as_a_warning():
    fake = FakeSwitchyard()
    fake.caddy_reachable = False
    result = await switchyard.test_connection(CFG, transport=fake.transport())
    assert ("Caddy", "warn", "Switchyard can't reach Caddy") in [
        (c.label, c.status, c.value) for c in result.checks]


@pytest.mark.parametrize("fake, reason", [
    (FakeSwitchyard(key="sy_other"), "Switchyard rejected the API key."),
    (FakeSwitchyard(permissions={"status.get"}),
     ("Switchyard's API key doesn't have the hosts.list permission. Add it to the key in "
      "Switchyard.")),
    (FakeSwitchyard(permissions=set()),
     ("Switchyard's API key doesn't have the status.get permission. Add it to the key in "
      "Switchyard.")),
])
async def test_test_connection_failures(fake, reason):
    with pytest.raises(ConnectFailed) as e:
        await switchyard.test_connection(CFG, transport=fake.transport())
    assert e.value.reason == reason


async def test_test_connection_unreachable():
    fake = FakeSwitchyard()
    fake.down = True
    with pytest.raises(ConnectFailed) as e:
        await switchyard.test_connection(CFG, transport=fake.transport())
    assert e.value.reason == "Couldn't reach Switchyard."
