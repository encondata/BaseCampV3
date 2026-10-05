import uuid

import pytest

from sirdar_api.config import get_settings
from sirdar_api.db.models import Deployment
from sirdar_api.deploy import vmcommon, vmsteps
from sirdar_api.deploy.vmcommon import VmPrepareError

from .deploy_factories import make_environment, secrets_key  # noqa: F401


def test_to_prune_keeps_the_newest_recorded_and_never_hand_made():
    names = ["sirdar-20261001T000000Z", "sirdar-20261002T000000Z", "sirdar-20261003T000000Z",
             "sirdar-20261004T000000Z", "sirdar-20200101T000000Z", "before upgrade"]
    recorded = {"sirdar-20261001T000000Z", "sirdar-20261002T000000Z",
                "sirdar-20261003T000000Z", "sirdar-20261004T000000Z", "before upgrade"}
    assert vmcommon.to_prune(names, recorded, 3) == ["sirdar-20261001T000000Z"]
    assert vmcommon.to_prune(names, recorded, 10) == []


async def test_recording_and_clearing_a_vm_snapshot(db):
    env = await make_environment(db, name="uat3")
    dep = Deployment(id=uuid.uuid4(), environment_id=env.id, mode="update", git_ref="main",
                     sha="", status="running", start_step=0, vm=True)
    db.add(dep)
    await db.commit()
    await vmcommon.record_vm_snapshot(dep.id, "sirdar-20261005T120000Z")
    assert await vmcommon.recorded_snapshots(env.id) == {"sirdar-20261005T120000Z"}
    await vmcommon.record_vm_snapshot(dep.id, None)
    assert await vmcommon.recorded_snapshots(env.id) == set()


async def test_the_probe_is_guarded_here(no_real_hosts):
    with pytest.raises(AssertionError):
        await vmcommon.tcp_open("10.10.48.71", 22)
    assert no_real_hosts == ["probe:10.10.48.71"]
    no_real_hosts.clear()


async def test_an_ssh_environment_has_no_vm_steps(db, secrets_key):
    env = await make_environment(db, name="uat3")
    dep = Deployment(environment_id=env.id, mode="update", git_ref="main", sha="",
                     status="running", start_step=0, vm=True)
    with pytest.raises(VmPrepareError):
        await vmsteps.prepare(db, env, dep, get_settings())
