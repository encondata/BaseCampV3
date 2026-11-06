"""Starting a cleanup through the API: Delete's steps for an environment
that has never deployed, on every target, with no snapshot and production's
rules; refused once an Update has succeeded. Also the environment's
never_deployed field, and Update waiting for a first admin's new password."""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import delete, update

from sirdar_api.db.models import Deployment, Environment
from sirdar_api.deploy import environments, first_admins, lan_slots, pipeline
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    leak_guard,
    make_environment,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
    trust_fake,
)
from .esxi_helpers import esxi_fake  # noqa: F401
from .proxmox_helpers import proxmox_fake  # noqa: F401
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_deployments_api import LS, SHA
from .test_deploy_do_deployments_api import PHRASE
from .test_deploy_do_deployments_api import ready as do_ready  # noqa: F401
from .test_deploy_esxi_vm_api import BODY as ESXI_BODY
from .test_deploy_esxi_vm_api import esx  # noqa: F401
from .test_deploy_lan_api import NEW as LAN_NEW
from .test_deploy_lan_api import ready as lan_ready  # noqa: F401
from .test_deploy_vm_api import VM_BODY, px  # noqa: F401

URL = "/api/deploy/environments"
ADMIN = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
         "password_mode": "typed", "password": "Correct-Horse-Battery-9"}


@pytest.fixture
async def fresh(db, deploy_env, ssh_server, secrets_key, fake_runner, fake_publisher):
    """uat on the SSH target, created and never deployed."""
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    ssh_server.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    return await make_environment(db)


def _code(resp) -> tuple[int, str]:
    return resp.status_code, resp.json()["detail"]["code"]


async def _start(client, h, name, **body):
    resp = await client.post(f"{URL}/{name}/deployments", headers=h, json=body)
    if resp.status_code == 201:
        await pipeline.wait(uuid.UUID(resp.json()["id"]))
    return resp


async def _retry(client, h, dep_id, **body):
    resp = await client.post(f"/api/deploy/deployments/{dep_id}/retry", headers=h, json=body)
    if resp.status_code == 201:
        await pipeline.wait(uuid.UUID(resp.json()["id"]))
    return resp


async def _cleanup_started(client, h, name, keys) -> dict:
    resp = await _start(client, h, name, mode="cleanup", confirm_name=name)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["mode"] == "cleanup"
    assert [s["key"] for s in body["steps"]] == keys
    assert body["snapshot"] is None
    return body


async def _succeeded_update(db, env_id, **over) -> Deployment:
    dep = Deployment(environment_id=env_id, mode="update", git_ref="main", sha=SHA,
                     status="succeeded", start_step=1, **over)
    db.add(dep)
    await db.commit()
    return dep


# ---- starting a cleanup, per target --------------------------------------------------

async def test_cleanup_starts_for_never_deployed_ssh(client, db, fresh):
    h = await auth_headers(client, db)
    body = await _cleanup_started(client, h, "uat", ["teardown", "unproxy", "undns"])
    assert body["start_step"] == 15
    # Unlike Delete, the environment stays (empty again).
    got = (await client.get(f"{URL}/uat", headers=h)).json()
    assert (got["status"], got["never_deployed"]) == ("new", True)


async def test_cleanup_starts_for_never_deployed_proxmox(client, db, px, fake_runner,
                                                         fake_provisioner, fake_publisher):
    h = await auth_headers(client, db)
    assert (await client.post(URL, headers=h, json=VM_BODY)).status_code == 201
    await _cleanup_started(client, h, "uat3", ["destroy", "unproxy", "undns"])
    assert fake_provisioner.calls == ["destroy"]


async def test_cleanup_starts_for_never_deployed_esxi(client, db, esx, fake_runner,
                                                      fake_provisioner, fake_publisher):
    h = await auth_headers(client, db)
    assert (await client.post(URL, headers=h, json=ESXI_BODY)).status_code == 201
    await _cleanup_started(client, h, "uat3", ["destroy", "unproxy", "undns"])
    assert fake_provisioner.calls == ["destroy"]


async def test_cleanup_starts_for_never_deployed_bluegreen(client, db, lan_ready):
    h = await auth_headers(client, db)
    assert (await client.post(URL, headers=h, json=LAN_NEW)).status_code == 201
    body = await _cleanup_started(client, h, "lan9", ["destroy", "unproxy", "undns"])
    assert body["bluegreen"] is True


