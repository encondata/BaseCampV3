"""The pipeline with a DigitalOcean environment: step 0 through the
provisioner, the host steps on the slot's droplet with the managed
database and Spaces in .env, DNS at the load balancer, the slot smoke test,
going live, and Delete with its snapshot. FakeProvisioner stands in for
DigitalOcean; its step 0 effect records what a real one would."""

import base64

import pytest
from sqlalchemy import func, select

from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import (
    Deployment,
    DoResource,
    DoSlot,
    Environment,
    EnvironmentSecret,
    Snapshot,
)
from sirdar_api.deploy import do_envs, envfile, pipeline, snapshots, vault, vms
from sirdar_api.deploy.provision import VmOutcome
from sirdar_api.deploy.runner import RunResult

from .bundle_helpers import make_bundle
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import make_do_environment
from .publish_helpers import publish_fakes  # noqa: F401
from .fake_digitalocean import DEV_RENEW_TOKEN
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA, _load

SPACES_SECRET = "spaces-SECRET-pipeline-1"
DOADMIN = "doadmin-SECRET-pipeline-1"
CA = "-----BEGIN CERTIFICATE-----\nMIIBcaPIPELINE\n-----END CERTIFICATE-----\n"
UNTRUSTED_IP = "192.0.2.10"


async def _built(ctx) -> None:
    """What a real step 0 leaves behind."""
    settings = get_settings()
    await do_envs.set_do(ctx.env_id, lb_ip="203.0.113.50", vpc_ip_range="10.116.0.0/20",
                         db_host="private-ss-uat9-db.db.ondigitalocean.com", db_port=25060,
                         db_ca_cert=CA, spaces_key_id="DO00KEY000001",
                         spaces_secret_enc=vault.encrypt(settings, SPACES_SECRET),
                         db_admin_password_enc=vault.encrypt(settings, DOADMIN))
    for i, slot in enumerate(ctx.slots):
        await do_envs.set_slot(ctx.env_id, slot, droplet_id=str(4001 + i), public_ip="127.0.0.1")
    await do_envs.record(ctx.env_id, "vpc", f"vpc-{ctx.env_id}", f"ss-{ctx.env_name}")


async def _destroyed(ctx) -> None:
    """What a real step 18 leaves behind: no do_resources rows."""
    async with get_sessionmaker()() as s:
        rows = await do_envs.resources_of(s, ctx.env_id)
    for row in rows:
        await do_envs.forget(ctx.env_id, row.kind, row.do_id)


@pytest.fixture
async def do_env(db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    env = await make_do_environment(db)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = _built
    fake_provisioner.effects["do_destroy"] = _destroyed
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)
    return env


async def _start(db, env, **kw):
    dep = await pipeline.create_deployment(db, env, git_ref="main", actor_id=None, cloud=True,
                                           **{"mode": "update", "sha": "", **kw})
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_a_first_deploy_goes_live(db, do_env, fake_runner, fake_publisher,
                                        fake_provisioner, ssh_server):
    fake_runner.output["render"] = [f"echo {SPACES_SECRET}\n"]
    dep_id = await _start(db, do_env, slot="orange", go_live=True)
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded", [(s.key, s.status, s.log) for s in steps]
    assert [s.key for s in steps] == ["do_prepare", "preflight", "bootstrap", "fetch", "render",
                                      "build", "dump", "up", "dns", "slot_smoke", "go_live"]
    assert fake_provisioner.calls == ["do_prepare", "go_live"]
    assert fake_publisher.calls == ["dns"] and fake_publisher.contexts[0].cloud is True
    assert (env.active_slot, env.current_sha, env.status) == ("orange", SHA, "ready")
    slot = await db.get(DoSlot, (env.id, "orange"), populate_existing=True)
    assert (slot.sha, slot.image_tag, slot.last_check_ok) == (SHA, envfile.image_tag(SHA), True)
    assert slot.last_check_at is not None
    render = next(r for r in fake_runner.requests if r.step == "render")
    text = base64.b64decode(render.extravars["env_file_b64"]).decode()
    assert "STACK_EXTERNAL_DATA=1\n" in text and "STACK_DROPLET_ID=4001\n" in text
    assert f"SS_SPACES_SECRET_KEY={SPACES_SECRET}\n" in text
    assert "SS_DATABASE_URL=postgresql+asyncpg://serversherpa:" in text
    smoke = next(r for r in fake_runner.requests if r.step == "slot_smoke")
    # no spaces: objects live in Spaces, and Caddy has no route for it
    assert [h["hostname"] for h in smoke.extravars["public_hosts"]] == [
        f"{s}.uat9.serversherpa.com" for s in ("api", "portal", "kiosk", "wiki", "status")]
    assert [h["path"] for h in smoke.extravars["public_hosts"]][0] == "/healthz"
    assert smoke.extravars["block_metadata"] is True
    assert smoke.extravars["external_data"] is True
    assert SPACES_SECRET not in next(s.log for s in steps if s.key == "render")


