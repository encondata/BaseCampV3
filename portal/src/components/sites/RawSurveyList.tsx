/**
 * RawSurveyList — the append-only survey submission trail (Task 5):
 * read-only clone of the RawScansTab standard-list skeleton (filter/sort/
 * columns/export). Every cell is display-only, so it renders straight off
 * `rawSurveyCellText` — no per-column formatting branches. No god-edit, no
 * archived column, no row expansion — the row columns already cover every
 * field on `RawSurveyRow`, so there is nothing left over for a detail
 * panel to show.
 */
import { useEffect, useMemo, useState } from 'react';

import { ApiError, listSiteSurveyRaw, type RawSurveyRow } from '../../lib/api';
import { rawSurveyCellText, rawSurveySearchText } from '../../lib/siteSurvey';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../../lib/columnMenu';
import { naturalCompare } from '../../lib/sites';
import {
  applyColumnOrder, ColHead, ColumnsButton, ExportButton, exportCsv, listGridStyle, moveKey,
  useReorderDrag, useSearchHaystacks, visibleColumnsFor, type ColumnDef,
} from '../../lib/listTools';
import { VirtualRows } from '../../lib/virtualRows';

// The always-shown field-key cell — a fixed leading track outside the
// column registry (same shape as the header markup below), so it needs
// its own ColumnDef for listGridStyle/ColHead (recipe R1).
export const PRIMARY_COL: ColumnDef = {
  key: 'primary', label: 'Field', width: '2fr', default: true, min: 150,
};

// Fit: default columns + trailing ≤ 1140px (1176 - 36 — this list sits
// inside an .init-panel, initiatives.css: padding 16px 18px, 18px each
// side, nested in a CollapsePanel that adds no horizontal padding of its
// own). RawSurveyList has no useAuth() call today (no other reason to
// touch AuthContext) — scale is omitted rather than adding that
// dependency just for list_size; listGridStyle defaults to scale 1.
export const COLUMNS: ColumnDef[] = [
  { key: 'value', label: 'Value', width: '1.4fr', default: true },
  { key: 'registered', label: 'Registered', width: '0.8fr', default: true },
  { key: 'source', label: 'Source', width: '0.8fr', default: true },
  { key: 'submitted_by', label: 'Submitted by', width: '1fr', default: true },
  { key: 'device', label: 'Device', width: '1fr', default: false },
  { key: 'captured', label: 'Captured', width: '1.1fr', default: true, min: 96 },
  { key: 'ingested', label: 'Ingested', width: '1fr', default: false },
];
const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'field']);
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

function sortValueFor(r: RawSurveyRow, key: string): string {
  switch (key) {
    case 'field': return r.field_key.toLowerCase();
    case 'value': return rawSurveyCellText(r, 'value').toLowerCase();
    case 'registered': return r.registered ? '1' : '0';
    case 'source': return (r.source || '').toLowerCase();
    case 'submitted_by': return (r.submitted_by_name ?? '').toLowerCase();
    case 'device': return (r.device_id || '').toLowerCase();
    case 'captured': return r.captured_at;
    case 'ingested': return r.created_at;
    default: return '';
  }
}

/** No tooltip for a blank cell — "—" repeated as a title on hover reads
 *  as noise, not information. */
const titleFor = (text: string) => (text === '—' ? undefined : text);

const CSV_COLUMNS: [string, (r: RawSurveyRow) => string][] = [
  ['Field key', (r) => r.field_key],
  ['Value', (r) => rawSurveyCellText(r, 'value')],
  ['Registered', (r) => rawSurveyCellText(r, 'registered')],
  ['Source', (r) => rawSurveyCellText(r, 'source')],
  ['Submitted by', (r) => rawSurveyCellText(r, 'submitted_by')],
  ['Device', (r) => rawSurveyCellText(r, 'device')],
  ['Captured', (r) => rawSurveyCellText(r, 'captured')],
  ['Ingested', (r) => rawSurveyCellText(r, 'ingested')],
];

export default function RawSurveyList({ siteId, refreshKey, onCount }: {
  siteId: string;
  refreshKey?: number;
  onCount?: (n: number | null) => void;
}) {
  const [rows, setRows] = useState<RawSurveyRow[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'raw_survey', { visible: DEFAULT_VISIBLE, sortKey: 'captured', sortDir: -1 },
    ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      const data = await listSiteSurveyRaw(siteId);
      setRows(data);
      setError('');
      onCount?.(data.length);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view this site.'
        : 'Failed to load survey submissions.');
      onCount?.(null);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, refreshKey]);

  const haystack = useSearchHaystacks(rows, rawSurveySearchText);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (!passesColumnFilters(r, filters, rawSurveyCellText)) return false;
      if (!q) return true;
      return haystack(r).includes(q);
    });
    return filtered.sort((a, b) =>
      naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [rows, filters, query, sortKey, sortDir, haystack]);

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = listGridStyle([PRIMARY_COL, ...shownCols]);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  const cellFor = (row: RawSurveyRow, key: string) => {
    const text = rawSurveyCellText(row, key);
    const isMono = key === 'device' || key === 'captured' || key === 'ingested';
    return (
      <span className={`${isMono ? 'mono' : 'cell-top'} cell-line`} title={titleFor(text)}>
        {text}
      </span>
    );
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter submissions…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {rows?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols} godMode={false} onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('raw-survey', CSV_COLUMNS, visible)} />
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load submissions</b>{error}</div>}

      {!error && (
        <div className="dir-list list-scroll">
          <div className="list-head" style={rowStyle}>
            <ColHead col={PRIMARY_COL} sortDir={sortKey === 'field' ? sortDir : null}
                     onToggleSort={() => toggleSort('field')}>
              <ColumnMenu colKey="field" label="Field"
                          allRows={rows ?? []} filters={filters}
                          text={rawSurveyCellText}
                          filter={filters.field} onFilter={setFilter}
                          sortDir={sortKey === 'field' ? sortDir : null}
                          onSort={(dir) => setSort('field', dir)} />
            </ColHead>
            {shownCols.map((c) => (
              <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                       onToggleSort={() => toggleSort(c.key)}
                       className={headerDrag.dropClass(c.key)}
                       dragProps={headerDrag.dragProps(c.key)}>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={rows ?? []} filters={filters}
                            text={rawSurveyCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </ColHead>
            ))}
          </div>

          {rows && visible.length === 0 && (
            <div className="dir-empty">
              {rows.length === 0 ? (
                <b>No survey submissions yet.</b>
              ) : (
                <>
                  <b>No matches</b>Try a different filter.
                  <EmptyClearFilters filters={filters} onClear={clearFilters} />
                </>
              )}
            </div>
          )}

          <VirtualRows rows={visible}
            renderRow={(row, vp) => (
              <div key={row.id} className="dir-row" {...vp}
                   style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                <div className="row-main" style={rowStyle}>
                  <div className="cell cell-primary">
                    <span className="mono cell-line" title={titleFor(row.field_key)}>{row.field_key}</span>
                  </div>
                  {shownCols.map((col) => (
                    <div className="cell" key={col.key}>{cellFor(row, col.key)}</div>
                  ))}
                </div>
              </div>
            )} />
        </div>
      )}
    </>
  );
}
