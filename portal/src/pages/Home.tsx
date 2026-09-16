/**
 * Main Dashboard (/) — the ops landing page. Mission-control layout:
 * KPI band, initiative flight board (the signature element), scan
 * activity (server-aggregated — raw_scans is too big to ship), asset
 * fleet distribution, the site network map, and recent audit activity.
 * Every panel is permission-gated with can(resource) and the page
 * degrades to whatever subset the viewer is allowed to see.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  listAssets, listAssetStatuses, listAuditLog, listContainers,
  listInitiativeAssets, listInitiatives, listProcessedScans,
  listScanDailyStats, listSites,
  type AssetItem, type AuditLogItem, type ContainerItem,
  type InitiativeItem, type ProcessedScanRow, type ScanDailyStat,
  type SiteItem, type StatusValue,
} from '../lib/api';
import { moveAssetProgress } from '../lib/initiatives';
import { actionLabel, targetLabel } from '../lib/auditFormat';
import { relativeTime } from '../lib/format';
import { parseApiDay } from '../lib/timeline';
import { DailyBars, Distribution, Sparkline, type DistEntry } from '../components/dashboard/charts';
import DashSitesMap from '../components/dashboard/DashSitesMap';
import TransitMap from '../components/dashboard/TransitMap';
import '../styles/directory.css';
import '../styles/dashboard.css';

const ACTIVE_INITIATIVE_STATUSES = new Set(['planned', 'scheduled', 'in_progress', 'on_hold']);
/** Board rows whose weighted progress we compute — capped so the landing
 *  page never fans out into dozens of roster fetches. */
const MAX_PROGRESS_FETCHES = 5;
const SCAN_DAYS = 14;
/** preferences.update is by far the noisiest audit action (UI prefs
 *  autosave) — it would drown the feed in identical rows. */
const FEED_HIDDEN_ACTIONS = new Set(['preferences.update']);
const FEED_ROWS = 9;

const nf = new Intl.NumberFormat();

