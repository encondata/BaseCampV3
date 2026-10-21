/**
 * Python-compatible primitives for the label generator (the Porting rules
 * in the Android label printing plan). The laptop builds labels in Python
 * (api/src/serversherpa/labels/*.py); this port must produce the same
 * bytes, so every place Python's semantics differ from JavaScript's goes
 * through here:
 *   - round() is half to even (`pyRound`), `//` floors (`floorDiv`);
 *   - strings count, slice and pad in code points, never UTF-16 units;
 *   - str() of a JSON value (`pyStr`), and fields.py `_text` (`pyText`);
 *   - Decimal text: fields.py `ru_text` (`decimalNormalize`) and
 *     label_values.py `_format_ru` (`formatRu`), on strings, never floats;
 *   - date.fromisoformat (`dateFromIsoformat`, CPython's C parser) and
 *     label_values.py `move_dates` (`moveDates`).
 *
 * Pure: no DOM, no Intl, no Node, no TextEncoder (the Android bundle runs
 * in a bare JavaScript engine). Unicode property escapes in regular
 * expressions are plain ECMAScript.
 */

import { isPyDict, isPyNumber, type PyValue } from './pyjson';

// --- numbers ---------------------------------------------------------------

/** Python's `round(x)` to an int: halves go to the even neighbor. */
export function pyRound(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x} to an integer`);
  const f = Math.floor(x);
  const diff = x - f; // exact for any double
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f === 0 ? 0 : f; // never -0
  return f % 2 === 0 ? f : f + 1;
}

/** Python's `a // b`. */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

// --- code-point strings ----------------------------------------------------

/** The code points of `s` (a lone surrogate is one, as in Python). */
export function codePoints(s: string): string[] {
  return Array.from(s);
}

/** Python's `len(s)`. */
export function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** Python's `s[start:end]`, negative indices and clamping included. */
export function cpSlice(s: string, start: number, end?: number): string {
  const cps = codePoints(s);
  const len = cps.length;
  const norm = (i: number) => (i < 0 ? Math.max(0, len + i) : Math.min(i, len));
  const a = norm(start);
  const b = end === undefined ? len : norm(end);
  return a < b ? cps.slice(a, b).join('') : '';
}

/** Python's `s.rjust(width, fill)` (`fill` one character). */
export function rjust(s: string, width: number, fill: string): string {
  const pad = width - cpLength(s);
  return pad > 0 ? fill.repeat(pad) + s : s;
}

// str.isspace(): not JavaScript's trim() set (that has U+FEFF, lacks
// U+001C..U+001F and U+0085)
const PY_SPACE = '\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003'
  + '\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';

export function isPySpace(ch: string): boolean {
  return ch.length === 1 && PY_SPACE.includes(ch);
}

/** Python's `s.strip()`. */
export function pyStrip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isPySpace(s[a])) a += 1;
  while (b > a && isPySpace(s[b - 1])) b -= 1;
  return s.slice(a, b);
}

/** `s.encode("utf-8")`. A lone surrogate throws, as it does in Python. */
export function utf8Encode(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new RangeError(`'utf-8' codec can't encode character '\\u${cp.toString(16)}': surrogates not allowed`);
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f));
    }
  }
  return out;
}

/** `len(s.encode("utf-8"))`. */
export function utf8Length(s: string): number {
  return utf8Encode(s).length;
}

// --- str() and repr() of JSON values ----------------------------------------

// str.isprintable() is false for these categories (ASCII space aside)
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

const hex = (cp: number, width: number) => cp.toString(16).padStart(width, '0');

