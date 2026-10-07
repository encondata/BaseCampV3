"""Terraform for Proxmox environments (phase 5, step 0 and Destroy VM).

One working folder per VM: SIRDAR_TERRAFORM_DIR/<environment id>/ (a
Blue/Green VM: <environment id>-<role>/; mode 700, never served):
main.tf.json (rendered here, no secret in it), the pinned Proxmox
certificate, the state and .terraform/. Terraform runs with
an allowlisted environment; the API token reaches it only as
PROXMOX_VE_API_TOKEN, never in a file or on its command line. Its TLS trust
is the pinned certificate alone (SSL_CERT_FILE, and SSL_CERT_DIR pointed at
an empty folder). The provider comes from the image's filesystem mirror
(TF_CLI_CONFIG_FILE), so `init` never goes online.

The pipeline depends only on the TerraformRunner protocol; tests use
FakeTerraform, and conftest's guard refuses to start any binary but a
fake-* script (_spawn is the one place a process starts)."""

import asyncio
import json
import logging
import os
import shutil
import signal
import uuid
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

from sirdar_api.config import Settings
from sirdar_api.deploy import tls_pin

TERRAFORM_VERSION = "1.16.5"
PROVIDER_VERSION = "0.115.0"
VM_USER = "deploy"
PLAN_FILE = "tfplan"
INIT = ("init", "-input=false", "-no-color")
# Step 0 plans, reads the plan (refusing any delete) and applies exactly that
# plan; only step 15's DESTROY removes a VM.
PLAN = ("plan", "-input=false", "-no-color", f"-out={PLAN_FILE}")
SHOW = ("show", "-json", "-no-color", PLAN_FILE)
APPLY = ("apply", "-input=false", "-no-color", PLAN_FILE)
DESTROY = ("destroy", "-input=false", "-no-color", "-auto-approve")
APPLY_TIMEOUT = 25 * 60            # inside the step's 30 minutes
_INHERITED_ENV = ("PATH", "LANG", "TZ")
# The longest output line read whole (a provider's debug or plan line can be
# long); a longer one is dropped in pieces, and reading goes on.
_LINE_LIMIT = 1024 * 1024

log = logging.getLogger(__name__)


class TerraformDirUnwritable(PermissionError):
    """SIRDAR_TERRAFORM_DIR can't be written (not owned by uid 10001?)."""


class PinnedCertificateInvalid(ValueError):
    """The pinned Proxmox certificate isn't exactly one PEM certificate. An
    empty or unreadable SSL_CERT_FILE would let Terraform fall back to the
    system's trust, so it is refused before anything is written."""


@dataclass(frozen=True)
class VmSpec:
    env_name: str
    name: str
    vmid: int
    node: str
    pool: str
    storage: str
    bridge: str
    vlan_tag: int | None
    template_vmid: int
    cores: int
    memory_mb: int
    disk_gb: int
    ip_cidr: str | None            # None: DHCP
    gateway: str | None
    ssh_public_key: str


