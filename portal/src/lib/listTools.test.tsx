// @vitest-environment jsdom
/**
 * lib/listTools.tsx: the column-order helpers (applyColumnOrder, moveKey),
 * the useReorderDrag drag-and-drop hook, and ColumnsButton's reorder mode.
 */

import { describe, expect, it } from 'vitest';

import { applyColumnOrder, moveKey, type ColumnDef } from './listTools';

const col = (key: string): ColumnDef => ({ key, label: key, width: '1fr', default: true });
const COLS: ColumnDef[] = [col('a'), col('b'), col('c'), col('d')];
const keysOf = (cols: ColumnDef[]) => cols.map((c) => c.key);

describe('applyColumnOrder', () => {
  it('returns columns unchanged for an empty order', () => {
    expect(applyColumnOrder(COLS, [])).toEqual(COLS);
  });

  it('orders by the given full key order', () => {
    expect(keysOf(applyColumnOrder(COLS, ['c', 'a', 'd', 'b']))).toEqual(['c', 'a', 'd', 'b']);
  });

  it('appends columns missing from a partial order in their default relative order', () => {
    // 'b' and 'd' unmentioned — they trail in original (b before d) order.
    expect(keysOf(applyColumnOrder(COLS, ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ignores order keys that match no column', () => {
    expect(keysOf(applyColumnOrder(COLS, ['zzz', 'b', 'a']))).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('moveKey', () => {
  it('moves src before dst', () => {
    expect(moveKey(['a', 'b', 'c', 'd'], 'd', 'b', true)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves src after dst', () => {
    expect(moveKey(['a', 'b', 'c', 'd'], 'a', 'c', false)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('returns keys unchanged when src === dst or either is unknown', () => {
    expect(moveKey(['a', 'b'], 'a', 'a', true)).toEqual(['a', 'b']);
    expect(moveKey(['a', 'b'], 'zzz', 'b', true)).toEqual(['a', 'b']);
    expect(moveKey(['a', 'b'], 'a', 'zzz', true)).toEqual(['a', 'b']);
  });
});
