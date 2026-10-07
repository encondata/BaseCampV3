/**
 * Pure helpers for the Timesheet report's Generate options
 * (`TimesheetOptions`): quick date ranges, the definition's defaults, the
 * run payload and validation. Side-effect free so they are unit-testable
 * without mounting the component tree.
 */
import type { ReportDefinition } from './api';
import { localDay } from './importReport';

export type TimesheetStatus = 'approved' | 'pending' | 'rejected' | 'open';
export type TimesheetView = 'day' | 'punch';
export type TimesheetFormat = 'xlsx' | 'pdf';
export type QuickRangeKind = 'this_week' | 'last_week' | 'this_month' | 'last_month';

/** Canonical order — the order the cards render and the payload carries. */
export const TIMESHEET_STATUSES: TimesheetStatus[] = ['approved', 'pending', 'rejected', 'open'];
export const TIMESHEET_VIEWS: TimesheetView[] = ['day', 'punch'];
/** The API refuses a range spanning more days than this (inclusive). */
export const MAX_SPAN_DAYS = 366;

/** ChoiceCard copy shared by the Generate options and the Edit definition modal. */
export const TIMESHEET_STATUS_CARDS: Record<TimesheetStatus, { title: string; description: string }> = {
  approved: { title: 'Approved', description: 'Reviewed and counted in the totals' },
  pending: { title: 'Pending', description: 'Awaiting review, counted in the totals' },
  rejected: { title: 'Rejected', description: 'Listed, not counted in the totals' },
  open: { title: 'On the clock', description: 'Still clocked in, not counted in the totals' },
};
export const TIMESHEET_VIEW_CARDS: Record<TimesheetView, { title: string; description: string }> = {
  day: { title: 'Day view', description: 'One row per person per day, with totals' },
  punch: { title: 'Punch view', description: 'Every clock-in and clock-out, with verification flags' },
};
const DAY_MS = 86_400_000;

/** A quick-pick range as local `YYYY-MM-DD` days. Weeks run Monday to
 *  Sunday; "This month" is the 1st through `today`. */
export function quickRange(kind: QuickRangeKind, today: Date): { from: string; to: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  const dom = today.getDate();
  if (kind === 'this_month') return { from: localDay(new Date(y, m, 1)), to: localDay(today) };
  if (kind === 'last_month') {
    return { from: localDay(new Date(y, m - 1, 1)), to: localDay(new Date(y, m, 0)) };
  }
  const sinceMonday = (today.getDay() + 6) % 7;     // Mon 0 … Sun 6
  const offset = kind === 'this_week' ? 0 : -7;
  const start = new Date(y, m, dom - sinceMonday + offset);
  const end = new Date(y, m, dom - sinceMonday + offset + 6);
  return { from: localDay(start), to: localDay(end) };
}

const pick = <T extends string>(raw: unknown, allowed: T[]): T[] =>
  Array.isArray(raw) ? allowed.filter((a) => raw.includes(a)) : [];

export interface TimesheetDefaults {
  format: TimesheetFormat; views: TimesheetView[]; statuses: TimesheetStatus[];
}

/** The definition's `default_format` / `default_views` / `default_statuses`,
 *  each falling back to the report's own default (xlsx / both views /
 *  approved + pending) when missing, empty or unrecognized. */
export function timesheetDefaults(definition: Pick<ReportDefinition, 'options'>): TimesheetDefaults {
  const views = pick(definition.options.default_views, TIMESHEET_VIEWS);
  const statuses = pick(definition.options.default_statuses, TIMESHEET_STATUSES);
  return {
    format: definition.options.default_format === 'pdf' ? 'pdf' : 'xlsx',
    views: views.length ? views : ['day', 'punch'],
    statuses: statuses.length ? statuses : ['approved', 'pending'],
  };
}

export interface TimesheetRunInput {
  from: string; to: string; personId: string; siteId: string;
  statuses: TimesheetStatus[]; views: TimesheetView[]; format: TimesheetFormat;
}

// A `type` alias so it is assignable to the run payload's Record<string, unknown>.
export type TimesheetRunOptions = {
  from: string; to: string; person_id?: string; site_id?: string;
  statuses: TimesheetStatus[]; views: TimesheetView[]; format: TimesheetFormat;
};

/** The run's `options` payload; an empty person/site is left out. */
export function buildTimesheetRunOptions(i: TimesheetRunInput): TimesheetRunOptions {
  const out: TimesheetRunOptions = {
    from: i.from, to: i.to,
    statuses: TIMESHEET_STATUSES.filter((s) => i.statuses.includes(s)),
    views: TIMESHEET_VIEWS.filter((v) => i.views.includes(v)),
    format: i.format,
  };
  if (i.personId) out.person_id = i.personId;
  if (i.siteId) out.site_id = i.siteId;
  return out;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (s: string): number => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

/** Why a From/To pair is unusable ('' when both are empty, partial or fine). */
export function timesheetDateError(from: string, to: string): string {
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) return '';
  const span = dayNumber(to) - dayNumber(from) + 1;
  if (span < 1) return 'The From date must be on or before the To date.';
  if (span > MAX_SPAN_DAYS) return `The range can span at most ${MAX_SPAN_DAYS} days.`;
  return '';
}

/** Generate is allowed: both dates set and in order within the span limit,
 *  and at least one status and one view chosen. */
export function timesheetOptionsValid(i: {
  from: string; to: string; statuses: TimesheetStatus[]; views: TimesheetView[];
}): boolean {
  return DAY_RE.test(i.from) && DAY_RE.test(i.to) && !timesheetDateError(i.from, i.to)
    && i.statuses.length > 0 && i.views.length > 0;
}
