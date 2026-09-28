/**
 * The one way to order text in the portal and kiosk: numbers inside a
 * string compare by value ("Rack 2" before "Rack 10") and case is ignored.
 * Matches the API's `natural` collation, so a server-sorted list and a
 * client re-sort agree. The guardrail in styles/naturalSort.test.ts keeps
 * every other string sort pointed here.
 */

// one collator — constructing one per comparison is measurably slow
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string | null | undefined, b: string | null | undefined): number {
  return COLLATOR.compare(a ?? '', b ?? '');
}

/** A sorted copy of `items`, by the text `key` gives for each. */
export function sortNatural<T>(items: readonly T[], key: (item: T) => string | null | undefined): T[] {
  return [...items].sort((x, y) => naturalCompare(key(x), key(y)));
}

/** For list columns whose sort value is text or a number: text compares
 *  naturally, numbers by value. Returns -1 / 0 / 1 (multiply by sortDir). */
export function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'string' && typeof b === 'string') return naturalCompare(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}
