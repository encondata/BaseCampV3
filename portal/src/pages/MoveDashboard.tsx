/**
 * Move Dashboard (/dashboards/move) — live ops view of one move
 * initiative. Mirrors the initiative full-detail page's asset side
 * (roster, weighted progress, status breakdown) while dropping the
 * planning chrome (partners, links, people admin). A move selector
 * defaults to the running move, and an auto-refresh selector re-pulls
 * the roster on a fixed cadence for wall-screen use.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  listAssetStatuses, listInitiativeAssets, listInitiatives,
  type InitiativeAssetRow, type InitiativeItem, type StatusValue,
} from '../lib/api';
import {
  MOVE_ASSET_COLUMNS, moveAssetCellText, moveAssetProgress, moveAssetStatusBreakdown,
} from '../lib/initiatives';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState,
} from '../lib/columnMenu';
import {
  applyColumnOrder, ColumnsButton, ExportButton, exportCsv, moveKey,
  useReorderDrag, useSearchHaystacks, visibleColumnsFor,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import { naturalCompare } from '../lib/sites';
import RackViewModal from '../components/initiatives/RackViewModal';
import StatusHover from '../components/StatusHover';
import { Distribution, type DistEntry } from '../components/dashboard/charts';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/dashboard.css';

const REFRESH_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '15s', seconds: 15 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
];

const nf = new Intl.NumberFormat();

/* ── roster list machinery — mirrors InitiativeDetail's Assets section
      (read-only: no edit-table, no row actions), sharing the same column
      defs and cell-text helpers so the two lists never drift. ───────── */

const MOVE_ASSET_ALL_COLUMN_KEYS = new Set<string>(MOVE_ASSET_COLUMNS.map((c) => c.key));
// The dashboard also shows Updated by default (hidden on the detail page):
// with the newest-update sort it's the column that explains the order.
const MOVE_ASSET_DEFAULT_VISIBLE = new Set<string>([
  ...MOVE_ASSET_COLUMNS.filter((c) => c.default).map((c) => c.key), 'updated']);

/** Same centered-column set as InitiativeDetail's assets table. */
const ASSET_CENTERED_COLS = new Set<string>([
  'status', 'source_ru', 'destination_ru', 'source_position',
  'destination_position', 'source_verified', 'destination_verified',
]);

/** CSV export always mirrors the full column set (list-page convention). */
const ASSET_CSV_COLUMNS: [string, (r: InitiativeAssetRow) => string][] =
  MOVE_ASSET_COLUMNS.map((c) => [c.label, (r: InitiativeAssetRow) => moveAssetCellText(r, c.key)]);

function statusChip(label: string | null, color: string | null) {
  if (!label) return null;
  return (
    <span className="chip custom" style={{ '--chip': color ?? '#51606f' } as CSSProperties}>
      <span className="dot" />{label}
    </span>
  );
}

