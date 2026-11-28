"""POST /api/deploy/environments/{name}/env-file: the environment's current
app .env, the text step 4 writes, after the caller types their Sirdar
password again. Texts are compared by digest so a failure never prints a
secret."""

import base64
import hashlib
import json

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, User
from sirdar_api.deploy import environments, envfile, pipeline, vms
from sirdar_api.deploy.provision import VmOutcome

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    make_environment,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import built as do_built
from .do_helpers import make_do_environment
from .factories import PASSWORD
from .integration_helpers import configure, configure_esxi, configure_proxmox
from .lan_helpers import lan_built, make_bluegreen_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_pipeline import OLD, SHA, _load
from .vm_helpers import make_vm_environment

URL = "/api/deploy/environments/{}/env-file"


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _renders(fake_runner) -> list[str]:
    return [base64.b64decode(r.extravars["env_file_b64"]).decode()
            for r in fake_runner.requests if r.step == "render"]


async def _run(db, env, **kw) -> None:
    dep = await pipeline.create_deployment(db, env, git_ref="main", actor_id=None,
                                           **{"mode": "update", "sha": SHA, **kw})
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    loaded, steps, _ = await _load(dep.id)
    assert loaded.status == "succeeded", [(s.key, s.status) for s in steps]


async def _download(client, db, name: str, password: str | None = PASSWORD, **kw):
    h = await auth_headers(client, db, **kw)
    body = {} if password is None else {"password": password}
    return await client.post(URL.format(name), headers=h, json=body)


@pytest.fixture
async def lan_ssh(db, deploy_env, ssh_server, secrets_key):  # noqa: F811
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    env = await make_environment(db, current_sha=OLD)
    # deployed at OLD, so it has what that deploy's step 4 made (the devices secrets)
    await environments.ensure_devices_secrets(db, get_settings(), env)
    await db.commit()
    return env


# ---- the same text the pipeline writes -------------------------------------------------

async def test_a_lan_ssh_environment_gets_what_step_4_wrote(client, db, lan_ssh, fake_runner):
    await _run(db, lan_ssh)
    [written] = _renders(fake_runner)
    resp = await _download(client, db, "uat")
    assert resp.status_code == 200
    assert _digest(resp.text) == _digest(written)


async def test_a_switchyard_environment_carries_its_hosts_ip(
        client, db, deploy_env, ssh_server, secrets_key, fake_runner):  # noqa: F811
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    await configure(db, switchyard=True)
    sy = await make_environment(db, name="sy", current_sha=OLD, proxy="switchyard")
    await _run(db, sy)
    [written] = _renders(fake_runner)
    resp = await _download(client, db, "sy")
    assert resp.status_code == 200
    assert "STACK_HOSTS_IP=203.0.113.7\n" in resp.text
    assert _digest(resp.text) == _digest(written)


async def test_a_vm_environment_gets_what_step_4_wrote(
        client, db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_runner,  # noqa: F811
        fake_provisioner):
    from sirdar_api.deploy import provision

    async def vm_up(ctx) -> None:
        await provision._set_vm(ctx.env_id, vmid=120, created=True, ip="127.0.0.1")

    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_proxmox(db)
    env = await make_vm_environment(db, current_sha=OLD)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = vm_up
    fake_provisioner.outcomes["provision"] = VmOutcome(sha=SHA)
    await _run(db, env, vm=True, sha="")
    [written] = _renders(fake_runner)
    resp = await _download(client, db, env.name)
    assert resp.status_code == 200
    assert _digest(resp.text) == _digest(written)


async def test_digitalocean_renders_the_active_slot(
        client, db, deploy_env, secrets_key, ssh_server, monkeypatch, fake_runner,  # noqa: F811
        fake_provisioner, fake_publisher):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    env = await make_do_environment(db)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = do_built
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)
    await _run(db, env, cloud=True, sha="", slot="orange", go_live=True)
    # the go-live deploy wrote orange's; the idle Update after it wrote purple's
    orange, purple = _renders(fake_runner)
    await db.refresh(env)
    assert env.active_slot == "orange"
    resp = await _download(client, db, env.name)
    assert resp.status_code == 200
    assert _digest(resp.text) == _digest(orange) != _digest(purple)


async def test_lan_blue_green_renders_the_active_slot(
        client, db, secrets_key, ssh_server, monkeypatch, fake_runner,  # noqa: F811
        fake_provisioner, fake_publisher):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = lan_built()
    fake_provisioner.outcomes["provision"] = VmOutcome()
    env = await make_bluegreen_environment(db)
    await _run(db, env, vm=True, bluegreen=True, slot="orange", go_live=True)
    written = _renders(fake_runner)
    resp = await _download(client, db, env.name)
    assert resp.status_code == 200
    assert _digest(resp.text) == _digest(written[0])
    assert "STACK_EXTERNAL_DATA=1\n" in resp.text


# ---- the response ----------------------------------------------------------------------

async def test_the_file_comes_as_an_uncached_attachment(client, db, lan_ssh, fake_runner):
    await _run(db, lan_ssh)
    resp = await _download(client, db, "uat")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "text/plain; charset=utf-8"
    assert resp.headers["content-disposition"] == 'attachment; filename="uat.env"'
    assert resp.headers["cache-control"] == "no-store"
    assert envfile.parse_env(resp.text)["STACK_IMAGE_TAG"] == envfile.image_tag(SHA)


