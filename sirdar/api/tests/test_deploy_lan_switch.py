"""Switch traffic on the LAN: every proxy host of the environment forwards
to the slot's VM, then the public names are checked through NPM; a failure
puts every proxy host back."""

from dataclasses import replace

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import EnvironmentService, EsxiVm
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


async def test_the_first_switch_creates_the_proxy_hosts(db, lan, publish_fakes):  # noqa: F811
    lines: list[str] = []
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lines.append)
    forwards = _forwards(publish_fakes)
    assert forwards["api.lan9.serversherpa.com"] == ORANGE
    assert forwards["spaces.lan9.serversherpa.com"] == DATA        # never switched
    assert "Traffic goes to orange" in "".join(lines)


async def test_a_switch_repoints_every_app_proxy_host(db, lan, publish_fakes):  # noqa: F811
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lambda _: None)
    await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    forwards = _forwards(publish_fakes)
    assert {d: ip for d, ip in forwards.items() if not d.startswith("spaces.")} == {
        d: PURPLE_IP for d in forwards if not d.startswith("spaces.")}
    assert forwards["spaces.lan9.serversherpa.com"] == DATA
    hosts = await _hosts(db, lan)
    assert hosts["spaces"] == DATA and hosts["api"] == PURPLE_IP and hosts["mailpit"] == PURPLE_IP


async def test_a_failed_smoke_test_puts_everything_back(db, lan, publish_fakes):  # noqa: F811
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lambda _: None)
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    with pytest.raises(publish.StepFailed) as e:
        await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    assert e.value.reason.endswith("Traffic stays where it was.")
    assert _app_forwards(publish_fakes) == {ORANGE}
    assert (await _hosts(db, lan))["api"] == ORANGE


async def test_a_slot_without_an_address_changes_nothing(db, lan, publish_fakes):  # noqa: F811
    await vmcommon.set_vm(EsxiVm, lan.id, role="purple", ip=None)
    with pytest.raises(publish.StepFailed) as e:
        await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    assert "purple VM has no address" in e.value.reason
    assert publish_fakes.npm.hosts == {}


async def test_no_slot_changes_nothing(db, lan, publish_fakes):  # noqa: F811
    with pytest.raises(publish.StepFailed) as e:
        await _publisher().run("lan_switch", await _ctx(db, lan, None), lambda _: None)
    assert "names no server" in e.value.reason
    assert publish_fakes.npm.hosts == {}


async def test_each_host_gets_its_own_previous_forward_host_back(db, lan,
                                                                 publish_fakes):  # noqa: F811
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lambda _: None)
    wiki = next(h for h in publish_fakes.npm.hosts.values()
                if h["domain_names"] == ["wiki.lan9.serversherpa.com"])
    wiki["forward_host"] = "10.10.48.77"        # changed by hand since
    publish_fakes.smoke.set("api.lan9.serversherpa.com", 502)
    with pytest.raises(publish.StepFailed):
        await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    forwards = _forwards(publish_fakes)
    assert forwards["wiki.lan9.serversherpa.com"] == "10.10.48.77"
    assert forwards["api.lan9.serversherpa.com"] == ORANGE
    assert forwards["spaces.lan9.serversherpa.com"] == DATA


async def test_only_the_environments_proxy_hosts_are_touched(db, lan,
                                                            publish_fakes):  # noqa: F811
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lambda _: None)
    other = publish_fakes.npm.add_host("api.elsewhere.serversherpa.com", "10.10.48.90", 8000)
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    with pytest.raises(publish.StepFailed):
        await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    assert publish_fakes.npm.hosts[other]["forward_host"] == "10.10.48.90"
    puts = [r for r in publish_fakes.npm.requests
            if r.method == "PUT" and r.url.path.endswith(f"/proxy-hosts/{other}")]
    assert puts == []


async def test_putting_back_fails_too(db, lan, publish_fakes, monkeypatch):  # noqa: F811
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lambda _: None)

    async def smoke_then_npm_down(*args, **kwargs):
        publish_fakes.npm.down = True
        raise publish.StepFailed("1 of 5 public URLs didn't answer: portal.")

    monkeypatch.setattr(publish, "run_smoke", smoke_then_npm_down)
    lines: list[str] = []
    with pytest.raises(publish.StepFailed) as e:
        await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lines.append)
    reason = e.value.reason
    assert reason.startswith("1 of 5 public URLs didn't answer: portal.")
    assert "Sirdar couldn't put the proxy hosts back (" in reason
    assert reason.endswith("check them in Nginx Proxy Manager.")
    assert NPM_PASSWORD not in reason and NPM_PASSWORD not in "".join(lines)
    # The database keeps the old addresses either way.
    assert (await _hosts(db, lan))["api"] == ORANGE


async def test_a_failed_proxy_step_puts_everything_back(db, lan, publish_fakes,
                                                      monkeypatch):  # noqa: F811
    await _publisher().run("lan_switch", await _ctx(db, lan, "orange"), lambda _: None)
    real = publish.ensure_proxy

    async def repoints_then_fails(ctx, out, **kwargs):
        await real(ctx, out, **kwargs)          # every host now forwards to purple
        raise NpmError("Nginx Proxy Manager didn't answer.")

    monkeypatch.setattr(publish, "ensure_proxy", repoints_then_fails)
    with pytest.raises(publish.StepFailed) as e:
        await _publisher().run("lan_switch", await _ctx(db, lan, "purple"), lambda _: None)
    assert e.value.reason == "Nginx Proxy Manager didn't answer. Traffic stays where it was."
    assert _app_forwards(publish_fakes) == {ORANGE}
    assert (await _hosts(db, lan))["api"] == ORANGE
