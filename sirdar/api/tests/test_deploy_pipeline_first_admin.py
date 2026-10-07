"""Step 11 (Create the first admin) in the pipeline: its vars, the password
only in the playbook's extravars (redacted everywhere else), the record
marked done, and our copy for bootstrap-admin's refusals."""

import asyncio
import json

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, Deployment, DeploymentStep, EnvironmentFirstAdmin
from sirdar_api.deploy import first_admins, pipeline, serialize
from sirdar_api.deploy.runner import RunResult

from .deploy_factories import (  # noqa: F401
    fake_runner,
    make_environment,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA, _load

TYPED = "Correct-Horse-Battery-9"
ADMIN = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
         "password_mode": "typed", "password": TYPED}


@pytest.fixture
async def fresh(db, deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    env = await make_environment(db, name="fresh", status="new")
    await first_admins.put(db, get_settings(), env.id, first_admins.check(ADMIN))
    await db.commit()
    return env


async def _run(db, env, **kw):
    dep = await pipeline.create_deployment(db, env, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, first_admin=True, **kw)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    return dep.id


def _rc(rc: int, status: str = "successful") -> RunResult:
    return RunResult(status=status, rc=0 if status == "successful" else 2,
                     data={"first_admin_rc": str(rc)})


async def test_step_11_runs_after_up_with_the_admin_vars(db, fresh, fake_runner):
    fake_runner.results["first_admin"] = _rc(0)
    dep_id = await _run(db, fresh)
    dep, steps, env = await _load(dep_id)
    assert fake_runner.steps() == ["preflight", "bootstrap", "fetch", "render", "build",
                                   "dump", "up", "first_admin"]
    assert [s.number for s in steps][-2:] == [10, 11]
    assert (dep.status, dep.first_admin, env.status) == ("succeeded", True, "ready")
    request = next(r for r in fake_runner.requests if r.step == "first_admin")
    assert request.playbook == "first_admin.yml"
    assert {k: request.extravars[k] for k in ("admin_email", "admin_role", "admin_invite",
                                              "admin_password", "admin_link_minutes")} == {
        "admin_email": "ada@test.example.com", "admin_role": "super_admin",
        "admin_invite": False, "admin_password": TYPED, "admin_link_minutes": 240}
    others = [r for r in fake_runner.requests if r.step != "first_admin"]
    assert all("admin_password" not in r.extravars for r in others)
    row = await db.get(EnvironmentFirstAdmin, fresh.id, populate_existing=True)
    assert row.password_enc is None and row.done_at is not None


async def test_the_password_is_redacted_from_every_log(db, fresh, fake_runner):
    fake_runner.output["first_admin"] = [f"echoed {TYPED} by mistake\n"]
    fake_runner.results["first_admin"] = _rc(0)
    dep_id = await _run(db, fresh)
    _, steps, _ = await _load(dep_id)
    logs = "".join(s.log for s in steps)
    assert TYPED not in logs and "[redacted]" in logs


async def test_an_existing_account_counts_as_done(db, fresh, fake_runner):
    fake_runner.results["first_admin"] = _rc(10)
    dep_id = await _run(db, fresh)
    dep, steps, _ = await _load(dep_id)
    assert dep.status == "succeeded"
    assert steps[-1].log.endswith(first_admins.EXISTS_NOTE.format(email="ada@test.example.com"))
    assert (await first_admins.pending(db, fresh.id)) is False


@pytest.mark.parametrize("rc", [1, 2, 3, 4, 5, 6, 7, 9])
async def test_a_refusal_fails_step_11_with_our_copy(db, fresh, fake_runner, rc):
    fake_runner.results["first_admin"] = _rc(rc, status="failed")
    dep_id = await _run(db, fresh)
    dep, steps, env = await _load(dep_id)
    assert (dep.status, dep.failed_step, env.status) == ("failed", 11, "failed")
    assert dep.error.endswith(first_admins.refusal(rc))
    assert steps[-1].log.endswith(first_admins.refusal(rc) + "\n")
    assert await first_admins.pending(db, fresh.id) is True          # the password is kept
    assert TYPED not in dep.error


async def test_a_done_record_plans_no_step_11(db, fresh, fake_runner):
    await first_admins.mark_done(db, fresh.id)
    await db.commit()
    dep_id = await _run(db, fresh)
    dep, steps, _ = await _load(dep_id)
    assert "first_admin" not in fake_runner.steps()
    assert (steps[-1].key, dep.first_admin, dep.status) == ("up", False, "succeeded")


async def test_a_record_done_after_create_skips_step_11(db, fresh, fake_runner):
    dep = await pipeline.create_deployment(db, fresh, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, first_admin=True)
    await first_admins.mark_done(db, fresh.id)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    dep, steps, _ = await _load(dep.id)
    assert "first_admin" not in fake_runner.steps()
    assert (steps[-1].key, steps[-1].status, steps[-1].log) == (
        "first_admin", "succeeded", first_admins.ALREADY_CREATED)
    assert dep.status == "succeeded"


async def test_a_retry_from_step_11_keeps_the_flag(db, fresh, fake_runner):
    fake_runner.results["first_admin"] = _rc(3, status="failed")
    failed = await _run(db, fresh)
    fake_runner.results["first_admin"] = _rc(0)
    dep = await pipeline.create_deployment(db, fresh, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, first_admin=True, start_step=11,
                                           retry_of=failed)
    await db.commit()
    pipeline.launch(dep.id)
    await pipeline.wait(dep.id)
    statuses = dict((await db.execute(
        select(DeploymentStep.key, DeploymentStep.status)
        .where(DeploymentStep.deployment_id == dep.id))).all())
    assert statuses["up"] == "skipped" and statuses["first_admin"] == "succeeded"
    assert (await db.get(Deployment, dep.id, populate_existing=True)).first_admin is True


async def test_a_seeded_update_has_no_step_11(db, fresh):
    with pytest.raises(ValueError):
        await pipeline.create_deployment(db, fresh, mode="reset", git_ref="main", sha=SHA,
                                         actor_id=None, first_admin=True)


async def test_the_deployment_json_has_the_flag_and_never_the_password(db, fresh, fake_runner):
    fake_runner.output["first_admin"] = [f"echoed {TYPED}\n"]
    fake_runner.results["first_admin"] = _rc(3, status="failed")
    dep_id = await _run(db, fresh)
    dep = await db.get(Deployment, dep_id, populate_existing=True)
    body = await serialize.deployment_out(db, dep, environment_name=fresh.name)
    assert body["first_admin"] is True
    assert TYPED not in json.dumps(body, default=str)
    audits = (await db.scalars(select(AuditLog))).all()
    assert all(TYPED not in json.dumps(a.changes, default=str) for a in audits)


def test_every_refusal_has_its_own_copy():
    assert "step's log" in first_admins.refusal(6)
    assert "without an account" in first_admins.refusal(7)
    assert first_admins.refusal(1) == ("Couldn't create the first admin (exit 1). See the "
                                       "step's log, then retry.")
    assert len({first_admins.refusal(rc) for rc in (1, 2, 3, 4, 5, 6, 7)}) == 7


@pytest.mark.parametrize("rc", [1, 2, 6, 7])
async def test_only_0_and_10_count_even_when_the_playbook_passed(db, fresh, fake_runner, rc):
    fake_runner.results["first_admin"] = _rc(rc)            # status "successful"
    dep_id = await _run(db, fresh)
    dep, _, _ = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 11)
    assert dep.error.endswith(first_admins.refusal(rc))
    assert await first_admins.pending(db, fresh.id) is True


