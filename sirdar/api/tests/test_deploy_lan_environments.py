"""Creating a LAN Blue/Green environment: three VM rows, two slots, the
services' first addresses, and the checks."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import EnvironmentService, VmSlot
from sirdar_api.deploy import environments, lan_slots, serialize, vms

from .deploy_factories import secrets_key  # noqa: F401
from .integration_helpers import configure, configure_esxi, configure_proxmox
from .lan_helpers import DATA, LAN_VM, ORANGE, PURPLE, make_bluegreen_environment


@pytest.fixture
async def esxi(db, secrets_key):
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)


async def test_create_builds_three_records_and_two_slots(db, esxi):
    env = await make_bluegreen_environment(db, auto_activate=True)
    assert (env.slots, env.active_slot, env.auto_activate) == (["orange", "purple"], None, True)
    assert lan_slots.is_bluegreen(env)
    rows = await vms.machines(db, env)
    assert [(r.role, r.name, vms.static_ip(r.ip_cidr), r.cores, r.disk_gb) for r in rows] == [
        ("data", "ss-lan9-data", DATA, 2, 60), ("orange", "ss-lan9-orange", ORANGE, 2, 40),
        ("purple", "ss-lan9-purple", PURPLE, 2, 40)]
    assert sorted((await lan_slots.slots_of(db, env.id))) == ["orange", "purple"]
    hosts = dict((await db.execute(select(EnvironmentService.service, EnvironmentService.host_ip)
                                   .where(EnvironmentService.environment_id == env.id))).all())
    assert hosts["spaces"] == DATA
    assert {h for s, h in hosts.items() if s != "spaces"} == {ORANGE}


async def test_the_json_lists_the_machines_and_slots(db, esxi):
    env = await make_bluegreen_environment(db)
    out = await serialize.environment_out(db, env)
    assert out["vm"] is None
    assert [m["role"] for m in out["machines"]] == ["data", "orange", "purple"]
    assert out["lan_slots"] == [
        {"slot": "orange", "ip": None, "sha": None, "image_tag": None, "active": False,
         "last_check_ok": None, "last_check_at": None},
        {"slot": "purple", "ip": None, "sha": None, "image_tag": None, "active": False,
         "last_check_ok": None, "last_check_at": None}]


@pytest.mark.parametrize("change, code", [
    ({"ip_mode": "dhcp", "ip_cidr": None, "gateway": None}, "vm_static_required"),
    ({"purple_ip_cidr": f"{ORANGE}/8"}, "vm_ips_not_distinct"),
    ({"data_ip_cidr": None}, "vm_ip_invalid"),
    ({"slots": 3}, "vm_invalid"),
    ({"auto_activate": "yes"}, "vm_invalid"),
])
async def test_create_refusals(db, esxi, change, code):
    with pytest.raises(environments.EnvError) as e:
        await make_bluegreen_environment(db, **change)
    assert e.value.code == code


async def test_needs_npm(db, secrets_key):
    await configure_esxi(db)
    with pytest.raises(environments.EnvError) as e:
        await make_bluegreen_environment(db)
    assert (e.value.code, e.value.extra) == ("integration_not_configured", {"kinds": ["npm"]})


async def test_only_on_a_vm_host(db, secrets_key):
    with pytest.raises(environments.EnvError) as e:
        await environments.create_new(db, get_settings(), name="x1", type_="dev",
                                      target_id="ssh", proxy_ip="10.0.0.2", vm=LAN_VM)
    assert e.value.code in ("bluegreen_not_allowed", "target_not_configured")


async def test_proxmox_too(db, secrets_key):
    await configure_proxmox(db)
    await configure(db, cloudflare=True, npm=True)
    env = await make_bluegreen_environment(db, target="proxmox")
    assert [r.role for r in await vms.machines(db, env)] == ["data", "orange", "purple"]


async def test_a_single_server_environment_is_unchanged(db, esxi):
    from .vm_helpers import make_esxi_environment
    env = await make_esxi_environment(db, name="solo")
    assert (env.slots, lan_slots.is_bluegreen(env)) == ([], False)
    assert [r.role for r in await vms.machines(db, env)] == ["main"]
    assert await db.scalar(select(VmSlot)) is None


# ---- VM names can't collide across environments -------------------------------------------
# vm_name("lan1", "data") and vm_name("lan1-data") are both ss-lan1-data.

async def test_a_single_server_name_taken_by_a_bluegreen_vm(db, esxi):
    from .vm_helpers import make_esxi_environment
    await make_bluegreen_environment(db, name="lan1")
    with pytest.raises(environments.EnvError) as e:
        await make_esxi_environment(db, name="lan1-data")
    assert (e.value.code, e.value.extra) == ("vm_name_taken", {"name": "ss-lan1-data"})


async def test_a_bluegreen_name_taken_by_a_single_server_vm(db, esxi):
    from .vm_helpers import make_esxi_environment
    await make_esxi_environment(db, name="lan1-purple")
    with pytest.raises(environments.EnvError) as e:
        await make_bluegreen_environment(db, name="lan1")
    assert (e.value.code, e.value.extra) == ("vm_name_taken", {"name": "ss-lan1-purple"})


async def test_a_proxmox_name_is_checked_against_esxi_too(db, esxi):
    await configure_proxmox(db)
    from .vm_helpers import make_esxi_environment
    await make_esxi_environment(db, name="lan1-orange")
    with pytest.raises(environments.EnvError) as e:
        await make_bluegreen_environment(db, name="lan1", target="proxmox")
    assert (e.value.code, e.value.extra) == ("vm_name_taken", {"name": "ss-lan1-orange"})


async def test_a_lost_race_on_the_name_key_is_vm_name_taken(db, esxi, monkeypatch):
    """Two creates both passed the check: the unique key settles it."""
    from .vm_helpers import make_esxi_environment
    await make_bluegreen_environment(db, name="lan1")

    async def none_taken(*args, **kwargs):
        return None

    monkeypatch.setattr(environments, "_vm_name_taken", none_taken)
    with pytest.raises(environments.EnvError) as e:
        await make_esxi_environment(db, name="lan1-data")
    assert (e.value.code, e.value.extra) == ("vm_name_taken", {"name": "ss-lan1-data"})
    await db.rollback()


def test_vm_name_taken_is_a_conflict():
    from sirdar_api.api.routes import deploy
    err = deploy._env_http(environments.EnvError("vm_name_taken", name="ss-lan1-data"))
    assert (err.status_code, err.detail) == (409, {"code": "vm_name_taken",
                                                   "name": "ss-lan1-data"})


# ---- review follow-ups ---------------------------------------------------------------------

@pytest.mark.parametrize("taken", [PURPLE, DATA])
async def test_each_address_is_checked(db, esxi, taken):
    """The real address check: another environment's VM already has purple's
    (or the data VM's) address."""
    from .vm_helpers import make_esxi_environment
    await make_esxi_environment(db, name="other", ip_cidr=f"{taken}/8")
    with pytest.raises(environments.EnvError) as e:
        await make_bluegreen_environment(db, check_addresses=True)
    assert e.value.code == "ip_in_use"


async def test_the_real_address_check_passes_free_addresses(db, esxi):
    env = await make_bluegreen_environment(db, check_addresses=True)
    assert [r.role for r in await vms.machines(db, env)] == ["data", "orange", "purple"]


async def test_not_on_digitalocean(db, secrets_key):
    with pytest.raises(environments.EnvError) as e:
        await environments.create_new(db, get_settings(), name="x1", type_="dev",
                                      target_id="digitalocean", vm=LAN_VM)
    assert (e.value.code, e.value.extra) == ("bluegreen_not_allowed", {})


async def test_not_production(db, esxi):
    with pytest.raises(environments.EnvError) as e:
        await environments.create_new(db, get_settings(), name="x1", type_="production",
                                      target_id="esxi", proxy_ip="10.0.0.2", vm=LAN_VM)
    assert e.value.code == "production_requires_digitalocean"


@pytest.mark.parametrize("change, code", [
    ({"gateway": "10.0.0.1"}, "vm_gateway_invalid"),
    ({"data": {"cores": 0}}, "vm_cores_invalid"),
    ({"data": {"memory_mb": 1024}}, "vm_memory_invalid"),
    ({"data": "big"}, "vm_invalid"),
    ({"slots": True}, "vm_invalid"),
    ({"slots": 2.0}, "vm_invalid"),
    ({"slots": "2"}, "vm_invalid"),
    # each has the gateway in its own network, but the networks differ
    ({"purple_ip_cidr": f"{PURPLE}/24"}, "vm_subnet_mismatch"),
    ({"data_ip_cidr": f"{DATA}/16"}, "vm_subnet_mismatch"),
])
async def test_more_refusals(db, esxi, change, code):
    with pytest.raises(environments.EnvError) as e:
        await make_bluegreen_environment(db, **change)
    assert e.value.code == code


@pytest.mark.parametrize("slots", [True, 1.0, "1", 0])
async def test_a_single_server_slots_value_is_strict(db, esxi, slots):
    from .vm_helpers import make_esxi_environment
    with pytest.raises(environments.EnvError) as e:
        await make_esxi_environment(db, name="solo", slots=slots)
    assert e.value.code == "vm_invalid"


async def test_slots_1_is_a_single_server(db, esxi):
    from .vm_helpers import make_esxi_environment
    env = await make_esxi_environment(db, name="solo", slots=1)
    assert [r.role for r in await vms.machines(db, env)] == ["main"]


async def _no_name_check(*args, **kwargs):
    return None


@pytest.mark.parametrize("target, other, taken", [
    ("esxi", "lan1-purple", "ss-lan1-purple"),
    ("proxmox", "lan1-data", "ss-lan1-data"),
])
async def test_a_bluegreen_lost_race_names_the_vm(db, secrets_key, monkeypatch,
                                                  target, other, taken):
    from .vm_helpers import make_esxi_environment, make_vm_environment
    await configure_esxi(db)
    await configure_proxmox(db)
    await configure(db, cloudflare=True, npm=True)
    make = make_esxi_environment if target == "esxi" else make_vm_environment
    await make(db, name=other, ip_cidr="127.0.0.9/8")
    monkeypatch.setattr(environments, "_vm_name_taken", _no_name_check)
    with pytest.raises(environments.EnvError) as e:
        await make_bluegreen_environment(db, name="lan1", target=target)
    assert (e.value.code, e.value.extra) == ("vm_name_taken", {"name": taken})
    await db.rollback()
