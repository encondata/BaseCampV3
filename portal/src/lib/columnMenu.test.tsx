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

import { sanitize,
  activeFilterCount,
  ColumnMenu,
  EmptyClearFilters,
  FilterSummaryChip,
  passesColumnFilters,
  rowsForMenu,
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
    accent: 'amber', theme: 'light' as const, density: 'comfortable' as const, list_size: 'default' as const,
    motion: true, nav_mode: 'expanded' as const, nav_bg: 'default', nav_size: 'default' as const,
    notif: { critical: true, email: true, maint: true, digest: false, sound: 'chime' },
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

describe('rowsForMenu', () => {
  it("ignores the column's own filter, so an already-checked value stays offered", () => {
    // site filter narrowed to just DA1 — if rowsForMenu applied it, DA10/DA2
    // would vanish from the Site menu's own options the moment DA1 alone is
    // checked, making it impossible to add a second value back.
    const result = rowsForMenu(rows, { site: { values: ['DA1'] } }, 'site', text);
    expect(result).toEqual(rows);
  });

  it("applies every OTHER column's filter", () => {
    // name filter to 'Bravo' (site: DA10) — opening the Site menu should
    // only offer values among rows that still pass the name filter.
    const result = rowsForMenu(rows, { name: { text: 'Bravo' } }, 'site', text);
    expect(result).toEqual([rows[1]]);
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
      <ColumnMenu colKey="site" label="Site" allRows={rows} filters={{}} text={text}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Site column menu' }).getAttribute('aria-pressed')).toBe('false');

    rerender(
      <ColumnMenu colKey="site" label="Site" allRows={rows} filters={{}} text={text}
                  filter={{ text: 'x' }} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Site column menu' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the checklist narrows to values matching the typed text, and Select all applies just that narrowed set', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    render(
      <ColumnMenu colKey="site" label="Site" allRows={rows} filters={{}} text={text}
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
      <ColumnMenu colKey="site" label="Site" allRows={rows} filters={{}} text={text}
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
      <ColumnMenu colKey="site" label="Site" allRows={rows} filters={{}} text={text}
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
      <ColumnMenu colKey="name" label="Name" allRows={rows} filters={{}} text={text}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={onSort} />,
    );
    await user.click(screen.getByRole('button', { name: 'Name column menu' }));
    await user.click(screen.getByText('Z → A'));
    expect(onSort).toHaveBeenCalledWith(-1);
  });

  it("never scans rows (rowsForMenu's text accessor stays uncalled) while the menu is closed", async () => {
    const user = userEvent.setup();
    const spy = vi.fn(text);
    const { rerender } = render(
      <ColumnMenu colKey="site" label="Site" allRows={rows} filters={{}} text={spy}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    expect(spy).not.toHaveBeenCalled();

    // A re-render with new filters/allRows (as happens every render on a
    // real page, since the page no longer memoizes rowsForMenu itself)
    // still must not scan while closed.
    rerender(
      <ColumnMenu colKey="site" label="Site" allRows={rows} filters={{ name: { text: 'a' } }} text={spy}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    expect(spy).not.toHaveBeenCalled();

    // Opening the menu is what finally triggers the scan.
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    expect(spy).toHaveBeenCalled();
  });

  it('renders the open menu through a portal under document.body, and a mousedown inside it does not close it', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ColumnMenu colKey="name" label="Name" allRows={rows} filters={{}} text={text}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Name column menu' }));

    const menu = document.querySelector('.colmenu-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.classList.contains('colmenu-portaled')).toBe(true);

    fireEvent.mouseDown(screen.getByPlaceholderText('Filter Name'));
    expect(document.querySelector('.colmenu-menu')).not.toBeNull();

    fireEvent.mouseDown(document.body);
    expect(document.querySelector('.colmenu-menu')).toBeNull();
  });

  it('closes when its header scrolls out of the list card', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <div className="dir-list list-scroll">
        <ColumnMenu colKey="name" label="Name" allRows={rows} filters={{}} text={text}
                    filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />
      </div>,
    );
    const card = container.querySelector('.dir-list') as HTMLElement;
    const wrap = container.querySelector('.colmenu') as HTMLElement;
    const rect = (left: number, right: number) =>
      ({ left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON() {} }) as DOMRect;
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(rect(100, 600));
    const wrapRect = vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(200, 260));

    await user.click(screen.getByRole('button', { name: 'Name column menu' }));
    expect(document.querySelector('.colmenu-menu')).not.toBeNull();

    // Still inside the card after a scroll: stays open, re-placed.
    wrapRect.mockReturnValue(rect(500, 560));
    act(() => { window.dispatchEvent(new Event('scroll')); });
    expect(document.querySelector('.colmenu-menu')).not.toBeNull();

    // Scrolled past the card's right edge: closes.
    wrapRect.mockReturnValue(rect(700, 760));
    act(() => { window.dispatchEvent(new Event('scroll')); });
    expect(document.querySelector('.colmenu-menu')).toBeNull();
  });
});

/* ── usePersistentListState ───────────────────────────────────────── */

describe('usePersistentListState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    auth.preferences = {
      accent: 'amber', theme: 'light', density: 'comfortable', list_size: 'default', motion: true,
      nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: false, sound: 'chime' },
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
        seen: ['name', 'status', 'city'],
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
        seen: ['name', 'status', 'city'],
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

  it('sanitizes against allKeys (not just defaults.visible) when provided, so a persisted non-default/god-only column survives', () => {
    auth.preferences.list_prefs = {
      sites: {
        visible: ['name', 'region'], // 'region' isn't in defaults.visible
        seen: ['name', 'status', 'region'],
        sortKey: 'name',
        sortDir: 1,
        filters: {},
      },
    };
    const { result } = renderHook(() => usePersistentListState(
      'sites',
      { visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1 },
      new Set(['name', 'status', 'region']), // the full offered set includes it
    ));
    expect(Array.from(result.current.visibleCols)).toEqual(['name', 'region']);
  });

  it('still strips a stored column absent from allKeys', () => {
    auth.preferences.list_prefs = {
      sites: {
        visible: ['name', 'ghost'],
        seen: ['name', 'status'],
        sortKey: 'name',
        sortDir: 1,
        filters: {},
      },
    };
    const { result } = renderHook(() => usePersistentListState(
      'sites',
      { visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1 },
      new Set(['name', 'status', 'region']),
    ));
    expect(Array.from(result.current.visibleCols)).toEqual(['name']);
  });

  it("runs the page's `migrate` on the stored entry BEFORE sanitizing it", () => {
    auth.preferences.list_prefs = {
      sites: {
        visible: ['name'],
        seen: ['name', 'status', 'region'], // 'region' counts as seen, so no surfacing
        sortKey: 'name',
        sortDir: 1,
        filters: {},
      },
    };
    const seenByMigrate: unknown[] = [];
    const { result } = renderHook(() => usePersistentListState(
      'sites',
      {
        visible: new Set(['name', 'status']),
        sortKey: 'name',
        sortDir: 1,
        migrate: (stored) => {
          seenByMigrate.push(stored.visible);
          // 'ghost' is not a known column: it survives migrate but must not
          // survive sanitize, which proves the order of the two steps.
          return { ...stored, visible: [...(stored.visible as string[]), 'region', 'ghost'] };
        },
      },
      new Set(['name', 'status', 'region']),
    ));
    expect(Array.from(result.current.visibleCols)).toEqual(['name', 'region']);
    expect(seenByMigrate[0]).toEqual(['name']); // migrate saw the raw stored entry
  });

  it('falls back to the default sortKey when the stored sortKey is not in allKeys', () => {
    auth.preferences.list_prefs = {
      sites: {
        visible: ['name'],
        sortKey: 'ghost',
        sortDir: -1,
        filters: {},
      },
    };
    const { result } = renderHook(() => usePersistentListState(
      'sites',
      { visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1 },
      new Set(['name', 'status', 'region']),
    ));
    expect(result.current.sortKey).toBe('name');
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
      filters: { status: { values: ['active'] } }, order: [], seen: ['name', 'status'],
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
      visible: ['status'], sortKey: 'status', sortDir: -1, filters: {}, order: [], seen: ['name', 'status'],
    });
  });

  it('flushes a still-pending debounced save on unmount instead of losing it', () => {
    const { result, unmount } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1,
    }));

    act(() => { result.current.setFilter('status', { values: ['active'] }); });
    act(() => { vi.advanceTimersByTime(300); }); // still inside the 600ms debounce window
    unmount();

    expect(auth.updatePreferences).toHaveBeenCalledTimes(1);
    const saved = auth.updatePreferences.mock.calls[0][0] as UiPreferences;
    expect(saved.list_prefs.sites).toEqual({
      visible: ['name', 'status'], sortKey: 'name', sortDir: 1,
      filters: { status: { values: ['active'] } }, order: [], seen: ['name', 'status'],
    });

    // The cancelled timer must not also fire later.
    act(() => { vi.advanceTimersByTime(1000); });
    expect(auth.updatePreferences).toHaveBeenCalledTimes(1);
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

  it('hydrates order from stored prefs, dropping unknown keys and junk', () => {
    auth.preferences.list_prefs = {
      sites: { order: ['site', 'ghost', 42, 'name'] },
    };
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'site']), sortKey: 'name', sortDir: 1,
    }));
    expect(result.current.colOrder).toEqual(['site', 'name']);
  });

  it('dedupes a stored order, keeping the first occurrence of each key', () => {
    auth.preferences.list_prefs = {
      sites: { order: ['site', 'site', 'name'] },
    };
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'site']), sortKey: 'name', sortDir: 1,
    }));
    expect(result.current.colOrder).toEqual(['site', 'name']);
  });

  it('hydrates an empty order when none is stored', () => {
    auth.preferences.list_prefs = { sites: { visible: ['name'] } };
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'site']), sortKey: 'name', sortDir: 1,
    }));
    expect(result.current.colOrder).toEqual([]);
  });

  it('saves order changes through the debounced merge-save', () => {
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'site']), sortKey: 'name', sortDir: 1,
    }));
    act(() => { result.current.setColOrder(['site', 'name']); });
    act(() => { vi.advanceTimersByTime(600); });
    expect(auth.updatePreferences).toHaveBeenCalledTimes(1);
    const saved = auth.updatePreferences.mock.calls[0][0] as UiPreferences;
    expect((saved.list_prefs.sites as { order?: string[] }).order).toEqual(['site', 'name']);
  });
});

