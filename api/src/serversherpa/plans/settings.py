"""Project-plan settings: the system_config `project_plans` section merged
with one plan's overrides into a frozen value for the services that enforce
them. The route in api/routes/system.py is the only writer of the system
section; a plan's overrides live in `project_plans.settings`.

The calendar is deliberately not part of `PlanSettings`: a new plan copies
the system calendar and then owns its own."""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.system.config_store import DEFAULTS, read_section

SECTION = "project_plans"


@dataclass(frozen=True)
class Completion:
    subtasks: str          # cascade | block | none
    predecessors: str      # block | warn | none


@dataclass(frozen=True)
class Reminders:
    enabled: bool
    offsets_days: tuple[int, ...]
    on_due_day: bool
    overdue: str           # daily | once | off
    send_time: str         # plan-local HH:MM
    use_finish_without_deadline: bool
    notify_on_assign: bool
    overdue_to_owner: bool
    email_assignees: bool


@dataclass(frozen=True)
class PlanSettings:
    honor_constraints: bool
    critical_slack_days: float
    default_task_mode: str
    default_duration: str
    show_times: bool
    completion: Completion
    reminders: Reminders


async def load_system(db: AsyncSession) -> dict:
    return await read_section(db, SECTION)


def _pick(key: str, system: dict, overrides: dict):
    """The override when it has a value (False, 0 and [] are values), else
    the system value, else the built-in default."""
    value = overrides.get(key)
    if value is not None:
        return value
    if system.get(key) is not None:
        return system[key]
    return DEFAULTS[SECTION][key]


def _group(name: str, system: dict, overrides: dict) -> dict:
    """One nested group (`completion`, `reminders`) merged key by key. A
    system row that stores only part of a group still gets the built-in
    default for the rest."""
    defaults = DEFAULTS[SECTION][name]
    sys_group = system.get(name) or {}
    ov_group = overrides.get(name) or {}
    return {key: _pick(key, {**defaults, **sys_group}, ov_group) for key in defaults}


def effective(system: dict, overrides: dict | None) -> PlanSettings:
    """`system` (from `load_system`) overlaid with a plan's `overrides`, key
    by key: top-level scalars, and each key inside `completion` and
    `reminders` on its own. An override of None, or a missing key, inherits;
    keys the settings do not know (such as `calendar`) are ignored."""
    ov = overrides or {}
    completion = _group("completion", system, ov)
    reminders = _group("reminders", system, ov)
    return PlanSettings(
        honor_constraints=_pick("honor_constraints", system, ov),
        critical_slack_days=float(_pick("critical_slack_days", system, ov)),
        default_task_mode=_pick("default_task_mode", system, ov),
        default_duration=_pick("default_duration", system, ov),
        show_times=_pick("show_times", system, ov),
        completion=Completion(**completion),
        reminders=Reminders(**{**reminders,
                               "offsets_days": tuple(reminders["offsets_days"])}),
    )
