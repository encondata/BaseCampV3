import { describe, expect, it } from 'vitest';

import type { HealthTable } from './api';
import {
  STALE_SECONDS, TABLE_COLUMNS, defaultSortDir, formatAge, formatBytes, formatLatency,
  formatPercent, formatUptime, formatVacuumTime, isStale, sortTables,
} from './dbHealth';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

describe('formatBytes', () => {
  it('uses B below 1 KB and one decimal above', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5.5 * MB)).toBe('5.5 MB');
    expect(formatBytes(1.2 * GB)).toBe('1.2 GB');
    expect(formatBytes(3 * 1024 * GB)).toBe('3.0 TB');
  });
});

describe('formatUptime', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  it('shows the two largest units', () => {
    expect(formatUptime('2026-10-06T08:00:00Z', now)).toBe('3 d 4 h');
    expect(formatUptime('2026-10-09T07:30:00Z', now)).toBe('4 h 30 m');
    expect(formatUptime('2026-10-09T11:48:00Z', now)).toBe('12 m');
    expect(formatUptime('2026-10-09T11:59:40Z', now)).toBe('< 1 m');
  });
  it('is a dash for a missing or future start', () => {
    expect(formatUptime(null, now)).toBe('—');
    expect(formatUptime('2026-10-10T00:00:00Z', now)).toBe('—');
  });
});

describe('formatLatency / formatPercent / formatVacuumTime', () => {
  it('formats response time', () => {
    expect(formatLatency(4.2)).toBe('4 ms');
    expect(formatLatency(0.3)).toBe('< 1 ms');
    expect(formatLatency(null)).toBe('—');
  });
  it('formats a 0-1 ratio as a percent with one decimal', () => {
    expect(formatPercent(0.9912)).toBe('99.1%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(null)).toBe('—');
  });
  it('formats the vacuum duration', () => {
    expect(formatVacuumTime(1234)).toBe('1.2 s');
    expect(formatVacuumTime(420)).toBe('420 ms');
  });
});

describe('formatAge / isStale', () => {
  it('formats seconds compactly and dashes null', () => {
    expect(formatAge(null)).toBe('—');
    expect(formatAge(0.4)).toBe('0 s');
    expect(formatAge(45)).toBe('45 s');
    expect(formatAge(372)).toBe('6 m 12 s');
    expect(formatAge(7500)).toBe('2 h 5 m');
  });
  it('flags only ages over five minutes', () => {
    expect(STALE_SECONDS).toBe(300);
    expect(isStale(300)).toBe(false);
    expect(isStale(300.5)).toBe(true);
    expect(isStale(null)).toBe(false);
  });
});

function table(name: string, over: Partial<HealthTable> = {}): HealthTable {
  return {
    name, rows: 0, total_bytes: 0, table_bytes: 0, index_bytes: 0, dead_rows: 0,
    dead_ratio: null, last_vacuum_at: null, last_analyze_at: null, ...over,
  };
}

describe('sortTables', () => {
  const rows = [
    table('rack 10', { rows: 5, total_bytes: 300, table_bytes: 100, index_bytes: 200,
      dead_rows: 9, last_vacuum_at: '2026-10-01T00:00:00Z', last_analyze_at: null }),
    table('rack 2', { rows: 50, total_bytes: 100, table_bytes: 300, index_bytes: 10,
      dead_rows: 1, last_vacuum_at: null, last_analyze_at: '2026-10-05T00:00:00Z' }),
    table('asset', { rows: 7, total_bytes: 200, table_bytes: 200, index_bytes: 100,
      dead_rows: 5, last_vacuum_at: '2026-10-03T00:00:00Z', last_analyze_at: '2026-10-02T00:00:00Z' }),
  ];
  const names = (key: string, dir: 1 | -1) => sortTables(rows, key, dir).map((t) => t.name);

  it('sorts names naturally', () => {
    expect(names('name', 1)).toEqual(['asset', 'rack 2', 'rack 10']);
    expect(names('name', -1)).toEqual(['rack 10', 'rack 2', 'asset']);
  });
  it('sorts each numeric column', () => {
    expect(names('rows', -1)).toEqual(['rack 2', 'asset', 'rack 10']);
    expect(names('total_bytes', -1)).toEqual(['rack 10', 'asset', 'rack 2']);
    expect(names('table_bytes', 1)).toEqual(['rack 10', 'asset', 'rack 2']);
    expect(names('index_bytes', -1)).toEqual(['rack 10', 'asset', 'rack 2']);
    expect(names('dead_rows', -1)).toEqual(['rack 10', 'asset', 'rack 2']);
  });
  it('sorts dates, with never-vacuumed last when descending', () => {
    expect(names('last_vacuum_at', -1)).toEqual(['asset', 'rack 10', 'rack 2']);
    expect(names('last_vacuum_at', 1)).toEqual(['rack 2', 'rack 10', 'asset']);
    expect(names('last_analyze_at', -1)).toEqual(['rack 2', 'asset', 'rack 10']);
  });
  it('does not mutate its input', () => {
    sortTables(rows, 'name', 1);
    expect(rows.map((t) => t.name)).toEqual(['rack 10', 'rack 2', 'asset']);
  });
  it('first click goes ascending for names and descending for the rest', () => {
    expect(defaultSortDir('name')).toBe(1);
    expect(defaultSortDir('total_bytes')).toBe(-1);
  });
});

describe('TABLE_COLUMNS', () => {
  it('has a short label and an explicit floor where the content needs one', () => {
    const keys = TABLE_COLUMNS.map((c) => c.key);
    expect(keys).toEqual(['name', 'rows', 'total_bytes', 'table_bytes', 'index_bytes',
      'dead_rows', 'last_vacuum_at', 'last_analyze_at']);
    expect(TABLE_COLUMNS.find((c) => c.key === 'name')?.min).toBeGreaterThanOrEqual(160);
    for (const c of TABLE_COLUMNS) expect(c.width).toMatch(/fr$/);
  });
});
