/**
 * Typed client for the project-plan API (api/routes/plans.py). Types mirror
 * api/src/serversherpa/plans/schemas.py: ids, instants and plan times arrive
 * as strings. Plan times (`start`, `deadline`, `status_date`, ...) are
 * floating `YYYY-MM-DDTHH:MM` text: read them only through
 * lib/plans/floatingTime.ts. Instants (`locked_at`, `completed_at`,
 * `updated_at`, ...) are ISO datetimes with an offset.
 *
 * Every call goes through apiFetch and throws the portal's ApiError
 * (status, code, detail) on a non-2xx; lib/plans/errors.ts words them.
 */
import { apiFetch, errorFrom } from '../api';
import type { DurationUnit } from './durations';
import type { LinkType } from './predecessors';

// ── plan ─────────────────────────────────────────────────────────────

export type TaskMode = 'auto' | 'manual';
export type ConstraintType = 'asap' | 'snet' | 'snlt' | 'fnet' | 'fnlt' | 'mso' | 'mfo';
export type TaskStatus = 'complete' | 'late' | 'in_progress' | 'not_started';
export type ResourceKind = 'person' | 'partner';
export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
/** `[start, end]` as `HH:MM`; `24:00` is valid as an end only. */
export type WorkInterval = [string, string];

export interface CalendarException {
  date: string;                       // YYYY-MM-DD
  name: string | null;
  hours: WorkInterval[];              // empty: a nonworking day
}

/** A plan calendar as stored (plans/calendar.py, clean_calendar). */
export interface PlanCalendar {
  week: Record<DayKey, WorkInterval[]>;
  exceptions: CalendarException[];
  hours_per_day: number;              // at most 24
  hours_per_week: number;             // at most 168
  days_per_month: number;             // at most 31
  default_start: string;              // HH:MM
  default_end: string;
}

export interface CompletionSettings {
  subtasks: 'cascade' | 'block' | 'none';
  predecessors: 'block' | 'warn' | 'none';
}

export interface ReminderSettings {
  enabled: boolean;
  offsets_days: number[];             // 1-5 distinct days before, largest first
  on_due_day: boolean;
  overdue: 'daily' | 'once' | 'off';
  send_time: string;                  // HH:MM, plan-local
  use_finish_without_deadline: boolean;
  notify_on_assign: boolean;
  overdue_to_owner: boolean;
  email_assignees: boolean;
}

/** The effective settings: the system's, overlaid with the plan's overrides. */
export interface PlanSettings {
  honor_constraints: boolean;
  critical_slack_days: number;
  default_task_mode: TaskMode;
  default_duration: string;           // duration text
  show_times: boolean;
  completion: CompletionSettings;
  reminders: ReminderSettings;
}

/** A plan's own overrides (PlanSettingsOverrides). In a PATCH, null
 *  removes an override (the plan inherits the system value again), for a
 *  key or a whole group. */
export interface PlanSettingsOverrides {
  honor_constraints?: boolean | null;
  critical_slack_days?: number | null;
  default_task_mode?: TaskMode | null;
  default_duration?: string | null;
  show_times?: boolean | null;
  completion?: { [K in keyof CompletionSettings]?: CompletionSettings[K] | null } | null;
  reminders?: { [K in keyof ReminderSettings]?: ReminderSettings[K] | null } | null;
}

export interface PlanPermissions {
  view: boolean;
  add: boolean;
  change: boolean;
  delete: boolean;
}

export interface Assignee {
  kind: ResourceKind;
  id: string;
  name: string;
}

/** One entry of the Resource Names picker (ResourceOut). A person on the
 *  team who is also staff is listed once, as team. */
export interface PlanResource {
  kind: ResourceKind;
  id: string;
  name: string;
  group: 'team' | 'staff' | 'partner';
  has_email: boolean;
  has_account: boolean;
}

export interface PlanLink {
  id: string;
  predecessor_id: string;
  successor_id: string;
  link_type: LinkType;
  lag_minutes: number;
  lag_unit: DurationUnit;
  lag_elapsed: boolean;
  lag_text: string;                   // "+2 days", "-4 hrs", "0 days"
}

