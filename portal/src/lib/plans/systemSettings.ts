/**
 * System settings › Project plans as a form (pages/settings/
 * ProjectPlanSettings), in LearningSettings' shape. Pure.
 *
 * - `toDraft(settings)`: GET /system/project-plans as the form's fields:
 *   numbers as text, the reminder offsets as the ChipPicker's values, the
 *   calendar day by day (settingsForm's CalendarForm, for CalendarEditor).
 * - `evaluate(draft, saved)`: the errors, by field key (the calendar's keyed
 *   `calendar.*` as CalendarEditor shows them) and in page order, held to
 *   Plan settings' own rules (settingsForm); and the PUT: only the good
 *   values that changed. A changed group (`completion`, `reminders`) or
 *   calendar goes whole, since the API replaces a nested object rather than
 *   merging it. A key with an error stays out of the patch but still makes
 *   the draft `dirty` (so Discard shows).
 * - `isDirty`, `isValid`; `fixHint`: what the Save line says when the draft
 *   can't be saved ("Fix “Default duration” above.").
 *
 * There is no "Use system default" here: this is the default.
 */
import type {
  CompletionSettings, ProjectPlanSettings, ProjectPlanSettingsPatch, ReminderSettings, TaskMode,
} from './api';
import { asciiTrim } from './durations';
import { SETTING_LABELS } from './errors';
import {
  DAYS, MAX_OFFSET_DAYS, MAX_OFFSETS, calendarErrors, defaultDurationError, sameCalendar, sendTimeError, slackError,
  toCalendar, toCalendarForm, type CalendarForm, type SettingsErrors,
} from './settingsForm';

/** The reminders as the form holds them: the offsets as picked values ("3"). */
export type ReminderDraft = Omit<ReminderSettings, 'offsets_days'> & { offsets_days: string[] };

export interface SystemSettingsDraft {
  honorConstraints: boolean;
  criticalSlackDays: string;
  defaultTaskMode: TaskMode;
  defaultDuration: string;
  showTimes: boolean;
  calendar: CalendarForm;
  completion: CompletionSettings;
  reminders: ReminderDraft;
}

export interface Evaluation {
  /** By field key, in the order the fields are on the page. */
  errors: SettingsErrors;
  /** Only the good values that differ from the saved settings. */
  patch: ProjectPlanSettingsPatch;
  /** Anything differs from the saved settings, a value with an error too. */
  dirty: boolean;
}

export const OFFSETS_ERROR = `Pick 1 to ${MAX_OFFSETS} days.`;

/** "1 day before", "3 days before". */
export const offsetLabel = (days: number): string => `${days} day${days === 1 ? '' : 's'} before`;

/** Every day an offset can be (1 to 365), as the picker's options. */
export const OFFSET_OPTIONS = Array.from({ length: MAX_OFFSET_DAYS }, (_, i) => ({
  value: String(i + 1), label: offsetLabel(i + 1),
}));

/** Picked offsets as days, largest first (the API's order). */
export const offsetDays = (values: readonly string[]): number[] => values.map(Number).sort((a, b) => b - a);

export function toDraft(s: ProjectPlanSettings): SystemSettingsDraft {
  return {
    honorConstraints: s.honor_constraints,
    criticalSlackDays: String(s.critical_slack_days),
    defaultTaskMode: s.default_task_mode,
    defaultDuration: s.default_duration,
    showTimes: s.show_times,
    calendar: toCalendarForm(s.calendar),
    completion: { ...s.completion },
    reminders: { ...s.reminders, offsets_days: [...s.reminders.offsets_days].sort((a, b) => b - a).map(String) },
  };
}

