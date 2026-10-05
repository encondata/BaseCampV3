"""Which VM host runs an environment's VM steps (0 Prepare VM, 0 Restore VM
snapshot, 15 Destroy VM): the one its target names. The pipeline calls
prepare() and one HostProvisioner; each host's module does the work
(provision.py for Proxmox, esxi_provision.py for ESXi)."""

from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import Deployment, Environment
from sirdar_api.deploy import esxi_provision, provision, targets
from sirdar_api.deploy.vmcommon import Output, Provisioner, VmOutcome, VmPrepareError

VmContext = provision.VmContext | esxi_provision.EsxiVmContext


async def prepare(db: AsyncSession, env: Environment, dep: Deployment,
                  settings: Settings) -> VmContext:
    if env.target_id == targets.ESXI_TARGET:
        return await esxi_provision.prepare(db, env, dep, settings)
    if env.target_id == targets.PROXMOX_TARGET:
        return await provision.prepare(db, env, dep, settings)
    raise VmPrepareError("This environment isn't on a VM host, so it has no VM steps.")


class HostProvisioner:
    """Runs a VM step on the host its context belongs to."""

    def __init__(self, *, proxmox: Provisioner, esxi: Provisioner | None = None):
        self._proxmox = proxmox
        self._esxi = esxi

    async def run(self, step: str, ctx, out: Output) -> VmOutcome:
        if isinstance(ctx, esxi_provision.EsxiVmContext):
            if self._esxi is None:
                raise VmPrepareError("ESXi steps can't run here.")
            return await self._esxi.run(step, ctx, out)
        return await self._proxmox.run(step, ctx, out)
