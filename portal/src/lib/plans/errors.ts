/**
 * Plain-language wording for the plan API's error codes (and its two notice
 * codes), one sentence each. Every code the API can answer is here: the
 * test reads them from api/src/serversherpa/plans/ and api/routes/plans.py,
 * so a new code fails it until it has wording. `planErrorText` adds what an
 * error body names (the tasks in a cycle, the field at fault) and goes
 * through `apiErrorText` for everything else.
 */
import { ApiError } from '../api';
import { apiErrorText } from '../learningDoc';
import type { CompletionBlocker } from './api';
import { DurationError } from './durations';
import { PredecessorError } from './predecessors';

export const PLAN_ERRORS: Record<string, string> = {
  // the plan and access
  no_plan: 'This initiative doesn’t have a project plan yet.',
  plan_exists: 'This initiative already has a project plan.',
  plan_not_found: 'This plan no longer exists, or you can’t see it.',
  initiative_not_found: 'This initiative no longer exists, or you can’t see it.',
  forbidden: 'You don’t have permission to do that.',
  plan_changed: 'Someone else changed this plan, so reload it and try again.',
  plan_locked: 'The schedule is locked, so only progress can be updated until someone unlocks it.',
  baseline_exists: 'This plan already has a baseline.',
  bad_owner: 'The plan owner has to be a staff member.',
  bad_timezone: 'Choose a timezone from the list.',
  bad_restore: 'That change can’t be undone anymore, so reload the plan and try again.',
  // tasks and the outline
  unknown_task: 'That task no longer exists, so reload the plan to see the latest.',
  summary_field: 'A summary task gets its dates, duration and % complete from its subtasks, so they can’t be edited.',
  cannot_indent: 'A task can only be indented under a task right above it at the same level.',
  cannot_outdent: 'That task is already at the top level.',
  cannot_move: 'A task can’t be moved into its own subtasks.',
  bad_field: 'One of the values isn’t valid, so check it and try again.',
  bad_duration: 'Enter a duration like 5d, 4h or 3ed, up to 10 years.',
  // links
  bad_predecessor: 'Enter predecessors as task IDs from this plan, like 2, 3SS or 4FS+2d.',
  bad_link: 'A task can’t be linked to itself, and a link’s tasks can’t be changed.',
  duplicate_link: 'Those two tasks are already linked.',
  unknown_link: 'That link no longer exists, so reload the plan to see the latest.',
  link_cycle: 'These links would make tasks depend on each other.',
  link_to_outline: 'A task can’t be linked to its own summary task or subtasks.',
  bad_summary_link: 'A summary task can only follow its predecessors Finish-to-Start or Start-to-Start.',
  bad_summary_constraint: 'A summary task can only be As Soon As Possible or Start No Earlier Than.',
  schedule_error: 'The plan can’t be scheduled as it stands.',
  // resources
  bad_resource: 'That person or partner can’t be assigned to tasks in this plan.',
  // the calendar
  bad_calendar: 'The calendar isn’t valid.',
  no_working_time: 'The calendar has no working time where the plan needs it.',
  // completion (usePlan turns these into the completion dialog)
  completion_blocked: 'Some tasks have to be complete first.',
  completion_confirm: 'Completing this involves other tasks that aren’t complete yet, so confirm to go ahead.',
  // notices: a batch went through and did this too
  constraint_added: 'Typing a date gave the task a Start No Earlier Than or Finish No Earlier Than constraint.',
  constraint_cleared: 'The task became a summary task, so its constraint went back to As Soon As Possible.',
};

/** The fields a `bad_field` names, in MS Project's words. */
const FIELD_LABELS: Record<string, string> = {
  name: 'Task Name',
  duration: 'Duration',
  start: 'Start',
  finish: 'Finish',
  mode: 'Task Mode',
  is_milestone: 'Milestone',
  constraint_type: 'Constraint Type',
  constraint_date: 'Constraint Date',
  deadline: 'Deadline',
  percent_complete: '% Complete',
  actual_start: 'Actual Start',
  actual_finish: 'Actual Finish',
  notes: 'Notes',
  show_on_timeline: 'Display on Timeline',
  predecessors: 'Predecessors',
  link_type: 'Type',
  lag: 'Lag',
  parent_id: 'outline position',
  position: 'outline position',
  project_start: 'Project Start',
  status_date: 'Status Date',
  complete_through: 'Update work as complete through',
  owner_id: 'Owner',
  timezone: 'Timezone',
};

/** The plan settings a `bad_field` names (`settings.<path>` from a PATCH,
 *  or the bare key from the system settings). */
export const SETTING_LABELS: Record<string, string> = {
  honor_constraints: 'Honor constraints',
  critical_slack_days: 'Critical slack',
  default_task_mode: 'Default task mode',
  default_duration: 'Default duration',
  show_times: 'Show times',
  'completion.subtasks': 'Completing a summary task',
  'completion.predecessors': 'Open predecessors',
  'reminders.enabled': 'Reminders',
  'reminders.offsets_days': 'Days before due',
  'reminders.on_due_day': 'On the due day',
  'reminders.overdue': 'Overdue reminders',
  'reminders.send_time': 'Send time',
  'reminders.use_finish_without_deadline': 'Use Finish when there’s no Deadline',
  'reminders.notify_on_assign': 'Notify on assignment',
  'reminders.overdue_to_owner': 'Tell the owner about overdue tasks',
  'reminders.email_assignees': 'Email assignees',
};

