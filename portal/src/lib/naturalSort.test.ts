import { describe, expect, it } from 'vitest';

import { compareOrdinal, compareValues, naturalCompare, sortNatural } from './naturalSort';

describe('naturalCompare', () => {
  it('orders numbers by value and ignores case', () => {
    expect(['Rack 10', 'Rack 2', 'rack 1', 'Rack 1a'].sort(naturalCompare))
      .toEqual(['rack 1', 'Rack 1a', 'Rack 2', 'Rack 10']);
  });
  it('treats missing values as empty strings, which sort first', () => {
    // Array.prototype.sort never hands `undefined` to a comparator (it always
    // moves it last), so undefined is asserted on the comparator directly.
    expect(['b', null, 'a'].sort(naturalCompare)).toEqual([null, 'a', 'b']);
    expect(naturalCompare(undefined, 'a')).toBeLessThan(0);
    expect(naturalCompare('a', undefined)).toBeGreaterThan(0);
    expect(naturalCompare(undefined, null)).toBe(0);
  });
  it('is stable for case-only differences', () => {
    expect(naturalCompare('Rack 1', 'rack 1')).toBe(0);
  });
  it('keeps accents distinct, like the API collation (ks-level2)', () => {
    expect(naturalCompare('Café', 'Cafe')).not.toBe(0);
    expect(naturalCompare('CAFÉ', 'café')).toBe(0);
  });
});

describe('sortNatural', () => {
  it('returns a sorted copy without mutating the input', () => {
    const items = [{ n: 'Site 10' }, { n: 'site 9' }, { n: 'Site 1' }];
    const out = sortNatural(items, (i) => i.n);
    expect(out.map((i) => i.n)).toEqual(['Site 1', 'site 9', 'Site 10']);
    expect(items.map((i) => i.n)).toEqual(['Site 10', 'site 9', 'Site 1']);
  });
});

describe('compareValues', () => {
  it('orders text naturally and numbers by value', () => {
    expect(compareValues('Rack 2', 'rack 10')).toBeLessThan(0);
    expect(compareValues(2, 10)).toBe(-1);
    expect(compareValues(10, 2)).toBe(1);
    expect(compareValues(3, 3)).toBe(0);
  });
  it('is a total order over mixed input: missing, then numbers, then text', () => {
    const mixed: (string | number | null | undefined)[] = ['b', 10, null, 'Rack 2', 2, undefined, 'rack 10'];
    // sort() moves undefined to the end without calling the comparator,
    // so the comparator's own rule for it is asserted directly.
    expect(mixed.filter((v) => v !== undefined).sort(compareValues))
      .toEqual([null, 2, 10, 'b', 'Rack 2', 'rack 10']);
    expect(compareValues(undefined, 0)).toBe(-1);
    expect(compareValues('0', 0)).toBe(1);
    expect(compareValues(0, '0')).toBe(-1);
    expect(compareValues(null, undefined)).toBe(0);
  });
});

describe('compareOrdinal', () => {
  it('orders by code unit, with missing values first', () => {
    expect(['2026-09-28T10:00:00.5Z', '2026-09-28T10:00:00.25Z', null, '2026-01-01T00:00:00Z']
      .sort(compareOrdinal))
      .toEqual([null, '2026-01-01T00:00:00Z', '2026-09-28T10:00:00.25Z', '2026-09-28T10:00:00.5Z']);
    expect(compareOrdinal('B', 'a')).toBe(-1);
    expect(compareOrdinal('a', 'a')).toBe(0);
    expect(compareOrdinal(undefined, 'a')).toBe(-1);
  });
});
