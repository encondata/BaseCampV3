import asyncio
import json
import os
import re
import stat
import uuid

import pytest

from sirdar_api.config import get_settings
from sirdar_api.deploy import terraform
from sirdar_api.deploy.terraform import SubprocessTerraform, TfRequest, VmSpec

from .conftest import API_DIR
from .integration_helpers import PX_CERT, PX_TOKEN

SPEC = VmSpec(env_name="uat3", name="ss-uat3", vmid=120, node="pve", pool="sirdar",
              storage="local-lvm", bridge="vmbr0", vlan_tag=None, template_vmid=9000,
              cores=4, memory_mb=8192, disk_gb=64, ip_cidr="10.10.48.70/24",
              gateway="10.10.48.1", ssh_public_key="ssh-ed25519 AAAAC3Nz sirdar@ss-uat3")
ENV_ID = uuid.UUID("11111111-2222-4333-8444-555555555555")


@pytest.fixture
def tf_dir(monkeypatch, tmp_path):
    folder = tmp_path / "terraform"
    monkeypatch.setenv("SIRDAR_TERRAFORM_DIR", str(folder))
    monkeypatch.setenv("SIRDAR_TERRAFORM_CLI_CONFIG", "/opt/terraform/terraformrc")
    get_settings.cache_clear()
    yield folder
    get_settings.cache_clear()


def test_the_vm_config():
    config = terraform.render_config("https://10.10.48.5:8006", SPEC)
    assert config["terraform"] == {
        "required_version": "= 1.16.5",
        "required_providers": {"proxmox": {"source": "bpg/proxmox", "version": "= 0.115.0"}}}
    assert config["provider"] == {"proxmox": {"endpoint": "https://10.10.48.5:8006",
                                              "insecure": False}}
    vm = config["resource"]["proxmox_virtual_environment_vm"]["vm"]
    assert (vm["name"], vm["node_name"], vm["vm_id"], vm["pool_id"], vm["tags"]) == (
        "ss-uat3", "pve", 120, "sirdar", ["sirdar", "ss-uat3"])
    assert vm["clone"] == {"vm_id": 9000, "full": True, "node_name": "pve",
                           "datastore_id": "local-lvm"}
    assert (vm["cpu"], vm["memory"]) == ({"cores": 4, "type": "host"}, {"dedicated": 8192})
    assert vm["disk"] == [{"datastore_id": "local-lvm", "interface": "scsi0", "size": 64,
                           "discard": "on", "iothread": True, "ssd": True}]
    assert vm["network_device"] == [{"bridge": "vmbr0", "model": "virtio"}]
    assert vm["agent"] == {"enabled": True, "trim": True, "timeout": "5m"}
    assert vm["initialization"] == {
        "datastore_id": "local-lvm",
        "user_account": {"username": "deploy", "keys": [SPEC.ssh_public_key]},
        "ip_config": [{"ipv4": {"address": "10.10.48.70/24", "gateway": "10.10.48.1"}}]}
    assert (vm["started"], vm["on_boot"], vm["stop_on_destroy"], vm["purge_on_destroy"]) == (
        True, True, True, True)
    # bpg/proxmox's clone fields force a new VM: never act on a change there.
    assert vm["lifecycle"] == {"ignore_changes": ["clone"]}
    assert PX_TOKEN not in json.dumps(config)


def test_step_0_plans_then_applies_the_saved_plan():
    assert terraform.PLAN == ("plan", "-input=false", "-no-color", "-out=tfplan")
    assert terraform.SHOW == ("show", "-json", "-no-color", "tfplan")
    assert terraform.APPLY == ("apply", "-input=false", "-no-color", "tfplan")
    assert "-auto-approve" in terraform.DESTROY


