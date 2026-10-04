import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import ManagedRecord
from sirdar_api.deploy import publish
from sirdar_api.deploy.cloudflare import DnsRecord
from sirdar_api.deploy.npm import Certificate, ProxyHost
from sirdar_api.deploy.publish import CERT, DNS, PROXY, Status

from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import CF_TOKEN, NPM_PASSWORD, configure
from .publish_helpers import PUBLIC_IP, managed, publish_fakes, sp  # noqa: F401

API = sp()
NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)


def rec(rid, type_="A", name=API.hostname, content=PUBLIC_IP, proxied=False) -> DnsRecord:
    return DnsRecord(id=rid, type=type_, name=name, content=content, proxied=proxied)


def row(kind, external_id, *, name=API.hostname, origin="created"):
    return publish.ManagedRecord(environment_id=uuid.uuid4(), service="api", kind=kind,
                                 external_id=str(external_id), name=name, origin=origin)


def host(hid, *, names=(API.hostname,), fwd=("10.10.48.63", 8100), cert=0, ssl=True,
         ws=True, scheme="http") -> ProxyHost:
    return ProxyHost(id=hid, domain_names=tuple(names), forward_scheme=scheme,
                     forward_host=fwd[0], forward_port=fwd[1], certificate_id=cert,
                     ssl_forced=ssl, http2_support=True, allow_websocket_upgrade=ws, raw={})


def cert(cid, names=(API.hostname,), days=60, provider="letsencrypt") -> Certificate:
    return Certificate(id=cid, provider=provider, domain_names=tuple(names),
                       expires_on=None if days is None else NOW + timedelta(days=days))


def _dns(records, managed_row=None, owners=None, service=API):
    return publish.dns_status(service, records, managed_row, owners or {},
                              zone="serversherpa.com", public_ip=PUBLIC_IP)


@pytest.mark.parametrize("records, managed_row, owners, expected", [
    ([], None, None, ("create", "Sirdar will create A 203.0.113.7.")),
    ([rec("r1")], row(DNS, "r1"), None, ("ok", "A 203.0.113.7")),
    ([rec("r1", content="198.51.100.1")], row(DNS, "r1"), None,
     ("update", "A 198.51.100.1; Sirdar will point it at 203.0.113.7.")),
    ([rec("r1", proxied=True)], row(DNS, "r1", origin="claimed"), None,
     ("update", "Cloudflare's proxy is on; Sirdar will turn it off.")),
    ([], row(DNS, "r1"), None, ("create", "Sirdar's record is gone; it will be created again.")),
    ([], row(DNS, "r1", origin="claimed"), None,
     ("create", "The record Sirdar claimed is gone; it will be created again.")),
    ([rec("r1", name="api2.uat2.serversherpa.com")], row(DNS, "r1"), None,
     ("conflict", "Sirdar's record r1 is now named api2.uat2.serversherpa.com; fix it in "
                  "Cloudflare or remove it.")),
    ([rec("r1", content="198.51.100.1")], None, None,
     ("claimable", "A 198.51.100.1, made outside Sirdar.")),
    ([rec("r1")], None, {"r1": "uat"}, ("conflict", "The environment uat manages this record.")),
    ([rec("r1", type_="CNAME", content="x.example.com")], None, None,
     ("conflict", "A CNAME record already uses this name.")),
    ([rec("r1"), rec("r2")], None, None,
     ("conflict", "More than one A record uses this name.")),
    ([rec("r1", name="*.uat2.serversherpa.com")], None, None,
     ("conflict", "The wildcard *.uat2.serversherpa.com covers this name; a record here would "
                  "override it.")),
    ([rec("r1", name="portal.uat2.serversherpa.com")], None, None,
     ("create", "Sirdar will create A 203.0.113.7.")),
    # Sirdar's record is gone and something else now holds the name: never create over it.
    ([rec("r2", content="198.51.100.1")], row(DNS, "r1"), None,
     ("conflict", "Sirdar's record is gone and another A record now uses this name.")),
    ([rec("r2", name="*.uat2.serversherpa.com")], row(DNS, "r1"), None,
     ("conflict", "The wildcard *.uat2.serversherpa.com covers this name; a record here would "
                  "override it.")),
    ([rec("r2", type_="CNAME", content="x.example.com")], row(DNS, "r1"), None,
     ("conflict", "A CNAME record already uses this name.")),
])
def test_dns_status(records, managed_row, owners, expected):
    status = _dns(records, managed_row, owners)
    assert (status.state, status.detail) == expected


