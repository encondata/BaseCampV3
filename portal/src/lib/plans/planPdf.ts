/**
 * The project plan PDF's page geometry (More › Export ▸ PDF…, the report
 * worker's `project_plan` report): the paper's content box, the Gantt pages'
 * chart width and rows, the scale the PDF draws over its date range, the fit
 * zoom for one page, and the page estimate the options step shows before
 * Generate ("About 12 pages (3 table, 9 Gantt)").
 *
 * The API renders the PDF (api/src/serversherpa/reports/project_plan/
 * gantt.py, a port of this file and of the parts of ganttGeometry,
 * ganttView and calendarShade it draws with), and both are held to the
 * shared vectors in api/tests/fixtures/plans/gantt.json, so the estimate
 * counts the Gantt pages the worker makes exactly. The task table's pages
 * are an estimate either way: a long name wraps.
 *
 * Lengths are CSS px (1/96 inch), the unit WeasyPrint lays the page out in.
 * The page is landscape with 38px (10 mm) margins at the top and sides and
 * 76px at the bottom, where the footer goes (Page N of M, the generated
 * stamp, the tracking barcode).
 *
 * The range is bounded: a custom one is cut to the plan's own span, and no
 * span over MAX_PRINT_YEARS (the plan's own duration bound) is printed, so
 * every loop the API draws with is bounded too.
 */
import { MAX_YEARS } from './durations';
import { fromMs, toMs } from './floatingTime';
import { FIT_MARGIN, MS_PER_DAY, ZOOM_PX_PER_DAY, fitZoom, type Scale, type Zoom } from './ganttGeometry';

export type Paper = 'letter' | 'a4';
export const PAPERS: readonly Paper[] = ['letter', 'a4'];

/** The landscape sheet, whole px (A4's 1122.5 × 793.7 rounded down). */
export const PAGE_PX: Record<Paper, { width: number; height: number }> = {
  letter: { width: 1056, height: 816 },
  a4: { width: 1122, height: 793 },
};
export const MARGIN_PX = 38;
export const FOOTER_PX = 76;

/** A Gantt page's header line (the tile's dates and rows). */
export const GANTT_HEAD_PX = 26;
/** One tier of the timescale; there are two. */
export const TIER_PX = 18;
/** A task row on a Gantt page. */
export const ROW_PX = 18;
/** The names column down a Gantt page's left side (ID and Task Name). */
export const NAMES_PX = 240;
/** Room kept under a Gantt page's last row (rounding in the layout). */
const GANTT_SLACK_PX = 2;

/** The task table: the title block above it on the first page, its
 *  header (repeated on every page) and a one-line row. */
export const TITLE_PX = 160;
export const TABLE_HEAD_PX = 24;
export const TABLE_ROW_PX = 20;

/** The page's content box inside the margins and above the footer. */
export function contentBox(paper: Paper): { width: number; height: number } {
  const page = PAGE_PX[paper];
  return { width: page.width - 2 * MARGIN_PX, height: page.height - MARGIN_PX - FOOTER_PX };
}

/** The chart's width on a Gantt page: what the names column leaves. */
export function chartWidth(paper: Paper): number {
  return contentBox(paper).width - NAMES_PX;
}

/** The task rows a Gantt page holds under its header and timescale. */
export function ganttRows(paper: Paper): number {
  const room = contentBox(paper).height - GANTT_HEAD_PX - 2 * TIER_PX - GANTT_SLACK_PX;
  return Math.max(1, Math.floor(room / ROW_PX));
}

/** One-line table rows on the first page (under the title block) and on each page after it. */
export function tableRows(paper: Paper): { first: number; rest: number } {
  const height = contentBox(paper).height;
  return {
    first: Math.max(1, Math.floor((height - TITLE_PX - TABLE_HEAD_PX) / TABLE_ROW_PX)),
    rest: Math.max(1, Math.floor((height - TABLE_HEAD_PX) / TABLE_ROW_PX)),
  };
}

/** A span of plan time, `start` to `finish`. */
export interface PrintSpan {
  start: string;
  finish: string;
}

/**
 * The plan's own span: from the project start, or an earlier task's start
 * (a manually scheduled one may begin before it), to the latest task finish
 * (the project finish); an empty plan's is its start. Every task counts,
 * printed or not. A start that is not a plan time throws.
 */
export function planSpan(
  projectStart: string, projectFinish: string | null | undefined,
  tasks: readonly { start: string | null; finish: string | null }[],
): PrintSpan {
  let s = toMs(projectStart);
  if (Number.isNaN(s)) throw new RangeError(`planSpan: not a plan time: ${projectStart}`);
  const pf = projectFinish ? toMs(projectFinish) : Number.NaN;
  let f = Number.isNaN(pf) ? s : Math.max(s, pf);
  for (const t of tasks) {
    for (const at of [t.start ? toMs(t.start) : Number.NaN, t.finish ? toMs(t.finish) : Number.NaN]) {
      if (Number.isNaN(at)) continue;
      if (at < s) s = at;
      if (at > f) f = at;
    }
  }
  return { start: fromMs(s), finish: fromMs(f) };
}

