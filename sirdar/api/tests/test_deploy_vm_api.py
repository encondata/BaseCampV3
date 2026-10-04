import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog, Deployment, DeploymentStep, Environment, Integration
from sirdar_api.deploy import proxmox, vms

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    leak_guard,
    make_environment,
    secrets_key,
    stop_pipeline,
)
from .integration_helpers import PX_TOKEN_SECRET, configure_proxmox
from .proxmox_helpers import proxmox_fake  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_deployments_api import OLD, SHA, UPDATE_KEYS, _finish, _headers_without_change

URL = "/api/deploy/environments"
UAT3 = f"{URL}/uat3"
SNAP = "sirdar-20261004T120000Z"
VM_BODY = {"mode": "new", "name": "uat3", "type": "dev", "target": "proxmox",
           "proxy_ip": "10.10.48.6", "publish": False,
           "vm": {"ip_mode": "static", "ip_cidr": "10.10.48.70/24", "gateway": "10.10.48.1",
                  "cores": 2}}


@pytest.fixture
async def px(db, deploy_env, secrets_key, proxmox_fake, leak_guard):
    await configure_proxmox(db)
    leak_guard.append(PX_TOKEN_SECRET)
    return proxmox_fake


async def _uat3(client, h, *, current_sha=None, db=None):
    """uat3 through the API; with current_sha, as if deployed at that commit."""
    resp = await client.post(URL, headers=h, json=VM_BODY)
    assert resp.status_code == 201, resp.text
    if current_sha:
        row = await db.get(Environment, uuid.UUID(resp.json()["id"]))
        row.current_sha, row.image_tag, row.status = current_sha, current_sha[:8], "ready"
        await db.commit()
    return resp.json()


async def _taken(db, env_id, name=SNAP, previous=OLD) -> Deployment:
    dep = Deployment(environment_id=env_id, mode="update", git_ref="main", sha=SHA,
                     status="failed", start_step=0, vm=True, take_vm_snapshot=True,
                     vm_snapshot=name, previous_sha=previous)
    db.add(dep)
    await db.commit()
    return dep


async def test_create_a_proxmox_environment(client, db, px):
    h = await auth_headers(client, db)
    body = await _uat3(client, h)
    assert (body["target"], body["target_kind"]) == ("proxmox", "proxmox")
    assert body["vm"] == {"name": "ss-uat3", "node": "pve", "vmid": None, "cores": 2,
                          "memory_mb": 8192, "disk_gb": 64, "ip_mode": "static",
                          "ip_cidr": "10.10.48.70/24", "gateway": "10.10.48.1", "ip": None,
                          "keep_snapshots": 3, "created": False}
    assert {s["host_ip"] for s in body["services"]} == {"10.10.48.70"}
    [audit] = await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_create"))
    assert audit["vm"] == VM_BODY["vm"]
    targets = (await client.get("/api/deploy/targets", headers=h)).json()["targets"]
    assert targets[-1]["id"] == "proxmox"
    defaults = (await client.get("/api/deploy/environment-defaults", headers=h)).json()
    assert defaults["vm"] == {"cores": 4, "memory_mb": 8192, "disk_gb": 64, "keep_snapshots": 3,
                              "limits": {"cores": [1, 64], "memory_mb": [2048, 262144],
                                         "disk_gb": [20, 4096], "keep_snapshots": [1, 10]}}


