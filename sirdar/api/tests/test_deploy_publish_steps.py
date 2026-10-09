import json
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


def _time_out_after_issuing(publish_fakes, monkeypatch, *, issue: bool,
                            no_expiry: bool = False):
    """NPM gets (and maybe issues) the api certificate request, but the answer
    never comes back."""
    import httpx

    from sirdar_api.deploy import outbound

    fake = publish_fakes.npm

    def handler(request):
        if (request.method == "POST" and request.url.path == "/api/nginx/certificates"
                and b"api.uat2" in request.content):
            if issue:
                made = json.loads(fake.handler(request).content)
                if no_expiry:
                    fake.certs[made["id"]]["expires_on"] = None
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
    kinds = {(s, k) for s, k, _, _ in await _rows(db)}
    assert ("api", PROXY) in kinds and ("api", CERT) not in kinds


async def test_proxy_does_not_adopt_an_issued_certificate_without_an_expiry(
        db, env, publish_fakes, monkeypatch):
    _time_out_after_issuing(publish_fakes, monkeypatch, issue=True, no_expiry=True)
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "proxy")
    assert e.value.reason == "Nginx Proxy Manager didn't answer in time."
    assert ("api", CERT) not in {(s, k) for s, k, _, _ in await _rows(db)}


# ---- a certificate a remaining proxy host uses is never deleted --------------------------

async def test_unproxy_keeps_a_certificate_a_claimed_host_still_uses(db, env, publish_fakes):
    proxy = publish_fakes.npm
    claimed_host = proxy.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000)
    await managed(db, env, "api", PROXY, claimed_host, origin="claimed")
    await _run(db, env, "proxy")
    mine = proxy.hosts[claimed_host]["certificate_id"]
    assert mine and {(s, k): o for s, k, _, o in await _rows(db)}[("api", CERT)] == "created"
    lines = await _run(db, env, "unproxy")
    assert list(proxy.hosts) == [claimed_host] and list(proxy.certs) == [mine]
    assert proxy.hosts[claimed_host]["certificate_id"] == mine
    assert (f"api.uat2.serversherpa.com: Certificate #{mine} left in place: proxy host "
            f"#{claimed_host} still uses it.\n") in lines
    assert await _rows(db) == []


async def test_proxy_removes_stale_entries_but_keeps_a_used_certificate(db, env,
                                                                       publish_fakes):
    """The base domain changed: created hosts and certificates under the old
    names go, a claimed host is forgotten, and the certificate Sirdar made
    for it stays because it still serves."""
    proxy = publish_fakes.npm
    old_cert = proxy.add_cert(["api.old.serversherpa.com"], days=80)
    old_host = proxy.add_host("api.old.serversherpa.com", "10.10.48.63", 8000,
                              certificate_id=old_cert, ssl_forced=True)
    kept_cert = proxy.add_cert(["portal.old.serversherpa.com"], days=80)
    kept_host = proxy.add_host("portal.old.serversherpa.com", "10.10.48.63", 8091,
                               certificate_id=kept_cert, ssl_forced=True)
    for service, kind, ext, origin in (("api", PROXY, old_host, "created"),
                                       ("api", CERT, old_cert, "created"),
                                       ("portal", PROXY, kept_host, "claimed"),
                                       ("portal", CERT, kept_cert, "created")):
        await managed(db, env, service, kind, ext, origin=origin,
                      name=f"{service}.old.serversherpa.com")
    lines = await _run(db, env, "proxy")
    assert old_host not in proxy.hosts and old_cert not in proxy.certs
    assert proxy.hosts[kept_host]["certificate_id"] == kept_cert and kept_cert in proxy.certs
    assert f"api.old.serversherpa.com: deleted the proxy host #{old_host}\n" in lines
    assert f"api.old.serversherpa.com: deleted the certificate #{old_cert}\n" in lines
    assert not any("old certificate" in line for line in lines)   # not deleted twice
    assert [r.url.path for r in proxy.requests if r.method == "DELETE"].count(
        f"/api/nginx/certificates/{old_cert}") == 1
    assert ("portal.old.serversherpa.com: left the proxy host in place (claimed, not made by "
            "Sirdar)\n") in lines
    assert (f"portal.old.serversherpa.com: Certificate #{kept_cert} left in place: proxy host "
            f"#{kept_host} still uses it.\n") in lines
    hosts = {h["domain_names"][0] for h in proxy.hosts.values()}
    assert hosts == set(NAMES) | {"portal.old.serversherpa.com"}
    rows = await db.scalars(select(ManagedRecord).execution_options(populate_existing=True))
    assert {r.name for r in rows} == set(NAMES)


