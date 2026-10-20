import { describe, expect, it } from 'vitest';

import { pyRound, toDots, toInches } from './units';

describe('pyRound', () => {
  it('rounds ties to the even neighbor, like Python round()', () => {
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(304.5)).toBe(304);
    expect(pyRound(-2.5)).toBe(-2);
    expect(pyRound(-3.5)).toBe(-4);
  });

  it('rounds everything else to the nearest integer', () => {
    expect(pyRound(3.99)).toBe(4);
    expect(pyRound(2.4999)).toBe(2);
    expect(pyRound(-1.2)).toBe(-1);
    expect(pyRound(7)).toBe(7);
  });
});

describe('toDots / toInches', () => {
  it('converts inches to whole dots the way the compiler does', () => {
    expect(toDots(3.3333, 300)).toBe(1000);
    expect(toDots(0.0133, 300)).toBe(4);
    expect(toDots(1.5, 203)).toBe(304);   // 304.5 → even
    expect(toDots(0.49, 300)).toBe(147);
  });

  it('converts dots back to inches', () => {
    expect(toInches(150, 300)).toBe(0.5);
    expect(toInches(203, 203)).toBe(1);
  });
});
