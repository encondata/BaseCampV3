"""Which host runs an environment's VM steps (0 Prepare VM, 0 Restore VM
snapshot, 15 Destroy VM, or DigitalOcean's steps 0, 14 and 18): the one its
target names. The pipeline calls prepare() and one HostProvisioner; each
host's module does the work (provision.py for Proxmox, esxi_provision.py for
ESXi, do_provision.py for DigitalOcean). A LAN Blue/Green environment's step
runs on each of its VMs in turn (LanContext)."""

import uuid
from dataclasses import dataclass, replace

from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Deployment, Environment
from sirdar_api.deploy import do_provision, esxi_provision, lan_slots, provision, targets, vms
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.vmcommon import Output, Provisioner, VmOutcome, VmPrepareError

# The data VM after the app VMs on Destroy: nothing is left using it.
DESTROY_ORDER = ("purple", "orange", vms.DATA)


HostVmContext = provision.VmContext | esxi_provision.EsxiVmContext


@dataclass(frozen=True)
class LanContext:
    """A LAN Blue/Green environment's VM step: one context per VM, in order
    (step 0: the data VM, then the deployment's slot; Destroy: purple,
    orange, data)."""
    env_id: uuid.UUID
    machines: tuple[HostVmContext, ...]

    @property
    def secret_values(self) -> list[str]:
        return [v for m in self.machines for v in m.secret_values]


VmContext = (provision.VmContext | esxi_provision.EsxiVmContext | do_provision.DoContext
             | LanContext)


async def _lan_prepare(db: AsyncSession, env: Environment, dep: Deployment,
                       settings: Settings) -> LanContext:
    host_prepare = (esxi_provision.prepare if env.target_id == targets.ESXI_TARGET
                    else provision.prepare)
    if dep.mode == "vm_restore":
        raise VmPrepareError("A Blue/Green environment has no VM snapshots to restore. "
                             "Activate the other server to go back.")
    if dep.mode == "teardown":
        present = {m.role for m in await vms.machines(db, env)}
        machines = [await host_prepare(db, env, dep, settings, role=role, services=(),
                                       resolve=False)
                    for role in DESTROY_ORDER if role in present]
    else:
        if dep.slot not in lan_slots.SLOTS:
            raise VmPrepareError("This deployment names no server to build.")
        # The data VM's address moves only spaces (its SeaweedFS); an app
        # VM's moves nothing: Switch traffic points the app services. Once
        # built, the data VM is never re-applied, resized or snapshotted by
        # an Update (as_built): both app VMs' database lives on it.
        machines = [await host_prepare(db, env, dep, settings, role=vms.DATA,
                                       services=("spaces",), resolve=False, as_built=True),
                    await host_prepare(db, env, dep, settings, role=dep.slot, services=(),
                                       resolve=True)]
    # No VM snapshots on Blue/Green: the other slot is the way back.
    return LanContext(env_id=env.id, machines=tuple(
        replace(m, take_snapshot=False, vm_snapshot=None) for m in machines))


async def prepare(db: AsyncSession, env: Environment, dep: Deployment,
                  settings: Settings) -> VmContext:
    if lan_slots.is_bluegreen(env):
        return await _lan_prepare(db, env, dep, settings)
    if env.target_id == targets.DO_TARGET:
        return await do_provision.prepare(db, env, dep, settings)
    if env.target_id == targets.ESXI_TARGET:
        return await esxi_provision.prepare(db, env, dep, settings)
    if env.target_id == targets.PROXMOX_TARGET:
        return await provision.prepare(db, env, dep, settings)
    raise VmPrepareError("This environment isn't on a VM host, so it has no VM steps.")


class HostProvisioner:
    """Runs a VM step on the host its context belongs to: a DoContext on
    DigitalOcean, an EsxiVmContext on ESXi, a Proxmox VmContext on Proxmox.
    Anything else is refused, never handed to Proxmox by default."""

    def __init__(self, *, proxmox: Provisioner, esxi: Provisioner | None = None,
                 digitalocean: Provisioner | None = None):
        self._proxmox = proxmox
        self._esxi = esxi
        self._do = digitalocean

    async def run(self, step: str, ctx, out: Output) -> VmOutcome:
        if isinstance(ctx, LanContext):
            if step == "destroy":
                await self._destroy_lan(ctx, out)
                return VmOutcome()
            # Each VM in order; the outcome is the slot's commit (the data VM
            # resolves nothing), never a VM snapshot (Blue/Green takes none).
            sha = None
            for machine in ctx.machines:
                out(f"— {machine.vm.name} —\n")
                got = await self.run(step, machine, out)
                sha = got.sha or sha
            return VmOutcome(sha=sha)
        if isinstance(ctx, do_provision.DoContext):
            if self._do is None:
                raise VmPrepareError("DigitalOcean steps can't run here.")
            return await self._do.run(step, ctx, out)
        if isinstance(ctx, esxi_provision.EsxiVmContext):
            if self._esxi is None:
                raise VmPrepareError("ESXi steps can't run here.")
            return await self._esxi.run(step, ctx, out)
        if isinstance(ctx, provision.VmContext):
            return await self._proxmox.run(step, ctx, out)
        raise VmPrepareError("This environment isn't on a VM host, so it has no VM steps.")

    async def _destroy_lan(self, ctx: LanContext, out: Output) -> None:
        """Every app VM, even after one fails; the data VM only when no app VM
        is left using it. One failure at the end names each VM."""
        failed: list[str] = []
        skipped: list[str] = []
        for machine in ctx.machines:
            vm = machine.vm
            out(f"— {vm.name} —\n")
            if vm.role == vms.DATA and failed:
                out(f"Kept {vm.name}: an app VM is still there.\n")
                skipped.append(vm.name)
                continue
            try:
                await self.run("destroy", machine, out)
            except StepFailed as e:
                out(f"{e.reason}\n")
                failed.append(f"{vm.name}: {e.reason}")
        if failed:
            kept = (f" Sirdar kept {', '.join(skipped)}, which the app VMs use, until they are "
                    "gone." if skipped else "")
            raise StepFailed(f"Sirdar couldn't remove every VM. {' '.join(failed)}{kept} "
                             "Fix that, then retry.")
