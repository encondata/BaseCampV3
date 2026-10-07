import uuid

import pytest

from sirdar_api.db.models import Deployment, Environment, EsxiVm, Integration
from sirdar_api.deploy.esxi import EsxiError, SnapshotInfo

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
from .esxi_helpers import esxi_fake  # noqa: F401
from .integration_helpers import ESXI_PASSWORD, configure_esxi
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_deployments_api import OLD, SHA, UPDATE_KEYS, _finish

URL = "/api/deploy/environments"
UAT3 = f"{URL}/uat3"
SNAP = "sirdar-20261005T120000Z"
BODY = {"mode": "new", "name": "uat3", "type": "dev", "target": "esxi",
        "proxy_ip": "10.10.48.6", "publish": False,
        "vm": {"ip_mode": "static", "ip_cidr": "10.10.48.71/24", "gateway": "10.10.48.1"}}


@pytest.fixture
async def esx(db, deploy_env, secrets_key, esxi_fake, leak_guard):
    await configure_esxi(db)
    leak_guard.append(ESXI_PASSWORD)
    return esxi_fake


async def _built(db, esx, env_id: uuid.UUID):
    """The VM step 0 would have built for uat3, on the fake ESXi."""
    vm = esx.add_vm("ss-uat3", owner=str(env_id), power_state="poweredOn")
    record = await db.get(EsxiVm, (env_id, "main"))
    record.moref, record.instance_uuid, record.created = vm.moref, vm.instance_uuid, True
    await db.commit()
    return vm


def _taken(env_id, name=SNAP, previous=OLD, status="succeeded") -> Deployment:
    return Deployment(environment_id=env_id, mode="update", git_ref="main", sha=SHA,
                      status=status, start_step=0, vm=True, take_vm_snapshot=True,
                      vm_snapshot=name, previous_sha=previous)


async def test_esxi_must_be_set_up(client, db, deploy_env, secrets_key):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json=BODY)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "integration_not_configured", "kinds": ["esxi"]}


async def test_create_an_esxi_environment(client, db, esx):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json=BODY)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["target"], body["target_kind"]) == ("esxi", "esxi")
    assert (body["vm"]["kind"], body["vm"]["stage"], body["vm"]["host"],
            body["vm"]["moref"], body["vm"]["role"]) == ("esxi", "none", "10.10.48.10", None,
                                                         "main")
    assert {s["host_ip"] for s in body["services"]} == {"10.10.48.71"}
    resp = await client.post(URL, headers=h,
                             json={**BODY, "name": "uat4", "mode": "adopt", "vm": None})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "adopt_not_allowed")


async def test_a_deploy_starts_with_prepare_vm_and_delete_destroys_it(client, db, esx,
                                                                      fake_runner,
                                                                      fake_provisioner,
                                                                      fake_publisher):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=BODY)
    fake_provisioner.fail["provision"] = "stopped here"           # never reaches SSH
    resp = await client.post(f"{UAT3}/deployments", headers=h,
                             json={"mode": "update", "git_ref": "main"})
    assert resp.status_code == 201, resp.text
    dep = resp.json()
    assert (dep["vm"], dep["sha"], dep["take_vm_snapshot"]) == (True, "", False)
    assert [s["key"] for s in dep["steps"]] == ["provision", *UPDATE_KEYS]
    await _finish(dep)
    assert fake_provisioner.calls[:1] == ["provision"]
    retry = await client.post(f"/api/deploy/deployments/{dep['id']}/retry", headers=h,
                              json={"from_step": 0})
    assert retry.status_code == 201, retry.text
    await _finish(retry.json())
    resp = await client.post(f"{UAT3}/deployments", headers=h,
                             json={"mode": "teardown", "confirm_name": "uat3"})
    assert resp.status_code == 201, resp.text
    assert [(s["number"], s["key"]) for s in resp.json()["steps"]] == [
        (15, "destroy"), (16, "unproxy"), (17, "undns")]
    await _finish(resp.json())
    assert fake_provisioner.calls[-1] == "destroy"


async def test_a_deployed_esxi_vm_takes_a_snapshot_and_needs_esxi(client, db, esx, fake_runner,
                                                                  fake_provisioner):
    h = await auth_headers(client, db)
    env_id = uuid.UUID((await client.post(URL, headers=h, json=BODY)).json()["id"])
    row = await db.get(Environment, env_id)
    row.current_sha, row.image_tag, row.status = OLD, OLD[:8], "ready"
    await db.commit()
    fake_provisioner.fail["provision"] = "stopped here"
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={})
    assert resp.status_code == 201, resp.text
    assert resp.json()["take_vm_snapshot"] is True
    await _finish(resp.json())
    await db.delete(await db.get(Integration, "esxi"))
    await db.commit()
    resp = await client.post(f"{UAT3}/deployments", headers=h, json={})
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["esxi"]})
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["esxi"]})


async def test_restore_an_esxi_vm_snapshot(client, db, esx, fake_runner, fake_provisioner):
    h = await auth_headers(client, db)
    env_id = uuid.UUID((await client.post(URL, headers=h, json=BODY)).json()["id"])
    db.add(_taken(env_id))
    await db.commit()
    resp = await client.post(f"{UAT3}/deployments", headers=h,
                             json={"mode": "vm_restore", "vm_snapshot": SNAP,
                                   "confirm_name": "uat3"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["mode"], body["sha"], body["vm"], body["vm_snapshot"]) == (
        "vm_restore", OLD, True, SNAP)
    assert [s["key"] for s in body["steps"]][:1] == ["vm_restore"]
    await _finish(body)
    assert fake_provisioner.calls[:1] == ["vm_restore"]


async def test_the_vm_snapshot_list_reads_esxi(client, db, esx):
    h = await auth_headers(client, db)
    env_id = uuid.UUID((await client.post(URL, headers=h, json=BODY)).json()["id"])
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert (resp.status_code, resp.json()) == (200, {"snapshots": []})   # no VM yet
    assert "snapshots" not in esx.calls
    vm = await _built(db, esx, env_id)
    vm.snapshots += [SnapshotInfo(1, SNAP, "Sirdar: before update", None),
                     SnapshotInfo(2, "by hand", "", None)]
    db.add(_taken(env_id))
    await db.commit()
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert resp.status_code == 200, resp.text
    [row] = resp.json()["snapshots"]
    assert (row["name"], row["sha"], row["restorable"], row["description"]) == (
        SNAP, OLD, True, "Sirdar: before update")


async def test_the_vm_snapshot_list_when_esxi_fails(client, db, esx):
    h = await auth_headers(client, db)
    env_id = uuid.UUID((await client.post(URL, headers=h, json=BODY)).json()["id"])
    await _built(db, esx, env_id)
    esx.fail["snapshots"] = EsxiError("ESXi didn't answer.")
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": "ESXi didn't answer."})


async def test_vm_routes_on_an_ssh_environment(client, db, deploy_env, secrets_key):
    await make_environment(db, name="uat3")
    h = await auth_headers(client, db)
    resp = await client.get(f"{UAT3}/vm-snapshots", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "not_vm_environment")
    resp = await client.post(f"{UAT3}/deployments", headers=h,
                             json={"mode": "vm_restore", "vm_snapshot": SNAP,
                                   "confirm_name": "uat3"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "not_vm_environment")


async def test_moving_to_esxi_is_locked(client, db, esx):
    await make_environment(db, name="uat")
    h = await auth_headers(client, db)
    resp = await client.patch(f"{URL}/uat", headers=h, json={"target": "esxi"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "target_kind_locked")
