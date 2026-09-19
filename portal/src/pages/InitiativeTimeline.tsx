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
 *
 * Hierarchy: both views read the same tree as Initiatives.tsx
 * (lib/initiatives.ts's buildInitiativeTree) and the same collapsed set
 * under `initiatives.collapsed`, so a project collapsed in one view is
 * collapsed in the others. The timeline nests rows with a chevron and an
 * indent, and gives a dateless parent the outline bar its scheduled
 * descendants imply; the calendar, which has no rows to indent, shows
 * the hierarchy as `Parent › Child` on a child's segment and draws no
 * derived envelope at all.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState, type CSSProperties,
} from 'react';
import { Link } from 'react-router-dom';

import ComboBox from '../components/ComboBox';
import InitiativeHoverCard from '../components/initiatives/InitiativeHoverCard';
import {
  ApiError, listInitiatives, listInitiativeStatuses,
  type InitiativeItem, type StatusValue,
} from '../lib/api';
import { longDateOf } from '../lib/format';
import {
  buildInitiativeTree, derivedSpan, readCollapsed, writeCollapsed,
  type InitiativeTreeRow,
} from '../lib/initiatives';
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

  /* Everything this page may show AT ALL, in row order — the tree's
   * input, and the map both views walk for parents and descendants.
   * Only the archived facet narrows it: an ancestor excluded by a pill
   * still has to be available as context under a matched child, and a
   * dateless parent still borrows its envelope from descendants the
   * pills hide. What the pills decide is `filtered`, not what renders. */
  const sortedAll = useMemo(
    () => sortForTimeline((initiatives ?? []).filter((i) => !i.archived_at)),
    [initiatives]);

  /* Shared with the list view under `initiatives.collapsed`, and with the
   * calendar below, so collapsing a project anywhere collapses it
   * everywhere. Read once on mount and written only on a toggle — a
   * write on mount would rewrite another tab's set with our own. */
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const toggleCollapsed = useCallback((id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);
  /* The write is a side effect, so it belongs in an effect and not in the
   * updater above, which StrictMode double-invokes. The ref holds the set
   * we last saw: on mount — and on StrictMode's second setup, which sees
   * the very same object — it only records, never writes. */
  const writtenCollapsed = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (writtenCollapsed.current === collapsed) return;
    const firstSeen = writtenCollapsed.current === null;
    writtenCollapsed.current = collapsed;
    if (!firstSeen) writeCollapsed(collapsed);
  }, [collapsed]);

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
        <TimelineGrid items={filtered} all={sortedAll} anchor={anchor} scale={scale}
                      collapsed={collapsed} onToggle={toggleCollapsed} />
      )}

      {!error && initiatives !== null && view === 'calendar' && (
        <CalendarMonth items={filtered} all={sortedAll} anchor={anchor}
                       collapsed={collapsed} />
      )}
    </div>
  );
}

/* ── Timeline view ────────────────────────────────────────────────── */

/** One rendered timeline row: a tree row plus what its bar track shows.
 *  `real` — the initiative's own scheduled dates. `derived` — the
 *  envelope a dateless parent borrows from its scheduled descendants,
 *  drawn as an outline bar. `none` — no dates anywhere beneath it.
 *  `bar` is null on a `real`/`derived` row whose span falls outside the
 *  visible range; the row keeps its place (a descendant may still be in
 *  range) and simply draws nothing. */
interface DrawnRow {
  row: InitiativeTreeRow<InitiativeItem>;
  kind: 'real' | 'derived' | 'none';
  bar: TimelineBar | null;
  realBar: TimelineBar | null;
  /** `derived` only: how many scheduled descendants the envelope covers. */
  derivedFrom: number;
}

/** The outline bar's tooltip. Pluralized rather than the flat wording the
 *  spec sketched — a project with one scheduled event is the common case,
 *  and "1 scheduled initiatives" reads as a bug. */