@pytest.mark.parametrize("plan, ok", [
    ({"resource_changes": [{"change": {"actions": ["update"]}}]}, True),
    ({"resource_changes": [{"change": {"actions": ["no-op"]}}]}, True),
    ({"resource_changes": [{"change": {"actions": ["create"]}}]}, True),
    ({}, True),
    ({"resource_changes": [{"change": {"actions": ["delete", "create"]}}]}, False),
    ({"resource_changes": [{"change": {"actions": ["create", "delete"]}}]}, False),
    ({"resource_changes": [{"change": {"actions": ["no-op"]}},
                           {"change": {"actions": ["delete"]}}]}, False),
])
def test_a_plan_that_deletes(plan, ok):
    assert terraform.plan_deletes(plan) is not ok


@pytest.mark.parametrize("plan", [[], "x", {"resource_changes": "x"},
                                  {"resource_changes": [{"change": {}}]},
                                  {"resource_changes": [{"change": {"actions": "delete"}}]}])
def test_a_plan_of_the_wrong_shape(plan):
    with pytest.raises(ValueError):
        terraform.plan_deletes(plan)


def test_dhcp_and_a_vlan():
    from dataclasses import replace
    vm = terraform.render_config("https://pve.lab:8006", replace(
        SPEC, ip_cidr=None, gateway=None, vlan_tag=40))["resource"][
        "proxmox_virtual_environment_vm"]["vm"]
    assert vm["initialization"]["ip_config"] == [{"ipv4": {"address": "dhcp"}}]
    assert vm["network_device"] == [{"bridge": "vmbr0", "model": "virtio", "vlan_id": 40}]


def test_the_working_folder_is_private_and_per_environment(tf_dir):
    settings = get_settings()
    config = terraform.render_config("https://10.10.48.5:8006", SPEC)
    work = terraform.prepare_workdir(settings, ENV_ID, config, PX_CERT)
    assert work == tf_dir / str(ENV_ID) == terraform.workdir(settings, ENV_ID)
    for folder in (tf_dir, work, work / "home", work / "ca"):
        assert stat.S_IMODE(folder.stat().st_mode) == 0o700, folder
    for name in ("main.tf.json", "proxmox-ca.pem"):
        assert stat.S_IMODE((work / name).stat().st_mode) == 0o600, name
    assert json.loads((work / "main.tf.json").read_text()) == config
    assert (work / "proxmox-ca.pem").read_text() == PX_CERT
    assert list((work / "ca").iterdir()) == []
    assert terraform.needs_init(work) and not terraform.has_state(work)
    (work / ".terraform").mkdir()
    (work / "terraform.tfstate").write_text(json.dumps({"resources": [{"type": "x"}]}))
    (work / "crash.log").write_text("panic")
    terraform.prepare_workdir(settings, ENV_ID, config, PX_CERT)       # a second run
    assert not terraform.needs_init(work) and terraform.has_state(work)
    assert not (work / "crash.log").exists()
    (work / "terraform.tfstate").write_text(json.dumps({"resources": []}))
    assert not terraform.has_state(work)
    terraform.remove_workdir(settings, ENV_ID)
    assert not work.exists() and tf_dir.is_dir()
    terraform.remove_workdir(settings, ENV_ID)                          # already gone


def test_an_unwritable_folder(monkeypatch, tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir(mode=0o500)
    monkeypatch.setenv("SIRDAR_TERRAFORM_DIR", str(locked / "terraform"))
    get_settings.cache_clear()
    try:
        with pytest.raises(terraform.TerraformDirUnwritable):
            terraform.prepare_workdir(get_settings(), ENV_ID, {}, PX_CERT)
    finally:
        locked.chmod(0o700)
        get_settings.cache_clear()


def test_terraform_s_environment_is_an_allowlist(tf_dir, monkeypatch):
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "never-passed-on")
    settings = get_settings()
    work = terraform.prepare_workdir(settings, ENV_ID, {}, PX_CERT)
    env = terraform.run_env(settings, work, PX_TOKEN)
    assert env["PROXMOX_VE_API_TOKEN"] == PX_TOKEN
    assert env["SSL_CERT_FILE"] == str(work / "proxmox-ca.pem")
    assert env["SSL_CERT_DIR"] == str(work / "ca")
    assert env["HOME"] == str(work / "home")
    assert env["TF_CLI_CONFIG_FILE"] == "/opt/terraform/terraformrc"
    assert (env["TF_IN_AUTOMATION"], env["TF_INPUT"], env["CHECKPOINT_DISABLE"]) == (
        "1", "0", "1")
    assert not [k for k in env if k.startswith(("SIRDAR_", "AWS_", "SS_", "TF_LOG"))]
    assert set(env) <= {"PATH", "LANG", "TZ", "HOME", "TF_CLI_CONFIG_FILE",
                        "TF_IN_AUTOMATION", "TF_INPUT", "CHECKPOINT_DISABLE", "SSL_CERT_FILE",
                        "SSL_CERT_DIR", "PROXMOX_VE_API_TOKEN"}


