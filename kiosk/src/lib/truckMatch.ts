/**
 * The kiosk's local copy of the move's trucks, and the two things the
 * Trucks screen's first step does with it: narrow the card list as
 * someone types, and select outright when what they typed is exactly a
 * truck.
 *
 * This is deliberately NOT `containerMatch.ts`. A crate carries an RFID
 * tag and a printed label key, so the Containers screen can open on a
 * scan box and let the reader decide. **A truck carries neither** —
 * `trucks` has no `rfid_tag` column and there is nothing on a trailer to
 * read — and a move has a handful of them, not hundreds. So step one is a
 * card picker, and this module is its filter, not a match index for a
 * scanner.
 *
 * `matchTruck` still exists for the one keyboard case: typing a full name
 * or load number and pressing Enter should select that truck instead of
 * leaving a one-card list to tap. It is EXACT (case-insensitive, trimmed)
 * for the same reason `matchContainer` is — `TRUCK-1` is a prefix of
 * `TRUCK-10`, and guessing between them would put a crate on the wrong
 * trailer. Name beats load number when a string is somehow both: the name
 * is what is painted on the door.
 */

export interface TruckRow {
  id: string;
  name: string;
  load_number: string | null;
  status: string;
  status_label: string;
  driver_name: string | null;
  start_site_id: string | null;
  start_site_name: string | null;
  end_site_id: string | null;
  end_site_name: string | null;
  container_count: number;
}

export type TruckMatchKind = 'name' | 'load_number';

export interface TruckMatch {
  kind: TruckMatchKind;
  truck: TruckRow;
}

export interface TruckIndex {
  byName: Map<string, TruckRow>;
  byLoadNumber: Map<string, TruckRow>;
  rows: TruckRow[];
}

function key(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toUpperCase();
  return trimmed || null;
}

export function buildTruckIndex(rows: readonly TruckRow[]): TruckIndex {
  const byName = new Map<string, TruckRow>();
  const byLoadNumber = new Map<string, TruckRow>();
  for (const row of rows) {
    // First row wins a duplicate key, the same rule `containerMatch.ts`
    // and `scanMatch.ts` use: re-registering would make the match depend
    // on sync order in a way nothing else does. Truck names are CITEXT in
    // the database but not unique, and load numbers are free text.
    const n = key(row.name);
    if (n && !byName.has(n)) byName.set(n, row);
    const l = key(row.load_number);
    if (l && !byLoadNumber.has(l)) byLoadNumber.set(l, row);
  }
  return { byName, byLoadNumber, rows: [...rows] };
}

/** An EXACT name or load number, or null. A partial is not a match —
 *  `filterTrucks` is what a partial is for. */
export function matchTruck(index: TruckIndex, raw: string): TruckMatch | null {
  const plain = key(raw);
  if (!plain) return null;
  const byName = index.byName.get(plain);
  if (byName) return { kind: 'name', truck: byName };
  const byLoad = index.byLoadNumber.get(plain);
  if (byLoad) return { kind: 'load_number', truck: byLoad };
  return null;
}

/** The trucks whose name or load number contains `raw`, in sync order (by
 *  name, as the server sends them). An empty term is every truck: the
 *  filter is a convenience over a short list, not a gate in front of it. */
export function filterTrucks(index: TruckIndex, raw: string): TruckRow[] {
  const term = key(raw);
  if (!term) return [...index.rows];
  return index.rows.filter((row) => (row.name ?? '').toUpperCase().includes(term)
    || (row.load_number ?? '').toUpperCase().includes(term));
}