def test_dns_status_outside_the_zone():
    outside = publish.ServicePlan("api", "api.example.org", "10.10.48.63", 8100, False)
    status = _dns([], service=outside)
    assert (status.state, status.detail) == (
        "conflict", "api.example.org isn't in the Cloudflare zone serversherpa.com.")


@pytest.mark.parametrize("hosts, managed_row, owners, expected", [
    ([], None, None, ("create", "Sirdar will create a proxy host to 10.10.48.63:8100.")),
    ([host(5)], row(PROXY, 5), None, ("ok", "To 10.10.48.63:8100")),
    ([host(5, fwd=("10.10.48.63", 8000), ws=False)], row(PROXY, 5), None,
     ("update", "Sirdar will change the forward port and WebSockets.")),
    ([], row(PROXY, 5), None,
     ("create", "Sirdar's proxy host is gone; it will be created again.")),
    ([], row(PROXY, 5, origin="claimed"), None,
     ("create", "The proxy host Sirdar claimed is gone; it will be created again.")),
    ([host(5, names=("api2.uat2.serversherpa.com",))], row(PROXY, 5), None,
     ("conflict", "Sirdar's proxy host #5 no longer serves api.uat2.serversherpa.com; fix it "
                  "in NPM or remove it.")),
    ([host(5, fwd=("10.10.48.63", 8000))], None, None,
     ("claimable", "To 10.10.48.63:8000, made outside Sirdar.")),
    ([host(5)], None, {"5": "uat"}, ("conflict", "The environment uat manages this proxy host.")),
    ([host(5), host(6)], None, None,
     ("conflict", "More than one proxy host serves this name.")),
    ([host(5, names=(API.hostname, "www.example.com"))], None, None,
     ("conflict", "This proxy host also serves www.example.com.")),
    ([host(6)], row(PROXY, 5), None,
     ("conflict", "Sirdar's proxy host is gone and another proxy host now serves this name.")),
])
def test_proxy_status(hosts, managed_row, owners, expected):
    status = publish.proxy_status(API, hosts, managed_row, owners or {})
    assert (status.state, status.detail) == expected


@pytest.mark.parametrize("the_host, certs, expected", [
    (None, [], ("create", "Sirdar will request a Let's Encrypt certificate.")),
    (host(5, cert=9), [cert(9)], ("ok", "Valid until 2026-12-03.")),
    (host(5, cert=9, ssl=False), [cert(9)],
     ("update", "Force SSL is off; Sirdar will turn it on.")),
    (host(5, cert=9), [cert(9, days=12)], ("update", "Expires 2026-10-16; Sirdar will renew it.")),
    (host(5, cert=9), [cert(9, days=12, provider="other"),
                       cert(10, names=("*.uat2.serversherpa.com",), days=80)],
     ("update", "Sirdar will use certificate #10 (valid until 2026-12-23).")),
    (host(5), [cert(10, names=("*.uat2.serversherpa.com",), days=80), cert(11, days=40)],
     ("update", "Sirdar will use certificate #11 (valid until 2026-11-13).")),
    (host(5), [cert(10, names=("*.uat.serversherpa.com",), days=80)],
     ("create", "Sirdar will request a Let's Encrypt certificate.")),
    (host(5, cert=9), [cert(9, days=None)], ("ok", "In place; no expiry date.")),
])
def test_cert_status(the_host, certs, expected):
    status = publish.cert_status(the_host, certs, API.hostname, NOW)
    assert (status.state, status.detail) == expected


