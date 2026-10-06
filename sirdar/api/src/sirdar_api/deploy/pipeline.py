"""Deployment pipeline (spec Section 2). Besides Update and Reset it runs the
snapshot modes: Reset (or a first deploy) that restores a snapshot, Restore
backup, Roll back, and Take snapshot, a job that leaves the environment as
it is. A deployment that publishes adds steps 12–14 (DNS records, proxy
hosts, smoke test), which run in Sirdar through a Publisher instead of a
playbook; a publish job is only those. Delete environment (teardown) runs
15–17 and, when they succeed, deletes the environment's row. A VM
environment's deployment (vm; on Proxmox or ESXi) adds the VM steps, run by
a Provisioner: 0 Prepare VM before the host steps (the SSH host is prepared
after it, once the VM has an address), 0 Restore VM snapshot alone, and 15
Destroy VM. A DigitalOcean environment's deployment (cloud) runs its own
plans (steps.plan_for(cloud=True)); its steps 0, 14 and 18 go through the
same provisioner seam, its host steps run on the slot's droplet, and Reset,
Restore backup and Roll back are refused (the managed database is shared by
both slots).

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
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import PurePosixPath

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings, get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    DoResource,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
    Snapshot,
)
from sirdar_api.deploy import (
    ConnectFailed,
    certs,
    do_envs,
    do_provision,
    envfile,
    esxi_provision,
    known_hosts,
    provision,
    publish,
    smoke,
    snapshots,
    spaces,
    ssh,
    targets,
    terraform,
    vault,
    vms,
    vmsteps,
)
from sirdar_api.deploy.redact import Redactor
from sirdar_api.deploy.runner import (
    CANCEL_GRACE_SECONDS,
    AnsibleRunner,
    Runner,
    RunnerDirUnwritable,
    RunRequest,
    RunResult,
    RunTarget,
)
from sirdar_api.deploy.steps import STEPS_BY_KEY, StepDef, plan_for
from sirdar_api.services.audit import audit

log = logging.getLogger(__name__)

LOG_LIMIT = 256 * 1024          # characters kept per step: the tail
FLUSH_SECONDS = 2.0             # how often a running step's log is saved
MIN_MEMORY_MB = 1800            # "2 GB" as the kernel reports it
RETRYABLE_STATUSES = ("failed", "cancelled", "interrupted")
# Jobs that leave the environment's status, commit and image tag as they are.
KEEPS_STATUS = ("snapshot", "publish")
# App shutdown waits this long: a cancelled runner may take its full grace
# to stop and still write its outcome before the engine is disposed.
SHUTDOWN_SECONDS = CANCEL_GRACE_SECONDS + 5
INTERRUPTED = "Sirdar stopped while this deployment was running."
CANCELLED = "Canceled."
UNEXPECTED = "Sirdar couldn't run this step."
KEPT_DUMP = "Keeping the pre-deploy backup from the first attempt"
RUNNER_DIR_UNWRITABLE = ("Sirdar can't write its runner folder (SIRDAR_RUNNER_DIR). It must "
                         "be owned by uid 10001 with mode 700.")

_tasks: dict[uuid.UUID, asyncio.Task] = {}
_cancel_requested: set[uuid.UUID] = set()


class DeployInProgress(Exception):
    """Another deployment of this environment is running."""


# Modes a DigitalOcean environment doesn't offer: the managed database is
# shared by both slots, so each would change the live slot too (Roll back is
# "Activate the other slot"), and there is no VM snapshot.
NOT_ON_DIGITALOCEAN = ("reset", "restore_dump", "rollback", "vm_restore")


class NotSupportedOnDigitalOcean(Exception):
    """The mode isn't offered on DigitalOcean (routes answer 409 `code`)."""

    code = "not_supported_on_digitalocean"

    def __init__(self, mode: str):
        super().__init__(self.code)
        self.mode = mode


NO_COMMIT = ("This deployment has no commit yet (step 0 resolves it on the VM), so Sirdar "
             "won't run the host steps. Retry from step 0 (Prepare VM).")


