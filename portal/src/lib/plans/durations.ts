/**
 * Duration and lag text for project plans: `5d`, `4 hrs`, `3ed`, `+2d`.
 *
 * A port of api/src/serversherpa/plans/durations.py, held to the same
 * vectors (api/tests/fixtures/plans/durations.json), so the sheet can check
 * a cell as it is typed and agree with the server. The portal never
 * schedules: these only parse and format.
 *
 * A duration is whole minutes plus the unit typed (display uses it back)
 * and an `elapsed` flag. Working units (m h d w mo) scale with the plan
 * calendar through `Units`; elapsed units (em eh ed ew emo) are wall-clock.
 *
 * Port rules: only ASCII whitespace is trimmed or allowed (String.trim and
 * a regex `\s` also take Unicode spaces the API refuses), and the minutes
 * are computed with BigInt from the exact decimal, never a float multiply
 * (1.025 * 60 is 61.49999999999999 in a double; the API reads 62).
 */

export type DurationUnit = 'm' | 'h' | 'd' | 'w' | 'mo';

export const DURATION_UNITS: readonly DurationUnit[] = ['m', 'h', 'd', 'w', 'mo'];

/** Working minutes in a day, week and month of one plan's calendar. */
export interface Units {
  minutesPerDay: number;
  minutesPerWeek: number;
  minutesPerMonth: number;
}

/** MS Project's Standard calendar: 8 h a day, 40 a week, 20 days a month. */
export const STANDARD_UNITS: Units = Object.freeze({
  minutesPerDay: 480, minutesPerWeek: 2400, minutesPerMonth: 9600,
});

export interface Duration {
  minutes: number;          // negative only for a lag (a lead)
  unit: DurationUnit;       // the unit shown back to the user
  elapsed: boolean;
}

/** Elapsed units never depend on the calendar. */
const ELAPSED_MINUTES: Record<DurationUnit, number> = { m: 1, h: 60, d: 1440, w: 10080, mo: 43200 };

const WORKING_LABELS: Record<DurationUnit, [string, string]> = {
  m: ['min', 'mins'], h: ['hr', 'hrs'], d: ['day', 'days'], w: ['wk', 'wks'], mo: ['mon', 'mons'],
};

/** Every spelling the parser accepts, lower-cased, to its unit. */
const UNIT_WORDS: Record<string, DurationUnit> = {};
for (const [unit, words] of [
  ['mo', ['mo', 'mon', 'mons', 'month', 'months']],
  ['m', ['m', 'min', 'mins', 'minute', 'minutes']],
  ['h', ['h', 'hr', 'hrs', 'hour', 'hours']],
  ['d', ['d', 'day', 'days']],
  ['w', ['w', 'wk', 'wks', 'week', 'weeks']],
] as const) {
  for (const word of words) UNIT_WORDS[word] = unit;
}

/** Input limits, shared with the API through the vectors file. */
export const MAX_DURATION_TEXT = 64;
export const MAX_INTEGER_DIGITS = 9;

const ASCII_WHITESPACE = ' \t\n\r\f\v';

/** Matched against already-trimmed text. ASCII classes only, and no `u`
 *  flag: case-insensitive matching then never folds a non-ASCII letter
 *  onto an ASCII one. The `mo...` spellings come before `m...`. */
const PATTERN = new RegExp(
  '^([+-]?)([0-9]+(?:\\.[0-9]+)?)[ \\t\\n\\r\\f\\v]*(e?)'
  + '(mo|mons?|months?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)?$',
  'i',
);

/** The text is not a duration (or lag). */
export class DurationError extends Error {
  readonly code = 'bad_duration';

  constructor(message: string) {
    super(message);
    this.name = 'DurationError';
  }
}

/** `s` without the ASCII whitespace around it (space, tab, CR, LF, FF,
 *  VT); a no-break space or any other Unicode space stays. */
export function asciiTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && ASCII_WHITESPACE.includes(s[start])) start += 1;
  while (end > start && ASCII_WHITESPACE.includes(s[end - 1])) end -= 1;
  return s.slice(start, end);
}

/** Minutes in one `unit`: working, or wall-clock when `elapsed`. */
export function unitMinutes(units: Units, unit: DurationUnit, elapsed: boolean): number {
  if (!DURATION_UNITS.includes(unit)) throw new Error(`unknown duration unit ${String(unit)}`);
  if (elapsed) return ELAPSED_MINUTES[unit];
  switch (unit) {
    case 'm': return 1;
    case 'h': return 60;
    case 'd': return units.minutesPerDay;
    case 'w': return units.minutesPerWeek;
    default: return units.minutesPerMonth;
  }
}

/** A non-negative exact quotient rounded to a whole number, halves up. */
function halfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** A finite number as an exact fraction of its shortest decimal text, the
 *  value Python's `Fraction(str(value))` reads ("7.35", "1e-7"). */
function exactDecimal(value: number): [bigint, bigint] {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/i.exec(String(value));
  if (!m) throw new Error(`not a number: ${String(value)}`);
  const [, sign, whole, frac = '', exp = '0'] = m;
  let numerator = BigInt(whole + frac) * (sign ? -1n : 1n);
  let denominator = 10n ** BigInt(frac.length);
  const shift = Number(exp);
  if (shift >= 0) numerator *= 10n ** BigInt(shift);
  else denominator *= 10n ** BigInt(-shift);
  return [numerator, denominator];
}

type CalendarUnitKeys = {
  hours_per_day?: number | null;
  hours_per_week?: number | null;
  days_per_month?: number | null;
};

