import uuid
from datetime import UTC, datetime

import asyncssh
import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, Deployment, Integration
from sirdar_api.deploy import gitref, known_hosts, provision, proxmox, terraform, vms
from sirdar_api.deploy.provision import VmOutcome, VmPrepareError
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.terraform import TfResult

from .deploy_factories import secrets_key  # noqa: F401
from .fake_terraform import FakeTerraform
from .integration_helpers import PX_TOKEN, PX_TOKEN_SECRET, configure_proxmox
from .proxmox_helpers import no_sleep, proxmox_fake  # noqa: F401
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .vm_helpers import apply_creates_vm, destroy_removes_vm, host_key_line, make_vm_environment

SHA = "e73b99ca" + "0" * 32
OLD = "a" * 40
NOW = datetime(2026, 10, 4, 12, 0, 0, tzinfo=UTC)
SNAP = "sirdar-20261004T120000Z"


@pytest.fixture
async def vm_env(db, deploy_env, secrets_key, ssh_server, proxmox_fake, monkeypatch, tmp_path):
    """uat3 on Proxmox; the tests' SSH server plays its VM (127.0.0.1). No
    SSH target is configured (deploy_env blanks them)."""
    monkeypatch.setenv("SIRDAR_TERRAFORM_DIR", str(tmp_path / "terraform"))
    get_settings.cache_clear()
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_proxmox(db)
    yield await make_vm_environment(db)
    get_settings.cache_clear()


@pytest.fixture
def tf(proxmox_fake, ssh_server):
    runner = FakeTerraform()
    runner.effects["apply"] = apply_creates_vm(proxmox_fake, host_key_line(ssh_server))
    runner.effects["destroy"] = destroy_removes_vm(proxmox_fake)
    return runner


async def nothing_answers(host, port):
    return False


def resolves_to(sha: str, calls: list | None = None):
    async def resolve(cfg, db, repo_url, ref):
        if calls is not None:
            calls.append((cfg.host, cfg.user, ref))
        return sha
    return resolve


def provisioner(tf, **kw):
    kw.setdefault("probe", nothing_answers)
    kw.setdefault("resolve", resolves_to(SHA))
    for key, value in (("poll", 1), ("agent_wait", 3), ("ssh_wait", 3)):
        kw.setdefault(key, value)
    return provision.ProxmoxProvisioner(terraform_runner=tf, settings=get_settings(),
                                        sleep=no_sleep, now=lambda: NOW, **kw)


async def ctx_for(db, env, *, mode="update", sha="", take=False, vm_snapshot=None):
    dep = Deployment(id=uuid.uuid4(), environment_id=env.id, mode=mode, git_ref="main",
                     sha=sha, status="running", start_step=0, vm=True,
                     take_vm_snapshot=take, vm_snapshot=vm_snapshot)
    return await provision.prepare(db, env, dep, get_settings())


async def _built(db, vm_env, tf):
    """Run step 0 once: the VM exists, has its address and a pinned key."""
    await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    return await vms.get(db, vm_env.id)


async def test_prepare_needs_the_integration_and_the_vm_record(db, vm_env):
    ctx = await ctx_for(db, vm_env)
    assert (ctx.vm.name, ctx.vm.static_ip, ctx.proxmox.node, ctx.secret_values) == (
        "ss-uat3", "127.0.0.1", "pve", [PX_TOKEN, PX_TOKEN_SECRET])
    assert PX_TOKEN_SECRET not in repr(ctx)
    await db.delete(await db.get(Integration, "proxmox"))
    await db.commit()
    with pytest.raises(VmPrepareError) as e:
        await ctx_for(db, vm_env)
    assert e.value.reason == "Proxmox isn't set up. Add it in Settings › Integrations, then retry."


