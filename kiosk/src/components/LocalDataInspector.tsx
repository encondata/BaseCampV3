/** Developer tab › Local data inspector — three collapsible sections
 *  (`<details className="local-section">`) that read straight out of the
 *  kiosk's own IndexedDB: the `assets` store, the `people` store, and the
 *  `sync` meta row. Read-only and independent of the "Local data"
 *  counts/"Clear local data" row above it in `Settings.tsx` — this is a
 *  raw inspector for developers to eyeball what actually landed.
 *
 *  Reads on mount, and again whenever `useSyncStatus().phase` becomes
 *  `'done'` (a sync just finished) or `'idle'` (the database was just
 *  cleared) — not on `'running'`/`'error'`, so it never reads mid-write.
 *  Each row's `Label` button reveals that asset's label placeholder map
 *  inline; the assets and people tables cap at 200 rendered rows (the
 *  synced roster/people list can run to a few thousand rows) with a
 *  `.local-count` line reporting how many matched the filter and how
 *  many exist in total. */

import { Fragment, useEffect, useRef, useState } from 'react';

import { getAll, readMeta } from '../lib/localDb';
import { useSyncStatus } from '../lib/sync';

interface AssetRow {
  id: string;
  asset_id: string;
  name: string | null;
  rfid: string | null;
  serial_number: string | null;
  make: string | null;
  model: string | null;
  make_model: string;
  label: Record<string, string>;
}

interface PersonRow {
  id: string;
  display_name: string;
  rfid_tag: string | null;
  is_worker: boolean;
  has_account: boolean;
}

interface SyncMeta {
  key: string;
  initiativeId?: string;
  initiativeName?: string;
  assets?: number;
  people?: number;
  syncedAt?: string;
}

type LoadStatus = 'loading' | 'ready' | 'error';

interface State {
  status: LoadStatus;
  assets: AssetRow[];
  people: PersonRow[];
  meta: SyncMeta | null;
}

const ROW_CAP = 200;

function matchesTerm(term: string, fields: readonly (string | null | undefined)[]): boolean {
  if (!term) return true;
  const needle = term.toLowerCase();
  return fields.some((f) => f != null && String(f).toLowerCase().includes(needle));
}

/** "Showing {shown} of {matched}", with " matching (of {total})" appended
 *  only while a filter narrows the set — unfiltered, matched === total
 *  so the plain form already says everything there is to say. */
