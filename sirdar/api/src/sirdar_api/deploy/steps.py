"""The deploy steps (spec Section 2) and which run in each mode. Spec steps
8–11 (start data services, restore, migrate, start the app) are one step
here, "Start services": `ss-stack up` already starts db → storage →
migrate → api → web → status and waits on health. Snapshot restore is
phase 3; DNS, proxy and smoke tests (12–14) are phase 4."""

from dataclasses import dataclass
from pathlib import Path

PLAYBOOK_DIR = Path(__file__).resolve().parent / "ansible"
MODES = ("update", "reset")
_BOTH = ("update", "reset")


@dataclass(frozen=True)
class StepDef:
    number: int
    key: str
    name: str
    playbook: str
    timeout: int                 # seconds for the whole playbook run
    modes: tuple[str, ...]


STEPS: tuple[StepDef, ...] = (
    StepDef(1, "preflight", "Preflight", "preflight.yml", 5 * 60, _BOTH),
    StepDef(2, "bootstrap", "Bootstrap", "bootstrap.yml", 30 * 60, _BOTH),
    StepDef(3, "fetch", "Fetch code", "fetch.yml", 15 * 60, _BOTH),
    StepDef(4, "render", "Render config", "render.yml", 5 * 60, _BOTH),
    StepDef(5, "build", "Build images", "build.yml", 90 * 60, _BOTH),
    StepDef(6, "dump", "Pre-deploy dump", "dump.yml", 30 * 60, ("update",)),
    StepDef(7, "reset", "Reset data", "reset.yml", 15 * 60, ("reset",)),
    StepDef(8, "up", "Start services", "up.yml", 45 * 60, _BOTH),
)
STEPS_BY_KEY = {s.key: s for s in STEPS}


def plan_for(mode: str) -> list[StepDef]:
    if mode not in MODES:
        raise ValueError(f"unknown deploy mode: {mode}")
    return [s for s in STEPS if mode in s.modes]