async def test_the_first_run_builds_the_vm_pins_its_key_and_resolves_the_ref(
        db, vm_env, tf, proxmox_fake, ssh_server):
    lines: list[str] = []
    calls: list = []
    outcome = await provisioner(tf, resolve=resolves_to(SHA, calls)).run(
        "provision", await ctx_for(db, vm_env), lines.append)
    assert outcome == VmOutcome(sha=SHA, vm_snapshot=None)
    assert tf.commands() == ["init", "apply"]
    apply = tf.requests[1]
    assert apply.args == terraform.APPLY and apply.env["PROXMOX_VE_API_TOKEN"] == PX_TOKEN
    assert PX_TOKEN_SECRET not in (apply.workdir / "main.tf.json").read_text()
    vm = await vms.get(db, vm_env.id)
    assert (vm.vmid, vm.created, vm.ip) == (120, True, "127.0.0.1")
    pinned = await known_hosts.lookup(db, "127.0.0.1", ssh_server.port)
    assert pinned.fingerprint_sha256 == ssh_server.fingerprint
    [trust] = await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.host_trust"))
    assert trust["target"] == "proxmox:uat3"
    assert calls == [("127.0.0.1", "deploy", "main")]
    text = "".join(lines)
    for line in ("Reserved VM id 120 for ss-uat3.\n",
                 "Creating ss-uat3 (4 vCPU, 8 GB, 64 GB disk) with Terraform.\n",
                 f"Pinned 127.0.0.1's SSH host key {ssh_server.fingerprint}, read through the "
                 "guest agent.\n",
                 f"main is {SHA}.\n"):
        assert line in text
    assert PX_TOKEN_SECRET not in text


async def test_a_second_run_updates_the_vm_and_keeps_the_pin(db, vm_env, tf, ssh_server):
    await _built(db, vm_env, tf)
    lines: list[str] = []
    outcome = await provisioner(tf).run("provision", await ctx_for(db, vm_env, sha=SHA),
                                        lines.append)
    assert outcome == VmOutcome()                       # a commit given: nothing to resolve
    assert tf.commands() == ["init", "apply", "apply"]
    text = "".join(lines)
    assert "Updating ss-uat3" in text and "Reserved" not in text
    assert f"SSH host key {ssh_server.fingerprint} is pinned.\n" in text


async def test_a_busy_address_stops_before_anything_is_made(db, vm_env, tf, proxmox_fake):
    async def answers(host, port):
        return True

    with pytest.raises(StepFailed) as e:
        await provisioner(tf, probe=answers).run("provision", await ctx_for(db, vm_env),
                                                 lambda _: None)
    assert e.value.reason.startswith("Something already answers SSH at 127.0.0.1")
    assert tf.commands() == [] and ("GET", "/cluster/nextid") not in proxmox_fake.requests
    assert (await vms.get(db, vm_env.id)).vmid is None


async def test_a_reserved_id_someone_else_took(db, vm_env, tf, proxmox_fake):
    vm = await vms.get(db, vm_env.id)
    vm.vmid = 130
    await db.commit()
    proxmox_fake.add_vm(130, "someone-else")
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == ("VM 130 on Proxmox isn't ss-uat3 any more; Sirdar changed "
                              "nothing.")
    assert tf.commands() == []


async def test_a_failed_apply_keeps_the_reserved_id(db, vm_env, tf):
    tf.results["apply"] = TfResult(status="failed", rc=1)
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == "Terraform couldn't create or update the VM. See the log above."
    vm = await vms.get(db, vm_env.id)
    assert (vm.vmid, vm.created) == (120, False)
    tf.results["apply"] = TfResult(status="timeout", rc=-1)
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == "Terraform didn't create or update the VM in 25 minutes."


async def test_no_address_or_the_wrong_one(db, vm_env, tf, proxmox_fake, ssh_server):
    tf.effects["apply"] = apply_creates_vm(proxmox_fake, host_key_line(ssh_server), ips=())
    slow = provisioner(tf, agent_wait=120, poll=60)
    with pytest.raises(StepFailed) as e:
        await slow.run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == ("The VM's guest agent didn't report an address in 2 minutes. "
                              "Is qemu-guest-agent installed in the template?")
    proxmox_fake.agent[120]["ips"] = ["10.9.9.9"]
    with pytest.raises(StepFailed) as e:
        await slow.run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == ("The VM came up at 10.9.9.9, not 127.0.0.1. Check the "
                              "template's cloud-init settings.")


