/** The left sidebar: the current space's tree, then Favorites and the five
 *  most recently updated items (in this space when there is one). With no
 *  space yet (first visit to Home) the tree's place lists the spaces. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import NodeIcon, { SpaceBadge } from '../components/NodeIcon';
import { atLeast } from '../components/RowMenu';
import { useTreeRevision } from '../lib/treeStore';
import type { NodeOut, SpaceOut } from '../lib/types';
import { listFavorites, listRecent } from '../lib/wikiApi';
import SpaceTree from './SpaceTree';

interface Props {
  space: SpaceOut | null;
  spaces: SpaceOut[] | null;
  activeId: string | null;
  revealIds: string[];
  onCollapse: () => void;
  onNewAtRoot: (space: SpaceOut) => void;
  onNewChild: (parent: NodeOut, kind: 'page' | 'folder') => void;
  onDelete: (node: NodeOut) => void;
  onRequestMove: (node: NodeOut) => void;
  onRequestPermissions: (node: NodeOut) => void;
}

/** Reloads whenever anything in the tree changes. */
function useNodeList(load: () => Promise<NodeOut[]>, deps: unknown[]): NodeOut[] | null {
  const revision = useTreeRevision();
  const [nodes, setNodes] = useState<NodeOut[] | null>(null);
  useEffect(() => {
    let live = true;
    load().then((n) => { if (live) setNodes(n); }).catch(() => { if (live) setNodes((cur) => cur ?? []); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, ...deps]);
  return nodes;
}

function NodeLinks({ nodes, activeId, empty }: { nodes: NodeOut[] | null; activeId: string | null; empty: string }) {
  if (!nodes) return <p className="wiki-side-note">Loading…</p>;
  if (nodes.length === 0) return <p className="wiki-side-note">{empty}</p>;
  return (
    <ul className="wiki-side-links">
      {nodes.map((n) => (
        <li key={n.id}>
          <Link to={`/n/${n.id}`} className={`wiki-side-link${n.id === activeId ? ' active' : ''}`} title={n.title}>
            <NodeIcon node={n} />
            <span>{n.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function Sidebar({
  space, spaces, activeId, revealIds, onCollapse, onNewAtRoot, ...treeHandlers
}: Props) {
  const favorites = useNodeList(listFavorites, []);
  const recent = useNodeList(() => listRecent({ space: space?.key, limit: 5 }), [space?.key]);

  return (
    <aside className="wiki-sidebar" aria-label="Wiki navigation">
      <div className="wiki-side-head">
        {space ? (
          <Link to={`/s/${space.key}`} className="wiki-side-space" title={space.name}>
            <SpaceBadge space={space} />
            <span className="wiki-side-space-name">{space.name}</span>
          </Link>
        ) : <span className="wiki-side-label">Spaces</span>}
        {space && atLeast(space.my_level, 'edit') && (
          <button type="button" className="wiki-side-icon-btn" aria-label={`New page in ${space.name}`}
                  title="New page" onClick={() => onNewAtRoot(space)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        )}
        <button type="button" className="wiki-side-icon-btn" aria-label="Hide sidebar"
                title="Hide sidebar (Ctrl/⌘+B)" onClick={onCollapse}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9 4.5v15M15 10l-2 2 2 2" />
          </svg>
        </button>
      </div>

      <div className="wiki-side-scroll">
        {space ? (
          <SpaceTree key={space.key} space={space} activeId={activeId} revealIds={revealIds} {...treeHandlers} />
        ) : (
          <ul className="wiki-side-links">
            {(spaces ?? []).map((s) => (
              <li key={s.id}>
                <Link to={`/s/${s.key}`} className="wiki-side-link">
                  <SpaceBadge space={s} size="sm" />
                  <span>{s.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <section className="wiki-side-section" aria-label="Favorites">
          <div className="wiki-side-label">Favorites</div>
          <NodeLinks nodes={favorites} activeId={activeId} empty="Star a page to keep it here." />
        </section>

        <section className="wiki-side-section" aria-label="Recently updated">
          <div className="wiki-side-label">Recently updated</div>
          <NodeLinks nodes={recent} activeId={activeId} empty="Nothing updated yet." />
        </section>
      </div>
    </aside>
  );
}
