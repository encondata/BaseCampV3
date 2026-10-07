"""Switch traffic on the LAN: every proxy host of the environment forwards
to the slot's VM, then the public names are checked through NPM; a failure
puts every proxy host back."""

from dataclasses import replace

import asyncio
import json

import pytest
from sqlalchemy import select, update

from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Environment, EnvironmentService, EsxiVm
from sirdar_api.deploy import publish, vmcommon
from sirdar_api.deploy.npm import NpmError

from .deploy_factories import secrets_key  # noqa: F401
from .integration_helpers import NPM_PASSWORD, configure, configure_esxi
from .lan_helpers import DATA, ORANGE, make_bluegreen_environment
from .publish_helpers import publish_fakes  # noqa: F401

PURPLE_IP = "10.10.48.49"


async def _no_sleep(_):
    return None


@pytest.fixture
async def lan(db, secrets_key):  # noqa: F811
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    env = await make_bluegreen_environment(db)
    await vmcommon.set_vm(EsxiVm, env.id, role="orange", ip=ORANGE, created=True,
                          moref="vm-1", instance_uuid="uuid-orange")
    await vmcommon.set_vm(EsxiVm, env.id, role="purple", ip=PURPLE_IP, created=True,
                          moref="vm-2", instance_uuid="uuid-purple")
    await vmcommon.set_vm(EsxiVm, env.id, role="data", ip=DATA, created=True,
                          moref="vm-3", instance_uuid="uuid-data")
    return env


def _publisher():
    return publish.HttpPublisher(sleep=_no_sleep, smoke_attempts=1, smoke_delay=0,
                                 cert_backoff=(0,))


async def _ctx(db, env, slot):
    return replace(await publish.prepare(db, env, get_settings()), slot=slot)


async def _hosts(db, env) -> dict[str, str]:
    return dict((await db.execute(select(EnvironmentService.service, EnvironmentService.host_ip)
                                  .where(EnvironmentService.environment_id == env.id)
                                  .execution_options(populate_existing=True))).all())


def _forwards(fakes) -> dict[str, str]:
    return {h["domain_names"][0]: h["forward_host"] for h in fakes.npm.hosts.values()}


def _app_forwards(fakes) -> set[str]:
    return {ip for d, ip in _forwards(fakes).items() if d.startswith(("api.", "portal.", "kiosk.",
                                                                     "wiki.", "status."))}


async def _live(env, slot) -> None:
    """What the pipeline records after a switch goes live."""
    async with get_sessionmaker()() as s:
        await s.execute(update(Environment).where(Environment.id == env.id)
                        .values(active_slot=slot))
        await s.commit()


async def _switched(db, env, slot) -> None:
    await _publisher().run("lan_switch", await _ctx(db, env, slot), lambda _: None)
    await _live(env, slot)


async def _ports(db, env) -> dict[str, int]:
    return dict((await db.execute(select(EnvironmentService.hostname, EnvironmentService.port)
                                  .where(EnvironmentService.environment_id == env.id,
                                         EnvironmentService.hostname.is_not(None)))).all())


def _host(fakes, name: str) -> dict:
    return next(h for h in fakes.npm.hosts.values() if h["domain_names"] == [name])


async def _fails(db, env, slot, lines=None) -> str:
    with pytest.raises(publish.StepFailed) as e:
        await _publisher().run("lan_switch", await _ctx(db, env, slot),
                               lines.append if lines is not None else lambda _: None)
    return e.value.reason


async def test_the_first_switch_creates_the_proxy_hosts(db, lan, publish_fakes):  # noqa: F811
    lines: list[str] = []
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lines.append)
    forwards = _forwards(publish_fakes)
    assert forwards["api.lan9.serversherpa.com"] == ORANGE
    assert forwards["spaces.lan9.serversherpa.com"] == DATA        # never switched
    assert "Traffic goes to orange" in "".join(lines)