/**
 * The units of a plan calendar's `hours_per_day`, `hours_per_week` and
 * `days_per_month`; a missing or null key keeps the Standard value. Minutes
 * round half up. A value that is not a positive number (or rounds to under
 * a minute) throws a plain Error: that is a bad calendar, not bad duration
 * text, so it is not a DurationError.
 */
export function unitsOf(calendar: CalendarUnitKeys | null | undefined): Units {
  const cal = calendar ?? {};
  const minutes = (key: keyof CalendarUnitKeys, fallback: number, per: number): number => {
    const raw: unknown = cal[key] ?? fallback;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new Error(`${key} must be a number, got ${String(raw)}`);
    }
    const [numerator, denominator] = exactDecimal(raw);
    const result = numerator > 0n ? halfUp(numerator * BigInt(per), denominator) : 0n;
    if (result < 1n) throw new Error(`${key} must be positive, got ${String(raw)}`);
    return Number(result);
  };
  const minutesPerDay = minutes('hours_per_day', 8, 60);
  return {
    minutesPerDay,
    minutesPerWeek: minutes('hours_per_week', 40, 60),
    minutesPerMonth: minutes('days_per_month', 20, minutesPerDay),
  };
}

/** An error that never echoes unbounded input. */
function bad(text: unknown, what: 'duration' | 'lag'): DurationError {
  const hint = what === 'lag' ? 'Try +2d, -4h or 1ed.' : 'Try 5d, 4h or 3ed.';
  if (typeof text !== 'string') {
    return new DurationError(`That isn’t a ${what}. ${hint}`);
  }
  const shown = text.length > 40 ? `${text.slice(0, 40)}...` : text;
  return new DurationError(`${JSON.stringify(shown)} isn’t a ${what}. ${hint}`);
}

function parse(text: string, units: Units, defaultUnit: DurationUnit, signed: boolean): Duration {
  if (!DURATION_UNITS.includes(defaultUnit)) {
    throw new Error(`unknown default unit ${String(defaultUnit)}`);
  }
  const what = signed ? 'lag' : 'duration';
  if (typeof text !== 'string') throw bad(text, what);
  const trimmed = asciiTrim(text);
  if (trimmed.length > MAX_DURATION_TEXT) throw bad(text, what);
  const match = PATTERN.exec(trimmed);
  if (!match) throw bad(text, what);
  const [, sign, number, elapsedFlag, word] = match;
  if (sign && !signed) throw bad(text, what);
  const [whole, frac = ''] = number.split('.');
  if (whole.length > MAX_INTEGER_DIGITS) throw bad(text, what);
  let unit: DurationUnit;
  let elapsed: boolean;
  if (word === undefined) {
    // "1e" names the elapsed prefix but no unit
    if (elapsedFlag) throw bad(text, what);
    unit = defaultUnit;
    elapsed = false;
  } else {
    unit = UNIT_WORDS[word.toLowerCase()];
    elapsed = elapsedFlag !== '';
  }
  const per = BigInt(unitMinutes(units, unit, elapsed));
  const size = Number(halfUp(BigInt(whole + frac) * per, 10n ** BigInt(frac.length)));
  // the size rounds first, then takes the sign; -0 reads as 0
  return { minutes: sign === '-' && size !== 0 ? -size : size, unit, elapsed };
}

/** `5d`, `4 hrs`, `0.5d`, `3ed`, `2 wks`; a bare number takes
 *  `defaultUnit`. Never negative, so a sign is an error. */
export function parseDuration(text: string, units: Units, defaultUnit: DurationUnit = 'd'): Duration {
  return parse(text, units, defaultUnit, false);
}

/** A duration with an optional sign: `+2d`, `-4h`, `2d`. A lead is a
 *  negative `minutes`. */
export function parseLag(text: string, units: Units, defaultUnit: DurationUnit = 'd'): Duration {
  return parse(text, units, defaultUnit, true);
}

/** Durations and lags are capped at 10 years: 260 working days a year of
 *  the plan's own day, or 365 wall-clock days for elapsed time. The parser
 *  has no magnitude cap; the API refuses past this (`bad_duration`). */
export const MAX_YEARS = 10;

/** The longest duration or lag (either way) a plan takes, in minutes. */
export function maxMinutes(units: Units, elapsed: boolean): number {
  return elapsed ? 1440 * 365 * MAX_YEARS : units.minutesPerDay * 260 * MAX_YEARS;
}

function format(minutes: number, unit: DurationUnit, elapsed: boolean, units: Units, plus: boolean): string {
  const per = BigInt(unitMinutes(units, unit, elapsed));
  // hundredths of a unit, halves up: at most two decimals shown
  const hundredths = halfUp(BigInt(Math.abs(minutes)) * 100n, per);
  const whole = hundredths / 100n;
  const frac = hundredths % 100n;
  const number = frac === 0n
    ? whole.toString()
    : `${whole}.${frac.toString().padStart(2, '0')}`.replace(/0+$/, '');
  const [singular, plural] = WORKING_LABELS[unit];
  const label = (elapsed ? 'e' : '') + (number === '1' ? singular : plural);
  let sign = '';
  if (hundredths !== 0n) {
    if (minutes < 0) sign = '-';
    else if (plus) sign = '+';
  }
  return `${sign}${number} ${label}`;
}

/** `5 days`, `1 day`, `4 hrs`, `0.5 days`, `3 edays`, `0 days`. */
export function formatDuration(minutes: number, unit: DurationUnit, elapsed: boolean, units: Units): string {
  return format(minutes, unit, elapsed, units, false);
}

/** Like `formatDuration` with an explicit sign: `+2 days`, `-4 hrs`, `0 days`. */
export function formatLag(minutes: number, unit: DurationUnit, elapsed: boolean, units: Units): string {
  return format(minutes, unit, elapsed, units, true);
}