async def test_cloud_vars_reach_every_host_step(db, do_env, fake_runner,
                                                        fake_publisher, fake_provisioner):
    await _start(db, do_env, slot="orange", go_live=True)
    preflight = next(r for r in fake_runner.requests if r.step == "preflight")
    assert preflight.extravars["external_data"] is True


async def test_every_cloud_secret_is_redacted(db, do_env, fake_runner, fake_publisher,
                                              fake_provisioner):
    """The .env extras (database URL, Spaces secret, CA), the new doadmin
    password, the renewal token and the cert-worker's ACME key never reach
    a step's log, whichever step prints them."""
    settings = get_settings()
    async with get_sessionmaker()() as s:
        row = await do_envs.get(s, do_env.id)
        acme_key = vault.decrypt(settings, row.acme_key_enc)
        password = vault.decrypt(settings, (await s.get(
            EnvironmentSecret, (do_env.id, "POSTGRES_PASSWORD"))).value_enc)
    assert acme_key.startswith("-----BEGIN")
    ca_b64 = base64.b64encode(CA.encode()).decode()
    leaks = [SPACES_SECRET, DOADMIN, DEV_RENEW_TOKEN, ca_b64, acme_key, password]
    lines = [f"leak {v}\n" for v in leaks]
    fake_runner.output["render"] = lines
    fake_runner.output["slot_smoke"] = lines
    fake_provisioner.echo["go_live"] = "".join(lines)

    def url_line(request):
        text = base64.b64decode(request.extravars["env_file_b64"]).decode()
        url = next(v for k, v in (ln.split("=", 1) for ln in text.splitlines() if "=" in ln)
                   if k == "SS_DATABASE_URL")
        fake_runner.output["up"] = [f"leak {url}\n"]

    fake_runner.effects["render"] = url_line
    dep_id = await _start(db, do_env, slot="orange", go_live=True)
    dep, steps, _ = await _load(dep_id)
    assert dep.status == "succeeded", [(s.key, s.log) for s in steps]
    for key in ("render", "slot_smoke", "go_live", "up"):
        log = next(s.log for s in steps if s.key == key)
        assert "[redacted]" in log, key
        for value in leaks:
            assert value not in log, (key, value[:12])
    assert "postgresql+asyncpg" not in next(s.log for s in steps if s.key == "up")


async def test_a_retry_before_any_droplet_names_step_0(db, do_env, fake_runner,
                                                       fake_publisher, fake_provisioner):
    """No droplet yet is a DigitalOcean message, not 'the SSH target isn't
    configured' (the target is built, like a VM's)."""
    dep_id = await _start(db, do_env, slot="orange", go_live=True, sha=SHA, start_step=1)
    dep, steps, _ = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 1)
    assert "droplet has no address yet" in dep.error and "Prepare DigitalOcean" in dep.error
    assert fake_runner.requests == []


async def test_an_idle_slot_deploy_waits_for_activate(db, do_env, fake_runner,
                                                      fake_publisher, fake_provisioner,
                                                      ssh_server):
    await _start(db, do_env, slot="orange", go_live=True)

    async def built_orange_elsewhere(ctx):
        await _built(ctx)
        # the active slot's droplet is somewhere Sirdar doesn't trust: the
        # Update must connect to purple's droplet, not the active one
        await do_envs.set_slot(ctx.env_id, "orange", public_ip=UNTRUSTED_IP)

    fake_provisioner.effects["do_prepare"] = built_orange_elsewhere
    fake_runner.requests.clear()
    dep_id = await _start(db, do_env, slot="purple", go_live=False)
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded" and steps[-1].key == "slot_smoke", \
        [(s.key, s.status, s.log) for s in steps]
    assert {r.target.host for r in fake_runner.requests} == {"127.0.0.1"}
    render = next(r for r in fake_runner.requests if r.step == "render")
    assert "STACK_DROPLET_ID=4002\n" in base64.b64decode(
        render.extravars["env_file_b64"]).decode()
    assert (env.active_slot, env.current_sha) == ("orange", SHA)
    purple = await db.get(DoSlot, (env.id, "purple"), populate_existing=True)
    assert (purple.sha, purple.last_check_ok) == (SHA, True)


