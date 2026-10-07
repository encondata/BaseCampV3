"""LAN Blue/Green environments' slots (deploy phase 8b): two app VMs
(orange, purple) and a data VM, on ESXi or Proxmox. vm_slots keeps each
slot's commit and last smoke test; the VMs are the proxmox_vms / esxi_vms
rows whose role is the slot. Which slot an Update targets and when it goes
live are DigitalOcean's rules (do_envs.target_slot, do_envs.goes_live).

set_slot writes in its own committed transaction (the pipeline's slot smoke
test records its result whatever happens next)."""

from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Deployment, DeploymentStep, Environment, VmSlot
from sirdar_api.deploy import do_envs, envfile, targets, vms

SLOTS = vms.APP_SLOTS


def is_bluegreen(env: Environment) -> bool:
    return targets.is_vm_target(env.target_id) and len(env.slots or ()) == 2


async def add(db: AsyncSession, env_id, slots) -> None:
    for slot in slots:
        db.add(VmSlot(environment_id=env_id, slot=slot))
    await db.flush()


async def slots_of(db: AsyncSession, env_id) -> dict[str, VmSlot]:
    rows = await db.scalars(select(VmSlot).where(VmSlot.environment_id == env_id)
                            .execution_options(populate_existing=True))
    return {r.slot: r for r in rows}


async def ran(db: AsyncSession, env: Environment) -> bool:
    """Anything live, or a slot whose up step ran: the shared database is
    then seeded (and migrated), so the next Update doesn't seed again."""
    if env.current_sha is not None or env.active_slot is not None:
        return True
    return any(r.sha for r in (await slots_of(db, env.id)).values())


async def set_slot(env_id, slot: str, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(VmSlot).where(VmSlot.environment_id == env_id,
                                             VmSlot.slot == slot)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()


async def after_success(db: AsyncSession, env: Environment, dep) -> None:
    """As do_envs.after_success, for vm_slots: the slot keeps the commit it now
    runs; if traffic moved, it is the active one and its commit the
    environment's. The caller commits."""
    now = datetime.now(UTC)
    slot = await db.get(VmSlot, (env.id, dep.slot), populate_existing=True) if dep.slot else None
    if dep.go_live and dep.mode != "update" and dep.slot and (slot is None or not slot.sha):
        raise do_envs.DoEnvError("slot_not_deployed", slot=dep.slot)
    if dep.mode == "update" and slot is not None:
        slot.sha, slot.image_tag, slot.updated_at = dep.sha, envfile.image_tag(dep.sha), now
    if dep.go_live:
        env.active_slot = dep.slot
        if slot is not None and slot.sha:
            env.current_sha, env.image_tag = slot.sha, slot.image_tag
    env.status, env.updated_at = "ready", now


def public(env: Environment, rows: dict[str, VmSlot], machines: list) -> list[dict]:
    by_role = {m.role: m for m in machines}
    return [{"slot": s, "ip": by_role[s].ip if s in by_role else None,
             "sha": r.sha, "image_tag": r.image_tag, "active": s == env.active_slot,
             "last_check_ok": r.last_check_ok, "last_check_at": r.last_check_at}
            for s in env.slots if (r := rows.get(s)) is not None]


async def slot_ip(env_id, slot: str) -> str | None:
    """The slot VM's recorded address (own session)."""
    async with get_sessionmaker()() as s:
        env = await s.get(Environment, env_id)
        row = await vms.get_for(s, env, slot) if env is not None else None
        return row.ip if row is not None else None


DB_PORT = 5432


def data_ip(machines: list) -> str | None:
    """The data VM's address: its static one (Blue/Green VMs are static)."""
    data = next((m for m in machines if m.role == vms.DATA), None)
    return vms.static_ip(data.ip_cidr) if data is not None else None


def app_ips(machines: list) -> list[str]:
    """The app VMs' static addresses, in slot order."""
    by_role = {m.role: m for m in machines}
    return [vms.static_ip(by_role[s].ip_cidr) for s in SLOTS if s in by_role]


async def env_extra(db: AsyncSession, env: Environment,
                    secrets: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """An app VM's .env keys on top of the usual ones: the data VM's database
    (no TLS on the LAN) and the secret values among them. Objects stay at
    https://spaces.<domain> through NPM, as on a single-server LAN host.
    Raises do_envs.DoEnvError (do_not_ready) when the data VM isn't recorded."""
    from urllib.parse import quote
    host = data_ip(await vms.machines(db, env))
    if host is None:
        raise do_envs.DoEnvError("do_not_ready", missing=["data VM"])
    password = quote(secrets["POSTGRES_PASSWORD"], safe="")
    url = f"postgresql+asyncpg://{do_envs.DB_USER}:{password}@{host}:{DB_PORT}/{do_envs.DB_NAME}"
    extra = {"STACK_EXTERNAL_DATA": "1", "STACK_DB_HOST": host, "STACK_DB_PORT": str(DB_PORT),
             "STACK_DB_NAME": do_envs.DB_NAME, "STACK_DB_USER": do_envs.DB_USER,
             "STACK_DB_SSLMODE": "disable", "SS_DATABASE_URL": url, "SS_DATABASE_SSL": "disable"}
    found = [url]
    if password != secrets["POSTGRES_PASSWORD"]:
        found.append(password)
    return extra, found


async def data_vars(db: AsyncSession, env: Environment, ports: dict[str, int]) -> dict:
    """data_vm.yml's firewall inputs: the app VMs reach Postgres; they and
    Nginx Proxy Manager (the environment's proxy) reach object storage. The
    same addresses and ports as the data VM's .env (the playbook checks)."""
    apps = app_ips(await vms.machines(db, env))
    return {"db_clients": apps, "spaces_clients": [*apps, env.proxy_ip], "db_port": DB_PORT,
            "spaces_port": ports["spaces"], "mailpit_port": ports["mailpit"]}


# publish._roll_back's copy when a proxy host couldn't be put back (a test
# pins it to publish's own text).
PUT_BACK_FAILED = "Sirdar couldn't put"
_SWITCH_ENDED = ("succeeded", "failed", "interrupted", "cancelled")


async def unresolved_switch(db: AsyncSession, env_id) -> str | None:
    """The slot Nginx Proxy Manager may still point at when the environment's
    latest Switch traffic didn't end cleanly, else None. Unclean: Sirdar
    stopped or was canceled during it (the put-back may not have finished),
    it timed out (the same), or it failed and couldn't put every proxy host
    back. A later Switch traffic that succeeds resolves it."""
    row = (await db.execute(
        select(Deployment.slot, Deployment.error, DeploymentStep.status, DeploymentStep.log,
               DeploymentStep.number, DeploymentStep.name)
        .join(DeploymentStep, DeploymentStep.deployment_id == Deployment.id)
        .where(Deployment.environment_id == env_id, DeploymentStep.key == "lan_switch",
               DeploymentStep.status.in_(_SWITCH_ENDED))
        .order_by(Deployment.created_at.desc(), DeploymentStep.finished_at.desc().nulls_last())
        .limit(1))).first()
    if row is None:
        return None
    slot, error, status, text, number, name = row
    if status in ("interrupted", "cancelled"):
        return slot
    if status == "failed" and (PUT_BACK_FAILED in (text or "")
                               or (error or "").startswith(f"Step {number} ({name}) timed out")):
        return slot
    return None
