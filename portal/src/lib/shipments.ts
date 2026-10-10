/**
 * Shipments dashboard (/dashboards/shipments) logic — pure functions the
 * page delegates to (the lib/trucks.ts pattern): refresh options, the
 * update feed's text and paging merge, and the trucks table's filter,
 * columns and cell text. Unit-testable without jsdom.
 */
import type { ComboOption } from '../components/ComboBox';
import type { TruckFeedEvent, TruckFeedPage, TruckItem } from './api';
import type { ColumnDef } from './listTools';
import { compareOrdinal, naturalCompare } from './naturalSort';

// No runtime import from ./api: api.ts imports the query builders below,
// and pages' tests often mock ./api wholesale.

/** The truck statuses the Shipments dashboard tracks. */
export const SHIPMENT_STATUSES = ['active', 'in_transit', 'at_destination'] as const;

/** `/trucks/map` query for the dashboard: current trip only (trip=true
 *  implies trails), the live statuses, optionally one move. */
export function trucksMapQuery(initiativeId: string | null): string {
  const q = `trip=true&statuses=${SHIPMENT_STATUSES.join(',')}`;
  return initiativeId ? `${q}&initiative_id=${encodeURIComponent(initiativeId)}` : q;
}

/** `GET /trucks` query for the dashboard's table: the three live statuses,
 *  optionally one move (the unfiltered list is only for the move picker). */
export function trucksListQuery(initiativeId: string | null): string {
  const q = `statuses=${SHIPMENT_STATUSES.join(',')}`;
  return initiativeId ? `${q}&initiative_id=${encodeURIComponent(initiativeId)}` : q;
}

/** `/trucks/feed` query; `before` is the previous page's opaque
 *  `next_before`, passed back verbatim (URL-encoded). */
export function trucksFeedQuery(
  opts: { initiativeId: string | null; limit: number; before?: string | null },
): string {
  const parts = [`limit=${opts.limit}`];
  if (opts.initiativeId) parts.push(`initiative_id=${encodeURIComponent(opts.initiativeId)}`);
  if (opts.before) parts.push(`before=${encodeURIComponent(opts.before)}`);
  return parts.join('&');
}

export const REFRESH_OPTIONS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '15 s', seconds: 15 },
  { label: '30 s', seconds: 30 },
  { label: '60 s', seconds: 60 },
  { label: '5 min', seconds: 300 },
];
export const DEFAULT_REFRESH_SEC = 30;

/** Events per feed request (the API caps `limit` at 200). */
export const FEED_PAGE_SIZE = 50;
/** Most events the feed keeps once the viewer has loaded older pages;
 *  refreshes that would grow it past this drop the oldest. */
export const FEED_CAP = 500;

/* ── feed text ───────────────────────────────────────────────────── */

/** A location event's place: the address, else the stored location
 *  text, else "lat, lng". */
export function locationText(e: TruckFeedEvent): string {
  if (e.address) return e.address;
  if (e.location) return e.location;
  if (e.lat !== null && e.lng !== null) return `${e.lat}, ${e.lng}`;
  return 'Location reported';
}

function containerText(e: TruckFeedEvent): string {
  // null when the container was deleted after the event
  return e.container_name ?? 'a removed container';
}

function assetsText(n: number | null): string {
  if (n === null) return '';
  return ` (${n} ${n === 1 ? 'asset' : 'assets'})`;
}

const withVia = (text: string, via: TruckFeedEvent['via']) => (via ? `${text} · ${via}` : text);

/** One line of feed text per event, as the spec words it. The page
 *  renders the status kind with chips; this is its plain form (also the
 *  row's hover title). */
export function feedEventText(e: TruckFeedEvent): string {
  switch (e.kind) {
    case 'location':
      return e.source ? `${locationText(e)} · ${e.source}` : locationText(e);
    case 'status': {
      const from = e.from_label ?? e.from_status ?? '—';
      const to = e.to_label ?? e.to_status ?? '—';
      return e.actor_name ? `${from} → ${to} by ${e.actor_name}` : `${from} → ${to}`;
    }
    case 'load':
      return withVia(`Loaded ${containerText(e)}${assetsText(e.asset_count)}`, e.via);
    case 'unload':
      return withVia(`Unloaded ${containerText(e)}`, e.via);
    default:
      return '';
  }
}

/* ── feed paging ─────────────────────────────────────────────────── */

export interface FeedState {
  events: TruckFeedEvent[];
  /** Cursor for "Show older" — the oldest loaded page's next_before. */
  nextBefore: string | null;
  /** The viewer has loaded older pages, so refreshes merge into what is
   *  shown instead of replacing it. */
  olderLoaded: boolean;
}

/** Newest first: `at` descending, then `id` descending (the API's order). */
function compareEvents(a: TruckFeedEvent, b: TruckFeedEvent): number {
  const dt = Date.parse(b.at) - Date.parse(a.at);
  return dt !== 0 ? dt : compareOrdinal(b.id, a.id);
}

/** The cursor the API would give after `e`: `<at>~<id>` (the server accepts
 *  any ISO stamp; `at` is the API's own string, so no precision is lost). */
const cursorAfter = (e: TruckFeedEvent) => `${e.at}~${e.id}`;

/** Drop the oldest events past FEED_CAP and point "Show older" at the new
 *  tail, so the dropped events are the next page rather than a hole. */
