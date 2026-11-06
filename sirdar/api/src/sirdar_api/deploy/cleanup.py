"""After a cleanup succeeds (Delete's steps, the environment kept): reset it
to never deployed. What a build recorded goes: the commit, the live slot,
each slot's commit and smoke test, the droplets' and VMs' ids and learned
addresses, DigitalOcean's step-0 addresses and bucket key, the VM snapshot
records, and the pins for those addresses. A host key a fresh build
delivers is made again, the first admin is pending again, and what the user
set (sizes, static addresses, apps, mail, services' ports and names,
secrets) stays. A saved SSH target's host and pin are the user's: never
touched. Every write is in the caller's session; the caller audits and
commits, so a failure leaves the environment as it was."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import (
    Deployment,
    DoEnvironment,
    DoSlot,
    Environment,
    EnvironmentService,
    EsxiVm,
)
from sirdar_api.deploy import do_envs, first_admins, known_hosts, lan_slots, targets, vault, vms

# Where every service points before step 0 has read an address (environments._insert).
UNSET_HOST = "0.0.0.0"
# What DigitalOcean's step 0 learns (VPC range, load balancer, database,
# the bucket's own key, certificate expiry). The account, team, sizes, SSH
# key pair and ACME key are frozen at create and stay.
_DO_LEARNED = ("vpc_ip_range", "lb_ip", "db_host", "db_port", "db_admin_password_enc",
               "db_ca_cert", "spaces_key_id", "spaces_secret_enc", "cert_not_after")


async def reset(db: AsyncSession, settings: Settings, env: Environment, *,
                actor_id: uuid.UUID | None = None) -> None:
    """`actor_id`: who ran the cleanup, for the pin-forget audit rows."""
    now = datetime.now(UTC)
    env.current_sha, env.image_tag, env.active_slot = None, None, None
    env.updated_at = now
    saved = {cfg.host for _, cfg in targets.ssh_configs(settings)}
    if env.target_id == targets.DO_TARGET:
        await _reset_do(db, settings, env, saved, now, actor_id)
    elif targets.is_vm_target(env.target_id):
        await _reset_vms(db, settings, env, saved, now, actor_id)
    await first_admins.reset(db, env.id)
    await db.flush()


async def _forget(db: AsyncSession, ips, saved: set[str], target_id: str,
                  actor_id: uuid.UUID | None) -> None:
    for ip in sorted(set(ips) - saved):
        await known_hosts.forget(db, ip, vms.VM_SSH_PORT, actor_id, target_id=target_id)


async def _reset_do(db: AsyncSession, settings: Settings, env: Environment, saved: set[str],
                    now: datetime, actor_id: uuid.UUID | None) -> None:
    slots = await do_envs.slots_of(db, env.id)
    ips = {r.public_ip for r in slots.values() if r.public_ip}
    # Step 18 forgot these unless another environment's droplet has the address.
    others = set(await db.scalars(select(DoSlot.public_ip).where(
        DoSlot.environment_id != env.id, DoSlot.public_ip.in_(ips or {""}))))
    await _forget(db, ips - others, saved, "digitalocean", actor_id)
    for slot, row in slots.items():
        row.droplet_id = row.public_ip = row.private_ip = None
        row.sha = row.image_tag = row.last_check_ok = row.last_check_at = None
        if row.host_key_private_enc is None:
            # Delivered to a droplet that is gone: the next droplet gets a new one.
            private, public = vms.new_host_keypair(f"{env.name}-{slot}")
            row.host_key_public = public
            row.host_key_private_enc = vault.encrypt(settings, private)
        row.updated_at = now
    await db.execute(update(DoEnvironment).where(DoEnvironment.environment_id == env.id)
                     .values(**dict.fromkeys(_DO_LEARNED), updated_at=now))


async def _reset_vms(db: AsyncSession, settings: Settings, env: Environment, saved: set[str],
                     now: datetime, actor_id: uuid.UUID | None) -> None:
    machines = await vms.machines(db, env)
    # Step 0 refuses a saved SSH target's address, so these are only ever the VMs'.
    await _forget(db, {m.ip for m in machines if m.ip}, saved, f"{env.target_id}:{env.name}",
                  actor_id)
    for vm in machines:
        if isinstance(vm, EsxiVm):
            vm.moref = vm.instance_uuid = vm.vm_path = None
            if vm.host_key_private_enc is None:
                # Delivered to a VM that is gone (as on DigitalOcean): cloud-init
                # gives the next VM a new one, so its fingerprint is known first.
                private, public = vms.new_host_keypair(env.name)
                vm.host_key_public = public
                vm.host_key_private_enc = vault.encrypt(settings, private)
        else:
            vm.vmid = None
        vm.created = False
        if vms.static_ip(vm.ip_cidr) is None:
            vm.ip = None                               # DHCP: the next VM's lease
        vm.updated_at = now
    # The VMs' snapshots went with them (vm_restore rows name a snapshot to
    # restore, not one taken: recorded_snapshots skips them).
    await db.execute(update(Deployment).where(
        Deployment.environment_id == env.id, Deployment.vm_snapshot.is_not(None),
        Deployment.mode != "vm_restore").values(vm_snapshot=None))
    by_role = {m.role: m for m in machines}
    services = update(EnvironmentService).where(EnvironmentService.environment_id == env.id)
    if lan_slots.is_bluegreen(env):
        for row in (await lan_slots.slots_of(db, env.id)).values():
            row.sha = row.image_tag = row.last_check_ok = row.last_check_at = None
            row.updated_at = now
        # As created: the services on orange, spaces on the data VM.
        first = by_role.get(lan_slots.SLOTS[0])
        data = by_role.get(vms.DATA)
        await db.execute(services.where(EnvironmentService.service != "spaces").values(
            host_ip=(vms.static_ip(first.ip_cidr) if first else None) or UNSET_HOST))
        await db.execute(services.where(EnvironmentService.service == "spaces").values(
            host_ip=(vms.static_ip(data.ip_cidr) if data else None) or UNSET_HOST))
    else:
        main = by_role.get(vms.MAIN)
        await db.execute(services.values(
            host_ip=(vms.static_ip(main.ip_cidr) if main else None) or UNSET_HOST))
