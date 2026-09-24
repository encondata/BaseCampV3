/**
 * The naming-convention rule for Create a move in steps (crates and
 * trucks). Mirrors api/src/serversherpa/imports/naming.py exactly — every
 * sentence too — so the live preview never disagrees with the server. A
 * convention is literal text with exactly one run of x's (either case); the
 * run's length is the zero-padding and a longer number is never truncated.
 */
export const CRATE_MAX = 500;
export const TRUCK_MAX = 100;

export interface Convention { prefix: string; width: number; suffix: string }
/** The step's fields as typed text, so a field can be emptied mid-edit. */
export interface NamingValue { convention: string; count: string; start: string }

export const NAMING_MESSAGES = {
  convention_required: 'Enter a naming convention, like CRT-xxx.',
  no_number: "Mark the number with a run of x's, like CRT-xxx.",
  many_numbers: "Use only one run of x's for the number.",
  start_negative: "The start number can't be below 0.",
  start_blank: 'Enter a start number.',
} as const;

export const countMessage = (max: number) => `The count must be between 0 and ${max}.`;

export function parseConvention(text: string): Convention | { error: string } {
  const value = text.trim();
  if (!value) return { error: NAMING_MESSAGES.convention_required };
  const runs = [...value.matchAll(/[xX]+/g)];
  if (runs.length === 0) return { error: NAMING_MESSAGES.no_number };
  if (runs.length > 1) return { error: NAMING_MESSAGES.many_numbers };
  const run = runs[0]!;
  const at = run.index ?? 0;
  return { prefix: value.slice(0, at), width: run[0].length, suffix: value.slice(at + run[0].length) };
}

/** A whole number typed into a field, or null for blank / anything else. */
export function toWhole(text: string): number | null {
  return /^\s*-?\d+\s*$/.test(text) ? Number(text.trim()) : null;
}

export function generateNames(
  convention: string, count: number, start: number, max: number,
): { names: string[]; error: string | null } {
  const rule = parseConvention(convention);
  if ('error' in rule) return { names: [], error: rule.error };
  if (count < 0 || count > max) return { names: [], error: countMessage(max) };
  if (start < 0) return { names: [], error: NAMING_MESSAGES.start_negative };
  const names = Array.from({ length: count },
    (_, i) => `${rule.prefix}${String(start + i).padStart(rule.width, '0')}${rule.suffix}`);
  return { names, error: null };
}

/** generateNames over typed text: convention first, then count, then start. */
export function namingResult(value: NamingValue, max: number): { names: string[]; error: string | null } {
  const rule = parseConvention(value.convention);
  if ('error' in rule) return { names: [], error: rule.error };
  const count = toWhole(value.count);
  if (count === null) return { names: [], error: countMessage(max) };
  const start = toWhole(value.start);
  if (start === null) return { names: [], error: NAMING_MESSAGES.start_blank };
  return generateNames(value.convention, count, start, max);
}

/** The prefill: KIND-{origin code}-{destination code}-xxx, or KIND-xxx when a
 *  code is missing — or contains an x, which would add a second run. */
export function defaultConvention(
  kind: 'CRT' | 'TRK', originCode?: string | null, destinationCode?: string | null,
): string {
  const codes = [(originCode ?? '').trim(), (destinationCode ?? '').trim()];
  if (codes.every((c) => c !== '' && !/x/i.test(c))) return `${kind}-${codes[0]}-${codes[1]}-xxx`;
  return `${kind}-xxx`;
}

/** First three names, an ellipsis, and the last; every name when there are four or fewer. */
export function namesPreview(names: string[]): string {
  if (names.length <= 4) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} … ${names[names.length - 1]}`;
}

/** The API's clash_sentence, word for word. */
export function clashSentence(noun: string, names: string[], limit = 10): string {
  const more = names.length > limit ? `, and ${names.length - limit} more` : '';
  return `These ${noun} names already exist: ${names.slice(0, limit).join(', ')}${more}.`;
}
