"""Switch traffic on the LAN through Switchyard: the hosts' upstreams move
to the slot's VM in one apply, the public names are checked, and a failure
puts every upstream back (and applies that)."""

from dataclasses import replace

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import EnvironmentService, EsxiVm
from sirdar_api.deploy import publish, vmcommon
from sirdar_api.deploy.publish import DNS

from .deploy_factories import secrets_key  # noqa: F401
from .integration_helpers import SY_KEY, configure, configure_esxi
from .lan_helpers import DATA, ORANGE, make_bluegreen_environment
from .publish_helpers import managed, publish_fakes  # noqa: F401
from .test_deploy_lan_switch import PURPLE_IP, _live, _no_sleep


@pytest.fixture
async def lan(db, secrets_key):  # noqa: F811
    await configure_esxi(db)
    await configure(db, npm=False, switchyard=True)
    env = await make_bluegreen_environment(db, proxy="switchyard")
    for n, (role, ip) in enumerate((("orange", ORANGE), ("purple", PURPLE_IP),
                                    ("data", DATA))):
        await vmcommon.set_vm(EsxiVm, env.id, role=role, ip=ip, created=True,
                              moref=f"vm-{n}", instance_uuid=f"uuid-{role}")
    await managed(db, env, "home", DNS, "rec-home", name="lan9.serversherpa.com")
    return env


def _publisher():
    return publish.HttpPublisher(sleep=_no_sleep, smoke_attempts=1, smoke_delay=0)


async def _ctx(db, env, slot):
    return replace(await publish.prepare(db, env, get_settings()), slot=slot)


def _upstreams(fakes, applied=True) -> dict[str, str]:
    hosts = fakes.sy.applied if applied else fakes.sy.hosts
    return {h["domains"][0]: h["upstreams"][0]["host"] for h in hosts.values()
            if h["type"] == "proxy"}


async def _switched(db, env, slot, lines=None) -> None:
    await _publisher().run("lan_switch", await _ctx(db, env, slot),
                           lines.append if lines is not None else lambda _: None)
    await _live(env, slot)


async def _fails(db, env, slot, lines=None) -> str:
    with pytest.raises(publish.StepFailed) as e:
        await _publisher().run("lan_switch", await _ctx(db, env, slot),
                               lines.append if lines is not None else lambda _: None)
    return e.value.reason


async def test_the_first_switch_creates_hosts_and_applies(db, lan, publish_fakes):  # noqa: F811
    lines: list[str] = []
    await _switched(db, lan, "orange", lines)
    ups = _upstreams(publish_fakes)
    assert ups["api.lan9.serversherpa.com"] == ORANGE
    assert ups["spaces.lan9.serversherpa.com"] == DATA
    home = next(h for h in publish_fakes.sy.applied.values()
                if h["domains"] == ["lan9.serversherpa.com"])
    assert home["type"] == "redirect"
    assert publish_fakes.sy.applies == ["Sirdar: lan9 switch to orange"]
    assert "Traffic goes to orange" in "".join(lines)
    assert SY_KEY not in "".join(lines)


async def test_a_switch_moves_every_app_upstream_in_one_apply(db, lan,
                                                              publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    await _switched(db, lan, "purple")
    ups = _upstreams(publish_fakes)
    assert {d: ip for d, ip in ups.items() if not d.startswith("spaces.")} == {
        d: PURPLE_IP for d in ups if not d.startswith("spaces.")}
    assert ups["spaces.lan9.serversherpa.com"] == DATA
    assert publish_fakes.sy.applies[-1] == "Sirdar: lan9 switch to purple"
    assert len(publish_fakes.sy.applies) == 2
    hosts = dict((await db.execute(select(EnvironmentService.service, EnvironmentService.host_ip)
                                   .where(EnvironmentService.environment_id == lan.id)
                                   .execution_options(populate_existing=True))).all())
    assert hosts["api"] == PURPLE_IP and hosts["spaces"] == DATA


async def test_a_failed_smoke_test_puts_the_upstreams_back(db, lan,
                                                           publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    lines: list[str] = []
    reason = await _fails(db, lan, "purple", lines)
    assert reason.endswith("Traffic stays where it was.")
    assert set(_upstreams(publish_fakes).values()) == {ORANGE, DATA}
    assert publish_fakes.sy.applies[-2:] == ["Sirdar: lan9 switch to purple",
                                             "Sirdar: lan9 put traffic back"]
    assert "api.lan9.serversherpa.com: Switchyard host back to 127.0.0.1\n" in lines


async def test_a_failed_first_switch_leaves_no_hosts(db, lan, publish_fakes):  # noqa: F811
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    reason = await _fails(db, lan, "orange")
    assert reason.endswith("No slot was live before, so nothing to put back.")
    assert publish_fakes.sy.hosts == {} and publish_fakes.sy.applied == {}


async def test_caddy_refusing_the_switch_changes_nothing_live(db, lan,
                                                              publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    publish_fakes.sy.reject_apply = "loading config: nope"
    reason = await _fails(db, lan, "purple")
    assert reason.startswith("Caddy refused the change and kept the old config: loading "
                             "config: nope")
    assert set(_upstreams(publish_fakes).values()) == {ORANGE, DATA}
    assert set(_upstreams(publish_fakes, applied=False).values()) == {ORANGE, DATA}


async def test_putting_back_fails_too(db, lan, publish_fakes, monkeypatch):  # noqa: F811
    await _switched(db, lan, "orange")

    async def smoke_then_down(*args, **kwargs):
        publish_fakes.sy.down = True
        raise publish.StepFailed("1 of 5 public URLs didn't answer: portal.")

    monkeypatch.setattr(publish, "run_smoke", smoke_then_down)
    reason = await _fails(db, lan, "purple")
    assert "Sirdar couldn't put the proxy hosts back (" in reason
    assert reason.endswith("check them in Switchyard.")


async def test_switching_needs_switchyard(db, secrets_key, publish_fakes):  # noqa: F811
    await configure_esxi(db)
    await configure(db, npm=False, switchyard=True)
    env = await make_bluegreen_environment(db, proxy="switchyard")
    await vmcommon.set_vm(EsxiVm, env.id, role="orange", ip=ORANGE, created=True,
                          moref="vm-1", instance_uuid="u1")
    await managed(db, env, "api", publish.SY_HOST, 99, name="api.lan9.serversherpa.com")
    publish_fakes.sy.key = "sy_wrong"
    reason = await _fails(db, env, "orange")
    assert reason == "Switchyard rejected the API key. Sirdar changed nothing."
