/**
 * Plan settings as a form (components/plans/PlanSettingsModal). Pure.
 *
 * - `toForm(plan)`: the plan's values as the dialog's fields. General shows
 *   the effective settings; Completion rules and Reminders mark each key
 *   the plan doesn't override "Use system default" (`inherit`), with the
 *   effective value ready for when the switch goes off. The calendar is
 *   read day by day.
 * - `toPatch(form, plan)`: the PATCH (`base_version` plus only what
 *   changed). An inherited key sends null when the plan overrode it; a key
 *   whose switch went off sends its value, even one equal to the system's
 *   (the plan then keeps it when the system changes). The calendar goes
 *   whole when anything in it changed. A locked plan takes only the status
 *   date and the owner (the API's rule), so only those are sent.
 * - `validate(form)`: what the API would refuse, by field key, said here
 *   first: interval times (`24:00` only as an end), the unit limits (24
 *   hours a day, 168 a week, 31 days a month), a week with no working day,
 *   exception dates and names, the default times, duration and slack, the
 *   reminder offsets and send time. Inherited values are the system's and
 *   aren't checked.
 *
 * System settings › Project plans (lib/plans/systemSettings) edits the same
 * keys with no inheriting, and shares the pieces: the calendar form
 * (`toCalendarForm`, `toCalendar`, `sameCalendar`, `calendarErrors`), the
 * checks (`defaultDurationError`, `slackError`, `sendTimeError`), and the
 * words (the option labels and hints).
 */
import type {
  CompletionSettings, DayKey, PlanCalendar, Plan, PlanPatch, PlanSettingsOverrides, ReminderSettings, TaskMode,
  WorkInterval,
} from './api';
import { DurationError, asciiTrim, maxMinutes, parseDuration, unitsOf, type Units } from './durations';
import { dayOf, fromDateInput, toDateInput, toDateTimeInput } from './floatingTime';

export type SettingsSection = 'general' | 'calendar' | 'completion' | 'reminders';

export const SETTINGS_SECTIONS: readonly { key: SettingsSection; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'completion', label: 'Completion rules' },
  { key: 'reminders', label: 'Reminders' },
];

export const DAYS: readonly { key: DayKey; label: string }[] = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

/** The API's unit limits (plans/calendar.py `_UNIT_MAX`). */
export const CALENDAR_LIMITS = { hoursPerDay: 24, hoursPerWeek: 168, daysPerMonth: 31 } as const;
/** Critical slack, in days (schemas.MAX_CRITICAL_SLACK_DAYS). */
export const MAX_SLACK_DAYS = 30;
/** Reminder offsets (schemas.MAX_REMINDER_OFFSETS, MAX_OFFSET_DAYS). */
export const MAX_OFFSETS = 5;
export const MAX_OFFSET_DAYS = 365;
/** Hours on one day of the week or one exception (the editor's two ranges). */
export const MAX_RANGES = 2;

export const NO_WORKING_DAY = 'At least one working day is needed';

export interface RangeForm {
  start: string;                     // HH:MM; an end may be 24:00
  end: string;
}

export interface DayForm {
  working: boolean;
  ranges: RangeForm[];
}

export interface ExceptionForm {
  key: string;
  date: string;                      // YYYY-MM-DD
  name: string;
  working: boolean;                  // false: a nonworking day
  ranges: RangeForm[];
}

export interface CalendarForm {
  week: Record<DayKey, DayForm>;
  exceptions: ExceptionForm[];
  hoursPerDay: string;
  hoursPerWeek: string;
  daysPerMonth: string;
  defaultStart: string;
  defaultEnd: string;
}

/** A key with "Use system default": `inherit` on sends nothing (or null). */
export interface Inherit<T> {
  inherit: boolean;
  value: T;
}

/** The reminders as the form holds them: the offsets as text ("3, 1"). */
export type ReminderForm = { [K in keyof ReminderSettings]: Inherit<K extends 'offsets_days' ? string : ReminderSettings[K]> };
export type CompletionForm = { [K in keyof CompletionSettings]: Inherit<CompletionSettings[K]> };

export interface SettingsForm {
  projectStart: string;              // a date or datetime-local input's value
  ownerId: string;                   // '' = no owner
  timezone: string;
  statusDate: string;                // '' = now
  showTimes: boolean;
  defaultTaskMode: TaskMode;
  defaultDuration: string;
  honorConstraints: boolean;
  criticalSlackDays: string;
  calendar: CalendarForm;
  completion: CompletionForm;
  reminders: ReminderForm;
}

