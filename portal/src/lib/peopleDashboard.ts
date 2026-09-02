/**
 * Pure People Dashboard helpers — event-feed derivation and chart-point
 * mapping. No React, no fetching.
 */

import type { DayPoint } from '../components/dashboard/charts';
import type { TimeDayStat, TimeEntryItem } from './api';

export interface TimeclockEvent {
  key: string;
  kind: 'in' | 'out';
  person_id: string;
  person_name: string;
  at: string;
  minutes: number | null;
  context: string;
}

/** Each entry emits an IN event and, when closed, an OUT event carrying
 *  its worked minutes; interleaved newest-first, capped. ISO strings
 *  compare lexicographically so no Date parsing is needed. */
export function buildTimeclockEvents(
  entries: TimeEntryItem[], cap: number,
): TimeclockEvent[] {
  const out: TimeclockEvent[] = [];
  for (const e of entries) {
    const context = e.initiative_name ?? e.site_name ?? '';
    out.push({ key: `${e.id}-in`, kind: 'in', person_id: e.person_id,
               person_name: e.person_name, at: e.clock_in_at,
               minutes: null, context });
    if (e.clock_out_at) {
      out.push({ key: `${e.id}-out`, kind: 'out', person_id: e.person_id,
                 person_name: e.person_name, at: e.clock_out_at,
                 minutes: e.minutes, context });
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, cap);
}

export function hoursDayPoints(days: TimeDayStat[]): DayPoint[] {
  return days.map((d) => ({
    key: d.day,
    label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    }),
    value: d.minutes,
  }));
}
