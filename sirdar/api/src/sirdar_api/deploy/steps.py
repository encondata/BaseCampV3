"""The deploy steps (spec Section 2) and the plan each mode runs.

Numbers follow the spec's order: 8 starts the data services, 9 restores
data and 10 ("Start services": `ss-stack up` runs migrate, then the app)
covers spec steps 10–11. Restore snapshot and Restore backup share number
9 and never meet in one plan. Take snapshot (11) is a job of its own.
11 Create the first admin follows Start services in the first Update of an
environment that starts empty (spec 2026-10-07 §3); it shares 11 with Take
snapshot, which never meets an Update.

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
back and Restore VM snapshot have no DigitalOcean plan. 19 Renew certificate
is Sirdar's backup renewal, a job of its own (renewals.py).

A LAN Blue/Green environment (vm and bluegreen; ESXi or Proxmox, a data VM
and two app VMs) has plans of its own too. Update is 0 Prepare VM (the data
VM, then the slot's), 1–5 on the slot's VM, 6 Pre-deploy dump, 7 Prepare
data VM (on the data VM), [9 Restore snapshot], 10 Start services, [11
Create the first admin], [12 DNS records], 13 Smoke test (slot) and [14
Switch traffic] (lan_switch: Nginx Proxy Manager's proxy hosts move to the
slot's VM). Activate is 13 then 14; Delete is [11 Take snapshot], 15 Destroy
VM (all three), 16 and 17. Reset, Restore backup, Roll back, Restore VM
snapshot, renew and a Blue/Green publish job have no plan: both app VMs
share the data VM (a publish job is the ordinary one, bluegreen=False)."""

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

PLAYBOOK_DIR = Path(__file__).resolve().parent / "ansible"
MODES = ("update", "reset", "snapshot", "restore_dump", "rollback", "publish", "teardown",
         "vm_restore", "activate", "renew")
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
    StepDef(7, "data_vm", "Prepare data VM", "data_vm.yml", 30 * 60),
    StepDef(8, "data", "Start data services", "data.yml", 15 * 60),
    StepDef(9, "restore", "Restore snapshot", "restore.yml", 120 * 60),
    StepDef(9, "restore_dump", "Restore backup", "restore_dump.yml", 60 * 60),
    StepDef(10, "up", "Start services", "up.yml", 45 * 60),
    StepDef(11, "export", "Take snapshot", "export.yml", 120 * 60),
    StepDef(11, "first_admin", "Create the first admin", "first_admin.yml", 10 * 60),
    StepDef(12, "dns", "DNS records", "", 10 * 60, "python"),
    StepDef(13, "proxy", "Proxy hosts", "", 45 * 60, "python"),
    StepDef(13, "slot_smoke", "Smoke test (slot)", "slot_smoke.yml", 10 * 60),
    StepDef(14, "smoke", "Smoke test", "", 10 * 60, "python"),
    StepDef(14, "go_live", "Switch traffic", "", 15 * 60, "vm"),
    # the first switch creates the proxy hosts and their certificates (as 13)
    StepDef(14, "lan_switch", "Switch traffic", "", 45 * 60, "python"),
    StepDef(15, "teardown", "Remove environment", "teardown.yml", 30 * 60),
    StepDef(15, "destroy", "Destroy VM", "", 30 * 60, "vm"),
    StepDef(16, "unproxy", "Remove proxy hosts", "", 15 * 60, "python"),
    StepDef(17, "undns", "Remove DNS records", "", 10 * 60, "python"),
    StepDef(18, "do_destroy", "Remove DigitalOcean resources", "", 60 * 60, "vm"),
    StepDef(19, "do_renew", "Renew certificate", "", 30 * 60, "vm"),
)
STEPS_BY_KEY = {s.key: s for s in STEPS}
# A LAN Blue/Green environment's step 0 builds up to two VMs (the data VM,
# then the slot's) and its Destroy VM removes three: each gets an hour.
BLUEGREEN_VM_TIMEOUT = 60 * 60
_BLUEGREEN_VM_STEPS = ("provision", "destroy")


def timeout_of(step_key: str, *, bluegreen: bool = False) -> int:
    """A step's timeout in seconds for this deployment."""
    if bluegreen and step_key in _BLUEGREEN_VM_STEPS:
        return BLUEGREEN_VM_TIMEOUT
    return STEPS_BY_KEY[step_key].timeout
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
    ("renew", False): ("do_renew",),
}


_BG_BUILD = ("provision", *_BUILD)
# (mode, restores or takes a snapshot) -> step keys of a LAN Blue/Green plan.
_BG_PLANS: dict[tuple[str, bool], tuple[str, ...]] = {
    ("update", False): (*_BG_BUILD, "dump", "data_vm", "up", "slot_smoke"),
    ("update", True): (*_BG_BUILD, "dump", "data_vm", "restore", "up", "slot_smoke"),
    ("snapshot", False): ("preflight", "export"),
    ("teardown", False): ("destroy", "unproxy", "undns"),
    ("teardown", True): ("export", "destroy", "unproxy", "undns"),
    ("activate", False): ("slot_smoke", "lan_switch"),
}


def _bg_plan(mode: str, *, restore: bool, publish: bool, go_live: bool,
             snapshot: bool) -> tuple[str, ...]:
    key = (mode, snapshot if mode == "teardown" else restore)
    if key not in _BG_PLANS:
        raise ValueError(f"no LAN Blue/Green plan for mode {mode!r}")
    keys = _BG_PLANS[key]
    if publish:
        if mode != "update":
            raise ValueError(f"mode {mode!r} doesn't publish")
        at = keys.index("slot_smoke")
        keys = (*keys[:at], "dns", *keys[at:])
    if go_live and mode != "activate":
        if mode != "update":
            raise ValueError(f"mode {mode!r} doesn't switch traffic")
        keys = (*keys, "lan_switch")
    return keys


def _with_first_admin(keys: tuple[str, ...]) -> tuple[str, ...]:
    """Step 11 right after Start services: the api is up, and nothing has
    published the environment yet."""
    at = keys.index("up") + 1
    return (*keys[:at], "first_admin", *keys[at:])


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
             smoke: bool = True, first_admin: bool = False,
             bluegreen: bool = False) -> list[StepDef]:
    if first_admin and (mode != "update" or restore):
        raise ValueError("only an Update that starts empty creates the first admin")
    if bluegreen:
        if not vm or cloud:
            raise ValueError("a LAN Blue/Green plan is a VM plan")
        if not smoke:
            raise ValueError("only Deactivate skips the slot smoke test")
        keys = _bg_plan(mode, restore=restore, publish=publish, go_live=go_live,
                        snapshot=snapshot)
        if first_admin:
            keys = _with_first_admin(keys)
        return [STEPS_BY_KEY[k] for k in keys]
    if cloud:
        keys = _cloud_plan(mode, restore=restore, publish=publish, vm=vm, go_live=go_live,
                           snapshot=snapshot, smoke=smoke)
        if first_admin:
            keys = _with_first_admin(keys)
        return [STEPS_BY_KEY[k] for k in keys]
    if mode == "activate":
        raise ValueError("only a DigitalOcean or LAN Blue/Green environment activates a slot")
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
    if first_admin:
        keys = _with_first_admin(keys)
    return [STEPS_BY_KEY[k] for k in keys]
