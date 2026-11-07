/** Seed Data › DB: pick a recipe and a ready snapshot, tick the rows the
 *  recipe keeps table by table, and save it. The snapshot is opened in the
 *  scratch database first (polled every 2 s while it restores). After each
 *  change the selection is resolved (debounced) and the rows it needs are
 *  listed under "Added because they're needed". */
import { useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';
import DataTable from '@portal/components/DataTable';
import { Switch } from '@portal/components/Switch';

import { snapshotLabel } from '../environments/labels';

import RowTable, { type CheckRow } from './RowTable';
import {
  createRecipe, getKeys, getRecipe, getRows, listRecipes, listTables, notOpen, putRecipe,
  resolveSelection, seedErrorText,
  type KeyFilter, type RecipeSummary, type Resolved, type RowsPage, type SeedTable,
} from './seedApi';
import {
  fromRecipe, pkKey, setAll, setMany, toBody, toggle, type PkObject, type Selection,
} from './selection';
import { useScratchSnapshot } from './useScratchSnapshot';

/** A change to the selection is resolved once it has been still this long. */
export const RESOLVE_DEBOUNCE_MS = 300;
const FILTER_DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

const pkText = (pk: PkObject) => Object.values(pk).join(', ');
const cellText = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : String(v));

export function reasonLine(r: Resolved['reasons'][number]): string {
  const by = r.needed_by_label === null ? r.needed_by_table : `${r.needed_by_table} row for ${r.needed_by_label}`;
  return `${r.table}: ${r.label}, needed by ${by}`;
}