def test_stale_rows_and_current_row():
    rows = {("api", DNS): row(DNS, "r1", name="api.old.serversherpa.com"),
            ("portal", DNS): row(DNS, "r2", name="portal.uat2.serversherpa.com"),
            ("mailpit", DNS): row(DNS, "r3", name="mailpit.uat2.serversherpa.com")}
    rows[("portal", DNS)].service = "portal"
    rows[("mailpit", DNS)].service = "mailpit"
    services = (API, sp("portal"))
    assert publish.current_row(rows, API, DNS) is None
    assert publish.current_row(rows, sp("portal"), DNS) is rows[("portal", DNS)]
    assert {r.external_id for r in publish.stale_rows(rows, services)} == {"r1", "r3"}


async def test_prepare_and_missing_integrations(db, secrets_key):
    env = await make_environment(db, name="uat2", host="10.10.48.63")
    assert await publish.missing_integrations(db, env) == ["cloudflare", "npm"]
    assert await publish.missing_integrations(db, env, teardown=True) == []
    await managed(db, env, "api", DNS, "r1")
    await managed(db, env, "api", PROXY, 5, origin="claimed")
    assert await publish.missing_integrations(db, env, teardown=True) == ["cloudflare"]
    await configure(db)
    assert await publish.missing_integrations(db, env) == []
    ctx = await publish.prepare(db, env, get_settings())
    assert [s.service for s in ctx.services] == ["api", "portal", "kiosk", "wiki", "spaces",
                                                 "status"]
    assert ctx.services[0] == publish.ServicePlan("api", "api.uat2.serversherpa.com",
                                                  "10.10.48.63", 8000, False)
    assert (ctx.env_name, ctx.proxy_ip) == ("uat2", "10.0.0.2")
    assert sorted(ctx.secret_values) == sorted([CF_TOKEN, NPM_PASSWORD])
    assert CF_TOKEN not in repr(ctx) and NPM_PASSWORD not in repr(ctx)


async def _uat2(db):
    """uat2 on 10.10.48.63 with integrations configured."""
    await configure(db)
    return await make_environment(db, name="uat2", host="10.10.48.63")


async def test_inspect_reports_every_service(db, secrets_key, publish_fakes):
    env = await _uat2(db)
    cf, proxy = publish_fakes.cf, publish_fakes.npm
    hand_api = cf.add("A", "api.uat2.serversherpa.com", PUBLIC_IP)
    mine = cf.add("A", "portal.uat2.serversherpa.com", PUBLIC_IP)
    await managed(db, env, "portal", DNS, mine)
    cf.add("CNAME", "kiosk.uat2.serversherpa.com", "elsewhere.example.com")
    api_cert = proxy.add_cert(["api.uat2.serversherpa.com"], days=70)
    api_host = proxy.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000,
                              certificate_id=api_cert, ssl_forced=True)
    await managed(db, env, "wiki", DNS, "rec-gone", name="wiki.old.serversherpa.com")
    state = await publish.inspect(db, env, get_settings())
    assert state["publish"] is False and state["proxy_ip"] == "10.0.0.2"
    assert state["cloudflare"] == {"configured": True, "zone": "serversherpa.com",
                                   "public_ip": PUBLIC_IP, "error": None}
    assert state["npm"] == {"configured": True, "url": "http://10.10.48.6:81", "error": None}
    by = {s["service"]: s for s in state["services"]}
    assert list(by) == ["api", "portal", "kiosk", "wiki", "spaces", "status"]
    assert by["api"]["forward"] == "10.10.48.63:8000"
    assert by["api"]["dns"] == {"state": "claimable", "detail": "A 203.0.113.7, made outside "
                                "Sirdar.", "origin": None, "record_id": hand_api}
    assert by["api"]["proxy"] == {"state": "claimable", "detail": "To 10.10.48.63:8000, made "
                                  "outside Sirdar.", "origin": None, "host_id": api_host}
    # The host isn't Sirdar's yet, so its certificate isn't judged.
    assert by["api"]["certificate"] == {"state": "unknown", "expires_on": None,
                                        "detail": "Waits for the proxy host."}
    assert (by["portal"]["dns"]["state"], by["portal"]["dns"]["origin"]) == ("ok", "created")
    assert by["kiosk"]["dns"]["state"] == "conflict"
    assert (by["status"]["dns"]["state"], by["status"]["proxy"]["state"],
            by["status"]["certificate"]["state"]) == ("create", "create", "create")
    assert state["stale"] == [{"service": "wiki", "kind": DNS,
                               "name": "wiki.old.serversherpa.com", "origin": "created"}]