async def test_create_errors(client, db, deploy_env, secrets_key, proxmox_fake):
    deploy_env(ssh_host="10.10.48.63", ssh_user="jrh", ssh_password="pw")
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json=VM_BODY)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["proxmox"]})
    await configure_proxmox(db)
    for change, status, code in (
            ({"vm": {**VM_BODY["vm"], "ip_cidr": "10.10.48.63/24"}}, 409, "ip_in_use"),
            ({"vm": {**VM_BODY["vm"], "ip_cidr": "10.10.48.70"}}, 422, "vm_ip_invalid"),
            ({"vm": {"ip_mode": "dhcp", "disk_gb": 10}}, 422, "vm_disk_invalid"),
            ({"target": "ssh"}, 422, "vm_not_allowed"),
            ({"mode": "adopt", "vm": None}, 422, "adopt_not_allowed"),
            ({"mode": "adopt", "target": "ssh"}, 422, "vm_not_allowed")):
        resp = await client.post(URL, headers=h, json={**VM_BODY, **change})
        assert (resp.status_code, resp.json()["detail"]["code"]) == (status, code), change


async def test_patch_the_vm(client, db, px):
    h = await auth_headers(client, db)
    await _uat3(client, h)
    resp = await client.patch(UAT3, headers=h, json={"vm": {"cores": 4, "disk_gb": 128,
                                                            "keep_snapshots": 5}})
    assert resp.status_code == 200, resp.text
    vm = resp.json()["vm"]
    assert (vm["cores"], vm["disk_gb"], vm["keep_snapshots"]) == (4, 128, 5)
    for patch, code in (({"vm": {"disk_gb": 64}}, "vm_disk_shrink"),
                        ({"services": {"api": {"host_ip": "10.10.48.71"}}}, "host_ip_managed"),
                        ({"target": "ssh"}, "target_kind_locked")):
        resp = await client.patch(UAT3, headers=h, json=patch)
        assert (resp.status_code, resp.json()["detail"]["code"]) == (422, code), patch


async def test_deploy_a_proxmox_environment(client, db, px, fake_runner, fake_provisioner):
    h = await auth_headers(client, db)
    await _uat3(client, h)
    fake_provisioner.fail["provision"] = "stopped here"           # never reaches SSH
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["sha"], body["git_ref"], body["vm"], body["take_vm_snapshot"]) == (
        "", "main", True, False)                                   # never deployed: no snapshot
    assert [s["key"] for s in body["steps"]] == ["provision", *UPDATE_KEYS]
    assert body["steps"][0]["number"] == 0 and body["start_step"] == 0
    await _finish(body)
    retry = await client.post(f"/api/deploy/deployments/{body['id']}/retry", headers=h,
                              json={"from_step": 0})
    assert retry.status_code == 201, retry.text
    assert (retry.json()["start_step"], retry.json()["steps"][0]["status"]) == (0, "pending")
    await _finish(retry.json())
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={"git_ref": SHA.upper()})
    assert resp.json()["sha"] == SHA
    await _finish(resp.json())


async def test_a_deployed_vm_takes_a_snapshot_unless_told_not_to(client, db, px, fake_runner,
                                                                  fake_provisioner):
    h = await auth_headers(client, db)
    await _uat3(client, h, current_sha=OLD, db=db)
    fake_provisioner.fail["provision"] = "stopped here"
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={})
    assert resp.json()["take_vm_snapshot"] is True
    await _finish(resp.json())
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={"take_vm_snapshot": False})
    assert resp.json()["take_vm_snapshot"] is False
    await _finish(resp.json())
    await make_environment(db, name="uat")
    resp = await client.post(f"{URL}/uat/deployments", headers=h,
                             json={"take_vm_snapshot": True})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "vm_snapshot_not_allowed")
    await db.delete(await db.get(Integration, "proxmox"))
    await db.commit()
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={})
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["proxmox"]})


