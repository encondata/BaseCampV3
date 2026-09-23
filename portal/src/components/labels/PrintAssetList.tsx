/**
 * Print Labels › Step 4 — the initiative's roster as a selectable
 * directory list: checkbox column (header = select all FILTERED rows,
 * indeterminate when partial; row click toggles), V2's columns (Asset ID,
 * Name, Serial, Make, Model, Source rack, RU, Status) plus a Label status
 * column, V2's Excel-style per-column sort + value filters via
 * `ColumnMenu`, a Ready / Missing filter, search, and persisted column
 * prefs under `labels-print`. Sorting by Source rack is numeric-aware
 * with RU top-down (largest first) as the tie-break — V2's own rule.
 * Selection is by asset id (`row.asset_id`); the parent gets the displayed
 * (sorted + filtered) rows so it can derive the print order.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { useAuth } from '../../auth/AuthContext';
import type { InitiativeAssetRow } from '../../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters, usePersistentListState,
  type CellText,
} from '../../lib/columnMenu';
import {
  ColHead, ColumnsButton, applyColumnOrder, listGridStyle, listScale, moveKey, titleFor,
  useReorderDrag,
  useSearchHaystacks, visibleColumnsFor, type ColumnDef,
} from '../../lib/listTools';
import type { LabelStatus } from '../../lib/printLabels';
import { naturalCompare } from '../../lib/sites';
import { VirtualRows } from '../../lib/virtualRows';
import '../../styles/directory.css';

export const PRINT_LIST_PAGE_KEY = 'labels-print';

export type LabelFilter = 'all' | 'ready' | 'missing';

// The leading selection checkbox — a fixed track outside the column
// registry, folded into a ColumnDef purely so listGridStyle/its minWidth
// sum accounts for it too (recipe R1); it is never rendered via ColHead,
// the header cell below still renders the raw checkbox input.
const CHECKBOX_COL: ColumnDef = { key: 'select', label: '', width: '32px', default: true };

// Fit: default columns + trailing ≤ 1126px (1174 - 44 - 2 - 2 safety —
// .plabels-card, labels.css: padding 18px 22px plus a 1px border,
// 23px each side). `name` sits at 152 rather than the 158 it had while
// the ceiling was 1132: the nine defaults now total exactly 1126, and
// `name` is the widest floor and the most flexible track, so it is the
// one place 6px comes off without squeezing a short identifier column.
export const COLUMNS: ColumnDef[] = [
  { key: 'asset_id', label: 'Asset ID', width: '90px', default: true },
  { key: 'name', label: 'Name', width: '1.6fr', default: true, min: 152 },
  { key: 'serial', label: 'Serial', width: '1fr', default: true, min: 120 },
  { key: 'make', label: 'Make', width: '0.8fr', default: true, min: 90 },
  { key: 'model', label: 'Model', width: '1fr', default: true, min: 110 },
  {
    key: 'source_rack', label: 'Source rack', short: 'Src Rack',
    width: '0.9fr', default: true, min: 100,
  },
  { key: 'source_ru', label: 'RU', width: '64px', default: true },
  { key: 'status', label: 'Status', width: '0.9fr', default: true, min: 110 },
  { key: 'label', label: 'Label', width: '110px', default: true },
];
const ALL_KEYS = new Set(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set(COLUMNS.filter((c) => c.default).map((c) => c.key));

const STATUS_LABEL: Record<LabelStatus, string> = { ready: 'Ready', stale: 'Stale', missing: 'Missing', unsupported: 'Unsupported' };
const STATUS_CHIP: Record<LabelStatus, string> = { ready: 'c-green', stale: 'c-amber', missing: 'c-slate', unsupported: 'c-red' };

/** Stable search-text function for `useSearchHaystacks` — must keep its
 *  identity across renders (see that hook's docstring) or the `displayed`
 *  memo's `haystack` dep churns every render. */
const searchText = (r: InitiativeAssetRow): string =>
  ['asset_id', 'name', 'serial', 'make', 'model'].map((k) => assetCellText(r, null, k)).join(' ').toLowerCase();