async def test_a_replaced_certificate_another_host_uses_stays(db, env, publish_fakes):
    """Sirdar's certificate for api expired (no renew: the host no longer
    uses it), so a new one is requested; the old one is deleted only when no
    host uses it."""
    proxy = publish_fakes.npm
    expired = proxy.add_cert(["api.uat2.serversherpa.com"], days=-5)
    api_host = proxy.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000)
    other = proxy.add_host("legacy.example.com", "10.10.48.9", 80, certificate_id=expired)
    await managed(db, env, "api", PROXY, api_host)
    await managed(db, env, "api", CERT, expired)
    lines = await _run(db, env, "proxy")
    new = proxy.hosts[api_host]["certificate_id"]
    assert new != expired and expired in proxy.certs
    assert (f"api.uat2.serversherpa.com: Certificate #{expired} left in place: proxy host "
            f"#{other} still uses it.\n") in lines
    rows = {(s, k): e for s, k, e, _ in await _rows(db)}
    assert rows[("api", CERT)] == str(new)
    # Unused, it goes.
    del proxy.hosts[other]
    proxy.certs[new]["expires_on"] = proxy.certs[expired]["expires_on"]
    proxy.hosts[api_host]["certificate_id"] = 0
    lines = await _run(db, env, "proxy")
    assert new not in proxy.certs
    assert f"api.uat2.serversherpa.com: deleted the old certificate #{new}\n" in lines


# ---- deletes check the live object is still Sirdar's ---------------------------------

LEFT = "left in place: it no longer matches what Sirdar made.\n"


async def test_undns_leaves_records_that_no_longer_match(db, env, publish_fakes):
    """A created row's id now names something else (renamed, retyped or
    relabeled by hand): the row is forgotten and the record survives."""
    cf = publish_fakes.cf
    renamed = cf.add("A", "shop.serversherpa.com", PUBLIC_IP,
                     comment="Managed by Sirdar (uat2/api)")
    retyped = cf.add("CNAME", "portal.uat2.serversherpa.com", "elsewhere.example.com")
    relabeled = cf.add("A", "kiosk.uat2.serversherpa.com", PUBLIC_IP, comment="by hand, keep")
    mine = cf.add("A", "wiki.uat2.serversherpa.com", PUBLIC_IP,
                  comment="Managed by Sirdar (uat2/wiki)")
    for service, rid in (("api", renamed), ("portal", retyped), ("kiosk", relabeled),
                         ("wiki", mine)):
        await managed(db, env, service, DNS, rid)
    lines = await _run(db, env, "undns")
    assert sorted(cf.records) == sorted([renamed, retyped, relabeled])
    assert f"api.uat2.serversherpa.com: DNS record #{renamed} {LEFT}" in lines
    assert f"portal.uat2.serversherpa.com: DNS record #{retyped} {LEFT}" in lines
    assert f"kiosk.uat2.serversherpa.com: DNS record #{relabeled} {LEFT}" in lines
    assert "wiki.uat2.serversherpa.com: deleted the A record\n" in lines
    assert await _rows(db) == []


async def test_dns_stale_drop_leaves_a_record_that_no_longer_matches(db, env, publish_fakes):
    cf = publish_fakes.cf
    repurposed = cf.add("A", "shop.serversherpa.com", "198.51.100.9")
    await managed(db, env, "api", DNS, repurposed, name="api.old.serversherpa.com")
    lines = await _run(db, env, "dns")
    assert cf.records[repurposed]["name"] == "shop.serversherpa.com"
    assert f"api.old.serversherpa.com: DNS record #{repurposed} {LEFT}" in lines
    assert ("api.uat2.serversherpa.com: created A 203.0.113.7\n") in lines
    rows = {(s, k): e for s, k, e, _ in await _rows(db)}
    assert rows[("api", DNS)] != repurposed


