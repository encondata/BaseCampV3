/**
 * /reports — two tabs: Available (report definitions; Generate / Edit /
 * Clone / Delete per row) and History (report runs; Task 9). Standard
 * directory list scaffolding, same as LabelTemplates.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  ApiError, cloneReportDefinition, deleteReportDefinition, listReportDefinitions,
  type ReportDefinition,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../lib/columnMenu';
import {
  ColumnsButton, applyColumnOrder, moveKey, useReorderDrag, useSearchHaystacks,
  visibleColumnsFor, type ColumnDef,
} from '../lib/listTools';
import { sectionCount } from '../lib/reports';
import { VirtualRows } from '../lib/virtualRows';
import { RowActionsMenu } from '../components/hardware/RowActionsMenu';
import EditDefinitionModal from '../components/reports/EditDefinitionModal';
import GenerateReportModal from '../components/reports/GenerateReportModal';
import HistoryTab from '../components/reports/HistoryTab';
import '../styles/directory.css';
import '../styles/profile.css';   /* .pf-form, .pf-error, .btn-solid (Edit modal) */
import '../styles/settings.css';  /* .switch (Edit modal) */
import '../styles/reports.css';

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.6fr', default: true },
  { key: 'report_type', label: 'Type', width: '1fr', default: true },
  { key: 'description', label: 'Description', width: '2fr', default: true },
  { key: 'sections', label: 'Sections', width: '0.8fr', default: true },
  { key: 'updated_at', label: 'Updated', width: '1fr', default: true },
  { key: 'is_system', label: 'Kind', width: '0.7fr', default: true },
];
const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));
const TYPE_LABELS: Record<string, string> = { move_report: 'Move Report' };
const TOTAL_SECTIONS = 8;
const TOAST_MS = 4000;

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? err.message || `Request failed (${err.code}).` : "Couldn't complete that action.";

type Tab = 'available' | 'history';