function derivedTitle(n: number): string {
  return `Derived from ${n} scheduled initiative${n === 1 ? '' : 's'}`;
}

function TimelineGrid({
  items, all, anchor, scale, collapsed, onToggle,
}: {
  items: InitiativeItem[];
  /** Every non-archived initiative, in row order — the tree's input and
   *  the source of the derived envelopes, both of which have to see past
   *  the toolbar pills. */
  all: InitiativeItem[];
  anchor: Date; scale: TimelineScale;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const range = useMemo(() => rangeFor(anchor, scale), [anchor, scale]);
  const ticks = useMemo(() => ticksFor(range, scale), [range, scale]);
  // The day/week rulers read as "… 29 30 1 2 …" across a month boundary, so
  // they get a band naming each month above them. The year ruler's ticks are
  // already month names, so a band there would only repeat them.
  const bands = useMemo(
    () => (scale === 'year' ? [] : monthBandsFor(range)), [range, scale]);
  const today = useMemo(() => startOfToday(), []);
  const todayPct = useMemo(() => pctForDate(today, range), [today, range]);

  /* Direct children, the index the descendant walk below runs on. */
  const childrenOf = useMemo(() => {
    const m = new Map<string, InitiativeItem[]>();
    for (const i of all) {
      if (!i.parent_id || i.parent_id === i.id) continue;
      const sibs = m.get(i.parent_id);
      if (sibs) sibs.push(i);
      else m.set(i.parent_id, [i]);
    }
    return m;
  }, [all]);

  /* Envelope and descendant count for every dateless initiative with
   * scheduled work somewhere beneath it. The walk is recursive, not one
   * level deep: a grandchild's dates belong in the program's envelope
   * exactly as much as a child's, and a middle layer is often the
   * dateless one. `seen` guards a legacy cycle the API now refuses. */
  const derived = useMemo(() => {
    const out = new Map<string, { span: { start: string; end: string }; from: number }>();
    for (const item of all) {
      if (item.scheduled_start || item.scheduled_end) continue;
      const kin: InitiativeItem[] = [];
      const seen = new Set<string>([item.id]);
      const walk = (id: string) => {
        for (const kid of childrenOf.get(id) ?? []) {
          if (seen.has(kid.id)) continue;
          seen.add(kid.id);
          kin.push(kid);
          walk(kid.id);
        }
      };
      walk(item.id);
      const span = derivedSpan(item, kin);
      if (!span) continue;
      out.set(item.id, {
        span,
        from: kin.filter((d) => d.scheduled_start || d.scheduled_end).length,
      });
    }
    return out;
  }, [all, childrenOf]);

  /* The pills decide what MATCHES; the tree decides what renders. A
   * scheduled initiative whose span misses the visible range leaves the
   * match set the same way a filtered one does, so stepping ‹ › still
   * empties the page — but it stays as a context row when a descendant
   * of its own is in range, rather than orphaning that descendant. */
  const matched = useMemo(() => {
    const out = new Set<string>();
    for (const i of items) {
      if (i.scheduled_start && barFor(i, range) === null) continue;
      out.add(i.id);
    }
    return out;
  }, [items, range]);

  const rows = useMemo(
    () => buildInitiativeTree(all, matched, collapsed), [all, matched, collapsed]);

  /* Render order, split at the "Unscheduled" divider. Only a ROOT with no
   * dates and no scheduled descendant goes below it: a dateless child
   * stays nested under its parent, where its place in the project is the
   * whole point, and a dateless parent with scheduled work keeps its
   * derived bar up top. Such a root's subtree is dateless by
   * construction — any scheduled descendant would have given it an
   * envelope — so the whole branch travels with it. */
  const { top, bottom } = useMemo(() => {
    const above: DrawnRow[] = [];
    const below: DrawnRow[] = [];
    let belowDivider = false;
    for (const row of rows) {
      const item = row.item;
      let drawn: DrawnRow;
      if (item.scheduled_start) {
        drawn = {
          row, kind: 'real', derivedFrom: 0,
          bar: barFor(item, range),
          realBar: realBarFor(item, range, today),
        };
      } else {
        const env = derived.get(item.id);
        drawn = env
          ? {
            row, kind: 'derived', derivedFrom: env.from, realBar: null,
            bar: barFor({
              name: item.name,
              scheduled_start: env.span.start,
              scheduled_end: env.span.end,
            }, range),
          }
          : { row, kind: 'none', derivedFrom: 0, bar: null, realBar: null };
      }
      if (row.depth === 0) belowDivider = drawn.kind === 'none';
      (belowDivider ? below : above).push(drawn);
    }
    return { top: above, bottom: below };
  }, [rows, range, today, derived]);

  const rightWidth = scale === 'month' || scale === '45d'
    ? Math.max(760, ticks.length * 32)
    : scale === 'quarter'
      ? Math.max(760, ticks.length * 84)
      : Math.max(760, ticks.length * 110);

  if (top.length === 0 && bottom.length === 0) {
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

        {top.map((drawn) => (
          <TimelineRow key={drawn.row.item.id} drawn={drawn} rightWidth={rightWidth}
                       todayPct={todayPct} onToggle={onToggle} />
        ))}

        {bottom.length > 0 && (
          <div className="itl-row itl-divider-row">
            <div className="itl-row-label itl-divider">Unscheduled</div>
            <div className="itl-row-bars" style={{ width: rightWidth }} />
          </div>
        )}
        {bottom.map((drawn) => (
          <TimelineRow key={drawn.row.item.id} drawn={drawn} rightWidth={rightWidth}
                       todayPct={todayPct} onToggle={onToggle} />
        ))}
      </div>
    </div>
  );
}

/** One timeline row: the sticky label (chevron, name, role chip) and the
 *  bar track beside it. `--depth` carries the indent, so one padding rule
 *  in the stylesheet serves every level — the `.cell-primary` idiom the
 *  list view uses. */
function TimelineRow({
  drawn, rightWidth, todayPct, onToggle,
}: {
  drawn: DrawnRow; rightWidth: number; todayPct: number | null;
  onToggle: (id: string) => void;
}) {
  const { row, kind, bar, realBar } = drawn;
  const item = row.item;
  return (
    <div className={`itl-row ${row.isContext ? 'context' : ''}`}
         style={{ '--depth': row.depth } as CSSProperties}>
      <div className="itl-row-label">
        {/* Gated on hasChildren, never on expanded — a leaf is "expanded"
            too, and a chevron that reveals nothing would be a lie. A
            context row is force-expanded by the builder whatever the
            collapsed set says, so its chevron could not collapse anything
            here; it would only write the id into the shared set and shut
            the branch later, here and in the list view. */}
        {row.hasChildren && !row.isContext && (
          <button type="button" className="tree-toggle"
                  aria-expanded={row.expanded}
                  aria-label={row.expanded ? 'Collapse' : 'Expand'}
                  onClick={(e) => {
                    e.stopPropagation();   // never the row's own link
                    onToggle(item.id);
                  }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.5" strokeLinecap="round"
                 strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
            <span className="tree-count">{row.childCount}</span>
          </button>
        )}
        <Link to={`/initiatives/${item.id}`} className="pn">
          <b>{item.name}</b>
          <span>{clientSiteLine(item)}</span>
        </Link>
        {/* `role` survives on a depth-0 orphan whose parent is out of the
            actor's scope; the chip only makes sense under a parent. */}
        {row.role && row.depth > 0 && (
          <span className="chip c-slate">{row.role}</span>
        )}
      </div>
      <div className="itl-row-bars" style={{ width: rightWidth }}>
        {kind !== 'none' && todayPct !== null && (
          <div className="itl-today-line" style={{ left: `${todayPct}%` }} />
        )}
        {kind === 'real' && bar && (
          <div className="itl-bar" title={spanTitle(item)}
               style={{
                 left: `${bar.left}%`, width: `${bar.width}%`,
                 '--chip': chipColor(item),
               } as CSSProperties}>
            {(bar.width / 100) * rightWidth >= 80 && (
              <span className="itl-bar-label">{item.name}</span>
            )}
          </div>
        )}
        {/* Dashed and unfilled: borrowed dates, not dates of its own. No
            inline label — there is no fill for white text to sit on. */}
        {kind === 'derived' && bar && (
          <div className="itl-bar itl-bar-derived" title={derivedTitle(drawn.derivedFrom)}
               style={{
                 left: `${bar.left}%`, width: `${bar.width}%`,
                 '--chip': chipColor(item),
               } as CSSProperties} />
        )}
        {realBar && (
          <div className="itl-real-bar"
               style={{
                 left: `${realBar.left}%`, width: `${realBar.width}%`,
                 '--chip': chipColor(item),
               } as CSSProperties} />
        )}
        {kind === 'none' && (
          <span className="cell-top itl-no-dates">No dates yet</span>
        )}
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

/** `Parent › Child` for a segment whose parent is on the page, the
 *  child's own name otherwise. A month grid has no rows to indent, so
 *  this breadcrumb is where a child's provenance shows. */
function segmentLabel(i: InitiativeItem, byId: Map<string, InitiativeItem>): string {
  const parent = i.parent_id ? byId.get(i.parent_id) : undefined;
  return parent ? `${parent.name} › ${i.name}` : i.name;
}

function CalendarMonth({
  items, all, anchor, collapsed,
}: {
  items: InitiativeItem[];
  /** Every non-archived initiative — the parent lookup and the
   *  collapsed-ancestor walk both have to see past the toolbar pills. */
  all: InitiativeItem[];
  anchor: Date;
  collapsed: ReadonlySet<string>;
}) {
  const cells = useMemo(() => monthGrid(anchor), [anchor]);
  const byId = useMemo(() => new Map(all.map((i) => [i.id, i])), [all]);

  /* The shared collapsed set is what makes the two views agree: a project
   * collapsed on the timeline hides its children's segments here too.
   * The walk goes all the way up (a grandchild hides under a collapsed
   * grandparent) and stops at a parent that isn't on the page. */
  const visible = useMemo(() => {
    if (collapsed.size === 0) return items;
    return items.filter((i) => {
      const seen = new Set<string>([i.id]);
      let pid = i.parent_id;
      while (pid && !seen.has(pid)) {
        if (collapsed.has(pid)) return false;
        seen.add(pid);
        pid = byId.get(pid)?.parent_id ?? null;
      }
      return true;
    });
  }, [items, byId, collapsed]);

  const weeks = useMemo(() => calendarWeeks(visible, cells), [visible, cells]);
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
                <CalendarSpan key={seg.item.id} seg={seg}
                              label={segmentLabel(seg.item, byId)} />
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
function CalendarSpan({
  seg, label,
}: { seg: CalendarSegment<InitiativeItem>; label: string }) {
  const i = seg.item;
  return (
    // The hover card replaces the native `title` the bar used to carry:
    // one flat line on the browser's own schedule becomes the
    // initiative's high-level details on ours. The wrapper draws no box
    // of its own, so the bar keeps its place in the week grid.
    <InitiativeHoverCard item={i} name={label}>
      <Link to={`/initiatives/${i.id}`}
            className={`chip custom itl-span ${seg.continuesBefore ? 'cont-before' : ''} ` +
                       `${seg.continuesAfter ? 'cont-after' : ''}`}
            style={{
              gridColumn: `${seg.startCol + 1} / span ${seg.span}`,
              gridRow: seg.lane + 1,
              '--chip': chipColor(i),
            } as CSSProperties}>
        <span className="dot" />
        <span className="itl-span-name">{label}</span>
      </Link>
    </InitiativeHoverCard>
  );
}
