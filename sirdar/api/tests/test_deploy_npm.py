from datetime import UTC, datetime, timedelta

import pytest

from sirdar_api.deploy import ConnectFailed, npm
from sirdar_api.deploy.integrations import NpmConfig
from sirdar_api.deploy.npm import Certificate, Npm, NpmError

from .fake_npm import FakeNpm
from .integration_helpers import NPM_PASSWORD

CFG = NpmConfig(url="http://10.10.48.6:81", identity="admin@example.com",
                letsencrypt_email="ops@example.com", password=NPM_PASSWORD)
NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)


def _client(fake, sleeps=None, **kw) -> Npm:
    async def sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)
    return Npm(CFG, transport=fake.transport(), sleep=sleep, **kw)


async def test_login_and_reads():
    fake = FakeNpm(now=NOW)
    hid = fake.add_host("api.uat.serversherpa.com", "10.10.48.63", 8000, certificate_id=7)
    cid = fake.add_cert(["*.uat.serversherpa.com"], days=45)
    async with _client(fake) as api:
        assert await api.version() == "2.12.3"
        hosts = await api.proxy_hosts()
        certs = await api.certificates()
    assert [(h.id, h.domain_names, h.forward_host, h.forward_port, h.certificate_id)
            for h in hosts] == [(hid, ("api.uat.serversherpa.com",), "10.10.48.63", 8000, 7)]
    assert hosts[0].raw["meta"]["nginx_online"] is True
    assert [(c.id, c.provider, c.domain_names) for c in certs] == [
        (cid, "letsencrypt", ("*.uat.serversherpa.com",))]
    assert npm.days_left(certs[0], NOW) == pytest.approx(45)
    login = fake.requests[0]
    assert (login.method, str(login.url)) == ("POST", "http://10.10.48.6:81/api/tokens")
    assert all(NPM_PASSWORD not in r.headers.get("authorization", "") for r in fake.requests)


async def test_a_wrong_password_is_our_copy():
    fake = FakeNpm(secret="something-else")
    with pytest.raises(NpmError) as e:
        async with _client(fake):
            pass
    assert e.value.reason == "Nginx Proxy Manager rejected the login."
    assert NPM_PASSWORD not in str(e.value)


async def test_an_expired_token_logs_in_again_once():
    fake = FakeNpm()
    async with _client(fake) as api:
        fake.expire_tokens = True
        assert await api.proxy_hosts() == []
    assert fake.logins() == 2


async def test_unreachable():
    fake = FakeNpm()
    fake.down = True
    with pytest.raises(NpmError) as e:
        async with _client(fake):
            pass
    assert e.value.reason == "Couldn't reach Nginx Proxy Manager."


async def test_hosts_create_update_delete():
    fake = FakeNpm()
    async with _client(fake) as api:
        host = await api.create_host({"domain_names": ["api.uat2.serversherpa.com"],
                                      "forward_scheme": "http", "forward_host": "10.10.48.63",
                                      "forward_port": 8100, "allow_websocket_upgrade": True})
        assert (host.forward_port, host.allow_websocket_upgrade) == (8100, True)
        moved = await api.update_host(host.id, {**{k: host.raw[k] for k in npm.HOST_FIELDS},
                                                "forward_port": 8101})
        assert moved.forward_port == 8101
        with pytest.raises(NpmError) as e:
            await api.update_host(host.id, {"enabled": False})
        assert e.value.reason == "Nginx Proxy Manager answered with HTTP 400."
        assert await api.delete_host(host.id) is True
        assert await api.delete_host(host.id) is False


