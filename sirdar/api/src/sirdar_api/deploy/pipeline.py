"""Deployment pipeline (spec Section 2: steps 1–8 here; DNS, proxy and smoke
tests come in phase 4).

One asyncio task per running deployment, registered in _tasks; each task
uses its own database sessions. Steps run in plan order through a Runner,
and the first failure stops the deployment (later steps become not_run).
Retry is a new deployment whose earlier steps are skipped. The partial
unique index deployments_one_running allows one running deployment per
environment. Shutdown cancels running tasks (they end "interrupted"); at
startup, deployments a previous process left running are marked the same.
Sirdar runs one process: _tasks is the whole truth about live runs.

Logs are redacted (every secret value this run knows becomes [redacted])
before they are kept, and only a step's last LOG_LIMIT characters are
stored. Ansible prints values JSON-encoded, so each secret's JSON-escaped
form is redacted as well. Exception text never reaches a log or the
database.

Runners call on_output from a worker thread: it only appends to a
lock-guarded _LogBuffer, never touching the event loop or a session; a
task on the loop saves the buffer every FLUSH_SECONDS."""

import asyncio
import base64
import json
import logging
import threading
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings, get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
)
from sirdar_api.deploy import ConnectFailed, envfile, known_hosts, ssh, targets, vault
from sirdar_api.deploy.redact import Redactor
from sirdar_api.deploy.runner import (
    CANCEL_GRACE_SECONDS,
    AnsibleRunner,
    Runner,
    RunRequest,
    RunResult,
    RunTarget,
)
from sirdar_api.deploy.steps import STEPS_BY_KEY, plan_for

log = logging.getLogger(__name__)

LOG_LIMIT = 256 * 1024          # characters kept per step: the tail
FLUSH_SECONDS = 2.0             # how often a running step's log is saved
MIN_MEMORY_MB = 1800            # "2 GB" as the kernel reports it
RETRYABLE_STATUSES = ("failed", "cancelled", "interrupted")
# App shutdown waits this long: a cancelled runner may take its full grace
# to stop and still write its outcome before the engine is disposed.
SHUTDOWN_SECONDS = CANCEL_GRACE_SECONDS + 5
INTERRUPTED = "Sirdar stopped while this deployment was running."
CANCELLED = "Cancelled."
UNEXPECTED = "Sirdar couldn't run this step."

_tasks: dict[uuid.UUID, asyncio.Task] = {}
_cancel_requested: set[uuid.UUID] = set()


class DeployInProgress(Exception):
    """Another deployment of this environment is running."""


