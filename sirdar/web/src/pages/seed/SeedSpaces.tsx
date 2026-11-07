/** Seed Data › Spaces: pick a recipe and a ready snapshot, see which of the
 *  snapshot's files the recipe keeps and why, tick or untick any of them by
 *  hand, and save the recipe. A file is "referenced" when a kept row holds
 *  its key; a manual change is stored only where it differs from that
 *  (untick a referenced file → false, tick an unreferenced one → true), and
 *  putting a file back the way its references have it drops the change. */
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';

import { formatBytes, snapshotLabel } from '../environments/labels';

import RowTable, { type CheckRow } from './RowTable';
import {
  getRecipe, listFiles, listRecipes, notOpen, putRecipe, seedErrorText,
  type FilesPage, type RecipeSummary, type SeedFile,
} from './seedApi';
import type { SelectionBody } from './selection';
import { useScratchSnapshot } from './useScratchSnapshot';

const FILTER_DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;
/** Check all / Deselect all page through every matching file this many at a time (the API's largest page). */
const KEYS_PAGE_SIZE = 1000;

// the API's "Kept because" texts that name no reference
const TICKED = 'Ticked by hand';
const UNTICKED = 'Unticked by hand';
const NONE = '—';

type Overrides = Record<string, boolean>;

/** What references the file in the saved recipe's kept rows ("Avatar of
 *  Person A (people)"), or null when nothing does. */
export function referenceOf(f: SeedFile): string | null {
  if (f.because === NONE || f.because === TICKED) return null;
  const prefix = `${UNTICKED} (`;
  if (f.because.startsWith(prefix) && f.because.endsWith(')')) return f.because.slice(prefix.length, -1);
  return f.because;
}

export const keptNow = (ref: string | null, override: boolean | undefined) =>
  override === undefined ? ref !== null : override;

/** The "Kept because" text for a file with this reference and manual change. */
export function becauseNow(ref: string | null, override: boolean | undefined): string {
  if (ref !== null) return override === false ? `${UNTICKED} (${ref})` : ref;
  return override === true ? TICKED : NONE;
}

/** Give each file the state `on`: a manual change where that differs
 *  from its references, none where it matches them. */
export function setKept(files: Overrides, targets: { key: string; referenced: boolean }[], on: boolean): Overrides {
  const next = { ...files };
  targets.forEach(({ key, referenced }) => {
    if (on === referenced) delete next[key]; else next[key] = on;
  });
  return next;
}

