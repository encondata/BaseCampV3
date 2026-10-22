/**
 * A JSON reader that keeps what Python's `json.loads` keeps, so the label
 * generator prints a synced value the way the laptop's Python prints it
 * (Porting rule 3):
 *   - a number keeps its literal text and whether Python reads it as an
 *     int (no fraction, no exponent) or a float: `12.0` stays a float and
 *     prints `12.0`, never `12`;
 *   - an object is a Map, so keys keep their order (a plain object would
 *     move "1" ahead of "b"); a duplicate key keeps its first position and
 *     takes the last value, like a dict;
 *   - Python's extra constants NaN, Infinity and -Infinity read as floats.
 * Everything JSON.parse accepts reads here, and nothing it refuses (bar
 * those constants). Strings decode through JSON.parse itself.
 *
 * Pure: no DOM, no Intl, no Node (the Android bundle runs it in a bare
 * JavaScript engine).
 */

/** A JSON number as Python holds it: `text` is the literal as written. */
export interface PyNumber {
  kind: 'int' | 'float';
  text: string;
}

/** A JSON array (a Python list). */
export type PyList = PyValue[];

/** A JSON object (a Python dict), in key order. */
export interface PyDict extends Map<string, PyValue> {}

/** Any value `json.loads` returns: None, bool, str, int/float, list, dict. */
export type PyValue = null | boolean | string | PyNumber | PyList | PyDict;

export function isPyDict(v: unknown): v is PyDict {
  return v instanceof Map;
}

export function isPyNumber(v: unknown): v is PyNumber {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Map)
    && ((v as PyNumber).kind === 'int' || (v as PyNumber).kind === 'float')
    && typeof (v as PyNumber).text === 'string';
}

const WS = /[ \t\n\r]*/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const CONSTANTS: readonly [string, PyValue][] = [
  ['null', null], ['true', true], ['false', false],
  ['NaN', { kind: 'float', text: 'NaN' }],
  ['Infinity', { kind: 'float', text: 'Infinity' }],
  ['-Infinity', { kind: 'float', text: '-Infinity' }],
];

class Reader {
  pos = 0;

  constructor(private readonly text: string) {}

  fail(what: string): never {
    throw new SyntaxError(`${what} at char ${this.pos}`);
  }

  ws(): void {
    WS.lastIndex = this.pos;
    WS.exec(this.text);
    this.pos = WS.lastIndex;
  }

  value(): PyValue {
    const ch = this.text[this.pos];
    if (ch === '"') return this.string();
    if (ch === '{') return this.object();
    if (ch === '[') return this.array();
    for (const [word, value] of CONSTANTS) {
      if (this.text.startsWith(word, this.pos)) {
        this.pos += word.length;
        // a fresh object each time: callers may hold on to it
        return isPyNumber(value) ? { ...value } : value;
      }
    }
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.text);
    if (!m) this.fail('Expecting value');
    this.pos = NUMBER.lastIndex;
    return { kind: m[1] !== undefined || m[2] !== undefined ? 'float' : 'int', text: m[0] };
  }

  string(): string {
    const start = this.pos;
    let i = start + 1;
    for (;;) {
      const ch = this.text[i];
      if (ch === undefined) {
        this.pos = start;
        this.fail('Unterminated string');
      }
      if (ch === '\\') i += 2;
      else if (ch === '"') break;
      else i += 1;
    }
    this.pos = i + 1;
    // JSON.parse checks the escapes and refuses raw control characters,
    // as Python's strict scanner does; it joins surrogate pairs the same way
    return JSON.parse(this.text.slice(start, i + 1)) as string;
  }

  array(): PyList {
    this.pos += 1;
    const out: PyList = [];
    this.ws();
    if (this.text[this.pos] === ']') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value());
      this.ws();
      const ch = this.text[this.pos];
      this.pos += 1;
      if (ch === ']') return out;
      if (ch !== ',') this.fail("Expecting ',' delimiter");
    }
  }

  object(): PyDict {
    this.pos += 1;
    const out: PyDict = new Map();
    this.ws();
    if (this.text[this.pos] === '}') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.text[this.pos] !== '"') this.fail('Expecting property name enclosed in double quotes');
      const key = this.string();
      this.ws();
      if (this.text[this.pos] !== ':') this.fail("Expecting ':' delimiter");
      this.pos += 1;
      this.ws();
      out.set(key, this.value());
      this.ws();
      const ch = this.text[this.pos];
      this.pos += 1;
      if (ch === '}') return out;
      if (ch !== ',') this.fail("Expecting ',' delimiter");
    }
  }
}

/** `json.loads(text)`, numbers kept as written and objects as Maps. Throws a
 *  SyntaxError for anything Python's json (and JSON.parse) refuses. */
export function parsePyJson(text: string): PyValue {
  const r = new Reader(text);
  r.ws();
  const value = r.value();
  r.ws();
  if (r.pos !== text.length) r.fail('Extra data');
  return value;
}
