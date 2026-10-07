"""VM rows carry a role (migration 0012): today's single VM is `main`; a
LAN Blue/Green environment has `data`, `orange` and `purple`. Every helper
defaults to `main`, so single-server environments don't change."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import EnvironmentService, EsxiVm, VmSlot
from sirdar_api.deploy import cloudinit, terraform, vmcommon, vms

from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import ESXI_VALUES


def test_names():
    assert vms.vm_name("uat3") == "ss-uat3"
    assert vms.vm_name("uat3", "data") == "ss-uat3-data"
    long = "a" + "b" * 31                                  # the longest environment name
    assert vms.check_vm_hostname(vms.vm_name(long, "purple")) == f"ss-{long}-purple"
    # nothing longer than the code can produce: ss- + 32 characters + -purple
    with pytest.raises(vms.VmError):
        vms.check_vm_hostname(f"ss-{long}x-purple")


async def _esxi_row(db, env, role: str, ip: str) -> EsxiVm:
    spec = {"cores": 2, "memory_mb": 4096, "disk_gb": 40, "ip_mode": "static",
            "ip_cidr": f"{ip}/24", "gateway": "10.10.48.1"}
    return await vms.add_esxi(db, get_settings(), env, spec, ESXI_VALUES, role=role)


async def test_three_rows_per_environment(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", secrets={})
    for role, ip in (("data", "10.10.48.47"), ("orange", "10.10.48.48"),
                     ("purple", "10.10.48.49")):
        await _esxi_row(db, env, role, ip)
    await db.commit()
    rows = await vms.machines(db, env)
    assert [(r.role, r.name) for r in rows] == [
        ("data", "ss-lan1-data"), ("orange", "ss-lan1-orange"), ("purple", "ss-lan1-purple")]
    assert (await vms.get_for(db, env, "orange")).name == "ss-lan1-orange"
    assert await vms.get_for(db, env) is None                 # no main VM
    assert vms.public(rows[0])["role"] == "data"
    # Free the name first, so only the (environment, role) primary key can refuse.
    rows[0].name = "ss-lan1-old"
    await db.commit()
    with pytest.raises(IntegrityError) as err:
        await _esxi_row(db, env, "data", "10.10.48.50")      # one row per role
    assert "esxi_vms_pkey" in str(err.value)
    await db.rollback()


async def test_set_vm_and_record_address_touch_one_role(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", host="0.0.0.0", secrets={})
    for role, ip in (("data", "10.10.48.47"), ("orange", "10.10.48.48")):
        await _esxi_row(db, env, role, ip)
    await db.commit()
    # 0008's CHECK: moref and instance_uuid are set together
    await vmcommon.set_vm(EsxiVm, env.id, role="data", moref="7", instance_uuid="u-7")
    with pytest.MonkeyPatch.context() as mp:
        async def free(*args, **kwargs) -> bool:
            return False
        mp.setattr(vms, "address_in_use", free)
        moved = await vmcommon.record_address(get_settings(), EsxiVm, env.id, None,
                                              "10.10.48.47", host_label="ESXi", role="data",
                                              services=("spaces",))
    assert moved is True
    async with get_sessionmaker()() as s:
        rows = {r.role: r for r in await s.scalars(select(EsxiVm))}
        hosts = dict((await s.execute(select(EnvironmentService.service,
                                             EnvironmentService.host_ip))).all())
    assert (rows["data"].moref, rows["data"].ip) == ("7", "10.10.48.47")
    assert rows["data"].instance_uuid == "u-7"
    assert (rows["orange"].moref, rows["orange"].ip) == (None, None)
    assert hosts["spaces"] == "10.10.48.47" and hosts["api"] == "0.0.0.0"


async def test_an_environments_other_vm_holds_its_address(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", secrets={})
    data = await _esxi_row(db, env, "data", "10.10.48.47")
    data.ip = "10.10.48.47"
    await db.commit()
    taken = await vms.address_in_use(db, get_settings(), "10.10.48.47", proxy_ip="10.0.0.2",
                                     env_id=env.id, role="orange")
    assert taken is True
    assert await vms.address_in_use(db, get_settings(), "10.10.48.47", proxy_ip="10.0.0.2",
                                    env_id=env.id, role="data") is False


async def test_without_a_role_every_vm_of_the_environment_is_its_own(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", secrets={})
    for role, ip in (("data", "10.10.48.47"), ("orange", "10.10.48.48")):
        row = await _esxi_row(db, env, role, ip)
        row.ip = ip
    other = await make_environment(db, name="lan2", target_id="esxi", secrets={})
    await db.commit()
    for ip in ("10.10.48.47", "10.10.48.48"):
        assert await vms.address_in_use(db, get_settings(), ip, proxy_ip="10.0.0.2",
                                        env_id=env.id) is False
        assert await vms.address_in_use(db, get_settings(), ip, proxy_ip="10.0.0.2",
                                        env_id=other.id) is True


async def test_host_config_follows_the_slot(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", secrets={})
    for role, ip in (("data", "10.10.48.47"), ("orange", "10.10.48.48"),
                     ("purple", "10.10.48.49")):
        row = await _esxi_row(db, env, role, ip)
        row.ip = ip
    env.slots, env.active_slot = ["orange", "purple"], "purple"
    await db.commit()
    s = get_settings()
    assert (await vms.host_config(db, s, env)).host == "10.10.48.49"            # active
    assert (await vms.host_config(db, s, env, slot="orange")).host == "10.10.48.48"
    assert (await vms.host_config(db, s, env, role="data")).host == "10.10.48.47"


def test_terraform_workdir_per_role(tmp_path):
    import uuid
    from types import SimpleNamespace
    settings = SimpleNamespace(terraform_dir=str(tmp_path))      # workdir reads only this
    env_id = uuid.uuid4()
    assert terraform.workdir(settings, env_id) == tmp_path / str(env_id)
    assert terraform.workdir(settings, env_id, "data") == tmp_path / f"{env_id}-data"


def test_cloudinit_instance_id_per_role():
    import uuid
    env_id = uuid.uuid4()
    meta = cloudinit.metadata(env_id=env_id, hostname="ss-lan1-data", ip_cidr="10.10.48.47/24",
                              gateway="10.10.48.1", dns_servers=(), role="data")
    assert f"instance-id: sirdar-{env_id}-data" in meta
    main = cloudinit.metadata(env_id=env_id, hostname="ss-lan1", ip_cidr=None, gateway=None,
                              dns_servers=())
    assert f"instance-id: sirdar-{env_id}\n" in main


async def test_vm_slots_go_with_the_environment(db, secrets_key):
    env = await make_environment(db, name="lan1", target_id="esxi", secrets={})
    db.add(VmSlot(environment_id=env.id, slot="orange"))
    await db.commit()
    await db.delete(env)
    await db.commit()
    assert await db.scalar(select(VmSlot)) is None


@pytest.mark.parametrize("services,line", [
    (None, "Every service now points at 10.10.48.47.\n"),
    (("spaces",), "The spaces service now points at 10.10.48.47.\n"),
])
async def test_settle_address_names_the_services_it_moved(monkeypatch, services, line):
    async def nothing(*args, **kwargs):
        return None

    async def moved(*args, **kwargs) -> bool:
        return True

    async def no_pin() -> bool:
        return False

    import uuid
    monkeypatch.setattr(vmcommon, "check_address", nothing)
    monkeypatch.setattr(vmcommon, "record_address", moved)
    lines: list[str] = []
    await vmcommon.settle_address(get_settings(), model=EsxiVm, env_id=uuid.uuid4(),
                                  previous_ip=None, ip="10.10.48.47", pin=no_pin, actor_id=None,
                                  target_id="esxi", out=lines.append, host_label="ESXi",
                                  role="data", services=services)
    assert lines == [line]