async def test_a_live_key_that_doesn_t_match_the_agent_s(db, vm_env, tf, proxmox_fake):
    other = asyncssh.generate_private_key("ssh-ed25519").export_public_key().decode().strip()
    tf.effects["apply"] = apply_creates_vm(proxmox_fake, other)
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == ("The VM's live SSH key doesn't match the one its guest agent "
                              "reports. Sirdar pinned nothing.")
    assert await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT) is None


async def test_a_saved_ssh_target_s_address_is_never_pinned(db, vm_env, tf, deploy_env,
                                                           ssh_server):
    deploy_env(ssh_host="127.0.0.1", ssh_port=ssh_server.port, ssh_user="x", ssh_password="y")
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == ("127.0.0.1 is a saved SSH target's address. Sirdar won't pin a "
                              "VM's key there.")


async def test_a_ref_that_doesn_t_resolve(db, vm_env, tf):
    async def missing(cfg, db, repo_url, ref):
        raise gitref.RefError("ref_not_found")

    with pytest.raises(StepFailed) as e:
        await provisioner(tf, resolve=missing).run("provision", await ctx_for(db, vm_env),
                                                   lambda _: None)
    assert e.value.reason == "The repository has no branch, tag or commit named main."


async def test_a_vm_snapshot_is_taken_and_old_ones_pruned(db, vm_env, tf, proxmox_fake):
    await _built(db, vm_env, tf)
    old = ["sirdar-20261001T080000Z", "sirdar-20261002T080000Z", "sirdar-20261003T080000Z"]
    for name in old:
        db.add(Deployment(environment_id=vm_env.id, mode="update", git_ref="main", sha=OLD,
                          status="succeeded", start_step=0, vm=True, vm_snapshot=name))
        proxmox_fake.snaps.setdefault(120, []).append({"name": name, "description": ""})
    proxmox_fake.snaps[120].append({"name": "manual-before-upgrade", "description": "by hand"})
    await db.commit()
    lines: list[str] = []
    outcome = await provisioner(tf).run(
        "provision", await ctx_for(db, vm_env, sha=SHA, take=True), lines.append)
    assert outcome.vm_snapshot == SNAP
    assert sorted(s["name"] for s in proxmox_fake.snaps[120]) == [
        "manual-before-upgrade", "sirdar-20261002T080000Z", "sirdar-20261003T080000Z", SNAP]
    taken = next(s for s in proxmox_fake.snaps[120] if s["name"] == SNAP)
    assert taken["vmstate"] == 0
    assert taken["description"].startswith("Sirdar: before update of uat3")
    text = "".join(lines)
    assert f"Took VM snapshot {SNAP}.\n" in text
    assert ("Deleted the old VM snapshot sirdar-20261001T080000Z (keeping the newest 3).\n"
            in text)


async def test_a_retry_keeps_the_first_attempt_s_snapshot(db, vm_env, tf, proxmox_fake):
    await _built(db, vm_env, tf)
    lines: list[str] = []
    outcome = await provisioner(tf).run(
        "provision", await ctx_for(db, vm_env, sha=SHA, take=True, vm_snapshot=SNAP),
        lines.append)
    assert outcome.vm_snapshot == SNAP and proxmox_fake.snaps.get(120, []) == []
    assert f"Keeping the VM snapshot from the first attempt: {SNAP}\n" in "".join(lines)


