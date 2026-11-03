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
 *
 * Project plans (spec "All-initiatives Timeline page"): for a
 * `project_plans:view` holder only, a "Milestones" pill-check beside "Show
 * cancelled" (on unless turned off, remembered as `milestones`) shows the
 * plan tasks flagged Show on timeline — a diamond on the initiative's row
 * on the day the task finishes, or a diamond chip on that day in the
 * calendar — each with a hover card (name, date, Complete / Late) and a
 * link to the task in the plan tab (`?tab=plan&task=`). Diamonds on a row
 * too close to tell apart cluster into one, whose card lists them all and
 * whose click opens the first. A milestone's day is the API's `day` (the
 * plan tab's finish-day rule). An initiative whose
 * own dates miss the range keeps its row for a milestone inside it. The
 * initiative hover card gains a "Plan:" line (% complete, next flagged
 * task), toggle or not. The data is GET /plans/timeline for the days the
 * view shows; a failed request just leaves the overlay off. Plan times are
 * floating text, read through lib/plans/floatingTime only.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState, type CSSProperties,
} from 'react';
import { naturalCompare } from '../lib/naturalSort';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ComboBox from '../components/ComboBox';
import InitiativeHoverCard, { PointerHoverCard } from '../components/initiatives/InitiativeHoverCard';
import {
  ApiError, listInitiatives, listInitiativeStatuses,
  type InitiativeItem, type StatusValue,
} from '../lib/api';
import { longDateOf } from '../lib/format';
import {
  getTimelineMilestones, type PlanTimeline, type TimelineMilestone, type TimelineSummary,
} from '../lib/plans/api';
import { formatDayRange } from '../lib/plans/floatingTime';
import {
  buildInitiativeTree, derivedSpan, readCollapsed, writeCollapsed,
  type InitiativeTreeRow,
} from '../lib/initiatives';
import {
  barFor, calendarWeeks, monthBandsFor, monthGrid, parseApiDay, rangeFor, realBarFor,
  sortForTimeline, ticksFor, type CalendarSegment, type CalendarWeek, type TimelineBar,
  type TimelineRange, type TimelineScale,
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

/** Where the learning invites go out (or went out), as a percent of the
 *  range: the middle of that local day, so the marker sits on the day the
 *  ruler names. Null when the initiative has none or it falls outside. */
function learningMarkFor(iso: string | null | undefined, range: TimelineRange): number | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate(), 12);
  return pctForDate(day, range);
}

function learningMarkTitle(iso: string): string {
  const at = new Date(iso);
  const when = at.toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return `Learning invites ${at.getTime() <= Date.now() ? 'sent' : 'go out'} ${when}`;
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

/* ── plan milestones ──────────────────────────────────────────────── */

/** Each initiative's milestones, in the API's order (by finish). */
type MilestonesBy = ReadonlyMap<string, readonly TimelineMilestone[]>;
const NO_MILESTONES: MilestonesBy = new Map();
const NO_PLAN_LINES: ReadonlyMap<string, string> = new Map();
const UNTITLED = 'Untitled task';

/** The days a view shows, both ends included, as `YYYY-MM-DD` — what the
 *  milestones are asked for: the timeline's range (end-exclusive, so its
 *  last day is the day before `end`) or the calendar's six-week grid. */
function shownDays(view: View, anchor: Date, scale: TimelineScale): { from: string; to: string } {
  if (view === 'calendar') {
    const cells = monthGrid(anchor);
    return { from: isoDay(cells[0].date), to: isoDay(cells[cells.length - 1].date) };
  }
  const range = rangeFor(anchor, scale);
  const last = new Date(range.end);
  last.setDate(last.getDate() - 1);
  return { from: isoDay(range.start), to: isoDay(last) };
}

/** A milestone's day as `Nov 14`. Its day is the API's `day`: the plan
 *  tab's finish-day rule (floatingTime `lastDay`: a finish at 00:00 ends
 *  the day before, a zero-length task keeps its own day), never the date
 *  of its `at`. */
function milestoneDate(m: TimelineMilestone): string {
  return formatDayRange(m.day, m.day);
}

/** A milestone's diamond in `range`: the middle of its day (as a local
 *  calendar date), as a percent; null outside. */
function milestonePct(m: TimelineMilestone, range: TimelineRange): number | null {
  const day = parseApiDay(m.day);
  return pctForDate(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12), range);
}

