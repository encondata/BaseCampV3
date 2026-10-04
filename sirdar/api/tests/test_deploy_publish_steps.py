from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import ManagedRecord
from sirdar_api.deploy import publish
from sirdar_api.deploy.publish import CERT, DNS, PROXY, StepFailed

from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import CF_TOKEN, NPM_PASSWORD, configure
from .publish_helpers import PUBLIC_IP, managed, publish_fakes  # noqa: F401

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)
NAMES = [f"{s}.uat2.serversherpa.com" for s in
         ("api", "portal", "kiosk", "wiki", "spaces", "status")]
PORTS = {"api": 8000, "portal": 8091, "kiosk": 8090, "wiki": 8096, "spaces": 9000,
         "status": 8095}


@pytest.fixture
async def env(db, secrets_key, publish_fakes):
    publish_fakes.npm.now = NOW
    await configure(db)
    return await make_environment(db, name="uat2", host="10.10.48.63")


def _publisher(sleeps=None, **kw) -> publish.HttpPublisher:
    async def sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)
    return publish.HttpPublisher(sleep=sleep, now=lambda: NOW, **kw)


async def _run(db, env, step, publisher=None) -> list[str]:
    ctx = await publish.prepare(db, env, get_settings())
    lines: list[str] = []
    await (publisher or _publisher()).run(step, ctx, lines.append)
    text = "".join(lines)
    assert CF_TOKEN not in text and NPM_PASSWORD not in text
    return lines


async def _rows(db) -> list[tuple]:
    rows = await db.scalars(select(ManagedRecord)
                            .order_by(ManagedRecord.service, ManagedRecord.kind)
                            .execution_options(populate_existing=True))
    return [(r.service, r.kind, r.external_id, r.origin) for r in rows]


def _writes(fake_npm) -> list[tuple[str, str]]:
    return [(r.method, r.url.path) for r in fake_npm.requests
            if r.method != "GET" and r.url.path != "/api/tokens"]


# ---- step 12: DNS -------------------------------------------------------------------

async def test_dns_creates_every_record_and_records_ownership(db, env, publish_fakes):
    cf = publish_fakes.cf
    lines = await _run(db, env, "dns")
    made = {r["name"]: r for r in cf.records.values()}
    assert sorted(made) == sorted(NAMES)
    api = made["api.uat2.serversherpa.com"]
    assert (api["type"], api["content"], api["proxied"], api["comment"]) == (
        "A", PUBLIC_IP, False, "Managed by Sirdar (uat2/api)")
    assert lines[0] == "api.uat2.serversherpa.com: created A 203.0.113.7\n"
    assert [(s, k, o) for s, k, _, o in await _rows(db)] == sorted(
        (s, DNS, "created") for s in PORTS)
    before = len(cf.writes())
    again = await _run(db, env, "dns")
    assert len(cf.writes()) == before
    assert again[0] == "api.uat2.serversherpa.com: A 203.0.113.7, unchanged\n"


async def test_dns_corrects_drift_on_managed_and_claimed_records(db, env, publish_fakes):
    cf = publish_fakes.cf
    mine = cf.add("A", "api.uat2.serversherpa.com", "198.51.100.1",
                  comment="Managed by Sirdar (uat2/api)")
    theirs = cf.add("A", "portal.uat2.serversherpa.com", "198.51.100.1", comment="by hand")
    await managed(db, env, "api", DNS, mine)
    await managed(db, env, "portal", DNS, theirs, origin="claimed")
    lines = await _run(db, env, "dns")
    assert cf.records[mine]["content"] == PUBLIC_IP
    assert (cf.records[theirs]["content"], cf.records[theirs]["comment"]) == (PUBLIC_IP,
                                                                              "by hand")
    assert "portal.uat2.serversherpa.com: updated to A 203.0.113.7\n" in lines
    rows = {(s, k): (e, o) for s, k, e, o in await _rows(db)}
    assert rows[("portal", DNS)] == (theirs, "claimed")


async def test_dns_blockers_change_nothing(db, env, publish_fakes):
    cf = publish_fakes.cf
    cf.add("A", "api.uat2.serversherpa.com", "198.51.100.1")
    cf.add("CNAME", "kiosk.uat2.serversherpa.com", "elsewhere.example.com")
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "dns")
    assert e.value.reason == (
        "Sirdar changed nothing: these DNS records are in the way.\n"
        "  api.uat2.serversherpa.com: A 198.51.100.1, made outside Sirdar.\n"
        "  kiosk.uat2.serversherpa.com: A CNAME record already uses this name.\n"
        "Claim the existing ones on the Publish tab, or remove them by hand, then retry.")
    assert cf.writes() == [] and await _rows(db) == []


