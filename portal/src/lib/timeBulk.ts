/**
 * Timesheet bulk approval helpers (pages/TimeManagement.tsx): the source
 * labels, the server-side filters and how they become GET /time/entries
 * params and the bulk-approve filter, and the result sentences.
 */
import type { TimeBulkFilter, TimeBulkSkip } from './api';

export const TIME_SOURCE_LABEL: Record<string, string> = {
  punch: 'Punch', kiosk: 'Kiosk', manual: 'Manual', import: 'Import',
};

export function timeSourceLabel(source: string): string {
  return TIME_SOURCE_LABEL[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/** The Timesheet's server-side filters; '' means "any". `from` / `to` are
 *  YYYY-MM-DD days from the date inputs, read in the viewer's time zone. */
export interface TimesheetFilter {
  person_id: string; initiative_id: string; site_id: string; from: string; to: string;
}

export const NO_FILTER: TimesheetFilter = {
  person_id: '', initiative_id: '', site_id: '', from: '', to: '',
};

export function hasFilter(f: TimesheetFilter): boolean {
  return Object.values(f).some((v) => v !== '');
}

/** Local midnight at the start of `day`, as an ISO instant. */
export function dayStartIso(day: string): string | undefined {
  return day ? new Date(`${day}T00:00:00`).toISOString() : undefined;
}

/** The last millisecond of `day`, local time, as an ISO instant. */
export function dayEndIso(day: string): string | undefined {
  return day ? new Date(`${day}T23:59:59.999`).toISOString() : undefined;
}

/** The filters as the bulk-approve API's `filter` object, blanks left out. */
export function bulkFilter(f: TimesheetFilter): TimeBulkFilter {
  const out: TimeBulkFilter = {};
  if (f.person_id) out.person_id = f.person_id;
  if (f.initiative_id) out.initiative_id = f.initiative_id;
  if (f.site_id) out.site_id = f.site_id;
  const from = dayStartIso(f.from);
  if (from) out.from = from;
  const to = dayEndIso(f.to);
  if (to) out.to = to;
  return out;
}

/** GET /time/entries params for a status pill plus the filters. */
export function listQuery(status: string, f: TimesheetFilter) {
  const b = bulkFilter(f);
  return {
    ...(status === 'all' ? {} : { status }),
    person_id: b.person_id, initiative_id: b.initiative_id, site_id: b.site_id,
    since: b.from, until: b.to,
  };
}

const num = (n: number) => n.toLocaleString('en-US');

export const entriesText = (n: number) => `${num(n)} ${n === 1 ? 'entry' : 'entries'}`;

/** "your own entry (1), no longer pending (1)" — most frequent first, ties in first-seen order. */
export function skipSummary(skipped: TimeBulkSkip[]): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, n], i) => ({ reason, n, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map(({ reason, n }) => `${reason} (${num(n)})`)
    .join(', ');
}

/** "Approved 212 entries. Skipped 2: your own entry (1), no longer pending (1)." */
export function bulkResultText(
  verb: 'Approved' | 'Rejected', done: number, skipped: TimeBulkSkip[],
): string {
  const head = `${verb} ${entriesText(done)}.`;
  return skipped.length ? `${head} Skipped ${num(skipped.length)}: ${skipSummary(skipped)}.` : head;
}

/** "Approve 214 pending entries that match these filters?" */
export function approveAllQuestion(n: number): string {
  return `Approve ${num(n)} pending ${n === 1 ? 'entry that matches' : 'entries that match'} these filters?`;
}
