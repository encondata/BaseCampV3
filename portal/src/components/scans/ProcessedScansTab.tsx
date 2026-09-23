/**
 * Processed scans — the permanent matched record, Containers.tsx pattern:
 * full standard list (filter/sort/columns/export/god-edit/god-delete).
 * Read-only detail — the matcher/processor is the only mutation surface
 * besides god-edit's site/location/operator patch.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import GodDeleteButton from '../GodDeleteButton';
import {
  ApiError,
  listProcessedScans,
  listSites,
  listUsers,
  updateProcessedScan,
  type ProcessedScanRow,
  type SiteItem,
  type UserSummary,
} from '../../lib/api';
import {
  matchedHref, processedScanCellText, processedScanSearchText,
  PROCESSED_SCAN_GOD_FIELDS, SCANS_ERRORS,
} from '../../lib/scans';
import { initialOpenId } from '../../lib/auditFormat';
import { statusChip } from '../../lib/chips';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../../lib/columnMenu';
import { GodCell, GodEditToggle, useGodEdit } from '../../lib/godEdit';
import { usePendingDeletes } from '../../lib/pendingDeletes';
import { naturalCompare } from '../../lib/sites';
import { useRecordFocus } from '../../lib/useDeepLinkFilter';
import {
  applyColumnOrder,
  ColHead,
  ColumnsButton,
  ExportButton,
  exportCsv,
  listGridStyle,
  listScale,
  moveKey,
  useReorderDrag,
  useSearchHaystacks,
  visibleColumnsFor,
  type ColumnDef,
} from '../../lib/listTools';
import { VirtualRows } from '../../lib/virtualRows';
import { displayScanValue } from '../../lib/format';

// The always-shown scanned-value cell — a fixed leading track outside the
// column registry (same shape as the header markup below), so it needs
// its own ColumnDef for listGridStyle/ColHead (recipe R1).
export const PRIMARY_COL: ColumnDef = {
  key: 'primary', label: 'Value', width: '2fr', default: true, min: 160,
};

// Fit: default columns + trailing ≤ 1176px (.portal-page at a 1512px
// window, nav expanded — Scans.tsx mounts this tab directly under
// .portal-page, no wrapping card).
export const COLUMNS: ColumnDef[] = [
  { key: 'match', label: 'Match', width: '1fr', default: true },
  { key: 'status', label: 'Scan status', width: '1.1fr', default: true },
  { key: 'matched', label: 'Matched record', short: 'Matched', width: '1.3fr', default: true },
  { key: 'scanned', label: 'Scanned', width: '1.1fr', default: true, min: 96 },
  { key: 'processed', label: 'Processed', width: '1.1fr', default: false },
  { key: 'scan_type', label: 'Method', width: '0.9fr', default: true },
  { key: 'device', label: 'Device', width: '1fr', default: true, min: 100 },
  { key: 'operator', label: 'Operator', width: '1fr', default: false },
  { key: 'site', label: 'Site', width: '1fr', default: true },
  { key: 'location', label: 'Location', width: '1.2fr', default: false },
  { key: 'source', label: 'Source', width: '0.7fr', default: false },
];

const ALL_COLUMN_KEYS = new Set<string>(
  [...COLUMNS.map((c) => c.key), 'primary', 'archived']);
const DEFAULT_VISIBLE = new Set<string>(
  COLUMNS.filter((c) => c.default).map((c) => c.key));

function sortValueFor(s: ProcessedScanRow, key: string): string {
  switch (key) {
    case 'primary': return s.scanned_value.toLowerCase();
    case 'match': return s.match_type_label.toLowerCase();
    case 'status': return (s.status_label ?? '').toLowerCase();
    case 'matched': return (s.matched_name ?? '').toLowerCase();
    case 'scanned': return s.scanned_at;
    case 'processed': return s.processed_at;
    case 'scan_type': return s.scan_type_label.toLowerCase();
    case 'device': return s.device_id.toLowerCase();
    case 'operator': return (s.operator_name ?? '').toLowerCase();
    case 'site': return (s.site_name ?? '').toLowerCase();
    case 'location': return s.location_detail.toLowerCase();
    case 'source': return s.source.toLowerCase();
    case 'archived': return s.archived_at ? '1' : '0';
    default: return '';
  }
}

/** No tooltip for a blank cell — "—" repeated as a title on hover reads
 *  as noise, not information. */
const titleFor = (text: string) => (text === '—' ? undefined : text);

const CSV_COLUMNS: [string, (s: ProcessedScanRow) => string][] = [
  ['ID', (s) => s.id],
  ['Value', (s) => s.scanned_value],
  ['Match', (s) => s.match_type_label],
  ['Scan status', (s) => s.status_label ?? ''],
  ['Matched record', (s) => s.matched_name ?? ''],
  ['Scanned', (s) => s.scanned_at],
  ['Processed', (s) => s.processed_at],
  ['Method', (s) => s.scan_type_label],
  ['Device', (s) => s.device_id],
  ['Operator', (s) => s.operator_name ?? ''],
  ['Site', (s) => s.site_name ?? ''],
  ['Location', (s) => s.location_detail],
  ['Source', (s) => s.source],
];