export function assetCellText(row: InitiativeAssetRow, status: LabelStatus | null, key: string): string {
  switch (key) {
    case 'asset_id': return row.asset.legacy_id != null ? String(row.asset.legacy_id) : '';
    case 'name': return row.asset.name ?? '';
    case 'serial': return row.asset.serial_number ?? '';
    case 'make': return row.asset.model_make ?? '';
    case 'model': return row.asset.model_name ?? '';
    case 'source_rack': return row.source_rack ?? '';
    case 'source_ru': return row.source_ru != null ? String(row.source_ru) : '';
    case 'status': return row.status_label ?? '';
    case 'label': return status ? STATUS_LABEL[status] : '';
    default: return '';
  }
}

/** Sort with V2's rack rule: rack compare is numeric-aware and, within the
 *  same rack, RU descends regardless of direction (V2's secondaryCompare). */
export function sortRows(
  rows: InitiativeAssetRow[], statusOf: (r: InitiativeAssetRow) => LabelStatus | null,
  sortKey: string, sortDir: 1 | -1,
): InitiativeAssetRow[] {
  const numeric = sortKey === 'source_ru' || sortKey === 'asset_id';
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (numeric) {
      const va = sortKey === 'source_ru' ? (a.source_ru ?? -Infinity) : (a.asset.legacy_id ?? -Infinity);
      const vb = sortKey === 'source_ru' ? (b.source_ru ?? -Infinity) : (b.asset.legacy_id ?? -Infinity);
      cmp = va < vb ? -1 : va > vb ? 1 : 0;
    } else {
      cmp = naturalCompare(assetCellText(a, statusOf(a), sortKey), assetCellText(b, statusOf(b), sortKey));
    }
    if (cmp !== 0) return cmp * sortDir;
    if (sortKey === 'source_rack') return (b.source_ru ?? 0) - (a.source_ru ?? 0);
    return 0;
  });
}

interface Props {
  rows: InitiativeAssetRow[];
  statusOf: ((row: InitiativeAssetRow) => LabelStatus) | null;
  selected: string[];
  onSelectedChange: (next: string[]) => void;
  onDisplayedChange: (displayed: InitiativeAssetRow[]) => void;
  onRefresh: () => void;
  refreshing: boolean;
  disabled?: boolean;
  resetKey?: string;
}

