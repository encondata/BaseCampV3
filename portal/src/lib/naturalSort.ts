/**
 * The one way to order text in the portal and kiosk: numbers inside a
 * string compare by value ("Rack 2" before "Rack 10"), case is ignored,
 * and accents are kept distinct ("Café" is not "Cafe"). That is the API's
 * `natural` collation (ICU `en-u-kn-true-ks-level2`: numeric, secondary
 * strength), so a server-sorted list and a client re-sort agree. The
 * guardrail in styles/naturalSort.test.ts keeps every other string sort
 * pointed here.
 *
 * `compareOrdinal` is the one exception: machine strings whose order is
 * their code-unit order (ISO timestamps, UUIDs) and never shown as text.
 */

// one collator — constructing one per comparison is measurably slow.
// sensitivity 'accent' = ICU secondary strength (ks-level2): case-insensitive,
// accent-sensitive, matching the API collation.
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'accent' });

export function naturalCompare(a: string | null | undefined, b: string | null | undefined): number {
  return COLLATOR.compare(a ?? '', b ?? '');
}

/** A sorted copy of `items`, by the text `key` gives for each. */
export function sortNatural<T>(items: readonly T[], key: (item: T) => string | null | undefined): T[] {
  return [...items].sort((x, y) => naturalCompare(key(x), key(y)));
}

/** Plain code-unit order, for machine strings (ISO timestamps, ids) where
 *  that IS the right order and nothing is shown to a person. Missing
 *  values compare as '' and sort first. */
export function compareOrdinal(a: string | null | undefined, b: string | null | undefined): number {
  const x = a ?? '', y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/** For list columns whose sort value is text or a number. A total order
 *  over mixed input: null/undefined first, then numbers (by value), then
 *  text (naturally). Returns -1 / 0 / 1 (multiply by sortDir). */
export function compareValues(
  a: string | number | null | undefined, b: string | number | null | undefined,
): number {
  const rank = (v: string | number | null | undefined) => (v == null ? 0 : typeof v === 'number' ? 1 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') return Math.sign(naturalCompare(a, b));
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}