async def test_cleanup_on_bluegreen_takes_no_snapshot_even_when_a_slot_ran(
        client, db, lan_ready, fake_runner):
    """A first Update that failed after its slot came up: the shared database
    may hold data, but a cleanup never takes a snapshot."""
    h = await auth_headers(client, db)
    assert (await client.post(URL, headers=h, json=LAN_NEW)).status_code == 201
    fake_runner.results["slot_smoke"] = RunResult(status="failed", rc=2)
    first = await _start(client, h, "lan9", git_ref=SHA)
    assert first.status_code == 201, first.text
    dep = await db.get(Deployment, uuid.UUID(first.json()["id"]), populate_existing=True)
    assert dep.status == "failed"
    env = await db.get(Environment, dep.environment_id, populate_existing=True)
    assert await lan_slots.ran(db, env)
    await _cleanup_started(client, h, "lan9", ["destroy", "unproxy", "undns"])


async def test_cleanup_starts_for_never_deployed_digitalocean(client, db, do_ready):
    env = await do_ready()
    h = await auth_headers(client, db)
    body = await _cleanup_started(client, h, "uat9", ["undns", "do_destroy"])
    assert body["cloud"] is True
    row = await db.get(Environment, env.id, populate_existing=True)
    assert row is not None and row.status == "new"


# ---- refusals ----------------------------------------------------------------------

async def test_cleanup_refused_after_a_successful_update(client, db, fresh):
    h = await auth_headers(client, db)
    await _succeeded_update(db, fresh.id)
    assert _code(await _start(client, h, "uat", mode="cleanup", confirm_name="uat")) == (
        409, "cleanup_not_allowed")


@pytest.mark.parametrize("mode", environments.DEPLOYED_MODES)
async def test_cleanup_refused_after_any_run_that_loads_or_serves_data(client, db, fresh, mode):
    """After a served-but-failed first Update, a Reset, Restore backup, Roll
    back, Restore VM snapshot or Activate that succeeded may hold real data."""
    h = await auth_headers(client, db)
    db.add(Deployment(environment_id=fresh.id, mode=mode, git_ref="main", sha=SHA,
                      status="succeeded", start_step=1))
    await db.commit()
    got = (await client.get(f"{URL}/uat", headers=h)).json()
    assert got["never_deployed"] is False
    assert _code(await _start(client, h, "uat", mode="cleanup", confirm_name="uat")) == (
        409, "cleanup_not_allowed")


@pytest.mark.parametrize("mode", ["publish", "cleanup"])
async def test_a_succeeded_publish_or_cleanup_leaves_it_never_deployed(client, db, fresh, mode):
    h = await auth_headers(client, db)
    db.add(Deployment(environment_id=fresh.id, mode=mode, git_ref="main", sha=SHA,
                      status="succeeded", start_step=1))
    await db.commit()
    assert (await client.get(f"{URL}/uat", headers=h)).json()["never_deployed"] is True


async def test_cleanup_refused_for_an_adopted_environment(client, db, fresh):
    """Adopted: never Sirdar's to clean up, even with no Update that succeeded."""
    h = await auth_headers(client, db)
    db.add(Deployment(environment_id=fresh.id, mode="adopt", git_ref="main", sha=SHA,
                      status="succeeded", start_step=0))
    await db.execute(update(Environment).where(Environment.id == fresh.id)
                     .values(current_sha=SHA))
    await db.commit()
    assert _code(await _start(client, h, "uat", mode="cleanup", confirm_name="uat")) == (
        409, "cleanup_not_allowed")


async def test_cleanup_allowed_when_a_failed_first_update_set_the_commit(client, db, fresh):
    """A first Update that failed at smoke, go_live or seed may already have
    recorded its commit (pipeline._serving, _seeded_failed): still never
    deployed."""
    h = await auth_headers(client, db)
    db.add(Deployment(environment_id=fresh.id, mode="update", git_ref="main", sha=SHA,
                      status="failed", start_step=1))
    await db.execute(update(Environment).where(Environment.id == fresh.id)
                     .values(current_sha=SHA, image_tag="t1"))
    await db.commit()
    await _cleanup_started(client, h, "uat", ["teardown", "unproxy", "undns"])
    got = (await client.get(f"{URL}/uat", headers=h)).json()
    assert (got["status"], got["never_deployed"]) == ("new", True)
    env = await db.get(Environment, fresh.id, populate_existing=True)
    assert (env.current_sha, env.image_tag) == (None, None)