export default function PrintAssetList({
  rows, statusOf, selected, onSelectedChange, onDisplayedChange, onRefresh, refreshing, disabled = false, resetKey,
}: Props) {
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const [query, setQuery] = useState('');
  const [labelFilter, setLabelFilter] = useState<LabelFilter>('all');
  const headerRef = useRef<HTMLInputElement>(null);
  const {
    visibleCols, setVisibleCols, sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters, colOrder, setColOrder,
  } = usePersistentListState(PRINT_LIST_PAGE_KEY, { visible: DEFAULT_VISIBLE, sortKey: 'source_rack', sortDir: 1 }, ALL_KEYS);

  // Clear filters/search/label-filter when the parent swaps in a new
  // initiative's rows (V2 only reset on a move/initiative change, never on
  // first load — so the initializer below intentionally skips mount).
  const prevResetKey = useRef(resetKey);
  useEffect(() => {
    if (prevResetKey.current !== resetKey) {
      prevResetKey.current = resetKey;
      clearFilters();
      setLabelFilter('all');
      setQuery('');
    }
  }, [resetKey]);

  const status = (r: InitiativeAssetRow): LabelStatus | null => (statusOf ? statusOf(r) : null);
  const cellText: CellText<InitiativeAssetRow> = (r, key) => assetCellText(r, status(r), key);
  const haystack = useSearchHaystacks(rows, searchText);

  const displayed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (statusOf && labelFilter !== 'all') {
        const s = statusOf(r);
        const printable = s === 'ready' || s === 'stale';
        if (labelFilter === 'ready' ? !printable : printable) return false;
      }
      if (!passesColumnFilters(r, filters, cellText)) return false;
      return !q || haystack(r).includes(q);
    });
    return sortRows(filtered, status, sortKey, sortDir);
    // `cellText`/`status` are intentionally omitted: both are re-created each
    // render but are pure functions of `statusOf`, which is already a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, statusOf, labelFilter, filters, query, sortKey, sortDir, haystack]);

  useEffect(() => { onDisplayedChange(displayed); }, [displayed]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayedIds = useMemo(() => displayed.map((r) => r.asset_id), [displayed]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedInDisplayed = displayedIds.filter((id) => selectedSet.has(id));
  const allSelected = displayedIds.length > 0 && selectedInDisplayed.length === displayedIds.length;
  const someSelected = selectedInDisplayed.length > 0 && !allSelected;
  useEffect(() => { if (headerRef.current) headerRef.current.indeterminate = someSelected; }, [someSelected]);

  const toggleOne = (id: string) =>
    onSelectedChange(selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  // V2 semantics: select-all REPLACES the selection with the filtered rows; unchecking clears it.
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
  const grid = listGridStyle([CHECKBOX_COL, ...shownCols], [], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  const cell = (r: InitiativeAssetRow, key: string) => {
    const text = cellText(r, key);
    switch (key) {
      case 'name': return <div className="pn"><b>{text || '—'}</b></div>;
      case 'asset_id': case 'serial': case 'source_rack': case 'source_ru': {
        const display = text || '—';
        return <span className="mono cell-line" title={titleFor(display)}>{display}</span>;
      }
      case 'status':
        return <span className="chip custom" style={{ '--chip': r.status_color } as CSSProperties}><span className="dot" />{text}</span>;
      case 'label': {
        const s = status(r);
        return s ? <span className={`chip ${STATUS_CHIP[s]}`}>{STATUS_LABEL[s]}</span> : null;
      }
      default: {
        const display = text || '—';
        return <span className="cell-sub cell-line" title={titleFor(display)}>{display}</span>;
      }
    }
  };

  return (
    <div className="plabels-list">
      <div className="plabels-list-tools">
        <div className="dir-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input placeholder="Search assets…" value={query} disabled={disabled} onChange={(e) => setQuery(e.target.value)} />
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

      <div className="dir-list list-scroll" role="list" aria-label="Assets">
        <div className="list-head" style={rowStyle}>
          <span className="col-head">
            <input type="checkbox" ref={headerRef} checked={allSelected} disabled={disabled || displayedIds.length === 0}
                   aria-label="Select all filtered assets" onChange={toggleAll} />
          </span>
          {shownCols.map((c) => (
            <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                     onToggleSort={() => toggleSort(c.key)}
                     className={headerDrag.dropClass(c.key)} dragProps={headerDrag.dragProps(c.key)}>
              <ColumnMenu colKey={c.key} label={c.label} allRows={rows} filters={filters} text={cellText}
                          filter={filters[c.key]} onFilter={setFilter}
                          sortDir={sortKey === c.key ? sortDir : null} onSort={(dir) => setSort(c.key, dir)} />
            </ColHead>
          ))}
        </div>

        {displayed.length === 0 && (
          <div className="dir-empty">
            {query ? 'No assets match your search' : 'No assets match the active filters'}
            <EmptyClearFilters filters={filters} onClear={() => { clearFilters(); setLabelFilter('all'); }} />
          </div>
        )}

        <VirtualRows rows={displayed} renderRow={(r, vp) => {
          const isSelected = selectedSet.has(r.asset_id);
          return (
            <div key={r.id} className={`dir-row ${isSelected ? 'open' : ''}`} {...vp}
                 style={{ ...vp?.style, minWidth: rowStyle.minWidth }} role="listitem">
              <div className="row-main" style={rowStyle} onClick={() => !disabled && toggleOne(r.asset_id)}>
                <div className="cell">
                  <input type="checkbox" checked={isSelected} disabled={disabled}
                         aria-label={`Select ${r.asset.name ?? r.asset.legacy_id ?? r.asset_id}`}
                         onChange={() => toggleOne(r.asset_id)} onClick={(e) => e.stopPropagation()} />
                </div>
                {shownCols.map((c) => (
                  <div key={c.key} className={`cell ${c.key === 'name' ? 'cell-primary' : ''}`}>{cell(r, c.key)}</div>
                ))}
              </div>
            </div>
          );
        }} />
      </div>
      <p className="page-hint">Showing {displayed.length} of {rows.length} assets</p>
    </div>
  );
}