export interface PlanTask {
  id: string;
  display_id: number;                 // index + 1 in outline order
  wbs: string;                        // "1", "1.2", "1.2.1"
  outline_level: number;              // 1 at the top
  parent_id: string | null;
  position: number;
  is_summary: boolean;
  name: string;
  is_milestone: boolean;
  mode: TaskMode;
  duration_minutes: number;
  duration_unit: DurationUnit;
  elapsed: boolean;
  duration_text: string;              // "2 days", "4 hrs", "3 edays"
  start: string | null;
  finish: string | null;
  constraint_type: ConstraintType;
  constraint_date: string | null;
  deadline: string | null;
  percent_complete: number;
  actual_start: string | null;
  actual_finish: string | null;
  notes: string | null;
  show_on_timeline: boolean;
  total_slack_minutes: number | null;
  is_critical: boolean;
  conflict: 'link' | 'constraint' | null;
  baseline_start: string | null;
  baseline_finish: string | null;
  baseline_duration_minutes: number | null;
  /** Working minutes from the baseline to the schedule (MS Project's Start
   *  / Finish Variance); negative when ahead, null without a baseline. */
  start_variance_minutes: number | null;
  finish_variance_minutes: number | null;
  completed_at: string | null;        // instant; never stamped on a summary
  completed_by_name: string | null;
  predecessors: string;               // MS Project text: "2,3SS+1 day"
  successors: string;
  assignees: Assignee[];
  status: TaskStatus;
  missed_deadline: boolean;
  created_at: string;                 // instant
  updated_at: string;                 // instant
}

export interface Plan {
  id: string;
  initiative_id: string;
  initiative_name: string;
  initiative_window: { start: string | null; end: string | null };   // YYYY-MM-DD
  timezone: string;
  project_start: string;
  project_finish: string | null;      // the latest task finish; null for an empty plan
  status_date: string | null;         // null = now
  now: string;                        // plan-local now
  calendar: PlanCalendar;
  settings_overrides: PlanSettingsOverrides;
  settings: PlanSettings;
  owner_id: string | null;
  owner_name: string | null;
  locked_at: string | null;           // instant
  locked_by_name: string | null;
  baseline_set_at: string | null;     // instant
  version: number;
  permissions: PlanPermissions;
  tasks: PlanTask[];                  // outline order
  links: PlanLink[];
  resources: PlanResource[];
}

export interface PlanCreate {
  project_start: string;              // YYYY-MM-DD (calendar default start) or a plan time
  owner_id?: string | null;
  template_id?: string | null;        // accepted, unused until templates land
}

/** PATCH /plans/{id} (PlanPatchIn): `base_version` and only the fields that
 *  change. A locked plan takes only `status_date` and `owner_id`. */
export interface PlanPatch {
  base_version: number;
  project_start?: string;             // a date alone = the calendar's default start
  timezone?: string;                  // IANA name
  status_date?: string | null;        // a date alone = default end; null = now
  owner_id?: string | null;           // a staff person; null = no owner
  calendar?: PlanCalendar;            // the whole calendar
  settings?: PlanSettingsOverrides;   // merged key by key; null inherits
}

export interface PlanVersion {
  version: number;
  updated_at: string;
  updated_by_name: string | null;
}

// ── ops (POST /plans/{id}/ops) ───────────────────────────────────────

/** The editable task fields; send only the ones that change. A field sent
 *  as null clears it where that makes sense (the ones typed `| null`); the
 *  API refuses null for the rest (ops_tasks.NOT_NULL: 422 `bad_field`). */
export interface TaskFields {
  name?: string;
  duration?: string;                  // duration text: "2d", "4 hrs", "0", "3ed"
  start?: string;                     // plan time; a date alone = default start
  finish?: string;                    // a date alone = default end
  mode?: TaskMode;
  is_milestone?: boolean;
  constraint_type?: ConstraintType;
  constraint_date?: string | null;
  deadline?: string | null;
  percent_complete?: number;          // a progress edit, like set_percent
  actual_start?: string | null;
  actual_finish?: string | null;
  notes?: string | null;
  show_on_timeline?: boolean;
  /** Replaces every link into the task. Its numbers are display IDs of
   *  the outline as it stood when the batch began; a task added in the
   *  same batch cannot be named. */
  predecessors?: string;
}

/** A new task: right above `before_id` as its sibling, else the last
 *  subtask of `parent_id`, else the last task. Its real id comes back in
 *  `OpsResult.temp_ids[temp_id]`; later ops in the same batch cannot name it. */
export interface AddTaskOp {
  op: 'add_task';
  temp_id?: string | null;
  before_id?: string | null;
  parent_id?: string | null;
  name?: string;
  duration?: string | null;
  start?: string | null;
  finish?: string | null;
  mode?: TaskMode | null;
  is_milestone?: boolean | null;
  deadline?: string | null;
  notes?: string | null;
}

export interface UpdateTaskOp {
  op: 'update_task';
  id: string;
  fields: TaskFields;
  confirm?: boolean;                  // answers a completion_confirm
}

