import { describe, expect, it } from 'vitest';

import {
  levelClass, mergeEntries, nextBackoff, splitMessage,
} from './logViewer';

const entry = (id: number): { id: number } & Record<string, unknown> => ({
  id, level: 'INFO', levelno: 20, logger: 't', message: `m${id}`,
  at: '2026-08-26T12:00:00Z',
});

describe('nextBackoff', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(nextBackoff(0)).toBe(1000);
    expect(nextBackoff(1000)).toBe(2000);
    expect(nextBackoff(16000)).toBe(30000);
    expect(nextBackoff(30000)).toBe(30000);
  });
});

describe('splitMessage', () => {
  it('splits multi-line, passes single-line through', () => {
    expect(splitMessage('one line')).toEqual({ head: 'one line', rest: null });
    expect(splitMessage('err\nTraceback\n  boom')).toEqual(
      { head: 'err', rest: 'Traceback\n  boom' });
  });
});

describe('levelClass', () => {
  it('maps known and unknown levels', () => {
    expect(levelClass('ERROR')).toBe('log-ERROR');
    expect(levelClass('whatever')).toBe('log-INFO');
  });
});

describe('mergeEntries', () => {
  it('dedupes by id and keeps ascending order', () => {
    const merged = mergeEntries(
      [entry(1), entry(2)] as never,
      [entry(2), entry(3)] as never);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
  });
});
