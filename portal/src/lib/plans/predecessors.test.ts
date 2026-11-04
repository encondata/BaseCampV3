/** Predecessors cell text (`3`, `3FS+2d`, `5SS`, `7FF-4h`, `2,3SS`), held to
 *  the vectors file the API's pytest suite reads too
 *  (api/tests/fixtures/plans/predecessors.json). */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DurationError, unitMinutes, unitsOf, type DurationUnit, type Units } from './durations';
import {
  LINK_TYPES, MAX_PREDECESSOR_TEXT, PredecessorError, formatPredecessors, keepsLag,
  parsePredecessors, splitEntries, type LinkType, type PredSpec,
} from './predecessors';

type SpecRow = [number, LinkType, number, DurationUnit, boolean];
type CalendarUnits = { hours_per_day: number; hours_per_week: number; days_per_month: number };

interface Vectors {
  notes: string;
  units: CalendarUnits;
  units_alt: CalendarUnits;
  valid_ids: number[];
  self_id: number;
  parse: [string, SpecRow[]][];
  parse_alt: [string, SpecRow[]][];
  empty: string[];
  invalid: string[];
  ids: [string, number[], number | null, SpecRow[] | null][];
  sized: [number, string, number, string, SpecRow[] | null][];
  format: [SpecRow[], string][];
  format_alt: [SpecRow[], string][];
}

const V: Vectors = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../../../api/tests/fixtures/plans/predecessors.json'), 'utf8'));
const UNITS = unitsOf(V.units);
const UNITS_ALT = unitsOf(V.units_alt);
const VALID_IDS = new Set(V.valid_ids);
const SELF_ID = V.self_id;

const specs = (rows: SpecRow[]): PredSpec[] => rows.map(([displayId, linkType, minutes, unit, elapsed]) => (
  { displayId, linkType, lag: { minutes, unit, elapsed } }));

const parse = (text: string, units: Units = UNITS, validIds: ReadonlySet<number> = VALID_IDS,
  selfId: number | null = SELF_ID) => parsePredecessors(text, units, validIds, selfId);

const failure = (fn: () => unknown): PredecessorError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PredecessorError);
    return err as PredecessorError;
  }
  throw new Error('expected a PredecessorError');
};

/** Lags the two-decimal text holds exactly, and a zero lag only in the unit
 *  a bare ID parses back to (the text does not keep it). */
const roundTrips = (rows: SpecRow[], units: Units = UNITS) => rows.every(
  ([, , minutes, unit, elapsed]) => (minutes === 0
    ? unit === 'd' && !elapsed
    : (Math.abs(minutes) * 100) % unitMinutes(units, unit, elapsed) === 0));

describe('the vectors file', () => {
  it('has only the keys this port reads', () => {
    expect(Object.keys(V).sort()).toEqual([
      'empty', 'format', 'format_alt', 'ids', 'invalid', 'notes', 'parse', 'parse_alt',
      'self_id', 'sized', 'units', 'units_alt', 'valid_ids',
    ]);
  });

  it('notes the rules this port follows', () => {
    expect(V.notes).toContain(`at most ${MAX_PREDECESSOR_TEXT} characters`);
    expect(V.notes).toContain('[ \\t\\n\\r\\f\\v]');
    expect(V.notes).toContain('no `u` flag');
    expect(MAX_PREDECESSOR_TEXT).toBe(1 + 509 + 2);   // the sized rows sit on the cap
  });

  it('covers all four link types', () => {
    const parsedTypes = new Set(V.parse.flatMap(([, rows]) => rows.map((r) => r[1])));
    const formattedTypes = new Set(V.format.flatMap(([rows]) => rows.map((r) => r[1])));
    expect([...parsedTypes].sort()).toEqual([...LINK_TYPES].sort());
    expect([...formattedTypes].sort()).toEqual([...LINK_TYPES].sort());
  });
});

