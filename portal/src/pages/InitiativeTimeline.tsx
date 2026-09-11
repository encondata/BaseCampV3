/**
 * Initiatives › Timeline — a second view onto the same initiatives list
 * (Initiatives.tsx owns the record grid; this page is read-only, no edit
 * modal, no row detail): a Gantt-style timeline and a month calendar, so
 * scheduling conflicts and upcoming work are visible at a glance. No new
 * data — everything comes from listInitiatives(); the pure range/tick/bar/
 * grid math lives in lib/timeline.ts (unit-tested there, no DOM).
 *
 * Persistence: view/scale/type/status survive a reload via localStorage
 * (usePersistentListState's shape is column-menu specific — visible
 * columns, sort, column filters — and doesn't fit this page's plain
 * toolbar state cleanly, so this follows the same plain-localStorage
 * idiom as Warehouse.tsx's remembered site). The range anchor date is
 * session state only, per the design spec.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

import ComboBox from '../components/ComboBox';
import {
  ApiError, listInitiatives, listInitiativeStatuses,
  type InitiativeItem, type StatusValue,
} from '../lib/api';
import {
  barFor, itemsOnDay, monthGrid, rangeFor, realBarFor, sortForTimeline,
  ticksFor, type TimelineBar, type TimelineRange, type TimelineScale,
} from '../lib/timeline';
import '../styles/directory.css';
import '../styles/trucks.css'; // .pill-check — shared generic toolbar checkbox pill
import '../styles/initiative-timeline.css';

type View = 'timeline' | 'month';

const TYPE_PILLS = [
  { key: 'all', label: 'All' },
  { key: 'project', label: 'Projects' },
  { key: 'event', label: 'Events' },
  { key: 'move', label: 'Moves' },
];

const SCALES: { key: TimelineScale; label: string }[] = [
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'year', label: 'Year' },
];

const STORAGE_PREFIX = 'initiatives-timeline.';

function loadPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key) ?? fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string) {
  try { localStorage.setItem(STORAGE_PREFIX + key, value); } catch { /* ignore */ }
}

function isView(v: string): v is View {
  return v === 'timeline' || v === 'month';
}
function isScale(v: string): v is TimelineScale {
  return v === 'month' || v === 'quarter' || v === 'year';
}