/** Python's `repr(s)` of a str. */
export function reprString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${hex(cp, 2)}`;
    else if (cp < 0x7f) out += ch;
    else if (!NOT_PRINTABLE.test(ch)) out += ch;
    else if (cp <= 0xff) out += `\\x${hex(cp, 2)}`;
    else if (cp <= 0xffff) out += `\\u${hex(cp, 4)}`;
    else out += `\\U${hex(cp, 8)}`;
  }
  return out + quote;
}

/** Python's `repr(x)` of a float: the shortest digits that read back as
 *  `x`, in exponent form below 1e-4 or from 1e16 (`1e-05`, `1e+16`), and a
 *  whole number in fixed form ends `.0`. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  // toExponential() with no argument gives the shortest round-trip digits
  const [mantissa, expText] = Math.abs(x).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const e = Number(expText);
  if (e < -4 || e >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  if (e < 0) return `${sign}0.${'0'.repeat(-e - 1)}${digits}`;
  if (digits.length <= e + 1) return `${sign}${digits}${'0'.repeat(e + 1 - digits.length)}.0`;
  return `${sign}${digits.slice(0, e + 1)}.${digits.slice(e + 1)}`;
}

function numberStr(text: string, kind: 'int' | 'float'): string {
  if (kind === 'int') return text === '-0' ? '0' : text;
  if (text === 'NaN') return 'nan';
  if (text === 'Infinity') return 'inf';
  if (text === '-Infinity') return '-inf';
  return floatRepr(Number(text));
}

/** Python's `repr(v)` of a parsed JSON value (undefined reads as None). */
export function pyRepr(v: PyValue | undefined): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return reprString(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (isPyDict(v)) {
    return `{${[...v].map(([k, item]) => `${reprString(k)}: ${pyRepr(item)}`).join(', ')}}`;
  }
  if (isPyNumber(v)) return numberStr(v.text, v.kind);
  throw new TypeError('not a parsed JSON value');
}

/** Python's `str(v)` of a parsed JSON value: a str is itself, anything else
 *  its repr (`None`, `True`, `12.0`, `[1, 'a']`, `{'a': 1}`). */
export function pyStr(v: PyValue | undefined): string {
  return typeof v === 'string' ? v : pyRepr(v);
}

/** fields.py `_text`: any sync value as label text. None -> '', a boolean
 *  -> Yes/No, a str as is, anything else str(). */
export function pyText(v: PyValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return pyStr(v);
}

// --- Decimal ----------------------------------------------------------------

const PREC = 28; // the default context's precision
const EMAX = 999999;

interface ParsedDecimal {
  negative: boolean;
  kind: 'finite' | 'inf' | 'nan' | 'snan';
  /** finite: the coefficient's digits (leading zeros kept); NaN: the payload */
  digits: string;
  exp: number;
}

const DECIMAL_RE = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const SPECIAL_RE = /^([+-])?(?:(inf|infinity)|(nan|snan)(\d*))$/i;
const ND = /\p{Nd}/u;

/** The value of a Unicode decimal digit. Decimal digits come in runs of
 *  ten, 0 to 9, so it is the distance from its run's start, mod 10. */
function digitValue(cp: number): number {
  let start = cp;
  while (ND.test(String.fromCodePoint(start - 1))) start -= 1;
  return (cp - start) % 10;
}

/** `Decimal(text)`'s reading of a string, or null where it raises
 *  InvalidOperation. Like CPython's C decimal: underscores anywhere are
 *  dropped, whitespace at the ends is stripped, and any Unicode decimal
 *  digit reads as its ASCII digit. */
function parseDecimal(text: string): ParsedDecimal | null {
  let ascii = '';
  for (const ch of pyStrip(text.split('_').join(''))) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0 && cp <= 127) ascii += ch;
    else if (ND.test(ch)) ascii += String(digitValue(cp));
    else return null;
  }
  const m = DECIMAL_RE.exec(ascii);
  if (m) {
    const [, sign, whole, frac, onlyFrac, expText] = m;
    const intPart = whole ?? '';
    const fracPart = frac ?? onlyFrac ?? '';
    const exp = Number(expText ?? '0') - fracPart.length;
    if (!Number.isSafeInteger(exp)) return null;
    return { negative: sign === '-', kind: 'finite', digits: intPart + fracPart, exp };
  }
  const s = SPECIAL_RE.exec(ascii);
  if (!s) return null;
  const negative = s[1] === '-';
  if (s[2]) return { negative, kind: 'inf', digits: '', exp: 0 };
  return {
    negative, kind: s[3].toLowerCase() === 'snan' ? 'snan' : 'nan',
    digits: s[4].replace(/^0+/, ''), exp: 0,
  };
}

/** Coefficient digits times 10**exp written out in `format(d, "f")` form. */
function fixedText(negative: boolean, digits: string, exp: number): string {
  const sign = negative ? '-' : '';
  if (exp >= 0) return sign + (digits === '0' ? '0' : digits + '0'.repeat(exp));
  const point = digits.length + exp;
  if (point > 0) return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${sign}0.${'0'.repeat(-point)}${digits}`;
}

