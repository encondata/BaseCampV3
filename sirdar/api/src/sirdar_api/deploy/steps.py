"""The deploy steps (spec Section 2) and the plan each mode runs.

Numbers follow the spec's order: 8 starts the data services, 9 restores
data and 10 ("Start services": `ss-stack up` runs migrate, then the app)
covers spec steps 10–11. Restore snapshot and Restore backup share number
9 and never meet in one plan. Take snapshot (11) is a job of its own.

12–14 publish (DNS records, proxy hosts, smoke test). They run in Sirdar
itself (runs="python", see publish.py) and a deployment has them when it
publishes; a "publish" deployment is only them. Delete environment
("teardown") runs 15 (stacks and folder on the host, an Ansible playbook),
then 16 and 17 (the proxy hosts and DNS records Sirdar made).

A VM environment (vm=True; Proxmox or ESXi) builds its host first: 0 Prepare VM
(runs="vm", see vmsteps.py) starts its update / reset / restore_dump /
rollback plans; its Delete runs 15 Destroy VM instead of 15 Remove
environment; and only it has "vm_restore", a plan of 0 Restore VM snapshot
alone. Steps with the same number never meet in one plan.

A DigitalOcean environment (deploy phase 7) has its own "vm" steps: 0 Prepare
DigitalOcean, 14 Switch traffic and 18 Remove DigitalOcean resources (see
do_provision.py), and 13 Smoke test (slot), a playbook that checks each
public name through Caddy on the slot's droplet.

A DigitalOcean environment (cloud=True) has plans of its own: 0 Prepare
DigitalOcean builds what is missing; the host steps run on the slot's
droplet; 12 DNS records point at the load balancer; 13 Smoke test (slot)
checks the slot through Caddy on the droplet; 14 Switch traffic moves the
load balancer to the slot (a first deploy, a one-slot environment, an
auto-activating one, or Activate). Activate is 13 then 14; Deactivate (a
retiring production, no slot) is 14 alone. Delete is [11 Take snapshot], 17
Remove DNS records, 18 Remove DigitalOcean resources. Reset, Restore backup, Roll
back and Restore VM snapshot have no DigitalOcean plan."""

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

PLAYBOOK_DIR = Path(__file__).resolve().parent / "ansible"
MODES = ("update", "reset", "snapshot", "restore_dump", "rollback", "publish", "teardown",
         "vm_restore", "activate")
# Modes that change what runs on the host: they publish afterwards when asked.
PUBLISHING_MODES = ("update", "reset", "restore_dump", "rollback")
PUBLISH_KEYS = ("dns", "proxy", "smoke")
# A VM environment's modes that start with 0 Prepare VM.
VM_HOST_MODES = ("update", "reset", "restore_dump", "rollback")


@dataclass(frozen=True)
class StepDef:
    number: int
    key: str
    name: str
    playbook: str                # "" for a step that runs in Sirdar
    timeout: int                 # seconds for the whole step
    runs: Literal["ansible", "python", "vm"] = "ansible"


STEPS: tuple[StepDef, ...] = (
    StepDef(0, "provision", "Prepare VM", "", 30 * 60, "vm"),
    StepDef(0, "vm_restore", "Restore VM snapshot", "", 30 * 60, "vm"),
    StepDef(0, "do_prepare", "Prepare DigitalOcean", "", 60 * 60, "vm"),
    StepDef(1, "preflight", "Preflight", "preflight.yml", 5 * 60),
    StepDef(2, "bootstrap", "Bootstrap", "bootstrap.yml", 30 * 60),
    StepDef(3, "fetch", "Fetch code", "fetch.yml", 15 * 60),
    StepDef(4, "render", "Render config", "render.yml", 5 * 60),
    StepDef(5, "build", "Build images", "build.yml", 90 * 60),
    StepDef(6, "dump", "Pre-deploy dump", "dump.yml", 30 * 60),
    StepDef(7, "reset", "Reset data", "reset.yml", 15 * 60),
    StepDef(8, "data", "Start data services", "data.yml", 15 * 60),
    StepDef(9, "restore", "Restore snapshot", "restore.yml", 120 * 60),
    StepDef(9, "restore_dump", "Restore backup", "restore_dump.yml", 60 * 60),
    StepDef(10, "up", "Start services", "up.yml", 45 * 60),
    StepDef(11, "export", "Take snapshot", "export.yml", 120 * 60),
    StepDef(12, "dns", "DNS records", "", 10 * 60, "python"),
    StepDef(13, "proxy", "Proxy hosts", "", 45 * 60, "python"),
    StepDef(13, "slot_smoke", "Smoke test (slot)", "slot_smoke.yml", 10 * 60),
    StepDef(14, "smoke", "Smoke test", "", 10 * 60, "python"),
    StepDef(14, "go_live", "Switch traffic", "", 15 * 60, "vm"),
    StepDef(15, "teardown", "Remove environment", "teardown.yml", 30 * 60),
    StepDef(15, "destroy", "Destroy VM", "", 30 * 60, "vm"),
    StepDef(16, "unproxy", "Remove proxy hosts", "", 15 * 60, "python"),
    StepDef(17, "undns", "Remove DNS records", "", 10 * 60, "python"),
    StepDef(18, "do_destroy", "Remove DigitalOcean resources", "", 60 * 60, "vm"),
)
STEPS_BY_KEY = {s.key: s for s in STEPS}
ANSIBLE_STEPS = tuple(s for s in STEPS if s.runs == "ansible")