export default function Reports() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'history' ? 'history' : 'available';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    next.delete('run');
    setParams(next, { replace: true });
  };
  const canAdd = can('reports', 'add');
  const canChange = can('reports', 'change');
  const canDelete = can('reports', 'delete');

  const [defs, setDefs] = useState<ReportDefinition[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ReportDefinition | null>(null);
  const [generating, setGenerating] = useState<ReportDefinition | null>(null);
  const [runCount, setRunCount] = useState<number | null>(null);
  // Minimal local toast — Task 10 replaces it with the shared ToastHost.
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(''), TOAST_MS);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const {
    visibleCols, setVisibleCols, sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters, colOrder, setColOrder,
  } = usePersistentListState(
    'reports-definitions', { visible: DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      setDefs(await listReportDefinitions());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? "You don't have access to reports." : "Couldn't load reports.");
    }
  };
  useEffect(() => { void load(); }, []);

  const cellText: CellText<ReportDefinition> = (d, key) => {
    switch (key) {
      case 'report_type': return TYPE_LABELS[d.report_type] ?? d.report_type;
      case 'description': return d.description;
      case 'sections': return `${sectionCount(d.options)} of ${TOTAL_SECTIONS}`;
      case 'updated_at': return d.updated_at;
      case 'is_system': return d.is_system ? 'System' : 'Custom';
      default: return d.name;
    }
  };
  const sortValue = (d: ReportDefinition, key: string): string | number =>
    key === 'sections' ? sectionCount(d.options) : cellText(d, key).toLowerCase();
  const haystack = useSearchHaystacks(defs, (d) =>
    `${d.name} ${d.description} ${cellText(d, 'report_type')}`.toLowerCase());

  const visible = useMemo(() => {
    if (!defs) return [];
    const q = query.trim().toLowerCase();
    return defs
      .filter((d) => passesColumnFilters(d, filters, cellText) && (!q || haystack(d).includes(q)))
      .sort((a, b) => {
        const va = sortValue(a, sortKey), vb = sortValue(b, sortKey);
        return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defs, filters, query, sortKey, sortDir, haystack]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;
  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 100px` };

  const clone = async (d: ReportDefinition) => {
    setError('');
    try { await cloneReportDefinition(d.id); await load(); } catch (err) { setError(msgFor(err)); }
  };
  const remove = async (d: ReportDefinition) => {
    if (!window.confirm(`Delete "${d.name}"? Past runs keep their PDFs.`)) return;
    setError('');
    try { await deleteReportDefinition(d.id); await load(); } catch (err) { setError(msgFor(err)); }
  };

  const cellFor = (d: ReportDefinition, key: string) => {
    switch (key) {
      case 'name': return <span className="cell-primary">{d.name}</span>;
      case 'description': return <span>{d.description || '—'}</span>;
      case 'updated_at': return <span>{new Date(d.updated_at).toLocaleDateString()}</span>;
      case 'is_system': return d.is_system
        ? <span className="chip c-slate">System</span>
        : <span className="cell-sub">—</span>;
      default: return <span>{cellText(d, key)}</span>;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Reports</div>
          <h1 className="page-title">Reports</h1>
          <p className="page-hint">Generate PDF reports and review what has been generated.</p>
        </div>
      </div>

      <div className="segmented reports-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'available'}
                className={tab === 'available' ? 'on' : ''} onClick={() => setTab('available')}>
          Available <span className="n">{defs?.length ?? 0}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'history'}
                className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
          History {runCount != null && <span className="n">{runCount}</span>}
        </button>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>{defs ? "Couldn't complete that action" : 'Cannot load reports'}</b>{error}
        </div>
      )}

      {tab === 'history' && (
        <HistoryTab highlightRunId={params.get('run')} onCount={setRunCount} />
      )}

      {tab === 'available' && defs && (
        <>
          <div className="dir-toolbar">
            <div className="toolbar-right">
              <div className="dir-search" style={{ marginLeft: 0 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <input placeholder="Filter this list…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <span className="result-count">{visible.length} of {defs.length} shown</span>
              <FilterSummaryChip filters={filters} onClear={clearFilters} />
              <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                             onReorder={setColOrder} />
            </div>
          </div>
          <div className="dir-list">
            <div className="list-head" style={grid}>
              {shownCols.map((c) => (
                <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                      {...headerDrag.dragProps(c.key)}>
                  <button className="sortable" onClick={() => toggleSort(c.key)}>{c.label} {caret(c.key)}</button>
                  <ColumnMenu colKey={c.key} label={c.label} allRows={defs} filters={filters}
                              text={cellText} filter={filters[c.key]} onFilter={setFilter}
                              sortDir={sortKey === c.key ? sortDir : null}
                              onSort={(dir) => setSort(c.key, dir)} />
                </span>
              ))}
              <span />
            </div>
            {visible.length === 0 && (
              <div className="dir-empty">
                <b>No matches</b>Try a different filter.
                <EmptyClearFilters filters={filters} onClear={clearFilters} />
              </div>
            )}
            <VirtualRows rows={visible} renderRow={(d, vp) => (
              <div key={d.id} className="dir-row" {...vp} style={vp?.style}>
                <div className="row-main" style={grid}>
                  {shownCols.map((c) => <div className="cell" key={c.key}>{cellFor(d, c.key)}</div>)}
                  <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <RowActionsMenu actions={[
                      ...(canAdd ? [{ key: 'generate', label: 'Generate', onSelect: () => setGenerating(d) }] : []),
                      ...(canChange ? [{ key: 'edit', label: 'Edit', onSelect: () => setEditing(d) }] : []),
                      ...(canAdd ? [{ key: 'clone', label: 'Clone', onSelect: () => void clone(d) }] : []),
                      ...(canDelete && !d.is_system
                        ? [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => void remove(d) }]
                        : []),
                    ]} />
                  </div>
                </div>
              </div>
            )} />
          </div>
        </>
      )}

      {editing && (
        <EditDefinitionModal definition={editing} onClose={() => setEditing(null)}
                             onSaved={() => { setEditing(null); void load(); }} />
      )}
      {generating && (
        <GenerateReportModal definition={generating} onClose={() => setGenerating(null)}
                             onToast={showToast} />
      )}
      {toast && <div role="status" className="toast">{toast}</div>}
    </div>
  );
}
