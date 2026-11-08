// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePersistentListState } from '@portal/lib/columnMenu';
import { useListPrefs } from '@portal/lib/listPrefs';

import { KIOSK_LIST_PREFS_KEY, KioskListPrefsProvider, readKioskListPrefs } from './listPrefs';

const wrapper = ({ children }: { children: ReactNode }) => (
  createElement(KioskListPrefsProvider, { listSize: 'large', children })
);

const defaults = { visible: new Set(['asset_id', 'name']), sortKey: 'source_rack', sortDir: 1 as const };
const allKeys = new Set(['asset_id', 'name', 'serial']);
const useState = () => usePersistentListState('labels-print', defaults, allKeys);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('KioskListPrefsProvider', () => {
  it('saves and restores sort, filters and columns', () => {
    const first = renderHook(useState, { wrapper });
    act(() => {
      first.result.current.setSort('name', -1);
      first.result.current.setFilter('name', { text: 'sw' });
      first.result.current.setVisibleCols(new Set(['name', 'serial']));
    });
    act(() => { vi.advanceTimersByTime(600); });

    const saved = JSON.parse(localStorage.getItem(KIOSK_LIST_PREFS_KEY)!)['labels-print'];
    expect(saved.sortKey).toBe('name');
    expect(saved.sortDir).toBe(-1);
    expect(saved.filters).toEqual({ name: { text: 'sw' } });
    expect([...saved.visible].sort()).toEqual(['name', 'serial']);
    first.unmount();

    const second = renderHook(useState, { wrapper });
    expect(second.result.current.sortKey).toBe('name');
    expect(second.result.current.sortDir).toBe(-1);
    expect(second.result.current.filters).toEqual({ name: { text: 'sw' } });
    expect([...second.result.current.visibleCols].sort()).toEqual(['name', 'serial']);
  });

  it("keeps other pages' entries", () => {
    localStorage.setItem(KIOSK_LIST_PREFS_KEY, JSON.stringify({ 'labels-print-containers': { sortKey: 'site' } }));
    const { result } = renderHook(useState, { wrapper });
    act(() => { result.current.setSort('name', 1); });
    act(() => { vi.advanceTimersByTime(600); });
    const all = JSON.parse(localStorage.getItem(KIOSK_LIST_PREFS_KEY)!);
    expect(all['labels-print-containers']).toEqual({ sortKey: 'site' });
    expect(all['labels-print'].sortKey).toBe('name');
  });

  it('listSize comes from the prop', () => {
    const { result } = renderHook(() => useListPrefs(), { wrapper });
    expect(result.current.listSize).toBe('large');
  });

  it('unreadable list settings fall back to defaults', () => {
    for (const stored of ['{not json', '[1,2]', 'null']) {
      localStorage.setItem(KIOSK_LIST_PREFS_KEY, stored);
      expect(readKioskListPrefs()).toEqual({});
      const { result, unmount } = renderHook(useState, { wrapper });
      expect(result.current.sortKey).toBe('source_rack');
      expect(result.current.sortDir).toBe(1);
      unmount();
    }
    localStorage.clear();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readKioskListPrefs()).toEqual({});
    const { result } = renderHook(useState, { wrapper });
    expect(result.current.sortKey).toBe('source_rack');
  });
});
