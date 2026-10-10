/**
 * Shipments dashboard (/dashboards/shipments) — a wall-screen view of the
 * trucks on the road: counts, a live map of each truck's current trip
 * with its destination, a feed of truck and container updates, and a
 * per-truck table. One move or all of them.
 *
 * Refresh idiom from PeopleDashboard / ClientDashboard: one refreshAll
 * (Promise.allSettled, a failed fetch keeps the last data) on an interval
 * select, plus: no ticks while the tab is hidden, and one immediately on
 * coming back (unless refresh is Off). A move change clears the old move's
 * panels in the same render as the new selection (never the old move's
 * numbers under the new name) and a generation counter drops any reply
 * still in flight for the old move. A tick is skipped while the previous
 * refresh is still running (unless it has hung past BUSY_LIMIT_MS), and a
 * per-panel sequence number keeps an older reply from overwriting a newer
 * one. A panel whose first load fails says so instead of "Loading…".
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ComboBox from '../components/ComboBox';
import TrucksMap from '../components/trucks/TrucksMap';
import {
  getShipmentMap, getTrucksFeed, getTrucksSummary, listInitiatives, listTrucks,
  type TruckFeedEvent, type TruckItem, type TruckMapPoint, type TruckSummary,
} from '../lib/api';
import { statusChip } from '../lib/chips';
import { relativeTime } from '../lib/format';
import { ColHead, listGridStyle, listScale, titleFor } from '../lib/listTools';
import { compareValues } from '../lib/naturalSort';
import {
  appendOlderPage, DEFAULT_REFRESH_SEC, FEED_PAGE_SIZE, feedEventText, type FeedState,
  mergeFeedPage, REFRESH_OPTIONS, SHIPMENT_COLUMNS, SHIPMENT_PRIMARY_COL, shipmentCellText,
  shipmentMoveOptions, shipmentSortValue, shipmentTrucks,
} from '../lib/shipments';
import '../styles/directory.css';
import '../styles/dashboard.css';
import '../styles/profile.css';
import '../styles/trucks.css';

const MAP_EMPTY =
  'No trucks with a recorded position yet. Add a location update on a truck to see it here.';

/** A refresh still running after this long no longer blocks the next tick
 *  (a hung request must not freeze a wall screen); sequence numbers keep
 *  its late replies from overwriting newer ones. */
const BUSY_LIMIT_MS = 120_000;

type Panel = 'trucks' | 'summary' | 'map' | 'feed';
const NO_FAILURES: Record<Panel, boolean> = { trucks: false, summary: false, map: false, feed: false };

const nf = new Intl.NumberFormat();
const skel = <span className="dash-skel" aria-label="loading" />;

const svg = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round">{path}</svg>
);
const KIND_ICON: Record<TruckFeedEvent['kind'], ReactNode> = {
  location: svg(<><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></>),
  status: svg(<path d="M4 12h13M13 7l5 5-5 5" />),
  load: svg(<><path d="M3 10l9-5 9 5v9H3z" /><path d="M12 9v7M9 13l3 3 3-3" /></>),
  unload: svg(<><path d="M3 10l9-5 9 5v9H3z" /><path d="M12 16V9M9 12l3-3 3 3" /></>),
};

function FeedText({ e }: { e: TruckFeedEvent }) {
  if (e.kind !== 'status') return <>{feedEventText(e)}</>;
  return (
    <>
      {statusChip(e.from_label ?? e.from_status ?? '—', e.from_color)}
      <span className="shipdash-arrow" aria-hidden="true">→</span>
      {statusChip(e.to_label ?? e.to_status ?? '—', e.to_color)}
      {e.actor_name && <span className="shipdash-by">by {e.actor_name}</span>}
    </>
  );
}