def _fake_binary(tmp_path, body: str):
    script = tmp_path / "fake-terraform"
    script.write_text("#!/bin/sh\n" + body)
    script.chmod(0o700)
    return str(script)


async def test_the_runner_streams_output_and_reports_the_exit(tmp_path):
    binary = _fake_binary(tmp_path, 'echo "args: $*"\n'
                                    'echo "token: ${PROXMOX_VE_API_TOKEN:+set}"\n'
                                    'echo "db: ${SIRDAR_DATABASE_URL:-absent}"\n'
                                    'exit "${FAKE_EXIT:-0}"\n')
    lines: list[str] = []
    env = {"PATH": os.environ["PATH"], "PROXMOX_VE_API_TOKEN": PX_TOKEN}
    result = await SubprocessTerraform(binary).run(
        TfRequest(args=terraform.APPLY, workdir=tmp_path, env=env, timeout=30), lines.append)
    assert (result.status, result.rc) == ("successful", 0)
    assert "".join(lines) == ("args: apply -input=false -no-color tfplan\n"
                              "token: set\ndb: absent\n")
    result = await SubprocessTerraform(binary).run(
        TfRequest(args=terraform.INIT, workdir=tmp_path, env={**env, "FAKE_EXIT": "1"},
                  timeout=30), lines.append)
    assert (result.status, result.rc) == ("failed", 1)
    assert PX_TOKEN not in repr(TfRequest(args=terraform.INIT, workdir=tmp_path, env=env,
                                          timeout=1))


async def test_a_run_that_takes_too_long_is_stopped(tmp_path):
    binary = _fake_binary(tmp_path, "trap 'echo interrupted; exit 130' INT\n"
                                    "sleep 30 >/dev/null 2>&1 &\nwait\n")
    lines: list[str] = []
    result = await SubprocessTerraform(binary, grace=5).run(
        TfRequest(args=terraform.APPLY, workdir=tmp_path, env={"PATH": os.environ["PATH"]},
                  timeout=1), lines.append)
    assert result.status == "timeout"
    assert "interrupted\n" in lines


async def test_cancel_stops_the_process(tmp_path):
    binary = _fake_binary(tmp_path, "echo started\nexec sleep 30\n")
    started = asyncio.Event()

    def out(line):
        started.set()

    task = asyncio.create_task(SubprocessTerraform(binary, grace=1).run(
        TfRequest(args=terraform.APPLY, workdir=tmp_path, env={"PATH": os.environ["PATH"]},
                  timeout=60), out))
    await asyncio.wait_for(started.wait(), 10)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_the_guard_refuses_a_real_terraform(no_real_hosts, tmp_path):
    with pytest.raises(AssertionError):
        await SubprocessTerraform("terraform").run(
            TfRequest(args=terraform.INIT, workdir=tmp_path, env={}, timeout=5), print)
    assert no_real_hosts == ["terraform:terraform"]
    no_real_hosts.clear()


def test_the_image_pins_the_versions_this_module_renders():
    dockerfile = (API_DIR.parent / "Dockerfile").read_text()
    pins = dict(re.findall(r"^ARG (TERRAFORM_VERSION|PROXMOX_PROVIDER_VERSION)=(\S+)$",
                           dockerfile, re.M))
    assert pins == {"TERRAFORM_VERSION": terraform.TERRAFORM_VERSION,
                    "PROXMOX_PROVIDER_VERSION": terraform.PROVIDER_VERSION}
    assert dockerfile.count("sha256sum -c -") == 2
    rc = (API_DIR.parent / "terraformrc").read_text()
    assert "filesystem_mirror" in rc and "/opt/terraform/providers" in rc
    assert "direct" not in rc


