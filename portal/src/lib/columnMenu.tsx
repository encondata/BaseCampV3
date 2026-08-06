/**
 * Excel-style per-column header menus: sort (A→Z / Z→A), a type-to-filter
 * text box, and a unique-value checkbox multi-select that narrows live as
 * you type. Replaces the toolbar-level FilterButton one page at a time —
 * Task 6 removes FilterButton once every list page has adopted this.
 *
 * `ColumnFilter`/`ColumnFilters`/`activeFilterCount` live in lib/listTools.tsx
 * (next to their toolbar-chip cousin, facetCount) and are re-exported here so
 * every consumer of the column-menu mechanism can import from one module.
 *
 * Persistence (`usePersistentListState`) piggybacks on the existing
 * account-wide preferences PATCH (see auth/AuthContext's updatePreferences,
 * lib/api.ts's savePreferencesRequest) — there is no new endpoint. It reads
 * and writes `preferences.list_prefs[pageKey]`, merging so a save from one
 * page's list state never touches another page's entry or any other
 * preference field.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import { naturalCompare } from './sites';
import {
  activeFilterCount,
  type ColumnFilter,
  type ColumnFilters,
} from './listTools';
import '../styles/column-menu.css';

export type { ColumnFilter, ColumnFilters };
export { activeFilterCount };

/** Reads one row's display text for a given column key. Pages reuse their
 *  existing facet/search accessors here — the same string that feeds the
 *  global search box and the (now-retired) facet filters. */
export type CellText<T> = (row: T, colKey: string) => string;

const BLANK_DISPLAY = '—'; // '—'

function displayOf(cell: string): string {
  return cell === '' ? BLANK_DISPLAY : cell;
}

/** Does this row pass every active column filter? A column with both a
 *  typed substring and an explicit value selection must satisfy both
 *  (AND) — the selection is usually a subset of the substring matches
 *  anyway, so in practice this is just the value check, but a filter
 *  restored from prefs before its checklist has ever been narrowed only
 *  carries `text`, and that alone must still filter rows. */
export function passesColumnFilters<T>(
  row: T, filters: ColumnFilters, text: CellText<T>,
): boolean {
  for (const [colKey, f] of Object.entries(filters)) {
    const cell = text(row, colKey);
    if (f.text && !cell.toLowerCase().includes(f.text.toLowerCase())) return false;
    if (f.values && f.values.length && !f.values.includes(displayOf(cell))) return false;
  }
  return true;
}

/** Rows to compute a column's checklist/uniqueValues from — Excel's own
 *  cross-filter rule: every OTHER column's active filter narrows the list
 *  (so opening the Site menu only offers sites among rows that already
 *  pass the Status filter), but the column's OWN filter is excluded (so a
 *  value the user already checked stays visible/uncheckable instead of
 *  vanishing once it's the only thing left selected). */
export function rowsForMenu<T>(
  rows: T[], filters: ColumnFilters, colKey: string, text: CellText<T>,
): T[] {
  const others: ColumnFilters = {};
  for (const [key, f] of Object.entries(filters)) {
    if (key !== colKey) others[key] = f;
  }
  return rows.filter((row) => passesColumnFilters(row, others, text));
}

/** Sorted (naturalCompare), deduped display values for a column — blanks
 *  collapse to '—' so an empty cell gets one checkbox, not a blank row. */
export function uniqueValues<T>(rows: T[], colKey: string, text: CellText<T>): string[] {
  const set = new Set<string>();
  for (const row of rows) set.add(displayOf(text(row, colKey)));
  return Array.from(set).sort(naturalCompare);
}

const CHECK = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4"
       strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
);

