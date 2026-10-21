/**
 * A design's JSON as Python's model.py sees it (`json.loads` output): the
 * number-preserving reader's tree (pyjson.ts) as it is, or a plain
 * JSON.parse tree converted to one (there a whole number reads as an int),
 * plus the checks model.py makes on it: `_num`, `_int`, `bool()`, `in` a
 * tuple of strings, `dict.get`. Pure: no DOM, no Intl, no Node.
 */

import { isPyDict, isPyNumber, type PyDict, type PyNumber, type PyValue } from './pyjson';

/** A plain JSON.parse value as the number-preserving reader would give it:
 *  objects become dicts, numbers ints (whole) or floats. A Map is taken as
 *  an already-read subtree. */
export function fromPlain(v: unknown): PyValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return numberOf(v);
  if (Array.isArray(v)) return v.map(fromPlain);
  if (v instanceof Map) return v as PyDict;
  if (typeof v === 'object') {
    const out: PyDict = new Map();
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      if (item !== undefined) out.set(k, fromPlain(item));
    }
    return out;
  }
  throw new TypeError(`not a JSON value: ${typeof v}`);
}

/** A JavaScript number as a Python int (whole) or float. */
export function numberOf(n: number): PyNumber {
  if (Number.isNaN(n)) return { kind: 'float', text: 'NaN' };
  if (!Number.isFinite(n)) return { kind: 'float', text: n > 0 ? 'Infinity' : '-Infinity' };
  if (Number.isInteger(n)) return { kind: 'int', text: BigInt(n).toString() };
  return { kind: 'float', text: String(n) };
}

/** `raw` as a Python value: a reader tree (a dict at the top) as it is, a
 *  plain JSON.parse tree converted. */
export function asPy(raw: unknown): PyValue {
  return isPyDict(raw) ? raw : fromPlain(raw);
}

/** Python's `bool(v)`. */
export function pyTruthy(v: PyValue | undefined): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'string') return v !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (isPyDict(v)) return v.size > 0;
  return Number(v.text) !== 0; // NaN is true, as in Python
}

/** The number a PyNumber holds. An int too large for a float raises
 *  OverflowError in Python wherever the model reads it as one. */
export function toFloat(v: PyNumber): number {
  const n = Number(v.text);
  if (v.kind === 'int' && !Number.isFinite(n)) throw new RangeError('int too large to convert to float');
  return n;
}

/** An int's value, for comparing (never read as a float, so a huge one
 *  doesn't overflow: Python compares ints exactly). */
export const intOf = (v: PyNumber): number => Number(v.text);

/** model.py `_num`: a finite int or float, never a bool. */
export function isNum(v: PyValue | undefined): v is PyNumber {
  return isPyNumber(v) && Number.isFinite(toFloat(v));
}

/** model.py `_int`: an int, never a bool or a float. */
export function isInt(v: PyValue | undefined): v is PyNumber {
  return isPyNumber(v) && v.kind === 'int';
}

/** `v in (…strings)`: only an equal str is in a tuple of strings. */
export function isOneOf<T extends string>(v: PyValue | undefined, choices: readonly T[]): v is T {
  return typeof v === 'string' && (choices as readonly string[]).includes(v);
}

/** `dict.get(key)`; undefined = missing (a JSON null is null). */
export const get = (d: PyDict, key: string): PyValue | undefined => d.get(key);
/** `dict.get(key, default)`. */
export const getOr = (d: PyDict, key: string, dflt: PyValue): PyValue => (d.has(key) ? d.get(key)! : dflt);