async def test_restore_a_vm_snapshot(db, vm_env, tf, proxmox_fake):
    await _built(db, vm_env, tf)
    proxmox_fake.snaps[120] = [{"name": SNAP, "description": ""},
                               {"name": "sirdar-20261001T000000Z", "description": "by hand"}]
    for name in (SNAP, "sirdar-20200101T000000Z"):
        db.add(Deployment(environment_id=vm_env.id, mode="update", git_ref="main", sha=OLD,
                          status="succeeded", start_step=0, vm=True, vm_snapshot=name))
    await db.commit()
    for name, reason in (
            ("sirdar-20261001T000000Z", "Sirdar didn't take the VM snapshot "
                                        "sirdar-20261001T000000Z for uat3, so it won't restore "
                                        "it."),
            ("before-upgrade", "before-upgrade isn't a VM snapshot Sirdar takes.")):
        with pytest.raises(StepFailed) as e:
            await provisioner(tf).run("vm_restore", await ctx_for(
                db, vm_env, mode="vm_restore", vm_snapshot=name), lambda _: None)
        assert e.value.reason == reason
    assert proxmox_fake.rolled_back == []
    lines: list[str] = []
    await provisioner(tf).run("vm_restore",
                              await ctx_for(db, vm_env, mode="vm_restore", vm_snapshot=SNAP),
                              lines.append)
    assert proxmox_fake.rolled_back == [(120, SNAP)]
    assert proxmox_fake.vms[120]["status"] == "running"
    text = "".join(lines)
    assert f"Rolling ss-uat3 back to {SNAP}.\n" in text and "Started the VM.\n" in text
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run(
            "vm_restore", await ctx_for(db, vm_env, mode="vm_restore",
                                        vm_snapshot="sirdar-20200101T000000Z"), lambda _: None)
    assert e.value.reason == "The VM snapshot sirdar-20200101T000000Z is gone from Proxmox."


async def test_destroy_removes_only_sirdar_s_vm(db, vm_env, tf, proxmox_fake, ssh_server):
    await _built(db, vm_env, tf)
    work = terraform.workdir(get_settings(), vm_env.id)
    proxmox_fake.vms[120]["name"] = "prod-db"
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                                  lambda _: None)
    assert e.value.reason == ("VM 120 is prod-db, not the ss-uat3 Sirdar made. Sirdar changed "
                              "nothing.")
    proxmox_fake.vms[120]["name"] = "ss-uat3"
    proxmox_fake.vms[120]["tags"] = "ss-uat3"
    with pytest.raises(StepFailed):
        await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                                  lambda _: None)
    assert "destroy" not in tf.commands() and work.is_dir()
    proxmox_fake.vms[120]["tags"] = "sirdar;ss-uat3"
    lines: list[str] = []
    await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                              lines.append)
    assert tf.commands()[-1] == "destroy" and 120 not in proxmox_fake.vms
    assert not work.exists()
    assert await known_hosts.lookup(db, "127.0.0.1", ssh_server.port) is None
    text = "".join(lines)
    assert "Destroying ss-uat3 (VM 120) and its VM snapshots with Terraform.\n" in text
    assert "Destroyed ss-uat3.\n" in text


async def test_destroy_without_state_or_a_vm(db, vm_env, tf, proxmox_fake):
    lines: list[str] = []
    await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                              lines.append)
    assert lines == ["Sirdar never created a VM for uat3.\n"]
    await _built(db, vm_env, tf)
    (terraform.workdir(get_settings(), vm_env.id) / "terraform.tfstate").unlink()
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                                  lambda _: None)
    assert e.value.reason.startswith("Sirdar's Terraform state for ss-uat3 is missing")
    proxmox_fake.remove_vm(120)
    lines = []
    await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                              lines.append)
    assert "VM 120 (ss-uat3) is already gone.\n" in lines


async def test_destroy_checks_the_vm_is_gone(db, vm_env, tf):
    await _built(db, vm_env, tf)
    del tf.effects["destroy"]
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                                  lambda _: None)
    assert e.value.reason == ("VM 120 is still there after Terraform's destroy. Remove it by "
                              "hand in Proxmox, then retry.")


async def test_proxmox_errors_end_as_our_copy(db, vm_env, tf, proxmox_fake):
    proxmox_fake.tls_error = True
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason == proxmox.TLS_CHANGED


async def test_the_probe_is_guarded(no_real_hosts):
    with pytest.raises(AssertionError):
        await provision.tcp_open("10.10.48.70", 22)
    assert no_real_hosts == ["probe:10.10.48.70"]
    no_real_hosts.clear()


