/**
 * DeliveryLogTab — System › Notifications › Delivery log (super admin and
 * above): every notification and email decision the API recorded, newest
 * first, as the standard server-paged directory list (usePagedList over
 * GET /notifications/log; RawScansTab is the model). The toolbar holds the
 * time range (default 7 days), the server search, the Outcome / Channel /
 * Category facets and Check delivery; "Load more" brings the next page. A
 * row's chevron opens its trail (DeliveryLogTrail).
 *
 * Outcome sends every event picked. Channel and Category send one value
 * each, because the API filters by one: picking a second one in the Filters
 * menu replaces the first.
 */

import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError, getDeliveryLogPage,
  type DeliveryLogEntry, type DeliveryLogQuery, type NotificationCategory,
} from '../../lib/api';
import {
  DELIVERY_LOG_COLUMNS as COLUMNS, DELIVERY_LOG_EVENTS, DELIVERY_LOG_TRAILING, EVENT_LABELS,
  LOG_CHANNEL_LABELS, TIME_RANGES, channelLabel, describeEntry, outcomeOf, sinceFor, type TimeRange,
} from '../../lib/deliveryLog';
import { fullDateTime, relativeTime } from '../../lib/format';
import {
  ColHead, FilterButton, listGridStyle, listScale, titleFor, type FacetGroup, type FacetState,
} from '../../lib/listTools';
import { NOTIFICATION_CATEGORIES, categoryLabel } from '../../lib/notificationKinds';
import { usePagedList } from '../../lib/usePagedList';
import { VirtualRows } from '../../lib/virtualRows';
import CheckDeliveryModal from './CheckDeliveryModal';
import DeliveryLogTrail from './DeliveryLogTrail';
import '../../styles/directory.css';
import '../../styles/profile.css';         // .btn-solid, .pf-error, .audit-more
import '../../styles/notifications.css';

const FACET_GROUPS: FacetGroup[] = [
  { key: 'outcome', title: 'Outcome',
    options: DELIVERY_LOG_EVENTS.map((e) => ({ value: e, label: EVENT_LABELS[e] })) },
  { key: 'channel', title: 'Channel',
    options: Object.entries(LOG_CHANNEL_LABELS).map(([value, label]) => ({ value, label })) },
  { key: 'category', title: 'Category',
    options: NOTIFICATION_CATEGORIES.map((c) => ({ value: c.key, label: c.label })) },
];

/** Facet groups the API filters by a single value. */
const ONE_VALUE = new Set(['channel', 'category']);

/** The one value picked in a single-value group, or null for none. */
const picked = (values: Set<string> | undefined): string | null =>
  (values && values.size === 1 ? [...values][0] : null);

/** A click on a link inside a row opens the link, not the row. */
const stop = (e: MouseEvent) => e.stopPropagation();