async def test_restore_a_vm_snapshot(client, db, px, fake_runner, fake_provisioner):
    h = await auth_headers(client, db)
    created = await _uat3(client, h, current_sha=SHA, db=db)
    env_id = uuid.UUID(created["id"])
    await _taken(db, env_id)
    start = f"{UAT3}/deployments"
    good = {"mode": "vm_restore", "vm_snapshot": SNAP, "confirm_name": "uat3"}
    adder = await _headers_without_change(client, db)
    assert (await client.post(start, headers=adder, json=good)).status_code == 403
    for body, status, code in (
            ({**good, "confirm_name": "uat"}, 422, "confirm_name_mismatch"),
            ({**good, "vm_snapshot": "manual-1"}, 422, "vm_snapshot_invalid"),
            ({**good, "vm_snapshot": "sirdar-20200101T000000Z"}, 404, "vm_snapshot_not_found"),
            ({"mode": "update", "vm_snapshot": SNAP}, 422, "vm_snapshot_invalid"),
            ({**good, "git_ref": "main"}, 422, "git_ref_not_allowed")):
        resp = await client.post(start, headers=h, json=body)
        assert (resp.status_code, resp.json()["detail"]["code"]) == (status, code), body
    resp = await client.post(start, headers=h, json=good)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["mode"], body["sha"], body["vm_snapshot"], body["start_step"]) == (
        "vm_restore", OLD, SNAP, 0)
    assert [(s["number"], s["key"]) for s in body["steps"]] == [(0, "vm_restore")]
    await _finish(body)
    env = (await client.get(UAT3, headers=h)).json()
    assert (env["current_sha"], env["status"]) == (OLD, "ready")
    # a snapshot restore after the VM snapshot changed the sign-in keys
    restoring = Deployment(environment_id=env_id, mode="reset", git_ref="main", sha=SHA,
                           status="succeeded", start_step=1)
    db.add(restoring)
    await db.flush()
    db.add(DeploymentStep(deployment_id=restoring.id, number=9, key="restore",
                          name="Restore snapshot", status="succeeded",
                          finished_at=vms.snapshot_taken_at(SNAP) + timedelta(hours=1)))
    await db.commit()
    resp = await client.post(start, headers=h, json=good)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "vm_snapshot_keys_changed")
    await make_environment(db, name="uat")
    resp = await client.post(f"{URL}/uat/deployments", headers=h,
                             json={**good, "confirm_name": "uat"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "not_proxmox")


async def test_the_vm_snapshot_list(client, db, px):
    h = await auth_headers(client, db)
    created = await _uat3(client, h, current_sha=SHA, db=db)
    env_id = uuid.UUID(created["id"])
    assert (await client.get(f"{UAT3}/vm-snapshots", headers=h)).json() == {"snapshots": []}
    vm = await vms.get(db, env_id)
    vm.vmid, vm.created = 120, True
    await db.commit()
    taking = await _taken(db, env_id)
    await _taken(db, env_id, name="sirdar-20261003T080000Z")       # recorded, but gone
    px.add_vm(120, "ss-uat3")
    px.snaps[120] = [{"name": SNAP, "description": "Sirdar: before update"},
                     {"name": "manual-before-upgrade", "description": "by hand"}]
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"snapshots": [{
        "name": SNAP, "taken_at": "2026-10-04T12:00:00Z", "sha": OLD,
        "deployment_id": str(taking.id), "description": "Sirdar: before update",
        "restorable": True, "reason": None}]}
    px.tls_error = True
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": proxmox.TLS_CHANGED})
    await make_environment(db, name="uat")
    resp = await client.get(f"{URL}/uat/vm-snapshots", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "not_proxmox")


async def test_delete_a_proxmox_environment(client, db, px, fake_runner, fake_provisioner,
                                            fake_publisher):
    h = await auth_headers(client, db)
    await _uat3(client, h)
    resp = await client.post(f"{UAT3}/deployments", headers=h,
                             json={"mode": "teardown", "confirm_name": "uat3"})
    assert resp.status_code == 201, resp.text
    assert [(s["number"], s["key"]) for s in resp.json()["steps"]] == [
        (15, "destroy"), (16, "unproxy"), (17, "undns")]
    await _finish(resp.json())
    assert fake_provisioner.calls == ["destroy"]
    assert (await client.get(UAT3, headers=h)).status_code == 404