async def test_a_dhcp_lease_someone_else_uses_is_refused(db, deploy_env, secrets_key,
                                                         ssh_server, proxmox_fake, tf,
                                                         monkeypatch, tmp_path):
    """The lease is re-checked under the address lock before the VM's
    address or its services' are written, and nothing is pinned."""
    from sirdar_api.db.models import EnvironmentService

    monkeypatch.setenv("SIRDAR_TERRAFORM_DIR", str(tmp_path / "terraform"))
    get_settings.cache_clear()
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_proxmox(db)
    other = await make_vm_environment(db, name="uat4")          # static 127.0.0.1
    env = await make_vm_environment(db, name="uat5", ip_mode="dhcp", ip_cidr=None,
                                    gateway=None)
    assert other.id != env.id
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, env), lambda _: None)
    assert e.value.reason == (
        "The VM came up at 127.0.0.1, an address another environment, an SSH target, the "
        "proxy or Proxmox already uses. Sirdar recorded nothing for it: free the address "
        "(or fix the DHCP lease), then retry.")
    vm = await vms.get(db, env.id)
    assert (vm.created, vm.ip) == (True, None)
    hosts = set(await db.scalars(select(EnvironmentService.host_ip).where(
        EnvironmentService.environment_id == env.id).execution_options(
            populate_existing=True)))
    assert hosts == {"0.0.0.0"}
    assert await known_hosts.lookup(db, "127.0.0.1", ssh_server.port) is None
    get_settings.cache_clear()


async def test_a_pinned_certificate_that_isn_t_one_certificate(db, vm_env, tf):
    from dataclasses import replace

    ctx = await ctx_for(db, vm_env)
    bad = replace(ctx, proxmox=replace(ctx.proxmox, tls_cert_pem="not a certificate"))
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", bad, lambda _: None)
    assert e.value.reason == provision.PINNED_CERTIFICATE_INVALID
    assert tf.commands() == []


async def test_pruning_keeps_hand_made_snapshots_even_with_sirdar_names(db, vm_env, tf,
                                                                         proxmox_fake):
    await _built(db, vm_env, tf)
    names = ["sirdar-20261001T080000Z", "sirdar-20261002T080000Z", "sirdar-20261003T080000Z"]
    for name in names:
        db.add(Deployment(environment_id=vm_env.id, mode="update", git_ref="main", sha=OLD,
                          status="succeeded", start_step=0, vm=True, vm_snapshot=name))
        proxmox_fake.snaps.setdefault(120, []).append({"name": name, "description": ""})
    # Named like Sirdar's, but no deployment took it: made by hand.
    proxmox_fake.snaps[120].append({"name": "sirdar-20200101T000000Z", "description": "hand"})
    await db.commit()
    await provisioner(tf).run("provision", await ctx_for(db, vm_env, sha=SHA, take=True),
                              lambda _: None)
    assert sorted(s["name"] for s in proxmox_fake.snaps[120]) == [
        "sirdar-20200101T000000Z", "sirdar-20261002T080000Z", "sirdar-20261003T080000Z", SNAP]


async def test_destroy_refuses_a_vm_without_the_sirdar_tag(db, vm_env, tf, proxmox_fake):
    await _built(db, vm_env, tf)
    proxmox_fake.vms[120]["tags"] = "ss-uat3"
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                                  lambda _: None)
    assert e.value.reason == ("VM 120 (ss-uat3) has no sirdar tag, so it isn't the VM Sirdar "
                              "made. Sirdar changed nothing.")
    assert 120 in proxmox_fake.vms and "destroy" not in tf.commands()