class PrepareError(Exception):
    """The run can't start. `reason` is our own copy, shown in the log."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def make_runner(settings: Settings) -> Runner:
    """The runner every deployment uses (tests replace this function)."""
    return AnsibleRunner(settings.runner_dir)


async def sweep_runs() -> int:
    """Startup: remove run folders a crash or kill left behind (runners
    without a sweep_stale have nothing on disk)."""
    sweep = getattr(make_runner(get_settings()), "sweep_stale", None)
    if sweep is None:
        return 0
    return await asyncio.to_thread(sweep)


def _redaction_values(values) -> list[str]:
    """Each secret plus its JSON-escaped form (quotes, backslashes and line
    breaks as ansible prints them) when that differs."""
    out: list[str] = []
    for value in values:
        if not value:
            continue
        out.append(value)
        for escaped in (json.dumps(value)[1:-1],
                        json.dumps(value, ensure_ascii=False)[1:-1]):
            if escaped not in out:
                out.append(escaped)
    return out


def _now() -> datetime:
    return datetime.now(UTC)


# ---- records -----------------------------------------------------------------

async def create_deployment(db: AsyncSession, env: Environment, *, mode: str, git_ref: str,
                            sha: str, actor_id: uuid.UUID | None, start_step: int = 1,
                            retry_of: uuid.UUID | None = None) -> Deployment:
    """Add a running deployment and its step rows. The caller commits, then
    calls launch(). Raises DeployInProgress (only the insert is rolled back,
    through a savepoint: the caller's session and objects stay usable), or
    ValueError when start_step isn't a step of this mode's plan."""
    plan = plan_for(mode)
    if start_step not in {step.number for step in plan}:
        raise ValueError(f"start_step {start_step} isn't a step of the {mode} plan")
    dep = Deployment(environment_id=env.id, mode=mode, git_ref=git_ref, sha=sha,
                     status="running", start_step=start_step, retry_of=retry_of,
                     previous_sha=env.current_sha, actor_id=actor_id)
    try:
        async with db.begin_nested():
            db.add(dep)
            await db.flush()
    except IntegrityError as e:
        if "deployments_one_running" in str(e.orig):
            raise DeployInProgress() from None
        raise
    for step in plan:
        db.add(DeploymentStep(deployment_id=dep.id, number=step.number, key=step.key,
                              name=step.name,
                              status="skipped" if step.number < start_step else "pending"))
    env.status = "deploying"
    env.updated_at = _now()
    await db.flush()
    return dep


# ---- task registry -------------------------------------------------------------

def launch(deployment_id: uuid.UUID) -> asyncio.Task:
    task = asyncio.create_task(_run(deployment_id), name=f"deployment-{deployment_id}")
    _tasks[deployment_id] = task

    def done(t: asyncio.Task) -> None:
        _tasks.pop(deployment_id, None)
        _cancel_requested.discard(deployment_id)
        if not t.cancelled() and t.exception() is not None:
            log.error("deployment %s task crashed: %s", deployment_id,
                      type(t.exception()).__name__)

    task.add_done_callback(done)
    return task


def is_active(deployment_id: uuid.UUID) -> bool:
    return deployment_id in _tasks


async def wait(deployment_id: uuid.UUID, timeout: float = 30.0) -> None:
    task = _tasks.get(deployment_id)
    if task is not None:
        await asyncio.wait({task}, timeout=timeout)


def request_cancel(deployment_id: uuid.UUID) -> bool:
    """Cancel a deployment running in this process; False when none is."""
    task = _tasks.get(deployment_id)
    if task is None:
        return False
    _cancel_requested.add(deployment_id)
    return task.cancel()


async def shutdown(timeout: float = 10.0) -> None:
    """App shutdown: stop every run; each records itself interrupted."""
    tasks = list(_tasks.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.wait(tasks, timeout=timeout)


async def recover_orphans() -> int:
    """Mark deployments left running by a previous process as interrupted."""
    async with get_sessionmaker()() as s:
        query = select(Deployment.id).where(Deployment.status == "running")
        if _tasks:
            query = query.where(Deployment.id.not_in(list(_tasks)))
        ids = list(await s.scalars(query))
        if not ids:
            return 0
        now = _now()
        await s.execute(update(DeploymentStep)
                        .where(DeploymentStep.deployment_id.in_(ids),
                               DeploymentStep.status == "running")
                        .values(status="interrupted", finished_at=now))
        await s.execute(update(DeploymentStep)
                        .where(DeploymentStep.deployment_id.in_(ids),
                               DeploymentStep.status == "pending")
                        .values(status="not_run"))
        await s.execute(update(Environment)
                        .where(Environment.id.in_(select(Deployment.environment_id)
                                                  .where(Deployment.id.in_(ids))),
                               Environment.status == "deploying")
                        .values(status="failed", updated_at=now))
        await s.execute(update(Deployment).where(Deployment.id.in_(ids))
                        .values(status="interrupted", finished_at=now, error=INTERRUPTED))
        await s.commit()
        return len(ids)


async def close_orphan(deployment_id: uuid.UUID) -> None:
    """Cancel a running deployment that has no task in this process."""
    async with get_sessionmaker()() as s:
        dep = await s.get(Deployment, deployment_id)
        if dep is None or dep.status != "running":
            return
        env_id = dep.environment_id
        running = await s.scalar(select(DeploymentStep.number).where(
            DeploymentStep.deployment_id == deployment_id, DeploymentStep.status == "running"))
    await _close(deployment_id, env_id, running, step_status="cancelled",
                 dep_status="cancelled", error=CANCELLED)


async def _close(deployment_id: uuid.UUID, env_id: uuid.UUID, step_number: int | None, *,
                 step_status: str, dep_status: str, error: str, failed_step: int | None = None,
                 append_log: str = "") -> None:
    """End a deployment that didn't succeed, in a fresh session (the run's own
    session may be mid-transaction or cancelled)."""
    now = _now()
    async with get_sessionmaker()() as s:
        if step_number is not None:
            values: dict = {"status": step_status, "finished_at": now}
            if append_log:
                values["log"] = DeploymentStep.log + append_log
            await s.execute(update(DeploymentStep)
                            .where(DeploymentStep.deployment_id == deployment_id,
                                   DeploymentStep.number == step_number)
                            .values(**values))
        await s.execute(update(DeploymentStep)
                        .where(DeploymentStep.deployment_id == deployment_id,
                               DeploymentStep.status == "pending")
                        .values(status="not_run"))
        await s.execute(update(Deployment).where(Deployment.id == deployment_id)
                        .values(status=dep_status, finished_at=now, error=error,
                                failed_step=failed_step))
        await s.execute(update(Environment).where(Environment.id == env_id)
                        .values(status="failed", updated_at=now))
        await s.commit()


# ---- logs ----------------------------------------------------------------------

class _LogBuffer:
    """A step's output, redacted as it arrives (from the runner's thread)."""

    def __init__(self, redactor: Redactor):
        self._redact = redactor
        self._parts: list[str] = []
        self._size = 0
        self._lock = threading.Lock()
        self.version = 0

    def append(self, text: str) -> None:
        clean = self._redact(text)
        with self._lock:
            self._parts.append(clean)
            self._size += len(clean)
            self.version += 1
            if self._size > 2 * LOG_LIMIT:
                kept = "".join(self._parts)[-LOG_LIMIT:]
                self._parts, self._size = [kept], len(kept)

    def text(self) -> str:
        with self._lock:
            joined = "".join(self._parts)
        return self._redact(joined)[-LOG_LIMIT:]


async def _save_log(step_id: uuid.UUID, text: str) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(DeploymentStep).where(DeploymentStep.id == step_id)
                        .values(log=text))
        await s.commit()


async def _flush_loop(step_id: uuid.UUID, buffer: _LogBuffer) -> None:
    seen = 0
    while True:
        await asyncio.sleep(FLUSH_SECONDS)
        if buffer.version != seen:
            seen = buffer.version
            try:
                await _save_log(step_id, buffer.text())
            except Exception as e:  # noqa: BLE001
                log.warning("couldn't save a running step's log: %s", type(e).__name__)
                seen = -1


# ---- running -------------------------------------------------------------------

@dataclass(frozen=True)
class _Context:
    target: RunTarget
    common: dict = field(repr=False)
    env_file_b64: str = field(repr=False)
    redactor: Redactor = field(repr=False)

    def vars_for(self, step_key: str) -> dict:
        if step_key == "render":
            return {**self.common, "env_file_b64": self.env_file_b64}
        return dict(self.common)


async def _load_secrets(db: AsyncSession, env_id: uuid.UUID,
                        settings: Settings) -> dict[str, str]:
    rows = await db.scalars(select(EnvironmentSecret)
                            .where(EnvironmentSecret.environment_id == env_id))
    try:
        return {row.key: vault.decrypt(settings, row.value_enc) for row in rows}
    except vault.SecretsKeyMissing:
        raise PrepareError("SIRDAR_SECRETS_KEY isn't set, so Sirdar can't read this "
                           "environment's secrets.") from None
    except vault.SecretUnreadable:
        raise PrepareError("This environment's secrets don't open with the current "
                           "SIRDAR_SECRETS_KEY.") from None


async def _prepare(db: AsyncSession, env: Environment, dep: Deployment,
                   settings: Settings) -> _Context:
    cfg = targets.ssh_config_for(env.target_id, settings)
    if cfg is None:
        raise PrepareError("This environment's SSH target isn't configured any more. "
                           "Pick another target, then retry.")
    try:
        pinned = await ssh.pinned_host_key(db, cfg.host, cfg.port)
    except ssh.HostKeyUnknown:
        raise PrepareError(f"Sirdar doesn't trust {cfg.host}:{cfg.port} yet. Trust its host "
                           "key on the Deploy page, then retry.") from None
    except ssh.HostKeyMismatch:
        raise PrepareError(f"The host key of {cfg.host}:{cfg.port} changed. Check the server, "
                           "forget the old key and trust the new one, then retry.") from None
    except ConnectFailed as e:
        raise PrepareError(e.reason) from None
    try:
        client_key = await ssh.load_client_key(cfg)
    except ConnectFailed as e:
        raise PrepareError(e.reason) from None
    secrets = await _load_secrets(db, env.id, settings)
    rows = await db.scalars(select(EnvironmentService)
                            .where(EnvironmentService.environment_id == env.id))
    ports = {**envfile.DEFAULT_PORTS, **{r.service: r.port for r in rows}}
    try:
        text = envfile.render_env(envfile.EnvConfig(
            name=env.name, domain=env.base_domain, image_tag=envfile.image_tag(dep.sha),
            proxy_ip=env.proxy_ip, bind_ip=env.bind_ip, ports=ports,
            keep_dumps=env.keep_dumps, spaces_bucket=env.spaces_bucket,
            log_level=env.log_level, secrets=secrets))
    except envfile.RenderError as e:
        raise PrepareError(f"Sirdar couldn't write this environment's .env: {e.reason}.") \
            from None
    env_b64 = base64.b64encode(text.encode()).decode()
    private_key = client_key.export_private_key("openssh").decode() if client_key else None
    folder = envfile.env_dir(env.name)
    target = RunTarget(
        host=cfg.host, port=cfg.port, user=cfg.user,
        known_hosts_line=known_hosts.openssh_line(cfg.host, cfg.port, pinned.public_key),
        host_key_algorithms=known_hosts.host_key_algorithms(pinned.key_type),
        password=cfg.password, private_key=private_key,
        become_password=cfg.sudo_password or cfg.password)
    common = {"env_name": env.name, "env_dir": folder, "repo_url": settings.deploy_repo_url,
              "sha": dep.sha, "ss_stack": f"{folder}/repo/deploy/stack/ss-stack",
              "min_disk_gb": ssh.MIN_DISK_GB, "min_memory_mb": MIN_MEMORY_MB}
    redactor = Redactor(_redaction_values([*secrets.values(), env_b64, cfg.password,
                                           cfg.passphrase, cfg.sudo_password, private_key]))
    return _Context(target=target, common=common, env_file_b64=env_b64, redactor=redactor)


def _failure_reason(step: DeploymentStep, result: RunResult) -> str:
    if result.status == "timeout":
        minutes = STEPS_BY_KEY[step.key].timeout // 60
        return f"Step {step.number} ({step.name}) timed out after {minutes} minutes."
    return f"Step {step.number} ({step.name}) failed. See its log."


async def _mark_running(db: AsyncSession, step: DeploymentStep) -> None:
    step.status, step.started_at = "running", _now()
    await db.commit()


async def _run_step(runner: Runner, ctx: _Context, step: DeploymentStep) -> RunResult:
    definition = STEPS_BY_KEY[step.key]
    buffer = _LogBuffer(ctx.redactor)
    flusher = asyncio.create_task(_flush_loop(step.id, buffer))
    try:
        return await runner.run(
            RunRequest(step=step.key, playbook=definition.playbook, target=ctx.target,
                       timeout=definition.timeout, extravars=ctx.vars_for(step.key)),
            buffer.append)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        log.error("deploy step %s couldn't run: %s", step.key, type(e).__name__)
        buffer.append(UNEXPECTED + "\n")
        return RunResult(status="failed", rc=-1)
    finally:
        flusher.cancel()
        with suppress(asyncio.CancelledError):
            await flusher
        await _save_log(step.id, buffer.text())


async def _run(deployment_id: uuid.UUID) -> None:
    current: int | None = None                 # number of the step in progress
    env_id: uuid.UUID | None = None
    async with get_sessionmaker()() as db:
        try:
            dep = await db.get(Deployment, deployment_id)
            env = await db.get(Environment, dep.environment_id)
            env_id = env.id
            steps = list(await db.scalars(
                select(DeploymentStep).where(DeploymentStep.deployment_id == deployment_id)
                .order_by(DeploymentStep.number)))
            todo = [s for s in steps if s.status == "pending"]
            if todo:
                settings = get_settings()
                current = todo[0].number
                await _mark_running(db, todo[0])
                try:
                    ctx = await _prepare(db, env, dep, settings)
                except PrepareError as e:
                    await db.rollback()
                    await _close(deployment_id, env_id, current, step_status="failed",
                                 dep_status="failed", error=e.reason, failed_step=current,
                                 append_log=e.reason + "\n")
                    return
                runner = make_runner(settings)
                for step in todo:
                    current = step.number
                    if step.status != "running":
                        await _mark_running(db, step)
                    result = await _run_step(runner, ctx, step)
                    if result.status != "successful":
                        await db.rollback()
                        await _close(deployment_id, env_id, current, step_status="failed",
                                     dep_status="failed", error=_failure_reason(step, result),
                                     failed_step=current)
                        return
                    step.status, step.finished_at = "succeeded", _now()
                    if step.key == "dump":
                        dep.dump_path = result.data.get("dump_path") or None
                    await db.commit()
            current = None
            now = _now()
            dep.status, dep.finished_at = "succeeded", now
            env.current_sha, env.image_tag = dep.sha, envfile.image_tag(dep.sha)
            env.status, env.updated_at = "ready", now
            await db.commit()
        except asyncio.CancelledError:
            status = "cancelled" if deployment_id in _cancel_requested else "interrupted"
            with suppress(Exception):
                await db.rollback()
            if env_id is not None:
                await _close(deployment_id, env_id, current, step_status=status,
                             dep_status=status,
                             error=CANCELLED if status == "cancelled" else INTERRUPTED)
            raise
        except Exception as e:  # noqa: BLE001
            log.error("deployment %s stopped by %s", deployment_id, type(e).__name__)
            with suppress(Exception):
                await db.rollback()
            if env_id is not None:
                await _close(deployment_id, env_id, current, step_status="failed",
                             dep_status="failed", error=UNEXPECTED, failed_step=current)