async def test_cleanup_needs_name(client, db, fresh):
    h = await auth_headers(client, db)
    assert _code(await _start(client, h, "uat", mode="cleanup")) == (
        422, "confirm_name_mismatch")
    assert _code(await _start(client, h, "uat", mode="cleanup", confirm_name="UAT")) == (
        422, "confirm_name_mismatch")


async def test_cleanup_needs_change(client, db, fresh):
    from .test_deploy_deployments_api import _headers_without_change
    adder = await _headers_without_change(client, db)
    resp = await _start(client, adder, "uat", mode="cleanup", confirm_name="uat")
    assert resp.status_code == 403


async def test_cleanup_refuses_snapshot_and_git_ref(client, db, fresh, do_ready):
    await do_ready()
    h = await auth_headers(client, db)
    for name in ("uat", "uat9"):
        base = {"mode": "cleanup", "confirm_name": name}
        for extra in ({"snapshot": True}, {"snapshot": False},
                      {"snapshot_id": str(uuid.uuid4())}):
            assert _code(await _start(client, h, name, **base, **extra)) == (
                422, "snapshot_not_allowed"), (name, extra)
        assert _code(await _start(client, h, name, **base, git_ref="main")) == (
            422, "git_ref_not_allowed")
    # The production phrase is DigitalOcean's only.
    assert _code(await _start(client, h, "uat", mode="cleanup", confirm_name="uat",
                              confirm_production="delete production uat")) == (
        422, "snapshot_not_allowed")


async def test_cleanup_production_needs_retiring_and_phrase(client, db, do_ready):
    env = await do_ready(name="prod", type_="production", account="production")
    h = await auth_headers(client, db)
    base = {"mode": "cleanup", "confirm_name": "prod", "confirm_production": PHRASE}
    assert _code(await _start(client, h, "prod", **base)) == (409, "production_not_retiring")
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=True))
    await db.commit()
    assert _code(await _start(client, h, "prod", **{**base, "confirm_production": "yes"})) == (
        422, "confirm_production_mismatch")
    assert _code(await _start(client, h, "prod", mode="cleanup", confirm_name="prod")) == (
        422, "confirm_production_mismatch")
    resp = await _start(client, h, "prod", **base)
    assert resp.status_code == 201, resp.text
    assert [s["key"] for s in resp.json()["steps"]] == ["undns", "do_destroy"]


# ---- retry -------------------------------------------------------------------------

async def test_retry_cleanup_refused_after_success(client, db, fresh, fake_runner):
    h = await auth_headers(client, db)
    fake_runner.results["teardown"] = RunResult(status="failed", rc=2)
    failed = (await _start(client, h, "uat", mode="cleanup", confirm_name="uat")).json()
    dep = await db.get(Deployment, uuid.UUID(failed["id"]), populate_existing=True)
    assert dep.status == "failed"
    del fake_runner.results["teardown"]
    assert _code(await _retry(client, h, dep.id)) == (422, "confirm_name_mismatch")
    # An Update that succeeded (before it, as history has it) makes it deployed.
    done = await _succeeded_update(db, fresh.id, created_at=dep.created_at - timedelta(hours=1))
    assert _code(await _retry(client, h, dep.id, confirm_name="uat")) == (
        409, "cleanup_not_allowed")
    await db.execute(delete(Deployment).where(Deployment.id == done.id))
    await db.commit()
    resp = await _retry(client, h, dep.id, confirm_name="uat")
    assert resp.status_code == 201, resp.text
    assert resp.json()["mode"] == "cleanup"
    retried = await db.get(Deployment, uuid.UUID(resp.json()["id"]), populate_existing=True)
    assert retried.status == "succeeded"
    # Nothing left to retry once it succeeded.
    assert _code(await _retry(client, h, retried.id, confirm_name="uat")) == (
        409, "not_retryable")


