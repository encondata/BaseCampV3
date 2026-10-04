import asyncio
from dataclasses import replace

from cryptography.fernet import Fernet
from sqlalchemy import select

from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import AuditLog, Deployment, Environment, Integration
from sirdar_api.deploy import pipeline
from sirdar_api.deploy.runner import RunResult
from sirdar_api.deploy.steps import STEPS_BY_KEY

from .deploy_factories import (  # noqa: F401
    fake_publisher,
    fake_runner,
    make_environment,
    secrets_key,
    stop_pipeline,
)
from .integration_helpers import CF_TOKEN, configure
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import OLD, SHA, UPDATE_KEYS, _load, env  # noqa: F401

PUBLISHED = ["dns", "proxy", "smoke"]


async def _start(db, env, mode="update", **kw):
    dep = await pipeline.create_deployment(db, env, mode=mode, git_ref="main",
                                           sha=kw.pop("sha", SHA), actor_id=None, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def test_a_publishing_update_runs_12_to_14_after_the_host(db, env, fake_runner,
                                                                fake_publisher):
    dep_id = await _start(db, env, publish=True)
    dep, steps, e = await _load(dep_id)
    assert fake_runner.steps() == UPDATE_KEYS
    assert fake_publisher.calls == PUBLISHED
    assert [(s.number, s.key, s.status) for s in steps][-3:] == [
        (12, "dns", "succeeded"), (13, "proxy", "succeeded"), (14, "smoke", "succeeded")]
    assert steps[-1].log == "smoke: ok\n"
    assert (dep.status, dep.publish, e.status, e.current_sha) == ("succeeded", True, "ready",
                                                                  SHA)
    ctx = fake_publisher.contexts[0]
    assert (ctx.env_name, ctx.proxy_ip, ctx.services[0].hostname) == (
        "uat", "10.0.0.2", "api.uat.serversherpa.com")
    assert [s.key for s in pipeline.plan_of(dep)][-3:] == PUBLISHED


async def test_an_update_without_publish_has_no_publish_steps(db, env, fake_runner,
                                                              fake_publisher):
    dep_id = await _start(db, env)
    _, steps, _ = await _load(dep_id)
    assert [s.key for s in steps] == UPDATE_KEYS and fake_publisher.calls == []


async def test_a_publish_job_needs_no_host_and_keeps_the_environment(
        db, deploy_env, secrets_key, fake_runner, fake_publisher):
    deploy_env()                            # no SSH target configured at all
    env = await make_environment(db, current_sha=OLD, status="failed")
    dep = await pipeline.create_deployment(db, env, mode="publish", git_ref="main", sha=OLD,
                                           actor_id=None)
    await db.commit()
    await db.refresh(env)
    assert env.status == "failed"            # a publish job never marks it deploying
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    d, steps, e = await _load(dep.id)
    assert fake_runner.requests == [] and fake_publisher.calls == PUBLISHED
    assert (d.status, e.status, e.current_sha) == ("succeeded", "failed", OLD)
    assert [s.number for s in steps] == [12, 13, 14]


async def test_a_failed_publish_step_stops_with_its_reason(db, env, fake_runner,
                                                           fake_publisher):
    fake_publisher.fail["proxy"] = "Sirdar changed nothing: these proxy hosts are in the way."
    dep_id = await _start(db, env, publish=True)
    dep, steps, e = await _load(dep_id)
    by_key = {s.key: s for s in steps}
    assert (dep.status, dep.failed_step, dep.error) == (
        "failed", 13, "Step 13 (Proxy hosts) failed. See its log.")
    assert by_key["proxy"].log == ("proxy: ok\nSirdar changed nothing: these proxy hosts are "
                                   "in the way.\n")
    assert by_key["smoke"].status == "not_run" and e.status == "failed"


async def test_a_failed_publish_job_leaves_the_environment_status(db, env, fake_runner,
                                                                  fake_publisher):
    fake_publisher.fail["smoke"] = "1 of 6 public URLs didn't answer: portal."
    dep_id = await _start(db, env, mode="publish", sha=OLD)
    dep, _, e = await _load(dep_id)
    assert (dep.status, dep.failed_step, e.status) == ("failed", 14, "ready")


async def test_python_step_timeout_and_crash(db, env, fake_runner, fake_publisher,
                                             monkeypatch):
    monkeypatch.setitem(STEPS_BY_KEY, "dns", replace(STEPS_BY_KEY["dns"], timeout=0.05))
    fake_publisher.gates["dns"] = asyncio.Event()
    dep_id = await _start(db, env, mode="publish", sha=OLD)
    dep, steps, _ = await _load(dep_id)
    assert dep.error.startswith("Step 12 (DNS records) timed out")
    assert steps[0].status == "failed"
    fake_publisher.gates.clear()
    fake_publisher.raises["dns"] = RuntimeError("upstream said SECRET-DETAIL")
    dep_id = await _start(db, env, mode="publish", sha=OLD)
    _, steps, _ = await _load(dep_id)
    assert steps[0].log == "dns: ok\nSirdar couldn't run this step.\n"


async def test_credentials_are_redacted_from_python_step_logs(db, env, fake_runner,
                                                              fake_publisher):
    await configure(db)
    fake_publisher.echo["dns"] = f"token {CF_TOKEN} in a line\n"
    dep_id = await _start(db, env, mode="publish", sha=OLD)
    _, steps, _ = await _load(dep_id)
    assert steps[0].log == "token [redacted] in a line\n"


async def test_unreadable_credentials_fail_the_first_step(db, env, fake_runner,
                                                          fake_publisher):
    db.add(Integration(kind="npm", config={"url": "http://10.10.48.6:81",
                                           "identity": "a@b.co", "letsencrypt_email": "a@b.co"},
                       secret_enc=Fernet(Fernet.generate_key()).encrypt(b"x")))
    await db.commit()
    dep_id = await _start(db, env, mode="publish", sha=OLD)
    dep, steps, _ = await _load(dep_id)
    reason = ("The stored credentials don't open with the current SIRDAR_SECRETS_KEY. Enter "
              "them again in Settings.")
    assert (dep.status, dep.failed_step, dep.error) == ("failed", 12, reason)
    assert steps[0].log == reason + "\n" and fake_publisher.calls == []


async def test_a_retry_of_publish_steps_runs_without_the_host(db, env, fake_runner,
                                                              fake_publisher):
    fake_publisher.fail["proxy"] = "busy"
    first = await _start(db, env, publish=True)
    fake_publisher.fail.clear()
    host_calls = len(fake_runner.requests)
    retry = await _start(db, env, publish=True, start_step=13, retry_of=first)
    dep, steps, e = await _load(retry)
    assert len(fake_runner.requests) == host_calls          # no SSH step ran again
    assert fake_publisher.calls[-2:] == ["proxy", "smoke"]
    assert [(s.number, s.status) for s in steps if s.number >= 12] == [
        (12, "skipped"), (13, "succeeded"), (14, "succeeded")]
    assert (dep.status, e.status, e.current_sha) == ("succeeded", "ready", SHA)


async def test_teardown_removes_the_environment(db, env, fake_runner, fake_publisher):
    env_id = env.id
    dep = await pipeline.create_deployment(db, env, mode="teardown", git_ref="main", sha="",
                                           actor_id=None)
    await db.commit()
    await db.refresh(env)
    assert env.status == "deleting"
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    assert fake_runner.steps() == ["teardown"]
    extravars = fake_runner.requests[0].extravars
    assert extravars["env_dir"] == "/opt/serversherpa/uat"
    # The playbook's own defaults hold: the pipeline never widens the root or
    # turns become off.
    assert "env_root" not in extravars and "teardown_become" not in extravars
    assert fake_publisher.calls == ["unproxy", "undns"]
    async with get_sessionmaker()() as s:
        assert await s.get(Environment, env_id) is None
        assert await s.get(Deployment, dep.id) is None
        audit = await s.scalar(select(AuditLog).where(
            AuditLog.action == "deploy.environment_delete"))
    assert (audit.entity_id, audit.changes) == ("uat", {"environment": "uat",
                                                        "deployment": str(dep.id)})


async def test_a_failed_teardown_keeps_the_environment(db, env, fake_runner, fake_publisher):
    fake_runner.results["teardown"] = RunResult(status="failed", rc=2)
    dep_id = await _start(db, env, mode="teardown", sha="")
    dep, steps, e = await _load(dep_id)
    assert (dep.status, dep.failed_step, e.status) == ("failed", 15, "failed")
    assert [s.status for s in steps] == ["failed", "not_run", "not_run"]
    assert fake_publisher.calls == []


async def test_recover_orphans_fails_a_deleting_environment(db, env):
    await pipeline.create_deployment(db, env, mode="teardown", git_ref="main", sha="",
                                     actor_id=None)
    await db.commit()
    assert await pipeline.recover_orphans() == 1
    await db.refresh(env)
    assert env.status == "failed"