function countLine(shown: number, matched: number, total: number, filtered: boolean): string {
  const base = `Showing ${shown.toLocaleString()} of ${matched.toLocaleString()}`;
  return filtered ? `${base} matching (of ${total.toLocaleString()})` : base;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export default function LocalDataInspector() {
  const { phase } = useSyncStatus();
  const [state, setState] = useState<State>({ status: 'loading', assets: [], people: [], meta: null });
  const [assetFilter, setAssetFilter] = useState('');
  const [peopleFilter, setPeopleFilter] = useState('');
  const [openLabels, setOpenLabels] = useState<ReadonlySet<string>>(new Set());
  const requestId = useRef(0);
  const isFirstRun = useRef(true);

  useEffect(() => {
    const load = () => {
      const myRequest = ++requestId.current;
      setState((s) => ({ ...s, status: 'loading' }));
      Promise.all([getAll<AssetRow>('assets'), getAll<PersonRow>('people'), readMeta('sync')])
        .then(([assets, people, meta]) => {
          if (myRequest !== requestId.current) return;
          setState({ status: 'ready', assets, people, meta: meta as SyncMeta | null });
        })
        .catch(() => {
          if (myRequest !== requestId.current) return;
          setState((s) => ({ ...s, status: 'error' }));
        });
    };

    if (isFirstRun.current) {
      isFirstRun.current = false;
      load();
      return;
    }
    if (phase === 'done' || phase === 'idle') load();
  }, [phase]);

  const toggleLabel = (id: string) => {
    setOpenLabels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (state.status === 'loading') return <p className="page-hint">Loading…</p>;
  if (state.status === 'error') return <p className="form-error" role="alert">Couldn&apos;t read local data.</p>;

  const assetTerm = assetFilter.trim();
  const matchedAssets = state.assets.filter((a) =>
    matchesTerm(assetTerm, [a.asset_id, a.name, a.rfid, a.serial_number, a.make_model]));
  const shownAssets = matchedAssets.slice(0, ROW_CAP);

  const peopleTerm = peopleFilter.trim();
  const matchedPeople = state.people.filter((p) =>
    matchesTerm(peopleTerm, [p.display_name, p.rfid_tag, p.id]));
  const shownPeople = matchedPeople.slice(0, ROW_CAP);

  return (
    <>
      <details className="local-section" open>
        <summary>Assets · {state.assets.length}</summary>
        {state.assets.length === 0 ? (
          <p className="page-hint">No assets downloaded yet.</p>
        ) : (
          <>
            <div className="local-toolbar">
              <div className="dir-search">
                <SearchIcon />
                <input
                  placeholder="Filter assets…"
                  value={assetFilter}
                  onChange={(e) => setAssetFilter(e.target.value)}
                />
              </div>
            </div>
            <p className="local-count">
              {countLine(shownAssets.length, matchedAssets.length, state.assets.length, assetTerm !== '')}
            </p>
            <div className="local-table-wrap">
              <table className="local-table">
                <thead>
                  <tr>
                    <th>Asset ID</th>
                    <th>Name</th>
                    <th>RFID</th>
                    <th>Serial</th>
                    <th>Make / Model</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shownAssets.map((a) => (
                    <Fragment key={a.id}>
                      <tr>
                        <td className="mono">{a.asset_id}</td>
                        <td>{a.name ?? '—'}</td>
                        <td className="mono">{a.rfid ?? '—'}</td>
                        <td className="mono">{a.serial_number ?? '—'}</td>
                        <td>{a.make_model || '—'}</td>
                        <td>
                          <button type="button" className="mini-btn" onClick={() => toggleLabel(a.id)}>
                            Label
                          </button>
                        </td>
                      </tr>
                      {openLabels.has(a.id) && (
                        <tr>
                          <td colSpan={6}>
                            <dl className="local-kv">
                              {Object.entries(a.label ?? {}).map(([k, v]) => (
                                <Fragment key={k}>
                                  <dt>{k}</dt>
                                  <dd>{v}</dd>
                                </Fragment>
                              ))}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </details>

      <details className="local-section">
        <summary>People · {state.people.length}</summary>
        {state.people.length === 0 ? (
          <p className="page-hint">No people downloaded yet.</p>
        ) : (
          <>
            <div className="local-toolbar">
              <div className="dir-search">
                <SearchIcon />
                <input
                  placeholder="Filter people…"
                  value={peopleFilter}
                  onChange={(e) => setPeopleFilter(e.target.value)}
                />
              </div>
            </div>
            <p className="local-count">
              {countLine(shownPeople.length, matchedPeople.length, state.people.length, peopleTerm !== '')}
            </p>
            <div className="local-table-wrap">
              <table className="local-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>RFID tag</th>
                    <th>ID</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {shownPeople.map((p) => (
                    <tr key={p.id}>
                      <td>{p.display_name}</td>
                      <td className="mono">{p.rfid_tag ?? '—'}</td>
                      <td className="mono" title={p.id}>{p.id.slice(0, 8)}</td>
                      <td>
                        {p.is_worker && <span className="chip tag">worker</span>}
                        {p.has_account && <span className="chip tag">account</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </details>

      <details className="local-section">
        <summary>Sync metadata</summary>
        {state.meta ? (
          <dl className="local-kv">
            <dt>initiativeId</dt><dd>{state.meta.initiativeId ?? '—'}</dd>
            <dt>initiativeName</dt><dd>{state.meta.initiativeName ?? '—'}</dd>
            <dt>assets</dt><dd>{state.meta.assets ?? '—'}</dd>
            <dt>people</dt><dd>{state.meta.people ?? '—'}</dd>
            <dt>syncedAt</dt>
            <dd>{state.meta.syncedAt ? new Date(state.meta.syncedAt).toLocaleString() : '—'}</dd>
          </dl>
        ) : (
          <p className="page-hint">No sync recorded.</p>
        )}
      </details>
    </>
  );
}