_BUILD = ("preflight", "bootstrap", "fetch", "render", "build")
# (mode, restores a snapshot) -> step keys, in order.
_PLANS: dict[tuple[str, bool], tuple[str, ...]] = {
    ("update", False): (*_BUILD, "dump", "up"),
    # the first deploy of an environment created from a snapshot; the dump
    # backs up a database already on the host (not required: usually none)
    # before ss-stack restore drops it
    ("update", True): (*_BUILD, "dump", "data", "restore", "up"),
    ("reset", False): (*_BUILD, "reset", "up"),
    ("reset", True): (*_BUILD, "reset", "data", "restore", "up"),
    # The deployed commit (current_sha) again, rendered with Sirdar's stored
    # keys: a failed Update may have left repo/ and .env at another commit,
    # and a failed restoring Reset the snapshot's keys in .env. Build is cached.
    ("restore_dump", False): ("preflight", "fetch", "render", "build", "data", "restore_dump",
                              "up"),
    # the previous commit, with the failed deployment's pre-deploy dump
    ("rollback", False): ("preflight", "fetch", "render", "build", "data", "restore_dump", "up"),
    ("snapshot", False): ("preflight", "export"),
    ("publish", False): PUBLISH_KEYS,
    # the host first: nothing is unpublished while the environment still runs
    ("teardown", False): ("teardown", "unproxy", "undns"),
    ("vm_restore", False): ("vm_restore",),
}


_CLOUD_BUILD = ("do_prepare", *_BUILD)
# (mode, restores or takes a snapshot) -> step keys of a DigitalOcean plan.
_CLOUD_PLANS: dict[tuple[str, bool], tuple[str, ...]] = {
    ("update", False): (*_CLOUD_BUILD, "dump", "up", "dns", "slot_smoke"),
    ("update", True): (*_CLOUD_BUILD, "dump", "restore", "up", "dns", "slot_smoke"),
    ("snapshot", False): ("preflight", "export"),
    ("publish", False): ("dns",),
    ("teardown", False): ("undns", "do_destroy"),
    ("teardown", True): ("export", "undns", "do_destroy"),
    ("activate", False): ("slot_smoke", "go_live"),
}


def _cloud_plan(mode: str, *, restore: bool, publish: bool, vm: bool, go_live: bool,
                snapshot: bool, smoke: bool = True) -> tuple[str, ...]:
    if publish or vm:
        raise ValueError("a DigitalOcean plan has its own DNS step and no VM steps")
    key = (mode, snapshot if mode == "teardown" else restore)
    if key not in _CLOUD_PLANS:
        raise ValueError(f"no DigitalOcean plan for mode {mode!r}")
    keys = _CLOUD_PLANS[key]
    if not smoke:
        if mode != "activate":
            raise ValueError("only Deactivate skips the slot smoke test")
        return ("go_live",)                     # Deactivate: no slot to test
    if go_live and mode != "activate":
        if mode != "update":
            raise ValueError(f"mode {mode!r} doesn't switch traffic")
        keys = (*keys, "go_live")
    return keys


def plan_for(mode: str, *, restore: bool = False, publish: bool = False, vm: bool = False,
             cloud: bool = False, go_live: bool = False, snapshot: bool = False,
             smoke: bool = True) -> list[StepDef]:
    if cloud:
        keys = _cloud_plan(mode, restore=restore, publish=publish, vm=vm, go_live=go_live,
                           snapshot=snapshot, smoke=smoke)
        return [STEPS_BY_KEY[k] for k in keys]
    if mode == "activate":
        raise ValueError("only a DigitalOcean environment activates a slot")
    if go_live or snapshot:
        raise ValueError("only a DigitalOcean plan switches traffic or snapshots on delete")
    if not smoke:
        raise ValueError("only Deactivate skips the slot smoke test")
    try:
        keys = _PLANS[(mode, restore)]
    except KeyError:
        raise ValueError(f"no deploy plan for mode {mode!r} (restore={restore})") from None
    if mode == "vm_restore" and not vm:
        raise ValueError("only a VM environment restores a VM snapshot")
    if vm and mode in VM_HOST_MODES:
        keys = ("provision", *keys)
    elif vm and mode == "teardown":
        keys = ("destroy", *keys[1:])           # the VM goes, with everything on it
    if publish:
        if mode not in PUBLISHING_MODES:
            raise ValueError(f"mode {mode!r} doesn't publish")
        keys = (*keys, *PUBLISH_KEYS)
    return [STEPS_BY_KEY[k] for k in keys]
