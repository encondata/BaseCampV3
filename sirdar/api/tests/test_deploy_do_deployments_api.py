"""Starting DigitalOcean deployments through the API: Update targets the
idle slot and goes live only when the rules say so; Reset, Restore backup
and Roll back aren't offered; Delete takes a snapshot first and keeps
production's rules. The pipeline runs with fakes."""

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, Deployment, DoAccount, DoSlot, Environment, Snapshot
from sirdar_api.deploy import pipeline, vms
from sirdar_api.deploy.runner import RunResult

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
from .do_helpers import make_do_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA
from .test_deploy_pipeline_do import _built, _fetched

URL = "/api/deploy/environments"


@pytest.fixture
async def ready(db, deploy_env, secrets_key, snapshots_dir, ssh_server, monkeypatch,
                fake_runner, fake_publisher, fake_provisioner):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await trust_fake(db, ssh_server)

    async def make(**kw) -> Environment:
        return await make_do_environment(db, **kw)
    return make


async def _deployed(db, env: Environment, active: str | None = "orange") -> None:
    """As if a first deploy went live on `active`."""
    await db.execute(update(Environment).where(Environment.id == env.id).values(
        active_slot=active, current_sha=SHA, image_tag=SHA[:8], status="ready"))
    for i, slot in enumerate(env.slots):
        await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                              DoSlot.slot == slot)
                         .values(droplet_id=str(4001 + i), public_ip="127.0.0.1", sha=SHA))
    await db.commit()


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


async def test_update_targets_the_idle_slot(client, db, ready):
    env = await ready()
    h = await auth_headers(client, db)
    first = await _start(client, h, "uat9", mode="update")
    assert first.status_code == 201, first.text
    assert (first.json()["cloud"], first.json()["slot"], first.json()["go_live"]) == (
        True, "orange", True)
    await _deployed(db, env)
    second = (await _start(client, h, "uat9", mode="update")).json()
    assert (second["slot"], second["go_live"]) == ("purple", False)
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.deployment_start").order_by(AuditLog.id))).all()
    assert (audit[-1]["slot"], audit[-1]["go_live"]) == ("purple", False)


async def test_a_one_slot_environment_always_goes_live(client, db, ready):
    env = await ready(slots=1)
    await _deployed(db, env)
    h = await auth_headers(client, db)
    body = (await _start(client, h, "uat9", mode="update")).json()
    assert (body["slot"], body["go_live"]) == ("orange", True)


async def test_an_update_never_publishes(client, db, ready):
    """DigitalOcean plans refuse publish=True: DNS is part of the Update plan."""
    env = await ready()
    await db.execute(update(Environment).where(Environment.id == env.id).values(publish=True))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="update")
    assert resp.status_code == 201, resp.text
    assert resp.json()["publish"] is False


async def test_modes_that_would_touch_the_live_slot_are_refused(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    for body in ({"mode": "reset", "confirm_name": "uat9"},
                 {"mode": "restore_dump", "confirm_name": "uat9",
                  "backup": "20261001T010203Z.dump"}):
        resp = await _start(client, h, "uat9", **body)
        assert (resp.status_code, resp.json()["detail"]["code"]) == (
            409, "not_supported_on_digitalocean")
    dep = Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                     status="failed", previous_sha=SHA, dump_path="/x/backups/a.dump",
                     cloud=True, slot="purple")
    db.add(dep)
    await db.commit()
    resp = await client.post(f"/api/deploy/deployments/{dep.id}/rollback", headers=h,
                             json={"confirm_name": "uat9"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (
        409, "not_supported_on_digitalocean")


async def test_the_pipeline_refusing_a_mode_answers_409(client, db, ready, monkeypatch):
    """pipeline.NotSupportedOnDigitalOcean, from wherever it comes, is a 409
    carrying its code (never a 500)."""
    await ready()
    h = await auth_headers(client, db)

    async def refuse(*a, **kw):
        raise pipeline.NotSupportedOnDigitalOcean(kw["mode"])
    monkeypatch.setattr(pipeline, "create_deployment", refuse)
    resp = await _start(client, h, "uat9", mode="update")
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "not_supported_on_digitalocean"})


async def test_snapshot_fields_belong_to_a_digitalocean_delete(client, db, ready):
    await ready()
    h = await auth_headers(client, db)
    for body in ({"mode": "update", "snapshot": False},
                 {"mode": "update", "confirm_production": "delete production uat9"}):
        resp = await _start(client, h, "uat9", **body)
        assert (resp.status_code, resp.json()["detail"]["code"]) == (
            422, "snapshot_not_allowed")


async def test_an_account_without_a_token(client, db, ready):
    await ready()
    await db.execute(update(DoAccount).where(DoAccount.key == "development")
                     .values(token_enc=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="update")
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "do_account_not_configured", "account": "development"})


async def test_delete_takes_a_snapshot_first(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert [s["key"] for s in body["steps"]] == ["export", "undns", "do_destroy"]
    assert body["snapshot"]["name"].startswith("uat9-before-delete-")
    assert body["slot"] == "orange"


async def test_delete_without_a_snapshot(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    body = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9",
                         snapshot=False)).json()
    assert [s["key"] for s in body["steps"]] == ["undns", "do_destroy"]
    assert (await db.scalars(select(Snapshot))).all() == []


