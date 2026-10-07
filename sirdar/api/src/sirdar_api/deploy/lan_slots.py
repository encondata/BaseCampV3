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
from sirdar_api.db.models import Environment, VmSlot
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