async def test_unproxy_leaves_hosts_and_certificates_that_no_longer_match(db, env,
                                                                          publish_fakes):
    proxy = publish_fakes.npm
    widened = proxy.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000)
    proxy.hosts[widened]["domain_names"].append("shop.example.com")
    reused = proxy.add_host("legacy.example.com", "10.10.48.9", 80)
    custom = proxy.add_cert(["kiosk.uat2.serversherpa.com"], provider="other")
    renamed = proxy.add_cert(["shop.example.com"])
    mine = proxy.add_cert(["wiki.uat2.serversherpa.com"])
    for service, kind, ext in (("api", PROXY, widened), ("portal", PROXY, reused),
                               ("kiosk", CERT, custom), ("status", CERT, renamed),
                               ("wiki", CERT, mine)):
        await managed(db, env, service, kind, ext)
    lines = await _run(db, env, "unproxy")
    assert sorted(proxy.hosts) == sorted([widened, reused])
    assert sorted(proxy.certs) == sorted([custom, renamed])
    assert f"api.uat2.serversherpa.com: Proxy host #{widened} {LEFT}" in lines
    assert f"portal.uat2.serversherpa.com: Proxy host #{reused} {LEFT}" in lines
    assert f"kiosk.uat2.serversherpa.com: Certificate #{custom} {LEFT}" in lines
    assert f"status.uat2.serversherpa.com: Certificate #{renamed} {LEFT}" in lines
    assert f"wiki.uat2.serversherpa.com: deleted the certificate #{mine}\n" in lines
    assert await _rows(db) == []


async def test_proxy_stale_drop_leaves_a_host_that_no_longer_matches(db, env, publish_fakes):
    proxy = publish_fakes.npm
    repurposed = proxy.add_host("legacy.example.com", "10.10.48.9", 80)
    other_cert = proxy.add_cert(["legacy.example.com"])
    await managed(db, env, "api", PROXY, repurposed, name="api.old.serversherpa.com")
    await managed(db, env, "api", CERT, other_cert, name="api.old.serversherpa.com")
    lines = await _run(db, env, "proxy")
    assert repurposed in proxy.hosts and other_cert in proxy.certs
    assert f"api.old.serversherpa.com: Proxy host #{repurposed} {LEFT}" in lines
    assert f"api.old.serversherpa.com: Certificate #{other_cert} {LEFT}" in lines
    assert "api.uat2.serversherpa.com: created a proxy host to 10.10.48.63:8000\n" in lines


async def test_a_replaced_certificate_that_no_longer_matches_stays(db, env, publish_fakes):
    """Sirdar's earlier certificate id now names someone else's certificate
    (NPM rebuilt): the new one is requested, the other is left alone."""
    proxy = publish_fakes.npm
    api_host = proxy.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000)
    theirs = proxy.add_cert(["shop.example.com"], days=60)
    await managed(db, env, "api", PROXY, api_host)
    await managed(db, env, "api", CERT, theirs)
    lines = await _run(db, env, "proxy")
    new = proxy.hosts[api_host]["certificate_id"]
    assert new != theirs and theirs in proxy.certs
    assert f"api.uat2.serversherpa.com: Certificate #{theirs} {LEFT}" in lines
    assert not any("deleted the old certificate" in line for line in lines)


async def test_unproxy_leaves_a_multi_name_certificate_at_the_recorded_id(db, env,
                                                                          publish_fakes):
    """Sirdar only requests single-name certificates: one that also names
    something else isn't the one it made, even when it names the host."""
    proxy = publish_fakes.npm
    shared = proxy.add_cert(["api.uat2.serversherpa.com", "shop.example.com"])
    await managed(db, env, "api", CERT, shared)
    lines = await _run(db, env, "unproxy")
    assert shared in proxy.certs
    assert f"api.uat2.serversherpa.com: Certificate #{shared} {LEFT}" in lines
    assert await _rows(db) == []


REDIRECT = ('if ($request_uri !~ "^/\\.well-known/acme-challenge/") {\n'
            "    return 302 https://portal.uat2.serversherpa.com$request_uri;\n"
            "}")


@pytest.fixture
async def home_env(db, secrets_key, publish_fakes):  # noqa: F811
    publish_fakes.npm.now = NOW
    await configure(db)
    return await make_environment(db, name="uat2", host="10.10.48.63", with_home=True)


def _bare(fake_npm) -> dict:
    return next(h for h in fake_npm.hosts.values()
                if h["domain_names"] == ["uat2.serversherpa.com"])