export function ColumnMenu<T>({
  colKey, label, rows, text, filter, onFilter, sortDir, onSort,
}: {
  colKey: string;
  label: string;
  rows: T[];
  text: CellText<T>;
  filter: ColumnFilter | undefined;
  onFilter: (colKey: string, f: ColumnFilter | null) => void;
  sortDir: 1 | -1 | null;
  onSort: (dir: 1 | -1) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Both fully local, and the only source read when committing a change —
  // never re-derived from the `filter` prop mid-edit. A parent typically
  // re-renders with an updated `filter` after every onFilter call, but
  // nothing guarantees that happens before the next interaction (e.g. two
  // edits in the same tick), so committing off a possibly-stale prop would
  // silently drop whichever half of the filter the prop hadn't caught up
  // to yet.
  const [typed, setTyped] = useState(filter?.text ?? '');
  const [localValues, setLocalValues] = useState(filter?.values);
  const ref = useRef<HTMLDivElement>(null);

  // Close on an outside click, same pattern as listTools' useOutsideClose.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  // Re-seed local edit state each time the menu opens, so it reflects the
  // live filter (e.g. after "Clear all filters" elsewhere) rather than
  // whatever was last edited in a previous session with this menu open.
  useEffect(() => {
    if (open) {
      setTyped(filter?.text ?? '');
      setLocalValues(filter?.values);
    }
    // Intentionally NOT reactive to `filter` while open — the menu owns its
    // own edit state during an editing session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Only pay for uniqueValues while the popover is actually open.
  const allValues = useMemo(
    () => (open ? uniqueValues(rows, colKey, text) : []),
    [open, rows, colKey, text],
  );
  const narrowed = useMemo(() => {
    if (!typed) return allValues;
    const needle = typed.toLowerCase();
    return allValues.filter((v) => v.toLowerCase().includes(needle));
  }, [allValues, typed]);

  const isChecked = (v: string) => !localValues || localValues.includes(v);
  const isFiltered = Boolean(filter?.text || (filter?.values && filter.values.length > 0));

  function commit(nextText: string, nextValues: string[] | undefined) {
    const next: ColumnFilter = {};
    if (nextText.trim()) next.text = nextText;
    if (nextValues && nextValues.length) next.values = nextValues;
    onFilter(colKey, next.text || next.values ? next : null);
  }

  function applyValues(values: string[]) {
    setLocalValues(values);
    commit(typed, values);
  }

  function toggleValue(v: string) {
    const base = localValues ?? allValues;
    const next = base.includes(v) ? base.filter((x) => x !== v) : [...base, v];
    applyValues(next);
  }

  function onTypeFilter(next: string) {
    setTyped(next);
    commit(next, localValues);
  }

  function clearFilter() {
    setTyped('');
    setLocalValues(undefined);
    onFilter(colKey, null);
  }

  return (
    <div className="pop-wrap colmenu" ref={ref}>
      <button
        type="button"
        className={`colmenu-trigger ${isFiltered ? 'filtered' : ''}`}
        aria-label={`${label} column menu`}
        aria-pressed={isFiltered}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="pop-menu colmenu-menu">
          <div className="colmenu-sort">
            <button type="button" className={`pop-item ${sortDir === 1 ? 'on' : ''}`}
                    onClick={() => onSort(1)}>
              A → Z
            </button>
            <button type="button" className={`pop-item ${sortDir === -1 ? 'on' : ''}`}
                    onClick={() => onSort(-1)}>
              Z → A
            </button>
          </div>
          <div className="pop-sep" />
          <input
            className="colmenu-search"
            type="text"
            placeholder={`Filter ${label}`}
            value={typed}
            onChange={(e) => onTypeFilter(e.target.value)}
          />
          <div className="colmenu-list">
            {narrowed.length === 0 && <div className="pop-empty">No matches</div>}
            {narrowed.map((v) => (
              <button key={v} type="button" className={`pop-item ${isChecked(v) ? 'on' : ''}`}
                      onClick={() => toggleValue(v)}>
                <span className="pop-check">{CHECK}</span>
                {v}
              </button>
            ))}
          </div>
          <div className="pop-sep" />
          <div className="colmenu-actions">
            <button type="button" className="pop-item" onClick={() => applyValues(narrowed)}>
              Select all
            </button>
            <button type="button" className="pop-item" onClick={clearFilter}>
              Clear filter
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Toolbar chip: active-filter count with one-click Clear. Renders nothing
 *  when no column filter is active. */
export function FilterSummaryChip({ filters, onClear }: {
  filters: ColumnFilters;
  onClear: () => void;
}): JSX.Element | null {
  const count = activeFilterCount(filters);
  if (count === 0) return null;
  return (
    <button type="button" className="btn-ghost colfilter-chip" onClick={onClear}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 3H2l8 9.5V19l4 2v-8.5z" />
      </svg>
      {count} filter{count === 1 ? '' : 's'} active
      <span className="colfilter-clear">Clear</span>
    </button>
  );
}

/** Zero-results empty state's "Clear all filters" escape hatch — required
 *  whenever column filters (not the global search box) are why the list
 *  is empty. Renders nothing when no column filter is active. */
export function EmptyClearFilters({ filters, onClear }: {
  filters: ColumnFilters;
  onClear: () => void;
}): JSX.Element | null {
  if (activeFilterCount(filters) === 0) return null;
  return (
    <div className="colfilter-empty">
      <p>No rows match the current filters.</p>
      <button type="button" className="btn-ghost" onClick={onClear}>Clear all filters</button>
    </div>
  );
}

export interface PersistentListDefaults {
  visible: Set<string>;
  sortKey: string;
  sortDir: 1 | -1;
}

interface StoredListPrefs {
  visible?: unknown;
  sortKey?: unknown;
  sortDir?: unknown;
  filters?: unknown;
}

const SAVE_DEBOUNCE_MS = 600;

/** Sanitize one page's stored list_prefs entry against the columns the page
 *  currently knows about (`known` — every column the page can offer, not
 *  just the default-visible ones; callers without a fuller set fall back to
 *  `defaults.visible`). A column dropped from the codebase, or a stale/
 *  malformed value written by an older shape, never survives hydration. */
function sanitize(
  stored: StoredListPrefs, known: Set<string>, defaults: PersistentListDefaults,
): { visible: Set<string>; sortKey: string; sortDir: 1 | -1; filters: ColumnFilters } {
  let visible = defaults.visible;
  if (Array.isArray(stored.visible)) {
    const kept = stored.visible.filter(
      (k): k is string => typeof k === 'string' && known.has(k),
    );
    if (kept.length) visible = new Set(kept);
  }

  let sortKey = defaults.sortKey;
  if (typeof stored.sortKey === 'string' && known.has(stored.sortKey)) {
    sortKey = stored.sortKey;
  }

  let sortDir = defaults.sortDir;
  if (stored.sortDir === 1 || stored.sortDir === -1) sortDir = stored.sortDir;

  const filters: ColumnFilters = {};
  if (stored.filters && typeof stored.filters === 'object') {
    for (const [colKey, raw] of Object.entries(stored.filters as Record<string, unknown>)) {
      if (!known.has(colKey) || !raw || typeof raw !== 'object') continue;
      const f = raw as ColumnFilter;
      const clean: ColumnFilter = {};
      if (typeof f.text === 'string' && f.text) clean.text = f.text;
      if (Array.isArray(f.values)) {
        const values = f.values.filter((v): v is string => typeof v === 'string');
        if (values.length) clean.values = values;
      }
      if (clean.text || clean.values) filters[colKey] = clean;
    }
  }

  return { visible, sortKey, sortDir, filters };
}

/** Per-page persistent list state: visible columns, sort, and column
 *  filters. Hydrates once from the account's saved preferences on mount,
 *  then debounces (600ms) a save of every subsequent change — merged onto
 *  the current preferences so no other page's entry, and no other
 *  preference field, is ever clobbered.
 *
 *  `allKeys` is every column the page can offer — including non-default
 *  and god-only columns a user may have made visible or filtered/sorted by.
 *  Sanitization checks stored values against `allKeys` (falling back to
 *  `defaults.visible` when the caller doesn't pass it), so a persisted
 *  column that isn't part of the default set still survives rehydrate;
 *  only a column absent from the full offered set is stripped. */
export function usePersistentListState(
  pageKey: string, defaults: PersistentListDefaults, allKeys?: Set<string>,
) {
  const { preferences, updatePreferences } = useAuth();
  const known = allKeys ?? defaults.visible;

  // Hydrate synchronously via the lazy initializer — it runs exactly once,
  // during the first render, so the mounted state is already the hydrated
  // state. (Hydrating in a useEffect instead would mean an extra render +
  // effect pass between "mounted with defaults" and "hydrated", and the
  // debounced-save effect below would see that as a real change and fire
  // an unwanted save right after mount.)
  const [visibleCols, setVisibleColsState] = useState<Set<string>>(() => {
    const stored = preferences.list_prefs?.[pageKey];
    if (!stored || typeof stored !== 'object') return defaults.visible;
    return sanitize(stored as StoredListPrefs, known, defaults).visible;
  });
  const [sort, setSortState] = useState<{ key: string; dir: 1 | -1 }>(() => {
    const stored = preferences.list_prefs?.[pageKey];
    if (!stored || typeof stored !== 'object') return { key: defaults.sortKey, dir: defaults.sortDir };
    const s = sanitize(stored as StoredListPrefs, known, defaults);
    return { key: s.sortKey, dir: s.sortDir };
  });
  const [filters, setFiltersState] = useState<ColumnFilters>(() => {
    const stored = preferences.list_prefs?.[pageKey];
    if (!stored || typeof stored !== 'object') return {};
    return sanitize(stored as StoredListPrefs, known, defaults).filters;
  });

  // Latest preferences, read (not depended-on) by the debounced save so a
  // change elsewhere (e.g. a Settings-page save) between scheduling and
  // firing still gets merged onto correctly, without resetting our timer.
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;

  // Holds the not-yet-fired save (its timer + the payload-builder to run
  // early) so a separate unmount-only effect below can flush it. Cleared
  // once the save actually fires (normally or flushed).
  const pendingSaveRef = useRef<{ timer: ReturnType<typeof setTimeout>; save: () => void } | null>(null);

  const skipNextSave = useRef(true); // the mount-time (already-hydrated) state must not itself trigger a save
  useEffect(() => {
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    const save = () => {
      const current = prefsRef.current;
      void updatePreferences({
        ...current,
        list_prefs: {
          ...current.list_prefs,
          [pageKey]: {
            visible: Array.from(visibleCols),
            sortKey: sort.key,
            sortDir: sort.dir,
            filters,
          },
        },
      });
    };
    const timer = setTimeout(() => {
      pendingSaveRef.current = null;
      save();
    }, SAVE_DEBOUNCE_MS);
    pendingSaveRef.current = { timer, save };
    // Only cancels the timer — on a real dependency change the effect body
    // above immediately replaces pendingSaveRef with the new timer/save, so
    // there's nothing to flush here. The unmount-only effect below is what
    // flushes a save that's still pending when the component goes away.
    return () => clearTimeout(timer);
  }, [pageKey, updatePreferences, visibleCols, sort, filters]);

  // Runs its cleanup exactly once, on unmount (empty deps) — never on a
  // dependency change — so a debounced save still pending at navigation
  // time (an edit made <600ms earlier) fires immediately instead of being
  // silently dropped when the timer above gets cleared.
  useEffect(() => () => {
    if (pendingSaveRef.current) {
      clearTimeout(pendingSaveRef.current.timer);
      pendingSaveRef.current.save();
      pendingSaveRef.current = null;
    }
  }, []);

  const setVisibleCols = useCallback((next: Set<string>) => {
    setVisibleColsState(next);
  }, []);

  const setSort = useCallback((key: string, dir: 1 | -1) => {
    setSortState({ key, dir });
  }, []);

  const toggleSort = useCallback((key: string) => {
    setSortState((prev) => (
      prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }
    ));
  }, []);

  const setFilter = useCallback((colKey: string, f: ColumnFilter | null) => {
    setFiltersState((prev) => {
      const isBlank = !f || (!f.text && !(f.values && f.values.length));
      if (isBlank) {
        if (!(colKey in prev)) return prev;
        const next = { ...prev };
        delete next[colKey];
        return next;
      }
      return { ...prev, [colKey]: f };
    });
  }, []);

  const clearFilters = useCallback(() => setFiltersState({}), []);

  return {
    visibleCols, setVisibleCols,
    sortKey: sort.key, sortDir: sort.dir, setSort, toggleSort,
    filters, setFilter, clearFilters,
  };
}
