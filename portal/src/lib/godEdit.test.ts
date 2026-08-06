import { describe, expect, it } from 'vitest';
import { boolTriToPatch, defaultToPatch, numberToPatch } from './godEdit';
import { visibleColumnsFor, type ColumnDef } from './listTools';

describe('defaultToPatch', () => {
  it('trims and passes through non-empty strings', () => {
    expect(defaultToPatch('  Acme Co  ')).toBe('Acme Co');
  });
  it('maps empty (after trim) to null', () => {
    expect(defaultToPatch('')).toBeNull();
    expect(defaultToPatch('   ')).toBeNull();
  });
});

describe('numberToPatch', () => {
  it('parses a numeric string', () => {
    expect(numberToPatch('42')).toBe(42);
    expect(numberToPatch('3.5')).toBe(3.5);
  });
  it('maps empty to null', () => {
    expect(numberToPatch('')).toBeNull();
    expect(numberToPatch('   ')).toBeNull();
  });
  it('throws not_a_number for non-numeric input', () => {
    expect(() => numberToPatch('abc')).toThrow('not_a_number');
  });
});

describe('boolTriToPatch', () => {
  it('maps empty to null', () => {
    expect(boolTriToPatch('')).toBeNull();
  });
  it('maps yes to true and anything else to false', () => {
    expect(boolTriToPatch('yes')).toBe(true);
    expect(boolTriToPatch('no')).toBe(false);
  });
});

describe('visibleColumnsFor', () => {
  const columns: (ColumnDef & { godOnly?: boolean })[] = [
    { key: 'name', label: 'Name', width: '1fr', default: true },
    { key: 'status', label: 'Status', width: '120px', default: true },
    { key: 'secret', label: 'Secret', width: '120px', default: false, godOnly: true },
  ];

  it('drops columns not in the visible set', () => {
    const visible = new Set(['name']);
    expect(visibleColumnsFor(columns, visible, false).map((c) => c.key)).toEqual(['name']);
  });

  it('drops godOnly columns when god mode is off, even if visible', () => {
    const visible = new Set(['name', 'status', 'secret']);
    expect(visibleColumnsFor(columns, visible, false).map((c) => c.key))
      .toEqual(['name', 'status']);
  });

  it('includes godOnly columns when god mode is on and the column is visible', () => {
    const visible = new Set(['name', 'status', 'secret']);
    expect(visibleColumnsFor(columns, visible, true).map((c) => c.key))
      .toEqual(['name', 'status', 'secret']);
  });

  it('still respects the visible set when god mode is on', () => {
    const visible = new Set(['name']);
    expect(visibleColumnsFor(columns, visible, true).map((c) => c.key)).toEqual(['name']);
  });
});