async def test_dns_moves_records_off_an_old_name(db, env, publish_fakes):
    cf = publish_fakes.cf
    old_mine = cf.add("A", "api.old.serversherpa.com", PUBLIC_IP)
    old_theirs = cf.add("A", "portal.old.serversherpa.com", PUBLIC_IP)
    await managed(db, env, "api", DNS, old_mine, name="api.old.serversherpa.com")
    await managed(db, env, "portal", DNS, old_theirs, origin="claimed",
                  name="portal.old.serversherpa.com")
    lines = await _run(db, env, "dns")
    assert old_mine not in cf.records and old_theirs in cf.records
    assert "api.old.serversherpa.com: deleted the A record\n" in lines
    assert "portal.old.serversherpa.com: left in place (claimed, not made by Sirdar)\n" in lines
    assert {e for _, _, e, _ in await _rows(db)}.isdisjoint({old_mine, old_theirs})


async def test_dns_needs_cloudflare(db, secrets_key, publish_fakes):
    env = await make_environment(db, name="uat2", host="10.10.48.63")
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "dns")
    assert e.value.reason == ("Cloudflare isn't set up. Add it in Settings › Integrations, or "
                              "turn Publish off for this environment.")


async def test_upstream_errors_become_step_failures(db, env, publish_fakes):
    publish_fakes.cf.down = True
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "dns")
    assert e.value.reason == "Couldn't reach the Cloudflare API."
    with pytest.raises(ValueError):
        await _run(db, env, "build")


# ---- step 13: proxy hosts and certificates ---------------------------------------------

async def test_proxy_creates_hosts_with_certificates(db, env, publish_fakes):
    proxy = publish_fakes.npm
    lines = await _run(db, env, "proxy")
    hosts = {h["domain_names"][0]: h for h in proxy.hosts.values()}
    assert sorted(hosts) == sorted(NAMES)
    for service, port in PORTS.items():
        h = hosts[f"{service}.uat2.serversherpa.com"]
        assert (h["forward_scheme"], h["forward_host"], h["forward_port"]) == (
            "http", "10.10.48.63", port)
        assert (h["allow_websocket_upgrade"], h["block_exploits"], h["ssl_forced"],
                h["http2_support"]) == (True, True, True, True)
        assert proxy.certs[h["certificate_id"]]["domain_names"] == [h["domain_names"][0]]
        assert h["advanced_config"] == ("client_max_body_size 0;" if service == "spaces" else "")
    assert sorted(proxy.cert_requests) == sorted([n] for n in NAMES)
    assert lines[:3] == [
        "api.uat2.serversherpa.com: created a proxy host to 10.10.48.63:8000\n",
        "api.uat2.serversherpa.com: requesting a Let's Encrypt certificate\n",
        f"api.uat2.serversherpa.com: HTTPS with certificate "
        f"#{hosts['api.uat2.serversherpa.com']['certificate_id']}, Force SSL on\n"]
    kinds = [(s, k, o) for s, k, _, o in await _rows(db)]
    assert kinds == sorted([(s, k, "created") for s in PORTS for k in (CERT, PROXY)])
    writes = len(_writes(proxy))
    again = await _run(db, env, "proxy")
    assert len(_writes(proxy)) == writes
    assert again[0] == "api.uat2.serversherpa.com: proxy host to 10.10.48.63:8000, unchanged\n"


async def test_proxy_reuses_renews_and_keeps_claimed_fields(db, env, publish_fakes):
    proxy = publish_fakes.npm
    wildcard = proxy.add_cert(["*.uat2.serversherpa.com"], days=80)
    expiring = proxy.add_cert(["api.uat2.serversherpa.com"], days=10)
    api_host = proxy.add_host("api.uat2.serversherpa.com", "10.10.48.63", 7999,
                              certificate_id=expiring, ssl_forced=True, http2_support=True,
                              allow_websocket_upgrade=True, advanced_config="# by hand",
                              access_list_id=3)
    await managed(db, env, "api", PROXY, api_host, origin="claimed")
    lines = await _run(db, env, "proxy")
    assert proxy.renewed == [expiring]
    assert proxy.cert_requests == []                        # the wildcard covers the rest
    h = proxy.hosts[api_host]
    assert (h["forward_port"], h["advanced_config"], h["access_list_id"],
            h["certificate_id"]) == (8000, "# by hand", 3, expiring)
    assert {proxy.hosts[i]["certificate_id"] for i in proxy.hosts if i != api_host} == {wildcard}
    assert "api.uat2.serversherpa.com: proxy host now goes to 10.10.48.63:8000\n" in lines
    assert f"portal.uat2.serversherpa.com: using certificate #{wildcard}\n" in lines
    rows = {(s, k): o for s, k, _, o in await _rows(db)}
    assert rows[("api", PROXY)] == "claimed" and ("api", CERT) not in rows


async def test_proxy_waits_out_a_busy_certbot(db, env, publish_fakes):
    publish_fakes.npm.certbot_busy = 1
    sleeps: list = []
    lines = await _run(db, env, "proxy", _publisher(sleeps))
    assert sleeps == [30]
    assert ("api.uat2.serversherpa.com: Certbot is busy (NPM's hourly renewal); trying again "
            "in 30 s\n") in lines


async def test_proxy_blockers_change_nothing(db, env, publish_fakes):
    proxy = publish_fakes.npm
    proxy.add_host("kiosk.uat2.serversherpa.com", "10.10.48.63", 8090)
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "proxy")
    assert "kiosk.uat2.serversherpa.com: To 10.10.48.63:8090, made outside Sirdar." in (
        e.value.reason)
    assert _writes(proxy) == [] and await _rows(db) == []


