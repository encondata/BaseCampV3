/**
 * Raw scans list: how the saved column filters become a server query.
 *
 * The Scanned column filters by a From / To day range, not by text or value
 * (its displayed text is locale-formatted, so the server cannot match it),
 * and Ingested has no filter at all. The range rides along in the list's
 * ordinary persisted column filters — `filters.scanned.values` holds
 * `from:YYYY-MM-DD` / `to:YYYY-MM-DD` tokens — so it is saved with the other
 * prefs, counted by the filter chip and cleared by Clear all for free.
 * Entries an older version saved for these two columns (locale text or
 * displayed-value lists) carry no token and are dropped here, harmlessly.
 */
import type { ColumnFilter, ColumnFilters } from './listTools';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FROM = 'from:';
const TO = 'to:';

/** Columns the server cannot filter by column filter. */
const NO_COLUMN_FILTER = new Set(['scanned', 'ingested']);

export interface DayRange { from: string; to: string }

/** The saved Scanned range, '' for an open end. */
export function scannedRange(filters: ColumnFilters): DayRange {
  const range: DayRange = { from: '', to: '' };
  for (const v of filters.scanned?.values ?? []) {
    if (v.startsWith(FROM) && DAY.test(v.slice(FROM.length))) range.from = v.slice(FROM.length);
    else if (v.startsWith(TO) && DAY.test(v.slice(TO.length))) range.to = v.slice(TO.length);
  }
  return range;
}

/** The column filter that stores a range; null when both ends are open. */
export function rangeFilter({ from, to }: DayRange): ColumnFilter | null {
  const values: string[] = [];
  if (DAY.test(from)) values.push(`${FROM}${from}`);
  if (DAY.test(to)) values.push(`${TO}${to}`);
  return values.length ? { values } : null;
}

/** The filters that really apply: stale Scanned / Ingested entries are dropped
 *  (only a real range survives under Scanned). This is what the filter chip,
 *  the empty-state escape hatch and the column menus should see. */
export function activeRawFilters(filters: ColumnFilters): ColumnFilters {
  const out: ColumnFilters = {};
  for (const [key, f] of Object.entries(filters)) {
    if (!NO_COLUMN_FILTER.has(key)) out[key] = f;
  }
  const range = rangeFilter(scannedRange(filters));
  if (range) out.scanned = range;
  return out;
}

/** Column filters to send to the server: everything but the Scanned range
 *  (which travels as since/until) and the unfilterable columns. */
export function serverColumnFilters(filters: ColumnFilters): ColumnFilters {
  const out: ColumnFilters = {};
  for (const [key, f] of Object.entries(filters)) {
    if (!NO_COLUMN_FILTER.has(key)) out[key] = f;
  }
  return out;
}

/** since / until instants for a day range. Date inputs are day-granular, so
 *  `to` means through the end of that local day (the Audit log's rule). */
export function rangeBounds({ from, to }: DayRange): { since?: string; until?: string } {
  const out: { since?: string; until?: string } = {};
  if (DAY.test(from)) out.since = new Date(`${from}T00:00:00`).toISOString();
  if (DAY.test(to)) out.until = new Date(`${to}T23:59:59.999`).toISOString();
  return out;
}