/** Round a digit string to `PREC` significant digits, half to even.
 *  Returns the new digits and how far the exponent moves. */
function roundToPrecision(digits: string): [string, number] {
  if (digits.length <= PREC) return [digits, 0];
  const shift = digits.length - PREC;
  let kept = digits.slice(0, PREC);
  const first = digits[PREC];
  const rest = digits.slice(PREC + 1);
  const up = first > '5' || (first === '5' && (/[1-9]/.test(rest) || Number(kept[PREC - 1]) % 2 === 1));
  if (!up) return [kept, shift];
  // add one to the kept digits, carrying
  const chars = kept.split('');
  let i = chars.length - 1;
  while (i >= 0 && chars[i] === '9') {
    chars[i] = '0';
    i -= 1;
  }
  if (i < 0) return [`1${'0'.repeat(PREC - 1)}`, shift + 1];
  chars[i] = String(Number(chars[i]) + 1);
  kept = chars.join('');
  return [kept, shift];
}

/** fields.py `ru_text`'s number: `format(Decimal(text).normalize(), "f")`
 *  (28 significant digits, half to even, trailing zeros dropped), or null
 *  where ru_text prints the text as it is (not a finite decimal). The
 *  caller strips and blanks first, as ru_text does. */
export function decimalNormalize(text: string): string | null {
  const d = parseDecimal(text);
  if (d === null || d.kind !== 'finite') return null;
  let digits = d.digits.replace(/^0+/, '');
  if (digits === '') return d.negative ? '-0' : '0';
  const [rounded, shift] = roundToPrecision(digits);
  digits = rounded;
  let exp = d.exp + shift;
  if (exp + digits.length - 1 > EMAX) throw new RangeError('decimal Overflow');
  while (digits.length > 1 && digits.endsWith('0') && exp < EMAX) {
    digits = digits.slice(0, -1);
    exp += 1;
  }
  return fixedText(d.negative, digits, exp);
}

const rstrip = (s: string, ch: string) => {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end -= 1;
  return s.slice(0, end);
};

/** label_values.py `_format_ru` of the laptop edge's `_decimal(raw)`: an RU
 *  shaped like V2's `U14` / `U14.5`. No value, or text Decimal refuses,
 *  is ''. Throws where Python raises (Infinity, sNaN). */
export function formatRu(text: string | null | undefined): string {
  if (text === null || text === undefined || text === '') return '';
  const d = parseDecimal(text);
  if (d === null) return '';
  if (d.kind === 'snan') throw new RangeError('[<class \'decimal.InvalidOperation\'>]');
  if (d.kind === 'inf') throw new RangeError('cannot convert Infinity to integer');
  if (d.kind === 'nan') {
    // NaN never equals its integral value; format(NaN, "f") is NaN<payload>
    const formatted = `${d.negative ? '-' : ''}NaN${d.digits}`;
    return `U${rstrip(rstrip(formatted, '0'), '.')}`;
  }
  const digits = d.digits.replace(/^0+/, '') || '0';
  const fracDigits = d.exp < 0 ? digits.slice(Math.max(0, digits.length + d.exp)) : '';
  if (/^0*$/.test(fracDigits)) {
    // a whole number: int(value), which drops the sign of a zero
    const whole = d.exp >= 0
      ? digits + '0'.repeat(d.exp)
      : digits.slice(0, Math.max(0, digits.length + d.exp));
    const intText = whole.replace(/^0+/, '') || '0';
    return `U${d.negative && intText !== '0' ? '-' : ''}${intText}`;
  }
  return `U${rstrip(rstrip(fixedText(d.negative, digits, d.exp), '0'), '.')}`;
}

// --- dates ------------------------------------------------------------------

export interface PyDate {
  year: number;
  month: number;
  day: number;
}

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysInMonth = (y: number, m: number) => (m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m]);

/** datetime's proleptic ordinal: 0001-01-01 is day 1 (a Monday). */
function ymdToOrd(y: number, m: number, d: number): number {
  const py = y - 1;
  return py * 365 + floorDiv(py, 4) - floorDiv(py, 100) + floorDiv(py, 400)
    + DAYS_BEFORE_MONTH[m] + (m > 2 && isLeap(y) ? 1 : 0) + d;
}

