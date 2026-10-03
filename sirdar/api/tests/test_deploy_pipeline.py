import asyncio
import base64
import json
import uuid

import pytest
from sqlalchemy import select, update

from sirdar_api.api.app import create_app
from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Deployment, DeploymentStep, Environment
from sirdar_api.deploy import envfile, pipeline
from sirdar_api.deploy.runner import CANCEL_GRACE_SECONDS, RunResult
from sirdar_api.deploy.steps import STEPS_BY_KEY

from .deploy_factories import (  # noqa: F401
    ENV_SECRETS,
    fake_runner,
    make_environment,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .ssh_server import SSH_PASSWORD, ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401

SHA = "e73b99ca" + "0" * 32
OLD = "a" * 40
UPDATE_KEYS = ["preflight", "bootstrap", "fetch", "render", "build", "dump", "up"]


@pytest.fixture
async def env(db, deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    return await make_environment(db, current_sha=OLD)


async def _create(db, env, mode="update", **kw) -> Deployment:
    dep = await pipeline.create_deployment(db, env, mode=mode, git_ref="main", sha=SHA,
                                           actor_id=None, **kw)
    await db.commit()
    return dep


async def _start(db, env, mode="update", **kw):
    dep = await _create(db, env, mode, **kw)
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


async def _load(dep_id):
    async with get_sessionmaker()() as s:
        dep = await s.get(Deployment, dep_id)
        steps = list(await s.scalars(select(DeploymentStep)
                                     .where(DeploymentStep.deployment_id == dep_id)
                                     .order_by(DeploymentStep.number)))
        env = await s.get(Environment, dep.environment_id)
        return dep, steps, env


async def test_update_runs_every_step_in_order(db, env, fake_runner):
    fake_runner.results["dump"] = RunResult(
        status="successful", rc=0, data={"dump_path": "/opt/serversherpa/uat/backups/x.dump"})
    dep_id = await _start(db, env)
    dep, steps, e = await _load(dep_id)
    assert fake_runner.steps() == UPDATE_KEYS
    assert [(s.number, s.status) for s in steps] == [
        (1, "succeeded"), (2, "succeeded"), (3, "succeeded"), (4, "succeeded"),
        (5, "succeeded"), (6, "succeeded"), (8, "succeeded")]
    assert all(s.started_at and s.finished_at for s in steps)
    assert steps[0].log == "ok: [target] preflight\n"
    assert (dep.status, dep.dump_path, dep.previous_sha, dep.error) == (
        "succeeded", "/opt/serversherpa/uat/backups/x.dump", OLD, None)
    assert dep.finished_at is not None
    assert (e.status, e.current_sha, e.image_tag) == ("ready", SHA, "e73b99ca")


async def test_requests_carry_the_pinned_target_and_step_vars(db, env, fake_runner,
                                                              ssh_server):
    await _start(db, env)
    target = fake_runner.requests[0].target
    assert (target.host, target.port, target.user) == ("127.0.0.1", ssh_server.port, "deployer")
    assert target.known_hosts_line.startswith(f"[127.0.0.1]:{ssh_server.port} ssh-ed25519 ")
    assert target.host_key_algorithms == "ssh-ed25519"
    assert (target.password, target.become_password, target.private_key) == (
        SSH_PASSWORD, SSH_PASSWORD, None)
    common = {"env_name": "uat", "env_dir": "/opt/serversherpa/uat",
              "repo_url": "https://github.com/encondata/BaseCampV3.git", "sha": SHA,
              "ss_stack": "/opt/serversherpa/uat/repo/deploy/stack/ss-stack",
              "min_disk_gb": 10, "min_memory_mb": 1800}
    for request in fake_runner.requests:
        assert request.playbook == STEPS_BY_KEY[request.step].playbook
        assert request.timeout == STEPS_BY_KEY[request.step].timeout
        if request.step == "dump":
            assert request.extravars == {**common, "dump_required": True}
        elif request.step == "render":
            assert set(request.extravars) == {*common, "env_file_b64"}
            values = envfile.parse_env(
                base64.b64decode(request.extravars["env_file_b64"]).decode())
            assert values["STACK_IMAGE_TAG"] == "e73b99ca"
            assert values["POSTGRES_PASSWORD"] == ENV_SECRETS["POSTGRES_PASSWORD"]
            assert values["STACK_PROXY_IP"] == "10.0.0.2"
        else:
            assert request.extravars == common


@pytest.mark.parametrize("current_sha, required", [(None, False), (OLD, True)])
async def test_dump_is_required_once_the_environment_has_deployed(
        db, deploy_env, ssh_server, secrets_key, fake_runner, current_sha, required):
    """A first deploy has no database to back up; an established environment
    must not migrate without a pre-deploy dump."""
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    env = await make_environment(db, current_sha=current_sha)
    await _start(db, env)
    dump = next(r for r in fake_runner.requests if r.step == "dump")
    assert dump.extravars["dump_required"] is required
    others = [r for r in fake_runner.requests if r.step != "dump"]
    assert others and all("dump_required" not in r.extravars for r in others)


async def test_reset_plan(db, env, fake_runner):
    await _start(db, env, mode="reset")
    assert fake_runner.steps() == ["preflight", "bootstrap", "fetch", "render", "build",
                                   "reset", "up"]


async def test_first_failure_stops_the_deployment(db, env, fake_runner):
    fake_runner.results["build"] = RunResult(status="failed", rc=2)
    dep_id = await _start(db, env)
    dep, steps, e = await _load(dep_id)
    assert fake_runner.steps() == ["preflight", "bootstrap", "fetch", "render", "build"]
    by_key = {s.key: s.status for s in steps}
    assert by_key == {"preflight": "succeeded", "bootstrap": "succeeded",
                      "fetch": "succeeded", "render": "succeeded", "build": "failed",
                      "dump": "not_run", "up": "not_run"}
    assert (dep.status, dep.failed_step) == ("failed", 5)
    assert dep.error == "Step 5 (Build images) failed. See its log."
    assert (e.status, e.current_sha) == ("failed", OLD)


async def test_a_failed_first_step_gets_its_own_message(db, env, fake_runner):
    """The failure message is built before the rollback (which can expire the
    step row): a failed step 1 used to crash with MissingGreenlet."""
    fake_runner.results["preflight"] = RunResult(status="failed", rc=2)
    dep, steps, _ = await _load(await _start(db, env))
    assert (steps[0].status, dep.failed_step) == ("failed", 1)
    assert dep.error == "Step 1 (Preflight) failed. See its log."


async def test_timeout_message(db, env, fake_runner):
    fake_runner.results["up"] = RunResult(status="timeout", rc=254)
    dep, _, _ = await _load(await _start(db, env))
    assert dep.error == "Step 8 (Start services) timed out after 45 minutes."


async def test_logs_are_redacted(db, env, fake_runner):
    fake_runner.output["preflight"] = [f"pw {SSH_PASSWORD}\n",
                                       f"pg {ENV_SECRETS['POSTGRES_PASSWORD']}\n"]
    _, steps, _ = await _load(await _start(db, env))
    assert steps[0].log == "pw [redacted]\npg [redacted]\n"


async def test_logs_redact_json_escaped_secrets(db, deploy_env, ssh_server, secrets_key,
                                               fake_runner):
    """Ansible prints values JSON-encoded (a quote becomes \\", a newline \\n):
    the escaped form of every secret is redacted too."""
    ssh_pw = "ssh-SECRET\nsecond-line"
    _ssh_env(deploy_env, ssh_server, ssh_password=ssh_pw)
    await trust_fake(db, ssh_server)
    pg = 'pg-"quoted"\\SECRET'
    pepper = 'café-"pepper"-SECRET'
    env = await make_environment(db, secrets={**ENV_SECRETS, "POSTGRES_PASSWORD": pg,
                                              "SS_PASSWORD_PEPPER": pepper})
    escaped_pg, escaped_ssh = json.dumps(pg)[1:-1], json.dumps(ssh_pw)[1:-1]
    assert (escaped_pg, escaped_ssh) != (pg, ssh_pw)
    pepper_ascii = json.dumps(pepper)[1:-1]                      # caf\u00e9-\"pepper\"...
    pepper_utf8 = json.dumps(pepper, ensure_ascii=False)[1:-1]   # café-\"pepper\"...
    assert len({pepper, pepper_ascii, pepper_utf8}) == 3
    fake_runner.output["preflight"] = [f"pg {escaped_pg}\n", f"pw {escaped_ssh}\n",
                                       f"raw {pg}\n", f"a {pepper_ascii}\n",
                                       f"u {pepper_utf8}\n"]
    _, steps, _ = await _load(await _start(db, env))
    assert steps[0].log == ("pg [redacted]\npw [redacted]\nraw [redacted]\n"
                            "a [redacted]\nu [redacted]\n")


async def test_a_failed_log_flush_does_not_fail_the_step(db, env, fake_runner, monkeypatch):
    monkeypatch.setattr(pipeline, "FLUSH_SECONDS", 0.05)
    real_save = pipeline._save_log
    raised = asyncio.Event()

    async def flaky_save(step_id, text):
        if text == "building api\n" and not raised.is_set():
            raised.set()
            raise RuntimeError("database hiccup")
        await real_save(step_id, text)

    monkeypatch.setattr(pipeline, "_save_log", flaky_save)
    fake_runner.gates["build"] = asyncio.Event()
    fake_runner.output["build"] = ["building api\n"]
    dep = await _create(db, env)
    pipeline.launch(dep.id)
    await asyncio.wait_for(raised.wait(), 5)       # the flusher hit the error mid-step
    fake_runner.gates["build"].set()
    await pipeline.wait(dep.id)
    d, steps, e = await _load(dep.id)
    assert (d.status, steps[4].status, steps[4].log) == ("succeeded", "succeeded",
                                                         "building api\n")
    assert e.status == "ready"


async def test_logs_keep_only_the_tail(db, env, fake_runner, monkeypatch):
    monkeypatch.setattr(pipeline, "LOG_LIMIT", 10)
    fake_runner.output["preflight"] = ["0123456789", "abcdef\n"]
    _, steps, _ = await _load(await _start(db, env))
    assert steps[0].log == "789abcdef\n"          # the last 10 characters


async def test_logs_flush_while_a_step_runs(db, env, fake_runner, monkeypatch):
    monkeypatch.setattr(pipeline, "FLUSH_SECONDS", 0.05)
    fake_runner.gates["build"] = asyncio.Event()
    fake_runner.output["build"] = ["building api\n"]
    dep = await _create(db, env)
    pipeline.launch(dep.id)
    await asyncio.wait_for(fake_runner.started["build"].wait(), 5)
    for _ in range(100):
        _, steps, _ = await _load(dep.id)
        if steps[4].log:
            break
        await asyncio.sleep(0.05)
    assert (steps[4].log, steps[4].status) == ("building api\n", "running")
    assert pipeline.is_active(dep.id)
    fake_runner.gates["build"].set()
    await pipeline.wait(dep.id)
    assert not pipeline.is_active(dep.id)


async def test_one_running_deployment_per_environment(db, env, fake_runner):
    fake_runner.gates["preflight"] = asyncio.Event()
    first_id = (await _create(db, env)).id     # the refused insert rolls back a savepoint
    pipeline.launch(first_id)
    with pytest.raises(pipeline.DeployInProgress):
        await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                         actor_id=None)
    assert env.name == "uat"                    # the caller's objects are still loaded
    fake_runner.gates["preflight"].set()
    await pipeline.wait(first_id)


async def test_cancel(db, env, fake_runner):
    fake_runner.gates["build"] = asyncio.Event()
    dep = await _create(db, env)
    pipeline.launch(dep.id)
    await asyncio.wait_for(fake_runner.started["build"].wait(), 5)
    assert pipeline.request_cancel(dep.id) is True
    await pipeline.wait(dep.id)
    d, steps, e = await _load(dep.id)
    assert (d.status, d.error) == ("cancelled", pipeline.CANCELLED)
    by_key = {s.key: s.status for s in steps}
    assert (by_key["render"], by_key["build"], by_key["dump"], by_key["up"]) == (
        "succeeded", "cancelled", "not_run", "not_run")
    assert steps[4].log == "ok: [target] build\n"
    assert (e.status, e.current_sha) == ("failed", OLD)
    assert pipeline.request_cancel(dep.id) is False


async def test_shutdown_interrupts(db, env, fake_runner):
    fake_runner.gates["fetch"] = asyncio.Event()
    dep = await _create(db, env)
    pipeline.launch(dep.id)
    await asyncio.wait_for(fake_runner.started["fetch"].wait(), 5)
    await pipeline.shutdown()
    d, steps, _ = await _load(dep.id)
    assert (d.status, d.error) == ("interrupted", pipeline.INTERRUPTED)
    assert [s.status for s in steps] == ["succeeded", "succeeded", "interrupted", "not_run",
                                         "not_run", "not_run", "not_run"]


async def test_recover_orphans(db, env):
    dep = await _create(db, env)
    await db.execute(update(DeploymentStep).where(DeploymentStep.deployment_id == dep.id,
                                                  DeploymentStep.number == 1)
                     .values(status="running"))
    await db.commit()
    assert await pipeline.recover_orphans() == 1
    d, steps, e = await _load(dep.id)
    assert (d.status, d.error) == ("interrupted", pipeline.INTERRUPTED)
    assert d.finished_at is not None
    assert steps[0].status == "interrupted"
    assert {s.status for s in steps[1:]} == {"not_run"}
    assert e.status == "failed"
    assert await pipeline.recover_orphans() == 0


async def test_close_orphan(db, env):
    dep = await _create(db, env)
    await pipeline.close_orphan(dep.id)
    d, steps, _ = await _load(dep.id)
    assert d.status == "cancelled"
    assert {s.status for s in steps} == {"not_run"}


async def test_untrusted_host_fails_step_one_and_runs_nothing(db, deploy_env, ssh_server,
                                                              secrets_key, fake_runner):
    _ssh_env(deploy_env, ssh_server)
    env = await make_environment(db)
    d, steps, e = await _load(await _start(db, env))
    assert fake_runner.requests == []
    assert (d.status, d.failed_step) == ("failed", 1)
    assert steps[0].status == "failed"
    assert "Trust its host key on the Deploy page" in steps[0].log
    assert d.error == steps[0].log.strip()
    assert e.status == "failed"


async def test_missing_target_or_key_fails_step_one(db, env, fake_runner, monkeypatch):
    env.target_id = "ssh:gone"
    await db.commit()
    d, steps, _ = await _load(await _start(db, env))
    assert "isn't configured any more" in steps[0].log

    env.target_id = "ssh"
    await db.commit()
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    d, steps, _ = await _load(await _start(db, env))
    assert d.status == "failed"
    assert "SIRDAR_SECRETS_KEY isn't set" in steps[0].log
    assert fake_runner.requests == []


@pytest.mark.parametrize(("mode", "start_step"), [("update", 0), ("update", 7),
                                                  ("reset", 6), ("reset", 9)])
async def test_start_step_must_be_in_the_plan(db, env, mode, start_step):
    with pytest.raises(ValueError):
        await pipeline.create_deployment(db, env, mode=mode, git_ref="main", sha=SHA,
                                         actor_id=None, start_step=start_step)


async def test_request_cancel_reports_whether_it_cancelled(monkeypatch):
    class Done:
        def cancel(self):
            return False

    dep_id = uuid.uuid4()
    monkeypatch.setitem(pipeline._tasks, dep_id, Done())
    assert pipeline.request_cancel(dep_id) is False


async def test_start_step_skips_earlier_steps(db, env, fake_runner):
    _, steps, _ = await _load(await _start(db, env, start_step=5))
    assert fake_runner.steps() == ["build", "dump", "up"]
    assert [s.status for s in steps] == ["skipped"] * 4 + ["succeeded"] * 3


async def test_runner_crash_is_a_failed_step_with_our_copy(db, env, fake_runner):
    fake_runner.raises["fetch"] = RuntimeError(f"boom {SSH_PASSWORD}")
    d, steps, _ = await _load(await _start(db, env))
    assert steps[2].status == "failed"
    assert steps[2].log == "Sirdar couldn't run this step.\n"
    assert d.error == "Step 3 (Fetch code) failed. See its log."


async def test_unwritable_runner_dir_gets_actionable_copy(db, env, fake_runner):
    from sirdar_api.deploy.runner import RunnerDirUnwritable

    fake_runner.raises["preflight"] = RunnerDirUnwritable()
    d, steps, _ = await _load(await _start(db, env))
    assert steps[0].status == "failed"
    assert steps[0].log == (
        "Sirdar can't write its runner folder (SIRDAR_RUNNER_DIR). It must be owned by "
        "uid 10001 with mode 700.\n")
    assert d.error == "Step 1 (Preflight) failed. See its log."


async def test_app_lifespan_recovers_then_shuts_down(monkeypatch):
    calls: list[str] = []

    async def recover():
        calls.append("recover")
        return 0

    async def sweep():
        calls.append("sweep")
        return 0

    timeouts: list[float] = []

    async def shutdown(timeout=10.0):
        calls.append("shutdown")
        timeouts.append(timeout)

    monkeypatch.setattr(pipeline, "recover_orphans", recover)
    monkeypatch.setattr(pipeline, "sweep_runs", sweep)
    monkeypatch.setattr(pipeline, "shutdown", shutdown)
    app = create_app()
    async with app.router.lifespan_context(app):
        assert calls == ["recover", "sweep"]
    assert calls == ["recover", "sweep", "shutdown"]
    assert timeouts == [CANCEL_GRACE_SECONDS + 5]    # the runner's grace, plus a margin


async def test_app_lifespan_starts_when_recovery_and_sweep_fail(monkeypatch):
    calls: list[str] = []

    async def broken():
        raise RuntimeError("database down")

    async def shutdown(timeout=10.0):
        calls.append("shutdown")

    monkeypatch.setattr(pipeline, "recover_orphans", broken)
    monkeypatch.setattr(pipeline, "sweep_runs", broken)
    monkeypatch.setattr(pipeline, "shutdown", shutdown)
    app = create_app()
    async with app.router.lifespan_context(app):
        calls.append("serving")
    assert calls == ["serving", "shutdown"]


async def test_startup_sweep_removes_every_run_folder(monkeypatch, tmp_path):
    """At startup no run is live (recover_orphans just closed them), so even a
    fresh run folder, with its secrets, goes: no 2-hour wait after a crash."""
    from sirdar_api.deploy.runner import AnsibleRunner

    root = tmp_path / "runner"
    fresh, other = root / "run-fresh", root / "keep-me"
    for d in (fresh, other):
        d.mkdir(parents=True)
    (fresh / "id_key").write_text("secret")

    async def recover():
        return 0

    async def shutdown(timeout=10.0):
        return None

    monkeypatch.setattr(pipeline, "recover_orphans", recover)
    monkeypatch.setattr(pipeline, "shutdown", shutdown)
    monkeypatch.setattr(pipeline, "make_runner", lambda settings: AnsibleRunner(str(root)))
    app = create_app()
    async with app.router.lifespan_context(app):
        assert not fresh.exists()
        assert other.exists()


async def test_sweep_runs_uses_the_runner(monkeypatch):
    class Sweeper:
        def sweep_stale(self, max_age=None):
            return 3

    monkeypatch.setattr(pipeline, "make_runner", lambda settings: Sweeper())
    assert await pipeline.sweep_runs() == 3
    monkeypatch.setattr(pipeline, "make_runner", lambda settings: object())
    assert await pipeline.sweep_runs() == 0