export default function ShipmentsDashboard() {
  const { can, preferences } = useAuth();
  const canInitiatives = can('initiatives', 'view');
  const navigate = useNavigate();

  const [moveId, setMoveId] = useState('');               // '' = all moves
  const initiativeId = moveId || null;
  const [refreshSec, setRefreshSec] = useState(DEFAULT_REFRESH_SEC);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const [trucks, setTrucks] = useState<TruckItem[] | null>(null);
  const [summary, setSummary] = useState<TruckSummary | null>(null);
  const [mapPoints, setMapPoints] = useState<TruckMapPoint[] | null>(null);
  const [feed, setFeed] = useState<FeedState | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [archivedMoves, setArchivedMoves] = useState<Set<string> | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [sortKey, setSortKey] = useState('primary');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  // a panel's latest fetch failed; shown only while it has no data yet
  const [failed, setFailed] = useState<Record<Panel, boolean>>(NO_FAILURES);

  // bumped on every move change: replies for an older generation are dropped
  const gen = useRef(0);
  // the refresh in flight (its generation and start), for the skip-a-tick guard
  const busy = useRef<{ gen: number; since: number } | null>(null);
  // refresh sequence: each panel applies only replies newer than its last one
  const seq = useRef(0);
  const applied = useRef<Record<Panel, number>>({ trucks: 0, summary: 0, map: 0, feed: 0 });

  const refreshAll = useCallback(() => {
    const g = gen.current;
    const b = busy.current;
    if (b && b.gen === g && Date.now() - b.since < BUSY_LIMIT_MS) return;
    const run = { gen: g, since: Date.now() };
    busy.current = run;
    const n = ++seq.current;
    const live = () => g === gen.current;
    const mark = (panel: Panel, value: boolean) =>
      setFailed((prev) => (prev[panel] === value ? prev : { ...prev, [panel]: value }));
    let anyOk = false;
    function job<T>(panel: Panel, p: Promise<T>, apply: (v: T) => void): Promise<void> {
      return p.then(
        (v) => {
          if (!live() || n < applied.current[panel]) return;
          applied.current[panel] = n;
          apply(v);
          mark(panel, false);
          anyOk = true;
        },
        () => { if (live()) mark(panel, true); }, // keeps the last data
      );
    }
    void Promise.allSettled([
      job('trucks', listTrucks(), setTrucks),
      job('summary', getTrucksSummary(initiativeId), setSummary),
      job('map', getShipmentMap(initiativeId), setMapPoints),
      job('feed', getTrucksFeed({ initiativeId, limit: FEED_PAGE_SIZE }),
        (page) => setFeed((prev) => mergeFeedPage(prev, page))),
    ]).then(() => {
      if (busy.current === run) busy.current = null;
      if (anyOk && live()) setUpdatedAt(new Date());
    });
  }, [initiativeId]);

  // mount + every move change
  useEffect(() => { refreshAll(); }, [refreshAll]);

  // the cadence; no ticks while the tab is hidden
  useEffect(() => {
    if (!refreshSec || hidden) return undefined;
    const t = setInterval(refreshAll, refreshSec * 1000);
    return () => clearInterval(t);
  }, [refreshSec, hidden, refreshAll]);

  // back on the tab: refresh at once (unless Off), then the cadence resumes
  const latest = useRef({ refreshSec, refreshAll });
  latest.current = { refreshSec, refreshAll };
  useEffect(() => {
    const onVisibility = () => {
      const nowHidden = document.hidden;
      setHidden(nowHidden);
      if (!nowHidden && latest.current.refreshSec > 0) latest.current.refreshAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // relative times ("5m ago") stay fresh between data refreshes
  const [, setClock] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // archived moves drop out of the picker (when the viewer can read moves)
  useEffect(() => {
    if (!canInitiatives) return undefined;
    let alive = true;
    listInitiatives()
      .then((items) => {
        if (alive) setArchivedMoves(new Set(items.filter((i) => i.archived_at).map((i) => i.id)));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [canInitiatives]);

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const changeMove = (value: string) => {
    if (value === moveId) return;
    gen.current += 1;
    // cleared in the same render as the new selection: the old move's
    // panels never show under the new move's name
    setMoveId(value);
    setSummary(null);
    setMapPoints(null);
    setFeed(null);
    setOlderBusy(false);
    setOlderFailed(false);
    setFailed(NO_FAILURES);
  };

  const showOlder = () => {
    const cursor = feed?.nextBefore;
    if (!cursor || olderBusy) return;
    const g = gen.current;
    setOlderBusy(true);
    setOlderFailed(false);
    getTrucksFeed({ initiativeId, limit: FEED_PAGE_SIZE, before: cursor })
      .then((page) => { if (g === gen.current) setFeed((prev) => appendOlderPage(prev, cursor, page)); })
      .catch(() => { if (g === gen.current) setOlderFailed(true); })
      .finally(() => { if (g === gen.current) setOlderBusy(false); });
  };

  /* ── derived ─────────────────────────────────────────────── */

  const moveOptions = useMemo(
    () => shipmentMoveOptions(trucks ?? [], archivedMoves),
    [trucks, archivedMoves],
  );
  const rows = useMemo(() => {
    const list = shipmentTrucks(trucks ?? [], initiativeId);
    return list.sort((a, b) =>
      compareValues(shipmentSortValue(a, sortKey), shipmentSortValue(b, sortKey)) * sortDir);
  }, [trucks, initiativeId, sortKey, sortDir]);

  const toggleSort = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(1); }
  };

  const grid = listGridStyle(
    [SHIPMENT_PRIMARY_COL, ...SHIPMENT_COLUMNS], [], undefined, listScale(preferences?.list_size));
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  const openTruck = (id: string) => navigate(`/logistics/trucks/${id}`);

  const cellFor = (t: TruckItem, key: string) => {
    switch (key) {
      case 'status':
        return <div className="chips">{statusChip(t.status_label, t.status_color)}</div>;
      case 'load': {
        const text = shipmentCellText(t, key);
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'route': {
        if (!t.start_site_name && !t.end_site_name) return <span className="cell-top cell-line">—</span>;
        const from = t.start_site_name ?? '—';
        const to = `→ ${t.end_site_name ?? '—'}`;
        return (
          <>
            <div className="cell-top cell-line" title={titleFor(from)}>{from}</div>
            <div className="cell-sub cell-line" title={titleFor(to)}>{to}</div>
          </>
        );
      }
      case 'location': {
        const text = shipmentCellText(t, key);
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'last_update': {
        const at = t.last_update?.recorded_at ?? null;
        return (
          <span className="mono cell-line" title={at ? new Date(at).toLocaleString() : undefined}>
            {relativeTime(at)}
          </span>
        );
      }
      case 'containers':
        return <span className="mono cell-line">{nf.format(t.container_count)}</span>;
      default:
        return null;
    }
  };

  const kpi = (label: string, value: number | undefined) => (
    <div className="dash-kpi">
      <span className="dash-kpi-label">{label}</span>
      <span className="dash-kpi-value">
        {value !== undefined ? nf.format(value) : failed.summary ? '—' : skel}
      </span>
    </div>
  );

  const panelError = (text: string) => <div className="pf-error shipdash-panel-error">{text}</div>;

  const map = (inModal: boolean) => (
    mapPoints === null
      ? <div className="trucks-map-empty">{failed.map ? panelError('Could not load the map.') : 'Loading…'}</div>
      : (
        <TrucksMap points={mapPoints} trails destinations onOpen={openTruck}
                   scrollWheelZoom={inModal} emptyText={MAP_EMPTY}
                   className="trucks-map shipdash-map" />
      )
  );

  /* ── render ──────────────────────────────────────────────── */

  return (
    <div className="portal-page">
      <div className="eyebrow">Dashboards</div>
      <div className="dash-head">
        <h1 className="page-title">Shipment tracking</h1>
        <div className="dash-ctrls">
          <div className="dash-ctrl shipdash-move">
            <span>Move</span>
            <ComboBox options={moveOptions} value={moveId} onChange={changeMove}
                      placeholder="All moves" ariaLabel="Move" />
          </div>
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
              {refreshSec > 0 && !hidden && <span className="dash-asof-dot" aria-hidden="true" />}
              updated {updatedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      <div className="dash-grid">
        {/* ── counts ── */}
        <section className="dash-kpis dash-rise" aria-label="Counts">
          {kpi('In transit', summary?.in_transit)}
          {kpi('Loading', summary?.active)}
          {kpi('At destination', summary?.at_destination)}
          {kpi('Containers on board', summary?.containers_on_board)}
          {summary === null && failed.summary && panelError('Could not load counts.')}
        </section>

        {/* ── live map ── */}
        <section className="dash-panel dash-span-12 dash-rise" aria-label="Live map">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Live map — current trips</span>
            <span className="dash-panel-head-right">
              <button type="button" className="mini-btn" onClick={() => setFullscreen(true)}>
                Fullscreen
              </button>
              <Link className="dash-panel-link" to="/logistics/trucks">All trucks</Link>
            </span>
          </div>
          <div className="trucks-map-panel shipdash-map-panel">{map(false)}</div>
        </section>

        {/* ── update feed ── */}
        <section className="dash-panel dash-span-5 dash-rise" aria-label="Update feed">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Update feed</span>
          </div>
          {feed === null && (failed.feed
            ? panelError('Could not load updates.')
            : <div className="dash-panel-empty">Loading…</div>)}
          {feed !== null && feed.events.length === 0 && (
            <div className="dash-panel-empty">No truck updates yet.</div>
          )}
          {feed !== null && feed.events.length > 0 && (
            <div className="mini-list shipdash-feed">
              {feed.events.map((e) => (
                <div key={e.id} className="mini-row shipdash-feed-row" data-testid="feed-row"
                     title={feedEventText(e)}>
                  <span className={`shipdash-feed-icon k-${e.kind}`} aria-hidden="true">
                    {KIND_ICON[e.kind]}
                  </span>
                  <span className="shipdash-feed-truck">
                    <Link className="cell-top" to={`/logistics/trucks/${e.truck_id}`}>{e.truck_name}</Link>
                    {e.load_number && <span className="mono shipdash-feed-load">{e.load_number}</span>}
                  </span>
                  <span className="cell-sub shipdash-feed-text"><FeedText e={e} /></span>
                  <span className="mono shipdash-feed-time" title={new Date(e.at).toLocaleString()}>
                    {relativeTime(e.at)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {feed?.nextBefore && (
            <div className="shipdash-feed-more">
              <button type="button" className="mini-btn" onClick={showOlder} disabled={olderBusy}>
                Show older
              </button>
              {olderFailed && <span className="page-hint">Could not load older updates. Try again.</span>}
            </div>
          )}
        </section>

        {/* ── trucks ── */}
        <section className="dash-panel dash-span-7 dash-rise" aria-label="Trucks">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Trucks</span>
            <span className="dash-panel-head-right">
              {trucks !== null && <span className="dash-panel-count">{nf.format(rows.length)}</span>}
              <Link className="dash-panel-link" to="/logistics/trucks">Trucks / Shipments</Link>
            </span>
          </div>
          {trucks === null && (failed.trucks
            ? panelError('Could not load trucks.')
            : <div className="dash-panel-empty">Loading…</div>)}
          {trucks !== null && (
            <div className="dir-list list-scroll">
              <div className="list-head" style={rowStyle}>
                <ColHead col={SHIPMENT_PRIMARY_COL} sortDir={sortKey === 'primary' ? sortDir : null}
                         onToggleSort={() => toggleSort('primary')} />
                {SHIPMENT_COLUMNS.map((c) => (
                  <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                           onToggleSort={() => toggleSort(c.key)} />
                ))}
              </div>
              {rows.length === 0 && (
                <div className="dir-empty">
                  <b>No trucks on the road</b>No active, in-transit or arrived trucks{initiativeId ? ' on this move' : ''}.
                </div>
              )}
              {rows.map((t) => (
                <div key={t.id} className="dir-row" style={{ minWidth: rowStyle.minWidth }}>
                  <div className="row-main shipdash-row-static" style={rowStyle}>
                    <div className="cell cell-primary">
                      <div className="pn">
                        <b><Link to={`/logistics/trucks/${t.id}`}>{t.name}</Link></b>
                        <span>{t.initiative_name ?? '—'}</span>
                      </div>
                    </div>
                    {SHIPMENT_COLUMNS.map((c) => (
                      <div className="cell" key={c.key}>{cellFor(t, c.key)}</div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {fullscreen && (
        <div className="modal-scrim" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setFullscreen(false);
        }}>
          <div className="modal-card trucks-fullscreen-card" role="dialog" aria-modal="true"
               aria-label="Live map">
            <div className="modal-head">
              <div className="shipdash-modal-head">
                <div className="eyebrow">Shipment tracking</div>
                <h3>Live map</h3>
                <p className="page-hint">
                  Each truck&apos;s current trip and destination. Scroll to zoom; click a truck to open it.
                </p>
              </div>
              <button className="modal-close" aria-label="Close" onClick={() => setFullscreen(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                     strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
              </button>
            </div>
            <div className="modal-body trucks-fullscreen-body">{map(true)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
