import pytest

from sirdar_api.deploy import steps


def keys(mode, **kw):
    return [s.key for s in steps.plan_for(mode, **kw)]


def test_the_vm_steps():
    by = steps.STEPS_BY_KEY
    assert [(by[k].number, by[k].name, by[k].runs, by[k].playbook)
            for k in ("provision", "vm_restore", "destroy")] == [
        (0, "Prepare VM", "vm", ""), (0, "Restore VM snapshot", "vm", ""),
        (15, "Destroy VM", "vm", "")]
    assert "vm_restore" in steps.MODES
    assert all(s.runs == "ansible" for s in steps.ANSIBLE_STEPS)


def test_a_proxmox_environment_s_host_plans_start_with_prepare_vm():
    for mode in steps.VM_HOST_MODES:
        for restore in ((False, True) if mode in ("update", "reset") else (False,)):
            for publish in (False, True):
                plain = keys(mode, restore=restore, publish=publish)
                assert keys(mode, restore=restore, publish=publish, vm=True) == [
                    "provision", *plain]
                numbers = [s.number for s in steps.plan_for(mode, restore=restore,
                                                             publish=publish, vm=True)]
                assert numbers == sorted(set(numbers)) and numbers[0] == 0


def test_deleting_a_proxmox_environment_destroys_the_vm_first():
    assert keys("teardown", vm=True) == ["destroy", "unproxy", "undns"]
    assert [s.number for s in steps.plan_for("teardown", vm=True)] == [15, 16, 17]
    assert keys("teardown") == ["teardown", "unproxy", "undns"]


def test_restore_vm_snapshot_is_a_plan_of_its_own():
    assert keys("vm_restore", vm=True) == ["vm_restore"]
    with pytest.raises(ValueError):
        steps.plan_for("vm_restore")
    with pytest.raises(ValueError):
        steps.plan_for("vm_restore", vm=True, publish=True)


def test_jobs_that_never_touch_the_vm():
    assert keys("snapshot", vm=True) == keys("snapshot")
    assert keys("publish", vm=True) == keys("publish")
