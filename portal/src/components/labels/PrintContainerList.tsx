/**
 * Print Labels › Step 4 for a container label type — the initiative's
 * containers as a selectable directory list. The container sibling of
 * `PrintAssetList`: same generic machinery (`ColumnMenu`, per-column
 * filters, `usePersistentListState`, `ColumnsButton`, `VirtualRows`, the
 * Ready / Missing segmented filter), different columns.
 *
 * Two deliberate differences from the asset list:
 *  - its own persisted prefs key. `PRINT_LIST_PAGE_KEY` ('labels-print')
 *    is a per-user, backend-persisted entry; sharing it would mean the two
 *    lists silently overwrote each other's column visibility, sort and
 *    filters, since their column vocabularies barely overlap.
 *  - no rack/RU tie-break in the sort. A rack is a property of an asset's
 *    position in a move (V2's own secondary-sort rule); a container has no
 *    rack, so sorting is a plain natural compare on the chosen column.
 *
 * Archived containers are dropped before anything else runs, so the list
 * matches what the label runner actually walks (it excludes them too) —
 * `GET /containers` itself does not filter them.
 *
 * Selection is by container id (`row.id`); the parent gets the displayed
 * (sorted + filtered) rows so it can derive the print order.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { ContainerItem } from '../../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters, usePersistentListState,
  type CellText,
} from '../../lib/columnMenu';
import {
  ColumnsButton, applyColumnOrder, moveKey, useReorderDrag, useSearchHaystacks, visibleColumnsFor,
  type ColumnDef,
} from '../../lib/listTools';
import { LABEL_TAG_OPTIONS } from '../../lib/labelTags';
import type { LabelStatus } from '../../lib/printLabels';
import { naturalCompare } from '../../lib/sites';
import { VirtualRows } from '../../lib/virtualRows';
import '../../styles/directory.css';

export const PRINT_CONTAINER_LIST_PAGE_KEY = 'labels-print-containers';

export type LabelFilter = 'all' | 'ready' | 'missing';

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Container', width: 'minmax(160px, 1.6fr)', default: true },
  { key: 'type', label: 'Type', width: 'minmax(110px, 1fr)', default: true },
  { key: 'tag', label: 'Label tag', width: '120px', default: true },
  { key: 'site', label: 'Site', width: 'minmax(110px, 1fr)', default: true },
  { key: 'assets', label: 'Assets', width: '80px', default: true },
  { key: 'status', label: 'Status', width: 'minmax(110px, 0.9fr)', default: true },
  { key: 'label', label: 'Label', width: '110px', default: true },
];
const ALL_KEYS = new Set(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set(COLUMNS.filter((c) => c.default).map((c) => c.key));

const STATUS_LABEL: Record<LabelStatus, string> = { ready: 'Ready', stale: 'Stale', missing: 'Missing', unsupported: 'Unsupported' };
const STATUS_CHIP: Record<LabelStatus, string> = { ready: 'c-green', stale: 'c-amber', missing: 'c-slate', unsupported: 'c-red' };

const TAG_LABEL = new Map(LABEL_TAG_OPTIONS.map((o) => [o.key, o.label]));
const TAG_COLOR = new Map(LABEL_TAG_OPTIONS.map((o) => [o.key, o.color]));

/** Stable search-text function for `useSearchHaystacks` — must keep its
 *  identity across renders (see that hook's docstring) or the `displayed`
 *  memo's `haystack` dep churns every render. */
const searchText = (c: ContainerItem): string =>
  ['name', 'type', 'tag', 'site'].map((k) => containerCellText(c, null, k)).join(' ').toLowerCase();

export function containerCellText(row: ContainerItem, status: LabelStatus | null, key: string): string {
  switch (key) {
    case 'name': return row.name ?? '';
    case 'type': return row.type_label ?? '';
    case 'tag': return row.label_tag ? (TAG_LABEL.get(row.label_tag) ?? row.label_tag) : '';
    case 'site': return row.site_name ?? '';
    case 'assets': return String(row.asset_count ?? 0);
    case 'status': return row.status_label ?? '';
    case 'label': return status ? STATUS_LABEL[status] : '';
    default: return '';
  }
}

/** Plain natural-compare sort on the chosen column — `assets` compares
 *  numerically. No secondary sort: the asset list's rack/RU tie-break is a
 *  V2 rule about rack positions and has no container meaning. */