export default function SeedSpaces() {
  const { can } = useAuth();
  const [error, setError] = useState('');

  // recipe
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [recipeId, setRecipeId] = useState('');
  const [name, setName] = useState('');
  const [tables, setTables] = useState<SelectionBody>({});
  const [files, setFiles] = useState<Overrides>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // snapshot
  const { snapshots, snapId, phase, pickSnapshot: pickSnap, reopen } = useScratchSnapshot(setError);

  // the files on show
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');
  const [listing, setListing] = useState<FilesPage | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped by Check all / Deselect all: a fresh RowTable forgets its shift-click anchor. */
  const [anchorReset, setAnchorReset] = useState(0);

  useEffect(() => {
    listRecipes().then(setRecipes).catch((e) => setError(seedErrorText(e, "Couldn't load recipes.")));
  }, []);

  const pickSnapshot = (id: string) => {
    setListing(null); setPage(1); setError('');
    pickSnap(id);
  };

  const pickRecipe = (id: string) => {
    setSaved(false); setError(''); setListing(null); setPage(1);
    if (!id) { setRecipeId(''); setName(''); setTables({}); setFiles({}); return; }
    getRecipe(id)
      .then((r) => { setRecipeId(r.id); setName(r.name); setTables(r.tables); setFiles(r.files); })
      .catch((e) => setError(seedErrorText(e, "Couldn't load that recipe.")));
  };

  useEffect(() => {
    const t = setTimeout(() => { setAppliedFilter(filter); setPage(1); }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filter]);
  const shownFilter = appliedFilter.trim();

  const seq = useRef(0);
  useEffect(() => {
    if (phase !== 'ready' || !snapId || !recipeId) return;
    const n = ++seq.current;
    setBusy(true);
    listFiles(snapId, recipeId, { page, size: PAGE_SIZE, filter: shownFilter })
      .then((r) => { if (n === seq.current) { setListing(r); setError(''); } })
      .catch((e) => {
        if (n !== seq.current) return;
        if (notOpen(e)) reopen(); else setError(seedErrorText(e, "Couldn't load the files."));
      })
      .finally(() => { if (n === seq.current) setBusy(false); });
  }, [phase, snapId, recipeId, page, shownFilter, reopen]);

  const change = (next: (f: Overrides) => Overrides) => { setFiles(next); setSaved(false); };

  const shown = (listing?.files ?? []).map((f) => ({ file: f, ref: referenceOf(f) }));
  const refByKey = new Map(shown.map(({ file, ref }) => [file.key, ref !== null]));
  const targets = (keys: string[]) => keys.map((key) => ({ key, referenced: !!refByKey.get(key) }));

  const checkMany = async (on: boolean) => {
    if (!snapId || !recipeId) return;
    setError('');
    try {
      const all: { key: string; referenced: boolean }[] = [];
      for (let p = 1; ; p += 1) {
        const r = await listFiles(snapId, recipeId, { page: p, size: KEYS_PAGE_SIZE, filter: shownFilter });
        r.files.forEach((f) => all.push({ key: f.key, referenced: referenceOf(f) !== null }));
        if (r.files.length < KEYS_PAGE_SIZE || all.length >= r.total) break;
      }
      change((f) => setKept(f, all, on));
      setAnchorReset((x) => x + 1);
    } catch (e) {
      if (notOpen(e)) reopen(); else setError(seedErrorText(e, "Couldn't load the matching files."));
    }
  };

  const save = async () => {
    if (!recipeId) return;
    setSaving(true); setSaved(false); setError('');
    try {
      // PUT replaces the recipe: its tables go back unchanged
      const r = await putRecipe(recipeId, { name, tables, files });
      setName(r.name);
      setSaved(true);
      listRecipes().then(setRecipes).catch(() => {});
    } catch (e) {
      setError(seedErrorText(e, "Couldn't save the recipe."));
    } finally {
      setSaving(false);
    }
  };

  const checkRows: CheckRow[] = shown.map(({ file, ref }) => {
    const override = files[file.key];
    return {
      key: file.key,
      checked: keptNow(ref, override),
      label: file.key,
      cells: [
        <span title={file.key}>{file.key}</span>,
        formatBytes(file.size),
        becauseNow(ref, override),
      ],
    };
  });

  const total = listing?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, page * PAGE_SIZE);
  const canSave = !!recipeId && can('seed_data', 'change');
  const ready = phase === 'ready' && !!recipeId;

  return (
    <div className="portal-page sirdar-seed">
      <div className="eyebrow">Seed Data</div>
      <div className="dir-head">
        <h1>Spaces</h1>
        <p>Files follow the rows a recipe keeps. Tick or untick any file by hand.</p>
      </div>

      <section className="sirdar-flow pf-form sirdar-seed-bar" aria-label="Recipe and snapshot">
        <div>
          <label htmlFor="seed-recipe">Recipe</label>
          <ComboBox inputId="seed-recipe" ariaLabel="Recipe" value={recipeId} placeholder="Choose a recipe…"
                    options={recipes.map((r) => ({ value: r.id, label: r.name }))} onChange={pickRecipe} />
        </div>
        <div>
          <label htmlFor="seed-snapshot">Snapshot</label>
          <ComboBox inputId="seed-snapshot" ariaLabel="Snapshot" value={snapId} placeholder="Choose a snapshot…"
                    options={snapshots.map((s) => ({ value: s.id, label: snapshotLabel(s) }))} onChange={pickSnapshot} />
        </div>
        <div className="pf-form-actions">
          <button type="button" className="btn-solid" onClick={() => void save()} disabled={saving || !canSave}>
            {saving ? 'Saving…' : 'Save recipe'}
          </button>
          {saved && <span className="page-hint" role="status">Saved.</span>}
        </div>
      </section>

      {error && <p className="form-error" role="alert">{error}</p>}
      {(!recipeId || phase === 'idle') && (
        <p className="page-hint">Choose a recipe and a snapshot to list the snapshot's files.</p>
      )}
      {recipeId && phase === 'opening' && <p className="page-hint" role="status">Opening the snapshot…</p>}

      {ready && (
        <section className="sirdar-seed-table" aria-label="Files">
          <div className="dir-toolbar">
            <div className="dir-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
              </svg>
              <input type="search" aria-label="Filter" placeholder="Filter" value={filter}
                     onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="sirdar-target-actions">
              <button type="button" className="mini-btn" onClick={() => void checkMany(true)}>Check all</button>
              <button type="button" className="mini-btn" onClick={() => void checkMany(false)}>Deselect all</button>
            </div>
          </div>
          <p className="page-hint">Shift-click a second file to tick or untick everything between.</p>

          <RowTable
            key={`${recipeId}|${snapId}|${shownFilter}|${anchorReset}`}
            ariaLabel="Files"
            columns={[
              { key: 'file', label: 'File' },
              { key: 'size', label: 'Size', align: 'right', mono: true },
              { key: 'because', label: 'Kept because' },
            ]}
            rows={checkRows}
            onToggle={(k, on) => change((f) => setKept(f, targets([k]), on))}
            onRange={(ks, on) => change((f) => setKept(f, targets(ks), on))}
            emptyText={listing === null ? 'Loading…' : 'No files match.'}
          />

          <div className="sirdar-seed-pager">
            <span className="page-hint">
              {total === 0 ? 'No files' : `Files ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
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
  );
}
