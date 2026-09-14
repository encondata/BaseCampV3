/**
 * Matching a scanned string against the kiosk's local copy of the move's
 * containers — the Containers screen's first step.
 *
 * A crate can be identified three ways, and the person at the kiosk
 * should not have to say which they just used, so one box takes all of
 * them and `matchContainer` tries them in the order a scan is most
 * likely to be: RFID first (the readers), then the label tag (the
 * Container Labels keys printed on a crate), then the name (typed, or
 * read off a barcode).
 *
 * RFID keys are stored with their leading zeros stripped — the same
 * `displayRfid` rule `scanMatch.ts` uses and the portal's lists show —
 * because a handheld reading a tag may or may not include the EPC's
 * padding. Everything is upper-cased, so case never decides a match;
 * container names are CITEXT in the database, so case-insensitive here
 * is the same rule the portal enforces.
 *
 * A name match is EXACT. A partial is not a match — several crates on a
 * move share a prefix (`SC-DAL_PAL-001`, `-002`, …) and picking one of
 * them for the operator would be a guess about which crate is in front
 * of them. `searchContainers` exists for that case instead: the screen
 * shows the short list and they tap the right one, exactly as the
 * Timeclock screen does with names.
 */

import { displayRfid } from '@portal/lib/format';

export interface ContainerRow {
  id: string;
  name: string;
  rfid_tag: string | null;
  label_tag: string | null;
  container_type: string | null;
  status: string;
  status_label: string;
  site_id: string | null;
  site_name: string | null;
  asset_count: number;
}

export type ContainerMatchKind = 'rfid' | 'label_tag' | 'name';

export interface ContainerMatch {
  kind: ContainerMatchKind;
  container: ContainerRow;
}

export interface ContainerIndex {
  byRfid: Map<string, ContainerRow>;
  byLabelTag: Map<string, ContainerRow>;
  byName: Map<string, ContainerRow>;
  rows: ContainerRow[];
}

function key(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toUpperCase();
  return trimmed || null;
}

/** The RFID key: zero-padding stripped, upper-cased. `displayRfid`
 *  renders a missing tag as an em dash, so an absent tag is filtered out
 *  before it can become a key that matches "—". */
function rfidKey(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  return key(displayRfid(value.trim()));
}

export function buildContainerIndex(rows: readonly ContainerRow[]): ContainerIndex {
  const byRfid = new Map<string, ContainerRow>();
  const byLabelTag = new Map<string, ContainerRow>();
  const byName = new Map<string, ContainerRow>();
  for (const row of rows) {
    // First row wins on a duplicate key, the same rule `scanMatch.ts`
    // uses: re-registering would make the match depend on sync order in
    // a way nothing else does. It matters most for `label_tag`, which is
    // one of five shared keys and NOT unique — several crates on a move
    // can carry "priority". A label tag is therefore a weak identifier
    // and a name or a tag should be preferred where there is one.
    const r = rfidKey(row.rfid_tag);
    if (r && !byRfid.has(r)) byRfid.set(r, row);
    const t = key(row.label_tag);
    if (t && !byLabelTag.has(t)) byLabelTag.set(t, row);
    const n = key(row.name);
    if (n && !byName.has(n)) byName.set(n, row);
  }
  return { byRfid, byLabelTag, byName, rows: [...rows] };
}

export function matchContainer(index: ContainerIndex, raw: string): ContainerMatch | null {
  const plain = key(raw);
  if (!plain) return null;
  const tag = rfidKey(raw);
  const byTag = tag ? index.byRfid.get(tag) : undefined;
  if (byTag) return { kind: 'rfid', container: byTag };
  const byLabel = index.byLabelTag.get(plain);
  if (byLabel) return { kind: 'label_tag', container: byLabel };
  const byName = index.byName.get(plain);
  if (byName) return { kind: 'name', container: byName };
  return null;
}

/** Containers whose name contains `raw`, for the tappable list the
 *  screen shows when a typed partial is ambiguous. Name only: a partial
 *  RFID read is a misread, not a search term. */
export function searchContainers(
  index: ContainerIndex, raw: string, limit: number,
): ContainerRow[] {
  const term = key(raw);
  if (!term) return [];
  return index.rows
    .filter((row) => (row.name ?? '').toUpperCase().includes(term))
    .slice(0, limit);
}
