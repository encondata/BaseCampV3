/** Wiki home: the spaces grid (plus "New space" for creators), then
 *  Favorites, Recently updated (10) and My drafts. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { relativeTime } from '@portal/lib/format';

import NodeIcon, { SpaceBadge } from '../components/NodeIcon';
import { useWikiShell } from '../layout/shellContext';
import { useTreeRevision } from '../lib/treeStore';
import type { NodeOut, WatchOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import { listDrafts, listFavorites, listRecent, listSpaces, listWatches } from '../lib/wikiApi';

const WATCHING_SHOWN = 5;

function useLoad<T>(load: () => Promise<T>, revision: number): T | null | 'error' {
  const [value, setValue] = useState<T | null | 'error'>(null);
  useEffect(() => {
    let live = true;
    load().then((v) => { if (live) setValue(v); }).catch(() => { if (live) setValue('error'); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);
  return value;
}

function NodeList({ label, nodes, empty }: { label: string; nodes: NodeOut[] | null | 'error'; empty: string }) {
  return (
    <section className="wiki-home-section" aria-label={label}>
      <div className="wiki-section-label">{label}</div>
      <div className="dir-list mini-list wiki-mini-list">
        {nodes === null && <div className="mini-row wiki-mini-note">Loading…</div>}
        {nodes === 'error' && <div className="mini-row wiki-mini-note">Couldn't load this list.</div>}
        {Array.isArray(nodes) && nodes.length === 0 && <div className="mini-row wiki-mini-note">{empty}</div>}
        {Array.isArray(nodes) && nodes.map((n) => (
          <Link key={n.id} to={`/n/${n.id}`} className="mini-row flex wiki-mini-row">
            <NodeIcon node={n} />
            <span className="cell-top cell-line wiki-mini-title">{n.title}</span>
            <span className="cell-sub cell-line wiki-mini-meta">
              {relativeTime(n.updated_at)}{n.updated_by ? ` · ${n.updated_by.name}` : ''}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function WatchingList({ watches }: { watches: WatchOut[] | null | 'error' }) {
  return (
    <section className="wiki-home-section" aria-label="Watching">
      <div className="wiki-section-label">Watching</div>
      <div className="dir-list mini-list wiki-mini-list">
        {watches === null && <div className="mini-row wiki-mini-note">Loading…</div>}
        {watches === 'error' && <div className="mini-row wiki-mini-note">Couldn't load this list.</div>}
        {Array.isArray(watches) && watches.length === 0 && (
          <div className="mini-row wiki-mini-note">Watch a page, folder or space to hear about changes there.</div>
        )}
        {Array.isArray(watches) && watches.slice(0, WATCHING_SHOWN).map((w) => {
          const href = w.node ? `/n/${w.node.id}` : `/s/${w.space?.key}`;
          const label = w.node ? w.node.title : (w.space?.name ?? 'Space');
          return (
            <Link key={w.id} to={href} className="mini-row flex wiki-mini-row">
              {w.node ? <NodeIcon node={{ kind: w.node.kind, title: w.node.title, file: null }} /> : <span />}
              <span className="cell-top cell-line wiki-mini-title">{label}</span>
              <span className="cell-sub cell-line wiki-mini-meta">{w.node ? '' : 'Whole space'}</span>
            </Link>
          );
        })}
      </div>
      {Array.isArray(watches) && watches.length > 0 && (
        <Link to="/watching" className="wiki-home-section-link">See all watching</Link>
      )}
    </section>
  );
}

export default function Home() {
  const me = useWikiMe();
  const { setCurrentNode } = useWikiShell();
  const revision = useTreeRevision();
  const spaces = useLoad(() => listSpaces(), 0);
  const favorites = useLoad(listFavorites, revision);
  const recent = useLoad(() => listRecent({ limit: 10 }), revision);
  const drafts = useLoad(listDrafts, revision);
  const watches = useLoad(listWatches, revision);

  useEffect(() => { setCurrentNode(null); }, [setCurrentNode]);

  return (
    <div className="portal-page wiki-page">
      <div className="eyebrow">ServerSherpa Wiki</div>
      <h1 className="page-title">Spaces</h1>
      <p className="page-hint">Guides, runbooks and files, organized by team and topic.</p>

      {spaces === 'error' && <p className="pf-error">Couldn't load the spaces. Refresh to try again.</p>}
      <ul className="wiki-space-grid" aria-label="Spaces">
        {Array.isArray(spaces) && spaces.map((s) => (
          <li key={s.id}>
            <Link to={`/s/${s.key}`} className="wiki-space-card">
              <SpaceBadge space={s} size="lg" />
              <span className="wiki-space-card-text">
                <b>{s.name}</b>
                {s.description && <span>{s.description}</span>}
              </span>
            </Link>
          </li>
        ))}
        {me?.can_create_spaces && (
          <li>
            <Link to="/spaces/new" className="wiki-space-card wiki-space-card-new">
              <span className="wiki-space-badge lg wiki-space-badge-new" aria-hidden="true">+</span>
              <span className="wiki-space-card-text">
                <b>New space</b>
                <span>Start a home for a team or topic.</span>
              </span>
            </Link>
          </li>
        )}
      </ul>
      {Array.isArray(spaces) && spaces.length === 0 && !me?.can_create_spaces && (
        <p className="page-hint">No spaces are shared with you yet.</p>
      )}

      <div className="wiki-home-lists">
        <NodeList label="Favorites" nodes={favorites} empty="Star a page to keep it here." />
        <NodeList label="Recently updated" nodes={recent} empty="Nothing updated yet." />
        <NodeList label="My drafts" nodes={drafts} empty="No unpublished changes." />
        <WatchingList watches={watches} />
      </div>
    </div>
  );
}
