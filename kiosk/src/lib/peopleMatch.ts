/**
 * Finding a person in the kiosk's local people list.
 *
 * The timeclock takes whatever the one input box is given, because the
 * person standing at the screen should not have to tell it which kind of
 * thing they just produced: an RFID badge, an id from a printed label,
 * or their own name typed out. Two doors, then:
 *
 *  - `matchPersonExact` — a badge or an id, which identifies exactly one
 *    person, so the screen can select them without waiting for Enter.
 *    RFID keys are stored zero-stripped and upper-cased (`displayRfid`,
 *    the same rule the portal lists and `scanMatch.ts` use), so a
 *    handheld that pads the EPC and a fixed reader that doesn't both
 *    land on the same person. Ids match in full or by their first eight
 *    characters — the short form printed on badges — and the short form
 *    is only tried for something that actually looks like hex, so an
 *    eight-letter surname can never be read as somebody's id.
 *
 *  - `searchPeople` — a typed name, filtered as it is typed. Jimmy
 *    Henderson answers to "jim hen", "hen jim", "jimmy", "james
 *    henderson" and "henderson j", because a person is indexed by every
 *    part of their name (first, last, preferred, and each word of the
 *    display name) and each typed term only has to be a prefix of one of
 *    them. Each term consumes a distinct part, so "tina tina" does not
 *    match a single Tina.
 *
 * Ranking, for the list the screen shows: a name typed out in full
 * first, then the people with the fewest name parts (the shorter, more
 * exactly matched name), then alphabetically — stable enough that the
 * same query always offers the same first row to tap.
 */

import { displayRfid } from '@portal/lib/format';

/** What matching needs from a person. The kiosk's synced people rows
 *  (`KioskPersonRow`) satisfy this; so does the timeclock status
 *  endpoint's person. */
export interface MatchPerson {
  id: string;
  display_name: string;
  first_name?: string | null;
  last_name?: string | null;
  preferred_name?: string | null;
  rfid_tag?: string | null;
  is_worker?: boolean;
  has_account?: boolean;
}

interface Entry<P extends MatchPerson> {
  person: P;
  /** Lower-cased, de-duplicated: first, last, preferred, and each word
   *  of the display name. */
  parts: string[];
  /** Lower-cased whole names a query can equal outright. */
  fullNames: string[];
  sortKey: string;
}

export interface PeopleIndex<P extends MatchPerson = MatchPerson> {
  byRfid: Map<string, P>;
  /** Full id and the eight-character short id, both lower-cased. */
  byId: Map<string, P>;
  entries: Entry<P>[];
  size: number;
}

const SHORT_ID = /^[0-9a-f]{8}$/i;

function words(value: string | null | undefined): string[] {
  // Whitespace or a hyphen starts a new part, so "Smith-Jones" indexes
  // as both "smith" and "jones" (and "smith-jones" itself is never a
  // part, so nobody has to type the hyphen to find them).
  return (value ?? '').trim().toLowerCase().split(/[\s-]+/).filter(Boolean);
}

/** The RFID key: zero-padding stripped, upper-cased. A missing tag
 *  renders as an em dash through `displayRfid`, so it is dropped before
 *  it can become a key. */
function rfidKey(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  return displayRfid(value.trim()).toUpperCase() || null;
}

function entryFor<P extends MatchPerson>(person: P): Entry<P> {
  const parts: string[] = [];
  const push = (word: string) => { if (word && !parts.includes(word)) parts.push(word); };
  for (const source of [person.first_name, person.last_name, person.preferred_name]) {
    words(source).forEach(push);
  }
  words(person.display_name).forEach(push);

  const first = (person.first_name ?? '').trim().toLowerCase();
  const last = (person.last_name ?? '').trim().toLowerCase();
  const preferred = (person.preferred_name ?? '').trim().toLowerCase();
  const fullNames: string[] = [];
  const pushFull = (name: string) => {
    const collapsed = name.trim().replace(/\s+/g, ' ');
    if (collapsed && !fullNames.includes(collapsed)) fullNames.push(collapsed);
  };
  pushFull(person.display_name.toLowerCase());
  if (first && last) pushFull(`${first} ${last}`);
  if (preferred && last) pushFull(`${preferred} ${last}`);

  return { person, parts, fullNames, sortKey: person.display_name.toLowerCase() };
}

