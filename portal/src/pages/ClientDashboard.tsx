/**
 * Client Dashboard (/dashboards/clients) — the client-facing landing page.
 * An internal viewer with more than one client picks one from a select;
 * a client-scoped viewer with exactly one client sees its name statically
 * (Home.tsx redirects that persona here — see the Navigate in Home.tsx).
 * Composition mirrors PeopleDashboard: one refreshAll(selectedId) with
 * quiet catches + Promise.allSettled, an auto-refresh interval that never
 * blanks loaded panels, and per-resource permission gates (Home.tsx style).
 */

import {
  useCallback, useEffect, useMemo, useState,
} from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  getClientActivity, getOrg, listAssets, listAssetStatuses, listInitiativeAssets,
  listInitiatives, listClients,
  type AssetItem, type ClientActivityItem, type InitiativeItem,
  type OrgRef, type StatusValue,
} from '../lib/api';
import { statusChip as chip } from '../lib/chips';
import { assetDistribution, sortClientInitiatives } from '../lib/clientDashboard';
import { moveAssetProgress } from '../lib/initiatives';
import { avatarGradient, initials, longDateOf, relativeTime } from '../lib/format';
import { STATUS_META, type OrgItem } from '../lib/orgs';
import { parseApiDay } from '../lib/timeline';
import { Distribution } from '../components/dashboard/charts';
import '../styles/directory.css';
import '../styles/dashboard.css';

const REFRESH_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '15s', seconds: 15 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: '15 min', seconds: 900 },
];
/** Roster fetches for the weighted move-progress bars — capped the same
 *  way Home.tsx caps its flight board so this page never fans out into
 *  dozens of requests for a client with a long initiative history. */
const MAX_PROGRESS_FETCHES = 5;

const nf = new Intl.NumberFormat();
const skel = <span className="dash-skel" aria-label="loading" />;

const TIER_META: Record<string, string> = {
  standard: 'tag', preferred: 'c-blue', strategic: 'c-amber',
};

/** scheduled_start/scheduled_end are date-only fields (midnight UTC for a
 *  plain YYYY-MM-DD input) — parse the Y-M-D digits into a local Date
 *  first, since `longDate` (built on `new Date(iso)`) would name the day
 *  before anywhere west of UTC. Null keeps `longDate`'s '—'. */
function scheduledDate(iso: string | null): string {
  return iso ? longDateOf(parseApiDay(iso)) : '—';
}

