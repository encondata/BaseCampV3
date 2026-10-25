// @vitest-environment jsdom
/**
 * lib/columnMenu.tsx: the pure matcher/uniqueValues/count helpers, the
 * persistence hook's hydrate→change→debounced-save lifecycle (including
 * unknown-column sanitization and the never-clobber merge), and the
 * <ColumnMenu> popover's checklist-narrowing + Select-all behavior.
 */

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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
  type ColumnValue,
  type ColumnValuesSource,
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
    motion: true, nav_mode: 'expanded' as const, nav_bg: 'default', nav_size: 'default' as const, list_view: 'expanded' as const,
    notif: { sound: 'chime', categories: { approvals: 'email', reports: 'email', wiki: 'email', security: 'email' } },
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

describe('passesColumnFilters exclude', () => {
  it('drops rows whose displayed value is excluded, with the em dash standing for blanks', () => {
    const f: ColumnFilters = { name: { exclude: ['Alpha', 'Bravo'] } };
    expect(rows.filter((r) => passesColumnFilters(r, f, text)).map((r) => r.id)).toEqual(['3', '4']);
    const blanks: ColumnFilters = { site: { exclude: ['—'] } };
    expect(rows.filter((r) => passesColumnFilters(r, blanks, text)).map((r) => r.id))
      .toEqual(['1', '2', '3']);
  });

  it('AND-combines with a text filter, and an empty exclude filters nothing', () => {
    const f: ColumnFilters = { name: { text: 'a', exclude: ['Alpha'] } };
    expect(rows.filter((r) => passesColumnFilters(r, f, text)).map((r) => r.id))
      .toEqual(['2', '3', '4']);
    expect(rows.every((r) => passesColumnFilters(r, { name: { exclude: [] } }, text))).toBe(true);
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
  const originalInnerHeight = window.innerHeight;
  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  });

  it('portals into the trigger\'s .portal-shell (themed), else document.body', async () => {
    const user = userEvent.setup();
    const props = {
      colKey: 'site', label: 'Site', allRows: rows, filters: {}, text,
      filter: undefined, onFilter: vi.fn(), sortDir: null, onSort: vi.fn(),
    } as const;
    const { container, unmount } = render(
      <div className="portal-shell"><ColumnMenu {...props} /></div>,
    );
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    expect(document.querySelector('.colmenu-menu')!.parentElement)
      .toBe(container.querySelector('.portal-shell'));
    unmount();

    render(<ColumnMenu {...props} />);
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    expect(document.querySelector('.colmenu-menu')!.parentElement).toBe(document.body);
  });

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

  it('opens upward when the trigger is near the bottom of the viewport', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ColumnMenu colKey="name" label="Name" allRows={rows} filters={{}} text={text}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    const wrap = container.querySelector('.colmenu') as HTMLElement;
    const rect = (top: number, bottom: number, left: number, right: number) =>
      ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} }) as DOMRect;
    const wrapRect = vi.spyOn(wrap, 'getBoundingClientRect');

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

    const trigger = screen.getByRole('button', { name: 'Name column menu' });

    // spaceBelow 900 - 870 = 30 < 388 (MENU_MAX_HEIGHT + MENU_GAP) and
    // spaceAbove 850 > spaceBelow 30: opens upward.
    wrapRect.mockReturnValue(rect(850, 870, 200, 260));
    await user.click(trigger);
    let menu = document.querySelector('.colmenu-menu') as HTMLElement;
    expect(menu.style.top).toBe('auto');
    expect(menu.style.bottom).toBe('58px'); // 900 - 850 + 8

    await user.click(trigger); // close
    expect(document.querySelector('.colmenu-menu')).toBeNull();

    // spaceBelow 900 - 120 = 780 >= 388: opens downward.
    wrapRect.mockReturnValue(rect(100, 120, 200, 260));
    await user.click(trigger);
    menu = document.querySelector('.colmenu-menu') as HTMLElement;
    expect(menu.style.top).toBe('128px'); // 120 + 8
    expect(menu.style.bottom).toBe('auto');
  });

  it('caps the menu height to the space on the chosen side', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ColumnMenu colKey="name" label="Name" allRows={rows} filters={{}} text={text}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    const wrap = container.querySelector('.colmenu') as HTMLElement;
    const rect = (top: number, bottom: number, left: number, right: number) =>
      ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} }) as DOMRect;
    const wrapRect = vi.spyOn(wrap, 'getBoundingClientRect');

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

    const trigger = screen.getByRole('button', { name: 'Name column menu' });

    // spaceBelow 900 - 420 = 480 >= 388: opens downward, capped to
    // 480 - 2*8 = 464.
    wrapRect.mockReturnValue(rect(400, 420, 200, 260));
    await user.click(trigger);
    const menu = document.querySelector('.colmenu-menu') as HTMLElement;
    expect(menu.style.maxHeight).toBe('464px');
  });

  it('Escape closes the menu', async () => {
    const user = userEvent.setup();
    render(
      <ColumnMenu colKey="name" label="Name" allRows={rows} filters={{}} text={text}
                  filter={undefined} onFilter={vi.fn()} sortDir={null} onSort={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'Name column menu' }));
    expect(document.querySelector('.colmenu-menu')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.colmenu-menu')).toBeNull();
  });
});

