"""What every VM host's steps share (deploy phases 5 and 6): the outcome
and protocol of a provisioner, the address checks under the advisory lock
(a saved SSH target's address is never pinned; a pin made for an address
that then can't be recorded is forgotten), the pin-and-confirm loop over
known_hosts.trust, the VM snapshot record and prune rule (only snapshots
Sirdar recorded, newest kept), and resolving the git ref on the VM. Each
small record is written in its own committed transaction, so a later
failure still knows what exists."""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Deployment, Environment, EnvironmentService
from sirdar_api.deploy import ConnectFailed, gitref, known_hosts, ssh, targets, vault, vms
from sirdar_api.deploy.publish import StepFailed

Output = Callable[[str], None]
TARGETS_UNREADABLE = ("Sirdar can't read the saved SSH targets file, so it can't check that "
                      "the VM's address is free. Fix the file, then retry.")
_REF_REASONS = {
    "ref_not_found": "The repository has no branch, tag or commit named {ref}.",
    "ref_invalid": "{ref} isn't a valid branch, tag or commit.",
    "git_missing": "git isn't installed on the VM.",
    "ref_lookup_failed": "The VM couldn't list the repository's branches and tags.",
}


class VmPrepareError(Exception):
    """The VM steps can't start. `reason` is our own copy."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class VmOutcome:
    sha: str | None = None             # the commit step 0 resolved
    vm_snapshot: str | None = None     # the VM snapshot step 0 took (or kept)


class Provisioner(Protocol):
    async def run(self, step: str, ctx, out: Output) -> VmOutcome: ...


async def tcp_open(host: str, port: int, timeout: float = 3.0) -> bool:
    """Whether something accepts TCP connections at host:port. Tests guard it."""
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    except (OSError, TimeoutError):
        return False
    writer.close()
    with suppress(Exception):
        await writer.wait_closed()
    return True


async def set_vm(model, env_id: uuid.UUID, **values) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(model).where(model.environment_id == env_id)
                        .values(**values, updated_at=datetime.now(UTC)))
        await s.commit()


def _address_taken(ip: str, host_label: str) -> StepFailed:
    return StepFailed(f"The VM came up at {ip}, an address another environment, an SSH "
                      f"target, the proxy or {host_label} already uses. Sirdar recorded nothing "
                      "for it: free the address (or fix the DHCP lease), then retry.")


def _address_refused(ip: str, host_label: str) -> StepFailed:
    return StepFailed(f"{ip} is an address another environment, an SSH target, the proxy or "
                      f"{host_label} already uses, so Sirdar won't give it to a new VM. Sirdar "
                      "created nothing: free the address, or delete this environment and create "
                      "it with another address.")


async def _address_free(s: AsyncSession, settings: Settings, env_id: uuid.UUID, ip: str,
                        host_label: str, *, before_boot: bool = False) -> None:
    """Under the address lock (vms.lock_addresses, held until `s`'s
    transaction ends): StepFailed unless `ip` is free for this environment's
    VM."""
    proxy_ip = await s.scalar(select(Environment.proxy_ip).where(Environment.id == env_id))
    await vms.lock_addresses(s)
    try:
        taken = await vms.address_in_use(s, settings, ip, proxy_ip=proxy_ip or "",
                                         env_id=env_id)
    except vms.VmError:
        raise StepFailed(TARGETS_UNREADABLE) from None
    if taken:
        raise (_address_refused if before_boot else _address_taken)(ip, host_label)


async def check_address(settings: Settings, env_id: uuid.UUID, ip: str, *,
                        host_label: str = "Proxmox", before_boot: bool = False) -> None:
    """Is the address free? Before a new VM is given its static address
    (`before_boot`), and before pinning a key at the address it came up at
    (a DHCP lease can land on an address in use)."""
    async with get_sessionmaker()() as s:
        await _address_free(s, settings, env_id, ip, host_label, before_boot=before_boot)
        await s.rollback()


async def record_address(settings: Settings, model, env_id: uuid.UUID, previous: str | None,
                         ip: str, *, host_label: str = "Proxmox") -> bool:
    """Re-check the address under the lock, then write the VM's address and
    point every service at it in the same transaction. True when a service
    moved."""
    async with get_sessionmaker()() as s:
        await _address_free(s, settings, env_id, ip, host_label)
        if ip != previous:
            await s.execute(update(model).where(model.environment_id == env_id)
                            .values(ip=ip, updated_at=datetime.now(UTC)))
        result = await s.execute(update(EnvironmentService).where(
            EnvironmentService.environment_id == env_id, EnvironmentService.host_ip != ip)
            .values(host_ip=ip))
        await s.commit()
        return result.rowcount > 0


async def recorded_snapshots(env_id: uuid.UUID) -> set[str]:
    """Names of the VM snapshots Sirdar took for this environment."""
    async with get_sessionmaker()() as s:
        return set(await s.scalars(select(Deployment.vm_snapshot).where(
            Deployment.environment_id == env_id, Deployment.vm_snapshot.is_not(None),
            Deployment.mode != "vm_restore")))


async def record_vm_snapshot(deployment_id: uuid.UUID, name: str | None) -> None:
    async with get_sessionmaker()() as s:
        await s.execute(update(Deployment).where(Deployment.id == deployment_id)
                        .values(vm_snapshot=name))
        await s.commit()


def to_prune(names, recorded: set[str], keep: int) -> list[str]:
    """Which snapshots to delete: only sirdar-* ones Sirdar's deployments
    recorded (a snapshot made by hand is never pruned, whatever its name),
    all but the newest `keep`."""
    ours = sorted({n for n in names if n in recorded and vms.valid_snapshot_name(n)},
                  reverse=True)
    return ours[keep:]


async def forget_pin(ip: str, actor_id: uuid.UUID | None, target_id: str) -> bool:
    async with get_sessionmaker()() as s:
        if await known_hosts.forget(s, ip, vms.VM_SSH_PORT, actor_id, target_id=target_id):
            await s.commit()
            return True
    return False


async def confirm_pin(*, ip: str, expected: str, actor_id: uuid.UUID | None, target_id: str,
                      tries: int, poll: int, sleep: Callable[[float], Awaitable[None]],
                      out: Output, how: str, mismatch: str,
                      minutes: int | None = None) -> bool:
    """Pin `expected` for ip:22 with known_hosts.trust, which re-reads the live
    key and refuses a mismatch; retried while SSH isn't up. True when this run
    made the pin (there was none before). `minutes` is the wait the timeout
    message names (by default tries * poll)."""
    port = vms.VM_SSH_PORT
    for _ in range(tries):
        async with get_sessionmaker()() as s:
            stored = await known_hosts.lookup(s, ip, port)
            try:
                if stored is not None and stored.fingerprint_sha256 == expected:
                    await ssh.pinned_host_key(s, ip, port)
                    out(f"SSH host key {expected} is pinned.\n")
                    return False
                await known_hosts.trust(s, ip, port, expected, actor_id, target_id=target_id)
                await s.commit()
                changed = " (it changed)" if stored is not None else ""
                out(f"Pinned {ip}'s SSH host key {expected}, {how}{changed}.\n")
                return stored is None
            except (known_hosts.HostKeyChanged, ssh.HostKeyMismatch):
                raise StepFailed(mismatch) from None
            except ConnectFailed:
                pass                                  # SSH isn't up yet
        await sleep(poll)
    if minutes is None:
        minutes = tries * poll // 60
    raise StepFailed(f"The VM didn't answer SSH at {ip} in {minutes} minutes.")


async def settle_address(settings: Settings, *, model, env_id: uuid.UUID,
                         previous_ip: str | None, ip: str,
                         pin: Callable[[], Awaitable[bool]], actor_id: uuid.UUID | None,
                         target_id: str, out: Output, host_label: str = "Proxmox") -> None:
    """The address the VM came up at: refused at a saved SSH target's or one
    in use, its key pinned (`pin`), then recorded (re-checked under the lock)
    on the VM and every service. A pin this run made is forgotten when the
    record fails."""
    if any(cfg.host == ip for _, cfg in targets.ssh_configs(settings)):
        raise StepFailed(f"{ip} is a saved SSH target's address. Sirdar won't pin a VM's "
                         "key there.")
    await check_address(settings, env_id, ip, host_label=host_label)
    made = await pin()
    try:
        moved = await record_address(settings, model, env_id, previous_ip, ip,
                                     host_label=host_label)
    except StepFailed:
        if made:                       # don't leave a pin for an address not recorded
            await forget_pin(ip, actor_id, target_id)
        raise
    if moved:
        out(f"Every service now points at {ip}.\n")


async def resolve_ref(settings: Settings, resolve, *, env_id: uuid.UUID, git_ref: str,
                      repo_url: str, out: Output, slot: str | None = None) -> str:
    """The commit `git_ref` names, resolved on the VM over its SSH connection
    (on DigitalOcean, `slot`'s droplet; default the active slot, else the first)."""
    async with get_sessionmaker()() as s:
        env = await s.get(Environment, env_id)
        try:
            cfg = await vms.host_config(s, settings, env, slot=slot)
        except (vault.SecretsKeyMissing, vault.SecretUnreadable):
            raise StepFailed("Sirdar can't read the VM's SSH key. Is SIRDAR_SECRETS_KEY the "
                             "one it was made with?") from None
        if cfg is None:
            raise StepFailed("The VM has no recorded address yet. Retry from step 0.")
        try:
            sha = await resolve(cfg, s, repo_url, git_ref)
        except gitref.RefError as e:
            reason = _REF_REASONS.get(e.code, _REF_REASONS["ref_lookup_failed"])
            raise StepFailed(reason.format(ref=git_ref)) from None
        except ConnectFailed as e:
            raise StepFailed(e.reason) from None
        except (ssh.HostKeyUnknown, ssh.HostKeyMismatch):
            raise StepFailed("The VM's SSH host key changed while Sirdar was resolving the "
                             "ref. Retry from step 0.") from None
    out(f"{git_ref} is {sha}.\n")
    return sha
