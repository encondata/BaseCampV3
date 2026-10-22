/**
 * The per-field value pipeline a designed label applies before it places a
 * value (labels/field_rules.py): Split → Strip → Max characters (trim) →
 * Number padding, in that order. fixtures/field_rules.json pins it to the
 * Python. Lengths count code points, never bytes or UTF-16 units.
 *
 * Ported rather than imported from the portal's labels/fieldRules.ts so the
 * rules keep model.py's snake_case keys (`FieldEl.rules`), which the
 * generator's model builds them with. Pure: no DOM, no Intl, no Node.
 */

import { cpLength, cpSlice, rjust } from './py';

/** One placement's formatting. Every key is optional; a missing key turns
 *  its step off, except that a Strip with no side strips the front and Max
 *  characters with no side trims the rear. */
export interface FieldRules {
  display?: 'text' | 'number' | 'barcode' | 'qr';
  expected_length?: number;
  max_chars?: number;
  trim?: 'front' | 'rear';
  strip?: string;
  strip_where?: 'front' | 'rear' | 'anywhere';
}

/** Split breaks on `.` only; '' is one empty piece. */
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
  const s = rules.strip || '';
  if (!s) return value;
  const where = rules.strip_where || 'front';
  if (where === 'anywhere') return value.split(s).join('');
  let out = value;
  if (where === 'rear') {
    while (out.endsWith(s)) out = out.slice(0, out.length - s.length);
    return out;
  }
  while (out.startsWith(s)) out = out.slice(s.length);
  return out;
}

function maxTrim(value: string, rules: FieldRules): string {
  // 0 (or unset) means no limit
  const maxChars = rules.max_chars || 0;
  if (maxChars <= 0 || cpLength(value) <= maxChars) return value;
  if (rules.trim === 'front') return cpSlice(value, -maxChars);
  return cpSlice(value, 0, maxChars);
}

/** Leading zeros on the integer part only (`3.5` → `03.5`, `.5` → `00.5`);
 *  never truncates. A blank value stays blank: no zeros. */
function padNumber(value: string, rules: FieldRules): string {
  const length = rules.expected_length || 0;
  if (!value || rules.display !== 'number' || length <= 0) return value;
  const dot = value.indexOf('.');
  const head = dot < 0 ? value : value.slice(0, dot);
  const tail = dot < 0 ? '' : value.slice(dot);
  return rjust(head, length, '0') + tail;
}

/** Strip → Max/Trim → Number padding. Split is the caller's (`piece`). */
export function applyRules(value: string, rules: FieldRules): string {
  return padNumber(maxTrim(strip(value, rules), rules), rules);
}

/** Hide-when-empty's test: blank after Strip and Max/Trim. */
export function isBlank(value: string, rules: FieldRules): boolean {
  return maxTrim(strip(value, rules), rules) === '';
}
