/**
 * Developer › Database › Health — display formatting, the Tables list's
 * column registry and its sort. Pure helpers; the tab (components/dev/
 * HealthTab.tsx) owns the state and the calls.
 */

import type { HealthTable } from './api';
import type { ColumnDef } from './listTools';
import { compareValues } from './naturalSort';

/** A query or transaction open longer than this is flagged amber. */
export const STALE_SECONDS = 300;

const DASH = '—';

/** B below 1 KB, then KB/MB/GB/TB with one decimal. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** "3 d 4 h" / "4 h 30 m" / "12 m" — the two largest units. */
export function formatUptime(startedAt: string | null, now: number = Date.now()): string {
  if (!startedAt) return DASH;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started) || started > now) return DASH;
  const mins = Math.floor((now - started) / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${mins % 60} m`;
  return mins > 0 ? `${mins} m` : '< 1 m';
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return DASH;
  return ms < 1 ? '< 1 ms' : `${Math.round(ms)} ms`;
}

/** A 0-1 ratio as "99.1%". */
export function formatPercent(ratio: number | null): string {
  return ratio === null ? DASH : `${(ratio * 100).toFixed(1)}%`;
}

/** "1.2 s", or whole milliseconds under a second. */
export function formatVacuumTime(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A query/transaction age in seconds: "45 s", "6 m 12 s", "2 h 5 m". */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return DASH;
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`;
}

export function isStale(seconds: number | null): boolean {
  return seconds !== null && seconds > STALE_SECONDS;
}

/** Fixed columns (no picker), so every `min` is an explicit floor sized
 *  for the cell value, not just the short header. 1,032px total with the
 *  actions track — under LIST_FIT.initPanel. */
export const TABLE_COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '2fr', default: true, min: 160 },
  { key: 'rows', label: 'Rows', width: '1fr', default: true, min: 80 },
  { key: 'total_bytes', label: 'Total size', short: 'Total', width: '1fr', default: true, min: 88 },
  { key: 'table_bytes', label: 'Table size', short: 'Table', width: '1fr', default: true, min: 88 },
  { key: 'index_bytes', label: 'Index size', short: 'Index', width: '1fr', default: true, min: 88 },
  { key: 'dead_rows', label: 'Dead rows', short: 'Dead', width: '1.2fr', default: true, min: 112 },
  { key: 'last_vacuum_at', label: 'Last vacuum', short: 'Vacuum', width: '1fr', default: true, min: 96 },
  { key: 'last_analyze_at', label: 'Last analyze', short: 'Analyze', width: '1fr', default: true, min: 96 },
];

/** Names read A→Z first; everything else leads with the biggest/latest. */
export function defaultSortDir(key: string): 1 | -1 {
  return key === 'name' ? 1 : -1;
}

function sortValue(t: HealthTable, key: string): string | number | null {
  switch (key) {
    case 'name': return t.name;
    case 'rows': return t.rows;
    case 'total_bytes': return t.total_bytes;
    case 'table_bytes': return t.table_bytes;
    case 'index_bytes': return t.index_bytes;
    case 'dead_rows': return t.dead_rows;
    case 'last_vacuum_at': return t.last_vacuum_at ? Date.parse(t.last_vacuum_at) : null;
    case 'last_analyze_at': return t.last_analyze_at ? Date.parse(t.last_analyze_at) : null;
    default: return null;
  }
}

/** A sorted copy. Ties fall back to the name so the order is stable;
 *  a never-vacuumed/analyzed table sorts as the oldest. */
export function sortTables(tables: readonly HealthTable[], key: string, dir: 1 | -1): HealthTable[] {
  return [...tables].sort((a, b) =>
    dir * compareValues(sortValue(a, key), sortValue(b, key))
    || compareValues(a.name, b.name));
}
