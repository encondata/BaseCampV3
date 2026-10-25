/**
 * Raw scans — the unprocessed inbox, Containers.tsx pattern: the full
 * standard list (filter/sort/columns/export), but loaded in pages from the
 * server. raw_scans runs to 100k+ rows, so sorting, column filters, search,
 * the Scanned date range, the checklist values (facets) and the CSV export
 * all run in the API; the list appends the next page as the scroller nears
 * the end. Read-only: rows arrive from kiosk/reader ingest and leave via the
 * future matcher/pruner. No god-edit/delete, no archived column, no
 * deep-link focus.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError, downloadRawScansCsv, getRawScanFacets, getRawScanPage,
  type RawScanFacetColumn, type RawScanRow, type RawScanSort,
} from '../../lib/api';
import { statusChip } from '../../lib/chips';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, usePersistentListState,
  type ColumnValuesSource,
} from '../../lib/columnMenu';
import { DateRangeMenu } from '../../lib/dateRangeMenu';
import {
  applyColumnOrder,
  ColHead,
  ColumnsButton,
  ExportButton,
  listGridStyle,
  listScale,
  moveKey,
  titleFor,
  useReorderDrag,
  visibleColumnsFor,
} from '../../lib/listTools';
import {
  activeRawFilters, rangeBounds, rangeFilter, scannedRange, serverColumnFilters,
} from '../../lib/rawScanQuery';
import { usePagedList } from '../../lib/usePagedList';
import { VirtualRows } from '../../lib/virtualRows';
import {
  RAW_SCAN_COLUMNS as COLUMNS, RAW_SCAN_PRIMARY_COL as PRIMARY_COL,
} from '../../lib/scanColumns';
import { displayScanValue } from '../../lib/format';

const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'primary']);

const DEFAULT_VISIBLE = new Set<string>(
  COLUMNS.filter((c) => c.default).map((c) => c.key));

/** Rows per request. */
const PAGE_SIZE = 100;