async def test_inspect_without_integrations_or_when_one_is_down(db, secrets_key,
                                                                publish_fakes):
    env = await make_environment(db, name="uat2", host="10.10.48.63")
    state = await publish.inspect(db, env, get_settings())
    assert state["cloudflare"]["configured"] is False and state["npm"]["configured"] is False
    assert {s["dns"]["state"] for s in state["services"]} == {"unknown"}
    assert {s["certificate"]["state"] for s in state["services"]} == {"unknown"}
    await configure(db)
    publish_fakes.cf.down = True
    state = await publish.inspect(db, env, get_settings())
    assert state["cloudflare"]["error"] == "Couldn't reach the Cloudflare API."
    assert {s["dns"]["state"] for s in state["services"]} == {"unknown"}
    assert {s["proxy"]["state"] for s in state["services"]} == {"create"}


async def test_claim_records_only_claimable_entries(db, secrets_key, publish_fakes):
    env = await _uat2(db)
    hand_api = publish_fakes.cf.add("A", "api.uat2.serversherpa.com", PUBLIC_IP)
    publish_fakes.cf.add("CNAME", "kiosk.uat2.serversherpa.com", "elsewhere.example.com")
    api_host = publish_fakes.npm.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000,
                                          allow_websocket_upgrade=True)
    state = await publish.inspect(db, env, get_settings())
    claimed = await publish.claim(db, env, state)
    await db.commit()
    assert claimed == ["dns:api.uat2.serversherpa.com", "proxy:api.uat2.serversherpa.com"]
    rows = list(await db.scalars(select(ManagedRecord).order_by(ManagedRecord.kind)))
    assert [(r.service, r.kind, r.external_id, r.origin) for r in rows] == [
        ("api", DNS, hand_api, "claimed"), ("api", PROXY, str(api_host), "claimed")]
    again = await publish.inspect(db, env, get_settings())
    api = again["services"][0]
    assert (api["dns"]["state"], api["dns"]["origin"]) == ("ok", "claimed")
    assert (api["proxy"]["state"], api["proxy"]["origin"]) == ("ok", "claimed")
    assert await publish.claim(db, env, again) == []
    assert CERT not in {r.kind for r in rows}          # certificates are never claimed


def test_status_compares_on_state_and_detail_only():
    assert Status("ok", "x", current=1) == Status("ok", "x", current=2)


async def test_inspect_judges_certificates_of_hosts_sirdar_manages(db, secrets_key,
                                                                   publish_fakes):
    env = await _uat2(db)
    proxy = publish_fakes.npm
    api_cert = proxy.add_cert(["api.uat2.serversherpa.com"], days=70)
    api_host = proxy.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000,
                              certificate_id=api_cert, ssl_forced=True,
                              allow_websocket_upgrade=True)
    proxy.add_host("portal.uat2.serversherpa.com", "10.10.48.63", 8091)
    proxy.add_host("portal.uat2.serversherpa.com", "10.10.48.63", 8091)
    await managed(db, env, "api", PROXY, api_host, origin="claimed")
    by = {s["service"]: s for s in (await publish.inspect(db, env, get_settings()))["services"]}
    assert (by["api"]["proxy"]["state"], by["api"]["certificate"]["state"]) == ("ok", "ok")
    assert by["api"]["certificate"]["expires_on"] is not None
    assert (by["portal"]["proxy"]["state"], by["portal"]["certificate"]["state"]) == (
        "conflict", "unknown")
    assert by["status"]["certificate"]["state"] == "create"