export default function ClientDashboard() {
  const { can } = useAuth();
  const canClients = can('clients', 'view');
  const canInitiatives = can('initiatives', 'view');
  const canAssets = can('assets', 'view');
  // `clients:view` is the page's functional prerequisite — the picker,
  // identity band, Recent Activity panel, and the Activity·7d KPI all
  // read through the client entity itself. Without it there is no client
  // to scope anything to, so the whole grid (including the initiatives
  // and asset-fleet panels, despite their own separate grants) stays
  // hidden behind the permission-poor note.
  const showGrid = canClients;

  const [clients, setClients] = useState<OrgRef[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshSec, setRefreshSec] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const [org, setOrg] = useState<OrgItem | null>(null);
  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [clientAssets, setClientAssets] = useState<AssetItem[] | null>(null);
  const [assetStatuses, setAssetStatuses] = useState<StatusValue[]>([]);
  const [activityEvents, setActivityEvents] = useState<ClientActivityItem[] | null>(null);
  const [activity7d, setActivity7d] = useState(0);
  const [progressById, setProgressById] = useState<Record<string, { pct: number; countable: number }>>({});

  // ── client list (unarchived, sorted by name) ──
  useEffect(() => {
    if (!showGrid) return;
    let alive = true;
    listClients()
      .then((all) => {
        if (!alive) return;
        const live = all.filter((c) => !c.archived_at).sort((a, b) => a.name.localeCompare(b.name));
        setClients(live);
        setSelectedId((prev) => prev ?? live[0]?.id ?? null);
      })
      .catch(() => { if (alive) setClients([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGrid]);

  // ── per-client loads, fired on selectedId change AND by refreshAll ──
  const refreshAll = useCallback((id: string | null) => {
    if (!id) return;
    const quiet = () => undefined; // a failed fetch keeps the last data
    const jobs: Promise<unknown>[] = [];
    if (canClients) jobs.push(getOrg('client', id).then(setOrg).catch(quiet));
    if (canInitiatives) {
      jobs.push(
        listInitiatives()
          .then((all) => setInitiatives(sortClientInitiatives(all.filter((i) => i.client_id === id))))
          .catch(quiet),
      );
    }
    if (canAssets) {
      jobs.push(
        Promise.all([listAssets(), listAssetStatuses()])
          .then(([allAssets, statuses]) => {
            setAssetStatuses(statuses);
            setClientAssets(allAssets.filter((a) => a.client_id === id));
          })
          .catch(quiet),
      );
    }
    if (canClients) {
      jobs.push(
        getClientActivity(id)
          .then((out) => { setActivityEvents(out.events); setActivity7d(out.activity_7d); })
          .catch(quiet),
      );
    }
    if (jobs.length) void Promise.allSettled(jobs).then(() => setUpdatedAt(new Date()));
  }, [canClients, canInitiatives, canAssets]);

  // Switching clients clears the previous client's panels first — unlike
  // the auto-refresh interval below (which must never blank a panel on a
  // quiet failure), a new selection is a different record entirely, and
  // showing the old client's rows under the new client's name would be
  // actively misleading (StakeholderDetail resets the same way on a param
  // change, for the same reason).
  useEffect(() => {
    setOrg(null);
    setInitiatives(null);
    setClientAssets(null);
    setActivityEvents(null);
    setActivity7d(0);
    setProgressById({});
  }, [selectedId]);

  useEffect(() => { refreshAll(selectedId); }, [selectedId, refreshAll]);

  useEffect(() => {
    if (!refreshSec) return;
    const t = setInterval(() => refreshAll(selectedId), refreshSec * 1000);
    return () => clearInterval(t);
  }, [refreshSec, refreshAll, selectedId]);

  // ── weighted progress for the first few active move initiatives ──
  useEffect(() => {
    if (!initiatives || initiatives.length === 0 || assetStatuses.length === 0) return;
    let alive = true;
    const moves = initiatives
      .filter((i) => i.initiative_type === 'move' && !i.real_end_at)
      .slice(0, MAX_PROGRESS_FETCHES);
    moves.forEach((init) => {
      listInitiativeAssets(init.id)
        .then((rows) => {
          if (!alive || rows.length === 0) return;
          setProgressById((prev) => ({ ...prev, [init.id]: moveAssetProgress(rows, assetStatuses) }));
        })
        .catch(() => undefined);
    });
    return () => { alive = false; };
  }, [initiatives, assetStatuses]);

  /* ── derived numbers ─────────────────────────────────────── */

  const activeInitiatives = useMemo(
    () => (initiatives ?? []).filter((i) => !i.real_end_at),
    [initiatives],
  );
  const liveAssets = useMemo(
    () => (clientAssets ?? []).filter((a) => !a.archived_at),
    [clientAssets],
  );
  const inTransit = useMemo(
    () => liveAssets.filter((a) => a.status === 'in_transit').length,
    [liveAssets],
  );
  const dist = useMemo(
    () => assetDistribution(clientAssets ?? [], assetStatuses),
    [clientAssets, assetStatuses],
  );

  const orgMeta = useMemo(() => {
    if (!org) return [];
    return [
      org.account_manager?.display_name ?? null,
      org.website,
      [org.city, org.region].filter(Boolean).join(', ') || null,
    ].filter((v): v is string => Boolean(v));
  }, [org]);

  /* ── render ──────────────────────────────────────────────── */

  return (
    <div className="portal-page">
      <div className="eyebrow">Dashboards</div>
      <div className="dash-head">
        <h1 className="page-title">Client Dashboard</h1>
        {showGrid && (
          <div className="dash-ctrls">
            {clients === null ? (
              <span className="dash-ctrl-static">Loading…</span>
            ) : clients.length === 0 ? (
              <select aria-label="Client" disabled><option>No clients</option></select>
            ) : clients.length === 1 ? (
              <span className="dash-ctrl-static">{clients[0].name}</span>
            ) : (
              <label className="dash-ctrl">
                <span>Client</span>
                <select aria-label="Client" value={selectedId ?? ''}
                        onChange={(e) => setSelectedId(e.target.value)}>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label className="dash-ctrl">
              <span>Auto-refresh</span>
              <select aria-label="Auto-refresh" value={refreshSec}
                      onChange={(e) => setRefreshSec(Number(e.target.value))}>
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
        )}
      </div>

      {!showGrid && (
        <div className="dash-panel-empty">Nothing your permissions can show here yet.</div>
      )}

      {showGrid && clients !== null && clients.length === 0 && (
        <div className="dash-panel-empty">No clients yet.</div>
      )}

      {showGrid && clients !== null && clients.length > 0 && (
        <div className="dash-grid">
          {/* ── identity band ── */}
          {canClients && (
            <section className="dash-panel dash-span-12 dash-rise cdash-hero" aria-label="Client identity">
              {org === null ? (
                <div className="dash-panel-empty">Loading…</div>
              ) : (
                <>
                  <div className="cdash-hero-logo" style={{ background: org.logo_url ? 'var(--surface-2)' : avatarGradient(org.name) }}>
                    {org.logo_url ? <img src={org.logo_url} alt="" /> : initials(org.name)}
                  </div>
                  <div>
                    <div>
                      <span className="cdash-hero-name">{org.name}</span>
                      {org.tier && (
                        <span className={`chip ${TIER_META[org.tier] ?? 'tag'}`}>{org.tier}</span>
                      )}{' '}
                      <span className={`chip ${(STATUS_META[org.status] ?? STATUS_META.prospect).cls}`}>
                        <span className="dot" />{(STATUS_META[org.status] ?? { label: org.status }).label}
                      </span>
                    </div>
                    {orgMeta.length > 0 && (
                      <div className="cdash-hero-meta">{orgMeta.join(' · ')}</div>
                    )}
                  </div>
                  <Link className="dash-panel-link cdash-hero-spacer" to={`/stakeholders/clients/${selectedId}`}>
                    Client profile
                  </Link>
                </>
              )}
            </section>
          )}

          {/* ── KPI strip ── */}
          <div className="dash-kpis dash-rise">
            {canInitiatives && (
              <div className="dash-kpi">
                <span className="dash-kpi-label">Active initiatives</span>
                <span className="dash-kpi-value">
                  {initiatives ? nf.format(activeInitiatives.length) : skel}
                </span>
              </div>
            )}
            {canAssets && (
              <div className="dash-kpi">
                <span className="dash-kpi-label">Total assets</span>
                <span className="dash-kpi-value">
                  {clientAssets ? nf.format(liveAssets.length) : skel}
                </span>
              </div>
            )}
            {canAssets && (
              <div className="dash-kpi">
                <span className="dash-kpi-label">In transit</span>
                <span className="dash-kpi-value">
                  {clientAssets ? nf.format(inTransit) : skel}
                </span>
              </div>
            )}
            {canClients && (
              <div className="dash-kpi">
                <span className="dash-kpi-label">Activity · 7d</span>
                <span className="dash-kpi-value">
                  {activityEvents ? nf.format(activity7d) : skel}
                </span>
              </div>
            )}
          </div>

          {/* ── initiatives ── */}
          {canInitiatives && (
            <section className="dash-panel dash-span-12 dash-rise" aria-label="Initiatives">
              <div className="dash-panel-head">
                <span className="dash-panel-title">Initiatives</span>
                <Link className="dash-panel-link" to="/initiatives">All initiatives</Link>
              </div>
              {initiatives === null && <div className="dash-panel-empty">Loading…</div>}
              {initiatives !== null && initiatives.length === 0 && (
                <div className="dash-panel-empty">No initiatives yet.</div>
              )}
              {initiatives !== null && initiatives.map((i) => {
                const progress = progressById[i.id];
                return (
                  <div key={i.id} className="mini-row flex cdash-init-row">
                    <Link className="cdash-init-name" to={`/initiatives/${i.id}`}><b className="cell-top">{i.name}</b></Link>
                    {chip(i.type_label, i.type_color)}
                    {chip(i.status_label, i.status_color)}
                    <span className="cdash-init-dates mono">
                      {scheduledDate(i.scheduled_start)} – {scheduledDate(i.scheduled_end)}
                    </span>
                    {i.origin_site_name && i.destination_site_name && (
                      <span className="cdash-init-dates cell-sub">
                        {i.origin_site_name} → {i.destination_site_name}
                      </span>
                    )}
                    {progress && (
                      <>
                        <span className="cdash-progress">
                          <span className="fill" style={{ width: `${progress.pct}%` }} />
                        </span>
                        <span className="cdash-progress-pct mono">{progress.pct}%</span>
                      </>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {/* ── asset fleet ── */}
          {canAssets && (
            <section className="dash-panel dash-span-5 dash-rise" aria-label="Asset fleet">
              <div className="dash-panel-head">
                <span className="dash-panel-title">Asset fleet by status</span>
                <span className="dash-panel-head-right">
                  {clientAssets !== null && (
                    <span className="dash-panel-count">{nf.format(liveAssets.length)}</span>
                  )}
                  <Link className="dash-panel-link" to="/assets">All assets</Link>
                </span>
              </div>
              {clientAssets === null && <div className="dash-panel-empty">Loading…</div>}
              {clientAssets !== null && liveAssets.length === 0 && (
                <div className="dash-panel-empty">No assets on file.</div>
              )}
              {clientAssets !== null && liveAssets.length > 0 && (
                <Distribution entries={dist} total={liveAssets.length} />
              )}
            </section>
          )}

          {/* ── recent activity ── */}
          {canClients && (
            <section className="dash-panel dash-span-7 dash-rise" aria-label="Recent activity">
              <div className="dash-panel-head">
                <span className="dash-panel-title">Recent activity</span>
              </div>
              {activityEvents === null && <div className="dash-panel-empty">Loading…</div>}
              {activityEvents !== null && activityEvents.length === 0 && (
                <div className="dash-panel-empty">No scan activity yet.</div>
              )}
              {activityEvents !== null && activityEvents.map((row) => (
                // Deep link mirrors lib/scans.ts's matchedHref asset branch
                // (`/assets?open=...`) — ClientActivityItem already carries
                // the asset id directly, so there's no match_type to switch on.
                <Link key={row.id} className="mini-row cdash-act-row"
                      to={`/assets?open=${encodeURIComponent(row.asset_id)}`}>
                  <span className="cdash-act-dot" style={{ background: row.status_color }} aria-hidden="true" />
                  <span>
                    <b className="cell-top">{row.asset_name ?? 'Unnamed asset'}</b>
                    {row.serial_number && <span className="cdash-act-serial mono"> {row.serial_number}</span>}
                  </span>
                  {/* status is nullable on this row (a scan that hasn't
                      resolved to a known asset status yet) — "Scanned" is
                      the neutral fallback copy for that case. */}
                  <span className="chip tag">{row.status_label ?? 'Scanned'}</span>
                  <span className="cdash-act-serial mono">
                    {[row.site_name, row.device_id].filter(Boolean).join(' · ')}
                  </span>
                  <span className="cdash-act-time mono">{relativeTime(row.scanned_at)}</span>
                </Link>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
