"""An A/B environment's first deploy: once side A goes live and the other
side has never had a release, Sirdar starts a separate Update of the other
side with the same commit, which stays idle. The pipeline runs with fakes."""

import logging
import uuid

from sqlalchemy import func, select, update

from sirdar_api.db.models import AuditLog, Deployment, DeploymentStep, DoSlot, Environment, VmSlot
from sirdar_api.deploy import pipeline
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
)
from .do_helpers import deployed
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_do_deployments_api import _retry, _start
from .test_deploy_do_deployments_api import ready as do_ready  # noqa: F401
from .test_deploy_lan_api import NEW, URL, _wait
from .test_deploy_lan_api import ready as lan_ready  # noqa: F401
from .test_deploy_pipeline import SHA

NOTE = ("Sirdar started this deploy after orange went live: the first deploy puts the same "
        "commit on both sides.\n")


async def _deployments(db, env_id) -> list[Deployment]:
    return list(await db.scalars(select(Deployment).where(Deployment.environment_id == env_id)
                                 .order_by(Deployment.created_at)
                                 .execution_options(populate_existing=True)))


async def _count(db, env_id) -> int:
    return await db.scalar(select(func.count()).select_from(Deployment)
                           .where(Deployment.environment_id == env_id))


async def _env(db, env_id) -> Environment:
    return await db.get(Environment, env_id, populate_existing=True)


async def _first_log(db, dep_id) -> str:
    return await db.scalar(select(DeploymentStep.log).where(
        DeploymentStep.deployment_id == dep_id, DeploymentStep.status != "skipped")
        .order_by(DeploymentStep.number).limit(1)
        .execution_options(populate_existing=True))


async def _both_sides(db, a: Deployment, b: Deployment, live: str = "orange",
                     other: str = "purple") -> None:
    assert (a.slot, a.go_live, a.status) == (live, True, "succeeded")
    assert (b.slot, b.go_live, b.status) == (other, False, "succeeded")
    # The commit itself is B's ref: a branch that moved meanwhile can't give
    # B a newer commit than A (DigitalOcean's step 0 resolves the ref again).
    assert (b.mode, b.sha, b.git_ref) == ("update", a.sha, a.sha)
    assert (b.first_admin, b.seed_content, b.snapshot_id) == (False, False, None)
    assert b.actor_id == a.actor_id
    assert (b.cloud, b.bluegreen, b.publish, b.vm) == (a.cloud, a.bluegreen, a.publish, a.vm)
    assert (await _first_log(db, b.id)).startswith(NOTE.replace("orange", live))
    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "deploy.deployment_start",
        AuditLog.entity_id == str(b.id)))).one()
    assert audit.changes["follows"] == str(a.id)
    assert audit.changes["go_live"] is False and audit.changes["slot"] == other
    assert audit.changes["git_ref"] == a.sha
    assert audit.actor_id == a.actor_id and audit.ip is None


# ---- DigitalOcean --------------------------------------------------------------------

async def test_a_first_do_deploy_then_deploys_the_other_side(client, db, do_ready):
    env = await do_ready()
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="update")
    assert resp.status_code == 201, resp.text
    deps = await _deployments(db, env.id)
    assert len(deps) == 2
    a, b = deps
    assert a.id == uuid.UUID(resp.json()["id"]) and a.sha == SHA
    await _both_sides(db, a, b)
    assert (await _env(db, env.id)).active_slot == "orange"
    purple = await db.get(DoSlot, (env.id, "purple"), populate_existing=True)
    assert purple.sha == SHA


async def test_a_first_production_deploy_fills_green_and_leaves_it_idle(client, db,
                                                                       do_ready):
    env = await do_ready(name="prod", type_="production", account="production")
    h = await auth_headers(client, db)
    resp = await _start(client, h, "prod", mode="update")
    assert resp.status_code == 201, resp.text
    a, b = await _deployments(db, env.id)
    await _both_sides(db, a, b, live="blue", other="green")
    assert (await _env(db, env.id)).active_slot == "blue"


async def test_the_second_side_starts_nothing(client, db, do_ready):
    env = await do_ready()
    h = await auth_headers(client, db)
    await _start(client, h, "uat9", mode="update")
    assert await _count(db, env.id) == 2
    # Both sides are released now: an Update is one deployment again.
    resp = await _start(client, h, "uat9", mode="update")
    assert resp.status_code == 201, resp.text
    assert resp.json()["slot"] == "purple"
    assert await _count(db, env.id) == 3
    assert (await db.get(Deployment, uuid.UUID(resp.json()["id"]),
                         populate_existing=True)).status == "succeeded"