function offsetsError(values: readonly string[]): string | null {
  const days = values.map(Number);
  if (days.length < 1 || days.length > MAX_OFFSETS || new Set(days).size !== days.length
    || days.some((d) => !Number.isInteger(d) || d < 1 || d > MAX_OFFSET_DAYS)) {
    return OFFSETS_ERROR;
  }
  return null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function evaluate(draft: SystemSettingsDraft, saved: ProjectPlanSettings): Evaluation {
  // in page order (Scheduling, the calendar, Reminders): fixHint names the first
  const errors: SettingsErrors = {};
  const put = (key: string, error: string | null) => { if (error) errors[key] = error; };
  put('criticalSlackDays', slackError(draft.criticalSlackDays));
  put('defaultDuration', defaultDurationError(draft.defaultDuration, draft.calendar));
  Object.assign(errors, calendarErrors(draft.calendar));
  put('reminders.offsets_days', offsetsError(draft.reminders.offsets_days));
  put('reminders.send_time', sendTimeError(draft.reminders.send_time));
  const wrong = (key: string) => Object.keys(errors).some((k) => k === key || k.startsWith(`${key}.`));

  const patch: ProjectPlanSettingsPatch = {};
  let dirty = false;
  /** A changed key: the draft is dirty; its value goes in the patch only when it's good. */
  const change = <K extends keyof ProjectPlanSettingsPatch>(key: K, value: ProjectPlanSettingsPatch[K], bad = false) => {
    dirty = true;
    if (!bad) patch[key] = value;
  };

  if (draft.honorConstraints !== saved.honor_constraints) change('honor_constraints', draft.honorConstraints);
  // a slack that isn't a number (a blank, "abc") can't be the saved one: changed, with nothing to send
  const slack = Number(asciiTrim(draft.criticalSlackDays));
  if (wrong('criticalSlackDays') || slack !== saved.critical_slack_days) {
    change('critical_slack_days', slack, wrong('criticalSlackDays'));
  }
  if (draft.defaultTaskMode !== saved.default_task_mode) change('default_task_mode', draft.defaultTaskMode);
  const duration = asciiTrim(draft.defaultDuration);
  if (duration !== saved.default_duration) change('default_duration', duration, wrong('defaultDuration'));
  if (draft.showTimes !== saved.show_times) change('show_times', draft.showTimes);

  const calendar = toCalendar(draft.calendar);
  if (!sameCalendar(calendar, saved.calendar)) change('calendar', calendar, wrong('calendar'));
  if (draft.completion.subtasks !== saved.completion.subtasks
    || draft.completion.predecessors !== saved.completion.predecessors) {
    change('completion', { subtasks: draft.completion.subtasks, predecessors: draft.completion.predecessors });
  }
  const reminders: ReminderSettings = {
    ...draft.reminders, send_time: asciiTrim(draft.reminders.send_time), offsets_days: offsetDays(draft.reminders.offsets_days),
  };
  const savedReminders = { ...saved.reminders, offsets_days: [...saved.reminders.offsets_days].sort((a, b) => b - a) };
  if ((Object.keys(reminders) as (keyof ReminderSettings)[]).some((k) => !same(reminders[k], savedReminders[k]))) {
    change('reminders', reminders, wrong('reminders'));
  }
  return { errors, patch, dirty };
}

export const isValid = (e: Evaluation): boolean => Object.keys(e.errors).length === 0;

export const isDirty = (e: Evaluation): boolean => e.dirty;

/** The name each error's field shows under on the page. */
function fieldName(key: string, draft: SystemSettingsDraft): string {
  const fixed: Record<string, string> = {
    criticalSlackDays: 'Critical slack (days)',
    defaultDuration: 'Default duration',
    'calendar.week': 'Working week',
    'calendar.hoursPerDay': 'Hours per day',
    'calendar.hoursPerWeek': 'Hours per week',
    'calendar.daysPerMonth': 'Days per month',
    'calendar.defaults': 'Default start and end time',
    'reminders.offsets_days': SETTING_LABELS['reminders.offsets_days'],
    'reminders.send_time': SETTING_LABELS['reminders.send_time'],
  };
  if (fixed[key]) return fixed[key];
  const day = DAYS.find((d) => key === `calendar.week.${d.key}`);
  if (day) return day.label;
  const at = draft.calendar.exceptions.findIndex((e) => key === `calendar.exceptions.${e.key}`);
  if (at >= 0) return `Exception ${at + 1}`;
  return 'the highlighted field';
}

/** The Save line's note while the draft can't be saved, or null. */
export function fixHint(errors: SettingsErrors, draft: SystemSettingsDraft): string | null {
  const keys = Object.keys(errors);
  if (!keys.length) return null;
  const more = keys.length - 1;
  return `Fix “${fieldName(keys[0], draft)}”${more ? ` and ${more} more` : ''} above.`;
}
