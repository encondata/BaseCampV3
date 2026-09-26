/** /search — the full results for `?q=` (top 50), with a space filter
 *  (ComboBox) and a kind filter (segmented All/Pages/Files/Folders); either
 *  filter re-queries and updates the URL, so the results page stays
 *  shareable/bookmarkable. Every hit's snippet is the same server-escaped
 *  `<mark>`-only HTML the search box shows — see SearchBox.tsx for why
 *  `dangerouslySetInnerHTML` is safe here. */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import ComboBox, { type ComboOption } from '@portal/components/ComboBox';

import NodeIcon from '../components/NodeIcon';
import { useWikiShell } from '../layout/shellContext';
import type { NodeKind, SearchHit, SpaceOut } from '../lib/types';
import { errorMessage, listSpaces, search } from '../lib/wikiApi';

const LIMIT = 50;

type KindFilter = '' | NodeKind;

const KINDS: { value: KindFilter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'page', label: 'Pages' },
  { value: 'file', label: 'Files' },
  { value: 'folder', label: 'Folders' },
];

type State =
  | { status: 'loading' }
  | { status: 'ready'; hits: SearchHit[] }
  | { status: 'error'; message: string };

function hitLabel(hit: SearchHit): string {
  return hit.node.space_name + (hit.breadcrumbs.length ? ` / ${hit.breadcrumbs.join(' / ')}` : '');
}

export default function SearchPage() {
  const { setCurrentNode } = useWikiShell();
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const space = params.get('space') ?? '';
  const kind = (params.get('kind') ?? '') as KindFilter;
  const [spaces, setSpaces] = useState<SpaceOut[] | null>(null);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => { setCurrentNode(null); }, [setCurrentNode]);

  useEffect(() => {
    listSpaces().then(setSpaces).catch(() => setSpaces((cur) => cur ?? []));
  }, []);

  useEffect(() => {
    if (!q) { setState({ status: 'ready', hits: [] }); return undefined; }
    let live = true;
    setState({ status: 'loading' });
    search({ q, space: space || undefined, kind: kind || undefined, limit: LIMIT })
      .then((hits) => { if (live) setState({ status: 'ready', hits }); })
      .catch((err) => { if (live) setState({ status: 'error', message: errorMessage(err, 'Couldn\'t search.') }); });
    return () => { live = false; };
  }, [q, space, kind]);

  const patch = (next: { space?: string; kind?: KindFilter }) => setParams((cur) => {
    const p = new URLSearchParams(cur);
    if ('space' in next) { if (next.space) p.set('space', next.space); else p.delete('space'); }
    if ('kind' in next) { if (next.kind) p.set('kind', next.kind); else p.delete('kind'); }
    return p;
  }, { replace: true });

  const spaceOptions: ComboOption[] = (spaces ?? []).map((s) => ({ value: s.key, label: s.name }));

  return (
    <div className="portal-page wiki-page wiki-search-page" data-testid="search-page">
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow">Search</div>
          <h1 className="page-title">{q ? `Results for “${q}”` : 'Search'}</h1>
        </div>
      </div>

      <div className="dir-toolbar wiki-search-filters">
        <ComboBox
          options={spaceOptions}
          value={space}
          onChange={(v) => patch({ space: v })}
          placeholder="All spaces"
          ariaLabel="Space"
          clearable
          disabled={!spaces}
        />
        <div className="segmented wiki-search-kind" role="group" aria-label="Type">
          {KINDS.map((k) => (
            <button key={k.value || 'all'} type="button" className={kind === k.value ? 'on' : undefined}
                    aria-pressed={kind === k.value} onClick={() => patch({ kind: k.value })}>
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {!q && <p className="page-hint">Type in the search box above to find pages, files and folders.</p>}
      {q && state.status === 'loading' && <p className="page-hint">Searching…</p>}
      {q && state.status === 'error' && <p className="pf-error">{state.message}</p>}
      {q && state.status === 'ready' && (
        <div className="dir-list list-scroll wiki-search-list">
          <div role="list" aria-label="Search results">
            {state.hits.map((hit) => (
              <div key={hit.node.id} className="dir-row wiki-search-row" role="listitem">
                <Link to={`/n/${hit.node.id}`} className="row-main wiki-row-link">
                  <div className="cell cell-primary">
                    <NodeIcon node={{ kind: hit.node.kind, title: hit.node.title, file: null }} className="wiki-row-icon" />
                    <div className="pn">
                      <b title={hit.node.title}>{hit.node.title}</b>
                      <span className="cell-sub cell-line">{hitLabel(hit)}</span>
                      <span className="wiki-search-snippet" dangerouslySetInnerHTML={{ __html: hit.snippet_html }} />
                    </div>
                  </div>
                </Link>
              </div>
            ))}
          </div>
          {state.hits.length === 0 && <div className="dir-empty">No results for “{q}”.</div>}
        </div>
      )}
    </div>
  );
}