async def test_delete_a_never_deployed_environment(client, db, ready):
    await ready()
    h = await auth_headers(client, db)
    body = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")).json()
    assert [s["key"] for s in body["steps"]] == ["undns", "do_destroy"]


async def test_production_delete_rules(client, db, ready):
    env = await ready(name="prod", type_="production", account="production")
    await _deployed(db, env, active="blue")
    h = await auth_headers(client, db)
    base = {"mode": "teardown", "confirm_name": "prod",
            "confirm_production": "delete production prod"}
    resp = await _start(client, h, "prod", **base)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "production_not_retiring")
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(retiring=True))
    await db.commit()
    resp = await _start(client, h, "prod", **base)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "production_slot_active")
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(active_slot=None))
    await db.commit()
    resp = await _start(client, h, "prod", **{**base, "confirm_production": "yes"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (
        422, "confirm_production_mismatch")
    resp = await _start(client, h, "prod", **{k: v for k, v in base.items()
                                               if k != "confirm_production"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (
        422, "confirm_production_mismatch")
    resp = await _start(client, h, "prod", **{**base, "snapshot": False})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "snapshot_required")
    resp = await _start(client, h, "prod", **base)
    assert resp.status_code == 201, resp.text
    assert resp.json()["steps"][0]["key"] == "export"
    # No slot is active: the snapshot comes from the first slot that runs a commit.
    assert resp.json()["slot"] == "blue"


async def test_a_retry_keeps_the_slot_and_whether_it_goes_live(client, db, ready, fake_runner,
                                                              monkeypatch):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    fake_runner.results["up"] = RunResult(status="failed", rc=2)
    failed = (await _start(client, h, "uat9", mode="update")).json()
    assert (failed["slot"], failed["go_live"]) == ("purple", False)
    assert (await db.get(Deployment, failed["id"], populate_existing=True)).status == "failed"
    del fake_runner.results["up"]
    seen: list = []
    real = vms.host_config

    async def spy(db_, settings, env_, *, slot=None):
        seen.append(slot)
        return await real(db_, settings, env_, slot=slot)
    monkeypatch.setattr(vms, "host_config", spy)
    resp = await _retry(client, h, failed["id"])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["cloud"], body["slot"], body["go_live"], body["publish"]) == (
        True, "purple", False, False)
    assert seen and set(seen) == {"purple"}     # the idle slot, never the live one


async def test_a_delete_retried_before_the_snapshot_takes_a_new_one(client, db, ready,
                                                                    fake_runner):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    fake_runner.results["export"] = RunResult(status="failed", rc=2)
    failed = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")).json()
    assert failed["slot"] == "orange"
    first_snap = failed["snapshot"]["id"]
    del fake_runner.results["export"]
    resp = await client.post(f"/api/deploy/deployments/{failed['id']}/retry", headers=h,
                             json={"confirm_name": "uat9"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    await pipeline.wait(uuid.UUID(body["id"]))
    assert (body["cloud"], body["slot"]) == (True, "orange")
    assert [s["key"] for s in body["steps"]] == ["export", "undns", "do_destroy"]
    assert body["snapshot"]["id"] != first_snap
    assert body["snapshot"]["name"].startswith("uat9-before-delete-")
    old = await db.scalar(select(Snapshot.status).where(Snapshot.id == first_snap)
                          .execution_options(populate_existing=True))
    assert old == "failed"


async def test_a_delete_retried_after_the_snapshot_keeps_it(client, db, ready, fake_runner,
                                                           fake_provisioner, tmp_path):
    env = await ready()
    await _built(SimpleNamespace(env_id=env.id, env_name=env.name, slots=list(env.slots)))
    await _deployed(db, env)
    fake_runner.effects["export"] = _fetched(tmp_path)
    h = await auth_headers(client, db)
    fake_provisioner.fail["do_destroy"] = "DigitalOcean said no."
    failed = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")).json()
    dep = await db.get(Deployment, failed["id"], populate_existing=True)
    assert (dep.status, dep.failed_step) == ("failed", 18), failed
    snap = await db.get(Snapshot, dep.snapshot_id, populate_existing=True)
    assert snap.status == "ready"
    del fake_provisioner.fail["do_destroy"]
    resp = await client.post(f"/api/deploy/deployments/{dep.id}/retry", headers=h,
                             json={"confirm_name": "uat9"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    await pipeline.wait(uuid.UUID(body["id"]))
    assert [(s["key"], s["status"]) for s in body["steps"]][0] == ("export", "skipped")
    assert body["snapshot"]["id"] == str(snap.id)
    assert (await db.scalars(select(Snapshot))).all() == [snap]


async def test_take_snapshot_reads_the_live_slot(client, db, ready):
    env = await ready()
    await _deployed(db, env, active="purple")
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/uat9/snapshots", headers=h, json={"name": "uat9-manual"})
    assert resp.status_code == 201, resp.text
    dep = resp.json()["deployment"]
    await pipeline.wait(uuid.UUID(dep["id"]))
    assert (dep["cloud"], dep["slot"], dep["go_live"]) == (True, "purple", False)
    assert [s["key"] for s in dep["steps"]] == ["preflight", "export"]


async def test_backups_before_any_droplet(client, db, ready):
    """A built target with no droplet yet has nothing to list (not 400)."""
    await ready()
    h = await auth_headers(client, db)
    resp = await client.get(f"{URL}/uat9/backups", headers=h)
    assert (resp.status_code, resp.json()) == (200, {"backups": []})