export default function DeliveryLogTab({ onCount }: {
  /** The total the page header shows (null when the list failed to load). */
  onCount?: (n: number | null) => void;
}) {
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});
  const [range, setRange] = useState<TimeRange>('7d');
  // Fixed when the range is picked: a `since` recomputed every render would
  // change the query, and with it reload page 1, on every render.
  const [since, setSince] = useState<string | null>(() => sinceFor('7d'));
  const [openId, setOpenId] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);

  const pickRange = (next: TimeRange) => {
    setRange(next);
    setSince(sinceFor(next));
  };

  // A single-value group keeps only the value just clicked.
  const pickFacets = (next: FacetState) => setFacets(Object.fromEntries(
    Object.entries(next).map(([key, values]) => [key, ONE_VALUE.has(key) && values.size > 1
      ? new Set([...values].filter((v) => !facets[key]?.has(v)))
      : values])));

  const logQuery = useMemo<DeliveryLogQuery>(() => ({
    events: DELIVERY_LOG_EVENTS.filter((e) => facets.outcome?.has(e)),
    channel: picked(facets.channel) as DeliveryLogQuery['channel'],
    category: picked(facets.category) as NotificationCategory | null,
    since,
  }), [facets, since]);

  const list = usePagedList<DeliveryLogEntry, DeliveryLogQuery>({
    query: logQuery,
    search: query.trim(),
    fetchPage: async (params, signal) => {
      try {
        return await getDeliveryLogPage(params, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        if (params.cursor) throw new Error("Couldn't load more entries.");
        throw new Error(err instanceof ApiError && err.status === 403
          ? 'Only super admins and above can read the delivery log.'
          : 'Failed to load the delivery log.');
      }
    },
  });
  const { rows, total } = list;
  const failed = list.error !== null && rows.length === 0;
  const moreFailed = list.error !== null && rows.length > 0;

  // The page header's count follows the server total.
  useEffect(() => {
    if (failed) onCount?.(null);
    else if (!list.loading) onCount?.(total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, list.loading, total]);

  const grid = listGridStyle(COLUMNS, DELIVERY_LOG_TRAILING, undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  const cellFor = (e: DeliveryLogEntry, key: string) => {
    switch (key) {
      case 'when':
        return <span className="mono cell-line" title={fullDateTime(e.at)}>{relativeTime(e.at)}</span>;
      case 'person': {
        if (!e.person_id) return <span className="cell-top">—</span>;
        const name = e.person_name ?? 'Unknown person';
        return (
          <Link className="cell-top cell-line dlog-person" to={`/people/users/${e.person_id}`}
                title={name} onClick={stop}>{name}</Link>
        );
      }
      case 'notification': {
        // Template mail mirrors no notification: its kind label (the template) stands in.
        const title = e.notification_title ?? e.kind_label ?? e.kind ?? '—';
        const kind = e.notification_title ? e.kind_label : null;
        return (
          <div className="cell-primary">
            <div className="pn">
              <b title={titleFor(title)}>{title}</b>
              {kind && <span title={kind}>{kind}</span>}
            </div>
          </div>
        );
      }
      case 'category': {
        if (!e.category) return <span className="cell-top">—</span>;
        const label = categoryLabel(e.category);
        return <span className="chip tag" title={label}>{label}</span>;
      }
      case 'channel':
        return <span className="chip tag">{channelLabel(e.channel)}</span>;
      case 'outcome': {
        const outcome = outcomeOf(e);
        return <span className={`chip ${outcome.chip}`} title={outcome.label}>{outcome.label}</span>;
      }
      case 'detail': {
        const text = describeEntry(e) || '—';
        return <span className="cell-sub cell-clamp2" title={titleFor(text)}>{text}</span>;
      }
      default:
        return null;
    }
  };

  return (
    <>
      <div className="dir-toolbar">
        <div className="segmented" role="group" aria-label="Time range">
          {TIME_RANGES.map((r) => (
            <button key={r.key} type="button" className={range === r.key ? 'on' : ''}
                    aria-pressed={range === r.key} onClick={() => pickRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" aria-label="Search the delivery log" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count" aria-live="polite">
            {failed ? '' : list.loading && rows.length === 0 ? 'Loading…'
              : list.reloading ? 'Updating…'
                : `${rows.length.toLocaleString()} of ${total.toLocaleString()} shown`}
          </span>
          <FilterButton groups={FACET_GROUPS} state={facets} onChange={pickFacets} />
          <button type="button" className="btn-solid" onClick={() => setChecking(true)}>
            Check delivery
          </button>
        </div>
      </div>

      {failed && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load the delivery log</b>{list.error}
          <div className="audit-more">
            <button type="button" className="mini-btn" onClick={list.reload}>Reload</button>
          </div>
        </div>
      )}

      {!failed && (
        <div className="dir-list list-scroll dlog-list" aria-busy={list.loading}>
          <div className="list-head" style={rowStyle}>
            {COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
            <span className="col-head" aria-hidden="true" />
          </div>

          {!list.loading && !list.error && rows.length === 0 && (
            <div className="dir-empty">
              <b>Nothing logged</b>
              No notification or email decisions match — try a longer time range or fewer filters.
            </div>
          )}

          <VirtualRows rows={rows}
            renderRow={(e, vp) => {
              const open = openId === e.id;
              return (
                <div key={e.id} className={`dir-row ${open ? 'open' : ''}`}
                     {...vp} style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                  <div className="row-main" style={rowStyle} onClick={() => setOpenId(open ? null : e.id)}>
                    {COLUMNS.map((c) => (
                      <div className="cell" key={c.key}>{cellFor(e, c.key)}</div>
                    ))}
                    <div className="cell chevron-cell">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                           strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                    </div>
                  </div>

                  <div className="detail">
                    <div className="detail-clip">
                      <div className="detail-inner">
                        {open && <DeliveryLogTrail entry={e} />}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }} />
        </div>
      )}

      {moreFailed && (
        <div className="audit-more notif-more">
          <span className="pf-error" role="alert">{list.error}</span>
          <button type="button" className="mini-btn" onClick={list.retry}>Retry</button>
        </div>
      )}
      {list.hasMore && !moreFailed && (
        <div className="audit-more">
          <button type="button" className="mini-btn" disabled={list.loadingMore} onClick={list.loadMore}>
            {list.loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      {checking && <CheckDeliveryModal onClose={() => setChecking(false)} />}
    </>
  );
}
