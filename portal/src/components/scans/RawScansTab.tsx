/** Raw scans — the unprocessed inbox, Audit.tsx pattern: server-side
 *  filters over a paged window, client-side sort of what's loaded.
 *  Read-only by design: rows arrive from kiosk/reader ingest and leave
 *  via the future matcher/pruner. */

import {
  useCallback, useEffect, useMemo, useRef, useState, type CSSProperties,
} from 'react';

import ComboBox from '../ComboBox';
import {
  listRawScans, listSites, listUsers,
  type RawScanRow, type SiteItem, type UserSummary,
} from '../../lib/api';
import { relativeTime } from '../../lib/format';
import {
  ColumnsButton, ExportButton, exportCsv, type ColumnDef,
} from '../../lib/listTools';
import { naturalCompare } from '../../lib/sites';

const PAGE = 100;

const COLUMNS: ColumnDef[] = [
  { key: 'value', label: 'Value', width: '1.4fr', default: true },
  { key: 'scan_type', label: 'Method', width: '1fr', default: true },
  { key: 'device', label: 'Device', width: '1fr', default: true },
  { key: 'operator', label: 'Operator', width: '1fr', default: true },
  { key: 'site', label: 'Site', width: '1fr', default: true },
  { key: 'location', label: 'Location', width: '1fr', default: false },
  { key: 'source', label: 'Source', width: '0.7fr', default: false },
  { key: 'ingested', label: 'Ingested', width: '1fr', default: false },
];

type SortKey = 'at' | 'value' | 'scan_type' | 'device' | 'operator'
  | 'site' | 'location' | 'source' | 'ingested';

interface Filters {
  device_id: string;
  operator_id: string;
  site_id: string;
  scan_type: string;
  value: string;
  since: string;   // yyyy-mm-dd from <input type=date>
  until: string;
}

const NO_FILTERS: Filters = {
  device_id: '', operator_id: '', site_id: '', scan_type: '',
  value: '', since: '', until: '',
};

const SCAN_TYPES = [
  { value: 'rfid', label: 'RFID' },
  { value: 'barcode', label: 'Barcode' },
  { value: 'manual', label: 'Manual' },
];

