"""Project-plan settings: the system_config `project_plans` section merged
with one plan's overrides into a frozen value for the services that enforce
them. The route in api/routes/system.py is the only writer of the system
section; a plan's overrides live in `project_plans.settings`.

The calendar is deliberately not part of `PlanSettings`: a new plan copies
the system calendar and then owns its own.

`system_view` is the section as GET|PUT /system/project-plans serve it;
`merge_overrides` applies a PATCH to a plan's overrides."""

import copy
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.system.config_store import DEFAULTS, read_section

SECTION = "project_plans"
# the nested groups, merged key by key (the calendar is replaced whole)
GROUPS = ("completion", "reminders")


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


def _pick(key: str, system: dict, overrides: dict, defaults: dict):
    """The override when it has a value (False, 0 and [] are values), else
    the system value, else the built-in default. `defaults` is the dict that
    level of the settings lives in: the whole section for a top-level key,
    the group's own defaults for a key inside `completion` / `reminders`."""
    value = overrides.get(key)
    if value is not None:
        return value
    if system.get(key) is not None:
        return system[key]
    return defaults[key]


def _group(name: str, system: dict, overrides: dict) -> dict:
    """One nested group (`completion`, `reminders`) merged key by key. A
    system row that stores only part of a group, or stores a null for a
    key, still gets the built-in default for it."""
    defaults = DEFAULTS[SECTION][name]
    sys_group = system.get(name) or {}
    ov_group = overrides.get(name) or {}
    return {key: _pick(key, sys_group, ov_group, defaults) for key in defaults}


def effective(system: dict, overrides: dict | None) -> PlanSettings:
    """`system` (from `load_system`) overlaid with a plan's `overrides`, key
    by key: top-level scalars, and each key inside `completion` and
    `reminders` on its own. An override of None, or a missing key, inherits;
    keys the settings do not know (such as `calendar`) are ignored."""
    ov = overrides or {}
    base = DEFAULTS[SECTION]
    completion = _group("completion", system, ov)
    reminders = _group("reminders", system, ov)
    return PlanSettings(
        honor_constraints=_pick("honor_constraints", system, ov, base),
        critical_slack_days=float(_pick("critical_slack_days", system, ov, base)),
        default_task_mode=_pick("default_task_mode", system, ov, base),
        default_duration=_pick("default_duration", system, ov, base),
        show_times=_pick("show_times", system, ov, base),
        completion=Completion(**completion),
        reminders=Reminders(**{**reminders,
                               "offsets_days": tuple(reminders["offsets_days"])}),
    )


def system_view(system: dict) -> dict:
    """The system section (from `load_system`) with every key, each group
    filled key by key the way `effective` reads it: a missing or null value
    is the built-in default. A deep copy: the section shares its nested
    values with config_store.DEFAULTS, which must never change."""
    base = DEFAULTS[SECTION]
    view = {key: system[key] if system.get(key) is not None else base[key]
            for key in base if key not in GROUPS}
    for name in GROUPS:
        view[name] = _group(name, system, {})
    return copy.deepcopy(view)


def merge_overrides(current: dict | None, patch: dict) -> dict:
    """A plan's overrides with a PATCH's `settings` applied: each key sent
    replaces that override and None removes it (the plan inherits again);
    inside `completion` / `reminders` the same, key by key, and None for a
    whole group removes all of it. Null values and emptied groups are left
    out of the result, so `{}` inherits everything. Neither input changes."""
    merged = copy.deepcopy(current or {})
    for key, value in patch.items():
        if key in GROUPS and value is not None:
            group = merged.get(key)
            merged[key] = {**(group if isinstance(group, dict) else {}), **value}
        else:
            merged[key] = copy.deepcopy(value)
    out = {}
    for key, value in merged.items():
        if key in GROUPS and isinstance(value, dict):
            value = {k: v for k, v in value.items() if v is not None}
            if not value:
                continue
        if value is not None:
            out[key] = value
    return out