async def test_activate_and_deactivate_set_the_active_slot(db, do_env, fake_runner,
                                                           fake_publisher, fake_provisioner):
    await _start(db, do_env, slot="orange", go_live=True)
    await _start(db, do_env, slot="purple", go_live=False)
    env = await db.get(Environment, do_env.id, populate_existing=True)
    dep_id = await _start(db, env, mode="activate", slot="purple", sha=SHA)
    dep, steps, env = await _load(dep_id)
    assert dep.status == "succeeded", [(s.key, s.log) for s in steps]
    assert [s.key for s in steps] == ["slot_smoke", "go_live"] and dep.go_live is True
    assert (env.active_slot, env.current_sha, env.status) == ("purple", SHA, "ready")

    env = await db.get(Environment, do_env.id, populate_existing=True)
    dep_id = await _start(db, env, mode="activate", slot=None, sha=SHA)
    dep, _, env = await _load(dep_id)
    assert dep.status == "succeeded"
    assert env.active_slot is None


async def test_a_failed_switch_keeps_the_active_slot(db, do_env, fake_runner, fake_publisher,
                                                     fake_provisioner):
    await _start(db, do_env, slot="orange", go_live=True)
    await _start(db, do_env, slot="purple", go_live=False)
    fake_provisioner.fail["go_live"] = "The public smoke test failed; traffic is back."
    env = await db.get(Environment, do_env.id, populate_existing=True)
    dep_id = await _start(db, env, mode="activate", slot="purple", sha=SHA)
    dep, _, env = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 14)
    assert env.active_slot == "orange"


async def test_a_failed_slot_smoke_test(db, do_env, fake_runner, fake_publisher,
                                        fake_provisioner):
    fake_runner.results["slot_smoke"] = RunResult(status="failed", rc=2)
    dep_id = await _start(db, do_env, slot="orange", go_live=True)
    dep, steps, env = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 13)
    assert fake_provisioner.calls == ["do_prepare"]
    slot = await db.get(DoSlot, (env.id, "orange"), populate_existing=True)
    assert slot.last_check_ok is False and env.active_slot is None


@pytest.mark.parametrize("mode", ["reset", "restore_dump", "rollback", "vm_restore"])
async def test_modes_digitalocean_does_not_offer(db, do_env, mode):
    with pytest.raises(pipeline.NotSupportedOnDigitalOcean) as e:
        await pipeline.create_deployment(db, do_env, mode=mode, git_ref="main", sha=SHA,
                                         actor_id=None, cloud=True)
    assert e.value.code == "not_supported_on_digitalocean"


async def test_cloud_must_match_the_target(db, do_env):
    with pytest.raises(ValueError):
        await pipeline.create_deployment(db, do_env, mode="update", git_ref="main", sha=SHA,
                                         actor_id=None)


def _fetched(tmp_path):
    """What export.yml leaves on Sirdar: the bundle at snapshot_dest."""
    def effect(request):
        keys = base64.b64decode(request.extravars["keys_enc_b64"])
        src = make_bundle(tmp_path, name="fetched-src.tar.gz", source="uat9", keys=keys)
        src.replace(request.extravars["snapshot_dest"])
    return effect


async def _take_for_delete(db, env):
    snap = await snapshots.begin_take(db, get_settings(), env, name="uat9-before-delete-x",
                                      notes="", actor_id=None)
    await db.commit()
    return snap


async def test_delete_takes_a_snapshot_then_removes_everything(db, do_env, snapshots_dir,
                                                               fake_runner, fake_publisher,
                                                               fake_provisioner, tmp_path):
    await _start(db, do_env, slot="orange", go_live=True)
    env = await db.get(Environment, do_env.id, populate_existing=True)
    snap = await _take_for_delete(db, env)
    fake_runner.effects["export"] = _fetched(tmp_path)
    fake_runner.requests.clear()
    dep = await pipeline.create_deployment(db, env, mode="teardown", git_ref="main",
                                           sha=env.current_sha, actor_id=None, cloud=True,
                                           slot="orange", snapshot_id=snap.id)
    assert pipeline.takes_snapshot(dep)
    assert [s.key for s in pipeline.plan_of(dep)] == ["export", "undns", "do_destroy"]
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    # the deployment went with the environment (ON DELETE CASCADE)
    assert await db.get(Deployment, dep.id, populate_existing=True) is None
    assert fake_runner.steps() == ["export"] and fake_publisher.calls[-1] == "undns"
    export = next(r for r in fake_runner.requests if r.step == "export")
    assert export.extravars["external_data"] is True
    assert export.extravars["spaces_endpoint"] == "https://nyc3.digitaloceanspaces.com"
    assert export.extravars["spaces_key_id"] == "DO00KEY000001"
    assert export.extravars["spaces_region"] == "nyc3"
    assert fake_provisioner.calls[-1] == "do_destroy"
    assert (await db.scalar(select(Snapshot.status).where(Snapshot.id == snap.id))) == "ready"
    assert await db.get(Environment, do_env.id, populate_existing=True) is None