export default function SeedDb() {
  const { can } = useAuth();

  // recipe
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [recipeId, setRecipeId] = useState('');
  const [name, setName] = useState('');
  const [sel, setSel] = useState<Selection>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [tables, setTables] = useState<SeedTable[] | null>(null);

  // the table on show
  const [current, setCurrent] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [filterCol, setFilterCol] = useState('');
  const [filter, setFilter] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');
  const [rows, setRows] = useState<RowsPage | null>(null);
  const [busy, setBusy] = useState(false);

  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    listRecipes().then(setRecipes).catch((e) => setError(seedErrorText(e, "Couldn't load recipes.")));
  }, []);

  // ---- opening the snapshot ------------------------------------------------
  const { snapshots, snapId, phase, pickSnapshot: pickSnap, reopen, isCurrent } = useScratchSnapshot(setError);
  const pickSnapshot = (id: string) => {
    setTables(null); setRows(null); setResolved(null); setError('');
    pickSnap(id);
  };

  useEffect(() => {
    if (phase !== 'ready' || !snapId) return;
    const id = snapId;
    listTables(id)
      .then((ts) => {
        if (!isCurrent(id)) return;
        setTables(ts);
        setCurrent((cur) => (ts.some((t) => t.table === cur) ? cur : ts[0]?.table ?? ''));
      })
      .catch((e) => { if (notOpen(e)) reopen(); else setError(seedErrorText(e, "Couldn't load the tables.")); });
  }, [phase, snapId, reopen, isCurrent]);

  // ---- rows of the table on show --------------------------------------------
  useEffect(() => {
    const t = setTimeout(() => { setAppliedFilter(filter); setPage(1); }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filter]);

  const pickTable = (t: string) => {
    setCurrent(t); setPage(1); setSort(''); setDir('asc'); setFilter(''); setAppliedFilter(''); setFilterCol('');
    setRows(null);
  };

  const rowsSeq = useRef(0);
  // the column matters only once there's text to look for
  const queryCol = appliedFilter ? filterCol : '';
  useEffect(() => {
    if (phase !== 'ready' || !snapId || !current) return;
    const n = ++rowsSeq.current;
    setBusy(true);
    getRows(snapId, current, {
      page, size: PAGE_SIZE, sort: sort || undefined, dir, filter_col: queryCol, filter: appliedFilter,
    })
      .then((r) => { if (n === rowsSeq.current) { setRows(r); setError(''); } })
      .catch((e) => {
        if (n !== rowsSeq.current) return;
        if (notOpen(e)) reopen(); else setError(seedErrorText(e, "Couldn't load the rows."));
      })
      .finally(() => { if (n === rowsSeq.current) setBusy(false); });
  }, [phase, snapId, current, page, sort, dir, queryCol, appliedFilter, reopen]);

  // the filter column defaults to the table's first column
  useEffect(() => {
    if (rows && !rows.columns.some((c) => c.name === filterCol)) setFilterCol(rows.columns[0]?.name ?? '');
  }, [rows, filterCol]);

  // ---- resolving the selection ------------------------------------------------
  const resolveSeq = useRef(0);
  useEffect(() => {
    if (phase !== 'ready' || !snapId) return undefined;
    const n = ++resolveSeq.current;
    const id = snapId;
    const timer = setTimeout(() => {
      const body = toBody(sel);
      if (Object.keys(body).length === 0) { setResolved(null); return; }
      resolveSelection(id, body)
        .then((r) => { if (n === resolveSeq.current) { setResolved(r); setError(''); } })
        .catch((e) => {
          if (n !== resolveSeq.current) return;
          if (notOpen(e)) reopen(); else setError(seedErrorText(e, "Couldn't work out the rows this selection needs."));
        });
    }, RESOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sel, phase, snapId, reopen]);

  // ---- recipes -------------------------------------------------------------------
  const recipeSeq = useRef(0);
  const pickRecipe = (id: string) => {
    const n = ++recipeSeq.current;
    setSaved(false); setError('');
    if (!id) { setRecipeId(''); setName(''); setSel({}); return; }
    getRecipe(id)
      .then((r) => {
        if (n !== recipeSeq.current) return;
        setRecipeId(r.id); setName(r.name); setSel(fromRecipe(r.tables));
      })
      .catch((e) => { if (n === recipeSeq.current) setError(seedErrorText(e, "Couldn't load that recipe.")); });
  };
  const newRecipe = () => {
    ++recipeSeq.current;
    setRecipeId(''); setName(''); setSel({}); setSaved(false); setError('');
  };
  const save = async () => {
    const clean = name.trim();
    if (!clean) { setError('Enter a recipe name.'); return; }
    setSaving(true); setSaved(false); setError('');
    try {
      // PUT replaces the recipe: re-read it so its files go back as saved
      // now, not as they were when it was picked (the Spaces page may have
      // saved since)
      const base = recipeId ? await getRecipe(recipeId) : await createRecipe(clean);
      setRecipeId(base.id);
      const r = await putRecipe(base.id, { name: clean, tables: toBody(sel), files: base.files });
      setName(r.name);
      setSaved(true);
      listRecipes().then(setRecipes).catch(() => {});
    } catch (e) {
      setError(seedErrorText(e, "Couldn't save the recipe."));
    } finally {
      setSaving(false);
    }
  };

  // ---- the table on show: its state -------------------------------------------------
  const table = tables?.find((t) => t.table === current) ?? null;
  const noPk = table !== null && table.pk === null;
  const tsel = sel[current];
  const allRows = tsel?.mode === 'all';
  const added = useMemo(() => new Set((resolved?.added[current] ?? []).map(pkKey)), [resolved, current]);
  const wholeAdded = !!resolved?.added_tables.some((a) => a.table === current);
  const shownFilter = appliedFilter.trim();
  const activeFilter: KeyFilter = filterCol && shownFilter
    ? { filter_col: filterCol, filter: shownFilter } : { filter_col: '', filter: '' };
  /** Bumped by Check all / Deselect all: a fresh RowTable forgets its shift-click anchor. */
  const [anchorReset, setAnchorReset] = useState(0);

  const checkMany = async (on: boolean) => {
    if (!snapId || !current) return;
    setError('');
    try {
      const r = await getKeys(snapId, current, activeFilter);
      setSel((s) => setMany(s, current, r.pks.map(pkKey), on));
      setAnchorReset((x) => x + 1);
    } catch (e) {
      if (notOpen(e)) reopen(); else setError(seedErrorText(e, "Couldn't load the matching rows."));
    }
  };

  const sortBy = (col: string) => {
    if (sort === col) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(col); setDir('asc'); }
    setPage(1);
  };

  const pkCols = new Set(table?.pk ?? []);
  const checkRows: CheckRow[] = (rows?.rows ?? []).map((r, i) => {
    const key = r.pk ? pkKey(r.pk) : `row:${page}:${i}`;
    const mine = !!r.pk && !!tsel?.pks.has(key);
    const needed = wholeAdded || (!!r.pk && added.has(key));
    const firstText = rows!.columns.find((c) => !pkCols.has(c.name) && r.values[c.name] !== null);
    return {
      key,
      checked: allRows || mine || needed,
      disabled: noPk || allRows || (needed && !mine),
      title: needed && !mine ? 'Needed by a kept row' : undefined,
      label: firstText ? cellText(r.values[firstText.name]) : r.pk ? pkText(r.pk) : String(i + 1),
      cells: rows!.columns.map((c) => cellText(r.values[c.name])),
    };
  });

  const total = rows?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, page * PAGE_SIZE);

  const missingLines = resolved ? [
    ...resolved.missing_tables.map((t) => `${t}: the table isn't in this snapshot`),
    ...Object.entries(resolved.missing).flatMap(([t, pks]) => pks.map((pk) => `${t}: ${pkText(pk)}`)),
  ] : [];
  const addedLines = resolved ? [
    ...resolved.reasons.map(reasonLine),
    ...resolved.added_tables.map((a) => `Added whole table ${a.table}, needed by ${a.needed_by_table}`),
  ] : [];

  // a new recipe is created, then filled with a PUT: it takes both
  /** Rows kept in a table: ticked by hand plus those resolve added (all
   *  of them for an All rows table or a whole table resolve added). */
  const keptCount = (t: SeedTable) => {
    if (sel[t.table]?.mode === 'all' || resolved?.added_tables.some((a) => a.table === t.table)) return t.rows;
    const kept = new Set(sel[t.table]?.pks ?? []);
    (resolved?.added[t.table] ?? []).forEach((pk) => kept.add(pkKey(pk)));
    return Math.min(kept.size, t.rows);
  };
  const canSave = recipeId ? can('seed_data', 'change') : can('seed_data', 'add') && can('seed_data', 'change');

  return (
    <div className="portal-page sirdar-seed">
      <div className="eyebrow">Seed Data</div>
      <div className="dir-head">
        <h1>DB</h1>
        <p>Tick the rows a recipe keeps, table by table. The rows they need are added for you.</p>
      </div>

      <section className="sirdar-flow pf-form sirdar-seed-bar" aria-label="Recipe and snapshot">
        <div>
          <label htmlFor="seed-recipe">Recipe</label>
          <ComboBox inputId="seed-recipe" ariaLabel="Recipe" value={recipeId} placeholder="Choose a recipe…"
                    options={recipes.map((r) => ({ value: r.id, label: r.name }))} onChange={pickRecipe} />
        </div>
        <div>
          <label htmlFor="seed-recipe-name">Recipe name</label>
          <input id="seed-recipe-name" type="text" value={name} autoComplete="off" spellCheck={false}
                 onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        </div>
        <div>
          <label htmlFor="seed-snapshot">Snapshot</label>
          <ComboBox inputId="seed-snapshot" ariaLabel="Snapshot" value={snapId} placeholder="Choose a snapshot…"
                    options={snapshots.map((s) => ({ value: s.id, label: snapshotLabel(s) }))} onChange={pickSnapshot} />
        </div>
        <div className="pf-form-actions">
          {can('seed_data', 'add') && (
            <button type="button" className="btn-ghost" onClick={newRecipe}>New recipe</button>
          )}
          <button type="button" className="btn-solid" onClick={() => void save()} disabled={saving || !canSave}>
            {saving ? 'Saving…' : 'Save recipe'}
          </button>
          {saved && <span className="page-hint" role="status">Saved.</span>}
        </div>
      </section>

      {error && <p className="form-error" role="alert">{error}</p>}
      {phase === 'idle' && <p className="page-hint">Choose a snapshot to browse its tables.</p>}
      {phase === 'opening' && <p className="page-hint" role="status">Opening the snapshot…</p>}

      {phase === 'ready' && tables && (
        <div className="sirdar-seed-cols">
          <DataTable
            ariaLabel="Tables"
            columns={[{ key: 'table', label: 'Table' }, { key: 'n', label: 'Ticked', align: 'right', mono: true }]}
            rows={tables.map((t) => ({
              key: t.table,
              selected: t.table === current,
              onClick: () => pickTable(t.table),
              cells: [
                <button type="button" className="sirdar-seed-pick" onClick={(e) => { e.stopPropagation(); pickTable(t.table); }}>
                  {t.table}
                </button>,
                `${keptCount(t).toLocaleString()} / ${t.rows.toLocaleString()}`,
              ],
            }))}
            emptyText="This snapshot has no tables."
          />

          {table && (
            <section className="sirdar-seed-table" aria-labelledby="seed-table-title">
              <div className="sirdar-section-head">
                <h2 id="seed-table-title">{table.table}</h2>
                <div className="sirdar-target-actions">
                  <button type="button" className="mini-btn" disabled={noPk || allRows}
                          onClick={() => void checkMany(true)}>Check all</button>
                  <button type="button" className="mini-btn" disabled={noPk || allRows}
                          onClick={() => void checkMany(false)}>Deselect all</button>
                  <span className="sirdar-switch-row">
                    <Switch checked={allRows} label="All rows"
                            onChange={(on) => setSel((s) => setAll(s, current, on))} />
                    <span aria-hidden="true">All rows</span>
                  </span>
                </div>
              </div>
              {noPk ? (
                <p className="page-hint">
                  This table has no primary key, so its rows can't be ticked one by one: keep All rows or none.
                </p>
              ) : (
                <p className="page-hint">Shift-click a second row to tick or untick everything between.</p>
              )}

              <div className="dir-toolbar">
                <ComboBox ariaLabel="Filter column" value={filterCol}
                          options={(rows?.columns ?? []).map((c) => ({ value: c.name, label: c.name }))}
                          onChange={(v) => { setFilterCol(v); setPage(1); }} />
                <div className="dir-search">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
                  </svg>
                  <input type="search" aria-label="Filter" placeholder="Filter" value={filter}
                         onChange={(e) => setFilter(e.target.value)} />
                </div>
              </div>

              <RowTable
                key={`${current}|${sort}|${dir}|${shownFilter}|${anchorReset}`}
                ariaLabel={`Rows of ${table.table}`}
                columns={(rows?.columns ?? []).map((c) => ({
                  key: c.name,
                  label: (
                    <button type="button" className="sortable" onClick={() => sortBy(c.name)}
                            aria-label={`Sort by ${c.name}`}>
                      {c.name}{sort === c.name && <span className="caret">{dir === 'asc' ? '▲' : '▼'}</span>}
                    </button>
                  ),
                }))}
                rows={checkRows}
                onToggle={(k, on) => setSel((s) => toggle(s, current, k, on))}
                onRange={(ks, on) => setSel((s) => setMany(s, current, ks, on))}
                emptyText={rows === null ? 'Loading…' : 'No rows match.'}
              />

              <div className="sirdar-seed-pager">
                <span className="page-hint">
                  {total === 0 ? 'No rows' : `Rows ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
                </span>
                {pages > 1 && (
                  <>
                    <button type="button" className="mini-btn" disabled={busy || page <= 1}
                            onClick={() => setPage((p) => p - 1)}>Previous</button>
                    <button type="button" className="mini-btn" disabled={busy || page >= pages}
                            onClick={() => setPage((p) => p + 1)}>Next</button>
                  </>
                )}
              </div>
            </section>
          )}
        </div>
      )}

      {phase === 'ready' && addedLines.length > 0 && (
        <div className="sirdar-card sirdar-seed-added">
          <h3>Added because they're needed</h3>
          <ul className="sirdar-plain-list">{addedLines.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
      )}
      {phase === 'ready' && missingLines.length > 0 && (
        <div className="sirdar-card sirdar-seed-added">
          <h3>Not in this snapshot</h3>
          <ul className="sirdar-plain-list">{missingLines.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
