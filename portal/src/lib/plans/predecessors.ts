/**
 * The MS Project "Predecessors" cell: `3`, `3FS+2d`, `5SS`, `7FF-4h`, `2,3SS`.
 *
 * A port of api/src/serversherpa/plans/predecessors.py, held to the same
 * vectors (api/tests/fixtures/plans/predecessors.json). A comma-separated
 * list of `ID[type][lag]` entries, the ID being the predecessor's display
 * number; the type is FS, SS, FF or SF (default FS) and the lag a signed
 * duration read by `parseLag`. Only ASCII whitespace is trimmed or allowed
 * (an explicit class: a JS `\s` also matches NBSP and friends), and the
 * trimmed text is at most MAX_PREDECESSOR_TEXT characters.
 */
import {
  DurationError, asciiTrim, formatLag, parseLag, type Duration, type Units,
} from './durations';

export type LinkType = 'FS' | 'SS' | 'FF' | 'SF';

export const LINK_TYPES: readonly LinkType[] = ['FS', 'SS', 'FF', 'SF'];

/** Input limit, shared with the API through the vectors file. */
export const MAX_PREDECESSOR_TEXT = 512;

export interface PredSpec {
  displayId: number;
  linkType: LinkType;
  lag: Duration;            // negative minutes is a lead
}

const ZERO_LAG: Duration = { minutes: 0, unit: 'd', elapsed: false };

/** The ID and the optional type at the start of a trimmed entry; the lag
 *  follows. ASCII-only and no `u` flag, so `ſ` never folds to `s` and `\d`
 *  is never a non-ASCII digit. */
const HEAD = /^([0-9]+)(?:[ \t\n\r\f\v]*(FS|SS|FF|SF))?/i;

/** Above this many digits an ID is past every safe integer, so no display
 *  ID can be it. */
const MAX_ID_DIGITS = 15;

/** The text is not a valid list of predecessors for this task. `detail`
 *  names the offending entry; it never echoes unbounded input. */
export class PredecessorError extends Error {
  readonly code = 'bad_predecessor';

  readonly detail: string;

  constructor(detail: string, options?: { cause?: unknown }) {
    super(detail, options);
    this.name = 'PredecessorError';
    this.detail = detail;
  }
}

const clip = (text: string, limit = 40): string => (text.length <= limit ? text : `${text.slice(0, limit)}...`);

const quoted = (text: string): string => JSON.stringify(clip(text));

/** One trimmed, non-empty entry to (digits, link type, lag). */
function parseEntry(part: string, units: Units): [string, LinkType, Duration] {
  const head = HEAD.exec(part);
  if (!head) {
    throw new PredecessorError(
      `${quoted(part)} is not a predecessor: start with a task number, then an optional `
      + 'link type (FS, SS, FF, SF) and lag, like 3FS+2d.',
    );
  }
  const [matched, digits, type] = head;
  const rest = asciiTrim(part.slice(matched.length));
  let lag = ZERO_LAG;
  if (rest && '0123456789.'.includes(rest[0])) {
    // a number straight after the ID or type: the sign is missing
    throw new PredecessorError(
      `${quoted(part)} is not a predecessor: a lag starts with + or -, like 3FS+2d.`,
    );
  } else if (rest && !'+-'.includes(rest[0])) {
    // anything else after the ID is most likely a mistyped link type
    throw new PredecessorError(
      `${quoted(part)} is not a predecessor: after the task number put a link type `
      + '(FS, SS, FF or SF), then a lag that starts with + or -, like 3FS+2d.',
    );
  } else if (rest) {
    try {
      lag = parseLag(rest, units);
    } catch (err) {
      if (!(err instanceof DurationError)) throw err;
      throw new PredecessorError(`${quoted(part)} has a bad lag: ${err.message}`, { cause: err });
    }
  }
  return [digits, (type ?? 'FS').toUpperCase() as LinkType, lag];
}

/** The entries of predecessor text, each trimmed, in the order written;
 *  none for blank text. `parsePredecessors` answers one PredSpec per entry
 *  in this same order, so the two line up. */
export function splitEntries(text: string): string[] {
  return entriesOf(asciiTrim(text));
}

/** `splitEntries` of text that is already trimmed. */
function entriesOf(trimmed: string): string[] {
  if (!trimmed) return [];
  return trimmed.split(',').map(asciiTrim);
}