/** Deletes each task with all of its subtasks (and their links). */
export interface DeleteTasksOp {
  op: 'delete_tasks';
  ids: string[];
}

/** Moves the tasks right above `before_id`, else to the end of
 *  `parent_id`'s subtasks, else to the end of the plan. With `before_id`,
 *  leave `parent_id` out: sent, it must be `before_id`'s parent. */
export interface MoveTasksOp {
  op: 'move_tasks';
  ids: string[];
  before_id?: string | null;
  parent_id?: string | null;
}

export interface IndentOp {
  op: 'indent';
  ids: string[];
}

export interface OutdentOp {
  op: 'outdent';
  ids: string[];
}

export interface AddLinkOp {
  op: 'add_link';
  predecessor_id: string;
  successor_id: string;
  link_type?: LinkType;               // default FS
  lag?: string;                       // lag text, default "0"; negative is a lead
}

/** Changes a link's type or lag; its ends never change. */
export interface UpdateLinkOp {
  op: 'update_link';
  id: string;
  link_type?: LinkType;
  lag?: string;
}

export interface DeleteLinkOp {
  op: 'delete_link';
  id: string;
}

export interface ResourceRef {
  kind: ResourceKind;
  id: string;
}

/** Replaces the task's assignees (an empty list clears them). */
export interface SetAssigneesOp {
  op: 'set_assignees';
  task_id: string;
  resources: ResourceRef[];
}

/** Each task's % complete (0-100) with its actuals; 100 goes through the
 *  completion rules (409 completion_blocked / completion_confirm). */
export interface SetPercentOp {
  op: 'set_percent';
  ids: string[];
  percent: number;
  confirm?: boolean;
}

/** `set_percent` 100. */
export interface CompleteOp {
  op: 'complete';
  ids: string[];
  confirm?: boolean;
}

export interface MarkOnTrackOp {
  op: 'mark_on_track';
  ids: string[];
  confirm?: boolean;
}

/** One row of a restore op, exactly as the server wrote it (ids as text,
 *  plan times as `YYYY-MM-DDTHH:MM`, null for an empty field). */
export interface RestoreRow {
  readonly [key: string]: unknown;
}

/**
 * The undo of a batch: `OpsResult.inverse` holds one of these. Only the
 * server writes them and `sig` signs every other field, so send it back
 * exactly as received: same keys (nulls included), same id text, same
 * numbers. A restore without a valid `sig` is 422 `bad_restore`.
 */
export interface RestoreOp {
  readonly op: 'restore';
  readonly tasks: readonly RestoreRow[];
  readonly links: readonly RestoreRow[];
  readonly assignments: readonly RestoreRow[];
  readonly remove_tasks: readonly string[];
  readonly remove_links: readonly string[];
  readonly sig: string;
}

export type Op =
  | AddTaskOp | UpdateTaskOp | DeleteTasksOp | MoveTasksOp | IndentOp | OutdentOp
  | AddLinkOp | UpdateLinkOp | DeleteLinkOp | SetAssigneesOp | SetPercentOp | CompleteOp
  | MarkOnTrackOp | RestoreOp;

export type OpName = Op['op'];

/** A batch is 1 to MAX_OPS ops (schemas.MAX_OPS). */
export const MAX_OPS = 5000;

/** Something a batch did that the user should hear about. */
export type Notice =
  | { code: 'constraint_added'; task_id: string; constraint_type: 'snet' | 'fnet' }
  | { code: 'constraint_cleared'; task_id: string };

/** What one batch changed (OpsOut). `tasks` and `links` are only the rows
 *  whose stored fields changed; `order` is the whole outline order when
 *  any task's parent or position changed, else null. */
export interface OpsResult {
  version: number;
  tasks: PlanTask[];
  links: PlanLink[];
  deleted_tasks: string[];
  deleted_links: string[];
  order: string[] | null;
  temp_ids: Record<string, string>;
  inverse: RestoreOp[];
  notices: Notice[];
}

/** POST /plans/{id}/update-project (UpdateProjectIn). */
export interface UpdateProjectBody {
  status_date: string | null;         // a date alone = default end; null = now
  complete_through?: string | null;
  confirm?: boolean;
}

/** A task in the way of a completion, as the completion 409s name it. */
export interface CompletionBlocker {
  task_id: string;
  display_id: number;
  name: string;
  reason: 'subtask' | 'predecessor';
}

// ── progress-only batches ────────────────────────────────────────────

/** The task fields a progress edit may touch (ops.PROGRESS_FIELDS). */
export const PROGRESS_FIELDS: ReadonlySet<string> = new Set(
  ['percent_complete', 'actual_start', 'actual_finish', 'notes']);