export function buildPeopleIndex<P extends MatchPerson>(people: readonly P[]): PeopleIndex<P> {
  const byRfid = new Map<string, P>();
  const byId = new Map<string, P>();
  const entries: Entry<P>[] = [];
  for (const person of people) {
    // First row wins on a duplicate key, as in `scanMatch.ts`:
    // re-registering would make the match depend on roster order.
    const tag = rfidKey(person.rfid_tag);
    if (tag && !byRfid.has(tag)) byRfid.set(tag, person);
    const id = person.id.trim().toLowerCase();
    if (id && !byId.has(id)) byId.set(id, person);
    const short = id.slice(0, 8);
    if (short.length === 8 && !byId.has(short)) byId.set(short, person);
    entries.push(entryFor(person));
  }
  return { byRfid, byId, entries, size: people.length };
}

/** The badge/id door: a value that names exactly one person, or null. */
export function matchPersonExact<P extends MatchPerson>(
  index: PeopleIndex<P>, raw: string,
): P | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const tag = rfidKey(trimmed);
  const byTag = tag ? index.byRfid.get(tag) : undefined;
  if (byTag) return byTag;
  const lower = trimmed.toLowerCase();
  const byFullId = index.byId.get(lower);
  // A full id is unambiguous; the eight-character short form is only
  // honored when the value actually looks like one, so a typed name
  // never resolves to somebody's id by coincidence.
  if (byFullId && (lower.length !== 8 || SHORT_ID.test(lower))) return byFullId;
  return null;
}

/** True when `raw` names one person outright by RFID tag but is *also*
 *  a strict prefix of a different person's (longer) tag — "1003" vs
 *  "100348". A fixed reader appends digits one at a time, so mid-scan
 *  the shorter tag can briefly look like a complete, exact match; the
 *  caller should hold off on auto-selecting until Enter (or the rest of
 *  the scan) settles which one was meant. Exact-length equality is
 *  never ambiguous — only a genuine prefix relationship is. */
export function isAmbiguousPrefix<P extends MatchPerson>(
  index: PeopleIndex<P>, raw: string,
): boolean {
  const tag = rfidKey(raw.trim());
  if (!tag || !index.byRfid.has(tag)) return false;
  for (const other of index.byRfid.keys()) {
    if (other !== tag && other.startsWith(tag)) return true;
  }
  return false;
}

/** Every term is a prefix of a distinct part — a small bipartite match,
 *  brute-forced because both sides are a handful of words. */
function assign(terms: readonly string[], parts: readonly string[]): boolean {
  if (terms.length > parts.length) return false;
  const used = parts.map(() => false);
  const go = (i: number): boolean => {
    if (i === terms.length) return true;
    for (let j = 0; j < parts.length; j += 1) {
      if (used[j] || !parts[j].startsWith(terms[i])) continue;
      used[j] = true;
      if (go(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return go(0);
}

/** The typed-name door: the people worth offering as tappable rows. */
export function searchPeople<P extends MatchPerson>(
  index: PeopleIndex<P>, query: string, limit = 8,
): P[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const typed = terms.join(' ');
  return index.entries
    .filter((entry) => assign(terms, entry.parts))
    .map((entry) => ({ entry, exact: entry.fullNames.includes(typed) ? 0 : 1 }))
    .sort((a, b) => a.exact - b.exact
      || a.entry.parts.length - b.entry.parts.length
      || a.entry.sortKey.localeCompare(b.entry.sortKey))
    .slice(0, limit)
    .map((hit) => hit.entry.person);
}
