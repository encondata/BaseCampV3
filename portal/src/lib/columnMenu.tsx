/**
 * Excel-style per-column header menus: sort (A→Z / Z→A), a type-to-filter
 * text box, and a unique-value checkbox multi-select that narrows live as
 * you type. Replaces the toolbar-level FilterButton one page at a time;
 * FilterButton itself stays in lib/listTools.tsx for its three remaining
 * consumers (ActivityHistory, MembersTab, Variables) that haven't adopted
 * column menus.
 *
 * `ColumnFilter`/`ColumnFilters`/`activeFilterCount` live in lib/listTools.tsx
 * and are re-exported here so every consumer of the column-menu mechanism
 * can import from one module.
 *
 * Persistence (`usePersistentListState`) piggybacks on the existing
 * account-wide preferences PATCH (see auth/AuthContext's updatePreferences,
 * lib/api.ts's savePreferencesRequest) — there is no new endpoint. It reads
 * and writes `preferences.list_prefs[pageKey]`, merging so a save from one
 * page's list state never touches another page's entry or any other
 * preference field.
 *
 * The open menu is portaled to the trigger's `.portal-shell` (else `document.body`;
 * fixed position from the trigger's rect) so a scrolling list card cannot clip it; see
 * RowActionsMenu for the same pattern.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useAuth } from '../auth/AuthContext';
import { naturalCompare } from './sites';
import {
  activeFilterCount,
  usePortaledMenu,
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
    if (f.exclude && f.exclude.length && f.exclude.includes(displayOf(cell))) return false;
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

/** One checklist entry from a server-backed values source. `value` is what the
 *  server filters on (sent in `ColumnFilter.values`); `count` is shown beside
 *  it. An empty cell is the value '—', like the sync checklist. */
export interface ColumnValue { value: string; count?: number }

/** Server-backed checklist source (e.g. a facets endpoint). Called when the
 *  menu opens and again, debounced, as the user types in the filter box
 *  (`search` is that text). Honor `signal`: a superseded call is aborted. */
export type ColumnValuesSource = (
  query: { search: string; signal: AbortSignal },
) => Promise<ColumnValue[]>;

/** Wait after the last keystroke before re-querying a values source, and
 *  before the typed text is committed as the column's filter (with a source). */
export const VALUES_SEARCH_DEBOUNCE_MS = 250;

/** A values source returns at most this many entries (the facets endpoint's
 *  cap); a full list means more exist, so the menu says to type to narrow. */
export const VALUES_SOURCE_CAP = 500;

type RemoteValues =
  | { status: 'loading'; items: ColumnValue[] }
  | { status: 'ready'; items: ColumnValue[] }
  | { status: 'error'; items: ColumnValue[] };

const CHECK = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4"
       strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
);

/** column-menu.css .colmenu-menu min-width — chrome.css's .pop-menu 230
 *  is overridden by source order, so this is the value that actually
 *  governs the element. */
const MENU_MIN_WIDTH = 220;
/** Worst-case menu height: column-menu.css's 2×8 padding + sort row +
 *  search + .colmenu-list max-height 220 + separators + actions row. */
const MENU_MAX_HEIGHT = 380;

/** An exclude list to start an editing session from (never alongside values). */
function seedExclude(filter: ColumnFilter | undefined): string[] | undefined {
  if (filter?.values && filter.values.length) return undefined;
  return filter?.exclude && filter.exclude.length ? filter.exclude : undefined;
}