def render_config(url: str, spec: VmSpec) -> dict:
    """main.tf.json: one full clone of the template, sized and on the bridge,
    with cloud-init for the deploy user and the address."""
    ipv4 = ({"address": spec.ip_cidr, "gateway": spec.gateway} if spec.ip_cidr
            else {"address": "dhcp"})
    network: dict = {"bridge": spec.bridge, "model": "virtio"}
    if spec.vlan_tag is not None:
        network["vlan_id"] = spec.vlan_tag
    vm = {
        "name": spec.name, "node_name": spec.node, "vm_id": spec.vmid, "pool_id": spec.pool,
        "tags": ["sirdar", spec.name],
        "description": f"Managed by Sirdar (environment {spec.env_name}). Change or delete it "
                       "from Sirdar, not here.",
        "started": True, "on_boot": True, "stop_on_destroy": True, "purge_on_destroy": True,
        "clone": {"vm_id": spec.template_vmid, "full": True, "node_name": spec.node,
                  "datastore_id": spec.storage},
        "agent": {"enabled": True, "trim": True, "timeout": "5m"},
        "cpu": {"cores": spec.cores, "type": "host"},
        "memory": {"dedicated": spec.memory_mb},
        "scsi_hardware": "virtio-scsi-single",
        "disk": [{"datastore_id": spec.storage, "interface": "scsi0", "size": spec.disk_gb,
                  "discard": "on", "iothread": True, "ssd": True}],
        "network_device": [network],
        "operating_system": {"type": "l26"},
        "initialization": {"datastore_id": spec.storage,
                           "user_account": {"username": VM_USER, "keys": [spec.ssh_public_key]},
                           "ip_config": [{"ipv4": ipv4}]},
        # The clone fields force a new VM in bpg/proxmox. They only matter at
        # create (and are frozen in proxmox_vms anyway): never act on them.
        "lifecycle": {"ignore_changes": ["clone"]},
    }
    return {
        "terraform": {"required_version": f"= {TERRAFORM_VERSION}",
                      "required_providers": {"proxmox": {"source": "bpg/proxmox",
                                                         "version": f"= {PROVIDER_VERSION}"}}},
        "provider": {"proxmox": {"endpoint": url, "insecure": False}},
        "resource": {"proxmox_virtual_environment_vm": {"vm": vm}},
    }


def plan_deletes(plan) -> bool:
    """Whether `terraform show -json` output plans to delete anything (a
    destroy, or a replace: "delete" + "create" either way round).
    ValueError when it isn't the shape Terraform writes."""
    if not isinstance(plan, dict):
        raise ValueError("not a plan")
    changes = plan.get("resource_changes") or []
    if not isinstance(changes, list):
        raise ValueError("not a plan")
    for change in changes:
        actions = (change.get("change") or {}).get("actions") if isinstance(change, dict) \
            else None
        if not isinstance(actions, list):
            raise ValueError("not a plan")
        if "delete" in actions:
            return True
    return False


def workdir(settings: Settings, env_id: uuid.UUID, role: str = "main") -> Path:
    name = str(env_id) if role == "main" else f"{env_id}-{role}"
    return Path(settings.terraform_dir) / name


