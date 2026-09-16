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

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

import ComboBox from '../components/ComboBox';
import InitiativeHoverCard from '../components/initiatives/InitiativeHoverCard';
import {
  ApiError, listInitiatives, listInitiativeStatuses,
  type InitiativeItem, type StatusValue,
} from '../lib/api';
import { longDateOf } from '../lib/format';
import {
  barFor, calendarWeeks, monthBandsFor, monthGrid, parseApiDay, rangeFor, realBarFor,
  sortForTimeline, ticksFor, type CalendarSegment, type TimelineBar, type TimelineRange,
  type TimelineScale,
} from '../lib/timeline';
import '../styles/directory.css';
import '../styles/trucks.css'; // .pill-check — shared generic toolbar checkbox pill
import '../styles/initiative-timeline.css';

type View = 'timeline' | 'calendar';

const TYPE_PILLS = [
  { key: 'all', label: 'All' },
  { key: 'project', label: 'Projects' },
  { key: 'event', label: 'Events' },
  { key: 'move', label: 'Moves' },
];

const SCALES: { key: TimelineScale; label: string }[] = [
  { key: 'month', label: 'Month' },
  { key: '45d', label: '45 days' },
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

/** `month` is the pre-rename stored value for what is now `calendar` — a
 *  browser that remembers it keeps the same view instead of silently
 *  falling back to the timeline. */
function readView(v: string): View {
  if (v === 'month' || v === 'calendar') return 'calendar';
  return 'timeline';
}
function isScale(v: string): v is TimelineScale {
  return v === 'month' || v === '45d' || v === 'quarter' || v === 'year';
}

function startOfToday(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function stepAnchor(anchor: Date, view: View, scale: TimelineScale, dir: 1 | -1): Date {
  const out = new Date(anchor);
  if (view === 'calendar' || scale === 'month') {
    out.setMonth(out.getMonth() + dir);
  } else if (scale === '45d') {
    // Six whole weeks, not 45 days. The range snaps to the anchor week's
    // Monday, so a 45-day step would land mid-week and snap back to the same
    // Monday + 42 anyway — stepping by 42 says that outright. Consecutive
    // views therefore share their last three days, which is a useful overlap
    // rather than a gap: a run straddling the boundary appears in both.
    out.setDate(out.getDate() + dir * 42);
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

/** The `--chip` color for a bar or span: the initiative's own calendar
 *  color, or its status color while it has none of its own. */
function chipColor(i: InitiativeItem): string {
  return i.color ?? i.status_color;
}

export default function InitiativeTimeline() {
  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [error, setError] = useState('');

  const [view, setView] = useState<View>(() => readView(loadPref('view', 'timeline')));
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

  const rangeLabel = view === 'calendar'
    ? `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`
    : null;

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Initiatives</div>
          <h1 className="page-title">Timeline</h1>
          <p className="page-hint">
            Scheduled and in-flight initiatives on a timeline or a month calendar,
            each run drawn as one bar across the days it covers.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="tablist">
          {(['timeline', 'calendar'] as View[]).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'timeline' ? 'Timeline' : 'Calendar'}
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

      {view === 'calendar' && (
        <div className="itl-month-nav">
          <span className="cell-top itl-month-label">{rangeLabel}</span>
          <button type="button" className="mini-btn" aria-label="Previous month"
                  onClick={() => setAnchor((a) => stepAnchor(a, view, scale, -1))}>‹</button>
          <button type="button" className="mini-btn" onClick={() => setAnchor(startOfToday())}>
            Today
          </button>
          <button type="button" className="mini-btn" aria-label="Next month"
                  onClick={() => setAnchor((a) => stepAnchor(a, view, scale, 1))}>›</button>
        </div>
      )}

      {error && <div className="dir-empty"><b>Cannot load initiatives</b>{error}</div>}

      {!error && initiatives === null && <div className="dir-empty"><b>Loading…</b></div>}

      {!error && initiatives !== null && view === 'timeline' && (
        <TimelineGrid items={filtered} anchor={anchor} scale={scale} />
      )}

      {!error && initiatives !== null && view === 'calendar' && (
        <CalendarMonth items={filtered} anchor={anchor} />
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
  // The day/week rulers read as "… 29 30 1 2 …" across a month boundary, so
  // they get a band naming each month above them. The year ruler's ticks are
  // already month names, so a band there would only repeat them.
  const bands = useMemo(
    () => (scale === 'year' ? [] : monthBandsFor(range)), [range, scale]);
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

  const rightWidth = scale === 'month' || scale === '45d'
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
          <div className="itl-ruler" style={{ width: rightWidth }}>
            {bands.length > 0 && (
              <div className="itl-band">
                {bands.map((b, idx) => (
                  <span key={idx} className="cell-top itl-band-seg"
                        style={{ left: `${b.left}%`, width: `${b.width}%` }}>
                    {b.label}
                  </span>
                ))}
              </div>
            )}
            {/* --tick-w caps every label at its own slot, so a long one is
                trimmed rather than printed over the next tick. */}
            <div className="itl-ticks"
                 style={{ '--tick-w': `${rightWidth / ticks.length}px` } as CSSProperties}>
              {ticks.map((t, idx) => (
                <span key={idx} className="itl-tick"
                      style={{ left: `${pctForDate(t.at, range) ?? 0}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
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
              <div className="itl-bar" title={spanTitle(item)}
                   style={{
                     left: `${bar.left}%`, width: `${bar.width}%`,
                     '--chip': chipColor(item),
                   } as CSSProperties}>
                {(bar.width / 100) * rightWidth >= 80 && (
                  <span className="itl-bar-label">{item.name}</span>
                )}
              </div>
              {realBar && (
                <div className="itl-real-bar"
                     style={{
                       left: `${realBar.left}%`, width: `${realBar.width}%`,
                       '--chip': chipColor(item),
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

/* ── Calendar view ────────────────────────────────────────────────── */

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Stacked runs a week row shows before the rest fold into "+N more".
 *  Four keeps the tallest week inside a cell that still shows the whole
 *  month without the page scrolling on a laptop; a crowded week is one
 *  click from showing every lane. */
const MAX_LANES = 4;

/** Local calendar date as YYYY-MM-DD, for a stable React key. Built from
 *  the local parts rather than toISOString(), which names the previous day
 *  west of UTC and would collide two rows onto one key across a month. */
function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Bar tooltip. The dates go through parseApiDay/longDateOf, not longDate:
 *  a date-only field arrives as midnight UTC, so `new Date(iso)` would name
 *  the day before the one the bar is actually drawn on. */
function spanTitle(i: InitiativeItem): string {
  const start = parseApiDay(i.scheduled_start as string);
  const end = i.scheduled_end ? parseApiDay(i.scheduled_end) : start;
  const range = end.getTime() !== start.getTime()
    ? `${longDateOf(start)} → ${longDateOf(end)}`
    : longDateOf(start);
  return `${i.name} · ${i.status_label} · ${range}`;
}

function CalendarMonth({ items, anchor }: { items: InitiativeItem[]; anchor: Date }) {
  const cells = useMemo(() => monthGrid(anchor), [anchor]);
  const weeks = useMemo(() => calendarWeeks(items, cells), [items, cells]);
  const [expanded, setExpanded] = useState<string | null>(null);

  // A month step swaps the whole grid out from under the expanded row.
  useEffect(() => { setExpanded(null); }, [anchor]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setExpanded(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded]);

  return (
    <div className="itl-month-grid">
      <div className="itl-weekdays">
        {WEEKDAY_LABELS.map((w) => <div key={w} className="itl-weekday">{w}</div>)}
      </div>

      {weeks.map((week) => {
        const key = isoDay(week.days[0].date);
        const isOpen = expanded === key;
        const laneCap = isOpen ? week.laneCount : MAX_LANES;
        const shown = week.segments.filter((s) => s.lane < laneCap);
        const hidden = week.segments.filter((s) => s.lane >= laneCap);
        // A day's "+N more" counts the runs crossing that day that the
        // lane cap dropped — the count belongs to the day, the row it
        // opens belongs to the week.
        const hiddenOnDay = (col: number) => hidden.filter(
          (s) => col >= s.startCol && col < s.startCol + s.span).length;
        const rows = Math.min(week.laneCount, laneCap) + (hidden.length || isOpen ? 1 : 0);

        return (
          <div className={`itl-week ${isOpen ? 'open' : ''}`} key={key}
               style={{ '--rows': rows } as CSSProperties}>
            {week.days.map((cell, col) => {
              const more = hiddenOnDay(col);
              return (
                <div key={isoDay(cell.date)}
                     className={`itl-day-cell ${cell.inMonth ? '' : 'muted'} ` +
                                `${cell.isToday ? 'today' : ''}`}>
                  <span className="mono itl-day-num">{cell.date.getDate()}</span>
                  {more > 0 && (
                    <button type="button" className="itl-more-btn"
                            aria-label={'Show all initiatives for the week of ' +
                                        longDateOf(week.days[0].date)}
                            onClick={() => setExpanded(key)}>
                      +{more} more
                    </button>
                  )}
                </div>
              );
            })}

            <div className="itl-week-bars">
              {shown.map((seg) => (
                <CalendarSpan key={seg.item.id} seg={seg} />
              ))}
            </div>

            {isOpen && (
              <button type="button" className="itl-less-btn"
                      onClick={() => setExpanded(null)}>
                Show less
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One run's bar across the days it covers in this week. A run reaching
 *  past either edge keeps its square end there, so a bar that carries on
 *  into the next week reads as continuing rather than ending on Sunday. */
function CalendarSpan({ seg }: { seg: CalendarSegment<InitiativeItem> }) {
  const i = seg.item;
  return (
    // The hover card replaces the native `title` the bar used to carry:
    // one flat line on the browser's own schedule becomes the
    // initiative's high-level details on ours. The wrapper draws no box
    // of its own, so the bar keeps its place in the week grid.
    <InitiativeHoverCard item={i}>
      <Link to={`/initiatives/${i.id}`}
            className={`chip custom itl-span ${seg.continuesBefore ? 'cont-before' : ''} ` +
                       `${seg.continuesAfter ? 'cont-after' : ''}`}
            style={{
              gridColumn: `${seg.startCol + 1} / span ${seg.span}`,
              gridRow: seg.lane + 1,
              '--chip': chipColor(i),
            } as CSSProperties}>
        <span className="dot" />
        <span className="itl-span-name">{i.name}</span>
      </Link>
    </InitiativeHoverCard>
  );
}