/** datetime's `_ord2ymd`. */
function ordToYmd(ord: number): PyDate {
  let n = ord - 1;
  const n400 = floorDiv(n, 146097);
  n -= n400 * 146097;
  let year = n400 * 400 + 1;
  const n100 = floorDiv(n, 36524);
  n -= n100 * 36524;
  const n4 = floorDiv(n, 1461);
  n -= n4 * 1461;
  const n1 = floorDiv(n, 365);
  n -= n1 * 365;
  year += n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) return { year: year - 1, month: 12, day: 31 };
  const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
  let month = (n + 50) >> 5;
  let preceding = DAYS_BEFORE_MONTH[month] + (month > 2 && leap ? 1 : 0);
  if (preceding > n) {
    month -= 1;
    preceding -= DAYS_IN_MONTH[month] + (month === 2 && leap ? 1 : 0);
  }
  return { year, month, day: n - preceding + 1 };
}

function isoWeek1Monday(year: number): number {
  const first = ymdToOrd(year, 1, 1);
  const weekday = (first + 6) % 7; // Monday is 0
  return first - weekday + (weekday > 3 ? 7 : 0);
}

/** `date.fromisoformat(text)` as CPython's C parser reads it, or null where
 *  it raises: `YYYY-MM-DD`, `YYYYMMDD`, `YYYY-Www[-D]`, `YYYYWww[D]`. Like
 *  CPython, it checks only that the UTF-8 length is 7, 8 or 10 and never
 *  looks past the date it read. */
export function dateFromIsoformat(text: string): PyDate | null {
  let size: number;
  try {
    size = utf8Length(text);
  } catch {
    return null; // a lone surrogate: not UTF-8, ValueError
  }
  if (size !== 7 && size !== 8 && size !== 10) return null;
  const cps = codePoints(text);
  let p = 0;
  const digits = (n: number): number | null => {
    let v = 0;
    for (let i = 0; i < n; i += 1) {
      const ch = cps[p + i];
      if (ch === undefined || ch < '0' || ch > '9' || ch.length !== 1) return null;
      v = v * 10 + (ch.charCodeAt(0) - 48);
    }
    p += n;
    return v;
  };
  const year = digits(4);
  if (year === null) return null;
  const sep = cps[p] === '-';
  if (sep) p += 1;
  let ymd: PyDate;
  if (cps[p] === 'W') {
    p += 1;
    const week = digits(2);
    if (week === null) return null;
    let weekday = 1;
    if (p < cps.length) {
      if (sep && cps[p++] !== '-') return null;
      const d = digits(1);
      if (d === null) return null;
      weekday = d;
    }
    if (year < 1 || year > 9999) return null;
    if (week <= 0 || week >= 53) {
      const first = ymdToOrd(year, 1, 1) % 7; // Thursday is 4
      if (!(week === 53 && (first === 4 || (first === 3 && isLeap(year))))) return null;
    }
    if (weekday <= 0 || weekday >= 8) return null;
    ymd = ordToYmd(isoWeek1Monday(year) + (week - 1) * 7 + weekday - 1);
  } else {
    const month = digits(2);
    if (month === null) return null;
    if (sep && cps[p++] !== '-') return null;
    const day = digits(2);
    if (day === null) return null;
    ymd = { year, month, day };
  }
  const { year: y, month: m, day: d } = ymd;
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return ymd;
}

const MONTHS_UPPER = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** label_values.py `move_dates` of the laptop edge's `_day(raw)`:
 *  `move_date` (`%m/%d/%Y`) and `move_date_long` (`05-OCT-2026`). No day,
 *  or one date.fromisoformat refuses, is blank. fields.py reads only the
 *  first ten characters: pass `cpSlice(raw, 0, 10)` for that path. */
export function moveDates(isoDay: string | null | undefined): [string, string] {
  const day = typeof isoDay === 'string' && isoDay ? dateFromIsoformat(isoDay) : null;
  if (day === null) return ['', ''];
  return [
    `${pad(day.month, 2)}/${pad(day.day, 2)}/${pad(day.year, 4)}`,
    `${pad(day.day, 2)}-${MONTHS_UPPER[day.month - 1]}-${day.year}`,
  ];
}