async def test_retry_cleanup_refused_after_a_restore(client, db, fresh, fake_runner):
    h = await auth_headers(client, db)
    fake_runner.results["teardown"] = RunResult(status="failed", rc=2)
    failed = (await _start(client, h, "uat", mode="cleanup", confirm_name="uat")).json()
    del fake_runner.results["teardown"]
    dep = await db.get(Deployment, uuid.UUID(failed["id"]), populate_existing=True)
    # Earlier in history, so the failed cleanup is still the latest run.
    db.add(Deployment(environment_id=fresh.id, mode="restore_dump", git_ref="main", sha=SHA,
                      status="succeeded", start_step=1,
                      created_at=dep.created_at - timedelta(hours=1)))
    await db.commit()
    assert _code(await _retry(client, h, dep.id, confirm_name="uat")) == (
        409, "cleanup_not_allowed")


async def test_retry_cleanup_keeps_production_s_rules(client, db, do_ready, fake_provisioner):
    env = await do_ready(name="prod", type_="production", account="production")
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=True))
    await db.commit()
    h = await auth_headers(client, db)
    fake_provisioner.fail["do_destroy"] = "DigitalOcean said no."
    body = (await _start(client, h, "prod", mode="cleanup", confirm_name="prod",
                         confirm_production=PHRASE)).json()
    dep = await db.get(Deployment, uuid.UUID(body["id"]), populate_existing=True)
    assert dep.status == "failed"
    del fake_provisioner.fail["do_destroy"]
    assert _code(await _retry(client, h, dep.id, confirm_name="prod")) == (
        422, "confirm_production_mismatch")
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=False))
    await db.commit()
    assert _code(await _retry(client, h, dep.id, confirm_name="prod",
                              confirm_production=PHRASE)) == (409, "production_not_retiring")
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=True))
    await db.commit()
    resp = await _retry(client, h, dep.id, confirm_name="prod", confirm_production=PHRASE)
    assert resp.status_code == 201, resp.text


# ---- never_deployed ----------------------------------------------------------------

async def test_environment_out_never_deployed(client, db, fresh):
    h = await auth_headers(client, db)

    async def never() -> bool:
        return (await client.get(f"{URL}/uat", headers=h)).json()["never_deployed"]
    assert await never() is True
    db.add(Deployment(environment_id=fresh.id, mode="update", git_ref="main", sha=SHA,
                      status="failed", start_step=1))
    await db.commit()
    assert await never() is True
    # A failed first Update that recorded its commit: still never deployed.
    await db.execute(update(Environment).where(Environment.id == fresh.id)
                     .values(current_sha=SHA))
    await db.commit()
    assert await never() is True
    await _succeeded_update(db, fresh.id)
    assert await never() is False
    listed = (await client.get(URL, headers=h)).json()
    assert [e["never_deployed"] for e in listed["environments"]] == [False]


# ---- the first admin's password ----------------------------------------------------

async def test_update_refused_while_first_admin_needs_password(client, db, fresh, secrets_key):
    from sirdar_api.config import get_settings
    h = await auth_headers(client, db)
    await first_admins.put(db, get_settings(), fresh.id, first_admins.check(ADMIN))
    # What a cleanup leaves: step 11 used (and cleared) the password, then reset.
    await first_admins.mark_done(db, fresh.id)
    await first_admins.reset(db, fresh.id)
    await db.commit()
    assert first_admins.needs_password(await first_admins.get(db, fresh.id))
    assert _code(await _start(client, h, "uat", mode="update")) == (
        409, "first_admin_password_needed")
    resp = await client.put(f"{URL}/uat/first-admin", headers=h, json=ADMIN)
    assert resp.status_code == 200, resp.text
    resp = await _start(client, h, "uat", mode="update")
    assert resp.status_code == 201, resp.text
    assert "first_admin" in [s["key"] for s in resp.json()["steps"]]


async def test_update_retry_refused_while_first_admin_needs_password(client, db, fresh,
                                                                     fake_runner):
    from sirdar_api.config import get_settings
    h = await auth_headers(client, db)
    fake_runner.results["up"] = RunResult(status="failed", rc=2)
    failed = (await _start(client, h, "uat", mode="update")).json()
    del fake_runner.results["up"]
    await first_admins.put(db, get_settings(), fresh.id, first_admins.check(ADMIN))
    await first_admins.mark_done(db, fresh.id)
    await first_admins.reset(db, fresh.id)
    await db.commit()
    assert _code(await _retry(client, h, failed["id"])) == (409, "first_admin_password_needed")
    assert (await client.put(f"{URL}/uat/first-admin", headers=h, json=ADMIN)).status_code == 200
    resp = await _retry(client, h, failed["id"])
    assert resp.status_code == 201, resp.text