/** Diamonds on a row whose centers are closer than this cluster into one:
 *  a 14px diamond is ~20px across its points, so two this close can't be
 *  told apart, hovered or clicked one by one. */
const CLUSTER_PX = 14;

/** One diamond on a row: a milestone, or a cluster of them, at `pct`. */
interface RowMark { milestones: readonly TimelineMilestone[]; pct: number }

/** A row's diamonds inside `range` on a track `width` px wide, left to
 *  right: a milestone joins the cluster before it when it is within
 *  CLUSTER_PX of that cluster's first one (so a cluster stays ~14px wide
 *  however dense the row), and a cluster sits at its milestones' mean.
 *  Same-day milestones always cluster; at Month they're the only ones that
 *  do (a day is 32px or more), at Quarter and Year neighboring days do. */
function rowMarks(
  milestones: readonly TimelineMilestone[], range: TimelineRange, width: number,
): RowMark[] {
  const placed = milestones
    .map((m) => ({ m, pct: milestonePct(m, range) }))
    .filter((p): p is { m: TimelineMilestone; pct: number } => p.pct !== null)
    .sort((a, b) => a.pct - b.pct);             // stable: the API's order on a day
  const marks: RowMark[] = [];
  let group: { m: TimelineMilestone; pct: number }[] = [];
  const close = () => {
    if (group.length === 0) return;
    marks.push({
      milestones: group.map((g) => g.m),
      pct: group.reduce((sum, g) => sum + g.pct, 0) / group.length,
    });
    group = [];
  };
  for (const p of placed) {
    if (group.length > 0 && ((p.pct - group[0].pct) / 100) * width >= CLUSTER_PX) close();
    group.push(p);
  }
  close();
  return marks;
}

function milestoneState(m: TimelineMilestone): 'Complete' | 'Late' | null {
  if (m.complete) return 'Complete';
  return m.late ? 'Late' : null;
}

/** `Move day, Nov 14, Late` — the diamond's name for a screen reader. */
function milestoneLabel(m: TimelineMilestone): string {
  return [m.name || UNTITLED, milestoneDate(m), milestoneState(m)].filter(Boolean).join(', ');
}

/** A diamond's name for a screen reader: the milestone's, or for a
 *  cluster `2 milestones: A, Nov 2, Late; B, Nov 2, Complete`. */
function markLabel(milestones: readonly TimelineMilestone[]): string {
  if (milestones.length === 1) return milestoneLabel(milestones[0]);
  return `${milestones.length} milestones: ${milestones.map(milestoneLabel).join('; ')}`;
}

/** The task in its initiative's plan tab, selected and scrolled to. */
function milestoneHref(m: TimelineMilestone): string {
  return `/initiatives/${encodeURIComponent(m.initiative_id)}`
    + `?tab=plan&task=${encodeURIComponent(m.task_id)}`;
}

/** `base`, plus `cluster` for more than one milestone, plus their state:
 *  `late` when any is late, `complete` when all are complete. */
function milestoneClass(base: string, milestones: readonly TimelineMilestone[]): string {
  const classes = [base];
  if (milestones.length > 1) classes.push('cluster');
  if (milestones.some((m) => m.late)) classes.push('late');
  else if (milestones.every((m) => m.complete)) classes.push('complete');
  return classes.join(' ');
}

/** "Plan: 42% complete · next: Move day Nov 14". */
function planLineOf(s: TimelineSummary): string {
  const pct = `Plan: ${s.percent_complete}% complete`;
  if (!s.next) return pct;
  return `${pct} · next: ${s.next.name || UNTITLED} ${formatDayRange(s.next.day, s.next.day)}`;
}

const stateClass = (state: 'Complete' | 'Late'): string => (state === 'Late' ? 'ihv-late' : 'ihv-done');

/** A diamond's hover card: name, date, Complete / Late; for a cluster, a
 *  line for each of its milestones (name · date · state). */