export type SettingsErrors = Record<string, string>;

const COMPLETION_KEYS: readonly (keyof CompletionSettings)[] = ['subtasks', 'predecessors'];
export const REMINDER_KEYS: readonly (keyof ReminderSettings)[] = [
  'enabled', 'offsets_days', 'on_due_day', 'overdue', 'send_time', 'use_finish_without_deadline',
  'notify_on_assign', 'overdue_to_owner', 'email_assignees',
];

// ── reading the plan ──

const rangesOf = (hours: readonly WorkInterval[]): RangeForm[] => hours.map(([start, end]) => ({ start, end }));

export function toCalendarForm(calendar: PlanCalendar): CalendarForm {
  const week = Object.fromEntries(DAYS.map(({ key }) => {
    const hours = calendar.week[key] ?? [];
    return [key, { working: hours.length > 0, ranges: rangesOf(hours) }];
  })) as Record<DayKey, DayForm>;
  return {
    week,
    exceptions: calendar.exceptions.map((e, i) => ({
      key: `x${i}`, date: e.date, name: e.name ?? '', working: e.hours.length > 0, ranges: rangesOf(e.hours),
    })),
    hoursPerDay: String(calendar.hours_per_day),
    hoursPerWeek: String(calendar.hours_per_week),
    daysPerMonth: String(calendar.days_per_month),
    defaultStart: calendar.default_start,
    defaultEnd: calendar.default_end,
  };
}

const offsetsText = (days: readonly number[]) => days.join(', ');

export function toForm(plan: Plan): SettingsForm {
  const showTimes = plan.settings.show_times;
  const input = (v: string | null) => (showTimes ? toDateTimeInput(v) : toDateInput(v));
  const ov = plan.settings_overrides;
  const completion = Object.fromEntries(COMPLETION_KEYS.map((k) => [k, {
    inherit: ov.completion?.[k] == null, value: plan.settings.completion[k],
  }])) as CompletionForm;
  const reminders = Object.fromEntries(REMINDER_KEYS.map((k) => {
    const value = plan.settings.reminders[k];
    return [k, { inherit: ov.reminders?.[k] == null, value: k === 'offsets_days' ? offsetsText(value as number[]) : value }];
  })) as ReminderForm;
  return {
    projectStart: input(plan.project_start),
    ownerId: plan.owner_id ?? '',
    timezone: plan.timezone,
    statusDate: input(plan.status_date),
    showTimes,
    defaultTaskMode: plan.settings.default_task_mode,
    defaultDuration: plan.settings.default_duration,
    honorConstraints: plan.settings.honor_constraints,
    criticalSlackDays: String(plan.settings.critical_slack_days),
    calendar: toCalendarForm(plan.calendar),
    completion,
    reminders,
  };
}

// ── the calendar back as the API stores it ──

const pairs = (ranges: readonly RangeForm[]): WorkInterval[] =>
  ranges.map((r): WorkInterval => [asciiTrim(r.start), asciiTrim(r.end)]);

export function toCalendar(c: CalendarForm): PlanCalendar {
  return {
    week: Object.fromEntries(DAYS.map(({ key }) => [key, c.week[key].working ? pairs(c.week[key].ranges) : []])) as
      Record<DayKey, WorkInterval[]>,
    exceptions: c.exceptions.map((e) => ({
      date: e.date, name: asciiTrim(e.name) || null, hours: e.working ? pairs(e.ranges) : [],
    })),
    hours_per_day: Number(c.hoursPerDay),
    hours_per_week: Number(c.hoursPerWeek),
    days_per_month: Number(c.daysPerMonth),
    default_start: c.defaultStart,
    default_end: c.defaultEnd,
  };
}

/** Fixed-width text (HH:MM, YYYY-MM-DD) in order. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The calendar in one order (the API's canonical form), for comparing. */
function canonical(c: PlanCalendar): string {
  const sorted = (hours: readonly WorkInterval[]) => [...hours].sort((a, b) => byText(a[0], b[0]));
  return JSON.stringify({
    week: DAYS.map(({ key }) => sorted(c.week[key] ?? [])),
    exceptions: [...c.exceptions].sort((a, b) => byText(a.date, b.date))
      .map((e) => [e.date, e.name || null, sorted(e.hours)]),
    units: [c.hours_per_day, c.hours_per_week, c.days_per_month].map(Number),
    defaults: [c.default_start, c.default_end],
  });
}