const PROGRESS_RESTORE_KEYS: ReadonlySet<string> = new Set(
  [...PROGRESS_FIELDS, 'id', 'completed_at', 'completed_by']);

/** The undo of a progress edit: progress fields of existing tasks only
 *  (none at all for the undo of a batch that changed nothing). */
function isProgressRestore(op: RestoreOp): boolean {
  if (typeof op.sig !== 'string' || !op.sig) return false;   // refused before it counts
  if (op.links.length || op.assignments.length || op.remove_tasks.length || op.remove_links.length) {
    return false;
  }
  return op.tasks.every((row) => {
    const keys = Object.keys(row);
    return keys.includes('id') && keys.length > 1 && keys.every((k) => PROGRESS_RESTORE_KEYS.has(k));
  });
}

/**
 * True for a batch of progress edits only (ops.is_progress_only):
 * `set_percent`, `complete`, `mark_on_track`, an `update_task` that sends
 * nothing but PROGRESS_FIELDS, or the signed restore that undoes one. Such
 * a batch is accepted on a locked plan; it still sends `base_version`.
 */
export function isProgressOnly(ops: readonly Op[]): boolean {
  if (!ops.length) return false;
  return ops.every((op) => {
    switch (op.op) {
      case 'set_percent':
      case 'complete':
      case 'mark_on_track':
        return true;
      case 'update_task': {
        // JSON.stringify drops an undefined key, so it is not sent
        const sent = Object.entries(op.fields).filter(([, v]) => v !== undefined).map(([k]) => k);
        return sent.length > 0 && sent.every((k) => PROGRESS_FIELDS.has(k));
      }
      case 'restore':
        return isProgressRestore(op);
      default:
        return false;
    }
  });
}

// ── calls ────────────────────────────────────────────────────────────

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const seg = (part: string): string => encodeURIComponent(part);

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify(body);
  }
  const resp = await apiFetch(path, init);
  if (!resp.ok) throw await errorFrom(resp);
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

const get = <T>(path: string) => send<T>(path, 'GET');

/** The initiative's plan; 404 `no_plan` when it has none. */
export const getPlan = (initiativeId: string) =>
  get<Plan>(`/initiatives/${seg(initiativeId)}/plan`);

/** 409 `plan_exists` when it already has one. */
export const createPlan = (initiativeId: string, body: PlanCreate) =>
  send<Plan>(`/initiatives/${seg(initiativeId)}/plan`, 'POST', body);

export const deletePlan = (initiativeId: string) =>
  send<void>(`/initiatives/${seg(initiativeId)}/plan`, 'DELETE');

/**
 * One atomic batch. Anything but a progress-only batch needs an unlocked
 * plan (409 `plan_locked`) and `baseVersion` equal to the plan's version
 * (409 `plan_changed`). Undo inverses (restore ops) go back as received.
 */
export async function postOps(planId: string, baseVersion: number, ops: readonly Op[]): Promise<OpsResult> {
  if (ops.length < 1 || ops.length > MAX_OPS) {
    throw new RangeError(`a batch holds 1 to ${MAX_OPS} ops, not ${ops.length}`);
  }
  return send<OpsResult>(`/plans/${seg(planId)}/ops`, 'POST', { base_version: baseVersion, ops });
}

export const patchPlan = (planId: string, patch: PlanPatch) =>
  send<Plan>(`/plans/${seg(planId)}`, 'PATCH', patch);

export const lockPlan = (planId: string) =>
  send<Plan>(`/plans/${seg(planId)}/lock`, 'POST');

export const unlockPlan = (planId: string) =>
  send<Plan>(`/plans/${seg(planId)}/lock`, 'DELETE');

/** 409 `baseline_exists` {set_at} unless `replace`; 409 `plan_locked`. */
export const setBaseline = (planId: string, replace: boolean) =>
  send<Plan>(`/plans/${seg(planId)}/baseline`, 'POST', { replace });

export const clearBaseline = (planId: string) =>
  send<Plan>(`/plans/${seg(planId)}/baseline`, 'DELETE');

/** MS Project's Update Project: a progress edit (no version, allowed when
 *  locked). Its `tasks` leave out status-only changes, so refetch the plan
 *  after it; its inverse does not restore the status date. */
export const updateProject = (planId: string, body: UpdateProjectBody) =>
  send<OpsResult>(`/plans/${seg(planId)}/update-project`, 'POST', body);

/** What an open tab polls to notice someone else's change. */
export const getPlanVersion = (planId: string) =>
  get<PlanVersion>(`/plans/${seg(planId)}/version`);
