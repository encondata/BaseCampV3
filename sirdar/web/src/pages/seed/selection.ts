/** A Seed Data selection: per table, the rows ticked by hand (by primary
 *  key) or All rows. Pure functions; each returns a new selection and
 *  leaves its input alone. A pk string is JSON.stringify of the pk object
 *  with its keys sorted, so the same row always gives the same string. */

export type PkObject = Record<string, string>;
export type TableSelection = { mode: 'rows' | 'all'; pks: Set<string> };
export type Selection = { [table: string]: TableSelection };
/** The API's shape (recipes and resolve): pk objects in a list. */
export type SelectionBody = Record<string, { mode: 'rows' | 'all'; pks: PkObject[] }>;

export function pkKey(pk: PkObject): string {
  const sorted: PkObject = {};
  Object.keys(pk).sort().forEach((k) => { sorted[k] = pk[k]; });
  return JSON.stringify(sorted);
}

export const pkObject = (key: string): PkObject => JSON.parse(key) as PkObject;

const current = (sel: Selection, table: string): TableSelection =>
  sel[table] ?? { mode: 'rows', pks: new Set<string>() };

export function setMany(sel: Selection, table: string, pks: Iterable<string>, on: boolean): Selection {
  const t = current(sel, table);
  const next = new Set(t.pks);
  for (const pk of pks) {
    if (on) next.add(pk); else next.delete(pk);
  }
  return { ...sel, [table]: { mode: t.mode, pks: next } };
}

export const toggle = (sel: Selection, table: string, pk: string, on: boolean): Selection =>
  setMany(sel, table, [pk], on);

/** Every row from fromIdx to toIdx (either order, both included) of
 *  `orderedPks` takes the state `on`. */
export function range(sel: Selection, table: string, orderedPks: string[], fromIdx: number, toIdx: number,
                      on: boolean): Selection {
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  return setMany(sel, table, orderedPks.slice(lo, hi + 1), on);
}

/** All rows on (mode 'all') or off (back to the rows ticked by hand). */
export function setAll(sel: Selection, table: string, on: boolean): Selection {
  const t = current(sel, table);
  return { ...sel, [table]: { mode: on ? 'all' : 'rows', pks: new Set(t.pks) } };
}

/** How many of a table's `total` rows the selection keeps. */
export function tickedCount(sel: Selection, table: string, total: number): number {
  const t = sel[table];
  if (!t) return 0;
  return t.mode === 'all' ? total : t.pks.size;
}

export function fromRecipe(tables: SelectionBody): Selection {
  const out: Selection = {};
  Object.entries(tables).forEach(([name, t]) => {
    out[name] = { mode: t.mode, pks: new Set(t.pks.map(pkKey)) };
  });
  return out;
}

/** The API body: tables with nothing kept are left out; an All rows table
 *  sends no keys. */
export function toBody(sel: Selection): SelectionBody {
  const out: SelectionBody = {};
  Object.keys(sel).sort().forEach((name) => {
    const t = sel[name];
    if (t.mode === 'all') out[name] = { mode: 'all', pks: [] };
    else if (t.pks.size) out[name] = { mode: 'rows', pks: [...t.pks].sort().map(pkObject) };
  });
  return out;
}
