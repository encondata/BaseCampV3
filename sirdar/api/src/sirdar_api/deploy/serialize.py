"""JSON shapes for the environment and deployment endpoints. Secrets never
appear: an environment reports only which optional secrets are set, and
step logs were redacted before they were stored."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.db.models import Deployment, DeploymentStep, Environment, ManagedRecord, User
from sirdar_api.deploy import envfile, snapshots, targets, vms
from sirdar_api.deploy.environments import secret_keys_of, services_of

LOG_TAIL_DEFAULT = 8000


async def _actor_name(db: AsyncSession, actor_id) -> str | None:
    if actor_id is None:
        return None
    user = await db.get(User, actor_id)
    return user.display_name if user else None


async def latest_deployment(db: AsyncSession, env_id) -> Deployment | None:
    return await db.scalar(select(Deployment).where(Deployment.environment_id == env_id)
                           .order_by(Deployment.created_at.desc()).limit(1))


async def recent_deployments(db: AsyncSession, env_id, limit: int) -> list[Deployment]:
    return list(await db.scalars(select(Deployment)
                                 .where(Deployment.environment_id == env_id)
                                 .order_by(Deployment.created_at.desc()).limit(limit)))


def rollback_available(dep: Deployment) -> bool:
    """A stopped Update with a pre-deploy dump and a commit to go back to
    (spec: Roll back after a failure in steps 6–11). The route also wants it
    to be the environment's latest deployment."""
    return (dep.mode == "update" and dep.status in ("failed", "cancelled", "interrupted")
            and bool(dep.dump_path) and bool(dep.previous_sha))


async def deployment_summary(db: AsyncSession, dep: Deployment) -> dict:
    return {"id": str(dep.id), "mode": dep.mode, "git_ref": dep.git_ref, "sha": dep.sha,
            "status": dep.status, "start_step": dep.start_step,
            "retry_of": str(dep.retry_of) if dep.retry_of else None,
            "failed_step": dep.failed_step, "dump_path": dep.dump_path,
            "snapshot": await snapshots.snapshot_ref(db, dep.snapshot_id),
            "restore_dump": dep.restore_dump, "rollback_available": rollback_available(dep),
            "publish": dep.publish,
            "vm": dep.vm, "take_vm_snapshot": dep.take_vm_snapshot,
            "vm_snapshot": dep.vm_snapshot,
            "cloud": dep.cloud, "slot": dep.slot, "go_live": dep.go_live,
            "previous_sha": dep.previous_sha, "error": dep.error,
            "actor_name": await _actor_name(db, dep.actor_id),
            "started_at": dep.started_at, "finished_at": dep.finished_at,
            "created_at": dep.created_at}


async def deployment_out(db: AsyncSession, dep: Deployment, *, environment_name: str,
                         tail: int = LOG_TAIL_DEFAULT) -> dict:
    steps = await db.scalars(select(DeploymentStep)
                             .where(DeploymentStep.deployment_id == dep.id)
                             .order_by(DeploymentStep.number)
                             .execution_options(populate_existing=True))
    return {**await deployment_summary(db, dep), "environment": environment_name,
            "steps": [{"number": s.number, "key": s.key, "name": s.name, "status": s.status,
                       "started_at": s.started_at, "finished_at": s.finished_at,
                       "log_size": len(s.log), "log_tail": s.log[-tail:] if tail > 0 else ""}
                      for s in steps]}


async def managed_records_out(db: AsyncSession, env_id) -> list[dict]:
    """What Sirdar manages for the environment in Cloudflare and NPM (names
    and origins only)."""
    rows = await db.scalars(select(ManagedRecord).where(ManagedRecord.environment_id == env_id)
                            .order_by(ManagedRecord.service, ManagedRecord.kind))
    return [{"service": r.service, "kind": r.kind, "name": r.name, "origin": r.origin}
            for r in rows]


async def _do_out(db: AsyncSession, env: Environment) -> dict | None:
    """A DigitalOcean environment's `do` block (no secrets), else None."""
    if env.target_id != targets.DO_TARGET:
        return None
    from sirdar_api.db.models import DoAccount
    from sirdar_api.deploy import do_envs
    row = await do_envs.get(db, env.id)
    if row is None:
        return None
    account = await db.get(DoAccount, row.account_key)
    return do_envs.public(env, row, await do_envs.slots_of(db, env.id),
                          await do_envs.resources_of(db, env.id), account.label)


async def environment_out(db: AsyncSession, env: Environment) -> dict:
    services = await services_of(db, env.id)
    keys = await secret_keys_of(db, env.id)
    last = await latest_deployment(db, env.id)
    on_vm = targets.is_vm_target(env.target_id)
    vm = await vms.get_for(db, env) if on_vm else None
    return {
        "id": str(env.id), "name": env.name, "type": env.type, "target": env.target_id,
        "target_kind": env.target_id if targets.is_built_target(env.target_id) else "ssh",
        "vm": vms.public(vm) if vm is not None else None,
        "do": await _do_out(db, env), "slots": list(env.slots),
        "active_slot": env.active_slot, "auto_activate": env.auto_activate,
        "retiring": env.retiring,
        "base_domain": env.base_domain, "env_dir": envfile.env_dir(env.name),
        "git_ref": env.git_ref, "current_sha": env.current_sha, "image_tag": env.image_tag,
        "status": env.status, "proxy_ip": env.proxy_ip, "bind_ip": env.bind_ip,
        "keep_dumps": env.keep_dumps, "spaces_bucket": env.spaces_bucket,
        "log_level": env.log_level,
        "services": [{"service": r.service, "host_ip": r.host_ip, "port": r.port,
                      "hostname": r.hostname, "proxied": r.proxied} for r in services],
        "secrets_set": {k: k in keys for k in envfile.OPTIONAL_SECRETS},
        "seed_snapshot": await snapshots.snapshot_ref(db, env.seed_snapshot_id),
        "publish": env.publish,
        "managed_records": await managed_records_out(db, env.id),
        "last_deployment": await deployment_summary(db, last) if last else None,
        "created_at": env.created_at, "updated_at": env.updated_at,
    }