function startOfToday(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function stepAnchor(anchor: Date, view: View, scale: TimelineScale, dir: 1 | -1): Date {
  const out = new Date(anchor);
  if (view === 'month' || scale === 'month') {
    out.setMonth(out.getMonth() + dir);
  } else if (scale === 'quarter') {
    out.setMonth(out.getMonth() + dir * 3);
  } else {
    out.setFullYear(out.getFullYear() + dir);
  }
  return out;
}

/** Percent position of `date` within `range`, or null when it falls
 *  outside — used for the today line in the timeline's right pane. */
function pctForDate(date: Date, range: TimelineRange): number | null {
  if (date < range.start || date >= range.end) return null;
  const total = range.end.getTime() - range.start.getTime();
  return ((date.getTime() - range.start.getTime()) / total) * 100;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function clientSiteLine(i: InitiativeItem): string {
  return [i.client_name, i.site_name].filter(Boolean).join(' · ') || '—';
}

export default function InitiativeTimeline() {
  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [error, setError] = useState('');

  const [view, setView] = useState<View>(() => {
    const v = loadPref('view', 'timeline');
    return isView(v) ? v : 'timeline';
  });
  const [scale, setScale] = useState<TimelineScale>(() => {
    const v = loadPref('scale', 'month');
    return isScale(v) ? v : 'month';
  });
  const [typePill, setTypePill] = useState(() => loadPref('type', 'all'));
  const [statusPill, setStatusPill] = useState(() => loadPref('status', 'all'));

  const [showCancelled, setShowCancelled] = useState(false);
  const [clientId, setClientId] = useState('');
  const [anchor, setAnchor] = useState<Date>(() => startOfToday());

  useEffect(() => { savePref('view', view); }, [view]);
  useEffect(() => { savePref('scale', scale); }, [scale]);
  useEffect(() => { savePref('type', typePill); }, [typePill]);
  useEffect(() => { savePref('status', statusPill); }, [statusPill]);

  useEffect(() => {
    void listInitiatives().then(setInitiatives).catch((err) => {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view initiatives.'
        : 'Failed to load initiatives.');
    });
    void listInitiativeStatuses().then(setStatuses).catch(() => {});
  }, []);

  const typeCounts = useMemo(() => {
    const c: Record<string, number> = { all: initiatives?.length ?? 0 };
    for (const pl of TYPE_PILLS.slice(1)) c[pl.key] = 0;
    for (const i of initiatives ?? []) c[i.initiative_type] = (c[i.initiative_type] ?? 0) + 1;
    return c;
  }, [initiatives]);

  const statusOptions = useMemo(
    () => statuses.filter((s) => s.key !== 'cancelled'),
    [statuses]);

  const clientOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of initiatives ?? []) {
      if (i.client_id && i.client_name && !seen.has(i.client_id)) {
        seen.set(i.client_id, i.client_name);
      }
    }
    return [...seen.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
  }, [initiatives]);

  const filtered = useMemo(() => {
    if (!initiatives) return [];
    return initiatives.filter((i) => {
      if (i.archived_at) return false;
      if (!showCancelled && i.status === 'cancelled') return false;
      if (typePill !== 'all' && i.initiative_type !== typePill) return false;
      if (statusPill !== 'all' && i.status !== statusPill) return false;
      if (clientId && i.client_id !== clientId) return false;
      return true;
    });
  }, [initiatives, showCancelled, typePill, statusPill, clientId]);

  const rangeLabel = view === 'month'
    ? `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`
    : null;

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Initiatives</div>
          <h1 className="page-title">Timeline</h1>
          <p className="page-hint">
            Scheduled and in-flight initiatives on a timeline or a month calendar.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="tablist">
          {(['timeline', 'month'] as View[]).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'timeline' ? 'Timeline' : 'Month'}
            </button>
          ))}
        </div>
        <div className="segmented" role="tablist">
          {TYPE_PILLS.map((pl) => (
            <button key={pl.key} className={typePill === pl.key ? 'on' : ''}
                    onClick={() => setTypePill(pl.key)}>
              {pl.label} <span className="n">{typeCounts[pl.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="segmented" role="tablist">
          <button className={statusPill === 'all' ? 'on' : ''} onClick={() => setStatusPill('all')}>
            All
          </button>
          {statusOptions.map((s) => (
            <button key={s.key} className={statusPill === s.key ? 'on' : ''}
                    onClick={() => setStatusPill(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="itl-client-filter">
          <ComboBox placeholder="Filter by client…" value={clientId} clearable
                     onChange={setClientId} options={clientOptions} />
        </div>
        <label className="pill-check">
          <input type="checkbox" checked={showCancelled}
                 onChange={(e) => setShowCancelled(e.target.checked)} />
          Show cancelled
        </label>
        <div className="toolbar-right">
          {view === 'timeline' && (
            <>
              <div className="itl-range-nav">
                <button type="button" className="mini-btn" aria-label="Previous period"
                        onClick={() => setAnchor((a) => stepAnchor(a, view, scale, -1))}>‹</button>
                <button type="button" className="mini-btn" onClick={() => setAnchor(startOfToday())}>
                  Today
                </button>
                <button type="button" className="mini-btn" aria-label="Next period"
                        onClick={() => setAnchor((a) => stepAnchor(a, view, scale, 1))}>›</button>
              </div>
              <div className="segmented" role="tablist">
                {SCALES.map((s) => (
                  <button key={s.key} className={scale === s.key ? 'on' : ''}
                          onClick={() => setScale(s.key)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {view === 'month' && (
        <div className="itl-month-nav">
          <button type="button" className="mini-btn" aria-label="Previous month"
                  onClick={() => setAnchor((a) => stepAnchor(a, view, scale, -1))}>‹</button>
          <span className="cell-top itl-month-label">{rangeLabel}</span>
          <button type="button" className="mini-btn" aria-label="Next month"
                  onClick={() => setAnchor((a) => stepAnchor(a, view, scale, 1))}>›</button>
          <button type="button" className="mini-btn" onClick={() => setAnchor(startOfToday())}>
            Today
          </button>
        </div>
      )}

      {error && <div className="dir-empty"><b>Cannot load initiatives</b>{error}</div>}

      {!error && initiatives === null && <div className="dir-empty"><b>Loading…</b></div>}

      {!error && initiatives !== null && view === 'timeline' && (
        <TimelineGrid items={filtered} anchor={anchor} scale={scale} />
      )}

      {!error && initiatives !== null && view === 'month' && (
        <MonthCalendar items={filtered} anchor={anchor} />
      )}
    </div>
  );
}

/* ── Timeline view ────────────────────────────────────────────────── */

function TimelineGrid({
  items, anchor, scale,
}: { items: InitiativeItem[]; anchor: Date; scale: TimelineScale }) {
  const range = useMemo(() => rangeFor(anchor, scale), [anchor, scale]);
  const ticks = useMemo(() => ticksFor(range, scale), [range, scale]);
  const today = useMemo(() => startOfToday(), []);
  const todayPct = useMemo(() => pctForDate(today, range), [today, range]);

  const sorted = useMemo(() => sortForTimeline(items), [items]);
  const scheduledRows = useMemo(() => {
    const rows = sorted
      .filter((i) => i.scheduled_start)
      .map((item) => ({ item, bar: barFor(item, range), realBar: realBarFor(item, range, today) }))
      .filter((r) => r.bar !== null);
    return rows as { item: InitiativeItem; bar: TimelineBar; realBar: TimelineBar | null }[];
  }, [sorted, range, today]);
  const unscheduledRows = useMemo(() => sorted.filter((i) => !i.scheduled_start), [sorted]);

  const rightWidth = scale === 'month'
    ? Math.max(760, ticks.length * 32)
    : scale === 'quarter'
      ? Math.max(760, ticks.length * 84)
      : Math.max(760, ticks.length * 110);

  if (scheduledRows.length === 0 && unscheduledRows.length === 0) {
    return <div className="dir-empty"><b>No initiatives in this range.</b></div>;
  }

  return (
    <div className="itl-scroll">
      <div className="itl-inner" style={{ width: 260 + rightWidth }}>
        <div className="itl-header-row">
          <div className="itl-corner" />
          <div className="itl-ticks" style={{ width: rightWidth }}>
            {ticks.map((t, idx) => (
              <span key={idx} className="itl-tick"
                    style={{ left: `${pctForDate(t.at, range) ?? 0}%` }}>
                {t.label}
              </span>
            ))}
          </div>
        </div>

        {scheduledRows.map(({ item, bar, realBar }) => (
          <div className="itl-row" key={item.id}>
            <div className="itl-row-label">
              <Link to={`/initiatives/${item.id}`} className="pn">
                <b>{item.name}</b>
                <span>{clientSiteLine(item)}</span>
              </Link>
            </div>
            <div className="itl-row-bars" style={{ width: rightWidth }}>
              {todayPct !== null && <div className="itl-today-line" style={{ left: `${todayPct}%` }} />}
              <div className="itl-bar" title={`${item.name} · ${item.status_label} · ` +
                  `${item.scheduled_start ?? '?'} → ${item.scheduled_end ?? item.scheduled_start ?? '?'}`}
                   style={{
                     left: `${bar.left}%`, width: `${bar.width}%`,
                     '--chip': item.status_color,
                   } as CSSProperties}>
                {(bar.width / 100) * rightWidth >= 80 && (
                  <span className="itl-bar-label">{item.name}</span>
                )}
              </div>
              {realBar && (
                <div className="itl-real-bar"
                     style={{
                       left: `${realBar.left}%`, width: `${realBar.width}%`,
                       '--chip': item.status_color,
                     } as CSSProperties} />
              )}
            </div>
          </div>
        ))}

        {unscheduledRows.length > 0 && (
          <div className="itl-row itl-divider-row">
            <div className="itl-row-label itl-divider">Unscheduled</div>
            <div className="itl-row-bars" style={{ width: rightWidth }} />
          </div>
        )}
        {unscheduledRows.map((item) => (
          <div className="itl-row" key={item.id}>
            <div className="itl-row-label">
              <Link to={`/initiatives/${item.id}`} className="pn">
                <b>{item.name}</b>
                <span>{clientSiteLine(item)}</span>
              </Link>
            </div>
            <div className="itl-row-bars" style={{ width: rightWidth }}>
              <span className="cell-top itl-no-dates">No dates yet</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Month view ───────────────────────────────────────────────────── */

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function MonthCalendar({ items, anchor }: { items: InitiativeItem[]; anchor: Date }) {
  const cells = useMemo(() => monthGrid(anchor), [anchor]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openKey) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenKey(null);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [openKey]);

  return (
    <div className="itl-month-grid" ref={wrapRef}>
      {WEEKDAY_LABELS.map((w) => <div key={w} className="itl-weekday">{w}</div>)}
      {cells.map((cell) => {
        const key = cell.date.toISOString().slice(0, 10);
        const dayItems = itemsOnDay(items, cell.date);
        const shown = dayItems.slice(0, 3);
        const extra = dayItems.length - shown.length;
        return (
          <div key={key}
               className={`itl-day-cell ${cell.inMonth ? '' : 'muted'} ${cell.isToday ? 'today' : ''}`}>
            <span className="mono itl-day-num">{cell.date.getDate()}</span>
            <div className="itl-day-chips">
              {shown.map((i) => (
                <Link key={i.id} to={`/initiatives/${i.id}`}
                      className="chip custom itl-day-chip"
                      style={{ '--chip': i.status_color } as CSSProperties}
                      title={i.name}>
                  <span className="dot" />{i.name}
                </Link>
              ))}
              {extra > 0 && (
                <div className="itl-more-wrap pop-wrap">
                  <button type="button" className="itl-more-btn"
                          onClick={() => setOpenKey(openKey === key ? null : key)}>
                    +{extra} more
                  </button>
                  {openKey === key && (
                    <div className="pop-menu itl-more-menu">
                      {dayItems.map((i) => (
                        <Link key={i.id} to={`/initiatives/${i.id}`} className="pop-item">
                          <span className="chip custom" style={{ '--chip': i.status_color } as CSSProperties}>
                            <span className="dot" />{i.name}
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
