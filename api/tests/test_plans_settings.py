"""Project-plan settings: the system_config `project_plans` section and the
effective (system + per-plan override) view the services read."""

import copy
import dataclasses
import json

import pytest
from sqlalchemy import text

from serversherpa.plans.settings import (
    SECTION,
    Completion,
    PlanSettings,
    Reminders,
    effective,
    load_system,
    merge_overrides,
    system_view,
)
from serversherpa.system.config_store import DEFAULTS

SPEC_DEFAULTS = PlanSettings(
    honor_constraints=True,
    critical_slack_days=0,
    default_task_mode="auto",
    default_duration="1d",
    show_times=False,
    completion=Completion(subtasks="cascade", predecessors="block"),
    reminders=Reminders(
        enabled=True, offsets_days=(3, 1), on_due_day=True, overdue="daily",
        send_time="08:00", use_finish_without_deadline=False, notify_on_assign=True,
        overdue_to_owner=True, email_assignees=True),
)


def test_section_name():
    assert SECTION == "project_plans"


def test_system_defaults_match_the_spec():
    section = DEFAULTS[SECTION]
    assert section["honor_constraints"] is True
    assert section["critical_slack_days"] == 0
    assert section["default_task_mode"] == "auto"
    assert section["default_duration"] == "1d"
    assert section["show_times"] is False
    assert section["completion"] == {"subtasks": "cascade", "predecessors": "block"}
    assert section["reminders"] == {
        "enabled": True, "offsets_days": [3, 1], "on_due_day": True,
        "overdue": "daily", "send_time": "08:00", "use_finish_without_deadline": False,
        "notify_on_assign": True, "overdue_to_owner": True, "email_assignees": True}


def test_system_calendar_is_the_standard_calendar():
    cal = DEFAULTS[SECTION]["calendar"]
    workday = [["08:00", "12:00"], ["13:00", "17:00"]]
    assert cal["week"] == {"mon": workday, "tue": workday, "wed": workday,
                           "thu": workday, "fri": workday, "sat": [], "sun": []}
    assert cal["exceptions"] == []
    assert (cal["hours_per_day"], cal["hours_per_week"], cal["days_per_month"]) == (8, 40, 20)
    assert (cal["default_start"], cal["default_end"]) == ("08:00", "17:00")


async def test_defaults_effective(db):
    system = await load_system(db)
    assert effective(system, None) == SPEC_DEFAULTS
    assert effective(system, {}) == SPEC_DEFAULTS


async def test_effective_is_frozen_and_tuple_valued(db):
    got = effective(await load_system(db), None)
    assert isinstance(got.reminders.offsets_days, tuple)
    with pytest.raises(dataclasses.FrozenInstanceError):
        got.honor_constraints = False  # type: ignore[misc]


async def test_override_one_reminder_key(db):
    got = effective(await load_system(db), {"reminders": {"offsets_days": [5]}})
    assert got.reminders.offsets_days == (5,)
    assert got.reminders == Reminders(
        enabled=True, offsets_days=(5,), on_due_day=True, overdue="daily",
        send_time="08:00", use_finish_without_deadline=False, notify_on_assign=True,
        overdue_to_owner=True, email_assignees=True)
    assert got.completion == SPEC_DEFAULTS.completion


async def test_override_scalars_and_one_completion_key(db):
    got = effective(await load_system(db), {
        "honor_constraints": False, "critical_slack_days": 1.5, "show_times": True,
        "default_task_mode": "manual", "default_duration": "2d",
        "completion": {"predecessors": "warn"}})
    assert got.honor_constraints is False
    assert got.critical_slack_days == 1.5
    assert got.show_times is True
    assert got.default_task_mode == "manual"
    assert got.default_duration == "2d"
    assert got.completion == Completion(subtasks="cascade", predecessors="warn")
    assert got.reminders == SPEC_DEFAULTS.reminders


async def test_falsy_overrides_still_override(db):
    """False, 0, [] and "" are values, not "inherit"; only None inherits."""
    got = effective(await load_system(db), {
        "honor_constraints": False, "critical_slack_days": 0,
        "reminders": {"enabled": False, "on_due_day": False, "offsets_days": []}})
    assert got.honor_constraints is False
    assert got.reminders.enabled is False
    assert got.reminders.on_due_day is False
    assert got.reminders.offsets_days == ()
    # untouched keys still inherit
    assert got.reminders.send_time == "08:00"


