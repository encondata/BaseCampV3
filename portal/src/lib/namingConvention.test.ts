import { describe, expect, it } from 'vitest';

import {
  CRATE_MAX, TRUCK_MAX, clashSentence, defaultConvention, generateNames, namesPreview,
  namingResult, parseConvention,
} from './namingConvention';

describe('parseConvention', () => {
  it('splits prefix, run and suffix', () => {
    expect(parseConvention('CRT-SJC-DAL-xxx')).toEqual({ prefix: 'CRT-SJC-DAL-', width: 3, suffix: '' });
    expect(parseConvention('  A-XX-B ')).toEqual({ prefix: 'A-', width: 2, suffix: '-B' });
  });
  it.each([
    ['', 'Enter a naming convention, like CRT-xxx.'],
    ['CRT-001', "Mark the number with a run of x's, like CRT-xxx."],
    ['BOX-xxx', "Use only one run of x's for the number."],
    ['xx-XX', "Use only one run of x's for the number."],
  ])('%j → %s', (text, message) => {
    expect(parseConvention(text)).toEqual({ error: message });
  });
});

describe('generateNames', () => {
  it('pads to the run and never truncates', () => {
    expect(generateNames('CRT-xxx', 3, 1, CRATE_MAX).names).toEqual(['CRT-001', 'CRT-002', 'CRT-003']);
    expect(generateNames('T-x-B', 3, 9, TRUCK_MAX).names).toEqual(['T-9-B', 'T-10-B', 'T-11-B']);
    expect(generateNames('CRT-xx', 1, 1234, CRATE_MAX).names).toEqual(['CRT-1234']);
    expect(generateNames('CRT-xxx', 0, 1, CRATE_MAX)).toEqual({ names: [], error: null });
  });
  it.each([
    [501, 1, CRATE_MAX, 'The count must be between 0 and 500.'],
    [101, 1, TRUCK_MAX, 'The count must be between 0 and 100.'],
    [3, -1, CRATE_MAX, "The start number can't be below 0."],
  ])('count %i start %i → %s', (count, start, max, message) => {
    expect(generateNames('CRT-xxx', count, start, max)).toEqual({ names: [], error: message });
  });
  it('checks the convention before the count', () => {
    expect(generateNames('CRT', 999, -5, CRATE_MAX).error).toBe("Mark the number with a run of x's, like CRT-xxx.");
  });
});

describe('namingResult', () => {
  it('reads typed text and reports a blank count or start', () => {
    expect(namingResult({ convention: 'CRT-xxx', count: '2', start: '5' }, CRATE_MAX).names).toEqual(['CRT-005', 'CRT-006']);
    expect(namingResult({ convention: 'CRT-xxx', count: '', start: '1' }, CRATE_MAX).error).toBe('The count must be between 0 and 500.');
    expect(namingResult({ convention: 'CRT-xxx', count: '2', start: '' }, CRATE_MAX).error).toBe('Enter a start number.');
    expect(namingResult({ convention: 'CRT', count: '', start: '' }, CRATE_MAX).error).toBe("Mark the number with a run of x's, like CRT-xxx.");
  });
});

describe('defaultConvention', () => {
  it('uses both site codes, else falls back', () => {
    expect(defaultConvention('CRT', 'SJC', 'DAL')).toBe('CRT-SJC-DAL-xxx');
    expect(defaultConvention('TRK', 'SJC', 'DAL')).toBe('TRK-SJC-DAL-xxx');
    expect(defaultConvention('CRT', 'SJC', null)).toBe('CRT-xxx');
    expect(defaultConvention('TRK', '  ', 'DAL')).toBe('TRK-xxx');
    expect(defaultConvention('CRT', 'XYZ', 'DAL')).toBe('CRT-xxx');   // an x would add a second run
  });
});

it('namesPreview and clashSentence', () => {
  expect(namesPreview(['A', 'B', 'C', 'D'])).toBe('A, B, C, D');
  expect(namesPreview(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C … E');
  expect(clashSentence('crate', ['A', 'B'])).toBe('These crate names already exist: A, B.');
  const many = Array.from({ length: 12 }, (_, i) => `T-${i}`);
  expect(clashSentence('truck', many)).toBe(
    'These truck names already exist: T-0, T-1, T-2, T-3, T-4, T-5, T-6, T-7, T-8, T-9, and 2 more.');
});