export default function ProcessedScansTab({ onCount }: {
  onCount: (n: number | null) => void;
}) {
  const { can, godMode, preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const canChange = can('scans', 'change');
  const canViewSites = can('sites', 'view');
  const canViewUsers = can('users', 'view');
  const god = useGodEdit();
  const pd = usePendingDeletes(godMode);

  const [scans, setScans] = useState<ProcessedScanRow[] | null>(null);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [people, setPeople] = useState<UserSummary[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const deepLinkTarget = useRef<string | null>(initialOpenId());
  const focusOpenId = (id: string | null) => {
    deepLinkTarget.current = id;
    clearedDeepLink.current = null;
    setOpenId(id);
  };
  useRecordFocus(scans, (s) => s.id, (s) => s.scanned_value, focusOpenId, setQuery);
  const clearedDeepLink = useRef<string | null>(null);
  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'processed_scans', { visible: DEFAULT_VISIBLE, sortKey: 'scanned', sortDir: -1 },
    ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      const rows = await listProcessedScans();
      setScans(rows);
      setError('');
      onCount(rows.length);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view scans.'
        : 'Failed to load processed scans.');
      onCount(null);
    }
  };

  useEffect(() => {
    void load();
    if (canViewSites) void listSites().then(setSites).catch(() => {});
    if (canViewUsers) void listUsers().then(setPeople).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const godFields = useMemo(() => PROCESSED_SCAN_GOD_FIELDS({
    sites: () => (canViewSites ? sites.map((s) => ({ value: s.id, label: s.name })) : []),
    people: () => (canViewUsers
      ? people.map((p) => ({ value: p.person_id, label: p.display_name })) : []),
  }), [sites, people, canViewSites, canViewUsers]);
  const godFieldFor = (column: string) => godFields.find((f) => f.column === column);
  const replaceRow = (u: ProcessedScanRow) =>
    setScans((xs) => xs?.map((x) => (x.id === u.id ? u : x)) ?? xs);

  const haystack = useSearchHaystacks(scans, processedScanSearchText);

  const visible = useMemo(() => {
    if (!scans) return [];
    const q = query.trim().toLowerCase();
    const showArchived = filters.archived?.values?.includes('Yes') ?? false;
    const rows = scans.filter((s) => {
      if (!showArchived && s.archived_at) return false;
      if (!passesColumnFilters(s, filters, processedScanCellText)) return false;
      if (!q) return true;
      return haystack(s).includes(q);
    });
    return rows.sort((a, b) =>
      naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [scans, filters, query, sortKey, sortDir, haystack]);

  // Deep-link vs persisted-filter interplay — cloned from Containers.tsx.
  useEffect(() => {
    if (!scans || !openId || visible.some((s) => s.id === openId)) return;
    if (openId === deepLinkTarget.current && clearedDeepLink.current !== openId) {
      clearedDeepLink.current = openId;
      const target = scans.find((s) => s.id === openId);
      if (target && !passesColumnFilters(target, filters, processedScanCellText)) {
        clearFilters();
        return;
      }
    }
    setOpenId(null);
  }, [scans, visible, openId, filters, clearFilters]);

  useEffect(() => {
    if (deepLinkTarget.current && visible.some((s) => s.id === deepLinkTarget.current)) {
      deepLinkTarget.current = null;
    }
  }, [visible]);

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, godMode);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = listGridStyle([PRIMARY_COL, ...shownCols], ['30px'], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: god.editing ? undefined : grid.minWidth };

  const cellFor = (s: ProcessedScanRow, key: string) => {
    if (god.editing) {
      const gf = godFieldFor(key);
      if (gf) {
        return (
          <GodCell row={s} gf={gf} patch={updateProcessedScan} onRowSaved={replaceRow}
                   errorMap={SCANS_ERRORS} disabled={!canChange} />
        );
      }
    }
    switch (key) {
      case 'match':
        return (
          <div className="chips">
            <span className="chip custom" style={{ '--chip': s.match_type_color } as CSSProperties}>
              <span className="dot" />{s.match_type_label}
            </span>
            {s.archived_at && <span className="chip tag">Archived</span>}
            {pd.pendingIds.has(s.id) && <span className="chip tag">Pending delete</span>}
          </div>
        );
      case 'status':
        return statusChip(s.status_label, s.status_color) ?? <span className="cell-top">—</span>;
      case 'matched': {
        const text = s.matched_name ?? s.match_type_label;
        return matchedHref(s)
          ? (
            <Link className="record-link cell-line" to={matchedHref(s)!} title={titleFor(text)}
                  onClick={(e) => e.stopPropagation()}>
              {text} ↗
            </Link>
          )
          : <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'scanned': {
        const text = new Date(s.scanned_at).toLocaleString();
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'processed': {
        const text = new Date(s.processed_at).toLocaleString();
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'scan_type':
        return (
          <span className="chip custom" style={{ '--chip': s.scan_type_color } as CSSProperties}>
            <span className="dot" />{s.scan_type_label}
          </span>
        );
      case 'device': {
        const text = s.device_id || '—';
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'operator': {
        const text = s.operator_name ?? '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'site': {
        const text = s.site_name ?? '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'location': {
        const text = s.location_detail || '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'source': {
        const text = s.source || '—';
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
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
          <span className="result-count">{visible.length} of {scans?.length ?? 0} shown</span>
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols} godMode={godMode} onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('processed-scans', CSV_COLUMNS, visible)} />
          <GodEditToggle editing={god.editing} onToggle={god.toggle} visible={godMode && canChange} />
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load scans</b>{error}</div>}

      {!error && (
        <div className={`dir-list list-scroll${god.editing ? ' editing' : ''}`}>
          <div className="list-head" style={rowStyle}>
            <ColHead col={PRIMARY_COL} sortDir={sortKey === 'primary' ? sortDir : null}
                     onToggleSort={() => toggleSort('primary')}>
              <ColumnMenu colKey="primary" label="Value"
                          allRows={scans ?? []} filters={filters}
                          text={processedScanCellText}
                          filter={filters.primary} onFilter={setFilter}
                          sortDir={sortKey === 'primary' ? sortDir : null}
                          onSort={(dir) => setSort('primary', dir)} />
            </ColHead>
            {shownCols.map((c) => (
              <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                       onToggleSort={() => toggleSort(c.key)}
                       className={headerDrag.dropClass(c.key)}
                       dragProps={headerDrag.dragProps(c.key)}>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={scans ?? []} filters={filters}
                            text={processedScanCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </ColHead>
            ))}
            <ColumnMenu colKey="archived" label="Archived"
                        allRows={scans ?? []} filters={filters}
                        text={processedScanCellText}
                        filter={filters.archived} onFilter={setFilter}
                        sortDir={sortKey === 'archived' ? sortDir : null}
                        onSort={(dir) => setSort('archived', dir)} />
          </div>

          {scans && visible.length === 0 && (
            <div className="dir-empty">
              <b>No matches</b>Try a different filter — processed scans appear when the matcher runs.
              <EmptyClearFilters filters={filters} onClear={clearFilters} />
            </div>
          )}

          <VirtualRows rows={visible}
            renderRow={(s, vp) => {
              const open = openId === s.id;
              return (
                <div key={s.id} className={`dir-row ${open ? 'open' : ''} ${s.archived_at ? 'archived' : ''}`}
                     {...vp} style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                  <div className="row-main" style={rowStyle}
                       onClick={() => { deepLinkTarget.current = null; setOpenId(open ? null : s.id); }}>
                    <div className="cell cell-primary">
                      <div className="pn"><b className="mono" title={s.scanned_value}>{displayScanValue(s.scanned_value, s.scan_type)}</b>
                        <span>{s.matched_name ?? s.match_type_label}</span></div>
                    </div>
                    {shownCols.map((col) => (
                      <div className="cell" key={col.key}>{cellFor(s, col.key)}</div>
                    ))}
                    <div className="cell chevron-cell">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                           strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                    </div>
                  </div>

                  <div className="detail">
                    <div className="detail-clip">
                      <div className="detail-inner">
                        {open && (
                          <ProcessedScanRowDetail
                            scan={s}
                            godVisible={godMode}
                            pending={pd.pendingIds.has(s.id)}
                            onMark={() => pd.mark('processed_scan', s.id, s.scanned_value)}
                            onUnmark={() => pd.unmark(s.id)}
                          />
                        )}
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

/* ── row detail: read-only — no interactive elements besides the god
 *    delete button. ── */

function ProcessedScanRowDetail({ scan, godVisible, pending, onMark, onUnmark }: {
  scan: ProcessedScanRow; godVisible: boolean; pending: boolean;
  onMark: () => Promise<void>; onUnmark: () => Promise<void>;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-block">
        <p className="eyebrow-sm">Scan</p>
        <dl className="kv">
          <dt>Value</dt><dd className="mono">{scan.scanned_value}</dd>
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
        <p className="eyebrow-sm">Match</p>
        <dl className="kv">
          <dt>Match type</dt><dd>{scan.match_type_label}</dd>
          <dt>Matched record</dt>
          <dd>{matchedHref(scan) ? (
            <Link className="record-link" to={matchedHref(scan)!}>
              {scan.matched_name ?? scan.match_type_label} ↗
            </Link>
          ) : (scan.matched_name ?? '—')}</dd>
          <dt>Processed</dt><dd>{new Date(scan.processed_at).toLocaleString()}</dd>
          <dt>Raw scan id</dt>
          <dd className="mono">{scan.raw_scan_id ?? '—'}</dd>
          <dt>Record id</dt><dd className="mono">{scan.id}</dd>
        </dl>
      </div>
      {godVisible && (
        <div className="detail-actions" style={{ gridColumn: '1 / -1' }}>
          <GodDeleteButton visible={godVisible} entityType="processed_scan"
                           entityId={scan.id} label={scan.scanned_value}
                           pending={pending}
                           onChange={pending ? onUnmark : onMark} />
        </div>
      )}
    </div>
  );
}