async def test_it_renders_the_current_commit_without_a_new_deploy(client, db, lan_ssh):
    resp = await _download(client, db, "uat")         # made at OLD, never run here
    assert resp.status_code == 200
    assert envfile.parse_env(resp.text)["STACK_IMAGE_TAG"] == envfile.image_tag(OLD)


async def test_the_success_audit_row_holds_no_secret(client, db, lan_ssh):
    resp = await _download(client, db, "uat")
    values = [v for v in envfile.parse_env(resp.text).values() if len(v) >= 8]
    rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.action == "environment.env_file_downloaded")))
    assert len(rows) == 1
    row = rows[0]
    user = await db.scalar(select(User).where(User.email == "boss@test.example.com"))
    assert (row.actor_id, row.entity_type, row.entity_id) == (user.person_id, "environment",
                                                               "uat")
    assert row.changes == {"environment": "uat"}
    kept = json.dumps([row.entity_id, row.changes])
    assert not any(v in kept for v in values)


# ---- refusals --------------------------------------------------------------------------

@pytest.mark.parametrize("password", ["not-my-password", "", None])
async def test_a_wrong_or_missing_password_is_refused_and_audited(client, db, lan_ssh,
                                                                  password):
    resp = await _download(client, db, "uat", password=password)
    assert (resp.status_code, resp.json()["detail"]) == (
        403, {"code": "invalid_current_password"})
    assert "STACK_" not in resp.text
    actions = list(await db.scalars(select(AuditLog.action).where(
        AuditLog.action.like("environment.env_file%"))))
    assert actions == ["environment.env_file_refused"]
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "environment.env_file_refused"))
    assert (row.entity_type, row.entity_id) == ("environment", "uat")
    assert row.changes == {"environment": "uat", "reason": "invalid_current_password"}


async def test_a_user_without_a_password_hash_is_refused(client, db, lan_ssh):
    from sqlalchemy import update
    h = await auth_headers(client, db)
    await db.execute(update(User).where(User.email == "boss@test.example.com")
                     .values(password_hash=None))
    await db.commit()
    resp = await client.post(URL.format("uat"), headers=h, json={"password": PASSWORD})
    assert (resp.status_code, resp.json()["detail"]) == (
        403, {"code": "invalid_current_password"})


async def test_wrong_passwords_count_as_sign_in_strikes(client, db, lan_ssh, monkeypatch):
    """The sign-in lockout applies: enough wrong passwords lock the account,
    and while it is locked even the right one is refused."""
    from sirdar_api.config import get_settings
    monkeypatch.setenv("SIRDAR_MAX_FAILED_LOGINS", "2")
    get_settings.cache_clear()
    h = await auth_headers(client, db)
    for _ in range(2):
        resp = await client.post(URL.format("uat"), headers=h, json={"password": "nope"})
        assert resp.status_code == 403
    resp = await client.post(URL.format("uat"), headers=h, json={"password": PASSWORD})
    assert (resp.status_code, resp.json()["detail"]) == (423, {"code": "account_locked"})
    reasons = [r.changes["reason"] for r in await db.scalars(
        select(AuditLog).where(AuditLog.action == "environment.env_file_refused")
        .order_by(AuditLog.id))]
    assert reasons == ["invalid_current_password", "invalid_current_password",
                       "account_locked"]
    get_settings.cache_clear()


async def test_it_needs_deploy_change(client, db, lan_ssh):
    resp = await _download(client, db, "uat", email="admin@test.example.com", roles=("admin",))
    assert (resp.status_code, resp.json()["detail"]) == (403, {"code": "forbidden"})
    assert (await db.scalar(select(AuditLog).where(
        AuditLog.action.like("environment.env_file%")))) is None


async def test_a_never_deployed_environment_has_no_file(client, db, deploy_env, ssh_server,  # noqa: F811
                                                        secrets_key):
    await make_environment(db, name="fresh", current_sha=None)
    resp = await _download(client, db, "fresh")
    assert (resp.status_code, resp.json()["detail"]) == (409, {"code": "env_file_not_deployed"})


async def test_an_unknown_environment_is_404(client, db, secrets_key):
    resp = await _download(client, db, "nope")
    assert (resp.status_code, resp.json()["detail"]["code"]) == (404, "environment_not_found")


# ---- the first successful deploy -------------------------------------------------------

async def test_only_the_first_successful_deploy_is_marked_first(client, db, lan_ssh,
                                                                fake_runner):
    from sirdar_api.db.models import Deployment
    await _run(db, lan_ssh)
    await _run(db, lan_ssh)
    h = await auth_headers(client, db)
    ids = list(await db.scalars(select(Deployment.id).order_by(Deployment.created_at)))
    first, second = [(await client.get(f"/api/deploy/deployments/{i}", headers=h)).json()
                     for i in ids]
    assert (first["first_success"], second["first_success"]) == (True, False)


async def test_a_failed_deploy_is_not_a_first_success(client, db, lan_ssh, fake_runner):
    from sirdar_api.db.models import Deployment
    from sirdar_api.deploy.runner import RunResult
    fake_runner.results["up"] = RunResult(status="failed", rc=2)
    dep = await pipeline.create_deployment(db, lan_ssh, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    h = await auth_headers(client, db)
    [dep_id] = list(await db.scalars(select(Deployment.id)))
    body = (await client.get(f"/api/deploy/deployments/{dep_id}", headers=h)).json()
    assert (body["status"], body["first_success"]) == ("failed", False)