export default function RawScansTab({ onCount }: {
  onCount: (n: number | null) => void;
}) {
  const [rows, setRows] = useState<RawScanRow[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [people, setPeople] = useState<UserSummary[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('at');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    new Set(COLUMNS.filter((c) => c.default).map((c) => c.key)));
  const seq = useRef(0);

  const queryFrom = (f: Filters, offset: number) => ({
    device_id: f.device_id || undefined,
    operator_id: f.operator_id || undefined,
    site_id: f.site_id || undefined,
    scan_type: f.scan_type || undefined,
    value: f.value || undefined,
    since: f.since ? new Date(`${f.since}T00:00:00`).toISOString() : undefined,
    until: f.until ? new Date(`${f.until}T23:59:59.999`).toISOString() : undefined,
    limit: PAGE,
    offset,
  });

  const load = useCallback(async (f: Filters, append: boolean, offset: number) => {
    const mySeq = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const page = await listRawScans(queryFrom(f, offset));
      if (mySeq !== seq.current) return;
      setRows((prev) => (append ? [...prev, ...page] : page));
      setExhausted(page.length < PAGE);
    } catch {
      if (mySeq !== seq.current) return;
      setError('Could not load raw scans.');
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(NO_FILTERS, false, 0);
    void listUsers().then(setPeople).catch(() => {});
    void listSites().then(setSites).catch(() => {});
  }, [load]);

  useEffect(() => { onCount(rows.length); }, [rows, onCount]);

  const applyFilters = (next: Filters) => {
    setFilters(next);
    void load(next, false, 0);
  };

  const sortVal = (r: RawScanRow): string => {
    switch (sortKey) {
      case 'at': return r.scanned_at;
      case 'value': return r.scanned_value;
      case 'scan_type': return r.scan_type_label;
      case 'device': return r.device_id;
      case 'operator': return r.operator_name ?? '';
      case 'site': return r.site_name ?? '';
      case 'location': return r.location_detail;
      case 'source': return r.source;
      case 'ingested': return r.created_at;
    }
  };

  const visible = useMemo(
    () => [...rows].sort((a, b) => naturalCompare(sortVal(a), sortVal(b)) * sortDir),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(key === 'at' ? -1 : 1); }
  };
  const caret = (key: SortKey) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const shownCols = COLUMNS.filter((c) => visibleCols.has(c.key));
  const grid = { gridTemplateColumns: `150px ${shownCols.map((c) => c.width).join(' ')}` };

  const cellFor = (r: RawScanRow, key: string) => {
    switch (key) {
      case 'value': return <span className="mono">{r.scanned_value}</span>;
      case 'scan_type':
        return (
          <span className="chip custom" style={{ '--chip': r.scan_type_color } as CSSProperties}>
            <span className="dot" />{r.scan_type_label}
          </span>
        );
      case 'device': return <span className="mono">{r.device_id || '—'}</span>;
      case 'operator': return <>{r.operator_name ?? '—'}</>;
      case 'site': return <>{r.site_name ?? '—'}</>;
      case 'location': return <>{r.location_detail || '—'}</>;
      case 'source': return <>{r.source || '—'}</>;
      case 'ingested': return <>{new Date(r.created_at).toLocaleString()}</>;
      default: return null;
    }
  };

  return (
    <>
      <div className="dir-toolbar audit-toolbar">
        <input placeholder="Value contains…" value={filters.value}
               aria-label="Scanned value"
               onChange={(e) => applyFilters({ ...filters, value: e.target.value })} />
        <input placeholder="Device…" value={filters.device_id}
               aria-label="Device"
               onChange={(e) => applyFilters({ ...filters, device_id: e.target.value })} />
        <select value={filters.scan_type} aria-label="Scan method"
                onChange={(e) => applyFilters({ ...filters, scan_type: e.target.value })}>
          <option value="">All methods</option>
          {SCAN_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <div className="audit-actor">
          <ComboBox
            options={people.map((p) => ({ value: p.person_id, label: p.display_name }))}
            value={filters.operator_id}
            clearable
            placeholder="Any operator…"
            onChange={(v) => applyFilters({ ...filters, operator_id: v })}
          />
        </div>
        <div className="audit-actor">
          <ComboBox
            options={sites.map((s) => ({ value: s.id, label: s.name }))}
            value={filters.site_id}
            clearable
            placeholder="Any site…"
            onChange={(v) => applyFilters({ ...filters, site_id: v })}
          />
        </div>
        <input type="date" value={filters.since} aria-label="From date"
               onChange={(e) => applyFilters({ ...filters, since: e.target.value })} />
        <input type="date" value={filters.until} aria-label="To date"
               onChange={(e) => applyFilters({ ...filters, until: e.target.value })} />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <ColumnsButton columns={COLUMNS} visible={visibleCols} onChange={setVisibleCols} />
          <ExportButton onExport={() => exportCsv<RawScanRow>(
            'raw-scans',
            [
              ['Scanned at', (r) => r.scanned_at],
              ['Value', (r) => r.scanned_value],
              ['Method', (r) => r.scan_type_label],
              ['Device', (r) => r.device_id],
              ['Operator', (r) => r.operator_name ?? ''],
              ['Site', (r) => r.site_name ?? ''],
              ['Location', (r) => r.location_detail],
              ['Source', (r) => r.source],
              ['Ingested', (r) => r.created_at],
            ],
            visible)} />
          <span className="result-count">{rows.length} loaded</span>
        </span>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>{error}</b></div>}

      <div className="dir-list">
        <div className="list-head" style={grid}>
          <button className="sortable" onClick={() => toggleSort('at')}>
            Scanned {caret('at')}
          </button>
          {shownCols.map((c) => (
            <button key={c.key} className="sortable"
                    onClick={() => toggleSort(c.key as SortKey)}>
              {c.label} {caret(c.key as SortKey)}
            </button>
          ))}
        </div>

        {!loading && visible.length === 0 && !error && (
          <div className="dir-empty">
            <b>No scans match</b>Loosen the filters — or wait for readers to report in.
          </div>
        )}

        {visible.map((r) => (
          <div key={r.id} className="dir-row">
            <div className="row-main" style={grid}>
              <div className="cell" title={new Date(r.scanned_at).toLocaleString()}>
                {relativeTime(r.scanned_at)}
              </div>
              {shownCols.map((c) => (
                <div className="cell" key={c.key}>{cellFor(r, c.key)}</div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {!exhausted && (
        <div className="audit-more">
          <button className="mini-btn" disabled={loading}
                  onClick={() => void load(filters, true, rows.length)}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}