/** The same calendar, whatever order its hours and exceptions are in. */
export const sameCalendar = (a: PlanCalendar, b: PlanCalendar): boolean => canonical(a) === canonical(b);

// ── the PATCH ──

function sameDate(text: string, current: string | null): boolean {
  if (current === null) return text === '';
  return text.length === 10 ? dayOf(current) === text : current === text;
}

/** The offsets text as days, largest first; null when it isn't 1-5 whole days. */
export function parseOffsets(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.every((p) => /^[0-9]{1,3}$/.test(p))) return null;
  return parts.map(Number).sort((a, b) => b - a);
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function groupPatch<K extends string>(keys: readonly K[], form: Record<K, Inherit<unknown>>,
  overrides: Partial<Record<K, unknown>> | null | undefined, valueOf: (key: K, value: unknown) => unknown,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const had = overrides?.[key] != null;
    const field = form[key];
    if (field.inherit) {
      if (had) out[key] = null;
      continue;
    }
    const value = valueOf(key, field.value);
    if (!had || !sameValue(value, overrides?.[key])) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export function toPatch(form: SettingsForm, plan: Plan): PlanPatch {
  const patch: PlanPatch = { base_version: plan.version };
  const locked = plan.locked_at !== null;

  const status = fromDateInput(asciiTrim(form.statusDate));
  if (!sameDate(status ?? '', plan.status_date)) patch.status_date = status;
  const owner = form.ownerId || null;
  if (owner !== plan.owner_id) patch.owner_id = owner;
  if (locked) return patch;

  const start = fromDateInput(asciiTrim(form.projectStart));
  if (start !== null && !sameDate(start, plan.project_start)) patch.project_start = start;
  if (form.timezone !== plan.timezone) patch.timezone = form.timezone;
  const calendar = toCalendar(form.calendar);
  if (!sameCalendar(calendar, plan.calendar)) patch.calendar = calendar;

  const now = plan.settings;
  const settings: PlanSettingsOverrides = {};
  if (form.showTimes !== now.show_times) settings.show_times = form.showTimes;
  if (form.defaultTaskMode !== now.default_task_mode) settings.default_task_mode = form.defaultTaskMode;
  const duration = asciiTrim(form.defaultDuration);
  if (duration !== now.default_duration) settings.default_duration = duration;
  if (form.honorConstraints !== now.honor_constraints) settings.honor_constraints = form.honorConstraints;
  const slack = Number(form.criticalSlackDays);
  if (slack !== now.critical_slack_days) settings.critical_slack_days = slack;
  const completion = groupPatch(COMPLETION_KEYS, form.completion, plan.settings_overrides.completion, (_k, v) => v);
  if (completion) settings.completion = completion as PlanSettingsOverrides['completion'];
  const reminders = groupPatch(REMINDER_KEYS, form.reminders as Record<keyof ReminderSettings, Inherit<unknown>>,
    plan.settings_overrides.reminders, (k, v) => (k === 'offsets_days' ? parseOffsets(v as string) : v));
  if (reminders) settings.reminders = reminders as PlanSettingsOverrides['reminders'];
  if (Object.keys(settings).length) patch.settings = settings;
  return patch;
}

// ── checks ──

const HHMM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const CONTROL = /[\x00-\x1f\x7f]/;   // eslint-disable-line no-control-regex

/** Minutes since midnight; `24:00` (the next midnight) only as an end. */
function clock(text: string, end: boolean): number | string {
  const t = asciiTrim(text);
  if (t === '24:00') return end ? 1440 : '24:00 can end hours but not start them.';
  const m = HHMM.exec(t);
  if (!m) return 'Enter times as HH:MM, like 08:00.';
  return Number(m[1]) * 60 + Number(m[2]);
}

const shown = (minutes: number) => (minutes === 1440 ? '24:00'
  : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);

/** The first thing wrong with a day's hours, or null. */
export function rangesError(ranges: readonly RangeForm[]): string | null {
  if (!ranges.length) return 'Add working hours, or make the day nonworking.';
  const spans: [number, number][] = [];
  for (const r of ranges) {
    const start = clock(r.start, false);
    const end = clock(r.end, true);
    if (typeof start === 'string') return start;
    if (typeof end === 'string') return end;
    if (end <= start) return `${shown(start)}–${shown(end)}: hours must end after they start.`;
    spans.push([start, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i += 1) {
    const [s1, e1] = spans[i - 1];
    const [s2, e2] = spans[i];
    if (s2 < e1) return `${shown(s1)}–${shown(e1)} and ${shown(s2)}–${shown(e2)} overlap.`;
  }
  return null;
}

function unitError(text: string, max: number, what: string): string | null {
  const n = Number(asciiTrim(text));
  if (asciiTrim(text) === '' || !Number.isFinite(n) || n <= 0 || n > max) return `${what}: more than 0, at most ${max}.`;
  return null;
}

/** The calendar's units, when its numbers are good (the default duration reads them). */
function unitsOfForm(c: CalendarForm): Units | null {
  try {
    return unitsOf({
      hours_per_day: Number(c.hoursPerDay), hours_per_week: Number(c.hoursPerWeek), days_per_month: Number(c.daysPerMonth),
    });
  } catch {
    return null;
  }
}

/** What's wrong with the calendar, keyed `calendar.*` the way CalendarEditor
 *  shows it (Plan settings and System settings › Project plans). */
export function calendarErrors(c: CalendarForm): SettingsErrors {
  const errors: SettingsErrors = {};
  if (!DAYS.some(({ key }) => c.week[key].working)) errors['calendar.week'] = NO_WORKING_DAY;
  for (const { key } of DAYS) {
    const day = c.week[key];
    const err = day.working ? rangesError(day.ranges) : null;
    if (err) errors[`calendar.week.${key}`] = err;
  }
  const unit = [
    ['hoursPerDay', unitError(c.hoursPerDay, CALENDAR_LIMITS.hoursPerDay, 'Hours per day')],
    ['hoursPerWeek', unitError(c.hoursPerWeek, CALENDAR_LIMITS.hoursPerWeek, 'Hours per week')],
    ['daysPerMonth', unitError(c.daysPerMonth, CALENDAR_LIMITS.daysPerMonth, 'Days per month')],
  ] as const;
  for (const [key, err] of unit) if (err) errors[`calendar.${key}`] = err;
  const defStart = clock(c.defaultStart, false);
  const defEnd = clock(c.defaultEnd, false);
  if (typeof defStart === 'string' || typeof defEnd === 'string') {
    errors['calendar.defaults'] = 'Enter the default times as HH:MM, like 08:00.';
  } else if (defEnd <= defStart) {
    errors['calendar.defaults'] = 'The default end time has to be after the default start time.';
  }
  const dates = new Set<string>();
  for (const e of c.exceptions) {
    const where = `calendar.exceptions.${e.key}`;
    let err: string | null = null;
    if (fromDateInput(e.date) === null || e.date.length !== 10) err = 'Enter the exception’s date.';
    else if (dates.has(e.date)) err = 'Each date can have one exception, listed once.';
    else if (CONTROL.test(e.name)) err = 'A name can’t contain a line break or a tab.';
    else if (e.working) err = rangesError(e.ranges);
    if (fromDateInput(e.date) !== null) dates.add(e.date);
    if (err) errors[where] = err;
  }
  return errors;
}

/** The default duration, read in the units of the calendar being edited
 *  (null when those units are themselves wrong: that error shows there). */
export function defaultDurationError(text: string, calendar: CalendarForm): string | null {
  const units = unitsOfForm(calendar);
  if (!units) return null;
  try {
    const d = parseDuration(text, units);
    return d.minutes > maxMinutes(units, d.elapsed) ? 'A duration can be at most 10 years.' : null;
  } catch (err) {
    return err instanceof DurationError ? err.message : 'Enter a duration like 1d.';
  }
}

/** Critical slack: 0 to 30 days, fractions allowed. */
export function slackError(text: string): string | null {
  const t = asciiTrim(text);
  const slack = Number(t);
  if (t === '' || !Number.isFinite(slack) || slack < 0 || slack > MAX_SLACK_DAYS) {
    return `Enter 0 to ${MAX_SLACK_DAYS} days (halves and quarters are fine).`;
  }
  return null;
}

/** A reminder send time: HH:MM. */
export const sendTimeError = (text: string): string | null =>
  (HHMM.test(asciiTrim(text)) ? null : 'Enter a time like 08:00.');

export function validate(form: SettingsForm): SettingsErrors {
  const errors: SettingsErrors = {};

  if (fromDateInput(asciiTrim(form.projectStart)) === null) errors.projectStart = 'Enter the project start date.';
  if (asciiTrim(form.statusDate) && fromDateInput(asciiTrim(form.statusDate)) === null) {
    errors.statusDate = 'Enter a full date, or leave it blank for now.';
  }
  if (!form.timezone) errors.timezone = 'Choose a timezone from the list.';

  Object.assign(errors, calendarErrors(form.calendar));

  // General's settings
  const duration = defaultDurationError(form.defaultDuration, form.calendar);
  if (duration) errors.defaultDuration = duration;
  const slack = slackError(form.criticalSlackDays);
  if (slack) errors.criticalSlackDays = slack;

  // the reminders this plan sets itself
  const offsets = form.reminders.offsets_days;
  if (!offsets.inherit) {
    const days = parseOffsets(offsets.value);
    if (!days || days.length < 1 || days.length > MAX_OFFSETS || new Set(days).size !== days.length
      || days.some((d) => d < 1 || d > MAX_OFFSET_DAYS)) {
      errors['reminders.offsets_days'] = `Enter 1 to ${MAX_OFFSETS} different numbers of days, each 1 to ${MAX_OFFSET_DAYS}, like 3, 1.`;
    }
  }
  const send = form.reminders.send_time;
  const sendError = send.inherit ? null : sendTimeError(send.value);
  if (sendError) errors['reminders.send_time'] = sendError;
  return errors;
}

/** The section an error key belongs to. */
export function sectionOfError(key: string): SettingsSection {
  if (key.startsWith('calendar.')) return 'calendar';
  if (key.startsWith('completion.')) return 'completion';
  if (key.startsWith('reminders.')) return 'reminders';
  return 'general';
}

// ── words ──

export const SUBTASK_RULES: Record<CompletionSettings['subtasks'], string> = {
  cascade: 'Complete them too',
  block: 'Must be complete first',
  none: 'Don’t check',
};
export const PREDECESSOR_RULES: Record<CompletionSettings['predecessors'], string> = {
  block: 'Must be complete first',
  warn: 'Warn',
  none: 'Don’t check',
};
export const OVERDUE_CADENCES: Record<ReminderSettings['overdue'], string> = {
  daily: 'Daily',
  once: 'Once',
  off: 'Off',
};
export const TASK_MODES: Record<TaskMode, string> = {
  auto: 'Auto Scheduled',
  manual: 'Manually Scheduled',
};

/** One line under each completion rule and reminder key. */
export const COMPLETION_HINTS: Record<keyof CompletionSettings, string> = {
  subtasks: 'Its subtasks that aren’t complete yet.',
  predecessors: 'Completing a task whose predecessors aren’t complete yet.',
};
export const REMINDER_HINTS: Record<keyof ReminderSettings, string> = {
  enabled: 'Reminders about due and overdue tasks to the people assigned.',
  offsets_days: 'Days before a task is due, like 3, 1.',
  on_due_day: 'One more on the day a task is due.',
  overdue: 'While a task is overdue and not complete.',
  send_time: 'The time of day reminders go out, in the plan’s timezone.',
  use_finish_without_deadline: 'A task with no Deadline is due at its Finish.',
  notify_on_assign: 'A notice when someone is assigned to a task.',
  overdue_to_owner: 'The plan owner also hears about overdue tasks.',
  email_assignees: 'Reminders are emailed as well as shown in the inbox.',
};

/** `HH:MM` on a 12-hour clock: 8:00 AM. */
export function clockText(hhmm: string): string {
  const m = HHMM.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "3 and 1 days before", "1 day before". */
export function offsetsWords(days: readonly number[]): string {
  if (!days.length) return 'None';
  const list = days.length === 1 ? String(days[0])
    : `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
  return `${list} day${days.length === 1 && days[0] === 1 ? '' : 's'} before`;
}

/** The system value as "Use system default (<value>)" names it. */
export function systemValueText(group: 'completion' | 'reminders', key: string, value: unknown): string {
  if (group === 'completion') {
    return key === 'subtasks'
      ? SUBTASK_RULES[value as CompletionSettings['subtasks']] ?? String(value)
      : PREDECESSOR_RULES[value as CompletionSettings['predecessors']] ?? String(value);
  }
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (key === 'offsets_days') return offsetsWords(value as number[]);
  if (key === 'send_time') return clockText(value as string);
  if (key === 'overdue') return OVERDUE_CADENCES[value as ReminderSettings['overdue']] ?? String(value);
  return String(value);
}