function MilestoneCard({ milestones }: { milestones: readonly TimelineMilestone[] }) {
  if (milestones.length === 1) {
    const m = milestones[0];
    const state = milestoneState(m);
    return (
      <>
        <span className="ihv-name">{m.name || UNTITLED}</span>
        <span className="ihv-line">{milestoneDate(m)}</span>
        {state && <span className={`ihv-line ${stateClass(state)}`}>{state}</span>}
      </>
    );
  }
  return (
    <>
      <span className="ihv-name">{milestones.length} milestones</span>
      {milestones.map((m) => {
        const state = milestoneState(m);
        return (
          <span key={m.task_id} className="ihv-line">
            {m.name || UNTITLED} · {milestoneDate(m)}
            {state && <>{' · '}<span className={stateClass(state)}>{state}</span></>}
          </span>
        );
      })}
    </>
  );
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

  const { can } = useAuth();
  const canSeePlans = can('project_plans', 'view');
  const [showMilestones, setShowMilestones] = useState(() => loadPref('milestones', 'on') !== 'off');

  useEffect(() => { savePref('view', view); }, [view]);
  useEffect(() => { savePref('scale', scale); }, [scale]);
  useEffect(() => { savePref('type', typePill); }, [typePill]);
  useEffect(() => { savePref('status', statusPill); }, [statusPill]);
  useEffect(() => { savePref('milestones', showMilestones ? 'on' : 'off'); }, [showMilestones]);

  /* The plan overlay, for the days the view shows. Asked for whether the
   * toggle is on or not: the summaries feed the hover card's "Plan:" line,
   * which the toggle doesn't hide. A late answer for days no longer shown
   * is dropped; a failure leaves the overlay off. */
  const [planData, setPlanData] = useState<PlanTimeline | null>(null);
  const shown = useMemo(() => shownDays(view, anchor, scale), [view, anchor, scale]);
  useEffect(() => {
    if (!canSeePlans) return undefined;
    let live = true;
    getTimelineMilestones(shown.from, shown.to)
      .then((data) => { if (live) setPlanData(data); })
      .catch(() => { if (live) setPlanData(null); });
    return () => { live = false; };
  }, [canSeePlans, shown.from, shown.to]);

  const milestonesBy = useMemo<MilestonesBy>(() => {
    const by = new Map<string, TimelineMilestone[]>();
    for (const m of planData?.milestones ?? []) {
      const list = by.get(m.initiative_id);
      if (list) list.push(m);
      else by.set(m.initiative_id, [m]);
    }
    return by;
  }, [planData]);
  const planLines = useMemo(() => new Map(
    Object.entries(planData?.summaries ?? {}).map(([id, s]) => [id, planLineOf(s)])), [planData]);
  const milestones = canSeePlans && showMilestones ? milestonesBy : NO_MILESTONES;

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
      .sort((a, b) => naturalCompare(a[1], b[1]))
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
        {canSeePlans && (
          <label className="pill-check">
            <input type="checkbox" checked={showMilestones}
                   onChange={(e) => setShowMilestones(e.target.checked)} />
            Milestones
          </label>
        )}
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
                      collapsed={collapsed} onToggle={toggleCollapsed} milestones={milestones} />
      )}

      {!error && initiatives !== null && view === 'calendar' && (
        <CalendarMonth items={filtered} all={sortedAll} anchor={anchor}
                       collapsed={collapsed} milestones={milestones}
                       planLines={canSeePlans ? planLines : NO_PLAN_LINES} />
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
  items, all, anchor, scale, collapsed, onToggle, milestones,
}: {
  items: InitiativeItem[];
  /** Every non-archived initiative, in row order — the tree's input and
   *  the source of the derived envelopes, both of which have to see past
   *  the toolbar pills. */
  all: InitiativeItem[];
  anchor: Date; scale: TimelineScale;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** The plan milestones to draw, by initiative (none when off). */
  milestones: MilestonesBy;
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

  /* Envelope and descendant count for every initiative that draws no real
   * bar of its own but has scheduled work somewhere beneath it. The walk is
   * recursive, not one level deep: a grandchild's dates belong in the
   * program's envelope exactly as much as a child's, and a middle layer is
   * often the dateless one. `seen` guards a legacy cycle the API now
   * refuses.
   *
   * The gate is `scheduled_start` alone — `barFor`'s own test — and not
   * "any date". An end-only initiative (the edit modal's two date inputs
   * are independent and neither is required, so the product reaches this)
   * draws no real bar, so it needs the envelope exactly as much as a fully
   * dateless one; skipping it here used to file its entire scheduled
   * subtree under "Unscheduled".
   *
   * `withScheduledKin` is the same walk's other answer: does this branch
   * hold any dates at all? The divider below reads it, so a root only
   * falls under "Unscheduled" when its whole branch is dateless. */
  const derived = useMemo(() => {
    const spans = new Map<string, { span: { start: string; end: string }; from: number }>();
    const withScheduledKin = new Set<string>();
    for (const item of all) {
      if (item.scheduled_start) continue;
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
      const from = kin.filter((d) => d.scheduled_start || d.scheduled_end).length;
      if (from > 0) withScheduledKin.add(item.id);
      const span = derivedSpan(item, kin);
      if (span) spans.set(item.id, { span, from });
    }
    return { spans, withScheduledKin };
  }, [all, childrenOf]);

  /* The pills decide what MATCHES; the tree decides what renders. A
   * scheduled initiative whose span misses the visible range leaves the
   * match set the same way a filtered one does, so stepping ‹ › still
   * empties the page — but it stays as a context row when a descendant
   * of its own is in range, rather than orphaning that descendant. A plan
   * milestone inside the range keeps its initiative's row too. */
  const matched = useMemo(() => {
    const out = new Set<string>();
    for (const i of items) {
      if (i.scheduled_start && barFor(i, range) === null
          && !(milestones.get(i.id) ?? []).some((m) => milestonePct(m, range) !== null)) continue;
      out.add(i.id);
    }
    return out;
  }, [items, range, milestones]);

  const rows = useMemo(
    () => buildInitiativeTree(all, matched, collapsed), [all, matched, collapsed]);

  /* Render order, split at the "Unscheduled" divider. Only a ROOT whose
   * whole branch is dateless goes below it: a dateless child stays nested
   * under its parent, where its place in the project is the whole point,
   * and a dateless parent with scheduled work keeps its derived bar up
   * top. The test is the branch, not the root's own row — a root that
   * somehow draws nothing while a descendant is scheduled would otherwise
   * drag that descendant's real bar under an "Unscheduled" heading. */
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
        const env = derived.spans.get(item.id);
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
      if (row.depth === 0) {
        belowDivider = drawn.kind === 'none' && !derived.withScheduledKin.has(item.id);
      }
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
          {/* A `.cell`, like the track beneath it: directory.css sizes the
              golden classes (the band's cell-top, the ticks' mono) from the
              list tokens only inside one, so the ruler reads at the row
              labels' scale and follows the List text size preference. */}
          <div className="itl-ruler cell" style={{ width: rightWidth }}>
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
                <span key={idx} className="mono itl-tick"
                      style={{ left: `${pctForDate(t.at, range) ?? 0}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        {top.map((drawn) => (
          <TimelineRow key={drawn.row.item.id} drawn={drawn} rightWidth={rightWidth}
                       todayPct={todayPct} range={range} onToggle={onToggle}
                       milestones={milestones.get(drawn.row.item.id)} />
        ))}

        {bottom.length > 0 && (
          <div className="itl-row itl-divider-row">
            {/* A `.cell`, so its cell-top takes the list tokens (see the
                ruler), muted as a divider. */}
            <div className="itl-row-label itl-divider cell">
              <span className="cell-top">Unscheduled</span>
            </div>
            <div className="itl-row-bars" style={{ width: rightWidth }} />
          </div>
        )}
        {bottom.map((drawn) => (
          <TimelineRow key={drawn.row.item.id} drawn={drawn} rightWidth={rightWidth}
                       todayPct={todayPct} range={range} onToggle={onToggle}
                       milestones={milestones.get(drawn.row.item.id)} />
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
  drawn, rightWidth, todayPct, range, onToggle, milestones,
}: {
  drawn: DrawnRow; rightWidth: number; todayPct: number | null; range: TimelineRange;
  onToggle: (id: string) => void;
  milestones?: readonly TimelineMilestone[];
}) {
  const { row, kind, bar, realBar } = drawn;
  const item = row.item;
  const markPct = learningMarkFor(item.learning_send_at, range);
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
        {/* The lists' name cell (directory.css `.cell-primary .pn`): the
            name, then client · site under it, each trimmed to the column. */}
        <div className="cell-primary">
          <Link to={`/initiatives/${item.id}`} className="pn">
            <b>{item.name}</b>
            <span>{clientSiteLine(item)}</span>
          </Link>
        </div>
        {/* `role` survives on a depth-0 orphan whose parent is out of the
            actor's scope; the chip only makes sense under a parent. */}
        {row.role && row.depth > 0 && (
          <span className="chip c-slate">{row.role}</span>
        )}
      </div>
      {/* `noted`: no bar here, so the track shows a note at its start ("No
          dates yet", "Scheduled outside this range"), its diamonds drop
          below the note rather than sitting on it, and the real-dates bar
          drops below the diamonds. The track is a `.cell` so the note's
          cell-sub takes the list tokens (see the ruler). */}
      <div className={`itl-row-bars cell${bar ? '' : ' noted'}`} style={{ width: rightWidth }}>
        {kind !== 'none' && todayPct !== null && (
          <div className="itl-today-line" style={{ left: `${todayPct}%` }} />
        )}
        {kind === 'real' && bar && (
          <div className="itl-bar" title={spanTitle(item)}
               style={{
                 left: `${bar.left}%`, width: `${bar.width}%`,
                 '--chip': chipColor(item),
               } as CSSProperties}>
            {/* The name: cell-top inside the track's `.cell`, white on
                the fill. */}
            {(bar.width / 100) * rightWidth >= 80 && (
              <span className="cell-top itl-bar-label">{item.name}</span>
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
        {markPct !== null && item.learning_send_at && (
          <div className="itl-learning-mark" title={learningMarkTitle(item.learning_send_at)}
               style={{ left: `${markPct}%` }} />
        )}
        {milestones && rowMarks(milestones, range, rightWidth).map((mark) => (
          <MilestoneDiamond key={mark.milestones[0].task_id} mark={mark} />
        ))}
        {kind === 'none' && (
          <span className="cell-sub itl-no-dates">No dates yet</span>
        )}
        {/* Dated, but the span sits before or after the visible range: say
            so rather than leaving an unexplained empty track. The row is
            here because a descendant of its own is in range, or because a
            plan milestone of its own is (a milestone-only row: the text
            stays at the track's start, the diamonds on their days). */}
        {kind !== 'none' && !bar && (
          <span className="cell-sub itl-no-dates">Scheduled outside this range</span>
        )}
      </div>
    </div>
  );
}

/** A plan milestone on its initiative's row: a diamond on its day, with
 *  the hover card and a link to the task in the plan. A cluster is one
 *  diamond (ringed) whose card lists every milestone in it; its click
 *  opens the first (the leftmost), the simplest clear choice — the card
 *  names the rest, each a click away in the plan. */
function MilestoneDiamond({ mark }: { mark: RowMark }) {
  return (
    <PointerHoverCard card={() => <MilestoneCard milestones={mark.milestones} />}>
      <Link to={milestoneHref(mark.milestones[0])}
            className={milestoneClass('itl-milestone', mark.milestones)}
            aria-label={markLabel(mark.milestones)} style={{ left: `${mark.pct}%` }} />
    </PointerHoverCard>
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

/** A plan milestone's chip in a week row: its day's column and its lane. */
interface PlacedMilestone { m: TimelineMilestone; col: number; lane: number }

/** The week's milestones as chips on their days, laid out after the runs
 *  (lib/timeline's packing stays the runs' own): each takes the lowest
 *  lane free on its day, so it fills a gap beside the runs rather than
 *  moving them. `milestones` in the order they should stack. */
function placeMilestones(
  week: CalendarWeek<InitiativeItem>, milestones: readonly TimelineMilestone[],
): PlacedMilestone[] {
  const taken: boolean[][] = [];
  for (const seg of week.segments) {
    taken[seg.lane] ??= [];
    for (let col = seg.startCol; col < seg.startCol + seg.span; col += 1) taken[seg.lane][col] = true;
  }
  const placed: PlacedMilestone[] = [];
  for (const m of milestones) {
    const col = week.days.findIndex((d) => isoDay(d.date) === m.day);
    if (col < 0) continue;
    let lane = 0;
    while (taken[lane]?.[col]) lane += 1;
    taken[lane] ??= [];
    taken[lane][col] = true;
    placed.push({ m, col, lane });
  }
  return placed;
}

function CalendarMonth({
  items, all, anchor, collapsed, milestones, planLines,
}: {
  items: InitiativeItem[];
  /** Every non-archived initiative — the parent lookup and the
   *  collapsed-ancestor walk both have to see past the toolbar pills. */
  all: InitiativeItem[];
  anchor: Date;
  collapsed: ReadonlySet<string>;
  /** The plan milestones to draw, by initiative (none when off). */
  milestones: MilestonesBy;
  /** Each initiative's "Plan:" line for its hover card. */
  planLines: ReadonlyMap<string, string>;
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

  /* The milestones of the initiatives the calendar shows (the pills and
   * the collapsed set decide, as for the runs), earliest first, as chips
   * on their days. The page's lane cap holds for them too: a chip whose
   * lane is past it folds into its day's "+N more" like a run. (The plan
   * tab's own Calendar keeps every milestone in view; that one is a plan's
   * schedule, this one a page of initiatives.) */
  const placedByWeek = useMemo(() => {
    const byDay = (a: TimelineMilestone, b: TimelineMilestone) =>
      (a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    const shownMilestones = visible.flatMap((i) => milestones.get(i.id) ?? []).sort(byDay);
    return weeks.map((week) => placeMilestones(week, shownMilestones));
  }, [visible, milestones, weeks]);

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

      {weeks.map((week, weekIndex) => {
        const key = isoDay(week.days[0].date);
        const isOpen = expanded === key;
        const placed = placedByWeek[weekIndex];
        const lanes = placed.reduce((n, p) => Math.max(n, p.lane + 1), week.laneCount);
        const laneCap = isOpen ? lanes : MAX_LANES;
        const shown = week.segments.filter((s) => s.lane < laneCap);
        const hidden = week.segments.filter((s) => s.lane >= laneCap);
        const shownChips = placed.filter((p) => p.lane < laneCap);
        const hiddenChips = placed.filter((p) => p.lane >= laneCap);
        // A day's "+N more" counts the runs crossing that day and the
        // milestone chips on it that the lane cap dropped — the count
        // belongs to the day, the row it opens belongs to the week.
        const hiddenOnDay = (col: number) => hidden.filter(
          (s) => col >= s.startCol && col < s.startCol + s.span).length
          + hiddenChips.filter((p) => p.col === col).length;
        const folded = hidden.length > 0 || hiddenChips.length > 0;
        const rows = Math.min(lanes, laneCap) + (folded || isOpen ? 1 : 0);

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
                              label={segmentLabel(seg.item, byId)}
                              planLine={planLines.get(seg.item.id)} />
              ))}
              {shownChips.map(({ m, col, lane }) => {
                const owner = byId.get(m.initiative_id);
                return (
                  <CalendarMilestone key={m.task_id} m={m} col={col} lane={lane}
                                     color={owner ? chipColor(owner) : 'var(--accent)'} />
                );
              })}
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
  seg, label, planLine,
}: { seg: CalendarSegment<InitiativeItem>; label: string; planLine?: string }) {
  const i = seg.item;
  return (
    // The hover card replaces the native `title` the bar used to carry:
    // one flat line on the browser's own schedule becomes the
    // initiative's high-level details on ours. The wrapper draws no box
    // of its own, so the bar keeps its place in the week grid.
    <InitiativeHoverCard item={i} name={label} planLine={planLine}>
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

/** A plan milestone in the calendar: a diamond chip on its day, in its
 *  initiative's color, as wide as its name; the diamond's hover card and
 *  link to the task in the plan. */
function CalendarMilestone({
  m, col, lane, color,
}: { m: TimelineMilestone; col: number; lane: number; color: string }) {
  return (
    <PointerHoverCard card={() => <MilestoneCard milestones={[m]} />}>
      <Link to={milestoneHref(m)} aria-label={milestoneLabel(m)}
            className={milestoneClass('chip custom itl-span itl-milestone-chip', [m])}
            style={{
              gridColumn: `${col + 1} / span 1`,
              gridRow: lane + 1,
              '--chip': color,
            } as CSSProperties}>
        <span className="itl-milestone-diamond" />
        <span className="itl-span-name">{m.name || UNTITLED}</span>
      </Link>
    </PointerHoverCard>
  );
}