describe('parsePredecessors', () => {
  it.each(V.parse)('parses %j', (text, rows) => {
    expect(parse(text)).toEqual(specs(rows));
  });

  it.each(V.parse_alt)('parses %j in the alternate calendar', (text, rows) => {
    expect(parse(text, UNITS_ALT)).toEqual(specs(rows));
  });

  it.each(V.empty)('reads %j as no links', (text) => {
    expect(parse(text)).toEqual([]);
  });

  it.each(V.invalid)('refuses %j', (text) => {
    const err = failure(() => parse(text));
    expect(err.code).toBe('bad_predecessor');
    expect(err.detail).toBeTruthy();
  });

  it.each(V.ids)('checks %j against %j (self %j)', (text, validIds, selfId, rows) => {
    if (rows === null) {
      failure(() => parse(text, UNITS, new Set(validIds), selfId));
    } else {
      expect(parse(text, UNITS, new Set(validIds), selfId)).toEqual(specs(rows));
    }
  });

  it.each(V.sized)('sizes %j + %j + %j spaces + %j', (outer, head, inner, tail, rows) => {
    const text = ' '.repeat(outer) + head + ' '.repeat(inner) + tail + ' '.repeat(outer);
    if (rows === null) {
      failure(() => parse(text));
    } else {
      expect(parse(text)).toEqual(specs(rows));
    }
  });

  it('reads blank text as no links even with no valid ids', () => {
    expect(parse('', UNITS, new Set(), null)).toEqual([]);
  });

  it('counts the trimmed text against the cap', () => {
    expect(parse(' '.repeat(2000) + '3SS' + ' '.repeat(2000))).toEqual(specs([[3, 'SS', 0, 'd', false]]));
    failure(() => parse('3' + ' '.repeat(MAX_PREDECESSOR_TEXT) + 'SS'));
  });

  it('says what is wrong with which part', () => {
    expect(failure(() => parse('2,3XX')).detail).toContain('3XX');
    expect(failure(() => parse('1')).detail).toContain('itself');
    const unknown = failure(() => parse('12')).detail;
    expect(unknown).toContain('12');
    expect(unknown).toContain('does not exist');
    const repeated = failure(() => parse('2,3,2')).detail;
    expect(repeated).toContain('more than once');
    expect(repeated).toContain('2');
    expect(failure(() => parse('2,,3')).detail).toContain('empty');
  });

  it.each(['3XX', '3S', '3F', '3 x', '3SSS', '3FSFS', '3FS x', '3SS,4YY'])(
    'hints at the link types for %j', (text) => {
      const { detail } = failure(() => parse(text));
      expect(detail).toContain('FS, SS, FF or SF');
      expect(detail).toContain('+ or -');
    });

  it.each(['3 2d', '3FS 2d', '3 4', '3FS 4', '3FS2d', '3.5'])(
    'says a lag starts with a sign for %j', (text) => {
      const { detail } = failure(() => parse(text));
      expect(detail).toContain('starts with + or -');
      expect(detail).not.toContain('link type');
    });

  it('reports a bad lag as a predecessor error naming the part', () => {
    const err = failure(() => parse('2,3FS+2x'));
    expect(err.code).toBe('bad_predecessor');
    expect(err.detail).toContain('3FS+2x');
    expect(err).not.toBeInstanceOf(DurationError);
    expect(err.cause).toBeInstanceOf(DurationError);
  });

  it('checks self, then unknown, then repeated, entry by entry', () => {
    expect(failure(() => parse('1')).detail).toContain('itself');
    expect(failure(() => parse('12,3XX')).detail).toContain('12');
    expect(failure(() => parse('3,3,x')).detail).toContain('more than once');
  });

  it('never echoes unbounded input', () => {
    const texts = ['x'.repeat(100_000), '3FS+' + 'x'.repeat(400), '3' + '9'.repeat(500),
      '2,3,' + '7'.repeat(400) + 'XX', '2,'.repeat(400), '9'.repeat(500)];
    for (const text of texts) {
      expect(failure(() => parse(text)).detail.length).toBeLessThan(250);
    }
  });

  it('treats an ID too long for a number as unknown', () => {
    const detail = failure(() => parse('9'.repeat(500))).detail;
    expect(detail).toContain('does not exist');
    // 9007199254740993 is not a safe integer: it must not read as ...992
    failure(() => parse('9007199254740993', UNITS, new Set([9007199254740992]), null));
  });

  it.each([
    '1' + ' '.repeat(100_000) + 'x',
    '1,2' + ' '.repeat(100_000) + 'x',
    '1 '.repeat(50_000),
    '1,'.repeat(50_000),
    ','.repeat(100_000),
    '1' + 'e'.repeat(100_000),
    '3FS+' + '1'.repeat(100_000),
    '3 ' + 'S'.repeat(100_000),
    '1' + ' '.repeat(500) + 'x',
    '1 '.repeat(250) + 'x',
    '3SS+1' + ' '.repeat(450) + 'x',
    '1,'.repeat(255) + 'x',
  ])('fails fast on long input %#', (text) => {
    const started = performance.now();
    failure(() => parse(text, UNITS, new Set(Array.from({ length: 299 }, (_, i) => i + 1)), null));
    // a generous bound: it catches a runaway regex, not a busy machine
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('is fast and empty for whitespace of any size', () => {
    const started = performance.now();
    expect(parse(' '.repeat(1_000_000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('refuses text that is not a string', () => {
    for (const value of [null, undefined, 5, ['3'], { 3: 1 }]) {
      failure(() => parse(value as unknown as string));
    }
  });

  it('allows every valid id without a self id, and leaves the set alone', () => {
    expect(parse('1', UNITS, VALID_IDS, null)).toEqual(specs([[1, 'FS', 0, 'd', false]]));
    const ids = new Set([2, 3]);
    parse('2,3', UNITS, ids, null);
    expect([...ids]).toEqual([2, 3]);
  });
});

describe('splitEntries', () => {
  it('lines up with the parsed specs', () => {
    expect(splitEntries(' 2, 3SS+1d ,4 ')).toEqual(['2', '3SS+1d', '4']);
    expect(splitEntries(' \t ')).toEqual([]);
    expect(splitEntries('2,,3')).toEqual(['2', '', '3']);
  });
});

describe('formatPredecessors', () => {
  it.each(V.format)('formats %j', (rows, text) => {
    expect(formatPredecessors(specs(rows), UNITS)).toBe(text);
  });

  it.each(V.format_alt)('formats %j in the alternate calendar', (rows, text) => {
    expect(formatPredecessors(specs(rows), UNITS_ALT)).toBe(text);
  });

  it.each(V.format.filter(([rows]) => rows.length > 0 && roundTrips(rows)))(
    'round-trips %j', (rows, text) => {
      const want = specs(rows);
      const back = parsePredecessors(text, UNITS, new Set(want.map((s) => s.displayId)), null);
      expect(back).toEqual(want);
      expect(formatPredecessors(back, UNITS)).toBe(text);
    });

  it.each(V.format_alt.filter(([rows]) => roundTrips(rows, UNITS_ALT)))(
    'round-trips %j in the alternate calendar', (rows, text) => {
      const want = specs(rows);
      const ids = new Set(want.map((s) => s.displayId));
      expect(parsePredecessors(text, UNITS_ALT, ids, null)).toEqual(want);
    });

  it('formats every parse vector to text that parses back', () => {
    for (const [, rows] of V.parse) {
      const want = specs(rows);
      const text = formatPredecessors(want, UNITS);
      const back = parsePredecessors(text, UNITS, new Set(want.map((s) => s.displayId)), null);
      expect(back.length).toBe(want.length);
      back.forEach((got, i) => {
        expect([got.displayId, got.linkType, got.lag.minutes])
          .toEqual([want[i].displayId, want[i].linkType, want[i].lag.minutes]);
        if (want[i].lag.minutes !== 0) {
          expect([got.lag.unit, got.lag.elapsed]).toEqual([want[i].lag.unit, want[i].lag.elapsed]);
        }
      });
    }
  });

  it('is display text, not a lossless encoding', () => {
    const text = formatPredecessors(specs([[3, 'FS', 160, 'd', false]]), UNITS);
    expect(text).toBe('3FS+0.33 days');
    const [again] = parsePredecessors(text, UNITS, new Set([3]), null);
    expect(again.lag.minutes).toBe(158);
    expect(formatPredecessors([again], UNITS)).toBe(text);
  });

  it('refuses an unknown link type as a programming error', () => {
    const lag = { minutes: 0, unit: 'd' as const, elapsed: false };
    for (const linkType of ['XX', 'fs']) {
      let err: unknown;
      try {
        formatPredecessors([{ displayId: 3, linkType: linkType as LinkType, lag }], UNITS);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PredecessorError);
    }
  });
});

describe('keepsLag', () => {
  const stored = (minutes: number, unit: DurationUnit = 'd', elapsed = false) => ({ minutes, unit, elapsed });
  const entry = (text: string) => {
    const [spec] = parsePredecessors(text, UNITS, new Set([3]), null);
    return { spec, entry: splitEntries(text)[0] };
  };

  it('keeps the stored lag when the entry is the link’s own text', () => {
    const { spec, entry: e } = entry('3FS+0.33 days');
    expect(spec.lag.minutes).toBe(158);
    expect(keepsLag(stored(160), 'FS', spec, e, UNITS)).toBe(true);
  });

  it('keeps it when the entry reads the same, with the type changed', () => {
    const { spec, entry: e } = entry('3SS+0.33 days');
    expect(keepsLag(stored(160), 'FS', spec, e, UNITS)).toBe(true);
  });

  it('compares zero lags by minutes, not by unit', () => {
    const { spec, entry: e } = entry('3SS');
    expect(keepsLag(stored(0, 'h', true), 'FS', spec, e, UNITS)).toBe(true);
    expect(keepsLag(stored(1), 'FS', spec, e, UNITS)).toBe(false);
    const plus = entry('3FS+0 days');
    // a tiny stored lag shows as +0 days; typed back, it is a zero lag
    expect(keepsLag(stored(1), 'FS', plus.spec, plus.entry, UNITS)).toBe(true);
    expect(keepsLag(stored(0), 'SS', plus.spec, plus.entry, UNITS)).toBe(true);
  });

  it('takes the typed lag when it reads differently', () => {
    const { spec, entry: e } = entry('3FS+0.5 days');
    expect(keepsLag(stored(160), 'FS', spec, e, UNITS)).toBe(false);
    const flipped = entry('3FS-0.33 days');
    expect(keepsLag(stored(160), 'FS', flipped.spec, flipped.entry, UNITS)).toBe(false);
  });
});