# ---- step 14: smoke test ---------------------------------------------------------------

async def test_smoke_passes_and_fails(db, env, publish_fakes):
    lines = await _run(db, env, "smoke")
    assert lines[0] == "https://api.uat2.serversherpa.com/healthz: HTTP 200\n"
    assert {r.url.host for r in publish_fakes.smoke.requests} == {"10.0.0.2"}
    publish_fakes.smoke.set("portal.uat2.serversherpa.com", 502)
    sleeps: list = []
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "smoke", _publisher(sleeps, smoke_attempts=2))
    assert e.value.reason == "1 of 6 public URLs didn't answer: portal."
    assert sleeps == [10]


# ---- steps 16 and 17: removal ------------------------------------------------------------

async def test_remove_deletes_only_what_sirdar_created(db, env, publish_fakes):
    cf, proxy = publish_fakes.cf, publish_fakes.npm
    await _run(db, env, "dns")
    await _run(db, env, "proxy")
    hand_record = cf.add("A", "mail.uat2.serversherpa.com", PUBLIC_IP)
    claimed_host = proxy.add_host("mail.uat2.serversherpa.com", "10.10.48.63", 8025)
    await managed(db, env, "mailpit", PROXY, claimed_host, origin="claimed",
                  name="mail.uat2.serversherpa.com")
    lines = await _run(db, env, "unproxy")
    assert list(proxy.hosts) == [claimed_host] and proxy.certs == {}
    assert ("mail.uat2.serversherpa.com: left the proxy host in place (claimed, not made by "
            "Sirdar)\n") in lines
    assert {k for _, k, _, _ in await _rows(db)} == {DNS}
    gone = next(rid for rid, r in cf.records.items() if r["name"].startswith("api."))
    del cf.records[gone]
    lines = await _run(db, env, "undns")
    assert list(cf.records) == [hand_record]
    assert "api.uat2.serversherpa.com: already gone\n" in lines
    assert await _rows(db) == []
    assert await _run(db, env, "undns") == ["No DNS records to remove.\n"]
    assert await _run(db, env, "unproxy") == ["No proxy hosts or certificates to remove.\n"]


async def test_removing_only_claimed_entries_needs_no_credentials(db, secrets_key,
                                                                  publish_fakes):
    env = await make_environment(db, name="uat2", host="10.10.48.63")
    await managed(db, env, "api", DNS, "rec-9", origin="claimed")
    await managed(db, env, "api", PROXY, 9, origin="claimed")
    await _run(db, env, "unproxy")
    await _run(db, env, "undns")
    assert await _rows(db) == []
    await managed(db, env, "api", DNS, "rec-9")
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "undns")
    assert e.value.reason == ("Cloudflare isn't set up, so Sirdar can't remove what it made "
                              "there. Add it in Settings › Integrations, then retry.")


def _time_out_after_issuing(publish_fakes, monkeypatch, *, issue: bool):
    """NPM gets (and maybe issues) the api certificate request, but the answer
    never comes back."""
    import httpx

    from sirdar_api.deploy import outbound

    fake = publish_fakes.npm

    def handler(request):
        if (request.method == "POST" and request.url.path == "/api/nginx/certificates"
                and b"api.uat2" in request.content):
            if issue:
                fake.handler(request)
            raise httpx.ReadTimeout("timed out", request=request)
        return fake.handler(request)

    monkeypatch.setattr(outbound, "transports", lambda: {
        "cloudflare": publish_fakes.cf.transport(), "npm": httpx.MockTransport(handler),
        "smoke": publish_fakes.smoke.transport()})


async def test_proxy_keeps_a_certificate_issued_before_a_timeout(db, env, publish_fakes,
                                                                 monkeypatch):
    proxy = publish_fakes.npm
    _time_out_after_issuing(publish_fakes, monkeypatch, issue=True)
    lines = await _run(db, env, "proxy")
    issued = next(c for c, v in proxy.certs.items()
                  if v["domain_names"] == ["api.uat2.serversherpa.com"])
    assert sum(1 for r in proxy.cert_requests if r == ["api.uat2.serversherpa.com"]) == 1
    assert (f"api.uat2.serversherpa.com: the request timed out, but Nginx Proxy Manager issued "
            f"certificate #{issued}\n") in lines
    api = next(h for h in proxy.hosts.values()
               if h["domain_names"] == ["api.uat2.serversherpa.com"])
    assert api["certificate_id"] == issued
    rows = {(s, k): e for s, k, e, _ in await _rows(db)}
    assert rows[("api", CERT)] == str(issued)


async def test_proxy_fails_when_a_timed_out_request_issued_nothing(db, env, publish_fakes,
                                                                   monkeypatch):
    _time_out_after_issuing(publish_fakes, monkeypatch, issue=False)
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "proxy")
    assert e.value.reason == "Nginx Proxy Manager didn't answer in time."
    assert ("api", CERT) not in {(s, k) for s, k, _, _ in await _rows(db)}
