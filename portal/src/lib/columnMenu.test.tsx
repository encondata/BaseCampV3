// @vitest-environment jsdom
/**
 * lib/columnMenu.tsx: the pure matcher/uniqueValues/count helpers, the
 * persistence hook's hydrate→change→debounced-save lifecycle (including
 * unknown-column sanitization and the never-clobber merge), and the
 * <ColumnMenu> popover's checklist-narrowing + Select-all behavior.
 */

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeFilterCount,
  ColumnMenu,
  EmptyClearFilters,
  FilterSummaryChip,
  passesColumnFilters,
  uniqueValues,
  usePersistentListState,
  type CellText,
  type ColumnFilters,
} from './columnMenu';
import type { UiPreferences } from './api';

interface Row { id: string; name: string; site: string }

const rows: Row[] = [
  { id: '1', name: 'Alpha', site: 'DA1' },
  { id: '2', name: 'Bravo', site: 'DA10' },
  { id: '3', name: 'Charlie', site: 'DA2' },
  { id: '4', name: 'Delta', site: '' },
];

const text: CellText<Row> = (row, colKey) => (colKey === 'site' ? row.site : row.name);

const auth = vi.hoisted(() => ({
  preferences: {
    accent: 'amber', theme: 'light' as const, density: 'comfortable' as const,
    motion: true, notif: { critical: true, email: true, maint: true, digest: false },
    list_prefs: {} as Record<string, unknown>,
  } as UiPreferences,
  updatePreferences: vi.fn(async (_prefs: UiPreferences) => true),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => auth,
}));

afterEach(cleanup);

/* ── pure helpers ─────────────────────────────────────────────────── */

describe('uniqueValues', () => {
  it('dedupes, collapses blanks to the em dash, and sorts naturally', () => {
    const result = uniqueValues(rows, 'site', text);
    expect(result).toContain('—');
    expect(new Set(result).size).toBe(result.length); // deduped
    expect(result.indexOf('DA1')).toBeLessThan(result.indexOf('DA2'));
    expect(result.indexOf('DA2')).toBeLessThan(result.indexOf('DA10'));
  });
});

describe('passesColumnFilters', () => {
  it('passes every row when there are no filters', () => {
    expect(passesColumnFilters(rows[0], {}, text)).toBe(true);
  });

  it('text filter substring-matches case-insensitively', () => {
    expect(passesColumnFilters(rows[0], { name: { text: 'ALP' } }, text)).toBe(true);
    expect(passesColumnFilters(rows[0], { name: { text: 'zzz' } }, text)).toBe(false);
  });

  it("values filter matches a blank cell via the '—' display value", () => {
    const blank = rows[3]; // site: ''
    expect(passesColumnFilters(blank, { site: { values: ['—'] } }, text)).toBe(true);
    expect(passesColumnFilters(blank, { site: { values: ['DA1'] } }, text)).toBe(false);
  });

  it('AND-combines a text filter and a values filter on the same column', () => {
    const row = rows[1]; // site: DA10
    expect(passesColumnFilters(row, { site: { text: 'da', values: ['DA10'] } }, text)).toBe(true);
    expect(passesColumnFilters(row, { site: { text: 'da', values: ['DA2'] } }, text)).toBe(false);
  });
});

describe('activeFilterCount', () => {
  it('counts filter keys', () => {
    expect(activeFilterCount({})).toBe(0);
    const filters: ColumnFilters = { name: { text: 'a' }, site: { values: ['DA1'] } };
    expect(activeFilterCount(filters)).toBe(2);
  });
});

/* ── FilterSummaryChip / EmptyClearFilters ───────────────────────── */