async def test_claim_replaces_a_claimed_entry_under_an_old_name(db, secrets_key,
                                                               publish_fakes):
    """Base domain renamed: the claimed row at the old name is forgotten (it
    stays in Cloudflare) and the hand-made record at the new name is claimed."""
    env = await _uat2(db)
    cf = publish_fakes.cf
    old = cf.add("A", "api.old.serversherpa.com", PUBLIC_IP)
    await managed(db, env, "api", DNS, old, origin="claimed", name="api.old.serversherpa.com")
    hand = cf.add("A", "api.uat2.serversherpa.com", PUBLIC_IP)
    state = await publish.inspect(db, env, get_settings())
    assert state["services"][0]["dns"]["state"] == "claimable"
    assert await publish.claim(db, env, state) == ["dns:api.uat2.serversherpa.com"]
    await db.commit()
    rows = list(await db.scalars(select(ManagedRecord)
                                 .execution_options(populate_existing=True)))
    assert [(r.service, r.kind, r.external_id, r.name, r.origin) for r in rows] == [
        ("api", DNS, hand, "api.uat2.serversherpa.com", "claimed")]
    assert old in cf.records and cf.writes() == []


async def test_a_created_entry_under_an_old_name_goes_before_claiming(db, secrets_key,
                                                                     publish_fakes):
    """Base domain renamed with a record Sirdar created at the old name and a
    hand-made one at the new name: inspect says why Claim must wait, Publish
    removes Sirdar's old record and stops at the hand-made one, then Claim
    works and the next Publish goes through."""
    env = await _uat2(db)
    cf = publish_fakes.cf
    old = cf.add("A", "api.old.serversherpa.com", PUBLIC_IP)
    await managed(db, env, "api", DNS, old, name="api.old.serversherpa.com")
    hand = cf.add("A", "api.uat2.serversherpa.com", PUBLIC_IP)
    state = await publish.inspect(db, env, get_settings())
    api = state["services"][0]["dns"]
    assert (api["state"], api["detail"]) == (
        "conflict", "A 203.0.113.7, made outside Sirdar. Publishing first removes Sirdar's "
                    "old record at api.old.serversherpa.com; then claim this one.")
    assert await publish.claim(db, env, state) == []

    ctx = await publish.prepare(db, env, get_settings())
    lines: list[str] = []
    with pytest.raises(publish.StepFailed) as e:
        await publish.HttpPublisher().run("dns", ctx, lines.append)
    assert "api.uat2.serversherpa.com: A 203.0.113.7, made outside Sirdar." in e.value.reason
    assert lines == ["api.old.serversherpa.com: deleted the A record\n"]
    assert old not in cf.records and hand in cf.records

    state = await publish.inspect(db, env, get_settings())
    assert state["services"][0]["dns"]["state"] == "claimable" and state["stale"] == []
    assert await publish.claim(db, env, state) == ["dns:api.uat2.serversherpa.com"]
    await db.commit()
    await publish.HttpPublisher().run("dns", ctx, lines.append)
    assert "api.uat2.serversherpa.com: A 203.0.113.7, unchanged\n" in lines


async def test_proxy_step_removes_a_created_host_under_an_old_name_first(db, secrets_key,
                                                                        publish_fakes):
    env = await _uat2(db)
    proxy = publish_fakes.npm
    old = proxy.add_host("api.old.serversherpa.com", "10.10.48.63", 8000)
    await managed(db, env, "api", PROXY, old, name="api.old.serversherpa.com")
    hand = proxy.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000)
    ctx = await publish.prepare(db, env, get_settings())
    lines: list[str] = []
    with pytest.raises(publish.StepFailed) as e:
        await publish.HttpPublisher().run("proxy", ctx, lines.append)
    assert "api.uat2.serversherpa.com: To 10.10.48.63:8000, made outside Sirdar." in (
        e.value.reason)
    assert old not in proxy.hosts and hand in proxy.hosts
    assert lines == [f"api.old.serversherpa.com: deleted the proxy host #{old}\n"]
    state = await publish.inspect(db, env, get_settings())
    assert await publish.claim(db, env, state) == ["proxy:api.uat2.serversherpa.com"]