class PrepareError(Exception):
    """The run can't start. `reason` is our own copy, shown in the log."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def make_runner(settings: Settings) -> Runner:
    """The runner every deployment uses (tests replace this function)."""
    return AnsibleRunner(settings.runner_dir)


def make_publisher(settings: Settings) -> publish.Publisher:
    """What runs steps 12–14 and 16–17 (tests replace this function)."""
    return publish.HttpPublisher()


def make_terraform(settings: Settings) -> terraform.TerraformRunner:
    return terraform.SubprocessTerraform(settings.terraform_binary)


def make_provisioner(settings: Settings) -> provision.Provisioner:
    """What runs a VM environment's VM steps (tests replace this function)."""
    return vmsteps.HostProvisioner(
        proxmox=provision.ProxmoxProvisioner(terraform_runner=make_terraform(settings),
                                             settings=settings),
        esxi=esxi_provision.EsxiProvisioner(settings=settings),
        digitalocean=do_provision.DoProvisioner(settings=settings))


async def sweep_runs() -> int:
    """Startup: remove every run folder a crash or kill left behind, whatever
    its age. No run is live yet (recover_orphans has just closed them), so
    the age cutoff that guards prepare()'s sweep isn't needed here, and the
    secrets in those folders don't wait it out. Runners without a
    sweep_stale have nothing on disk."""
    sweep = getattr(make_runner(get_settings()), "sweep_stale", None)
    if sweep is None:
        return 0
    return await asyncio.to_thread(sweep, 0)


async def sweep_snapshots() -> int:
    """Startup: remove the half-written files a crashed upload or bundle
    write left in SIRDAR_SNAPSHOTS_DIR (an upload's may hold plaintext keys)."""
    return await asyncio.to_thread(snapshots.sweep_incoming, get_settings())


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


def restores(mode: str, snapshot_id: uuid.UUID | None) -> bool:
    """Whether a deployment restores a snapshot (Reset with one, or the first
    deploy of an environment created from one). A snapshot job also points
    at a snapshot, but takes it."""
    return snapshot_id is not None and mode in ("update", "reset")


def takes_snapshot(dep: Deployment) -> bool:
    """A DigitalOcean Delete that saves a snapshot first (step 11)."""
    return dep.mode == "teardown" and dep.cloud and dep.snapshot_id is not None


def _exports_now(dep: Deployment) -> bool:
    """The deployment runs Take snapshot itself (not skipped by a retry)."""
    return dep.mode == "snapshot" or (takes_snapshot(dep)
                                      and dep.start_step <= STEPS_BY_KEY["export"].number)


def plan_of(dep: Deployment) -> list[StepDef]:
    return plan_for(dep.mode, restore=restores(dep.mode, dep.snapshot_id), publish=dep.publish,
                    vm=dep.vm, cloud=dep.cloud, go_live=dep.go_live,
                    snapshot=takes_snapshot(dep))


# ---- records -----------------------------------------------------------------