/* ── usePersistentListState ───────────────────────────────────────── */

describe('usePersistentListState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    auth.preferences = {
      accent: 'amber', theme: 'light', density: 'comfortable', list_size: 'default', motion: true,
      nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
      notif: { sound: 'chime', categories: { approvals: 'email', reports: 'email', wiki: 'email', security: 'email' } },
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

  it('keeps an exclude filter through setFilter and sanitize, never alongside values', () => {
    const { result } = renderHook(() => usePersistentListState('sites', {
      visible: new Set(['name', 'status']), sortKey: 'name', sortDir: 1,
    }));
    act(() => { result.current.setFilter('status', { exclude: ['active'] }); });
    expect(result.current.filters).toEqual({ status: { exclude: ['active'] } });
    const known = new Set(['name', 'status']);
    const defaults = { visible: new Set(['name']), sortKey: 'name', sortDir: 1 as const };
    expect(sanitize({ filters: { status: { exclude: ['a', 5, 'b'] } } }, known, defaults).filters)
      .toEqual({ status: { exclude: ['a', 'b'] } });
    expect(sanitize({ filters: { status: { values: ['a'], exclude: ['b'] } } }, known, defaults).filters)
      .toEqual({ status: { values: ['a'] } });
    expect(sanitize({ filters: { status: { exclude: [] } } }, known, defaults).filters).toEqual({});
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

/* ── ColumnMenu with a server-backed values source ────────────────── */

describe('ColumnMenu with a valuesSource', () => {
  const noop = { onFilter: vi.fn(), onSort: vi.fn(), sortDir: null, filters: {} } as const;

  function deferredValues() {
    let resolve!: (v: ColumnValue[]) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<ColumnValue[]>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('does not call the source until the menu opens, then shows a loading state and the values with counts', async () => {
    const user = userEvent.setup();
    const d = deferredValues();
    const source = vi.fn<ColumnValuesSource>(() => d.promise);
    render(<ColumnMenu colKey="site" label="Site" valuesSource={source} filter={undefined} {...noop} />);
    expect(source).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    expect(source).toHaveBeenCalledTimes(1);
    expect(source.mock.calls[0][0].search).toBe('');
    expect(source.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText('Loading…')).toBeDefined();

    await act(async () => { d.resolve([{ value: 'DA1', count: 1200 }, { value: '—', count: 3 }]); });
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText('DA1')).toBeDefined();
    expect(screen.getByText('1,200')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });

  it('shows the display label but sends the raw value in the filter', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    const source = vi.fn<ColumnValuesSource>(async () => [
      { value: '0000AB12', count: 2 }, { value: 'XYZ', count: 1 },
    ]);
    render(
      <ColumnMenu colKey="primary" label="Value" valuesSource={source}
                  displayValue={(v) => v.replace(/^0+/, '')}
                  filter={undefined} {...noop} onFilter={onFilter} />,
    );
    await user.click(screen.getByRole('button', { name: 'Value column menu' }));
    await screen.findByText('AB12');
    expect(screen.queryByText('0000AB12')).toBeNull();

    await user.click(screen.getByText('AB12')); // uncheck it
    expect(onFilter).toHaveBeenLastCalledWith('primary', { exclude: ['0000AB12'] });
  });

  it('re-queries the source with the typed text after the debounce and aborts the superseded call', async () => {
    const user = userEvent.setup();
    const source = vi.fn<ColumnValuesSource>(async ({ search }) =>
      (search ? [{ value: 'DA10', count: 1 }] : [{ value: 'DA1', count: 1 }, { value: 'DA10', count: 1 }]));
    render(<ColumnMenu colKey="site" label="Site" valuesSource={source} filter={undefined} {...noop} />);
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await screen.findByText('DA1');
    const firstSignal = source.mock.calls[0][0].signal;

    await user.type(screen.getByPlaceholderText('Filter Site'), 'da10');
    await waitFor(() => expect(source).toHaveBeenCalledTimes(2));
    expect(source.mock.calls[1][0].search).toBe('da10');
    expect(firstSignal.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByText('DA1')).toBeNull());
    expect(screen.getByText('DA10')).toBeDefined();
  });

  it('seeds the first query with the filter\'s existing text', async () => {
    const user = userEvent.setup();
    const source = vi.fn<ColumnValuesSource>(async () => []);
    render(<ColumnMenu colKey="site" label="Site" valuesSource={source}
                       filter={{ text: 'da' }} {...noop} />);
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await waitFor(() => expect(source).toHaveBeenCalled());
    expect(source.mock.calls.every((c) => c[0].search === 'da')).toBe(true);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('shows an error line when the source fails and an empty line for no matches', async () => {
    const user = userEvent.setup();
    const source = vi.fn<ColumnValuesSource>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce([]);
    const { rerender } = render(
      <ColumnMenu colKey="site" label="Site" valuesSource={source} filter={undefined} {...noop} />,
    );
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await screen.findByText('Couldn’t load values');

    await user.click(screen.getByRole('button', { name: 'Site column menu' })); // close
    rerender(<ColumnMenu colKey="site" label="Site" valuesSource={source} filter={undefined} {...noop} />);
    await user.click(screen.getByRole('button', { name: 'Site column menu' })); // reopen
    await screen.findByText('No matches');
  });

  it('Select all drops the value selection instead of listing the loaded subset', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    const source = vi.fn<ColumnValuesSource>(async () => [{ value: 'DA1', count: 1 }, { value: 'DA2', count: 1 }]);
    render(<ColumnMenu colKey="site" label="Site" valuesSource={source}
                       filter={{ values: ['DA1'] }} {...noop} onFilter={onFilter} />);
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await screen.findByText('DA2');
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(onFilter).toHaveBeenLastCalledWith('site', null);
  });

  it('re-queries an open menu when another column\'s filter changes, but not on its own', async () => {
    const user = userEvent.setup();
    const source = vi.fn<ColumnValuesSource>(async () => [{ value: 'DA1', count: 1 }]);
    const props = { colKey: 'site', label: 'Site', valuesSource: source, onFilter: vi.fn(),
                    onSort: vi.fn(), sortDir: null } as const;
    const { rerender } = render(<ColumnMenu {...props} filters={{}} filter={undefined} />);
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await screen.findByText('DA1');
    expect(source).toHaveBeenCalledTimes(1);

    rerender(<ColumnMenu {...props} filters={{ site: { values: ['DA1'] } }} filter={{ values: ['DA1'] }} />);
    expect(source).toHaveBeenCalledTimes(1);

    rerender(<ColumnMenu {...props} filters={{ site: { values: ['DA1'] }, status: { text: 'x' } }}
                         filter={{ values: ['DA1'] }} />);
    await waitFor(() => expect(source).toHaveBeenCalledTimes(2));
  });

  it('a new source function identity on re-render does not re-query', async () => {
    const user = userEvent.setup();
    const calls: number[] = [];
    const make = () => vi.fn<ColumnValuesSource>(async () => { calls.push(1); return [{ value: 'A', count: 1 }]; });
    const props = { colKey: 'site', label: 'Site', filter: undefined, filters: {},
                    onFilter: vi.fn(), onSort: vi.fn(), sortDir: null } as const;
    const { rerender } = render(<ColumnMenu {...props} valuesSource={make()} />);
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await screen.findByText('A');
    rerender(<ColumnMenu {...props} valuesSource={make()} />);
    rerender(<ColumnMenu {...props} valuesSource={make()} />);
    expect(calls).toHaveLength(1);
  });

  it('unchecking from the implicit all-checked state adds the value to exclude, and re-checking removes it', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    const source = vi.fn<ColumnValuesSource>(async () => [
      { value: 'DA1', count: 3 }, { value: 'DA2', count: 2 }, { value: '—', count: 1 }]);
    const { rerender } = render(<ColumnMenu colKey="site" label="Site" valuesSource={source}
                       filter={undefined} {...noop} onFilter={onFilter} />);
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await screen.findByText('DA2');

    await user.click(screen.getByText('DA2'));
    expect(onFilter).toHaveBeenLastCalledWith('site', { exclude: ['DA2'] });
    expect(screen.getByText('DA2').closest('button')!.className).not.toContain('on');
    expect(screen.getByText('DA1').closest('button')!.className).toContain('on');

    await user.click(screen.getByText('—'));
    expect(onFilter).toHaveBeenLastCalledWith('site', { exclude: ['DA2', '—'] });

    await user.click(screen.getByText('DA2')); // re-check
    expect(onFilter).toHaveBeenLastCalledWith('site', { exclude: ['—'] });
    await user.click(screen.getByText('—'));
    expect(onFilter).toHaveBeenLastCalledWith('site', null);
    expect(screen.getByText('DA2').closest('button')!.className).toContain('on');
    rerender(<div />);
  });

  it('starts from an existing exclude filter and Select all clears it', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    const source = vi.fn<ColumnValuesSource>(async () => [
      { value: 'DA1', count: 3 }, { value: 'DA2', count: 2 }]);
    render(<ColumnMenu colKey="site" label="Site" valuesSource={source}
                       filter={{ exclude: ['DA1'] }} {...noop} onFilter={onFilter} />);
    expect(screen.getByRole('button', { name: 'Site column menu' }).className).toContain('filtered');
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await screen.findByText('DA2');
    expect(screen.getByText('DA1').closest('button')!.className).not.toContain('on');
    expect(screen.getByText('DA2').closest('button')!.className).toContain('on');

    await user.click(screen.getByText('DA2'));
    expect(onFilter).toHaveBeenLastCalledWith('site', { exclude: ['DA1', 'DA2'] });
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(onFilter).toHaveBeenLastCalledWith('site', null);
    expect(screen.getByText('DA1').closest('button')!.className).toContain('on');
  });

  it('from an include selection a toggle stays in include mode, never mixing in exclude', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    const source = vi.fn<ColumnValuesSource>(async () => [
      { value: 'DA1', count: 3 }, { value: 'DA2', count: 2 }, { value: 'DA3', count: 1 }]);
    render(<ColumnMenu colKey="site" label="Site" valuesSource={source}
                       filter={{ values: ['DA1', 'DA2'] }} {...noop} onFilter={onFilter} />);
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await screen.findByText('DA3');
    await user.click(screen.getByText('DA2'));   // uncheck
    expect(onFilter).toHaveBeenLastCalledWith('site', { values: ['DA1'] });
    await user.click(screen.getByText('DA3'));   // check
    expect(onFilter).toHaveBeenLastCalledWith('site', { values: ['DA1', 'DA3'] });
    for (const call of onFilter.mock.calls) expect(call[1]).not.toHaveProperty('exclude');
  });

  it('excludes by value when the list is capped at 500, instead of listing 499 loaded values', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    const many: ColumnValue[] = Array.from({ length: 500 }, (_, i) => ({ value: `V${i}`, count: 1 }));
    const source = vi.fn<ColumnValuesSource>(async () => many);
    render(<ColumnMenu colKey="primary" label="Value" valuesSource={source}
                       filter={undefined} {...noop} onFilter={onFilter} />);
    await user.click(screen.getByRole('button', { name: 'Value column menu' }));
    await screen.findByText('V499');
    await user.click(screen.getByText('V7'));
    expect(onFilter).toHaveBeenLastCalledWith('primary', { exclude: ['V7'] });
  });

  it('hints to type to narrow only when the list reached the 500 cap', async () => {
    const user = userEvent.setup();
    const many: ColumnValue[] = Array.from({ length: 500 }, (_, i) => ({ value: `V${i}`, count: 1 }));
    const source = vi.fn<ColumnValuesSource>()
      .mockResolvedValueOnce(many.slice(0, 499))
      .mockResolvedValueOnce(many);
    const props = { colKey: 'primary', label: 'Value', filter: undefined, ...noop } as const;
    const { rerender } = render(<ColumnMenu {...props} valuesSource={source} />);
    await user.click(screen.getByRole('button', { name: 'Value column menu' }));
    await screen.findByText('V498');
    expect(screen.queryByText('Top 500 shown — type to narrow')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Value column menu' })); // close
    rerender(<ColumnMenu {...props} valuesSource={source} />);
    await user.click(screen.getByRole('button', { name: 'Value column menu' })); // reopen
    await screen.findByText('Top 500 shown — type to narrow');
  });

  it('commits typed text to the filter only after a pause, once, with the latest text', async () => {
    vi.useFakeTimers();
    try {
      const onFilter = vi.fn();
      const source = vi.fn<ColumnValuesSource>(async () => [{ value: 'DA1', count: 1 }]);
      render(<ColumnMenu colKey="site" label="Site" valuesSource={source}
                         filter={undefined} {...noop} onFilter={onFilter} />);
      fireEvent.click(screen.getByRole('button', { name: 'Site column menu' }));
      const box = screen.getByPlaceholderText('Filter Site');
      fireEvent.change(box, { target: { value: 'd' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      fireEvent.change(box, { target: { value: 'da' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(onFilter).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(60); });
      expect(onFilter).toHaveBeenCalledTimes(1);
      expect(onFilter).toHaveBeenCalledWith('site', { text: 'da' });
    } finally { vi.useRealTimers(); }
  });

  it('flushes a pending text commit on Enter and on close, and drops it on unmount', async () => {
    vi.useFakeTimers();
    try {
      const onFilter = vi.fn();
      const source = vi.fn<ColumnValuesSource>(async () => []);
      const { unmount } = render(<ColumnMenu colKey="site" label="Site" valuesSource={source}
                         filter={undefined} {...noop} onFilter={onFilter} />);
      fireEvent.click(screen.getByRole('button', { name: 'Site column menu' }));
      const box = screen.getByPlaceholderText('Filter Site');

      fireEvent.change(box, { target: { value: 'da' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onFilter).toHaveBeenCalledTimes(1);
      expect(onFilter).toHaveBeenLastCalledWith('site', { text: 'da' });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(onFilter).toHaveBeenCalledTimes(1);   // the timer was cancelled by the flush

      fireEvent.change(box, { target: { value: 'dax' } });
      fireEvent.keyDown(document, { key: 'Escape' });   // close
      expect(onFilter).toHaveBeenCalledTimes(2);
      expect(onFilter).toHaveBeenLastCalledWith('site', { text: 'dax' });

      fireEvent.click(screen.getByRole('button', { name: 'Site column menu' }));
      fireEvent.change(screen.getByPlaceholderText('Filter Site'), { target: { value: 'gone' } });
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(onFilter).toHaveBeenCalledTimes(2);   // no commit after unmount
    } finally { vi.useRealTimers(); }
  });

  it('a value click commits the typed text immediately and cancels the pending commit', async () => {
    vi.useFakeTimers();
    try {
      const onFilter = vi.fn();
      const source = vi.fn<ColumnValuesSource>(async () => [{ value: 'DA1', count: 1 }]);
      render(<ColumnMenu colKey="site" label="Site" valuesSource={source}
                         filter={undefined} {...noop} onFilter={onFilter} />);
      fireEvent.click(screen.getByRole('button', { name: 'Site column menu' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.change(screen.getByPlaceholderText('Filter Site'), { target: { value: 'da' } });
      fireEvent.click(screen.getByText('DA1'));
      expect(onFilter).toHaveBeenCalledTimes(1);
      expect(onFilter).toHaveBeenLastCalledWith('site', { text: 'da', exclude: ['DA1'] });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(onFilter).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('the sync menu (no source) still commits each keystroke at once', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    render(<ColumnMenu colKey="name" label="Name" allRows={rows} text={text} filter={undefined}
                       {...noop} onFilter={onFilter} />);
    await user.click(screen.getByRole('button', { name: 'Name column menu' }));
    await user.type(screen.getByPlaceholderText('Filter Name'), 'al');
    expect(onFilter.mock.calls.map((c) => c[1])).toEqual([{ text: 'a' }, { text: 'al' }]);
    await user.click(screen.getByText('Alpha'));   // uncheck: include-list, never exclude
    expect(onFilter.mock.lastCall![1]).toEqual({ text: 'al', values: ['Bravo', 'Charlie', 'Delta'] });
  });

  it('re-queries an open menu when valuesKey changes (search, date range), not otherwise', async () => {
    const user = userEvent.setup();
    const source = vi.fn<ColumnValuesSource>(async () => [{ value: 'DA1', count: 1 }]);
    const props = { colKey: 'site', label: 'Site', valuesSource: source, onFilter: vi.fn(),
                    onSort: vi.fn(), sortDir: null, filters: {}, filter: undefined } as const;
    const { rerender } = render(<ColumnMenu {...props} valuesKey="q=a" />);
    await user.click(screen.getByRole('button', { name: 'Site column menu' }));
    await screen.findByText('DA1');
    expect(source).toHaveBeenCalledTimes(1);
    rerender(<ColumnMenu {...props} valuesKey="q=a" />);
    expect(source).toHaveBeenCalledTimes(1);
    rerender(<ColumnMenu {...props} valuesKey="q=ab" />);
    await waitFor(() => expect(source).toHaveBeenCalledTimes(2));
  });
});