export function ColumnMenu<T>({
  colKey, label, allRows, filters, text, valuesSource, valuesKey, displayValue,
  filter, onFilter, sortDir, onSort,
}: {
  colKey: string;
  label: string;
  /** The page's full unfiltered row set. `rowsForMenu` (cross-filter
   *  scoping) runs on this ONLY while the popover is open — see `allValues`
   *  below — so a page can pass its raw rows every render without paying
   *  O(rows×filters) per column on every keystroke/render. Unused (omit it)
   *  when `valuesSource` supplies the checklist. */
  allRows?: T[];
  /** The page's current column filters. With `valuesSource`, the other
   *  columns' filters decide when an open menu re-queries it. */
  filters: ColumnFilters;
  /** Reads a row's display text. Unused when `valuesSource` supplies the
   *  checklist. */
  text?: CellText<T>;
  /** Server-backed checklist (values + counts) in place of the one computed
   *  from `allRows`: loaded when the menu opens, re-queried as the user types.
   *  Read through a ref, so a fresh function identity each render is fine. */
  valuesSource?: ColumnValuesSource;
  /** With `valuesSource`: an opaque key for every other input that shapes the
   *  list (global search, date range, extra params). An open menu re-queries
   *  when it changes; the other columns' `filters` are tracked on their own. */
  valuesKey?: string;
  /** With `valuesSource`: how to show a raw value in the checklist, while the
   *  raw value is still what goes into the filter. */
  displayValue?: (value: string) => string;
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
  // With a source, "all checked except these" (see toggleValue). Mutually
  // exclusive with localValues.
  const [localExclude, setLocalExclude] = useState(seedExclude(filter));
  const { triggerRef: ref, menuRef, pos, host } = usePortaledMenu(
    open, () => setOpen(false), { width: MENU_MIN_WIDTH, height: MENU_MAX_HEIGHT });

  // ── server-backed checklist ──
  const [remote, setRemote] = useState<RemoteValues>({ status: 'loading', items: [] });
  // The text the source is queried with: `typed`, settled for a beat.
  const [querySearch, setQuerySearch] = useState('');
  const sourceRef = useRef(valuesSource);
  sourceRef.current = valuesSource;
  const remoteOn = Boolean(valuesSource);
  // Another column's filter changing is when an open menu's counts go stale.
  const othersKey = useMemo(() => {
    if (!remoteOn) return '';
    const others: ColumnFilters = {};
    for (const [key, f] of Object.entries(filters)) if (key !== colKey) others[key] = f;
    return JSON.stringify(others);
  }, [remoteOn, filters, colKey]);

  useEffect(() => {
    if (!open || !remoteOn) return;
    if (typed === querySearch) return;
    const timer = setTimeout(() => setQuerySearch(typed), VALUES_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, remoteOn, typed, querySearch]);

  useEffect(() => {
    const source = sourceRef.current;
    if (!open || !source) return;
    const controller = new AbortController();
    // Keep the previous entries on screen while a re-query runs.
    setRemote((prev) => ({ status: 'loading', items: prev.items }));
    source({ search: querySearch, signal: controller.signal })
      .then((items) => {
        if (!controller.signal.aborted) setRemote({ status: 'ready', items });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRemote({ status: 'error', items: [] });
      });
    return () => controller.abort();
  }, [open, remoteOn, querySearch, othersKey, valuesKey]);

  // With a source the typed text is committed as the filter after a pause,
  // like the list query; this holds that timer. commit() cancels it (it
  // commits the latest text itself), and a close flushes it.
  const pendingCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => void>(() => {});
  const cancelPendingCommit = () => {
    if (pendingCommit.current !== null) clearTimeout(pendingCommit.current);
    pendingCommit.current = null;
  };
  const flushPendingCommit = () => {
    if (pendingCommit.current === null) return;
    cancelPendingCommit();
    flushRef.current();
  };
  useEffect(() => { if (!open) flushPendingCommit(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => cancelPendingCommit, []); // eslint-disable-line react-hooks/exhaustive-deps

  function openMenu() {
    // Seed everything here, not in an effect, so the first query already
    // carries the filter's current text and never a stale one.
    setTyped(filter?.text ?? '');
    setLocalValues(filter?.values);
    setLocalExclude(seedExclude(filter));
    setQuerySearch(filter?.text ?? '');
    setRemote({ status: 'loading', items: [] });
    setOpen(true);
  }

  // Escape closes the menu, matching RowActionsMenu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Re-seed local edit state each time the menu opens, so it reflects the
  // live filter (e.g. after "Clear all filters" elsewhere) rather than
  // whatever was last edited in a previous session with this menu open.
  useEffect(() => {
    if (open) {
      setTyped(filter?.text ?? '');
      setLocalValues(filter?.values);
      setLocalExclude(seedExclude(filter));
    }
    // Intentionally NOT reactive to `filter` while open — the menu owns its
    // own edit state during an editing session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Only pay for rowsForMenu's cross-filter scan + uniqueValues while the
  // popover is actually open — closed columns (the common case: every
  // OTHER header on the page while one menu is open, and every header when
  // none are) never touch `allRows`.
  const allValues = useMemo(() => {
    if (!open) return [];
    if (remoteOn) return remote.items.map((i) => i.value);
    if (!allRows || !text) return [];
    return uniqueValues(rowsForMenu(allRows, filters, colKey, text), colKey, text);
  }, [open, remoteOn, remote, allRows, filters, colKey, text]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    if (remoteOn) for (const i of remote.items) if (i.count !== undefined) m.set(i.value, i.count);
    return m;
  }, [remoteOn, remote]);
  const narrowed = useMemo(() => {
    // The server already narrowed a remote list by the typed text.
    if (!typed || remoteOn) return allValues;
    const needle = typed.toLowerCase();
    return allValues.filter((v) => v.toLowerCase().includes(needle));
  }, [allValues, typed, remoteOn]);

  const isChecked = (v: string) => {
    if (remoteOn && localExclude) return !localExclude.includes(v);
    return !localValues || localValues.includes(v);
  };
  const isFiltered = Boolean(
    filter?.text || (filter?.values && filter.values.length > 0)
    || (filter?.exclude && filter.exclude.length > 0));

  function commit(nextText: string, nextValues: string[] | undefined,
                  nextExclude?: string[]) {
    cancelPendingCommit();
    const next: ColumnFilter = {};
    if (nextText.trim()) next.text = nextText;
    if (nextValues && nextValues.length) next.values = nextValues;
    else if (nextExclude && nextExclude.length) next.exclude = nextExclude;
    onFilter(colKey, next.text || next.values || next.exclude ? next : null);
  }
  flushRef.current = () => commit(typed, localValues, localExclude);

  function applyValues(values: string[]) {
    setLocalValues(values);
    commit(typed, values);
  }

  function selectAll() {
    // A server-backed list may be capped or narrowed by the typed text, so
    // "everything checked" is the absence of a value selection, not the
    // loaded subset.
    if (remoteOn) {
      setLocalValues(undefined);
      setLocalExclude(undefined);
      commit(typed, undefined);
    } else {
      applyValues(narrowed);
    }
  }

  function toggleValue(v: string) {
    if (remoteOn && !localValues) {
      // From "all checked" (or an exclude list) a toggle edits the exclude
      // list: listing the loaded values instead would drop every value past
      // the server's cap, and a long include list overflows the request URL.
      const base = localExclude ?? [];
      const next = base.includes(v) ? base.filter((x) => x !== v) : [...base, v];
      setLocalExclude(next.length ? next : undefined);
      commit(typed, undefined, next);
      return;
    }
    const base = localValues ?? allValues;
    const next = base.includes(v) ? base.filter((x) => x !== v) : [...base, v];
    applyValues(next);
  }

  function onTypeFilter(next: string) {
    setTyped(next);
    if (!remoteOn) {
      commit(next, localValues);
      return;
    }
    // Debounced: every commit re-filters (and re-fetches) the whole list.
    cancelPendingCommit();
    pendingCommit.current = setTimeout(() => {
      pendingCommit.current = null;
      commit(next, localValues, localExclude);
    }, VALUES_SEARCH_DEBOUNCE_MS);
  }

  function clearFilter() {
    cancelPendingCommit();
    setTyped('');
    setLocalValues(undefined);
    setLocalExclude(undefined);
    onFilter(colKey, null);
  }

  return (
    <div className="pop-wrap colmenu" ref={ref}>
      <button
        type="button"
        className={`colmenu-trigger ${isFiltered ? 'filtered' : ''}`}
        aria-label={`${label} column menu`}
        aria-pressed={isFiltered}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        {/* classic funnel, sized to read at header-text scale */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5z" />
        </svg>
      </button>
      {open && pos && host && createPortal(
        <div className="pop-menu colmenu-menu colmenu-portaled" ref={menuRef}
             style={{
               top: pos.top, left: pos.left, right: pos.right, bottom: pos.bottom,
               maxHeight: pos.maxHeight, overflowY: 'auto',
             }}>
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
            onKeyDown={(e) => { if (e.key === 'Enter') flushPendingCommit(); }}
          />
          <div className="colmenu-list" aria-busy={remoteOn && remote.status === 'loading'}>
            {remoteOn && remote.status === 'loading' && remote.items.length === 0 && (
              <div className="pop-empty">Loading…</div>
            )}
            {remoteOn && remote.status === 'error' && (
              <div className="pop-empty">Couldn’t load values</div>
            )}
            {narrowed.length === 0 && (!remoteOn || remote.status === 'ready') && (
              <div className="pop-empty">No matches</div>
            )}
            {remoteOn && remote.status === 'ready' && remote.items.length >= VALUES_SOURCE_CAP && (
              <div className="pop-empty">Top {VALUES_SOURCE_CAP} shown — type to narrow</div>
            )}
            {narrowed.map((v) => (
              <button key={v} type="button" className={`pop-item ${isChecked(v) ? 'on' : ''}`}
                      onClick={() => toggleValue(v)}>
                <span className="pop-check">{CHECK}</span>
                <span className="colmenu-value">{remoteOn && displayValue ? displayValue(v) : v}</span>
                {counts.has(v) && <span className="colmenu-count">{counts.get(v)!.toLocaleString()}</span>}
              </button>
            ))}
          </div>
          <div className="pop-sep" />
          <div className="colmenu-actions">
            <button type="button" className="pop-item" onClick={selectAll}>
              Select all
            </button>
            <button type="button" className="pop-item" onClick={clearFilter}>
              Clear filter
            </button>
          </div>
        </div>,
        host,
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
  /** Optional per-page rewrite of a stored entry, applied before any
   *  sanitization. For layouts saved under an older column vocabulary that
   *  sanitize's own rules can't repair — e.g. a key that used to be a
   *  pseudo-column and so could never appear in `visible`. Must be pure:
   *  it runs on every hydrating render, and its output still goes through
   *  the normal known-key filtering. */
  migrate?: (stored: StoredListPrefs) => StoredListPrefs;
}

export interface StoredListPrefs {
  visible?: unknown;
  sortKey?: unknown;
  sortDir?: unknown;
  filters?: unknown;
  order?: unknown;
  /** Every column key the page offered when this entry was saved. A default
   *  column that is NOT in `seen` is one the user never had the chance to
   *  hide — it is surfaced on hydrate, so a column added to the codebase
   *  after someone saved their layout still appears for them. */
  seen?: unknown;
}

const SAVE_DEBOUNCE_MS = 600;

/** Sanitize one page's stored list_prefs entry against the columns the page
 *  currently knows about (`known` — every column the page can offer, not
 *  just the default-visible ones; callers without a fuller set fall back to
 *  `defaults.visible`). A column dropped from the codebase, or a stale/
 *  malformed value written by an older shape, never survives hydration. */
export function sanitize(
  raw: StoredListPrefs, known: Set<string>, defaults: PersistentListDefaults,
): { visible: Set<string>; sortKey: string; sortDir: 1 | -1; filters: ColumnFilters; order: string[] } {
  // The page's own migration runs first, on the untouched stored entry, so
  // it can reason about the exact shape that was written; everything it
  // produces is then filtered against `known` like any stored value.
  const stored = defaults.migrate ? defaults.migrate(raw) : raw;

  let visible = defaults.visible;
  if (Array.isArray(stored.visible)) {
    const kept = stored.visible.filter(
      (k): k is string => typeof k === 'string' && known.has(k),
    );
    if (kept.length) visible = new Set(kept);
    // Surface default columns the user was never offered. Entries saved
    // before `seen` existed count their visible + ordered keys as seen —
    // a column the user arranged or kept is one they knew about; anything
    // else that is default-visible today is new to them.
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
    const seen = new Set(Array.isArray(stored.seen)
      ? strings(stored.seen)
      : [...kept, ...strings(stored.order)]);
    const surfaced = [...defaults.visible].filter((k) => known.has(k) && !seen.has(k));
    if (surfaced.length) visible = new Set([...visible, ...surfaced]);
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
      // A filter never carries both; an include list wins.
      if (!clean.values && Array.isArray(f.exclude)) {
        const exclude = f.exclude.filter((v): v is string => typeof v === 'string');
        if (exclude.length) clean.exclude = exclude;
      }
      if (clean.text || clean.values || clean.exclude) filters[colKey] = clean;
    }
  }

  let order: string[] = [];
  if (Array.isArray(stored.order)) {
    const kept = stored.order.filter((k): k is string => typeof k === 'string' && known.has(k));
    order = Array.from(new Set(kept)); // first occurrence wins — a duplicated key would render twice
  }

  return { visible, sortKey, sortDir, filters, order };
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

  // Display order for the page's columns. Empty = the page's default
  // (ColumnDef[] source order); applyColumnOrder treats it that way.
  const [colOrder, setColOrderState] = useState<string[]>(() => {
    const stored = preferences.list_prefs?.[pageKey];
    if (!stored || typeof stored !== 'object') return [];
    return sanitize(stored as StoredListPrefs, known, defaults).order;
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
            order: colOrder,
            seen: Array.from(known),
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
  }, [pageKey, updatePreferences, visibleCols, sort, filters, colOrder]);

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
      const isBlank = !f || (!f.text && !(f.values && f.values.length)
        && !(f.exclude && f.exclude.length));
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

  const setColOrder = useCallback((next: string[]) => {
    setColOrderState(next);
  }, []);

  return {
    visibleCols, setVisibleCols,
    sortKey: sort.key, sortDir: sort.dir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  };
}