async def test_auto_activate_still_leaves_the_other_side_idle(client, db, do_ready):
    env = await do_ready()
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(auto_activate=True))
    await db.commit()
    h = await auth_headers(client, db)
    await _start(client, h, "uat9", mode="update")
    _, b = await _deployments(db, env.id)
    assert (b.slot, b.go_live, b.status) == ("purple", False, "succeeded")
    assert (await _env(db, env.id)).active_slot == "orange"


async def test_a_failed_first_deploy_starts_nothing_until_its_retry_succeeds(
        client, db, do_ready, fake_runner):
    env = await do_ready()
    h = await auth_headers(client, db)
    fake_runner.results["up"] = RunResult(status="failed", rc=2)
    failed = await _start(client, h, "uat9", mode="update")
    assert failed.status_code == 201, failed.text
    deps = await _deployments(db, env.id)
    assert [d.status for d in deps] == ["failed"]
    del fake_runner.results["up"]
    resp = await _retry(client, h, failed.json()["id"])
    assert resp.status_code == 201, resp.text
    deps = await _deployments(db, env.id)
    assert len(deps) == 3
    _, retry, b = deps
    assert retry.retry_of == deps[0].id
    await _both_sides(db, retry, b)


async def test_a_one_slot_environment_starts_nothing(client, db, do_ready):
    env = await do_ready(slots=1)
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="update")
    assert resp.status_code == 201, resp.text
    assert [d.status for d in await _deployments(db, env.id)] == ["succeeded"]


async def test_an_activate_starts_nothing(client, db, do_ready):
    """Orange is live but has no release recorded: only the mode stops a
    follow-up of orange here."""
    env = await do_ready()
    await deployed(db, env, "orange", sha=SHA)
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "orange")
                     .values(sha=None, image_tag=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/environments/uat9/activate", headers=h,
                             json={"slot": "purple"})
    assert resp.status_code == 201, resp.text
    await pipeline.wait(uuid.UUID(resp.json()["id"]))
    deps = await _deployments(db, env.id)
    assert [(d.mode, d.status) for d in deps] == [("activate", "succeeded")]


async def test_a_busy_environment_skips_the_other_side(client, db, do_ready, monkeypatch,
                                                       caplog):
    env = await do_ready()
    real = pipeline.create_deployment

    async def busy(db_, env_, **kw):
        if kw.get("go_live") is False:
            raise pipeline.DeployInProgress()
        return await real(db_, env_, **kw)
    monkeypatch.setattr(pipeline, "create_deployment", busy)
    h = await auth_headers(client, db)
    with caplog.at_level(logging.WARNING, logger=pipeline.log.name):
        resp = await _start(client, h, "uat9", mode="update")
    assert resp.status_code == 201, resp.text
    deps = await _deployments(db, env.id)
    assert [(d.slot, d.status) for d in deps] == [("orange", "succeeded")]
    assert any("didn't start the purple side: DeployInProgress" in r.getMessage()
               for r in caplog.records)
    assert (await _env(db, env.id)).active_slot == "orange"


async def test_an_empty_sha_starts_nothing(client, db, do_ready, monkeypatch, caplog):
    """The route can't finish a deploy without a commit (the host steps
    refuse to run), so this calls the trigger on a succeeded row directly."""
    env = await do_ready()
    real = pipeline._start_other_side

    async def nothing(deployment_id):
        return None
    monkeypatch.setattr(pipeline, "_start_other_side", nothing)
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="update")
    assert resp.status_code == 201, resp.text
    a_id = uuid.UUID(resp.json()["id"])
    await db.execute(update(Deployment).where(Deployment.id == a_id).values(sha=""))
    await db.commit()
    with caplog.at_level(logging.WARNING, logger=pipeline.log.name):
        assert await real(a_id) is None
    assert await _count(db, env.id) == 1
    assert any("didn't start the purple side" in r.getMessage() for r in caplog.records)


# ---- LAN Blue/Green ------------------------------------------------------------------

async def test_a_first_lan_deploy_then_deploys_the_other_side(client, db, lan_ready):
    h = await auth_headers(client, db)
    assert (await client.post(URL, headers=h, json=NEW)).status_code == 201
    resp = await _wait(await client.post(f"{URL}/lan9/deployments", headers=h,
                                         json={"git_ref": SHA}))
    assert resp.status_code == 201, resp.text
    env = await db.scalar(select(Environment).where(Environment.name == "lan9")
                          .execution_options(populate_existing=True))
    deps = await _deployments(db, env.id)
    assert len(deps) == 2
    a, b = deps
    assert a.bluegreen and a.sha == SHA
    await _both_sides(db, a, b)
    assert env.active_slot == "orange"
    purple = await db.get(VmSlot, (env.id, "purple"), populate_existing=True)
    assert purple.sha == SHA