async def test_delete_without_a_snapshot(db, do_env, fake_runner, fake_publisher,
                                         fake_provisioner):
    await _start(db, do_env, slot="orange", go_live=True)
    env = await db.get(Environment, do_env.id, populate_existing=True)
    fake_runner.requests.clear()
    dep = await pipeline.create_deployment(db, env, mode="teardown", git_ref="main",
                                           sha=env.current_sha, actor_id=None, cloud=True)
    assert not pipeline.takes_snapshot(dep)
    assert [s.key for s in pipeline.plan_of(dep)] == ["undns", "do_destroy"]
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    assert fake_runner.requests == [] and fake_provisioner.calls[-1] == "do_destroy"
    assert await db.get(Environment, do_env.id, populate_existing=True) is None


async def test_delete_keeps_the_environment_while_resources_are_recorded(
        db, do_env, fake_runner, fake_publisher, fake_provisioner):
    """do_resources is ON DELETE RESTRICT: if step 18 left a row, the
    environment stays (failed, with our message), never a 500."""
    await _start(db, do_env, slot="orange", go_live=True)
    env = await db.get(Environment, do_env.id, populate_existing=True)
    fake_provisioner.effects["do_destroy"] = lambda ctx: _noop()
    dep_id = await _start(db, env, mode="teardown", sha=env.current_sha)
    dep, _, env = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 18)
    assert "still records" in dep.error
    assert env is not None and env.status == "failed"
    left = await db.scalar(select(func.count()).select_from(DoResource)
                           .where(DoResource.environment_id == do_env.id))
    assert left == 1


async def _noop() -> None:
    return None


async def test_a_failed_delete_snapshot_is_marked_failed(db, do_env, snapshots_dir,
                                                         fake_runner, fake_publisher,
                                                         fake_provisioner):
    await _start(db, do_env, slot="orange", go_live=True)
    env = await db.get(Environment, do_env.id, populate_existing=True)
    snap = await _take_for_delete(db, env)
    fake_runner.results["export"] = RunResult(status="failed", rc=2)
    dep_id = await _start(db, env, mode="teardown", sha=env.current_sha, snapshot_id=snap.id)
    dep, _, env = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 11)
    assert "do_destroy" not in fake_provisioner.calls
    assert (await db.scalar(select(Snapshot.status).where(Snapshot.id == snap.id))) == "failed"
    assert env is not None and env.status == "failed"


async def test_the_host_provisioner_sends_digitalocean_steps_to_digitalocean(secrets_key):
    from sirdar_api.deploy import do_provision, provision, vmcommon, vmsteps

    from .fake_provisioner import FakeProvisioner

    px, do = FakeProvisioner(), FakeProvisioner()
    do_ctx = do_provision.DoContext.__new__(do_provision.DoContext)
    await vmsteps.HostProvisioner(proxmox=px, digitalocean=do).run("go_live", do_ctx,
                                                                  lambda _: None)
    assert (px.calls, do.calls) == ([], ["go_live"])
    with pytest.raises(vmcommon.VmPrepareError):           # never Proxmox by default
        await vmsteps.HostProvisioner(proxmox=px).run("go_live", do_ctx, lambda _: None)
    assert px.calls == []
    real = pipeline.make_provisioner(get_settings())
    assert isinstance(real._do, do_provision.DoProvisioner)
    assert isinstance(real._proxmox, provision.ProxmoxProvisioner)


async def test_dns_points_at_the_load_balancer_and_never_needs_npm(db, secrets_key,
                                                                   publish_fakes):
    from sirdar_api.deploy import publish

    from .integration_helpers import configure

    env = await make_do_environment(db)                  # Cloudflare only, no NPM
    assert await publish.missing_integrations(db, env) == []
    assert await publish.missing_integrations(db, env, teardown=True) == []
    ctx = await publish.prepare(db, env, get_settings())
    assert ctx.cloud is True and ctx.npm is None
    with pytest.raises(publish.StepFailed, match="load balancer has no address"):
        await publish.HttpPublisher().run("dns", ctx, lambda _: None)
    assert publish_fakes.cf.writes() == []

    await do_envs.set_do(env.id, lb_ip="203.0.113.50")
    lines: list[str] = []
    await publish.HttpPublisher().run("dns", ctx, lines.append)
    made = {r["name"]: r["content"] for r in publish_fakes.cf.records.values()}
    assert made == {f"{s}.uat9.serversherpa.com": "203.0.113.50"
                    for s in ("api", "portal", "kiosk", "wiki", "status")}
    assert lines[0] == "api.uat9.serversherpa.com: created A 203.0.113.50\n"

    await configure(db)                                  # NPM saved: still never read
    state = await publish.inspect(db, env, get_settings())
    assert state["cloudflare"]["public_ip"] == "203.0.113.50"
    assert state["npm"] == {"configured": False, "url": None, "error": None}
    assert {s["dns"]["state"] for s in state["services"]} == {"ok"}
    assert not [r for r in publish_fakes.npm.requests]