async def test_a_vm_without_an_address_has_no_backups_or_data_snapshots(client, db, px):
    h = await auth_headers(client, db)
    await _uat3(client, h, current_sha=SHA, db=db)
    assert (await client.get(f"{UAT3}/backups", headers=h)).json() == {"backups": []}
    resp = await client.post(f"{UAT3}/snapshots", headers=h, json={"name": "uat3-now"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "vm_not_ready")


async def test_an_unreadable_vm_key(client, db, px, fake_runner, fake_provisioner,
                                    fake_publisher):
    """Deploys that use the VM's SSH key refuse when it can't be decrypted;
    Delete environment (step 15 Destroy VM, no SSH) still runs."""
    h = await auth_headers(client, db)
    created = await _uat3(client, h, current_sha=SHA, db=db)
    vm = await vms.get(db, uuid.UUID(created["id"]))
    vm.ip, vm.ssh_private_key_enc = "10.10.48.70", b"not-a-fernet-token"
    await db.commit()
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "vm_key_unreadable")
    resp = await client.post(f"{UAT3}/deployments", headers=h,
                             json={"mode": "teardown", "confirm_name": "uat3"})
    assert resp.status_code == 201, resp.text
    await _finish(resp.json())


async def test_a_vm_restore_retry_checks_the_sign_in_keys_again(client, db, px, fake_runner,
                                                                fake_provisioner):
    """A snapshot restore after the failed Restore VM snapshot replaced the
    sign-in keys: retrying would bring back keys that exist nowhere."""
    h = await auth_headers(client, db)
    created = await _uat3(client, h, current_sha=SHA, db=db)
    env_id = uuid.UUID(created["id"])
    await _taken(db, env_id)
    fake_provisioner.fail["vm_restore"] = "Proxmox said no."
    good = {"mode": "vm_restore", "vm_snapshot": SNAP, "confirm_name": "uat3"}
    resp = await client.post(f"{UAT3}/deployments", headers=h, json=good)
    assert resp.status_code == 201, resp.text
    failed = resp.json()
    await _finish(failed)
    retry = f"/api/deploy/deployments/{failed['id']}/retry"
    # The keys change after the failure (a snapshot restore's step finished
    # later than the VM snapshot was taken), with the failed restore still latest.
    restoring = Deployment(environment_id=env_id, mode="reset", git_ref="main", sha=SHA,
                           status="succeeded", start_step=1,
                           created_at=vms.snapshot_taken_at(SNAP) - timedelta(days=1))
    db.add(restoring)
    await db.flush()
    db.add(DeploymentStep(deployment_id=restoring.id, number=9, key="restore",
                          name="Restore snapshot", status="succeeded",
                          finished_at=vms.snapshot_taken_at(SNAP) + timedelta(hours=1)))
    await db.commit()
    resp = await client.post(retry, headers=h, json={"from_step": 0, "confirm_name": "uat3"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "vm_snapshot_keys_changed")
    assert resp.json()["detail"]["reason"].startswith("Taken before the sign-in keys changed")
    assert fake_provisioner.calls == ["vm_restore"]


@pytest.mark.parametrize("with_address", [False, True])
async def test_backups_on_a_vm_need_the_secrets_key(client, db, px, monkeypatch, secrets_key,
                                                    with_address):
    """The VM's SSH key is sealed with SIRDAR_SECRETS_KEY: without it the
    list says so, whether or not the VM has an address yet."""
    from sirdar_api.config import get_settings

    h = await auth_headers(client, db)
    created = await _uat3(client, h, current_sha=SHA, db=db)
    if with_address:
        vm = await vms.get(db, uuid.UUID(created["id"]))
        vm.ip = "10.10.48.70"
        await db.commit()
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    resp = await client.get(f"{UAT3}/backups", headers=h)
    assert (resp.status_code, resp.json()) == (400, {"detail": {"code": "secrets_key_missing"}})
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", secrets_key)    # the leak guard reads with it
    get_settings.cache_clear()
