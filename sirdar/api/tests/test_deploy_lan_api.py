"""LAN Blue/Green through the API: create, Update to the idle slot,
Activate, refusals, auto-activate, Delete with a snapshot."""

import uuid

import pytest
from sqlalchemy import delete, select, update

from sirdar_api.db.models import (AuditLog, Deployment, Environment, Integration, Snapshot,
                                  VmSlot)
from sirdar_api.deploy import envfile, pipeline, vms
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


@pytest.mark.parametrize("patch, field", [
    ({"services": {"spaces": {"port": 9555}}}, "services.spaces.port"),
    ({"bind_ip": "10.0.0.9"}, "bind_ip"),
    ({"proxy_ip": "10.0.0.3"}, "proxy_ip"),
])
async def test_what_npm_and_the_vms_were_built_for_is_locked(client, db, ready, patch, field):
    h = await auth_headers(client, db)
    assert (await client.post(URL, headers=h, json=NEW)).status_code == 201
    resp = await client.patch(f"{URL}/lan9", headers=h, json=patch)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {"code": "bluegreen_field_locked", "field": field}


async def test_unchanged_locked_fields_and_other_ports_still_patch(client, db, ready):
    h = await auth_headers(client, db)
    out = (await client.post(URL, headers=h, json=NEW)).json()
    spaces = next(s["port"] for s in out["services"] if s["service"] == "spaces")
    resp = await client.patch(f"{URL}/lan9", headers=h, json={
        "bind_ip": "0.0.0.0", "proxy_ip": "10.0.0.2",
        "services": {"spaces": {"port": spaces}, "mailpit": {"port": 9556}}})
    assert resp.status_code == 200, resp.text


async def test_bluegreen_binds_everywhere(client, db, ready):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "bind_ip": "10.0.0.9"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["bind_ip"] == "0.0.0.0"


async def test_a_single_server_vm_keeps_its_fields_editable(client, db, ready):
    h = await auth_headers(client, db)
    single = {**NEW, "name": "solo", "vm": {k: v for k, v in LAN_VM.items()
                                            if k in ("ip_mode", "ip_cidr", "gateway")}}
    assert (await client.post(URL, headers=h, json=single)).status_code == 201
    resp = await client.patch(f"{URL}/solo", headers=h, json={
        "proxy_ip": "10.0.0.3", "services": {"spaces": {"port": 9555}}})
    assert resp.status_code == 200, resp.text
    assert "warnings" not in resp.json()


async def test_publish_off_warns_that_npm_still_needs_certificates(client, db, ready):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json=NEW)
    assert resp.json()["warnings"] == ["bluegreen_npm_certificates"]
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_create"))).one()
    assert audit["warnings"] == ["bluegreen_npm_certificates"]
    on = await client.patch(f"{URL}/lan9", headers=h, json={"publish": True})
    assert on.status_code == 200 and "warnings" not in on.json()
    off = await client.patch(f"{URL}/lan9", headers=h, json={"publish": False})
    assert off.json()["warnings"] == ["bluegreen_npm_certificates"]


async def test_publish_on_has_no_warning(client, db, ready):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "publish": True})
    assert resp.status_code == 201 and "warnings" not in resp.json()


async def test_delete_snapshots_a_slot_that_never_went_live(client, db, ready, snapshots_dir,
                                                            fake_runner, tmp_path):
    # the shared database can hold data (the first admin, say) before anything is live
    from .do_helpers import fetched
    fake_runner.effects["export"] = fetched(tmp_path)
    h = await auth_headers(client, db)
    env = await _deployed(client, db, h)
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(active_slot=None, current_sha=None, image_tag=None))
    await db.commit()
    resp = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                         json={"mode": "teardown", "confirm_name": "lan9"}))
    assert resp.status_code == 201, resp.text
    assert resp.json()["slot"] == "orange"
    assert resp.json()["snapshot"]["name"].startswith("lan9-before-delete-")
    # it ran to the end: the environment (and its deployments) are gone
    assert await db.get(Environment, env.id, populate_existing=True) is None
    export = next(r for r in fake_runner.requests if r.step == "export")
    assert export.extravars["api_image"] == f"serversherpa-api:{envfile.image_tag(SHA)}"
    snap = await db.scalar(select(Snapshot).where(Snapshot.name == resp.json()["snapshot"]["name"])
                           .execution_options(populate_existing=True))
    assert snap.status == "ready"