export function sortContainerRows(
  rows: ContainerItem[], statusOf: (r: ContainerItem) => LabelStatus | null,
  sortKey: string, sortDir: 1 | -1,
): ContainerItem[] {
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (sortKey === 'assets') {
      const va = a.asset_count ?? 0, vb = b.asset_count ?? 0;
      cmp = va < vb ? -1 : va > vb ? 1 : 0;
    } else {
      cmp = naturalCompare(containerCellText(a, statusOf(a), sortKey), containerCellText(b, statusOf(b), sortKey));
    }
    return cmp * sortDir;
  });
}

interface Props {
  rows: ContainerItem[];
  statusOf: ((row: ContainerItem) => LabelStatus) | null;
  selected: string[];
  onSelectedChange: (next: string[]) => void;
  onDisplayedChange: (displayed: ContainerItem[]) => void;
  onRefresh: () => void;
  refreshing: boolean;
  disabled?: boolean;
  resetKey?: string;
}

export default function PrintContainerList({
  rows, statusOf, selected, onSelectedChange, onDisplayedChange, onRefresh, refreshing, disabled = false, resetKey,
}: Props) {
  const [query, setQuery] = useState('');
  const [labelFilter, setLabelFilter] = useState<LabelFilter>('all');
  const headerRef = useRef<HTMLInputElement>(null);
  const {
    visibleCols, setVisibleCols, sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters, colOrder, setColOrder,
  } = usePersistentListState(PRINT_CONTAINER_LIST_PAGE_KEY, { visible: DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 }, ALL_KEYS);

  // Archived containers are not labeled by the runner, so they are not
  // printable here either — drop them before sorting, filtering or counting.
  const live = useMemo(() => rows.filter((r) => !r.archived_at), [rows]);

  // Clear filters/search/label-filter when the parent swaps in a new
  // initiative's rows (mirrors the asset list; never resets on mount).
  const prevResetKey = useRef(resetKey);
  useEffect(() => {
    if (prevResetKey.current !== resetKey) {
      prevResetKey.current = resetKey;
      clearFilters();
      setLabelFilter('all');
      setQuery('');
    }
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = (r: ContainerItem): LabelStatus | null => (statusOf ? statusOf(r) : null);
  const cellText: CellText<ContainerItem> = (r, key) => containerCellText(r, status(r), key);
  const haystack = useSearchHaystacks(live, searchText);

  const displayed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = live.filter((r) => {
      if (statusOf && labelFilter !== 'all') {
        const s = statusOf(r);
        const printable = s === 'ready' || s === 'stale';
        if (labelFilter === 'ready' ? !printable : printable) return false;
      }
      if (!passesColumnFilters(r, filters, cellText)) return false;
      return !q || haystack(r).includes(q);
    });
    return sortContainerRows(filtered, status, sortKey, sortDir);
    // `cellText`/`status` are intentionally omitted: both are re-created each
    // render but are pure functions of `statusOf`, which is already a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, statusOf, labelFilter, filters, query, sortKey, sortDir, haystack]);

  useEffect(() => { onDisplayedChange(displayed); }, [displayed]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayedIds = useMemo(() => displayed.map((r) => r.id), [displayed]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedInDisplayed = displayedIds.filter((id) => selectedSet.has(id));
  const allSelected = displayedIds.length > 0 && selectedInDisplayed.length === displayedIds.length;
  const someSelected = selectedInDisplayed.length > 0 && !allSelected;
  useEffect(() => { if (headerRef.current) headerRef.current.indeterminate = someSelected; }, [someSelected]);

  const toggleOne = (id: string) =>
    onSelectedChange(selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  // Same semantics as the asset list: select-all REPLACES the selection with
  // the filtered rows; unchecking clears it.
  const toggleAll = () => onSelectedChange(allSelected ? [] : displayedIds);

  const orderedCols = useMemo(
    () => applyColumnOrder(COLUMNS.filter((c) => statusOf || c.key !== 'label'), colOrder),
    [statusOf, colOrder],
  );
  const shownCols = useMemo(
    () => visibleColumnsFor(orderedCols, visibleCols, false),
    [orderedCols, visibleCols],
  );
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid: CSSProperties = { gridTemplateColumns: `32px ${shownCols.map((c) => c.width).join(' ')}` };
  const caret = (key: string) => (sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null);

  const cell = (r: ContainerItem, key: string) => {
    const text = cellText(r, key);
    switch (key) {
      case 'name': return <div className="pn"><b>{text || '—'}</b></div>;
      case 'assets': return <span className="mono">{text}</span>;
      case 'type':
        return text
          ? <span className="chip custom" style={{ '--chip': r.type_color } as CSSProperties}>{text}</span>
          : <span className="cell-sub">—</span>;
      case 'tag':
        return text
          ? <span className="chip custom" style={{ '--chip': TAG_COLOR.get(r.label_tag!) } as CSSProperties}>{text}</span>
          : <span className="cell-sub">—</span>;
      case 'status':
        return <span className="chip custom" style={{ '--chip': r.status_color } as CSSProperties}><span className="dot" />{text}</span>;
      case 'label': {
        const s = status(r);
        return s ? <span className={`chip ${STATUS_CHIP[s]}`}>{STATUS_LABEL[s]}</span> : null;
      }
      default: return <span className="cell-sub">{text || '—'}</span>;
    }
  };

  return (
    <div className="plabels-list">
      <div className="plabels-list-tools">
        <div className="dir-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input placeholder="Search containers…" value={query} disabled={disabled}
                 onChange={(e) => setQuery(e.target.value)} />
        </div>
        {selected.length > 0 && <span className="chip tag">{selected.length} selected</span>}
        {statusOf && (
          <div className="segmented" role="tablist" aria-label="Label status filter">
            {(['all', 'ready', 'missing'] as LabelFilter[]).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={labelFilter === f}
                      className={labelFilter === f ? 'on' : ''} onClick={() => setLabelFilter(f)}>
                {f === 'all' ? 'All' : f === 'ready' ? 'Ready' : 'Missing'}
              </button>
            ))}
          </div>
        )}
        <FilterSummaryChip filters={filters} onClear={clearFilters} />
        <span className="spacer" />
        <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                       onReorder={setColOrder} />
        <button type="button" className="mini-btn" onClick={onRefresh} disabled={refreshing || disabled}>Refresh</button>
      </div>

      <div className="dir-list" role="list" aria-label="Containers">
        <div className="list-head" style={grid}>
          <span className="col-head">
            <input type="checkbox" ref={headerRef} checked={allSelected} disabled={disabled || displayedIds.length === 0}
                   aria-label="Select all filtered containers" onChange={toggleAll} />
          </span>
          {shownCols.map((c) => (
            <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`} {...headerDrag.dragProps(c.key)}>
              <button className="sortable" onClick={() => toggleSort(c.key)}>{c.label} {caret(c.key)}</button>
              <ColumnMenu colKey={c.key} label={c.label} allRows={live} filters={filters} text={cellText}
                          filter={filters[c.key]} onFilter={setFilter}
                          sortDir={sortKey === c.key ? sortDir : null} onSort={(dir) => setSort(c.key, dir)} />
            </span>
          ))}
        </div>

        {displayed.length === 0 && (
          <div className="dir-empty">
            {query ? 'No containers match your search' : 'No containers match the active filters'}
            <EmptyClearFilters filters={filters} onClear={() => { clearFilters(); setLabelFilter('all'); }} />
          </div>
        )}

        <VirtualRows rows={displayed} renderRow={(r, vp) => {
          const isSelected = selectedSet.has(r.id);
          return (
            <div key={r.id} className={`dir-row ${isSelected ? 'open' : ''}`} {...vp} style={vp?.style} role="listitem">
              <div className="row-main" style={grid} onClick={() => !disabled && toggleOne(r.id)}>
                <div className="cell">
                  <input type="checkbox" checked={isSelected} disabled={disabled}
                         aria-label={`Select ${r.name || r.id}`}
                         onChange={() => toggleOne(r.id)} onClick={(e) => e.stopPropagation()} />
                </div>
                {shownCols.map((c) => (
                  <div key={c.key} className={`cell ${c.key === 'name' ? 'cell-primary' : ''}`}>{cell(r, c.key)}</div>
                ))}
              </div>
            </div>
          );
        }} />
      </div>
      <p className="page-hint">Showing {displayed.length} of {live.length} containers</p>
    </div>
  );
}
