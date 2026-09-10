/**
 * Raw scans — the unprocessed inbox, Containers.tsx pattern: full standard
 * list (filter/sort/columns/export). Read-only: rows arrive from kiosk/
 * reader ingest and leave via the future matcher/pruner; raw_scans will be
 * kept bounded by the future pruning job, so full client-side load is
 * acceptable. No god-edit/delete, no archived column, no deep-link focus.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import {
  ApiError, listRawScans, type RawScanRow,
} from '../../lib/api';
import { rawScanCellText, rawScanSearchText } from '../../lib/scans';
import { statusChip } from '../../lib/chips';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../../lib/columnMenu';
import { naturalCompare } from '../../lib/sites';
import {
  applyColumnOrder,
  ColumnsButton,
  ExportButton,
  exportCsv,
  moveKey,
  useReorderDrag,
  useSearchHaystacks,
  visibleColumnsFor,
  type ColumnDef,
} from '../../lib/listTools';
import { VirtualRows } from '../../lib/virtualRows';
import { displayScanValue } from '../../lib/format';

const COLUMNS: ColumnDef[] = [
  { key: 'status', label: 'Scan status', width: '1.1fr', default: true },
  { key: 'scan_type', label: 'Method', width: '0.9fr', default: true },
  { key: 'scanned', label: 'Scanned', width: '1.1fr', default: true },
  { key: 'device', label: 'Device', width: '1fr', default: true },
  { key: 'operator', label: 'Operator', width: '1fr', default: true },
  { key: 'site', label: 'Site', width: '1fr', default: true },
  { key: 'location', label: 'Location', width: '1.2fr', default: false },
  { key: 'source', label: 'Source', width: '0.7fr', default: false },
  { key: 'ingested', label: 'Ingested', width: '1.1fr', default: false },
];
const ALL_COLUMN_KEYS = new Set<string>([...COLUMNS.map((c) => c.key), 'primary']);

const DEFAULT_VISIBLE = new Set<string>(
  COLUMNS.filter((c) => c.default).map((c) => c.key));

function sortValueFor(r: RawScanRow, key: string): string {
  switch (key) {
    case 'primary': return r.scanned_value.toLowerCase();
    case 'status': return (r.status_label ?? '').toLowerCase();
    case 'scan_type': return r.scan_type_label.toLowerCase();
    case 'scanned': return r.scanned_at;
    case 'device': return r.device_id.toLowerCase();
    case 'operator': return (r.operator_name ?? '').toLowerCase();
    case 'site': return (r.site_name ?? '').toLowerCase();
    case 'location': return r.location_detail.toLowerCase();
    case 'source': return r.source.toLowerCase();
    case 'ingested': return r.created_at;
    default: return '';
  }
}

const CSV_COLUMNS: [string, (r: RawScanRow) => string][] = [
  ['Scanned at', (r) => r.scanned_at],
  ['Value', (r) => r.scanned_value],
  ['Scan status', (r) => r.status_label ?? ''],
  ['Method', (r) => r.scan_type_label],
  ['Device', (r) => r.device_id],
  ['Operator', (r) => r.operator_name ?? ''],
  ['Site', (r) => r.site_name ?? ''],
  ['Location', (r) => r.location_detail],
  ['Source', (r) => r.source],
  ['Ingested', (r) => r.created_at],
];

export default function RawScansTab({ onCount }: {
  onCount: (n: number | null) => void;
}) {
  const [scans, setScans] = useState<RawScanRow[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'raw_scans', { visible: DEFAULT_VISIBLE, sortKey: 'scanned', sortDir: -1 },
    ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      const rows = await listRawScans({});
      setScans(rows);
      setError('');
      onCount(rows.length);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view scans.'
        : 'Failed to load raw scans.');
      onCount(null);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const haystack = useSearchHaystacks(scans, rawScanSearchText);

  const visible = useMemo(() => {
    if (!scans) return [];
    const q = query.trim().toLowerCase();
    const rows = scans.filter((r) => {
      if (!passesColumnFilters(r, filters, rawScanCellText)) return false;
      if (!q) return true;
      return haystack(r).includes(q);
    });
    return rows.sort((a, b) =>
      naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [scans, filters, query, sortKey, sortDir, haystack]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `2fr ${shownCols.map((c) => c.width).join(' ')} 30px` };

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
      case 'scanned':
        return <span className="mono">{new Date(r.scanned_at).toLocaleString()}</span>;
      case 'device':
        return <span className="mono">{r.device_id || '—'}</span>;
      case 'operator':
        return <span className="cell-top">{r.operator_name ?? '—'}</span>;
      case 'site':
        return <span className="cell-top">{r.site_name ?? '—'}</span>;
      case 'location':
        return <span className="cell-top">{r.location_detail || '—'}</span>;
      case 'source':
        return <span className="cell-top">{r.source || '—'}</span>;
      case 'ingested':
        return <span className="mono">{new Date(r.created_at).toLocaleString()}</span>;
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
          <span className="result-count">{visible.length} of {scans?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols} godMode={false} onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('raw-scans', CSV_COLUMNS, visible)} />
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load scans</b>{error}</div>}

      {!error && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            <span className="col-head">
              <button className="sortable" onClick={() => toggleSort('primary')}>
                Value {caret('primary')}
              </button>
              <ColumnMenu colKey="primary" label="Value"
                          allRows={scans ?? []} filters={filters}
                          text={rawScanCellText}
                          filter={filters.primary} onFilter={setFilter}
                          sortDir={sortKey === 'primary' ? sortDir : null}
                          onSort={(dir) => setSort('primary', dir)} />
            </span>
            {shownCols.map((c) => (
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={scans ?? []} filters={filters}
                            text={rawScanCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <span />
          </div>

          {scans && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — raw scans appear when readers report in.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          <VirtualRows rows={visible}
            renderRow={(r, vp) => {
              const open = openId === r.id;
              return (
                <div key={r.id} className={`dir-row ${open ? 'open' : ''}`}
                     {...vp} style={vp?.style}>
                  <div className="row-main" style={grid}
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
