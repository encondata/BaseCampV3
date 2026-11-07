"""A recipe-built snapshot may seed an environment that also gets a first
super admin: the restore still runs and step 11 creates the admin. A plain
snapshot still refuses it (its users are already in the data)."""

import uuid

import pytest
from sqlalchemy import update

from sirdar_api.config import get_settings
from sirdar_api.db.models import Snapshot
from sirdar_api.deploy import first_admins, pipeline
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    make_environment,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import ready_snapshot
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_deployments_api import LS, SHA
from .test_deploy_first_admin_api import ADMIN, NEW, URL, _code

pytestmark = pytest.mark.usefixtures("snapshots_dir")


@pytest.fixture
def target(deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    return ssh_server


async def _snap(db, tmp_path, origin: str, name: str) -> Snapshot:
    snap = await ready_snapshot(db, tmp_path, name=name)
    await db.execute(update(Snapshot).where(Snapshot.id == snap.id).values(origin=origin))
    await db.commit()
    return snap


def _keys(body: dict) -> list[str]:
    return [s["key"] for s in body["steps"]]


async def test_create_accepts_a_first_admin_with_a_recipe_snapshot(client, db, target, tmp_path):
    snap = await _snap(db, tmp_path, "recipe", "from-recipe")
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "snapshot_id": str(snap.id),
                                                   "first_admin": ADMIN})
    assert resp.status_code == 201, resp.text
    assert resp.json()["first_admin"]["email"] == ADMIN["email"]


async def test_create_still_refuses_a_first_admin_with_a_plain_snapshot(
        client, db, target, tmp_path):
    snap = await _snap(db, tmp_path, "upload", "plain")
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "snapshot_id": str(snap.id),
                                                   "first_admin": ADMIN})
    assert _code(resp) == (422, "first_admin_with_seed")


async def test_create_needs_a_first_admin_when_the_recipe_reset_passwords(
        client, db, target, tmp_path):
    # its passwords are gone: without a first admin nobody could sign in
    snap = await _snap(db, tmp_path, "recipe", "reset")
    await db.execute(update(Snapshot).where(Snapshot.id == snap.id).values(reset_passwords=True))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "snapshot_id": str(snap.id)})
    assert _code(resp) == (422, "first_admin_required")
    resp = await client.post(URL, headers=h, json={**NEW, "snapshot_id": str(snap.id),
                                                   "first_admin": ADMIN})
    assert resp.status_code == 201, resp.text


async def test_ssh_first_update_restores_the_recipe_seed_and_creates_the_admin(
        client, db, target, fake_runner, tmp_path):
    snap = await _snap(db, tmp_path, "recipe", "from-recipe")
    h = await auth_headers(client, db)
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    fake_runner.results["first_admin"] = RunResult(status="successful", rc=0,
                                                   data={"first_admin_rc": "0"})
    assert (await client.post(URL, headers=h, json={
        **NEW, "snapshot_id": str(snap.id), "first_admin": ADMIN})).status_code == 201
    resp = await client.post(f"{URL}/fresh/deployments", headers=h, json={"mode": "update"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["snapshot"]["id"] == str(snap.id)
    assert body["first_admin"] is True
    assert {"restore", "first_admin"} <= set(_keys(body))
    await pipeline.wait(uuid.UUID(body["id"]))


async def test_ssh_first_update_of_a_plain_seed_has_no_first_admin_step(
        client, db, target, tmp_path):
    snap = await _snap(db, tmp_path, "upload", "plain")
    h = await auth_headers(client, db)
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    assert (await client.post(URL, headers=h, json={
        **NEW, "snapshot_id": str(snap.id)})).status_code == 201
    resp = await client.post(f"{URL}/fresh/deployments", headers=h, json={"mode": "update"})
    assert resp.status_code == 201, resp.text
    assert "first_admin" not in _keys(resp.json())
    await pipeline.wait(uuid.UUID(resp.json()["id"]))


async def test_do_first_update_restores_the_recipe_seed_and_creates_the_admin(
        client, db, secrets_key, ssh_server, monkeypatch, fake_runner, fake_publisher,
        fake_provisioner, tmp_path):
    from sirdar_api.deploy import vms
    from sirdar_api.deploy.provision import VmOutcome

    from .do_helpers import built, built_env, make_do_environment

    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = built
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)
    snap = await _snap(db, tmp_path, "recipe", "from-recipe")
    env = await make_do_environment(db, snapshot_id=snap.id)
    await built_env(env)
    await first_admins.put(db, get_settings(), env.id, first_admins.check(ADMIN))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/uat9/deployments", headers=h, json={"mode": "update"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["snapshot"]["id"] == str(snap.id)
    assert body["first_admin"] is True
    assert {"restore", "first_admin"} <= set(_keys(body))
    await pipeline.wait(uuid.UUID(body["id"]))


async def test_lan_first_update_restores_the_recipe_seed_and_creates_the_admin(
        client, db, secrets_key, ssh_server, monkeypatch, fake_provisioner, fake_runner,
        fake_publisher, tmp_path):
    from sirdar_api.deploy import vms
    from sirdar_api.deploy.vmcommon import VmOutcome

    from .integration_helpers import configure, configure_esxi
    from .lan_helpers import LAN_VM, lan_built

    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    monkeypatch.setattr(vms, "ALLOW_LOOPBACK", True)

    async def free(*args, **kwargs) -> bool:
        return False
    monkeypatch.setattr(vms, "address_in_use", free)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = lan_built()
    fake_provisioner.outcomes["provision"] = VmOutcome()
    snap = await _snap(db, tmp_path, "recipe", "from-recipe")
    h = await auth_headers(client, db)
    lan = {"mode": "new", "name": "lan9", "type": "custom", "target": "esxi",
           "proxy_ip": "10.0.0.2", "publish": False, "vm": LAN_VM}
    created = await client.post(URL, headers=h, json={
        **lan, "snapshot_id": str(snap.id), "first_admin": ADMIN})
    assert created.status_code == 201, created.text
    resp = await client.post(f"{URL}/lan9/deployments", headers=h, json={"git_ref": SHA})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["snapshot"]["id"] == str(snap.id)
    assert body["first_admin"] is True
    assert {"restore", "first_admin"} <= set(_keys(body))
    await pipeline.wait(uuid.UUID(body["id"]))
