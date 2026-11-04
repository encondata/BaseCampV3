# Project Plans — Plan A: Engine + API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The data model, the MS Project-style scheduling engine and the plan API (create, read, edit through ops, progress with completion checks, lock, baseline, settings) — usable end to end over HTTP.

**Architecture:** A new `serversherpa.plans` package. Pure, I/O-free modules (`durations`, `calendar`, `predecessors`, `engine`) carry all scheduling logic and are tested exhaustively; `service`/`ops`/`completion` load a plan, apply a batch of ops, run the engine over the whole plan and persist changed rows in one transaction; `api/routes/plans.py` exposes it. The API is the single scheduler; the portal (Plan B) only renders what it returns.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async, Alembic, Postgres, pytest (+ pytest-asyncio).

**Spec:** `docs/superpowers/specs/2026-10-27-project-plans-design.md` — read it before any task. Section names below refer to it.

**Plan series:** A (this) engine + API · B portal tab, sheet, Gantt, dialogs · C reminders, settings UI, views, timeline, templates, import/export, print. All on branch `project-plans`.

## Global Constraints

- Worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/project-plans`, branch `project-plans`. Never `cd` to the main checkout; never switch branches.
- API tests: from `api/`, `PYTHONPATH=src SS_TEST_DB=serversherpa_test_project_plans .venv/bin/pytest <path> -q` (the venv is the main checkout's editable install; without `PYTHONPATH=src` you test main's code). Run everything in the FOREGROUND with a 600000 ms timeout; never background a suite and end your turn waiting.
- Never commit `api/src/serversherpa/_dev_reload.py`.
- Migration **0110** (`down_revision` = 0109's revision id). Head is 0109 today.
- All plan times are naive local wall-clock datetimes (`timestamp without time zone`); never attach tzinfo inside `plans/`.
- American English in code, comments, copy.
- Error responses: `HTTPException(status_code, detail={"code": "<code>", ...})` with the codes the spec lists.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Reference week used by every engine test (Standard calendar, Mon–Fri 08:00–12:00 + 13:00–17:00): Mon 2026-11-02 … Fri 2026-11-06; Thu 2026-11-26 is a nonworking exception ("Thanksgiving"); Sat 2026-11-14 is a working exception 06:00–22:00 ("Move weekend"). Write datetimes in tests as `dt("2026-11-02 08:00")` via a local helper.

## Review Focus

1. **Boundary snapping** — a task ending at 17:00 must finish *at* 17:00 Monday, and its FS successor must start 08:00 Tuesday; a milestone after it sits at Monday 17:00. Off-by-one-period bugs here silently shift every downstream date. (Task 3, Task 4)
2. **Summary tasks in links** — links into and out of summaries, nested summaries, and a cycle that only exists through a summary's rollup. (Task 5)
3. **Batch atomicity** — a batch whose 3rd op fails (cycle) must leave the plan, its version and every task untouched. (Task 9)
4. **Stale version vs progress-only batches** — a structural batch with an old `base_version` is refused; a progress-only batch with an old one is applied. (Task 11)
5. **Ids from another plan** — an ops batch naming a task or link that belongs to a different plan must be refused (422 `unknown_task`/`unknown_link`), never edit the other plan. Scope itself is enforced by the `visible_to={"global"}` hard gate plus `visible_initiative`/`plan_for_actor` on every route. (Task 9)

---
### Task 1: Schema, models, access resource, settings section

**Files:**
- Create: `api/migrations/versions/0110_project_plans.py`
- Create: `api/src/serversherpa/plans/__init__.py` (docstring only), `api/src/serversherpa/plans/models.py`, `api/src/serversherpa/plans/settings.py`
- Modify: `api/src/serversherpa/db/models.py` (end of file: `import serversherpa.plans.models  # noqa: F401`, next to the learning import)
- Modify: `api/src/serversherpa/access/resources.py` (`Resource("project_plans", "Project plans", visible_to=frozenset({"global"}))`, no routes — it's a tab)
- Modify: `api/src/serversherpa/access/defaults.py` (`"project_plans"` in `_ALL`; `"project_plans": FULL` in `admin`; nothing for `staff` or below)
- Modify: `api/src/serversherpa/system/config_store.py` (`DEFAULTS["project_plans"]`)
- Test: `api/tests/test_plans_migration.py`, `api/tests/test_plans_settings.py`; modify `api/tests/test_access_registry.py`

**Interfaces:**
- Produces:
  - Tables exactly as the spec's *Data model* section, in raw-SQL `DDL` style like 0109 (`id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, inline FKs, named `<table>_<col>_check` CHECKs, a `TABLES` tuple for downgrade). Wall-clock columns (`project_start`, `status_date`, every task date, `constraint_date`, `deadline`, actuals, baselines, `plan_reminder_log.due_at`) are `timestamp without time zone`; audit-style columns (`created_at`, `updated_at`, `locked_at`, `baseline_set_at`, `completed_at`, `sent_at`) are `timestamptz DEFAULT now()` where they default. CHECKs: `mode IN ('auto','manual')`, `duration_unit IN ('m','h','d','w','mo')`, `lag_unit` same, `constraint_type IN ('asap','snet','snlt','fnet','fnlt','mso','mfo')`, `link_type IN ('FS','SS','FF','SF')`, `percent_complete BETWEEN 0 AND 100`, `duration_minutes >= 0`, `conflict IS NULL OR conflict IN ('link','constraint')`, `predecessor_id <> successor_id`, assignments `num_nonnulls(person_id, partner_id) = 1`. Uniques: `project_plans(initiative_id)`, `plan_links(predecessor_id, successor_id)`, `plan_assignments(task_id, person_id)` and `(task_id, partner_id)` (partial, where not null), `plan_reminder_log(task_id, person_id, stage, due_at)`, `plan_templates(name)` (CITEXT). Indexes: `plan_tasks(plan_id, position)`, `plan_tasks(parent_id)`, `plan_links(plan_id)`, `plan_tasks(deadline) WHERE percent_complete < 100`.
  - Grants: insert `role_permissions` `(role, 'project_plans', action)` for developer, founder, super_admin, admin × FULL (`ON CONFLICT DO NOTHING`); downgrade deletes them.
  - `ck_notification_groups_categories` → 0109's list plus `'plans'` (downgrade first `array_remove(categories, 'plans')`). The code-side category is added in Plan C.
  - `plans/models.py`: `ProjectPlan`, `PlanTask`, `PlanLink`, `PlanAssignment`, `PlanReminderLog`, `PlanTemplate` (learning/models.py style, `_id()`/`_now()` helpers). **`Base` maps `datetime` to `TIMESTAMP(timezone=True)`, so every wall-clock column must say `mapped_column(TIMESTAMP(timezone=False))` explicitly.** `PlanTask.parent_id` FK `plan_tasks.id ON DELETE CASCADE`.
  - `config_store.DEFAULTS["project_plans"]` = the spec's *Settings* block verbatim: `calendar` = `STANDARD_CALENDAR` values written inline (no import from `plans/`), `honor_constraints: True`, `critical_slack_days: 0`, `default_task_mode: "auto"`, `default_duration: "1d"`, `show_times: False`, `completion: {"subtasks": "cascade", "predecessors": "block"}`, `reminders: {"enabled": True, "offsets_days": [3, 1], "on_due_day": True, "overdue": "daily", "send_time": "08:00", "use_finish_without_deadline": False, "notify_on_assign": True, "overdue_to_owner": True, "email_assignees": True}`.
  - `plans/settings.py`:
    ```python
    SECTION = "project_plans"
    @dataclass(frozen=True)
    class Completion: subtasks: str; predecessors: str          # cascade|block|none ; block|warn|none
    @dataclass(frozen=True)
    class Reminders: enabled: bool; offsets_days: tuple[int, ...]; on_due_day: bool; overdue: str
        send_time: str; use_finish_without_deadline: bool; notify_on_assign: bool
        overdue_to_owner: bool; email_assignees: bool
    @dataclass(frozen=True)
    class PlanSettings: honor_constraints: bool; critical_slack_days: float; default_task_mode: str
        default_duration: str; show_times: bool; completion: Completion; reminders: Reminders
    async def load_system(db) -> dict                 # read_section(db, SECTION)
    def effective(system: dict, overrides: dict | None) -> PlanSettings
    ```
    `effective` merges per key: top-level scalars, and each key inside `completion` / `reminders` separately; an override value of `None` (or a missing key) inherits. `calendar` is NOT part of `PlanSettings` (each plan stores its own copy).

- [ ] **Step 1: Failing tests.**
  - `test_plans_migration.py::test_downgrade_and_upgrade_again` — copy the throwaway-DB pattern of `tests/test_migration_0109_learning_portal.py` (DB `<SS_TEST_DB>_m0110`, `_alembic` from `tests/test_migration_0099_kiosk_config.py`): upgrade head; the six tables exist; `SELECT action FROM role_permissions WHERE role='admin' AND resource='project_plans'` → `{view, add, change, delete}`; none for `staff`; inserting a notification group with `categories = '{plans}'` succeeds; downgrade to `0109` drops the six tables and the grants; upgrade head again succeeds.
  - `test_plans_migration.py::test_task_check_constraints` (on the regular test DB through the `db` fixture, raw SQL): `percent_complete = 101` → IntegrityError; assignment with both person and partner → IntegrityError; link with predecessor = successor → IntegrityError.
  - `test_access_registry.py`: add `"project_plans"` to the `test_registry_shape` set; new `test_project_plans_default_grants`: `DEFAULT_GRANTS["admin"]["project_plans"] == FULL`, `"project_plans" not in DEFAULT_GRANTS["staff"]`, developer/founder/super_admin hold FULL.
  - `test_plans_settings.py`: `test_defaults_effective` (`effective(await load_system(db), None)` equals a `PlanSettings` built from the spec values above), `test_override_one_reminder_key` (`{"reminders": {"offsets_days": [5]}}` → offsets `(5,)`, every other reminder key inherited), `test_null_override_inherits` (`{"completion": {"subtasks": None}}` → `"cascade"`), `test_system_row_wins_over_defaults` (store a `system_config` row `project_plans` with `{"honor_constraints": False}` → effective `False`).
- [ ] **Step 2: Run** `PYTHONPATH=src SS_TEST_DB=serversherpa_test_project_plans .venv/bin/pytest tests/test_plans_migration.py tests/test_plans_settings.py tests/test_access_registry.py -q` → FAIL.
- [ ] **Step 3: Implement** the migration, models, registrations, defaults and `settings.py`.
- [ ] **Step 4: Run** the same command → PASS. Then the access/permission suites that pin grants: `… pytest tests/test_access_registry.py tests/test_kiosk_access.py tests/test_scans_model.py tests/test_access_api.py -q` (whichever exist) → PASS.
- [ ] **Step 5: Commit** `feat(plans): schema, models, access resource and settings section`.

### Task 2: Duration and lag text (`plans/durations.py`) + shared vectors

**Files:**
- Create: `api/src/serversherpa/plans/durations.py`
- Create: `api/tests/fixtures/plans/durations.json` (shared with the portal in Plan B — the portal reads this exact file)
- Test: `api/tests/test_plans_durations.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class Units: minutes_per_day: int = 480; minutes_per_week: int = 2400; minutes_per_month: int = 9600` and `Units.from_calendar(cal: dict) -> Units` (reads `hours_per_day`, `hours_per_week`, `days_per_month`).
  - `@dataclass(frozen=True) class Duration: minutes: int; unit: str; elapsed: bool` — `unit` ∈ `m h d w mo`.
  - `class DurationError(ValueError)` with `.code = "bad_duration"`.
  - `parse_duration(text: str, units: Units, default_unit: str = "d") -> Duration` (≥ 0 only).
  - `parse_lag(text: str, units: Units, default_unit: str = "d") -> Duration` (signed; `minutes` may be negative).
  - `format_duration(d: Duration, units: Units) -> str`; `format_lag(d: Duration, units: Units) -> str` (`+2 days`, `-4 hrs`, `0 days`).
  - Elapsed conversions are fixed: `em`=1, `eh`=60, `ed`=1440, `ew`=10080, `emo`=43200 minutes.

- [ ] **Step 1: Write the vectors file.** JSON `{"units": {"hours_per_day": 8, "hours_per_week": 40, "days_per_month": 20}, "parse": [...], "invalid": [...], "lag": [...], "format": [...]}`. `parse` rows are `[text, minutes, unit, elapsed]` and must include exactly these (more are welcome):

```
["5d",2400,"d",false] ["1d",480,"d",false] ["4h",240,"h",false] ["1h",60,"h",false]
["30m",30,"m",false] ["2w",4800,"w",false] ["1mo",9600,"mo",false] ["0.5d",240,"d",false]
["3",1440,"d",false] ["0",0,"d",false] ["3ed",4320,"d",true] ["12eh",720,"h",true]
["2 days",960,"d",false] ["4 hours",240,"h",false] ["4 hrs",240,"h",false] ["1 week",2400,"w",false]
["2 wks",4800,"w",false] ["30 min",30,"m",false] ["30 minutes",30,"m",false] ["  5D ",2400,"d",false]
["1 mon",9600,"mo",false] ["2 edays",2880,"d",true]
```
`invalid`: `"", "abc", "-1d", "5x", "1.2.3d", "d", "1e"`. `lag` rows `[text, minutes, unit, elapsed]`: `["+2d",960,"d",false] ["2d",960,"d",false] ["-4h",-240,"h",false] ["+1ed",1440,"d",true] ["0",0,"d",false]`. `format` rows `[minutes, unit, elapsed, text]`: `[2400,"d",false,"5 days"] [480,"d",false,"1 day"] [240,"h",false,"4 hrs"] [60,"h",false,"1 hr"] [30,"m",false,"30 mins"] [1,"m",false,"1 min"] [4800,"w",false,"2 wks"] [2400,"w",false,"1 wk"] [9600,"mo",false,"1 mon"] [19200,"mo",false,"2 mons"] [240,"d",false,"0.5 days"] [360,"d",false,"0.75 days"] [0,"d",false,"0 days"] [4320,"d",true,"3 edays"] [720,"h",true,"12 ehrs"] [160,"d",false,"0.33 days"]` (at most two decimals, trailing zeros trimmed). `format_lag` rows: `[960,"d",false,"+2 days"] [-240,"h",false,"-4 hrs"] [0,"d",false,"0 days"]`.

- [ ] **Step 2: Write the failing tests** — `test_parse_vectors`, `test_invalid_vectors` (each raises `DurationError`), `test_lag_vectors`, `test_format_vectors`, `test_format_lag_vectors`, `test_round_trip` (`parse_duration(format_duration(d)) == d` for every non-elapsed and elapsed format row whose value has ≤ 2 decimals exactly — skip the `0.33` row), `test_custom_units` (`hours_per_day=10` → `"1d"` is 600 minutes and `format_duration(Duration(600,"d",False))` is `"1 day"`). Load the JSON relative to the test file.
- [ ] **Step 3: Run** `PYTHONPATH=src SS_TEST_DB=serversherpa_test_project_plans .venv/bin/pytest tests/test_plans_durations.py -q` → FAIL (module missing).
- [ ] **Step 4: Implement** `durations.py` — one regex `^\s*([+-]?)(\d+(?:\.\d+)?)\s*(e?)(mo|mons?|months?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)?\s*$` (case-insensitive; the `mo…` alternatives must be tried before `m…`); a bare number takes `default_unit`; minutes are `round(value × unit_minutes)`; a sign is only accepted by `parse_lag`. Format picks the singular label when the value is exactly 1 (`day hr min wk mon`, elapsed `eday ehr emin ewk emon`), plural otherwise (`days hrs mins wks mons`, elapsed with an `e` prefix).
- [ ] **Step 5: Run** the same command → PASS.
- [ ] **Step 6: Commit** `feat(plans): duration and lag parsing`.

### Task 3: Work calendar arithmetic (`plans/calendar.py`)

**Files:**
- Create: `api/src/serversherpa/plans/calendar.py`
- Test: `api/tests/test_plans_calendar.py`

**Interfaces:**
- Consumes: `Units` (Task 2).
- Produces:
  - `STANDARD_CALENDAR: dict` — the spec's Standard calendar JSON with `"exceptions": []`.
  - `class CalendarError(ValueError)` with `.code = "no_working_time"`.
  - `class WorkCalendar` with `WorkCalendar.from_json(data: dict) -> WorkCalendar` (raises `CalendarError` with code `bad_calendar` on malformed hours: end ≤ start, overlapping intervals, bad `HH:MM`), `.units -> Units`, `.default_start -> time`, `.default_end -> time`, and:
    - `intervals(day: date) -> list[tuple[datetime, datetime]]` (exception hours replace the weekday pattern; `[]` = nonworking)
    - `next_work_start(t: datetime) -> datetime` — `t` if inside `[s, e)`, else the next interval start. `t == e` is NOT inside.
    - `prev_work_end(t: datetime) -> datetime` — `t` if inside `(s, e]`, else the previous interval end.
    - `add_work(t: datetime, minutes: int) -> datetime` — `minutes == 0` returns `t` unchanged; otherwise starts from `next_work_start(t)` and may return an interval end exactly.
    - `sub_work(t: datetime, minutes: int) -> datetime` — mirror image from `prev_work_end(t)`; `0` returns `t`.
    - `work_between(a: datetime, b: datetime) -> int` — working minutes, negative when `b < a`.
    - `at_default_start(d: date) -> datetime`, `at_default_end(d: date) -> datetime` (used for date-only input).
  - Searching more than 3,660 days without finding working time raises `CalendarError`.

- [ ] **Step 1: Write the failing tests** (Standard calendar + the two reference exceptions):

| Test | Call | Expected |
|---|---|---|
| `test_next_start_before_day` | `next_work_start(dt("2026-11-02 07:00"))` | `2026-11-02 08:00` |
| `test_next_start_at_lunch` | `next_work_start(dt("2026-11-02 12:00"))` | `2026-11-02 13:00` |
| `test_next_start_at_day_end` | `next_work_start(dt("2026-11-02 17:00"))` | `2026-11-03 08:00` |
| `test_next_start_friday_end` | `next_work_start(dt("2026-11-06 17:00"))` | `2026-11-09 08:00` |
| `test_next_start_skips_holiday` | `next_work_start(dt("2026-11-25 17:00"))` | `2026-11-27 08:00` |
| `test_next_start_working_saturday` | `next_work_start(dt("2026-11-13 17:00"))` | `2026-11-14 06:00` |
| `test_add_full_day_ends_at_17` | `add_work(dt("2026-11-02 08:00"), 480)` | `2026-11-02 17:00` |
| `test_add_half_day_ends_at_lunch` | `add_work(dt("2026-11-02 08:00"), 240)` | `2026-11-02 12:00` |
| `test_add_crosses_lunch` | `add_work(dt("2026-11-02 08:00"), 300)` | `2026-11-02 14:00` |
| `test_add_from_day_end` | `add_work(dt("2026-11-02 17:00"), 60)` | `2026-11-03 09:00` |
| `test_add_over_weekend` | `add_work(dt("2026-11-06 13:00"), 960)` | `2026-11-10 12:00` |
| `test_add_zero_does_not_snap` | `add_work(dt("2026-11-02 17:00"), 0)` | `2026-11-02 17:00` |
| `test_sub_across_night` | `sub_work(dt("2026-11-03 08:00"), 60)` | `2026-11-02 16:00` |
| `test_sub_across_lunch` | `sub_work(dt("2026-11-02 13:00"), 60)` | `2026-11-02 11:00` |
| `test_sub_full_day` | `sub_work(dt("2026-11-02 17:00"), 480)` | `2026-11-02 08:00` |
| `test_between_forward` | `work_between(dt("2026-11-02 08:00"), dt("2026-11-03 12:00"))` | `720` |
| `test_between_backward` | swapped | `-720` |
| `test_between_inside_day` | `work_between(dt("2026-11-02 11:00"), dt("2026-11-02 14:00"))` | `120` |
| `test_no_working_time` | week all `[]`, `next_work_start(...)` | raises `CalendarError` |
| `test_bad_calendar` | `"mon": [["17:00","08:00"]]` | `from_json` raises `CalendarError`, `code == "bad_calendar"` |
| `test_units_from_calendar` | `hours_per_day=10` | `units.minutes_per_day == 600` |

- [ ] **Step 2: Run** `… pytest tests/test_plans_calendar.py -q` → FAIL.
- [ ] **Step 3: Implement** `calendar.py`. Interval lookup walks day by day from `t.date()`; memoize `intervals()` per date in an instance dict (calendars are immutable after `from_json`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans): work calendar arithmetic`.

### Task 4: Engine forward pass for leaf tasks (`plans/engine.py`)

**Files:**
- Create: `api/src/serversherpa/plans/engine.py`
- Test: `api/tests/test_plans_engine_forward.py`

**Interfaces:**
- Consumes: `WorkCalendar`, `CalendarError` (Task 3).
- Produces (Tasks 5–6 extend this file; keep these names):

```python
@dataclass(frozen=True)
class TaskIn:
    id: str
    parent_id: str | None
    position: int
    mode: str = "auto"                  # "auto" | "manual"
    duration: int = 480                 # minutes
    elapsed: bool = False
    is_milestone: bool = False
    constraint_type: str = "asap"       # asap snet snlt fnet fnlt mso mfo
    constraint_date: datetime | None = None
    deadline: datetime | None = None
    start: datetime | None = None       # used for manual tasks only
    finish: datetime | None = None
    actual_start: datetime | None = None
    actual_finish: datetime | None = None
    percent_complete: int = 0

@dataclass(frozen=True)
class LinkIn:
    predecessor_id: str
    successor_id: str
    link_type: str = "FS"               # FS SS FF SF
    lag: int = 0                        # signed minutes
    lag_elapsed: bool = False

@dataclass(frozen=True)
class EngineSettings:
    honor_constraints: bool = True
    critical_slack_minutes: int = 0

@dataclass
class TaskOut:
    start: datetime
    finish: datetime
    duration: int                       # minutes (derived for summaries)
    is_summary: bool
    percent_complete: int               # derived for summaries
    late_start: datetime | None = None
    late_finish: datetime | None = None
    total_slack: int | None = None      # working minutes
    is_critical: bool = False
    conflict: str | None = None         # None | "link" | "constraint"

class ScheduleError(ValueError):
    code: str
    task_ids: list[str]
# subclasses: CycleError("link_cycle"), OutlineLinkError("link_to_outline"),
# SummaryLinkError("bad_summary_link"), SummaryConstraintError("bad_summary_constraint")

def schedule(tasks: list[TaskIn], links: list[LinkIn], calendar: WorkCalendar,
             project_start: datetime, settings: EngineSettings = EngineSettings()
             ) -> dict[str, TaskOut]
```

- [ ] **Step 1: Write the failing tests.** Project start `dt("2026-11-02 08:00")` unless stated; every task is a leaf (no parents) in this task. Durations in minutes (1d = 480). "→ X" means an FS link unless another type is named.

| Test | Setup | Expected |
|---|---|---|
| `test_single_task` | A 2400 | A 11-02 08:00 → 11-06 17:00 |
| `test_project_start_on_sunday` | start `11-01 00:00`, A 480 | A 11-02 08:00 → 17:00 |
| `test_fs` | A 960 → B 480 | B 11-04 08:00 → 11-04 17:00 |
| `test_fs_lag` | A 960 →FS+480 B 480 | B starts 11-05 08:00 |
| `test_fs_lead` | A 960 →FS−240 B 480 | B 11-03 13:00 → 11-04 12:00 |
| `test_fs_elapsed_lag` | A 480 →FS+1440 (elapsed) B 480 | B starts 11-04 08:00 |
| `test_ss_lag` | A 1440 →SS+480 B 480 | B 11-03 08:00 → 17:00 |
| `test_ff` | A 1440 →FF B 480 | B 11-04 08:00 → 11-04 17:00 |
| `test_sf` | A 480 SNET `11-04 08:00` →SF B 480 | B 11-03 08:00 → 11-03 17:00 |
| `test_max_of_predecessors` | A 480 → B, C 1440 → B, B 480 | B starts 11-05 08:00 |
| `test_lunch_snap` | A 240 → B 240 | B 11-02 13:00 → 17:00 |
| `test_milestone_no_snap` | A 960 → M 0 | M start = finish = 11-03 17:00 |
| `test_elapsed_task` | A 480 → E 2880 elapsed | E 11-02 17:00 → 11-04 17:00 |
| `test_snet` | A 480 SNET `11-05 08:00` | A 11-05 08:00 → 17:00 |
| `test_fnet` | A 480 FNET `11-06 17:00` | A 11-06 08:00 → 17:00 |
| `test_mfo` | A 960 MFO `11-06 17:00` | A 11-05 08:00 → 11-06 17:00 |
| `test_mso_honored` | A 1920 → B 480 MSO `11-04 08:00` | B 11-04 08:00, `conflict == "link"` |
| `test_mso_not_honored` | same, `honor_constraints=False` | B 11-06 08:00, `conflict == "constraint"` |
| `test_snlt_honored` | A 960 → B 480 SNLT `11-03 08:00` | B 11-03 08:00, `conflict == "link"` |
| `test_snlt_not_honored` | same, honor off | B 11-04 08:00, `conflict == "constraint"` |
| `test_fnlt_honored` | A 960 → B 480 FNLT `11-03 17:00` | B finish 11-03 17:00, `conflict == "link"` |
| `test_snlt_satisfied` | B 480 SNLT `11-05 08:00`, no preds | B 11-02 08:00, `conflict is None` |
| `test_manual_task_stays` | A 1920 → M manual start `11-03 10:00` finish `11-04 15:00` | M unchanged |
| `test_manual_drives_successor` | M (as above) → B 480 | B 11-04 15:00 → 11-05 15:00 |
| `test_actual_start_pins` | A 1920 → B 480 `actual_start 11-02 10:00` | B 11-02 10:00 → 11-03 10:00 |
| `test_actual_finish_pins` | A 480 `actual_start 11-02 08:00` `actual_finish 11-03 12:00` | A finish 11-03 12:00 |
| `test_not_started_past_is_not_moved` | project start `2026-01-05 08:00`, A 480 | A 01-05 08:00 → 17:00 |
| `test_holiday_skipped` | start `11-25 08:00`, A 960 | A finish 11-27 17:00 |
| `test_working_saturday` | start `11-13 08:00`, A 960 | A 11-13 08:00 → 11-14 14:00 |

- [ ] **Step 2: Run** `… pytest tests/test_plans_engine_forward.py -q` → FAIL.
- [ ] **Step 3: Implement the forward pass** for leaves. Order leaves topologically over links (Kahn, ties by `position`). For each auto leaf compute the earliest raw start as the max of: project start; each predecessor bound (FS: `P.finish ± lag`; SS: `P.start ± lag`; FF: `sub_work(P.finish ± lag, D)`; SF: `sub_work(P.start ± lag, D)` — working lag through `add_work`/`sub_work`, elapsed lag and elapsed `D` through `timedelta`); the constraint floor (SNET date; FNET `sub_work(date, D)`). Then: non-elapsed with `D > 0` → `start = next_work_start(raw)`, `finish = add_work(start, D)`; `D == 0` → `start = finish = raw`; elapsed → `start = raw`, `finish = start + D`. Constraint ceilings and pins (SNLT, FNLT, MSO, MFO) follow the spec's *Honor constraints* rule and set `conflict`. `actual_start` replaces start; `actual_finish` replaces finish. Manual leaves keep their stored start/finish (`finish = add_work(start, D)` when only start is stored; project start when neither). Late fields stay `None` in this task.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans): engine forward pass`.

### Task 5: Engine summaries, outline rules and cycles

**Files:**
- Modify: `api/src/serversherpa/plans/engine.py`
- Test: `api/tests/test_plans_engine_summary.py`

**Interfaces:**
- Consumes: Task 4's types.
- Produces: `schedule()` handles `parent_id`; raises the four `ScheduleError` subclasses; `TaskOut.is_summary`, derived `duration` and `percent_complete` for summaries.

- [ ] **Step 1: Write the failing tests.** `S{A, B}` means A and B are children of S.

| Test | Setup | Expected |
|---|---|---|
| `test_summary_rollup_dates` | S{A 960, B 1440} | S 11-02 08:00 → 11-04 17:00, `duration == 1440`, `is_summary` |
| `test_link_into_summary_moves_children` | X 960 → S{A 480, B 480} | A and B start 11-04 08:00 |
| `test_ss_into_summary` | X 960 →SS+480 S{A 480} | A starts 11-03 08:00 |
| `test_link_from_summary` | S{A 960} → Y 480 | Y starts 11-04 08:00 |
| `test_nested_summary_gate` | X 480 → S1{S2{A 480}} | A starts 11-03 08:00 |
| `test_child_link_inside_summary` | S{A 960 → B 480} | B 11-04 08:00; S finish 11-04 17:00 |
| `test_link_to_own_parent_rejected` | S{A}, link A→S | `OutlineLinkError`, `set(task_ids) == {A, S}` |
| `test_link_from_parent_to_child_rejected` | S{A}, link S→A | `OutlineLinkError` |
| `test_link_to_grandchild_rejected` | S1{S2{A}}, link S1→A | `OutlineLinkError` |
| `test_cycle_rejected` | A→B→C→A | `CycleError`, `set(task_ids) == {A,B,C}` |
| `test_cycle_through_rollup` | S{A}, links S→B, B→A | `CycleError` |
| `test_ff_into_summary_rejected` | X →FF S{A} | `SummaryLinkError` |
| `test_summary_constraint_rejected` | S{A} with `constraint_type="mso"` | `SummaryConstraintError` |
| `test_summary_snet_applies` | S{A 480} SNET `11-04 08:00` | A starts 11-04 08:00 |
| `test_rollup_percent_weighted` | S{A 480 100%, B 1440 0%} | S `percent_complete == 25` |
| `test_rollup_percent_milestones` | S{M1 0 100%, M2 0 0%} | S `percent_complete == 50` |

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Graph nodes per the spec's *Summary tasks* paragraph: leaf `L`; per summary `G:S` (entry gate) and `R:S` (rollup). Edges: `G:parent → child` (leaf or `G:child-summary`); each direct child (leaf or `R:child-summary`) `→ R:S`; a link `P→S` goes from `P` (or `R:P`) to `S` (or `G:S`). Before sorting, reject outline links (predecessor is an ancestor/descendant of the successor), FF/SF links whose successor is a summary, and summary constraints other than `asap`/`snet`. A gate's raw start = max(project start, parent gate, FS/SS bounds into it, SNET). A cycle's `task_ids` are the tasks left unsorted when Kahn stops (map `G:`/`R:` back to the summary id). Rollup % = `round(Σ pct·dur / Σ dur)` over leaf descendants, count-weighted when `Σ dur == 0`.
- [ ] **Step 4: Run** this file and Task 4's → PASS.
- [ ] **Step 5: Commit** `feat(plans): summary tasks, outline rules, cycle detection`.

### Task 6: Engine backward pass — slack, critical path, deadlines

**Files:**
- Modify: `api/src/serversherpa/plans/engine.py`
- Test: `api/tests/test_plans_engine_slack.py`

**Interfaces:**
- Produces: `TaskOut.late_start`, `late_finish`, `total_slack`, `is_critical` filled for every task.

- [ ] **Step 1: Write the failing tests.**

| Test | Setup | Expected |
|---|---|---|
| `test_chain_is_critical` | A 960 → B 480; C 480 alone | A, B slack 0 critical; C slack 960, not critical |
| `test_deadline_tightens_slack` | A 960 → B 480; C 480 deadline `11-02 17:00` | C slack 0, critical |
| `test_missed_deadline_negative` | D 960 deadline `11-02 17:00` | D slack −480, critical |
| `test_threshold` | `critical_slack_minutes=960`, chain + C | C critical |
| `test_complete_never_critical` | chain, A 100% | A `is_critical is False` |
| `test_summary_slack_is_min` | S{A 960 → B 480, C 480} | S slack 0, critical |
| `test_fs_lag_backward` | A 480 →FS+480 B 480 | A slack 0 |
| `test_ss_backward` | A 1440 →SS B 480 | A slack 0; B slack 960 |
| `test_fnlt_caps_late_finish` | A 960 FNLT `11-02 17:00`, honor off | A slack −480 |
| `test_perf_2000_tasks` | 200 summaries × 10 leaves, 3,000 FS links from lower to higher position (`random.Random(7)`) | `schedule()` < 1.0 s (print the time; the spec's target is 200 ms) |

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Project finish = max leaf finish. In reverse topological order a node's late finish = min(project finish, deadline, FNLT/MFO date, each successor's requirement — FS `LS(S) ∓ lag`, SS `add_work(LS(S) ∓ lag, D)`, FF `LF(S) ∓ lag`, SF `add_work(LF(S) ∓ lag, D)`); SNLT/MSO cap late start; `late_start = sub_work(late_finish, D)`. A gate passes its late start down as a cap on every child; a rollup's successor requirements apply to every leaf descendant (conservative for SS/SF from a summary); a summary's deadline caps every descendant. `total_slack = work_between(start, late_start)`; `is_critical = slack <= critical_slack_minutes and percent_complete < 100`; summary slack = min over descendants, critical if any descendant is.
- [ ] **Step 4: Run** all `tests/test_plans_engine_*.py` → PASS.
- [ ] **Step 5: Commit** `feat(plans): slack and critical path`.

### Task 7: Predecessor text (`plans/predecessors.py`) + shared vectors

**Files:**
- Create: `api/src/serversherpa/plans/predecessors.py`
- Create: `api/tests/fixtures/plans/predecessors.json`
- Test: `api/tests/test_plans_predecessors.py`

**Interfaces:**
- Consumes: `parse_lag`, `format_lag`, `Units`, `Duration` (Task 2).
- Produces:
  - `@dataclass(frozen=True) class PredSpec: display_id: int; link_type: str; lag: Duration`
  - `class PredecessorError(ValueError)` with `.code = "bad_predecessor"` and `.detail: str`.
  - `parse_predecessors(text: str, units: Units, *, valid_ids: set[int], self_id: int | None) -> list[PredSpec]`
  - `format_predecessors(specs: list[PredSpec], units: Units) -> str`

- [ ] **Step 1: Vectors** — `parse` rows `[text, [[id, type, minutes, unit, elapsed], ...]]`: `"3"`→`[[3,"FS",0,"d",false]]`; `"3FS+2d"`→`[[3,"FS",960,"d",false]]`; `"5SS"`→`[[5,"SS",0,"d",false]]`; `"7FF-4h"`→`[[7,"FF",-240,"h",false]]`; `"9SF+1ed"`→`[[9,"SF",1440,"d",true]]`; `"2,3FS+1d"`→`[[2,"FS",0,"d",false],[3,"FS",480,"d",false]]`; `" 4 ss "`→`[[4,"SS",0,"d",false]]`; `"3FS+2 days"`→`[[3,"FS",960,"d",false]]`. `invalid` (with `valid_ids` 1–9, `self_id` 1): `"0"`, `"x"`, `"3XX"`, `"3FS+"`, `"3,3"`, `"12"`, `"1"`. `format` rows: `[[3,"FS",0,"d",false]]`→`"3"`; `[[5,"SS",0,"d",false]]`→`"5SS"`; `[[3,"FS",960,"d",false]]`→`"3FS+2 days"`; `[[7,"FF",-240,"h",false]]`→`"7FF-4 hrs"`; `[[2,"FS",0,"d",false],[3,"SS",0,"d",false]]`→`"2,3SS"`.
- [ ] **Step 2: Failing tests** `test_parse_vectors`, `test_invalid_vectors`, `test_format_vectors`, `test_empty_string_is_no_links` (`""` and `"  "` → `[]`).
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** — split on commas; each part matches `^(\d+)\s*(FS|SS|FF|SF)?\s*([+-].+)?$` case-insensitively; lag through `parse_lag`; duplicates, unknown and self ids raise.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(plans): predecessor text`.

### Task 8: Plan service + create / read / delete routes

**Files:**
- Create: `api/src/serversherpa/plans/service.py`, `api/src/serversherpa/plans/schemas.py`, `api/src/serversherpa/plans/floating.py`
- Create: `api/src/serversherpa/api/routes/plans.py` (`router = APIRouter(tags=["plans"])`, full paths, no prefix)
- Modify: `api/src/serversherpa/api/app.py` (import + `app.include_router(plans.router)`)
- Test: `api/tests/test_plans_api.py`, `api/tests/test_plans_floating.py`

**Interfaces:**
- Consumes: models + `effective`/`load_system` (Task 1), `WorkCalendar`/`STANDARD_CALENDAR` (Task 3), `schedule`/`TaskIn`/`LinkIn`/`EngineSettings` (Tasks 4–6), `format_duration` (Task 2), `format_predecessors` (Task 7).
- Produces:
  - `plans/floating.py`: `parse_floating(text: str, *, date_only_time: time) -> datetime` (accepts `YYYY-MM-DD` → that day at `date_only_time`, or `YYYY-MM-DDTHH:MM[:SS]`; rejects offsets/`Z` with `ValueError`), `format_floating(dt: datetime | None) -> str | None` (`YYYY-MM-DDTHH:MM`), `plan_now(zone_name: str) -> datetime` (naive wall-clock now in that zone).
  - `plans/service.py`:
    - `async def visible_initiative(db, initiative_id: uuid.UUID, actor: AuthContext) -> Initiative` — the `_get_initiative` pattern from `routes/initiatives.py:97` (404 `initiative_not_found`).
    - `async def plan_for_actor(db, plan_id: uuid.UUID, actor: AuthContext, *, lock: bool = False) -> ProjectPlan` — 404 `plan_not_found` when the plan is missing or its initiative is invisible; `lock=True` uses `SELECT … FOR UPDATE` on the plan row (every write path locks).
    - `@dataclass class PlanState: plan; tasks: dict[uuid, PlanTask]; links: dict[uuid, PlanLink]; assignments: dict[uuid, list[PlanAssignment]]; order: list[uuid]` and `async def load_state(db, plan) -> PlanState` (order = by `position`).
    - `def calendar_of(plan) -> WorkCalendar`; `async def settings_of(db, plan) -> PlanSettings`.
    - `def recalc(state: PlanState, settings: PlanSettings) -> set[uuid.UUID]` — runs `schedule()` and writes `start`, `finish`, `total_slack_minutes`, `is_critical`, `conflict` (and, for summaries, `duration_minutes` and `percent_complete`) onto the ORM rows; returns ids whose stored values changed. `critical_slack_minutes = round(critical_slack_days × minutes_per_day)`.
    - `def renumber(state: PlanState) -> None` — rewrites `position` 0..n−1 in outline order (parent before children, siblings by current position).
    - `async def create_plan(db, initiative, actor, *, project_start: datetime, owner_id: uuid.UUID | None) -> ProjectPlan` — timezone = the initiative's site zone via `learning.codes.initiative_zone`, falling back to `services.timezone.DEFAULT_TIMEZONE` when that yields UTC because no site zone is known; calendar = system `calendar`; `version = 1`; audit `plan_create`.
    - `async def plan_out(db, state: PlanState, actor) -> PlanOut`.
  - `plans/schemas.py` (pydantic): `PlanCreateIn {project_start: str, owner_id: UUID | None = None, template_id: UUID | None = None}` (`template_id` is accepted and ignored until Plan C Task 6 wires it); `PlanOut`; `PlanTaskOut`; `PlanLinkOut`; `ResourceOut`. Field lists:
    - `PlanOut`: `id, initiative_id, initiative_name, initiative_window {start: str|None, end: str|None}` (date strings via `stored_day`), `timezone, project_start, project_finish, status_date, now, calendar, settings_overrides, settings` (effective, as a dict), `owner_id, owner_name, locked_at, locked_by_name, baseline_set_at, version, permissions {view, add, change, delete}, tasks: list[PlanTaskOut], links: list[PlanLinkOut], resources: list[ResourceOut]`.
    - `PlanTaskOut`: `id, display_id, wbs, outline_level, parent_id, position, is_summary, name, is_milestone, mode, duration_minutes, duration_unit, elapsed, duration_text, start, finish, constraint_type, constraint_date, deadline, percent_complete, actual_start, actual_finish, notes, show_on_timeline, total_slack_minutes, is_critical, conflict, baseline_start, baseline_finish, baseline_duration_minutes, completed_at, completed_by_name, predecessors, successors, assignees: [{kind, id, name}], status, missed_deadline, updated_at`. `status` ∈ `complete | late | in_progress | not_started` (late = incomplete and finish, or deadline when set and earlier, is before the plan's status date or now); `missed_deadline` = deadline set and finish > deadline. All plan times through `format_floating`.
    - `PlanLinkOut`: `id, predecessor_id, successor_id, link_type, lag_minutes, lag_unit, lag_elapsed, lag_text`.
    - `ResourceOut`: `kind ("person"|"partner"), id, name, group ("team"|"staff"|"partner"), has_email, has_account` — team = `InitiativePerson` rows of the initiative; staff = people holding a role whose `scope_anchor = 'global'` and a `UserAccount`; partner = the initiative's non-null partner FK columns (shipping, origin/destination tech/cable/logistics). A person in both team and staff is listed once as team.
  - Routes: `GET /initiatives/{initiative_id}/plan` (view) → `PlanOut` or 404 `no_plan`; `POST /initiatives/{initiative_id}/plan` (add) → 201 `PlanOut`, 409 `plan_exists`; `DELETE /initiatives/{initiative_id}/plan` (delete) → 204, audit `plan_delete`. Every route: `require_permission("project_plans", <action>)` then `visible_initiative`.

- [ ] **Step 1: Failing tests.** Helpers at the top of `test_plans_api.py`: `_admin(db, client)` = `_make(db, client, "admin", f"pa-{uuid4().hex[:8]}@test.example.com")` (from `tests.test_status_values_write`); `_initiative(db, name="Move")` as in `tests/test_learning_assign.py`.
  - `test_floating.py`: `parse_floating("2026-11-02", date_only_time=time(8))` → `datetime(2026,11,2,8,0)`; `"2026-11-02T13:30"` → 13:30; `"2026-11-02T13:30:00Z"` raises; `format_floating(datetime(2026,11,2,8,0))` → `"2026-11-02T08:00"`; `plan_now("America/Chicago")` is naive and within 2 minutes of `datetime.now(ZoneInfo("America/Chicago")).replace(tzinfo=None)`.
  - `test_create_and_get_plan` — POST `{"project_start": "2026-11-02"}` → 201; body `project_start == "2026-11-02T08:00"`, `version == 1`, `tasks == []`, `timezone == "America/New_York"` (no site), `calendar["hours_per_day"] == 8`, `permissions == {"view": True, "add": True, "change": True, "delete": True}`, `settings["completion"] == {"subtasks": "cascade", "predecessors": "block"}`; GET returns the same id.
  - `test_site_zone_used` — initiative with a site whose `timezone = "America/Chicago"` → plan `timezone == "America/Chicago"`.
  - `test_get_without_plan` → 404 `no_plan`. `test_create_twice` → 409 `plan_exists`.
  - `test_staff_forbidden` — `login(client)` (seeded staff) GET → 403 `forbidden`.
  - `test_unknown_initiative` → 404 `initiative_not_found`.
  - `test_delete_plan` → 204; GET → 404 `no_plan`; an `audit_log` row with action `plan_delete`.
  - `test_resources_listed` — initiative with one `InitiativePerson` worker (no account) and a shipping partner → `resources` contains `{"kind": "person", "group": "team", "has_account": False}` and `{"kind": "partner", "group": "partner"}` entries, and the admin themself as `group == "staff"`.
- [ ] **Step 2: Run** `… pytest tests/test_plans_floating.py tests/test_plans_api.py -q` → FAIL.
- [ ] **Step 3: Implement** `floating.py`, `schemas.py`, `service.py`, the three routes, router registration.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans): plan service and create/read/delete routes`.

### Task 9: Ops endpoint — task structure edits, versioning, undo, lock

**Files:**
- Create: `api/src/serversherpa/plans/ops.py`
- Modify: `api/src/serversherpa/plans/schemas.py` (op models), `api/src/serversherpa/api/routes/plans.py`
- Test: `api/tests/test_plans_ops.py`

**Interfaces:**
- Consumes: Task 8's `plan_for_actor(lock=True)`, `load_state`, `recalc`, `renumber`, `settings_of`, `calendar_of`; `parse_duration` (Task 2); `parse_floating` (Task 8).
- Produces:
  - `POST /plans/{plan_id}/ops` (`project_plans:change`) body `OpsIn {base_version: int, ops: list[Op]}` → `OpsOut {version: int, tasks: list[PlanTaskOut], links: list[PlanLinkOut], deleted_tasks: list[UUID], deleted_links: list[UUID], order: list[UUID] | None, temp_ids: dict[str, UUID], inverse: list[dict], notices: list[dict]}`. `tasks`/`links` carry only rows whose stored fields changed; `order` is the full outline order whenever any `position`/`parent_id` changed (else `None`) — the portal recomputes display IDs, WBS and predecessor text from it (Plan B).
  - Op models (pydantic, discriminated on `op`) in this task: `add_task {temp_id?: str, before_id?: UUID, parent_id?: UUID, name: str = "", duration?: str, start?: str, finish?: str, mode?: str, is_milestone?: bool, deadline?: str, notes?: str}` (with `before_id` it inserts above that row as its sibling; without, it appends as the last child of `parent_id` or at the end of the plan); `update_task {id, fields: TaskFields}`; `delete_tasks {ids}`; `move_tasks {ids, before_id?: UUID, parent_id?: UUID}`; `indent {ids}`; `outdent {ids}`; `restore {tasks: list[dict], links: list[dict], assignments: list[dict], remove_tasks: list[UUID], remove_links: list[UUID]}`.
  - `TaskFields` (all optional): `name, duration (str), start (str), finish (str), mode, is_milestone, constraint_type, constraint_date (str|None), deadline (str|None), percent_complete (int), actual_start, actual_finish, notes, show_on_timeline, predecessors (str — Task 10)`.
  - `async def apply_ops(db, state: PlanState, ops: list[Op], actor, settings: PlanSettings) -> OpResult` with `@dataclass class OpResult: changed_tasks: set[UUID]; changed_links: set[UUID]; deleted_tasks: set[UUID]; deleted_links: set[UUID]; outline_changed: bool; temp_ids: dict[str, UUID]; inverse: list[dict]; notices: list[dict]; newly_assigned: dict[UUID, list[UUID]]` (person id → task ids; Task 10 fills it, Plan C consumes it).
  - `PROGRESS_FIELDS = {"percent_complete", "actual_start", "actual_finish", "notes"}` and `def is_progress_only(ops) -> bool` (Task 11 adds its op names).

Rules to implement (and test):
- The whole batch runs in one transaction under the plan row lock; any error rolls everything back (plan `version` unchanged). Structural batches need `base_version == plan.version` else 409 `plan_changed` `{version: <current>}`; a locked plan refuses them with 409 `plan_locked`. Every successful batch bumps `version` by 1, sets `updated_by/at`, writes one audit row (`plan_update`, `changes = {"ops": {<op>: count}}`).
- Unknown task/link ids (including ids of another plan) → 422 `unknown_task` / `unknown_link`.
- **Inverse:** before mutating, snapshot the *input* fields (never computed ones) of every task/link/assignment the batch will touch; `inverse` is one `restore` op that re-creates deleted rows, removes created rows and puts changed rows back. Applying `inverse` and then its own `inverse` returns to the post-batch state.
- **Editing rules** (spec *Editing rules that touch the engine*): `start` on an auto task → `constraint_type="snet"`, `constraint_date` = parsed start (date-only → calendar default start) and a notice `{"code": "constraint_added", "task_id", "constraint_type": "snet"}`; `finish` on an auto task → FNET (date-only → default end); both in one update → SNET + `duration_minutes = work_between(start, finish)`; on a manual task they set `start`/`finish` directly (and `duration_minutes = work_between`). `duration` text → `duration_minutes`, `duration_unit`, `elapsed`; `"0"` (or any 0 duration) sets `is_milestone = True`; a non-zero duration on a milestone created by a 0 duration clears the flag. Summary tasks reject `duration`, `start`, `finish`, `percent_complete` edits with 422 `summary_field` (their values are derived; completion goes through `complete`, Task 11).
- **Defaults for new tasks:** `mode` = settings `default_task_mode`, duration = settings `default_duration`, `show_on_timeline = is_milestone`.
- **delete_tasks** deletes subtrees (and their links via FK cascade). **indent**: each task becomes the last child of its previous sibling (422 `cannot_indent` when it has none); **outdent**: the task moves up one level to sit right after its old parent, and the siblings that followed it become its children (MS Project behavior); 422 `cannot_outdent` at top level. Multi-id indent/outdent process ids in outline order. After any outline change call `renumber`.
- After the ops: `recalc` (a `ScheduleError` → 422 with `code` and `task_ids`), collect changed rows, build `OpsOut`.

- [ ] **Step 1: Failing tests** (`test_plans_ops.py`; helper `_ops(client, hdrs, plan, ops, version=None)` posts with the plan's current version unless given):
  - `test_add_tasks_and_schedule` — add "A" `duration "2d"` then "B" `duration "1d"` → both start `2026-11-02T08:00` (no links yet); `temp_ids` maps both; `version == 2`; `order` lists A then B.
  - `test_insert_before` — insert C `before_id=B` → `order == [A, C, B]`.
  - `test_update_duration_reschedules` — A `"3d"` → A finish `2026-11-04T17:00`, `duration_text == "3 days"`.
  - `test_zero_duration_makes_milestone` — `duration "0"` → `is_milestone`, start == finish.
  - `test_typed_start_adds_snet` — A `start "2026-11-05"` → `constraint_type == "snet"`, `constraint_date == "2026-11-05T08:00"`, start `2026-11-05T08:00`, one notice `constraint_added`.
  - `test_manual_task_dates` — `mode "manual"`, `start "2026-11-03T10:00"`, `finish "2026-11-04T15:00"` → stored as typed, `duration_minutes == 720`.
  - `test_indent_outdent` — A, B, C; indent B → B.parent = A, A `is_summary`; indent C → C child of A; outdent B → B top-level, C now child of B (the "following siblings" rule); indent A → 422 `cannot_indent`.
  - `test_summary_field_rejected` — set `duration` on summary A → 422 `summary_field`.
  - `test_delete_subtree` — delete A (summary) → its children are gone, `deleted_tasks` lists all three.
  - `test_stale_version` — structural batch with `base_version` one behind → 409 `plan_changed`, body has the current version, nothing changed.
  - `test_batch_is_atomic` — batch [`update A name "X"`, `add_task`, `update_task` with an unknown id] → 422 `unknown_task`; GET shows A's old name, no new task, same version. (Review Focus 3)
  - `test_other_plans_task_id` — a task id from a second initiative's plan in `update_task` → 422 `unknown_task`. (Review Focus 5)
  - `test_locked_refuses_structure` — set `locked_at` directly in the DB, add_task → 409 `plan_locked`.
  - `test_inverse_round_trip` — batch [rename A, delete B, add D]; post `inverse` as the next batch → state equals the pre-batch state (names, ids of A and B, D gone); post that response's `inverse` → back to the post-batch state.
  - `test_audit_row` — one `plan_update` audit row per batch with op counts.
- [ ] **Step 2: Run** `… pytest tests/test_plans_ops.py -q` → FAIL.
- [ ] **Step 3: Implement** `ops.py`, op schemas, the route.
- [ ] **Step 4: Run** → PASS (and `tests/test_plans_api.py` still passes).
- [ ] **Step 5: Commit** `feat(plans): ops endpoint for task edits with undo and versioning`.

### Task 10: Links, predecessor text and assignees

**Files:**
- Modify: `api/src/serversherpa/plans/ops.py`, `api/src/serversherpa/plans/schemas.py`
- Test: `api/tests/test_plans_links.py`

**Interfaces:**
- Consumes: `parse_predecessors`/`PredSpec` (Task 7), `parse_lag` (Task 2), Task 9's op machinery.
- Produces ops: `add_link {predecessor_id, successor_id, link_type = "FS", lag: str = "0"}`, `update_link {id, link_type?, lag?}`, `delete_link {id}`, `update_task.fields.predecessors: str` (replaces every incoming link of that task; display IDs resolved against the current outline order *before* the batch's outline changes are applied — document this in the op docstring), `set_assignees {task_id, resources: list[{kind: "person"|"partner", id: UUID}]}` (replaces the task's assignments). `OpResult.newly_assigned` gains person ids that were not assigned to that task before.

Rules: a link to self → 422 `bad_link`; an existing (pred, succ) pair → 422 `duplicate_link`; engine errors surface as 422 `link_cycle` / `link_to_outline` / `bad_summary_link` with `task_ids` and `display_ids`; a resource that is not in the plan's `resources` list → 422 `bad_resource`; assignees on a summary task are allowed.

- [ ] **Step 1: Failing tests:**
  - `test_add_fs_link_moves_successor` — A 2d, B 1d; `add_link A→B` → B start `2026-11-04T08:00`; B `predecessors == "1"`, A `successors == "2"` (from GET).
  - `test_link_types_and_lag` — `add_link A→B SS lag "+1d"` → B starts `2026-11-03T08:00`; `lag_text == "+1 day"`.
  - `test_predecessors_text` — B `fields.predecessors = "1FS+2d"` → one link, lag 960; then `""` → no links.
  - `test_bad_predecessor_text` — `"9"` (no task 9) → 422 `bad_predecessor`.
  - `test_cycle` — A→B, then B→A → 422 `link_cycle`, `display_ids == [1, 2]` (sorted), plan unchanged.
  - `test_link_to_parent` — S{A}, `add_link A→S` → 422 `link_to_outline`.
  - `test_duplicate_and_self` — second A→B → 422 `duplicate_link`; A→A → 422 `bad_link`.
  - `test_update_and_delete_link` — change to FF then delete; B moves back.
  - `test_set_assignees` — a team worker + a partner → `assignees` lists both with names; a random person id → 422 `bad_resource`.
  - `test_newly_assigned_reported` — unit-level: `apply_ops` with `set_assignees` twice returns the person only the first time.
- [ ] **Step 2: Run** `… pytest tests/test_plans_links.py -q` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans): links, predecessor text and assignees`.

### Task 11: Progress, completion rules, Mark on Track, Update project

**Files:**
- Create: `api/src/serversherpa/plans/completion.py`
- Modify: `api/src/serversherpa/plans/ops.py`, `api/src/serversherpa/plans/schemas.py`, `api/src/serversherpa/api/routes/plans.py`
- Test: `api/tests/test_plans_progress.py`

**Interfaces:**
- Produces:
  - Ops: `set_percent {ids, percent: int 0–100, confirm: bool = False}`, `complete {ids, confirm: bool = False}` (= `set_percent` 100), `mark_on_track {ids}`; `update_task` with `percent_complete` routes through the same code. `is_progress_only` now also accepts these op names and `update_task` whose fields ⊆ `PROGRESS_FIELDS`.
  - `completion.py`: `@dataclass class Blocker: task_id: UUID; display_id: int; name: str; reason: str` (`"subtask"|"predecessor"`) and `def check_completion(state: PlanState, task_ids: list[UUID], rules: Completion) -> tuple[list[Blocker], list[Blocker], list[UUID]]` → `(blocked, needs_confirm, cascade_ids)`.
  - `POST /plans/{plan_id}/update-project` (`change`) body `{status_date: str | None, complete_through: str | None = None, confirm: bool = False}` → `OpsOut`.

Rules:
- Progress-only batches skip the `base_version` check and are accepted on a locked plan (Review Focus 4); everything else is unchanged.
- Setting % > 0 fills `actual_start` with the scheduled start when empty; 100 fills `actual_finish` with the scheduled finish when empty and sets `completed_at`/`completed_by`; < 100 clears `actual_finish`, `completed_at`, `completed_by`; 0 also clears `actual_start`.
- When a task reaches 100% (any path except `restore`), apply the plan's effective `completion` rules: **subtasks** `cascade` → its open leaf descendants are `needs_confirm` (reason `subtask`) and, once confirmed, are completed too; `block` → they are `blocked`; `none` → skipped. **predecessors** (every task linked into it or into any ancestor, open only) `block` → `blocked`; `warn` → `needs_confirm`; `none` → skipped. Tasks completed in the same batch don't count as open. Any `blocked` → 409 `completion_blocked {blockers: [...]}`; else any `needs_confirm` without `confirm: true` → 409 `completion_confirm {will_complete: [...subtask blockers], open_predecessors: [...]}`; nothing is written in either case.
- `mark_on_track`: percent = `round(100 × work_between(start, min(status, finish)) / duration)` clamped 0–100, where status = the plan's status date or `plan_now`; milestones → 100 when start ≤ status else 0. Reaching 100 goes through the rules.
- `update-project`: sets `status_date` (null = now); with `complete_through`, every incomplete leaf finishing on or before it → 100 and every leaf spanning it → on track, all through the rules with `confirm`.

- [ ] **Step 1: Failing tests:**
  - `test_percent_sets_actuals` — A 50% → `actual_start == start`; 100% → `actual_finish == finish`, `completed_by_name` set; back to 40% → `actual_finish is None`.
  - `test_summary_complete_cascades_with_confirm` — S{A, B}: `complete [S]` → 409 `completion_confirm`, `will_complete` lists A and B; with `confirm: true` → A, B, S 100%.
  - `test_subtasks_block_rule` — plan override `completion.subtasks = "block"` (PATCH from Task 12, or set the JSON directly) → `complete [S]` → 409 `completion_blocked` with reason `subtask`.
  - `test_predecessor_block_default` — A→B, `complete [B]` → 409 `completion_blocked`, blocker A reason `predecessor`.
  - `test_predecessor_of_ancestor` — X→S{B}: `complete [B]` blocked by X.
  - `test_predecessor_warn` — override `warn` → 409 `completion_confirm` with `open_predecessors == [A]`; `confirm` → B 100%, A unchanged.
  - `test_same_batch_counts` — `complete [A, B]` in one op with A→B → succeeds.
  - `test_progress_skips_version_and_lock` — locked plan, stale `base_version`, `set_percent` → 200 and version bumped. (Review Focus 4)
  - `test_mark_on_track` — status date `2026-11-04T12:00`, A 5d from `11-02 08:00` → 50%.
  - `test_update_project` — three chained 1d tasks, `complete_through "2026-11-03T17:00"` with `confirm: true` → first two 100%, third 0%; `status_date` stored.
- [ ] **Step 2: Run** `… pytest tests/test_plans_progress.py -q` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans): progress and completion rules`.

### Task 12: Plan settings, lock, baseline, version probe, system settings

**Files:**
- Modify: `api/src/serversherpa/api/routes/plans.py`, `api/src/serversherpa/plans/schemas.py`, `api/src/serversherpa/plans/service.py`
- Modify: `api/src/serversherpa/api/routes/system.py` (`GET|PUT /system/project-plans`)
- Test: `api/tests/test_plans_settings_api.py`

**Interfaces:**
- Produces:
  - `PATCH /plans/{plan_id}` (`change`) body `PlanPatchIn {base_version: int, project_start?: str, timezone?: str, status_date?: str | None, owner_id?: UUID, calendar?: dict, settings?: dict}` → `PlanOut`. `settings` is a partial overrides dict deep-merged into `plan.settings` (a `null` leaf deletes that override = inherit). Validation through `PlanSettingsOverrides` (pydantic, `extra="forbid"`, same enums/ranges as the system schema). Calendar through `WorkCalendar.from_json` (422 `bad_calendar`); timezone through `ZoneInfo` (422 `bad_timezone`); owner must be a staff resource (422 `bad_owner`). A locked plan accepts only `status_date` and `owner_id` (else 409 `plan_locked`). Recalc after every PATCH. Audit `plan_settings`.
  - `POST /plans/{plan_id}/lock` / `DELETE /plans/{plan_id}/lock` (`change`) → `PlanOut`; audit `plan_lock` / `plan_unlock`.
  - `POST /plans/{plan_id}/baseline` (`change`) body `{replace: bool = False}` → copies `start`, `finish`, `duration_minutes` into the baseline columns for every task, sets `baseline_set_at/by`; 409 `baseline_exists {set_at}` when one exists and `replace` is false. `DELETE /plans/{plan_id}/baseline` clears them. Audit both.
  - `GET /plans/{plan_id}/version` (`view`) → `{version, updated_at, updated_by_name}`.
  - `GET /system/project-plans` (`settings:view`) → `ProjectPlanSettingsOut`; `PUT /system/project-plans` (`settings:change`) body `ProjectPlanSettingsIn` (all optional, `extra="forbid"`, nested `completion`/`reminders`/`calendar` replaced as whole objects when present) → same pattern as `put_learning_settings` in `routes/system.py:249` (read section, merge, store, audit `project_plans_config_update` with from/to per key, commit). Validation: `offsets_days` 1–5 distinct ints in 1–365 (stored sorted descending), `send_time` `HH:MM`, `overdue` ∈ `daily|once|off`, `subtasks` ∈ `cascade|block|none`, `predecessors` ∈ `block|warn|none`, `default_task_mode` ∈ `auto|manual`, `critical_slack_days` 0–30, `default_duration` parses with `parse_duration`, `calendar` valid.

- [ ] **Step 1: Failing tests:**
  - `test_patch_overrides_and_inherit` — PATCH `settings {"completion": {"predecessors": "warn"}}` → effective `warn`, `settings_overrides == {"completion": {"predecessors": "warn"}}`; PATCH `{"completion": {"predecessors": null}}` → back to `block`, overrides `{}` (empty groups pruned).
  - `test_patch_calendar_reschedules` — A `"2d"` at project start `2026-11-02T08:00`; PATCH a calendar with weekdays 07:00–11:00 + 12:00–16:00 (still 8 h/day) → A finishes `2026-11-04T08:00`.
  - `test_bad_calendar` → 422 `bad_calendar`; `test_bad_timezone` → 422 `bad_timezone`.
  - `test_lock_unlock` — lock → `locked_at` and `locked_by_name` set; PATCH `project_start` → 409 `plan_locked`; PATCH `status_date` → 200; unlock → structural ops work again.
  - `test_baseline` — set → every task has `baseline_start == start`; second set → 409 `baseline_exists`; with `replace: true` → 200; delete → baselines null.
  - `test_version_probe` — after an op the probe's version equals the ops response version.
  - `test_system_settings_round_trip` — GET equals the defaults; PUT `{"reminders": {...offsets_days: [7, 2]...}}` → GET returns `[7, 2]`; staff PUT → 403; `offsets_days: [0]` → 422.
- [ ] **Step 2: Run** `… pytest tests/test_plans_settings_api.py -q` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Run the whole plans set and the full API suite** — `… pytest tests/test_plans_*.py -q` then `… pytest -q` (foreground, 600000 ms). Expected: all pass except failures that also fail on the baseline (list any in the commit message).
- [ ] **Step 6: Commit** `feat(plans): plan settings, lock, baseline and system settings`.
