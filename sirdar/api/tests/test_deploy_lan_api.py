"""LAN Blue/Green through the API: create, Update to the idle slot,
Activate, refusals, auto-activate, Delete with a snapshot."""

import uuid

import pytest
from sqlalchemy import delete, select, update

from sirdar_api.db.models import AuditLog, Deployment, Environment, Integration, VmSlot
from sirdar_api.deploy import pipeline, vms
from sirdar_api.deploy.runner import RunResult
from sirdar_api.deploy.vmcommon import VmOutcome

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
    trust_fake,
)
from .integration_helpers import configure, configure_esxi
from .lan_helpers import LAN_VM, lan_built
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_pipeline import SHA

URL = "/api/deploy/environments"
NEWER = "e1" * 20
NEW = {"mode": "new", "name": "lan9", "type": "custom", "target": "esxi",
       "proxy_ip": "10.0.0.2", "publish": False, "vm": LAN_VM}


@pytest.fixture
async def ready(db, secrets_key, ssh_server, monkeypatch, fake_provisioner, fake_runner,
                fake_publisher):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    monkeypatch.setattr(vms, "ALLOW_LOOPBACK", True)

    async def free(*args, **kwargs) -> bool:
        return False
    monkeypatch.setattr(vms, "address_in_use", free)
    await configure_esxi(db)
    await configure(db, cloudflare=True, npm=True)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["provision"] = lan_built()
    fake_provisioner.outcomes["provision"] = VmOutcome()     # the API sends full SHAs


async def _wait(resp):
    if resp.status_code == 201:
        await pipeline.wait(uuid.UUID(resp.json()["id"]))
    return resp


def _code(resp) -> tuple[int, str]:
    return resp.status_code, resp.json()["detail"]["code"]


async def _deployed(client, db, h) -> Environment:
    assert (await client.post(URL, headers=h, json=NEW)).status_code == 201
    first = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                          json={"git_ref": SHA}))
    assert (first.json()["slot"], first.json()["go_live"], first.json()["bluegreen"]) == (
        "orange", True, True)
    return await db.scalar(select(Environment).where(Environment.name == "lan9")
                           .execution_options(populate_existing=True))


async def _drop_npm(db) -> None:
    await db.execute(delete(Integration).where(Integration.kind == "npm"))
    await db.commit()


async def test_create_update_activate(client, db, ready):
    h = await auth_headers(client, db)
    env = await _deployed(client, db, h)
    assert env.active_slot == "orange"
    second = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                           json={"git_ref": NEWER}))
    assert (second.json()["slot"], second.json()["go_live"]) == ("purple", False)
    resp = await _wait(await client.post(f"{URL}/lan9/activate", headers=h,
                                         json={"slot": "purple"}))
    assert resp.status_code == 201, resp.text
    assert [s["key"] for s in resp.json()["steps"]] == ["slot_smoke", "lan_switch"]
    env = await db.get(Environment, env.id, populate_existing=True)
    assert (env.active_slot, env.current_sha) == ("purple", NEWER)
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.activate"))).one()
    assert (audit["slot"], audit["go_live"]) == ("purple", True)


async def test_the_create_audit_and_json_carry_the_three_vms(client, db, ready):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "vm": {**LAN_VM,
                                                               "auto_activate": True}})
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert [m["role"] for m in out["machines"]] == ["data", "orange", "purple"]
    assert out["auto_activate"] is True and out["vm"] is None
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_create"))).one()
    assert audit["vm"]["slots"] == 2 and audit["vm"]["data"]["disk_gb"] == 60


@pytest.mark.parametrize("body, expected", [
    ({"slot": "orange"}, (409, "slot_already_active")),
    ({"slot": "blue"}, (422, "slot_invalid")),
    ({"slot": None}, (422, "slot_required")),
    ({"slot": "purple"}, (409, "slot_not_deployed")),
])
async def test_activate_refusals(client, db, ready, body, expected):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    assert _code(await client.post(f"{URL}/lan9/activate", headers=h, json=body)) == expected


async def test_shared_data_modes_are_refused(client, db, ready):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    for body in ({"mode": "reset", "confirm_name": "lan9"},
                 {"mode": "restore_dump", "confirm_name": "lan9",
                  "backup": "20261007T120000Z.dump"},
                 {"mode": "vm_restore", "confirm_name": "lan9",
                  "vm_snapshot": "sirdar-20261007T120000Z"}):
        assert _code(await client.post(f"{URL}/lan9/deployments", headers=h, json=body)) == (
            409, "not_supported_on_bluegreen")
    assert _code(await client.post(f"{URL}/lan9/deployments", headers=h,
                                   json={"take_vm_snapshot": True})) == (
        422, "vm_snapshot_not_allowed")