/**
 * `3`, `3FS+2d`, `5SS`, `2,3SS` to one PredSpec per entry, in the order
 * written; empty or blank text is no links. Every ID must be in `validIds`,
 * may not be `selfId` (a task cannot precede itself) and may appear once,
 * checked entry by entry in that order. Throws PredecessorError otherwise.
 */
export function parsePredecessors(
  text: string, units: Units, validIds: ReadonlySet<number>, selfId: number | null,
): PredSpec[] {
  if (typeof text !== 'string') {
    throw new PredecessorError(`Predecessors must be text, not ${text === null ? 'null' : typeof text}.`);
  }
  // trimmed once: a megabyte of padding is walked once, not twice
  const trimmed = asciiTrim(text);
  if (trimmed.length > MAX_PREDECESSOR_TEXT) {
    throw new PredecessorError(`Predecessors are longer than ${MAX_PREDECESSOR_TEXT} characters.`);
  }
  const specs: PredSpec[] = [];
  const seen = new Set<number>();
  for (const part of entriesOf(trimmed)) {
    if (!part) throw new PredecessorError('There is an empty entry: check for a stray comma.');
    const [digits, linkType, lag] = parseEntry(part, units);
    const number = digits.replace(/^0+(?=[0-9])/, '');
    // an ID too long for a safe integer is no display ID (and never self)
    const displayId = number.length <= MAX_ID_DIGITS ? Number(number) : null;
    const shown = clip(number, 12);
    if (displayId !== null && displayId === selfId) {
      throw new PredecessorError(`Task ${shown} cannot depend on itself.`);
    }
    if (displayId === null || !validIds.has(displayId)) {
      throw new PredecessorError(`Task ${shown} does not exist in this plan.`);
    }
    if (seen.has(displayId)) {
      throw new PredecessorError(`Task ${shown} is listed more than once.`);
    }
    seen.add(displayId);
    specs.push({ displayId, linkType, lag });
  }
  return specs;
}

function formatEntry(spec: PredSpec, units: Units): string {
  if (!LINK_TYPES.includes(spec.linkType)) {
    throw new Error(`unknown link type ${String(spec.linkType)}`);
  }
  const { minutes, unit, elapsed } = spec.lag;
  let lag = '';
  if (minutes !== 0) {
    lag = formatLag(minutes, unit, elapsed, units);
    // a lag too small to show at two decimals prints as "0 days": keep its
    // sign so the text still parses
    if (!'+-'.includes(lag[0])) lag = (minutes < 0 ? '-' : '+') + lag;
  }
  const type = lag || spec.linkType !== 'FS' ? spec.linkType : '';
  return `${spec.displayId}${type}${lag}`;
}

/**
 * Display text for links: `3`, `3FS+2 days`, `5SS`, `7FF-4 hrs`, `2,3SS`.
 *
 * For people to read, not a lossless encoding. A lag prints rounded to two
 * decimals of its own unit, so 160 minutes of a 480-minute day is
 * `3FS+0.33 days`, which parses back to 158; a zero lag is left out (its
 * unit is not kept) and so is an FS type with no lag; a nonzero lag too
 * small to show keeps only its sign (`3FS+0 days`). Code that turns edited
 * text back into links keeps a link's stored lag where `keepsLag` says so.
 */
export function formatPredecessors(specs: readonly PredSpec[], units: Units): string {
  return specs.map((spec) => formatEntry(spec, units)).join(',');
}

/** How a nonzero lag reads in the cell: its sign and its text. */
const reads = (lag: Duration, units: Units): string =>
  `${Math.sign(lag.minutes)} ${formatLag(lag.minutes, lag.unit, lag.elapsed, units)}`;

/**
 * True when a Predecessors entry leaves an existing link's stored lag as it
 * is (the API's ops_links._keeps_lag): the entry is the link's own formatted
 * text, or it reads the same as the stored lag. Zero lags compare by
 * minutes, never by unit (`3SS` keeps a stored 0 hrs lag). `entry` is the
 * trimmed entry text (`splitEntries`), `spec` its parse.
 */
export function keepsLag(
  stored: Duration, storedType: LinkType, spec: PredSpec, entry: string, units: Units,
): boolean {
  const own = formatPredecessors([{ displayId: spec.displayId, linkType: storedType, lag: stored }], units);
  if (entry === own) return true;
  if (stored.minutes === 0 || spec.lag.minutes === 0) return stored.minutes === spec.lag.minutes;
  return reads(stored, units) === reads(spec.lag, units);
}
