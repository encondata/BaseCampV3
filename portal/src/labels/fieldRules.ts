/**
 * The per-field value pipeline a designed label applies before it places a
 * value: Split → Strip → Max characters (trim) → Number padding, in that
 * order (spec §4.2). The canvas uses it to show what the printer will print;
 * the API's labels/field_rules.py is the same pipeline for the compiler, and
 * both are pinned by api/src/serversherpa/labels/fixtures/field_rules.json,
 * so change the two together.
 *
 * Lengths count characters (code points), like Python's len(), never UTF-16
 * units, so a value outside the BMP trims and pads the same in both.
 */

/** One placement's formatting. Every key is optional; a missing key turns its
 *  step off, except that a Strip with no side strips the front and Max
 *  characters with no side trims the rear. */
export interface FieldRules {
  display?: 'text' | 'number' | 'barcode' | 'qr';
  expectedLength?: number;
  maxChars?: number;
  trim?: 'front' | 'rear';
  strip?: string;
  stripWhere?: 'front' | 'rear' | 'anywhere';
}

/** Split breaks on `.` only; `''` is one empty piece. */
export function splitValue(value: string): string[] {
  return value.split('.');
}

/** The 0-based piece of a split value. A value with fewer pieces than the
 *  sample prints the missing ones blank. */
export function piece(value: string, index: number): string {
  const pieces = splitValue(value);
  return index >= 0 && index < pieces.length ? pieces[index] : '';
}

function strip(value: string, rules: FieldRules): string {
  const s = rules.strip ?? '';
  if (!s) return value;
  const where = rules.stripWhere ?? 'front';
  if (where === 'anywhere') return value.replaceAll(s, '');
  let out = value;
  if (where === 'rear') {
    while (out.endsWith(s)) out = out.slice(0, out.length - s.length);
    return out;
  }
  while (out.startsWith(s)) out = out.slice(s.length);
  return out;
}

function maxTrim(value: string, rules: FieldRules): string {
  const max = rules.maxChars ?? 0;   // 0 (or unset) means no limit
  const chars = Array.from(value);
  if (max <= 0 || chars.length <= max) return value;
  return (rules.trim === 'front' ? chars.slice(-max) : chars.slice(0, max)).join('');
}

/** Leading zeros on the integer part only (`3.5` → `03.5`, `.5` → `00.5`);
 *  never truncates. A blank value stays blank: no zeros. */
function padNumber(value: string, rules: FieldRules): string {
  const length = rules.expectedLength ?? 0;
  if (!value || rules.display !== 'number' || length <= 0) return value;
  const dot = value.indexOf('.');
  const head = dot < 0 ? value : value.slice(0, dot);
  const tail = dot < 0 ? '' : value.slice(dot);
  return '0'.repeat(Math.max(0, length - Array.from(head).length)) + head + tail;
}

/** Strip → Max/Trim → Number padding. Split is the caller's (`piece`). */
export function applyRules(value: string, rules: FieldRules): string {
  return padNumber(maxTrim(strip(value, rules), rules), rules);
}

/** Hide-when-empty's test: blank after Strip and Max/Trim. Padding leaves a
 *  blank value blank, so this always agrees with applyRules returning `''`. */
export function isBlank(value: string, rules: FieldRules): boolean {
  return maxTrim(strip(value, rules), rules) === '';
}