/**
 * The PDF's date range: the plan's span, or the custom days `from` through
 * `to` (`YYYY-MM-DD`, the first day's midnight to the midnight after the
 * last) cut to that span, since nothing is drawn outside it. null when the
 * custom days lie wholly outside the span.
 */
export function printRange(span: PrintSpan, from?: string | null, to?: string | null): PrintSpan | null {
  if (!(from && to)) return span;
  const a = toMs(from);
  const b = toMs(to) + MS_PER_DAY;
  const s = toMs(span.start);
  const f = toMs(span.finish);
  if (b < s || a > f) return null;
  return { start: fromMs(Math.max(a, s)), finish: fromMs(Math.min(b, f)) };
}

/** The longest span the PDF prints: the plan's own bound on a duration. */
export const MAX_PRINT_YEARS = MAX_YEARS;

/** True when `finish` is past `start` plus MAX_PRINT_YEARS calendar years
 *  (the same wall-clock date and time; Feb 29 goes on to Mar 1). */
export function spanTooLong(start: string, finish: string): boolean {
  const at = new Date(toMs(start));
  const limit = Date.UTC(at.getUTCFullYear() + MAX_PRINT_YEARS, at.getUTCMonth(), at.getUTCDate(),
    at.getUTCHours(), at.getUTCMinutes());
  return toMs(finish) > limit;
}

/** What the dialog says for a range the PDF won't print (the API's problems). */
export const RANGE_TOO_LONG = `The date range can be at most ${MAX_PRINT_YEARS} years.`;
export const RANGE_OUTSIDE = 'The dates are outside this plan’s tasks.';

/** The scale's lead before the range and after it: half of FIT_MARGIN, as
 *  whole minutes of the zoom. */
function leadMs(zoom: Zoom): number {
  return Math.round(((FIT_MARGIN / 2) * MS_PER_DAY) / ZOOM_PX_PER_DAY[zoom] / 60_000) * 60_000;
}

/**
 * The scale the PDF draws: the range itself with half of FIT_MARGIN either
 * side (room for a link's stub and a milestone's diamond at its ends), not
 * snapped to a unit and without the portal's scrolling padding, so the range
 * a fit chose fills one page's width. A finish before the start reads as the
 * start. A start that is not a plan time throws.
 */
export function printScale(start: string, finish: string, zoom: Zoom): Scale {
  const s = toMs(start);
  if (Number.isNaN(s)) throw new RangeError(`printScale: not a plan time: ${start}`);
  const f = toMs(finish);
  const end = Number.isNaN(f) ? s : Math.max(s, f);
  const lead = leadMs(zoom);
  const perDay = ZOOM_PX_PER_DAY[zoom];
  const startMs = s - lead;
  const endMs = end + lead;
  return { startMs, endMs, pxPerMs: perDay / MS_PER_DAY, width: ((endMs - startMs) * perDay) / MS_PER_DAY };
}

/** The zoom the PDF's Fit uses: the portal's Fit for the range at one page's chart width. */
export function printFit(start: string, finish: string, paper: Paper): Zoom {
  return fitZoom(start, finish, chartWidth(paper));
}

/** How many chart tiles a scale `width` px wide takes across a page row (a
 *  hair over is still one: the fit's lead is rounded to whole minutes). */
export function tilesAcross(width: number, paper: Paper): number {
  return Math.max(1, Math.ceil(width / chartWidth(paper) - 1e-6));
}

/** How many Gantt pages the rows take down. */
export function tilesDown(rows: number, paper: Paper): number {
  return Math.max(1, Math.ceil(rows / ganttRows(paper)));
}

/** The task table's pages for `rows` one-line rows (at least the title page). */
export function tablePages(rows: number, paper: Paper): number {
  const { first, rest } = tableRows(paper);
  return rows <= first ? 1 : 1 + Math.ceil((rows - first) / rest);
}

export interface PageEstimate {
  /** The zoom drawn: the one asked for, or the fit's. */
  zoom: Zoom;
  table: number;
  gantt: number;
  across: number;
  down: number;
  total: number;
}

/**
 * The PDF's pages: the task table's (an estimate: a long name wraps) and
 * the Gantt's (exact: tiles left to right, then top to bottom). `rows` is
 * the tasks printed; `start`/`finish` the range (printRange); `zoom` 'fit'
 * for the fit.
 */
export function estimatePages({ rows, start, finish, zoom, paper }: {
  rows: number; start: string; finish: string; zoom: Zoom | 'fit'; paper: Paper;
}): PageEstimate {
  const drawn = zoom === 'fit' ? printFit(start, finish, paper) : zoom;
  const across = tilesAcross(printScale(start, finish, drawn).width, paper);
  const down = tilesDown(rows, paper);
  const table = tablePages(rows, paper);
  return { zoom: drawn, table, gantt: across * down, across, down, total: table + across * down };
}

/** "About 12 pages (3 table, 9 Gantt)". */
export function estimateText(e: Pick<PageEstimate, 'table' | 'gantt' | 'total'>): string {
  return `About ${e.total} ${e.total === 1 ? 'page' : 'pages'} (${e.table} table, ${e.gantt} Gantt)`;
}