async def create_deployment(db: AsyncSession, env: Environment, *, mode: str, git_ref: str,
                            sha: str, actor_id: uuid.UUID | None,
                            start_step: int | None = None,
                            retry_of: uuid.UUID | None = None,
                            snapshot_id: uuid.UUID | None = None,
                            restore_dump: str | None = None,
                            publish: bool = False, vm: bool = False,
                            take_vm_snapshot: bool = False,
                            vm_snapshot: str | None = None, cloud: bool = False,
                            slot: str | None = None, go_live: bool = False) -> Deployment:
    """Add a running deployment and its step rows. The caller commits, then
    calls launch(). start_step None means the plan's first step (1, or 12
    for a publish job, 15 for a teardown). Raises DeployInProgress (only the
    insert is rolled back, through a savepoint: the caller's session and
    objects stay usable), or ValueError when start_step isn't a step of this
    mode's plan (or the mode can't publish). Snapshot and publish jobs leave
    the environment's status alone; a teardown marks it deleting.

    cloud: a DigitalOcean environment's deployment (it must match the
    environment's target); `slot` is the slot it deploys, snapshots or
    switches to, and `go_live` ends it with 14 Switch traffic (always, for
    activate). A cloud teardown with a snapshot takes it first (step 11).
    Raises NotSupportedOnDigitalOcean for Reset, Restore backup, Roll back
    and Restore VM snapshot there."""
    on_do = env.target_id == targets.DO_TARGET
    if on_do and mode in NOT_ON_DIGITALOCEAN:
        raise NotSupportedOnDigitalOcean(mode)
    if cloud != on_do:
        raise ValueError("cloud must be set exactly for a DigitalOcean environment")
    go_live = go_live or mode == "activate"
    taking_on_delete = mode == "teardown" and cloud and snapshot_id is not None
    plan = plan_for(mode, restore=restores(mode, snapshot_id), publish=publish, vm=vm,
                    cloud=cloud, go_live=go_live, snapshot=taking_on_delete)
    if start_step is None:
        start_step = plan[0].number
    if start_step not in {step.number for step in plan}:
        raise ValueError(f"start_step {start_step} isn't a step of the {mode} plan")
    if snapshot_id is not None:
        # Lock the snapshot row until the caller commits, and re-check it in
        # this transaction: a concurrent delete (which locks it too) then
        # either finishes first (we refuse) or sees our running deployment.
        # populate_existing: read the locked row, not a stale identity-map copy.
        snap = await db.scalar(select(Snapshot).where(Snapshot.id == snapshot_id)
                               .with_for_update()
                               .execution_options(populate_existing=True))
        if snap is None:
            raise snapshots.SnapshotError("snapshot_not_found")
        export = STEPS_BY_KEY["export"].number
        taking = mode == "snapshot" or (taking_on_delete and start_step <= export)
        wanted = "pending" if taking else "ready"
        if snap.status != wanted:
            raise snapshots.SnapshotError("snapshot_not_ready")
    previous_sha, dump_path = env.current_sha, None
    if retry_of is not None:
        # A retry carries on its chain's first attempt: the commit to roll back
        # to and the pre-deploy dump taken before anything changed (a later
        # dump may already be post-migration).
        parent = await db.get(Deployment, retry_of)
        if parent is not None:
            previous_sha, dump_path = parent.previous_sha, parent.dump_path
            # ...and its VM snapshot from before anything changed (step 0 keeps it).
            if vm_snapshot is None:
                vm_snapshot = parent.vm_snapshot
    dep = Deployment(environment_id=env.id, mode=mode, git_ref=git_ref, sha=sha,
                     status="running", start_step=start_step, retry_of=retry_of,
                     previous_sha=previous_sha, actor_id=actor_id,
                     snapshot_id=snapshot_id, restore_dump=restore_dump,
                     dump_path=dump_path, publish=publish, vm=vm,
                     take_vm_snapshot=take_vm_snapshot, vm_snapshot=vm_snapshot,
                     cloud=cloud, slot=slot, go_live=go_live)
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
    if mode == "teardown":
        env.status, env.updated_at = "deleting", _now()
    elif mode not in KEEPS_STATUS:
        env.status, env.updated_at = "deploying", _now()
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
                               Environment.status.in_(("deploying", "deleting")))
                        .values(status="failed", updated_at=now))
        taken = list(await s.scalars(select(Deployment.snapshot_id).where(
            Deployment.id.in_(ids),
            or_(Deployment.mode == "snapshot",
                and_(Deployment.mode == "teardown", Deployment.cloud)),
            Deployment.snapshot_id.is_not(None))))
        if taken:
            await s.execute(update(Snapshot).where(Snapshot.id.in_(taken),
                                                   Snapshot.status == "pending")
                            .values(status="failed"))
        await s.execute(update(Deployment).where(Deployment.id.in_(ids))
                        .values(status="interrupted", finished_at=now, error=INTERRUPTED))
        await s.commit()
    settings = get_settings()
    for snapshot_id in taken:
        snapshots.discard_fetched(settings, snapshot_id)
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
    session may be mid-transaction or cancelled). A snapshot job's (or a
    DigitalOcean Delete's) pending snapshot becomes failed (and its
    half-fetched bundle goes); any mode but a snapshot or publish job leaves
    the environment failed."""
    now = _now()
    taken: uuid.UUID | None = None
    async with get_sessionmaker()() as s:
        mode, snapshot_id, cloud = (await s.execute(
            select(Deployment.mode, Deployment.snapshot_id, Deployment.cloud)
            .where(Deployment.id == deployment_id))).one()
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
        if (mode == "snapshot" or (mode == "teardown" and cloud)) and snapshot_id is not None:
            taken = snapshot_id
            await s.execute(update(Snapshot).where(Snapshot.id == snapshot_id,
                                                   Snapshot.status == "pending")
                            .values(status="failed"))
        if mode not in ("snapshot", "publish"):
            # a snapshot job and a publish job leave the environment as it was
            await s.execute(update(Environment).where(Environment.id == env_id)
                            .values(status="failed", updated_at=now))
        await s.commit()
    snapshots.discard_fetched(get_settings(), taken)


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
            # The next flush (or the final save) retries.
            except Exception as e:  # noqa: BLE001
                log.warning("couldn't save a running step's log: %s", type(e).__name__)
                seen = -1


# ---- running -------------------------------------------------------------------

@dataclass(frozen=True)
class _Context:
    target: RunTarget | None                   # None when no step runs on the host
    common: dict = field(repr=False)
    env_file_b64: str = field(repr=False)
    redactor: Redactor = field(repr=False)
    # An environment that has deployed before has a database worth keeping:
    # its pre-deploy dump must happen (dump.yml fails rather than skip it).
    dump_required: bool = False
    # It restores a snapshot: the dump refuses a database that exists but
    # isn't running (the restore would drop it unbacked).
    restores_snapshot: bool = False
    # Extra vars of the snapshot steps (restore, restore_dump, export).
    step_vars: dict = field(default_factory=dict, repr=False)
    # The restored snapshot's pepper and TOTP key: stored as the
    # environment's own once Restore snapshot succeeds.
    snapshot_keys: dict = field(default_factory=dict, repr=False)
    # Steps 12–14 and 16–17: credentials and the public services.
    publishing: publish.PublishContext | None = field(default=None, repr=False)
    # Steps 0 and 15 of a VM environment: its VM and the host's credentials.
    vm: vmsteps.VmContext | None = field(default=None, repr=False)

    def vars_for(self, step_key: str) -> dict:
        if step_key == "render":
            return {**self.common, "env_file_b64": self.env_file_b64}
        if step_key == "dump":
            return {**self.common, "dump_required": self.dump_required,
                    "restores_snapshot": self.restores_snapshot}
        return {**self.common, **self.step_vars.get(step_key, {})}


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


async def _prepare(db: AsyncSession, env: Environment, dep: Deployment, settings: Settings, *,
                   needs_host: bool = True, more_secrets: tuple[str, ...] = ()) -> _Context:
    """Everything the steps need. Without host steps (a publish job, or a
    retry of only steps 12–14 or 16–17) there is no target to connect to:
    only the redactor is built. more_secrets: the integration credentials."""
    if not needs_host:
        return _Context(target=None, common={"env_name": env.name}, env_file_b64="",
                        redactor=Redactor(_redaction_values(more_secrets)))
    if not dep.sha and dep.mode != "teardown":   # the .env names the commit's image
        raise PrepareError(NO_COMMIT)
    try:
        # DigitalOcean: the slot this deployment works on (an Update targets
        # the idle slot), not the active one.
        cfg = await vms.host_config(db, settings, env, slot=dep.slot if dep.cloud else None)
    except (vault.SecretsKeyMissing, vault.SecretUnreadable):
        raise PrepareError("Sirdar can't read its key for this environment's VM with the "
                           "current SIRDAR_SECRETS_KEY.") from None
    if cfg is None and targets.is_built_target(env.target_id):
        raise PrepareError(
            "This environment's droplet has no address yet. Retry from step 0 (Prepare "
            "DigitalOcean)." if env.target_id == targets.DO_TARGET else
            "This environment's VM has no address yet. Retry from step 0 (Prepare VM).")
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
    step_vars, snapshot_keys, extra_secrets = await _snapshot_vars(db, env, dep, settings,
                                                                   secrets)
    secrets = {**secrets, **snapshot_keys}
    extra: dict[str, str] = {}
    if dep.cloud:
        # Read again here, not only at the start: step 0 may have just made
        # the Spaces secret and the doadmin password.
        extra_secrets = [*extra_secrets, *await do_envs.secret_values(db, settings, env)]
    if dep.cloud and dep.mode == "update":           # only Update renders .env
        try:
            extra, cloud_secrets = await do_envs.env_extra(db, settings, env, dep.slot, secrets)
        except do_envs.DoEnvError as e:
            missing = ", ".join(e.extra.get("missing") or [])
            raise PrepareError(f"This environment isn't fully built yet (missing: {missing}). "
                               "Retry from step 0 (Prepare DigitalOcean).") from None
        except (vault.SecretsKeyMissing, vault.SecretUnreadable):
            raise PrepareError("Sirdar can't read this environment's DigitalOcean secrets "
                               "with the current SIRDAR_SECRETS_KEY.") from None
        extra_secrets = [*extra_secrets, *cloud_secrets]
    rows = await db.scalars(select(EnvironmentService)
                            .where(EnvironmentService.environment_id == env.id))
    ports = {**envfile.DEFAULT_PORTS, **{r.service: r.port for r in rows}}
    try:
        text = envfile.render_env(envfile.EnvConfig(
            name=env.name, domain=env.base_domain, image_tag=envfile.image_tag(dep.sha),
            proxy_ip=env.proxy_ip, bind_ip=env.bind_ip, ports=ports,
            keep_dumps=env.keep_dumps, spaces_bucket=env.spaces_bucket,
            log_level=env.log_level, secrets=secrets, extra=extra))
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
              "min_disk_gb": ssh.MIN_DISK_GB, "min_memory_mb": MIN_MEMORY_MB,
              "external_data": dep.cloud, "block_metadata": dep.cloud,
              # the slot smoke test's names: no spaces (objects live in
              # Spaces; Caddy has no route for it)
              "public_hosts": ([{"service": s, "hostname": f"{s}.{env.base_domain}",
                                 "path": smoke.PATHS.get(s, "/")} for s in certs.PUBLIC_SERVICES]
                               if dep.cloud else [])}
    redactor = Redactor(_redaction_values([*secrets.values(), env_b64, cfg.password,
                                           cfg.passphrase, cfg.sudo_password, private_key,
                                           *extra_secrets, *more_secrets]))
    return _Context(target=target, common=common, env_file_b64=env_b64, redactor=redactor,
                    dump_required=env.current_sha is not None,
                    restores_snapshot=restores(dep.mode, dep.snapshot_id), step_vars=step_vars,
                    snapshot_keys=snapshot_keys)


async def _snapshot_vars(db: AsyncSession, env: Environment, dep: Deployment,
                         settings: Settings, secrets: dict[str, str]
                         ) -> tuple[dict, dict[str, str], list[str]]:
    """(per-step vars, the restored snapshot's keys, more values to redact)."""
    step_vars: dict[str, dict] = {}
    keys: dict[str, str] = {}
    extra: list[str] = []
    snap = await db.get(Snapshot, dep.snapshot_id) if dep.snapshot_id else None
    try:
        if restores(dep.mode, dep.snapshot_id):
            if snap is None or snap.status != "ready":
                raise PrepareError("The snapshot this deployment restores is gone. Start a "
                                   "new deployment.")
            keys = await asyncio.to_thread(snapshots.read_keys, settings, snap)
            step_vars["restore"] = {
                "bundle_path": str(snapshots.bundle_path(settings, snap)),
                "bundle_tool": snapshots.BUNDLE_TOOL,
                "snapshot_revision": snap.alembic_revision,
                "api_image": f"serversherpa-api:{envfile.image_tag(dep.sha)}"}
            # Reset data refuses a too-new snapshot before it wipes anything.
            step_vars["reset"] = {"snapshot_revision": snap.alembic_revision}
        if _exports_now(dep):
            if snap is None or snap.status != "pending":
                raise PrepareError("This snapshot job's record is gone. Take the snapshot "
                                   "again.")
            await asyncio.to_thread(snapshots.ensure_dirs, settings)
            token = snapshots.encrypt_keys(settings, secrets)
            token_b64 = base64.b64encode(token).decode()
            extra += [token.decode(), token_b64]
            step_vars["export"] = {
                "snapshot_dest": str(snapshots.fetched_path(settings, snap.id)),
                "bundle_tool": snapshots.BUNDLE_TOOL, "keys_enc_b64": token_b64,
                "api_image": f"serversherpa-api:{env.image_tag}",
                "spaces_bucket": env.spaces_bucket}
    except snapshots.SnapshotError as e:
        raise PrepareError(e.reason) from None
    if dep.restore_dump:
        step_vars["restore_dump"] = {"dump_name": dep.restore_dump}
    if dep.cloud:
        # The managed database and the Spaces bucket (the secret comes from
        # the droplet's .env).
        row = await do_envs.get(db, env.id)
        if row is not None:
            external = {"external_data": True, "spaces_endpoint": spaces.endpoint(row.region),
                        "spaces_key_id": row.spaces_key_id or "", "spaces_region": row.region}
            for key in ("export", "restore"):
                if key in step_vars:
                    step_vars[key] |= external
    return step_vars, keys, extra


async def _keep_snapshot_keys(db: AsyncSession, env_id: uuid.UUID, settings: Settings,
                              keys: dict[str, str]) -> None:
    """After a restore the environment runs on the snapshot's pepper and TOTP
    key: store them as its own, so later deploys render them."""
    for key, value in keys.items():
        row = await db.get(EnvironmentSecret, (env_id, key))
        if row is None:
            db.add(EnvironmentSecret(environment_id=env_id, key=key,
                                     value_enc=vault.encrypt(settings, value)))
        else:
            row.value_enc, row.updated_at = vault.encrypt(settings, value), _now()


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
    except RunnerDirUnwritable:
        log.error("deploy step %s couldn't write the runner folder", step.key)
        buffer.append(RUNNER_DIR_UNWRITABLE + "\n")
        return RunResult(status="failed", rc=-1)
    # A failed step, never the exception text.
    except Exception as e:  # noqa: BLE001
        log.error("deploy step %s couldn't run: %s", step.key, type(e).__name__)
        buffer.append(UNEXPECTED + "\n")
        return RunResult(status="failed", rc=-1)
    finally:
        flusher.cancel()
        with suppress(asyncio.CancelledError):
            await flusher
        await _save_log(step.id, buffer.text())


async def _run_python_step(publisher: publish.Publisher, ctx: _Context,
                           step: DeploymentStep) -> RunResult:
    """A step that runs in Sirdar: the same log handling as a playbook. A
    StepFailed reason ends the log; any other error shows only our copy.
    Cancel (and shutdown's interrupt) propagates like an Ansible step's."""
    definition = STEPS_BY_KEY[step.key]
    buffer = _LogBuffer(ctx.redactor)
    flusher = asyncio.create_task(_flush_loop(step.id, buffer))
    try:
        await asyncio.wait_for(publisher.run(step.key, ctx.publishing, buffer.append),
                               definition.timeout)
        return RunResult(status="successful", rc=0)
    except asyncio.CancelledError:
        raise
    except TimeoutError:
        return RunResult(status="timeout", rc=-1)
    except publish.StepFailed as e:
        buffer.append(e.reason + "\n")
        return RunResult(status="failed", rc=1)
    # A failed step, never the exception text.
    except Exception as e:  # noqa: BLE001
        log.error("deploy step %s couldn't run: %s", step.key, type(e).__name__)
        buffer.append(UNEXPECTED + "\n")
        return RunResult(status="failed", rc=-1)
    finally:
        flusher.cancel()
        with suppress(asyncio.CancelledError):
            await flusher
        await _save_log(step.id, buffer.text())


async def _run_vm_step(provisioner: provision.Provisioner, ctx: _Context,
                       step: DeploymentStep) -> RunResult:
    """Step 0 or 15 of a VM environment, in Sirdar: a publish step's log
    handling, plus what step 0 found out (the resolved commit, the VM
    snapshot) in the result's data."""
    definition = STEPS_BY_KEY[step.key]
    buffer = _LogBuffer(ctx.redactor)
    flusher = asyncio.create_task(_flush_loop(step.id, buffer))
    try:
        outcome = await asyncio.wait_for(provisioner.run(step.key, ctx.vm, buffer.append),
                                         definition.timeout)
        return RunResult(status="successful", rc=0,
                         data={"sha": outcome.sha, "vm_snapshot": outcome.vm_snapshot})
    except asyncio.CancelledError:
        raise
    except TimeoutError:
        return RunResult(status="timeout", rc=-1)
    except publish.StepFailed as e:
        buffer.append(e.reason + "\n")
        return RunResult(status="failed", rc=1)
    # A failed step, never the exception text.
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
                runs = {STEPS_BY_KEY[s.key].runs for s in todo}
                try:
                    publishing = (await publish.prepare(db, env, settings)
                                  if "python" in runs else None)
                    vm_ctx = (await vmsteps.prepare(db, env, dep, settings)
                              if "vm" in runs else None)
                    more = (*(publishing.secret_values if publishing else ()),
                            *(vm_ctx.secret_values if vm_ctx else ()))
                    if dep.cloud:
                        # The renewal token, Spaces secret, doadmin password and
                        # ACME key aren't all in the DigitalOcean context.
                        more = (*more, *await do_envs.secret_values(db, settings, env))
                    # Step 0 first: the SSH host is prepared once the VM is up.
                    host_now = "ansible" in runs and STEPS_BY_KEY[todo[0].key].runs != "vm"
                    ctx = await _prepare(db, env, dep, settings, needs_host=host_now,
                                         more_secrets=more)
                except (PrepareError, publish.PublishError, vmsteps.VmPrepareError) as e:
                    await db.rollback()
                    await _close(deployment_id, env_id, current, step_status="failed",
                                 dep_status="failed", error=e.reason, failed_step=current,
                                 append_log=e.reason + "\n")
                    return
                # End _prepare's read transaction: step 1 must not hold a
                # connection idle in a transaction for its whole timeout.
                ctx = replace(ctx, publishing=publishing, vm=vm_ctx)
                await db.commit()
                runner = make_runner(settings)
                publisher = make_publisher(settings)
                provisioner = make_provisioner(settings) if vm_ctx is not None else None
                for step in todo:
                    current = step.number
                    if step.status != "running":
                        await _mark_running(db, step)
                    runs_on = STEPS_BY_KEY[step.key].runs
                    if runs_on == "ansible" and ctx.target is None:
                        try:
                            host = await _prepare(db, env, dep, settings, more_secrets=more)
                        except PrepareError as e:
                            await db.rollback()
                            await _close(deployment_id, env_id, current, step_status="failed",
                                         dep_status="failed", error=e.reason,
                                         failed_step=current, append_log=e.reason + "\n")
                            return
                        ctx = replace(host, publishing=ctx.publishing, vm=ctx.vm)
                        await db.commit()
                    if step.key == "dump" and dep.dump_path:
                        # Never replace the chain's first pre-deploy dump.
                        name = PurePosixPath(dep.dump_path).name
                        await _save_log(step.id, f"{KEPT_DUMP}: {name}\n")
                        step.status, step.finished_at = "succeeded", _now()
                        await db.commit()
                        continue
                    if runs_on == "python":
                        result = await _run_python_step(publisher, ctx, step)
                    elif runs_on == "vm":
                        result = await _run_vm_step(provisioner, ctx, step)
                    else:
                        result = await _run_step(runner, ctx, step)
                    if step.key == "slot_smoke" and dep.slot:
                        await do_envs.set_slot(env.id, dep.slot,
                                               last_check_ok=result.status == "successful",
                                               last_check_at=_now())
                    if result.status != "successful":
                        # Before the rollback, which may expire `step`: reloading
                        # it would need a greenlet.
                        reason = _failure_reason(step, result)
                        await db.rollback()
                        await _close(deployment_id, env_id, current, step_status="failed",
                                     dep_status="failed", error=reason, failed_step=current)
                        return
                    step.status, step.finished_at = "succeeded", _now()
                    if step.key in ("provision", "do_prepare"):
                        # The commit step 0 resolved on the VM, and its VM snapshot.
                        if result.data.get("sha"):
                            dep.sha = result.data["sha"]
                        if result.data.get("vm_snapshot"):
                            dep.vm_snapshot = result.data["vm_snapshot"]
                    elif step.key == "go_live":
                        # The load balancer points at the slot now (None: Deactivate).
                        env.active_slot = dep.slot
                    elif step.key == "dump":
                        dep.dump_path = result.data.get("dump_path") or None
                    elif step.key == "restore":
                        await _keep_snapshot_keys(db, env.id, settings, ctx.snapshot_keys)
                    elif step.key == "export":
                        try:
                            stored = await asyncio.to_thread(snapshots.ingest_fetched,
                                                             settings, dep.snapshot_id)
                        except snapshots.SnapshotError as e:
                            reason = f"Step {step.number} ({step.name}) failed: {e.reason}"
                            await db.rollback()
                            await _close(deployment_id, env_id, current, step_status="failed",
                                         dep_status="failed", error=reason,
                                         failed_step=current, append_log=reason + "\n")
                            return
                        snapshots.mark_ready(await db.get(Snapshot, dep.snapshot_id), stored)
                    await db.commit()
            current = None
            now = _now()
            dep.status, dep.finished_at = "succeeded", now
            if dep.mode == "teardown" and dep.cloud:
                left = await db.scalar(select(func.count()).select_from(DoResource)
                                       .where(DoResource.environment_id == env.id))
                if left:
                    # do_resources is ON DELETE RESTRICT, and each row is
                    # something on DigitalOcean that still costs money.
                    destroy = STEPS_BY_KEY["do_destroy"]
                    reason = (f"Sirdar still records {left} DigitalOcean resource"
                              f"{'' if left == 1 else 's'} for this environment, so it kept "
                              f"the environment. Retry from step {destroy.number} "
                              f"({destroy.name}).")
                    await db.rollback()
                    await _close(deployment_id, env_id, destroy.number, step_status="failed",
                                 dep_status="failed", error=reason,
                                 failed_step=destroy.number, append_log=reason + "\n")
                    return
            if dep.mode == "teardown":
                # Its deployments, steps, services, secrets and managed
                # records go with it (ON DELETE CASCADE); the audit row stays.
                audit(db, actor_id=dep.actor_id, action="deploy.environment_delete",
                      entity_type="environment", entity_id=env.name,
                      changes={"environment": env.name, "deployment": str(dep.id)})
                await db.delete(env)
            elif dep.cloud and dep.mode in ("update", "activate"):
                await do_envs.after_success(db, env, dep)
            elif dep.mode not in KEEPS_STATUS:
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
        # Record the failure, never its text.
        except Exception as e:  # noqa: BLE001
            log.error("deployment %s stopped by %s", deployment_id, type(e).__name__)
            with suppress(Exception):
                await db.rollback()
            if env_id is not None:
                await _close(deployment_id, env_id, current, step_status="failed",
                             dep_status="failed", error=UNEXPECTED, failed_step=current)