async def test_a_created_vm_someone_replaced_is_never_applied(db, vm_env, tf, proxmox_fake):
    """Proxmox reuses the lowest free id: after a manual delete another VM can
    hold it, and an apply would rename and retag it."""
    await _built(db, vm_env, tf)
    proxmox_fake.vms[120]["name"] = "prod-db"
    proxmox_fake.vms[120]["tags"] = ""
    before = tf.commands()
    for name, tags in (("prod-db", ""), ("ss-uat3", "ss-uat3"), ("prod-db", "sirdar;prod-db")):
        proxmox_fake.vms[120]["name"], proxmox_fake.vms[120]["tags"] = name, tags
        with pytest.raises(StepFailed) as e:
            await provisioner(tf).run("provision", await ctx_for(db, vm_env, sha=SHA),
                                      lambda _: None)
        assert e.value.reason == ("VM 120 on Proxmox isn't ss-uat3 any more; Sirdar changed "
                                  "nothing.")
    assert tf.commands() == before


async def test_a_created_vm_that_is_gone_is_not_rebuilt(db, vm_env, tf, proxmox_fake):
    await _built(db, vm_env, tf)
    proxmox_fake.remove_vm(120)
    before = tf.commands()
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env, sha=SHA),
                                  lambda _: None)
    assert e.value.reason == (
        "The VM Sirdar made for uat3 (ss-uat3, VM 120) is gone from Proxmox. Sirdar won't "
        "build a new one silently: delete the environment, or fix it by hand, then retry.")
    assert tf.commands() == before


async def test_a_vm_on_another_node(db, vm_env, tf, proxmox_fake, ssh_server):
    await _built(db, vm_env, tf)
    proxmox_fake.vms[120]["node"] = "pve2"
    reason = ("VM 120 (ss-uat3) is on node pve2 now, not pve. Sirdar changed nothing: move it "
              "back, or fix it by hand, then retry.")
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env, sha=SHA),
                                  lambda _: None)
    assert e.value.reason == reason
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("destroy", await ctx_for(db, vm_env, mode="teardown"),
                                  lambda _: None)
    assert e.value.reason == reason
    assert "destroy" not in tf.commands()
    assert terraform.has_state(terraform.workdir(get_settings(), vm_env.id))
    assert await known_hosts.lookup(db, "127.0.0.1", ssh_server.port) is not None


async def test_a_failed_re_check_forgets_the_pin_it_made(db, vm_env, tf, ssh_server,
                                                        monkeypatch):
    real = vms.address_in_use
    seen: list[str] = []

    async def taken_on_the_second_look(*args, **kwargs):
        seen.append(args[2])
        if len(seen) == 2:
            return True
        return await real(*args, **kwargs)

    monkeypatch.setattr(vms, "address_in_use", taken_on_the_second_look)
    with pytest.raises(StepFailed) as e:
        await provisioner(tf).run("provision", await ctx_for(db, vm_env), lambda _: None)
    assert e.value.reason.startswith("The VM came up at 127.0.0.1, an address another")
    assert seen == ["127.0.0.1", "127.0.0.1"]
    assert await known_hosts.lookup(db, "127.0.0.1", ssh_server.port) is None
    assert (await vms.get(db, vm_env.id)).ip is None
    actions = list(await db.scalars(select(AuditLog.action).where(
        AuditLog.action.like("deploy.host_%")).order_by(AuditLog.id)))
    assert actions == ["deploy.host_trust", "deploy.host_forget"]


async def test_a_changed_key_is_pinned_again(db, vm_env, tf, ssh_server):
    from sqlalchemy import update as sql_update

    from sirdar_api.db.models import SshKnownHost

    await _built(db, vm_env, tf)
    await db.execute(sql_update(SshKnownHost).where(SshKnownHost.host == "127.0.0.1")
                     .values(fingerprint_sha256="SHA256:old"))
    await db.commit()
    lines: list[str] = []
    await provisioner(tf).run("provision", await ctx_for(db, vm_env, sha=SHA), lines.append)
    assert (f"Pinned 127.0.0.1's SSH host key {ssh_server.fingerprint}, read through the "
            "guest agent (it changed).\n") in "".join(lines)
    changes = list(await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.host_trust").order_by(AuditLog.id)))
    assert changes[-1]["previous_fingerprint"] == "SHA256:old"
    assert changes[-1]["fingerprint"] == ssh_server.fingerprint