async def test_null_override_inherits(db):
    system = await load_system(db)
    got = effective(system, {"completion": {"subtasks": None}})
    assert got.completion.subtasks == "cascade"
    assert effective(system, {"honor_constraints": None, "show_times": None}) == SPEC_DEFAULTS
    # a whole group set to null inherits the whole group
    assert effective(system, {"completion": None, "reminders": None}) == SPEC_DEFAULTS


async def test_unknown_override_keys_are_ignored(db):
    system = await load_system(db)
    got = effective(system, {"calendar": {"hours_per_day": 4}, "bogus": 1,
                             "completion": {"nope": "x"}})
    assert got == SPEC_DEFAULTS


async def test_system_row_wins_over_defaults(db):
    await db.execute(text(
        "INSERT INTO system_config (section, data) VALUES "
        "('project_plans', '{\"honor_constraints\": false}'::jsonb)"))
    await db.commit()
    system = await load_system(db)
    assert system["honor_constraints"] is False
    # keys the row does not carry still come from the defaults
    assert system["default_duration"] == "1d"
    got = effective(system, None)
    assert got.honor_constraints is False
    assert got.completion == SPEC_DEFAULTS.completion
    # a plan override beats the system row
    assert effective(system, {"honor_constraints": True}).honor_constraints is True


@pytest.mark.parametrize("stored", [
    {"reminders": {"send_time": None}},
    {"completion": {"subtasks": None}},
    {"reminders": {"offsets_days": None, "enabled": None}},
    {"reminders": None, "completion": None},
])
async def test_stored_nulls_inside_a_group_fall_back_to_defaults(db, stored):
    """A system row with an explicit null inside a nested group inherits the
    built-in default for that key instead of failing."""
    await db.execute(
        text("INSERT INTO system_config (section, data) VALUES "
             "('project_plans', CAST(:data AS jsonb))"), {"data": json.dumps(stored)})
    await db.commit()
    got = effective(await load_system(db), None)
    assert got == SPEC_DEFAULTS
    assert got.reminders.send_time == "08:00"
    assert got.completion.subtasks == "cascade"


async def test_stored_null_in_a_group_keeps_the_other_stored_keys(db):
    await db.execute(
        text("INSERT INTO system_config (section, data) VALUES "
             "('project_plans', CAST(:data AS jsonb))"),
        {"data": json.dumps({"reminders": {"send_time": None, "overdue": "once"},
                             "completion": {"subtasks": None, "predecessors": "warn"}})})
    await db.commit()
    got = effective(await load_system(db), None)
    assert got.reminders.send_time == "08:00" and got.reminders.overdue == "once"
    assert got.completion == Completion(subtasks="cascade", predecessors="warn")
    # a plan override still wins over a stored value, and a null override inherits it
    got = effective(await load_system(db), {"reminders": {"send_time": "09:30"},
                                            "completion": {"subtasks": None}})
    assert got.reminders.send_time == "09:30"
    assert got.completion.subtasks == "cascade"


# --- the system view and merging a PATCH into a plan's overrides ------------------


def test_system_view_fills_each_group_key_by_key():
    stored = {"reminders": {"offsets_days": [9], "send_time": None},
              "honor_constraints": None, "critical_slack_days": 3}
    view = system_view(stored)
    assert view == {**DEFAULTS[SECTION], "critical_slack_days": 3,
                    "reminders": {**DEFAULTS[SECTION]["reminders"], "offsets_days": [9]}}
    # a deep copy: the shared defaults never change through it
    view["calendar"]["exceptions"].append({"date": "2026-11-26", "hours": []})
    view["reminders"]["offsets_days"].append(1)
    assert DEFAULTS[SECTION]["calendar"]["exceptions"] == []
    assert system_view({})["reminders"]["offsets_days"] == [3, 1]


def test_merge_overrides_key_by_key():
    current = {"completion": {"subtasks": "block", "predecessors": None},
               "show_times": True, "calendar": {"kept": "as is"}}
    before = copy.deepcopy(current)
    got = merge_overrides(current, {"completion": {"predecessors": "warn"},
                                    "show_times": None, "reminders": {"enabled": False}})
    assert got == {"completion": {"subtasks": "block", "predecessors": "warn"},
                   "reminders": {"enabled": False}, "calendar": {"kept": "as is"}}
    assert current == before
    # null for a whole group, or for its last key, leaves nothing behind
    assert merge_overrides(got, {"completion": None, "reminders": {"enabled": None},
                                 "calendar": None}) == {}
    assert merge_overrides(None, {}) == {}