async def test_a_switch_repoints_every_app_proxy_host(db, lan, publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    await _switched(db, lan, "purple")
    forwards = _forwards(publish_fakes)
    assert {d: ip for d, ip in forwards.items() if not d.startswith("spaces.")} == {
        d: PURPLE_IP for d in forwards if not d.startswith("spaces.")}
    assert forwards["spaces.lan9.serversherpa.com"] == DATA
    hosts = await _hosts(db, lan)
    assert hosts["spaces"] == DATA and hosts["api"] == PURPLE_IP and hosts["mailpit"] == PURPLE_IP


async def test_each_service_keeps_its_port_on_the_new_slot(db, lan, publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    await _switched(db, lan, "purple")
    ports = await _ports(db, lan)
    assert len(set(ports.values())) == len(ports)          # one port per service
    got = {h["domain_names"][0]: (h["forward_host"], h["forward_port"])
           for h in publish_fakes.npm.hosts.values()}
    assert got == {name: (DATA if name.startswith("spaces.") else PURPLE_IP, port)
                   for name, port in ports.items()}


async def test_a_failed_smoke_test_puts_everything_back(db, lan, publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    reason = await _fails(db, lan, "purple")
    assert reason.endswith("Traffic stays where it was.")
    assert _app_forwards(publish_fakes) == {ORANGE}
    assert (await _hosts(db, lan))["api"] == ORANGE


async def test_a_slot_without_an_address_changes_nothing(db, lan, publish_fakes):  # noqa: F811
    await vmcommon.set_vm(EsxiVm, lan.id, role="purple", ip=None)
    assert "purple VM has no address" in await _fails(db, lan, "purple")
    assert publish_fakes.npm.hosts == {}


async def test_no_slot_changes_nothing(db, lan, publish_fakes):  # noqa: F811
    assert "names no server" in await _fails(db, lan, None)
    assert publish_fakes.npm.hosts == {}


async def test_every_forward_field_comes_back(db, lan, publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    wiki = _host(publish_fakes, "wiki.lan9.serversherpa.com")
    wiki.update(forward_scheme="https", forward_port=9443,      # changed by hand since
                allow_websocket_upgrade=False)
    publish_fakes.smoke.set("api.lan9.serversherpa.com", 502)
    await _fails(db, lan, "purple")
    wiki = _host(publish_fakes, "wiki.lan9.serversherpa.com")
    assert (wiki["forward_scheme"], wiki["forward_host"], wiki["forward_port"],
            wiki["allow_websocket_upgrade"]) == ("https", ORANGE, 9443, False)
    assert _forwards(publish_fakes)["api.lan9.serversherpa.com"] == ORANGE
    assert _forwards(publish_fakes)["spaces.lan9.serversherpa.com"] == DATA


async def test_only_the_environments_proxy_hosts_are_touched(db, lan,
                                                            publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    other = publish_fakes.npm.add_host("api.elsewhere.serversherpa.com", "10.10.48.90", 8000)
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    await _fails(db, lan, "purple")
    assert publish_fakes.npm.hosts[other]["forward_host"] == "10.10.48.90"
    puts = [r for r in publish_fakes.npm.requests
            if r.method == "PUT" and r.url.path.endswith(f"/proxy-hosts/{other}")]
    assert puts == []


async def test_putting_back_fails_too(db, lan, publish_fakes, monkeypatch):  # noqa: F811
    await _switched(db, lan, "orange")

    async def smoke_then_npm_down(*args, **kwargs):
        publish_fakes.npm.down = True
        raise publish.StepFailed("1 of 5 public URLs didn't answer: portal.")

    monkeypatch.setattr(publish, "run_smoke", smoke_then_npm_down)
    lines: list[str] = []
    reason = await _fails(db, lan, "purple", lines)
    assert reason.startswith("1 of 5 public URLs didn't answer: portal.")
    assert "Sirdar couldn't put the proxy hosts back (" in reason
    assert reason.endswith("check them in Nginx Proxy Manager.")
    assert "Traffic stays where it was" not in reason
    assert NPM_PASSWORD not in reason and NPM_PASSWORD not in "".join(lines)
    assert (await _hosts(db, lan))["api"] == ORANGE


async def test_a_failed_proxy_step_puts_everything_back(db, lan, publish_fakes,
                                                      monkeypatch):  # noqa: F811
    await _switched(db, lan, "orange")
    real = publish.ensure_proxy

    async def repoints_then_fails(ctx, out, **kwargs):
        await real(ctx, out, **kwargs)          # every host now forwards to purple
        raise NpmError("Nginx Proxy Manager didn't answer.")

    monkeypatch.setattr(publish, "ensure_proxy", repoints_then_fails)
    reason = await _fails(db, lan, "purple")
    assert reason == "Nginx Proxy Manager didn't answer. Traffic stays where it was."
    assert _app_forwards(publish_fakes) == {ORANGE}
    assert (await _hosts(db, lan))["api"] == ORANGE


# Review fixes: the order of writes, cancellation, interrupted switches.

async def test_a_cancel_during_the_smoke_test_still_puts_npm_back(db, lan, publish_fakes,
                                                                 monkeypatch):  # noqa: F811
    await _switched(db, lan, "orange")

    async def cancelled(*args, **kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(publish, "run_smoke", cancelled)
    with pytest.raises(asyncio.CancelledError):
        await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    assert _app_forwards(publish_fakes) == {ORANGE}
    hosts = await _hosts(db, lan)
    assert hosts["api"] == ORANGE and hosts["mailpit"] == ORANGE


async def test_the_database_changes_only_after_the_smoke_test(db, lan, publish_fakes,
                                                             monkeypatch):  # noqa: F811
    await _switched(db, lan, "orange")
    seen: list[str] = []
    real = publish.run_smoke

    async def watching(ctx, out, **kwargs):
        async with get_sessionmaker()() as s:
            seen.append(await s.scalar(select(EnvironmentService.host_ip).where(
                EnvironmentService.environment_id == lan.id,
                EnvironmentService.service == "api")))
        await real(ctx, out, **kwargs)

    monkeypatch.setattr(publish, "run_smoke", watching)
    await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    assert seen == [ORANGE]
    assert (await _hosts(db, lan))["api"] == PURPLE_IP


async def test_a_retry_after_an_interrupted_switch_goes_back_to_the_live_slot(
        db, lan, publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    # The process died mid-switch: NPM already forwards to purple, nothing was recorded.
    ctx = await _ctx(db, lan, "purple")
    moved = replace(ctx, services=tuple(
        replace(s, host_ip=PURPLE_IP) if s.service != "spaces" else s for s in ctx.services))
    await publish.ensure_proxy(moved, lambda _: None, transport=publish_fakes.npm.transport(),
                               sleep=_no_sleep, now=publish.datetime.now(publish.UTC),
                               backoff=(0,))
    assert _app_forwards(publish_fakes) == {PURPLE_IP}
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    reason = await _fails(db, lan, "purple")
    assert reason.endswith("Traffic stays where it was.")
    assert _app_forwards(publish_fakes) == {ORANGE}
    assert _forwards(publish_fakes)["spaces.lan9.serversherpa.com"] == DATA


async def test_a_failed_first_switch_removes_what_it_created(db, lan, publish_fakes):  # noqa: F811
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    reason = await _fails(db, lan, "orange")
    assert reason.endswith("No slot was live before, so nothing to put back.")
    assert "Traffic stays where it was" not in reason
    assert publish_fakes.npm.hosts == {}
    async with get_sessionmaker()() as s:
        left = await publish.rows_of(s, lan.id)
    assert not [k for k in left if k[1] == publish.PROXY]


async def test_a_failed_switch_to_the_live_slot_says_so(db, lan, publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    reason = await _fails(db, lan, "orange")
    assert "Traffic stays where it was" not in reason
    assert reason.endswith("orange was already live, so traffic still goes to it.")
    assert _app_forwards(publish_fakes) == {ORANGE}


async def test_a_database_failure_after_the_smoke_test_puts_npm_back(
        db, lan, publish_fakes, monkeypatch):  # noqa: F811
    await _switched(db, lan, "orange")

    async def broken(*args, **kwargs):
        raise RuntimeError("connection to sirdar-db lost (password=hunter2)")

    monkeypatch.setattr(publish, "_point", broken)
    reason = await _fails(db, lan, "purple")
    assert reason == ("Sirdar couldn't save the new addresses in its database. "
                      "Traffic stays where it was.")
    assert _app_forwards(publish_fakes) == {ORANGE}
    assert (await _hosts(db, lan))["api"] == ORANGE


async def test_a_database_failure_while_putting_back_says_both(
        db, lan, publish_fakes, monkeypatch):  # noqa: F811
    await _switched(db, lan, "orange")
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    real = publish._managed_hosts
    calls: list[int] = []

    async def second_call_fails(env_id):
        calls.append(1)
        if len(calls) > 1:
            raise RuntimeError("connection to sirdar-db lost (password=hunter2)")
        return await real(env_id)

    monkeypatch.setattr(publish, "_managed_hosts", second_call_fails)
    reason = await _fails(db, lan, "purple")
    assert reason.startswith("1 of 6 public URLs didn't answer: portal.")
    assert reason.endswith("Sirdar couldn't put the proxy hosts back: check them in Nginx "
                           "Proxy Manager.")
    assert "hunter2" not in reason


async def test_one_host_that_cant_be_put_back_is_named(db, lan, publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    wiki = _host(publish_fakes, "wiki.lan9.serversherpa.com")["id"]
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    real_handler = publish_fakes.npm.handler

    def fail_wiki_on_put_back(request):
        # The switch's own PUT to wiki goes through; the put-back's (to orange) fails.
        if (request.method == "PUT" and request.url.path.endswith(f"/proxy-hosts/{wiki}")
                and json.loads(request.content)["forward_host"] == ORANGE):
            publish_fakes.npm.put_errors.add(wiki)
        return real_handler(request)

    publish_fakes.npm.handler = fail_wiki_on_put_back
    reason = await _fails(db, lan, "purple")
    assert "Sirdar couldn't put 1 of 6 proxy hosts back: check them in Nginx Proxy Manager." \
        in reason
    assert "wiki.lan9.serversherpa.com: " in reason
    forwards = _forwards(publish_fakes)
    assert forwards["wiki.lan9.serversherpa.com"] == PURPLE_IP
    assert {ip for d, ip in forwards.items()
            if d.startswith(("api.", "portal.", "kiosk.", "status."))} == {ORANGE}


async def test_everything_else_on_a_host_survives(db, lan, publish_fakes):  # noqa: F811
    publish_fakes.npm.put_replaces = True          # a PUT drops what its body leaves out
    await _switched(db, lan, "orange")
    api = _host(publish_fakes, "api.lan9.serversherpa.com")
    api.update(access_list_id=3, advanced_config="proxy_read_timeout 600;",
               locations=[{"path": "/ws", "forward_host": "10.10.48.5", "forward_port": 81}])
    want_api = {k: api[k] for k in ("access_list_id", "advanced_config", "locations",
                                    "certificate_id", "ssl_forced", "http2_support")}
    spaces = _host(publish_fakes, "spaces.lan9.serversherpa.com")
    want_spaces = {k: spaces[k] for k in ("advanced_config", "certificate_id", "ssl_forced")}
    assert want_api["certificate_id"] and want_api["ssl_forced"]
    assert want_spaces["advanced_config"] == publish.SPACES_ADVANCED
    await _switched(db, lan, "purple")
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    await _fails(db, lan, "orange")
    api = _host(publish_fakes, "api.lan9.serversherpa.com")
    spaces = _host(publish_fakes, "spaces.lan9.serversherpa.com")
    assert api["forward_host"] == PURPLE_IP
    assert {k: api[k] for k in want_api} == want_api
    assert {k: spaces[k] for k in want_spaces} == want_spaces