async def test_the_bare_name_gets_a_redirect_host_with_its_own_certificate(db, home_env,
                                                                         publish_fakes):  # noqa: F811
    lines = await _run(db, home_env, "proxy")
    bare = _bare(publish_fakes.npm)
    assert bare["advanced_config"] == REDIRECT
    assert (bare["forward_host"], bare["forward_port"]) == ("10.10.48.63", 8091)
    assert bare["ssl_forced"] and publish_fakes.npm.certs[bare["certificate_id"]][
        "domain_names"] == ["uat2.serversherpa.com"]
    others = [h for h in publish_fakes.npm.hosts.values() if h is not bare]
    assert {h["advanced_config"] for h in others} == {"", "client_max_body_size 0;"}
    assert ("uat2.serversherpa.com: created a proxy host to 10.10.48.63:8091\n" in lines)
    order = [line.split(":")[0] for line in lines if "created a proxy host" in line]
    assert order[:3] == ["api.uat2.serversherpa.com", "portal.uat2.serversherpa.com",
                         "uat2.serversherpa.com"]


async def test_a_redirect_changed_by_hand_is_put_back(db, home_env, publish_fakes):  # noqa: F811
    await _run(db, home_env, "proxy")
    _bare(publish_fakes.npm)["advanced_config"] = "return 301 https://elsewhere.example;"
    state = await publish.inspect(db, home_env, get_settings())
    bare = next(s for s in state["services"] if s["service"] == "home")
    assert (bare["proxy"]["state"], bare["proxy"]["detail"]) == (
        "update", "Sirdar will change the redirect.")
    lines = await _run(db, home_env, "proxy")
    assert _bare(publish_fakes.npm)["advanced_config"] == REDIRECT
    assert "uat2.serversherpa.com: proxy host now redirects to the portal\n" in lines
    assert not any("now goes to" in line for line in lines)


async def test_a_moved_bare_name_says_where_it_goes_and_that_it_redirects(
        db, home_env, publish_fakes):  # noqa: F811
    await _run(db, home_env, "proxy")
    bare = _bare(publish_fakes.npm)
    bare["advanced_config"] = ""
    bare["forward_host"] = "10.10.48.99"
    lines = await _run(db, home_env, "proxy")
    assert ("uat2.serversherpa.com: proxy host now goes to 10.10.48.63:8091 and redirects "
            "to the portal\n") in lines


async def test_other_hosts_keep_their_own_advanced_config(db, home_env,
                                                          publish_fakes):  # noqa: F811
    await _run(db, home_env, "proxy")
    api = next(h for h in publish_fakes.npm.hosts.values()
               if h["domain_names"] == ["api.uat2.serversherpa.com"])
    api["advanced_config"] = "proxy_read_timeout 300;"
    writes = len(_writes(publish_fakes.npm))
    await _run(db, home_env, "proxy")
    assert api["advanced_config"] == "proxy_read_timeout 300;"
    assert len(_writes(publish_fakes.npm)) == writes


async def test_the_bare_name_gets_its_a_record_beside_txt_and_mx(db, home_env,
                                                                  publish_fakes):  # noqa: F811
    cf = publish_fakes.cf
    spf = cf.add("TXT", "uat2.serversherpa.com", "v=spf1 include:_spf.example.com -all")
    mx = cf.add("MX", "uat2.serversherpa.com", "mail.example.com")
    lines = await _run(db, home_env, "dns")
    assert "uat2.serversherpa.com: created A 203.0.113.7\n" in lines
    a = [r for r in cf.records.values()
         if r["name"] == "uat2.serversherpa.com" and r["type"] == "A"]
    assert len(a) == 1 and a[0]["comment"] == "Managed by Sirdar (uat2/home)"
    assert spf in cf.records and mx in cf.records
    assert ("home", DNS, a[0]["id"], "created") in await _rows(db)
    again = await _run(db, home_env, "dns")
    assert "uat2.serversherpa.com: A 203.0.113.7, unchanged\n" in again


async def test_a_cname_at_the_bare_name_still_blocks(db, home_env, publish_fakes):  # noqa: F811
    cf = publish_fakes.cf
    cf.add("CNAME", "uat2.serversherpa.com", "elsewhere.example.com")
    with pytest.raises(StepFailed) as e:
        await _run(db, home_env, "dns")
    assert "  uat2.serversherpa.com: A CNAME record already uses this name.\n" in e.value.reason
    assert cf.writes() == [] and await _rows(db) == []