async def test_delete_of_a_never_deployed_environment_takes_no_snapshot(client, db, ready,
                                                                       snapshots_dir):
    h = await auth_headers(client, db)
    assert (await client.post(URL, headers=h, json=NEW)).status_code == 201
    resp = await client.post(f"{URL}/lan9/deployments", headers=h,
                             json={"mode": "teardown", "confirm_name": "lan9"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["snapshot"] is None
    assert [s["key"] for s in resp.json()["steps"]] == ["destroy", "unproxy", "undns"]


# ---- an unresolved switch (lan_slots.unresolved_switch) ---------------------------

PUT_BACK = ("2 of 5 public URLs didn't answer. Sirdar couldn't put 2 of 5 proxy hosts "
            "back; check them in Nginx Proxy Manager.")


async def _stuck_activate(client, db, h, fake_publisher) -> None:
    """orange live, purple deployed; Activate purple fails without putting NPM back."""
    await _deployed(client, db, h)
    await _wait(await client.post(f"{URL}/lan9/deployments", headers=h, json={"git_ref": NEWER}))
    fake_publisher.fail["lan_switch"] = PUT_BACK
    resp = await _wait(await client.post(f"{URL}/lan9/activate", headers=h,
                                         json={"slot": "purple"}))
    assert resp.status_code == 201, resp.text
    del fake_publisher.fail["lan_switch"]


async def test_an_unresolved_switch_refuses_an_update_with_its_slot(client, db, ready,
                                                                    fake_publisher):
    h = await auth_headers(client, db)
    await _stuck_activate(client, db, h, fake_publisher)
    resp = await client.post(f"{URL}/lan9/deployments", headers=h, json={"git_ref": NEWER})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {"code": "switch_unresolved", "slot": "purple"}
    env = await db.scalar(select(Environment).where(Environment.name == "lan9")
                          .execution_options(populate_existing=True))
    assert env.status != "deploying"


async def test_activating_the_live_slot_resolves_an_unresolved_switch(client, db, ready,
                                                                     fake_publisher):
    h = await auth_headers(client, db)
    await _stuck_activate(client, db, h, fake_publisher)
    resp = await _wait(await client.post(f"{URL}/lan9/activate", headers=h,
                                         json={"slot": "orange"}))
    assert resp.status_code == 201, resp.text
    env = await db.scalar(select(Environment).where(Environment.name == "lan9")
                          .execution_options(populate_existing=True))
    assert (env.active_slot, env.current_sha) == ("orange", SHA)
    # resolved: the live slot is "already active" again, and Updates run
    assert _code(await client.post(f"{URL}/lan9/activate", headers=h,
                                   json={"slot": "orange"})) == (409, "slot_already_active")
    assert (await client.post(f"{URL}/lan9/deployments", headers=h,
                              json={"git_ref": NEWER})).status_code == 201


async def test_an_update_stuck_in_its_switch_retries_from_step_14(client, db, ready,
                                                                  fake_publisher, fake_runner):
    h = await auth_headers(client, db)
    await _deployed(client, db, h)
    assert (await client.patch(f"{URL}/lan9", headers=h,
                               json={"auto_activate": True})).status_code == 200
    fake_publisher.fail["lan_switch"] = PUT_BACK
    failed = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                           json={"git_ref": NEWER}))
    assert (failed.json()["slot"], failed.json()["go_live"]) == ("purple", True)
    del fake_publisher.fail["lan_switch"]
    fake_runner.requests.clear()
    resp = await _wait(await client.post(f"/api/deploy/deployments/{failed.json()['id']}/retry",
                                         headers=h, json={}))
    assert resp.status_code == 201, resp.text
    assert resp.json()["start_step"] == 14
    assert [s["key"] for s in resp.json()["steps"] if s["status"] != "skipped"] == ["lan_switch"]
    assert fake_runner.steps() == []
    env = await db.scalar(select(Environment).where(Environment.name == "lan9")
                          .execution_options(populate_existing=True))
    assert (env.active_slot, env.current_sha) == ("purple", NEWER)