async def test_a_failure_before_bootstrap_admin_ran_keeps_the_password(db, fresh, fake_runner):
    fake_runner.results["first_admin"] = RunResult(status="failed", rc=2)   # no first_admin_rc
    dep_id = await _run(db, fresh)
    dep, _, _ = await _load(dep_id)
    assert (dep.status, dep.failed_step) == ("failed", 11)
    assert dep.error == "Step 11 (Create the first admin) failed. See its log."
    assert await first_admins.pending(db, fresh.id) is True


async def test_step_11_reads_the_password_when_it_runs(db, fresh, fake_runner):
    """A PUT after the deployment was created (a retry after a refusal) is
    what step 11 uses, and the new password is redacted too."""
    newer = "Newer-Staple-Horse-42"
    dep = await pipeline.create_deployment(db, fresh, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, first_admin=True)
    await db.commit()
    gate = fake_runner.gates["up"] = asyncio.Event()
    pipeline.launch(dep.id)
    await fake_runner.started["up"].wait()
    await first_admins.put(db, get_settings(), fresh.id,
                           first_admins.check({**ADMIN, "password": newer}))
    await db.commit()
    fake_runner.output["first_admin"] = [f"echoed {newer} and {TYPED}\n"]
    fake_runner.results["first_admin"] = _rc(0)
    gate.set()
    await pipeline.wait(dep.id)
    request = next(r for r in fake_runner.requests if r.step == "first_admin")
    assert request.extravars["admin_password"] == newer
    _, steps, _ = await _load(dep.id)
    assert newer not in steps[-1].log and "[redacted]" in steps[-1].log


async def test_an_unreadable_password_fails_step_11(db, fresh, fake_runner):
    row = await db.get(EnvironmentFirstAdmin, fresh.id)
    row.password_enc = b"not-a-fernet-token"
    await db.commit()
    dep_id = await _run(db, fresh)
    dep, steps, _ = await _load(dep_id)
    assert (dep.status, dep.failed_step, dep.error) == ("failed", 11,
                                                         pipeline.FIRST_ADMIN_UNREADABLE)
    assert "first_admin" not in fake_runner.steps()
    assert await first_admins.pending(db, fresh.id) is True