/** Selector ordering: running first, then upcoming, then the rest. */
function moveOrder(a: InitiativeItem, b: InitiativeItem): number {
  const rank = (s: string) =>
    s === 'in_progress' ? 0 : s === 'scheduled' ? 1 : s === 'planned' ? 2
      : s === 'on_hold' ? 3 : 4;
  if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default function MoveDashboard() {
  const { can } = useAuth();
  const canInitiatives = can('initiatives');

  const [moves, setMoves] = useState<InitiativeItem[] | null>(null);
  const [assetStatuses, setAssetStatuses] = useState<StatusValue[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [roster, setRoster] = useState<InitiativeAssetRow[] | null>(null);
  const [refreshSec, setRefreshSec] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [assetsQuery, setAssetsQuery] = useState('');
  const [rackView, setRackView] = useState<
    { rackName: string; side: 'source' | 'destination' } | null>(null);

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'move_dashboard_assets',
    { visible: MOVE_ASSET_DEFAULT_VISIBLE, sortKey: 'wave', sortDir: 1 },
    MOVE_ASSET_ALL_COLUMN_KEYS,
  );
  const orderedCols = applyColumnOrder(MOVE_ASSET_COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(
      moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );

  // moves + vocabulary, once
  useEffect(() => {
    if (!canInitiatives) return;
    let alive = true;
    listInitiatives()
      .then((items) => {
        if (!alive) return;
        const moveItems = items
          .filter((i) => i.initiative_type === 'move' && !i.archived_at)
          .sort(moveOrder);
        setMoves(moveItems);
        setSelectedId((prev) => prev ?? moveItems[0]?.id ?? null);
      })
      .catch(() => setMoves([]));
    listAssetStatuses().then((s) => { if (alive) setAssetStatuses(s); }).catch(() => undefined);
    return () => { alive = false; };
  }, [canInitiatives]);

  const loadRoster = useCallback((id: string, initial: boolean) => {
    if (initial) setRoster(null);
    listInitiativeAssets(id)
      .then((rows) => {
        setRoster(rows);
        setUpdatedAt(new Date());
      })
      .catch(() => { if (initial) setRoster([]); });
  }, []);

  // roster on selection change
  useEffect(() => {
    if (selectedId) loadRoster(selectedId, true);
  }, [selectedId, loadRoster]);

  // auto-refresh cadence
  useEffect(() => {
    if (!refreshSec || !selectedId) return;
    const t = setInterval(() => loadRoster(selectedId, false), refreshSec * 1000);
    return () => clearInterval(t);
  }, [refreshSec, selectedId, loadRoster]);

  const move = useMemo(
    () => (moves ?? []).find((m) => m.id === selectedId) ?? null,
    [moves, selectedId],
  );

  /* ── derived ─────────────────────────────────────────────── */

  const rows = roster ?? [];
  const progress = useMemo(
    () => moveAssetProgress(rows, assetStatuses),
    [rows, assetStatuses],
  );
  const breakdown = useMemo<DistEntry[]>(
    () => moveAssetStatusBreakdown(rows, assetStatuses)
      .map((e) => ({ key: e.key, label: e.label, color: e.color, count: e.count })),
    [rows, assetStatuses],
  );
  const completeCount = useMemo(
    () => rows.filter((r) => r.status === 'complete').length,
    [rows],
  );
  const sourceVerified = useMemo(
    () => rows.filter((r) => r.source_verified === true).length,
    [rows],
  );
  const destVerified = useMemo(
    () => rows.filter((r) => r.destination_verified === true).length,
    [rows],
  );
  const waves = useMemo(() => {
    const byWave = new Map<string, number>();
    for (const r of rows) {
      const key = r.priority_wave?.trim() || 'Unassigned';
      byWave.set(key, (byWave.get(key) ?? 0) + 1);
    }
    return [...byWave.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => {
        if (a.label === 'Unassigned') return 1;
        if (b.label === 'Unassigned') return -1;
        return a.label.localeCompare(b.label, undefined, { numeric: true });
      });
  }, [rows]);
  const maxWave = Math.max(...waves.map((w) => w.count), 1);

  const haystackText = useCallback((a: InitiativeAssetRow) =>
    MOVE_ASSET_COLUMNS.map((c) => moveAssetCellText(a, c.key)).join(' ').toLowerCase(), []);
  const haystack = useSearchHaystacks(rows, haystackText);

  // Same filter + sort semantics as InitiativeDetail's assets table,
  // including wave's blanks-last rule and the serial tiebreak.
  const visibleAssets = useMemo(() => {
    const q = assetsQuery.trim().toLowerCase();
    const filtered = rows.filter((a) => {
      if (!passesColumnFilters(a, filters, moveAssetCellText)) return false;
      if (!q) return true;
      return haystack(a).includes(q);
    });
    return filtered.sort((a, b) => {
      // Timestamp columns sort by the real instant, not the locale date
      // text (which would collapse same-day updates and sort wrong) —
      // this is what makes "newest status update first" exact.
      if (sortKey === 'updated' || sortKey === 'added') {
        const field = sortKey === 'updated' ? 'updated_at' : 'created_at';
        return (Date.parse(a[field]) - Date.parse(b[field])) * sortDir;
      }
      const aText = moveAssetCellText(a, sortKey);
      const bText = moveAssetCellText(b, sortKey);
      if (sortKey === 'wave') {
        const aBlank = aText === '—';
        const bBlank = bText === '—';
        if (aBlank !== bBlank) return aBlank ? 1 : -1;
      }
      const primary = naturalCompare(aText, bText) * sortDir;
      if (primary !== 0) return primary;
      if (sortKey === 'wave') {
        return naturalCompare(moveAssetCellText(a, 'serial'), moveAssetCellText(b, 'serial'))
          * sortDir;
      }
      return 0;
    });
  }, [rows, filters, assetsQuery, sortKey, sortDir, haystack]);

  const rosterGrid = { gridTemplateColumns: shownCols.map((c) => c.width).join(' ') };
  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  /** Read-only cell renderer — InitiativeDetail's assetCellFor minus the
   *  edit-table branch and row actions. Rack cells still open the
   *  elevation modal. */
  const cellFor = (a: InitiativeAssetRow, key: string) => {
    if (key === 'status') {
      return (
        <StatusHover entityType="initiative_asset" entityId={a.id} status={a.status}>
          {statusChip(a.status_label, a.status_color)
            ?? <span className="cell-top">{a.status_label}</span>}
        </StatusHover>
      );
    }
    if (key === 'asset_status') {
      return (
        <StatusHover entityType="asset" entityId={a.asset_id} status={a.asset.status}>
          {statusChip(a.asset.status_label, a.asset.status_color)
            ?? <span className="cell-top">{a.asset.status_label}</span>}
        </StatusHover>
      );
    }
    if (key === 'source_verified' || key === 'destination_verified') {
      const verified = key === 'source_verified' ? a.source_verified : a.destination_verified;
      if (verified) {
        return (
          <span className="cell-top idet-verified-yes">
            Yes
            <svg className="idet-check-yes" viewBox="0 0 12 12" fill="none"
                 stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
                 strokeLinejoin="round">
              <path d="M2 6.5 4.8 9.5 10 2.8" />
            </svg>
          </span>
        );
      }
    }
    if (key === 'source_rack' || key === 'destination_rack') {
      const side: 'source' | 'destination' =
        key === 'source_rack' ? 'source' : 'destination';
      const rackName = side === 'source' ? a.source_rack : a.destination_rack;
      if (rackName) {
        return (
          <button type="button" className="idet-rack-cell-btn"
                  onClick={() => setRackView({ rackName, side })}>
            {rackName}
          </button>
        );
      }
    }
    return <span className="cell-top">{moveAssetCellText(a, key)}</span>;
  };

  /* ── render ──────────────────────────────────────────────── */

  const skel = <span className="dash-skel" aria-label="loading" />;

  if (!canInitiatives) {
    return (
      <div className="portal-page">
        <div className="eyebrow">Dashboards</div>
        <h1 className="page-title">Move Dashboard</h1>
        <p className="page-hint">You don't have access to initiatives, so there's nothing to show here.</p>
      </div>
    );
  }

  return (
    <div className="portal-page">
      <div className="eyebrow">Dashboards</div>
      <div className="dash-head">
        <h1 className="page-title">Move Dashboard</h1>
        <div className="dash-ctrls">
          <label className="dash-ctrl">
            <span>Move</span>
            <select value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value)}
                    disabled={!moves || moves.length === 0}>
              {(moves ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.status_label}
                </option>
              ))}
            </select>
          </label>
          <label className="dash-ctrl">
            <span>Auto-refresh</span>
            <select value={refreshSec} onChange={(e) => setRefreshSec(Number(e.target.value))}>
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds}>{o.label}</option>
              ))}
            </select>
          </label>
          {updatedAt && (
            <span className="dash-asof">
              {refreshSec > 0 && <span className="dash-asof-dot" aria-hidden="true" />}
              updated {updatedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {moves !== null && moves.length === 0 && (
        <p className="page-hint">
          No move initiatives yet. <Link className="dash-panel-link" to="/initiatives">Create one</Link>
        </p>
      )}

      {move && (
        <div className="dash-grid">
          {/* ── move summary strip ── */}
          <section className="dash-panel mdash-summary dash-span-12 dash-rise" aria-label="Move summary">
            <div className="mdash-summary-main">
              <span className="mdash-summary-name">{move.name}</span>
              <StatusHover entityType="initiative" entityId={move.id} status={move.status}>
                <span className="chip custom" style={{ '--chip': move.status_color } as CSSProperties}>
                  <span className="dot" />{move.status_label}
                </span>
              </StatusHover>
            </div>
            <span className="mdash-summary-route">
              <span className="code">{move.origin_site_name ?? 'TBD'}</span>
              <span className="arrow" aria-hidden="true">→</span>
              <span className="code">{move.destination_site_name ?? 'TBD'}</span>
            </span>
            <span className="mdash-summary-window">
              {fmtDate(move.scheduled_start)} → {fmtDate(move.scheduled_end)}
            </span>
            <Link className="dash-panel-link" to={`/initiatives/${move.id}`}>Full details</Link>
          </section>

          {/* ── KPI band ── */}
          <div className="dash-kpis dash-rise">
            <div className="dash-kpi">
              <span className="dash-kpi-label">Assets on move</span>
              <span className="dash-kpi-value">{roster ? nf.format(rows.length) : skel}</span>
              <span className="dash-kpi-sub">
                {roster ? <><strong>{nf.format(progress.countable)}</strong> counted toward progress</> : ''}
              </span>
            </div>
            <div className="dash-kpi">
              <span className="dash-kpi-label">Progress</span>
              <span className="dash-kpi-value">{roster ? `${progress.pct}%` : skel}</span>
              <span className="dash-kpi-sub">{roster ? 'weighted by status' : ''}</span>
            </div>
            <div className="dash-kpi">
              <span className="dash-kpi-label">Complete</span>
              <span className="dash-kpi-value">{roster ? nf.format(completeCount) : skel}</span>
              <span className="dash-kpi-sub">
                {roster ? <>of <strong>{nf.format(rows.length)}</strong> assets</> : ''}
              </span>
            </div>
            <div className="dash-kpi">
              <span className="dash-kpi-label">Racks verified</span>
              <span className="dash-kpi-value">
                {roster ? nf.format(sourceVerified + destVerified) : skel}
              </span>
              <span className="dash-kpi-sub">
                {roster ? <><strong>{nf.format(sourceVerified)}</strong> source · <strong>{nf.format(destVerified)}</strong> destination</> : ''}
              </span>
            </div>
            <div className="dash-kpi mdash-kpi-soon">
              <span className="dash-kpi-label">Workers on site</span>
              <span className="dash-kpi-value">—</span>
              <span className="dash-kpi-sub">coming soon</span>
            </div>
          </div>

          {/* ── status breakdown ── */}
          <section className="dash-panel dash-span-4 dash-rise" aria-label="Assets by status">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Assets by status</span>
            </div>
            {roster === null && <div className="dash-panel-empty">Loading…</div>}
            {roster !== null && rows.length === 0 && (
              <div className="dash-panel-empty">No assets on this move yet.</div>
            )}
            {roster !== null && rows.length > 0 && (
              <Distribution entries={breakdown} total={rows.length} />
            )}
          </section>

          {/* ── priority waves ── */}
          <section className="dash-panel dash-span-4 dash-rise" aria-label="Assets by wave">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Priority waves</span>
            </div>
            {roster === null && <div className="dash-panel-empty">Loading…</div>}
            {roster !== null && rows.length === 0 && (
              <div className="dash-panel-empty">No assets on this move yet.</div>
            )}
            <div className="mdash-waves">
              {waves.map((w) => (
                <div key={w.label} className="mdash-wave-row">
                  <span className="mdash-wave-label">{w.label}</span>
                  <span className="mdash-wave-track">
                    <span className="mdash-wave-fill" style={{ width: `${(w.count / maxWave) * 100}%` }} />
                  </span>
                  <span className="mdash-wave-count">{nf.format(w.count)}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ── rack verification ── */}
          <section className="dash-panel dash-span-4 dash-rise" aria-label="Rack verification">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Rack verification</span>
            </div>
            {roster === null && <div className="dash-panel-empty">Loading…</div>}
            {roster !== null && rows.length === 0 && (
              <div className="dash-panel-empty">No assets on this move yet.</div>
            )}
            {roster !== null && rows.length > 0 && (
              <div className="mdash-verify">
                {([
                  ['Source racks', sourceVerified],
                  ['Destination racks', destVerified],
                ] as const).map(([label, n]) => (
                  <div key={label} className="mdash-verify-row">
                    <div className="mdash-verify-head">
                      <span>{label}</span>
                      <span className="mdash-verify-n">{nf.format(n)} / {nf.format(rows.length)}</span>
                    </div>
                    <div className="mdash-verify-track">
                      <div className="mdash-verify-fill"
                           style={{ width: `${rows.length ? (n / rows.length) * 100 : 0}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── asset roster — mirrors InitiativeDetail's assets table
                (shared columns, per-column filters, sort, column picker,
                CSV export); read-only here ── */}
          <section className="dash-panel mdash-roster dash-span-12 dash-rise" aria-label="Asset roster">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Asset roster</span>
            </div>
            {roster === null && <div className="dash-panel-empty">Loading…</div>}
            {roster !== null && rows.length === 0 && (
              <div className="dash-panel-empty">
                No assets on this move yet. <Link className="dash-panel-link" to={`/initiatives/${move.id}`}>Import assets</Link>
              </div>
            )}
            {roster !== null && rows.length > 0 && (
              <>
                <div className="dir-toolbar idet-assets-toolbar">
                  <div className="toolbar-right">
                    <div className="dir-search" style={{ marginLeft: 0 }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           strokeWidth="2" strokeLinecap="round">
                        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                      <input placeholder="Filter assets…" value={assetsQuery}
                             onChange={(e) => setAssetsQuery(e.target.value)} />
                    </div>
                    <span className="result-count">
                      {visibleAssets.length} of {rows.length} shown</span>
                    <button type="button"
                            className={`mini-btn sm${sortKey === 'updated' && sortDir === -1 ? ' mdash-sort-on' : ''}`}
                            title="Sort by most recent status update, newest first — persists across refreshes"
                            onClick={() => (sortKey === 'updated' && sortDir === -1
                              ? setSort('wave', 1)
                              : setSort('updated', -1))}>
                      Newest updates
                    </button>
                    <FilterSummaryChip filters={filters} onClear={clearFilters} />
                    <ColumnsButton columns={orderedCols} visible={visibleCols}
                                   onChange={setVisibleCols}
                                   onReorder={setColOrder} />
                    <ExportButton onExport={() =>
                      exportCsv('move-assets', ASSET_CSV_COLUMNS, visibleAssets)} />
                  </div>
                </div>

                <div className="dir-list idet-assets-list">
                  <div className="list-head" style={rosterGrid}>
                    {shownCols.map((c) => (
                      <span key={c.key}
                            className={`col-head ${headerDrag.dropClass(c.key)}`
                              + `${ASSET_CENTERED_COLS.has(c.key) ? ' idet-col-center' : ''}`}
                            {...headerDrag.dragProps(c.key)}>
                        <button type="button" className="sortable"
                                onClick={() => toggleSort(c.key)}>
                          {c.label} {caret(c.key)}
                        </button>
                        <ColumnMenu colKey={c.key} label={c.label}
                                    allRows={rows} filters={filters}
                                    text={moveAssetCellText}
                                    filter={filters[c.key]} onFilter={setFilter}
                                    sortDir={sortKey === c.key ? sortDir : null}
                                    onSort={(dir) => setSort(c.key, dir)} />
                      </span>
                    ))}
                  </div>

                  {visibleAssets.length === 0 && (
                    <div className="dir-empty">
                      <b>No matches</b>Try a different search or filter.
                      <EmptyClearFilters filters={filters} onClear={clearFilters} />
                    </div>
                  )}

                  <VirtualRows rows={visibleAssets}
                    renderRow={(a, vp) => (
                      <div key={a.id} className="dir-row" {...vp} style={vp?.style}>
                        <div className="row-main mdash-row-static" style={rosterGrid}>
                          {shownCols.map((c) => (
                            <div className={`cell${ASSET_CENTERED_COLS.has(c.key)
                              ? ' idet-col-center' : ''}`}
                                 key={c.key}>{cellFor(a, c.key)}</div>
                          ))}
                        </div>
                      </div>
                    )} />
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {rackView && (
        <RackViewModal rackName={rackView.rackName} side={rackView.side}
                       rows={rows} onClose={() => setRackView(null)} />
      )}
    </div>
  );
}