async def test_a_certificate_request_waits_out_certbot():
    fake = FakeNpm()
    fake.certbot_busy, fake.challenge_fails = 2, 1
    sleeps, lines = [], []
    async with _client(fake, sleeps) as api:
        cert = await api.request_certificate("api.uat2.serversherpa.com", "ops@example.com",
                                             out=lines.append)
    assert cert.domain_names == ("api.uat2.serversherpa.com",)
    assert sleeps == [30, 60, 120]
    assert lines == [
        "api.uat2.serversherpa.com: Certbot is busy (NPM's hourly renewal); trying again in 30 s\n",
        "api.uat2.serversherpa.com: Certbot is busy (NPM's hourly renewal); trying again in 60 s\n",
        "api.uat2.serversherpa.com: Let's Encrypt couldn't check the name yet; trying again in "
        "120 s\n",
    ]
    body = fake.requests[-1].read()
    assert b'"letsencrypt_email":"ops@example.com"' in body.replace(b" ", b"")
    assert b'"dns_challenge":false' in body.replace(b" ", b"")


async def test_a_certificate_request_gives_up_after_the_backoff():
    fake = FakeNpm()
    fake.certbot_busy = 99
    sleeps = []
    with pytest.raises(NpmError) as e:
        async with _client(fake, sleeps) as api:
            await api.request_certificate("api.uat2.serversherpa.com", "ops@example.com")
    assert sleeps == [30, 60, 120, 240]
    assert len(fake.cert_requests) == 5
    assert e.value.reason == (
        "Nginx Proxy Manager couldn't get a certificate for api.uat2.serversherpa.com. Check "
        "that the name resolves to the public IP and that port 80 reaches the proxy, then "
        "retry.")


async def test_renew_and_delete_certificates():
    fake = FakeNpm(now=NOW)
    cid = fake.add_cert(["api.uat.serversherpa.com"], days=5)
    fake.certbot_busy = 1
    sleeps = []
    async with _client(fake, sleeps) as api:
        renewed = await api.renew_certificate(cid, "api.uat.serversherpa.com")
        assert npm.days_left(renewed, NOW) == pytest.approx(90)
        assert await api.delete_certificate(cid) is True
        assert await api.delete_certificate(cid) is False
    assert (fake.renewed, sleeps) == ([cid], [30])


def test_covers_and_expiry_parsing():
    cert = Certificate(id=1, provider="letsencrypt", domain_names=("*.uat.serversherpa.com",),
                       expires_on=None)
    assert npm.covers(cert, "api.uat.serversherpa.com")
    assert not npm.covers(cert, "api.uat2.serversherpa.com")
    assert not npm.covers(cert, "a.b.uat.serversherpa.com")
    assert npm.days_left(cert, NOW) is None
    assert npm.parse_expiry("2026-12-30 10:00:00") == datetime(2026, 12, 30, 10, tzinfo=UTC)
    assert npm.parse_expiry("2026-12-30T10:00:00.000Z") == datetime(2026, 12, 30, 10,
                                                                    tzinfo=UTC)
    assert npm.parse_expiry("") is None and npm.parse_expiry("soon") is None


async def test_connection_test():
    fake = FakeNpm(now=NOW)
    fake.add_host("api.uat.serversherpa.com", "10.10.48.63", 8000)
    fake.add_cert(["api.uat.serversherpa.com"], days=80)
    fake.add_cert(["kiosk.uat.serversherpa.com"], days=10)
    result = await npm.test_connection(CFG, transport=fake.transport(), now=NOW)
    assert result.target == "npm"
    assert [(c.label, c.status, c.value) for c in result.checks] == [
        ("Login", "pass", "admin@example.com"), ("Version", "pass", "2.12.3"),
        ("Proxy hosts", "pass", "1"),
        ("Certificates", "warn", "2, 1 expiring within 30 days"),
    ]
    assert result.facts == {"url": "http://10.10.48.6:81", "version": "2.12.3",
                            "proxy_hosts": 1, "certificates": 2}
    fake.secret = "changed-password"
    with pytest.raises(ConnectFailed) as e:
        await npm.test_connection(CFG, transport=fake.transport())
    assert e.value.reason == "Nginx Proxy Manager rejected the login."


def test_expiry_math_is_in_days():
    later = NOW + timedelta(days=31, hours=12)
    cert = Certificate(id=1, provider="other", domain_names=("x.y.z",), expires_on=later)
    assert npm.days_left(cert, NOW) == pytest.approx(31.5)