export default function RawScansTab({ onCount }: {
  onCount: (n: number | null) => void;
}) {
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [exportError, setExportError] = useState('');
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters: savedFilters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'raw_scans', { visible: DEFAULT_VISIBLE, sortKey: 'scanned', sortDir: -1 },
    ALL_COLUMN_KEYS,
  );

  // What really applies: stale Scanned / Ingested entries from older saved
  // prefs are dropped here (the server ignores them too).
  const filters = useMemo(() => activeRawFilters(savedFilters), [savedFilters]);
  const range = useMemo(() => scannedRange(filters), [filters]);
  const columnFilters = useMemo(() => serverColumnFilters(filters), [filters]);
  const { since, until } = useMemo(() => rangeBounds(range), [range]);
  const q = query.trim();

  const list = usePagedList({
    query: useMemo(() => ({
      sort: sortKey as RawScanSort,
      dir: sortDir === 1 ? 'asc' as const : 'desc' as const,
      filters: columnFilters, since, until, limit: PAGE_SIZE,
    }), [sortKey, sortDir, columnFilters, since, until]),
    search: query,
    fetchPage: async ({ search, ...params }, signal) => {
      try {
        return await getRawScanPage({ ...params, q: search.trim() }, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        if (params.cursor) throw new Error('Couldn’t load more scans.');
        throw new Error(err instanceof ApiError && err.status === 403
          ? 'You do not have permission to view scans.'
          : 'Failed to load raw scans.');
      }
    },
  });
  const { rows: scans, total } = list;
  const failed = list.error !== null && scans.length === 0;

  // The page header's count follows the server total.
  useEffect(() => {
    if (failed) onCount(null);
    else if (!list.loading) onCount(total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, list.loading, total]);

  // Checklist values come from the facets endpoint, given everything else
  // that narrows the list. The open menu refreshes when `valuesKey` changes.
  const valuesKey = JSON.stringify({ q, since, until });
  const sourceFor = (column: RawScanFacetColumn): ColumnValuesSource =>
    ({ search, signal }) =>
      getRawScanFacets(column, { q, since, until, filters: columnFilters, search }, signal);

  // The Value menu shows a read as the row does (RFID tags without their zero
  // padding) but filters on the raw value; the facets carry no scan type, so
  // values already on screen use theirs and others show as reported.
  const typeOfValue = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of scans) m.set(r.scanned_value, r.scan_type);
    return m;
  }, [scans]);
  const displayValue = (v: string) => displayScanValue(v, typeOfValue.get(v));

  const exportCsv = async () => {
    setExportError('');
    try {
      await downloadRawScansCsv({
        q, filters: columnFilters, since, until,
        sort: sortKey as RawScanSort, dir: sortDir === 1 ? 'asc' : 'desc',
      });
    } catch {
      setExportError('Export failed. Try again.');
    }
  };

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = listGridStyle([PRIMARY_COL, ...shownCols], ['30px'], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  const cellFor = (r: RawScanRow, key: string) => {
    switch (key) {
      case 'status':
        return statusChip(r.status_label, r.status_color) ?? <span className="cell-top">—</span>;
      case 'scan_type':
        return (
          <span className="chip custom" style={{ '--chip': r.scan_type_color } as CSSProperties}>
            <span className="dot" />{r.scan_type_label}
          </span>
        );
      case 'scanned': {
        const text = new Date(r.scanned_at).toLocaleString();
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'device': {
        const text = r.device_id || '—';
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'operator': {
        const text = r.operator_name ?? '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'site': {
        const text = r.site_name ?? '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'location': {
        const text = r.location_detail || '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'source': {
        const text = r.source || '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'ingested': {
        const text = new Date(r.created_at).toLocaleString();
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      default:
        return null;
    }
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count" aria-live="polite">
            {failed ? '' : list.loading && scans.length === 0 ? 'Loading…'
              : list.reloading ? 'Updating…'
                : `${scans.length.toLocaleString()} of ${total.toLocaleString()} shown`}
          </span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols} godMode={false} onReorder={setColOrder} />
          <ExportButton onExport={() => void exportCsv()} />
        </div>
      </div>

      {failed && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load scans</b>{list.error}
          <div className="audit-more">
            <button type="button" className="mini-btn" onClick={list.reload}>Reload</button>
          </div>
        </div>
      )}
      {exportError && (
        <div className="dir-empty" style={{ marginBottom: 12 }}><b>{exportError}</b></div>
      )}

      {!failed && (
        <div className="dir-list list-scroll" aria-busy={list.loading}>
          <div className="list-head" style={rowStyle}>
            <ColHead col={PRIMARY_COL} sortDir={sortKey === 'primary' ? sortDir : null}
                     onToggleSort={() => toggleSort('primary')}>
              <ColumnMenu colKey="primary" label="Value" filters={filters}
                          valuesSource={sourceFor('primary')} valuesKey={valuesKey}
                          displayValue={displayValue}
                          filter={filters.primary} onFilter={setFilter}
                          sortDir={sortKey === 'primary' ? sortDir : null}
                          onSort={(dir) => setSort('primary', dir)} />
            </ColHead>
            {shownCols.map((c) => (
              <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                       onToggleSort={() => toggleSort(c.key)}
                       className={headerDrag.dropClass(c.key)}
                       dragProps={headerDrag.dragProps(c.key)}>
                {c.key === 'scanned' ? (
                  <DateRangeMenu label={c.label} range={range}
                                 onChange={(r) => setFilter('scanned', rangeFilter(r))}
                                 sortDir={sortKey === c.key ? sortDir : null}
                                 onSort={(dir) => setSort(c.key, dir)} />
                ) : c.key === 'ingested' ? (
                  <DateRangeMenu label={c.label}
                                 sortDir={sortKey === c.key ? sortDir : null}
                                 onSort={(dir) => setSort(c.key, dir)} />
                ) : (
                  <ColumnMenu colKey={c.key} label={c.label} filters={filters}
                              valuesSource={sourceFor(c.key as RawScanFacetColumn)}
                              valuesKey={valuesKey}
                              filter={filters[c.key]} onFilter={setFilter}
                              sortDir={sortKey === c.key ? sortDir : null}
                              onSort={(dir) => setSort(c.key, dir)} />
                )}
              </ColHead>
            ))}
            <span className="col-head" aria-hidden="true" />
          </div>

          {!list.loading && !list.error && scans.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — raw scans appear when readers report in.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          <VirtualRows rows={scans} onNearEnd={list.loadMore}
            renderRow={(r, vp) => {
              const open = openId === r.id;
              return (
                <div key={r.id} className={`dir-row ${open ? 'open' : ''}`}
                     {...vp} style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                  <div className="row-main" style={rowStyle}
                       onClick={() => setOpenId(open ? null : r.id)}>
                    <div className="cell cell-primary">
                      <div className="pn"><b className="mono" title={r.scanned_value}>{displayScanValue(r.scanned_value, r.scan_type)}</b>
                        <span>{r.scan_type_label}</span></div>
                    </div>
                    {shownCols.map((col) => (
                      <div className="cell" key={col.key}>{cellFor(r, col.key)}</div>
                    ))}
                    <div className="cell chevron-cell">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                           strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                    </div>
                  </div>

                  <div className="detail">
                    <div className="detail-clip">
                      <div className="detail-inner">
                        {open && <RawScanRowDetail scan={r} />}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }} />

          {list.loadingMore && (
            <div className="audit-more" role="status"><span className="set-note">Loading more…</span></div>
          )}
          {list.error && scans.length > 0 && (
            <div className="audit-more">
              <span className="set-note">{list.error}</span>
              <button type="button" className="mini-btn" onClick={list.retry}>Retry</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ── row detail: read-only, no interactive elements. ── */

function RawScanRowDetail({ scan }: { scan: RawScanRow }) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Scan</p>
        <dl className="kv">
          <dt>Value</dt><dd className="mono" title={scan.scanned_value}>{displayScanValue(scan.scanned_value, scan.scan_type)}</dd>
          <dt>Method</dt><dd>{scan.scan_type_label}</dd>
          <dt>Scanned</dt><dd>{new Date(scan.scanned_at).toLocaleString()}</dd>
          <dt>Device</dt><dd className="mono">{scan.device_id || '—'}</dd>
          <dt>Operator</dt><dd>{scan.operator_name ?? '—'}</dd>
          <dt>Site</dt><dd>{scan.site_name ?? '—'}</dd>
          <dt>Location</dt><dd>{scan.location_detail || '—'}</dd>
          <dt>Source</dt><dd>{scan.source || '—'}</dd>
        </dl>
      </div>
      <div className="detail-block">
        <p className="eyebrow-sm">Record</p>
        <dl className="kv">
          <dt>Ingested</dt><dd>{new Date(scan.created_at).toLocaleString()}</dd>
          <dt>Record id</dt><dd className="mono">{scan.id}</dd>
        </dl>
      </div>
    </div>
  );
}
