/**
 * Plans, tasks, links and ops results shaped like the API's, for tests.
 * Not imported by the app: each factory takes overrides for the fields a
 * test cares about and fills the rest with plain defaults.
 */
import type { OpsResult, Plan, PlanLink, PlanTask, RestoreOp } from './api';

export function makeTask(id: string, over: Partial<PlanTask> = {}): PlanTask {
  return {
    id,
    display_id: 1,
    wbs: '1',
    outline_level: 1,
    parent_id: null,
    position: 0,
    is_summary: false,
    name: `Task ${id}`,
    is_milestone: false,
    mode: 'auto',
    duration_minutes: 480,
    duration_unit: 'd',
    elapsed: false,
    duration_text: '1 day',
    start: '2026-11-02T08:00',
    finish: '2026-11-02T17:00',
    constraint_type: 'asap',
    constraint_date: null,
    deadline: null,
    percent_complete: 0,
    actual_start: null,
    actual_finish: null,
    notes: null,
    show_on_timeline: false,
    total_slack_minutes: 0,
    is_critical: false,
    conflict: null,
    baseline_start: null,
    baseline_finish: null,
    baseline_duration_minutes: null,
    start_variance_minutes: null,
    finish_variance_minutes: null,
    completed_at: null,
    completed_by_name: null,
    predecessors: '',
    successors: '',
    assignees: [],
    status: 'not_started',
    missed_deadline: false,
    created_at: '2026-10-26T12:00:00Z',
    updated_at: '2026-10-27T12:00:00Z',
    ...over,
  };
}

export function makeLink(id: string, predecessor_id: string, successor_id: string,
  over: Partial<PlanLink> = {}): PlanLink {
  return {
    id, predecessor_id, successor_id,
    link_type: 'FS', lag_minutes: 0, lag_unit: 'd', lag_elapsed: false, lag_text: '0 days',
    ...over,
  };
}

/** Top-level tasks in the order given, numbered 1, 2, 3... */
export function flatTasks(ids: readonly string[]): PlanTask[] {
  return ids.map((id, i) => makeTask(id, {
    display_id: i + 1, wbs: String(i + 1), position: i,
  }));
}

export function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    initiative_id: 'init-1',
    initiative_name: 'NAP11 move',
    initiative_window: { start: '2026-11-01', end: '2026-11-30' },
    timezone: 'America/Chicago',
    project_start: '2026-11-02T08:00',
    project_finish: '2026-11-02T17:00',
    status_date: null,
    now: '2026-10-27T09:00',
    calendar: {
      week: {
        mon: [['08:00', '12:00'], ['13:00', '17:00']],
        tue: [['08:00', '12:00'], ['13:00', '17:00']],
        wed: [['08:00', '12:00'], ['13:00', '17:00']],
        thu: [['08:00', '12:00'], ['13:00', '17:00']],
        fri: [['08:00', '12:00'], ['13:00', '17:00']],
        sat: [],
        sun: [],
      },
      exceptions: [],
      hours_per_day: 8,
      hours_per_week: 40,
      days_per_month: 20,
      default_start: '08:00',
      default_end: '17:00',
    },
    settings_overrides: {},
    settings: {
      honor_constraints: true,
      critical_slack_days: 0,
      default_task_mode: 'auto',
      default_duration: '1 day',
      show_times: false,
      completion: { subtasks: 'cascade', predecessors: 'warn' },
      reminders: {
        enabled: false, offsets_days: [1], on_due_day: true, overdue: 'daily', send_time: '08:00',
        use_finish_without_deadline: true, notify_on_assign: false, overdue_to_owner: false,
        email_assignees: false,
      },
    },
    system_settings: {
      honor_constraints: true,
      critical_slack_days: 0,
      default_task_mode: 'auto',
      default_duration: '1 day',
      show_times: false,
      completion: { subtasks: 'cascade', predecessors: 'warn' },
      reminders: {
        enabled: false, offsets_days: [1], on_due_day: true, overdue: 'daily', send_time: '08:00',
        use_finish_without_deadline: true, notify_on_assign: false, overdue_to_owner: false,
        email_assignees: false,
      },
    },
    owner_id: null,
    owner_name: null,
    locked_at: null,
    locked_by_name: null,
    baseline_set_at: null,
    version: 5,
    permissions: { view: true, add: true, change: true, delete: true },
    tasks: flatTasks(['a', 'b', 'c']),
    links: [],
    resources: [],
    ...over,
  };
}

/** A signed restore as the server writes one; `tag` tells them apart. */
export function makeRestore(tag: string): RestoreOp {
  return {
    op: 'restore',
    tasks: [{ id: tag, name: `before ${tag}`, notes: null }],
    links: [],
    assignments: [],
    remove_tasks: [],
    remove_links: [],
    sig: `sig-${tag}`,
  };
}

export function makeOpsResult(over: Partial<OpsResult> = {}): OpsResult {
  return {
    version: 6,
    tasks: [],
    links: [],
    deleted_tasks: [],
    deleted_links: [],
    order: null,
    temp_ids: {},
    inverse: [makeRestore('inv')],
    notices: [],
    ...over,
  };
}