describe('FilterSummaryChip', () => {
  it('renders nothing absent active filters, else a count + Clear', () => {
    const onClear = vi.fn();
    const { rerender } = render(<FilterSummaryChip filters={{}} onClear={onClear} />);
    expect(screen.queryByRole('button')).toBeNull();

    rerender(<FilterSummaryChip filters={{ name: { text: 'a' } }} onClear={onClear} />);
    expect(screen.getByText(/1 filter active/)).toBeDefined();
    fireEvent.click(screen.getByRole('button'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('EmptyClearFilters', () => {
  it('renders nothing absent active filters, else a Clear-all-filters button', () => {
    const onClear = vi.fn();
    const { rerender } = render(<EmptyClearFilters filters={{}} onClear={onClear} />);
    expect(screen.queryByRole('button')).toBeNull();

    rerender(<EmptyClearFilters filters={{ name: { text: 'a' } }} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

/* ── ColumnMenu ───────────────────────────────────────────────────── */

describe('ColumnMenu', () => {
  it('the trigger carries the filtered class only when a filter is active', () => {
    const { rerender } = render(
      <ColumnMenu colKey="site" label="Site" rows={rows} text={text}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Site column menu' }).getAttribute('aria-pressed')).toBe('false');

    rerender(
      <ColumnMenu colKey="site" label="Site" rows={rows} text={text}
                  filter={{ text: 'x' }} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Site column menu' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the checklist narrows to values matching the typed text, and Select all applies just that narrowed set', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    render(
      <ColumnMenu colKey="site" label="Site" rows={rows} text={text}
                  filter={undefined} onFilter={onFilter} sortDir={null} onSort={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await user.type(screen.getByPlaceholderText('Filter Site'), 'da1');

    expect(screen.getByText('DA1')).toBeDefined();
    expect(screen.getByText('DA10')).toBeDefined();
    expect(screen.queryByText('DA2')).toBeNull();
    expect(screen.queryByText('—')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(onFilter).toHaveBeenLastCalledWith('site', { text: 'da1', values: ['DA1', 'DA10'] });
  });

  it('unchecking one value (no prior filter) keeps every other value selected', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    render(
      <ColumnMenu colKey="site" label="Site" rows={rows} text={text}
                  filter={undefined} onFilter={onFilter} sortDir={null} onSort={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await user.click(screen.getByText('DA2'));

    expect(onFilter).toHaveBeenCalledTimes(1);
    const [colKey, f] = onFilter.mock.calls[0] as [string, { values: string[] }];
    expect(colKey).toBe('site');
    expect(f.values).toHaveLength(3);
    expect(f.values).not.toContain('DA2');
    expect(f.values).toEqual(expect.arrayContaining(['—', 'DA1', 'DA10']));
  });

  it('Clear filter calls onFilter with null', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    render(
      <ColumnMenu colKey="site" label="Site" rows={rows} text={text}
                  filter={{ values: ['DA1'] }} onFilter={onFilter} sortDir={null} onSort={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(onFilter).toHaveBeenCalledWith('site', null);
  });

  it('the A→Z / Z→A actions call onSort with the chosen direction', async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(
      <ColumnMenu colKey="name" label="Name" rows={rows} text={text}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={onSort} />,
    );
    await user.click(screen.getByRole('button', { name: 'Name column menu' }));
    await user.click(screen.getByText('Z → A'));
    expect(onSort).toHaveBeenCalledWith(-1);
  });
});

/* ── usePersistentListState ───────────────────────────────────────── */

describe('usePersistentListState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    auth.preferences = {
      accent: 'amber', theme: 'light', density: 'comfortable', motion: true,
      notif: { critical: true, email: true, maint: true, digest: false },
      list_prefs: {},
    };
    auth.updatePreferences.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('with nothing persisted, returns the caller-supplied defaults', () => {
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1,
    }));
    expect(Array.from(result.current.visibleCols)).toEqual(['name', 'status']);
    expect(result.current.sortKey).toBe('name');
    expect(result.current.sortDir).toBe(1);
    expect(result.current.filters).toEqual({});
  });

  it('hydrates visible/sort/filters from list_prefs[pageKey] once on mount', () => {
    auth.preferences.list_prefs = {
      sites: {
        visible: ['name', 'city'],
        sortKey: 'city',
        sortDir: -1,
        filters: { status: { values: ['active'] } },
      },
    };
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status', 'city']), sortKey: 'name', sortDir: 1,
    }));
    expect(Array.from(result.current.visibleCols)).toEqual(['name', 'city']);
    expect(result.current.sortKey).toBe('city');
    expect(result.current.sortDir).toBe(-1);
    expect(result.current.filters).toEqual({ status: { values: ['active'] } });
  });

  it('sanitizes columns that no longer exist out of visible/sort/filters', () => {
    auth.preferences.list_prefs = {
      sites: {
        visible: ['name', 'ghost', 'status'],
        sortKey: 'ghost',
        sortDir: -1,
        filters: { ghost: { text: 'x' }, status: { values: ['active'] } },
      },
    };
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status', 'city']), sortKey: 'name', sortDir: 1,
    }));
    expect(Array.from(result.current.visibleCols)).toEqual(['name', 'status']);
    expect(result.current.sortKey).toBe('name'); // 'ghost' is unknown -> falls back to the default
    expect(result.current.filters).toEqual({ status: { values: ['active'] } }); // the ghost-keyed entry is dropped
  });

  it('does not save immediately after hydration', () => {
    auth.preferences.list_prefs = {
      sites: { visible: ['name'], sortKey: 'name', sortDir: 1, filters: {} },
    };
    renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1,
    }));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(auth.updatePreferences).not.toHaveBeenCalled();
  });

  it('debounces a save 600ms after a change, merging onto current preferences without clobbering other pages/fields', () => {
    auth.preferences = {
      ...auth.preferences,
      accent: 'blue',
      list_prefs: { workers: { visible: ['name'], sortKey: 'name', sortDir: 1, filters: {} } },
    };
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1,
    }));

    act(() => { result.current.setFilter('status', { values: ['active'] }); });
    act(() => { vi.advanceTimersByTime(599); });
    expect(auth.updatePreferences).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1); });
    expect(auth.updatePreferences).toHaveBeenCalledTimes(1);

    const saved = auth.updatePreferences.mock.calls[0][0] as UiPreferences;
    expect(saved.accent).toBe('blue'); // other preference fields preserved
    expect(saved.list_prefs.workers).toEqual({ // another page's entry preserved
      visible: ['name'], sortKey: 'name', sortDir: 1, filters: {},
    });
    expect(saved.list_prefs.sites).toEqual({
      visible: ['name', 'status'], sortKey: 'name', sortDir: 1,
      filters: { status: { values: ['active'] } },
    });
  });

  it('collapses rapid changes into a single save carrying the latest state', () => {
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1,
    }));

    act(() => { result.current.setSort('status', -1); });
    act(() => { vi.advanceTimersByTime(300); });
    act(() => { result.current.setVisibleCols(new Set(['status'])); });
    act(() => { vi.advanceTimersByTime(600); });

    expect(auth.updatePreferences).toHaveBeenCalledTimes(1);
    const saved = auth.updatePreferences.mock.calls[0][0] as UiPreferences;
    expect(saved.list_prefs.sites).toEqual({
      visible: ['status'], sortKey: 'status', sortDir: -1, filters: {},
    });
  });

  it('toggleSort flips direction on the same key, resets to ascending on a new key', () => {
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1,
    }));
    act(() => { result.current.toggleSort('name'); });
    expect(result.current.sortDir).toBe(-1);
    act(() => { result.current.toggleSort('status'); });
    expect(result.current.sortKey).toBe('status');
    expect(result.current.sortDir).toBe(1);
  });

  it('setFilter with a blank filter removes the key; clearFilters empties everything', () => {
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1,
    }));
    act(() => { result.current.setFilter('status', { values: ['active'] }); });
    expect(result.current.filters).toEqual({ status: { values: ['active'] } });

    act(() => { result.current.setFilter('status', { text: '' }); });
    expect(result.current.filters).toEqual({});

    act(() => { result.current.setFilter('name', { text: 'a' }); });
    act(() => { result.current.clearFilters(); });
    expect(result.current.filters).toEqual({});
  });
});
