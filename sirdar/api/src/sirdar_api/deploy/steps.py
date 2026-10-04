"""The deploy steps (spec Section 2) and the plan each mode runs.

Numbers follow the spec's order: 8 starts the data services, 9 restores
data and 10 ("Start services": `ss-stack up` runs migrate, then the app)
covers spec steps 10–11. Restore snapshot and Restore backup share number
9 and never meet in one plan. Take snapshot (11) is a job of its own.
DNS, proxy and smoke tests (12–14) are phase 4."""

from dataclasses import dataclass
from pathlib import Path

PLAYBOOK_DIR = Path(__file__).resolve().parent / "ansible"
MODES = ("update", "reset", "snapshot", "restore_dump", "rollback")


@dataclass(frozen=True)
class StepDef:
    number: int
    key: str
    name: str
    playbook: str
    timeout: int                 # seconds for the whole playbook run


STEPS: tuple[StepDef, ...] = (
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
)
STEPS_BY_KEY = {s.key: s for s in STEPS}

_BUILD = ("preflight", "bootstrap", "fetch", "render", "build")
# (mode, restores a snapshot) -> step keys, in order.
_PLANS: dict[tuple[str, bool], tuple[str, ...]] = {
    ("update", False): (*_BUILD, "dump", "up"),
    # the first deploy of an environment created from a snapshot
    ("update", True): (*_BUILD, "data", "restore", "up"),
    ("reset", False): (*_BUILD, "reset", "up"),
    ("reset", True): (*_BUILD, "reset", "data", "restore", "up"),
    ("restore_dump", False): ("preflight", "data", "restore_dump", "up"),
    # the previous commit, with the failed deployment's pre-deploy dump
    ("rollback", False): ("preflight", "fetch", "render", "build", "data", "restore_dump", "up"),
    ("snapshot", False): ("preflight", "export"),
}


def plan_for(mode: str, *, restore: bool = False) -> list[StepDef]:
    try:
        keys = _PLANS[(mode, restore)]
    except KeyError:
        raise ValueError(f"no deploy plan for mode {mode!r} (restore={restore})") from None
    return [STEPS_BY_KEY[k] for k in keys]