async def test_auto_activate(client, db, ready):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    resp = await client.patch(f"{URL}/lan9", headers=h, json={"auto_activate": True})
    assert resp.status_code == 200 and resp.json()["auto_activate"] is True
    resp = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                         json={"git_ref": NEWER}))
    assert (resp.json()["slot"], resp.json()["go_live"]) == ("purple", True)
    assert _code(await client.patch(f"{URL}/lan9", headers=h, json={"vm": {"cores": 8}})) == (
        409, "vm_resize_not_supported")


async def test_a_single_server_environment_has_nothing_to_activate(client, db, ready):
    h = await auth_headers(client, db)
    single = {**NEW, "name": "solo", "vm": {k: v for k, v in LAN_VM.items()
                                            if k in ("ip_mode", "ip_cidr", "gateway")}}
    assert (await client.post(URL, headers=h, json=single)).status_code == 201
    assert _code(await client.post(f"{URL}/solo/activate", headers=h,
                                   json={"slot": "orange"})) == (409, "not_bluegreen_environment")
    # nor anything to activate automatically
    assert _code(await client.patch(f"{URL}/solo", headers=h, json={"auto_activate": True})) == (
        422, "auto_activate_not_allowed")


async def test_delete_takes_a_snapshot_then_removes_all_three(client, db, ready, snapshots_dir,
                                                              fake_runner, fake_provisioner):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    # the plan and the pending snapshot; the run itself is the pipeline tests' (Task 6)
    resp = await client.post(f"{URL}/lan9/deployments", headers=h,
                             json={"mode": "teardown", "confirm_name": "lan9"})
    assert resp.status_code == 201, resp.text
    assert [s["key"] for s in resp.json()["steps"]] == ["export", "destroy", "unproxy", "undns"]
    assert resp.json()["snapshot"]["name"].startswith("lan9-before-delete-")
    assert resp.json()["slot"] == "orange"


async def test_delete_without_a_snapshot(client, db, ready):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    await db.execute(update(VmSlot).values(sha=SHA))
    await db.commit()
    resp = await client.post(f"{URL}/lan9/deployments", headers=h,
                             json={"mode": "teardown", "confirm_name": "lan9", "snapshot": False})
    assert resp.status_code == 201, resp.text
    assert [s["key"] for s in resp.json()["steps"]] == ["destroy", "unproxy", "undns"]


async def test_production_phrase_is_not_for_bluegreen(client, db, ready):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    assert _code(await client.post(f"{URL}/lan9/deployments", headers=h, json={
        "mode": "teardown", "confirm_name": "lan9",
        "confirm_production": "delete production lan9"})) == (422, "snapshot_not_allowed")


async def test_npm_is_the_switch_even_with_publish_off(client, db, ready):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    await _wait(await client.post(f"{URL}/lan9/deployments", headers=h, json={"git_ref": NEWER}))
    await _drop_npm(db)
    for resp in (await client.post(f"{URL}/lan9/deployments", headers=h, json={}),
                 await client.post(f"{URL}/lan9/activate", headers=h, json={"slot": "purple"})):
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == {"code": "integration_not_configured", "kinds": ["npm"]}


async def test_retry_keeps_bluegreen_slot_and_go_live(client, db, ready, fake_runner):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    fake_runner.results["up"] = RunResult(status="failed", rc=1)
    failed = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                           json={"git_ref": NEWER}))
    dep = await db.get(Deployment, uuid.UUID(failed.json()["id"]), populate_existing=True)
    assert dep.status == "failed"
    del fake_runner.results["up"]
    resp = await _wait(await client.post(f"/api/deploy/deployments/{dep.id}/retry", headers=h,
                                         json={}))
    assert resp.status_code == 201, resp.text
    assert (resp.json()["bluegreen"], resp.json()["slot"], resp.json()["go_live"]) == (
        True, "purple", False)
    retry = await db.get(Deployment, uuid.UUID(resp.json()["id"]), populate_existing=True)
    assert retry.status == "succeeded"
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.deployment_retry"))).one()
    assert (audit["slot"], audit["go_live"]) == ("purple", False)


async def test_rollback_is_refused(client, db, ready, fake_runner):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    fake_runner.results["up"] = RunResult(status="failed", rc=1)
    failed = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                           json={"git_ref": NEWER}))
    await db.execute(update(Deployment).where(Deployment.id == uuid.UUID(failed.json()["id"]))
                     .values(dump_path="/srv/lan9/backups/20261007T120000Z.dump"))
    await db.commit()
    assert _code(await client.post(f"/api/deploy/deployments/{failed.json()['id']}/rollback",
                                   headers=h, json={"confirm_name": "lan9"})) == (
        409, "not_supported_on_bluegreen")


async def test_take_snapshot_runs_on_the_live_slot(client, db, ready, snapshots_dir):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    resp = await client.post(f"{URL}/lan9/snapshots", headers=h, json={"name": "lan9-manual"})
    assert resp.status_code == 201, resp.text
    dep = resp.json()["deployment"]
    assert (dep["bluegreen"], dep["slot"], [s["key"] for s in dep["steps"]]) == (
        True, "orange", ["preflight", "export"])
