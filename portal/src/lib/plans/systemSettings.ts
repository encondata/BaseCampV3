/**
 * System settings › Project plans as a form (pages/settings/
 * ProjectPlanSettings), in LearningSettings' shape. Pure.
 *
 * - `toDraft(settings)`: GET /system/project-plans as the form's fields:
 *   numbers as text, the reminder offsets as the ChipPicker's values, the
 *   calendar day by day (settingsForm's CalendarForm, for CalendarEditor).
 * - `evaluate(draft, saved)`: the errors, by field key (the calendar's keyed
 *   `calendar.*` as CalendarEditor shows them), held to Plan settings' own
 *   rules (settingsForm); and the PUT: only the keys that changed. A
 *   changed group (`completion`, `reminders`) or calendar goes whole, since
 *   the API replaces a nested object rather than merging it.
 * - `isDirty`, `isValid`.
 *
 * There is no "Use system default" here: this is the default.
 */
import type {
  CompletionSettings, ProjectPlanSettings, ProjectPlanSettingsPatch, ReminderSettings, TaskMode,
} from './api';
import { asciiTrim } from './durations';
import {
  MAX_OFFSET_DAYS, MAX_OFFSETS, calendarErrors, defaultDurationError, sameCalendar, sendTimeError, slackError,
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
  errors: SettingsErrors;
  /** Only what differs from the saved settings. */
  patch: ProjectPlanSettingsPatch;
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
  const errors: SettingsErrors = { ...calendarErrors(draft.calendar) };
  const put = (key: string, error: string | null) => { if (error) errors[key] = error; };
  put('criticalSlackDays', slackError(draft.criticalSlackDays));
  put('defaultDuration', defaultDurationError(draft.defaultDuration, draft.calendar));
  put('reminders.offsets_days', offsetsError(draft.reminders.offsets_days));
  put('reminders.send_time', sendTimeError(draft.reminders.send_time));

  const patch: ProjectPlanSettingsPatch = {};
  if (draft.honorConstraints !== saved.honor_constraints) patch.honor_constraints = draft.honorConstraints;
  const slack = Number(asciiTrim(draft.criticalSlackDays));
  if (asciiTrim(draft.criticalSlackDays) === '' || slack !== saved.critical_slack_days) {
    patch.critical_slack_days = slack;
  }
  if (draft.defaultTaskMode !== saved.default_task_mode) patch.default_task_mode = draft.defaultTaskMode;
  const duration = asciiTrim(draft.defaultDuration);
  if (duration !== saved.default_duration) patch.default_duration = duration;
  if (draft.showTimes !== saved.show_times) patch.show_times = draft.showTimes;

  const calendar = toCalendar(draft.calendar);
  if (!sameCalendar(calendar, saved.calendar)) patch.calendar = calendar;
  if (draft.completion.subtasks !== saved.completion.subtasks
    || draft.completion.predecessors !== saved.completion.predecessors) {
    patch.completion = { subtasks: draft.completion.subtasks, predecessors: draft.completion.predecessors };
  }
  const reminders: ReminderSettings = {
    ...draft.reminders, send_time: asciiTrim(draft.reminders.send_time), offsets_days: offsetDays(draft.reminders.offsets_days),
  };
  const savedReminders = { ...saved.reminders, offsets_days: [...saved.reminders.offsets_days].sort((a, b) => b - a) };
  if ((Object.keys(reminders) as (keyof ReminderSettings)[]).some((k) => !same(reminders[k], savedReminders[k]))) {
    patch.reminders = reminders;
  }
  return { errors, patch };
}

export const isValid = (e: Evaluation): boolean => Object.keys(e.errors).length === 0;

export const isDirty = (e: Evaluation): boolean => Object.keys(e.patch).length > 0;