@pytest.mark.parametrize("pem", ["", "   \n", "not a certificate",
                                 PX_CERT + PX_CERT,
                                 PX_CERT.replace("MI", "XX", 1)],
                         ids=["empty", "blank", "text", "two", "garbled"])
def test_the_pinned_certificate_must_be_exactly_one(tf_dir, pem):
    """An empty or garbled pin would leave Go's default trust in place."""
    with pytest.raises(terraform.PinnedCertificateInvalid) as caught:
        terraform.prepare_workdir(get_settings(), ENV_ID, {}, pem)
    assert "BEGIN" not in str(caught.value)
    assert not (tf_dir / str(ENV_ID) / "proxmox-ca.pem").exists()


async def test_a_long_line_does_not_stall_the_run(tmp_path):
    binary = _fake_binary(tmp_path, "head -c 204800 /dev/zero | tr '\\0' x\necho\n"
                                    "head -c 2097152 /dev/zero | tr '\\0' y >&2\necho\n"
                                    "echo done\n")
    lines: list[str] = []
    result = await asyncio.wait_for(SubprocessTerraform(binary).run(
        TfRequest(args=terraform.APPLY, workdir=tmp_path, env={"PATH": os.environ["PATH"]},
                  timeout=20), lines.append), 30)
    assert (result.status, result.rc) == ("successful", 0)
    assert "x" * 204800 + "\n" in lines
    assert lines[-1].endswith("done\n")


async def test_an_on_output_error_does_not_stall_the_run(tmp_path, caplog):
    binary = _fake_binary(tmp_path, "i=0\nwhile [ $i -lt 5000 ]; do\n"
                                    "  echo \"line $i secret-ish payload padding padding\"\n"
                                    "  i=$((i+1))\ndone\necho done\n")
    seen: list[str] = []

    def out(line):
        seen.append(line)
        raise RuntimeError(f"boom {line}")

    result = await asyncio.wait_for(SubprocessTerraform(binary).run(
        TfRequest(args=terraform.APPLY, workdir=tmp_path, env={"PATH": os.environ["PATH"]},
                  timeout=20), out), 30)
    assert (result.status, result.rc) == ("successful", 0)
    assert seen[-1] == "done\n" and len(seen) == 5001
    errors = [r for r in caplog.records if r.name == terraform.__name__]
    assert len(errors) == 1
    assert "RuntimeError" in errors[0].getMessage()
    assert "boom" not in caplog.text and "payload" not in caplog.text


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.parametrize("second_cancel", [False, True])
async def test_a_process_that_ignores_sigint_is_killed(tmp_path, second_cancel):
    pidfile = tmp_path / "child.pid"
    binary = _fake_binary(tmp_path, "trap '' INT\n"
                                    f"sh -c 'trap \"\" INT; echo $$ > {pidfile}; "
                                    "exec sleep 60' &\n"
                                    "echo started\nwait\nwait\n")
    started = asyncio.Event()
    runner = SubprocessTerraform(binary, grace=0.5 if not second_cancel else 30)
    task = asyncio.create_task(runner.run(
        TfRequest(args=terraform.APPLY, workdir=tmp_path, env={"PATH": os.environ["PATH"]},
                  timeout=60), lambda line: started.set()))
    await asyncio.wait_for(started.wait(), 10)
    for _ in range(100):
        if pidfile.exists() and pidfile.read_text().strip():
            break
        await asyncio.sleep(0.05)
    child = int(pidfile.read_text())
    task.cancel()
    if second_cancel:                    # cancel again during the grace wait
        await asyncio.sleep(0.3)
        task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 10)
    for _ in range(50):
        if not _alive(child):
            break
        await asyncio.sleep(0.05)
    assert not _alive(child)