function capFeed(state: FeedState): FeedState {
  if (state.events.length <= FEED_CAP) return state;
  const events = state.events.slice(0, FEED_CAP);
  return { ...state, events, nextBefore: cursorAfter(events[FEED_CAP - 1]) };
}

/** Fold a freshly fetched first page into what's loaded.
 *
 *  Until the viewer loads an older page the feed IS the first page, so each
 *  refresh simply replaces it (and picks up events removed server-side).
 *  Once older pages are loaded, unseen events prepend (by id) and every
 *  older page stays, capped at FEED_CAP. When the fresh page shares no
 *  event with the loaded feed and there are older events beyond it, more
 *  arrived than one page holds: keeping the old rows would leave a silent
 *  hole, so the fresh page replaces them. */
export function mergeFeedPage(prev: FeedState | null, page: TruckFeedPage): FeedState {
  const fresh: FeedState = { events: page.events, nextBefore: page.next_before, olderLoaded: false };
  if (!prev || !prev.olderLoaded || prev.events.length === 0) return fresh;
  const seen = new Set(prev.events.map((e) => e.id));
  const overlaps = page.events.some((e) => seen.has(e.id));
  if (!overlaps && page.next_before !== null) return fresh;
  const added = page.events.filter((e) => !seen.has(e.id));
  if (added.length === 0) return prev;
  return capFeed({
    events: [...added, ...prev.events].sort(compareEvents),
    nextBefore: prev.nextBefore,
    olderLoaded: true,
  });
}

/** Append a "Show older" page fetched with `cursor`. Ignored (returns
 *  `prev` unchanged) when the feed moved on while it loaded — replaced
 *  by a refresh, or cleared by a move change. */
export function appendOlderPage(
  prev: FeedState | null, cursor: string, page: TruckFeedPage,
): FeedState | null {
  if (!prev || prev.nextBefore !== cursor) return prev;
  const seen = new Set(prev.events.map((e) => e.id));
  return {
    events: [...prev.events, ...page.events.filter((e) => !seen.has(e.id))],
    nextBefore: page.next_before,
    olderLoaded: true,
  };
}

/* ── trucks table ────────────────────────────────────────────────── */

const LIVE = new Set<string>(SHIPMENT_STATUSES);

/** The table's rows: non-archived trucks in the three live statuses,
 *  optionally one move's. */
export function shipmentTrucks(trucks: TruckItem[], initiativeId: string | null): TruckItem[] {
  return trucks.filter((t) => !t.archived_at && LIVE.has(t.status)
    && (!initiativeId || t.initiative_id === initiativeId));
}

/** Move picker: "All moves", then every move a non-archived truck is on
 *  (naturally sorted). `archivedMoves`, when the viewer can read the
 *  initiatives list, drops archived moves. */
export function shipmentMoveOptions(
  trucks: TruckItem[], archivedMoves: Set<string> | null,
): ComboOption[] {
  const byId = new Map<string, string>();
  for (const t of trucks) {
    if (t.archived_at || !t.initiative_id) continue;
    if (archivedMoves?.has(t.initiative_id)) continue;
    byId.set(t.initiative_id, t.initiative_name ?? 'Unnamed move');
  }
  const moves = [...byId].map(([value, label]) => ({ value, label }))
    .sort((a, b) => naturalCompare(a.label, b.label));
  return [{ value: '', label: 'All moves' }, ...moves];
}

// The always-shown truck name cell, outside the toggle registry.
export const SHIPMENT_PRIMARY_COL: ColumnDef = {
  key: 'primary', label: 'Truck', width: '1.6fr', default: true, min: 160,
};

// Fit: these columns + the primary ≤ LIST_FIT.dashPanel (the list sits in
// a .dash-panel) — asserted in shipments.test.ts.
export const SHIPMENT_COLUMNS: ColumnDef[] = [
  { key: 'status', label: 'Status', width: '1fr', default: true },
  { key: 'load', label: 'Load #', width: '0.8fr', default: true, min: 90 },
  { key: 'route', label: 'Route', width: '1.6fr', default: true },
  { key: 'location', label: 'Last location', short: 'Location', width: '1.4fr', default: true },
  { key: 'last_update', label: 'Last update', short: 'Updated', width: '0.9fr', default: true, min: 96 },
  { key: 'containers', label: 'Containers', width: '0.8fr', default: true },
];

function lastLocation(t: TruckItem): string {
  const u = t.last_update;
  if (!u) return '—';
  if (u.approximate_address) return u.approximate_address;
  if (u.lat !== null && u.lng !== null) return `${u.lat}, ${u.lng}`;
  return '—';
}

export function shipmentCellText(t: TruckItem, key: string): string {
  switch (key) {
    case 'primary': return t.name;
    case 'status': return t.status_label;
    case 'load': return t.load_number ?? '—';
    case 'route': return `${t.start_site_name ?? '—'} → ${t.end_site_name ?? '—'}`;
    case 'location': return lastLocation(t);
    case 'containers': return String(t.container_count);
    default: return '';
  }
}

/** Sort value per column, for compareValues (numbers by value, text
 *  naturally, nulls first). Last update sorts by the ISO stamp. */
export function shipmentSortValue(t: TruckItem, key: string): string | number | null {
  switch (key) {
    case 'containers': return t.container_count;
    case 'last_update': return t.last_update?.recorded_at ?? null;
    case 'load': return t.load_number;
    case 'location': return t.last_update ? lastLocation(t) : null;
    default: return shipmentCellText(t, key);
  }
}