def _private_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def _write_private(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def prepare_workdir(settings: Settings, env_id: uuid.UUID, config: dict, ca_pem: str,
                    role: str = "main") -> Path:
    """Write this run's config and pinned certificate; keep the state and
    .terraform/. A crash log or a plan from an earlier run is removed. The pin must
    be exactly one certificate (PinnedCertificateInvalid otherwise)."""
    try:
        tls_pin.load_one(ca_pem)
    except ValueError:
        raise PinnedCertificateInvalid(
            "The pinned Proxmox certificate isn't one valid certificate.") from None
    try:
        _private_dir(Path(settings.terraform_dir))
        work = workdir(settings, env_id, role)
        _private_dir(work)
        _private_dir(work / "home")
        _private_dir(work / "ca")                       # empty: SSL_CERT_DIR
        _write_private(work / "main.tf.json", json.dumps(config, indent=2))
        _write_private(work / "proxmox-ca.pem", ca_pem)
        (work / "crash.log").unlink(missing_ok=True)
        (work / PLAN_FILE).unlink(missing_ok=True)      # a plan is applied by its own run
    except PermissionError:
        raise TerraformDirUnwritable() from None
    return work


def needs_init(work: Path) -> bool:
    return not (work / ".terraform").is_dir()


def has_state(work: Path) -> bool:
    """Whether the state records any resource (a VM to destroy)."""
    try:
        state = json.loads((work / "terraform.tfstate").read_text())
    except (OSError, ValueError):
        return False
    return bool(state.get("resources"))


def remove_workdir(settings: Settings, env_id: uuid.UUID, role: str = "main") -> None:
    shutil.rmtree(workdir(settings, env_id, role), ignore_errors=True)


def run_env(settings: Settings, work: Path, token: str) -> dict[str, str]:
    env = {k: os.environ[k] for k in _INHERITED_ENV if k in os.environ}
    env.update({
        "HOME": str(work / "home"),
        "TF_CLI_CONFIG_FILE": settings.terraform_cli_config,
        "TF_IN_AUTOMATION": "1",
        "TF_INPUT": "0",
        "CHECKPOINT_DISABLE": "1",
        "SSL_CERT_FILE": str(work / "proxmox-ca.pem"),
        "SSL_CERT_DIR": str(work / "ca"),
        "PROXMOX_VE_API_TOKEN": token,
    })
    return env


@dataclass(frozen=True)
class TfRequest:
    args: tuple[str, ...]
    workdir: Path
    env: dict = field(repr=False)
    timeout: int


@dataclass(frozen=True)
class TfResult:
    status: Literal["successful", "failed", "timeout"]
    rc: int


class TerraformRunner(Protocol):
    async def run(self, request: TfRequest,
                  on_output: Callable[[str], None]) -> TfResult: ...


async def _spawn(argv: list[str], *, cwd: Path, env: dict) -> asyncio.subprocess.Process:
    """The one place a Terraform process starts (tests guard it)."""
    return await asyncio.create_subprocess_exec(
        *argv, cwd=str(cwd), env=env, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        start_new_session=True, limit=_LINE_LIMIT)


class SubprocessTerraform:
    """Runs the terraform binary. Output goes to on_output line by line (the
    caller redacts). A timeout or cancel sends SIGINT, Terraform's graceful
    stop (it saves the state), and kills after `grace` seconds."""

    def __init__(self, binary: str = "terraform", grace: float = 30):
        self.binary = binary
        self.grace = grace

    async def _stop(self, proc: asyncio.subprocess.Process) -> None:
        """Like Ctrl-C in a terminal: SIGINT to the whole process group
        (Terraform and its provider plugins; _spawn starts a new session),
        then SIGKILL to the group after the grace period. The SIGKILL is
        unconditional (finally): a second cancel during the grace wait, or
        a plugin left behind after Terraform exits, still gets it."""
        if proc.returncode is not None:
            return
        with suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGINT)
        try:
            with suppress(TimeoutError):
                await asyncio.wait_for(proc.wait(), self.grace)
        finally:
            with suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)
        await proc.wait()

    async def run(self, request: TfRequest,
                  on_output: Callable[[str], None]) -> TfResult:
        proc = await _spawn([self.binary, *request.args], cwd=request.workdir, env=request.env)

        async def pump() -> None:
            """Drains the pipe to the end whatever happens to a line: a full
            pipe would stall Terraform. A failing on_output is logged once,
            by exception type only (its message could carry output)."""
            reported = False
            while True:
                try:
                    line = await proc.stdout.readline()
                except ValueError:              # longer than _LINE_LIMIT: dropped
                    continue
                if not line:
                    return
                try:
                    on_output(line.decode(errors="replace"))
                except Exception as exc:
                    if not reported:
                        reported = True
                        log.warning("Terraform output handler failed (%s); output "
                                    "keeps draining", type(exc).__name__)

        reader = asyncio.ensure_future(pump())
        try:
            await asyncio.wait_for(asyncio.shield(proc.wait()), request.timeout)
        except TimeoutError:
            await self._stop(proc)
            with suppress(Exception):
                await asyncio.wait_for(reader, 5)
            return TfResult(status="timeout", rc=-1)
        except asyncio.CancelledError:
            try:
                await self._stop(proc)
            finally:
                reader.cancel()
            raise
        with suppress(Exception):
            await asyncio.wait_for(reader, 5)
        return TfResult(status="successful" if proc.returncode == 0 else "failed",
                        rc=proc.returncode)
