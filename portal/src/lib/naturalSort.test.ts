import { describe, expect, it } from 'vitest';

import { compareValues, naturalCompare, sortNatural } from './naturalSort';

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
});