function fmtDay(isoDay: string): string {
  return new Date(`${isoDay}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  });
}

/** Departure-board window: one or two stacked mono lines. */
function windowLines(start: string | null, end: string | null): string[] {
  if (!start && !end) return ['unscheduled'];
  const thisYear = new Date().getFullYear();
  const fmt = (iso: string) => {
    // scheduled_start/scheduled_end are date-only fields (midnight UTC for
    // a plain YYYY-MM-DD input) — parseApiDay reads the Y-M-D digits into
    // a local Date, since `new Date(iso)` would land on the previous
    // evening west of UTC and name the day before.
    const d = parseApiDay(iso);
    return d.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric',
      ...(d.getFullYear() !== thisYear ? { year: 'numeric' } : {}),
    });
  };
  if (start && end) return [fmt(start), `→ ${fmt(end)}`];
  return start ? [`from ${fmt(start)}`] : [`by ${fmt(end!)}`];
}

/** Board ordering: running work first, then by soonest scheduled start. */
function boardOrder(a: InitiativeItem, b: InitiativeItem): number {
  const rank = (s: string) => (s === 'in_progress' ? 0 : s === 'scheduled' ? 1 : s === 'planned' ? 2 : 3);
  if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
  const at = a.scheduled_start ? Date.parse(a.scheduled_start) : Infinity;
  const bt = b.scheduled_start ? Date.parse(b.scheduled_start) : Infinity;
  return at - bt;
}

export default function Home() {
  const { can, mustChangePassword, scope } = useAuth();
  const navigate = useNavigate();

  const [assets, setAssets] = useState<AssetItem[] | null>(null);
  const [sites, setSites] = useState<SiteItem[] | null>(null);
  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [containers, setContainers] = useState<ContainerItem[] | null>(null);
  const [scanDays, setScanDays] = useState<ScanDailyStat[] | null>(null);
  const [audit, setAudit] = useState<AuditLogItem[] | null>(null);
  const [assetStatuses, setAssetStatuses] = useState<StatusValue[] | null>(null);
  const [recentScans, setRecentScans] = useState<ProcessedScanRow[] | null>(null);
  const [progressById, setProgressById] = useState<Record<string, { pct: number; countable: number }>>({});

  const canAssets = can('assets');
  const canSites = can('sites');
  const canInitiatives = can('initiatives');
  const canContainers = can('containers');
  const canScans = can('scans');
  const canAudit = can('audit');

  useEffect(() => {
    let alive = true;
    const guard = <T,>(setter: (v: T) => void) => (v: T) => { if (alive) setter(v); };
    const quiet = () => undefined; // a failed panel stays in its loading/empty state
    if (canAssets) listAssets().then(guard(setAssets)).catch(quiet);
    if (canSites) listSites().then(guard(setSites)).catch(quiet);
    if (canContainers) listContainers().then(guard(setContainers)).catch(quiet);
    if (canScans) {
      listScanDailyStats(SCAN_DAYS).then(guard(setScanDays)).catch(quiet);
      listProcessedScans().then(guard(setRecentScans)).catch(quiet);
    }
    if (canAudit) listAuditLog({ limit: 100 }).then(guard(setAudit)).catch(quiet);
    if (canInitiatives) {
      listInitiatives().then(guard(setInitiatives)).catch(quiet);
      listAssetStatuses().then(guard(setAssetStatuses)).catch(quiet);
    }
    return () => { alive = false; };
  }, [canAssets, canSites, canContainers, canScans, canAudit, canInitiatives]);

  const board = useMemo(
    () => (initiatives ?? [])
      .filter((i) => !i.archived_at && ACTIVE_INITIATIVE_STATUSES.has(i.status))
      .sort(boardOrder),
    [initiatives],
  );

  // weighted progress for the board's move rows — one roster fetch each
  useEffect(() => {
    if (!assetStatuses || board.length === 0) return;
    let alive = true;
    const moves = board.filter((i) => i.initiative_type === 'move').slice(0, MAX_PROGRESS_FETCHES);
    moves.forEach((init) => {
      listInitiativeAssets(init.id)
        .then((rows) => {
          if (!alive || rows.length === 0) return;
          setProgressById((prev) => ({
            ...prev, [init.id]: moveAssetProgress(rows, assetStatuses),
          }));
        })
        .catch(() => undefined);
    });
    return () => { alive = false; };
  }, [board, assetStatuses]);

  /* ── derived numbers ─────────────────────────────────────── */

  const liveAssets = useMemo(() => (assets ?? []).filter((a) => !a.archived_at), [assets]);
  const liveSites = useMemo(() => (sites ?? []).filter((s) => !s.archived_at), [sites]);
  const liveContainers = useMemo(() => (containers ?? []).filter((c) => !c.archived_at), [containers]);

  const assetDist = useMemo<DistEntry[]>(() => {
    const byKey = new Map<string, DistEntry>();
    for (const a of liveAssets) {
      const e = byKey.get(a.status);
      if (e) e.count += 1;
      else byKey.set(a.status, { key: a.status, label: a.status_label, color: a.status_color, count: 1 });
    }
    return [...byKey.values()].sort((x, y) => y.count - x.count);
  }, [liveAssets]);

  const inTransit = useMemo(
    () => liveAssets.filter((a) => a.status === 'in_transit').length,
    [liveAssets],
  );
  const activeSites = useMemo(
    () => liveSites.filter((s) => s.status === 'active').length,
    [liveSites],
  );
  const datacenters = useMemo(
    () => liveSites.filter((s) => s.site_type === 'datacenter').length,
    [liveSites],
  );

  const scansToday = scanDays?.length ? scanDays[scanDays.length - 1].count : 0;
  const scans7d = useMemo(
    () => (scanDays ?? []).slice(-7).reduce((sum, d) => sum + d.count, 0),
    [scanDays],
  );

  const activeMoves = useMemo(
    () => board.filter((i) => i.initiative_type === 'move'),
    [board],
  );
  const latestScans = useMemo(() => (recentScans ?? []).slice(0, 8), [recentScans]);

  const feed = useMemo(
    () => (audit ?? []).filter((r) => !FEED_HIDDEN_ACTIONS.has(r.action)).slice(0, FEED_ROWS),
    [audit],
  );

  const barDays = useMemo(
    () => (scanDays ?? []).map((d) => ({ key: d.day, label: fmtDay(d.day), value: d.count })),
    [scanDays],
  );

  /* ── render ──────────────────────────────────────────────── */

  const skel = <span className="dash-skel" aria-label="loading" />;

  if (scope && !scope.global && scope.client_ids.length > 0) {
    return <Navigate to="/dashboards/clients" replace />;
  }

  return (
    <div className="portal-page">
      {mustChangePassword && (
        <div className="portal-banner">
          Your password was set by an administrator — please change it once
          password management ships.
        </div>
      )}
      <div className="eyebrow">Dashboards</div>
      <div className="dash-head">
        <h1 className="page-title">Main Dashboard</h1>
        <div className="dash-asof">
          <span className="dash-asof-dot" aria-hidden="true" />
          {new Date().toLocaleDateString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
          })}
        </div>
      </div>

      <div className="dash-grid">
        {/* ── KPI band ── */}
        <div className="dash-kpis dash-rise">
          {canAssets && (
            <Link to="/assets" className="dash-kpi">
              <span className="dash-kpi-label">Assets</span>
              <span className="dash-kpi-value">{assets ? nf.format(liveAssets.length) : skel}</span>
              <span className="dash-kpi-sub">
                {assets ? <><strong>{nf.format(inTransit)}</strong> in transit</> : ''}
              </span>
            </Link>
          )}
          {canSites && (
            <Link to="/sites" className="dash-kpi">
              <span className="dash-kpi-label">Sites</span>
              <span className="dash-kpi-value">{sites ? nf.format(liveSites.length) : skel}</span>
              <span className="dash-kpi-sub">
                {sites ? <><strong>{nf.format(activeSites)}</strong> active · {nf.format(datacenters)} datacenters</> : ''}
              </span>
            </Link>
          )}
          {canInitiatives && (
            <Link to="/initiatives" className="dash-kpi">
              <span className="dash-kpi-label">Initiatives</span>
              <span className="dash-kpi-value">{initiatives ? nf.format(board.length) : skel}</span>
              <span className="dash-kpi-sub">
                {initiatives ? <>active of <strong>{nf.format(initiatives.filter((i) => !i.archived_at).length)}</strong> total</> : ''}
              </span>
            </Link>
          )}
          {canContainers && (
            <Link to="/logistics/containers" className="dash-kpi">
              <span className="dash-kpi-label">Containers</span>
              <span className="dash-kpi-value">{containers ? nf.format(liveContainers.length) : skel}</span>
              <span className="dash-kpi-sub">
                {containers ? <><strong>{nf.format(liveContainers.reduce((n, c) => n + c.asset_count, 0))}</strong> assets packed</> : ''}
              </span>
            </Link>
          )}
          {canScans && (
            <Link to="/admin/scans" className="dash-kpi">
              <span className="dash-kpi-label">Scans · 7d</span>
              <span className="dash-kpi-value">{scanDays ? nf.format(scans7d) : skel}</span>
              <span className="dash-kpi-sub">
                {scanDays ? <><strong>{nf.format(scansToday)}</strong> today</> : ''}
              </span>
              {scanDays && <Sparkline points={scanDays.map((d) => d.count)} />}
            </Link>
          )}
        </div>

        {/* ── flight board ── */}
        {canInitiatives && (
          <section className="dash-panel dash-board dash-span-12 dash-rise" aria-label="Active initiatives">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Flight board — active initiatives</span>
              <Link className="dash-panel-link" to="/initiatives">All initiatives</Link>
            </div>
            <div className="mini-list dash-board-rows">
              {initiatives === null && <div className="dash-panel-empty" style={{ padding: '18px 20px' }}>Loading…</div>}
              {initiatives !== null && board.length === 0 && (
                <div className="dash-panel-empty" style={{ padding: '18px 20px' }}>
                  No active initiatives. <Link className="dash-panel-link" to="/initiatives">Start one</Link>
                </div>
              )}
              {board.map((init) => {
                const progress = progressById[init.id];
                const isMove = init.initiative_type === 'move';
                return (
                  <Link key={init.id} to={`/initiatives/${init.id}`} className="mini-row dash-board-row">
                    <div className="cell-primary">
                      <div className="pn">
                        <b>{init.name}</b>
                        <span>
                          {init.type_label}{init.sub_type_label ? ` · ${init.sub_type_label}` : ''}
                        </span>
                      </div>
                    </div>
                    <span className="dash-board-route cell-sub">
                      {isMove ? (
                        <>
                          <span className="code" title={init.origin_site_name ?? undefined}>
                            {init.origin_site_name ?? <span className="tbd">TBD</span>}
                          </span>
                          <span className="code" title={init.destination_site_name ?? undefined}>
                            <span className="arrow" aria-hidden="true">→ </span>
                            {init.destination_site_name ?? <span className="tbd">TBD</span>}
                          </span>
                        </>
                      ) : (
                        <span className="code" title={init.site_name ?? undefined}>
                          {init.site_name ?? init.location ?? '—'}
                        </span>
                      )}
                    </span>
                    <span className="dash-board-window mono">
                      {windowLines(init.scheduled_start, init.scheduled_end).map((line) => (
                        <span key={line}>{line}</span>
                      ))}
                    </span>
                    {progress ? (
                      <span className="dash-board-progress">
                        <span className="pct mono">{progress.pct}%</span>
                        <span className="track"><span className="fill" style={{ width: `${progress.pct}%` }} /></span>
                      </span>
                    ) : (
                      <span className="dash-board-chip chip custom"
                            style={{ '--chip': init.status_color ?? '#51606f' } as CSSProperties}>
                        <span className="dot" />{init.status_label}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* ── in transit (truck tracking placeholder) ── */}
        {canInitiatives && canSites && (
          <section className="dash-panel dash-span-6 dash-rise" aria-label="In transit">
            <div className="dash-panel-head">
              <span className="dash-panel-title">In transit — planned routes</span>
              <Link className="dash-panel-link" to="/initiatives">All moves</Link>
            </div>
            {(initiatives === null || sites === null) && <div className="dash-panel-empty">Loading…</div>}
            {initiatives !== null && sites !== null && (
              <TransitMap moves={activeMoves} sites={liveSites} />
            )}
          </section>
        )}

        {/* ── site network ── */}
        {canSites && (
          <section className="dash-panel dash-span-6 dash-rise" aria-label="Site network">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Site network</span>
              <Link className="dash-panel-link" to="/sites">All sites</Link>
            </div>
            {sites === null && <div className="dash-panel-empty">Loading…</div>}
            {sites !== null && (
              <div className="dash-map">
                <DashSitesMap sites={liveSites} onSelect={(id) => navigate(`/sites/${id}`)} />
              </div>
            )}
          </section>
        )}

        {/* ── scan activity ── */}
        {canScans && (
          <section className="dash-panel dash-span-7 dash-rise" aria-label="Scan activity">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Scan activity — {SCAN_DAYS} days</span>
              <Link className="dash-panel-link" to="/admin/scans">Scan inbox</Link>
            </div>
            {scanDays === null && <div className="dash-panel-empty">Loading…</div>}
            {scanDays !== null && (
              <>
                <DailyBars
                  days={barDays}
                  ariaLabel={`Raw scans per day over the last ${SCAN_DAYS} days`}
                  formatTooltip={(d) => `${nf.format(d.value)} scans — ${d.label}`}
                />
                <p className="dash-chart-note">
                  <strong>{nf.format(scansToday)}</strong> scans so far today
                  across RFID, barcode, and manual sources.
                </p>
              </>
            )}
          </section>
        )}

        {/* ── asset fleet ── */}
        {canAssets && (
          <section className="dash-panel dash-span-5 dash-rise" aria-label="Assets by status">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Asset fleet by status</span>
              <Link className="dash-panel-link" to="/assets">All assets</Link>
            </div>
            {assets === null && <div className="dash-panel-empty">Loading…</div>}
            {assets !== null && liveAssets.length === 0 && (
              <div className="dash-panel-empty">No assets yet.</div>
            )}
            {assets !== null && liveAssets.length > 0 && (
              <Distribution entries={assetDist} total={liveAssets.length} />
            )}
          </section>
        )}

        {/* ── latest scans ── */}
        {canScans && (
          <section className="dash-panel dash-span-6 dash-rise" aria-label="Latest scans">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Latest scans</span>
              <Link className="dash-panel-link" to="/admin/scans">All scans</Link>
            </div>
            {recentScans === null && <div className="dash-panel-empty">Loading…</div>}
            {recentScans !== null && latestScans.length === 0 && (
              <div className="dash-panel-empty">No processed scans yet.</div>
            )}
            <div className="mini-list dash-scan-list">
              {latestScans.map((s) => (
                <div key={s.id} className="mini-row dash-scan-row">
                  <span className="dash-scan-dot" style={{ background: s.match_type_color }} aria-hidden="true" />
                  <span className="cell-top dash-scan-name" title={s.scanned_value}>
                    {s.matched_name ?? s.scanned_value}
                  </span>
                  <span className="dash-scan-kind chip tag">{s.match_type_label}</span>
                  <span className="cell-sub dash-scan-site" title={s.site_name ?? undefined}>
                    {s.site_name ?? '—'}
                  </span>
                  <span className="dash-scan-time mono">{relativeTime(s.scanned_at)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── recent activity ── */}
        {canAudit && (
          <section className="dash-panel dash-span-6 dash-rise" aria-label="Recent activity">
            <div className="dash-panel-head">
              <span className="dash-panel-title">Recent activity</span>
              <Link className="dash-panel-link" to="/admin/audit">Audit log</Link>
            </div>
            {audit === null && <div className="dash-panel-empty">Loading…</div>}
            {audit !== null && feed.length === 0 && (
              <div className="dash-panel-empty">Nothing recorded yet.</div>
            )}
            <div className="mini-list dash-feed">
              {feed.map((row) => (
                <div key={row.id} className="mini-row dash-feed-row">
                  <span className="dash-feed-time mono">{relativeTime(row.at)}</span>
                  <span className="dash-feed-text">
                    <b className="cell-top">{row.actor_name ?? 'System'}</b>{' '}
                    <span className="what cell-sub">{actionLabel(row).toLowerCase()}</span>{' '}
                    {targetLabel(row, { hideAuthTarget: true }) !== '—' && targetLabel(row)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