describe('sanitize surfaces default columns the user never saw', () => {
  const known = new Set(['primary', 'asset_id', 'model', 'status']);
  const defaults = { visible: new Set(['asset_id', 'model', 'status']), sortKey: 'primary', sortDir: 1 as const };

  it('adds a new default column to an old entry that predates `seen`', () => {
    const out = sanitize({ visible: ['model', 'status'], order: ['model', 'status'] }, known, defaults);
    expect(out.visible.has('asset_id')).toBe(true);
    expect(out.visible.has('model')).toBe(true);
  });

  it('keeps a default column hidden when the entry records having seen it', () => {
    const out = sanitize({ visible: ['model'], seen: ['primary', 'asset_id', 'model', 'status'] }, known, defaults);
    expect(out.visible.has('asset_id')).toBe(false);
    expect(out.visible.has('status')).toBe(false);
  });

  it('treats an old entry\'s ordered-but-hidden column as deliberately hidden', () => {
    const out = sanitize({ visible: ['model'], order: ['status', 'model'] }, known, defaults);
    expect(out.visible.has('status')).toBe(false);
    expect(out.visible.has('asset_id')).toBe(true);
  });

  it('never mutates the page defaults set', () => {
    sanitize({ visible: ['model'] }, known, defaults);
    expect(defaults.visible.has('primary')).toBe(false);
    expect([...defaults.visible]).toEqual(['asset_id', 'model', 'status']);
  });
});