/** A plan error body, as the API writes it ({"code", ...extra}). */
export interface PlanErrorDetail {
  code: string;
  field?: string;                       // bad_field, bad_duration, bad_predecessor
  message?: string;                     // bad_predecessor, bad_calendar, no_working_time
  task_id?: string;
  task_ids?: string[];                  // schedule errors, in outline order
  display_ids?: number[];               // schedule errors, sorted
  link_id?: string;
  link_ids?: string[];                  // link_to_outline, bad_summary_link
  predecessor_id?: string;              // duplicate_link
  successor_id?: string;
  kind?: string;                        // bad_resource
  id?: string;
  version?: number;                     // plan_changed: the plan's version now
  set_at?: string;                      // baseline_exists
  blockers?: CompletionBlocker[];       // completion_blocked
  will_complete?: CompletionBlocker[];  // completion_confirm
  open_predecessors?: CompletionBlocker[];
}

/** The detail of an ApiError whose body is a plan error object; else null. */
export function planErrorDetail(err: unknown): PlanErrorDetail | null {
  if (!(err instanceof ApiError)) return null;
  const detail = err.detail as { code?: unknown } | null | undefined;
  if (!detail || typeof detail !== 'object' || typeof detail.code !== 'string') return null;
  return detail as PlanErrorDetail;
}

/** True for a 409 `plan_changed`: someone else changed the plan. usePlan
 *  has already reloaded it and said so in a toast, so a dialog that gets
 *  this from a write closes quietly. */
export function isPlanChanged(err: unknown): boolean {
  return planErrorDetail(err)?.code === 'plan_changed';
}

/** "2", "2 and 5", "2, 5 and 7". */
function idList(ids: readonly number[]): string {
  if (ids.length < 2) return ids.join('');
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

/** The server's own message as a sentence. */
function sentence(text: string): string {
  const trimmed = text.trim();
  const capped = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

function fieldText(field: string | undefined): string {
  if (!field) return PLAN_ERRORS.bad_field;
  if (field === 'actual_finish') {
    return 'Actual Finish can’t be before Actual Start, and a task at 100% needs one.';
  }
  const label = FIELD_LABELS[field];
  if (label) return `Check the ${label} value.`;
  const setting = SETTING_LABELS[field.replace(/^settings\./, '')];
  if (setting) return `Check the “${setting}” setting.`;
  if (field === 'settings' || field.startsWith('settings.')) return 'Check the plan settings.';
  return PLAN_ERRORS.bad_field;
}

function cycleText(ids: readonly number[] | undefined): string {
  if (!ids?.length) return PLAN_ERRORS.link_cycle;
  if (ids.length === 1) return `Task ${ids[0]} would depend on itself.`;
  return `Tasks ${idList(ids)} would depend on each other.`;
}

/** The base sentence, then which tasks to look at. */
function withTasks(code: string, ids: readonly number[] | undefined): string {
  if (!ids?.length) return PLAN_ERRORS[code];
  return `${PLAN_ERRORS[code]} Check task${ids.length > 1 ? 's' : ''} ${idList(ids)}.`;
}

/** A completion the API stopped (ApplyResult `blocked` / `confirm`). */
export type CompletionAnswer =
  | { kind: 'blocked'; blockers: readonly CompletionBlocker[] }
  | { kind: 'confirm'; willComplete: readonly CompletionBlocker[]; openPredecessors: readonly CompletionBlocker[] };

const sortedIds = (tasks: readonly CompletionBlocker[]) => tasks.map((t) => t.display_id).sort((a, b) => a - b);
const tasksWord = (ids: readonly number[]) => `task${ids.length > 1 ? 's' : ''} ${idList(ids)}`;

/** What a stopped completion says: which tasks are in the way, or which it
 *  takes along and which come before it unfinished (the plan's warn rule). */
export function completionText(answer: CompletionAnswer): string {
  if (answer.kind === 'blocked') return withTasks('completion_blocked', sortedIds(answer.blockers));
  const parts: string[] = [];
  const along = sortedIds(answer.willComplete);
  if (along.length) parts.push(`Completing this also completes ${tasksWord(along)}.`);
  const before = sortedIds(answer.openPredecessors);
  if (before.length) {
    const words = tasksWord(before);
    parts.push(`${words.charAt(0).toUpperCase()}${words.slice(1)} ${before.length > 1
      ? 'come before it and aren’t' : 'comes before it and isn’t'} complete yet.`);
  }
  return parts.length ? parts.join(' ') : PLAN_ERRORS.completion_confirm;
}

/** Plain-language text for any failure of a plan call, or of the sheet's
 *  own check of a duration or predecessors (its message is already one). */
export function planErrorText(err: unknown): string {
  if (err instanceof DurationError || err instanceof PredecessorError) return err.message;
  const detail = planErrorDetail(err);
  switch (detail?.code) {
    case 'link_cycle':
      return cycleText(detail.display_ids);
    case 'link_to_outline':
    case 'bad_summary_link':
    case 'bad_summary_constraint':
    case 'schedule_error':
      return withTasks(detail.code, detail.display_ids);
    case 'bad_field':
      return fieldText(detail.field);
    case 'bad_duration':
      if (detail.field === 'lag') return 'Enter a lag like +2d, -4h or 1ed, up to 10 years.';
      if (detail.field === 'predecessors') return 'A predecessor’s lag can be at most 10 years.';
      return PLAN_ERRORS.bad_duration;
    case 'bad_predecessor':
      return detail.message ? sentence(detail.message) : PLAN_ERRORS.bad_predecessor;
    case 'bad_calendar':
    case 'no_working_time':
      return detail.message
        ? `${PLAN_ERRORS[detail.code]} ${sentence(detail.message)}`
        : PLAN_ERRORS[detail.code];
    default:
      return apiErrorText(err, PLAN_ERRORS);
  }
}
